/**
 * What an agent can call. Every capability in the config becomes a tool the model sees:
 * plugin nodes run on their own (`$fromAI` fills what the model decides), workflows run
 * from their "When Called by a Workflow or Agent" trigger, sub-agents get a task, MCP servers
 * offer their tools (buildToolset lists them first), knowledge bases a search tool (knowledge.ts),
 * plus built-in tools for skills and cross-session memory.
 */
import { defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import { ExpressionResolver, REASON_DESCRIPTION, deriveToolSchema, toToolName, withReason, type AgentTool, type ToolSpec } from '@landflow/engine';
import type {
  A2aAgentToolConfig,
  Agent,
  AgentConfig,
  AgentSession,
  McpServerToolConfig,
  NodeToolConfig,
  PendingCall,
  RemoteRun,
  SubAgentConfig,
  ToolKind,
  WorkflowToolConfig,
} from '../../shared/agents';
import type { ExecutionRecord } from '../../shared/types';
import {
  answerMessage,
  approvalMessage,
  endpointFrom as a2aEndpointFrom,
  getAgentCard,
  hitlRequestOf,
  KAGENT_HITL_EXTENSION,
  questionTexts,
  remoteStepsOf,
  replyOf,
  stateName,
  statusText,
  supportsExtension,
  tokenUsageOf,
  type A2aEndpoint,
  type A2aResult,
  type A2aTask,
  type AgentCard,
  type HitlRequest,
  type OutgoingMessage,
} from '../a2a/client';
import { callAgent, landflowTags, remoteRunOf, throttled } from '../a2a/traced';
import { credentials } from '../credentials/vault';
import { agentToolsFrom, endpointFrom, listMcpTools, resourceAndPromptTools, selectTools } from '../mcp/client';
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
  /** `deny`: no one can approve in this run (sub-agents, workflow nodes, schedules), so a remote agent's pause is rejected. */
  approvals: 'ask' | 'deny';
  /** A remote agent's progress during this call (its tool calls as they happen), for the timeline. */
  progress?(remote: RemoteRun): void;
  /** The model's id for this call, and the journal span it is recorded under (set by the runtime while a run is journaled). */
  callId?: string;
  callSpan?: string;
}

export interface ToolOutcome {
  output: unknown;
  workflowId?: string;
  executionId?: string;
  childAgentId?: string;
  childSessionId?: string;
  /** An A2A agent's task: its tool calls and usage. */
  remote?: RemoteRun;
  /** The remote agent paused for a person's approval of its own tool calls: the run waits, then `resume` sends the decision. */
  pause?: { message: string; remote: NonNullable<PendingCall['remote']> };
}

export interface BuiltTool extends ToolSpec {
  kind: ToolKind;
  /** What the builder calls it. */
  label: string;
  nodeType?: string;
  requireApproval: boolean;
  invoke(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** After a pause (ToolOutcome.pause): send the person's decision and carry on. */
  resume?(state: Record<string, unknown>, approved: boolean, ctx: ToolContext): Promise<ToolOutcome>;
}

export interface Toolset {
  tools: BuiltTool[];
  /** Capabilities that can't be offered right now (offline plugin, deleted workflow…), for the run's notices. */
  unavailable: string[];
}

/** The agent's tools. MCP servers' tools and A2A agents' cards are read over the network: pass them in from buildToolset. */
export function buildTools(agent: Agent, config: AgentConfig, mcp: Toolset = { tools: [], unavailable: [] }): Toolset {
  const tools: BuiltTool[] = [...mcp.tools];
  const unavailable: string[] = [...mcp.unavailable];
  for (const tool of config.tools) {
    if (tool.type === 'mcp' || tool.type === 'a2a') continue;
    const built =
      tool.type === 'node' ? nodeTool(tool) : tool.type === 'workflow' ? workflowTool(tool) : tool.type === 'knowledge' ? knowledgeTool(tool) : subAgentTool(tool, agent);
    if ('error' in built) unavailable.push(built.error);
    else tools.push(built);
  }
  if (config.skills.length) tools.push(...skillTools(config));
  if (config.memory.crossSession) tools.push(rememberTool());
  return { tools: dedupe(tools), unavailable };
}

export function dedupe(tools: BuiltTool[]): BuiltTool[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const count = seen.get(tool.name) ?? 0;
    seen.set(tool.name, count + 1);
    return count ? { ...tool, name: `${tool.name.slice(0, 60)}_${count + 1}` } : tool;
  });
}

/** buildTools plus the tools of the agent's MCP servers and A2A agents, read from each (in parallel), and the flow's. */
export async function buildToolset(agent: Agent, config: AgentConfig, flow: AgentTool[] = []): Promise<Toolset> {
  const listed = await Promise.all(
    config.tools.flatMap((tool) => (tool.type === 'mcp' ? [mcpServerTools(tool)] : tool.type === 'a2a' ? [a2aAgentTool(tool).then((t) => ('error' in t ? t : [t]))] : [])),
  );
  const remote: Toolset = { tools: [], unavailable: [] };
  for (const result of listed) {
    if ('error' in result) remote.unavailable.push(result.error);
    else remote.tools.push(...result);
  }
  const built = buildTools(agent, config, remote);
  return flow.length ? { ...built, tools: dedupe([...built.tools, ...flow.map(flowTool)]) } : built;
}

/**
 * A tool connected to the agent's node in a workflow (Run an Agent): a tool node or a vector store searched as a tool.
 * The engine runs it as the node's sub-node, so it lights up on the canvas like an AI Agent's tools.
 */
export function flowTool(tool: AgentTool): BuiltTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    kind: 'flow',
    label: tool.name,
    requireApproval: false,
    async invoke(input, ctx) {
      return { output: await tool.invoke(input, ctx.signal) };
    },
  };
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
    const resolveSecrets = () => credentials.resolveFor({ type: MCP_CLIENT_TOOL, credentials: config.credentials, parameters: config.parameters }, resolved.descriptor);
    // An OAuth2 credential's token is renewed before the call (it may have expired since the last run).
    const secrets = (await credentials.freshen(resolveSecrets())) ?? resolveSecrets();
    const endpoint = endpointFrom(config.parameters, secrets);
    // A 401 mid-run (the token was revoked or expired early): renew it by force and use the new header once.
    if (config.parameters.authentication === 'mcpOAuth2') {
      endpoint.reauth = async () => {
        const renewed = await credentials.freshen(resolveSecrets(), true);
        return renewed ? endpointFrom(config.parameters, renewed).headers : undefined;
      };
    }
    const { include, includeTools, excludeTools, extras } = config.parameters;
    const tools = [
      ...agentToolsFrom(endpoint, selectTools(await listMcpTools(endpoint), include, includeTools, excludeTools)),
      // Resources and prompts as tools (list_resources, read_resource, list_prompts, get_prompt), when the server config asks.
      ...resourceAndPromptTools(endpoint, Array.isArray(extras) ? extras.map(String) : []),
    ];
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
// A2A agents
// ---------------------------------------------------------------------------

export const A2A_AGENT = 'core.a2aAgent';
/** How often a remote agent that pauses in a run where no one can approve gets a rejection before the call fails. */
const MAX_AUTO_REJECTIONS = 3;

/** The tool description: the card's description and skills, unless the builder wrote when to use it. */
function describeCard(card: AgentCard, useWhen?: string): string {
  if (useWhen?.trim()) return useWhen.trim();
  const skills = (card.skills ?? []).map((skill) => `${skill.name}${skill.description ? `: ${skill.description}` : ''}`);
  return [card.description || `Ask the ${card.name} agent`, skills.length ? `Skills: ${skills.join('; ')}` : ''].filter(Boolean).join('. ').slice(0, 1_000);
}

export interface A2aToolOptions {
  /** Where a question the remote agent asks goes: the calling agent (its tool result, the default) or a person (`onPerson` hears it; a team run routes to Needs a person). */
  questions?: 'caller' | 'person';
  onPerson?(text: string): void;
}

/** An A2A agent as an `ask_<name>` tool: its card is read when the run starts (an agent that can't be reached is a notice). */
export async function a2aAgentTool(config: A2aAgentToolConfig, toolOptions: A2aToolOptions = {}): Promise<BuiltTool | { error: string }> {
  const resolved = registry.resolve(A2A_AGENT);
  if ('error' in resolved) return { error: `${config.name}: ${resolved.error}` };
  let endpoint: A2aEndpoint;
  let card: AgentCard;
  try {
    const secrets = credentials.resolveFor({ type: A2A_AGENT, credentials: config.credentials, parameters: config.parameters }, resolved.descriptor);
    endpoint = a2aEndpointFrom(config.parameters, secrets);
    card = await getAgentCard(endpoint);
  } catch (error) {
    return { error: `${config.name}: ${(error as Error).message}` };
  }
  const options = (config.parameters.options ?? {}) as { humanInTheLoop?: boolean };
  const extensions = options.humanInTheLoop !== false && supportsExtension(card, KAGENT_HITL_EXTENSION) ? [KAGENT_HITL_EXTENSION] : [];
  const name = toToolName(`ask_${config.name}`);

  /** Send one message and turn the task it ends with into the tool's outcome. */
  async function run(message: OutgoingMessage, ctx: ToolContext, rejections = 0): Promise<ToolOutcome> {
    const metadata = { ...landflowTags({ 'agent.id': ctx.agent.id, 'session.id': ctx.session.id, 'run.id': ctx.runId }), ...message.metadata };
    const result: A2aResult = await callAgent(endpoint, card, { ...message, metadata }, { caller: 'agent', signal: ctx.signal, extensions, onUpdate: throttled(ctx.progress, card) });
    const contexts = (ctx.session.remoteContexts ??= {});
    if (result.kind === 'message') {
      if (result.message.contextId) contexts[config.id] = { contextId: result.message.contextId };
      return { output: replyOf(result) ?? `(${card.name} gave no answer)`, remote: { agent: card.name, state: 'completed', steps: [] } };
    }
    const { task } = result;
    const remote = remoteRunOf(card, task);
    contexts[config.id] = { contextId: task.contextId };
    const state = task.status.state;
    if (state === 'TASK_STATE_COMPLETED') return { output: replyOf(result) ?? `(${card.name} gave no answer)`, remote };
    if (state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_REJECTED' || state === 'TASK_STATE_CANCELED') {
      throw new Error(`${card.name}: the task ${stateName(state)}${statusText(task) ? `: ${statusText(task)}` : ''}`);
    }
    if (state === 'TASK_STATE_AUTH_REQUIRED') throw new Error(`${card.name} needs credentials Landflow can't give it${statusText(task) ? `: ${statusText(task)}` : ''}`);
    // INPUT_REQUIRED
    const request = hitlRequestOf(task);
    if (request?.type === 'tool_approval_request') {
      if (ctx.approvals === 'deny') {
        if (rejections >= MAX_AUTO_REJECTIONS) throw new Error(`${card.name} keeps asking for approvals no one can give in this kind of run`);
        const reason = 'No one can approve tool calls in this kind of run: carry on without them, or say what you would have done.';
        return run(approvalMessage(task, request, false, reason), ctx, rejections + 1);
      }
      const calls = request.tools.map((t) => ({ name: t.name, ...(t.args && { args: t.args }) }));
      return {
        output: null,
        remote,
        pause: {
          message: `${card.name} wants to run ${calls.map((c) => c.name).join(', ')}`,
          remote: { agent: card.name, calls, state: { taskId: task.id, contextId: task.contextId, request } },
        },
      };
    }
    // A question: the model answers it (or asks the user) with its next call, which goes to the same task.
    const questions = request?.type === 'ask_user_request' ? questionTexts(request) : [statusText(task) ?? 'The agent needs more input'];
    if (toolOptions.questions === 'person') {
      contexts[config.id] = { contextId: task.contextId };
      toolOptions.onPerson?.(`${card.name} asks:\n${questions.map((q) => `- ${q}`).join('\n')}`);
      return { output: `${card.name} asked a question that a person will answer. Don't ask it again: finish with what you have and say what is still open.`, remote };
    }
    contexts[config.id] = { contextId: task.contextId, taskId: task.id, ...(request?.type === 'ask_user_request' && { question: { id: request.id, questions } }) };
    return {
      output: `${card.name} asks:\n${questions.map((q) => `- ${q}`).join('\n')}\nAnswer from what you know or ask the user, then call ${name} again with the answers as the message.`,
      remote,
    };
  }

  return {
    kind: 'a2a',
    nodeType: A2A_AGENT,
    name,
    label: config.name,
    description: describeCard(card, config.useWhen),
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: `What to ask ${card.name}. It keeps the conversation across your calls, but does not see yours: say what it needs to know` },
        reason: { type: 'string', description: REASON_DESCRIPTION },
      },
      required: ['message', 'reason'],
    },
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      const text = String(input.message ?? '').trim();
      if (!text) throw new Error('"message" is empty');
      const known = ctx.session.remoteContexts?.[config.id];
      if (known?.taskId && known.question) {
        const request: Extract<HitlRequest, { type: 'ask_user_request' }> = { type: 'ask_user_request', id: known.question.id, questions: known.question.questions };
        return run(answerMessage({ id: known.taskId, contextId: known.contextId }, request, [text]), ctx);
      }
      return run({ text, ...(known?.contextId && { contextId: known.contextId }), ...(known?.taskId && { taskId: known.taskId }) }, ctx);
    },
    async resume(state, approved, ctx) {
      const { taskId, contextId, request } = state as { taskId: string; contextId: string; request: Extract<HitlRequest, { type: 'tool_approval_request' }> };
      return run(approvalMessage({ id: taskId, contextId }, request, approved, approved ? undefined : 'A person rejected this tool call.'), ctx);
    },
  };
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
    inputSchema: descriptor.delegates ? withReason(deriveToolSchema(descriptor, config.parameters)) : deriveToolSchema(descriptor, config.parameters),
    requireApproval: Boolean(config.requireApproval),
    async invoke(given, ctx) {
      // A delegating node's `reason` is for the record (the timeline shows the call's input), not for the node.
      const { reason: _reason, ...rest } = given;
      const input = descriptor.delegates ? rest : given;
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
      properties: {
        task: { type: 'string', description: 'The task, with everything the agent needs to know: it does not see this conversation' },
        reason: { type: 'string', description: REASON_DESCRIPTION },
      },
      required: ['task', 'reason'],
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
