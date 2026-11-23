/** The Google OpenID Connect fake: discovery, the code flow with PKCE, a single-use code, the id_token's claims and every scripted refusal. */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGoogleOidc, GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET, type OidcErrorMode } from '../src/google-oidc';

const REDIRECT = 'http://localhost:3000/api/access/outside/google/callback';
const oidc = fakeGoogleOidc({ redirectUris: [REDIRECT] });
beforeAll(() => oidc.start());
afterAll(() => oidc.stop());
beforeEach(() => oidc.reset());

const b64 = (buffer: Buffer) => buffer.toString('base64url');
const pkce = () => {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
};
const decode = (jwt: string) => {
  const [h, p] = jwt.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, any> };
};
const authParams = (extra: Record<string, string> = {}, challenge = pkce().challenge) =>
  new URLSearchParams({
    client_id: GOOGLE_OIDC_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'st-1',
    nonce: 'nonce-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
const auto = (email: string, extra: Record<string, string> = {}, challenge?: string) => fetch(`${oidc.url}/o/oauth2/v2/auth?${authParams({ login_hint: email, auto: '1', ...extra }, challenge)}`, { redirect: 'manual' });
/** Run the auto login and return the code, checking state came back. */
const login = async (email: string, challenge?: string) => {
  const response = await auto(email, {}, challenge);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('st-1');
  return location.searchParams.get('code') ?? '';
};
const exchange = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${oidc.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
const tokenFields = (code: string, verifier: string, extra: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  code,
  redirect_uri: REDIRECT,
  client_id: GOOGLE_OIDC_CLIENT_ID,
  client_secret: GOOGLE_OIDC_CLIENT_SECRET,
  code_verifier: verifier,
  ...extra,
});
const seed = (account: Record<string, unknown>) => fetch(`${oidc.url}/_fake/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) });
const fail = (mode: OidcErrorMode, times?: number) => fetch(`${oidc.url}/_fake/next-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, times }) });
/** A whole successful flow for mia, returning the token response. */
const flow = async () => {
  const { verifier, challenge } = pkce();
  const code = await login('mia@acme.test', challenge);
  return exchange(tokenFields(code, verifier));
};

describe('discovery and keys', () => {
  it('serves the document with its own origin as issuer and Google\'s supported values', async () => {
    const doc = (await (await fetch(`${oidc.url}/.well-known/openid-configuration`)).json()) as Record<string, any>;
    expect(doc).toMatchObject({
      issuer: oidc.url,
      authorization_endpoint: `${oidc.url}/o/oauth2/v2/auth`,
      token_endpoint: `${oidc.url}/token`,
      jwks_uri: `${oidc.url}/oauth2/v3/certs`,
      userinfo_endpoint: `${oidc.url}/v1/userinfo`,
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['plain', 'S256'],
    });
    expect(doc.response_types_supported).toContain('code');
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
    expect(doc.claims_supported).toEqual(expect.arrayContaining(['sub', 'email', 'email_verified', 'hd', 'name']));
  });

  it('publishes a JWKS whose key verifies the id_token', async () => {
    const jwks = (await (await fetch(`${oidc.url}/oauth2/v3/certs`)).json()) as { keys: Array<Record<string, string>> };
    expect(jwks.keys).toHaveLength(1);
    const jwt = ((await (await flow()).json()) as { id_token: string }).id_token;
    const [h, p, s] = jwt.split('.');
    expect(decode(jwt).header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: jwks.keys[0].kid });
    const key = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('the authorization page', () => {
  it('lists the seeded accounts with a button each and posts the choice back as a redirect with code and state', async () => {
    const page = await fetch(`${oidc.url}/o/oauth2/v2/auth?${authParams()}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Continue as mia@acme.test');
    expect(html).toContain('Continue as sam@acme.test');
    const picked = await fetch(`${oidc.url}/o/oauth2/v2/auth/select`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(authParams()), email: 'sam@acme.test' }),
    });
    expect(picked.status).toBe(302);
    const location = new URL(picked.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('st-1');
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('answers a deny button with access_denied and the state', async () => {
    const response = await fetch(`${oidc.url}/o/oauth2/v2/auth/select`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(authParams()), deny: '1' }),
    });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('shows an error page, and never redirects, for an unknown client or an unregistered redirect_uri', async () => {
    for (const extra of [{ client_id: 'someone-else' }, { redirect_uri: 'https://evil.test/cb' }] as Array<Record<string, string>>) {
      const response = await auto('mia@acme.test', extra);
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it.each([
    ['response_type', { response_type: 'token' }, 'unsupported_response_type'],
    ['scope without openid', { scope: 'email' }, 'invalid_scope'],
    ['scope without email', { scope: 'openid' }, 'invalid_scope'],
    ['state', { state: '' }, 'invalid_request'],
    ['nonce', { nonce: '' }, 'invalid_request'],
    ['code_challenge', { code_challenge: '' }, 'invalid_request'],
    ['a plain challenge method', { code_challenge_method: 'plain' }, 'invalid_request'],
  ])('redirects with an error for a bad %s', async (_name, extra, error) => {
    const response = await auto('mia@acme.test', extra);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('refuses a login_hint nobody is seeded for', async () => {
    const location = new URL((await auto('ghost@acme.test')).headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
});

describe('the token endpoint', () => {
  it('gives an id_token with the account\'s claims, an access_token and the userinfo for it', async () => {
    const { verifier, challenge } = pkce();
    const code = await login('mia@acme.test', challenge);
    const response = await exchange(tokenFields(code, verifier));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3599, access_token: expect.any(String) });
    const { claims } = decode(body.id_token);
    expect(claims).toMatchObject({ iss: oidc.url, aud: GOOGLE_OIDC_CLIENT_ID, email: 'mia@acme.test', email_verified: true, hd: 'acme.test', name: 'Mia Acme', nonce: 'nonce-1' });
    expect(claims.sub).toMatch(/^\d+$/);
    expect(claims.exp).toBe(claims.iat + 3600);
    const info = await fetch(`${oidc.url}/v1/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(await info.json()).toMatchObject({ sub: claims.sub, email: 'mia@acme.test', email_verified: true, hd: 'acme.test', name: 'Mia Acme' });
    expect((await fetch(`${oidc.url}/v1/userinfo`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('takes the client secret as HTTP Basic too', async () => {
    const { verifier, challenge } = pkce();
    const code = await login('mia@acme.test', challenge);
    const { client_id: _id, client_secret: _secret, ...rest } = tokenFields(code, verifier);
    const basic = `Basic ${Buffer.from(`${GOOGLE_OIDC_CLIENT_ID}:${GOOGLE_OIDC_CLIENT_SECRET}`).toString('base64')}`;
    expect((await exchange(rest, { authorization: basic })).status).toBe(200);
  });

  it('refuses a wrong secret, a wrong client, a wrong redirect_uri and a missing grant type', async () => {
    for (const extra of [{ client_secret: 'wrong' }, { client_id: 'other' }, { redirect_uri: 'http://localhost:3000/elsewhere' }, { grant_type: 'password' }] as Array<Record<string, string>>) {
      const { verifier, challenge } = pkce();
      const code = await login('mia@acme.test', challenge);
      const response = await exchange(tokenFields(code, verifier, extra));
      expect(response.status, JSON.stringify(extra)).toBe('client_secret' in extra || 'client_id' in extra ? 401 : 400);
    }
  });

  it('refuses a wrong or missing code_verifier (PKCE) with invalid_grant', async () => {
    const { challenge } = pkce();
    const code = await login('mia@acme.test', challenge);
    const bad = await exchange(tokenFields(code, pkce().verifier));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
    const code2 = await login('mia@acme.test', challenge);
    const { code_verifier: _v, ...without } = tokenFields(code2, '');
    expect((await exchange(without)).status).toBe(400);
  });

  it('spends a code once: the second exchange fails, even with the right verifier', async () => {
    const { verifier, challenge } = pkce();
    const code = await login('mia@acme.test', challenge);
    expect((await exchange(tokenFields(code, verifier))).status).toBe(200);
    const again = await exchange(tokenFields(code, verifier));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(tokenFields('made-up', verifier))).status).toBe(400);
  });

  it('refuses a code older than its lifetime', async () => {
    const short = fakeGoogleOidc({ redirectUris: [REDIRECT], codeTtlMs: 20 });
    await short.start();
    try {
      const { verifier, challenge } = pkce();
      const location = new URL((await fetch(`${short.url}/o/oauth2/v2/auth?${authParams({ login_hint: 'mia@acme.test', auto: '1' }, challenge)}`, { redirect: 'manual' })).headers.get('location') ?? '');
      await new Promise((resolve) => setTimeout(resolve, 60));
      const response = await fetch(`${short.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(tokenFields(location.searchParams.get('code') ?? '', verifier)) });
      expect(response.status).toBe(400);
    } finally {
      await short.stop();
    }
  });
});

describe('the control endpoints', () => {
  it('seeds an account, with Google\'s defaults, and a consumer account has no hd', async () => {
    expect((await seed({ email: 'zed@other.test', name: 'Zed', hd: 'other.test', email_verified: false })).status).toBe(200);
    expect((await seed({ email: 'gmail@gmail.test', hd: null })).status).toBe(200);
    expect((await seed({ name: 'no email' })).status).toBe(400);
    const accounts = oidc.state().accounts;
    expect(accounts.find((a) => a.email === 'zed@other.test')).toMatchObject({ hd: 'other.test', emailVerified: false });
    const { verifier, challenge } = pkce();
    const code = await login('gmail@gmail.test', challenge);
    const { claims } = decode(((await (await exchange(tokenFields(code, verifier))).json()) as { id_token: string }).id_token);
    expect(claims).not.toHaveProperty('hd');
    expect(claims.email_verified).toBe(true);
  });

  it('logs the flow in order, never the secret', async () => {
    await flow();
    const log = (await (await fetch(`${oidc.url}/_fake/log`)).json()) as Array<Record<string, any>>;
    expect(log.map((e) => e.event)).toEqual(['authorize', 'token']);
    expect(log[0]).toMatchObject({ email: 'mia@acme.test', clientId: GOOGLE_OIDC_CLIENT_ID });
    expect(log[1]).toMatchObject({ outcome: 'ok', mode: null });
    expect(JSON.stringify(log)).not.toContain(GOOGLE_OIDC_CLIENT_SECRET);
  });

  it('refuses an unknown mode and clears with reset', async () => {
    expect((await fail('nope' as OidcErrorMode)).status).toBe(400);
    await fail('wrong_aud');
    oidc.reset();
    expect(decode(((await (await flow()).json()) as { id_token: string }).id_token).claims.aud).toBe(GOOGLE_OIDC_CLIENT_ID);
  });
});

describe('next-error modes', () => {
  const claimsOf = async () => {
    const response = await flow();
    expect(response.status).toBe(200);
    const { id_token } = (await response.json()) as { id_token: string };
    return { jwt: id_token, ...decode(id_token) };
  };

  it.each<[OidcErrorMode, (c: Record<string, any>) => void]>([
    ['wrong_aud', (c) => expect(c.aud).not.toBe(GOOGLE_OIDC_CLIENT_ID)],
    ['wrong_iss', (c) => expect(c.iss).not.toBe(oidc.url)],
    ['expired', (c) => expect(c.exp).toBeLessThan(Date.now() / 1000)],
    ['missing_nonce', (c) => expect(c).not.toHaveProperty('nonce')],
    ['email_unverified', (c) => expect(c.email_verified).toBe(false)],
    ['other_hd', (c) => expect(c.hd).toBe('other.test')],
  ])('%s changes only that claim', async (mode, check) => {
    await fail(mode);
    const { claims } = await claimsOf();
    check(claims);
    // It is spent: the next flow is clean.
    const next = (await claimsOf()).claims;
    expect(next).toMatchObject({ iss: oidc.url, aud: GOOGLE_OIDC_CLIENT_ID, nonce: 'nonce-1', email_verified: true, hd: 'acme.test' });
    expect(next.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('bad_signature signs with a key the JWKS does not hold', async () => {
    await fail('bad_signature');
    const { jwt } = await claimsOf();
    const jwks = (await (await fetch(`${oidc.url}/oauth2/v3/certs`)).json()) as { keys: Array<Record<string, string>> };
    const [h, p, s] = jwt.split('.');
    const key = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(false);
  });

  it('token_error answers the call with invalid_grant, and server_error with a 500', async () => {
    await fail('token_error');
    const first = await flow();
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ error: 'invalid_grant' });
    await fail('server_error');
    expect((await flow()).status).toBe(500);
    expect((await flow()).status).toBe(200);
  });

  it('applies to as many token calls as asked', async () => {
    await fail('wrong_aud', 2);
    expect((await claimsOf()).claims.aud).not.toBe(GOOGLE_OIDC_CLIENT_ID);
    expect((await claimsOf()).claims.aud).not.toBe(GOOGLE_OIDC_CLIENT_ID);
    expect((await claimsOf()).claims.aud).toBe(GOOGLE_OIDC_CLIENT_ID);
  });
});
