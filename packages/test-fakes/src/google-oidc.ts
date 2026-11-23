/**
 * A Google OpenID Connect stand-in for testing "Sign in with Google" (the code flow with state, nonce and PKCE S256).
 * Serves discovery, the authorization page (a button per seeded account, plus `login_hint` + `auto=1` to skip the click),
 * the token endpoint (single-use short-lived code, client secret by Basic or post, code_verifier against the challenge),
 * the JWKS, userinfo, and control endpoints: `POST /_fake/accounts` seeds an account, `POST /_fake/next-error` makes the
 * next token call fail or carry one bad claim (so a client's every refusal can be proved), `GET /_fake/log` is the flow.
 * The id_token is an RS256 JWT signed with a key generated per fake (`node:crypto`); the `bad_signature` mode signs with
 * a second key the JWKS does not hold. The fake needs no token: like Google's endpoints it is public. Test-only; node
 * built-ins only.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { defineFake, type FakeReply, type FakeRequest } from './harness';

/** The client the fake knows unless `clientId` / `clientSecret` say otherwise. */
export const GOOGLE_OIDC_CLIENT_ID = 'fake-google-client.apps.googleusercontent.test';
export const GOOGLE_OIDC_CLIENT_SECRET = 'fake-google-client-secret';

/** What `POST /_fake/next-error` can ask for: a failed call, or an id_token with one thing wrong. */
export type OidcErrorMode = 'token_error' | 'server_error' | 'wrong_aud' | 'wrong_iss' | 'expired' | 'bad_signature' | 'missing_nonce' | 'email_unverified' | 'other_hd';
export const OIDC_ERROR_MODES: readonly OidcErrorMode[] = ['token_error', 'server_error', 'wrong_aud', 'wrong_iss', 'expired', 'bad_signature', 'missing_nonce', 'email_unverified', 'other_hd'];
/** The calls themselves fail; the others still need a call that passed every check. */
const FAILING: readonly OidcErrorMode[] = ['token_error', 'server_error'];

export interface OidcAccount {
  email: string;
  name: string;
  /** The Workspace domain claim; absent for a consumer account. */
  hd?: string;
  emailVerified: boolean;
}

export interface OidcClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

interface IssuedCode {
  email: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  issuedAt: number;
}

export interface GoogleOidcState {
  accounts: OidcAccount[];
  clients: OidcClient[];
  /** Codes not yet spent, by code. */
  codes: Record<string, IssuedCode>;
  /** Codes already spent (a second use is refused). */
  spent: string[];
  /** Access tokens issued, to the account's email. */
  accessTokens: Record<string, string>;
  /** Modes waiting for the next token calls, in order. */
  nextErrors: OidcErrorMode[];
  log: Array<Record<string, unknown>>;
}

export interface GoogleOidcOptions {
  clientId?: string;
  clientSecret?: string;
  /** Redirect URIs the default client registered (more through `POST /_fake/clients`). Default none: nothing is accepted. */
  redirectUris?: string[];
  /** How long a code lives (default 60 s). */
  codeTtlMs?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): FakeReply => ({ status, body, headers: { 'cache-control': 'no-store', ...headers } });
const html = (status: number, body: string): FakeReply => ({ status, body, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const redirect = (to: URL): FakeReply => ({ status: 302, body: '', headers: { location: to.toString(), 'cache-control': 'no-store' } });
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const domainOf = (email: string) => email.split('@')[1] ?? '';

/** A Google-looking numeric subject, stable per email. */
const subjectOf = (email: string) => BigInt(`0x${createHash('sha256').update(email).digest('hex').slice(0, 16)}`).toString().padStart(21, '1').slice(0, 21);

const seedAccounts = (): OidcAccount[] => [
  { email: 'mia@acme.test', name: 'Mia Acme', hd: 'acme.test', emailVerified: true },
  { email: 'sam@acme.test', name: 'Sam Acme', hd: 'acme.test', emailVerified: true },
];

export function fakeGoogleOidc(options: GoogleOidcOptions = {}) {
  const clientId = options.clientId ?? GOOGLE_OIDC_CLIENT_ID;
  const clientSecret = options.clientSecret ?? GOOGLE_OIDC_CLIENT_SECRET;
  const ttl = options.codeTtlMs ?? 60_000;
  // Keys stay out of the state: `state()` is a structured clone, and a reset keeps the same keys (the JWKS a client cached stays right).
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = b64(randomBytes(8));
  let strangerKey: KeyObject | undefined;
  const stranger = () => (strangerKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);

  const fresh = (): GoogleOidcState => ({
    accounts: seedAccounts(),
    clients: [{ clientId, clientSecret, redirectUris: [...(options.redirectUris ?? [])] }],
    codes: {},
    spent: [],
    accessTokens: {},
    nextErrors: [],
    log: [],
  });

  const origin = () => fake.url;

  const signJwt = (claims: Record<string, unknown>, key: KeyObject, keyId: string) => {
    const input = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId }))}.${b64(JSON.stringify(claims))}`;
    return `${input}.${b64(sign('RSA-SHA256', Buffer.from(input), createPrivateKey(key.export({ format: 'pem', type: 'pkcs8' })))) }`;
  };

  /** Validate an authorization request; an error is either a page (client or redirect unusable) or a redirect with `error`. */
  const checkAuth = (state: GoogleOidcState, q: URLSearchParams): { page: FakeReply } | { redirectUri: string; error?: string; description?: string; client: OidcClient } => {
    const client = state.clients.find((c) => c.clientId === q.get('client_id'));
    if (!client) return { page: html(400, '<h1>Error 401: invalid_client</h1><p>The OAuth client was not found.</p>') };
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!client.redirectUris.includes(redirectUri)) return { page: html(400, '<h1>Error 400: redirect_uri_mismatch</h1><p>The redirect URI is not registered for this client.</p>') };
    const bad = (error: string, description: string) => ({ redirectUri, client, error, description });
    if (q.get('response_type') !== 'code') return bad('unsupported_response_type', 'response_type must be code');
    const scopes = (q.get('scope') ?? '').split(/\s+/);
    if (!scopes.includes('openid') || !scopes.includes('email')) return bad('invalid_scope', 'scope must include openid and email');
    if (!q.get('state')) return bad('invalid_request', 'state is required');
    if (!q.get('nonce')) return bad('invalid_request', 'nonce is required');
    if (!q.get('code_challenge')) return bad('invalid_request', 'code_challenge is required');
    if (q.get('code_challenge_method') !== 'S256') return bad('invalid_request', 'code_challenge_method must be S256');
    return { redirectUri, client };
  };

  const back = (redirectUri: string, params: Record<string, string>) => {
    const to = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) to.searchParams.set(k, v);
    return redirect(to);
  };

  /** Issue a code for an account and send the browser back. */
  const grant = (state: GoogleOidcState, q: URLSearchParams, email: string): FakeReply => {
    const checked = checkAuth(state, q);
    if ('page' in checked) return checked.page;
    const stateParam = q.get('state') ?? '';
    if (checked.error) return back(checked.redirectUri, { error: checked.error, error_description: checked.description ?? '', state: stateParam });
    const account = state.accounts.find((a) => a.email === email);
    if (!account) return back(checked.redirectUri, { error: 'access_denied', state: stateParam });
    const code = `4/0${randomBytes(24).toString('base64url')}`;
    state.codes[code] = { email, clientId: checked.client.clientId, redirectUri: checked.redirectUri, challenge: q.get('code_challenge') ?? '', nonce: q.get('nonce') ?? '', issuedAt: Date.now() };
    state.log.push({ event: 'authorize', email, clientId: checked.client.clientId, redirectUri: checked.redirectUri, state: stateParam });
    return back(checked.redirectUri, { code, state: stateParam });
  };

  const authPage = (state: GoogleOidcState, q: URLSearchParams): FakeReply => {
    const hidden = [...q.entries()].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('');
    const hint = q.get('login_hint');
    const buttons = state.accounts
      .map((a) => `<li><button type="submit" name="email" value="${escape(a.email)}"${a.email === hint ? ' autofocus' : ''}>Continue as ${escape(a.email)}</button> <small>${escape(a.name)}${a.hd ? ` (${escape(a.hd)})` : ''}</small></li>`)
      .join('');
    return html(
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in with Google (fake)</title></head><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem"><h1>Sign in with Google</h1><p>This is a test stand-in. Choose an account.</p><form method="post" action="/o/oauth2/v2/auth/select">${hidden}<ul style="list-style:none;padding:0;line-height:2.6">${buttons}</ul><button type="submit" name="deny" value="1">Cancel</button></form></body></html>`,
    );
  };

  const tokenError = (status: number, error: string, description: string): FakeReply => json(status, { error, error_description: description });

  const token = (state: GoogleOidcState, request: FakeRequest): FakeReply => {
    const form = (request.body ?? {}) as Record<string, string>;
    const note = (outcome: string, mode: OidcErrorMode | null = null) => state.log.push({ event: 'token', outcome, mode });
    // A failing mode answers the call before anything is checked: the next call fails, whatever it was.
    if (state.nextErrors.length && FAILING.includes(state.nextErrors[0])) {
      const mode = state.nextErrors.shift() as OidcErrorMode;
      note('failed', mode);
      return mode === 'server_error' ? tokenError(500, 'server_error', 'scripted') : tokenError(400, 'invalid_grant', 'scripted');
    }
    let id = form.client_id;
    let secret = form.client_secret;
    const basic = /^Basic (.+)$/i.exec(String(request.headers.authorization ?? ''));
    if (basic) {
      const [user, ...rest] = Buffer.from(basic[1], 'base64').toString().split(':');
      id = decodeURIComponent(user);
      secret = decodeURIComponent(rest.join(':'));
    }
    const client = state.clients.find((c) => c.clientId === id);
    if (!client || client.clientSecret !== secret) {
      note('refused: invalid_client');
      return tokenError(401, 'invalid_client', 'The OAuth client was not found or the secret is wrong.');
    }
    if (form.grant_type !== 'authorization_code') {
      note('refused: unsupported_grant_type');
      return tokenError(400, 'unsupported_grant_type', 'grant_type must be authorization_code');
    }
    const code = form.code ?? '';
    const issued = state.codes[code];
    if (!issued) {
      note(state.spent.includes(code) ? 'refused: code already used' : 'refused: unknown code');
      return tokenError(400, 'invalid_grant', 'Bad Request');
    }
    // Spent first: a wrong verifier or redirect burns the code, like Google's.
    delete state.codes[code];
    state.spent.push(code);
    if (Date.now() - issued.issuedAt > ttl) {
      note('refused: code expired');
      return tokenError(400, 'invalid_grant', 'Bad Request');
    }
    if (issued.clientId !== client.clientId || issued.redirectUri !== form.redirect_uri) {
      note('refused: redirect_uri or client mismatch');
      return tokenError(400, 'invalid_grant', 'Bad Request');
    }
    const verifier = form.code_verifier ?? '';
    if (!verifier || b64(createHash('sha256').update(verifier).digest()) !== issued.challenge) {
      note('refused: code_verifier');
      return tokenError(400, 'invalid_grant', 'Invalid code verifier.');
    }
    const account = state.accounts.find((a) => a.email === issued.email) as OidcAccount;
    const mode = state.nextErrors.shift() ?? null;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: mode === 'wrong_iss' ? 'https://accounts.evil.test' : origin(),
      azp: client.clientId,
      aud: mode === 'wrong_aud' ? 'someone-elses-client' : client.clientId,
      sub: subjectOf(account.email),
      email: account.email,
      email_verified: mode === 'email_unverified' ? false : account.emailVerified,
      name: account.name,
      iat: mode === 'expired' ? now - 7200 : now,
      exp: mode === 'expired' ? now - 3600 : now + 3600,
    };
    const hd = mode === 'other_hd' ? 'other.test' : account.hd;
    if (hd) claims.hd = hd;
    if (mode !== 'missing_nonce') claims.nonce = issued.nonce;
    const accessToken = `ya29.${randomBytes(24).toString('base64url')}`;
    state.accessTokens[accessToken] = account.email;
    note('ok', mode);
    return json(200, {
      access_token: accessToken,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      token_type: 'Bearer',
      id_token: mode === 'bad_signature' ? signJwt(claims, stranger(), kid) : signJwt(claims, keyPair.privateKey, kid),
    });
  };

  const fake = defineFake<GoogleOidcState>({
    name: 'google-oidc',
    token: 'google-oidc-needs-no-token',
    // Google's endpoints are public (the client authenticates inside the token call), and so are the control endpoints of a test fake.
    auth: () => true,
    initial: fresh,
    routes: (state, request): FakeReply => {
      const { method, path, query } = request;
      const form = (request.body ?? {}) as Record<string, string>;
      if (method === 'GET' && path === '/.well-known/openid-configuration') {
        const base = origin();
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/o/oauth2/v2/auth`,
          device_authorization_endpoint: `${base}/device/code`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/v1/userinfo`,
          revocation_endpoint: `${base}/revoke`,
          jwks_uri: `${base}/oauth2/v3/certs`,
          response_types_supported: ['code', 'token', 'id_token', 'code token', 'code id_token', 'token id_token', 'code token id_token', 'none'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email', 'profile'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          claims_supported: ['aud', 'email', 'email_verified', 'exp', 'family_name', 'given_name', 'iat', 'iss', 'name', 'picture', 'sub', 'hd', 'nonce'],
          code_challenge_methods_supported: ['plain', 'S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        });
      }
      if (method === 'GET' && path === '/oauth2/v3/certs') return json(200, { keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
      if (method === 'GET' && path === '/o/oauth2/v2/auth') {
        const checked = checkAuth(state, query);
        if ('page' in checked) return checked.page;
        // An invalid request never shows the chooser: it goes back to the client with the error, like Google's.
        if (checked.error) return grant(state, query, '');
        const hint = query.get('login_hint');
        if (query.get('auto') === '1' && hint) return grant(state, query, hint);
        return authPage(state, query);
      }
      if (method === 'POST' && path === '/o/oauth2/v2/auth/select') {
        const q = new URLSearchParams(Object.entries(form).filter(([k]) => !['email', 'deny'].includes(k)));
        return grant(state, q, form.deny ? '' : (form.email ?? ''));
      }
      if (method === 'POST' && path === '/token') return token(state, request);
      if (method === 'GET' && path === '/v1/userinfo') {
        const email = state.accessTokens[/^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? ''];
        const account = state.accounts.find((a) => a.email === email);
        if (!account) return json(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
        return json(200, { sub: subjectOf(account.email), name: account.name, email: account.email, email_verified: account.emailVerified, ...(account.hd && { hd: account.hd }) });
      }
      if (method === 'POST' && path === '/_fake/accounts') {
        const body = (request.body ?? {}) as { email?: unknown; name?: unknown; hd?: unknown; email_verified?: unknown };
        if (typeof body.email !== 'string' || !body.email.includes('@')) return json(400, { error: 'email is required' });
        const hd = body.hd === null ? undefined : typeof body.hd === 'string' ? body.hd : domainOf(body.email);
        const account: OidcAccount = { email: body.email, name: typeof body.name === 'string' ? body.name : body.email.split('@')[0], ...(hd && { hd }), emailVerified: body.email_verified !== false };
        state.accounts = [...state.accounts.filter((a) => a.email !== account.email), account];
        return json(200, account);
      }
      if (method === 'POST' && path === '/_fake/clients') {
        const body = (request.body ?? {}) as { client_id?: unknown; client_secret?: unknown; redirect_uris?: unknown };
        if (typeof body.client_id !== 'string' || typeof body.client_secret !== 'string' || !Array.isArray(body.redirect_uris)) return json(400, { error: 'client_id, client_secret and redirect_uris are required' });
        const entry = { clientId: body.client_id, clientSecret: body.client_secret, redirectUris: body.redirect_uris.map(String) };
        state.clients = [...state.clients.filter((c) => c.clientId !== entry.clientId), entry];
        return json(200, { ok: true });
      }
      if (method === 'POST' && path === '/_fake/next-error') {
        const body = (request.body ?? {}) as { mode?: unknown; times?: unknown };
        if (!OIDC_ERROR_MODES.includes(body.mode as OidcErrorMode)) return json(400, { error: `mode must be one of ${OIDC_ERROR_MODES.join(', ')}` });
        const times = Math.max(1, Math.min(20, Number(body.times) || 1));
        for (let i = 0; i < times; i += 1) state.nextErrors.push(body.mode as OidcErrorMode);
        return json(200, { ok: true, queued: state.nextErrors.length });
      }
      if (method === 'GET' && path === '/_fake/log') return json(200, state.log);
      return json(404, { error: 'not_found' });
    },
  });

  return {
    ...fake,
    // The wrapped fake's getter must stay live: spread would copy its current value.
    get url() {
      return fake.url;
    },
    clientId,
    clientSecret,
  };
}

export type FakeGoogleOidc = ReturnType<typeof fakeGoogleOidc>;
