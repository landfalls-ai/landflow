/**
 * The agent loop. One run = one user message (or schedule prompt, or resumed approval):
 * model turn → tool calls (concurrently, `toolConcurrency` at a time) → results → next turn,
 * until the model answers, a tool needs a person's approval, the iteration limit or the
 * session's token budget is reached. Every run is an `invoke_agent` span; the session keeps
 * the transcript (session memory) and the timeline the UI shows.
 */
import { nanoid } from 'nanoid';
import type { AgentMessage, AgentTool, LanguageModel, ToolCall, ToolResult } from '@landflow/engine';
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
import { agentScope, isUsageCapError, runInUsageScope } from '../ai-usage';
import { currentActorId } from '../auth/context';
import { bus } from '../bus';
import { notifyApprovalEmails } from '../approval-email';
import { singleton } from '../singleton';
import { activeTraceIds, logger, recordAgentTokens, recordApproval, traceAgentRun, traceToolCall, traceUrl } from '../telemetry';
import { applyGuardrail, guardrailEntry, ruleActive } from './guardrails';
import { agentSessionJournal } from '../journal/agent-session';
import { agentModel } from './models';
import { personaPrompt } from '../../shared/persona';
import { agentStore, configOf } from './store';
import { buildToolset, dedupe, type BuiltTool, type ToolContext } from './tools';

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
  /** What a workflow connected to the agent's node (Run an Agent): a chat model that replaces the agent's, and more tools. */
  flow?: { model?: LanguageModel; tools?: AgentTool[] };
  /** What a team run adds to a member (agent-teams/runtime.ts): the tools for its reports, how it shows in the journal, a check before its answer. */
  team?: TeamRole;
}

export interface TeamRole {
  /** One delegate tool per direct report. */
  tools: BuiltTool[];
  /** The member's title: the journal names it by this, not by its agent's name. */
  title?: string;
  /** Journal under the span of the request that asked this member (default: the node's span), its words as inline messages. */
  under?: string;
  /** Tokens the member may use in this session: the run stops with reason `budget` at the limit. */
  budgetTokens?: number;
  /** Called with the answer the model is about to give (and the session so far): text back is told to the model (as a message) and the loop goes on. */
  beforeAnswer?(reply: string, session: AgentSession): string | undefined;
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

function systemPrompt(agent: Agent, config: AgentConfig, session: AgentSession, extra?: string): string {
  let memory: string | undefined;
  if (config.memory.crossSession) {
    const notes = agentStore.memories(agent.id, session.userId);
    memory = [
      '## What you remember about this user',
      notes.length ? notes.map((n) => `- ${n.text} (${n.at.slice(0, 10)})`).join('\n') : '(nothing yet)',
      'Use the remember tool for durable facts worth knowing next time.',
    ].join('\n');
  }
  const prompt = personaPrompt(config, { memory, now: new Date() });
  return extra ? `${prompt}\n\n${extra}` : prompt;
}

/**
 * A team member's tools in this run: its instructions may name a tool the team or the flow doesn't give it here (written
 * for another flow), and a model told nothing tends to report what that tool would have returned.
 */
function toolsInRun(tools: BuiltTool[]): string {
  const lines = tools.map((t) => `- ${t.name}${t.label && t.label !== t.name ? ` (${t.label})` : ''}`);
  return [
    '## Your tools in this run',
    lines.length ? lines.join('\n') : 'None.',
    "If your instructions name a tool that isn't listed here, you don't have it in this run: don't say you used it or give what it would have returned.",
  ].join('\n');
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

/** The least time between two saves of a running session. */
const SAVE_EVERY_MS = 1_500;

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
  // A session a Run an Agent node started also writes its entries into that run's journal (lib/server/journal).
  const journalEntry = agentSessionJournal(session, { id: agent.id, name: request.team?.title ?? agent.name }, { under: request.team?.under, inline: Boolean(request.team?.under) });
  const upsert = (entry: TimelineEntry) => {
    const index = session.timeline.findIndex((e) => e.id === entry.id);
    if (index >= 0) session.timeline[index] = entry;
    else session.timeline.push(entry);
    emit({ type: 'entry', sessionId: session.id, entry });
    journalEntry(entry);
    persistSoon();
  };
  // While the run goes on, the saved session follows the timeline (at most every SAVE_EVERY_MS), so a page that
  // opens mid-run (the execution view's agent panel) sees the tool calls so far. The final save stays the one below.
  let lastSave = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistNow = () => {
    saveTimer = undefined;
    if (!running.has(session.id)) return;
    lastSave = Date.now();
    try {
      // Keep the object the loop holds: only the store's copy gets the new updatedAt.
      agentStore.saveSession(session);
    } catch (error) {
      logger.warn(`could not save the running session: ${(error as Error).message}`);
    }
  };
  const persistSoon = () => {
    if (saveTimer || session.status !== 'running') return;
    const wait = lastSave + SAVE_EVERY_MS - Date.now();
    if (wait <= 0) persistNow();
    else saveTimer = setTimeout(persistNow, wait);
  };

  // Token & cost tracking: the run's model calls count for this agent, under its usage limits (and any caller's caps).
  const userId = currentActorId();
  const usage = agentScope({ agentId: agent.id, agentName: config.name, sessionId: session.id, settings: config.settings, ...(userId && { userId }) });
  try {
    return await runInUsageScope(usage, () => traceAgentRun(
      {
        agentId: agent.id,
        agentName: config.name,
        sessionId: session.id,
        source: session.source,
        version: String(session.version),
        ...((request.flow?.model ?? config.model) && { model: { provider: (request.flow?.model ?? config.model)!.provider, model: (request.flow?.model ?? config.model)!.model } }),
        root: request.rootTrace,
      },
      async () => {
        const traceId = activeTraceIds()?.traceId;
        if (traceId) session.traceIds = [...session.traceIds, traceId].slice(-50);
        session.status = 'running';
        const link = traceUrl(traceId);
        emit({ type: 'run.started', sessionId: session.id, ...(traceId && { traceId }), ...(link && { traceUrl: link }) });
        let blockedReply: string | undefined;
        if (request.message !== undefined) {
          let text = request.message.trim();
          // Input guardrail: the model never sees a blocked message; a sanitized one reaches it (and the session) cleaned.
          const rule = config.guardrails?.input;
          const checked = ruleActive(rule) ? await applyGuardrail(rule, 'input', text, { model: () => agentModel(config.model), signal: request.signal, log: (m) => logger.warn(m) }) : undefined;
          const from = session.source !== 'test' ? { from: session.userId } : {};
          if (checked?.action === 'blocked') {
            blockedReply = checked.text;
            const withheld = '[Message withheld by an input guardrail]';
            if (session.timeline.every((e) => e.type !== 'user')) session.title = 'Blocked message';
            session.messages.push({ role: 'user', content: withheld }, { role: 'assistant', text: blockedReply, toolCalls: [] });
            upsert({ id: entryId(), type: 'user', text: withheld, at: now(), ...from });
            upsert(guardrailEntry(entryId(), 'input', checked, now()));
            upsert({ id: entryId(), type: 'assistant', text: blockedReply, at: now(), model: 'guardrail' });
          } else {
            if (checked?.action === 'sanitized') text = checked.text;
            if (session.timeline.every((e) => e.type !== 'user')) session.title = text.slice(0, 80) || session.title;
            session.messages.push({ role: 'user', content: text });
            upsert({ id: entryId(), type: 'user', text, at: now(), ...from });
            if (checked?.action === 'sanitized') upsert(guardrailEntry(entryId(), 'input', checked, now()));
          }
        }
        session = agentStore.saveSession(session);
        const result = blockedReply !== undefined ? { reason: 'completed' as const, reply: blockedReply } : await loop();
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
        // Approvals by email: the addresses in the agent's settings get approve / reject links for each call that waits.
        if (result.reason === 'awaiting_approval' && config.settings.approvalEmails?.length) void notifyApprovalEmails(agent, session, config.settings.approvalEmails);
        return { session, reason: result.reason, usage: session.usage, ...(result.reply !== undefined && { reply: result.reply }) };
      },
    ));
  } finally {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    running.delete(session.id);
  }

  async function loop(): Promise<{ reason: RunEndReason; reply?: string }> {
    let model;
    let toolset;
    try {
      model = request.flow?.model ?? (await agentModel(config.model));
      toolset = await buildToolset(agent, config, request.flow?.tools);
      if (request.team?.tools.length) toolset = { ...toolset, tools: dedupe([...toolset.tools, ...request.team.tools]) };
    } catch (error) {
      upsert({ id: entryId(), type: 'error', message: (error as Error).message, at: now() });
      return { reason: 'error' };
    }
    for (const note of toolset.unavailable) upsert({ id: entryId(), type: 'notice', message: `Tool unavailable: ${note}`, at: now() });
    const byName = new Map(toolset.tools.map((t) => [t.name, t]));
    const toolNote = request.team ? toolsInRun(toolset.tools) : undefined;
    const specs = toolset.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const ctx: ToolContext = {
      agent: { ...agent, ...config },
      session,
      depth,
      maxDepth,
      runId: `ar_${nanoid(10)}`,
      signal: request.signal,
      delegate: (target, task) => delegate(target, task),
      approvals: request.approvals ?? 'ask',
    };

    let iterations = 0;
    /** Tools a person just denied: retrying them in the very next turn is refused without asking again. */
    let justDenied = new Set<string>();
    // Resuming: run what was approved, refuse what was denied, then hand the whole turn's results back.
    if (request.message === undefined && session.pending) {
      const pending = session.pending;
      iterations = pending.iterations;
      const decided = await Promise.all(pending.calls.map((call) => settlePending(call, byName.get(call.tool), ctx)));
      const settled = [...pending.results, ...decided.filter(isResult)];
      // A remote agent that paused again: wait for the next decision, keeping what is settled.
      const again = decided.filter((d): d is { pending: PendingCall } => !isResult(d)).map((d) => d.pending);
      if (again.length) {
        session.pending = { calls: again, results: settled, iterations };
        return { reason: 'awaiting_approval' };
      }
      const order = pendingOrder(session.messages);
      session.messages.push({ role: 'tool', results: settled.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) });
      // A rejected remote call isn't a rejected tool: the agent heard the reason and answered, so the model may ask it again.
      justDenied = new Set(pending.calls.filter((c) => c.decision === 'denied' && !c.remote).map((c) => c.tool));
      delete session.pending;
    }

    const limits = [config.settings.sessionTokenBudget, request.team?.budgetTokens ?? 0].filter((n) => n > 0);
    const budget = limits.length ? Math.min(...limits) : 0;
    while (iterations < Math.min(200, Math.max(1, config.settings.maxIterations))) {
      if (request.signal?.aborted) return { reason: 'canceled' };
      if (budget > 0 && session.usage.inputTokens + session.usage.outputTokens >= budget) {
        upsert({ id: entryId(), type: 'notice', message: `Stopped: this session used its ${budget.toLocaleString()}-token budget.`, at: now() });
        return { reason: 'budget' };
      }
      iterations++;
      let turn;
      try {
        turn = await model.generate({ system: systemPrompt(agent, config, session, toolNote), messages: contextWindow(session.messages), tools: specs, signal: request.signal });
      } catch (error) {
        if (isUsageCapError(error)) {
          upsert({ id: entryId(), type: 'notice', message: `Stopped: ${error.message}.`, at: now() });
          return { reason: 'budget' };
        }
        upsert({ id: entryId(), type: 'error', message: `${model.provider}/${model.model}: ${(error as Error).message}`, at: now() });
        return { reason: 'error' };
      }
      const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0 };
      session.usage = { inputTokens: session.usage.inputTokens + usage.inputTokens, outputTokens: session.usage.outputTokens + usage.outputTokens };
      recordAgentTokens({ agentId: agent.id, agentName: config.name }, usage);
      // Output guardrail: only the final answer is checked; a blocked or sanitized one replaces it in the transcript too.
      let answer = turn.text;
      let changed = false;
      const outRule = config.guardrails?.output;
      if (!turn.toolCalls.length && ruleActive(outRule)) {
        const checked = await applyGuardrail(outRule, 'output', answer, { model: async () => model, signal: request.signal, log: (m) => logger.warn(m) });
        if (checked.action !== 'pass') {
          upsert(guardrailEntry(entryId(), 'output', checked, now()));
          answer = checked.text;
          changed = true;
        }
      }
      // `raw` replays the provider's own blocks (the original text), so a changed answer drops it.
      session.messages.push({ role: 'assistant', text: answer, toolCalls: turn.toolCalls, ...(turn.raw && !changed && { raw: turn.raw }) });
      if (answer.trim()) upsert({ id: entryId(), type: 'assistant', text: answer, at: now(), model: `${model.provider}/${model.model}`, usage });
      if (!turn.toolCalls.length) {
        const nudge = request.team?.beforeAnswer?.(answer, session);
        if (nudge) {
          session.messages.push({ role: 'user', content: nudge });
          upsert({ id: entryId(), type: 'notice', message: nudge, at: now() });
          continue;
        }
        return { reason: 'completed', reply: answer };
      }
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
      const ran = await pool(runnable, config.settings.toolConcurrency, (call) => execute(call, byName.get(call.name)!, ctx));
      const results = [...immediate, ...ran.filter(isResult)];
      // Remote agents that paused for an approval of their own tool calls wait with the calls that need one.
      waiting.push(...ran.filter((r): r is { pending: PendingCall } => !isResult(r)).map((r) => r.pending));
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

  /** Run a tool call (or, with `resume`, answer the remote agent it paused on): its result, or the pause to wait on. */
  async function execute(call: ToolCall, tool: BuiltTool, ctx: ToolContext, resume?: { state: Record<string, unknown>; approved: boolean; answer?: string }): Promise<ToolResult | { pending: PendingCall }> {
    const started = Date.now();
    upsert(toolEntry(call, tool, { status: 'running', approval: undefined }));
    // The remote agent's tool calls as they happen (A2A tools).
    const callCtx: ToolContext = { ...ctx, callId: call.id, callSpan: journalEntry.spanOf(call.id), progress: (remote) => upsert(toolEntry(call, tool, { status: 'running', remote, approval: undefined })) };
    try {
      const outcome = await traceToolCall({ agentId: agent.id, agentName: config.name, tool: call.name, callId: call.id, kind: tool.kind }, () =>
        resume && tool.resume ? tool.resume(resume.state, resume.approved, callCtx, resume.answer) : tool.invoke(call.input, callCtx),
      );
      if (outcome.pause) {
        upsert(toolEntry(call, tool, { status: 'awaiting_approval', approval: { message: outcome.pause.message }, durationMs: Date.now() - started, ...(outcome.remote && { remote: outcome.remote }) }));
        return { pending: { callId: call.id, tool: call.name, input: call.input, remote: outcome.pause.remote } };
      }
      upsert(
        toolEntry(call, tool, {
          status: 'success',
          output: outcome.output,
          approval: undefined,
          durationMs: Date.now() - started,
          ...(outcome.workflowId && { workflowId: outcome.workflowId }),
          ...(outcome.executionId && { executionId: outcome.executionId }),
          ...(outcome.childAgentId && { childAgentId: outcome.childAgentId }),
          ...(outcome.childSessionId && { childSessionId: outcome.childSessionId }),
          ...(outcome.remote && { remote: outcome.remote }),
        }),
      );
      return { id: call.id, name: call.name, content: asContent(outcome.output) };
    } catch (error) {
      const message = (error as Error).message;
      upsert(toolEntry(call, tool, { status: 'error', error: message, approval: undefined, durationMs: Date.now() - started }));
      return { id: call.id, name: call.name, content: `Error: ${message}`, isError: true };
    }
  }

  async function settlePending(call: PendingCall, tool: BuiltTool | undefined, ctx: ToolContext): Promise<ToolResult | { pending: PendingCall }> {
    if (!tool) return { id: call.callId, name: call.tool, content: `The tool "${call.tool}" is no longer available.`, isError: true };
    const asCall: ToolCall = { id: call.callId, name: call.tool, input: call.input };
    // A remote agent's pause: the decision goes to that agent either way, and its answer is the tool's result.
    if (call.remote) {
      if (!tool.resume) return { id: call.callId, name: call.tool, content: `The tool "${call.tool}" can no longer answer the agent that paused.`, isError: true };
      return execute(asCall, tool, ctx, { state: call.remote.state, approved: call.decision === 'approved', ...(call.answer !== undefined && { answer: call.answer }) });
    }
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

const isResult = (value: ToolResult | { pending: PendingCall }): value is ToolResult => !('pending' in value);

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
  options: { onEvent?: (event: AgentStreamEvent) => void; signal?: AbortSignal; by?: string } = {},
): Promise<DecisionResult> {
  const session = agentStore.getSession(sessionId);
  if (!session || session.agentId !== agent.id) throw new DecisionError('Session not found', 404);
  const call = session.pending?.calls.find((c) => c.callId === callId);
  if (!session.pending || !call) throw new DecisionError('That tool call is not waiting for approval', 409);
  if (call.decision) throw new DecisionError(`Already ${call.decision}`, 409);
  call.decision = approved ? 'approved' : 'denied';
  if (options.by) call.decidedBy = options.by;
  recordApproval({ agentId: agent.id, agentName: agent.name, tool: call.tool }, call.decision);
  if (session.pending.calls.some((c) => !c.decision)) {
    const entry = session.timeline.find((e) => e.type === 'tool' && e.callId === callId);
    if (entry?.type === 'tool' && !approved) Object.assign(entry, { status: 'denied', error: 'Denied by a person' });
    const saved = agentStore.saveSession(session);
    if (entry) options.onEvent?.({ type: 'entry', sessionId, entry });
    options.onEvent?.({ type: 'run.finished', sessionId, status: 'awaiting_approval', reason: 'awaiting_approval', usage: saved.usage });
    return { status: 'waiting', session: saved };
  }
  const { by: _by, ...runOptions } = options;
  const result = await runAgent({ agent, session, approvals: 'ask', ...runOptions });
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
