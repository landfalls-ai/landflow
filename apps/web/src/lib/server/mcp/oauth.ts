/**
 * OAuth for the MCP clients (the MCP authorization spec, 2025-06-18): what the Connect popup of an MCP server's credential
 * (`core.mcpOAuth2Api`) needs before it can send the browser to the authorization server.
 *
 * 1. **The server asks for a token**: an unauthenticated request to the MCP endpoint answers 401 with
 *    `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` (RFC 9728 §5.1). Servers that don't send the header are tried
 *    at `/.well-known/oauth-protected-resource` (with the endpoint's path, then without).
 * 2. **Protected resource metadata** (RFC 9728): `authorization_servers`, `scopes_supported`, `resource`. A server without it
 *    is its own authorization server (the 2025-03-26 revision's fallback).
 * 3. **Authorization server metadata**: RFC 8414 (`/.well-known/oauth-authorization-server`) then OpenID Connect discovery
 *    (`/.well-known/openid-configuration`), each with the issuer's path inserted and appended as the MCP spec lists them.
 *    PKCE with S256 is required when the server says which methods it supports; the metadata's `issuer` must be the issuer asked for.
 * 4. **A client**: the credential's client id (and secret) when it names one (a preconfigured client), else dynamic client
 *    registration (RFC 7591) at `registration_endpoint` as a public client (`token_endpoint_auth_method: none`), repeated when the
 *    redirect URI changed. A server with neither says what to do.
 * 5. **The resource** (RFC 8707): the MCP server's canonical URL (the metadata's `resource` when it names this server), sent with the
 *    authorization request and every token request (lib/server/credentials/oauth2.ts).
 *
 * The result (`McpOAuthMeta`) is kept in the credential's host-owned `oauthMeta` field, sealed with the rest of the data; the code
 * exchange, the refresh and the node's token then work as for any OAuth2 credential. Everything takes `fetch` so tests use fakes.
 */
import type { JsonObject } from '@landflow/protocol';
import { OAuth2Error } from '../credentials/oauth2';

const TIMEOUT_MS = 15_000;

export type McpTokenAuth = 'none' | 'basic' | 'post';

/** What discovery and registration found, as stored in the credential. */
export interface McpOAuthMeta {
  /** The endpoint it was found for: a different `serverUrl` in the form means discovery runs again. */
  serverUrl: string;
  resource: string;
  issuer: string;
  authUrl: string;
  accessTokenUrl: string;
  registrationUrl?: string;
  /** The client the server gave out (dynamic registration), or the one the form names. */
  clientId?: string;
  clientSecret?: string;
  /** The redirect URI the client was registered with. */
  redirectUri?: string;
  scope?: string;
  tokenAuth: McpTokenAuth;
  /** The client came from dynamic registration (not from the form). */
  registered?: boolean;
  discoveredAt: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function httpUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuth2Error(`The ${what} “${value}” is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OAuth2Error(`The ${what} must be an http(s) URL`);
  return url;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<JsonObject | undefined> {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

/** The parameters of a `WWW-Authenticate: Bearer …` challenge (`resource_metadata`, `scope`, `error`…). */
export function parseChallenge(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const bearer = /(?:^|,\s*)Bearer\s+([^]*)/i.exec(header ?? '');
  if (!bearer) return out;
  for (const match of bearer[1].matchAll(/([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) out[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

export interface ProtectedResource {
  /** The MCP endpoint, as the form has it. */
  serverUrl: string;
  /** The canonical resource URI for RFC 8707. */
  resource: string;
  authorizationServers: string[];
  /** The challenge's `scope`, else the metadata's `scopes_supported`. */
  scope?: string;
  /** Where the metadata came from (a diagnostic; undefined when the server has none). */
  metadataUrl?: string;
}

/** The MCP server's own URL without a fragment or a trailing slash on its root: the RFC 8707 form. */
export function canonicalResource(serverUrl: string): string {
  const url = httpUrl(serverUrl, 'MCP server URL');
  url.hash = '';
  const out = url.toString();
  return url.pathname === '/' && !url.search ? out.replace(/\/$/, '') : out;
}

/**
 * Ask the MCP server for authorization and read what it says (steps 1 and 2). A server that answers without asking for a token
 * is still looked for at the well-known paths; one with no metadata at all is its own authorization server.
 */
export async function discoverProtectedResource(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProtectedResource> {
  const endpoint = httpUrl(serverUrl, 'MCP server URL');
  const canonical = canonicalResource(serverUrl);
  let challenge: Record<string, string> = {};
  try {
    const probe = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'landflow', version: '0.1.0' } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await probe.body?.cancel().catch(() => {});
    if (probe.status === 401) challenge = parseChallenge(probe.headers.get('www-authenticate'));
  } catch (error) {
    throw new OAuth2Error(`Cannot reach the MCP server at ${endpoint.origin}: ${(error as Error).message}`);
  }
  const path = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '');
  const candidates = [
    ...(challenge.resource_metadata ? [challenge.resource_metadata] : []),
    `${endpoint.origin}/.well-known/oauth-protected-resource${path}`,
    ...(path ? [`${endpoint.origin}/.well-known/oauth-protected-resource`] : []),
  ];
  for (const url of [...new Set(candidates)]) {
    const metadata = await getJson(url, fetchImpl);
    const servers = strings(metadata?.authorization_servers);
    if (!metadata || !servers.length) continue;
    // The metadata's `resource` names the server it describes: use it when it is this server, else ours.
    const named = text(metadata.resource);
    const resource = named && sameResource(named, canonical) ? named : canonical;
    const scopes = strings(metadata.scopes_supported).join(' ');
    return { serverUrl, resource, authorizationServers: servers, ...((challenge.scope || scopes) && { scope: challenge.scope || scopes }), metadataUrl: url };
  }
  // No metadata: the server is its own authorization server.
  return { serverUrl, resource: canonical, authorizationServers: [endpoint.origin], ...(challenge.scope && { scope: challenge.scope }) };
}

/** Whether a resource named by metadata is the server we connect to (the endpoint is the resource or lies below it). */
function sameResource(named: string, canonical: string): boolean {
  const a = named.replace(/\/+$/, '');
  const b = canonical.replace(/\/+$/, '');
  return a === b || b.startsWith(`${a}/`);
}

export interface AuthorizationServer {
  issuer: string;
  authUrl: string;
  accessTokenUrl: string;
  registrationUrl?: string;
  tokenAuth: McpTokenAuth[];
  scopes: string[];
}

/** The well-known locations of an issuer's metadata, in the order the MCP spec tries them. */
export function metadataUrls(issuer: string): string[] {
  const url = httpUrl(issuer, 'authorization server');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`];
}

/** Read an authorization server's metadata (step 3): the first location that answers with a usable document. */
export async function discoverAuthorizationServer(issuer: string, fetchImpl: typeof fetch = fetch): Promise<AuthorizationServer | undefined> {
  for (const url of metadataUrls(issuer)) {
    const doc = await getJson(url, fetchImpl);
    if (!doc) continue;
    const authUrl = text(doc.authorization_endpoint);
    const accessTokenUrl = text(doc.token_endpoint);
    if (!authUrl || !accessTokenUrl) continue;
    // RFC 8414 §3.3: the issuer in the document is the one it was asked for (a mismatch means the wrong document).
    if (text(doc.issuer) && !sameIssuer(text(doc.issuer), issuer)) continue;
    const methods = strings(doc.code_challenge_methods_supported);
    if (methods.length && !methods.includes('S256')) throw new OAuth2Error(`The authorization server ${issuer} does not support PKCE with S256 (it offers ${methods.join(', ')}), which MCP requires`);
    const supported = strings(doc.token_endpoint_auth_methods_supported);
    const tokenAuth: McpTokenAuth[] = supported.length ? supported.flatMap((m): McpTokenAuth[] => (m === 'none' ? ['none'] : m === 'client_secret_basic' ? ['basic'] : m === 'client_secret_post' ? ['post'] : [])) : ['basic'];
    return { issuer, authUrl, accessTokenUrl, ...(text(doc.registration_endpoint) && { registrationUrl: text(doc.registration_endpoint) }), tokenAuth, scopes: strings(doc.scopes_supported) };
  }
  return undefined;
}

/** What a registered client is: its id, and its secret when the server issued one. */
export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  tokenAuth: McpTokenAuth;
}

/** Dynamic client registration (RFC 7591): Landflow as a public web client with this redirect URI. */
export async function registerClient(server: Pick<AuthorizationServer, 'registrationUrl' | 'issuer' | 'tokenAuth'>, redirectUri: string, scope: string | undefined, fetchImpl: typeof fetch = fetch): Promise<RegisteredClient> {
  if (!server.registrationUrl) throw new OAuth2Error(`The authorization server ${server.issuer} offers no dynamic client registration: register Landflow there (redirect URI ${redirectUri}) and enter the client ID (and secret) in the credential`);
  const wantsPublic = server.tokenAuth.includes('none');
  let response: Response;
  try {
    response = await fetchImpl(httpUrl(server.registrationUrl, 'registration endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Landflow',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: wantsPublic ? 'none' : server.tokenAuth.includes('post') && !server.tokenAuth.includes('basic') ? 'client_secret_post' : 'client_secret_basic',
        application_type: 'web',
        ...(scope && { scope }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuth2Error(`Cannot reach the registration endpoint ${new URL(server.registrationUrl).origin}: ${(error as Error).message}`);
  }
  const raw = await response.text();
  let body: JsonObject = {};
  try {
    body = JSON.parse(raw) as JsonObject;
  } catch {}
  if (!response.ok || !text(body.client_id)) {
    const why = text(body.error_description) || text(body.error) || raw.slice(0, 200).trim();
    throw new OAuth2Error(`Client registration at ${server.issuer} failed (${response.status}${why ? `: ${why}` : ''}): register Landflow there with the redirect URI ${redirectUri} and enter the client ID (and secret) in the credential`);
  }
  const method = text(body.token_endpoint_auth_method);
  return {
    clientId: text(body.client_id),
    ...(text(body.client_secret) && { clientSecret: text(body.client_secret) }),
    tokenAuth: method === 'none' || !text(body.client_secret) ? 'none' : method === 'client_secret_post' ? 'post' : 'basic',
  };
}

export interface PrepareInput {
  serverUrl: string;
  /** The form's client id and secret (already resolved from `$secrets`); a client id here means "preconfigured": no registration. */
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  /** What an earlier run stored. */
  meta?: JsonObject;
}

/**
 * Everything the authorization request needs (steps 1 to 5), reusing what an earlier run stored while it still fits: the same
 * server URL, and for a registered client the same redirect URI. Throws an OAuth2Error that says what to do when the server
 * can't be discovered or offers no way to get a client.
 */
export async function prepareMcpAuthorization(input: PrepareInput, fetchImpl: typeof fetch = fetch): Promise<McpOAuthMeta> {
  if (!input.serverUrl) throw new OAuth2Error('Enter the MCP server’s endpoint URL');
  const stored = input.meta as Partial<McpOAuthMeta> | undefined;
  const fits = stored && stored.serverUrl === input.serverUrl && stored.authUrl && stored.accessTokenUrl && stored.resource;
  let found: Pick<McpOAuthMeta, 'resource' | 'issuer' | 'authUrl' | 'accessTokenUrl' | 'registrationUrl' | 'scope' | 'tokenAuth'> & { offered: McpTokenAuth[] };
  if (fits) {
    found = { resource: stored.resource!, issuer: stored.issuer ?? '', authUrl: stored.authUrl!, accessTokenUrl: stored.accessTokenUrl!, ...(stored.registrationUrl && { registrationUrl: stored.registrationUrl }), ...(stored.scope && { scope: stored.scope }), tokenAuth: stored.tokenAuth ?? 'basic', offered: stored.tokenAuth ? [stored.tokenAuth] : ['basic'] };
  } else {
    const resource = await discoverProtectedResource(input.serverUrl, fetchImpl);
    let server: AuthorizationServer | undefined;
    for (const issuer of resource.authorizationServers) {
      server = await discoverAuthorizationServer(issuer, fetchImpl);
      if (server) break;
    }
    if (!server) throw new OAuth2Error(`Found no authorization server metadata for ${resource.authorizationServers.join(', ')} (tried ${metadataUrls(resource.authorizationServers[0]).join(', ')}): does ${new URL(input.serverUrl).origin} use OAuth?`);
    found = { resource: resource.resource, issuer: server.issuer, authUrl: server.authUrl, accessTokenUrl: server.accessTokenUrl, ...(server.registrationUrl && { registrationUrl: server.registrationUrl }), ...(resource.scope && { scope: resource.scope }), tokenAuth: server.tokenAuth[0] ?? 'basic', offered: server.tokenAuth };
  }
  const base = { serverUrl: input.serverUrl, resource: found.resource, issuer: found.issuer, authUrl: found.authUrl, accessTokenUrl: found.accessTokenUrl, ...(found.registrationUrl && { registrationUrl: found.registrationUrl }), ...(found.scope && { scope: found.scope }), discoveredAt: fits && stored?.discoveredAt ? stored.discoveredAt : new Date().toISOString() };
  // A preconfigured client: the form's id (and secret). Public when there is no secret, else the method the server offers.
  if (input.clientId) {
    const tokenAuth: McpTokenAuth = !input.clientSecret ? 'none' : found.offered.includes('basic') || !found.offered.includes('post') ? 'basic' : 'post';
    return { ...base, tokenAuth };
  }
  // A client registered earlier for this redirect URI is reused.
  if (fits && stored?.registered && stored.clientId && stored.redirectUri === input.redirectUri) return { ...base, clientId: stored.clientId, ...(stored.clientSecret && { clientSecret: stored.clientSecret }), redirectUri: stored.redirectUri, tokenAuth: stored.tokenAuth ?? 'none', registered: true };
  const registered = await registerClient({ registrationUrl: found.registrationUrl, issuer: found.issuer, tokenAuth: found.offered }, input.redirectUri, input.scope || found.scope, fetchImpl);
  return { ...base, clientId: registered.clientId, ...(registered.clientSecret && { clientSecret: registered.clientSecret }), redirectUri: input.redirectUri, tokenAuth: registered.tokenAuth, registered: true };
}
