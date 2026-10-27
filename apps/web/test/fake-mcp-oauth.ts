/**
 * An OAuth-protected MCP server and its authorization server on one 127.0.0.1 port, for the MCP OAuth tests:
 *
 * - `/mcp`: an MCP endpoint (SDK `createMcpHandler`) with a tool, resources and prompts. It answers 401 with
 *   `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` to a missing or unknown token, and to a token that was issued
 *   for another resource (RFC 8707);
 * - `/.well-known/oauth-protected-resource/mcp`: RFC 9728 metadata (`prm: false` removes it and the header's pointer);
 * - the authorization server `<origin>/as` (the origin itself when `prm` is false) with metadata at the RFC 8414 location, or the OpenID Connect ones (`metadata`),
 *   dynamic client registration (`dcr: false` removes it), an authorization endpoint that consents at once, and a token endpoint
 *   (PKCE, `resource` recorded, refresh tokens with rotation, public or Basic / body client auth).
 *
 * Every authorize, register and token request is recorded for the assertions.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

export interface FakeMcpOAuthOptions {
  /** Where the authorization server metadata lives (default rfc8414). */
  metadata?: 'rfc8414' | 'oidc' | 'oidc-append';
  /** Serve protected resource metadata (default true). */
  prm?: boolean;
  /** Offer dynamic client registration (default true). */
  dcr?: boolean;
  /** A pre-registered client: the only one the authorization server knows when `dcr` is false. */
  client?: { id: string; secret?: string };
  /** expires_in of access tokens (seconds). */
  expiresIn?: number;
  /** Offer only `plain` PKCE in the metadata (the client must refuse). */
  plainOnly?: boolean;
  /** A real authorization server (Keycloak): the metadata points at it and tokens are checked with `verifyToken`. */
  externalIssuer?: string;
  verifyToken?: (token: string) => Promise<boolean>;
}

export interface FakeMcpOAuth {
  origin: string;
  /** The MCP endpoint. */
  url: string;
  issuer: string;
  registrations: Array<Record<string, unknown>>;
  authorizeRequests: URLSearchParams[];
  tokenRequests: Array<{ params: Record<string, string>; basic?: { id: string; secret: string } }>;
  /** MCP requests with the token they carried: ok is whether it was accepted. */
  mcpCalls: Array<{ token: string; ok: boolean }>;
  validAccess: Map<string, { resource: string }>;
  validRefresh: Set<string>;
  revokeAccess(): void;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

function toWebRequest(req: IncomingMessage, body: string, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), { method, headers, ...(method !== 'GET' && method !== 'HEAD' && { body }) });
}

async function sendWeb(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  for await (const chunk of Readable.fromWeb(response.body as never)) res.write(chunk);
  res.end();
}

function mcpServer(): McpServer {
  const server = new McpServer({ name: 'oauth-protected', version: '1.0.0' });
  server.registerTool('add', { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.registerResource('readme', 'doc://readme', { title: 'Readme', description: 'The project readme', mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello from the readme' }] }));
  server.registerPrompt('review', { title: 'Code review', description: 'Review some code', argsSchema: z.object({ language: z.string().describe('The language') }) }, async ({ language }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Please review this ${language} code` } }],
  }));
  return server;
}

export async function startFakeMcpOAuth(options: FakeMcpOAuthOptions = {}): Promise<FakeMcpOAuth> {
  const opts = { metadata: 'rfc8414', prm: true, dcr: true, ...options };
  const handler = createMcpHandler(() => mcpServer());
  const clients = new Map<string, { redirectUris: string[]; secret?: string }>();
  if (opts.client) clients.set(opts.client.id, { redirectUris: [], ...(opts.client.secret && { secret: opts.client.secret }) });
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource?: string; scope?: string }>();
  let counter = 0;
  let origin = '';
  // Without protected resource metadata the server is its own authorization server (RFC 8414 at the origin).
  const issuerPath = opts.prm ? '/as' : '';
  const fake: FakeMcpOAuth = {
    origin: '',
    url: '',
    issuer: '',
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    mcpCalls: [],
    validAccess: new Map(),
    validRefresh: new Set(),
    revokeAccess: () => fake.validAccess.clear(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    },
  };

  const issue = (resource: string | undefined, scope: string | undefined, refresh = true) => {
    counter++;
    const access = `mcp-at-${counter}-${Math.random().toString(36).slice(2)}`;
    fake.validAccess.set(access, { resource: resource ?? '' });
    const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', ...(opts.expiresIn !== undefined && { expires_in: opts.expiresIn }), ...(scope && { scope }) };
    if (refresh) {
      const token = `mcp-rt-${counter}-${Math.random().toString(36).slice(2)}`;
      fake.validRefresh.add(token);
      out.refresh_token = token;
    }
    return out;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const asMetadata = {
      issuer: fake.issuer,
      authorization_endpoint: `${fake.issuer}/authorize`,
      token_endpoint: `${fake.issuer}/token`,
      ...(opts.dcr && { registration_endpoint: `${fake.issuer}/register` }),
      response_types_supported: ['code'],
      code_challenge_methods_supported: opts.plainOnly ? ['plain'] : ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    };
    const metadataPaths = { rfc8414: `/.well-known/oauth-authorization-server${issuerPath}`, oidc: `/.well-known/openid-configuration${issuerPath}`, 'oidc-append': `${issuerPath}/.well-known/openid-configuration` };
    if (url.pathname === metadataPaths[opts.metadata as keyof typeof metadataPaths]) return json(200, asMetadata);

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && opts.prm) return json(200, { resource: fake.url, authorization_servers: [opts.externalIssuer ?? fake.issuer], scopes_supported: ['mcp:read', 'mcp:write'], bearer_methods_supported: ['header'] });

    if (url.pathname === `${issuerPath}/register` && req.method === 'POST' && opts.dcr) {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
      fake.registrations.push(body);
      const id = `dyn-${++counter}`;
      clients.set(id, { redirectUris: body.redirect_uris ?? [] });
      return json(201, { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    }

    if (url.pathname === `${issuerPath}/authorize`) {
      fake.authorizeRequests.push(url.searchParams);
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const client = clients.get(clientId);
      if (!client) return json(400, { error: 'invalid_client' });
      if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) return json(400, { error: 'invalid_request', error_description: 'redirect_uri not registered' });
      const challenge = url.searchParams.get('code_challenge') ?? '';
      if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      const code = `code-${++counter}`;
      codes.set(code, { clientId, redirectUri, challenge, ...(url.searchParams.get('resource') && { resource: url.searchParams.get('resource')! }), ...(url.searchParams.get('scope') && { scope: url.searchParams.get('scope')! }) });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === `${issuerPath}/token` && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      let basic: { id: string; secret: string } | undefined;
      const header = req.headers.authorization;
      if (header?.startsWith('Basic ')) {
        const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
        basic = { id, secret };
      }
      fake.tokenRequests.push({ params, ...(basic && { basic }) });
      const clientId = basic?.id ?? params.client_id;
      const client = clients.get(clientId);
      if (!client) return json(401, { error: 'invalid_client' });
      if (client.secret && (basic?.secret ?? params.client_secret) !== client.secret) return json(401, { error: 'invalid_client', error_description: 'bad secret' });
      if (params.grant_type === 'authorization_code') {
        const code = codes.get(params.code);
        if (!code || code.clientId !== clientId) return json(400, { error: 'invalid_grant', error_description: 'Unknown code' });
        codes.delete(params.code);
        if (code.redirectUri !== params.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (createHash('sha256').update(params.code_verifier ?? '').digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        if (code.resource && params.resource !== code.resource) return json(400, { error: 'invalid_target', error_description: 'resource differs from the authorization request' });
        return json(200, issue(code.resource, code.scope));
      }
      if (params.grant_type === 'refresh_token') {
        if (!fake.validRefresh.has(params.refresh_token)) return json(400, { error: 'invalid_grant', error_description: 'Token is not active' });
        fake.validRefresh.delete(params.refresh_token);
        return json(200, issue(params.resource, undefined));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
      const known = fake.validAccess.get(token);
      // An access token is for the resource it was requested for (RFC 8707).
      const ok = opts.verifyToken ? Boolean(token) && (await opts.verifyToken(token)) : Boolean(known) && (known!.resource === '' || known!.resource === fake.url);
      fake.mcpCalls.push({ token, ok });
      if (!ok) {
        const challenge = `Bearer ${opts.prm ? `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` : ''}scope="mcp:read"`;
        return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { 'www-authenticate': challenge });
      }
      return sendWeb(res, await handler.fetch(toWebRequest(req, await readBody(req), origin)));
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.origin = origin;
  fake.url = `${origin}/mcp`;
  fake.issuer = `${origin}${issuerPath}`;
  return fake;
}
