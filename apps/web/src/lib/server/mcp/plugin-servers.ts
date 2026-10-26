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
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError, Server, type AuthInfo, type CallToolResult, type InputRequiredResult, type Tool } from '@modelcontextprotocol/server';
import {
  gatewayToolName,
  listOptionsToolDefinition,
  MCP_LIST_OPTIONS_TOOL,
  MCP_TOOL_META_KEY,
  toolCallToParameters,
  withDynamicOptionValues,
  withoutBinding,
  type JsonObject,
  type McpToolDefinition,
  type PropertyOption,
} from '@landflow/protocol';
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
import { needsApproval } from './approval-mode';
import { requireApproval, type ApprovalOutcome } from './approvals';
import { bindCredentials, callerLabel, qualifyCredentialType, type BoundCredentials } from './bind';
import { mcpExposure } from './exposure';
import { fileBlocks } from './files';
import { pluginTools, type EffectiveTool } from './grants';
import { authenticateMcpRequest, callableTool, listableTools, listableTriggers, McpAuthError, mcpAuthErrorResponse, type McpCaller } from './identity';
import { optionsCacheTtlMs, recalledOptions, rememberOptions, type LookupKey } from './options';
import { jsonRpcError, listenRefusal, notifyToolsChanged, serveMcpEndpoint, textResult } from './server';
import { callerSubscriptions, McpTriggerError, openTriggerSubscriptions, readTriggerResource } from './triggers';

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
/** Bind credentials for a tool call (./bind.ts). */
const bindTool = (caller: McpCaller, pluginId: string, tool: McpToolDefinition, granted: Record<string, string>, requested: Record<string, string> | undefined) =>
  bindCredentials(caller, pluginId, tool._meta[MCP_TOOL_META_KEY], granted, requested);

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

/**
 * What a finished run answers: the node's output items (`structuredContent`, a text copy), a `resource_link` per file in
 * them and the small images and audio inline, or an error result naming the execution.
 */
async function callResult(record: ExecutionRecord, plugin: PluginSummary, caller: McpCaller, tool: McpToolDefinition): Promise<CallToolResult> {
  const url = `${publicUrl()}/workflows/${record.workflowId}/executions/${record.executionId}`;
  const meta = { [MCP_EXECUTION_META_KEY]: { id: record.executionId, status: record.status, url } };
  if (record.status !== 'success') {
    return { ...textResult(`${record.error?.message ?? `The run ended as ${record.status}`} (execution ${record.executionId})`, true), _meta: meta };
  }
  const run = record.runData[TOOL_NODE_ID]?.filter((r) => r.source === 'main').at(-1);
  const items = run?.outputs?.[0] ?? [];
  const files = await fileBlocks(items, { tool: `${plugin.id}/${tool.name}`, caller: callerLabel(caller) }).catch((error: Error) => {
    logger.warn('mcp file blocks failed', { error: error.message });
    return undefined;
  });
  const structuredContent = { items: items.map((item) => item.json) };
  const text = clip(JSON.stringify(structuredContent.items, null, 2));
  const note = files?.total
    ? `\n(${files.total} file(s) in the output${files.total > files.links.length ? `, ${files.links.length} linked` : ''}; the links expire; execution ${record.executionId} keeps them)`
    : '';
  return {
    content: [{ type: 'text', text: `${text}${note}` }, ...(files?.links ?? []), ...(files?.inline ?? [])] as CallToolResult['content'],
    structuredContent,
    _meta: meta,
  };
}

/** One tool call as an execution with mode `mcp`, audited and traced; failures come back as error results. */
async function callTool(plugin: PluginSummary, caller: McpCaller, tool: McpToolDefinition, granted: Record<string, string>, args: JsonObject, meta: CallMeta | undefined, request: Request | undefined, approved?: Record<string, unknown>): Promise<CallToolResult> {
  const mapping = toolCallToParameters(tool, args);
  const bound = bindTool(caller, plugin.id, tool, granted, meta?.credentials);
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
    audit(plugin, caller, tool.name, outcome, { executionId: record.executionId, status: record.status, durationMs: Date.now() - startedAt, ...approved, ...(record.error && { error: record.error.message }) });
    if (record.status !== 'success') failSpan(span, record.error?.message ?? record.status);
    return await callResult(record, plugin, caller, tool);
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

// ---------------------------------------------------------------------------
// list_options
// ---------------------------------------------------------------------------

const dynamicBinding = (tool: McpToolDefinition) => tool._meta[MCP_TOOL_META_KEY];
const hasDynamicOptions = (tool: McpToolDefinition) => dynamicBinding(tool).dynamicOptions.length > 0;

/**
 * Tools that take part in `list_options`: a dynamic list, and (for `core`, whose lists such as `workflows` are Landflow's own
 * data and not scoped to the caller's projects here) a credential. The plugin's lists are the plugin's world.
 */
const lookupTools = <T extends { tool: McpToolDefinition }>(plugin: PluginSummary, tools: T[]): T[] =>
  tools.filter(({ tool }) => hasDynamicOptions(tool) && (plugin.id !== CORE_PLUGIN_ID || dynamicBinding(tool).credentials.length > 0));

/** The slot → credential id map of a binding, which is what keys a remembered lookup. */
const credentialIds = (bound: BoundCredentials) => Object.fromEntries(Object.entries(bound.credentials).map(([slot, c]) => [slot, c.id]));

/** The parameters a lookup sends: the tool's fixed ones, the arguments the tool knows, the credential selector. */
const lookupParameters = (tool: McpToolDefinition, bound: BoundCredentials, nested: JsonObject | undefined): JsonObject => ({ ...toolCallToParameters(tool, nested).parameters, ...bound.parameters });

/** The tool as `tools/list` shows it to this caller: with `enum`s from remembered lookups made with the credential they would call with. */
function withRememberedOptions(plugin: PluginSummary, caller: McpCaller, entry: EffectiveTool): McpToolDefinition {
  const { tool } = entry;
  const binding = dynamicBinding(tool);
  if (!optionsCacheTtlMs() || !binding.dynamicOptions.length || !binding.credentials.length) return tool;
  // The credential a call would bind: the grant's (an admin who browses everything has no grant in the listing, but may hold one to call with).
  const granted = callableTool(caller, plugin.id, tool.name)?.credentials ?? entry.credentials;
  const bound = bindTool(caller, plugin.id, tool, granted, undefined);
  if (bound.error || !Object.keys(bound.credentials).length) return tool;
  const selectors = new Set(binding.credentialSelectors.map((selector) => selector.parameter));
  const lists: Record<string, PropertyOption[] | undefined> = {};
  for (const option of binding.dynamicOptions) {
    // Lists that depend on other arguments are the caller's to ask for; the credential's own selector is already set.
    if (option.dependsOn?.some((name) => !selectors.has(name))) continue;
    const key: LookupKey = { pluginId: plugin.id, nodeType: binding.nodeType, method: option.method, credentials: credentialIds(bound), parameters: lookupParameters(tool, bound, undefined) };
    lists[option.parameter] = recalledOptions(key);
  }
  return withDynamicOptionValues(tool, lists);
}

/** `list_options`, as the plugin's own MCP face defines it, with the tools this caller can look values up for. */
function listOptionsTool(toolNames: string[]): Tool {
  return listOptionsToolDefinition(toolNames) as unknown as Tool;
}

/** Whether the caller can resolve a credential (or needs none) for at least one tool with a dynamic list: the tool is worth offering. */
function lookupsPossible(plugin: PluginSummary, caller: McpCaller, entries: EffectiveTool[]): boolean {
  return lookupTools(plugin, entries).some((entry) => {
    const bound = bindTool(caller, plugin.id, entry.tool, callableTool(caller, plugin.id, entry.tool.name)?.credentials ?? entry.credentials, undefined);
    return !bound.error && (dynamicBinding(entry.tool).credentials.length === 0 || Object.keys(bound.credentials).length > 0);
  });
}

/** A `list_options` call: the values of one dynamic argument, resolved with the credential a call of the tool would bind. */
async function callListOptions(plugin: PluginSummary, caller: McpCaller, tools: EffectiveTool[], args: JsonObject, meta: CallMeta | undefined, request: Request | undefined): Promise<CallToolResult> {
  const toolName = typeof args.tool === 'string' ? args.tool : undefined;
  const parameter = typeof args.parameter === 'string' ? args.parameter : undefined;
  if (!toolName || !parameter) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${MCP_LIST_OPTIONS_TOOL} needs "tool" and "parameter"`);
  const listed = lookupTools(plugin, tools).find((entry) => entry.tool.name === toolName);
  if (!listed) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool "${toolName}" or it has no dynamic options`);
  const option = dynamicBinding(listed.tool).dynamicOptions.find((d) => d.parameter === parameter);
  if (!option) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `"${parameter}" of ${toolName} has no dynamic options`);
  const label = `${MCP_LIST_OPTIONS_TOOL}(${toolName}.${parameter})`;
  // Governed like the call it prepares: the caller needs the grant to call the tool whose argument they ask about.
  const callable = callableTool(caller, plugin.id, toolName);
  if (!callable) {
    audit(plugin, caller, MCP_LIST_OPTIONS_TOOL, 'denied', { lookup: toolName, parameter, reason: 'no grant allows calling the tool' });
    return textResult(`${callerLabel(caller)} has no grant to call ${toolName}, so it cannot look up its options`, true);
  }
  const nested = typeof args.arguments === 'object' && args.arguments !== null && !Array.isArray(args.arguments) ? (args.arguments as JsonObject) : undefined;
  const bound = bindTool(caller, plugin.id, callable.tool, callable.credentials, meta?.credentials);
  if (bound.error) {
    audit(plugin, caller, MCP_LIST_OPTIONS_TOOL, 'denied', { lookup: toolName, parameter, reason: bound.error });
    return textResult(bound.error, true);
  }
  const binding = dynamicBinding(callable.tool);
  const parameters = lookupParameters(callable.tool, bound, nested);
  const { span, context: active } = startSpan('mcp.tool.call', {
    attributes: { 'mcp.tool.name': MCP_LIST_OPTIONS_TOOL, 'landflow.plugin.id': plugin.id, 'landflow.mcp.caller': callerLabel(caller), 'landflow.load_options.tool': toolName },
  });
  const startedAt = Date.now();
  const outcome = (value: 'success' | 'failure') => hostMetrics().mcpToolCalls.add(1, { 'landflow.plugin.id': plugin.id, 'mcp.tool.name': MCP_LIST_OPTIONS_TOOL, 'landflow.mcp.outcome': value });
  try {
    const resolved = registry.resolve(binding.nodeType);
    if ('error' in resolved) throw new Error(resolved.error);
    const data = Object.keys(bound.credentials).length ? credentials.resolveFor({ type: binding.nodeType, credentials: bound.credentials, parameters }, resolved.descriptor, true) : undefined;
    const lookup = context.with(active, () => registry.loadOptions(binding.nodeType, option.method, parameters, data && Object.keys(data).length ? data : undefined));
    const options = await withDeadline(lookup, timeoutSeconds(request) * 1000, request?.signal);
    const key: LookupKey = { pluginId: plugin.id, nodeType: binding.nodeType, method: option.method, credentials: credentialIds(bound), parameters };
    // A list that is news changes what tools/list shows this caller (the enum): tell the listeners.
    if (rememberOptions(key, options) && !nested) notifyPluginToolsChanged(plugin.id);
    outcome('success');
    audit(plugin, caller, MCP_LIST_OPTIONS_TOOL, 'success', { lookup: toolName, parameter, options: options.length, durationMs: Date.now() - startedAt });
    return { content: [{ type: 'text', text: `${options.length} option${options.length === 1 ? '' : 's'}` }], structuredContent: { options: options as unknown as JsonObject[] } };
  } catch (error) {
    failSpan(span, error);
    outcome('failure');
    audit(plugin, caller, MCP_LIST_OPTIONS_TOOL, 'failure', { lookup: toolName, parameter, error: (error as Error).message, durationMs: Date.now() - startedAt });
    return textResult((error as Error).message, true);
  } finally {
    span.end();
  }
}

/** `work`, but not past the deadline or the client's cancellation. */
function withDeadline<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The lookup took longer than ${Math.round(ms / 1000)} seconds`)), ms);
    const stop = () => (clearTimeout(timer), reject(new Error('The lookup was cancelled')));
    signal?.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** Whether the client can be asked a form question in the request that makes the call (2026-07-28 with `elicitation` declared). */
function canElicit(server: Server, era: 'legacy' | 'modern'): boolean {
  if (era !== 'modern') return false;
  const elicitation = server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  return Boolean(elicitation) && (!Object.keys(elicitation!).length || 'form' in elicitation!);
}

/** A stateless MCP server for one request to a plugin's endpoint. */
export function pluginServer(plugin: PluginSummary, caller: McpCaller, request?: Request, era: 'legacy' | 'modern' = 'legacy'): Server {
  const tools = visibleTools(caller, plugin.id);
  const lookups = lookupsPossible(plugin, caller, tools);
  const triggers = listableTriggers(caller, plugin.id);
  const server = new Server(
    { name: `landflow-${plugin.id}`, title: plugin.info.name, version: plugin.info.version },
    {
      // Triggers are resources; only a 2026-07-28 caller can subscribe (the stateless 2025-era endpoint has no stream to notify on).
      capabilities: { tools: { listChanged: true }, ...(triggers.length && { resources: era === 'modern' ? { subscribe: true } : {} }) },
      instructions: instructionsFor(plugin, tools.length),
      cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } },
      // A 2025-era request is answered alone (no stream to ask on): approvals there are Landflow's, not elicitation.
      inputRequired: { legacyShim: false },
    },
  );
  server.setRequestHandler('tools/list', async () => {
    const listed = tools.map((entry) => wireTool(withRememberedOptions(plugin, caller, entry)));
    const dynamic = lookupTools(plugin, tools).map((entry) => entry.tool.name);
    return { tools: lookups && !tools.some((entry) => entry.tool.name === MCP_LIST_OPTIONS_TOOL) ? [...listed, listOptionsTool(dynamic)] : listed };
  });
  if (triggers.length) {
    server.setRequestHandler('resources/list', async () => ({
      resources: callerSubscriptions(caller, plugin.id).map((sub) => ({ uri: sub.uri, name: sub.trigger, description: sub.subscribed ? 'Your active subscription' : 'Your stopped subscription (its last events stay readable for a while)', mimeType: 'application/json' })),
    }));
    server.setRequestHandler('resources/templates/list', async () => ({
      resourceTemplates: triggers.map(({ trigger }) => ({
        uriTemplate: trigger.uriTemplate,
        name: trigger.name,
        title: trigger.title,
        description: trigger.description,
        mimeType: trigger.mimeType,
        _meta: { 'dev.landflow/trigger': { inputSchema: trigger.inputSchema, source: trigger._meta[MCP_TOOL_META_KEY].triggerSource } },
      })),
    }));
    server.setRequestHandler('resources/read', async (req, ctx) => {
      try {
        const read = await readTriggerResource(caller, plugin.id, req.params.uri, ctx.mcpReq.signal);
        return { contents: [{ uri: req.params.uri, mimeType: 'application/json', text: JSON.stringify(read, null, 2) }] };
      } catch (error) {
        if (error instanceof McpTriggerError) {
          if (error.kind === 'invalid' && /^Unknown (resource|trigger)/.test(error.message)) throw new ResourceNotFoundError(req.params.uri);
          throw new ProtocolError(error.kind === 'invalid' ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InvalidRequest, error.message);
        }
        throw error;
      }
    });
  }
  server.setRequestHandler('tools/call', async (req, ctx): Promise<CallToolResult | InputRequiredResult> => {
    const name = req.params.name;
    const raw = req.params.arguments;
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw new ProtocolError(ProtocolErrorCode.InvalidParams, '"arguments" must be an object');
    const args = (raw ?? {}) as JsonObject;
    const meta = (req.params._meta as Record<string, unknown> | undefined)?.[MCP_TOOL_META_KEY] as CallMeta | undefined;
    if (name === MCP_LIST_OPTIONS_TOOL && lookups && !tools.some((entry) => entry.tool.name === name)) {
      return server.projectCallToolResult(await callListOptions(plugin, caller, tools, args, meta, request), listOptionsToolDefinition([]).outputSchema);
    }
    const listed = tools.find((entry) => entry.tool.name === name);
    if (!listed) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool "${name}"`);
    const callable = callableTool(caller, plugin.id, name);
    if (!callable) {
      audit(plugin, caller, name, 'denied', { reason: 'no grant allows calling it' });
      return textResult(`${callerLabel(caller)} may list ${name} but has no grant to call it`, true);
    }
    let approved: Record<string, unknown> | undefined;
    const mode = callable.approval ?? 'destructive';
    if (needsApproval(mode, callable.tool)) {
      const bound = bindTool(caller, plugin.id, callable.tool, callable.credentials, meta?.credentials);
      const gate: ApprovalOutcome = await requireApproval({
        call: {
          pluginId: plugin.id,
          tool: name,
          caller: callerLabel(caller),
          callerUserId: caller.userId,
          args,
          credentialNames: Object.values(bound.credentials).map((c) => c.name),
        },
        title: callable.tool.title,
        inputResponses: ctx.mcpReq.inputResponses,
        requestState: ctx.mcpReq.requestState(),
        canElicit: canElicit(server, era),
        timeoutSeconds: timeoutSeconds(request),
        signal: ctx.mcpReq.signal,
      });
      if (!gate.proceed) {
        if (gate.audit && gate.audit.reason !== 'elicitation requested') audit(plugin, caller, name, 'denied', { reason: gate.audit.reason, approvalMode: mode, ...(gate.audit.approvalId && { approvalId: gate.audit.approvalId }), ...(gate.audit.by && { decidedBy: gate.audit.by }) });
        return gate.result;
      }
      approved = { approvalMode: mode, approvedVia: gate.how, ...(gate.approvalId && { approvalId: gate.approvalId }), ...(gate.by && { approvedBy: gate.by }) };
    }
    const result = await callTool(plugin, caller, callable.tool, callable.credentials, args, meta, request, approved);
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
      return pluginServer(pluginSummary(pluginId) ?? plugin, who, info.request, info.era);
    },
    authInfoFor(caller),
    {
      // A 2026-07-28 `subscriptions/listen` naming trigger URIs starts those triggers for this caller (./triggers.ts); the stream ending stops them.
      onListen: async (uris, info) => {
        const who = callerOf(info.authInfo) ?? caller;
        const refuse = (message: string) => listenRefusal(info.id, -32602, message);
        if (!listableTriggers(who, pluginId).length) return refuse(`${callerLabel(who)} has no grant for any trigger of ${pluginId}`);
        try {
          return await openTriggerSubscriptions({ caller: who, pluginId, uris, endpointKey: info.key });
        } catch (error) {
          if (error instanceof McpTriggerError) return refuse(error.message);
          throw error;
        }
      },
    },
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
