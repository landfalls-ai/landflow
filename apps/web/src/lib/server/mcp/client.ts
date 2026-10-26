/**
 * The client side of MCP (the MCP SDK v2, `@modelcontextprotocol/client`): connections to MCP servers over Streamable
 * HTTP, or SSE for older servers, with the headers of an auth credential (none, a bearer token or a custom header).
 * The client negotiates the protocol revision itself: `server/discover` first (2026-07-28), falling back to
 * `initialize` for 2025-xx and older servers.
 * Connections are pooled per endpoint and closed after 30 s idle, so an agent's tool calls in
 * one run share a session. Used by the MCP Client Tool and MCP Client nodes and by agents'
 * MCP server capabilities (docs/agents.md).
 */
import { createHash } from 'node:crypto';
import { Client, ProtocolError, SdkHttpError, SSEClientTransport, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import type { JsonObject } from '@landflow/protocol';
import { toToolName, type AgentTool } from '@landflow/engine';
import { mcpUrlBlocked } from '../governance/policy';
import { singleton } from '../singleton';

export type McpTransport = 'httpStreamable' | 'sse';
export type McpAuthentication = 'none' | 'bearerAuth' | 'headerAuth';
export type McpToolSelection = 'all' | 'selected' | 'except';

/** Where an MCP server is and how to reach it. */
export interface McpEndpoint {
  url: string;
  transport: McpTransport;
  /** Sent with every request (the auth credential's header). */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 60 s). */
  timeoutMs?: number;
  /** Test hook: the fetch the transport uses. */
  fetch?: typeof fetch;
}

/** The MCP server parameters the MCP Client Tool and MCP Client nodes share (n8n's names). */
export interface McpServerParameters {
  endpointUrl?: unknown;
  serverTransport?: unknown;
  authentication?: unknown;
  options?: { timeout?: unknown } | unknown;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
const IDLE_MS = 30_000;
const CLIENT_INFO = { name: 'landflow', version: '0.1.0' };

/** A human-friendly error for anything that goes wrong talking to an MCP server. */
export class McpClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The auth header of the node's credential: `Authorization: Bearer …` or a custom header. */
export function authHeaders(authentication: unknown, credentials: { httpBearerAuth?: JsonObject; httpHeaderAuth?: JsonObject }): Record<string, string> {
  if (authentication === 'bearerAuth') {
    const token = String(credentials.httpBearerAuth?.token ?? '').trim();
    if (!token) throw new McpClientError('Choose a Bearer Auth credential with a token');
    return { Authorization: `Bearer ${token}` };
  }
  if (authentication === 'headerAuth') {
    const name = String(credentials.httpHeaderAuth?.name ?? '').trim();
    if (!name) throw new McpClientError('Choose a Header Auth credential with a header name');
    return { [name]: String(credentials.httpHeaderAuth?.value ?? '') };
  }
  return {};
}

/** The endpoint described by an MCP node's parameters and its decrypted credentials. */
export function endpointFrom(parameters: McpServerParameters, credentials: { httpBearerAuth?: JsonObject; httpHeaderAuth?: JsonObject }): McpEndpoint {
  const url = String(parameters.endpointUrl ?? '').trim();
  if (!url) throw new McpClientError('Enter the MCP server’s endpoint URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpClientError(`“${url}” is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new McpClientError('The endpoint URL must start with http:// or https://');
  // Settings → Governance: MCP servers outside the allow-list are refused (MCP Client node and tool, agents).
  const blocked = mcpUrlBlocked(parsed.toString());
  if (blocked) throw new McpClientError(`Blocked by policy: ${blocked}. An admin can allow it in Settings → Governance.`, 403);
  const options = (parameters.options && typeof parameters.options === 'object' ? parameters.options : {}) as { timeout?: unknown };
  const timeout = Number(options.timeout);
  return {
    url: parsed.toString(),
    transport: parameters.serverTransport === 'sse' ? 'sse' : 'httpStreamable',
    headers: authHeaders(parameters.authentication, credentials),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

interface Pooled {
  client: Client;
  busy: number;
  timer?: ReturnType<typeof setTimeout>;
}

const pool = singleton('mcp-client-pool', () => new Map<string, Promise<Pooled>>());

function keyOf(endpoint: McpEndpoint): string {
  const headers = Object.entries(endpoint.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  // Hashed: the key would otherwise hold the token.
  return createHash('sha256')
    .update(JSON.stringify([endpoint.url, endpoint.transport, headers]))
    .digest('hex');
}

function describe(error: unknown, endpoint: McpEndpoint): McpClientError {
  if (error instanceof McpClientError) return error;
  // The SDK's HTTP errors carry the status; older shapes put it in `code`.
  const status = error instanceof SdkHttpError ? error.status : (error as { code?: unknown }).code;
  const code = typeof status === 'number' && status >= 100 ? status : undefined;
  const message = (error as Error).message ?? String(error);
  if (code === 401 || code === 403) return new McpClientError(`The MCP server at ${endpoint.url} rejected the credentials (${code})`, code);
  if (code === 404) return new McpClientError(`No MCP server at ${endpoint.url} (404)`, code);
  return new McpClientError(`Cannot connect to the MCP server at ${endpoint.url}: ${message}`, code);
}

async function connect(endpoint: McpEndpoint): Promise<Client> {
  const url = new URL(endpoint.url);
  const requestInit: RequestInit = { headers: endpoint.headers ?? {} };
  const transport =
    endpoint.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, ...(endpoint.fetch && { fetch: endpoint.fetch }) })
      : new StreamableHTTPClientTransport(url, { requestInit, ...(endpoint.fetch && { fetch: endpoint.fetch }) });
  // `auto`: probe with `server/discover` (2026-07-28) and fall back to the `initialize` handshake of older servers.
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport, { timeout: endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => {});
    throw describe(error, endpoint);
  }
  return client;
}

function drop(key: string, entry: Promise<Pooled>) {
  if (pool.get(key) !== entry) return;
  pool.delete(key);
  void entry.then((pooled) => pooled.client.close()).catch(() => {});
}

/** A session that went away (server restart, expired session id): worth one reconnect. */
function isStale(error: unknown): boolean {
  if (error instanceof SdkHttpError) return error.status === 404;
  return /not connected|connection closed/i.test((error as Error)?.message ?? '');
}

/**
 * Run `fn` with a connected client for `endpoint`, from the pool. A stale session is reconnected
 * once; other errors are thrown as they are (an McpError for a JSON-RPC error from the server).
 */
export async function withMcpClient<T>(endpoint: McpEndpoint, fn: (client: Client) => Promise<T>): Promise<T> {
  const key = keyOf(endpoint);
  for (let attempt = 0; ; attempt++) {
    let entry = pool.get(key);
    if (!entry) {
      entry = connect(endpoint).then((client) => {
        const pooled: Pooled = { client, busy: 0 };
        client.onclose = () => {
          if (pool.get(key) === entry) pool.delete(key);
        };
        return pooled;
      });
      pool.set(key, entry);
      // A failed connection must not stay in the pool.
      entry.catch(() => pool.get(key) === entry && pool.delete(key));
    }
    const pooled = await entry;
    pooled.busy++;
    clearTimeout(pooled.timer);
    try {
      return await fn(pooled.client);
    } catch (error) {
      if (attempt === 0 && isStale(error)) {
        drop(key, entry);
        continue;
      }
      throw error;
    } finally {
      pooled.busy--;
      if (!pooled.busy && pool.get(key) === entry) {
        const current = entry;
        pooled.timer = setTimeout(() => drop(key, current), IDLE_MS);
        pooled.timer.unref?.();
      }
    }
  }
}

/** Close every pooled connection (tests, shutdown). */
export async function closeMcpClients(): Promise<void> {
  const entries = [...pool.entries()];
  pool.clear();
  await Promise.allSettled(entries.map(([, entry]) => entry.then((pooled) => (clearTimeout(pooled.timer), pooled.client.close()))));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Every tool the server lists (all pages). */
export async function listMcpTools(endpoint: McpEndpoint): Promise<Tool[]> {
  try {
    return await withMcpClient(endpoint, async (client) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 2_000);
      return tools;
    });
  } catch (error) {
    throw describe(error, endpoint);
  }
}

/** Call one tool; the raw MCP result (an error result is returned, not thrown; a JSON-RPC error about the call becomes one too). */
export async function callMcpTool(endpoint: McpEndpoint, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    const result = await withMcpClient(endpoint, (client) =>
      client.callTool({ name, arguments: args }, { timeout: endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(signal && { signal }) }),
    );
    // Servers on the 2024-10-07 protocol answer { toolResult }.
    const compat = result as unknown as { toolResult?: unknown; content?: unknown };
    if ('toolResult' in compat && !('content' in compat)) return { content: [{ type: 'text', text: JSON.stringify(compat.toolResult) }] };
    return result;
  } catch (error) {
    // A JSON-RPC error (unknown tool, invalid arguments) is the server's answer about this call: an error result, as
    // servers on the 2025 SDKs sent it, so callers treat both the same way.
    if (error instanceof ProtocolError || (error as { name?: string }).name === 'McpError') return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    throw describe(error, endpoint);
  }
}

/** Tools to offer: all, only the selected ones, or all except the listed ones. */
export function selectTools<T extends { name: string }>(tools: T[], include: unknown, includeTools: unknown, excludeTools: unknown): T[] {
  const names = (value: unknown) => new Set((Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : []).map((v) => String(v).trim()));
  if (include === 'selected') {
    const wanted = names(includeTools);
    return tools.filter((tool) => wanted.has(tool.name));
  }
  if (include === 'except') {
    const unwanted = names(excludeTools);
    return tools.filter((tool) => !unwanted.has(tool.name));
  }
  return tools;
}

/** The text parts of a result, joined. */
export function resultText(result: CallToolResult): string {
  return result.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

/** Content without the bytes of images, audio and embedded blobs (they would swamp a model or an item). */
export function compactContent(result: CallToolResult): JsonObject[] {
  return result.content.map((part): JsonObject => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'image':
      case 'audio':
        return { type: part.type, mimeType: part.mimeType, bytes: Math.floor((part.data.length * 3) / 4) };
      case 'resource': {
        const { resource } = part;
        return 'text' in resource
          ? { type: 'resource', uri: resource.uri, ...(resource.mimeType && { mimeType: resource.mimeType }), text: resource.text }
          : { type: 'resource', uri: resource.uri, ...(resource.mimeType && { mimeType: resource.mimeType }), bytes: Math.floor((String(resource.blob).length * 3) / 4) };
      }
      case 'resource_link':
        return { type: 'resource_link', uri: part.uri, name: part.name, ...(part.mimeType && { mimeType: part.mimeType }) };
      default:
        return { type: String((part as { type?: unknown }).type ?? 'unknown') };
    }
  });
}

/**
 * What an agent gets back from a tool call: the structured content when the server sends it, the
 * text when the result is text only, else the content parts. An error result throws its text.
 */
export function toolOutput(result: CallToolResult): unknown {
  const text = resultText(result);
  if (result.isError) throw new McpClientError(text || 'The MCP tool returned an error');
  if (result.structuredContent) return result.structuredContent;
  if (result.content.every((part) => part.type === 'text')) return text;
  return compactContent(result);
}

/** An MCP tool's input schema as an agent tool schema (always an object schema, without `$schema`). */
export function toolSchema(tool: Pick<Tool, 'inputSchema'>): JsonObject {
  const { $schema: _schema, ...schema } = (tool.inputSchema ?? {}) as Record<string, unknown>;
  return { ...schema, type: 'object', properties: (schema.properties as JsonObject | undefined) ?? {} } as JsonObject;
}

/** Each selected MCP tool as an agent tool with its JSON schema; calls go through the pool. */
export function agentToolsFrom(endpoint: McpEndpoint, tools: Tool[]): AgentTool[] {
  return tools.map((tool) => ({
    name: toToolName(tool.name),
    description: tool.description || tool.title || tool.annotations?.title || `The “${tool.name}” tool of an MCP server`,
    inputSchema: toolSchema(tool),
    invoke: async (input, signal) => toolOutput(await callMcpTool(endpoint, tool.name, input, signal)),
  }));
}
