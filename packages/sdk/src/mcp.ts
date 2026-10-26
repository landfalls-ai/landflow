/**
 * The MCP face (docs/transports.md "MCP: every plugin is also an MCP server", docs/protocol.md §15.2): every action
 * node's operations as MCP tools, with no code in the plugin.
 *
 * - **Streamable HTTP at `/mcp`** on the plugin's HTTP port (`serve(plugin, { http })`), stateless: `createMcpHandler`
 *   from `@modelcontextprotocol/server` 2.4.0 serves the 2026-07-28 revision (per-request `_meta` envelope,
 *   `server/discover`) and 2025-era clients (`initialize`, stateless) from the same factory. A `Bearer
 *   $LANDFLOW_MCP_TOKEN` is required unless the HTTP server listens on loopback only; a missing or wrong token is `401`
 *   with `WWW-Authenticate: Bearer`.
 * - **stdio** with `--mcp-stdio` or `LANDFLOW_MCP=stdio`: the plugin speaks MCP on stdin/stdout and nothing else (logs go
 *   to stderr), so a desktop agent can start it directly.
 * - **Tools** are `mcpToolsFromManifest(manifest)` (`@landflow/protocol`): `mcp: false` opt-outs, `outputSchema`,
 *   `toolAnnotations` and `idempotent` hints all come from the shared mapping; `_meta` (the node binding) is stripped from
 *   what agents see. A `list_options` tool exists when a tool has dynamic options and a credential is configured.
 * - **`tools/call`** → `toolCallToParameters()` → the dispatcher's Execute with `mode: 'mcp'`, the call's `AbortSignal`
 *   (the client closing the request's stream, `notifications/cancelled` on stdio) and the span attribute `mcp.tool.name`.
 *   Credentials come from `LANDFLOW_MCP_CREDENTIALS` (a JSON file path or inline JSON, `{ "<credentialType>": { …fields } }`
 *   by local type name); a tool whose node needs a credential that is not configured answers `isError: true` naming the
 *   missing type and its fields. The result is the node's first output as `structuredContent: { items }` plus a short
 *   text; a node error is `isError: true` with its message.
 */
import { readFileSync } from 'node:fs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from '@opentelemetry/api';
import {
  findMcpTool,
  MCP_TOOL_META_KEY,
  mcpToolsFromManifest,
  toolCallToParameters,
  withoutBinding,
  type ExecuteRequest,
  type ExecuteResponse,
  type JsonObject,
  type JsonValue,
  type McpToolDefinition,
  type NodeDescriptor,
  type NodeItem,
  type PluginManifest,
  type PropertyOption,
} from '@landflow/protocol';
import {
  createMcpHandler,
  INVALID_PARAMS,
  ProtocolError,
  Server,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type CallToolResult,
  type McpServerFactory,
  type ServerContext,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/server';
import { DispatchError, type DispatchCall, type Dispatcher } from './dispatcher';
import type { ProcessLogger } from './logger';
import { contextFromHeaders, type Telemetry } from './otel';
import { toErrorPayload } from './runtime';

export const MCP_ENV = 'LANDFLOW_MCP';
export const MCP_TOKEN_ENV = 'LANDFLOW_MCP_TOKEN';
export const MCP_CREDENTIALS_ENV = 'LANDFLOW_MCP_CREDENTIALS';
export const MCP_STDIO_FLAG = '--mcp-stdio';
export const DEFAULT_MCP_PATH = '/mcp';
/** The name of the read-only tool that resolves dynamic options (`loadOptions`) for another tool's parameter. */
export const LIST_OPTIONS_TOOL = 'list_options';

/** How the MCP face runs: `http` (at `/mcp` on the HTTP port, the default), `stdio` (MCP on stdin/stdout, nothing else) or `off`. */
export type McpMode = 'http' | 'stdio' | 'off';

/**
 * The mode from `--mcp-stdio` (argv), `LANDFLOW_MCP` (`on`, `off`, `stdio`) and the `serve()` option (`false` turns it
 * off; `{ stdio: true }` picks stdio), in that order of precedence. Default `http`.
 */
export function mcpMode(option: { enabled?: boolean; stdio?: boolean } | false | undefined, env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv): McpMode {
  if (argv.includes(MCP_STDIO_FLAG)) return 'stdio';
  const value = env[MCP_ENV]?.trim().toLowerCase();
  if (value === 'stdio') return 'stdio';
  if (value === 'off' || value === 'false' || value === '0') return 'off';
  if (value && value !== 'on' && value !== 'true' && value !== '1' && value !== 'http') throw new Error(`${MCP_ENV}="${env[MCP_ENV]}" is not one of on, off, stdio`);
  if (option === false || option?.enabled === false) return 'off';
  if (option && option.stdio) return 'stdio';
  return 'http';
}

/** Is a listen host loopback only (so `/mcp` may run without a token)? */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * The credentials a standalone plugin uses for its tools, from `LANDFLOW_MCP_CREDENTIALS`: a path to a JSON file or
 * inline JSON, `{ "<credentialType>": { …fields } }` keyed by the local credential type name. Empty when unset.
 */
export function loadMcpCredentials(value: string | undefined = process.env[MCP_CREDENTIALS_ENV]): Record<string, JsonObject> {
  const text = value?.trim();
  if (!text) return {};
  const inline = text.startsWith('{') || text.startsWith('[');
  const source = inline ? text : readFileSync(text, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${MCP_CREDENTIALS_ENV} is not valid JSON${inline ? '' : ` (file ${text})`}: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${MCP_CREDENTIALS_ENV} must be a JSON object keyed by credential type`);
  const credentials: Record<string, JsonObject> = {};
  for (const [type, fields] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error(`${MCP_CREDENTIALS_ENV}: "${type}" must be an object of fields`);
    credentials[type.slice(type.lastIndexOf('.') + 1)] = fields as JsonObject;
  }
  return credentials;
}

/** Constant-time check of `Authorization: Bearer <token>`. */
export function bearerTokenMatches(header: string | null | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  if (!match) return false;
  const a = createHash('sha256').update(match[1]).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

export interface McpFaceOptions {
  dispatcher: Dispatcher;
  /** The served manifest (the dispatcher's, hints included). */
  manifest?: PluginManifest;
  telemetry?: Telemetry;
  logger?: ProcessLogger;
  /** Credentials by local type name (`loadMcpCredentials()`); default from the environment. */
  credentials?: Record<string, JsonObject>;
  /** Required on `/mcp` unless `loopback`; absent on stdio. */
  token?: string;
  /** The HTTP server listens on loopback only, so no token is needed. */
  loopback?: boolean;
  /** Reported in the 401 challenge. Default `landflow-plugin`. */
  realm?: string;
}

export interface McpFace {
  /** The tools as `tools/list` returns them (without `_meta`). */
  readonly tools: Tool[];
  /** The factory a transport entry (`createMcpHandler`, `serveStdio`) builds a per-request or per-connection server from. */
  readonly factory: McpServerFactory;
  /** Serve one `/mcp` HTTP request (token checked here). */
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface ToolRuntime {
  definition: McpToolDefinition;
  node: NodeDescriptor | undefined;
}

const text = (value: string): CallToolResult['content'][number] => ({ type: 'text', text: value });
const toolError = (message: string): CallToolResult => ({ isError: true, content: [text(message)] });

/** "a (fields: x, y)" for the error that names a missing credential. */
function describeCredential(manifest: PluginManifest, type: string): string {
  const descriptor = manifest.credentialTypes?.find((c) => c.name === type);
  const fields = descriptor?.properties.map((p) => p.name) ?? [];
  return fields.length ? `${type} (fields: ${fields.join(', ')})` : type;
}

/**
 * Which configured credentials a node call gets, and the credential-selector parameters that pick them. A node whose
 * credentials are all unconfigured gets an error naming the missing types when any of them is required.
 */
function bindCredentials(node: NodeDescriptor | undefined, runtime: ToolRuntime, manifest: PluginManifest, configured: Record<string, JsonObject>): { credentials?: Record<string, JsonObject>; selectors: JsonObject } | { error: string } {
  const wanted = node?.credentials ?? [];
  if (!wanted.length) return { selectors: {} };
  const credentials: Record<string, JsonObject> = {};
  const selectors: JsonObject = {};
  const binding = runtime.definition._meta[MCP_TOOL_META_KEY];
  for (const credential of wanted) {
    const value = configured[credential.name];
    if (!value) continue;
    credentials[credential.name] = value;
    for (const selector of binding.credentialSelectors) {
      if (selector.byCredential[credential.name] !== undefined && selectors[selector.parameter] === undefined) selectors[selector.parameter] = selector.byCredential[credential.name];
    }
  }
  if (!Object.keys(credentials).length && wanted.some((c) => c.required)) {
    const missing = wanted.map((c) => describeCredential(manifest, c.name)).join(' or ');
    return { error: `This tool needs a credential that is not configured: ${missing}. Set ${MCP_CREDENTIALS_ENV} to a JSON file or inline JSON { "<credentialType>": { …fields } }.` };
  }
  return { ...(Object.keys(credentials).length && { credentials }), selectors };
}

/** The node's first output as `structuredContent: { items }` plus a short text, or `isError` with the node's message. */
export function toolResultFromResponse(response: ExecuteResponse, ignored: string[] = []): CallToolResult {
  if (response.error) {
    const { message, description } = response.error;
    return toolError(description ? `${message}\n${description}` : message);
  }
  const items: NodeItem[] = response.outputs[0] ?? [];
  const json = items.map((item) => item.json);
  // Arguments the tool's schema does not declare are not node parameters; they only reach the node as fields of the input item.
  const note = ignored.length ? ` (arguments outside this tool's schema, passed only as input item fields: ${ignored.join(', ')})` : '';
  const summary = json.length === 1 ? JSON.stringify(json[0]) : `${json.length} item${json.length === 1 ? '' : 's'}`;
  return { content: [text(`${summary}${note}`)], structuredContent: { items: json as JsonValue[] } };
}

/** The W3C trace context of a tool call: `_meta.traceparent` (the MCP convention), else the HTTP request's headers. */
function traceContext(telemetry: Telemetry, ctx: ServerContext): Context {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  const headers = new Headers();
  const traceparent = meta?.[TRACEPARENT_META_KEY];
  if (typeof traceparent === 'string') {
    headers.set('traceparent', traceparent);
    const tracestate = meta?.[TRACESTATE_META_KEY];
    if (typeof tracestate === 'string') headers.set('tracestate', tracestate);
  } else {
    ctx.http?.req?.headers.forEach((value, key) => headers.set(key, value));
  }
  return contextFromHeaders(telemetry, headers);
}

const invalidParams = (message: string) => new ProtocolError(INVALID_PARAMS, message);

/**
 * The MCP face over a dispatcher: the tools of the served manifest, a server factory for the MCP SDK's transport
 * entries, and the token-checking `fetch` for `/mcp`.
 */
export function createMcpFace(options: McpFaceOptions): McpFace {
  const { dispatcher } = options;
  const manifest = options.manifest ?? dispatcher.manifest;
  const telemetry = () => options.telemetry ?? dispatcher.telemetry;
  const log = options.logger ?? dispatcher.telemetry.logger;
  const configured = options.credentials ?? loadMcpCredentials();
  const nodes = new Map(manifest.nodes.map((node) => [node.name, node]));
  const definitions = mcpToolsFromManifest(manifest);
  const runtimes = new Map<string, ToolRuntime>(definitions.map((definition) => [definition.name, { definition, node: nodes.get(definition._meta[MCP_TOOL_META_KEY].nodeName) }]));
  const dynamic = definitions.some((d) => d._meta[MCP_TOOL_META_KEY].dynamicOptions.length > 0) && Object.keys(configured).length > 0;

  const tools: Tool[] = definitions.map((definition) => withoutBinding(definition) as unknown as Tool);
  if (dynamic && !runtimes.has(LIST_OPTIONS_TOOL)) {
    tools.push({
      name: LIST_OPTIONS_TOOL,
      title: 'List options',
      description: 'The values a tool argument with a dynamic list accepts (resolved with the configured credential): pass the tool name, the parameter and, when the list depends on other arguments, those arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The tool whose argument has a dynamic list.', enum: definitions.filter((d) => d._meta[MCP_TOOL_META_KEY].dynamicOptions.length).map((d) => d.name) },
          parameter: { type: 'string', description: 'The argument (a path like `channel` or `options/labels`).' },
          arguments: { type: 'object', description: 'Other arguments the list depends on.' },
        },
        required: ['tool', 'parameter'],
      },
      outputSchema: { type: 'object', properties: { options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] } } }, required: ['options'] },
      annotations: { title: 'List options', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    });
  }

  const callFor = (ctx: ServerContext, attributes: DispatchCall['attributes']): DispatchCall => ({
    transport: 'mcp',
    signal: ctx.mcpReq.signal,
    parent: traceContext(telemetry(), ctx),
    attributes,
  });

  const executeTool = async (runtime: ToolRuntime, args: JsonObject | undefined, ctx: ServerContext): Promise<CallToolResult> => {
    const { definition, node } = runtime;
    const mapping = toolCallToParameters(definition, args);
    const bound = bindCredentials(node, runtime, manifest, configured);
    if ('error' in bound) return toolError(bound.error);
    const parameters: JsonObject = { ...bound.selectors, ...mapping.parameters };
    const request: ExecuteRequest = {
      protocol: manifest.protocol,
      executionId: `mcp_${randomUUID()}`,
      mode: 'mcp',
      node: { id: `mcp-${definition.name}`, name: node?.displayName ?? definition.title, type: mapping.nodeType, typeVersion: mapping.typeVersion },
      parameters,
      itemParameters: [parameters],
      inputs: [[{ json: args ?? {} }]],
      ...(bound.credentials && { credentials: bound.credentials }),
    };
    try {
      const response = await dispatcher.execute(request, callFor(ctx, { 'mcp.tool.name': definition.name }));
      return toolResultFromResponse(response, mapping.ignored);
    } catch (error) {
      if (error instanceof DispatchError) {
        if (error.code === 'unknown_node') throw invalidParams(error.message);
        if (error.code === 'capacity') return toolError(`${error.message}; try again shortly`);
        throw error;
      }
      throw error;
    }
  };

  const listOptions = async (args: JsonObject | undefined, ctx: ServerContext): Promise<CallToolResult> => {
    const toolName = typeof args?.tool === 'string' ? args.tool : undefined;
    const parameter = typeof args?.parameter === 'string' ? args.parameter : undefined;
    if (!toolName || !parameter) throw invalidParams(`${LIST_OPTIONS_TOOL} needs "tool" and "parameter"`);
    const runtime = runtimes.get(toolName);
    if (!runtime) throw invalidParams(`Unknown tool "${toolName}"`);
    const binding = runtime.definition._meta[MCP_TOOL_META_KEY];
    const option = binding.dynamicOptions.find((d) => d.parameter === parameter);
    if (!option) throw invalidParams(`"${parameter}" of ${toolName} has no dynamic options`);
    const nested = typeof args?.arguments === 'object' && args.arguments !== null && !Array.isArray(args.arguments) ? (args.arguments as JsonObject) : undefined;
    const mapping = toolCallToParameters(runtime.definition, nested);
    const bound = bindCredentials(runtime.node, runtime, manifest, configured);
    if ('error' in bound) return toolError(bound.error);
    try {
      const options: PropertyOption[] = await dispatcher.loadOptions(
        { nodeType: binding.nodeType, method: option.method, parameters: { ...bound.selectors, ...mapping.parameters }, ...(bound.credentials && { credentials: bound.credentials }) },
        callFor(ctx, { 'mcp.tool.name': LIST_OPTIONS_TOOL, 'landflow.load_options.tool': toolName }),
      );
      return { content: [text(`${options.length} option${options.length === 1 ? '' : 's'}`)], structuredContent: { options: options as unknown as JsonValue[] } };
    } catch (error) {
      if (error instanceof DispatchError) throw error;
      return toolError(toErrorPayload(error).message);
    }
  };

  const factory: McpServerFactory = () => {
    const server = new Server({ name: manifest.plugin.id, title: manifest.plugin.name, version: manifest.plugin.version }, { capabilities: { tools: {} }, instructions: manifest.plugin.description });
    server.setRequestHandler('tools/list', async () => ({ tools }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const name = request.params.name;
      const raw = request.params.arguments;
      if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw invalidParams('"arguments" must be an object');
      const args = raw as JsonObject | undefined;
      if (name === LIST_OPTIONS_TOOL && dynamic) return listOptions(args, ctx);
      const runtime = runtimes.get(name);
      if (!runtime) throw invalidParams(`Unknown tool "${name}"`);
      return executeTool(runtime, args, ctx);
    });
    return server;
  };

  const handler = createMcpHandler(factory, {
    legacy: 'stateless',
    onerror: (error) => log.warn('MCP request failed', { error: error.message, 'landflow.transport': 'mcp' }),
  });
  const realm = options.realm ?? 'landflow-plugin';
  const needsToken = !options.loopback;

  return {
    tools,
    factory,
    async fetch(request) {
      if (needsToken) {
        if (!options.token) return new Response(JSON.stringify({ error: 'MCP is not configured with a token' }), { status: 503, headers: { 'content-type': 'application/json' } });
        if (!bearerTokenMatches(request.headers.get('authorization'), options.token)) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer realm="${realm}"` } });
        }
      }
      return handler.fetch(request);
    },
    close: () => handler.close(),
  };
}

/** `tools/list` for a manifest, as the face serves it (for tests and the host): the shared mapping without `_meta`. */
export function mcpToolsForListing(manifest: PluginManifest): Tool[] {
  return mcpToolsFromManifest(manifest).map((tool) => withoutBinding(tool) as unknown as Tool);
}

/**
 * Serve MCP over stdio (`--mcp-stdio` / `LANDFLOW_MCP=stdio`): both eras (`server/discover` and the 2025 handshake), no
 * token. The caller must keep stdout for MCP (logs go to stderr). Resolves with a handle; `close()` ends the session.
 */
export async function serveMcpStdio(face: McpFace, options: { logger?: ProcessLogger; transport?: Transport } = {}): Promise<{ close(): Promise<void> }> {
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const handle = serveStdio(face.factory, {
    legacy: 'serve',
    ...(options.transport && { transport: options.transport }),
    onerror: (error) => options.logger?.warn('MCP stdio error', { error: error.message, 'landflow.transport': 'mcp' }),
  });
  return { close: () => handle.close() };
}

export { findMcpTool };
