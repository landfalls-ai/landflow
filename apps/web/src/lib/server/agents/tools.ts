/**
 * What an agent can call. Every capability in the config becomes a tool the model sees:
 * plugin nodes run on their own (`$fromAI` fills what the model decides), workflows run
 * from their "When Called by a Workflow or Agent" trigger, sub-agents get a task, MCP servers
 * offer their tools (buildToolset lists them first), knowledge bases a search tool (knowledge.ts),
 * plus built-in tools for skills and cross-session memory.
 */
import { defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import { ExpressionResolver, isToolOutputWithImages, type ToolImage, REASON_DESCRIPTION, deriveToolSchema, toolInputItem, toToolName, withReason, type AgentTool, type ToolSpec } from '@landflow/engine';
import { binaryAccessFor } from '../binary/access';
import { withProjectContext } from '../nodes/a2a';
import { binaryToolImages } from '../nodes/tool-images';
import { currentRunContext } from '../project-context/seam';
import { practicesIndexFor, recordRemoteCitations, withPracticesIndex, type PracticesIndex } from '../practices/remote';
import { holdSessionImages } from './session-images';
import type {
  A2aAgentToolConfig,
  Agent,
  AgentConfig,
  AgentSession,
  AgentTraceSummary,
  McpServerToolConfig,
  NodeKnowledgeBaseConfig,
  NodeToolConfig,
  PendingCall,
  RemoteRun,
  SubAgentConfig,
  ToolKind,
  WorkflowToolConfig,
} from '../../shared/agents';
import { isNodeKnowledge } from '../../shared/agents';
import { readsByQuery, writesOutside } from '../../shared/run-check';
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
  cancelTask as cancelRemoteTask,
} from '../a2a/client';
import { traceFor, usageOfTrace, withMarker } from '../a2a/agent-trace';
import { callAgent, landflowTags, remoteRunOf, throttled } from '../a2a/traced';
import { credentials } from '../credentials/vault';
import { safeEndpoint, type ToolTarget } from '../../shared/tool-target'; // AG14:
import { targetOfA2a, targetOfAgent, targetOfMcp, targetOfNode, targetOfWorkflow } from './tool-target'; // AG14:
import { agentToolsFrom, endpointFrom, listMcpTools, resourceAndPromptTools, selectTools } from '../mcp/client';
import { githubMcpUrl, githubToolsOf, isGithubPreset } from '../mcp/github';
import { registry } from '../plugins/registry';
import { workflowForCall } from '../publish';
import { runWorkflow } from '../runner';
import { parameterSecrets, rememberResolvedParameters } from '../secrets/resolve';
import { store } from '../store';
import { variables } from '../variables';
import { knowledgeTool } from './knowledge';
import { agentStore } from './store';
import { callDestinations } from './spotlight-approvals'; // AG23:

export const WORKFLOW_TRIGGER = 'core.workflowTrigger';

/**
 * Who a workflow an agent's tool runs is run for: the workflow run the agent works in (its sub-execution: it takes that
 * run's starter, and the briefing nodes check that run), or the person who asked (`startedBy`). Empty: nobody, so the
 * run has no starter (runner/run.ts never takes one from the request around it for a tool call).
 */
export interface ToolCaller {
  execution?: { executionId: string; nodeId?: string };
  startedBy?: string;
}

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
  /** Who the workflows its tools start are run for (see ToolCaller). */
  caller?: ToolCaller;
}

/**
 * Where a run's files (screenshots a tool returns) are stored: with the workflow execution the agent runs in, so they go
 * when it does; else under the session (session-images.ts), kept as long as the session is, so a chat's images can be read back.
 */
export const binaryScopeFor = (ctx: Pick<ToolContext, 'session' | 'runId'>): string =>
  ctx.session?.execution?.executionId ?? (ctx.session?.id ? holdSessionImages(ctx.session.id) : ctx.runId);

export interface ToolOutcome {
  output: unknown;
  /** Images the tool returned (a screenshot): inline bytes or references; the runtime stores them and shows them to a model that sees. */
  images?: ToolImage[];
  /** AG14: what this call reached, when only the call knows it (a knowledge search's document count). */
  target?: ToolTarget;
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
  /** AG14: what the tool reaches (the credential or system and where), set when it is built from its config; never a secret. */
  target?: ToolTarget;
  /** AG14: the target when the model gives the place (an HTTP Request's URL): per call, from the call's input. */
  targetOf?(input: Record<string, unknown>): ToolTarget | undefined;
  requireApproval: boolean;
  /** A knowledge base search: what it returns is what the output guardrail's grounded check judges an answer against. */
  knowledge?: boolean;
  invoke(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** A node tool that takes only what its schema offered ($fromAI, toolInputSchema): the call's input without the rest, so an approval card shows what runs. */
  shownInput?(input: Record<string, unknown>): Record<string, unknown>;
  /**
   * A tool configured as a read whose call would not be one (the model passed another operation, or SQL that changes data): the
   * reason to hold it for a person, decided per call on the effective parameters. Undefined when the call may run.
   */
  holdReason?(input: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined>;
  /** AG23: where this call would go (what Spotlight checks before it approves a call that asks first): per call, on the parameters it would run with. Absent: the tool names no destination. */
  destinationsOf?(input: Record<string, unknown>, ctx: ToolContext): Promise<string[]>;
  /** After a pause (ToolOutcome.pause): send the person's decision and carry on. */
  resume?(state: Record<string, unknown>, approved: boolean, ctx: ToolContext, answer?: string): Promise<ToolOutcome>;
  /** A remote agent: stop the task it works on (A2A CancelTask), so a person can redirect it (agent-teams/pause.ts). */
  cancelTask?(taskId: string): Promise<void>;
}

/** AG14: what a call reached: the per-call target (the model's URL), else the one set when the tool was built. */
export function targetOfCall(tool: BuiltTool, input: Record<string, unknown>): ToolTarget | undefined {
  try {
    return tool.targetOf?.(input) ?? tool.target;
  } catch {
    return tool.target;
  }
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
      tool.type === 'node'
        ? nodeTool(tool)
        : tool.type === 'workflow'
          ? workflowTool(tool)
          : tool.type === 'knowledge'
            ? isNodeKnowledge(tool)
              ? nodeKnowledgeTool(tool)
              : knowledgeTool(tool)
            : subAgentTool(tool, agent);
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
export async function buildToolset(agent: Agent, config: AgentConfig, flow: AgentTool[] = [], flowTargets?: Map<string, ToolTarget>): Promise<Toolset> {
  const listed = await Promise.all(
    config.tools.flatMap((tool) => (tool.type === 'mcp' ? [mcpServerTools(tool)] : tool.type === 'a2a' ? [a2aAgentTool(tool).then((t) => ('error' in t ? t : [t]))] : [])),
  );
  const remote: Toolset = { tools: [], unavailable: [] };
  for (const result of listed) {
    if ('error' in result) remote.unavailable.push(result.error);
    else remote.tools.push(...result);
  }
  const built = buildTools(agent, config, remote);
  return flow.length ? { ...built, tools: dedupe([...built.tools, ...flow.map((tool) => flowTool(tool, flowTargets?.get(tool.name)))]) } : built;
}

/**
 * A tool connected to the agent's node in a workflow (Run an Agent): a tool node or a vector store searched as a tool.
 * The engine runs it as the node's sub-node, so it lights up on the canvas like an AI Agent's tools.
 */
export function flowTool(tool: AgentTool, target?: ToolTarget): BuiltTool {
  return {
    ...(target && { target }), // AG14: what the wired sub-node reaches
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    kind: 'flow',
    label: tool.name,
    requireApproval: false,
    async invoke(input, ctx) {
      const output = await tool.invoke(input, ctx.signal);
      // A tool's images go to the runtime, which stores them and shows them to a model that can see; the plain result stays the output.
      return isToolOutputWithImages(output) ? { output: output.value ?? output.text, images: output.images } : { output };
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
    const github = isGithubPreset(config);
    // GitHub's server: the bundled one unless the agent names another; always a bearer token, which is the credential.
    const parameters = github
      ? { ...config.parameters, authentication: 'bearerAuth', endpointUrl: String(config.parameters.endpointUrl ?? '').trim() || githubMcpUrl() }
      : config.parameters;
    const resolveSecrets = () => credentials.resolveFor({ type: MCP_CLIENT_TOOL, credentials: config.credentials, parameters }, resolved.descriptor);
    // An OAuth2 credential's token is renewed before the call (it may have expired since the last run).
    const secrets = (await credentials.freshen(resolveSecrets())) ?? resolveSecrets();
    const endpoint = endpointFrom(parameters, secrets);
    // A 401 mid-run (the token was revoked or expired early): renew it by force and use the new header once.
    if (parameters.authentication === 'mcpOAuth2') {
      endpoint.reauth = async () => {
        const renewed = await credentials.freshen(resolveSecrets(), true);
        return renewed ? endpointFrom(parameters, renewed).headers : undefined;
      };
    }
    const { include, includeTools, excludeTools, extras } = parameters;
    const tools = [
      // GitHub's server: only what the agent's access allows, whatever the server lists (lib/server/mcp/github.ts).
      ...agentToolsFrom(endpoint, github ? githubToolsOf(config, await listMcpTools(endpoint)) : selectTools(await listMcpTools(endpoint), include, includeTools, excludeTools)),
      // Resources and prompts as tools (list_resources, read_resource, list_prompts, get_prompt), when the server config asks.
      ...(github ? [] : resourceAndPromptTools(endpoint, Array.isArray(extras) ? extras.map(String) : [])),
    ];
    return tools.map((tool) => ({
      // Shown with the MCP Client Tool's icon in the timeline.
      kind: 'node' as const,
      nodeType: MCP_CLIENT_TOOL,
      name: tool.name,
      label: `${config.name} · ${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      target: targetOfMcp(config.name, parameters, config.credentials), // AG14:
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
  /**
   * Where a question the remote agent asks goes: the calling agent (its tool result, the default), a person who answers
   * later (`person`: `onPerson` hears it and the caller is told to finish without it), or a person the run waits for
   * (`pause`: the call pauses on the question like an approval, and the person's answer goes to the same task).
   */
  questions?: 'caller' | 'person' | 'pause';
  onPerson?(text: string): void;
}

/** A remote run with what the agent's mod reported: its usage (unless the task carried its own) and the trace. */
export function withTrace(remote: RemoteRun, summary: AgentTraceSummary | undefined): RemoteRun {
  if (!summary) return remote;
  const usage = remote.usage ?? usageOfTrace(summary);
  return { ...remote, ...(usage && { usage }), trace: summary };
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
  const options = (config.parameters.options ?? {}) as { humanInTheLoop?: boolean; projectContext?: string; practices?: 'on' | 'off' };
  const extensions = options.humanInTheLoop !== false && supportsExtension(card, KAGENT_HITL_EXTENSION) ? [KAGENT_HITL_EXTENSION] : [];
  const name = toToolName(`ask_${config.name}`);

  /**
   * Send one message and turn the task it ends with into the tool's outcome. A Landflow agent on kagent with the
   * landflow-harness mod reports what it does to a trace for this call (a2a/agent-trace.ts): its real usage, cost, tool
   * calls and guardrail stops replace the estimate.
   */
  /** The practices indexed to a session's conversation, kept until the answer that completes it (a pause or a question comes first). A pause carries them in its saved state; a question to the caller keeps them in memory for this run only (a restart loses them, and `practice_cite` still records). */
  const indexed = new Map<string, PracticesIndex>();
  /** Records the citations of an answer that completes the conversation; a pause or a question to the caller keeps the index for the answer to come. */
  function settle(outcome: ToolOutcome, ctx: ToolContext): ToolOutcome {
    const index = indexed.get(ctx.session.id);
    if (!index) return outcome;
    // A pause ends this run: the resume is a new run with a new tool, so the index travels in the saved state.
    if (outcome.pause) {
      outcome.pause.remote.state = { ...outcome.pause.remote.state, practices: index };
      return outcome;
    }
    // The task is still open (a question with or without the extension): the answer to come completes it.
    if (ctx.session.remoteContexts?.[config.id]?.taskId) return outcome;
    indexed.delete(ctx.session.id);
    recordRemoteCitations(index, typeof outcome.output === 'string' ? outcome.output : JSON.stringify(outcome.output ?? ''), ctx.session.execution?.executionId);
    return outcome;
  }

  async function run(message: OutgoingMessage, ctx: ToolContext, rejections = 0): Promise<ToolOutcome> {
    const metadata = { ...landflowTags({ 'agent.id': ctx.agent.id, 'session.id': ctx.session.id, 'run.id': ctx.runId }), ...message.metadata };
    // In a run the member's asks (a push to main its guard puts to a person) show under this request.
    const where = ctx.session.execution && { executionId: ctx.session.execution.executionId, workflowId: ctx.session.execution.workflowId, nodeId: ctx.session.execution.nodeId, member: ctx.agent.name, ...(ctx.callSpan && { spanId: ctx.callSpan }) };
    const trace = message.text && !message.taskId ? traceFor(endpoint.url, where || undefined) : undefined;
    const progress = ctx.progress && trace ? (remote: RemoteRun) => ctx.progress!(withTrace(remote, trace.summary())) : ctx.progress;
    let result: A2aResult;
    let summary: AgentTraceSummary | undefined;
    try {
      result = await callAgent(endpoint, card, { ...withMarker(message, trace), metadata }, { caller: 'agent', signal: ctx.signal, extensions, onUpdate: throttled(progress, card) });
    } finally {
      summary = await trace?.close();
    }
    const contexts = (ctx.session.remoteContexts ??= {});
    if (result.kind === 'message') {
      if (result.message.contextId) contexts[config.id] = { contextId: result.message.contextId };
      return { output: replyOf(result) ?? `(${card.name} gave no answer)`, remote: withTrace({ agent: card.name, state: 'completed', steps: [] }, summary) };
    }
    const { task } = result;
    const remote = withTrace(remoteRunOf(card, task), summary);
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
    if (toolOptions.questions === 'pause') {
      contexts[config.id] = { contextId: task.contextId };
      const ask = `${card.name} asks:\n${questions.map((q) => `- ${q}`).join('\n')}`;
      return {
        output: null,
        remote,
        pause: { message: ask, remote: { agent: card.name, calls: [], state: { taskId: task.id, contextId: task.contextId, question: { id: request?.type === 'ask_user_request' ? request.id : '', questions }, ask } } },
      };
    }
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
    target: targetOfA2a(config.name, config.parameters, config.credentials), // AG14:
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
    async cancelTask(taskId) {
      await cancelRemoteTask(endpoint, taskId);
    },
    async invoke(input, ctx) {
      const text = String(input.message ?? '').trim();
      if (!text) throw new Error('"message" is empty');
      const known = ctx.session.remoteContexts?.[config.id];
      if (known?.taskId && known.question) {
        const request: Extract<HitlRequest, { type: 'ask_user_request' }> = { type: 'ask_user_request', id: known.question.id, questions: known.question.questions };
        return settle(await run(answerMessage({ id: known.taskId, contextId: known.contextId }, request, [text]), ctx), ctx);
      }
      // The first message of a conversation carries the project's compact block (docs/a2a.md); follow-ups go as they are, and the capability's option Project context: Off sends nothing.
      const fresh = !known?.contextId && !known?.taskId && options.projectContext !== 'off';
      // PR07: a Landflow agent on kagent also gets the index of the practices that apply, after the project block the text may already begin with (a team's runtime puts it there).
      const brandNew = !known?.contextId && !known?.taskId;
      const index = brandNew ? practicesIndexFor(config.parameters.agentUrl as string, options.practices, text) : undefined;
      const block = currentRunContext()?.compact;
      const { text: sent, tags } = withProjectContext(withPracticesIndex(text, index?.text ?? '', block), fresh ? currentRunContext() : undefined);
      if (index) indexed.set(ctx.session.id, index);
      const outcome = await run({ text: sent, ...(Object.keys(tags).length > 0 && { metadata: tags }), ...(known?.contextId && { contextId: known.contextId }), ...(known?.taskId && { taskId: known.taskId }) }, ctx);
      return settle(outcome, ctx);
    },
    async resume(state, approved, ctx, answer) {
      const carried = (state as { practices?: PracticesIndex }).practices;
      if (carried) indexed.set(ctx.session.id, carried);
      const { taskId, contextId, request, question } = state as { taskId: string; contextId: string; request?: Extract<HitlRequest, { type: 'tool_approval_request' }>; question?: { id: string; questions: string[] } };
      // A question a person answered: the answer goes to the same task (as a plain reply when the agent asked without the extension).
      if (question) {
        const text = answer?.trim() || 'No one answered: carry on with what you have and say what is still open.';
        if (!question.id) return settle(await run({ text, contextId, taskId }, ctx), ctx);
        return settle(await run(answerMessage({ id: taskId, contextId }, { type: 'ask_user_request', id: question.id, questions: question.questions }, [text]), ctx), ctx);
      }
      return settle(await run(approvalMessage({ id: taskId, contextId }, request!, approved, approved ? undefined : 'A person rejected this tool call.'), ctx), ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin nodes
// ---------------------------------------------------------------------------

/** Whether a call's parameters only read: the operation the plugin marks idempotent, an Execute Query that is one SELECT (SQLite), else the shared heuristic. */
function callReads(descriptor: { properties: Array<{ name: string; default?: unknown; options?: Array<{ value: unknown; idempotent?: boolean }> }> }, nodeType: string, parameters: Record<string, unknown>): boolean {
  const property = descriptor.properties.find((p) => p.name === 'operation');
  const operation = parameters.operation ?? property?.default;
  if (operation === 'executeQuery' && nodeType === 'databases.sqlite') return readsByQuery({ ...parameters, operation }, nodeType);
  if (property?.options?.some((o) => o.idempotent === true) && typeof operation === 'string') return property.options.find((o) => o.value === operation)?.idempotent === true;
  return !writesOutside({ type: nodeType, parameters: { ...parameters, ...(operation !== undefined && { operation }) } });
}

/** The SQLite credential as a read-only connection (the plugin's Read Only: mode=ro, _query_only=1); a file it would create is never made. */
export function readOnlyCreds<T extends Record<string, JsonObject>>(creds: T): Partial<T> {
  return creds.sqlite ? ({ sqlite: { ...creds.sqlite, readOnly: true, createIfMissing: false } } as unknown as Partial<T>) : {};
}

function nodeTool(config: NodeToolConfig): BuiltTool | { error: string } {
  const resolved = registry.resolve(config.nodeType);
  if ('error' in resolved) return { error: `${config.name}: ${resolved.error}` };
  const { descriptor } = resolved;
  const skip = new Set(descriptor.properties.filter((p) => p.noDataExpression || p.type === 'code').map((p) => p.name));
  const derived = descriptor.delegates ? withReason(deriveToolSchema(descriptor, config.parameters)) : deriveToolSchema(descriptor, config.parameters);
  // A tool configured as a read (no approval, and its stored parameters only read) keeps its operation: the model may not offer another.
  const isRead = !config.requireApproval && callReads(descriptor, config.nodeType, config.parameters);
  const pinned = isRead && (derived.properties as Record<string, unknown> | undefined)?.operation !== undefined;
  const inputSchema: JsonObject = pinned
    ? { ...derived, properties: Object.fromEntries(Object.entries(derived.properties as Record<string, unknown>).filter(([k]) => k !== 'operation')) as JsonObject, ...(Array.isArray(derived.required) && { required: (derived.required as string[]).filter((k) => k !== 'operation') }) }
    : derived;
  /** The parameters a call runs with: the stored ones resolved, then the arguments the schema offered over them. */
  async function effectiveOf(given: Record<string, unknown>, ctx: ToolContext) {
      // A delegating node's `reason` is for the record (the timeline shows the call's input), not for the node.
      const { reason: _reason, ...rest } = given;
      const input = descriptor.delegates ? rest : given;
      // The arguments are the node's one input item; $fromAI() reads them and same-named parameters take them.
      // AG03: with the generated `item` argument, that is the item and the other arguments are the overrides.
      const { json: itemJson, rest: toolArgs } = toolInputItem(inputSchema, input);
      const items: NodeItem[] = [{ json: itemJson }];
      // $secrets in the tool's parameters, when Settings → External secrets allows it.
      const secrets = await parameterSecrets(config.parameters, skip);
      const resolver = new ExpressionResolver({
        items,
        nodeOutputs: {},
        workflow: { id: `agent:${ctx.agent.id}`, name: ctx.agent.name },
        execution: { id: ctx.runId, mode: 'tool' },
        parameters: config.parameters,
        toolArgs,
        variables: variables.forWorkflow(`agent:${ctx.agent.id}`),
        ...(secrets && { secrets }),
      });
      // AG08: only an argument the tool's own schema offered overrides a parameter (a To the design fixed is not one a $fromAI or toolInputSchema tool takes).
      const offered = (inputSchema.properties ?? {}) as Record<string, unknown>;
      const overrides = Object.fromEntries(Object.entries(toolArgs).filter(([key]) => key in offered && descriptor.properties.some((p) => p.name === key)));
      const resolvedParameters = resolver.resolveParameters(config.parameters, 0, skip);
      if (secrets) rememberResolvedParameters(config.parameters, resolvedParameters, skip);
      const parameters = { ...resolvedParameters, ...overrides } as JsonObject;
    return { parameters, items };
  }
  return {
    kind: 'node',
    name: toToolName(config.name),
    label: config.name,
    nodeType: config.nodeType,
    // AG14: where the call goes, from the credential and the node's own parameters; a URL the model gives (HTTP Request) is read per call.
    target: targetOfNode(config.nodeType, config.credentials, config.parameters),
    ...(descriptor.properties.some((p) => p.name === 'url') && !safeEndpoint(config.parameters.url) && {
      targetOf: (given: Record<string, unknown>) => targetOfNode(config.nodeType, config.credentials, { ...config.parameters, url: given.url }),
    }),
    description: config.description || descriptor.toolDescription || descriptor.description,
    inputSchema,
    requireApproval: Boolean(config.requireApproval),
    // AG08: the arguments the tool's schema did not offer are never used, so they are not shown for approval either.
    ...((descriptor.toolInputSchema || JSON.stringify(config.parameters).includes('$fromAI')) && {
      shownInput: (given: Record<string, unknown>) => Object.fromEntries(Object.entries(given).filter(([key]) => key in ((inputSchema.properties ?? {}) as Record<string, unknown>))),
    }),
    ...(isRead && {
      async holdReason(given: Record<string, unknown>, ctx: ToolContext) {
        const { parameters } = await effectiveOf(given, ctx);
        // An operation the call names is judged as named, though a pinned schema would not apply it.
        const judged = { ...parameters, ...(typeof given.operation === 'string' && { operation: given.operation }), ...(typeof given.method === 'string' && { method: given.method.toUpperCase() }) };
        if (callReads(descriptor, config.nodeType, judged)) return undefined;
        const what = judged.operation === 'executeQuery' ? 'SQL that is not one read-only SELECT' : judged.operation !== undefined ? `the operation “${String(judged.operation)}”` : judged.method !== undefined ? `the ${String(judged.method)} method` : 'a change';
        return `“${config.name}” is a read-only tool, and this call asked for ${what}.`;
      },
    }),
    // AG23:
    async destinationsOf(given: Record<string, unknown>, ctx: ToolContext) {
      const { parameters } = await effectiveOf(given, ctx);
      return callDestinations(config.nodeType, { ...parameters, ...(typeof given.operation === 'string' && { operation: given.operation }), ...(typeof given.method === 'string' && { method: given.method }) });
    },
    async invoke(given, ctx) {
      const { parameters, items } = await effectiveOf(given, ctx);
      const creds = { ...credentials.resolveFor({ type: config.nodeType, credentials: config.credentials, parameters: config.parameters }, descriptor) };
      // A read tool on SQLite reaches the file through a read-only connection, whatever the call asks (defence in depth).
      if (isRead && config.nodeType === 'databases.sqlite') Object.assign(creds, readOnlyCreds(creds));
      const request: ExecuteRequest = {
        protocol: PROTOCOL_VERSION,
        // Also where the host writes the files an in-process node stores (a screenshot): the execution's or the session's scope.
        executionId: binaryScopeFor(ctx),
        workflowId: `agent:${ctx.agent.id}`,
        mode: 'tool',
        node: { id: config.id, name: config.name, type: config.nodeType, typeVersion: defaultVersionOf(descriptor) },
        parameters,
        itemParameters: [parameters],
        inputs: [items],
        ...(Object.keys(creds).length > 0 && { credentials: creds }),
        // So a plugin can store a file over 64 KiB (a full-page screenshot) and hand back a reference.
        binaryAccess: binaryAccessFor(binaryScopeFor(ctx), [items]),
      };
      const response = await resolved.execute(request, { signal: ctx.signal });
      if (response.error) throw new Error([response.error.message, response.error.description].filter(Boolean).join(' — '));
      const out = response.outputs[0] ?? [];
      // A screenshot the node attaches (item.binary) reaches the model as an image, up to four per call.
      const images = out.flatMap((item) => binaryToolImages(item.binary)).slice(0, 4);
      return { output: out.length === 1 ? out[0].json : out.map((item) => item.json), ...(images.length && { images }) };
    },
  };
}

/** The knowledge tool's argument: what the model asks. */
const KNOWLEDGE_QUERY_SCHEMA: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string', description: 'What to look for, in natural language' } },
  required: ['query'],
};

/** A node's answer as knowledge results: `{ results }` as it is, else each item as one result. */
export function knowledgeResults(output: unknown): { results: unknown[] } {
  if (output && typeof output === 'object' && !Array.isArray(output) && Array.isArray((output as { results?: unknown }).results)) return { results: (output as { results: unknown[] }).results };
  const items = Array.isArray(output) ? output : output === undefined || output === null ? [] : [output];
  return { results: items.map((item) => (item && typeof item === 'object' && 'pageContent' in item ? item : { pageContent: typeof item === 'string' ? item : JSON.stringify(item), metadata: {} })) };
}

/**
 * A knowledge base a plugin node answers (Clickland's knowledge search): the node runs on the same path as a node tool,
 * with its fixed parameters and the question in `queryParameter`, and the model sees `{ query }` in, `{ results }` out.
 * `knowledge: true`, so the grounded-answer guardrail judges answers against what it returned.
 */
export function nodeKnowledgeTool(config: NodeKnowledgeBaseConfig): BuiltTool | { error: string } {
  const label = config.name || config.nodeType || 'Knowledge base';
  if (!config.nodeType?.trim()) return { error: `${label}: no plugin node set` };
  const queryParameter = config.queryParameter?.trim() || 'query';
  const built = nodeTool({ id: config.id, type: 'node', name: config.name || 'search_knowledge_base', description: config.description, nodeType: config.nodeType, parameters: { ...(config.parameters as JsonObject) }, ...(config.credentials && { credentials: config.credentials }) });
  if ('error' in built) return { error: `${label}: ${built.error.replace(/^[^:]*: /, '')}` };
  const resolved = registry.resolve(config.nodeType);
  if (!('error' in resolved) && !resolved.descriptor.properties.some((p) => p.name === queryParameter)) return { error: `${label}: ${config.nodeType} has no “${queryParameter}” parameter for the question` };
  return {
    ...built,
    knowledge: true,
    label,
    description: config.description || built.description,
    inputSchema: KNOWLEDGE_QUERY_SCHEMA,
    requireApproval: Boolean(config.requireApproval),
    ...(built.holdReason && { holdReason: (input: Record<string, unknown>, ctx: ToolContext) => built.holdReason!({ [queryParameter]: String(input.query ?? '') }, ctx) }),
    async invoke(input, ctx) {
      const outcome = await built.invoke({ [queryParameter]: String(input.query ?? '') }, ctx);
      return { ...outcome, output: knowledgeResults(outcome.output) };
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
    target: targetOfWorkflow(info.workflow.name), // AG14:
    name: toToolName(config.name || info.workflow.name),
    label: config.name || info.workflow.name,
    description: config.description || info.workflow.description || `Run the “${info.workflow.name}” workflow`,
    inputSchema: info.inputSchema,
    requireApproval: Boolean(config.requireApproval),
    async invoke(input, ctx) {
      // Read the workflow again: it may have been edited since the run started.
      const current = workflowToolInfo(config.workflowId);
      if (!current.eligible) throw new Error(current.reason);
      // Run for the agent's caller (ToolCaller), never for whoever's request is around the call.
      const caller = ctx.caller ?? {};
      const runFor = caller.execution ? { parent: caller.execution } : caller.startedBy ? { startedBy: caller.startedBy } : {};
      const record = await runWorkflow({ workflow: current.workflow, mode: 'tool', startNodeId: current.trigger.id, triggerItems: [{ json: input as JsonObject }], signal: ctx.signal, ...runFor });
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
    target: targetOfAgent(target.name), // AG14:
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
