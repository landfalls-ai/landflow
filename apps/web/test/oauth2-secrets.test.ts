/**
 * `$secrets` in an OAuth2 credential's client fields (client id and secret, and the token URL), against the fake
 * OAuth2 provider (./fake-oauth2) and a fake Vault: resolved when the host builds the authorization URL, exchanges
 * the code, refreshes the token and asks for a client credentials token; the saved credential keeps the expressions,
 * and the values stay out of what the credential and its errors show.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { startFakeOAuth2 } from './fake-oauth2';

vi.setConfig({ testTimeout: 30_000 });

const CLIENT_ID = 'client-from-vault-01';
const CLIENT_SECRET = 'secret-from-vault-99';
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oauth2-secrets-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' });
delete process.env.LANDFLOW_ENVIRONMENT;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { credentials } = await import('@/lib/server/credentials/vault');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const secrets = await import('@/lib/server/secrets');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');
const tokenRoute = await import('@/app/api/credentials/[id]/oauth2/token/route');
const { fakeVault } = await import('./fake-secret-stores');

registry.registerBuiltin(corePlugin);
const fake = await startFakeOAuth2({ expiresIn: 3600, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
let vault: Awaited<ReturnType<typeof fakeVault>>;

beforeAll(async () => {
  await ensureBootstrapped();
  vault = await fakeVault({ rootToken: 'root-token-abcdef' });
  vault.kv.secret = { oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenUrl: `${fake.url}/token` } };
  secrets.externalSecrets.create({ name: 'vault', kind: 'vault', settings: { url: vault.url, auth: 'token', token: 'root-token-abcdef' } });
});
afterAll(async () => {
  waits.stop();
  secrets.externalSecrets.closeAll();
  await vault.close();
  await fake.close();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const FIELDS = { clientId: '{{ $secrets.vault.oauth.clientId }}', clientSecret: '{{ $secrets.vault.oauth.clientSecret }}', accessTokenUrl: '{{ $secrets.vault.oauth.tokenUrl }}' };

const create = (data: Record<string, unknown> = {}) =>
  credentials.create({ name: 'Vault OAuth', type: 'core.oAuth2Api', data: { authUrl: `${fake.url}/authorize`, scope: 'openid email', ...FIELDS, ...data } as JsonObject });

async function connect(id: string) {
  const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${id}/oauth2/authorize`), params({ id }));
  const location = start.headers.get('location');
  if (start.status !== 302 || !location) return { start, html: await start.text() };
  const consent = await fetch(new URL(location), { redirect: 'manual' });
  const page = await callbackRoute.GET(new Request(new URL(consent.headers.get('location')!), { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0] } }));
  return { start, authorizeUrl: new URL(location), page, html: await page.text() };
}

const httpWorkflow = (id: string, credentialId: string): Workflow =>
  store.saveWorkflow({
    id,
    name: id,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'Call',
        name: 'Call',
        type: 'core.httpRequest',
        typeVersion: 1,
        position: [200, 0],
        parameters: { method: 'GET', url: `${fake.url}/resource`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
        credentials: { oAuth2Api: { id: credentialId, name: 'Vault OAuth' } },
      },
    ],
    connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Call', sourceIndex: 0, targetIndex: 0 }],
  } as Workflow);

describe('$secrets in the OAuth2 Connect client fields', () => {
  it('builds the authorization URL and exchanges the code with the resolved client id, secret and token URL', async () => {
    const credential = create();
    const { authorizeUrl, page, html } = await connect(credential.id);
    expect(authorizeUrl!.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(page!.status).toBe(200);
    expect(html).toContain('Connected');
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.params.grant_type).toBe('authorization_code');
    expect(exchange.basic).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET });
    expect(credentials.get(credential.id)!.oauth2).toMatchObject({ connected: true });
    // The saved credential keeps the references; neither the API view nor the vault file holds the values.
    const saved = credentials.oauth2(credential.id).config;
    expect(saved).toMatchObject({ clientId: FIELDS.clientId, clientSecret: FIELDS.clientSecret, accessTokenUrl: FIELDS.accessTokenUrl });
    expect(JSON.stringify(credentials.get(credential.id))).not.toContain(CLIENT_SECRET);
    expect(readFileSync(join(dataDir, 'credentials.json'), 'utf8')).not.toContain(CLIENT_SECRET);
  });

  it('refreshes an expiring token with the resolved client credentials before a node runs', async () => {
    const credential = create();
    await connect(credential.id);
    const { token } = credentials.oauth2(credential.id);
    credentials.saveOAuth2Token(credential.id, { ...token!, expires_at: new Date(Date.now() - 5_000).toISOString() });
    const execution = await runWorkflow({ workflow: httpWorkflow('wf_oauth_secret_refresh', credential.id), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('success');
    const refresh = fake.tokenRequests.at(-1)!;
    expect(refresh.params.grant_type).toBe('refresh_token');
    expect(refresh.basic).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET });
    expect(JSON.stringify(execution)).not.toContain(CLIENT_SECRET);
  });

  it('gets a client credentials token from the token route and at first use', async () => {
    const credential = create({ grantType: 'clientCredentials', clientSecret: '{{ $secrets.vault.oauth.clientSecret }}', authentication: 'body' });
    const response = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: credential.id }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(CLIENT_SECRET);
    expect(fake.tokenRequests.at(-1)!.params).toMatchObject({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

    const machine = create({ grantType: 'clientCredentials' });
    const execution = await runWorkflow({ workflow: httpWorkflow('wf_oauth_secret_cc', machine.id), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('success');
    expect(fake.tokenRequests.at(-1)!.basic).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET });
  });

  it('says which reference is missing, on the popup and on the credential', async () => {
    const credential = create({ clientId: '{{ $secrets.vault.oauth.nope }}' });
    const { start, html } = await connect(credential.id);
    expect(start.status).toBe(400);
    expect(html).toMatch(/\$secrets\.vault\.oauth has no key “nope”/);
    const machine = create({ grantType: 'clientCredentials', clientSecret: "{{ $secrets.vault['missing'].x }}" });
    const response = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: machine.id }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/\$secrets\.vault\.missing doesn’t exist/);
    expect(credentials.get(machine.id)!.oauth2!.error).toMatch(/missing/);
  });

  it('redacts a resolved client field from the error a credential keeps', async () => {
    const credential = create();
    await connect(credential.id);
    credentials.setOAuth2Error(credential.id, `The token endpoint answered 401: bad client ${CLIENT_SECRET}`);
    const error = credentials.get(credential.id)!.oauth2!.error!;
    expect(error).toContain(secrets.REDACTED);
    expect(error).not.toContain(CLIENT_SECRET);
  });
});
