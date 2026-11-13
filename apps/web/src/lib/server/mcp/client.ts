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
import { safeFetch } from '../net/safe-fetch';
import { singleton } from '../singleton';

export type McpTransport = 'httpStreamable' | 'sse';
export type McpAuthentication = 'none' | 'bearerAuth' | 'headerAuth' | 'mcpOAuth2';
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
  /**
   * OAuth sign-in: called once when the server answers 401, it renews the token and returns the new headers (undefined: nothing
   * new, give up). The endpoint takes them for its next calls.
   */
  reauth?: () => Promise<Record<string, string> | undefined>;
}

/** The credentials an MCP node can authenticate with. */
export interface McpCredentials {
  httpBearerAuth?: JsonObject;
  httpHeaderAuth?: JsonObject;
  mcpOAuth2Api?: JsonObject;
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
export function authHeaders(authentication: unknown, credentials: McpCredentials): Record<string, string> {
  if (authentication === 'mcpOAuth2') {
    const token = String(credentials.mcpOAuth2Api?.accessToken ?? '').trim();
    if (!token) throw new McpClientError('The MCP OAuth2 credential is not connected: open it in Credentials and use Connect');
    return { Authorization: `Bearer ${token}` };
  }
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
export function endpointFrom(parameters: McpServerParameters, credentials: McpCredentials): McpEndpoint {
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
  if (code === 401 || code === 403) return new McpClientError(`The MCP server at ${endpoint.url} rejected the credentials (${code})${endpoint.reauth ? ': the OAuth sign-in may have been revoked, reconnect the MCP OAuth2 credential' : ''}`, code);
  if (code === 404) return new McpClientError(`No MCP server at ${endpoint.url} (404)`, code);
  return new McpClientError(`Cannot connect to the MCP server at ${endpoint.url}: ${message}`, code);
}

async function connect(endpoint: McpEndpoint): Promise<Client> {
  const url = new URL(endpoint.url);
  const requestInit: RequestInit = { headers: endpoint.headers ?? {} };
  // Remote MCP servers go through the outbound policy (net/safe-fetch.ts); tests inject their own fetch.
  const guarded = endpoint.fetch ?? (((input, init) => safeFetch(input as string | URL | Request, init)) as typeof fetch);
  const transport =
    endpoint.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, fetch: guarded })
      : new StreamableHTTPClientTransport(url, { requestInit, fetch: guarded });
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

/** Run a call; when the server answers 401 and the endpoint can renew its OAuth token, renew it and run the call once more. */
async function withReauth<T>(endpoint: McpEndpoint, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof McpClientError) || error.status !== 401 || !endpoint.reauth) throw error;
    const headers = await endpoint.reauth().catch(() => undefined);
    if (!headers) throw error;
    endpoint.headers = headers;
    return run();
  }
}

/** Every tool the server lists (all pages). */
export const listMcpTools = (endpoint: McpEndpoint): Promise<Tool[]> => withReauth(endpoint, () => listTools(endpoint));

async function listTools(endpoint: McpEndpoint): Promise<Tool[]> {
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
export const callMcpTool = (endpoint: McpEndpoint, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => withReauth(endpoint, () => callTool(endpoint, name, args, signal));

async function callTool(endpoint: McpEndpoint, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
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

// ---------------------------------------------------------------------------
// Resources and prompts
// ---------------------------------------------------------------------------

export interface McpResourceInfo extends JsonObject {
  uri: string;
  name: string;
}

/** Every page of a list call, up to a cap. */
async function allPages<T>(endpoint: McpEndpoint, page: (client: Client, cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  return withReauth(endpoint, async () => {
    try {
      return await withMcpClient(endpoint, async (client) => {
        const out: T[] = [];
        let cursor: string | undefined;
        do {
          const result = await page(client, cursor);
          out.push(...result.items);
          cursor = result.nextCursor;
        } while (cursor && out.length < 2_000);
        return out;
      });
    } catch (error) {
      throw describe(error, endpoint);
    }
  });
}

const timeoutOf = (endpoint: McpEndpoint) => ({ timeout: endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS });

/** The resources a server lists (a server without the capability answers with an empty list). */
export async function listMcpResources(endpoint: McpEndpoint): Promise<JsonObject[]> {
  return allPages(endpoint, async (client, cursor) => {
    const page = await client.listResources(cursor ? { cursor } : undefined, timeoutOf(endpoint));
    return { items: page.resources.map((r) => ({ uri: r.uri, name: r.name, ...(r.title && { title: r.title }), ...(r.description && { description: r.description }), ...(r.mimeType && { mimeType: r.mimeType }) }) as JsonObject), nextCursor: page.nextCursor };
  });
}

/** The resource templates a server lists (RFC 6570 URI templates). */
export async function listMcpResourceTemplates(endpoint: McpEndpoint): Promise<JsonObject[]> {
  return allPages(endpoint, async (client, cursor) => {
    const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, timeoutOf(endpoint));
    return { items: page.resourceTemplates.map((r) => ({ uriTemplate: r.uriTemplate, name: r.name, ...(r.description && { description: r.description }), ...(r.mimeType && { mimeType: r.mimeType }) }) as JsonObject), nextCursor: page.nextCursor };
  });
}

/** One resource's contents: text as it is, binary as its size (the bytes would swamp a model or an item). */
export async function readMcpResource(endpoint: McpEndpoint, uri: string): Promise<JsonObject[]> {
  if (!uri.trim()) throw new McpClientError('Enter the resource URI');
  return withReauth(endpoint, async () => {
    try {
      const result = await withMcpClient(endpoint, (client) => client.readResource({ uri }, timeoutOf(endpoint)));
      return result.contents.map((part): JsonObject => ('text' in part ? { uri: part.uri, ...(part.mimeType && { mimeType: part.mimeType }), text: part.text } : { uri: part.uri, ...(part.mimeType && { mimeType: part.mimeType }), bytes: Math.floor((String(part.blob).length * 3) / 4) }));
    } catch (error) {
      if (error instanceof ProtocolError || (error as { name?: string }).name === 'McpError') throw new McpClientError((error as Error).message);
      throw describe(error, endpoint);
    }
  });
}

/** The prompts a server lists. */
export async function listMcpPrompts(endpoint: McpEndpoint): Promise<JsonObject[]> {
  return allPages(endpoint, async (client, cursor) => {
    const page = await client.listPrompts(cursor ? { cursor } : undefined, timeoutOf(endpoint));
    return { items: page.prompts.map((p) => ({ name: p.name, ...(p.title && { title: p.title }), ...(p.description && { description: p.description }), ...(p.arguments && { arguments: p.arguments.map((a) => ({ name: a.name, ...(a.description && { description: a.description }), required: Boolean(a.required) })) }) }) as JsonObject), nextCursor: page.nextCursor };
  });
}

/** A prompt with its arguments filled in: the description and its messages (text as it is). */
export async function getMcpPrompt(endpoint: McpEndpoint, name: string, args: Record<string, string> = {}): Promise<JsonObject> {
  if (!name.trim()) throw new McpClientError('Enter the prompt name');
  return withReauth(endpoint, async () => {
    try {
      const result = await withMcpClient(endpoint, (client) => client.getPrompt({ name, arguments: args }, timeoutOf(endpoint)));
      return {
        ...(result.description && { description: result.description }),
        messages: result.messages.map((message): JsonObject => ({ role: message.role, content: compactContent({ content: [message.content] } as CallToolResult)[0] })),
      };
    } catch (error) {
      if (error instanceof ProtocolError || (error as { name?: string }).name === 'McpError') throw new McpClientError((error as Error).message);
      throw describe(error, endpoint);
    }
  });
}

/** A prompt's messages as one text (the text parts, each with its role): what an agent gets for a prompt. */
export function promptText(prompt: JsonObject): string {
  const messages = (prompt.messages as JsonObject[] | undefined) ?? [];
  return messages
    .map((message) => {
      const content = message.content as JsonObject;
      return `${message.role}: ${content.type === 'text' ? content.text : content.type === 'resource' && typeof content.text === 'string' ? content.text : JSON.stringify(content)}`;
    })
    .join('\n');
}

/**
 * Agent tools for a server's resources and prompts (`list_resources`, `read_resource`, `list_prompts`, `get_prompt`), the ones
 * the options of the MCP Client Tool ask for. A server without the capability makes the list tools answer "none".
 */
export function resourceAndPromptTools(endpoint: McpEndpoint, extras: ReadonlyArray<string>): AgentTool[] {
  const tools: AgentTool[] = [];
  if (extras.includes('resources')) {
    tools.push(
      { name: 'list_resources', description: 'List the resources (documents, files, data) this MCP server offers: each with a uri, a name and a description. Read one with read_resource.', inputSchema: { type: 'object', properties: {} }, invoke: async () => ({ resources: await listMcpResources(endpoint), templates: await listMcpResourceTemplates(endpoint).catch(() => []) }) },
      { name: 'read_resource', description: 'Read a resource of this MCP server by its uri (from list_resources, or a URI template filled in).', inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'The resource URI' } }, required: ['uri'] }, invoke: async (input) => ({ contents: await readMcpResource(endpoint, String(input.uri ?? '')) }) },
    );
  }
  if (extras.includes('prompts')) {
    tools.push(
      { name: 'list_prompts', description: 'List the prompt templates this MCP server offers, with their arguments. Use one with get_prompt.', inputSchema: { type: 'object', properties: {} }, invoke: async () => ({ prompts: await listMcpPrompts(endpoint) }) },
      {
        name: 'get_prompt',
        description: 'Get a prompt template of this MCP server with its arguments filled in: answers with the prompt messages to follow.',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The prompt name' }, arguments: { type: 'object', description: 'The prompt arguments, name to string value', additionalProperties: { type: 'string' } } }, required: ['name'] },
        invoke: async (input) => promptText(await getMcpPrompt(endpoint, String(input.name ?? ''), stringRecord(input.arguments))),
      },
    );
  }
  return tools;
}

/** An object's values as strings (prompt arguments are strings on the wire). */
export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, typeof v === 'string' ? v : JSON.stringify(v)]));
}
