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
import type { RunContext, RunContextRef } from '../../shared/project-context';
import { emptyContext } from '../project-context/empty';
import { refFromSession } from '../project-context/resolve';
import { citedIn, recordRunPractices, runPractices, withPractices } from '../project-context/practices';
import { runContextProvider, withRunContext } from '../project-context/seam';
import { agentScope, isUsageCapError, runInUsageScope } from '../ai-usage';
import { currentCallNote, withCallNote } from '../ai-usage/call-context'; // SP03:
import { agentDraft, type SystemSegment } from '../ai-usage/drafts'; // SP03:
import { currentActorId, requestAuth } from '../auth/context';
import { applyToolPolicy } from './policy';
import { bus } from '../bus';
import { notifyApprovalEmails } from '../approval-email';
import { singleton } from '../singleton';
import { activeTraceIds, logger, recordAgentTokens, recordApproval, traceAgentRun, traceToolCall, traceUrl } from '../telemetry';
import { applyGuardrail, guardrailEntry, ruleActive } from './guardrails';
import { agentSessionJournal } from '../journal/agent-session';
import { uncacheable } from '../../shared/agent-cache';
import { chooseTier } from '../../shared/agent-router';
import { cacheKey, responseCache } from './response-cache';
import { configHash, embedderFor, semanticCache } from './semantic-cache';
import { agentModel } from './models';
import { cleanPersona, personaPrompt, personaPromptParts } from '../../shared/persona';
import { sawPersona } from '../../shared/what-it-saw-sections';
import { agentStore, configOf } from './store';
import type { MemberPause } from '../agent-teams/pause';
import type { ToolTarget } from '../../shared/tool-target';
import { approvedByLine } from '../../shared/fix-autonomy'; // AG23:
import { NOT_GIVEN, spotlightDestinations, spotlightVerdict, type SpotlightApprovals } from './spotlight-approvals'; // AG23:
import { maskParams } from '../../shared/approval-inbox'; // AP02:
import { targetLine } from '../../shared/tool-target'; // AP02:
import { redactValue } from '../secrets/redact'; // AP02:
import { buildToolset, binaryScopeFor, targetOfCall, dedupe, nodeKnowledgeTool, type BuiltTool, type ToolCaller, type ToolContext } from './tools';
import { knowledgeTool } from './knowledge';
import { agentNotAllowedMessage, projectAgentRules } from '../project-context/project-settings';
import { isNodeKnowledge, type AgentModel, type AgentToolConfig } from '../../shared/agents'; // AG17: moved types
import { PROJECT_KNOWLEDGE_TOOL } from '../../shared/project-policy';
import { hostBinaryClient, storeBinary } from '../binary/access';
import { DEFAULT_KEPT_TOOL_IMAGES, hydrateToolImages, imageSizeLabel, storeToolImages, type ToolImageMode } from '../nodes/tool-images';
import { HttpError } from '../errors';
import { store } from '../store';
import { agentVersionRow } from './version-rows'; // AG21:

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
  approvals?: 'ask' | 'deny' | 'spotlight'; // AG23: 'spotlight' (with `spotlight`): a call that asks first is decided as Spotlight in a fix session's test run
  /** AG23: who decides as Spotlight, the destinations already given, and whether a call it leaves can wait for the person. Only with approvals 'spotlight'. */
  spotlight?: SpotlightApprovals;
  /** AP02: a run nobody watches whose held calls wait in the approval inbox (Run an Agent, approvals 'ask'): each PendingCall carries its `review`, no agent-session approval mail goes out, and a remote agent's own pause stays auto-rejected. */
  inbox?: true;
  /** Wave ap1: with approvals 'deny', why this run cannot ask (`REFUSE_WHY`'s words, e.g. the hosted chat's), said in the refused call's result. */
  refusedWhy?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
  /** Who is calling, for the project block (docs/agents.md#which-project-a-run-is-in); absent: the session says. Not `caller`, which is whose tools run. */
  context?: RunContextRef;
  /** The session's usage so far, after each model call (a team's budget bars). */
  onUsage?: (usage: TokenUsage) => void;
  /** Images tools return (a screenshot): how many of the newest go to the model each turn (default 2, or LANDFLOW_TOOL_IMAGES_KEPT) and whether it sees them. */
  toolImages?: { keep?: number; mode?: ToolImageMode };
  /** Start a new trace (schedules, channels) instead of joining the caller's. */
  rootTrace?: boolean;
  /** What a workflow connected to the agent's node (Run an Agent): a chat model that replaces the agent's, and more tools. */
  flow?: { model?: LanguageModel; tools?: AgentTool[]; /** AG14: what each wired tool reaches, by tool name. */ targets?: Map<string, ToolTarget> };
  /**
   * AG17: what a flow's wired sub-nodes moved into the agent's draft and the config this run uses does not have yet (Run an Agent,
   * agents/flow-moves.ts `pendingFor`): a model that counts as the flow's own, and tools that join the config's for this run only.
   */
  moved?: { model?: AgentModel; tools?: AgentToolConfig[] };
  /** What a team run adds to a member (agent-teams/runtime.ts): the tools for its reports, how it shows in the journal, a check before its answer. */
  team?: TeamRole;
  /**
   * Who the workflows this run's tools start are run for (ToolContext.caller): the person a chat route names, or a
   * delegating agent's own caller. Absent: the workflow run the session belongs to (Run an Agent), else nobody.
   */
  caller?: ToolCaller;
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
  /** A person may pause the member between steps and give it an instruction (agent-teams/pause.ts). */
  pause?: MemberPause;
  /** Called after each turn's tool results: text back ends the run there with it as the reply (a member that handed its task to a peer). */
  stopAfterTools?(): string | undefined;
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
  // AG21: a version older than the 20 kept in `history` still runs, from the versions table.
  return agent.history.find((v) => v.version === version)?.config ?? (typeof version === 'number' ? agentVersionRow(agent.id, version) : undefined) ?? agent.published?.config ?? configOf(agent);
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

function systemPrompt(agent: Agent, config: AgentConfig, session: AgentSession, runCtx: RunContext, extra?: string): string {
  return systemPromptParts(agent, config, session, runCtx, extra).text;
}

// SP03: the same prompt with its segments, for the call's draft: persona, instructions, skills and the intro line are
// `instructions`; then the project block, the practices, memory and the team's tool note, each its own part. The date
// stamp is a `formatting` segment, which no part hash covers, so a new run's date doesn't change the instructions' hash.
// SP19: the prompt is cut where it stops being stable (`cacheBreak`, a character index): the last segment before it is
// marked `breakpoint`, so the provider's cache point sits after the project block and the practices, and the memory,
// the intro line and the date stamp (which change between runs) come after it. `memoryText` is the memory read once at the
// run's start (see `memoryBlock`); without it the notes are read now, as before.
export function systemPromptParts(agent: Agent, config: AgentConfig, session: AgentSession, runCtx: RunContext, extra?: string, memoryText?: string): { text: string; segments: SystemSegment[]; cacheBreak: number } {
  const memory = memoryText ?? memoryBlock(agent, config, session);
  // The date is the run's own, pinned at its start: a clock that moves on every model call defeats the provider's prompt cache.
  const now = new Date(runCtx.at);
  const parts = personaPromptParts(config, { memory, now, ...(runCtx.text && { context: runCtx.text }) });
  const prompt = parts.stable + parts.volatile;
  const cacheBreak = parts.stable.length;
  // Where the project block and the memory sit in the prompt: a probe with markers in their places (the persona text never holds a NUL).
  const probe = personaPrompt(config, { memory: memory && MEMORY_MARK, now, ...(runCtx.text && { context: CONTEXT_MARK }) });
  const marks: { at: number; mark: string; text: string; parts: SystemSegment[] }[] = [];
  if (runCtx.text) {
    const practices = runCtx.practicesText && runCtx.text.endsWith(runCtx.practicesText) ? runCtx.practicesText : '';
    const block = runCtx.text.slice(0, runCtx.text.length - practices.length);
    marks.push({ at: probe.indexOf(CONTEXT_MARK), mark: CONTEXT_MARK, text: runCtx.text, parts: [...(block ? [{ part: 'projectBlock' as const, text: block }] : []), ...(practices ? [{ part: 'practices' as const, text: practices }] : [])] });
  }
  if (memory) marks.push({ at: probe.indexOf(MEMORY_MARK), mark: MEMORY_MARK, text: memory, parts: [{ part: 'memory', text: memory }] });
  marks.sort((a, b) => a.at - b.at);
  const segments: SystemSegment[] = [];
  // The date stamp ends the prompt (see personaPrompt): its own segment, the one thing that differs between two runs of a prompt.
  const stamp = ` Current date and time: ${now.toISOString()}.`;
  const body = prompt.endsWith(stamp) ? prompt.slice(0, prompt.length - stamp.length) : prompt;
  let probeAt = 0;
  let textAt = 0;
  for (const m of marks) {
    const gap = m.at - probeAt;
    if (gap > 0) segments.push({ part: 'instructions', text: prompt.slice(textAt, textAt + gap) });
    segments.push(...m.parts);
    textAt += gap + m.text.length;
    probeAt = m.at + m.mark.length;
  }
  if (textAt < body.length) segments.push({ part: 'instructions', text: body.slice(textAt) });
  if (body !== prompt) segments.push({ part: 'formatting', text: stamp });
  // SP19: cut at the break (a segment that spans it is split in two) and mark the last stable segment.
  const cut: SystemSegment[] = [];
  let at = 0;
  for (const seg of segments) {
    const end = at + seg.text.length;
    if (at < cacheBreak && end > cacheBreak) {
      cut.push({ part: seg.part, text: seg.text.slice(0, cacheBreak - at), breakpoint: true }, { part: seg.part, text: seg.text.slice(cacheBreak - at) });
    } else cut.push(end === cacheBreak && seg.text ? { ...seg, breakpoint: true } : seg);
    at = end;
  }
  if (extra) cut.push({ part: 'toolNote', text: `\n\n${extra}` });
  return { text: extra ? `${prompt}\n\n${extra}` : prompt, segments: cut, cacheBreak };
}

/** SP19: the cross-session memory as the prompt shows it, read once at the run's start (a `remember` mid-run reaches the next run). */
export function memoryBlock(agent: Agent, config: AgentConfig, session: AgentSession): string | undefined {
  if (!config.memory.crossSession) return undefined;
  const notes = agentStore.memories(agent.id, session.userId);
  return [
    '## What you remember about this user',
    notes.length ? notes.map((n) => `- ${n.text} (${n.at.slice(0, 10)})`).join('\n') : '(nothing yet)',
    'Use the remember tool for durable facts worth knowing next time.',
  ].join('\n');
}

const CONTEXT_MARK = '\u0000project-block\u0000';
const MEMORY_MARK = '\u0000memory\u0000';

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

/** How many tool images to keep: the run's setting, else LANDFLOW_TOOL_IMAGES_KEPT, else 2 (0 to 10). */
function keptToolImages(request: RunRequest, settings?: { toolImagesKept?: number }): number {
  const value = request.toolImages?.keep ?? settings?.toolImagesKept ?? (process.env.LANDFLOW_TOOL_IMAGES_KEPT ? Number(process.env.LANDFLOW_TOOL_IMAGES_KEPT) : DEFAULT_KEPT_TOOL_IMAGES);
  return Number.isFinite(value) ? Math.min(10, Math.max(0, Math.floor(value))) : DEFAULT_KEPT_TOOL_IMAGES;
}

/** The binary store as the helpers tool-images.ts reads and writes with (files go under the run's scope). */
function storeHelpers(scope: string) {
  const client = hostBinaryClient(scope);
  return {
    prepareBinaryData: (data: unknown, fileName?: string, mimeType?: string) => storeBinary(scope, data as Buffer, { fileName, mimeType }),
    binaryToBuffer: async (ref: Parameters<typeof client.read>[0]) => Buffer.from(await client.read(ref)),
  } as unknown as Parameters<typeof storeToolImages>[0]['helpers'];
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

/**
 * Whom a workflow session's tools run for when the request names no caller: the run it works in, but only while that
 * run goes on (running, or waiting on this agent's approval). A session resumed after its run ended (an approval
 * decided later) runs its tools for nobody, never as that run's starter or version.
 */
async function sessionCaller(execution: AgentSession['execution']): Promise<ToolCaller> {
  if (!execution) return {};
  const record = await store.loadExecution(execution.executionId);
  return record?.status === 'running' || record?.status === 'waiting' ? { execution: { executionId: execution.executionId, nodeId: execution.nodeId } } : {};
}

/** Run the agent once on a session. Rejects if the session is already running. */
export async function runAgent(request: RunRequest): Promise<RunResult> {
  const { agent } = request;
  let session = request.session;
  // Never the request around the run: a schedule, a channel or a workflow's agent may run inside someone else's.
  const caller: ToolCaller = request.caller ?? (await sessionCaller(session.execution));
  if (running.has(session.id)) throw new Error('This session is already running — wait for the reply');
  running.add(session.id);
  const config = configFor(agent, session.version);
  const depth = request.depth ?? 0;
  const maxDepth = request.maxDepth ?? Math.min(5, Math.max(1, config.settings.maxDelegationDepth));

  const emit = (event: AgentStreamEvent) => {
    request.onEvent?.(event);
    bus.publish({ channel: 'agent', agentId: agent.id, ...(session.context?.projectId && { projectId: session.context.projectId }), event }); // PC13: the session's project, for the live feed
  };
  // A session a Run an Agent node started also writes its entries into that run's journal (lib/server/journal).
  const journalEntry = agentSessionJournal(session, { id: agent.id, name: request.team?.title ?? agent.name }, { under: request.team?.under, inline: Boolean(request.team?.under) });
  const decidedBy = new Map<string, import('../../shared/fix-autonomy').ApprovalBy>(); // AG23: calls Spotlight approved in this run
  const inboxLines = new Map<string, string>(); // AP02: the settled line of calls the approval inbox let run
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
  // The project block and the pinned date are settled before the usage scope opens: the scope reads the run's project and goal.
  // A resume after approval keeps what the run began with, date included.
  const provider = runContextProvider();
  let runCtx: RunContext;
  const resumed = request.message === undefined && Boolean(session.pending) && Boolean(session.context);
  if (resumed) runCtx = session.context!;
  else {
    // The block is background data: if it cannot be built, the run goes on with the old prompt.
    try {
      runCtx = provider ? provider.build(request.context ?? refFromSession(session, agent.id), config.projectContext ?? 'full') : emptyContext();
    } catch (error) {
      logger.warn(`could not build the project context: ${(error as Error).message}`);
      runCtx = emptyContext();
    }
    // PR06: approved practices join the block, on a fresh build only: a resume keeps the context it began with. A run whose project context is Off still gets them.
    runCtx = withPractices(runCtx, runPractices(config.practices, { ...(runCtx.projectId && { projectId: runCtx.projectId }), agentId: agent.id, ...(request.message && { task: request.message.slice(0, 500) }), size: 'full' }));
    recordRunPractices('delivered', runCtx.practices, { ...(runCtx.projectId && { projectId: runCtx.projectId }), ...(session.execution?.executionId && { executionId: session.execution.executionId }), agentId: agent.id, ...(currentActorId() && { userId: currentActorId() }) });
  }
  session.context = runCtx;
  // SP19: the memory is read once for the run (a `remember` during it is in the conversation and reaches the prompt next run).
  const runMemory = memoryBlock(agent, config, session);
  // PC13: the project's settings for agents, read once for the run (undefined: none on, the run is as it was).
  const rules = projectAgentRules(runCtx.projectId);
  const notAllowed = rules && !rules.agentAllowed(agent.id) ? agentNotAllowedMessage(config.name, rules.projectName) : undefined;
  const effectiveModel = request.flow?.model ?? request.moved?.model ?? config.model ?? rules?.settings.defaultModel; // AG17: moved
  // The response caches key on the model the run really uses, so two projects' defaults never share an answer.
  const cacheConfig = rules?.settings.defaultModel && !config.model ? { ...config, model: rules.settings.defaultModel } : config;
  // PC08: what the agent saw, once per run (a resume reuses the first run's block and records nothing).
  if (!resumed) {
    journalEntry.saw({
      mode: runCtx.mode,
      text: runCtx.text,
      ...(runCtx.projectId && { projectId: runCtx.projectId }),
      ...(runCtx.projectName && { projectName: runCtx.projectName }),
      ...(runCtx.goalId && { goalId: runCtx.goalId }),
      ...(runCtx.goalTitle && { goalTitle: runCtx.goalTitle }),
      at: runCtx.at,
      persona: sawPersona(cleanPersona(config.persona)),
      practices: runCtx.practices,
    });
  }
  const userId = currentActorId();
  // The scope is created inside the run's context: it reads the run's own project and goal (not an outer run's).
  const usage = withRunContext(runCtx, () => agentScope({ agentId: agent.id, agentName: config.name, sessionId: session.id, settings: config.settings, ...(userId && { userId }) }));
  try {
    return await withRunContext(runCtx, () => runInUsageScope(usage, () => traceAgentRun(
      {
        agentId: agent.id,
        agentName: config.name,
        sessionId: session.id,
        source: session.source,
        version: String(session.version),
        ...(effectiveModel && { model: { provider: effectiveModel.provider, model: effectiveModel.model } }),
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
          const checked = ruleActive(rule) && !notAllowed ? await applyGuardrail(rule, 'input', text, { model: () => agentModel(config.model ?? rules?.settings.defaultModel), signal: request.signal, log: (m) => logger.warn(m) }) : undefined;
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
        // PR06: what the answer cites, among the practices this run was given.
        if (result.reply) recordRunPractices('cited', citedIn(result.reply, runCtx.practices), { ...(runCtx.projectId && { projectId: runCtx.projectId }), ...(session.execution?.executionId && { executionId: session.execution.executionId }), agentId: agent.id, ...(currentActorId() && { userId: currentActorId() }) });
        logger.info('agent run finished', {
          'gen_ai.agent.id': agent.id,
          'gen_ai.agent.name': config.name,
          'gen_ai.conversation.id': session.id,
          'landflow.agent.source': session.source,
          'landflow.agent.end_reason': result.reason,
        });
        emit({ type: 'run.finished', sessionId: session.id, status: session.status, reason: result.reason, usage: session.usage, ...(result.reply !== undefined && { reply: result.reply }) });
        // Approvals by email: the addresses in the agent's settings get approve / reject links for each call that waits.
        // AP02: not for a workflow's session in the inbox: its link would decide outside the run (the inbox nudges instead).
        if (result.reason === 'awaiting_approval' && config.settings.approvalEmails?.length && !(request.inbox && session.execution)) void notifyApprovalEmails(agent, session, config.settings.approvalEmails);
        return { session, reason: result.reason, usage: session.usage, ...(result.reply !== undefined && { reply: result.reply }) };
      },
    )));
  } finally {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    running.delete(session.id);
  }

  async function loop(): Promise<{ reason: RunEndReason; reply?: string }> {
    let model;
    let toolset;
    /** Tools the agent has before the access policy: the response cache looks at these, so a caller denied every tool can't fill it for one who may use them. */
    let toolsOffered = 0;
    let accessNotes: string[] = [];
    /** The router sent this run to the cheap model: its answer is not stored, so the agent's own model still answers the same question later. */
    let routedToCheap = false;
    // PC13: an agent the project doesn't allow doesn't run: no tool or model is built.
    if (notAllowed) {
      upsert({ id: entryId(), type: 'error', message: notAllowed, at: now() });
      return { reason: 'error' };
    }
    try {
      toolset = await buildToolset(agent, request.moved?.tools?.length ? { ...config, tools: [...config.tools, ...request.moved.tools.filter((t) => !config.tools.some((own) => own.id === t.id))] } : config, request.flow?.tools, request.flow?.targets); // AG17: moved
      // A team's own tools (reports, consults, hand-offs, notebook), by the names they have after the merge: an agent tool
      // named like one keeps the name, so the team's copy is the renamed one and only it is exempt from the kinds below.
      let teamNames = new Set<string>();
      if (request.team?.tools.length) {
        const merged = dedupe([...toolset.tools, ...request.team.tools]);
        teamNames = new Set(merged.slice(toolset.tools.length).map((tool) => tool.name));
        toolset = { ...toolset, tools: merged };
      }
      toolsOffered = toolset.tools.length;
      // Tool access by caller: tools this caller may not use are withheld; some may need a person's approval for them.
      const role = requestAuth()?.principal?.user.id === session.userId ? requestAuth()?.principal?.user.role : undefined;
      const access = await applyToolPolicy(toolset.tools, { agentId: agent.id, caller: { id: session.userId, ...(role && { role }), source: session.source }, access: config.access, ...(request.signal && { signal: request.signal }) });
      toolset = { ...toolset, tools: access.tools };
      accessNotes = access.notes;
      // PC13: the project's tool kinds, then its knowledge base (never withheld by the kinds).
      if (rules) {
        // A team's own tools are never withheld by the kinds.
        const kept = toolset.tools.filter((tool) => teamNames.has(tool.name) || rules.toolAllowed(tool));
        accessNotes = [...accessNotes, ...toolset.tools.filter((tool) => !kept.includes(tool)).map((tool) => `${tool.label} withheld by project “${rules.projectName}” settings`)];
        const knowledge = rules.settings.knowledge;
        const built = knowledge?.enabled ? (isNodeKnowledge(knowledge.tool) ? nodeKnowledgeTool(knowledge.tool) : knowledgeTool(knowledge.tool)) : undefined;
        if (built && 'error' in built) toolset = { ...toolset, tools: kept, unavailable: [...toolset.unavailable, built.error] };
        else if (built) {
          toolset = { ...toolset, tools: dedupe([...kept, { ...built, name: PROJECT_KNOWLEDGE_TOOL, label: 'Project knowledge' }]) };
          toolsOffered += 1;
        } else toolset = { ...toolset, tools: kept };
      }
      // The model router: a short, simple request goes to the cheap model. A workflow's own model (Run an Agent) always wins.
      const route = request.flow?.model || request.moved?.model ? undefined : chooseTier( // AG17: moved
        config.router, { ...(request.message !== undefined && { message: request.message }), toolCount: toolset.tools.length });
      const cheap = route?.tier === 'cheap' ? config.router?.cheapModel : undefined;
      model = request.flow?.model ?? (await agentModel(request.moved?.model ?? cheap ?? config.model ?? rules?.settings.defaultModel)); // AG17: moved
      if (cheap) routedToCheap = true;
      if (cheap) upsert({ id: entryId(), type: 'notice', message: `Routed to ${cheap.model}: ${route?.reason}`, at: now() });
    } catch (error) {
      upsert({ id: entryId(), type: 'error', message: (error as Error).message, at: now() });
      return { reason: 'error' };
    }
    for (const note of toolset.unavailable) upsert({ id: entryId(), type: 'notice', message: `Tool unavailable: ${note}`, at: now() });
    for (const note of accessNotes) upsert({ id: entryId(), type: 'notice', message: `Tool access: ${note}`, at: now() });
    const byName = new Map(toolset.tools.map((t) => [t.name, t]));
    // What this run's knowledge bases returned: the passages the output rule's grounded check judges the answer against.
    const passages: string[] = [];
    const hasKnowledge = toolset.tools.some((t) => t.knowledge);
    // Tool-result guardrail: each result is checked before the model reads it. A blocked one reaches the model as a failed call
    // (the rule's reply says it was withheld); a sanitized one is cleaned. Errors we wrote ourselves are not checked.
    const toolRule = config.guardrails?.toolResult;
    const guardResults = (results: ToolResult[]): Promise<ToolResult[]> =>
      Promise.all(
        results.map(async (result) => {
          let next = result;
          if (!result.isError && ruleActive(toolRule)) {
            const checked = await applyGuardrail(toolRule, 'tool', result.content, { model: () => agentModel(config.model ?? rules?.settings.defaultModel), signal: request.signal, log: (m) => logger.warn(m) });
            if (checked.action !== 'pass') {
              upsert(guardrailEntry(entryId(), 'tool', checked, now(), result.name));
              next = { ...result, content: checked.text, ...(checked.action === 'blocked' && { isError: true }) };
            }
          }
          if (!next.isError && byName.get(next.name)?.knowledge) passages.push(next.content);
          return next;
        }),
      );
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
      approvals: request.approvals === 'spotlight' || request.inbox ? 'deny' : (request.approvals ?? 'ask'), // AG23: a remote pause is auto-rejected under spotlight too; AP02: and in the inbox
      caller,
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
      session.messages.push({ role: 'tool', results: (await guardResults(settled)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) });
      // A rejected remote call isn't a rejected tool: the agent heard the reason and answered, so the model may ask it again.
      justDenied = new Set(pending.calls.filter((c) => c.decision === 'denied' && !c.remote).map((c) => c.tool));
      delete session.pending;
      const stopped = request.team?.stopAfterTools?.();
      if (stopped !== undefined) {
        session.messages.push({ role: 'assistant', text: stopped, toolCalls: [] });
        return { reason: 'completed', reply: stopped };
      }
    }

    // The response cache: a repeated question, word for word, gets the stored answer with no model call. Only a first message to an
    // agent without tools or memory is eligible (shared/agent-cache.ts), so the answer depends on nothing but the question and the config.
    const first = session.messages[0];
    const question = request.message !== undefined && first?.role === 'user' && typeof first.content === 'string' ? first.content : undefined;
    const skip = session.userId === 'evaluation' ? 'it is an evaluation run (the eval gate must ask the model, and must not fill the cache)' : question === undefined ? 'it is a resumed run' : uncacheable({ cache: config.cache, messageCount: session.messages.length, toolCount: toolsOffered, memory: config.memory.crossSession, borrowed: Boolean(request.flow || request.team || request.moved) // AG17: moved
 });
    const cacheId = question !== undefined && !skip ? cacheKey(agent.id, cacheConfig, question, runCtx.hash) : undefined;
    let questionVector: number[] | undefined;
    if (cacheId) {
      const stored = responseCache.get(cacheId);
      if (stored !== undefined) {
        session.messages.push({ role: 'assistant', text: stored, toolCalls: [] });
        upsert({ id: entryId(), type: 'notice', message: 'Answered from the response cache: no model call.', at: now() });
        upsert({ id: entryId(), type: 'assistant', text: stored, at: now(), model: 'response cache' });
        return { reason: 'completed', reply: stored };
      }
      // Nothing word for word: a stored question that means the same may answer (an embedding model failing only skips this).
      const semantic = config.cache?.semantic;
      if (semantic?.enabled && question !== undefined) {
        try {
          questionVector = await embedderFor(semantic)(question, request.signal);
          const similar = semanticCache.find(agent.id, configHash(agent.id, cacheConfig, runCtx.hash), questionVector, semantic.threshold);
          if (similar) {
            session.messages.push({ role: 'assistant', text: similar.reply, toolCalls: [] });
            upsert({ id: entryId(), type: 'notice', message: `Answered from the response cache: no model call (similar to "${similar.question.slice(0, 80)}", ${Math.round(similar.similarity * 100)}% alike).`, at: now() });
            upsert({ id: entryId(), type: 'assistant', text: similar.reply, at: now(), model: 'response cache' });
            return { reason: 'completed', reply: similar.reply };
          }
        } catch (caught) {
          if (request.signal?.aborted) return { reason: 'canceled' };
          questionVector = undefined;
          upsert({ id: entryId(), type: 'notice', message: `Similar-question cache skipped: ${(caught as Error).message}`, at: now() });
        }
      }
    }

    const limits = [config.settings.sessionTokenBudget, request.team?.budgetTokens ?? 0].filter((n) => n > 0);
    const budget = limits.length ? Math.min(...limits) : 0;
    while (iterations < Math.min(200, Math.max(1, config.settings.maxIterations))) {
      if (request.signal?.aborted) return { reason: 'canceled' };
      // A person asked for a pause: stop at this step boundary, keep the session, and go on with their instruction.
      if (request.team?.pause?.requested()) {
        const lastTool = [...session.timeline].reverse().find((e): e is Extract<TimelineEntry, { type: 'tool' }> => e.type === 'tool');
        const instruction = await request.team.pause.wait({ summary: lastTool ? `Paused after ${lastTool.label}` : 'Paused before its first step', signal: request.signal });
        if (request.signal?.aborted) return { reason: 'canceled' };
        if (instruction) {
          session.messages.push({ role: 'user', content: `A person paused you to give you new instructions. Follow them, then carry on with your task:\n${instruction}` });
          upsert({ id: entryId(), type: 'user', text: instruction, at: now(), from: 'A person (took over)' });
        }
      }
      if (budget > 0 && session.usage.inputTokens + session.usage.outputTokens >= budget) {
        upsert({ id: entryId(), type: 'notice', message: `Stopped: this session used its ${budget.toLocaleString()}-token budget.`, at: now() });
        return { reason: 'budget' };
      }
      iterations++;
      let turn;
      try {
        // SP03: the prompt's parts go with the call (in memory only), for the split the meter's listener writes.
        const system = systemPromptParts(agent, config, session, runCtx, toolNote, runMemory);
        const messages = await hydrateToolImages({ helpers: storeHelpers(binaryScopeFor(ctx)), logger: { warn: (m: string) => logger.warn(m) } as never }, contextWindow(session.messages), { model, keep: keptToolImages(request, config.settings), mode: request.toolImages?.mode });
        const draft = agentDraft({ systemSegments: system.segments, tools: specs, messages, cache: model.provider === 'anthropic' });
        // An outer purpose wins (an evaluation run's calls stay `eval`); else this is an answer.
        turn = await withCallNote({ purpose: currentCallNote().purpose ?? 'answer', iteration: iterations, draft }, () => model.generate({ system: system.text, systemCacheBreak: system.cacheBreak, messages, tools: specs, signal: request.signal }));
      } catch (error) {
        if (isUsageCapError(error)) {
          upsert({ id: entryId(), type: 'notice', message: `Stopped: ${error.message}.`, at: now() });
          return { reason: 'budget' };
        }
        upsert({ id: entryId(), type: 'error', message: `${model.provider}/${model.model}: ${(error as Error).message}`, at: now() });
        return { reason: 'error' };
      }
      const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0 };
      // Each model call counts, with the model that answered: a team's report names it beside the agent's tokens.
      // SP03: the cache numbers stay with the session (they were dropped here).
      const cacheRead = (session.usage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
      const cacheWrite = (session.usage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      session.usage = { inputTokens: session.usage.inputTokens + usage.inputTokens, outputTokens: session.usage.outputTokens + usage.outputTokens, ...(cacheRead > 0 && { cacheReadTokens: cacheRead }), ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }), requests: (session.usage.requests ?? 0) + 1, model: model.model };
      recordAgentTokens({ agentId: agent.id, agentName: config.name }, usage);
      request.onUsage?.(session.usage);
      // Output guardrail: only the final answer is checked; a blocked or sanitized one replaces it in the transcript too.
      let answer = turn.text;
      let changed = false;
      const outRule = config.guardrails?.output;
      if (!turn.toolCalls.length && ruleActive(outRule)) {
        const checked = await applyGuardrail(outRule, 'output', answer, { model: async () => model, signal: request.signal, log: (m) => logger.warn(m), ...(hasKnowledge && { context: passages.join('\n\n---\n\n') }) });
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
        // Store the answer the person got (after the output guardrail), unless the run left the first turn (a nudge sent it round again).
        if (cacheId && !routedToCheap && answer.trim() && config.cache && session.messages.length === 2) {
          responseCache.set(agent.id, cacheId, answer, config.cache.ttlSeconds);
          if (questionVector && question !== undefined) semanticCache.add({ agentId: agent.id, configHash: configHash(agent.id, cacheConfig, runCtx.hash), question, reply: answer, vector: questionVector, ttlSeconds: config.cache.ttlSeconds });
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
        // A tool set up as a read whose call is not one (another operation, SQL that changes data) is held like a write: decided per call on the parameters it would run with.
        const heldFor = tool && !tool.requireApproval && tool.holdReason ? await tool.holdReason(call.input, ctx).catch(() => 'The call’s parameters could not be checked.') : undefined;
        // AG23: in a fix session's test run Spotlight decides a call that asks first: it runs when every destination was given, else it is left for the person.
        const verdict = tool && (tool.requireApproval || heldFor) && request.approvals === 'spotlight' && request.spotlight
          ? spotlightVerdict(await spotlightDestinations(tool, call.input, ctx), request.spotlight.given)
          : undefined;
        if (!tool) immediate.push({ id: call.id, name: call.name, content: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(', ')}`, isError: true });
        else if (denied.has(call.name)) {
          const message = `The user just rejected ${call.name}. Do not call it again now: reply to the user and wait for their instructions.`;
          upsert(toolEntry(call, tool, { status: 'denied', error: 'Denied by a person (retry refused)' }));
          immediate.push({ id: call.id, name: call.name, content: message, isError: true });
        } else if (verdict === 'approve' && request.spotlight) {
          // AG23: the decision is recorded on the call; the Run Trace says who approved.
          decidedBy.set(call.id, request.spotlight.by);
          runnable.push(call);
        } else if (verdict === 'leave' && request.spotlight && !request.spotlight.canWait) {
          const line = approvedByLine(request.spotlight.by, false);
          const message = `${heldFor ?? `"${tool!.label}"`}${heldFor ? ' It' : ''} reaches a destination nobody gave, so it did not run (${line}). Don't retry it; explain what you would have done.`;
          upsert(toolEntry(call, tool!, { status: 'denied', error: line, by: request.spotlight.by, decidedLine: line }));
          immediate.push({ id: call.id, name: call.name, content: message, isError: true });
        } else if ((tool.requireApproval || heldFor) && (request.approvals ?? 'ask') === 'deny') {
          const message = `${heldFor ?? `"${tool.label}"`}${heldFor ? ' It' : ''} needs a person's approval, which isn't available in this kind of run${request.refusedWhy ? ` (${request.refusedWhy})` : ''}. Don't retry it; explain what you would have done.`;
          upsert(toolEntry(call, tool, { status: 'denied', error: message }));
          immediate.push({ id: call.id, name: call.name, content: message, isError: true });
        } else if (tool.requireApproval || heldFor) {
          // The waiting step shows what the card shows (what would run); the model's own call stays in the transcript. A held call shows everything it asked for.
          const shown = tool.shownInput && !heldFor ? tool.shownInput(call.input) : call.input;
          // AP02: in the inbox, what the person is asked about: the parameters it would run with, masked, and where it goes.
          const review = request.inbox ? await reviewOf(tool, call.input, shown, ctx) : undefined;
          waiting.push({ callId: call.id, tool: call.name, input: shown, ...(review && { review }) });
          upsert(toolEntry(call, tool, { status: 'awaiting_approval', input: shown }));
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
      session.messages.push({ role: 'tool', results: (await guardResults(results)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) });
      const stopped = request.team?.stopAfterTools?.();
      if (stopped !== undefined) {
        session.messages.push({ role: 'assistant', text: stopped, toolCalls: [] });
        return { reason: 'completed', reply: stopped };
      }
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
      // AG14: what the call reached, from the tool's config (an HTTP Request's URL the model gave: from the call's input).
      ...(targetOfCall(tool, call.input) && { target: targetOfCall(tool, call.input) }),
      input: call.input,
      status: 'running',
      at: existing?.at ?? now(),
      ...(decidedBy.get(call.id) && { by: decidedBy.get(call.id), decidedLine: approvedByLine(decidedBy.get(call.id)!, true) }), // AG23:
      ...(inboxLines.get(call.id) && { decidedLine: inboxLines.get(call.id) }), // AP02:
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
      // Images are kept by reference: the transcript holds the stored file's reference, the timeline and journal a label.
      const images = outcome.images?.length ? await storeToolImages({ helpers: storeHelpers(binaryScopeFor(ctx)) }, outcome.images) : [];
      const labels = images.map((image) => `[image: ${imageSizeLabel(image)}]`);
      const shown = !labels.length ? outcome.output : typeof outcome.output === 'string' ? `${outcome.output}\n${labels.join(' ')}` : { result: outcome.output, images: labels };
      upsert(
        toolEntry(call, tool, {
          status: 'success',
          output: shown,
          ...(images.length && { images: images.map((image) => ({ mimeType: image.mimeType, size: image.ref?.fileSize ?? 0, ...(image.ref?.id && { ref: image.ref.id }) })) }),
          approval: undefined,
          durationMs: Date.now() - started,
          ...(outcome.workflowId && { workflowId: outcome.workflowId }),
          ...(outcome.executionId && { executionId: outcome.executionId }),
          ...(outcome.childAgentId && { childAgentId: outcome.childAgentId }),
          ...(outcome.childSessionId && { childSessionId: outcome.childSessionId }),
          ...(outcome.remote && { remote: outcome.remote }),
          ...(outcome.target && { target: outcome.target }), // AG14:
        }),
      );
      return { id: call.id, name: call.name, content: asContent(outcome.output), ...(images.length && { images }) };
    } catch (error) {
      const message = (error as Error).message;
      upsert(toolEntry(call, tool, { status: 'error', error: message, approval: undefined, durationMs: Date.now() - started }));
      return { id: call.id, name: call.name, content: `Error: ${message}`, isError: true };
    }
  }

  async function settlePending(call: PendingCall, tool: BuiltTool | undefined, ctx: ToolContext): Promise<ToolResult | { pending: PendingCall }> {
    if (!tool) return { id: call.callId, name: call.tool, content: `The tool "${call.tool}" is no longer available.`, isError: true };
    // An edit that approved the call with changes meets the same rule as the card: only what the schema offered.
    const asCall: ToolCall = { id: call.callId, name: call.tool, input: tool.shownInput ? tool.shownInput(call.input) : call.input };
    // A remote agent's pause: the decision goes to that agent either way, and its answer is the tool's result.
    if (call.remote) {
      if (!tool.resume) return { id: call.callId, name: call.tool, content: `The tool "${call.tool}" can no longer answer the agent that paused.`, isError: true };
      return execute(asCall, tool, ctx, { state: call.remote.state, approved: call.decision === 'approved', ...(call.answer !== undefined && { answer: call.answer }) });
    }
    // AG23: a person who decided is named in the Run Trace ("Approved by you").
    const person = call.decidedBy ? ({ kind: 'person', userId: call.decidedBy } as const) : undefined;
    if (person && call.decision === 'approved') decidedBy.set(call.callId, person);
    if (call.decision === 'approved') {
      if (call.decidedLine) inboxLines.set(call.callId, call.decidedLine); // AP02: the entry says the inbox's word once it runs
      const result = await execute(asCall, tool, ctx);
      // A person's edit that added a field the tool does not take: said, not silently dropped.
      const ignored = tool.shownInput ? Object.keys(call.input).filter((k) => !(k in tool.shownInput!(call.input))) : [];
      if (ignored.length) {
        const note = `${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not something ${tool.label} takes; ignored.`;
        upsert({ id: entryId(), type: 'notice', message: note, at: now() }); // the person's step row says it too
        if (isResult(result)) return { ...result, content: `${result.content}\nNote: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not something this tool takes; ignored.` };
      }
      return result;
    }
    upsert(toolEntry(asCall, tool, { status: 'denied', error: call.decidedLine ?? 'Denied by a person', ...(person && { by: person, decidedLine: approvedByLine(person, false) }), ...(call.decidedLine && { decidedLine: call.decidedLine }) })); // AG23: AP02:
    return {
      id: call.callId,
      name: call.tool,
      content: call.refusal ? call.refusal : request.team
        ? `A person rejected your call to ${tool.label}; it did not run. Don't call it again: go on with what you can do without it, and tell your manager what you couldn't do.`
        : `The user rejected the tool call to ${call.tool}. STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`,
      isError: true,
    };
  }

  async function delegate(target: Agent, task: string): Promise<{ reply?: string; sessionId: string }> {
    // PC13: a sub-agent the project doesn't allow is a failed tool call, not an empty answer.
    if (rules && !rules.agentAllowed(target.id)) throw new Error(agentNotAllowedMessage(target.name, rules.projectName));
    const child = newSession(target, {
      source: 'agent',
      userId: `agent:${agent.id}`,
      version: target.published?.version ?? 'draft',
      title: task.slice(0, 80),
      parentSessionId: session.id,
      parentAgentId: agent.id,
    });
    const result = await runAgent({ agent: target, session: child, message: task, depth: depth + 1, maxDepth, approvals: 'deny', signal: request.signal, caller, context: { ...(request.context ?? refFromSession(session, agent.id)), caller: 'agent', agentId: target.id, ...(runCtx.projectId && { projectId: runCtx.projectId }), ...(runCtx.goalId && { goalId: runCtx.goalId }) } });
    return { reply: result.reply, sessionId: child.id };
  }
}

const isResult = (value: ToolResult | { pending: PendingCall }): value is ToolResult => !('pending' in value);

/** AP02: a held call's review for the approval inbox: the parameters it would run with (the host's secret redaction, then the mask) and where it goes in plain words. */
async function reviewOf(tool: BuiltTool, given: Record<string, unknown>, shown: Record<string, unknown>, ctx: ToolContext): Promise<NonNullable<PendingCall['review']>> {
  const effective = tool.effectiveInput ? await tool.effectiveInput(given, ctx).catch(() => shown) : shown;
  const destinations = (await spotlightDestinations(tool, given, ctx)).filter((d) => d !== NOT_GIVEN);
  const destination = [destinations.join(', '), targetLine(targetOfCall(tool, given))].filter(Boolean).join(' · ');
  return { params: maskParams(redactValue(effective)) as Record<string, unknown>, ...(destination && { destination }) };
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
  // AG10: toolImages keeps the run's image count the same on a resumed run as on the first.
  options: { onEvent?: (event: AgentStreamEvent) => void; signal?: AbortSignal; by?: string; toolImages?: { keep?: number }; line?: string; refusal?: string /* AP02: the inbox's word on the call */; inbox?: true /* AP02: the resumed turn still holds asks-first calls in the inbox */ } = {},
): Promise<DecisionResult> {
  const session = agentStore.getSession(sessionId);
  if (!session || session.agentId !== agent.id) throw new DecisionError('Session not found', 404);
  const call = session.pending?.calls.find((c) => c.callId === callId);
  if (!session.pending || !call) throw new DecisionError('That tool call is not waiting for approval', 409);
  if (call.decision) throw new DecisionError(`Already ${call.decision}`, 409);
  // AP02: a call held in the approval inbox is decided by the record through the run's resume, never by a link, a click or the session route.
  if (call.review && !options.inbox) throw new DecisionError('This call waits in the approval inbox: decide it in Needs you', 409);
  call.decision = approved ? 'approved' : 'denied';
  if (options.by) call.decidedBy = options.by;
  if (options.line) call.decidedLine = options.line; // AP02:
  if (options.refusal) call.refusal = options.refusal; // AP02:
  recordApproval({ agentId: agent.id, agentName: agent.name, tool: call.tool }, call.decision);
  if (session.pending.calls.some((c) => !c.decision)) {
    const entry = session.timeline.find((e) => e.type === 'tool' && e.callId === callId);
    if (entry?.type === 'tool' && !approved) Object.assign(entry, { status: 'denied', error: options.line ?? 'Denied by a person', ...(options.line && { decidedLine: options.line }) });
    const saved = agentStore.saveSession(session);
    if (entry) options.onEvent?.({ type: 'entry', sessionId, entry });
    options.onEvent?.({ type: 'run.finished', sessionId, status: 'awaiting_approval', reason: 'awaiting_approval', usage: saved.usage });
    return { status: 'waiting', session: saved };
  }
  const { by, line: _line, refusal: _refusal, ...runOptions } = options;
  // The person deciding goes on with a chat; a workflow's session goes on for its run.
  const result = await runAgent({ agent, session, approvals: 'ask', ...runOptions, ...(!session.execution && by && { caller: { startedBy: by } }) });
  return { status: 'resumed', ...result };
}

export class DecisionError extends HttpError {
  static readonly errorName: string = 'DecisionError';
  constructor(
    message: string,
    status: number,
  ) {
    super(message, status, { expose: true });
  }
}
