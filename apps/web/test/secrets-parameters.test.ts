/**
 * `$secrets` in node parameters (Settings → External secrets → “Allow in node parameters”), against a fake Vault and
 * a local echo server: off by default (a clear node error), the setting through the route, resolution at run time,
 * and redaction of everything a run keeps or streams: outputs, stored execution rows, steps and checkpoints, live
 * events, node logs, errors the engine writes (an expression error quoting a value), derived values. Plus the
 * expression preview (masked) and the resolvers outside the engine (polls, app webhooks, agent tools).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { ExecutionEvent, Workflow } from '@landflow/engine';
import type { SecretProvidersResponse } from '@/lib/shared/secrets';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-secret-params-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_SECRETS_CACHE_TTL: '60' });
delete process.env.LANDFLOW_ENVIRONMENT;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { bus } = await import('@/lib/server/bus');
const { runWorkflow } = await import('@/lib/server/runner');
const secrets = await import('@/lib/server/secrets');
const listRoute = await import('@/app/api/external-secrets/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const { fakeVault, echoServer } = await import('./fake-secret-stores');

const SECRET = 'hello from vault';
const TOKEN = 'tok-param-7f3a9c21';

const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://secrets.test${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const read = async <T>(response: Response) => ({ status: response.status, body: (await response.json()) as T & { error?: string } });

/** Holds runs that reach it until released, so the checkpoint and steps of a run in flight can be read. */
const gate = { closed: false, release: undefined as (() => void) | undefined, reached: undefined as (() => void) | undefined };
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'paramsecrets', name: 'Parameter secrets test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: {
          name: 'echo',
          displayName: 'Echo',
          description: 'Logs and returns its parameter',
          version: 1,
          kind: 'action',
          inputs: [{ type: 'main' }],
          outputs: [{ type: 'main' }],
          properties: [{ name: 'value', displayName: 'Value', type: 'string', default: '' }],
        },
        async execute(c) {
          const value = c.getNodeParameter<string>('value', 0);
          c.logger.info(`echo got ${value}`);
          if (gate.closed) {
            gate.reached?.();
            await new Promise<void>((resolve) => (gate.release = resolve));
          }
          return [c.getInputData().map((item, i) => ({ json: { ...item.json, value: c.getNodeParameter('value', i) } }))];
        },
      }),
    ],
  }),
);

let vault: Awaited<ReturnType<typeof fakeVault>>;
let echo: Awaited<ReturnType<typeof echoServer>>;

beforeAll(async () => {
  await ensureBootstrapped();
  vault = await fakeVault({ rootToken: 'root-token-abcdef' });
  vault.kv.secret = { 'dev/hello': { message: SECRET }, api: { token: TOKEN } };
  echo = await echoServer();
  secrets.externalSecrets.create({ name: 'vault', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'root-token-abcdef' } });
  await secrets.externalSecrets.refresh('vault');
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await vault.close();
  await echo.close();
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });
const workflowOf = (id: string, nodes: ReturnType<typeof node>[]): Workflow =>
  store.saveWorkflow({
    id,
    name: id,
    nodes: [node('Start', 'core.manualTrigger'), ...nodes],
    connections: nodes.map((n, i) => ({ id: `e${i}`, type: 'main' as const, source: i ? nodes[i - 1].id : 'Start', sourceIndex: 0, target: n.id, targetIndex: 0 })),
  } as Workflow);

const storedRows = (executionId: string) =>
  JSON.stringify([
    database().all('SELECT * FROM executions WHERE id = ?', executionId),
    database().all('SELECT * FROM execution_steps WHERE execution_id = ?', executionId),
    database().all('SELECT * FROM execution_checkpoints WHERE execution_id = ?', executionId),
  ]);

const setAllowed = async (allowInParameters: boolean) => read<{ allowInParameters: boolean }>(await listRoute.PATCH(request('/api/external-secrets', 'PATCH', { allowInParameters })));

/** A run with every live event it streamed (the caller's and the bus's). */
async function runWithEvents(workflow: Workflow) {
  const events: ExecutionEvent[] = [];
  const published: unknown[] = [];
  const unsubscribe = bus.subscribe((event) => published.push(event));
  try {
    const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start', onEvent: (event) => events.push(event) });
    return { execution, events: JSON.stringify(events), published: JSON.stringify(published) };
  } finally {
    unsubscribe();
  }
}

describe('the setting', () => {
  it('is off by default, and a parameter that reads $secrets fails its node with how to allow it', async () => {
    const list = await read<SecretProvidersResponse>(await listRoute.GET(request('/api/external-secrets')));
    expect(list.body.allowInParameters).toBe(false);
    const execution = await runWorkflow({ workflow: workflowOf('wf_param_off', [node('Echo', 'paramsecrets.echo', { value: "{{ $secrets.vault['dev/hello'].message }}" })]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    expect(execution.runData.Echo[0].error?.message).toBe(secrets.PARAMETERS_NOT_ALLOWED);
    expect(execution.runData.Echo[0].error?.message).toMatch(/Allow in node parameters.*Settings → External secrets/);
    expect(JSON.stringify(execution)).not.toContain(SECRET);
  });

  it('changes through PATCH /api/external-secrets (validated) and shows in GET', async () => {
    expect((await listRoute.PATCH(request('/api/external-secrets', 'PATCH', { allowInParameters: 'yes' }))).status).toBe(400);
    expect((await listRoute.PATCH(request('/api/external-secrets', 'PATCH', { other: true }))).status).toBe(400);
    expect((await setAllowed(true)).body).toEqual({ allowInParameters: true });
    expect((await read<SecretProvidersResponse>(await listRoute.GET(request('/api/external-secrets')))).body.allowInParameters).toBe(true);
    expect(secrets.secretsAllowedInParameters()).toBe(true);
  });
});

describe('with node parameters allowed', () => {
  beforeAll(() => setAllowed(true));

  it('resolves at run time; the output that would hold the secret is redacted everywhere', async () => {
    const workflow = workflowOf('wf_param_set', [node('Set', 'core.set', { mode: 'json', json: "={{ JSON.stringify({ v: $secrets.vault['dev/hello'].message, n: 1 }) }}" })]);
    const { execution, events, published } = await runWithEvents(workflow);
    expect(execution.status).toBe('success');
    const output = execution.runData.Set[0].outputs[0][0].json as { v: string; n: number };
    expect(output).toEqual({ v: secrets.REDACTED, n: 1 });
    const rows = storedRows(execution.executionId);
    expect(rows).not.toContain(SECRET);
    expect(rows).toContain(secrets.REDACTED);
    expect(JSON.stringify(store.getExecution(execution.executionId))).not.toContain(SECRET);
    expect(events).not.toContain(SECRET);
    expect(published).not.toContain(SECRET);
    // The saved workflow keeps the expression, never the value.
    expect(JSON.stringify(store.getWorkflow('wf_param_set'))).toContain("$secrets.vault['dev/hello'].message");
  });

  it('sends the real value out (an HTTP header parameter) but keeps it out of the run', async () => {
    const workflow = workflowOf('wf_param_http', [
      node('Call', 'core.httpRequest', { method: 'GET', url: `${echo.url}/headers`, headers: { header: [{ name: 'X-Token', value: 'Bearer {{ $secrets.vault.api.token }}' }] } }),
    ]);
    const { execution, events } = await runWithEvents(workflow);
    expect(execution.status).toBe('success');
    expect(echo.requests.at(-1)!.headers['x-token']).toBe(`Bearer ${TOKEN}`);
    const output = execution.runData.Call[0].outputs[0][0].json as { headers: Record<string, string> };
    expect(output.headers['x-token']).toBe(secrets.REDACTED);
    expect(storedRows(execution.executionId)).not.toContain(TOKEN);
    expect(events).not.toContain(TOKEN);
  });

  it('redacts values derived from a secret, node logs and live log events', async () => {
    const workflow = workflowOf('wf_param_derived', [node('Echo', 'paramsecrets.echo', { value: '{{ $secrets.vault.api.token.toUpperCase() }}' })]);
    const { execution, events, published } = await runWithEvents(workflow);
    expect(execution.status).toBe('success');
    const upper = TOKEN.toUpperCase();
    expect(execution.runData.Echo[0].outputs[0][0].json.value).toBe(secrets.REDACTED);
    expect(JSON.stringify(execution.runData.Echo[0].logs)).toContain(`echo got ${secrets.REDACTED}`);
    expect(JSON.stringify(execution)).not.toContain(upper);
    expect(storedRows(execution.executionId)).not.toContain(upper);
    expect(events).not.toContain(upper);
    expect(published).not.toContain(upper);
  });

  it('keeps values out of steps and checkpoints while a run is in flight', async () => {
    const workflow = workflowOf('wf_param_gate', [node('First', 'paramsecrets.echo', { value: '{{ $secrets.vault.api.token }}' }), node('Hold', 'paramsecrets.echo', { value: 'x' })]);
    let executionId = '';
    const reached = new Promise<void>((resolve) => {
      gate.reached = () => {
        // Close only for the second node: the first one's output is in the steps by then.
        resolve();
      };
    });
    const running = runWorkflow({
      workflow,
      mode: 'manual',
      startNodeId: 'Start',
      onStart: (id) => (executionId = id),
      onEvent: (event) => {
        if (event.type === 'node.finished' && event.nodeId === 'First') gate.closed = true;
      },
    });
    await reached;
    await vi.waitFor(() => expect(database().all('SELECT * FROM execution_steps WHERE execution_id = ?', executionId).length).toBeGreaterThan(1));
    const rows = storedRows(executionId);
    expect(rows).toContain(secrets.REDACTED);
    expect(rows).not.toContain(TOKEN);
    gate.closed = false;
    gate.release?.();
    expect((await running).status).toBe('success');
  });

  it('redacts an expression error the engine writes when it quotes the value', async () => {
    const workflow = workflowOf('wf_param_error', [node('Echo', 'paramsecrets.echo', { value: "{{ JSON.parse($secrets.vault['dev/hello'].message) }}" })]);
    const { execution, events, published } = await runWithEvents(workflow);
    expect(execution.status).toBe('error');
    const message = execution.runData.Echo[0].error?.message ?? '';
    expect(message).toMatch(/Expression error/);
    // V8 quotes the text it couldn't parse: the secret, which is redacted.
    expect(message).toContain(secrets.REDACTED);
    expect(JSON.stringify(execution)).not.toContain(SECRET);
    expect(storedRows(execution.executionId)).not.toContain(SECRET);
    expect(events).not.toContain(SECRET);
    expect(published).not.toContain(SECRET);
  });

  it('fails the node with the reference when a secret is missing', async () => {
    const execution = await runWorkflow({ workflow: workflowOf('wf_param_missing', [node('Echo', 'paramsecrets.echo', { value: "{{ $secrets.vault['dev/gone'].x }}" })]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    expect(execution.runData.Echo[0].error?.message).toMatch(/\$secrets\.vault\['dev\/gone'\] doesn’t exist/);
  });

  it('serves resolvers outside the engine (polls, app webhooks, agent tools) and refuses when turned off', async () => {
    const parameters = { url: 'https://x/{{ $secrets.vault.api.token }}', code: '{{ $secrets.vault.never }}' };
    expect(await secrets.parameterSecrets(parameters, new Set(['code']))).toEqual({ vault: { api: { token: TOKEN } } });
    expect(await secrets.parameterSecrets({ url: '{{ $json.x }}' })).toBeUndefined();
    secrets.forgetSecretValues();
    secrets.rememberResolvedParameters({ a: { b: 'Basic {{ btoa($secrets.vault.api.token) }}' }, c: 'plain-text-value' }, { a: { b: 'Basic dG9rLXBhcmFt' }, c: 'plain-text-value' });
    expect(secrets.redactText('auth: Basic dG9rLXBhcmFt; plain-text-value')).toBe(`auth: ${secrets.REDACTED}; plain-text-value`);
    await setAllowed(false);
    await expect(secrets.parameterSecrets(parameters)).rejects.toThrow(secrets.PARAMETERS_NOT_ALLOWED);
    await setAllowed(true);
  });
});

describe('the expression preview', () => {
  const preview = async (value: string) => read<{ ok: boolean; value?: unknown; error?: string }>(await previewRoute.POST(request('/api/expressions/preview', 'POST', { value })));

  it('masks secrets (never reads them) and checks the names', async () => {
    const before = secrets.externalSecrets.stats().fetches;
    expect((await preview('Bearer {{ $secrets.vault.api.token }}')).body).toEqual({ ok: true, value: 'Bearer [secret]' });
    expect((await preview("{{ $secrets.vault['dev/hello'] }}")).body).toEqual({ ok: true, value: '[secret]' });
    expect(secrets.externalSecrets.stats().fetches).toBe(before);
    expect((await preview('{{ $secrets.nope.x }}')).body.error).toMatch(/No external secrets provider “nope”/);
    expect((await preview('{{ $secrets.vault.other }}')).body.error).toMatch(/doesn’t list a secret “other”/);
  });

  it('refuses $secrets while the setting is off', async () => {
    await setAllowed(false);
    try {
      const response = await preview('{{ $secrets.vault.api.token }}');
      expect(response.body).toEqual({ ok: false, error: secrets.PARAMETERS_NOT_ALLOWED });
    } finally {
      await setAllowed(true);
    }
  });
});
