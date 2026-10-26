/**
 * Single sign-on with any OpenID Connect provider (Keycloak, Authentik, Entra ID, Google…): the authorization code
 * flow with PKCE (S256), a state and a nonce. Configured with LANDFLOW_OIDC_ISSUER, LANDFLOW_OIDC_CLIENT_ID and
 * LANDFLOW_OIDC_CLIENT_SECRET; the redirect URL to register is `<public URL>/api/auth/oidc/callback`.
 *
 * Users are created on their first sign-in. Their role comes from a claim (LANDFLOW_OIDC_ROLE_CLAIM, default
 * `roles`, a dotted path such as `realm_access.roles` works too) through LANDFLOW_OIDC_ROLE_MAP
 * (`idp-value=admin,other=member`), else LANDFLOW_OIDC_DEFAULT_ROLE (`member`; `none` refuses unmapped users),
 * and is refreshed at every sign-in. The owner's role never changes. An existing user with the same verified email
 * is linked to the SSO identity.
 *
 * ID tokens are verified here (signature against the provider's JWKS, issuer, audience, expiry, nonce) with
 * node:crypto, without a JOSE library.
 *
 * The pending sign-in (PKCE verifier, nonce, where to go next) lives in memory, or in queue mode in Valkey (sealed with
 * the encryption key, 10 minutes, taken once), so the provider may send the browser back to any main.
 */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, constants, type JsonWebKey, type KeyObject } from 'node:crypto';
import { ASSIGNABLE_ROLES, type AssignableRole } from '../../shared/auth';
import { clusterActive, coordinator } from '../cluster/state';
import { singleton } from '../singleton';
import { randomToken } from './passwords';
import { createUser, findUserByEmail, findUserByOidc, setupRequired, updateUser, type UserRecord } from './users';

export const OIDC_STATE_COOKIE = 'landflow_oidc_state';
const STATE_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_S = 120;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  label: string;
  roleClaim: string;
  roleMap: Record<string, AssignableRole>;
  defaultRole: AssignableRole | 'none';
  redirectUrl?: string;
  /** Where to fetch the discovery document when the issuer URL isn't reachable from the host (Docker). */
  discoveryUrl?: string;
}

export function parseRoleMap(text: string | undefined): Record<string, AssignableRole> {
  const map: Record<string, AssignableRole> = {};
  for (const entry of (text ?? '').split(',')) {
    const [value, role] = entry.split(/[=:](?=[^=:]*$)/).map((part) => part?.trim());
    if (value && role && (ASSIGNABLE_ROLES as readonly string[]).includes(role)) map[value] = role as AssignableRole;
  }
  return map;
}

export function oidcConfig(): OidcConfig | undefined {
  const issuer = process.env.LANDFLOW_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  const clientId = process.env.LANDFLOW_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return undefined;
  const defaultRole = process.env.LANDFLOW_OIDC_DEFAULT_ROLE?.trim().toLowerCase();
  return {
    issuer,
    clientId,
    ...(process.env.LANDFLOW_OIDC_CLIENT_SECRET && { clientSecret: process.env.LANDFLOW_OIDC_CLIENT_SECRET }),
    scopes: process.env.LANDFLOW_OIDC_SCOPES?.trim() || 'openid email profile',
    label: process.env.LANDFLOW_OIDC_LABEL?.trim() || 'Sign in with SSO',
    roleClaim: process.env.LANDFLOW_OIDC_ROLE_CLAIM?.trim() || 'roles',
    roleMap: parseRoleMap(process.env.LANDFLOW_OIDC_ROLE_MAP),
    defaultRole: defaultRole === 'none' || defaultRole === 'admin' ? defaultRole : 'member',
    ...(process.env.LANDFLOW_OIDC_REDIRECT_URL?.trim() && { redirectUrl: process.env.LANDFLOW_OIDC_REDIRECT_URL.trim() }),
    ...(process.env.LANDFLOW_OIDC_DISCOVERY_URL?.trim() && { discoveryUrl: process.env.LANDFLOW_OIDC_DISCOVERY_URL.trim() }),
  };
}

export class OidcError extends Error {}

// ---- discovery and keys -----------------------------------------------------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

const caches = () =>
  singleton('oidc-caches', () => ({
    discovery: new Map<string, { doc: Discovery; at: number }>(),
    jwks: new Map<string, { keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>; at: number }>(),
    states: new Map<string, PendingSignIn>(),
  }));

interface PendingSignIn {
  verifier: string;
  nonce: string;
  next: string;
  redirectUri: string;
  at: number;
}

/** Queue mode: the Valkey key of a pending sign-in (the state itself isn't stored, only its hash). */
const pendingKey = (state: string) => `oidc:state:${createHash('sha256').update(state).digest('hex')}`;

/** Keep a pending sign-in until the provider sends the browser back (to this main, or in queue mode to any main). */
async function putPending(state: string, entry: PendingSignIn): Promise<void> {
  if (clusterActive()) {
    const { credentials } = await import('../credentials/vault');
    await coordinator().set(pendingKey(state), credentials.sealSecret(JSON.stringify(entry)), STATE_TTL_MS);
    return;
  }
  const states = caches().states;
  for (const [key, saved] of states) if (entry.at - saved.at > STATE_TTL_MS) states.delete(key);
  states.set(state, entry);
}

/** The pending sign-in of `state`, at most once (a second callback with the same state finds nothing). */
async function takePending(state: string): Promise<PendingSignIn | undefined> {
  if (clusterActive()) {
    const key = pendingKey(state);
    const sealed = await coordinator().get(key);
    // Only one main may take it.
    if (!sealed || !(await coordinator().deleteIfValue(key, sealed))) return undefined;
    try {
      const { credentials } = await import('../credentials/vault');
      return JSON.parse(credentials.openSecret(sealed)) as PendingSignIn;
    } catch {
      return undefined;
    }
  }
  const states = caches().states;
  const entry = states.get(state);
  states.delete(state);
  return entry;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', ...init?.headers } });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new OidcError(`${new URL(url).host} answered ${response.status} with something other than JSON`);
  }
  if (!response.ok) {
    const detail = (body as { error_description?: string; error?: string } | undefined)?.error_description ?? (body as { error?: string } | undefined)?.error;
    throw new OidcError(`${new URL(url).pathname} answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return body as T;
}

export async function discover(config: OidcConfig, force = false): Promise<Discovery> {
  const cache = caches().discovery;
  const hit = cache.get(config.issuer);
  if (hit && !force && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const doc = await getJson<Discovery>(config.discoveryUrl ?? `${config.issuer}/.well-known/openid-configuration`);
  if (!doc?.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new OidcError('The provider’s discovery document lacks endpoints');
  if (doc.issuer.replace(/\/+$/, '') !== config.issuer) throw new OidcError(`The provider says its issuer is ${doc.issuer}, not ${config.issuer}`);
  cache.set(config.issuer, { doc, at: Date.now() });
  return doc;
}

async function signingKey(jwksUri: string, kid: string | undefined, alg: string): Promise<KeyObject> {
  const cache = caches().jwks;
  const pick = (keys: Array<JsonWebKey & { kid?: string; use?: string }>) => keys.find((k) => (kid ? k.kid === kid : true) && (k.use ?? 'sig') === 'sig' && keyFits(k, alg));
  let entry = cache.get(jwksUri);
  let key = entry && pick(entry.keys);
  // Unknown key id: the provider may have rotated its keys (refetch at most every 30 s).
  if (!key && (!entry || Date.now() - entry.at > 30_000)) {
    const fetched = await getJson<{ keys: Array<JsonWebKey & { kid?: string }> }>(jwksUri);
    entry = { keys: fetched.keys ?? [], at: Date.now() };
    cache.set(jwksUri, entry);
    key = pick(entry.keys);
  }
  if (!key) throw new OidcError(`No signing key ${kid ?? ''} for ${alg} in the provider’s JWKS`);
  return createPublicKey({ key, format: 'jwk' });
}

function keyFits(key: JsonWebKey, alg: string): boolean {
  if (alg.startsWith('RS') || alg.startsWith('PS')) return key.kty === 'RSA';
  if (alg.startsWith('ES')) return key.kty === 'EC';
  if (alg === 'EdDSA') return key.kty === 'OKP';
  return false;
}

// ---- ID tokens ----------------------------------------------------------------

export type Claims = Record<string, unknown> & { iss?: string; sub?: string; aud?: string | string[]; exp?: number; iat?: number; nonce?: string; azp?: string };

const base64urlJson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** Verify an ID token's signature and claims; returns its claims. */
export async function verifyIdToken(token: string, config: OidcConfig, discovery: Pick<Discovery, 'jwks_uri'>, nonce: string, now = Date.now()): Promise<Claims> {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new OidcError('The ID token is not a JWT');
  const header = base64urlJson(headerPart) as { alg?: string; kid?: string };
  const claims = base64urlJson(payloadPart) as Claims;
  const data = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, 'base64url');
  const alg = String(header.alg ?? '');
  let valid: boolean;
  if (/^HS(256|384|512)$/.test(alg)) {
    if (!config.clientSecret) throw new OidcError(`The ID token is signed with ${alg}, which needs a client secret`);
    const expected = createHmac(`sha${alg.slice(2)}`, config.clientSecret).update(data).digest();
    valid = expected.length === signature.length && timingSafeEqual(expected, signature);
  } else if (/^(RS|PS|ES)(256|384|512)$/.test(alg) || alg === 'EdDSA') {
    const key = await signingKey(discovery.jwks_uri, header.kid, alg);
    const hash = alg === 'EdDSA' ? null : `sha${alg.slice(2)}`;
    const options = alg.startsWith('PS')
      ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
      : alg.startsWith('ES')
        ? { key, dsaEncoding: 'ieee-p1363' as const }
        : key;
    valid = verifySignature(hash, data, options, signature);
  } else {
    throw new OidcError(`Unsupported ID token algorithm ${alg || 'none'}`);
  }
  if (!valid) throw new OidcError('The ID token’s signature is invalid');

  const seconds = Math.floor(now / 1000);
  if (String(claims.iss ?? '').replace(/\/+$/, '') !== config.issuer) throw new OidcError('The ID token is from another issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.clientId)) throw new OidcError('The ID token is for another client');
  if (audiences.length > 1 && claims.azp && claims.azp !== config.clientId) throw new OidcError('The ID token was issued to another party');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < seconds) throw new OidcError('The ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > seconds) throw new OidcError('The ID token is from the future');
  if (claims.nonce !== nonce) throw new OidcError('The ID token’s nonce doesn’t match this sign-in');
  if (!claims.sub) throw new OidcError('The ID token has no subject');
  return claims;
}

// ---- the flow -------------------------------------------------------------------

/** Where the provider sends the browser back. */
export function redirectUri(config: OidcConfig, origin: string): string {
  return config.redirectUrl ?? `${origin}/api/auth/oidc/callback`;
}

/** Step 1: the provider's authorization URL, and the state to bind to the browser (cookie). */
export async function beginLogin(config: OidcConfig, origin: string, next: string): Promise<{ url: string; state: string }> {
  const discovery = await discover(config);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const callback = redirectUri(config, origin);
  await putPending(state, { verifier, nonce, next, redirectUri: callback, at: Date.now() });
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

/** The value at a dotted path of the claims (`realm_access.roles`). */
function claimAt(claims: Claims, path: string): unknown {
  if (path in claims) return claims[path];
  return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), claims);
}

/** The highest role the claim maps to, if any. */
export function mappedRole(claims: Claims, config: Pick<OidcConfig, 'roleClaim' | 'roleMap'>): AssignableRole | undefined {
  const raw = claimAt(claims, config.roleClaim);
  const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []).map(String);
  const roles = values.map((value) => config.roleMap[value]).filter(Boolean);
  return roles.includes('admin') ? 'admin' : roles.includes('member') ? 'member' : undefined;
}

/** Step 2: exchange the code, verify the ID token and find or create the user. */
export async function completeLogin(config: OidcConfig, params: { code?: string | null; state?: string | null; cookieState?: string }): Promise<{ user: UserRecord; next: string }> {
  const { code, state } = params;
  if (!code || !state) throw new OidcError('The provider sent no authorization code');
  // Started in another browser: the pending sign-in stays for the browser that started it.
  if (!params.cookieState || params.cookieState !== state) throw new OidcError('This sign-in expired or was started in another browser. Try again.');
  const entry = await takePending(state);
  if (!entry || Date.now() - entry.at > STATE_TTL_MS) throw new OidcError('This sign-in expired or was started in another browser. Try again.');
  if (setupRequired()) throw new OidcError('Finish the owner setup before signing in with SSO');

  const discovery = await discover(config);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier, client_id: config.clientId });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (config.clientSecret) {
    const methods = discovery.token_endpoint_auth_methods_supported;
    if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) body.set('client_secret', config.clientSecret);
    else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`;
  }
  const tokens = await getJson<{ id_token?: string; access_token?: string }>(discovery.token_endpoint, { method: 'POST', headers, body });
  if (!tokens.id_token) throw new OidcError('The provider returned no ID token (is the `openid` scope allowed?)');
  let claims = await verifyIdToken(tokens.id_token, config, discovery, entry.nonce);
  if ((!claims.email || claimAt(claims, config.roleClaim) === undefined) && discovery.userinfo_endpoint && tokens.access_token) {
    const info = await getJson<Claims>(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } }).catch(() => undefined);
    if (info && info.sub === claims.sub) claims = { ...info, ...claims, ...(claims.email ? {} : { email: info.email, email_verified: info.email_verified }) };
  }
  return { user: await signInUser(config, claims), next: entry.next };
}

/** Find (by SSO identity, then verified email) or create the user of these claims, with their mapped role. */
export async function signInUser(config: OidcConfig, claims: Claims): Promise<UserRecord> {
  const subject = String(claims.sub);
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const name = String(claims.name ?? claims.preferred_username ?? claims.given_name ?? email.split('@')[0] ?? '').trim();
  const role = mappedRole(claims, config);

  let user = findUserByOidc(config.issuer, subject);
  if (!user && email) {
    const byEmail = findUserByEmail(email);
    if (byEmail) {
      if (claims.email_verified === false) throw new OidcError(`${email} already has a Landflow account, and the provider hasn’t verified that address`);
      user = updateUser(byEmail.id, { oidcIssuer: config.issuer, oidcSubject: subject });
    }
  }
  if (user) {
    const patch: Parameters<typeof updateUser>[1] = {};
    if (role && user.role !== 'owner' && user.role !== role) patch.role = role;
    if (!user.name && name) patch.name = name;
    return Object.keys(patch).length ? updateUser(user.id, patch) : user;
  }
  if (!email) throw new OidcError('The provider didn’t share an email address (add the `email` scope)');
  const assigned = role ?? (config.defaultRole === 'none' ? undefined : config.defaultRole);
  if (!assigned) throw new OidcError('Your account has no Landflow role at the identity provider. Ask an admin for access.');
  return createUser({ email, name: name || email, role: assigned, oidc: { issuer: config.issuer, subject } });
}

/** Tests. */
export function resetOidcCaches() {
  const c = caches();
  c.discovery.clear();
  c.jwks.clear();
  c.states.clear();
}
