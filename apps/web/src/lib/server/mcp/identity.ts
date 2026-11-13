/**
 * Who is calling an MCP endpoint of the host (docs/transports.md "Sign-in and identity", docs/protocol.md §15.3):
 *
 * 1. **Through the bundled gateway**: `x-landflow-gateway` equals LANDFLOW_MCP_GATEWAY_SECRET (constant time), so the
 *    `x-landflow-caller-iss` / `-sub` headers the gateway set from the validated token are trusted (and `-jti` when its
 *    transformation forwards it). The issuer and subject map to a Landflow user: the instance's identity provider
 *    (LANDFLOW_OIDC_ISSUER, Keycloak in dev) through the OIDC identity link of SSO sign-in, or this host (a
 *    Landflow-issued MCP token, ./tokens). No token at the gateway arrives as `anonymous`: a caller with no grants.
 *    Without a configured secret the gateway headers are ignored, so a forged `x-landflow-caller-*` never counts.
 * 2. **Directly** with `Authorization: Bearer`: a Landflow-issued MCP token (verified against this host's keys, `jti`
 *    checked for revocation), an access token of the identity provider (verified against the issuer's JWKS from its
 *    discovery document, audience checked), or a Landflow API key (`lf_…`).
 * 3. A **session cookie**, for the UI's own calls (the tool browser in Settings → MCP).
 *
 * Anything else is `McpAuthError` 401 with `WWW-Authenticate: Bearer resource_metadata="…"` pointing at the resource's
 * protected resource metadata (RFC 9728, /.well-known/oauth-protected-resource/…), which lists the identity provider
 * and this host as authorization servers. `canListTool` / `canCallTool` apply the grants (./grants).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { can, type Role } from '../../shared/auth';
import { API_KEY_PREFIX, SESSION_COOKIE } from '../../shared/auth-paths';
import { verifyApiKey } from '../auth/api-keys';
import { looksLikeDebugToken } from '../auth/debug-tokens';
import { readCookie } from '../auth/cookies';
import { sameSecret } from '../auth/passwords';
import { sessionUser } from '../auth/sessions';
import { findUserByOidc, type UserRecord } from '../auth/users';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { effectiveTool, effectiveTools, effectiveTrigger, effectiveTriggers, pluginTools, type EffectiveTool, type EffectiveTrigger } from './grants';
import { gatewayPublicUrl, instanceUrl, looksLikeLandflowMcpToken, mcpResourceRoot, parseTokenScopes, resolveTokenSubject, unverifiedClaims, verifyMcpToken } from './tokens';
import { HttpError } from '../errors';

export interface McpCaller {
  kind: 'gateway' | 'token' | 'idp' | 'apiKey' | 'session' | 'anonymous';
  issuer?: string;
  subject: string;
  userId?: string;
  role?: string;
  /** Token scopes (lib/shared/mcp.ts); everything for sessions, API keys and identity provider tokens. */
  scopes: string[];
  tokenId?: string;
  /** The project a Landflow MCP token is scoped to (the instance server then shows only that project's workflows). */
  projectId?: string;
  viaGateway: boolean;
}

export class McpAuthError extends HttpError {
  declare readonly status: 401 | 403;
  readonly wwwAuthenticate?: string;
  constructor(message: string, status: 401 | 403 = 401, wwwAuthenticate?: string) {
    super(message, status);
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export const GATEWAY_SECRET_HEADER = 'x-landflow-gateway';
export const CALLER_ISSUER_HEADER = 'x-landflow-caller-iss';
export const CALLER_SUBJECT_HEADER = 'x-landflow-caller-sub';
export const CALLER_TOKEN_ID_HEADER = 'x-landflow-caller-jti';
/** The subject the gateway sends for a call without a token (`has(jwt.sub) ? jwt.sub : "anonymous"`), or none at all. */
export const ANONYMOUS = 'anonymous';

const ALL_SCOPES = ['tools:list', 'tools:call', 'registry:read'];

// ---- configuration ----------------------------------------------------------------

/** LANDFLOW_MCP_GATEWAY: `bundled` (the agentgateway sidecar, default), `file` (a gateway of its own reading a YAML file) or `off`. */
export function gatewayMode(): 'bundled' | 'file' | 'off' {
  const mode = process.env.LANDFLOW_MCP_GATEWAY?.trim().toLowerCase();
  return mode === 'off' || mode === 'file' ? mode : 'bundled';
}

/** LANDFLOW_MCP_GATEWAY_SECRET, when set (at least 16 characters; shorter values are ignored and logged once). */
export function gatewaySecret(): string | undefined {
  const secret = process.env.LANDFLOW_MCP_GATEWAY_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : undefined;
}

/** The identity provider agents sign in with: the SSO issuer (LANDFLOW_OIDC_ISSUER), without a trailing slash. */
export function identityProviderIssuer(): string | undefined {
  const issuer = process.env.LANDFLOW_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  return issuer || undefined;
}

const normalizeIssuer = (iss: string | undefined) => (iss ?? '').trim().replace(/\/+$/, '');

/** The URL of an MCP resource on this host: a plugin's endpoint, or the MCP root. */
export function mcpResourceUrl(resource: { pluginId?: string; projectId?: string }): string {
  if (resource.projectId) return `${mcpResourceRoot()}/projects/${encodeURIComponent(resource.projectId)}`;
  return resource.pluginId ? `${mcpResourceRoot()}/plugins/${encodeURIComponent(resource.pluginId)}` : mcpResourceRoot();
}

/** The protected resource metadata URL (RFC 9728 §3: `/.well-known/oauth-protected-resource` + the resource's path). */
export function protectedResourceMetadataUrl(resource: { pluginId?: string; projectId?: string }): string {
  const path = new URL(mcpResourceUrl(resource)).pathname;
  return `${instanceUrl()}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The protected resource metadata document (RFC 9728) of an MCP resource: the authorization servers are the identity
 * provider (when configured) and this host (Landflow-issued tokens; its "authorization server" is Settings → MCP).
 */
export function protectedResourceMetadata(resource: { pluginId?: string; projectId?: string }): Record<string, unknown> {
  const idp = identityProviderIssuer();
  return {
    resource: mcpResourceUrl(resource),
    authorization_servers: [...(idp ? [idp] : []), instanceUrl()],
    jwks_uri: `${instanceUrl()}/api/mcp/jwks`,
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: resource.projectId ? `Landflow project ${resource.projectId}` : resource.pluginId ? `Landflow plugin ${resource.pluginId}` : 'Landflow MCP',
    resource_documentation: 'https://github.com/landflow/landflow/blob/main/docs/transports.md',
    mcp_protocol_version: '2025-06-18',
    resource_type: 'mcp-server',
  };
}

/** The audiences a direct bearer token may carry for `resource`: the resource itself, the MCP root, the instance, the gateway. */
export function acceptedAudiences(resource: { pluginId?: string; projectId?: string }): string[] {
  const gateway = gatewayPublicUrl();
  const extra = process.env.LANDFLOW_MCP_IDP_AUDIENCE?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  return [...new Set([mcpResourceUrl(resource), mcpResourceRoot(), instanceUrl(), ...(gateway ? [`${gateway}/mcp`, gateway] : []), ...extra])];
}

const bearerChallenge = (resource: { pluginId?: string; projectId?: string }) => `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;

// ---- the identity provider's tokens -------------------------------------------------

interface IdpDiscovery {
  issuer: string;
  jwks_uri: string;
}

const idpCaches = () =>
  singleton('mcp-idp-caches', () => ({
    discovery: new Map<string, { doc: IdpDiscovery; at: number }>(),
    jwks: new Map<string, JWTVerifyGetKey>(),
  }));

const DISCOVERY_TTL_MS = 10 * 60_000;

/** The issuer's discovery document (LANDFLOW_OIDC_DISCOVERY_URL when the issuer URL isn't reachable from the host). */
async function idpDiscovery(issuer: string): Promise<IdpDiscovery> {
  const cache = idpCaches().discovery;
  const hit = cache.get(issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const url = process.env.LANDFLOW_OIDC_DISCOVERY_URL?.trim() || `${issuer}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new McpAuthError(`The identity provider's discovery document answered ${response.status}`);
  const doc = (await response.json()) as IdpDiscovery;
  if (!doc?.jwks_uri || normalizeIssuer(doc.issuer) !== issuer) throw new McpAuthError('The identity provider’s discovery document doesn’t match the configured issuer');
  cache.set(issuer, { doc, at: Date.now() });
  return doc;
}

function idpKeys(jwksUri: string): JWTVerifyGetKey {
  const cache = idpCaches().jwks;
  let keys = cache.get(jwksUri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
    cache.set(jwksUri, keys);
  }
  return keys;
}

/** Verify an access token of the identity provider: signature (its JWKS), issuer, audience, expiry. */
export async function verifyIdpToken(token: string, issuer: string, audiences: string[]): Promise<JWTPayload> {
  const discovery = await idpDiscovery(issuer);
  try {
    const { payload } = await jwtVerify(token, idpKeys(discovery.jwks_uri), { issuer: [issuer, `${issuer}/`], audience: audiences });
    return payload;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') throw new McpAuthError('The access token has expired');
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && /audience/i.test((error as Error).message)) throw new McpAuthError('The access token is not for this resource (aud)');
    throw new McpAuthError('Invalid access token');
  }
}

/** The last key sets fetched for the gateway, by issuer: kept when the provider can't be reached for a while. */
const gatewayKeyCache = () => singleton('mcp-idp-gateway-jwks', () => new Map<string, { jwks: string; at: number }>());
const GATEWAY_JWKS_TTL_MS = 60_000;

/**
 * The identity provider's current key set as the JSON text agentgateway takes as `jwks` (the gateway sync writes it inline
 * into per-plugin routes, so a gateway restarted while the provider is down still starts, and a rotated key reaches it within
 * a sync tick). Fetched through the discovery document, cached for a minute; when the provider can't be reached the last
 * key set is used, and undefined when there never was one.
 */
export async function identityProviderJwks(issuer = identityProviderIssuer()): Promise<string | undefined> {
  if (!issuer) return undefined;
  const cache = gatewayKeyCache();
  const hit = cache.get(issuer);
  if (hit && Date.now() - hit.at < GATEWAY_JWKS_TTL_MS) return hit.jwks;
  try {
    const { jwks_uri } = await idpDiscovery(issuer);
    const response = await fetch(jwks_uri, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`the key set answered ${response.status}`);
    const body = (await response.json()) as { keys?: unknown[] };
    if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('the key set has no keys');
    const jwks = JSON.stringify({ keys: body.keys });
    cache.set(issuer, { jwks, at: Date.now() });
    return jwks;
  } catch (error) {
    logger.warn('mcp: the identity provider’s keys could not be fetched for the gateway', { issuer, error: (error as Error).message });
    return hit?.jwks;
  }
}

/** Forget cached discovery documents and key sets (tests). */
export function resetIdentityCaches() {
  idpCaches().discovery.clear();
  idpCaches().jwks.clear();
  gatewayKeyCache().clear();
}

// ---- resolving callers ---------------------------------------------------------------

const userCaller = (kind: McpCaller['kind'], user: UserRecord, extra: Partial<McpCaller> = {}): McpCaller => ({
  kind,
  subject: user.id,
  userId: user.id,
  role: user.role,
  scopes: ALL_SCOPES,
  viaGateway: false,
  ...extra,
});

/** Map an (issuer, subject) pair the gateway validated to a Landflow user, or an anonymous caller. */
function gatewayCaller(issuer: string | undefined, subject: string | undefined, jti: string | undefined): McpCaller {
  const iss = normalizeIssuer(issuer);
  const anonymous: McpCaller = { kind: 'gateway', subject: ANONYMOUS, scopes: [], viaGateway: true, ...(iss && { issuer: iss }) };
  if (!subject || subject === ANONYMOUS || !iss) return anonymous;
  if (iss === instanceUrl()) {
    const found = resolveTokenSubject(subject, jti);
    if (!found) return { ...anonymous, subject };
    return userCaller('gateway', found.user, { issuer: iss, viaGateway: true, scopes: found.record?.scopes ?? ALL_SCOPES, ...(found.record && { tokenId: found.record.id }), ...(found.record?.projectId && { projectId: found.record.projectId }) });
  }
  const idp = identityProviderIssuer();
  if (idp && iss === idp) {
    const user = findUserByOidc(idp, subject) ?? findUserByOidc(`${idp}/`, subject);
    if (user && !user.disabledAt) return userCaller('gateway', user, { issuer: iss, viaGateway: true });
  }
  return { ...anonymous, subject };
}

function bearerOf(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1];
}

/**
 * Who is calling `resource`. Throws McpAuthError (401 with a bearer challenge; 403 for a caller that is known but
 * refused, such as a deactivated user). Never throws for an anonymous gateway call: that caller just has no grants.
 */
export async function authenticateMcpRequest(request: Request, resource: { pluginId: string; projectId?: string }): Promise<McpCaller> {
  const challenge = bearerChallenge(resource);

  // 1. The gateway: the secret, then the identity it validated.
  const secret = gatewaySecret();
  const presented = request.headers.get(GATEWAY_SECRET_HEADER);
  if (presented !== null) {
    if (!secret) throw new McpAuthError('This host has no gateway secret (LANDFLOW_MCP_GATEWAY_SECRET), so gateway calls are refused', 401, challenge);
    if (!sameSecret(presented, secret)) throw new McpAuthError('Wrong gateway secret', 401, challenge);
    return gatewayCaller(request.headers.get(CALLER_ISSUER_HEADER) ?? undefined, request.headers.get(CALLER_SUBJECT_HEADER)?.trim() || undefined, request.headers.get(CALLER_TOKEN_ID_HEADER)?.trim() || undefined);
  }

  // 2. A bearer token: an API key, a Landflow-issued MCP token, or the identity provider's access token.
  const bearer = bearerOf(request);
  if (bearer) {
    // A debug token reads one execution through /api/mcp and does nothing else (docs/specs/19-debug-token.md).
    if (looksLikeDebugToken(bearer)) throw new McpAuthError('A debug token works only for explain_failure, get_run_trace and get_execution at /api/mcp', 403, challenge);
    if (bearer.startsWith(API_KEY_PREFIX)) {
      const checked = verifyApiKey(bearer);
      if (!checked.ok) throw new McpAuthError(checked.reason === 'expired' ? 'This API key has expired' : 'Invalid API key', 401, challenge);
      return userCaller('apiKey', checked.user, { issuer: instanceUrl() });
    }
    const claims = unverifiedClaims(bearer);
    if (!claims) throw new McpAuthError('Send a Landflow MCP token, an access token of the identity provider, or an API key as “Authorization: Bearer …”', 401, challenge);
    if (looksLikeLandflowMcpToken(bearer)) {
      const checked = await verifyMcpToken(bearer, { audiences: acceptedAudiences(resource) });
      if (!checked.ok) {
        const reasons: Record<typeof checked.reason, string> = { invalid: 'Invalid MCP token', expired: 'This MCP token has expired', revoked: 'This MCP token was revoked', audience: 'This MCP token is not for this resource (aud)', user: 'The token’s user is deactivated' };
        throw new McpAuthError(reasons[checked.reason], checked.reason === 'user' ? 403 : 401, challenge);
      }
      return userCaller('token', checked.user, { issuer: instanceUrl(), scopes: parseTokenScopes(checked.claims.scope), tokenId: checked.record.id, ...(checked.record.projectId && { projectId: checked.record.projectId }) });
    }
    const idp = identityProviderIssuer();
    if (idp && normalizeIssuer(claims.iss) === idp) {
      let payload: JWTPayload;
      try {
        payload = await verifyIdpToken(bearer, idp, acceptedAudiences(resource));
      } catch (error) {
        if (error instanceof McpAuthError) throw new McpAuthError(error.message, error.status, challenge);
        throw error;
      }
      const user = payload.sub ? (findUserByOidc(idp, payload.sub) ?? findUserByOidc(`${idp}/`, payload.sub)) : undefined;
      if (!user) throw new McpAuthError('This identity has not signed in to Landflow yet: sign in once through single sign-on first', 403, challenge);
      if (user.disabledAt) throw new McpAuthError('This account is deactivated', 403, challenge);
      return userCaller('idp', user, { issuer: idp, subject: payload.sub ?? user.id });
    }
    throw new McpAuthError(idp ? `Tokens from ${claims.iss ?? 'an unknown issuer'} are not accepted here: sign in at ${idp} or use a Landflow MCP token` : 'Tokens from other issuers are not accepted here: use a Landflow MCP token (Settings → MCP)', 401, challenge);
  }

  // 3. The UI's own calls.
  const found = sessionUser(readCookie(request, SESSION_COOKIE));
  if (found) return userCaller('session', found.user, { issuer: instanceUrl() });

  throw new McpAuthError('Sign in, or send a Landflow MCP token, an access token of the identity provider, or an API key as “Authorization: Bearer …”', 401, challenge);
}

// ---- grants ----------------------------------------------------------------------------

const subjectsOfCaller = (caller: McpCaller) => ({ userId: caller.userId, role: caller.role as Role | undefined, tokenId: caller.tokenId });

/** Owners and admins browsing from the UI (a session or an API key, not an agent) see every tool, to write grants. */
function browsesEverything(caller: McpCaller): boolean {
  return (caller.kind === 'session' || caller.kind === 'apiKey') && can({ role: caller.role as Role }, 'mcp:manage');
}

/** Whether `tools/list` on `pluginId` shows `toolName` to `caller`. */
export function canListTool(caller: McpCaller, pluginId: string, toolName: string): boolean {
  if (!caller.scopes.includes('tools:list') && !caller.scopes.includes('tools:call')) return false;
  if (browsesEverything(caller)) return pluginTools(pluginId).some((t) => t.name === toolName);
  return Boolean(effectiveTool(subjectsOfCaller(caller), pluginId, toolName));
}

/** Whether `caller` may call `toolName` on `pluginId`: a grant must cover it (admins included), and the token's scopes allow calls. */
export function canCallTool(caller: McpCaller, pluginId: string, toolName: string): boolean {
  if (!caller.scopes.includes('tools:call')) return false;
  return Boolean(effectiveTool(subjectsOfCaller(caller), pluginId, toolName));
}

/** The tools `caller` may list on `pluginId`, with the credentials their grants bind (for the per-plugin endpoints). */
export function listableTools(caller: McpCaller, pluginId: string): EffectiveTool[] {
  if (!caller.scopes.includes('tools:list') && !caller.scopes.includes('tools:call')) return [];
  if (browsesEverything(caller)) return pluginTools(pluginId).map((tool) => ({ tool, grants: [], credentials: {} }));
  return effectiveTools(subjectsOfCaller(caller), pluginId);
}

/** The grant-resolved tool for a call (its credentials, approval requirement), or undefined when `caller` may not call it. */
export function callableTool(caller: McpCaller, pluginId: string, toolName: string): EffectiveTool | undefined {
  if (!caller.scopes.includes('tools:call')) return undefined;
  return effectiveTool(subjectsOfCaller(caller), pluginId, toolName);
}

/** The trigger resources `caller` may list and read on `pluginId` (a grant must cover each; there is no browse-everything for subscriptions). */
export function listableTriggers(caller: McpCaller, pluginId: string): EffectiveTrigger[] {
  if (!caller.scopes.includes('tools:call')) return [];
  return effectiveTriggers(subjectsOfCaller(caller), pluginId);
}

/** The grant-resolved trigger for a subscription or read, or undefined when `caller` may not use it. */
export function callableTrigger(caller: McpCaller, pluginId: string, name: string): EffectiveTrigger | undefined {
  if (!caller.scopes.includes('tools:call')) return undefined;
  return effectiveTrigger(subjectsOfCaller(caller), pluginId, name);
}

/** Whether `caller` may read the catalog (server.json, the registry API, Server Cards): any known caller with the scope. */
export function canReadRegistry(caller: McpCaller): boolean {
  return caller.kind !== 'anonymous' && caller.subject !== ANONYMOUS && caller.scopes.includes('registry:read');
}

/** The HTTP response for an McpAuthError, as MCP clients expect (a JSON-RPC error body and the bearer challenge). */
export function mcpAuthErrorResponse(error: McpAuthError): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: error.status === 403 ? -32003 : -32001, message: error.message }, id: null }), {
    status: error.status,
    headers: { 'content-type': 'application/json', ...(error.wwwAuthenticate && { 'www-authenticate': error.wwwAuthenticate }) },
  });
}

/** Who may read the catalog (the registry API, Server Cards), or the 401/403 response to send instead. */
export async function registryCaller(request: Request): Promise<{ ok: true; caller: McpCaller } | { ok: false; response: Response }> {
  try {
    // The catalog is the MCP root's resource, so the bearer challenge points at the root's metadata (an empty plugin id).
    const caller = await authenticateMcpRequest(request, { pluginId: '' });
    if (!canReadRegistry(caller)) return { ok: false, response: mcpAuthErrorResponse(new McpAuthError('This caller may not read the catalog', 403)) };
    return { ok: true, caller };
  } catch (caught) {
    if (caught instanceof McpAuthError) return { ok: false, response: mcpAuthErrorResponse(caught) };
    throw caught;
  }
}
