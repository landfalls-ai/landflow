/**
 * The agent loop. One run = one user message (or schedule prompt, or resumed approval):
 * model turn → tool calls (concurrently, `toolConcurrency` at a time) → results → next turn,
 * until the model answers, a tool needs a person's approval, the iteration limit or the
 * session's token budget is reached. Every run is an `invoke_agent` span; the session keeps
 * the transcript (session memory) and the timeline the UI shows.
 */
import { nanoid } from 'nanoid';
import type { AgentMessage, ToolCall, ToolResult } from '@landflow/engine';
import type {
  Agent,
  AgentConfig,
  AgentSession,
  AgentStreamEvent,
  PendingCall,
  RunEndReason,
  SessionSource,
  TimelineEntry,
  TokenUsage,
} from '../../shared/agents';
import { bus } from '../bus';
import { singleton } from '../singleton';
import { activeTraceIds, logger, recordAgentTokens, recordApproval, traceAgentRun, traceToolCall, traceUrl } from '../telemetry';
import { agentModel } from './models';
import { agentStore, configOf } from './store';
import { buildToolset, type BuiltTool, type ToolContext } from './tools';

const MAX_RESULT_CHARS = 16_000;
const MAX_USER_TURNS_IN_CONTEXT = 30;

export interface RunRequest {
  agent: Agent;
  session: AgentSession;
  /** A new user message; absent when resuming after approvals. */
  message?: string;
  depth?: number;
  /** Delegation limit of the whole tree: set by the agent the user talks to, inherited by sub-agents. */
  maxDepth?: number;
  /** `deny`: tools that need approval fail instead of pausing (sub-agents, workflow nodes, schedules). */
  approvals?: 'ask' | 'deny';
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
  /** Start a new trace (schedules, channels) instead of joining the caller's. */
  rootTrace?: boolean;
}

export interface RunResult {
  session: AgentSession;
  reply?: string;
  reason: RunEndReason;
  usage: TokenUsage;
}

const running = singleton('agent-runs', () => new Set<string>());

/** Whether a run is in progress on the session (in this process). */
export const isRunning = (sessionId: string) => running.has(sessionId);

const entryId = () => `t_${nanoid(8)}`;
const now = () => new Date().toISOString();

/** The config a session runs on: the draft, or the published version it started with. */
export function configFor(agent: Agent, version: AgentSession['version']): AgentConfig {
  if (version === 'draft') return configOf(agent);
  return agent.history.find((v) => v.version === version)?.config ?? agent.published?.config ?? configOf(agent);
}

export function newSession(
  agent: Agent,
  options: {
    source: SessionSource;
    userId: string;
    version: AgentSession['version'];
    title?: string;
    parentSessionId?: string;
    parentAgentId?: string;
    conversationKey?: string;
  },
): AgentSession {
  const at = now();
  return {
    id: `as_${nanoid(12)}`,
    agentId: agent.id,
    agentName: agent.name,
    source: options.source,
    userId: options.userId,
    title: options.title ?? 'New session',
    status: 'idle',
    version: options.version,
    messages: [],
    timeline: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    traceIds: [],
    ...(options.parentSessionId && { parentSessionId: options.parentSessionId }),
    ...(options.parentAgentId && { parentAgentId: options.parentAgentId }),
    ...(options.conversationKey && { conversationKey: options.conversationKey }),
    createdAt: at,
    updatedAt: at,
  };
}

function systemPrompt(agent: Agent, config: AgentConfig, session: AgentSession): string {
  const parts = [config.instructions.trim() || 'You are a helpful assistant.'];
  if (config.skills.length) {
    parts.push(
      [
        '## Skills',
        'Skills are step-by-step instructions for specific tasks. When a task matches a skill, call load_skill first and follow it.',
        ...config.skills.map((s) => `- ${s.name}: ${s.whenToUse}`),
      ].join('\n'),
    );
  }
  if (config.memory.crossSession) {
    const notes = agentStore.memories(agent.id, session.userId);
    parts.push(
      [
        '## What you remember about this user',
        notes.length ? notes.map((n) => `- ${n.text} (${n.at.slice(0, 10)})`).join('\n') : '(nothing yet)',
        'Use the remember tool for durable facts worth knowing next time.',
      ].join('\n'),
    );
  }
  parts.push(`You are “${config.name}”${config.description ? `: ${config.description}` : ''}. Current date and time: ${new Date().toISOString()}.`);
  return parts.join('\n\n');
}

/** The transcript the model sees: the last N user turns, cut at a user message so tool calls stay paired. */
function contextWindow(messages: AgentMessage[]): AgentMessage[] {
  const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  return starts.length > MAX_USER_TURNS_IN_CONTEXT ? messages.slice(starts[starts.length - MAX_USER_TURNS_IN_CONTEXT]) : messages;
}

function asContent(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} chars]` : text;
}

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Run the agent once on a session. Rejects if the session is already running. */
export async function runAgent(request: RunRequest): Promise<RunResult> {
  const { agent } = request;
  let session = request.session;
  if (running.has(session.id)) throw new Error('This session is already running — wait for the reply');
  running.add(session.id);
  const config = configFor(agent, session.version);
  const depth = request.depth ?? 0;
  const maxDepth = request.maxDepth ?? Math.min(5, Math.max(1, config.settings.maxDelegationDepth));

  const emit = (event: AgentStreamEvent) => {
    request.onEvent?.(event);
    bus.publish({ channel: 'agent', agentId: agent.id, event });
  };
  const upsert = (entry: TimelineEntry) => {
    const index = session.timeline.findIndex((e) => e.id === entry.id);
    if (index >= 0) session.timeline[index] = entry;
    else session.timeline.push(entry);
    emit({ type: 'entry', sessionId: session.id, entry });
  };

  try {
    return await traceAgentRun(
      {
        agentId: agent.id,
        agentName: config.name,
        sessionId: session.id,
        source: session.source,
        version: String(session.version),
        ...(config.model && { model: { provider: config.model.provider, model: config.model.model } }),
        root: request.rootTrace,
      },
      async () => {
        const traceId = activeTraceIds()?.traceId;
        if (traceId) session.traceIds = [...session.traceIds, traceId].slice(-50);
        session.status = 'running';
        const link = traceUrl(traceId);
        emit({ type: 'run.started', sessionId: session.id, ...(traceId && { traceId }), ...(link && { traceUrl: link }) });
        if (request.message !== undefined) {
          const text = request.message.trim();
          if (session.timeline.every((e) => e.type !== 'user')) session.title = text.slice(0, 80) || session.title;
          session.messages.push({ role: 'user', content: text });
          upsert({ id: entryId(), type: 'user', text, at: now(), ...(session.source !== 'test' && { from: session.userId }) });
        }
        session = agentStore.saveSession(session);
        const result = await loop();
        session.status = result.reason === 'awaiting_approval' ? 'awaiting_approval' : result.reason === 'error' ? 'error' : 'idle';
        session = agentStore.saveSession(session);
        logger.info('agent run finished', {
          'gen_ai.agent.id': agent.id,
          'gen_ai.agent.name': config.name,
          'gen_ai.conversation.id': session.id,
          'landflow.agent.source': session.source,
          'landflow.agent.end_reason': result.reason,
        });
        emit({ type: 'run.finished', sessionId: session.id, status: session.status, reason: result.reason, usage: session.usage, ...(result.reply !== undefined && { reply: result.reply }) });
        return { session, reason: result.reason, usage: session.usage, ...(result.reply !== undefined && { reply: result.reply }) };
      },
    );
  } finally {
    running.delete(session.id);
  }

  async function loop(): Promise<{ reason: RunEndReason; reply?: string }> {
    let model;
    let toolset;
    try {
      model = agentModel(config.model);
      toolset = await buildToolset(agent, config);
    } catch (error) {
      upsert({ id: entryId(), type: 'error', message: (error as Error).message, at: now() });
      return { reason: 'error' };
    }
    for (const note of toolset.unavailable) upsert({ id: entryId(), type: 'notice', message: `Tool unavailable: ${note}`, at: now() });
    const byName = new Map(toolset.tools.map((t) => [t.name, t]));
    const specs = toolset.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const ctx: ToolContext = {
      agent: { ...agent, ...config },
      session,
      depth,
      maxDepth,
      runId: `ar_${nanoid(10)}`,
      signal: request.signal,
      delegate: (target, task) => delegate(target, task),
    };

    let iterations = 0;
    /** Tools a person just denied: retrying them in the very next turn is refused without asking again. */
    let justDenied = new Set<string>();
    // Resuming: run what was approved, refuse what was denied, then hand the whole turn's results back.
    if (request.message === undefined && session.pending) {
      const pending = session.pending;
      iterations = pending.iterations;
      const decided = await Promise.all(pending.calls.map((call) => settlePending(call, byName.get(call.tool), ctx)));
      const order = pendingOrder(session.messages);
      const results = [...pending.results, ...decided].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      session.messages.push({ role: 'tool', results });
      justDenied = new Set(pending.calls.filter((c) => c.decision === 'denied').map((c) => c.tool));
      delete session.pending;
    }

    const budget = config.settings.sessionTokenBudget;
    while (iterations < Math.min(200, Math.max(1, config.settings.maxIterations))) {
      if (request.signal?.aborted) return { reason: 'canceled' };
      if (budget > 0 && session.usage.inputTokens + session.usage.outputTokens >= budget) {
        upsert({ id: entryId(), type: 'notice', message: `Stopped: this session used its ${budget.toLocaleString()}-token budget.`, at: now() });
        return { reason: 'budget' };
      }
      iterations++;
      let turn;
      try {
        turn = await model.generate({ system: systemPrompt(agent, config, session), messages: contextWindow(session.messages), tools: specs, signal: request.signal });
      } catch (error) {
        upsert({ id: entryId(), type: 'error', message: `${model.provider}/${model.model}: ${(error as Error).message}`, at: now() });
        return { reason: 'error' };
      }
      const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0 };
      session.usage = { inputTokens: session.usage.inputTokens + usage.inputTokens, outputTokens: session.usage.outputTokens + usage.outputTokens };
      recordAgentTokens({ agentId: agent.id, agentName: config.name }, usage);
      session.messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, ...(turn.raw && { raw: turn.raw }) });
      if (turn.text.trim()) upsert({ id: entryId(), type: 'assistant', text: turn.text, at: now(), model: `${model.provider}/${model.model}`, usage });
      if (!turn.toolCalls.length) return { reason: 'completed', reply: turn.text };
      const denied = justDenied;
      justDenied = new Set();

      const waiting: PendingCall[] = [];
      const runnable: ToolCall[] = [];
      const immediate: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        const tool = byName.get(call.name);
        if (!tool) immediate.push({ id: call.id, name: call.name, content: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}`, isError: true });
        else if (denied.has(call.name)) {
          const message = `The user just rejected ${call.name}. Do not call it again now: reply to the user and wait for their instructions.`;
          upsert(toolEntry(call, tool, { status: 'denied', error: 'Denied by a person (retry refused)' }));
          immediate.push({ id: call.id, name: call.name, content: message, isError: true });
        } else if (tool.requireApproval && (request.approvals ?? 'ask') === 'deny') {
          const message = `"${tool.label}" needs a person's approval, which isn't available in this kind of run. Don't retry it; explain what you would have done.`;
          upsert(toolEntry(call, tool, { status: 'denied', error: message }));
          immediate.push({ id: call.id, name: call.name, content: message, isError: true });
        } else if (tool.requireApproval) {
          waiting.push({ callId: call.id, tool: call.name, input: call.input });
          upsert(toolEntry(call, tool, { status: 'awaiting_approval' }));
        } else runnable.push(call);
      }
      const results = [...immediate, ...(await pool(runnable, config.settings.toolConcurrency, (call) => execute(call, byName.get(call.name)!, ctx)))];
      if (waiting.length) {
        session.pending = { calls: waiting, results, iterations };
        return { reason: 'awaiting_approval' };
      }
      const order = turn.toolCalls.map((c) => c.id);
      session.messages.push({ role: 'tool', results: results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) });
    }
    upsert({ id: entryId(), type: 'notice', message: `Stopped after ${iterations} iterations without a final answer (Settings → Max iterations).`, at: now() });
    return { reason: 'max_iterations' };
  }

  function toolEntry(call: ToolCall, tool: BuiltTool, patch: Partial<Extract<TimelineEntry, { type: 'tool' }>>): Extract<TimelineEntry, { type: 'tool' }> {
    const existing = session.timeline.find((e): e is Extract<TimelineEntry, { type: 'tool' }> => e.type === 'tool' && e.callId === call.id);
    return {
      id: existing?.id ?? entryId(),
      type: 'tool',
      callId: call.id,
      tool: call.name,
      label: tool.label,
      kind: tool.kind,
      ...(tool.nodeType && { nodeType: tool.nodeType }),
      input: call.input,
      status: 'running',
      at: existing?.at ?? now(),
      ...patch,
    };
  }

  async function execute(call: ToolCall, tool: BuiltTool, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    upsert(toolEntry(call, tool, { status: 'running' }));
    try {
      const outcome = await traceToolCall({ agentId: agent.id, agentName: config.name, tool: call.name, callId: call.id, kind: tool.kind }, () => tool.invoke(call.input, ctx));
      upsert(
        toolEntry(call, tool, {
          status: 'success',
          output: outcome.output,
          durationMs: Date.now() - started,
          ...(outcome.workflowId && { workflowId: outcome.workflowId }),
          ...(outcome.executionId && { executionId: outcome.executionId }),
          ...(outcome.childAgentId && { childAgentId: outcome.childAgentId }),
          ...(outcome.childSessionId && { childSessionId: outcome.childSessionId }),
        }),
      );
      return { id: call.id, name: call.name, content: asContent(outcome.output) };
    } catch (error) {
      const message = (error as Error).message;
      upsert(toolEntry(call, tool, { status: 'error', error: message, durationMs: Date.now() - started }));
      return { id: call.id, name: call.name, content: `Error: ${message}`, isError: true };
    }
  }

  async function settlePending(call: PendingCall, tool: BuiltTool | undefined, ctx: ToolContext): Promise<ToolResult> {
    if (!tool) return { id: call.callId, name: call.tool, content: `The tool "${call.tool}" is no longer available.`, isError: true };
    const asCall: ToolCall = { id: call.callId, name: call.tool, input: call.input };
    if (call.decision === 'approved') return execute(asCall, tool, ctx);
    upsert(toolEntry(asCall, tool, { status: 'denied', error: 'Denied by a person' }));
    return {
      id: call.callId,
      name: call.tool,
      content: `The user rejected the tool call to ${call.tool}. STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`,
      isError: true,
    };
  }

  async function delegate(target: Agent, task: string): Promise<{ reply?: string; sessionId: string }> {
    const child = newSession(target, {
      source: 'agent',
      userId: `agent:${agent.id}`,
      version: target.published?.version ?? 'draft',
      title: task.slice(0, 80),
      parentSessionId: session.id,
      parentAgentId: agent.id,
    });
    const result = await runAgent({ agent: target, session: child, message: task, depth: depth + 1, maxDepth, approvals: 'deny', signal: request.signal });
    return { reply: result.reply, sessionId: child.id };
  }
}

/** Tool-call ids of the last assistant turn, in the order the model made them. */
function pendingOrder(messages: AgentMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant') return message.toolCalls.map((c) => c.id);
  }
  return [];
}

export type DecisionResult = { status: 'waiting'; session: AgentSession } | ({ status: 'resumed' } & RunResult);

/** Record a person's decision on a paused tool call; once every call has one, the run continues. */
export async function decide(
  agent: Agent,
  sessionId: string,
  callId: string,
  approved: boolean,
  options: { onEvent?: (event: AgentStreamEvent) => void; signal?: AbortSignal } = {},
): Promise<DecisionResult> {
  const session = agentStore.getSession(sessionId);
  if (!session || session.agentId !== agent.id) throw new DecisionError('Session not found', 404);
  const call = session.pending?.calls.find((c) => c.callId === callId);
  if (!session.pending || !call) throw new DecisionError('That tool call is not waiting for approval', 409);
  if (call.decision) throw new DecisionError(`Already ${call.decision}`, 409);
  call.decision = approved ? 'approved' : 'denied';
  recordApproval({ agentId: agent.id, agentName: agent.name, tool: call.tool }, call.decision);
  if (session.pending.calls.some((c) => !c.decision)) {
    const entry = session.timeline.find((e) => e.type === 'tool' && e.callId === callId);
    if (entry?.type === 'tool' && !approved) Object.assign(entry, { status: 'denied', error: 'Denied by a person' });
    const saved = agentStore.saveSession(session);
    if (entry) options.onEvent?.({ type: 'entry', sessionId, entry });
    options.onEvent?.({ type: 'run.finished', sessionId, status: 'awaiting_approval', reason: 'awaiting_approval', usage: saved.usage });
    return { status: 'waiting', session: saved };
  }
  const result = await runAgent({ agent, session, approvals: 'ask', ...options });
  return { status: 'resumed', ...result };
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
