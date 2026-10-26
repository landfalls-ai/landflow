/**
 * The host's per-plugin MCP endpoints (docs/transports.md "MCP: every plugin is also an MCP server", docs/protocol.md
 * §15.3): one MCP server per exposed plugin at /api/mcp/plugins/<pluginId>, and the in-process core nodes at
 * /api/mcp/plugins/core. Behind the bundled gateway (agentgateway) they are its targets; the gateway prefixes each
 * tool with the plugin id (`gatewayToolName()`).
 *
 * - **Tools** come from the plugin's current manifest through `@landflow/protocol`'s `mcpToolsFromDescriptors()`
 *   (one tool per resource × operation; `usableAsTool` nodes minus `mcp: false`), cached per plugin by ./grants.ts.
 *   Only exposed plugins answer (./exposure.ts); `tools/list` is filtered by the caller's grants and the governance
 *   allow-lists, and served with `cacheScope: private`.
 * - **A call** is an execution with mode `mcp` (a one-node workflow `mcp_<pluginId>` saved with the execution, so
 *   Executions shows the caller, the tool, the inputs and the outputs) run through the normal runner: the registry's
 *   client path applies the plugin's transport policy, the governance policy and the plugin's health. Credentials are
 *   bound on the way in and never seen by the agent: the grant's, else the ones the call's `_meta["dev.landflow/node"]`
 *   names (`{ credentials: { <type>: <credential id> } }`), else the caller's newest credential of each type the node
 *   uses, all limited to the credentials the caller's projects may use. Output items are `structuredContent`
 *   (`{ items }`, per the tool's `outputSchema`) plus a text copy; a failed run is a result with `isError: true`.
 * - **Audit** `mcp.tool.call` (caller, tool, outcome, execution id; never the arguments); span `mcp.tool.call` with
 *   `mcp.tool.name`, `landflow.plugin.id`, `landflow.mcp.caller`; metric `landflow.mcp.tool.calls`.
 * - **`tools/list_changed`**: the `core` endpoint tells its 2026-07-28 subscribers (`subscriptions/listen`) whenever
 *   the registry adds, changes, loses or removes a plugin or an exposure flips (the gateway relays an upstream's
 *   notification but emits none of its own); a plugin's own endpoint does the same for its own changes.
 *
 * Both protocol eras are served (./server.ts). Who may call: ./identity.ts (the gateway secret with the caller the
 * gateway validated, a Landflow MCP token, an identity provider token, an API key or a session).
 */
import { context } from '@opentelemetry/api';
import { ProtocolError, ProtocolErrorCode, Server, type AuthInfo, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { gatewayToolName, MCP_TOOL_META_KEY, toolCallToParameters, withoutBinding, type JsonObject, type McpToolDefinition } from '@landflow/protocol';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { MCP_EXECUTION_META_KEY, type McpToolsResponse, type McpToolView } from '../../shared/mcp';
import type { ExecutionMcpInfo, ExecutionRecord, PluginSummary, RegistryEvent } from '../../shared/types';
import type { Role } from '../../shared/auth';
import { recordAudit } from '../audit';
import { bus } from '../bus';
import { credentials } from '../credentials/vault';
import { nodeTypeBlocked } from '../governance/policy';
import { registry } from '../plugins/registry';
import { visibleIds } from '../projects/access';
import { publicUrl, runWorkflow } from '../runner';
import { singleton } from '../singleton';
import { failSpan, logger, startSpan } from '../telemetry';
import { hostMetrics } from '../telemetry/metrics';
import { mcpExposure } from './exposure';
import { pluginTools } from './grants';
import { authenticateMcpRequest, callableTool, listableTools, McpAuthError, mcpAuthErrorResponse, type McpCaller } from './identity';
import { jsonRpcError, notifyToolsChanged, serveMcpEndpoint, textResult } from './server';

export const CORE_PLUGIN_ID = 'core';
/** Where the endpoints live on this host. */
export const PLUGIN_MCP_PATH = '/api/mcp/plugins';
export const pluginMcpPath = (pluginId: string) => `${PLUGIN_MCP_PATH}/${encodeURIComponent(pluginId)}`;
/** The id of the one-node workflow an endpoint's calls run as (one per plugin, so Executions groups them). */
export const mcpWorkflowId = (pluginId: string) => `mcp_${pluginId}`;
const TOOL_NODE_ID = 'tool';
/** A call runs at most this long (LANDFLOW_MCP_TOOL_TIMEOUT_SECONDS), unless the request's `x-landflow-deadline` is sooner. */
const DEFAULT_TIMEOUT_SECONDS = 120;
/** The text copy of the output is clipped here (the structured content carries everything). */
const MAX_TEXT_BYTES = 256 * 1024;
const LIST_CHANGED_DEBOUNCE_MS = 250;

const endpointKey = (pluginId: string) => `plugin:${pluginId}`;
const callerLabel = (caller: McpCaller) => `${caller.kind}:${caller.subject}`;

/** What a `tools/call` may carry under `_meta["dev.landflow/node"]`: which credential to bind per credential type. */
interface CallMeta {
  credentials?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function pluginSummary(pluginId: string): PluginSummary | undefined {
  return registry.list().find((plugin) => plugin.id === pluginId);
}

/** A tool as the tool browser shows it. */
function toolView(plugin: PluginSummary, tool: McpToolDefinition): McpToolView {
  const binding = tool._meta[MCP_TOOL_META_KEY];
  const blocked = nodeTypeBlocked(binding.nodeType);
  return {
    pluginId: plugin.id,
    pluginName: plugin.info.name,
    name: tool.name,
    gatewayName: gatewayToolName(plugin.id, tool.name),
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
    nodeType: binding.nodeType,
    typeVersion: binding.typeVersion,
    ...(binding.resource && { resource: binding.resource }),
    ...(binding.operation && { operation: binding.operation }),
    credentials: binding.credentials.map((name) => qualifyCredentialType(plugin.id, name)),
    ...(blocked && { blocked: blocked.message }),
    online: plugin.status === 'online',
  };
}

/** Every tool of every exposed plugin (GET /api/mcp/tools: the tool browser in Settings → MCP). */
export function exposedTools(): McpToolsResponse {
  const plugins = registry.list().filter((plugin) => mcpExposure.isExposed(plugin.id));
  return {
    tools: plugins.flatMap((plugin) => pluginTools(plugin.id).map((tool) => toolView(plugin, tool))),
    plugins: plugins.map((plugin) => ({ id: plugin.id, name: plugin.info.name, path: pluginMcpPath(plugin.id), tools: pluginTools(plugin.id).length, online: plugin.status === 'online' })),
  };
}

/** How many tools a plugin's manifest maps to (the Plugins page). */
export function pluginToolCount(pluginId: string): number {
  return pluginTools(pluginId).length;
}

/** A tool definition as the client sees it: without the Landflow binding, and with the shapes the SDK expects. */
function wireTool(tool: McpToolDefinition): Tool {
  const { annotations, ...rest } = withoutBinding(tool);
  return { ...rest, annotations } as unknown as Tool;
}

/** The tools `caller` sees on `pluginId`: the grants' choice, minus nodes the governance policy blocks. */
function visibleTools(caller: McpCaller, pluginId: string) {
  return listableTools(caller, pluginId).filter((entry) => !nodeTypeBlocked(entry.tool._meta[MCP_TOOL_META_KEY].nodeType));
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** A node's credential slot (`twilioApi`, `core.httpBearerAuth`) as the vault's fully qualified type. */
function qualifyCredentialType(pluginId: string, name: string): string {
  return name.includes('.') ? name : `${pluginId}.${name}`;
}

interface BoundCredentials {
  /** By the node's slot name, as the runner expects them. */
  credentials: Record<string, { id: string; name: string }>;
  /** Credential selector parameters (`authentication`) set for the bound type. */
  parameters: JsonObject;
  /** Why the call cannot run (a named credential the caller may not use, or of the wrong type). */
  error?: string;
}

/**
 * Bind credentials for a call: for each credential slot of the node, the grant's credential for that type, else the
 * one `_meta` names, else the caller's newest credential of that type. Only credentials the caller's projects may use
 * count (a grant's choice is trusted: it was made by an admin from the project's credentials). A slot without any
 * stays empty; the vault then fails the run only when the node requires it.
 */
function bindCredentials(caller: McpCaller, pluginId: string, tool: McpToolDefinition, granted: Record<string, string>, requested: Record<string, string> | undefined): BoundCredentials {
  const binding = tool._meta[MCP_TOOL_META_KEY];
  const out: BoundCredentials = { credentials: {}, parameters: {} };
  if (!binding.credentials.length) return out;
  const all = credentials.list();
  const visible = caller.userId ? visibleIds({ id: caller.userId, role: (caller.role ?? 'member') as Role }, 'credential', all.map((c) => c.id)) : new Set<string>();
  const mayUse = (id: string) => !visible || visible.has(id);
  const who = callerLabel(caller);
  let selected = false;
  for (const slot of binding.credentials) {
    const type = qualifyCredentialType(pluginId, slot);
    const fromGrant = granted[type] ?? granted[slot];
    const wanted = fromGrant ?? requested?.[type] ?? requested?.[slot];
    let chosen: { id: string; name: string } | undefined;
    if (wanted) {
      const credential = all.find((c) => c.id === wanted);
      if (!credential) return { ...out, error: `Credential ${wanted} (for ${type}) does not exist` };
      if (credential.type !== type) return { ...out, error: `Credential "${credential.name}" is a ${credential.type}, not a ${type}` };
      if (!fromGrant && !mayUse(credential.id)) return { ...out, error: `Credential "${credential.name}" is not available to ${who}` };
      chosen = { id: credential.id, name: credential.name };
    } else {
      const candidate = all.filter((c) => c.type === type && mayUse(c.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (candidate) chosen = { id: candidate.id, name: candidate.name };
    }
    if (!chosen) continue;
    out.credentials[slot] = chosen;
    // The parameter that picks the auth method (`authentication: oAuth2`): set for the first slot that has a credential.
    if (!selected) {
      for (const selector of binding.credentialSelectors) {
        if (slot in selector.byCredential) {
          out.parameters[selector.parameter] = selector.byCredential[slot];
          selected = true;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The deadline of a call: the request's `x-landflow-deadline` (epoch ms) when sooner than the default. */
function timeoutSeconds(request: Request | undefined): number {
  const fallback = Number(process.env.LANDFLOW_MCP_TOOL_TIMEOUT_SECONDS) || DEFAULT_TIMEOUT_SECONDS;
  const deadline = Number(request?.headers.get('x-landflow-deadline'));
  if (!Number.isFinite(deadline) || deadline <= 0) return fallback;
  return Math.max(1, Math.min(fallback, Math.ceil((deadline - Date.now()) / 1000)));
}

function clip(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
  return `${text.slice(0, MAX_TEXT_BYTES)}\n… (text clipped at ${MAX_TEXT_BYTES} bytes; structuredContent has every item)`;
}

/** What a finished run answers: the node's output items, or an error result naming the execution. */
function callResult(record: ExecutionRecord): CallToolResult {
  const url = `${publicUrl()}/workflows/${record.workflowId}/executions/${record.executionId}`;
  const meta = { [MCP_EXECUTION_META_KEY]: { id: record.executionId, status: record.status, url } };
  if (record.status !== 'success') {
    return { ...textResult(`${record.error?.message ?? `The run ended as ${record.status}`} (execution ${record.executionId})`, true), _meta: meta };
  }
  const run = record.runData[TOOL_NODE_ID]?.filter((r) => r.source === 'main').at(-1);
  const items = run?.outputs?.[0] ?? [];
  const files = items.flatMap((item) => Object.values(item.binary ?? {}).map((file) => file.fileName ?? file.mimeType ?? 'file'));
  const structuredContent = { items: items.map((item) => item.json) };
  const text = clip(JSON.stringify(structuredContent.items, null, 2));
  return {
    content: [{ type: 'text', text: files.length ? `${text}\n(${files.length} file(s) in the output: ${files.join(', ')}; see execution ${record.executionId})` : text }],
    structuredContent,
    _meta: meta,
  };
}

/** One tool call as an execution with mode `mcp`, audited and traced; failures come back as error results. */
async function callTool(plugin: PluginSummary, caller: McpCaller, tool: McpToolDefinition, granted: Record<string, string>, args: JsonObject, meta: CallMeta | undefined, request: Request | undefined): Promise<CallToolResult> {
  const mapping = toolCallToParameters(tool, args);
  const bound = bindCredentials(caller, plugin.id, tool, granted, meta?.credentials);
  if (bound.error) {
    audit(plugin, caller, tool.name, 'denied', { reason: bound.error });
    return textResult(bound.error, true);
  }
  const timeout = timeoutSeconds(request);
  const node: WorkflowNode = {
    id: TOOL_NODE_ID,
    name: tool.title,
    type: mapping.nodeType,
    typeVersion: mapping.typeVersion,
    position: [0, 0],
    parameters: { ...mapping.parameters, ...bound.parameters },
    timeoutSeconds: timeout,
    ...(Object.keys(bound.credentials).length && { credentials: bound.credentials }),
  };
  const workflow: Workflow = { id: mcpWorkflowId(plugin.id), name: `${plugin.info.name} · MCP`, nodes: [node], connections: [], settings: { timeoutSeconds: timeout } };
  const info: ExecutionMcpInfo = { pluginId: plugin.id, tool: tool.name, caller: callerLabel(caller), ...(caller.userId && { userId: caller.userId }) };
  const { span, context: active } = startSpan('mcp.tool.call', {
    attributes: { 'mcp.tool.name': tool.name, 'landflow.plugin.id': plugin.id, 'landflow.mcp.caller': info.caller, ...(mapping.ignored.length && { 'landflow.mcp.ignored_arguments': mapping.ignored.join(',') }) },
  });
  const startedAt = Date.now();
  try {
    const record = await context.with(active, () => runWorkflow({ workflow, mode: 'mcp', startNodeId: TOOL_NODE_ID, triggerItems: [{ json: args }], signal: request?.signal, mcp: info }));
    span.setAttribute('landflow.execution.id', record.executionId);
    const outcome = record.status === 'success' ? 'success' : 'failure';
    hostMetrics().mcpToolCalls.add(1, { 'landflow.plugin.id': plugin.id, 'mcp.tool.name': tool.name, 'landflow.mcp.outcome': outcome });
    audit(plugin, caller, tool.name, outcome, { executionId: record.executionId, status: record.status, durationMs: Date.now() - startedAt, ...(record.error && { error: record.error.message }) });
    if (record.status !== 'success') failSpan(span, record.error?.message ?? record.status);
    return callResult(record);
  } catch (error) {
    failSpan(span, error);
    hostMetrics().mcpToolCalls.add(1, { 'landflow.plugin.id': plugin.id, 'mcp.tool.name': tool.name, 'landflow.mcp.outcome': 'failure' });
    audit(plugin, caller, tool.name, 'failure', { error: (error as Error).message, durationMs: Date.now() - startedAt });
    return textResult((error as Error).message, true);
  } finally {
    span.end();
  }
}

function audit(plugin: PluginSummary, caller: McpCaller, tool: string, outcome: 'success' | 'failure' | 'denied', details: Record<string, unknown>) {
  try {
    recordAudit({
      action: 'mcp.tool.call',
      outcome,
      target: { type: 'plugin', id: plugin.id, name: plugin.info.name },
      summary: `${outcome === 'success' ? 'Called' : outcome === 'denied' ? 'Refused' : 'Failed'} MCP tool ${tool} of ${plugin.info.name}`,
      details: { tool, gatewayTool: gatewayToolName(plugin.id, tool), caller: callerLabel(caller), callerKind: caller.kind, viaGateway: caller.viaGateway, ...(caller.tokenId && { tokenId: caller.tokenId }), ...details },
      actor: caller.userId ? { id: caller.userId } : 'anonymous',
      project: null,
    });
  } catch (error) {
    logger.warn('mcp audit failed', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function instructionsFor(plugin: PluginSummary, count: number): string {
  const what = plugin.id === CORE_PLUGIN_ID ? 'Landflow’s built-in nodes (HTTP requests, data tables, workflows, agents…)' : `the ${plugin.info.name} plugin${plugin.info.description ? ` (${plugin.info.description})` : ''}`;
  return `${count} tool(s) of ${what}, one per operation. Each call runs as a Landflow execution; credentials are bound by Landflow, never passed as arguments.`;
}

/** The caller the endpoint authenticated, carried to the handlers in `authInfo.extra`. */
function callerOf(authInfo: AuthInfo | undefined): McpCaller | undefined {
  return (authInfo?.extra as { caller?: McpCaller } | undefined)?.caller;
}

/** A stateless MCP server for one request to a plugin's endpoint. */
export function pluginServer(plugin: PluginSummary, caller: McpCaller, request?: Request): Server {
  const tools = visibleTools(caller, plugin.id);
  const server = new Server(
    { name: `landflow-${plugin.id}`, title: plugin.info.name, version: plugin.info.version },
    { capabilities: { tools: { listChanged: true } }, instructions: instructionsFor(plugin, tools.length), cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } } },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: tools.map((entry) => wireTool(entry.tool)) }));
  server.setRequestHandler('tools/call', async (req) => {
    const name = req.params.name;
    const listed = tools.find((entry) => entry.tool.name === name);
    if (!listed) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool "${name}"`);
    const callable = callableTool(caller, plugin.id, name);
    if (!callable) {
      audit(plugin, caller, name, 'denied', { reason: 'no grant allows calling it' });
      return textResult(`${callerLabel(caller)} may list ${name} but has no grant to call it`, true);
    }
    const meta = (req.params._meta as Record<string, unknown> | undefined)?.[MCP_TOOL_META_KEY] as CallMeta | undefined;
    const result = await callTool(plugin, caller, callable.tool, callable.credentials, (req.params.arguments ?? {}) as JsonObject, meta, request);
    return server.projectCallToolResult(result, callable.tool.outputSchema);
  });
  return server;
}

/** The `authInfo` an endpoint hands the SDK: the caller rides in `extra`. */
function authInfoFor(caller: McpCaller): AuthInfo {
  return { token: '', clientId: caller.subject, scopes: caller.scopes, extra: { caller } };
}

/** Everything /api/mcp/plugins/<id> does: authenticate, find the exposed plugin, serve the request (both protocol eras). */
export async function handlePluginMcpRequest(request: Request, pluginId: string): Promise<Response> {
  startListChangedRelay();
  let caller: McpCaller;
  try {
    caller = await authenticateMcpRequest(request, { pluginId });
  } catch (error) {
    if (error instanceof McpAuthError) return mcpAuthErrorResponse(error);
    throw error;
  }
  const plugin = pluginSummary(pluginId);
  if (!plugin || !mcpExposure.isExposed(pluginId)) return jsonRpcError(404, -32001, `No MCP endpoint for plugin "${pluginId}": it is not installed or not exposed to agents`);
  return serveMcpEndpoint(
    endpointKey(pluginId),
    request,
    (info) => {
      const who = callerOf(info.authInfo);
      if (!who) throw new Error('The MCP endpoint lost its caller');
      // The plugin as it is now (a manifest change between requests shows at once).
      return pluginServer(pluginSummary(pluginId) ?? plugin, who, info.request);
    },
    authInfoFor(caller),
  );
}

// ---------------------------------------------------------------------------
// tools/list_changed
// ---------------------------------------------------------------------------

const RELEVANT: ReadonlySet<RegistryEvent['type']> = new Set(['plugin.registered', 'plugin.updated', 'plugin.offline', 'plugin.removed']);

/** Tell a plugin endpoint's 2026-07-28 subscribers its tool list changed (the gateway sync does this on `core` after a target change). */
export function notifyPluginToolsChanged(pluginId: string): boolean {
  return notifyToolsChanged(endpointKey(pluginId));
}

/**
 * Relay registry changes to the endpoints' `subscriptions/listen` streams: the changed plugin's own endpoint and the
 * `core` endpoint (always registered in the gateway, so agents listening through it learn of every plugin that comes
 * or goes). Events are coalesced for a moment: a re-pull emits several in a row.
 */
export function startListChangedRelay(): () => void {
  const state = singleton('mcp-list-changed-relay', () => ({ stop: undefined as undefined | (() => void), timers: new Map<string, ReturnType<typeof setTimeout>>() }));
  if (state.stop) return state.stop;
  const schedule = (pluginId: string) => {
    clearTimeout(state.timers.get(pluginId));
    const timer = setTimeout(() => {
      state.timers.delete(pluginId);
      notifyToolsChanged(endpointKey(pluginId));
    }, LIST_CHANGED_DEBOUNCE_MS);
    timer.unref?.();
    state.timers.set(pluginId, timer);
  };
  const unsubscribe = bus.subscribe((event) => {
    if (event.channel !== 'registry' || !RELEVANT.has(event.event.type)) return;
    const pluginId = 'pluginId' in event.event ? event.event.pluginId : undefined;
    if (pluginId && pluginId !== CORE_PLUGIN_ID) schedule(pluginId);
    schedule(CORE_PLUGIN_ID);
  });
  state.stop = () => {
    unsubscribe();
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.timers.clear();
    state.stop = undefined;
  };
  return state.stop;
}
