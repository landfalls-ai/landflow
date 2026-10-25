/**
 * External secrets against the real OpenBao of the landflow-infra stack (deploy/compose.infra.yml, profile secrets:
 * http://127.0.0.1:58200, root token landflow-dev-root-token, KV v2 at landflow/, sample landflow/dev/hello).
 * Runs only with LANDFLOW_INTEGRATION=secrets (comma-separated list); the setup enables AppRole through the API,
 * idempotently, with a read-only policy for landflow/dev. Covers token and AppRole auth, listing, reading, lease
 * renewal, and a workflow whose credential reads a secret, with the value redacted from the stored run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

const ENABLED = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim()).includes('secrets');
const BAO = process.env.LANDFLOW_OPENBAO_URL ?? 'http://127.0.0.1:58200';
const ROOT = process.env.LANDFLOW_OPENBAO_TOKEN ?? 'landflow-dev-root-token';
const ROLE = 'landflow-tests';
const POLICY = 'landflow-tests-read';

vi.setConfig({ testTimeout: 30_000 });

async function bao<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BAO}/v1/${path}`, { method, headers: { 'x-vault-token': ROOT, ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe.skipIf(!ENABLED)('OpenBao (landflow-infra)', () => {
  let roleId = '';
  let secretId = '';
  let modules: {
    PROVIDERS: typeof import('@/lib/server/secrets/providers').PROVIDERS;
    secrets: typeof import('@/lib/server/secrets');
  };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'landflow-openbao-'));
    Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    modules = { PROVIDERS: (await import('@/lib/server/secrets/providers')).PROVIDERS, secrets: await import('@/lib/server/secrets') };

    // AppRole, a read-only policy for landflow/dev and a role: each created when missing, so reruns are no-ops.
    const auths = await bao<Record<string, unknown>>('GET', 'sys/auth');
    if (!('approle/' in auths.body) && !(auths.body.data && 'approle/' in (auths.body.data as object))) {
      const enabled = await bao('POST', 'sys/auth/approle', { type: 'approle' });
      if (enabled.status >= 300 && !/already in use/.test(JSON.stringify(enabled.body))) throw new Error(`enable approle: ${enabled.status} ${JSON.stringify(enabled.body)}`);
    }
    const policy = ['path "landflow/data/dev/*" { capabilities = ["read"] }', 'path "landflow/metadata/dev" { capabilities = ["list"] }', 'path "landflow/metadata/dev/*" { capabilities = ["list", "read"] }'].join('\n');
    await bao('PUT', `sys/policies/acl/${POLICY}`, { policy });
    await bao('POST', `auth/approle/role/${ROLE}`, { token_policies: [POLICY], token_ttl: '10m', token_max_ttl: '30m' });
    roleId = (await bao<{ data: { role_id: string } }>('GET', `auth/approle/role/${ROLE}/role-id`)).body.data.role_id;
    secretId = (await bao<{ data: { secret_id: string } }>('POST', `auth/approle/role/${ROLE}/secret-id`, {})).body.data.secret_id;
    // A JSON secret of the tests' own, next to the stack's sample.
    await bao('POST', 'landflow/data/dev/landflow-tests', { data: { password: 'openbao-integration-password', user: 'tests' } });
  });

  afterAll(() => modules?.secrets.externalSecrets.closeAll());

  it('reads the sample secret with the root token', async () => {
    const provider = modules.PROVIDERS.vault.create({ url: BAO, auth: 'token', token: ROOT, mount: 'landflow' }, {});
    const names = await provider.listNames();
    expect(names).toContain('dev/hello');
    const hello = (await provider.getSecret('dev/hello')) as Record<string, unknown>;
    expect(typeof hello.message).toBe('string');
    expect(String(hello.message).length).toBeGreaterThan(0);
    expect(await provider.getSecret('dev/does-not-exist')).toBeUndefined();
  });

  it('logs in with AppRole, lists under a prefix and renews its token', async () => {
    const provider = modules.PROVIDERS.vault.create({ url: BAO, auth: 'appRole', roleId, secretId, mount: 'landflow', pathPrefix: '{environment}' }, { environment: 'dev' }) as ReturnType<
      typeof modules.PROVIDERS.vault.create
    > & { renew(): Promise<boolean>; lease?: { leaseSeconds: number; renewable: boolean } };
    try {
      expect(await provider.listNames()).toEqual(expect.arrayContaining(['hello', 'landflow-tests']));
      expect(await provider.getSecret('landflow-tests')).toEqual({ password: 'openbao-integration-password', user: 'tests' });
      expect(provider.lease?.renewable).toBe(true);
      expect(provider.lease?.leaseSeconds).toBeGreaterThan(0);
      expect(await provider.renew()).toBe(true);
      // The policy is read-only on landflow/dev: anything else is refused.
      const outside = modules.PROVIDERS.vault.create({ url: BAO, auth: 'appRole', roleId, secretId, mount: 'landflow', pathPrefix: 'prod' }, {});
      await expect(outside.listNames().then(() => outside.getSecret('x'))).rejects.toThrow(/403|permission denied/);
      outside.close?.();
    } finally {
      provider.close?.();
    }
  });

  it('runs a workflow whose credential reads an OpenBao secret, redacted from the stored run', async () => {
    const { registry } = await import('@/lib/server/plugins/registry');
    const { corePlugin } = await import('@/lib/server/nodes');
    const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
    const { store } = await import('@/lib/server/store');
    const { credentials } = await import('@/lib/server/credentials/vault');
    const { runWorkflow } = await import('@/lib/server/runner');
    const { echoServer } = await import('./fake-secret-stores');
    registry.registerBuiltin(corePlugin);
    await ensureBootstrapped();
    const echo = await echoServer();
    try {
      modules.secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: BAO, auth: 'appRole', roleId, secretId, mount: 'landflow', pathPrefix: 'dev' } });
      expect(await modules.secrets.externalSecrets.test('bao')).toMatchObject({ ok: true });
      const credential = credentials.create({ name: 'Bao header', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: "{{ $secrets.bao['landflow-tests'].password }}" } });
      const workflow = store.saveWorkflow({
        id: 'wf_openbao',
        name: 'OpenBao',
        nodes: [
          { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          {
            id: 'Call',
            name: 'Call',
            type: 'core.httpRequest',
            typeVersion: 1,
            position: [200, 0],
            parameters: { method: 'GET', url: `${echo.url}/headers`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
            credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } },
          },
        ],
        connections: [{ id: 'e1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Call', targetIndex: 0 }],
      } as Workflow);
      const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
      expect(execution.status).toBe('success');
      expect(echo.requests.at(-1)!.headers['x-api-key']).toBe('openbao-integration-password');
      expect(JSON.stringify(store.getExecution(execution.executionId))).not.toContain('openbao-integration-password');
    } finally {
      await echo.close();
    }
  });
});
