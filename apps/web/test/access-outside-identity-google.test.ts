/**
 * C36-A: Google sign-in for people without a Landflow account, against the fake Google OpenID Connect server (@landflow/test-fakes/google-oidc):
 * the redirect (PKCE S256, state, nonce, `hd` only with one domain), a good sign-in, every scripted refusal of the fake, the `hd` and
 * verified-email rules, Gmail refused, state binding and single use, a pinned Google subject, and that Landflow's SSO and this flow can't
 * finish each other's sign-ins.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGoogleOidc, OIDC_ERROR_MODES, type OidcErrorMode } from '@landflow/test-fakes/google-oidc';

vi.setConfig({ testTimeout: 30_000 });
const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-outside-google-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://landflow.test',
  LANDFLOW_TRUSTED_PROXIES: '1',
  // The fake provider is not accounts.google.com: outside sign-in refuses any other issuer unless this dev flag is set.
  LANDFLOW_ACCESS_OUTSIDE_DEV_OIDC: 'true',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const BASE = 'http://landflow.test';
const CALLBACK = `${BASE}/request-access/api/sign-in/google/callback`;
const SSO_CALLBACK = `${BASE}/api/auth/oidc/callback`;
const fake = fakeGoogleOidc({ redirectUris: [CALLBACK, SSO_CALLBACK] });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const auth = await import('@/lib/server/auth');
const oidc = await import('@/lib/server/auth/oidc');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const settings = await import('@/lib/server/access/outside/settings');
const limits = await import('@/lib/server/access/outside/limits');
const store = await import('@/lib/server/access/outside/store');
const startRoute = await import('@/app/request-access/api/sign-in/google/route');
const callbackRoute = await import('@/app/request-access/api/sign-in/google/callback/route');
const sessionRoute = await import('@/app/request-access/api/session/route');

registry.registerBuiltin(corePlugin);
const owner = await auth.createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
await auth.createUser({ email: 'sam@partner.test', name: 'Sam Landflow', role: 'member' });

type Handler = (request: Request) => Promise<Response>;
let ipSeq = 0;
const nextIp = () => `10.30.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const request = (path: string, cookie?: string, ip?: string) => new Request(`${BASE}${path}`, { headers: { 'x-forwarded-for': ip ?? nextIp(), ...(cookie && { cookie }) } });
const setCookie = (response: Response, name: string) => response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) => setCookie(response, name)?.split(';')[0].slice(name.length + 1);
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 200 }).events;
const seed = (account: Record<string, unknown>) => fetch(`${fake.url}/_fake/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) });
const fail = (mode: OidcErrorMode) => fetch(`${fake.url}/_fake/next-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
const configure = (patch: Parameters<typeof settings.saveOutsideSettings>[1]) => settings.saveOutsideSettings(owner, patch);
let credentialId = '';

/** Press "Sign in with Google": the redirect to the provider and the state cookie. */
const start = async (ip?: string) => {
  const response = await (startRoute.GET as Handler)(request('/request-access/api/sign-in/google', undefined, ip));
  const location = response.headers.get('location');
  return { response, url: location ? new URL(location, BASE) : undefined, state: cookieValue(response, 'landflow_requester_oidc') };
};
/** The provider part: choose `email` there and get the URL the browser is sent back to. */
const chooseAccount = async (url: URL, email: string) => {
  const next = new URL(url);
  next.searchParams.set('login_hint', email);
  next.searchParams.set('auto', '1');
  const response = await fetch(next, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '');
};
/** The whole flow for `email`: the callback's response. */
const signIn = async (email: string, options: { cookieState?: string | null; ip?: string } = {}) => {
  const started = await start(options.ip);
  expect(started.response.status).toBe(302);
  const back = await chooseAccount(started.url!, email);
  const cookieState = options.cookieState === undefined ? started.state : options.cookieState;
  const response = await (callbackRoute.GET as Handler)(request(`${back.pathname}${back.search}`, cookieState ? `landflow_requester_oidc=${cookieState}` : undefined, options.ip));
  return { response, started, back };
};
const errorOf = (response: Response) => new URL(response.headers.get('location') ?? '', BASE).searchParams.get('error');

beforeAll(async () => {
  await fake.start();
  auth.disableTestAuth();
});
afterAll(async () => {
  auth.enableTestAuth();
  await fake.stop();
});
beforeEach(async () => {
  await fake.reset();
  limits.resetOutsideLimits();
  for (const table of ['access_outside_sessions', 'access_outside_links', 'access_outside_requesters']) database().all<{ id: string }>(`SELECT id FROM ${table}`).forEach((r) => database().delete(table as 'access_outside_sessions', { id: r.id }));
  if (!credentialId) credentialId = credentials.create({ name: 'Fake Google client', type: 'core.oidcClient', data: { issuer: fake.url, clientId: fake.clientId, clientSecret: fake.clientSecret } }).id;
  auth.enableTestAuth();
  configure({ enabled: true, domains: ['partner.test'], google: { enabled: true, credentialId } });
  auth.disableTestAuth();
  await seed({ email: 'dana@partner.test', name: 'Dana Partner', hd: 'partner.test' });
});

describe('starting', () => {
  it('redirects to the provider with PKCE S256, state, nonce, the openid scope and the hd hint (one domain), and a state cookie only the callback sees', async () => {
    const { response, url, state } = await start();
    expect(response.status).toBe(302);
    expect(url!.origin + url!.pathname).toBe(`${fake.url}/o/oauth2/v2/auth`);
    const q = url!.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(fake.clientId);
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('nonce')!.length).toBeGreaterThanOrEqual(20);
    expect(q.get('state')).toBe(state);
    expect(q.get('hd')).toBe('partner.test');
    const line = setCookie(response, 'landflow_requester_oidc')!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=lax/i);
    expect(line).toMatch(/Path=\/request-access\/api\/sign-in\/google(;|$)/);
    expect(line).toMatch(/Max-Age=600/);
    // Two or more domains: no hint.
    auth.enableTestAuth();
    configure({ domains: ['partner.test', 'acme.test'] });
    auth.disableTestAuth();
    expect((await start()).url!.searchParams.has('hd')).toBe(false);
  });

  it('answers 404 while Google sign-in is off, without a credential, or with its credential deleted', async () => {
    auth.enableTestAuth();
    configure({ google: { enabled: false } });
    auth.disableTestAuth();
    expect((await start()).response.status).toBe(404);
    auth.enableTestAuth();
    configure({ google: { enabled: true, credentialId } });
    credentials.delete(credentialId);
    auth.disableTestAuth();
    expect((await start()).response.status).toBe(404);
    credentialId = '';
  });

  it('limits starts to 20 in 15 minutes from one network address (the page, with ?error=limited)', async () => {
    const ip = '10.31.0.1';
    for (let i = 0; i < 20; i++) expect((await start(ip)).response.status).toBe(302);
    const refused = await start(ip);
    expect(refused.response.status).toBe(303);
    expect(refused.response.headers.get('location')).toBe('/request-access?error=limited');
  });
});

describe('a good sign-in', () => {
  it('signs a Workspace account of an allowed domain in: requester verified by Google, subject kept, session cookie, audit', async () => {
    const { response } = await signIn('dana@partner.test');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/request-access');
    const line = setCookie(response, 'landflow_requester')!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=strict/i);
    expect(line).toMatch(/Path=\/request-access(;|$)/);
    // The state cookie is cleared.
    expect(setCookie(response, 'landflow_requester_oidc')).toMatch(/Max-Age=0/);
    const row = store.requesterRowByKey('dana@partner.test')!;
    expect(row).toMatchObject({ verified_by: 'google', name: 'Dana Partner', email: 'dana@partner.test' });
    expect(row.google_subject).toMatch(/^\d{10,}$/);
    expect(audited('access.outside.sign_in').some((e) => e.outcome === 'success' && e.details?.method === 'google')).toBe(true);
    const me = await (sessionRoute.GET as Handler)(request('/request-access/api/session', `landflow_requester=${cookieValue(response, 'landflow_requester')}`));
    expect(me.status).toBe(200);
    expect((await me.json()).requester).toEqual({ email: 'dana@partner.test', name: 'Dana Partner', verifiedBy: 'google' });
    // The secret never reaches the audit log.
    expect(JSON.stringify(audited('access.outside.sign_in'))).not.toContain(fake.clientSecret);
  });

  it('works through discovery at a URL other than the issuer (the credential’s discovery URL)', async () => {
    // The credential names the provider's real issuer and where to find it from here.
    const id = credentials.create({ name: 'Via discovery', type: 'core.oidcClient', data: { issuer: fake.url, clientId: fake.clientId, clientSecret: fake.clientSecret, discoveryUrl: `${fake.url}/.well-known/openid-configuration` } }).id;
    auth.enableTestAuth();
    configure({ google: { enabled: true, credentialId: id } });
    auth.disableTestAuth();
    expect((await signIn('dana@partner.test')).response.headers.get('location')).toBe('/request-access');
  });
});

describe('every refusal', () => {
  const refusals: Array<[OidcErrorMode, string]> = [
    ['token_error', 'failed'],
    ['server_error', 'failed'],
    ['wrong_aud', 'failed'],
    ['wrong_iss', 'failed'],
    ['expired', 'failed'],
    ['bad_signature', 'failed'],
    ['missing_nonce', 'failed'],
    ['email_unverified', 'not_verified'],
    ['other_hd', 'domain'],
  ];
  it('covers every error mode the fake can script', () => {
    expect(refusals.map(([mode]) => mode).sort()).toEqual([...OIDC_ERROR_MODES].sort());
  });
  for (const [mode, code] of refusals) {
    it(`refuses ${mode} (${code}): no session, no requester, audited`, async () => {
      await fail(mode);
      const { response } = await signIn('dana@partner.test');
      expect(response.status).toBe(303);
      expect(errorOf(response)).toBe(code);
      expect(setCookie(response, 'landflow_requester')).toBeUndefined();
      expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);
      expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(0);
      expect(audited('access.outside.sign_in').some((e) => e.outcome === 'denied' && e.details?.method === 'google' && e.details?.reason === code)).toBe(true);
      expect(setCookie(response, 'landflow_requester_oidc')).toMatch(/Max-Age=0/);
    });
  }

  it('refuses an unverified address, a Gmail account (no hd), an hd no one allowed, and an hd unlike the address’s domain', async () => {
    await seed({ email: 'unv@partner.test', hd: 'partner.test', email_verified: false });
    await seed({ email: 'gil@gmail.test', name: 'Gil Gmail', hd: null });
    await seed({ email: 'oto@other.test', hd: 'other.test' });
    // A personal Google account registered on a work address: verified, allowed domain, but no Workspace behind it (no hd).
    await seed({ email: 'solo@partner.test', hd: null });
    await seed({ email: 'alias@alias.test', hd: 'partner.test' });
    auth.enableTestAuth();
    configure({ domains: ['partner.test', 'alias.test'] });
    auth.disableTestAuth();
    expect(errorOf((await signIn('unv@partner.test')).response)).toBe('not_verified');
    expect(errorOf((await signIn('gil@gmail.test')).response)).toBe('domain');
    expect(errorOf((await signIn('oto@other.test')).response)).toBe('domain');
    expect(errorOf((await signIn('solo@partner.test')).response)).toBe('domain');
    expect(errorOf((await signIn('alias@alias.test')).response)).toBe('domain');
    expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(0);
    // And an allowed domain's Workspace account is fine again.
    expect((await signIn('dana@partner.test')).response.headers.get('location')).toBe('/request-access');
  });

  it('refuses an address of a Landflow user, a blocked requester, and a Google subject that changed', async () => {
    await seed({ email: 'sam@partner.test', name: 'Sam', hd: 'partner.test' });
    expect(errorOf((await signIn('sam@partner.test')).response)).toBe('landflow_user');
    expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(0);
    expect((await signIn('dana@partner.test')).response.headers.get('location')).toBe('/request-access');
    const dana = store.requesterRowByKey('dana@partner.test')!;
    database().upsert('access_outside_requesters', { ...dana, google_subject: '999999999999999999999' });
    expect(errorOf((await signIn('dana@partner.test')).response)).toBe('subject_changed');
    database().upsert('access_outside_requesters', { ...dana, blocked_at: new Date().toISOString(), blocked_by: owner.id });
    expect(errorOf((await signIn('dana@partner.test')).response)).toBe('blocked');
  });

  it('reports a cancelled sign-in at the provider as denied', async () => {
    const response = await (callbackRoute.GET as Handler)(request('/request-access/api/sign-in/google/callback?error=access_denied&state=x', 'landflow_requester_oidc=x'));
    expect(errorOf(response)).toBe('denied');
  });
});

describe('state, nonce and PKCE', () => {
  it('needs this browser’s own state cookie, and uses the state once', async () => {
    // Started in another browser: no cookie, or somebody else's.
    expect(errorOf((await signIn('dana@partner.test', { cookieState: null })).response)).toBe('expired');
    expect(errorOf((await signIn('dana@partner.test', { cookieState: 'someone-elses-state' })).response)).toBe('expired');
    // The first callback works; replaying it finds nothing.
    const { response, started, back } = await signIn('dana@partner.test');
    expect(response.headers.get('location')).toBe('/request-access');
    const replay = await (callbackRoute.GET as Handler)(request(`${back.pathname}${back.search}`, `landflow_requester_oidc=${started.state}`));
    expect(errorOf(replay)).toBe('expired');
    const log = (await (await fetch(`${fake.url}/_fake/log`)).json()) as Array<{ event: string; outcome?: string }>;
    // The provider verified the PKCE verifier on the one exchange that happened for each good callback.
    expect(log.filter((e) => e.event === 'token' && e.outcome === 'ok').length).toBe(1);
  });

  it('sends a code verifier whose SHA-256 is the challenge (the provider checks it)', async () => {
    const started = await start();
    const challenge = started.url!.searchParams.get('code_challenge')!;
    // A SHA-256 in base64url is 43 characters; the provider (below) checks the verifier we send against it.
    expect(challenge).toHaveLength(43);
    const back = await chooseAccount(started.url!, 'dana@partner.test');
    const response = await (callbackRoute.GET as Handler)(request(`${back.pathname}${back.search}`, `landflow_requester_oidc=${started.state}`));
    expect(response.headers.get('location')).toBe('/request-access');
    const log = (await (await fetch(`${fake.url}/_fake/log`)).json()) as Array<{ event: string; outcome?: string }>;
    expect(log.some((e) => e.event === 'token' && e.outcome === 'ok')).toBe(true);
    expect(log.some((e) => e.outcome?.includes('code_verifier'))).toBe(false);
  });
});

describe('the SSO flow and this one can’t finish each other’s sign-ins', () => {
  const sso = (): import('@/lib/server/auth/oidc').OidcConfig => ({ issuer: fake.url, clientId: fake.clientId, clientSecret: fake.clientSecret, scopes: 'openid email profile', label: 'SSO', roleClaim: 'roles', roleMap: {}, defaultRole: 'member' });

  it('an outside state can’t complete a Landflow SSO sign-in', async () => {
    const started = await start();
    const back = await chooseAccount(started.url!, 'dana@partner.test');
    await expect(oidc.completeLogin(sso(), { code: back.searchParams.get('code'), state: started.state, cookieState: started.state })).rejects.toThrow(/expired|another browser/);
    expect(database().all('SELECT id FROM access_outside_sessions')).toHaveLength(0);
    expect(auth.findUserByEmail('dana@partner.test')).toBeUndefined();
  });

  it('a Landflow SSO state can’t complete an outside sign-in', async () => {
    const { url, state } = await oidc.beginLogin(sso(), BASE, '/');
    const back = await chooseAccount(new URL(url), 'dana@partner.test');
    const response = await (callbackRoute.GET as Handler)(request(`${back.pathname}${back.search}`, `landflow_requester_oidc=${state}`));
    expect(errorOf(response)).toBe('expired');
    expect(setCookie(response, 'landflow_requester')).toBeUndefined();
    expect(database().all('SELECT id FROM access_outside_requesters')).toHaveLength(0);
  });

  it('the SSO flow still works on its own', async () => {
    const { url, state } = await oidc.beginLogin(sso(), BASE, '/');
    const back = await chooseAccount(new URL(url), 'dana@partner.test');
    const done = await oidc.completeLogin(sso(), { code: back.searchParams.get('code'), state, cookieState: state });
    expect(done.user.email).toBe('dana@partner.test');
  });
});

describe('the issuer spellings Google uses', () => {
  it('accepts accounts.google.com beside https://accounts.google.com, and nothing else', async () => {
    // A token the fake signed, checked against a client whose issuer is Google's and that lists the fake's address as an alias.
    const started = await start();
    const nonce = started.url!.searchParams.get('nonce')!;
    const claims = { iss: 'accounts.google.com', aud: 'c', sub: '1', exp: Math.floor(Date.now() / 1000) + 600, nonce };
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k', use: 'sig', alg: 'RS256' };
    const server = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const jwks = `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks`;
    const jwt = (payload: Record<string, unknown>) => {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), pair.privateKey).toString('base64url')}`;
    };
    try {
      const client = { issuer: 'https://accounts.google.com', clientId: 'c', clientSecret: 's' };
      await expect(oidc.verifyIdToken(jwt(claims), { ...client, issuerAliases: ['accounts.google.com'] }, { jwks_uri: jwks }, nonce)).resolves.toMatchObject({ sub: '1' });
      await expect(oidc.verifyIdToken(jwt(claims), client, { jwks_uri: jwks }, nonce)).rejects.toThrow(/another issuer/);
      await expect(oidc.verifyIdToken(jwt({ ...claims, iss: 'accounts.evil.test' }), { ...client, issuerAliases: ['accounts.google.com'] }, { jwks_uri: jwks }, nonce)).rejects.toThrow(/another issuer/);
    } finally {
      server.close();
    }
  });
});

describe('which provider the credential may point at', () => {
  const asOwner = <T>(fn: () => T): T => {
    auth.enableTestAuth();
    try {
      return fn();
    } finally {
      auth.disableTestAuth();
    }
  };

  it('pins Google’s issuer: another issuer or a discovery URL is refused (at save, at sign-in and in the config) unless the dev flag is set', async () => {
    delete process.env.LANDFLOW_ACCESS_OUTSIDE_DEV_OIDC;
    try {
      expect(settings.googleReady()).toBe(false);
      expect((await start()).response.status).not.toBe(302);
      expect(() => asOwner(() => configure({ google: { enabled: true, credentialId } }))).toThrow(/Google’s own issuer|accounts\.google\.com/);
      // The real issuer is fine, but a discovery URL on it is not.
      const real = credentials.create({ name: 'Real Google', type: 'core.oidcClient', data: { issuer: 'https://accounts.google.com', clientId: 'c', clientSecret: 's' } });
      expect(asOwner(() => configure({ google: { enabled: true, credentialId: real.id } })).google.credentialId).toBe(real.id);
      const sneaky = credentials.create({ name: 'Sneaky', type: 'core.oidcClient', data: { issuer: 'https://accounts.google.com', discoveryUrl: `${fake.url}/.well-known/openid-configuration`, clientId: 'c', clientSecret: 's' } });
      expect(() => asOwner(() => configure({ google: { enabled: true, credentialId: sneaky.id } }))).toThrow(/Google’s own issuer|accounts\.google\.com/);
    } finally {
      process.env.LANDFLOW_ACCESS_OUTSIDE_DEV_OIDC = 'true';
      asOwner(() => configure({ google: { enabled: true, credentialId } }));
    }
  });

  it('refuses sign-in once the chosen credential changed, until an admin saves the settings again', async () => {
    expect(settings.googleReady()).toBe(true);
    credentials.update(credentialId, { data: { issuer: fake.url, clientId: fake.clientId, clientSecret: fake.clientSecret, hostedDomain: 'changed' } });
    expect(settings.googleReady()).toBe(false);
    expect((await start()).response.status).not.toBe(302);
    asOwner(() => configure({ google: { enabled: true, credentialId } }));
    expect(settings.googleReady()).toBe(true);
    expect((await start()).response.status).toBe(302);
  });
});
