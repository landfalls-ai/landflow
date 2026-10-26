/**
 * The AWS Secrets Manager provider against LocalStack (deploy/compose.infra.yml, profile `aws`:
 * `COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile aws up -d localstack`,
 * http://127.0.0.1:54566). Runs only with LANDFLOW_INTEGRATION=aws (comma-separated list).
 *
 * Local only: the endpoint is pinned to LocalStack (a loopback URL, checked before anything runs), the access keys are
 * dummies, and the shared AWS credentials and config files are turned off (AWS_SHARED_CREDENTIALS_FILE and
 * AWS_CONFIG_FILE = /dev/null, no profile, no instance metadata), so ~/.aws is never read. The test's secrets live under
 * a prefix of their own and are deleted at the end. Covers access-key and "environment" auth, listing under a prefix
 * with `{environment}`, JSON and plain secrets, a missing secret, and a workflow that reads a secret from a credential
 * field and from a node parameter, redacted from the stored run.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

const ENABLED = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim()).includes('aws');
const ENDPOINT = (process.env.LANDFLOW_LOCALSTACK_URL ?? 'http://127.0.0.1:54566').replace(/\/+$/, '');
const REGION = 'us-east-1';
/** LocalStack takes any keys; these are not real credentials. */
const KEYS = { accessKeyId: 'test', secretAccessKey: 'test' };
const RUN = `landflow-tests/${Date.now().toString(36)}`;
const DB_PASSWORD = 'localstack-db-password-4711';
const API_TOKEN = 'localstack-api-token-0815';

vi.setConfig({ testTimeout: 30_000 });

/** The AWS environment the tests run with: dummy keys, no shared files, no profile, no metadata service. */
const AWS_ENV: Record<string, string | undefined> = {
  AWS_SHARED_CREDENTIALS_FILE: devNull,
  AWS_CONFIG_FILE: devNull,
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
  AWS_SESSION_TOKEN: undefined,
  AWS_PROFILE: undefined,
  AWS_DEFAULT_PROFILE: undefined,
  AWS_REGION: REGION,
  AWS_DEFAULT_REGION: REGION,
  AWS_ENDPOINT_URL: ENDPOINT,
};

describe.skipIf(!ENABLED)('AWS Secrets Manager (LocalStack)', () => {
  const previous: Record<string, string | undefined> = {};
  const created: string[] = [];
  let modules: {
    aws: typeof import('@/lib/server/secrets/providers/aws');
    PROVIDERS: typeof import('@/lib/server/secrets/providers').PROVIDERS;
    secrets: typeof import('@/lib/server/secrets');
  };

  /** One signed Secrets Manager call to LocalStack (seeding and cleanup; the provider only lists and reads). */
  async function call(action: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const headers = modules.aws.signV4({
      method: 'POST',
      url: `${ENDPOINT}/`,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${action}` },
      body,
      region: REGION,
      service: 'secretsmanager',
      ...KEYS,
    });
    const response = await fetch(`${ENDPOINT}/`, { method: 'POST', headers, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`${action}: ${response.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  const createSecret = async (name: string, value: string) => {
    await call('CreateSecret', { Name: name, SecretString: value, ClientRequestToken: randomUUID() });
    created.push(name);
  };

  beforeAll(async () => {
    // Never anything but a loopback endpoint.
    const { hostname } = new URL(ENDPOINT);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) throw new Error(`LANDFLOW_LOCALSTACK_URL must be a local URL, not ${ENDPOINT}`);
    for (const [key, value] of Object.entries(AWS_ENV)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'landflow-localstack-'));
    Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    delete process.env.LANDFLOW_ENVIRONMENT;
    modules = { aws: await import('@/lib/server/secrets/providers/aws'), PROVIDERS: (await import('@/lib/server/secrets/providers')).PROVIDERS, secrets: await import('@/lib/server/secrets') };
    const health = (await (await fetch(`${ENDPOINT}/_localstack/health`)).json()) as { services?: Record<string, string> };
    expect(['available', 'running']).toContain(health.services?.secretsmanager);
    await createSecret(`${RUN}/dev/db`, JSON.stringify({ user: 'app', password: DB_PASSWORD }));
    await createSecret(`${RUN}/dev/api-token`, API_TOKEN);
    await createSecret(`${RUN}/prod/db`, JSON.stringify({ password: 'never-read-from-dev' }));
  });

  afterAll(async () => {
    modules?.secrets.externalSecrets.closeAll();
    for (const name of created) await call('DeleteSecret', { SecretId: name, ForceDeleteWithoutRecovery: true }).catch(() => undefined);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lists under a prefix with {environment} and reads JSON and plain secrets with access keys', async () => {
    const provider = modules.PROVIDERS.awsSecretsManager.create({ region: REGION, auth: 'accessKey', ...KEYS, endpoint: ENDPOINT, namePrefix: `${RUN}/{environment}/` }, { environment: 'dev' });
    expect(await provider.listNames()).toEqual(['api-token', 'db']);
    expect(await provider.test()).toBe(`2 secrets in ${REGION} under ${RUN}/dev/`);
    expect(await provider.getSecret('db')).toEqual({ user: 'app', password: DB_PASSWORD });
    expect(await provider.getSecret('api-token')).toBe(API_TOKEN);
    expect(await provider.getSecret('missing')).toBeUndefined();
  });

  it('takes "environment" keys from the variables only (never ~/.aws)', async () => {
    const provider = modules.PROVIDERS.awsSecretsManager.create({ region: REGION, auth: 'environment', endpoint: ENDPOINT, namePrefix: `${RUN}/dev/` }, {});
    expect(await provider.getSecret('db')).toMatchObject({ password: DB_PASSWORD });
    // Without the variables it refuses, whatever shared files exist on the host.
    const keyId = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_ACCESS_KEY_ID;
    try {
      expect(() => modules.PROVIDERS.awsSecretsManager.create({ region: REGION, auth: 'environment', endpoint: ENDPOINT }, {})).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set/);
    } finally {
      process.env.AWS_ACCESS_KEY_ID = keyId;
    }
  });

  it('runs a workflow that reads LocalStack secrets in a credential field and a node parameter, redacted from the run', async () => {
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
      const { externalSecrets, writeSecretsSettings } = modules.secrets;
      externalSecrets.create({ name: 'aws', kind: 'awsSecretsManager', settings: { region: REGION, auth: 'accessKey', ...KEYS, endpoint: ENDPOINT, namePrefix: `${RUN}/dev/` } });
      expect(await externalSecrets.test('aws')).toMatchObject({ ok: true, count: 2 });
      expect(externalSecrets.names().aws).toEqual(['api-token', 'db']);
      writeSecretsSettings({ allowInParameters: true });
      const credential = credentials.create({ name: 'AWS header', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: '{{ $secrets.aws.db.password }}' } });
      const workflow = store.saveWorkflow({
        id: 'wf_localstack',
        name: 'LocalStack',
        nodes: [
          { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          {
            id: 'Call',
            name: 'Call',
            type: 'core.httpRequest',
            typeVersion: 1,
            position: [200, 0],
            parameters: {
              method: 'GET',
              url: `${echo.url}/headers`,
              authentication: 'genericCredentialType',
              genericAuthType: 'httpHeaderAuth',
              headers: { header: [{ name: 'X-Token', value: "{{ $secrets.aws['api-token'] }}" }] },
            },
            credentials: { httpHeaderAuth: { id: credential.id, name: credential.name } },
          },
        ],
        connections: [{ id: 'e1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Call', targetIndex: 0 }],
      } as Workflow);
      const execution = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
      expect(execution.status).toBe('success');
      const sent = echo.requests.at(-1)!.headers;
      expect(sent['x-api-key']).toBe(DB_PASSWORD);
      expect(sent['x-token']).toBe(API_TOKEN);
      const stored = JSON.stringify(store.getExecution(execution.executionId));
      expect(stored).not.toContain(DB_PASSWORD);
      expect(stored).not.toContain(API_TOKEN);
      expect(stored).toContain(modules.secrets.REDACTED);
    } finally {
      modules.secrets.writeSecretsSettings({ allowInParameters: false });
      await echo.close();
    }
  });
});
