/**
 * What an agent can call. Every capability in the config becomes a tool the model sees:
 * plugin nodes run on their own (`$fromAI` fills what the model decides), workflows run
 * from their "When Called by a Workflow or Agent" trigger, sub-agents get a task, MCP servers
 * offer their tools (buildToolset lists them first), knowledge bases a search tool (knowledge.ts),
 * plus built-in tools for skills and cross-session memory.
 */
import { defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import { ExpressionResolver, deriveToolSchema, toToolName, type ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig, AgentSession, McpServerToolConfig, NodeToolConfig, SubAgentConfig, ToolKind, WorkflowToolConfig } from '../../shared/agents';
import type { ExecutionRecord } from '../../shared/types';
import { credentials } from '../credentials/vault';
import { agentToolsFrom, endpointFrom, listMcpTools, selectTools } from '../mcp/client';
import { registry } from '../plugins/registry';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { parameterSecrets, rememberResolvedParameters } from '../secrets/resolve';
import { store } from '../store';
import { variables } from '../variables';
import { knowledgeTool } from './knowledge';
import { agentStore } from './store';

export const WORKFLOW_TRIGGER = 'core.workflowTrigger';

export interface ToolContext {
  agent: Agent;
  session: AgentSession;
  /** 0 for the agent the user talks to; +1 per delegation. */
  depth: number;
  /** How deep delegation may go in this run tree. */
  maxDepth: number;
  runId: string;
  signal?: AbortSignal;
  /** Runs a sub-agent on a task in a child session (provided by the runtime, avoiding an import cycle). */
  delegate(target: Agent, task: string): Promise<{ reply?: string; sessionId: string }>;
}

export interface ToolOutcome {
  output: unknown;
  workflowId?: string;
  executionId?: string;
  childAgentId?: string;
  childSessionId?: string;
}

export interface BuiltTool extends ToolSpec {
  kind: ToolKind;
  /** What the builder calls it. */
  label: string;
  nodeType?: string;
  requireApproval: boolean;
  invoke(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

export interface Toolset {
  tools: BuiltTool[];
  /** Capabilities that can't be offered right now (offline plugin, deleted workflow…), for the run's notices. */
  unavailable: string[];
}

/** The agent's tools. MCP servers' tools are listed over the network: pass them in from buildToolset. */
export function buildTools(agent: Agent, config: AgentConfig, mcp: Toolset = { tools: [], unavailable: [] }): Toolset {
  const tools: BuiltTool[] = [...mcp.tools];
  const unavailable: string[] = [...mcp.unavailable];
  for (const tool of config.tools) {
    if (tool.type === 'mcp') continue;
    const built =
      tool.type === 'node' ? nodeTool(tool) : tool.type === 'workflow' ? workflowTool(tool) : tool.type === 'knowledge' ? knowledgeTool(tool) : subAgentTool(tool, agent);
    if ('error' in built) unavailable.push(built.error);
    else tools.push(built);
  }
  if (config.skills.length) tools.push(...skillTools(config));
  if (config.memory.crossSession) tools.push(rememberTool());
  return { tools: dedupe(tools), unavailable };
}

function dedupe(tools: BuiltTool[]): BuiltTool[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const count = seen.get(tool.name) ?? 0;
    seen.set(tool.name, count + 1);
    return count ? { ...tool, name: `${tool.name.slice(0, 60)}_${count + 1}` } : tool;
  });
}

/** buildTools plus the tools of the agent's MCP servers, listed from each server (in parallel). */
export async function buildToolset(agent: Agent, config: AgentConfig): Promise<Toolset> {
  const servers = config.tools.filter((tool): tool is McpServerToolConfig => tool.type === 'mcp');
  const listed = await Promise.all(servers.map((server) => mcpServerTools(server)));
  const mcp: Toolset = { tools: [], unavailable: [] };
  for (const result of listed) {
    if ('error' in result) mcp.unavailable.push(result.error);
    else mcp.tools.push(...result);
  }
  return buildTools(agent, config, mcp);
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export const MCP_CLIENT_TOOL = 'core.mcpClientTool';

/** Each tool an MCP server lists (after the include filter), with the server's schema. */
async function mcpServerTools(config: McpServerToolConfig): Promise<BuiltTool[] | { error: string }> {
  const resolved = registry.resolve(MCP_CLIENT_TOOL);
  if ('error' in resolved) return { error: `${config.name}: ${resolved.error}` };
  try {
    const secrets = credentials.resolveFor({ type: MCP_CLIENT_TOOL, credentials: config.credentials, parameters: config.parameters }, resolved.descriptor);
    const endpoint = endpointFrom(config.parameters, secrets);
    const { include, includeTools, excludeTools } = config.parameters;
    const tools = agentToolsFrom(endpoint, selectTools(await listMcpTools(endpoint), include, includeTools, excludeTools));
    return tools.map((tool) => ({
      // Shown with the MCP Client Tool's icon in the timeline.
      kind: 'node' as const,
      nodeType: MCP_CLIENT_TOOL,
      name: tool.name,
      label: `${config.name} · ${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requireApproval: Boolean(config.requireApproval),
      async invoke(input, ctx) {
        return { output: await tool.invoke(input, ctx.signal) };
      },
    }));
  } catch (error) {
    return { error: `${config.name}: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Plugin nodes
// ---------------------------------------------------------------------------

function nodeTool(config: NodeToolConfig): BuiltTool | { error: string } {
  const resolved = registry.resolve(config.nodeType);
  if ('error' in resolved) return { error: `${config.name}: ${resolved.error}` };
  const { descriptor } = resolved;
  const skip = new Set(descriptor.properties.filter((p) => p.noDataExpression || p.type === 'code').map((p) => p.name));
  return {
    kind: 'node',
    name: toToolName(config.name),
    label: config.name,
    nodeType: config.nodeType,
    description: config.description || descriptor.toolDescription || descriptor.description,
    inputSchema: deriveToolSchema(descriptor, config.parameters),
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      // The arguments are the node's one input item; $fromAI() reads them and same-named parameters take them.
      const items: NodeItem[] = [{ json: input as JsonObject }];
      // $secrets in the tool's parameters, when Settings → External secrets allows it.
      const secrets = await parameterSecrets(config.parameters, skip);
      const resolver = new ExpressionResolver({
        items,
        nodeOutputs: {},
        workflow: { id: `agent:${ctx.agent.id}`, name: ctx.agent.name },
        execution: { id: ctx.runId, mode: 'tool' },
        parameters: config.parameters,
        toolArgs: input,
        variables: variables.forWorkflow(`agent:${ctx.agent.id}`),
        ...(secrets && { secrets }),
      });
      const overrides = Object.fromEntries(Object.entries(input).filter(([key]) => descriptor.properties.some((p) => p.name === key)));
      const resolvedParameters = resolver.resolveParameters(config.parameters, 0, skip);
      if (secrets) rememberResolvedParameters(config.parameters, resolvedParameters, skip);
      const parameters = { ...resolvedParameters, ...overrides } as JsonObject;
      const creds = credentials.resolveFor({ type: config.nodeType, credentials: config.credentials, parameters: config.parameters }, descriptor);
      const request: ExecuteRequest = {
        protocol: PROTOCOL_VERSION,
        executionId: ctx.runId,
        workflowId: `agent:${ctx.agent.id}`,
        mode: 'tool',
        node: { id: config.id, name: config.name, type: config.nodeType, typeVersion: defaultVersionOf(descriptor) },
        parameters,
        itemParameters: [parameters],
        inputs: [items],
        ...(Object.keys(creds).length > 0 && { credentials: creds }),
      };
      const response = await resolved.execute(request, { signal: ctx.signal });
      if (response.error) throw new Error([response.error.message, response.error.description].filter(Boolean).join(' — '));
      const out = response.outputs[0] ?? [];
      return { output: out.length === 1 ? out[0].json : out.map((item) => item.json) };
    },
  };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

interface TriggerField {
  name?: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  required?: boolean;
}

/** Why a workflow can or can't be a tool, and the arguments its trigger declares. */
export function workflowToolInfo(workflowId: string) {
  // Its published version, or the saved workflow when it was never published (draft and publish).
  const workflow = workflowForCall(workflowId, 'tool');
  if (!workflow) return { eligible: false as const, reason: 'The workflow was deleted' };
  const trigger = workflow.nodes.find((n) => n.type === WORKFLOW_TRIGGER && !n.disabled);
  if (!trigger) return { eligible: false as const, workflow, reason: 'Needs a “When Called by a Workflow or Agent” trigger' };
  // "Accept All Data": any arguments.
  const passthrough = trigger.parameters.inputSource === 'passthrough';
  const fields = passthrough ? [] : ((trigger.parameters.inputs as { fields?: TriggerField[] } | undefined)?.fields ?? []).filter((f) => f.name?.trim());
  const inputSchema: JsonObject = fields.length
    ? {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((f) => [f.name!.trim(), { type: f.type === 'json' ? 'object' : (f.type ?? 'string'), ...(f.description && { description: f.description }) }]),
        ),
        required: fields.filter((f) => f.required !== false).map((f) => f.name!.trim()),
      }
    : { type: 'object', properties: {}, additionalProperties: true };
  return { eligible: true as const, workflow, trigger, inputSchema };
}

/** The last main output of a finished execution: what a workflow tool returns. */
export function lastOutput(record: ExecutionRecord): unknown {
  for (let i = record.executionOrder.length - 1; i >= 0; i--) {
    const run = record.runData[record.executionOrder[i]]?.filter((r) => r.source === 'main').at(-1);
    if (run?.status === 'success') {
      const items = run.outputs[0] ?? [];
      return items.length === 1 ? items[0].json : items.map((item) => item.json);
    }
  }
  return null;
}

function workflowTool(config: WorkflowToolConfig): BuiltTool | { error: string } {
  const info = workflowToolInfo(config.workflowId);
  if (!info.eligible) return { error: `${config.name}: ${info.reason}` };
  return {
    kind: 'workflow',
    name: toToolName(config.name || info.workflow.name),
    label: config.name || info.workflow.name,
    description: config.description || info.workflow.description || `Run the “${info.workflow.name}” workflow`,
    inputSchema: info.inputSchema,
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      // Read the workflow again: it may have been edited since the run started.
      const current = workflowToolInfo(config.workflowId);
      if (!current.eligible) throw new Error(current.reason);
      const record = await runWorkflow({ workflow: current.workflow, mode: 'tool', startNodeId: current.trigger.id, triggerItems: [{ json: input as JsonObject }], signal: ctx.signal });
      if (record.status === 'error') throw new Error(`Workflow failed: ${record.error?.message ?? 'unknown error'} (execution ${record.executionId})`);
      // A Wait (or form page) in the workflow: it goes on in the background; the tool can't wait for it.
      if (record.status === 'waiting') {
        return {
          output: { status: 'waiting', executionId: record.executionId, message: 'The workflow is waiting (for a time, a webhook call or a form) and continues in the background' },
          workflowId: current.workflow.id,
          executionId: record.executionId,
        };
      }
      return { output: lastOutput(record), workflowId: current.workflow.id, executionId: record.executionId };
    },
  };
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

function subAgentTool(config: SubAgentConfig, self: Agent): BuiltTool | { error: string } {
  const target = agentStore.get(config.agentId);
  if (!target) return { error: 'A sub-agent was deleted' };
  if (target.id === self.id) return { error: `${target.name} can't delegate to itself` };
  return {
    kind: 'agent',
    name: toToolName(`ask_${target.name}`),
    label: target.name,
    description: config.useWhen || target.description || `Delegate a task to the ${target.name} agent and get its answer`,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The task, with everything the agent needs to know: it does not see this conversation' } },
      required: ['task'],
    },
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      const latest = agentStore.get(config.agentId);
      if (!latest) throw new Error('The sub-agent was deleted');
      if (ctx.depth >= ctx.maxDepth) throw new Error(`Delegation depth ${ctx.maxDepth} reached — answer with what you have`);
      const task = String(input.task ?? '').trim();
      if (!task) throw new Error('"task" is empty');
      const result = await ctx.delegate(latest, task);
      return { output: result.reply ?? '(the sub-agent gave no answer)', childAgentId: latest.id, childSessionId: result.sessionId };
    },
  };
}

// ---------------------------------------------------------------------------
// Skills and memory
// ---------------------------------------------------------------------------

function skillTools(config: AgentConfig): BuiltTool[] {
  const names = config.skills.map((s) => s.name);
  const find = (name: unknown) => config.skills.find((s) => s.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
  const tools: BuiltTool[] = [
    {
      kind: 'skill',
      name: 'load_skill',
      label: 'Load skill',
      description: 'Load the step-by-step instructions of one of your skills. Call it before a task that matches the skill.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', enum: names, description: 'The skill name' } }, required: ['name'] },
      requireApproval: false,
      async invoke(input) {
        const skill = find(input.name);
        if (!skill) throw new Error(`No skill "${String(input.name)}". Skills: ${names.join(', ')}`);
        const references = skill.references?.map((r) => r.name) ?? [];
        return {
          output: [
            `# Skill: ${skill.name}`,
            skill.instructions,
            skill.allowedTools?.length ? `Tools this skill uses: ${skill.allowedTools.join(', ')}` : '',
            references.length ? `Reference files (read with read_skill_reference): ${references.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        };
      },
    },
  ];
  if (config.skills.some((s) => s.references?.length)) {
    tools.push({
      kind: 'skill',
      name: 'read_skill_reference',
      label: 'Read skill reference',
      description: 'Read one reference file of a skill.',
      inputSchema: { type: 'object', properties: { skill: { type: 'string', enum: names }, file: { type: 'string' } }, required: ['skill', 'file'] },
      requireApproval: false,
      async invoke(input) {
        const skill = find(input.skill);
        const file = skill?.references?.find((r) => r.name === String(input.file ?? ''));
        if (!file) throw new Error(`No reference "${String(input.file)}" in skill "${String(input.skill)}"`);
        return { output: file.content };
      },
    });
  }
  return tools;
}

function rememberTool(): BuiltTool {
  return {
    kind: 'memory',
    name: 'remember',
    label: 'Remember',
    description:
      'Save a durable fact about the user you are talking to (a preference, a decision, ongoing work) so you know it in later sessions. Not for one-off details.',
    inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'One short sentence' } }, required: ['fact'] },
    requireApproval: false,
    async invoke(input, ctx) {
      const fact = String(input.fact ?? '').trim();
      if (!fact) throw new Error('"fact" is empty');
      const notes = agentStore.remember(ctx.agent.id, ctx.session.userId, fact.slice(0, 500));
      return { output: `Saved. You now remember ${notes.length} fact(s) about this user.` };
    },
  };
}
