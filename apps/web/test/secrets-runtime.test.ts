/**
 * External secrets on the host, against a fake Vault and a local echo server: Settings → External secrets through
 * its routes (providers saved encrypted, test, refresh, names but never values), `$secrets` in credential fields
 * resolved when a workflow runs (and not in node parameters, where it is refused by default), the short TTL cache with shared
 * in-flight reads, and redaction: what a node got from a secret never reaches the saved execution, its steps and
 * checkpoints, the logs or the error texts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import type { SecretProviderCheck, SecretProvidersResponse, SecretProviderView } from '@/lib/shared/secrets';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-secrets-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_SECRETS_CACHE_TTL: '60' });
delete process.env.LANDFLOW_ENVIRONMENT;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { runWorkflow } = await import('@/lib/server/runner');
const { writeRecord } = await import('@/lib/server/telemetry/logger');
const secrets = await import('@/lib/server/secrets');
const listRoute = await import('@/app/api/external-secrets/route');
const oneRoute = await import('@/app/api/external-secrets/[name]/route');
const testRoute = await import('@/app/api/external-secrets/[name]/test/route');
const refreshRoute = await import('@/app/api/external-secrets/[name]/refresh/route');
const credentialTestRoute = await import('@/app/api/credentials/test/route');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const { fakeVault, echoServer } = await import('./fake-secret-stores');

const SECRET = 'hello from vault';
const DB_PASSWORD = 'S3cret-Passw0rd-9876';

const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://secrets.test${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const read = async <T>(response: Response) => ({ status: response.status, body: (await response.json()) as T & { error?: string } });

/** Holds runs that reach it until released, so the checkpoint of the node before it can be read. */
const gate = { closed: false, release: undefined as (() => void) | undefined, reached: undefined as (() => void) | undefined };
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'secretstest', name: 'Secrets test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'gate', displayName: 'Gate', description: 'Holds while closed', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        async execute(c) {
          if (gate.closed) {
            gate.reached?.();
            await new Promise<void>((resolve) => (gate.release = resolve));
          }
          return [c.getInputData()];
        },
      }),
    ],
  }),
);

let vault: Awaited<ReturnType<typeof fakeVault>>;
let echo: Awaited<ReturnType<typeof echoServer>>;
let credentialId: string;

beforeAll(async () => {
  await ensureBootstrapped();
  vault = await fakeVault({ rootToken: 'root-token-abcdef' });
  vault.kv.secret = { 'dev/hello': { message: SECRET }, 'dev/db': { password: DB_PASSWORD, user: 'app' }, plain: { value: 'a-plain-value' } };
  echo = await echoServer();
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await vault.close();
  await echo.close();
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });
const httpNode = (url: string, id = credentialId) =>
  node('Call', 'core.httpRequest', { method: 'GET', url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, { credentials: { httpHeaderAuth: { id, name: 'Vault header' } } });
const workflowOf = (id: string, nodes: ReturnType<typeof node>[]): Workflow =>
  store.saveWorkflow({
    id,
    name: id,
    nodes: [node('Start', 'core.manualTrigger'), ...nodes],
    connections: nodes.map((n, i) => ({ id: `e${i}`, type: 'main' as const, source: i ? nodes[i - 1].id : 'Start', sourceIndex: 0, target: n.id, targetIndex: 0 })),
  } as Workflow);

/** Every stored row of a run (execution, steps, checkpoint) as text. */
const storedRows = (executionId: string) =>
  JSON.stringify([
    database().all('SELECT * FROM executions WHERE id = ?', executionId),
    database().all('SELECT * FROM execution_steps WHERE execution_id = ?', executionId),
    database().all('SELECT * FROM execution_checkpoints WHERE execution_id = ?', executionId),
  ]);

describe('Settings → External secrets', () => {
  it('adds a provider with its token sealed, and never returns the token', async () => {
    const created = await read<SecretProviderView>(await listRoute.POST(request('/api/external-secrets', 'POST', { name: 'vault', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'root-token-abcdef' } })));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'vault', kind: 'vault', enabled: true, secretsSet: ['token'], settings: { url: vault.url, auth: 'token' } });
    expect(JSON.stringify(created.body)).not.toContain('root-token-abcdef');
    const row = database().get<{ secrets: string; settings: string }>('SELECT secrets, settings FROM external_secret_providers WHERE name = ?', 'vault')!;
    expect(row.secrets).not.toContain('root-token-abcdef');
    expect(row.settings).not.toContain('root-token-abcdef');

    const list = await read<SecretProvidersResponse>(await listRoute.GET(request('/api/external-secrets')));
    expect(list.body.kinds.map((k) => k.kind)).toEqual(['vault', 'onePassword', 'awsSecretsManager', 'gcpSecretManager', 'azureKeyVault']);
    expect(list.body.cacheTtlSeconds).toBe(60);
    expect(JSON.stringify(list.body)).not.toContain('root-token-abcdef');
  });

  it('tests, refreshes and lists names (never values)', async () => {
    const check = await read<SecretProviderCheck>(await testRoute.POST(new Request('http://secrets.test/api/external-secrets/vault/test', { method: 'POST' }), ctx({ name: 'vault' })));
    expect(check.body).toMatchObject({ ok: true, message: '3 secrets in secret/', count: 3 });
    const refreshed = await read<SecretProviderView>(await refreshRoute.POST(new Request('http://secrets.test/api/external-secrets/vault/refresh', { method: 'POST' }), ctx({ name: 'vault' })));
    expect(refreshed.body.names).toEqual(['dev/db', 'dev/hello', 'plain']);
    expect(refreshed.body.lastCheck?.ok).toBe(true);
    expect(JSON.stringify(refreshed.body)).not.toContain(SECRET);
    expect(JSON.stringify(refreshed.body)).not.toContain(DB_PASSWORD);
    expect(secrets.externalSecrets.names()).toEqual({ vault: ['dev/db', 'dev/hello', 'plain'] });
  });

  it('tests an unsaved configuration without storing it, and validates', async () => {
    const unsaved = await read<SecretProviderCheck>(await testRoute.POST(request('/api/external-secrets/draft/test', 'POST', { kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'wrong-token-zzz' } }), ctx({ name: 'draft' })));
    expect(unsaved.body.ok).toBe(false);
    expect(unsaved.body.message).toMatch(/403/);
    expect(unsaved.body.message).not.toContain('wrong-token-zzz');
    expect(secrets.externalSecrets.get('draft')).toBeUndefined();
    expect((await listRoute.POST(request('/api/external-secrets', 'POST', { name: '1bad', kind: 'vault', settings: { url: vault.url, token: 'x' } }))).status).toBe(400);
    expect((await listRoute.POST(request('/api/external-secrets', 'POST', { name: 'vault', kind: 'vault', settings: { url: vault.url, token: 'x' } }))).status).toBe(409);
    expect((await listRoute.POST(request('/api/external-secrets', 'POST', { name: 'other', kind: 'vault', settings: { url: vault.url, auth: 'token' } }))).status).toBe(400);
    // A secret setting left empty keeps its value.
    const patched = await read<SecretProviderView>(await oneRoute.PATCH(request('/api/external-secrets/vault', 'PATCH', { settings: { token: '', mount: 'secret' } }), ctx({ name: 'vault' })));
    expect(patched.body.secretsSet).toEqual(['token']);
    expect((await secrets.externalSecrets.test('vault')).ok).toBe(true);
  });
});

describe('$secrets in credentials', () => {
  beforeAll(() => {
    credentialId = credentials.create({ name: 'Vault header', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: "{{ $secrets.vault['dev/hello'].message }}" } }).id;
  });

  it('shows a reference in a secret field (it holds no secret) and resolves it when the node runs', async () => {
    const detail = await read<{ credential: { data: Record<string, unknown>; secrets: string[] } }>(await credentialRoute.GET(request(`/api/credentials/${credentialId}`), ctx({ id: credentialId })));
    expect(detail.body.credential.data.value).toBe("{{ $secrets.vault['dev/hello'].message }}");
    expect(detail.body.credential.secrets).toEqual([]);

    const workflow = workflowOf('wf_secret_header', [httpNode(`${echo.url}/headers`)]);
    const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('success');
    // The echo server got the real value…
    const sent = echo.requests.at(-1)!;
    expect(sent.headers['x-api-key']).toBe(SECRET);
    // …but the run holds it redacted everywhere.
    const output = execution.runData.Call[0].outputs?.[0]?.[0]?.json as { headers: Record<string, string> };
    expect(output.headers['x-api-key']).toBe(secrets.REDACTED);
    const rows = storedRows(execution.executionId);
    expect(rows).not.toContain(SECRET);
    expect(rows).toContain(secrets.REDACTED);
    expect(JSON.stringify(store.getExecution(execution.executionId))).not.toContain(SECRET);
  });

  it('keeps values out of checkpoints and steps while a run is in flight', async () => {
    const workflow = workflowOf('wf_secret_gate', [httpNode(`${echo.url}/headers`), node('Hold', 'secretstest.gate')]);
    gate.closed = true;
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    const running = runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    await reached;
    const executionId = database().get<{ id: string }>("SELECT id FROM executions WHERE workflow_id = 'wf_secret_gate' ORDER BY started_at DESC")!.id;
    await vi.waitFor(() => expect(database().all('SELECT * FROM execution_steps WHERE execution_id = ?', executionId).length).toBeGreaterThan(0));
    const rows = storedRows(executionId);
    expect(rows).toContain('x-api-key');
    expect(rows).not.toContain(SECRET);
    gate.closed = false;
    gate.release?.();
    expect((await running).status).toBe('success');
  });

  it('redacts a secret a node error carries', async () => {
    const workflow = workflowOf('wf_secret_error', [httpNode(`${echo.url}/fail`)]);
    const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    const text = JSON.stringify(store.getExecution(execution.executionId));
    expect(text).toContain('rejected');
    // Redacted (credential values are masked in node errors already; secret values are on top of that).
    expect(text).toMatch(/rejected \[redacted\]/i);
    expect(text).not.toContain(SECRET);
    expect(storedRows(execution.executionId)).not.toContain(SECRET);
  });

  it('redacts log lines', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      writeRecord('warn', `upstream said ${SECRET}`, { 'http.header': `X-Api-Key: ${SECRET}`, nested: { value: SECRET } });
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('')).toContain(secrets.REDACTED);
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('refuses $secrets in node parameters by default (Settings → External secrets allows them: secrets-parameters.test.ts)', async () => {
    const workflow = workflowOf('wf_secret_param', [node('Set', 'core.set', { mode: 'json', json: "={{ JSON.stringify({ v: $secrets.vault['dev/hello'].message }) }}" })]);
    const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    expect(JSON.stringify(execution)).toMatch(/can’t be used in node parameters on this instance/);
  });

  it('fails the node with the reason when a secret can’t be read', async () => {
    const missing = credentials.create({ name: 'Missing', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: '{{ $secrets.nope.thing }}' } });
    const execution = await runWorkflow({ workflow: workflowOf('wf_secret_missing', [httpNode(`${echo.url}/headers`, missing.id)]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    expect(JSON.stringify(execution)).toMatch(/External secrets provider “nope” isn’t set up on this instance/);
    const gone = credentials.create({ name: 'Gone', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: "{{ $secrets.vault['dev/gone'].x }}" } });
    const second = await runWorkflow({ workflow: workflowOf('wf_secret_gone', [httpNode(`${echo.url}/headers`, gone.id)]), mode: 'manual', startNodeId: 'Start' });
    expect(JSON.stringify(second)).toMatch(/\$secrets\.vault\['dev\/gone'\] doesn’t exist/);
  });

  it('resolves for Test connection, redacted', async () => {
    const response = await read<{ ok: boolean; message?: string }>(
      await credentialTestRoute.POST(request('/api/credentials/test', 'POST', { type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: '{{ $secrets.nope.thing }}' } })),
    );
    expect(response.body.ok).toBe(false);
    expect(response.body.message).toMatch(/isn’t set up/);
  });

  it('resolves interpolated, keyed and bracketed references', async () => {
    const data = await secrets.resolveCredentialData({ a: "Bearer {{ $secrets.vault['dev/db'].password }}", b: '{{ $secrets.vault.plain.value }}', c: 'literal {{ not a secret }}', n: 5 });
    expect(data).toEqual({ a: `Bearer ${DB_PASSWORD}`, b: 'a-plain-value', c: 'literal {{ not a secret }}', n: 5 });
    expect(secrets.redactText(`password=${DB_PASSWORD}`)).toBe(`password=${secrets.REDACTED}`);
    expect(secrets.referencedSecrets({ x: "{{ $secrets.vault['dev/db'].password }} {{ $secrets.vault['dev/db'].user }}" })).toEqual([
      { provider: 'vault', name: 'dev/db', key: 'password' },
      { provider: 'vault', name: 'dev/db', key: 'user' },
    ]);
  });
});

describe('caching', () => {
  it('reuses a value for the TTL, shares in-flight reads and forgets on refresh or change', async () => {
    secrets.externalSecrets.clearCache();
    const before = secrets.externalSecrets.stats().fetches;
    await Promise.all([secrets.externalSecrets.read('vault', 'dev/db'), secrets.externalSecrets.read('vault', 'dev/db'), secrets.externalSecrets.read('vault', 'dev/db')]);
    expect(secrets.externalSecrets.stats().fetches).toBe(before + 1);
    await secrets.externalSecrets.read('vault', 'dev/db');
    expect(secrets.externalSecrets.stats().fetches).toBe(before + 1);

    // A changed value shows after a refresh.
    vault.kv.secret['dev/db'] = { password: 'rotated-password-1111', user: 'app' };
    expect(await secrets.externalSecrets.read('vault', 'dev/db')).toMatchObject({ password: DB_PASSWORD });
    await secrets.externalSecrets.refresh('vault');
    expect(await secrets.externalSecrets.read('vault', 'dev/db')).toMatchObject({ password: 'rotated-password-1111' });

    // TTL 0: every read reaches the provider.
    process.env.LANDFLOW_SECRETS_CACHE_TTL = '0';
    try {
      const at = secrets.externalSecrets.stats().fetches;
      await secrets.externalSecrets.read('vault', 'plain');
      await secrets.externalSecrets.read('vault', 'plain');
      expect(secrets.externalSecrets.stats().fetches).toBe(at + 2);
    } finally {
      process.env.LANDFLOW_SECRETS_CACHE_TTL = '60';
    }

    // Turned off: references fail; a row changed elsewhere (another process) rebuilds the provider.
    await oneRoute.PATCH(request('/api/external-secrets/vault', 'PATCH', { enabled: false }), ctx({ name: 'vault' }));
    await expect(secrets.externalSecrets.read('vault', 'plain')).rejects.toThrow(/turned off/);
    const row = database().get<Record<string, string | number>>('SELECT * FROM external_secret_providers WHERE name = ?', 'vault')!;
    database().upsert('external_secret_providers', { ...row, enabled: 1, updated_at: '2999-01-01T00:00:00.000Z' });
    expect(await secrets.externalSecrets.read('vault', 'plain')).toEqual({ value: 'a-plain-value' });
  });

  it('deletes a provider', async () => {
    secrets.externalSecrets.create({ name: 'temp', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'root-token-abcdef' } });
    expect((await oneRoute.DELETE(request('/api/external-secrets/temp', 'DELETE'), ctx({ name: 'temp' }))).status).toBe(200);
    expect((await oneRoute.GET(request('/api/external-secrets/temp'), ctx({ name: 'temp' }))).status).toBe(404);
  });
});

describe('redaction', () => {
  it('leaves short values and unrelated text alone, and keeps JSON valid', () => {
    secrets.rememberSecretValues({ short: 'abc', long: 'value-with-"quotes"-and\\slash' });
    expect(secrets.redactText('abc is fine')).toBe('abc is fine');
    const json = JSON.stringify({ text: 'x value-with-"quotes"-and\\slash y', other: 1 });
    const redacted = secrets.redactJsonText(json);
    expect(JSON.parse(redacted)).toEqual({ text: `x ${secrets.REDACTED} y`, other: 1 });
    const error = secrets.redactValue(new Error(`failed with value-with-"quotes"-and\\slash`));
    expect(error.message).toBe(`failed with ${secrets.REDACTED}`);
  });
});
