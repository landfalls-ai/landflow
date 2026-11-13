/**
 * The tools of the instance MCP server (/api/mcp), for coding agents that build and run
 * workflows: list, get, create, update and validate workflows; list, search and describe node
 * types; execute a workflow and read executions. Every result is JSON text.
 */
import { context } from '@opentelemetry/api';
import { nanoid } from 'nanoid';
import { governedSave } from '../governance/saves';
import { currentActorId } from '../auth/context';
import { z } from 'zod';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { JsonObject, NodeItem } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord, ExecutionSummary, NodeTypeInfo } from '../../shared/types';
import { PARAMETER_FORMATS } from '../flow-builder';
import { registry } from '../plugins/registry';
import { productionWorkflowById } from '../publish';
import { findTrigger, lastNodeItems, liveExecution, liveExecutions, publicUrl, runWorkflow, startInBackground } from '../runner';
import { workflowSchema } from '../schemas';
import { protectedMessage } from '../environments/protection';
import { isProtectedEnvironment } from '../environments/settings';
import { listExecutionsPage } from '../executions-query';
import { store } from '../store';
import { startTrigger } from '../telemetry';
import { canResource, creationProject, filterVisible, resourceDenial, type Actor } from '../projects/access';
import { getProject } from '../projects/store';
import { inScope, type McpScope } from './project-servers';
import { createIn } from '../projects/http';
import type { ResourceAction } from '../../shared/projects';
import { MCP_SERVER_VERSION, textResult } from './server';
import { registerBrainTools } from './brain-tools';
import { registerDebugTools } from './debug-tools';
import { normalizeWorkflow, validateWorkflow, type WorkflowInput } from './workflows';

const INSTRUCTIONS = `Landflow is an n8n-like workflow platform. A workflow is a graph of nodes: a trigger starts it, items (JSON objects) flow along "main" connections from left to right, and each node processes the items it gets.

How to build one:
1. Find node types with search_node_types (or list_node_types), then read their parameters with get_node_type. Types are "<plugin>.<name>", e.g. core.manualTrigger, core.httpRequest, core.set, core.if, core.code.
2. Write nodes with a unique name, a type and parameters. Ids, positions and default parameters are filled in. Expressions go in {{ }}, e.g. "{{ $json.title }}" or "{{ $('Node name').item.json.id }}".
3. Connections go from source to target by node name. "sourceIndex" picks the output (If/Filter: 0 = true, 1 = false). AI sub-nodes (chat models, memory, tools) connect from the sub-node to the root node with type ai_languageModel, ai_memory or ai_tool.
4. validate_workflow (it warns when an expression reads a field the node before it does not write), then create_workflow or update_workflow (nodes and connections given to update_workflow replace the current ones), then execute_workflow to test and get_execution to see each node's output.
5. When a run fails: explain_failure (failing node, resolved parameters, sample input, upstream fields, what to check), get_run_trace (the journal), get_plugin_logs (a node plugin's output), then run_node to reproduce on a pinned input and retry_execution to continue after a fix.
The second brain: check_overlap before building (is anyone already doing this?), brain_search_facts, brain_workflow_knowledge, brain_list_suggestions, brain_usage_report, and brain_suggest to post a suggestion.
Credentials can't be created here: nodes that need one get it chosen in the editor (the workflow's url).

${PARAMETER_FORMATS}`;

const SCOPE_NOTE = (project: string) =>
  `This server is scoped to the project “${project}”: it lists, reads, changes and runs only that project's workflows, and new workflows are created in it. Other workflows do not exist here.`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const nodeInput = z
  .object({
    id: z.string().optional().describe('Stable id; generated when left out'),
    name: z.string().min(1).describe('Unique in the workflow; connections refer to nodes by name'),
    type: z.string().min(3).describe('Node type, e.g. "core.httpRequest" (see search_node_types)'),
    typeVersion: z.number().int().positive().optional(),
    position: z.tuple([z.number(), z.number()]).optional().describe('Canvas [x, y]; laid out left to right when left out'),
    parameters: z.record(z.string(), z.unknown()).optional().describe('Parameter values by name (see get_node_type); defaults are filled in for new nodes'),
    credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
    disabled: z.boolean().optional(),
    notes: z.string().optional().describe('Also the tool description when the node is used as an AI tool'),
  })
  .passthrough();

const connectionInput = z.object({
  source: z.string().describe('Name (or id) of the node the connection leaves'),
  target: z.string().describe('Name (or id) of the node it enters'),
  type: z.string().optional().describe('"main" (default), or ai_languageModel / ai_memory / ai_tool from a sub-node to its root node'),
  sourceIndex: z.number().int().min(0).optional().describe('Output of the source (default 0)'),
  targetIndex: z.number().int().min(0).optional().describe('Input of the target (default 0)'),
  id: z.string().optional(),
});

const workflowFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  nodes: z.array(nodeInput),
  connections: z.array(connectionInput).optional(),
  settings: z.record(z.string(), z.unknown()).optional().describe('timeoutSeconds, errorWorkflowId, timezone, callerPolicy, saveSuccessfulExecutions…'),
  active: z.boolean().optional().describe('Active workflows answer webhooks, forms, MCP and schedules'),
  tags: z.array(z.string()).optional(),
};

const json = (value: unknown): CallToolResult => textResult(value);
const failure = (message: string): CallToolResult => textResult(message, true);
const workflowUrl = (id: string) => `${publicUrl()}/workflows/${id}`;

const MAX_OUTPUT_ITEMS = 25;
/** list_executions with a status reads at most this many pages of 200 saved runs (the status is in SQL; only access is filtered after). */
const STATUS_SCAN_PAGES = 10;

/** Items as JSON, at most MAX_OUTPUT_ITEMS. */
function itemsJson(items: NodeItem[]): { items: JsonObject[]; total: number; truncated?: true } {
  return { items: items.slice(0, MAX_OUTPUT_ITEMS).map((item) => item.json), total: items.length, ...(items.length > MAX_OUTPUT_ITEMS && { truncated: true as const }) };
}

function nodeTypeSummary(info: NodeTypeInfo) {
  const { descriptor } = info;
  return {
    type: info.type,
    displayName: descriptor.displayName,
    description: descriptor.description,
    kind: descriptor.kind,
    ...(descriptor.triggerSource && { triggerSource: descriptor.triggerSource }),
    ...(descriptor.supplies && { supplies: descriptor.supplies }),
    ...(descriptor.usableAsTool && { usableAsTool: true }),
    categories: descriptor.categories ?? [],
    ...(!info.available && { available: false }),
  };
}

/** One execution in brief: status, error, and per node its runs, item counts and errors; the last node's output. */
export function executionDigest(record: ExecutionRecord, includeData: boolean) {
  const names = record.nodeNames ?? Object.fromEntries((record.workflow?.nodes ?? []).map((n) => [n.id, n.name]));
  const nodes = [...new Set(record.executionOrder)].map((nodeId) => {
    const runs = record.runData[nodeId] ?? [];
    const last = runs.at(-1);
    return {
      node: names[nodeId] ?? nodeId,
      runs: runs.length,
      status: last?.status,
      ...(last?.source && last.source !== 'main' && { usedAs: last.source }),
      outputItems: (last?.outputs ?? []).map((branch) => branch.length),
      ...(last?.error && { error: last.error.message }),
    };
  });
  return {
    id: record.executionId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.finishedAt && { finishedAt: record.finishedAt }),
    durationMs: record.durationMs,
    ...(record.error && { error: record.error }),
    ...(record.wait && { waitingFor: { node: record.wait.nodeName, resume: record.wait.resume, ...(record.wait.until && { until: record.wait.until }) } }),
    ...(record.parentExecutionId && { parentExecutionId: record.parentExecutionId }),
    ...(record.lastNodeId && { lastNode: names[record.lastNodeId] ?? record.lastNodeId }),
    nodes,
    output: itemsJson(lastNodeItems(record)),
    ...(includeData && { runData: record.runData }),
    url: `${workflowUrl(record.workflowId)}/executions/${record.executionId}`,
  };
}

/** The node an execution starts from: the one named, else the first manual, webhook, chat or schedule trigger. */
function startNode(workflow: Workflow, ref?: string) {
  if (ref) return workflow.nodes.find((n) => n.id === ref || n.name === ref);
  return findTrigger(workflow, 'manual') ?? findTrigger(workflow, 'webhook') ?? findTrigger(workflow, 'chat') ?? findTrigger(workflow, 'schedule');
}

/**
 * The instance server. `actor` is the Landflow user a gateway-routed call was made by (./identity.ts): their project
 * access decides which workflows they see and what they may do with them (the same rules as the REST API:
 * `resourceCan`), and what they create goes to their personal project. Without one (the instance access token) the
 * server acts for the instance and checks nothing, as before.
 */
export function instanceServer(actor?: Actor, scope?: McpScope): McpServer {
  const project = scope && getProject(scope.projectId);
  const server = new McpServer(
    { name: 'landflow', title: project ? `Landflow · ${project.name}` : 'Landflow', version: MCP_SERVER_VERSION },
    { instructions: project ? `${SCOPE_NOTE(project.name)}\n\n${INSTRUCTIONS}` : INSTRUCTIONS },
  );
  /** The refusal for `actor` doing `action` with a workflow, or undefined when allowed (a workflow they cannot see is "not found"; neither is one outside the project this server is scoped to). */
  const denied = (id: string, action: ResourceAction): CallToolResult | undefined => {
    if (!inScope(scope, id)) return failure(`Workflow ${id} not found`);
    if (!actor) return undefined;
    const why = resourceDenial(actor, 'workflow', id, action);
    return why ? failure(why.status === 404 ? `Workflow ${id} not found` : why.message) : undefined;
  };

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Workflows with their id, name, whether they are active, tags and node types. Filter by a text query or by active.',
      inputSchema: z.object({
        query: z.string().optional().describe('Matched against name, description and tags'),
        active: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, active, limit }) => {
      const q = query?.trim().toLowerCase();
      const list = (actor ? filterVisible(actor, 'workflow', store.workflowSummaries()) : store.workflowSummaries())
        .filter((w) => inScope(scope, w.id))
        .filter((w) => (active === undefined || w.active === active) && (!q || [w.name, w.description ?? '', ...w.tags].some((text) => text.toLowerCase().includes(q))));
      return json({
        total: list.length,
        workflows: list.slice(0, limit ?? 100).map((w) => ({
          id: w.id,
          name: w.name,
          ...(w.description && { description: w.description }),
          active: w.active,
          tags: w.tags,
          nodeCount: w.nodeCount,
          nodeTypes: w.nodeTypes,
          updatedAt: w.updatedAt,
        })),
      });
    },
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get a workflow',
      description: 'The whole workflow: nodes with their parameters, connections, settings, whether it is active.',
      inputSchema: z.object({ id: z.string().describe('Workflow id') }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const workflow = store.getWorkflow(id);
      if (workflow && denied(id, 'read')) return denied(id, 'read')!;
      return workflow ? json({ ...workflow, url: workflowUrl(id) }) : failure(`Workflow ${id} not found`);
    },
  );

  server.registerTool(
    'create_workflow',
    {
      title: 'Create a workflow',
      description:
        'Save a new workflow. Node ids, positions, type versions and default parameters are filled in; connections name their nodes. The reply has the id, the editor url and a validation report.',
      inputSchema: z.object(workflowFields),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      if (isProtectedEnvironment()) return failure(protectedMessage());
      const normalized = normalizeWorkflow({ ...args, connections: args.connections ?? [] } as WorkflowInput);
      const parsed = workflowSchema.safeParse(normalized);
      if (!parsed.success) return failure(`Invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      // Governance: activation may need approval (four-eyes) or be refused (node policy); see lib/server/governance/saves.ts.
      const id = `wf_${nanoid(10)}`;
      const { workflow: saved, extras } = createIn(
        // A scoped server creates in its project (the actor needs to be allowed to create there); an unscoped one in the actor's personal project.
        scope ? (actor ? creationProject(actor, scope.projectId) : scope.projectId) : actor ? creationProject(actor) : undefined,
        'workflow',
        () => governedSave({ ...parsed.data, id } as Workflow, undefined, (w) => store.saveWorkflow(w), { by: currentActorId(), source: 'mcp' }),
        (created) => created.workflow.id,
        id,
      );
      return json({ id: saved.id, name: saved.name, active: Boolean(saved.active), url: workflowUrl(saved.id), validation: validateWorkflow(saved), ...extras });
    },
  );

  server.registerTool(
    'update_workflow',
    {
      title: 'Update a workflow',
      description:
        'Change a workflow: only the fields given change. "nodes" and "connections" replace the current lists, so read the workflow with get_workflow first and send the full lists. "active" turns triggers on or off.',
      inputSchema: z.object({
        id: z.string().describe('Workflow id'),
        name: workflowFields.name.optional(),
        description: workflowFields.description,
        nodes: workflowFields.nodes.optional(),
        connections: workflowFields.connections,
        settings: workflowFields.settings,
        active: workflowFields.active,
        tags: workflowFields.tags,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ...changes }) => {
      if (isProtectedEnvironment()) return failure(protectedMessage());
      const existing = store.getWorkflow(id);
      if (!existing) return failure(`Workflow ${id} not found`);
      const refused = denied(id, 'update');
      if (refused) return refused;
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      let merged: Record<string, unknown> = { ...existing, ...defined };
      if (changes.nodes || changes.connections) {
        merged = normalizeWorkflow({ ...merged, nodes: (changes.nodes ?? existing.nodes) as WorkflowInput['nodes'], connections: changes.connections ?? existing.connections } as WorkflowInput, existing);
      }
      const parsed = workflowSchema.safeParse(merged);
      if (!parsed.success) return failure(`Invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const { workflow: saved, extras } = governedSave({ ...existing, ...parsed.data, id } as Workflow, existing, (w) => store.saveWorkflow(w), { by: currentActorId(), source: 'mcp' });
      return json({ id: saved.id, name: saved.name, active: Boolean(saved.active), url: workflowUrl(saved.id), validation: validateWorkflow(saved), ...extras });
    },
  );

  server.registerTool(
    'validate_workflow',
    {
      title: 'Validate a workflow',
      description:
        'Check a saved workflow (id) or a draft (the same fields as create_workflow) against the installed node types: unknown types, required parameters and sub-nodes, ports and connections. Nothing is saved.',
      inputSchema: z.object({
        id: z.string().optional().describe('A saved workflow'),
        workflow: z.object(workflowFields).optional().describe('A draft, as for create_workflow'),
      }),
      annotations: READ_ONLY,
    },
    async ({ id, workflow }) => {
      if (id) {
        const saved = store.getWorkflow(id);
        if (saved && denied(id, 'read')) return denied(id, 'read')!;
        return saved ? json(validateWorkflow(saved)) : failure(`Workflow ${id} not found`);
      }
      if (!workflow) return failure('Give a workflow id or a workflow draft');
      return json(validateWorkflow(normalizeWorkflow({ ...workflow, connections: workflow.connections ?? [] } as WorkflowInput)));
    },
  );

  server.registerTool(
    'list_node_types',
    {
      title: 'List node types',
      description: 'Every installed node type (core and plugins): type, name, description, kind (trigger, action, subnode) and categories.',
      inputSchema: z.object({
        kind: z.enum(['trigger', 'action', 'subnode']).optional(),
        category: z.string().optional().describe('e.g. "AI", "Triggers", "Data"'),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, category }) => {
      const types = registry
        .nodeTypes()
        .filter((t) => (!kind || t.descriptor.kind === kind) && (!category || (t.descriptor.categories ?? []).some((c) => c.toLowerCase() === category.toLowerCase())));
      return json({ total: types.length, nodeTypes: types.map(nodeTypeSummary) });
    },
  );

  server.registerTool(
    'search_node_types',
    {
      title: 'Search node types',
      description: 'Find node types by keywords (e.g. "http request", "slack message", "if condition"), best matches first.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional().describe('Default 10') }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = registry
        .nodeTypes()
        .map((info) => {
          const d = info.descriptor;
          const name = `${info.type} ${d.displayName}`.toLowerCase();
          const keywords = (d.keywords ?? []).join(' ').toLowerCase();
          const rest = `${d.description} ${(d.categories ?? []).join(' ')} ${info.pluginName}`.toLowerCase();
          let score = 0;
          for (const word of words) score += name.includes(word) ? 3 : keywords.includes(word) ? 2 : rest.includes(word) ? 1 : 0;
          if (d.displayName.toLowerCase() === query.toLowerCase().trim()) score += 5;
          return { info, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.info.descriptor.displayName.localeCompare(b.info.descriptor.displayName));
      return json({ total: scored.length, nodeTypes: scored.slice(0, limit ?? 10).map((entry) => nodeTypeSummary(entry.info)) });
    },
  );

  server.registerTool(
    'get_node_type',
    {
      title: 'Get a node type',
      description:
        'A node type in full: its parameters (name, type, default, options, required, when they show), inputs and outputs, credentials, whether it can be an AI tool, and its outputSchema (the fields one output item holds, when the node declares it). Use the parameter names in a node\'s "parameters".',
      inputSchema: z.object({ type: z.string().describe('e.g. "core.httpRequest"') }),
      annotations: READ_ONLY,
    },
    async ({ type }) => {
      const info = registry.nodeTypes().find((t) => t.type === type);
      if (!info) return failure(`Unknown node type "${type}". Use search_node_types to find one.`);
      const { descriptor } = info;
      return json({
        ...nodeTypeSummary(info),
        plugin: info.pluginId === 'core' ? 'core' : info.pluginName,
        version: descriptor.version,
        inputs: descriptor.inputs,
        outputs: descriptor.outputs,
        ...(descriptor.credentials?.length && { credentials: descriptor.credentials }),
        ...(descriptor.toolDescription && { toolDescription: descriptor.toolDescription }),
        ...(descriptor.outputSchema && { outputSchema: descriptor.outputSchema }),
        properties: descriptor.properties,
      });
    },
  );

  server.registerTool(
    'execute_workflow',
    {
      title: 'Execute a workflow',
      description:
        'Run a saved workflow from its trigger (or a node you name) with input items, and get the result: status, error, each node\'s item counts and the last node\'s output. It runs the draft unless version is "published". With wait false it returns the execution id at once (read it later with get_execution).',
      inputSchema: z.object({
        id: z.string().describe('Workflow id'),
        input: z
          .union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe('The item (or items) the start node gets, e.g. a webhook body or the arguments of "When Called by a Workflow or Agent"'),
        startNode: z.string().optional().describe('Name or id of the node to start from; default: the manual, webhook, chat or schedule trigger'),
        wait: z.boolean().optional().describe('Wait for the run to finish (default true)'),
        version: z.enum(['draft', 'published']).optional().describe('Run the saved draft (default, to test changes) or the published version that production triggers run'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, input, startNode: ref, wait, version }) => {
      const draft = store.getWorkflow(id);
      if (!draft) return failure(`Workflow ${id} not found`);
      const refused = denied(id, 'run');
      if (refused) return refused;
      const workflow = version === 'published' ? productionWorkflowById(id) : draft;
      if (!workflow) return failure(`“${draft.name}” is not published; run the draft, or publish it first`);
      const start = startNode(workflow, ref);
      if (ref && !start) return failure(`No node "${ref}" in “${workflow.name}”`);
      const triggerItems: NodeItem[] = (Array.isArray(input) ? input : input ? [input] : [{}]).map((json) => ({ json: json as JsonObject }));
      const options = { workflow, mode: 'mcp' as const, ...(start && { startNodeId: start.id }), triggerItems };
      const trigger = startTrigger({ source: 'mcp', workflowId: workflow.id, nodeName: start?.name });
      try {
        if (wait === false) {
          const executionId = await context.with(trigger.context, () => startInBackground(options));
          trigger.end();
          return json({ executionId, status: 'running', url: `${workflowUrl(id)}/executions/${executionId}` });
        }
        const record = await context.with(trigger.context, () => runWorkflow(options));
        trigger.end();
        return json(executionDigest(record, false));
      } catch (error) {
        trigger.end(error);
        return failure((error as Error).message);
      }
    },
  );

  server.registerTool(
    'list_executions',
    {
      title: 'List executions',
      description: 'Recent executions, newest first (running ones included): id, workflow, mode, status, start time, duration, error.',
      inputSchema: z.object({
        workflowId: z.string().optional(),
        status: z.enum(['running', 'queued', 'success', 'error', 'canceled', 'waiting']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      }),
      annotations: READ_ONLY,
    },
    async ({ workflowId, status, limit }) => {
      const max = limit ?? 20;
      const seen = new Set<string>();
      const list: ExecutionSummary[] = [];
      const take = (rows: ExecutionSummary[]) => {
        for (const e of rows) {
          if (list.length >= max) return;
          if (!seen.has(e.id) && seen.add(e.id) && (!status || e.status === status) && (!actor || canResource(actor, 'workflow', e.workflowId, 'read')) && inScope(scope, e.workflowId)) list.push(e);
        }
      };
      take(liveExecutions(workflowId));
      if (!status) take(store.listExecutions({ workflowId, limit: max }));
      else if (status !== 'running') {
        // The status is filtered in SQL and saved runs are read a page at a time, never the whole history at once.
        let cursor: string | undefined;
        for (let pages = 0; list.length < max && pages < STATUS_SCAN_PAGES; pages += 1) {
          const page = listExecutionsPage({ workflowId, status, limit: 200, cursor });
          take(page.executions);
          if (!(cursor = page.nextCursor)) break;
        }
      }
      return json({
        executions: list.map((e) => ({
          id: e.id,
          workflowId: e.workflowId,
          workflowName: e.workflowName,
          mode: e.mode,
          status: e.status,
          startedAt: e.startedAt,
          durationMs: e.durationMs,
          ...(e.error && { error: e.error.message }),
        })),
      });
    },
  );

  server.registerTool(
    'get_execution',
    {
      title: 'Get an execution',
      description: 'One execution: status, error, what each node did (runs, output item counts, errors) and the last node\'s output. includeData adds every node\'s full input and output.',
      inputSchema: z.object({ id: z.string().describe('Execution id'), includeData: z.boolean().optional() }),
      annotations: READ_ONLY,
    },
    async ({ id, includeData }) => {
      const record = liveExecution(id) ?? (await store.loadExecution(id));
      if (record && (denied(record.workflowId, 'read') || !inScope(scope, record.workflowId))) return failure(`Execution ${id} not found`);
      return record ? json(executionDigest(record, Boolean(includeData))) : failure(`Execution ${id} not found`);
    },
  );

  registerDebugTools(server, {
    actor,
    scope,
    denied: (id, action) => denied(id, action),
    inScope: (id) => inScope(scope, id),
    json,
    failure,
    workflowUrl,
    digest: executionDigest,
  });

  registerBrainTools(server, { actor, scope, denied: (id, action) => denied(id, action), json, failure });

  return server;
}
