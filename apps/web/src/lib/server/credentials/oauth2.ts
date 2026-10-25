/**
 * The OAuth2 client behind OAuth2 credentials (the core `oAuth2Api` type and every type that extends it): the
 * authorization URL with PKCE, the signed state the public callback verifies, the token endpoint calls
 * (authorization code, refresh token, client credentials) and what is stored of a token.
 *
 * State: `<payload>.<signature>`, base64url JSON `{ c: credentialId, n: nonce, r: redirectUri, e: expiresAt }` signed
 * with HMAC-SHA256 under a key derived from the vault's key. The PKCE verifier is never stored or sent through the
 * browser: it is an HMAC of the nonce under another derived key, so only this host can recompute it. The callback
 * also wants a cookie named after the nonce, set by the authorize route, which ties the flow to the browser that
 * started it (login CSRF).
 *
 * Pure apart from `fetch`: the vault (./vault) stores tokens and refreshes them, the routes run the flow.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JsonObject, JsonValue } from '@landflow/protocol';
import type { OAuth2GrantType, OAuth2Status } from '../../shared/oauth2';

/** Credential data fields the host owns. The API never accepts or returns them; nodes get `nodeTokenFields` instead. */
export const TOKEN_FIELD = 'oauthTokenData';
export const ACCOUNT_FIELD = 'oauthAccount';
export const ERROR_FIELD = 'oauthError';
export const RESERVED_FIELDS: readonly string[] = [TOKEN_FIELD, ACCOUNT_FIELD, ERROR_FIELD];

/** How long a Connect flow may take, from opening the provider's page to the callback. */
export const STATE_TTL_MS = 10 * 60_000;
/** A token this close to its expiry is refreshed before a node gets it. */
export const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 20_000;

/** The cookie the authorize route sets for one flow and the callback requires (Path=/api/oauth2/callback). */
export const stateCookieName = (nonce: string) => `landflow_oauth2_${nonce}`;

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  authUrl: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  authQueryParameters: string;
  /** How the client authenticates at the token endpoint: HTTP Basic (RFC 6749 §2.3.1) or client_id/client_secret in the body. */
  authentication: 'header' | 'body';
  userInfoUrl: string;
}

/**
 * A token as stored in the credential (encrypted with the rest of its data): the provider's response (`token_type`,
 * `refresh_token`, `scope`, `id_token`…) plus `expires_at` (ISO, from `expires_in` when it was issued) and `obtained_at`.
 */
export interface StoredToken extends JsonObject {
  access_token: string;
  /** When this access token was obtained (ISO). */
  obtained_at: string;
}

/** A string field of a token ('' when absent). */
export const tokenField = (token: StoredToken | undefined, key: string): string => text(token?.[key]);

export class OAuth2Error extends Error {
  constructor(
    message: string,
    /** The provider's `error` code (`invalid_grant`, `invalid_client`…), when it sent one. */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuth2Error';
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const GRANTS: OAuth2GrantType[] = ['pkce', 'authorizationCode', 'clientCredentials'];

/** The flow settings of an OAuth2 credential's data (type defaults already applied). */
export function oauth2Config(data: JsonObject): OAuth2Config {
  const grant = text(data.grantType) as OAuth2GrantType;
  return {
    grantType: GRANTS.includes(grant) ? grant : 'pkce',
    authUrl: text(data.authUrl),
    accessTokenUrl: text(data.accessTokenUrl),
    clientId: text(data.clientId),
    clientSecret: text(data.clientSecret),
    scope: text(data.scope),
    authQueryParameters: text(data.authQueryParameters),
    authentication: text(data.authentication) === 'body' ? 'body' : 'header',
    userInfoUrl: text(data.userInfoUrl),
  };
}

function httpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuth2Error(value ? `The ${label} "${value}" is not a URL` : `Enter the ${label}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OAuth2Error(`The ${label} must be an http(s) URL`);
  return url;
}

// ---------------------------------------------------------------------------
// State and PKCE
// ---------------------------------------------------------------------------

const b64url = (buffer: Buffer) => buffer.toString('base64url');

export interface StatePayload {
  /** Credential id. */
  c: string;
  /** Nonce: names the flow's cookie and derives the PKCE verifier. */
  n: string;
  /** The redirect URI sent to the provider (the token request must repeat it). */
  r: string;
  /** Expiry, ms since the epoch. */
  e: number;
}

export const newNonce = () => b64url(randomBytes(18));

export function signState(key: Buffer, payload: StatePayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}

/** The payload of a state this host signed and that hasn't expired; throws an OAuth2Error otherwise. */
export function verifyState(key: Buffer, state: string | null | undefined, now = Date.now()): StatePayload {
  const [body, signature, extra] = (state ?? '').split('.');
  if (!body || !signature || extra !== undefined) throw new OAuth2Error('The sign-in response has no valid state: start again from the credential’s Connect button');
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuth2Error('The sign-in response’s state was not issued by this Landflow host');
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new OAuth2Error('The sign-in response’s state is unreadable');
  }
  if (typeof payload.c !== 'string' || typeof payload.n !== 'string' || typeof payload.r !== 'string' || typeof payload.e !== 'number') {
    throw new OAuth2Error('The sign-in response’s state is incomplete');
  }
  if (payload.e < now) throw new OAuth2Error('The sign-in took too long (more than 10 minutes): connect again');
  return payload;
}

/** RFC 7636 code verifier for a flow: 43 characters, recomputable from the nonce with the host's key only. */
export function pkceVerifier(key: Buffer, nonce: string): string {
  return b64url(createHmac('sha256', key).update(`pkce:${nonce}`).digest());
}

/** The S256 code challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

/** The provider's consent page for a flow: response_type=code, the client, scope, state, PKCE, plus the extra query parameters. */
export function authorizationUrl(config: OAuth2Config, options: { redirectUri: string; state: string; codeChallenge?: string }): string {
  if (config.grantType === 'clientCredentials') throw new OAuth2Error('The client credentials grant has no sign-in page: use Get token');
  if (!config.clientId) throw new OAuth2Error('Enter the client ID');
  const url = httpUrl(config.authUrl, 'authorization URL');
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', config.clientId);
  params.set('redirect_uri', options.redirectUri);
  if (config.scope) params.set('scope', config.scope);
  params.set('state', options.state);
  if (options.codeChallenge) {
    params.set('code_challenge', options.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  // n8n's "Auth URI Query Parameters": a query string (a leading ? or & is fine).
  for (const [key, value] of new URLSearchParams(config.authQueryParameters.replace(/^[?&]/, ''))) if (key) params.set(key, value);
  return url.toString();
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');

/** POST to the token endpoint with the client's authentication; the answer must carry an access token. */
export async function requestToken(config: OAuth2Config, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<JsonObject> {
  const url = httpUrl(config.accessTokenUrl, 'access token URL');
  if (!config.clientId) throw new OAuth2Error('Enter the client ID');
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (config.authentication === 'header' && config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString('base64')}`;
  } else {
    // Public clients (PKCE without a secret) identify themselves in the body.
    body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), redirect: 'error' });
  } catch (error) {
    throw new OAuth2Error(`Cannot reach the token endpoint ${url.origin}: ${(error as Error).message}`);
  }
  const raw = await response.text();
  let parsed: JsonObject = {};
  try {
    parsed = raw.trim().startsWith('{') ? (JSON.parse(raw) as JsonObject) : (Object.fromEntries(new URLSearchParams(raw)) as JsonObject);
  } catch {
    // Neither JSON nor a form: reported below.
  }
  // Slack answers 200 with { ok: false, error }.
  const code = text(parsed.error) || (parsed.ok === false ? 'error' : '');
  if (!response.ok || code) {
    const description = text(parsed.error_description) || (code ? '' : raw.slice(0, 200).trim());
    throw new OAuth2Error(`The token endpoint answered ${response.status}${code ? ` ${code}` : ''}${description ? `: ${description}` : ''}`, code || undefined, response.status);
  }
  if (!text(parsed.access_token)) throw new OAuth2Error('The token endpoint’s answer has no access_token', undefined, response.status);
  return parsed;
}

export function exchangeCode(config: OAuth2Config, options: { code: string; redirectUri: string; codeVerifier?: string }, fetchImpl?: typeof fetch) {
  return requestToken(
    config,
    { grant_type: 'authorization_code', code: options.code, redirect_uri: options.redirectUri, ...(options.codeVerifier && { code_verifier: options.codeVerifier }) },
    fetchImpl,
  );
}

export function refreshAccessToken(config: OAuth2Config, refreshToken: string, fetchImpl?: typeof fetch) {
  return requestToken(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}

export function clientCredentialsToken(config: OAuth2Config, fetchImpl?: typeof fetch) {
  return requestToken(config, { grant_type: 'client_credentials', ...(config.scope && { scope: config.scope }) }, fetchImpl);
}

/**
 * What is stored of a token response: all of it (providers put useful ids in there: Slack's team, Notion's
 * workspace), the expiry as a time, and the previous refresh token when a refresh didn't rotate it.
 */
export function toStoredToken(response: JsonObject, previous?: StoredToken, now = Date.now()): StoredToken {
  const expiresIn = Number(response.expires_in);
  const token: StoredToken = { ...response, access_token: text(response.access_token), obtained_at: new Date(now).toISOString() };
  if (Number.isFinite(expiresIn) && expiresIn > 0) token.expires_at = new Date(now + expiresIn * 1000).toISOString();
  else delete token.expires_at;
  if (!text(token.refresh_token) && tokenField(previous, 'refresh_token')) token.refresh_token = tokenField(previous, 'refresh_token');
  if (!text(token.id_token) && tokenField(previous, 'id_token')) token.id_token = tokenField(previous, 'id_token');
  return token;
}

/** Whether a token is past (or within `marginMs` of) its expiry. Tokens without an expiry never are. */
export function isExpiring(token: StoredToken | undefined, now = Date.now(), marginMs = EXPIRY_MARGIN_MS): boolean {
  const expiresAt = tokenField(token, 'expires_at');
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at - marginMs <= now;
}

export function storedToken(value: JsonValue | undefined): StoredToken | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.access_token === 'string' && value.access_token ? (value as StoredToken) : undefined;
}

/**
 * What a node gets of the token, next to the credential's other fields: `accessToken` (and n8n's
 * `oauthTokenData.access_token`), its type and expiry. Never the refresh token: refreshing is the host's job.
 */
export function nodeTokenFields(token: StoredToken | undefined): JsonObject {
  if (!token) return {};
  const expiresAt = tokenField(token, 'expires_at');
  return {
    accessToken: token.access_token,
    tokenType: tokenField(token, 'token_type') || 'Bearer',
    ...(expiresAt && { expiresAt }),
    oauthTokenData: { access_token: token.access_token },
  };
}

// ---------------------------------------------------------------------------
// Who is connected
// ---------------------------------------------------------------------------

/** The claims of a JWT, unverified (only to show who signed in: the token came straight from the token endpoint). */
export function jwtClaims(jwt: unknown): JsonObject | undefined {
  const part = typeof jwt === 'string' ? jwt.split('.')[1] : undefined;
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

const IDENTITY_KEYS = ['email', 'preferred_username', 'login', 'username', 'name', 'sub'];

function identity(source: JsonObject | undefined): string | undefined {
  if (!source) return undefined;
  for (const key of IDENTITY_KEYS) if (text(source[key])) return text(source[key]);
  return undefined;
}

const nested = (value: JsonValue | undefined, ...path: string[]): JsonValue | undefined =>
  path.reduce<JsonValue | undefined>((current, key) => (current && typeof current === 'object' && !Array.isArray(current) ? current[key] : undefined), value);

/**
 * "Connected as …": the ID token's user, else the user info endpoint's, else what the token response says (Slack,
 * Notion), else the subject of a JWT access token (client credentials: the service account).
 */
export function accountOf(token: StoredToken, userInfo?: JsonObject): string | undefined {
  return (
    identity(jwtClaims(token.id_token)) ??
    identity(userInfo) ??
    (text(nested(token, 'owner', 'user', 'name')) || text(token.workspace_name) || text(nested(token, 'team', 'name')) || text(nested(token, 'authed_user', 'id')) || undefined) ??
    identity(jwtClaims(token.access_token))
  );
}

/** GET the user info URL with the new token. Best effort: any failure means no account name. */
export async function fetchUserInfo(config: OAuth2Config, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<JsonObject | undefined> {
  if (!config.userInfoUrl) return undefined;
  try {
    const response = await fetchImpl(httpUrl(config.userInfoUrl, 'user info URL'), {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'Landflow' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

/** The connection status the API shows for an OAuth2 credential's data. */
export function oauth2Status(data: JsonObject, now = Date.now()): OAuth2Status {
  const config = oauth2Config(data);
  const token = storedToken(data[TOKEN_FIELD]);
  const account = text(data[ACCOUNT_FIELD]);
  const error = text(data[ERROR_FIELD]);
  const expiresAt = tokenField(token, 'expires_at');
  const scope = tokenField(token, 'scope');
  return {
    grantType: config.grantType,
    connected: Boolean(token),
    ...(account && { account }),
    ...(token && { connectedAt: token.obtained_at }),
    ...(expiresAt && { expiresAt }),
    expired: isExpiring(token, now, 0),
    refreshable: config.grantType === 'clientCredentials' || Boolean(tokenField(token, 'refresh_token')),
    ...(scope && { scope }),
    ...(error && { error }),
  };
}

/** Whether a node's error says the API refused its token (then the host refreshes the token and tries the node once more). */
export function looksUnauthorized(message: string | undefined): boolean {
  return Boolean(message && /\b401\b|\bunauthori[sz]ed\b|invalid[_ ]token|(?:access )?token (?:has )?expired|expired[_ ]token/i.test(message));
}
