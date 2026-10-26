/**
 * Test URLs (lib/server/test-webhooks.ts) through the real routes, in regular mode: listening (POST
 * /api/workflows/:id/listen and its SSE stream), the single-shot test webhook, 404s with the hint, the 120 s timeout,
 * Stop, the run using the workflow the editor sent (manual mode), each respond mode, the trigger's authentication,
 * test forms (GET, POST, multi-page, "Form Is Submitted"), binary uploads, the MCP Server Trigger's test URL (many
 * requests per listen, a manual run per tool call, the deadline pushed on), and how test calls are traced. Queue mode:
 * test-webhooks-cluster.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { ExecutionEvent, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-test-webhooks-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://test-hooks.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { waits } = await import('@/lib/server/waits');
const { binaryStore } = await import('@/lib/server/binary/access');
const { readAll } = await import('@/lib/server/binary/store');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const { routePolicy, resourceRule } = await import('@/lib/server/auth/policy');
const { listenerStream, NOT_LISTENING_HINT, startListening, TEST_LISTEN_MS } = await import('@/lib/server/test-webhooks');
const { isTracedRequest } = await import('@/lib/server/telemetry/processors');
const { publishDraft } = await import('@/lib/server/publish');
const listenRoute = await import('@/app/api/workflows/[id]/listen/route');
const testHookRoute = await import('@/app/api/webhook-test/[...path]/route');
const testFormRoute = await import('@/app/form-test/[...path]/route');
const hookRoute = await import('@/app/api/webhook/[...path]/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');
const testMcpRoute = await import('@/app/mcp-test/[...path]/route');
const mcpRoute = await import('@/app/mcp/[...path]/route');

/** Holds every run that reaches it while closed, until released. */
const gate = { closed: false, held: [] as Array<() => void> };
const release = () => gate.held.splice(0).forEach((resolve) => resolve());

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'testhooks', name: 'Test webhook nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'gate', displayName: 'Gate', description: 'Holds while closed', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        async execute(ctx) {
          if (gate.closed) await new Promise<void>((resolve) => gate.held.push(resolve));
          return [ctx.getInputData()];
        },
      }),
    ],
  }),
);

afterAll(() => {
  release();
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key as keyof typeof ENV] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key as keyof typeof ENV];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}

function workflowOf(id: string, nodes: N[], edges: Array<[string, string]>): Workflow {
  return {
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [i * 200, 0], parameters: n.parameters ?? {}, ...(n.credentials && { credentials: n.credentials }) })),
    connections: edges.map(([source, target], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex: 0, targetIndex: 0 })),
  };
}
const save = (id: string, nodes: N[], edges: Array<[string, string]>) => store.saveWorkflow(workflowOf(id, nodes, edges));

const hook = (path: string, extra: Record<string, unknown> = {}, creds?: N['credentials']): N => ({
  name: 'Hook',
  type: 'core.webhook',
  parameters: { path, method: 'POST', respond: 'lastNode', ...extra },
  ...(creds && { credentials: creds }),
});
const setX = (value: string): N => ({ name: 'Set', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'x', type: 'string', value }] } } });
const noOp = (name: string): N => ({ name, type: 'core.noOp' });
const gateNode: N = { name: 'Gate', type: 'testhooks.gate' };

const request = (url: string, init: RequestInit = {}) => new Request(`http://test-hooks.test${url}`, init);
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const call = (path: string, init: RequestInit = {}) => {
  const method = (init.method ?? 'POST').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  return testHookRoute[method](request(`/api/webhook-test/${path}`, { method, ...init }), params({ path: path.split('/') }));
};
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const formGet = (path: string, headers: Record<string, string> = {}) => testFormRoute.GET(request(`/form-test/${path}`, { headers }), params({ path: path.split('/') }));
const formBody = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const formPost = (path: string, init: RequestInit) => testFormRoute.POST(request(`/form-test/${path}`, init), params({ path: path.split('/') }));

interface Listening {
  response: Response;
  events: Array<{ event: string; data: any }>;
  /** The data of the first `event` (waits for it). */
  next(event: string): Promise<any>;
  /** Execution events received so far. */
  executionEvents(): ExecutionEvent[];
  closed: Promise<void>;
  stop(): void;
}

/** Read an SSE response into `events`. */
function readEvents(response: Response, abort?: AbortController): Listening {
  const events: Listening['events'] = [];
  const closed = (async () => {
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    response,
    events,
    closed,
    stop: () => abort?.abort(),
    executionEvents: () => events.filter((e) => e.event === 'execution').map((e) => e.data as ExecutionEvent),
    next: (event) =>
      vi.waitFor(
        () => {
          const found = events.find((e) => e.event === event);
          if (!found) throw new Error(`no ${event} event yet (have: ${events.map((e) => e.event).join(', ')})`);
          return found.data;
        },
        { timeout: 10_000, interval: 10 },
      ),
  };
}

/** POST /api/workflows/:id/listen (the editor's "Listen for test event"); waits for `listening` when it streams. */
async function listen(workflowId: string, nodeId: string, workflow?: Workflow): Promise<Listening> {
  const abort = new AbortController();
  const response = await listenRoute.POST(
    request(`/api/workflows/${workflowId}/listen`, { method: 'POST', body: JSON.stringify({ nodeId, ...(workflow && { workflow }) }), headers: { 'content-type': 'application/json' }, signal: abort.signal }),
    params({ id: workflowId }),
  );
  const listening = readEvents(response, abort);
  if (response.status === 200) await listening.next('listening');
  return listening;
}

const outputOf = (record: ExecutionRecord | undefined, node: string) => record?.runData[node]?.at(-1)?.outputs[0]?.map((i) => i.json);
const stored = (id: string) => store.getExecution(id);

// ---------------------------------------------------------------------------
// Routing and access
// ---------------------------------------------------------------------------

describe('test URL routing', () => {
  it('serves the test URLs without a session, and listening needs the run scope', () => {
    expect(isPublicPath('/api/webhook-test/orders')).toBe(true);
    expect(isPublicPath('/form-test/signup')).toBe(true);
    expect(isPublicPath('/api/webhook-tests')).toBe(false);
    expect(isPublicPath('/form-tester')).toBe(false);
    expect(isPublicPath('/api/workflows/wf_1/listen')).toBe(false);
    expect(routePolicy('POST', '/api/workflows/wf_1/listen')).toEqual({ scope: 'run' });
    expect(resourceRule('POST', '/api/workflows/wf_1/listen')).toEqual({ kind: 'workflow', id: 'wf_1', action: 'run' });
  });

  it('answers 404 with a hint while nobody listens', async () => {
    const miss = await postJson('tw-nobody', { a: 1 });
    expect(miss.status).toBe(404);
    const body = await miss.json();
    expect(body.error).toContain('No editor is listening on POST /api/webhook-test/tw-nobody');
    expect(body.hint).toContain('Listen for test event');

    const form = await formGet('tw-nobody-form');
    expect(form.status).toBe(404);
    expect(form.headers.get('content-type')).toContain('text/html');
    expect(await form.text()).toContain('Listen for test event');
  });

  it('refuses nodes without a test URL and unknown workflows', async () => {
    save('wf_tw_refuse', [{ name: 'Start', type: 'core.manualTrigger' }, hook('')], []);
    expect((await listen('wf_tw_refuse', 'Start')).response.status).toBe(400);
    const empty = await listen('wf_tw_refuse', 'Hook');
    expect(empty.response.status).toBe(400);
    expect((await empty.response.json()).error).toBe('Set the webhook path first');
    expect((await listen('wf_tw_refuse', 'Nope')).response.status).toBe(400);
    expect((await listen('wf_tw_missing', 'Hook')).response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Test webhooks
// ---------------------------------------------------------------------------

describe('test webhooks', () => {
  it('runs the workflow the editor sent, once, as a manual run streamed to the editor', async () => {
    save('wf_tw_basic', [hook('tw-basic'), setX('saved')], [['Hook', 'Set']]);
    // The editor's unsaved change: Set writes "editor".
    const listening = await listen('wf_tw_basic', 'Hook', workflowOf('wf_tw_basic', [hook('tw-basic'), setX('editor')], [['Hook', 'Set']]));
    const info = await listening.next('listening');
    expect(info).toMatchObject({ nodeId: 'Hook', kind: 'webhook', method: 'POST', path: 'tw-basic', executionId: expect.stringMatching(/^ex_/) });
    expect(TEST_LISTEN_MS).toBe(120_000);
    expect(info.timeoutMs).toBeGreaterThan(115_000);
    expect(info.timeoutMs).toBeLessThanOrEqual(120_000);
    // The production URL is a different thing: not published, so not served.
    expect((await hookRoute.POST(request('/api/webhook/tw-basic', { method: 'POST', body: '{}' }), params({ path: ['tw-basic'] }))).status).toBe(404);

    const response = await postJson('tw-basic', { name: 'Ada' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: 'POST', path: 'tw-basic', body: { name: 'Ada' }, x: 'editor' });
    expect(await listening.next('result')).toEqual({ executionId: info.executionId, status: 'success' });
    await listening.closed;

    // The editor got the run as /run streams it: started (manual), both nodes with their data, finished.
    const events = listening.executionEvents();
    expect(events[0]).toMatchObject({ type: 'execution.started', executionId: info.executionId, mode: 'manual' });
    const finished = events.filter((e): e is Extract<ExecutionEvent, { type: 'node.finished' }> => e.type === 'node.finished');
    expect(finished.map((e) => e.nodeName)).toEqual(['Hook', 'Set']);
    expect(finished[1].run.outputs[0][0].json).toMatchObject({ x: 'editor', body: { name: 'Ada' } });
    expect(events.at(-1)).toMatchObject({ type: 'execution.finished', status: 'success' });
    expect(stored(info.executionId)).toMatchObject({ mode: 'manual', workflowId: 'wf_tw_basic', status: 'success' });

    // Single-shot: the next call finds nobody listening.
    expect((await postJson('tw-basic', { name: 'Bob' })).status).toBe(404);
  });

  it('runs a workflow that was never saved; the trigger outputs the call, not its pinned test data', async () => {
    const workflow = { ...workflowOf('wf_tw_unsaved', [hook('tw-unsaved'), setX('fresh')], [['Hook', 'Set']]), pinData: { Hook: [{ json: { pinned: true } }] } };
    const listening = await listen('wf_tw_unsaved', 'Hook', workflow);
    const response = await postJson('tw-unsaved', { live: true });
    const output = await response.json();
    expect(output).toMatchObject({ x: 'fresh', body: { live: true } });
    expect(output.pinned).toBeUndefined();
    expect((await listening.next('result')).status).toBe('success');
  });

  it('names the method it waits for, and keeps listening after a call with another one', async () => {
    const listening = await listen('wf_tw_method', 'Hook', workflowOf('wf_tw_method', [hook('tw-method', { method: 'PUT' })], []));
    const wrong = await call('tw-method', { method: 'GET' });
    expect(wrong.status).toBe(404);
    expect((await wrong.json()).error).toBe('The test webhook /api/webhook-test/tw-method listens for PUT requests, not GET');
    const right = await call('tw-method', { method: 'PUT', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(right.status).toBe(200);
    expect(await right.json()).toMatchObject({ method: 'PUT', body: { a: 1 } });
    await listening.closed;
  });

  it('times out after its 120 s', async () => {
    const workflow = workflowOf('wf_tw_timeout', [hook('tw-timeout')], []);
    const started = await startListening(workflow, 'Hook');
    if (!started.ok) throw new Error(started.error);
    expect(started.listener.expiresAt - Date.now()).toBeGreaterThan(TEST_LISTEN_MS - 2_000);
    // Its clock, run fast: the listener expires in 50 ms instead of 120 s.
    started.listener.expiresAt = Date.now() + 50;
    const listening = readEvents(listenerStream(started.listener, new AbortController().signal));
    expect((await listening.next('timeout')).message).toBe('No test event arrived within 120 s');
    await listening.closed;
    expect((await postJson('tw-timeout', {})).status).toBe(404);
  });

  it('stops listening on Stop, and Stop cancels a test run that is going', async () => {
    const idle = await listen('wf_tw_stop', 'Hook', workflowOf('wf_tw_stop', [hook('tw-stop')], []));
    idle.stop();
    await idle.closed;
    expect((await postJson('tw-stop', {})).status).toBe(404);

    gate.closed = true;
    try {
      const busy = await listen('wf_tw_stop', 'Hook', workflowOf('wf_tw_stop', [hook('tw-stop'), gateNode], [['Hook', 'Gate']]));
      const { executionId } = await busy.next('listening');
      const answer = postJson('tw-stop', {});
      await vi.waitFor(() => expect(gate.held.length).toBe(1));
      busy.stop();
      const response = await answer;
      expect(response.status).toBe(500);
      await vi.waitFor(() => expect(stored(executionId)?.status).toBe('canceled'));
    } finally {
      gate.closed = false;
      release();
    }
  });

  it('refuses a second workflow on the same test URL; the same trigger listening again replaces the first', async () => {
    const first = await listen('wf_tw_owner', 'Hook', workflowOf('wf_tw_owner', [hook('tw-shared')], []));
    const other = await listen('wf_tw_other', 'Hook', workflowOf('wf_tw_other', [hook('tw-shared')], []));
    expect(other.response.status).toBe(409);
    expect((await other.response.json()).error).toBe('Another workflow (“wf_tw_owner”) is listening on /api/webhook-test/tw-shared');

    const again = await listen('wf_tw_owner', 'Hook', workflowOf('wf_tw_owner', [hook('tw-shared'), setX('second')], [['Hook', 'Set']]));
    expect((await first.next('stopped')).message).toBe('Listening again elsewhere');
    await first.closed;
    expect(await (await postJson('tw-shared', {})).json()).toMatchObject({ x: 'second' });
    expect((await again.next('result')).status).toBe('success');
  });

  it('answers in each respond mode', async () => {
    // Immediately: 202 with the test run's id.
    let listening = await listen('wf_tw_modes', 'Hook', workflowOf('wf_tw_modes', [hook('tw-modes', { respond: 'immediately' }), setX('later')], [['Hook', 'Set']]));
    let { executionId } = await listening.next('listening');
    const now = await postJson('tw-modes', {});
    expect(now.status).toBe(202);
    expect(await now.json()).toEqual({ status: 'started', workflowId: 'wf_tw_modes', executionId });
    expect((await listening.next('result')).status).toBe('success');

    // When the last node finishes: its output.
    listening = await listen('wf_tw_modes', 'Hook', workflowOf('wf_tw_modes', [hook('tw-modes', { respond: 'lastNode' }), setX('last')], [['Hook', 'Set']]));
    ({ executionId } = await listening.next('listening'));
    const last = await postJson('tw-modes', {});
    expect(last.headers.get('x-landflow-execution')).toBe(executionId);
    expect(await last.json()).toMatchObject({ x: 'last' });
    await listening.closed;

    // Using Respond to Webhook: what that node sends, while the run goes on.
    const respond: N = {
      name: 'Respond',
      type: 'core.respondToWebhook',
      parameters: { respondWith: 'text', responseBody: 'hello {{ $json.body.name }}', options: { responseCode: 201, responseHeaders: { entries: [{ name: 'x-test', value: 'yes' }] } } },
    };
    listening = await listen('wf_tw_modes', 'Hook', workflowOf('wf_tw_modes', [hook('tw-modes', { respond: 'responseNode' }), respond, noOp('After')], [['Hook', 'Respond'], ['Respond', 'After']]));
    const replied = await postJson('tw-modes', { name: 'Ada' });
    expect([replied.status, replied.headers.get('x-test'), await replied.text()]).toEqual([201, 'yes', 'hello Ada']);
    expect((await listening.next('result')).status).toBe('success');
    expect(listening.executionEvents().some((e) => e.type === 'node.finished' && e.nodeName === 'After')).toBe(true);
  });

  it('checks the trigger’s authentication and IP allow-list; a refused call leaves it listening', async () => {
    const key = credentials.create({ name: 'Test hook key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: 'k-123' } });
    let listening = await listen('wf_tw_auth', 'Hook', workflowOf('wf_tw_auth', [hook('tw-auth', { authentication: 'headerAuth' }, { httpHeaderAuth: { id: key.id, name: key.name } })], []));
    expect((await postJson('tw-auth', {})).status).toBe(403);
    expect((await postJson('tw-auth', {}, { 'x-api-key': 'nope' })).status).toBe(403);
    const ok = await postJson('tw-auth', {}, { 'x-api-key': 'k-123', 'x-other': 'kept' });
    expect(ok.status).toBe(200);
    const item = (await ok.json()) as { headers: Record<string, string> };
    expect(item.headers['x-api-key']).toBeUndefined();
    expect(item.headers['x-other']).toBe('kept');
    await listening.closed;

    const login = credentials.create({ name: 'Test hook login', type: 'core.httpBasicAuth', data: { user: 'ada', password: 'lovelace' } });
    listening = await listen('wf_tw_auth', 'Hook', workflowOf('wf_tw_auth', [hook('tw-auth', { authentication: 'basicAuth' }, { httpBasicAuth: { id: login.id, name: login.name } })], []));
    const challenged = await postJson('tw-auth', {});
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toMatch(/^Basic realm="Webhook"/);
    expect((await postJson('tw-auth', {}, { authorization: `Basic ${Buffer.from('ada:lovelace').toString('base64')}` })).status).toBe(200);
    await listening.closed;

    listening = await listen('wf_tw_auth', 'Hook', workflowOf('wf_tw_auth', [hook('tw-auth', { options: { ipWhitelist: '10.0.0.0/8' } })], []));
    expect((await postJson('tw-auth', {}, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await postJson('tw-auth', {}, { 'x-forwarded-for': '10.1.2.3' })).status).toBe(200);
    await listening.closed;
  });

  it('stores uploaded files as item.binary, as production does', async () => {
    const listening = await listen('wf_tw_upload', 'Hook', workflowOf('wf_tw_upload', [hook('tw-upload'), noOp('After')], [['Hook', 'After']]));
    const { executionId } = await listening.next('listening');
    const form = new FormData();
    form.append('title', 'Report');
    form.append('file', new File(['a,b\n1,2\n'], 'one.csv', { type: 'text/csv' }));
    const response = await call('tw-upload', { body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { title: 'Report' } });
    await listening.closed;
    const binary = stored(executionId)?.runData.After?.at(-1)?.outputs[0]?.[0]?.binary;
    expect(binary?.file).toMatchObject({ fileName: 'one.csv', mimeType: 'text/csv', fileSize: 8 });
    expect(binary!.file.id).toMatch(new RegExp(`^${executionId}\\.`));
    expect((await readAll((await (await binaryStore()).open(binary!.file.id!))!.stream)).toString('utf8')).toBe('a,b\n1,2\n');
  });
});

// ---------------------------------------------------------------------------
// Test forms
// ---------------------------------------------------------------------------

describe('test forms', () => {
  const fields = { values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: true }, { fieldLabel: 'Resume', fieldType: 'file' }] };
  const formTrigger = (path: string, extra: Record<string, unknown> = {}, creds?: N['credentials']): N => ({
    name: 'Form',
    type: 'core.formTrigger',
    parameters: { path, formTitle: 'Apply', formFields: fields, options: { formSubmittedText: 'Got it' }, ...extra },
    ...(creds && { credentials: creds }),
  });

  it('serves the form while listening and walks a multi-page form to its end, streamed to the editor', async () => {
    const workflow = workflowOf(
      'wf_tf_pages',
      [
        formTrigger('tf-pages', { responseMode: 'lastNode' }),
        { name: 'Details', type: 'core.form', parameters: { operation: 'page', formTitle: 'Details', formFields: { values: [{ fieldLabel: 'Email', fieldType: 'email', requiredField: true }] } } },
        { name: 'End', type: 'core.form', parameters: { operation: 'completion', respondWith: 'text', completionTitle: 'All done', completionMessage: 'Thanks {{ $json.Email }}' } },
      ],
      [
        ['Form', 'Details'],
        ['Details', 'End'],
      ],
    );
    const listening = await listen('wf_tf_pages', 'Form', workflow);
    const { executionId, kind } = await listening.next('listening');
    expect(kind).toBe('form');

    // GET shows the form, as often as you like.
    for (let i = 0; i < 2; i++) {
      const page = await formGet('tf-pages');
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<h1>Apply</h1>');
      expect(html).toContain('action="/form-test/tf-pages"');
    }
    // A submission that fails the checks doesn't use the listener up.
    const invalid = await formPost('tf-pages', formBody({}));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('This field is required');

    const first = await formPost('tf-pages', formBody({ f0: 'Ada' }));
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe(`/form/waiting/${executionId}`);
    // Waiting for page 2: the stream follows on; the test URL sends a reload to that page, a second submit too.
    await vi.waitFor(() => expect(listening.executionEvents().some((e) => e.type === 'execution.finished' && e.status === 'waiting')).toBe(true));
    expect(listening.events.some((e) => e.event === 'result')).toBe(false);
    expect((await formGet('tf-pages')).headers.get('location')).toBe(`/form/waiting/${executionId}`);
    expect((await formPost('tf-pages', formBody({ f0: 'Again' }))).headers.get('location')).toBe(`/form/waiting/${executionId}`);

    const page2 = await formWaitingRoute.GET(request(`/form/waiting/${executionId}`), params({ id: executionId }));
    expect(await page2.text()).toContain('<h1>Details</h1>');
    const end = await formWaitingRoute.POST(request(`/form/waiting/${executionId}`, formBody({ f0: 'ada@example.com' })), params({ id: executionId }));
    expect(await end.text()).toContain('Thanks ada@example.com');

    expect(await listening.next('result')).toEqual({ executionId, status: 'success' });
    await listening.closed;
    const events = listening.executionEvents();
    expect(events.filter((e) => e.type === 'execution.started')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'node.finished').map((e) => (e as { nodeName: string }).nodeName)).toEqual(['Form', 'Details', 'End']);
    const record = stored(executionId);
    expect(record).toMatchObject({ mode: 'manual', status: 'success' });
    expect(outputOf(record, 'Form')).toEqual([{ Name: 'Ada', Resume: '', submittedAt: expect.any(String), formMode: 'test' }]);
    expect(outputOf(record, 'Details')).toEqual([{ Email: 'ada@example.com', submittedAt: expect.any(String), formMode: 'test' }]);
    // The run is over: so is the test URL.
    expect((await formGet('tf-pages')).status).toBe(404);
  });

  it('shows the end screen at once with “Form Is Submitted”, and stays until the run finishes', async () => {
    gate.closed = true;
    try {
      const listening = await listen('wf_tf_quick', 'Form', workflowOf('wf_tf_quick', [formTrigger('tf-quick'), gateNode], [['Form', 'Gate']]));
      const { executionId } = await listening.next('listening');
      const done = await formPost('tf-quick', formBody({ f0: 'Ada' }));
      expect(done.status).toBe(200);
      expect(await done.text()).toContain('Got it');
      await vi.waitFor(() => expect(gate.held.length).toBe(1));
      const meanwhile = await formGet('tf-quick');
      expect(meanwhile.status).toBe(200);
      expect(await meanwhile.text()).toContain('This test form was submitted');
      expect((await formPost('tf-quick', formBody({ f0: 'Bob' }))).status).toBe(409);
      release();
      expect(await listening.next('result')).toEqual({ executionId, status: 'success' });
      await listening.closed;
      expect((await formGet('tf-quick')).status).toBe(404);
    } finally {
      gate.closed = false;
      release();
    }
  });

  it('checks the trigger’s authentication', async () => {
    const login = credentials.create({ name: 'Test form login', type: 'core.httpBasicAuth', data: { user: 'ada', password: 'lovelace' } });
    const listening = await listen('wf_tf_auth', 'Form', workflowOf('wf_tf_auth', [formTrigger('tf-auth', { authentication: 'basicAuth' }, { httpBasicAuth: { id: login.id, name: login.name } })], []));
    const denied = await formGet('tf-auth');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/^Basic realm="Form"/);
    expect((await formPost('tf-auth', formBody({ f0: 'Ada' }))).status).toBe(401);
    const authorization = `Basic ${Buffer.from('ada:lovelace').toString('base64')}`;
    expect((await formGet('tf-auth', { authorization })).status).toBe(200);
    const done = await formPost('tf-auth', { ...formBody({ f0: 'Ada' }), headers: { 'content-type': 'application/x-www-form-urlencoded', authorization } });
    expect(await done.text()).toContain('Got it');
    expect((await listening.next('result')).status).toBe('success');
  });

  it('stores file fields as item.binary', async () => {
    const listening = await listen('wf_tf_upload', 'Form', workflowOf('wf_tf_upload', [formTrigger('tf-upload'), noOp('After')], [['Form', 'After']]));
    const { executionId } = await listening.next('listening');
    const body = new FormData();
    body.append('f0', 'Ada');
    body.append('f1', new File(['%PDF-1.4 cv'], 'cv.pdf', { type: 'application/pdf' }));
    expect((await formPost('tf-upload', { method: 'POST', body })).status).toBe(200);
    expect((await listening.next('result')).status).toBe('success');
    const item = stored(executionId)?.runData.After?.at(-1)?.outputs[0]?.[0];
    expect(item?.json).toMatchObject({ Name: 'Ada', Resume: 'cv.pdf', formMode: 'test' });
    expect(item?.binary?.Resume).toMatchObject({ fileName: 'cv.pdf', mimeType: 'application/pdf', fileSize: 11 });
  });
});

// ---------------------------------------------------------------------------
// The MCP Server Trigger's test URL
// ---------------------------------------------------------------------------

type McpHandler = (request: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
/** A fetch that answers through the /mcp-test/<path> route's handlers. */
const mcpFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);
  const segments = new URL(req.url).pathname.split('/').filter(Boolean).slice(1);
  return (testMcpRoute as unknown as Record<string, McpHandler>)[req.method](req, params({ path: segments }));
};
async function mcpClient(path: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'landflow-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://test-hooks.test/mcp-test/${path}`), { fetch: mcpFetch, requestInit: { headers } }));
  return client;
}
const resultText = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;

describe('test MCP Server Trigger', () => {
  /** An MCP Server Trigger with the Calculator tool (and `more` nodes after it). */
  const tools = (id: string, path: string, extra: Record<string, unknown> = {}, creds?: N['credentials'], more: N[] = [], edges: Array<[string, string]> = []): Workflow => {
    const workflow = workflowOf(id, [{ name: 'MCP', type: 'core.mcpTrigger', parameters: { path, ...extra }, ...(creds && { credentials: creds }) }, { name: 'Calculator', type: 'core.calculatorTool' }, ...more], edges);
    return { ...workflow, connections: [...workflow.connections, { id: 'tool', type: 'ai_tool', source: 'Calculator', target: 'MCP', sourceIndex: 0, targetIndex: 0 }] };
  };
  const results = (listening: Listening) => listening.events.filter((e) => e.event === 'result').map((e) => e.data as { executionId: string; status: string });

  it('serves the editor’s tools at /mcp-test/<path> while listening; each tool call is a manual run shown live', async () => {
    expect(isPublicPath('/mcp-test/team/tools')).toBe(true);
    expect(isPublicPath('/mcp-tester')).toBe(false);
    // Nobody listens: 404 with the hint.
    await expect(mcpClient('tm-basic')).rejects.toMatchObject({ code: 404 });
    const miss = await mcpFetch('http://test-hooks.test/mcp-test/tm-basic', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect((await miss.json()).error.message).toBe(`No editor is listening on /mcp-test/tm-basic. ${NOT_LISTENING_HINT}`);

    store.saveWorkflow(tools('wf_tm_basic', 'tm-basic', { instructions: 'Saved version' }));
    const listening = await listen('wf_tm_basic', 'MCP', tools('wf_tm_basic', 'tm-basic', { instructions: 'Editor version' }));
    const info = await listening.next('listening');
    expect(info).toMatchObject({ nodeId: 'MCP', kind: 'mcp', path: 'tm-basic', executionId: expect.stringMatching(/^ex_/) });
    expect(info.method).toBeUndefined();
    // The production URL serves published workflows only.
    expect((await mcpRoute.POST(request('/mcp/tm-basic', { method: 'POST', body: '{}' }), params({ path: ['tm-basic'] }))).status).toBe(404);

    // The workflow the editor sent, unsaved changes included; tools/list isn't recorded.
    const client = await mcpClient('tm-basic');
    expect(client.getInstructions()).toBe('Editor version');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['Calculator']);
    const executions = () => store.listExecutions({ workflowId: 'wf_tm_basic' });
    expect(executions()).toHaveLength(0);

    const sum = await client.callTool({ name: 'Calculator', arguments: { expression: '6*7' } });
    expect(sum.isError).toBeFalsy();
    expect(JSON.parse(resultText(sum))).toMatchObject({ result: 42 });
    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(resultText(unknown)).toMatch(/Unknown tool "nope"/);

    // Each call is its own manual run (`<the listener's id>-<suffix>`), streamed to the editor with its result.
    await vi.waitFor(() => expect(results(listening)).toHaveLength(2));
    const [first, second] = results(listening);
    expect([first.status, second.status]).toEqual(['success', 'error']);
    expect(first.executionId).toMatch(new RegExp(`^${info.executionId}-`));
    expect(second.executionId).toMatch(new RegExp(`^${info.executionId}-`));
    expect(first.executionId).not.toBe(second.executionId);
    expect(resultText(unknown)).toContain(second.executionId);
    const started = listening.executionEvents().filter((e) => e.type === 'execution.started');
    expect(started.map((e) => [e.executionId, (e as { mode?: string }).mode])).toEqual([
      [first.executionId, 'manual'],
      [second.executionId, 'manual'],
    ]);
    expect(executions().map((e) => e.mode)).toEqual(['manual', 'manual']);
    expect(stored(first.executionId)).toMatchObject({ workflowId: 'wf_tm_basic', status: 'success' });

    // Still listening (each call pushed its deadline on and told the editor), until Stop.
    expect(listening.events.filter((e) => e.event === 'listening').length).toBeGreaterThan(1);
    expect(listening.events.some((e) => e.event === 'timeout' || e.event === 'stopped')).toBe(false);
    expect((await client.callTool({ name: 'Calculator', arguments: { expression: '1+2' } })).isError).toBeFalsy();
    await vi.waitFor(() => expect(results(listening)).toHaveLength(3));
    await client.close();
    listening.stop();
    await listening.closed;
    await expect(mcpClient('tm-basic')).rejects.toMatchObject({ code: 404 });
  });

  it('listens 120 s past the last request, and times out when none comes', async () => {
    const started = await startListening(tools('wf_tm_deadline', 'tm-deadline'), 'MCP');
    if (!started.ok) throw new Error(started.error);
    // Its clock, run fast: a second left.
    started.listener.expiresAt = Date.now() + 1_000;
    const abort = new AbortController();
    const listening = readEvents(listenerStream(started.listener, abort.signal), abort);
    expect((await listening.next('listening')).timeoutMs).toBeLessThanOrEqual(1_000);
    // Requests that start no run (initialize, tools/list) push the deadline on too; the editor hears the new one.
    const client = await mcpClient('tm-deadline');
    await client.listTools();
    await vi.waitFor(() => expect(listening.events.filter((e) => e.event === 'listening')).toHaveLength(2), { timeout: 5_000 });
    expect(listening.events.at(-1)?.data.timeoutMs).toBeGreaterThan(TEST_LISTEN_MS - 5_000);
    expect(listening.events.some((e) => e.event === 'timeout')).toBe(false);
    await client.close();
    listening.stop();
    await listening.closed;

    const idle = await startListening(tools('wf_tm_idle', 'tm-idle'), 'MCP');
    if (!idle.ok) throw new Error(idle.error);
    idle.listener.expiresAt = Date.now() + 50;
    const quiet = readEvents(listenerStream(idle.listener, new AbortController().signal));
    expect((await quiet.next('timeout')).message).toBe('No MCP request arrived within 120 s');
    await quiet.closed;
    await expect(mcpClient('tm-idle')).rejects.toMatchObject({ code: 404 });
  });

  it('checks the trigger’s bearer auth, and keeps one workflow per test URL', async () => {
    const token = credentials.create({ name: 'Test MCP token', type: 'core.httpBearerAuth', data: { token: 'tm-secret' } });
    const listening = await listen('wf_tm_auth', 'MCP', tools('wf_tm_auth', 'tm-auth', { authentication: 'bearerAuth' }, { httpBearerAuth: { id: token.id, name: token.name } }));
    await expect(mcpClient('tm-auth')).rejects.toMatchObject({ code: 401 });
    await expect(mcpClient('tm-auth', { Authorization: 'Bearer wrong' })).rejects.toMatchObject({ code: 401 });
    const client = await mcpClient('tm-auth', { Authorization: 'Bearer tm-secret' });
    expect((await client.callTool({ name: 'Calculator', arguments: { expression: '2+2' } })).isError).toBeFalsy();
    await client.close();
    expect(results(listening).map((r) => r.status)).toEqual(['success']);

    const other = await listen('wf_tm_other', 'MCP', tools('wf_tm_other', 'tm-auth'));
    expect(other.response.status).toBe(409);
    expect((await other.response.json()).error).toBe('Another workflow (“wf_tm_auth”) is listening on /mcp-test/tm-auth');
    listening.stop();
    await listening.closed;
  });

  it('Stop cancels the tool calls that are going', async () => {
    gate.closed = true;
    try {
      const listening = await listen('wf_tm_stop', 'MCP', tools('wf_tm_stop', 'tm-stop', {}, undefined, [gateNode], [['MCP', 'Gate']]));
      const client = await mcpClient('tm-stop');
      const answer = client.callTool({ name: 'Calculator', arguments: { expression: '1+1' } });
      await vi.waitFor(() => expect(gate.held.length).toBe(1));
      const runId = listening.executionEvents().find((e) => e.type === 'execution.started')!.executionId;
      listening.stop();
      expect((await answer).isError).toBe(true);
      await vi.waitFor(() => expect(stored(runId)?.status).toBe('canceled'));
      await client.close();
    } finally {
      gate.closed = false;
      release();
    }
  });
});

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

describe('tracing test calls', () => {
  const spans = new InMemorySpanExporter();
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });
  beforeEach(() => spans.reset());
  const named = (name: string, workflowId: string) => spans.getFinishedSpans().filter((span) => span.name === name && span.attributes['landflow.workflow.id'] === workflowId);

  it('samples the trigger URLs, production and test alike', () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(isTracedRequest(method, '/api/webhook/orders')).toBe(true);
      expect(isTracedRequest(method, '/api/webhook-test/orders')).toBe(true);
    }
    for (const path of ['/form/signup', '/form-test/signup', '/mcp/tools', '/mcp-test/tools']) {
      expect(isTracedRequest('POST', path), path).toBe(true);
      // Showing a form isn't a trigger call.
      expect(isTracedRequest('GET', path), path).toBe(false);
    }
    expect(isTracedRequest('POST', '/api/workflows/wf_1/listen')).toBe(true);
    expect(isTracedRequest('POST', '/mcp-tester')).toBe(false);
  });

  it('traces a test call as a trigger.fire with landflow.trigger.test, and the listening as trigger.listen', async () => {
    const listening = await listen('wf_tt_trace', 'Hook', workflowOf('wf_tt_trace', [hook('tt-trace'), setX('traced')], [['Hook', 'Set']]));
    const { executionId, listenerId } = await listening.next('listening');
    expect((await postJson('tt-trace', {})).status).toBe(200);
    await listening.closed;
    await vi.waitFor(() => expect(named('trigger.listen', 'wf_tt_trace')).toHaveLength(1));
    const [fire] = named('trigger.fire', 'wf_tt_trace');
    expect(fire.attributes).toMatchObject({ 'landflow.trigger.source': 'webhook', 'landflow.trigger.test': true, 'landflow.node.name': 'Hook' });
    // The run is inside it, as on the production URL.
    const execute = spans.getFinishedSpans().find((span) => span.name === 'workflow.execute' && span.parentSpanContext?.spanId === fire.spanContext().spanId);
    expect(execute).toBeDefined();
    expect(named('trigger.listen', 'wf_tt_trace')[0].attributes).toMatchObject({
      'landflow.trigger.source': 'webhook',
      'landflow.trigger.test': true,
      'landflow.listener.id': listenerId,
      'landflow.execution.id': executionId,
      'landflow.node.name': 'Hook',
      'landflow.listen.outcome': 'received',
    });

    // Production: the same span without the attribute.
    store.saveWorkflow(workflowOf('wf_tt_prod', [hook('tt-prod')], []));
    await publishDraft('wf_tt_prod');
    expect((await hookRoute.POST(request('/api/webhook/tt-prod', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), params({ path: ['tt-prod'] }))).status).toBe(200);
    const [production] = named('trigger.fire', 'wf_tt_prod');
    expect(production.attributes['landflow.trigger.source']).toBe('webhook');
    expect(production.attributes['landflow.trigger.test']).toBeUndefined();
  });

  it('ends an MCP listen span with its outcome and how many tool calls it took', async () => {
    const workflow = workflowOf('wf_tt_mcp', [{ name: 'MCP', type: 'core.mcpTrigger', parameters: { path: 'tt-mcp' } }, { name: 'Calculator', type: 'core.calculatorTool' }], []);
    workflow.connections.push({ id: 'tool', type: 'ai_tool', source: 'Calculator', target: 'MCP', sourceIndex: 0, targetIndex: 0 });
    const listening = await listen('wf_tt_mcp', 'MCP', workflow);
    const client = await mcpClient('tt-mcp');
    await client.callTool({ name: 'Calculator', arguments: { expression: '3*3' } });
    await client.callTool({ name: 'Calculator', arguments: { expression: '4*4' } });
    await client.close();
    await vi.waitFor(() => expect(listening.events.filter((e) => e.event === 'result')).toHaveLength(2));
    listening.stop();
    await listening.closed;
    await vi.waitFor(() => expect(named('trigger.listen', 'wf_tt_mcp')).toHaveLength(1));
    expect(named('trigger.listen', 'wf_tt_mcp')[0].attributes).toMatchObject({ 'landflow.trigger.source': 'mcp', 'landflow.listen.outcome': 'closed', 'landflow.listen.calls': 2 });
    const fires = named('trigger.fire', 'wf_tt_mcp');
    expect(fires).toHaveLength(2);
    expect(fires.every((span) => span.attributes['landflow.trigger.source'] === 'mcp' && span.attributes['landflow.trigger.test'] === true)).toBe(true);
  });
});
