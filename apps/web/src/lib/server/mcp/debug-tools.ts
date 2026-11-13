/**
 * Debugging tools of the instance MCP server, for a coding agent (a local Claude Code) that has to find out why a
 * remote workflow failed: `explain_failure`, `get_run_trace`, `get_plugin_logs`, `retry_execution` and `run_node`.
 * Registered by instanceServer (./instance-tools.ts), which hands over its access checks.
 *
 * Everything these tools return is redacted first (`redactorFor`): credential values of the workflow's nodes, `$vars`
 * values, external-secret values and any field named like a secret (password, token, authorization…), and long text is
 * cut. A node's resolved parameters are computed with `$vars` masked and without `$secrets`.
 */
import { context } from '@opentelemetry/api';
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { JsonObject, NodeDescriptor, NodeItem } from '@landflow/protocol';
import { ExpressionResolver, type NodeRun, type Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { credentials } from '../credentials/vault';
import { journalStore, rebuildJournal } from '../journal';
import { marketplace } from '../marketplace/service';
import { registry } from '../plugins/registry';
import { RerunError, liveExecution, newExecutionId, runWorkflow, startRetry } from '../runner';
import { redactValue } from '../secrets/redact';
import { store } from '../store';
import { startTrigger } from '../telemetry';
import { variables } from '../variables';
import { isInstanceAdmin, type Actor } from '../projects/access';
import type { McpScope } from './project-servers';
import { checkExpressionFields, describeIssue, fieldsOfItems, outputSchemaOf, schemaFields, type CheckNode, type KnownFields } from './expression-fields';

const REDACTED = '[redacted]';
const MAX_TEXT = 3000;
const SECRET_KEY = /^(password|passwd|secret|token|apikey|api_key|api-key|authorization|auth|cookie|set-cookie|credentials?|private_?key|client_?secret|access_?token|refresh_?token|session)$/i;

export type Redact = <T>(value: T) => T;

const leaves = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object' && depth < 6) for (const entry of Object.values(value)) leaves(entry, out, depth + 1);
  return out;
};

/**
 * A function that cleans any JSON value for output: the secret values the workflow could read (its nodes' credentials,
 * `$vars`) are replaced wherever they appear, secret-named keys are blanked, strings are cut.
 */
export function redactorFor(workflow: Pick<Workflow, 'id' | 'nodes'> | undefined): Redact {
  const secrets = new Set<string>();
  try {
    for (const value of Object.values(variables.forWorkflow(workflow?.id))) if (typeof value === 'string' && value.length >= 4) secrets.add(value);
  } catch {
    // No variables to hide.
  }
  for (const node of workflow?.nodes ?? []) {
    for (const [type, ref] of Object.entries(node.credentials ?? {})) {
      try {
        for (const text of leaves(credentials.dataFor(ref, type))) if (text.length >= 6) secrets.add(text);
      } catch {
        // A credential that is gone has nothing to hide.
      }
    }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  const text = (input: string) => {
    let out = input;
    for (const secret of values) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…[cut]` : out;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return text(value);
    if (!value || typeof value !== 'object') return value;
    if (depth > 12) return '…[deep]';
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) && entry ? REDACTED : walk(entry, depth + 1)]));
  };
  return (<T,>(value: T): T => walk(redactValue(value), 0) as T) as Redact;
}

export interface DebugContext {
  actor?: Actor;
  scope?: McpScope;
  /** The refusal for the workflow and action, or undefined when allowed. */
  denied: (workflowId: string, action: 'read' | 'run') => CallToolResult | undefined;
  inScope: (workflowId: string) => boolean;
  json: (value: unknown) => CallToolResult;
  failure: (message: string) => CallToolResult;
  workflowUrl: (id: string) => string;
  /** instanceServer's one-execution summary. */
  digest: (record: ExecutionRecord, includeData: boolean) => unknown;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lastRunOf = (record: ExecutionRecord, nodeId: string): NodeRun | undefined => record.runData[nodeId]?.at(-1);
const itemsOf = (run: NodeRun | undefined, branch = 0): NodeItem[] | undefined => run?.outputs[branch];

/** Fields a node wrote: its declared outputSchema, else what it wrote in this execution. */
function knownFieldsIn(record: ExecutionRecord, node: CheckNode, descriptor: NodeDescriptor | undefined): KnownFields | undefined {
  const declared = descriptor && schemaFields(outputSchemaOf(descriptor, node.parameters));
  if (declared) return { fields: declared, from: 'outputSchema' };
  const run = [...(record.runData[node.id] ?? [])].reverse().find((r) => r.status === 'success' && r.source === 'main');
  const fields = fieldsOfItems(run?.outputs[0] as Array<{ json: Record<string, unknown> }> | undefined);
  return fields && { fields, from: 'last run' };
}

const descriptorOf = (type: string): NodeDescriptor | undefined => {
  const resolved = registry.resolve(type);
  return 'error' in resolved ? undefined : resolved.descriptor;
};

/** The node an execution failed in: the one its error names, else the last node whose last run errored. */
function failingNodeId(record: ExecutionRecord): string | undefined {
  if (record.error?.nodeId && record.runData[record.error.nodeId]) return record.error.nodeId;
  const order = [...new Set(record.executionOrder)].reverse();
  return order.find((id) => lastRunOf(record, id)?.status === 'error') ?? record.error?.nodeId;
}

/** Plain-language leads for a failure message, most specific first. */
function whatToCheck(message: string, ctx: { nodeName: string; pluginNode: boolean; hasCredential: boolean; inputItems: number; fieldIssues: string[] }): string[] {
  const out = [...ctx.fieldIssues];
  const m = message.toLowerCase();
  if (ctx.inputItems === 0) out.push(`"${ctx.nodeName}" received no items: look at the node before it (upstream), it produced nothing for this run.`);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(key|token)|authentication/.test(m)) out.push(ctx.hasCredential ? 'The service refused the credential: check it is valid, not expired and has the scopes the operation needs (re-save it in the editor).' : 'The service refused the request and the node has no credential chosen: pick one in the editor.');
  if (/\b404\b|not found/.test(m)) out.push('The address or id does not exist: compare the URL / id parameter with sampleInput and the upstream fields.');
  if (/\b429\b|rate.?limit|too many requests/.test(m)) out.push('Rate limited: add retries with exponential backoff to the node (retryBackoff) or a node rate limit.');
  if (/\b5\d\d\b|bad gateway|service unavailable/.test(m)) out.push('The remote service failed: retry_execution is likely to work once it recovers.');
  if (/econnrefused|enotfound|fetch failed|socket hang up|econnreset|unreachable|connect/.test(m)) out.push(ctx.pluginNode ? 'The plugin or the service behind it is not reachable: read get_plugin_logs for this node type, and check the plugin is running.' : 'The host could not connect: check the URL, DNS and any network allow-list.');
  if (/timed? ?out|timeout|etimedout/.test(m)) out.push('It ran out of time: raise the node or workflow timeout, or check the service is slow rather than down.');
  if (/is not defined|cannot read|undefined|expression|unexpected token|syntaxerror/.test(m)) out.push('An expression or code failed: compare what it reads with sampleInput and upstream[].fields; a missing field is the usual cause.');
  if (/required|missing|invalid (value|parameter)/.test(m)) out.push('A parameter is missing or invalid: see get_node_type for this node type and compare with parameters.');
  if (!out.length) out.push('Compare parameters and resolvedParameters with sampleInput; then re-run just this node with run_node and the same input to reproduce it.');
  out.push('After a fix, retry_execution continues from the failed node; run_node tests one node with an input you pin.');
  return out;
}

export function registerDebugTools(server: McpServer, ctx: DebugContext) {
  const { json, failure } = ctx;

  const visible = async (id: string): Promise<{ record: ExecutionRecord } | { refusal: CallToolResult }> => {
    const record = liveExecution(id) ?? (await store.loadExecution(id));
    if (!record || !ctx.inScope(record.workflowId) || ctx.denied(record.workflowId, 'read')) return { refusal: failure(`Execution ${id} not found`) };
    return { record };
  };

  server.registerTool(
    'explain_failure',
    {
      title: 'Explain why an execution failed',
      description:
        'Everything needed to debug a failed execution in one call: the failing node (type, error text, node logs), its parameters raw and resolved against the input it got, a sample input item, the fields each upstream node wrote (declared and actual), expressions that read a field the upstream node does not write, and a short list of what to check. Credentials and $vars are redacted.',
      inputSchema: z.object({ id: z.string().describe('Execution id'), runIndex: z.number().int().min(0).optional().describe('Which run of the node (a loop runs it many times); default the failed one') }),
      annotations: READ_ONLY,
    },
    async ({ id, runIndex }) => {
      const found = await visible(id);
      if ('refusal' in found) return found.refusal;
      const { record } = found;
      const workflow: Workflow | undefined = record.workflow ?? store.getWorkflow(record.workflowId);
      const redact = redactorFor(workflow);
      if (record.status !== 'error') {
        return json(redact({ id, status: record.status, ...(record.error && { error: record.error }), note: record.status === 'success' ? 'This execution did not fail.' : `This execution is ${record.status}, not failed.`, url: `${ctx.workflowUrl(record.workflowId)}/executions/${id}` }));
      }
      const nodeId = failingNodeId(record);
      const node = workflow?.nodes.find((n) => n.id === nodeId);
      const runs = (nodeId && record.runData[nodeId]) || [];
      const run = (runIndex !== undefined ? runs[runIndex] : undefined) ?? [...runs].reverse().find((r) => r.status === 'error') ?? runs.at(-1);
      const message = run?.error?.message ?? record.error?.message ?? 'Unknown error';
      if (!workflow || !node) {
        return json(redact({ id, status: record.status, error: record.error ?? { message }, note: 'The failing node is not in the stored workflow, so only the error is known.', whatToCheck: whatToCheck(message, { nodeName: record.error?.nodeName ?? 'the node', pluginNode: false, hasCredential: true, inputItems: -1, fieldIssues: [] }) }));
      }
      const info = registry.nodeTypes().find((t) => t.type === node.type);
      const descriptor = descriptorOf(node.type);
      const names = Object.fromEntries(workflow.nodes.map((n) => [n.id, n.name]));
      const inputItems = run?.inputs[0] ?? [];

      // Parameters resolved against the item the node got, with $vars masked and no $secrets.
      const masked = Object.fromEntries(Object.keys(variables.forWorkflow(workflow.id)).map((key) => [key, REDACTED]));
      const nodeOutputs = Object.fromEntries(workflow.nodes.map((n) => [n.name, itemsOf(lastRunOf(record, n.id)) ?? []]));
      const resolver = new ExpressionResolver({ items: inputItems, nodeOutputs, workflow: { id: workflow.id, name: workflow.name }, execution: { id: record.executionId, mode: record.mode }, parameters: node.parameters, variables: masked });
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.parameters)) {
        if (!JSON.stringify(value)?.includes('{{')) continue;
        try {
          resolved[key] = resolver.resolveValue(value, 0);
        } catch (error) {
          resolved[key] = { error: (error as Error).message };
        }
      }

      const upstream = workflow.connections
        .filter((c) => (c.type ?? 'main') === 'main' && c.target === node.id)
        .map((c) => workflow.nodes.find((n) => n.id === c.source))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map((n) => {
          const upstreamRun = lastRunOf(record, n.id);
          const out = itemsOf(upstreamRun);
          const declared = descriptorOf(n.type) && schemaFields(outputSchemaOf(descriptorOf(n.type)!, n.parameters));
          return {
            node: n.name,
            type: n.type,
            ...(upstreamRun && { status: upstreamRun.status }),
            outputItems: out?.length ?? 0,
            fields: fieldsOfItems(out as Array<{ json: Record<string, unknown> }> | undefined) ?? [],
            ...(declared && { declaredFields: declared }),
          };
        });

      const checkNodes = workflow.nodes.map((n): CheckNode => ({ id: n.id, name: n.name, type: n.type, parameters: n.parameters, disabled: n.disabled }));
      const fieldIssues = checkExpressionFields(
        { nodes: checkNodes, connections: workflow.connections.map((c) => ({ source: c.source, target: c.target, type: c.type ?? 'main' })) },
        (n) => descriptorOf(n.type),
        (n) => knownFieldsIn(record, n, descriptorOf(n.type)),
      )
        .filter((issue) => issue.nodeId === node.id)
        .map(describeIssue);

      const hasCredential = Boolean(node.credentials && Object.keys(node.credentials).length) || !(descriptor?.credentials ?? []).some((c) => c.required);
      const result = {
        id: record.executionId,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        status: record.status,
        failedNode: {
          name: node.name,
          type: node.type,
          ...(info && info.pluginId !== 'core' && { plugin: info.pluginName }),
          runIndex: Math.max(0, runs.indexOf(run as NodeRun)),
          runs: runs.length,
          ...(run && { startedAt: run.startedAt, durationMs: run.durationMs }),
          ...(node.credentials && { credentials: Object.fromEntries(Object.entries(node.credentials).map(([type, ref]) => [type, ref.name])) }),
        },
        error: { message, ...(run?.error?.description && { description: run.error.description }) },
        parameters: node.parameters,
        resolvedParameters: resolved,
        inputItemCount: inputItems.length,
        sampleInput: inputItems[0]?.json ?? null,
        upstream,
        ...(run?.logs?.length && { nodeLogs: run.logs.slice(-20) }),
        ...(record.retryOf && { retryOf: record.retryOf }),
        ...(record.retriedBy && { retriedBy: record.retriedBy }),
        executionPath: [...new Set(record.executionOrder)].map((nodeIdInOrder) => names[nodeIdInOrder] ?? nodeIdInOrder),
        whatToCheck: whatToCheck(message, { nodeName: node.name, pluginNode: Boolean(info && info.pluginId !== 'core'), hasCredential, inputItems: inputItems.length, fieldIssues }),
        url: `${ctx.workflowUrl(record.workflowId)}/executions/${record.executionId}`,
      };
      return json(redact(result));
    },
  );

  server.registerTool(
    'get_run_trace',
    {
      title: 'Get the run trace',
      description: 'The Run Trace journal of an execution: its spans (nodes, agent steps, tool calls, waits) and updates in order, with seq numbers. Page with after (a seq) and limit. Text is cut and credentials and $vars are redacted.',
      inputSchema: z.object({ id: z.string().describe('Execution id'), after: z.number().int().min(0).optional().describe('Return events with a seq above this (default 0)'), limit: z.number().int().min(1).max(500).optional().describe('Default 200') }),
      annotations: READ_ONLY,
    },
    async ({ id, after, limit }) => {
      const found = await visible(id);
      if ('refusal' in found) return found.refusal;
      const { record } = found;
      const stored = liveExecution(id) ? undefined : await store.loadExecution(id);
      const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
      if (stored && !after) rebuildJournal(stored, workflow);
      const max = limit ?? 200;
      const rows = await journalStore.readEventsAsync(id, after ?? 0, max + 1);
      const events = rows.slice(0, max);
      return json(redactorFor(workflow)({ executionId: id, status: record.status, events, last: events.at(-1)?.seq ?? after ?? 0, more: rows.length > max }));
    },
  );

  server.registerTool(
    'get_plugin_logs',
    {
      title: 'Get a node plugin\'s logs',
      description: 'The recent output (install and process logs) of an installed node plugin. Name the plugin by its installed id, its plugin id, or any of its node types (e.g. "browser.browser"). Plugins started by LANDFLOW_PLUGINS rather than installed from a marketplace have no logs here.',
      inputSchema: z.object({ plugin: z.string().describe('Installed plugin id, plugin id, or a node type'), tail: z.number().int().min(1).max(500).optional().describe('Last lines to return (default 100)') }),
      annotations: READ_ONLY,
    },
    async ({ plugin, tail }) => {
      if (ctx.scope) return failure('Plugin logs are not available on a project-scoped server');
      if (ctx.actor && !isInstanceAdmin(ctx.actor)) return failure('Only an instance admin can read plugin logs');
      const asType = registry.nodeTypes().find((t) => t.type === plugin);
      if (asType?.pluginId === 'core') return failure('Core nodes run inside the host: their errors are in the execution (explain_failure), not in a plugin log');
      const wanted = asType?.pluginId ?? plugin;
      const installed = marketplace.installed().filter((p) => p.nodePlugin);
      const match = installed.find((p) => p.id === wanted || p.plugin === wanted || p.nodePlugin?.pluginId === wanted || p.nodePlugin?.manifest?.id === wanted);
      if (!match) {
        return failure(`No installed node plugin "${plugin}". Installed: ${installed.map((p) => p.id).join(', ') || 'none'}. A plugin started with LANDFLOW_PLUGINS has no logs here.`);
      }
      try {
        const lines = marketplace.logs(match.id).slice(-(tail ?? 100));
        const redact = redactorFor(undefined);
        return json({ plugin: match.id, status: match.nodePlugin?.status, lines: redact(lines) });
      } catch (error) {
        return failure((error as Error).message);
      }
    },
  );

  /** Wait for a started execution to finish (up to `seconds`), then its record. */
  const settle = async (executionId: string, seconds: number): Promise<ExecutionRecord | undefined> => {
    const deadline = Date.now() + seconds * 1000;
    while (liveExecution(executionId) && Date.now() < deadline) await sleep(200);
    return liveExecution(executionId) ?? (await store.loadExecution(executionId));
  };

  server.registerTool(
    'retry_execution',
    {
      title: 'Retry a failed execution',
      description:
        'Run a failed or canceled execution again as a new execution linked to it. By default it continues from the failed node and reuses what ran before it, on the version that ran; from "start" runs everything again with the same trigger input; version "current" uses the saved workflow, so a fix you just made applies. With wait false it returns the new id at once.',
      inputSchema: z.object({
        id: z.string().describe('The failed execution'),
        from: z.enum(['failed', 'start']).optional().describe('failed (default) or start'),
        version: z.enum(['original', 'current']).optional().describe('original (default) or current'),
        wait: z.boolean().optional().describe('Wait for the run to finish (default true)'),
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe('How long to wait (default 60)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, from, version, wait, timeoutSeconds }) => {
      const found = await visible(id);
      if ('refusal' in found) return found.refusal;
      const refused = ctx.denied(found.record.workflowId, 'run');
      if (refused) return refused;
      const trigger = startTrigger({ source: 'mcp', workflowId: found.record.workflowId, nodeName: 'retry' });
      try {
        const newId = await context.with(trigger.context, () => startRetry(id, { from, version }));
        trigger.end();
        const url = `${ctx.workflowUrl(found.record.workflowId)}/executions/${newId}`;
        if (wait === false) return json({ executionId: newId, retryOf: id, status: 'running', url });
        const record = await settle(newId, timeoutSeconds ?? 60);
        if (!record) return json({ executionId: newId, retryOf: id, status: 'running', url });
        const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
        return json({ retryOf: id, ...(redactorFor(workflow)(ctx.digest(record, false)) as object) });
      } catch (error) {
        trigger.end(error);
        return failure(error instanceof RerunError ? error.message : (error as Error).message);
      }
    },
  );

  server.registerTool(
    'run_node',
    {
      title: 'Run one node with a pinned input',
      description:
        'Run a single node of a saved workflow on input you give (items, or the items it received in an earlier execution with fromExecution) and get its output or error, without running the nodes around it. Use it to reproduce a failure and to test a fix on the saved draft. It saves an execution (mode manual). Expressions that read other nodes with $(\'Name\') see nothing unless fromExecution is given.',
      inputSchema: z.object({
        workflowId: z.string().describe('Workflow id'),
        node: z.string().describe('Name or id of the node'),
        input: z
          .union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe('The item (or items) the node gets; default one empty item'),
        fromExecution: z.string().optional().describe('Use the input and the other nodes\' output of this execution instead of `input`'),
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe('How long to wait (default 60)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workflowId, node: ref, input, fromExecution, timeoutSeconds }) => {
      if (!ctx.inScope(workflowId)) return failure(`Workflow ${workflowId} not found`);
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) return failure(`Workflow ${workflowId} not found`);
      const refused = ctx.denied(workflowId, 'run');
      if (refused) return refused;
      const node = workflow.nodes.find((n) => n.id === ref || n.name === ref);
      if (!node) return failure(`No node "${ref}" in “${workflow.name}”`);
      if (fromExecution) {
        const source = await visible(fromExecution);
        if ('refusal' in source) return source.refusal;
        if (source.record.workflowId !== workflowId) return failure(`Execution ${fromExecution} is of another workflow`);
        if (!source.record.runData[node.id]) return failure(`Execution ${fromExecution} never ran “${node.name}”`);
      }
      const triggerItems: NodeItem[] = (Array.isArray(input) ? input : input ? [input] : [{}]).map((item) => ({ json: item as JsonObject }));
      const executionId = newExecutionId();
      const options = {
        workflow,
        mode: 'manual' as const,
        executionId,
        destinationNodeId: node.id,
        ...(fromExecution ? { partial: { executionId: fromExecution, nodeId: node.id, scope: 'only' as const } } : { startNodeId: node.id, triggerItems }),
      };
      const trigger = startTrigger({ source: 'mcp', workflowId, nodeName: node.name });
      try {
        const started = await context.with(trigger.context, () => runWorkflow({ ...options, bypassConcurrency: true }));
        trigger.end();
        const record = started.status === 'running' ? ((await settle(started.executionId, timeoutSeconds ?? 60)) ?? started) : started;
        const run = lastRunOf(record, node.id);
        return json(
          redactorFor(workflow)({
            executionId: record.executionId,
            node: node.name,
            status: run?.status ?? record.status,
            ...(run?.error && { error: run.error }),
            ...(record.error && !run?.error && { error: record.error }),
            input: (run?.inputs[0] ?? triggerItems).slice(0, 5).map((item) => item.json),
            outputItems: (run?.outputs ?? []).map((branch) => branch.length),
            output: (run?.outputs[0] ?? []).slice(0, 25).map((item) => item.json),
            ...(run?.logs?.length && { nodeLogs: run.logs.slice(-20) }),
            url: `${ctx.workflowUrl(workflowId)}/executions/${record.executionId}`,
          }),
        );
      } catch (error) {
        trigger.end(error);
        return failure((error as Error).message);
      }
    },
  );
}
