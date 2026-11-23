/**
 * C26: secret routes on kagent, against a fake Kubernetes API (no cluster): deploying a Claude Code agent with routes writes a
 * Secret `<name>-routes` and an EgressPolicy `<name>-routes` with `authentication` per host and references it from the Agent;
 * the credential's value is in the Secret and nowhere else (the AgentTemplate, the agent record, the API's answers, the audit
 * log, the logs); drift shows without reading the Secret; removing routes and undeploying delete both objects; the routes' rules
 * and credential checks fail the deploy with the route and credential named. The gateway's swap itself is the cluster live check.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, KagentStatus } from '@/lib/shared/agents';
import type { KubeObject } from '@/lib/server/kagent/kube';

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { logger } = await import('@/lib/server/telemetry');
const { queryEvents } = await import('@/lib/server/audit/store');
const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');
const kagentRoute = await import('@/app/api/agents/[id]/kagent/route');
const agentRoute = await import('@/app/api/agents/[id]/route');

/** A Kubernetes API that keeps objects in memory: server-side apply (merged per field), get, list and delete. */
interface FakeKube {
  url: string;
  objects: Map<string, KubeObject>;
  requests: Array<{ method: string; path: string; contentType?: string; authorization?: string }>;
  /** Out of reach: every request fails with 503. */
  down: boolean;
  /** Plurals Landflow may only read (an older access Role): writing one is 403. */
  readOnly: Set<string>;
  /** Called as each object is applied, as kagent's controller would see it. */
  onApply?: (plural: string, object: KubeObject) => void;
  close(): Promise<void>;
}

async function startFakeKube(): Promise<FakeKube> {
  const objects = new Map<string, KubeObject>();
  const requests: FakeKube['requests'] = [];
  const state: FakeKube = { url: '', objects, requests, down: false, readOnly: new Set(), close: () => new Promise((resolve) => server.close(() => resolve())) };
  const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://kube');
    requests.push({ method: req.method!, path: url.pathname + url.search, contentType: req.headers['content-type'], authorization: req.headers.authorization });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (state.down) return send(503, { message: 'unavailable' });
    if (req.headers.authorization !== 'Bearer kube-token') return send(401, { message: 'Unauthorized' });
    // /api/v1/namespaces/<ns>/<plural>[/<name>] or /apis/<group>/<version>/namespaces/<ns>/<plural>[/<name>]
    const match = /^\/apis?\/(?:[^/]+\/)?[^/]+\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return send(404, { message: 'not found' });
    const [, namespace, plural, name] = match;
    const key = `${plural}/${namespace}/${name}`;
    if (req.method !== 'GET' && state.readOnly.has(plural)) return send(403, { message: `${plural} is forbidden` });
    if (req.method === 'PATCH') {
      expect(req.headers['content-type']).toBe('application/apply-patch+yaml');
      expect(url.searchParams.get('fieldManager')).toBe('landflow');
      const applied = JSON.parse(await body(req)) as KubeObject;
      const previous = objects.get(key);
      const merged = { ...previous, ...applied, metadata: { ...previous?.metadata, ...applied.metadata, generation: ((previous?.metadata.generation as number) ?? 0) + 1 } } as KubeObject;
      objects.set(key, merged);
      state.onApply?.(plural, merged);
      return send(200, merged);
    }
    if (req.method === 'DELETE') {
      if (!objects.delete(key)) return send(404, { message: `${key} not found` });
      return send(200, { status: 'Success' });
    }
    if (!name) return send(200, { items: [...objects.entries()].filter(([k]) => k.startsWith(`${plural}/${namespace}/`)).map(([, v]) => v) });
    const found = objects.get(key);
    return found ? send(200, found) : send(404, { message: `${key} not found` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}


let kube: FakeKube;
let cluster: { id: string; name: string };
let bearer: { id: string; name: string };
let headerAuth: { id: string; name: string };
const TOKEN = 'dummy-route-token-1';
const HEADER_VALUE = 'dummy-header-value-9';

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  kube = await startFakeKube();
  cluster = credentials.create({ name: 'kind kagent', type: 'core.kagentApi', data: { server: kube.url, token: 'kube-token', namespace: 'kagent', harness: 'landflow-kagent', controllerUrl: 'http://kagent.test:8083', landflowUrl: 'http://landflow.test:3000' } });
  bearer = credentials.create({ name: 'Linear', type: 'core.httpBearerAuth', data: { token: TOKEN } });
  headerAuth = credentials.create({ name: 'Acme key', type: 'core.httpHeaderAuth', data: { name: 'X-API-Key', value: HEADER_VALUE } });
});
afterAll(() => kube.close());

const HARNESSES: Array<[string, Record<string, unknown>]> = [
  ['landflow-kagent', { kagent: {} }],
  ['landflow-claude', { claude: {} }],
];
beforeEach(() => {
  kube.objects.clear();
  for (const [name, spec] of HARNESSES) kube.objects.set(`harnesses/kagent/${name}`, { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'Harness', metadata: { name, namespace: 'kagent' }, spec });
  kube.objects.set('egresspolicies/kagent/landflow-github', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'EgressPolicy', metadata: { name: 'landflow-github', namespace: 'kagent' }, spec: { destinations: [{ origin: 'https://github.com' }] } });
  kube.requests.length = 0;
  kube.readOnly.clear();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const call = async <T,>(handler: unknown, id: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> => {
  const response = await (handler as Handler)(new Request(`http://localhost/api/agents/${id}/kagent`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), ctx(id));
  return { status: response.status, data: (await response.json()) as T };
};
const CONFIG: Partial<AgentConfig> = {
  name: 'Router',
  description: 'Calls a tracker',
  model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434' },
  instructions: 'You call the tracker with curl.',
};
const published = (name = 'Router') => agentStore.publish(agentStore.create({ ...CONFIG, name }).id)!;
const held = (kind: string, name: string) => kube.objects.get(`${kind}/kagent/${name}`);
type Spec = { destinations?: Array<Record<string, unknown>>; egressPolicyRefs?: Array<{ name: string }> };
const linear = () => ({ credential: { id: bearer.id, name: bearer.name }, hosts: ['https://api.linear.app'] });
const acme = (hosts = ['https://api.acme.test']) => ({ credential: { id: headerAuth.id, name: headerAuth.name }, hosts });
const deploy = (id: string, body: Record<string, unknown> = {}) => call<{ status: KagentStatus; unavailable: string[]; error?: string }>(kagentRoute.PUT, id, 'PUT', { credentialId: cluster.id, harness: 'landflow-claude', ...body });
const secretValue = (name: string, key: string) => Buffer.from(((held('secrets', name) as unknown as { data: Record<string, string> }).data ?? {})[key] ?? '', 'base64').toString();

describe('deploying with routes', () => {
  it('writes the Secret and the EgressPolicy and references the policy beside the named ones (AS-1, AS-9)', async () => {
    const agent = published();
    const answer = await deploy(agent.id, { egressPolicies: ['landflow-github'], routes: [linear(), acme(['https://api.acme.test', 'https://files.acme.test'])] });
    expect(answer.status, JSON.stringify(answer.data)).toBe(200);
    expect(secretValue('router-routes', 'r0')).toBe(TOKEN);
    expect(secretValue('router-routes', 'r1')).toBe(HEADER_VALUE);
    const policy = held('egresspolicies', 'router-routes')!;
    expect((policy.spec as Spec).destinations).toEqual([
      { origin: 'https://api.linear.app', authentication: { header: 'Authorization', prefix: 'Bearer ', secretKeyRef: { name: 'router-routes', key: 'r0' } } },
      { origin: 'https://api.acme.test', authentication: { header: 'X-API-Key', secretKeyRef: { name: 'router-routes', key: 'r1' } } },
      { origin: 'https://files.acme.test', authentication: { header: 'X-API-Key', secretKeyRef: { name: 'router-routes', key: 'r1' } } },
    ]);
    expect(policy.metadata.annotations?.['landflow.dev/routes-hmac']).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.metadata.labels?.['landflow.dev/agent-id']).toBe(agent.id);
    expect((held('agents', 'router')!.spec as Spec).egressPolicyRefs).toEqual([{ name: 'landflow-github' }, { name: 'router-routes' }]);
    // The hand-made policy is untouched.
    expect(held('egresspolicies', 'landflow-github')!.metadata.labels).toBeUndefined();
    expect(answer.data.status.inSync, JSON.stringify(answer.data.status.drift)).toBe(true);
    expect(answer.data.status.routes).toEqual([
      { credential: { id: bearer.id, name: 'Linear' }, hosts: ['https://api.linear.app'], header: 'Authorization', prefix: 'Bearer ' },
      { credential: { id: headerAuth.id, name: 'Acme key' }, hosts: ['https://api.acme.test', 'https://files.acme.test'], header: 'X-API-Key' },
    ]);
  });

  it('keeps the value out of everything but the Secret (AS-2)', async () => {
    const lines: string[] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level).mockImplementation((message: string, attributes?: Record<string, unknown>) => void lines.push(JSON.stringify({ message, attributes }))));
    const agent = published('Quiet');
    const answer = await deploy(agent.id, { routes: [linear(), acme()] });
    spies.forEach((spy) => spy.mockRestore());
    expect(answer.status).toBe(200);
    const everything = [
      JSON.stringify(answer.data),
      JSON.stringify((await call(kagentRoute.GET, agent.id)).data),
      JSON.stringify(await (await (agentRoute.GET as Handler)(new Request(`http://localhost/api/agents/${agent.id}`), ctx(agent.id))).json()),
      JSON.stringify(agentStore.get(agent.id)),
      JSON.stringify(held('agenttemplates', 'quiet')),
      JSON.stringify(held('egresspolicies', 'quiet-routes')),
      JSON.stringify(held('agents', 'quiet')),
      JSON.stringify(held('remotemcpservers', 'quiet')),
      JSON.stringify(queryEvents({}, { limit: 500 }).events),
      lines.join('\n'),
    ].join('\n');
    for (const value of [TOKEN, HEADER_VALUE, Buffer.from(TOKEN).toString('base64')]) expect(everything).not.toContain(value);
    // It is in the Secret.
    expect(secretValue('quiet-routes', 'r0')).toBe(TOKEN);
  });

  it('refuses routes on a runtime that is not Claude Code (D6)', async () => {
    const agent = published('Adk');
    const answer = await deploy(agent.id, { harness: 'landflow-kagent', routes: [linear()] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toMatch(/Claude Code/);
    expect(held('secrets', 'adk-routes')).toBeUndefined();
  });

  it('names the route and the host a rule refuses, and writes nothing (AS-7)', async () => {
    const agent = published('Rules');
    const answer = await deploy(agent.id, { routes: [linear(), { credential: { id: bearer.id, name: bearer.name }, hosts: ['https://*.example.com'] }] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toMatch(/Route 2: .*\*\.example\.com/);
    expect(kube.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('refuses a credential of another type, naming the types that work (AS-4)', async () => {
    const wrong = credentials.create({ name: 'OpenAI key', type: 'core.openAiApi', data: { apiKey: 'x', baseUrl: 'http://localhost:1' } });
    const answer = await deploy(published('Typed').id, { routes: [{ credential: { id: wrong.id, name: wrong.name }, hosts: ['https://api.example.test'] }] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toMatch(/OpenAI key.*Bearer Auth and Header Auth/);
  });

  it('refuses a credential the agent’s project may not use, naming it (AS-5)', async () => {
    const elsewhere = credentials.create({ name: 'Secret elsewhere', type: 'core.httpBearerAuth', data: { token: 'elsewhere-token' } });
    setHomeProject('credential', elsewhere.id, createTeamProject({ name: 'Other team' }).id);
    const answer = await deploy(published('Scoped').id, { routes: [{ credential: { id: elsewhere.id, name: elsewhere.name }, hosts: ['https://api.example.test'] }] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toContain('Secret elsewhere');
    expect(held('secrets', 'scoped-routes')).toBeUndefined();
    expect(JSON.stringify(answer.data)).not.toContain('elsewhere-token');
  });

  it('does not take over an object it did not write', async () => {
    kube.objects.set('egresspolicies/kagent/mine-routes', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'EgressPolicy', metadata: { name: 'mine-routes', namespace: 'kagent' }, spec: { destinations: [] } });
    const answer = await deploy(published('Mine').id, { routes: [linear()] });
    expect(answer.status).toBe(409);
    expect(answer.data.error).toContain('mine-routes');
    expect((held('egresspolicies', 'mine-routes')!.spec as Spec).destinations).toEqual([]);
  });

  it('fails the deploy when the routes policy can not be written, instead of running the agent without it', async () => {
    kube.readOnly.add('egresspolicies');
    const answer = await deploy(published('Readonly').id, { routes: [linear()] });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(agentStore.list().find((a) => a.name === 'Readonly')?.kagent).toBeUndefined();
  });

  it('keeps the routes across a redeploy (a publish writes them again)', async () => {
    const agent = published('Again');
    await deploy(agent.id, { routes: [linear()] });
    const again = await call<{ status: KagentStatus }>(kagentRoute.PUT, agent.id, 'PUT', {});
    expect(again.status).toBe(200);
    expect(again.data.status.routes).toHaveLength(1);
    expect(secretValue('again-routes', 'r0')).toBe(TOKEN);
  });
});

describe('the status', () => {
  it('shows a policy edited in kagent as drift in routes, without reading any Secret', async () => {
    const agent = published('Drifty');
    await deploy(agent.id, { routes: [linear()] });
    kube.requests.length = 0;
    const clean = await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id);
    expect(clean.data.status.inSync).toBe(true);
    expect(kube.requests.some((r) => r.path.includes('/secrets'))).toBe(false);
    const policy = held('egresspolicies', 'drifty-routes')!;
    (policy.spec as Spec).destinations![0].origin = 'https://evil.example.com';
    expect((await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status.drift.map((d) => d.field)).toContain('routes');
    (policy.spec as Spec).destinations![0].origin = 'https://api.linear.app';
    delete policy.metadata.annotations!['landflow.dev/routes-hmac'];
    expect((await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status.drift.map((d) => d.field)).toContain('routes');
  });

  it('shows a changed credential before the refresh wrote it, and a deleted one as broken', async () => {
    const own = credentials.create({ name: 'Changing', type: 'core.httpBearerAuth', data: { token: 'first-value' } });
    const agent = published('Pending');
    await deploy(agent.id, { routes: [{ credential: { id: own.id, name: own.name }, hosts: ['https://api.example.test'] }] });
    credentials.update(own.id, { data: { token: 'second-value' } });
    const pending = (await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status;
    expect(pending.drift.find((d) => d.field === 'routes')?.landflow).toMatch(/credential changed/);
    expect(JSON.stringify(pending)).not.toMatch(/first-value|second-value/);
    credentials.delete(own.id);
    const broken = (await call<{ status: KagentStatus }>(kagentRoute.GET, agent.id)).data.status;
    expect(broken.routes?.[0]).toMatchObject({ broken: expect.stringContaining('Changing') });
  });
});

describe('removing routes', () => {
  it('deletes the Secret and the policy when the list is emptied, and the Agent stops naming it (AS-8)', async () => {
    const agent = published('Dropper');
    await deploy(agent.id, { egressPolicies: ['landflow-github'], routes: [linear()] });
    expect(held('secrets', 'dropper-routes')).toBeDefined();
    const answer = await deploy(agent.id, { egressPolicies: ['landflow-github'], routes: [] });
    expect(answer.status).toBe(200);
    expect(held('secrets', 'dropper-routes')).toBeUndefined();
    expect(held('egresspolicies', 'dropper-routes')).toBeUndefined();
    expect((held('agents', 'dropper')!.spec as Spec).egressPolicyRefs).toEqual([{ name: 'landflow-github' }]);
    expect(held('egresspolicies', 'landflow-github')).toBeDefined();
    expect(agentStore.get(agent.id)!.kagent?.routes).toBeUndefined();
  });

  it('drops the key of a route taken out of a longer list', async () => {
    const agent = published('Shrink');
    await deploy(agent.id, { routes: [linear(), acme()] });
    await deploy(agent.id, { routes: [acme()] });
    expect(Object.keys((held('secrets', 'shrink-routes') as unknown as { data: object }).data)).toEqual(['r0']);
    expect(secretValue('shrink-routes', 'r0')).toBe(HEADER_VALUE);
  });

  it('undeploying deletes both objects and only the agent’s own', async () => {
    const agent = published('Gone');
    await deploy(agent.id, { routes: [linear()] });
    expect((await call(kagentRoute.DELETE, agent.id, 'DELETE')).status).toBe(200);
    expect(held('secrets', 'gone-routes')).toBeUndefined();
    expect(held('egresspolicies', 'gone-routes')).toBeUndefined();
    expect(held('egresspolicies', 'landflow-github')).toBeDefined();
  });
});

describe('the audit', () => {
  it('records each route added, changed and removed with the credential’s name and hosts, never the value', async () => {
    const agent = published('Audited');
    await deploy(agent.id, { routes: [linear()] });
    await deploy(agent.id, { routes: [{ credential: { id: bearer.id, name: bearer.name }, hosts: ['https://api.linear.app', 'https://uploads.linear.app'] }] });
    await deploy(agent.id, { routes: [] });
    const events = queryEvents({ targetId: agent.id, action: ['kagent.route.added', 'kagent.route.changed', 'kagent.route.removed'] }).events;
    expect(events.map((e) => e.action).sort()).toEqual(['kagent.route.added', 'kagent.route.changed', 'kagent.route.removed']);
    const changed = events.find((e) => e.action === 'kagent.route.changed')!;
    expect(changed.details).toMatchObject({ credential: 'Linear', header: 'Authorization' });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});

describe('the Run Trace connections', () => {
  it('list one network row per routed host with the credential’s name and never the value (US-3)', async () => {
    const { kagentConnections } = await import('@/lib/server/agents/connections');
    const agent = published('Traced');
    await deploy(agent.id, { routes: [linear(), acme(['https://api.acme.test', 'https://files.acme.test'])] });
    const rows = kagentConnections(agentStore.get(agent.id)!).filter((c) => c.kind === 'network' && c.detail?.includes('the gateway adds it'));
    expect(rows.map((r) => r.name)).toEqual(['api.linear.app', 'api.acme.test', 'files.acme.test']);
    expect(rows[0].detail).toBe('Linear · Authorization: the gateway adds it');
    expect(rows[1].detail).toContain('Acme key · X-API-Key');
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${TOKEN}|${HEADER_VALUE}`));
  });
});

describe('review fixes', () => {
  it('refuses a listed EgressPolicy that Landflow wrote for an agent (another agent’s routes policy)', async () => {
    await deploy(published('Owner A').id, { routes: [linear()] });
    const b = published('Taker B');
    const answer = await deploy(b.id, { egressPolicies: ['owner-a-routes'] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toContain('owner-a-routes');
    expect(held('agents', 'taker-b')).toBeUndefined();
  });

  it('refuses a route host that a listed policy already authenticates (landflow-github)', async () => {
    kube.objects.set('egresspolicies/kagent/landflow-github', { apiVersion: 'api.kagent.dev/v1alpha3', kind: 'EgressPolicy', metadata: { name: 'landflow-github', namespace: 'kagent' }, spec: { destinations: [{ origin: 'https://api.github.com', authentication: { header: 'Authorization', secretKeyRef: { name: 'github-git', key: 'token' } } }, { origin: 'https://codeload.github.com' }] } });
    const agent = published('Hosty');
    const clash = await deploy(agent.id, { egressPolicies: ['landflow-github'], routes: [{ credential: { id: bearer.id, name: bearer.name }, hosts: ['https://api.github.com'] }] });
    expect(clash.status).toBe(400);
    expect(clash.data.error).toMatch(/Route 1: .*api\.github\.com.*landflow-github/);
    // A host the policy lists without a credential is fine.
    const ok = await deploy(agent.id, { egressPolicies: ['landflow-github'], routes: [{ credential: { id: bearer.id, name: bearer.name }, hosts: ['https://codeload.github.com'] }] });
    expect(ok.status).toBe(200);
  });

  it('keeps the routes on the record when taking them away fails, so the next deploy retries', async () => {
    const agent = published('Sticky');
    await deploy(agent.id, { routes: [linear()] });
    kube.readOnly.add('egresspolicies');
    const answer = await deploy(agent.id, { routes: [] });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(agentStore.get(agent.id)!.kagent!.routes).toHaveLength(1);
    kube.readOnly.clear();
    expect((await deploy(agent.id, { routes: [] })).status).toBe(200);
    expect(held('egresspolicies', 'sticky-routes')).toBeUndefined();
    expect(held('secrets', 'sticky-routes')).toBeUndefined();
  });

  it('audits the removal when the agent is taken off kagent', async () => {
    const agent = published('Leaving');
    await deploy(agent.id, { routes: [linear()] });
    await call(kagentRoute.DELETE, agent.id, 'DELETE');
    expect(queryEvents({ targetId: agent.id, action: ['kagent.route.removed'] }).events).toHaveLength(1);
  });

  it('audits two routes of one credential separately: adding a third is one added event', async () => {
    const agent = published('Twice');
    const cred = { id: bearer.id, name: bearer.name };
    await deploy(agent.id, { routes: [{ credential: cred, hosts: ['https://a.example.test'] }, { credential: cred, hosts: ['https://b.example.test'] }] });
    const before = queryEvents({ targetId: agent.id, action: ['kagent.route.added'] }).events.length;
    expect(before).toBe(2);
    await deploy(agent.id, { routes: [{ credential: cred, hosts: ['https://a.example.test'] }, { credential: cred, hosts: ['https://b.example.test'] }, { credential: cred, hosts: ['https://c.example.test'] }] });
    const all = queryEvents({ targetId: agent.id, action: ['kagent.route.added', 'kagent.route.changed', 'kagent.route.removed'] }).events;
    expect(all.filter((e) => e.action === 'kagent.route.added')).toHaveLength(3);
    expect(all).toHaveLength(3);
  });
});

describe('the route’s answers', () => {
  it('is a 400 with the route’s message for a bad route', async () => {
    const answer = await deploy(published('Bad').id, { routes: [{ credential: { id: bearer.id, name: bearer.name }, hosts: ['http://10.0.0.5'] }] });
    expect(answer.status).toBe(400);
    expect(answer.data.error).toMatch(/^Route 1: /);
  });
});
