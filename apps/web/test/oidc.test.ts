/**
 * Single sign-on (OIDC authorization code + PKCE) against an in-process fake provider: discovery, the redirect with
 * state, nonce and S256 challenge, the code exchange (the provider checks the verifier and the client secret), ID token
 * signature and claim checks, role mapping, just-in-time users, linking by verified email, and the failure paths.
 * The same flow against the real Keycloak is test/oidc.integration.test.ts (LANDFLOW_INTEGRATION=oidc).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oidc-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const oidc = await import('@/lib/server/auth/oidc');
const loginRoute = await import('@/app/api/auth/oidc/login/route');
const callbackRoute = await import('@/app/api/auth/oidc/callback/route');
const meRoute = await import('@/app/api/auth/me/route');
const statusRoute = await import('@/app/api/auth/status/route');

// ---- a fake provider ---------------------------------------------------------------------------------------

const CLIENT_ID = 'landflow';
const CLIENT_SECRET = 'fake-client-secret';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

type Grant = { claims: Record<string, unknown>; challenge: string; nonce: string; redirectUri: string };
const grants = new Map<string, Grant>();
let issuer = '';
let server: Server;
/** Overrides for the next ID token (to test the checks). */
let tamper: { claims?: Record<string, unknown>; key?: KeyObject } = {};

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const path = url.pathname.replace(/^\/realms\/test/, '');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    }
    if (path === '/jwks') return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (path === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}`) return send(401, { error: 'invalid_client' });
        const grant = grants.get(form.get('code') ?? '');
        if (!grant) return send(400, { error: 'invalid_grant', error_description: 'Code not valid' });
        grants.delete(form.get('code')!);
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        if (form.get('redirect_uri') !== grant.redirectUri) return send(400, { error: 'invalid_grant', error_description: 'Incorrect redirect_uri' });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce, ...grant.claims, ...tamper.claims };
        send(200, { id_token: jwt(claims, tamper.key), access_token: 'at', token_type: 'Bearer' });
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/test`;
  Object.assign(process.env, {
    LANDFLOW_OIDC_ISSUER: issuer,
    LANDFLOW_OIDC_CLIENT_ID: CLIENT_ID,
    LANDFLOW_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    LANDFLOW_OIDC_ROLE_MAP: 'landflow-admin=admin,landflow-editor=member',
    LANDFLOW_OIDC_LABEL: 'Sign in with Fake',
  });
  auth.disableTestAuth();
});

beforeEach(() => {
  tamper = {};
  delete process.env.LANDFLOW_OIDC_DEFAULT_ROLE;
});

afterAll(() => {
  server?.close();
  auth.enableTestAuth();
  oidc.resetOidcCaches();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_OIDC_ISSUER', 'LANDFLOW_OIDC_CLIENT_ID', 'LANDFLOW_OIDC_CLIENT_SECRET', 'LANDFLOW_OIDC_ROLE_MAP', 'LANDFLOW_OIDC_LABEL', 'LANDFLOW_OIDC_DEFAULT_ROLE']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- the browser's side ------------------------------------------------------------------------------------

type Route = (request: Request) => Promise<Response>;
const BASE = 'http://localhost:3000';

function cookieOf(response: Response, name: string): string | undefined {
  const line = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : undefined;
}

/** Sign in through the fake provider as a user with `claims`: the callback's response (and the provider's URL). */
async function ssoSignIn(claims: Record<string, unknown>, options: { next?: string; stateCookie?: string } = {}) {
  const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/oidc/login${options.next ? `?next=${encodeURIComponent(options.next)}` : ''}`));
  expect(started.status).toBe(307);
  const authorize = new URL(started.headers.get('location')!);
  const state = cookieOf(started, oidc.OIDC_STATE_COOKIE)!;
  // The provider authenticates the user and redirects back with a code.
  const code = `code-${Math.random().toString(36).slice(2)}`;
  grants.set(code, { claims, challenge: authorize.searchParams.get('code_challenge')!, nonce: authorize.searchParams.get('nonce')!, redirectUri: authorize.searchParams.get('redirect_uri')! });
  const callback = `${authorize.searchParams.get('redirect_uri')}?code=${code}&state=${authorize.searchParams.get('state')}`;
  const response = await (callbackRoute.GET as Route)(new Request(callback, { headers: { cookie: `${oidc.OIDC_STATE_COOKIE}=${options.stateCookie ?? state}` } }));
  return { response, authorize, location: response.headers.get('location') ?? '', session: cookieOf(response, 'landflow_session') };
}

async function me(session: string) {
  const response = await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${session}` } }));
  return (await response.json()) as { user: { id: string; email: string; name: string; role: string; sso: boolean; hasPassword: boolean } };
}

describe('OIDC sign-in', () => {
  it('shows the SSO button on the sign-in page', async () => {
    const status = await (await (statusRoute.GET as Route)(new Request(`${BASE}/api/auth/status`))).json();
    expect(status.oidc).toEqual({ label: 'Sign in with Fake' });
  });

  it('refuses SSO before the owner exists', async () => {
    const result = await ssoSignIn({ sub: 'early', email: 'early@example.com', email_verified: true, roles: ['landflow-admin'] });
    expect(result.location).toContain('/login?error=');
    expect(decodeURIComponent(result.location)).toContain('owner setup');
    expect(result.session).toBeUndefined();
  });

  it('redirects with state, nonce, PKCE (S256) and the callback URL', async () => {
    await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'owner-password' });
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/oidc/login?next=/workflows`));
    const url = new URL(started.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${BASE}/api/auth/oidc/callback`, scope: 'openid email profile', code_challenge_method: 'S256' });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe(cookieOf(started, oidc.OIDC_STATE_COOKIE));
    const cookie = started.headers.getSetCookie().find((c) => c.startsWith(oidc.OIDC_STATE_COOKIE))!.toLowerCase();
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('path=/api/auth/oidc');
  });

  it('creates users just in time with their mapped role, and signs them in where they were going', async () => {
    const alice = await ssoSignIn({ sub: 'alice-sub', email: 'Alice@Example.com', email_verified: true, name: 'Alice', roles: ['default-roles', 'landflow-admin'] }, { next: '/workflows/wf_1' });
    expect(alice.location).toBe(`${BASE}/workflows/wf_1`);
    expect(alice.session).toBeTruthy();
    expect((await me(alice.session!)).user).toMatchObject({ email: 'alice@example.com', name: 'Alice', role: 'admin', sso: true, hasPassword: false });

    const bob = await ssoSignIn({ sub: 'bob-sub', email: 'bob@example.com', email_verified: true, preferred_username: 'bob', roles: ['landflow-editor'] });
    expect(bob.location).toBe(`${BASE}/`);
    expect((await me(bob.session!)).user).toMatchObject({ name: 'bob', role: 'member' });

    // Signing in again finds the same user, and follows role changes at the provider.
    const again = await ssoSignIn({ sub: 'bob-sub', email: 'bob@example.com', email_verified: true, roles: ['landflow-admin'] });
    const user = (await me(again.session!)).user;
    expect(user.id).toBe((await me(bob.session!)).user.id);
    expect(user.role).toBe('admin');
  });

  it('links an existing account by verified email, never changes the owner’s role, and refuses unverified matches', async () => {
    await auth.createUser({ email: 'carol@example.com', name: 'Carol', role: 'member', password: 'carol-password' });
    const carol = await ssoSignIn({ sub: 'carol-sub', email: 'carol@example.com', email_verified: true, roles: ['landflow-admin'] });
    expect((await me(carol.session!)).user).toMatchObject({ name: 'Carol', role: 'admin', sso: true, hasPassword: true });

    const owner = await ssoSignIn({ sub: 'owner-sub', email: 'owner@example.com', email_verified: true, roles: ['landflow-editor'] });
    expect((await me(owner.session!)).user.role).toBe('owner');

    await auth.createUser({ email: 'dave@example.com', name: 'Dave', role: 'member', password: 'dave-password' });
    const dave = await ssoSignIn({ sub: 'mallory', email: 'dave@example.com', email_verified: false });
    expect(dave.session).toBeUndefined();
    expect(decodeURIComponent(dave.location)).toContain('hasn’t verified');
  });

  it('applies the default role, or refuses users without a mapped role when it is `none`', async () => {
    const plain = await ssoSignIn({ sub: 'erin', email: 'erin@example.com', email_verified: true });
    expect((await me(plain.session!)).user.role).toBe('member');
    process.env.LANDFLOW_OIDC_DEFAULT_ROLE = 'none';
    const refused = await ssoSignIn({ sub: 'frank', email: 'frank@example.com', email_verified: true, roles: ['something-else'] });
    expect(refused.session).toBeUndefined();
    expect(decodeURIComponent(refused.location)).toContain('no Landflow role');
  });

  it('rejects a bad state, a forged signature, the wrong audience, an expired token and a replayed nonce', async () => {
    const claims = { sub: 'gina', email: 'gina@example.com', email_verified: true };
    const expectFailure = async (result: Awaited<ReturnType<typeof ssoSignIn>>, text: string) => {
      expect(result.session).toBeUndefined();
      expect(decodeURIComponent(result.location)).toContain(text);
    };
    await expectFailure(await ssoSignIn(claims, { stateCookie: 'another-browser' }), 'another browser');
    tamper = { key: otherKey };
    await expectFailure(await ssoSignIn(claims), 'signature is invalid');
    tamper = { claims: { aud: 'someone-else' } };
    await expectFailure(await ssoSignIn(claims), 'another client');
    tamper = { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } };
    await expectFailure(await ssoSignIn(claims), 'expired');
    tamper = { claims: { nonce: 'replayed' } };
    await expectFailure(await ssoSignIn(claims), 'nonce');
    tamper = { claims: { iss: 'https://evil.example' } };
    await expectFailure(await ssoSignIn(claims), 'another issuer');
  });

  it('maps roles from a dotted claim path and a space-separated string', () => {
    const config = { roleClaim: 'realm_access.roles', roleMap: oidc.parseRoleMap('a=member, b=admin, junk, c=owner') };
    expect(config.roleMap).toEqual({ a: 'member', b: 'admin' });
    expect(oidc.mappedRole({ realm_access: { roles: ['a', 'b'] } }, config)).toBe('admin');
    expect(oidc.mappedRole({ realm_access: { roles: ['a'] } }, config)).toBe('member');
    expect(oidc.mappedRole({ groups: 'a c' }, { roleClaim: 'groups', roleMap: config.roleMap })).toBe('member');
    expect(oidc.mappedRole({}, config)).toBeUndefined();
  });
});
