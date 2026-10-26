/**
 * Test URLs in queue mode (lib/server/test-webhooks.ts): listeners are registered in Valkey, so a test call that
 * reaches another main than the one holding the editor's stream finds the listener there, claims it atomically and
 * runs it in that main, and the bus relay carries the run's events to the editor's main; an MCP Server Trigger's test URL
 * too (each request pushes the deadline on in Valkey). Listening again on one main ends the earlier stream on the other
 * (`stopped`, over the control channel). One main (startCluster on the in-process coordinator) and "another main" on the
 * same MemoryHub that writes listener keys, hears the bus and the control channel, and sends on it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ExecutionEvent, Workflow } from '@landflow/engine';
import type { BusEvent } from '@/lib/server/bus';
import type { ControlMessage } from '@/lib/server/cluster/state';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-test-webhooks-cluster-'));
const ENV: Record<string, string | undefined> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_DB: 'sqlite',
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://cluster-hooks.test',
  LANDFLOW_EXECUTIONS_MODE: 'queue',
  LANDFLOW_QUEUE_ALLOW_SQLITE: 'true',
  LANDFLOW_INSTANCE_ID: 'main-test',
  LANDFLOW_QUEUE_PREFIX: 'landflow',
  LANDFLOW_WORKER_PORT: '0',
  LANDFLOW_ROLE: undefined,
  LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS: undefined,
};
const previousEnv = { ...process.env };
for (const [key, value] of Object.entries(ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { startCluster, stopCluster } = await import('@/lib/server/cluster');
const { clusterActive } = await import('@/lib/server/cluster/state');
const { MemoryCoordinator, MemoryHub } = await import('@/lib/server/cluster/memory');
const { Relay } = await import('@/lib/server/cluster/relay');
const { listenerStream, startListening } = await import('@/lib/server/test-webhooks');
type TestListener = Extract<Awaited<ReturnType<typeof startListening>>, { ok: true }>['listener'];
const listenRoute = await import('@/app/api/workflows/[id]/listen/route');
const testHookRoute = await import('@/app/api/webhook-test/[...path]/route');
const testFormRoute = await import('@/app/form-test/[...path]/route');
const testMcpRoute = await import('@/app/mcp-test/[...path]/route');

const hub = new MemoryHub();
/** This main's connection. */
const valkey = new MemoryCoordinator(hub);
/** Another main on the same Valkey: it registers listeners and hears this main's bus. */
const otherValkey = new MemoryCoordinator(hub);
const otherRelay = new Relay(new MemoryCoordinator(hub), 'main-other');
const heard: BusEvent[] = [];
/** What the other main hears on the control channel. */
const controls: ControlMessage[] = [];

beforeAll(async () => {
  expect(await startCluster({ coordinator: valkey })).toBe(true);
  await ensureBootstrapped();
  await otherRelay.listen<BusEvent>('bus', (event) => heard.push(event));
  await otherRelay.listen<ControlMessage>('control', (message) => controls.push(message));
});

afterAll(async () => {
  waits.stop();
  await stopCluster();
  await otherRelay.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  heard.length = 0;
  controls.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const request = (url: string, init: RequestInit = {}) => new Request(`http://cluster-hooks.test${url}`, init);
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const postJson = (path: string, body: unknown) =>
  testHookRoute.POST(request(`/api/webhook-test/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params({ path: path.split('/') }));
const formBody = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

function workflowOf(id: string, path: string, kind: 'webhook' | 'form' = 'webhook'): Workflow {
  const trigger =
    kind === 'webhook'
      ? { id: 'Hook', name: 'Hook', type: 'core.webhook', typeVersion: 1, position: [0, 0] as [number, number], parameters: { path, method: 'POST', respond: 'lastNode' } }
      : { id: 'Form', name: 'Form', type: 'core.formTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: { path, formTitle: 'Apply', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } } };
  return {
    id,
    name: id,
    nodes: [
      trigger,
      { id: 'Set', name: 'Set', type: 'core.set', typeVersion: 1, position: [200, 0], parameters: { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'ranOn', type: 'string', value: 'main-test' }] } } },
    ],
    connections: [{ id: 'e0', type: 'main', source: trigger.id, target: 'Set', sourceIndex: 0, targetIndex: 0 }],
  };
}

/** What another main writes when its editor listens (lib/server/test-webhooks.ts, queue mode). */
async function remoteListener(listener: TestListener) {
  await otherValkey.set(`test-listener:${listener.id}`, JSON.stringify(listener), 150_000);
  await otherValkey.set(`test-listener:${listener.kind}:${listener.method}:${listener.path}`, listener.id, 150_000);
}

/** Read an SSE response's events. */
function readEvents(response: Response) {
  const events: Array<{ event: string; data: any }> = [];
  const closed = (async () => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  const next = (event: string) =>
    vi.waitFor(
      () => {
        const found = events.find((e) => e.event === event);
        if (!found) throw new Error(`no ${event} event yet`);
        return found.data;
      },
      { timeout: 10_000, interval: 10 },
    );
  return { events, closed, next };
}

const heardFor = (executionId: string) =>
  heard.filter((e): e is Extract<BusEvent, { channel: 'execution' }> => e.channel === 'execution' && e.event.executionId === executionId).map((e) => e.event as ExecutionEvent);

// ---------------------------------------------------------------------------

describe('test URLs in queue mode', () => {
  it('registers the editor’s listener in Valkey; the first call claims it there', async () => {
    expect(clusterActive()).toBe(true);
    const response = await listenRoute.POST(
      request('/api/workflows/wf_twc_local/listen', { method: 'POST', body: JSON.stringify({ nodeId: 'Hook', workflow: workflowOf('wf_twc_local', 'twc-local') }), headers: { 'content-type': 'application/json' } }),
      params({ id: 'wf_twc_local' }),
    );
    expect(response.status).toBe(200);
    const stream = readEvents(response);
    const { listenerId, executionId } = await stream.next('listening');
    expect(await valkey.get('test-listener:webhook:POST:twc-local')).toBe(listenerId);
    expect(JSON.parse((await valkey.get(`test-listener:${listenerId}`))!)).toMatchObject({ workflow: { id: 'wf_twc_local' }, executionId });

    const answer = await postJson('twc-local', { n: 1 });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ body: { n: 1 }, ranOn: 'main-test' });
    expect(await stream.next('result')).toEqual({ executionId, status: 'success' });
    await stream.closed;
    expect(await valkey.get('test-listener:webhook:POST:twc-local')).toBeUndefined();
    expect((await postJson('twc-local', { n: 2 })).status).toBe(404);
    // Its events went to the other mains too (an editor there would see the run).
    expect(heardFor(executionId).map((e) => e.type)).toContain('execution.finished');
  });

  it('runs a call that reaches this main for a listener another main holds, and the bus relay takes the run there', async () => {
    const listener: TestListener = {
      id: 'tl_remote_hook',
      kind: 'webhook',
      method: 'POST',
      path: 'twc-remote',
      workflow: workflowOf('wf_twc_remote', 'twc-remote'),
      nodeId: 'Hook',
      executionId: 'ex_twc_remote1',
      expiresAt: Date.now() + 120_000,
    };
    await remoteListener(listener);

    const answer = await postJson('twc-remote', { n: 1 });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ body: { n: 1 }, ranOn: 'main-test' });
    expect(store.getExecution('ex_twc_remote1')).toMatchObject({ mode: 'manual', workflowId: 'wf_twc_remote', status: 'success' });
    // What the other main's listening stream forwards to its editor, filtered by the test run's id.
    await vi.waitFor(() => expect(heardFor('ex_twc_remote1').at(-1)).toMatchObject({ type: 'execution.finished', status: 'success' }));
    const events = heardFor('ex_twc_remote1');
    expect(events[0]).toMatchObject({ type: 'execution.started', mode: 'manual' });
    expect(events.filter((e) => e.type === 'node.finished').map((e) => (e as { nodeName: string }).nodeName)).toEqual(['Hook', 'Set']);

    // Claimed in Valkey: single-shot across mains.
    expect(await otherValkey.get('test-listener:webhook:POST:twc-remote')).toBeUndefined();
    expect((await postJson('twc-remote', { n: 2 })).status).toBe(404);
  });

  it('claims a test form held by another main once, and keeps its URL for the run', async () => {
    const listener: TestListener = {
      id: 'tl_remote_form',
      kind: 'form',
      method: '',
      path: 'twc-form',
      workflow: workflowOf('wf_twc_form', 'twc-form', 'form'),
      nodeId: 'Form',
      executionId: 'ex_twc_form1',
      expiresAt: Date.now() + 120_000,
    };
    await remoteListener(listener);
    const page = await testFormRoute.GET(request('/form-test/twc-form'), params({ path: ['twc-form'] }));
    expect(await page.text()).toContain('action="/form-test/twc-form"');
    const done = await testFormRoute.POST(request('/form-test/twc-form', formBody({ f0: 'Ada' })), params({ path: ['twc-form'] }));
    expect(done.status).toBe(200);
    expect(await otherValkey.get('test-listener:tl_remote_form:claim')).toBe('main-test');
    await vi.waitFor(() => expect(store.getExecution('ex_twc_form1')?.status).toBe('success'));
    expect(store.getExecution('ex_twc_form1')?.runData.Set?.at(-1)?.outputs[0][0].json).toMatchObject({ Name: 'Ada', formMode: 'test', ranOn: 'main-test' });
    // Submitted: until the owner's stream sees the run end and removes it, the URL says so.
    expect((await testFormRoute.POST(request('/form-test/twc-form', formBody({ f0: 'Bob' })), params({ path: ['twc-form'] }))).status).toBe(409);
  });

  it('refuses another workflow’s listener on a test URL another main listens on', async () => {
    await remoteListener({ id: 'tl_remote_taken', kind: 'webhook', method: 'POST', path: 'twc-taken', workflow: workflowOf('wf_twc_holder', 'twc-taken'), nodeId: 'Hook', executionId: 'ex_twc_taken', expiresAt: Date.now() + 120_000 });
    const response = await listenRoute.POST(
      request('/api/workflows/wf_twc_second/listen', { method: 'POST', body: JSON.stringify({ nodeId: 'Hook', workflow: workflowOf('wf_twc_second', 'twc-taken') }), headers: { 'content-type': 'application/json' } }),
      params({ id: 'wf_twc_second' }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('wf_twc_holder');
  });

  it('times out and removes its Valkey keys', async () => {
    const started = await startListening(workflowOf('wf_twc_timeout', 'twc-timeout'), 'Hook');
    if (!started.ok) throw new Error(started.error);
    started.listener.expiresAt = Date.now() + 50;
    const stream = readEvents(listenerStream(started.listener, new AbortController().signal));
    await stream.next('timeout');
    await stream.closed;
    expect(await valkey.get('test-listener:webhook:POST:twc-timeout')).toBeUndefined();
    expect(await valkey.get(`test-listener:${started.listener.id}`)).toBeUndefined();
    expect((await postJson('twc-timeout', {})).status).toBe(404);
  });
});

describe('listening again on another main', () => {
  const listenHere = async (workflow: Workflow, nodeId = 'Hook') => {
    const response = await listenRoute.POST(
      request(`/api/workflows/${workflow.id}/listen`, { method: 'POST', body: JSON.stringify({ nodeId, workflow }), headers: { 'content-type': 'application/json' } }),
      params({ id: workflow.id }),
    );
    expect(response.status).toBe(200);
    const stream = readEvents(response);
    return { stream, info: await stream.next('listening') };
  };

  it('ends this main’s stream with `stopped` when the trigger listens again on another main', async () => {
    const { stream, info } = await listenHere(workflowOf('wf_twc_moved', 'twc-moved'));
    // The other main registered its listener over this one and says so on the control channel.
    await remoteListener({ id: 'tl_twc_moved_there', kind: 'webhook', method: 'POST', path: 'twc-moved', workflow: workflowOf('wf_twc_moved', 'twc-moved'), nodeId: 'Hook', executionId: 'ex_twc_moved', expiresAt: Date.now() + 120_000 });
    await otherRelay.broadcast<ControlMessage>('control', { t: 'listener-replaced', id: info.listenerId });
    expect((await stream.next('stopped')).message).toBe('Listening again elsewhere');
    await stream.closed;
    // Ending it left the other main's listener alone.
    expect(await valkey.get('test-listener:webhook:POST:twc-moved')).toBe('tl_twc_moved_there');
  });

  it('tells the main holding the earlier stream when the trigger listens again here', async () => {
    await remoteListener({ id: 'tl_twc_old_there', kind: 'webhook', method: 'POST', path: 'twc-again', workflow: workflowOf('wf_twc_again', 'twc-again'), nodeId: 'Hook', executionId: 'ex_twc_old', expiresAt: Date.now() + 120_000 });
    const { stream, info } = await listenHere(workflowOf('wf_twc_again', 'twc-again'));
    await vi.waitFor(() => expect(controls).toContainEqual({ t: 'listener-replaced', id: 'tl_twc_old_there' }));
    expect(await valkey.get('test-listener:webhook:POST:twc-again')).toBe(info.listenerId);
    // This stream is the one that listens now.
    expect(stream.events.some((e) => e.event === 'stopped')).toBe(false);
    expect((await postJson('twc-again', { n: 1 })).status).toBe(200);
    expect((await stream.next('result')).status).toBe('success');
  });
});

describe('the MCP Server Trigger’s test URL in queue mode', () => {
  it('serves tool calls for a listener another main holds, pushing its deadline on in Valkey; the relay takes the runs there', async () => {
    const workflow: Workflow = {
      id: 'wf_twc_mcp',
      name: 'wf_twc_mcp',
      nodes: [
        { id: 'MCP', name: 'MCP', type: 'core.mcpTrigger', typeVersion: 1, position: [0, 0], parameters: { path: 'twc-mcp' } },
        { id: 'Calculator', name: 'Calculator', type: 'core.calculatorTool', typeVersion: 1, position: [0, 200], parameters: {} },
      ],
      connections: [{ id: 'tool', type: 'ai_tool', source: 'Calculator', target: 'MCP', sourceIndex: 0, targetIndex: 0 }],
    };
    const expiresAt = Date.now() + 5_000;
    await remoteListener({ id: 'tl_twc_mcp', kind: 'mcp', method: '', path: 'twc-mcp', workflow, nodeId: 'MCP', executionId: 'ex_twc_mcp', expiresAt });

    type Handler = (request: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      return (testMcpRoute as unknown as Record<string, Handler>)[req.method](req, params({ path: new URL(req.url).pathname.split('/').filter(Boolean).slice(1) }));
    };
    const client = new Client({ name: 'landflow-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://cluster-hooks.test/mcp-test/twc-mcp'), { fetch }));
    const sum = (await client.callTool({ name: 'Calculator', arguments: { expression: '6*7' } })) as CallToolResult;
    expect(JSON.parse((sum.content[0] as { text: string }).text)).toMatchObject({ result: 42 });
    await client.close();

    // The listener stays (many calls per listen), 120 s from the last request, for whichever main holds the stream.
    expect(await otherValkey.get('test-listener:mcp::twc-mcp')).toBe('tl_twc_mcp');
    expect(JSON.parse((await otherValkey.get('test-listener:tl_twc_mcp'))!).expiresAt).toBeGreaterThan(expiresAt + 100_000);
    // The tool call ran here as a manual run with the listener's id and a suffix; its events reached the other main.
    const runId = heard.find((e) => e.channel === 'execution' && e.event.type === 'execution.started' && e.event.executionId.startsWith('ex_twc_mcp-'))?.event.executionId;
    expect(runId).toBeDefined();
    await vi.waitFor(() => expect(heardFor(runId!).at(-1)).toMatchObject({ type: 'execution.finished', status: 'success' }));
    expect(store.getExecution(runId!)).toMatchObject({ mode: 'manual', workflowId: 'wf_twc_mcp', status: 'success' });
  });
});
