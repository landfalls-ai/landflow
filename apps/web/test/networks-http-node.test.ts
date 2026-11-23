/**
 * C29 T-5: the HTTP Request node's Run In. Host (the default) behaves as before (AS-8); a network sends the prepared
 * request to a runner loop of the runner package (in this process, against a front that serves the host's runner routes
 * over HTTP) and reads the answer as if fetched in the host (AS-1): status, headers and body, a binary response as a
 * file, a Header Auth credential arriving at the upstream and nowhere else (AS-6), another project's network refused
 * (D13), no runner online failing at once with the message (AS-4), the runner's refusal reaching the node (AS-3), and
 * 20 calls over two runners each made once with both taking some (AS-7).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runNode, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/sdk';
import { fakeUpstream } from '@landflow/test-fakes/upstream';
import { parseAllow } from '../../../services/network-runner/src/allow';
import { runLoop } from '../../../services/network-runner/src/poll';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-networks-node-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const store = await import('@/lib/server/networks/store');
const calls = await import('@/lib/server/networks/calls');
const { hostBinaryClient, setBinaryStore } = await import('@/lib/server/binary/access');
const { FilesystemBinaryStore } = await import('@/lib/server/binary/store');
const { httpRequestNode } = await import('@/lib/server/nodes/data');
const pollRoute = await import('@/app/api/runner/v1/poll/route');
const answerRoute = await import('@/app/api/runner/v1/calls/[id]/route');
setBinaryStore(new FilesystemBinaryStore(join(dataDir, 'binary')));

const upstream = fakeUpstream();
let inside: Server;
let insideUrl: string;
let insideHits: string[] = [];
/** One-shot handlers for the next request of the "inside" service (a test that wants to see or script it). */
const hooks: Array<(req: IncomingMessage, res: ServerResponse) => void> = [];
let front: Server;
let frontUrl: string;
let owner: Awaited<ReturnType<typeof auth.createUser>>;

/** The host's runner routes over HTTP, so a runner loop (which uses fetch) reaches them as it would the real host. */
async function serve(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url ?? '/', 'http://localhost:3000');
  const call = /^\/api\/runner\/v1\/calls\/([^/]+)$/.exec(url.pathname);
  const route = url.pathname === '/api/runner/v1/poll' ? pollRoute.POST : call ? answerRoute.POST : undefined;
  if (!route) return void res.writeHead(404).end();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
  const request = new Request(url, { method: 'POST', headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await (route as (r: Request, c?: unknown) => Promise<Response>)(request, call && { params: Promise.resolve({ id: call[1] }) });
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
}

beforeAll(async () => {
  auth.disableTestAuth();
  await upstream.start();
  inside = createServer((req, res) => {
    insideHits.push(req.url ?? '');
    const hook = hooks.shift();
    if (hook) return void hook(req, res);
    if (req.url?.startsWith('/slow')) return void setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"slow":true}'), 40);
    if (req.url?.startsWith('/logo.png')) return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"inside":true}');
  });
  await new Promise<void>((resolve) => inside.listen(0, '127.0.0.1', resolve));
  insideUrl = `http://127.0.0.1:${(inside.address() as AddressInfo).port}`;
  front = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  owner = await auth.createUser({ email: 'node@example.test', name: 'Node', role: 'owner', password: 'a-long-password-1' });
});
afterAll(async () => {
  auth.enableTestAuth();
  await upstream.stop();
  await new Promise((resolve) => inside.close(resolve));
  await new Promise((resolve) => front.close(resolve));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const loops: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const loop of loops.splice(0)) await loop.stop();
  upstream.reset();
  insideHits = [];
  hooks.length = 0;
});

/** Register a runner in `networkId` and run its loop in this process; `lines` collects its log. */
async function startRunner(networkId: string, name: string, allow = '127.0.0.0/8', concurrency = 2) {
  const { token } = store.registerRunner(networkId, { name }, owner);
  const controller = new AbortController();
  const lines: string[] = [];
  const done = runLoop({ url: new URL(frontUrl), token, name, allow: parseAllow(allow), concurrency, retryMs: [20] }, controller.signal, (line) => lines.push(line));
  const handle = { lines, token, stop: async () => (controller.abort(), void (await done)) };
  loops.push(handle);
  // Online once its first poll has reached the host (a node asks for a runner seen in the last 30 s).
  const until = Date.now() + 5_000;
  while (Date.now() < until && store.onlineRunnerCount(networkId) < (name.endsWith('-2') ? 2 : 1)) await new Promise((resolve) => setTimeout(resolve, 10));
  return handle;
}

const request = (parameters: Record<string, unknown>, extra: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_net',
  workflowId: 'wf_net',
  mode: 'manual',
  node: { id: 'http1', name: 'HTTP Request', type: 'core.httpRequest', typeVersion: 1 },
  parameters: parameters as JsonObject,
  itemParameters: [parameters as JsonObject],
  inputs: [[{ json: {} }]],
  ...extra,
});
const exec = (parameters: Record<string, unknown>, extra: Partial<ExecuteRequest> = {}) => runNode(httpRequestNode, request(parameters, extra), { binary: hostBinaryClient('ex_net') });
const items = (response: Awaited<ReturnType<typeof exec>>): NodeItem[] => {
  if (response.error) throw new Error(response.error.message);
  return response.outputs[0];
};

describe('Run In', () => {
  it('AS-8: with no network (or "host") the node fetches in the host, as before', async () => {
    const plain = items(await exec({ method: 'GET', url: `${upstream.url}/a`, authentication: 'none' }));
    expect(plain[0].json).toHaveProperty('headers');
    const host = items(await exec({ method: 'GET', url: `${upstream.url}/b`, authentication: 'none', runIn: 'host' }));
    expect(host[0].json).toHaveProperty('headers');
    expect(upstream.state().requests.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('AS-1: in a network, a runner inside makes the call and the node gets the answer', async () => {
    const net = store.createNetwork({ name: 'Office' }, owner);
    await startRunner(net.id, 'office-1');
    const out = items(await exec({ method: 'GET', url: `${insideUrl}/status.json`, authentication: 'none', runIn: net.id }));
    expect(out[0].json).toEqual({ inside: true });
    expect(insideHits).toEqual(['/status.json']);
  });

  it('keeps the status and headers (Include Status & Headers) and a binary response as a file', async () => {
    const net = store.createNetwork({ name: 'Files' }, owner);
    await startRunner(net.id, 'files-1');
    const full = items(await exec({ method: 'GET', url: `${insideUrl}/x`, authentication: 'none', runIn: net.id, options: { fullResponse: true } }));
    expect(full[0].json).toMatchObject({ status: 200, headers: { 'content-type': 'application/json' }, body: { inside: true } });
    const file = items(await exec({ method: 'GET', url: `${insideUrl}/logo.png`, authentication: 'none', runIn: net.id }));
    expect(file[0].binary?.data).toMatchObject({ mimeType: 'image/png', fileSize: 7 });
  });

  it('sends the body and query of a POST through the runner', async () => {
    const net = store.createNetwork({ name: 'Post' }, owner);
    await startRunner(net.id, 'post-1');
    const seen: string[] = [];
    hooks.push((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()} ${req.headers['content-type']}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"inside":true}');
      });
    });
    items(await exec({ method: 'POST', url: `${insideUrl}/in`, authentication: 'none', runIn: net.id, query: { parameter: [{ name: 'a', value: '1' }] }, bodyType: 'json', body: '{"n":1}' }));
    expect(seen).toEqual(['POST /in?a=1 {"n":1} application/json']);
  });

  it('AS-6: a Header Auth credential reaches the upstream and appears nowhere on the host side', async () => {
    const net = store.createNetwork({ name: 'Secret' }, owner);
    const runner = await startRunner(net.id, 'secret-1');
    const seen: Array<string | undefined> = [];
    hooks.push((req, res) => {
      seen.push(req.headers['x-inside-key'] as string);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"inside":true}');
    });
    const response = await exec(
      { method: 'GET', url: `${insideUrl}/s`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', runIn: net.id },
      { credentials: { httpHeaderAuth: { name: 'X-Inside-Key', value: 'dummy-runner-header-1' } } },
    );
    expect(items(response)[0].json).toEqual({ inside: true });
    expect(seen).toEqual(['dummy-runner-header-1']);
    expect(JSON.stringify(response)).not.toContain('dummy-runner-header-1');
    expect(runner.lines.join('\n')).not.toContain('dummy-runner-header-1');
    const { database } = await import('@/lib/server/db');
    expect(JSON.stringify(database().all('SELECT * FROM network_calls'))).not.toContain('dummy-runner-header-1');
  });

  it('D13: a project’s network is for that project’s workflows only', async () => {
    const a = projects.createTeamProject({ name: 'Net A', createdBy: owner.id });
    const b = projects.createTeamProject({ name: 'Net B', createdBy: owner.id });
    const net = store.createNetwork({ name: 'A only', projectId: a.id }, owner);
    await startRunner(net.id, 'a-1');
    projects.setHomeProject('workflow', 'wf_in_a', a.id);
    projects.setHomeProject('workflow', 'wf_in_b', b.id);
    const parameters = { method: 'GET', url: `${insideUrl}/p`, authentication: 'none', runIn: net.id };
    expect(items(await exec(parameters, { workflowId: 'wf_in_a' }))[0].json).toEqual({ inside: true });
    const refused = await exec(parameters, { workflowId: 'wf_in_b' });
    expect(refused.error?.message).toBe('This network belongs to another project');
    expect(insideHits).toEqual(['/p']);
  });

  it('a network that was deleted fails the node', async () => {
    const response = await exec({ method: 'GET', url: `${insideUrl}/x`, authentication: 'none', runIn: 'net_gone' });
    expect(response.error?.message).toBe('Network not found');
  });

  it('AS-4: with no runner online the node fails at once with the message', async () => {
    const net = store.createNetwork({ name: 'Asleep' }, owner);
    store.registerRunner(net.id, { name: 'stopped' }, owner);
    const started = Date.now();
    const response = await exec({ method: 'GET', url: `${insideUrl}/x`, authentication: 'none', runIn: net.id });
    expect(response.error?.message).toBe('No runner online for network Asleep');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(insideHits).toEqual([]);
  });

  it('AS-3: the runner’s own allow-list refuses a target the host asked for', async () => {
    const net = store.createNetwork({ name: 'Narrow' }, owner);
    await startRunner(net.id, 'narrow-1', '10.20.0.0/16');
    const response = await exec({ method: 'GET', url: `${insideUrl}/x`, authentication: 'none', runIn: net.id });
    expect(response.error?.message).toMatch(/refused: 127\.0\.0\.1 is not in this runner’s allow-list/);
    expect(insideHits).toEqual([]);
  });

  it('turns a 4xx answer into the node’s HTTP error, as in the host', async () => {
    const net = store.createNetwork({ name: 'Errors' }, owner);
    await startRunner(net.id, 'errors-1');
    hooks.push((_req, res) => res.writeHead(404, { 'content-type': 'text/plain' }).end('nothing here'));
    const response = await exec({ method: 'GET', url: `${insideUrl}/missing`, authentication: 'none', runIn: net.id });
    expect(response.error).toMatchObject({ message: 'HTTP 404', description: 'nothing here' });
  });

  it('AS-7: 20 calls over two runners are each made once and both runners take some', async () => {
    const net = store.createNetwork({ name: 'Pair' }, owner);
    const one = await startRunner(net.id, 'pair-1', '127.0.0.0/8', 2);
    const two = await startRunner(net.id, 'pair-2', '127.0.0.0/8', 2);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => exec({ method: 'GET', url: `${insideUrl}/slow/${i}`, authentication: 'none', runIn: net.id })));
    for (const response of responses) expect(items(response)[0].json).toEqual({ slow: true });
    expect([...insideHits].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `/slow/${i}`).sort());
    const took = (lines: string[]) => lines.filter((line) => line.startsWith('call ')).length;
    expect(took(one.lines) + took(two.lines)).toBe(20);
    expect(took(one.lines)).toBeGreaterThan(0);
    expect(took(two.lines)).toBeGreaterThan(0);
  });

  it('audits one network.call event per run, node and network, not one per call', async () => {
    const net = store.createNetwork({ name: 'Audited' }, owner);
    await startRunner(net.id, 'audited-1');
    const { queryEvents } = await import('@/lib/server/audit/store');
    const before = queryEvents({}, { limit: 500 }).events.filter((e) => e.action === 'network.call').length;
    for (let i = 0; i < 3; i++) items(await exec({ method: 'GET', url: `${insideUrl}/a${i}`, authentication: 'none', runIn: net.id }, { executionId: 'ex_audited' }));
    items(await exec({ method: 'GET', url: `${insideUrl}/b`, authentication: 'none', runIn: net.id }, { executionId: 'ex_audited_2' }));
    const events = queryEvents({}, { limit: 500 }).events.filter((e) => e.action === 'network.call');
    expect(events.length - before).toBe(2);
    expect(JSON.stringify(events[0])).not.toContain('/a0');
    expect(events[0].details).toMatchObject({ node: 'HTTP Request', workflowId: 'wf_net' });
  });
});
