/**
 * OAuth2 credentials against a fake provider (./fake-oauth2): the Connect flow through the routes (authorization
 * code with PKCE, the signed state and the flow's cookie, the code exchange), tokens encrypted at rest and never
 * returned by the API, refresh before expiry and after a 401 (persisted), client credentials, failures, types that
 * extend oAuth2Api (n8n's `extends`), and the HTTP Request node's OAuth2 authentication end to end.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import { startFakeOAuth2 } from './fake-oauth2';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oauth2-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials, CredentialError } = await import('@/lib/server/credentials/vault');
const oauth2 = await import('@/lib/server/credentials/oauth2');
const { withExtends, qualifyParent, mergeProperties } = await import('@/lib/server/credentials/extends');
const { oauth2RedirectUrl } = await import('@/lib/server/credentials/oauth2-flow');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');
const tokenRoute = await import('@/app/api/credentials/[id]/oauth2/token/route');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const oauth2Route = await import('@/app/api/oauth2/route');
const { defineCredentialType, defineNode, definePlugin } = await import('@landflow/sdk');

const fake = await startFakeOAuth2({ expiresIn: 3600 });

// A plugin whose credential type extends the generic one, like a "Google OAuth2" would, and a node that echoes it.
const acme = definePlugin({
  info: { id: 'acme', name: 'Acme', version: '1.0.0', language: 'typescript' },
  credentialTypes: [
    defineCredentialType({
      name: 'acmeOAuth2Api',
      displayName: 'Acme OAuth2',
      extends: ['oAuth2Api'],
      properties: [
        { name: 'authUrl', displayName: 'Authorization URL', type: 'hidden', default: `${fake.url}/authorize` },
        { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'hidden', default: `${fake.url}/token` },
        { name: 'scope', displayName: 'Scope', type: 'hidden', default: 'acme.read' },
        { name: 'region', displayName: 'Region', type: 'string', default: 'eu' },
      ],
    }),
  ],
  nodes: [
    defineNode({
      description: {
        name: 'whoami',
        displayName: 'Who am I',
        version: 1,
        kind: 'action',
        inputs: [{ type: 'main' }],
        outputs: [{ type: 'main' }],
        properties: [],
        credentials: [{ name: 'acmeOAuth2Api', required: true }],
      },
      async execute(ctx) {
        const data = ctx.getCredentials('acmeOAuth2Api');
        const response = await fetch(`${fake.url}/resource`, { headers: { authorization: `Bearer ${String(data.accessToken)}` } });
        if (response.status === 401) throw new Error('Acme said 401 Unauthorized');
        return [[{ json: { received: data, resource: (await response.json()) as JsonObject } }]];
      },
    }),
  ],
});

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(acme);

afterAll(async () => {
  waits.stop();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  fake.options.expiresIn = 3600;
  fake.options.rotateRefreshTokens = true;
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const vaultFile = () => readFileSync(join(dataDir, 'credentials.json'), 'utf8');

function create(data: Record<string, unknown> = {}, type = 'core.oAuth2Api') {
  return credentials.create({
    name: 'Fake',
    type,
    data: { authUrl: `${fake.url}/authorize`, accessTokenUrl: `${fake.url}/token`, clientId: 'client-1', clientSecret: 'secret-1', scope: 'openid email', ...data } as JsonObject,
  });
}

/** Connect through the routes the way a browser would: authorize → provider consent (302) → callback with the cookie. */
async function connect(id: string, options: { cookie?: string | null; tamper?: (url: URL) => void } = {}) {
  const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${id}/oauth2/authorize`), params({ id }));
  expect(start.status).toBe(302);
  const authorizeUrl = new URL(start.headers.get('location')!);
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location')!);
  options.tamper?.(back);
  const headers: Record<string, string> = {};
  if (options.cookie !== null) headers.cookie = options.cookie ?? cookie;
  const page = await callbackRoute.GET(new Request(back, { headers }));
  return { page, html: await page.text(), authorizeUrl, setCookie: start.headers.get('set-cookie')!, clearCookie: page.headers.get('set-cookie') };
}

function httpWorkflow(id: string, credentialId: string): Workflow {
  return store.saveWorkflow({
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
        credentials: { oAuth2Api: { id: credentialId, name: 'Fake' } },
      },
    ],
    connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Call', sourceIndex: 0, targetIndex: 0 }],
  } as Workflow);
}

const run = (workflow: Workflow) => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
const grants = () => fake.tokenRequests.map((r) => r.params.grant_type);
const token = (id: string) => credentials.oauth2(id).token!;

function expire(id: string) {
  credentials.saveOAuth2Token(id, { ...token(id), expires_at: new Date(Date.now() - 5_000).toISOString() });
}

describe('the generic OAuth2 credential type', () => {
  it('is registered as core.oAuth2Api with n8n’s fields and flagged oauth2', () => {
    const info = registry.credentialType('core.oAuth2Api')!;
    expect(info.oauth2).toBe(true);
    expect(info.descriptor.properties.map((p) => p.name)).toEqual(['grantType', 'authUrl', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'authQueryParameters', 'authentication', 'userInfoUrl']);
    expect(info.nodeTypes).toContain('core.httpRequest');
  });

  it('serves the redirect URL and presets', async () => {
    const body = (await (await oauth2Route.GET(new Request('http://localhost:3000/api/oauth2'))).json()) as { redirectUrl: string; presets: Array<{ id: string }> };
    expect(body.redirectUrl).toBe('http://landflow.test/api/oauth2/callback');
    expect(body.presets.map((p) => p.id)).toEqual(['google', 'github', 'slack', 'microsoft', 'notion', 'discord', 'hubspot', 'airtable']);
  });

  it('builds the redirect URL from the request when no public URL is set', () => {
    vi.stubEnv('LANDFLOW_PUBLIC_URL', '');
    try {
      expect(oauth2RedirectUrl(new Request('http://127.0.0.1:3000/api/credentials/x/oauth2/authorize'))).toBe('http://127.0.0.1:3000/api/oauth2/callback');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('only asks for the fields the grant uses', () => {
    expect(() => credentials.create({ name: 'cc', type: 'core.oAuth2Api', data: { grantType: 'clientCredentials', accessTokenUrl: `${fake.url}/token`, clientId: 'client-1' } })).not.toThrow();
    expect(() => credentials.create({ name: 'code', type: 'core.oAuth2Api', data: { accessTokenUrl: `${fake.url}/token`, clientId: 'client-1' } })).toThrow(/Authorization URL/);
  });
});

describe('Connect: authorization code with PKCE', () => {
  it('sends the browser to the provider with PKCE, the signed state and the extra parameters', async () => {
    const credential = create({ authQueryParameters: 'access_type=offline&prompt=consent' });
    const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${credential.id}/oauth2/authorize`), params({ id: credential.id }));
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${fake.url}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'http://landflow.test/api/oauth2/callback',
      scope: 'openid email',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^landflow_oauth2_[\w-]+=1; Path=\/api\/oauth2\/callback; Max-Age=600; HttpOnly; SameSite=Lax$/);
    // The state names the credential and the cookie's nonce, and carries no secret.
    const payload = JSON.parse(Buffer.from(url.searchParams.get('state')!.split('.')[0], 'base64url').toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ c: credential.id, r: 'http://landflow.test/api/oauth2/callback' });
    expect(cookie).toContain(`landflow_oauth2_${String(payload.n)}=`);
  });

  it('exchanges the code with the verifier, stores the token and shows who connected', async () => {
    const credential = create();
    const { page, html, clearCookie } = await connect(credential.id);
    expect(page.status).toBe(200);
    expect(html).toContain('Connected as alice@example.test');
    expect(html).toContain('postMessage');
    expect(clearCookie).toMatch(/Max-Age=0/);
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.params).toMatchObject({ grant_type: 'authorization_code', redirect_uri: 'http://landflow.test/api/oauth2/callback' });
    expect(exchange.params.code_verifier).toMatch(/^[\w-]{43}$/);
    // Basic client authentication by default.
    expect(exchange.basic).toEqual({ id: 'client-1', secret: 'secret-1' });
    const status = credentials.list().find((c) => c.id === credential.id)!.oauth2!;
    expect(status).toMatchObject({ grantType: 'pkce', connected: true, account: 'alice@example.test', expired: false, refreshable: true, scope: 'openid email' });
    expect(Date.parse(status.expiresAt!)).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('keeps tokens encrypted at rest and out of the API', async () => {
    const credential = create();
    await connect(credential.id);
    const stored = token(credential.id);
    const file = vaultFile();
    for (const secret of [stored.access_token, oauth2.tokenField(stored, 'refresh_token'), 'oauthTokenData', 'secret-1']) expect(file).not.toContain(secret);
    const detail = credentials.get(credential.id)!;
    expect(detail.data).not.toHaveProperty('oauthTokenData');
    expect(detail.data).not.toHaveProperty('oauthAccount');
    expect(detail.secrets).toEqual(['clientSecret']);
    const response = await credentialRoute.GET(new Request('http://landflow.test'), params({ id: credential.id }));
    const text = await response.text();
    expect(text).not.toContain(stored.access_token);
    expect(text).not.toContain(oauth2.tokenField(stored, 'refresh_token'));
    expect(JSON.parse(text).credential.oauth2.connected).toBe(true);
  });

  it('ignores token fields written through the API', async () => {
    const credential = create();
    await connect(credential.id);
    const before = token(credential.id).access_token;
    await credentialRoute.PATCH(
      new Request('http://landflow.test', { method: 'PATCH', body: JSON.stringify({ data: { scope: 'openid', oauthTokenData: { access_token: 'evil' }, oauthAccount: 'mallory' } }) }),
      params({ id: credential.id }),
    );
    expect(token(credential.id).access_token).toBe(before);
    expect(credentials.get(credential.id)!.oauth2!.account).toBe('alice@example.test');
    expect(credentials.get(credential.id)!.data.scope).toBe('openid');
    expect(() => credentials.create({ name: 'x', type: 'core.oAuth2Api', data: { authUrl: 'http://a', accessTokenUrl: 'http://b', clientId: 'c', oauthTokenData: { access_token: 'evil' } } })).not.toThrow();
    const sneaky = credentials.list().find((c) => c.name === 'x')!;
    expect(sneaky.oauth2!.connected).toBe(false);
  });

  it('sends the client credentials in the body when asked, and no PKCE for the plain code grant', async () => {
    const credential = create({ grantType: 'authorizationCode', authentication: 'body' });
    const { page, authorizeUrl } = await connect(credential.id);
    expect(page.status).toBe(200);
    expect(authorizeUrl.searchParams.has('code_challenge')).toBe(false);
    const exchange = fake.tokenRequests.at(-1)!;
    expect(exchange.basic).toBeUndefined();
    expect(exchange.params).toMatchObject({ client_id: 'client-1', client_secret: 'secret-1', grant_type: 'authorization_code' });
    expect(exchange.params.code_verifier).toBeUndefined();
  });

  it('works for a public client: PKCE without a secret', async () => {
    const credential = create({ clientSecret: '' });
    const { page } = await connect(credential.id);
    expect(page.status).toBe(200);
    expect(fake.tokenRequests.at(-1)!.params.client_id).toBe('client-1');
  });
});

describe('the state and the flow’s cookie', () => {
  const key = Buffer.alloc(32, 7);
  const payload = { c: 'cred_1', n: 'nonce', r: 'http://landflow.test/api/oauth2/callback', e: Date.now() + 60_000 };

  it('accepts its own signature and rejects others, tampering and expiry', () => {
    const state = oauth2.signState(key, payload);
    expect(oauth2.verifyState(key, state)).toEqual(payload);
    expect(() => oauth2.verifyState(Buffer.alloc(32, 8), state)).toThrow(/not issued by this Landflow host/);
    const [body, signature] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, c: 'cred_2' })).toString('base64url');
    expect(() => oauth2.verifyState(key, `${forged}.${signature}`)).toThrow(/not issued/);
    expect(() => oauth2.verifyState(key, body)).toThrow(/no valid state/);
    expect(() => oauth2.verifyState(key, undefined)).toThrow(/no valid state/);
    expect(() => oauth2.verifyState(key, state, payload.e + 1)).toThrow(/took too long/);
  });

  it('derives a verifier only the host can recompute, and its S256 challenge', () => {
    const verifier = oauth2.pkceVerifier(key, 'nonce');
    expect(verifier).toBe(oauth2.pkceVerifier(key, 'nonce'));
    expect(verifier).not.toBe(oauth2.pkceVerifier(Buffer.alloc(32, 9), 'nonce'));
    // RFC 7636 appendix B.
    expect(oauth2.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('refuses a callback with a forged state, without the cookie, or after a denial', async () => {
    const credential = create();
    const forged = await connect(credential.id, { tamper: (url) => url.searchParams.set('state', `${url.searchParams.get('state')}x`) });
    expect(forged.page.status).toBe(400);
    expect(forged.html).toContain('not issued by this Landflow host');

    const noCookie = await connect(credential.id, { cookie: null });
    expect(noCookie.page.status).toBe(400);
    expect(noCookie.html).toContain('started in another browser');

    const denied = await connect(credential.id, {
      tamper: (url) => {
        url.searchParams.delete('code');
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('error_description', 'The user said no');
      },
    });
    expect(denied.page.status).toBe(400);
    expect(denied.html).toContain('Access was denied: The user said no');
    expect(credentials.get(credential.id)!.oauth2!.connected).toBe(false);
  });

  it('reports a failed code exchange on the credential', async () => {
    const credential = create({ clientId: 'wrong-client' });
    const { page, html } = await connect(credential.id);
    expect(page.status).toBe(400);
    expect(html).toContain('invalid_client');
    expect(credentials.get(credential.id)!.oauth2!.error).toMatch(/invalid_client/);
  });

  it('explains a credential that can’t connect in the popup', async () => {
    const credential = create({ grantType: 'clientCredentials' });
    const page = await authorizeRoute.GET(new Request('http://landflow.test'), params({ id: credential.id }));
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('no sign-in page');
  });
});

describe('fresh tokens for nodes', () => {
  it('gives the HTTP Request node the access token, never the refresh token', async () => {
    const credential = create();
    await connect(credential.id);
    const record = await run(httpWorkflow('wf_oauth_plain', credential.id));
    expect(record.status).toBe('success');
    expect(record.runData.Call[0].outputs[0][0].json).toEqual({ hello: 'world' });
    expect(fake.resourceCalls.at(-1)).toEqual({ token: token(credential.id).access_token, ok: true });
    const resolved = registry.resolve('core.httpRequest');
    if ('error' in resolved) throw new Error(resolved.error);
    const data = credentials.resolveFor({ type: 'core.httpRequest', credentials: { oAuth2Api: { id: credential.id, name: 'Fake' } }, parameters: { authentication: 'genericCredentialType' } }, resolved.descriptor).oAuth2Api;
    expect(data).toMatchObject({ accessToken: token(credential.id).access_token, tokenType: 'Bearer', oauthTokenData: { access_token: token(credential.id).access_token }, clientId: 'client-1' });
    expect(JSON.stringify(data)).not.toContain(oauth2.tokenField(token(credential.id), 'refresh_token'));
  });

  it('refreshes a token that is about to expire before the node runs, and saves it', async () => {
    const credential = create();
    await connect(credential.id);
    const old = token(credential.id);
    expire(credential.id);
    const refreshes = grants().filter((g) => g === 'refresh_token').length;
    const record = await run(httpWorkflow('wf_oauth_expiry', credential.id));
    expect(record.status).toBe('success');
    expect(grants().filter((g) => g === 'refresh_token').length).toBe(refreshes + 1);
    const fresh = token(credential.id);
    expect(fresh.access_token).not.toBe(old.access_token);
    // Rotated refresh token stored; the resource saw the new access token.
    expect(oauth2.tokenField(fresh, 'refresh_token')).not.toBe(oauth2.tokenField(old, 'refresh_token'));
    expect(fake.resourceCalls.at(-1)).toEqual({ token: fresh.access_token, ok: true });
    expect(vaultFile()).not.toContain(fresh.access_token);
  });

  it('keeps the refresh token when the provider doesn’t rotate it', async () => {
    fake.options.rotateRefreshTokens = false;
    const credential = create();
    await connect(credential.id);
    const refreshToken = oauth2.tokenField(token(credential.id), 'refresh_token');
    expect(await credentials.refreshOAuth2(credential.id, { force: true })).toBe(true);
    expect(oauth2.tokenField(token(credential.id), 'refresh_token')).toBe(refreshToken);
  });

  it('refreshes once when the API answers 401 and runs the node again', async () => {
    const credential = create();
    await connect(credential.id);
    fake.revokeAccess();
    const calls = fake.resourceCalls.length;
    const record = await run(httpWorkflow('wf_oauth_401', credential.id));
    expect(record.status).toBe('success');
    expect(fake.resourceCalls.slice(calls).map((c) => c.ok)).toEqual([false, true]);
    expect(grants().at(-1)).toBe('refresh_token');
  });

  it('fails with the 401 when there is no way to renew the token', async () => {
    const credential = create();
    await connect(credential.id);
    const { refresh_token: _drop, ...withoutRefresh } = token(credential.id);
    credentials.saveOAuth2Token(credential.id, withoutRefresh as never);
    fake.revokeAccess();
    const calls = fake.resourceCalls.length;
    const record = await run(httpWorkflow('wf_oauth_401_final', credential.id));
    expect(record.status).toBe('error');
    expect(record.error?.message).toContain('HTTP 401');
    expect(fake.resourceCalls.length).toBe(calls + 1);
    expect(credentials.get(credential.id)!.oauth2!.refreshable).toBe(false);
  });

  it('asks to reconnect when the refresh token was revoked', async () => {
    const credential = create();
    await connect(credential.id);
    expire(credential.id);
    fake.revokeRefresh();
    const record = await run(httpWorkflow('wf_oauth_revoked', credential.id));
    expect(record.status).toBe('error');
    expect(record.error?.message).toMatch(/could not be renewed .*invalid_grant.*reconnect it in Credentials/);
    expect(credentials.get(credential.id)!.oauth2).toMatchObject({ expired: true, error: expect.stringContaining('invalid_grant') });
  });

  it('makes concurrent calls wait for one refresh', async () => {
    const credential = create();
    await connect(credential.id);
    expire(credential.id);
    const before = fake.tokenRequests.length;
    const results = await Promise.all([credentials.refreshOAuth2(credential.id), credentials.refreshOAuth2(credential.id), credentials.refreshOAuth2(credential.id)]);
    expect(results).toEqual([true, true, true]);
    expect(fake.tokenRequests.length).toBe(before + 1);
    // Not expiring any more: nothing to do.
    expect(await credentials.refreshOAuth2(credential.id)).toBe(false);
  });

  it('keeps the refreshed token across a restart', async () => {
    const credential = create();
    await connect(credential.id);
    expire(credential.id);
    await credentials.refreshOAuth2(credential.id);
    const fresh = token(credential.id).access_token;
    // A new vault instance reads the file (same data directory, same key).
    (globalThis as unknown as { __landflow: Map<string, unknown> }).__landflow.delete('credentials');
    vi.resetModules();
    const reloaded = (await import('@/lib/server/credentials/vault')).credentials;
    expect(reloaded).not.toBe(credentials);
    expect(reloaded.oauth2(credential.id).token!.access_token).toBe(fresh);
    (globalThis as unknown as { __landflow: Map<string, unknown> }).__landflow.set('credentials', credentials);
  });

  it('refreshes from the token route and disconnects', async () => {
    const credential = create();
    await connect(credential.id);
    const old = token(credential.id).access_token;
    const refreshed = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: credential.id }));
    expect(refreshed.status).toBe(200);
    expect(token(credential.id).access_token).not.toBe(old);
    const gone = (await (await tokenRoute.DELETE(new Request('http://landflow.test', { method: 'DELETE' }), params({ id: credential.id }))).json()) as { credential: { oauth2: { connected: boolean } } };
    expect(gone.credential.oauth2.connected).toBe(false);
    const notConnected = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: credential.id }));
    expect(notConnected.status).toBe(400);
    expect(((await notConnected.json()) as { error: string }).error).toMatch(/Not connected/);
  });
});

describe('client credentials', () => {
  it('gets a token at first use, on demand, and again after a 401', async () => {
    const credential = credentials.create({ name: 'Machine', type: 'core.oAuth2Api', data: { grantType: 'clientCredentials', accessTokenUrl: `${fake.url}/token`, clientId: 'client-1', clientSecret: 'secret-1', scope: 'api.read' } });
    expect(credentials.get(credential.id)!.oauth2).toMatchObject({ grantType: 'clientCredentials', connected: false, refreshable: true });
    const workflow = httpWorkflow('wf_oauth_cc', credential.id);
    const first = await run(workflow);
    expect(first.status).toBe('success');
    expect(fake.tokenRequests.at(-1)!.params).toMatchObject({ grant_type: 'client_credentials', scope: 'api.read' });
    expect(credentials.get(credential.id)!.oauth2!.connected).toBe(true);

    const response = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: credential.id }));
    expect(response.status).toBe(200);
    expect(grants().at(-1)).toBe('client_credentials');

    fake.revokeAccess();
    const calls = fake.resourceCalls.length;
    expect((await run(workflow)).status).toBe('success');
    expect(fake.resourceCalls.slice(calls).map((c) => c.ok)).toEqual([false, true]);
  });

  it('reports a rejected client', async () => {
    const credential = credentials.create({ name: 'Bad', type: 'core.oAuth2Api', data: { grantType: 'clientCredentials', accessTokenUrl: `${fake.url}/token`, clientId: 'client-1', clientSecret: 'nope' } });
    const response = await tokenRoute.POST(new Request('http://landflow.test', { method: 'POST' }), params({ id: credential.id }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/401 invalid_client/);
    expect(credentials.get(credential.id)!.oauth2!.error).toMatch(/invalid_client/);
  });
});

describe('types that extend oAuth2Api', () => {
  it('merge the parent’s properties, the child’s replacing same-named ones in place', () => {
    const info = registry.credentialType('acme.acmeOAuth2Api')!;
    expect(info.oauth2).toBe(true);
    expect(info.extendsTypes).toEqual(['core.oAuth2Api']);
    const properties = info.descriptor.properties;
    expect(properties.map((p) => p.name)).toEqual(['grantType', 'authUrl', 'accessTokenUrl', 'clientId', 'clientSecret', 'scope', 'authQueryParameters', 'authentication', 'userInfoUrl', 'region']);
    expect(properties.find((p) => p.name === 'authUrl')).toMatchObject({ type: 'hidden', default: `${fake.url}/authorize` });
    expect(info.nodeTypes).toEqual(['acme.whoami']);
  });

  it('connect with the URLs the child fixed and hand its node a fresh token', async () => {
    const credential = credentials.create({ name: 'Acme', type: 'acme.acmeOAuth2Api', data: { clientId: 'client-1', clientSecret: 'secret-1' } });
    const { page, authorizeUrl } = await connect(credential.id);
    expect(page.status).toBe(200);
    expect(authorizeUrl.searchParams.get('scope')).toBe('acme.read');
    expire(credential.id);
    const workflow = store.saveWorkflow({
      id: 'wf_acme',
      name: 'acme',
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'Who', name: 'Who', type: 'acme.whoami', typeVersion: 1, position: [200, 0], parameters: {}, credentials: { acmeOAuth2Api: { id: credential.id, name: 'Acme' } } },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Who', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
    let record = await run(workflow);
    expect(record.status).toBe('success');
    const received = record.runData.Who[0].outputs[0][0].json.received as JsonObject;
    // The node was handed the token, so the host scrubs it from what the node returns (secrets/redact).
    expect(received).toMatchObject({ accessToken: '[redacted]', region: 'eu', clientId: 'client-1', scope: 'acme.read' });
    expect(received).not.toHaveProperty('oauthAccount');
    expect(JSON.stringify(received)).not.toContain(oauth2.tokenField(token(credential.id), 'refresh_token'));
    // A plugin node's 401 is retried after a refresh too.
    fake.revokeAccess();
    record = await run(workflow);
    expect(record.status).toBe('success');
  });

  it('resolve parents by local name, plugin first, then core; skip unknown parents and cycles', () => {
    const known = new Set(['acme.base', 'core.oAuth2Api']);
    expect(qualifyParent('base', 'acme', known)).toBe('acme.base');
    expect(qualifyParent('oAuth2Api', 'acme', known)).toBe('core.oAuth2Api');
    expect(qualifyParent('other.thing', 'acme', known)).toBe('other.thing');
    const info = (type: string, extendsTypes: string[] | undefined, names: string[]) => ({
      type,
      pluginId: type.split('.')[0],
      pluginName: 'P',
      available: true,
      nodeTypes: [],
      descriptor: { name: type.split('.')[1], displayName: type, properties: names.map((name) => ({ name, displayName: name, type: 'string' as const })), ...(extendsTypes && { extends: extendsTypes }) },
    });
    const merged = withExtends([info('p.a', ['b'], ['a1']), info('p.b', ['a'], ['b1']), info('p.c', ['missing', 'a'], ['c1'])]);
    expect(merged[0].descriptor.properties.map((p) => p.name)).toEqual(['b1', 'a1']);
    expect(merged[2].descriptor.properties.map((p) => p.name)).toEqual(['b1', 'a1', 'c1']);
    expect(merged[2].extendsTypes).toEqual(['p.a', 'p.b']);
    expect(merged[2].oauth2).toBeUndefined();
    expect(mergeProperties([{ name: 'x', displayName: 'X', type: 'string' }], [{ name: 'x', displayName: 'X2', type: 'hidden' }])).toEqual([{ name: 'x', displayName: 'X2', type: 'hidden' }]);
  });
});

describe('OAuth2 helpers', () => {
  it('merges extra auth query parameters and requires http(s) URLs', () => {
    const config = oauth2.oauth2Config({ authUrl: 'https://p.test/auth?tenant=x', accessTokenUrl: 'https://p.test/token', clientId: 'id', scope: 'a b', authQueryParameters: '?prompt=consent&tenant=y' });
    const url = new URL(oauth2.authorizationUrl(config, { redirectUri: 'http://cb', state: 's' }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ tenant: 'y', response_type: 'code', client_id: 'id', redirect_uri: 'http://cb', scope: 'a b', state: 's', prompt: 'consent' });
    expect(() => oauth2.authorizationUrl({ ...config, authUrl: 'ftp://x' }, { redirectUri: 'http://cb', state: 's' })).toThrow(/http\(s\)/);
  });

  it('keeps the expiry as a time and recognises 401-like errors', () => {
    const stored = oauth2.toStoredToken({ access_token: 'a', expires_in: 60 }, { access_token: 'old', refresh_token: 'r', obtained_at: '' }, 1_000_000);
    expect(stored).toMatchObject({ access_token: 'a', refresh_token: 'r', expires_at: new Date(1_060_000).toISOString() });
    expect(oauth2.isExpiring(stored, 1_000_000)).toBe(true); // within the one-minute margin
    expect(oauth2.isExpiring(stored, 1_000_000, 0)).toBe(false);
    expect(oauth2.isExpiring({ access_token: 'x', obtained_at: '' })).toBe(false);
    for (const message of ['HTTP 401', 'Unauthorized', 'invalid_token', 'The access token expired']) expect(oauth2.looksUnauthorized(message)).toBe(true);
    for (const message of ['HTTP 403', 'HTTP 4010 items', 'Not found', undefined]) expect(oauth2.looksUnauthorized(message)).toBe(false);
  });

  it('finds the account in ID tokens, user info and provider-specific responses', () => {
    const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
    const base = { access_token: 'opaque', obtained_at: '' };
    expect(oauth2.accountOf({ ...base, id_token: jwt({ preferred_username: 'bob' }) })).toBe('bob');
    expect(oauth2.accountOf(base, { login: 'octocat' })).toBe('octocat');
    expect(oauth2.accountOf({ ...base, team: { name: 'Acme Slack' } })).toBe('Acme Slack');
    expect(oauth2.accountOf({ ...base, owner: { user: { name: 'Nora' } }, workspace_name: 'Docs' })).toBe('Nora');
    expect(oauth2.accountOf({ ...base, access_token: jwt({ preferred_username: 'service-account-landflow' }) })).toBe('service-account-landflow');
    expect(oauth2.accountOf(base)).toBeUndefined();
  });

  it('seals other secrets with the vault key', () => {
    const sealed = credentials.sealSecret('https://hooks.slack.test/T000/B000/xyz');
    expect(sealed).toMatch(/^v2\.k0\./);
    expect(sealed).not.toContain('hooks.slack');
    expect(credentials.openSecret(sealed)).toBe('https://hooks.slack.test/T000/B000/xyz');
    const [v, kid, iv, tag, value] = sealed.split('.');
    // A changed first character always alters the ciphertext, so GCM's tag check fails.
    expect(() => credentials.openSecret([v, kid, iv, tag, `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`].join('.'))).toThrow(CredentialError);
  });
});
