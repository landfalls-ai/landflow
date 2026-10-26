/**
 * MCP Server Trigger (n8n's mcpTrigger): an active workflow with this trigger serves the tool
 * sub-nodes attached to its `ai_tool` port at /mcp/<path>, over Streamable HTTP, with optional
 * bearer or header auth.
 *
 * - `tools/list` runs only the trigger, through the engine and without recording an execution:
 *   the trigger pulls its tools the way an AI Agent does and outputs their names and schemas.
 * - `tools/call` is an execution with mode `mcp`, recorded like any trigger's: the trigger gets
 *   `{ tool, arguments }`, calls the tool (it shows up as a sub-node run) and outputs the result.
 * - The test URL, /mcp-test/<path>, answers while the editor listens for the trigger (lib/server/test-webhooks.ts): it
 *   serves the tools of the workflow the editor sent (saved or not), and each `tools/call` is a manual test run the
 *   editor shows live. Every request pushes the listener's deadline on.
 * - The trigger's auth credential must be one the workflow's project may use, or every call gets 403 (as for webhooks,
 *   lib/server/webhook-auth.ts).
 */
import { context } from '@opentelemetry/api';
import { nanoid } from 'nanoid';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { JsonObject } from '@landflow/protocol';
import { executeWorkflow, type ToolSpec, type Workflow, type WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { credentials } from '../credentials/vault';
import { resolveWorkflowCredentials } from '../projects/credentials';
import { registry } from '../plugins/registry';
import { parameterSecretOptions } from '../secrets/runtime';
import { runWorkflow } from '../runner';
import { productionWorkflows } from '../publish';
import { startTrigger } from '../telemetry';
import { claimTestListener, findTestListener, NOT_LISTENING_HINT, runTestEvent, TEST_PREFIX, testRunId, type TestListener } from '../test-webhooks';
import { variables } from '../variables';
import { triggerAuthRefusal } from '../webhook-auth';
import { bearerToken, jsonRpcError, MCP_SERVER_VERSION, methodNotAllowed, sameSecret, serveMcp, textResult, unauthorized } from './server';

export const MCP_TRIGGER = 'core.mcpTrigger';

/** The trigger's path without leading or trailing slashes. */
export function mcpTriggerPath(node: Pick<WorkflowNode, 'parameters'>): string {
  return String(node.parameters.path ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

/** The published workflow (its published version) whose (enabled) MCP Server Trigger has this path. */
export function findMcpTrigger(path: string): { workflow: Workflow; node: WorkflowNode } | undefined {
  for (const workflow of productionWorkflows()) {
    const node = workflow.nodes.find((n) => !n.disabled && n.type === MCP_TRIGGER && mcpTriggerPath(n) === path);
    if (node) return { workflow, node };
  }
  return undefined;
}

/**
 * Undefined when the request may go on; else the 401, the 403 for a credential `workflowId`'s project can't use (before
 * any secret is compared), or 500 for a trigger without its credential.
 */
export function checkTriggerAuth(request: Request, workflowId: string, node: WorkflowNode): Response | undefined {
  const authentication = String(node.parameters.authentication ?? 'none');
  if (authentication !== 'bearerAuth' && authentication !== 'headerAuth') return undefined;
  const refused = triggerAuthRefusal(workflowId, node, 'MCP Server Trigger', (message) => jsonRpcError(403, -32001, message));
  if (refused) return refused;
  const resolved = registry.resolve(MCP_TRIGGER);
  if ('error' in resolved) return jsonRpcError(500, -32603, resolved.error);
  let secrets: Record<string, JsonObject>;
  try {
    secrets = credentials.resolveFor(node, resolved.descriptor);
  } catch (error) {
    return jsonRpcError(500, -32603, `The MCP Server Trigger’s credential is missing: ${(error as Error).message}`);
  }
  if (authentication === 'bearerAuth') {
    const token = String(secrets.httpBearerAuth?.token ?? '');
    if (!token) return jsonRpcError(500, -32603, 'The MCP Server Trigger’s Bearer Auth credential has no token');
    return sameSecret(bearerToken(request), token) ? undefined : unauthorized('Authorization failed: send the token as “Authorization: Bearer <token>”');
  }
  const name = String(secrets.httpHeaderAuth?.name ?? '').trim();
  if (!name) return jsonRpcError(500, -32603, 'The MCP Server Trigger’s Header Auth credential has no header name');
  return sameSecret(request.headers.get(name), String(secrets.httpHeaderAuth?.value ?? '')) ? undefined : unauthorized(`Authorization failed: send the “${name}” header`, 'header');
}

/** The tools the trigger serves, from a run of the trigger alone (not recorded; `test`: for the test URL). */
export async function listTriggerTools(workflow: Workflow, node: WorkflowNode, test = false): Promise<ToolSpec[]> {
  const result = await executeWorkflow({
    workflow,
    resolver: registry,
    executionId: `mcp_list_${nanoid(10)}`,
    mode: 'mcp',
    startNodeId: node.id,
    destinationNodeId: node.id,
    triggerItems: [{ json: {} }],
    resolveCredentials: (target, descriptor) => resolveWorkflowCredentials(workflow.id, target, descriptor),
    ...parameterSecretOptions,
    variables: variables.forWorkflow(workflow.id),
    spanAttributes: { 'landflow.mcp.method': 'tools/list', ...(test && { 'landflow.trigger.test': true }) },
  });
  if (result.status !== 'success') throw new Error(result.error?.message ?? 'Could not list the tools');
  const items = result.runData[node.id]?.find((run) => run.source === 'main')?.outputs[0] ?? [];
  return items.map((item) => item.json as unknown as ToolSpec);
}

/** What a finished tool-call run answers: the trigger's `result`, or an error result naming the execution. */
function toolResult(record: ExecutionRecord, node: WorkflowNode): CallToolResult {
  if (record.status !== 'success') return textResult(`${record.error?.message ?? `The workflow ended as ${record.status}`} (execution ${record.executionId})`, true);
  const output = record.runData[node.id]?.filter((run) => run.source === 'main').at(-1)?.outputs[0]?.[0]?.json;
  return textResult(output?.result ?? null);
}

/** A tool call on the test URL: a manual test run of the editor's workflow, as the user who listens, shown live in the editor. */
async function callTestTool(listener: TestListener, node: WorkflowNode, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { run, started } = runTestEvent(listener, { json: { tool: name, arguments: args as JsonObject } }, {}, testRunId(listener));
  const caught = await started;
  if (caught !== undefined) return textResult((caught as Error)?.message ?? 'The test run could not start', true);
  try {
    return toolResult(await run, node);
  } catch (error) {
    return textResult((error as Error).message, true);
  }
}

/** One tool call: an execution with mode `mcp` (on the test URL: the listener's manual test run). A failed run comes back as an error result. */
export async function callTriggerTool(workflow: Workflow, node: WorkflowNode, name: string, args: Record<string, unknown>, listener?: TestListener): Promise<CallToolResult> {
  if (listener) return callTestTool(listener, node, name, args);
  const trigger = startTrigger({ source: 'mcp', workflowId: workflow.id, nodeName: node.name });
  try {
    const record = await context.with(trigger.context, () =>
      runWorkflow({ workflow, mode: 'mcp', startNodeId: node.id, triggerItems: [{ json: { tool: name, arguments: args as JsonObject } }] }),
    );
    trigger.end();
    return toolResult(record, node);
  } catch (error) {
    trigger.end(error);
    return textResult((error as Error).message, true);
  }
}

/** A stateless MCP server for one request to the trigger (`listener`: on its test URL). */
export function triggerServer(workflow: Workflow, node: WorkflowNode, listener?: TestListener): McpServer {
  const instructions = String(node.parameters.instructions ?? '').trim();
  const server = new McpServer(
    { name: 'landflow', title: workflow.name, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, ...(instructions && { instructions }) },
  );
  // Raw JSON schemas, so the low-level handlers rather than registerTool (which takes zod).
  server.server.setRequestHandler('tools/list', async () => ({
    tools: (await listTriggerTools(workflow, node, Boolean(listener))).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: 'object' as const },
    })),
  }));
  server.server.setRequestHandler('tools/call', async (request) => callTriggerTool(workflow, node, request.params.name, request.params.arguments ?? {}, listener));
  return server;
}

/** Everything /mcp/<path> does: find the trigger, check auth, serve the request. */
export async function handleTriggerRequest(request: Request, path: string): Promise<Response> {
  const match = findMcpTrigger(path);
  if (!match) return jsonRpcError(404, -32001, `No active workflow serves MCP at /mcp/${path}`);
  const denied = checkTriggerAuth(request, match.workflow.id, match.node);
  if (denied) return denied;
  return serveMcp(request, () => triggerServer(match.workflow, match.node));
}

/** The 404 of a test URL nobody listens on. */
const testMiss = (path: string) => jsonRpcError(404, -32001, `No editor is listening on ${TEST_PREFIX.mcp}${path}. ${NOT_LISTENING_HINT}`);

/**
 * Everything /mcp-test/<path> does: find the editor's listener, check the trigger's auth, push the listener's deadline
 * on (a request that gets in keeps it listening) and serve the request from the workflow the editor sent.
 */
export async function handleTestTriggerRequest(request: Request, path: string): Promise<Response> {
  const found = await findTestListener('mcp', path);
  if (!found) return testMiss(path);
  const { listener, node } = found;
  const denied = checkTriggerAuth(request, listener.workflow.id, node);
  if (denied) return denied;
  if (request.method !== 'POST') return methodNotAllowed();
  if (!(await claimTestListener(listener))) return testMiss(path);
  return serveMcp(request, () => triggerServer(listener.workflow, node, listener));
}
