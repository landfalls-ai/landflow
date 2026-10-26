/**
 * The server side of MCP over Streamable HTTP, on the MCP SDK v2 (`@modelcontextprotocol/server`), speaking two
 * protocol eras at once:
 *
 * - **2026-07-28** (stateless: no `initialize`, a `_meta` envelope on every request, `server/discover`,
 *   `subscriptions/listen`): the SDK's `createMcpHandler`, one per endpoint, kept in a map so the `subscriptions/listen`
 *   streams it holds outlive the request that opened them and `notifyToolsChanged()` reaches them.
 * - **2025-xx** (`initialize` first, optional sessions): a fresh server and transport per POST, answering with JSON (no
 *   session id, no server-to-client stream), so a request needs nothing from an earlier one. GET (the optional event
 *   stream) and DELETE (ending a session) get 405, which clients take as "not offered".
 *
 * `isLegacyRequest` (the SDK's own classifier) decides per request. Used by /mcp/<path> (MCP Server Trigger), /api/mcp
 * (the instance server) and /api/mcp/plugins/<id> (the per-plugin endpoints, ./plugin-servers.ts). agentgateway
 * forwards the client's protocol version untouched, so every endpoint behind it must speak both.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo, type CallToolResult, type McpHttpHandler, type Server } from '@modelcontextprotocol/server';
import { binaryLimits } from '../binary/access';
import { singleton } from '../singleton';
import { logger } from '../telemetry';

/** The version Landflow's MCP servers report. */
export const MCP_SERVER_VERSION = '0.1.0';

/** What a server factory learns about the request it answers. */
export interface McpRequestInfo {
  era: 'legacy' | 'modern';
  request?: Request;
  /** The caller, as the endpoint authenticated it (./plugin-servers.ts puts the McpCaller in `extra.caller`). */
  authInfo?: AuthInfo;
}

export type McpServerFactory = (info: McpRequestInfo) => McpServer | Server | Promise<McpServer | Server>;

interface Endpoint {
  factory: McpServerFactory;
  modern: McpHttpHandler;
}

const endpoints = () => singleton('mcp-endpoints', () => new Map<string, Endpoint>());

/** Requests the SDK refuses (a wrong header, an unknown version) are the client's problem, not ours: debug level. */
const report = (error: Error) => logger.debug('mcp request refused', { error: error.message });

/** The size limit of a JSON-RPC body: the same as webhook bodies (LANDFLOW_BINARY_MAX_BYTES). */
const maxRequestBodySize = () => binaryLimits().maxBytes;

/**
 * The handler of one endpoint: made once per `key` (the modern handler owns the `subscriptions/listen` streams), its
 * factory replaced on every call so a renamed workflow or a changed manifest shows on the next request.
 */
function endpoint(key: string, factory: McpServerFactory): Endpoint {
  const existing = endpoints().get(key);
  if (existing) {
    existing.factory = factory;
    return existing;
  }
  const entry: Endpoint = {
    factory,
    modern: undefined as unknown as McpHttpHandler,
  };
  entry.modern = createMcpHandler((ctx) => entry.factory({ era: 'modern', request: ctx.requestInfo, authInfo: ctx.authInfo }), { legacy: 'reject', onerror: report, maxRequestBodySize: maxRequestBodySize() });
  endpoints().set(key, entry);
  return entry;
}

/** A 2025-era request: a fresh server on a stateless transport answering JSON; GET and DELETE are 405. */
async function serveLegacy(request: Request, factory: McpServerFactory, authInfo?: AuthInfo): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const server = await factory({ era: 'legacy', request, authInfo });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxRequestBodySize() });
  await server.connect(transport);
  try {
    // In JSON mode the response is complete when this resolves, so the server can close right after.
    return await transport.handleRequest(request, authInfo && { authInfo });
  } finally {
    void server.close().catch(() => {});
  }
}

/** What an endpoint does when a 2026-07-28 client opens `subscriptions/listen` for resources: claim them, or refuse the stream. */
export type ListenHook = (uris: string[], info: { request: Request; authInfo?: AuthInfo; key: string; id: unknown }) => Promise<{ release: () => void } | Response>;

export interface ServeOptions {
  /** Called for a `subscriptions/listen` that names `resourceSubscriptions`; `release` runs once when that stream ends (the client left, or the server closed it). */
  onListen?: ListenHook;
}

/** A JSON-RPC error answered in-band (HTTP 200) for a `subscriptions/listen` the endpoint refuses, as the SDK's own listen router does. */
export function listenRefusal(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id }, { status: 200 });
}

/** The body of an event stream with `release` called once when it ends or the reader cancels it. */
function releasingStream(response: Response, release: () => void): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** The URIs a `subscriptions/listen` body subscribes to (and its JSON-RPC id), or undefined for any other request. */
async function listenedResources(request: Request): Promise<{ id: unknown; uris: string[] } | undefined> {
  if (request.method !== 'POST') return undefined;
  const body = (await request
    .clone()
    .json()
    .catch(() => undefined)) as { id?: unknown; method?: string; params?: { notifications?: { resourceSubscriptions?: unknown } } } | undefined;
  if (body?.method !== 'subscriptions/listen') return undefined;
  const uris = body.params?.notifications?.resourceSubscriptions;
  return Array.isArray(uris) && uris.length ? { id: body.id, uris: uris.filter((u): u is string => typeof u === 'string') } : undefined;
}

/**
 * Answer one MCP request on the endpoint `key` with a server the factory makes for it (one per request, both eras).
 * `authInfo` reaches the factory and the handlers (`ctx.authInfo`). A 2026-07-28 `subscriptions/listen` that subscribes
 * to resources goes through `options.onListen` first, and its stream is released when it ends.
 */
export async function serveMcpEndpoint(key: string, request: Request, factory: McpServerFactory, authInfo?: AuthInfo, options: ServeOptions = {}): Promise<Response> {
  const entry = endpoint(key, factory);
  if (await isLegacyRequest(request)) return serveLegacy(request, entry.factory, authInfo);
  const listen = options.onListen ? await listenedResources(request) : undefined;
  if (!listen) return entry.modern.fetch(request, authInfo && { authInfo });
  const claim = await options.onListen!(listen.uris, { request, authInfo, key, id: listen.id });
  if (claim instanceof Response) return claim;
  let response: Response;
  try {
    response = await entry.modern.fetch(request, authInfo && { authInfo });
  } catch (error) {
    claim.release();
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    claim.release();
  };
  request.signal.addEventListener('abort', release, { once: true });
  return releasingStream(response, release);
}

/** Answer one MCP request with a server made for it (the instance server and the MCP Server Triggers). */
export function serveMcp(request: Request, create: () => McpServer | Promise<McpServer>, key = `request:${new URL(request.url).pathname}`): Promise<Response> {
  return serveMcpEndpoint(key, request, () => create());
}

/** Tell the 2026-07-28 clients listening on `key` (`subscriptions/listen`) that its tool list changed. */
export function notifyToolsChanged(key: string): boolean {
  const entry = endpoints().get(key);
  if (!entry) return false;
  entry.modern.notify.toolsChanged();
  return true;
}

/** Tell the 2026-07-28 clients listening on `key` that subscribed to `uri` (`resourceSubscriptions`) that it changed (`notifications/resources/updated`). */
export function notifyResourceUpdated(key: string, uri: string): boolean {
  const entry = endpoints().get(key);
  if (!entry) return false;
  entry.modern.notify.resourceUpdated(uri);
  return true;
}

/** Close every endpoint's listen streams (tests, shutdown). */
export async function closeMcpEndpoints(): Promise<void> {
  const all = [...endpoints().values()];
  endpoints().clear();
  await Promise.allSettled(all.map((entry) => entry.modern.close()));
}

export function methodNotAllowed(): Response {
  return jsonRpcError(405, -32000, 'Method not allowed: this server is stateless, send JSON-RPC messages with POST', { allow: 'POST' });
}

/** An HTTP error with a JSON-RPC error body, as MCP clients expect. */
export function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 401 with a bearer challenge (or none, for a custom header). */
export function unauthorized(message: string, scheme: 'bearer' | 'header' = 'bearer'): Response {
  return jsonRpcError(401, -32001, message, scheme === 'bearer' ? { 'www-authenticate': 'Bearer realm="landflow"' } : {});
}

/** The token of an `Authorization: Bearer …` header. */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1].trim() || undefined;
}

/** Constant-time comparison of two secrets (hashed first, so lengths don't leak either). */
export function sameSecret(given: string | undefined | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A tool result: text (JSON for anything but a string). */
export function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text }], ...(isError && { isError: true }) };
}

export { McpServer };
