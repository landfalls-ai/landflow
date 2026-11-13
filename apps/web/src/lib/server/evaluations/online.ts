/**
 * Online evaluations: an LLM judge grades a sample of an agent's finished runs against a rubric (1–5). Targets
 * are standalone agents (`agent:<id>`, their sessions' `run.finished` events) and AI Agent nodes of workflows
 * (`node:<workflowId>:<nodeId>`, the executions they ran in). Each target has its own settings: on/off, sample
 * rate, rubric, judge model and the score at or below which a run is flagged. Evaluation runs are never graded.
 */
import { nanoid } from 'nanoid';
import type { LanguageModel, Workflow } from '@landflow/engine';
import type { AgentModel, AgentSession } from '../../shared/agents';
import type { OnlineEvalConfig, OnlineEvalReport, OnlineEvalScore, WorkflowOnlineEvals } from '../../shared/evaluations';
import type { ChatFeedback } from '../../shared/chat-feedback';
import type { ExecutionRecord } from '../../shared/types';
import { agentModel } from '../agents/models';
import { agentStore } from '../agents/store';
import { bus, isRelayed } from '../bus';
import { executionFeedback, getFeedback, onFeedback } from '../chat-feedback';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry';
import { asText, judge, namesOf } from './metrics';
import * as db from './store';

export const AI_AGENT_NODE = 'core.aiAgent';
/** Grading jobs waiting at most; more are dropped (the sample is a sample). */
export const MAX_QUEUED = 50;
const TEXT_LIMIT = 4_000;

export const agentTarget = (agentId: string) => `agent:${agentId}`;
export const nodeTarget = (workflowId: string, nodeId: string) => `node:${workflowId}:${nodeId}`;

/** Whether a run is in the sample: `rate` percent of them. */
export function shouldSample(rate: number, random: () => number = Math.random): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 100) return true;
  return random() * 100 < rate;
}

/** Settings as saved, clamped to their ranges. */
export function normalizeOnlineConfig(input: Partial<OnlineEvalConfig>, current: OnlineEvalConfig): OnlineEvalConfig {
  const next = { ...current, ...input };
  return {
    enabled: Boolean(next.enabled),
    sampleRate: Math.min(100, Math.max(0, Number(next.sampleRate) || 0)),
    rubric: String(next.rubric ?? '').trim() || current.rubric,
    ...(next.model?.model && { model: next.model }),
    lowScore: Math.min(5, Math.max(1, Math.round(Number(next.lowScore) || 1))),
  };
}

/** One graded run: what the user asked (with earlier turns), the reply, and the tools used. */
export interface GradedRun {
  /** The conversation up to the reply. */
  input: string;
  output: string;
  tools?: string[];
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  nodeId?: string;
  executionId?: string;
  /** Agent sessions: the timeline entry of the reply (where its thumbs up/down are kept). */
  entryId?: string;
  userFeedback?: { rating: 'up' | 'down'; comment?: string };
}

/** The thumbs up/down the graded reply got, if any (chat feedback). */
function feedbackOf(run: GradedRun): GradedRun['userFeedback'] {
  if (run.userFeedback) return run.userFeedback;
  const found = run.executionId ? executionFeedback(run.executionId) : run.agentId && run.sessionId && run.entryId ? getFeedback(`agent:${run.sessionId}:${run.entryId}`) : undefined;
  return found && { rating: found.rating, ...(found.comment && { comment: found.comment }) };
}

const clip = (text: string, limit = TEXT_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The judge's model: the target's own setting, else the given fallback (the agent's model, the node's chat model). */
function judgeModel(config: OnlineEvalConfig, fallback?: AgentModel): Promise<LanguageModel> {
  const chosen = config.model?.model ? config.model : fallback;
  if (!chosen?.model) return Promise.reject(new Error('Choose a judge model for online evaluations'));
  return agentModel(chosen);
}

const ids = { ms: 0, seq: 0 };

/** Score ids sort in creation order (time, then a sequence within the millisecond), so two scores saved together list newest first. */
export function newScoreId(now = Date.now()): string {
  ids.seq = now === ids.ms ? ids.seq + 1 : 0;
  ids.ms = now;
  return `os_${now.toString(36).padStart(9, '0')}${ids.seq.toString(36).padStart(3, '0')}${nanoid(6)}`;
}

/** Grade a run with the target's rubric and save the score. */
export async function gradeRun(target: string, run: GradedRun, options: { model?: LanguageModel; fallbackModel?: AgentModel; signal?: AbortSignal } = {}): Promise<OnlineEvalScore> {
  const config = db.getOnlineConfig(target);
  const model = options.model ?? (await judgeModel(config, options.fallbackModel));
  const toolsLine = run.tools?.length ? `\n\n(Tools the agent called: ${run.tools.join(', ')})` : '';
  const userFeedback = feedbackOf(run);
  const feedbackLine = userFeedback ? `\n\n(The person rated this reply thumbs ${userFeedback.rating}${userFeedback.comment ? `: "${clip(userFeedback.comment, 500)}"` : ''}. Weigh that, but grade the reply against the rubric.)` : '';
  const result = await judge(model, 'rubric', { rubric: config.rubric, question: clip(run.input) + toolsLine + feedbackLine, actual: clip(run.output) }, options.signal);
  const now = Date.now();
  const score: OnlineEvalScore = {
    id: newScoreId(now),
    target,
    createdAt: new Date(now).toISOString(),
    score: result.score,
    flagged: result.score <= config.lowScore,
    reasoning: result.reasoning,
    input: clip(run.input, 1_000),
    output: clip(run.output, 1_000),
    ...(run.tools?.length && { tools: run.tools }),
    judge: `${model.provider}/${model.model}`,
    ...(userFeedback && { userFeedback }),
    ...(run.agentId && { agentId: run.agentId }),
    ...(run.sessionId && { sessionId: run.sessionId }),
    ...(run.workflowId && { workflowId: run.workflowId }),
    ...(run.nodeId && { nodeId: run.nodeId }),
    ...(run.executionId && { executionId: run.executionId }),
  };
  db.saveScore(score);
  if (score.flagged) logger.warn('online evaluation flagged a low score', { 'landflow.evaluation.target': target, 'landflow.evaluation.score': score.score });
  return score;
}

// ---------------------------------------------------------------------------
// Standalone agents
// ---------------------------------------------------------------------------

/** The last turn of a session: the conversation up to its final reply, and the tools called since the last user message. */
export function sessionRun(session: AgentSession): GradedRun | undefined {
  const timeline = session.timeline ?? [];
  const lastUser = timeline.map((entry) => entry.type).lastIndexOf('user');
  const reply = [...timeline].reverse().find((entry) => entry.type === 'assistant' && entry.text.trim());
  if (lastUser < 0 || !reply || reply.type !== 'assistant') return undefined;
  const turns = timeline
    .filter((entry) => entry.type === 'user' || entry.type === 'assistant')
    .slice(-8)
    .filter((entry) => entry !== reply)
    .map((entry) => (entry.type === 'user' ? `User: ${entry.text}` : entry.type === 'assistant' ? `Agent: ${entry.text}` : ''));
  const tools = [...new Set(timeline.slice(lastUser).flatMap((entry) => (entry.type === 'tool' ? [entry.label || entry.tool] : [])))];
  return { input: turns.join('\n\n'), output: reply.text, ...(tools.length && { tools }), agentId: session.agentId, sessionId: session.id, entryId: reply.id };
}

/** Grade a session's latest turn now (sampling aside). */
export async function gradeAgentSession(agentId: string, sessionId: string, options: { model?: LanguageModel } = {}): Promise<OnlineEvalScore> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new Error('Agent not found');
  const session = agentStore.getSession(sessionId);
  if (!session || session.agentId !== agentId) throw new Error('Session not found');
  const run = sessionRun(session);
  if (!run) throw new Error('The session has no finished reply to grade');
  return gradeRun(agentTarget(agentId), run, { ...options, ...(agent.model && { fallbackModel: agent.model }) });
}

// ---------------------------------------------------------------------------
// AI Agent nodes
// ---------------------------------------------------------------------------

/** The AI Agent node's last successful run in an execution: the prompt it got, its answer and tools. */
export function nodeRunOf(record: Pick<ExecutionRecord, 'executionId' | 'workflowId' | 'runData'>, nodeId: string): GradedRun | undefined {
  const run = [...(record.runData[nodeId] ?? [])].reverse().find((entry) => entry.status === 'success' && entry.source === 'main');
  const out = run?.outputs?.[0]?.[0]?.json as Record<string, unknown> | undefined;
  if (!run || !out || out.output === undefined) return undefined;
  const input = (run.inputs?.[0]?.[0]?.json ?? {}) as Record<string, unknown>;
  const asked = input.chatInput ?? input.prompt ?? input.text ?? input.query ?? input.message ?? input;
  const tools = [...new Set(namesOf(out.steps ?? []))];
  return { input: asText(asked), output: asText(out.output), ...(tools.length && { tools }), workflowId: record.workflowId, nodeId, executionId: record.executionId };
}

/** The chat model attached to an AI Agent node, as an agent model config (the judge when none is chosen). */
export function modelOfNode(workflow: Pick<Workflow, 'nodes' | 'connections'>, nodeId: string): AgentModel | undefined {
  const edge = workflow.connections.find((c) => c.type === 'ai_languageModel' && c.target === nodeId && (c.targetIndex ?? 0) === 0);
  const source = edge && workflow.nodes.find((n) => n.id === edge.source);
  if (!source) return undefined;
  const p = source.parameters as Record<string, unknown>;
  const model = typeof p.model === 'string' ? p.model : '';
  const credential = (key: string) => source.credentials?.[key];
  switch (source.type) {
    case 'core.ollamaChatModel':
      return { provider: 'ollama', model: model || 'qwen3-coder:30b', ...(typeof p.baseUrl === 'string' && p.baseUrl && { baseUrl: p.baseUrl }) };
    case 'core.anthropicChatModel': {
      const ref = credential('anthropicApi');
      return { provider: 'anthropic', model: model || 'claude-opus-5-5', ...(ref && { credential: ref }) };
    }
    case 'core.openAiChatModel': {
      const ref = credential('openAiApi');
      return ref ? { provider: 'openai', model: model || 'gpt-5-mini', credential: ref } : undefined;
    }
    default:
      return undefined;
  }
}

/** Grade an AI Agent node's run in an execution now (sampling aside). */
export async function gradeNodeExecution(record: ExecutionRecord, nodeId: string, options: { model?: LanguageModel } = {}): Promise<OnlineEvalScore | undefined> {
  const run = nodeRunOf(record, nodeId);
  if (!run) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  const fallbackModel = workflow ? modelOfNode(workflow, nodeId) : undefined;
  return gradeRun(nodeTarget(record.workflowId, nodeId), run, { ...options, ...(fallbackModel && { fallbackModel }) });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function onlineReport(target: string, limit = 50): OnlineEvalReport {
  const config = db.getOnlineConfig(target);
  const scores = db.listScores(target, Math.max(limit, 20));
  const totals = db.scoreTotals(target);
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const recent = scores.slice(0, 10).map((s) => s.score);
  const before = scores.slice(10, 20).map((s) => s.score);
  return {
    target,
    config,
    scores: scores.slice(0, limit),
    trend: db.dailyScores(target, since),
    total: totals.total,
    ...(totals.average !== undefined && { average: totals.average }),
    flagged: totals.flagged,
    ...(recent.length >= 2 && before.length >= 2 && { change: average(recent) - average(before) }),
  };
}

/** The AI Agent nodes of a workflow, each with its report. */
export function workflowOnlineEvals(workflow: Pick<Workflow, 'id' | 'nodes'>): WorkflowOnlineEvals {
  return {
    nodes: workflow.nodes.filter((node) => node.type === AI_AGENT_NODE).map((node) => ({ nodeId: node.id, nodeName: node.name, report: onlineReport(nodeTarget(workflow.id, node.id), 20) })),
  };
}

// ---------------------------------------------------------------------------
// Sampling finished runs (bus subscription, started at boot)
// ---------------------------------------------------------------------------

const queue = singleton('online-eval-queue', () => ({ tail: Promise.resolve() as Promise<unknown>, pending: 0 }));

/** Run grading jobs one at a time, in the background; beyond MAX_QUEUED they are dropped. */
export function enqueueGrading(job: () => Promise<unknown>): Promise<unknown> | undefined {
  if (queue.pending >= MAX_QUEUED) return undefined;
  queue.pending++;
  const next = queue.tail
    .then(job)
    .catch((error: Error) => logger.warn('online evaluation failed', { error: error.message }))
    .finally(() => queue.pending--);
  queue.tail = next;
  return next;
}

/** Resolves when the queued grading jobs are done (tests). */
export const gradingIdle = () => queue.tail;

/** The execution record once it is saved (the finished event comes just before the save). */
async function loadRecord(executionId: string): Promise<ExecutionRecord | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await store.loadExecution(executionId);
    if (saved && saved.status !== 'running') return saved;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return store.loadExecution(executionId);
}

/** Queue a sampled grading of a finished agent session turn. */
export function onAgentRunFinished(agentId: string, sessionId: string, random: () => number = Math.random) {
  const target = agentTarget(agentId);
  const config = db.getOnlineConfig(target);
  if (!config.enabled || !shouldSample(config.sampleRate, random)) return undefined;
  return enqueueGrading(() => gradeAgentSession(agentId, sessionId));
}

/** Queue sampled gradings of the AI Agent nodes (with grading on) that ran in a finished execution. */
export function onExecutionFinished(workflowId: string, executionId: string, random: () => number = Math.random) {
  const prefix = `node:${workflowId}:`;
  const targets = db.enabledTargets(prefix).filter((target) => shouldSample(db.getOnlineConfig(target).sampleRate, random));
  if (!targets.length) return undefined;
  return enqueueGrading(async () => {
    const record = await loadRecord(executionId);
    if (!record || record.evaluation || record.debug || record.status !== 'success') return;
    for (const target of targets) {
      const nodeId = target.slice(prefix.length);
      if (!record.runData[nodeId]) continue;
      await gradeNodeExecution(record, nodeId).catch((error: Error) => logger.warn('online evaluation failed', { 'landflow.evaluation.target': target, error: error.message }));
    }
  });
}

/** A reply someone marked as bad is graded now (the sample rate aside), when its target has grading on and hasn't scored it yet. */
export function onBadFeedback(feedback: ChatFeedback) {
  if (feedback.rating !== 'down') return undefined;
  if (feedback.kind === 'agent' && feedback.agentId && feedback.sessionId) {
    const { agentId, sessionId, entryId } = feedback;
    if (!db.getOnlineConfig(agentTarget(agentId)).enabled) return undefined;
    if (db.listScores(agentTarget(agentId), 200).some((s) => s.sessionId === sessionId && s.userFeedback)) return undefined;
    const session = agentStore.getSession(sessionId);
    const run = session && sessionRun(session);
    if (!run || run.entryId !== entryId) return undefined;
    return enqueueGrading(() => gradeAgentSession(agentId, sessionId));
  }
  if (!feedback.workflowId || !feedback.executionId) return undefined;
  const { workflowId, executionId } = feedback;
  const targets = db.enabledTargets(`node:${workflowId}:`).filter((target) => !db.listScores(target, 200).some((s) => s.executionId === executionId && s.userFeedback));
  if (!targets.length) return undefined;
  return enqueueGrading(async () => {
    const record = await loadRecord(executionId);
    if (!record || record.evaluation || record.debug || record.status !== 'success') return;
    for (const target of targets) {
      const nodeId = target.slice(`node:${workflowId}:`.length);
      if (record.runData[nodeId]) await gradeNodeExecution(record, nodeId).catch((error: Error) => logger.warn('online evaluation failed', { 'landflow.evaluation.target': target, error: error.message }));
    }
  });
}

const subscription = singleton('online-eval-subscription', () => ({ stop: undefined as (() => void) | undefined, stopFeedback: undefined as (() => void) | undefined }));

/** Listen for finished agent runs and executions (once per process). */
export function startOnlineEvaluations(): void {
  if (subscription.stop) return;
  subscription.stopFeedback = onFeedback((feedback) => {
    try {
      onBadFeedback(feedback);
    } catch (error) {
      logger.warn('online evaluation sampling failed', { error: (error as Error).message });
    }
  });
  subscription.stop = bus.subscribe((message) => {
    // Queue mode: the process that ran it grades it.
    if (isRelayed(message)) return;
    try {
      if (message.channel === 'agent' && message.event.type === 'run.finished' && message.event.reason === 'completed') onAgentRunFinished(message.agentId, message.event.sessionId);
      else if (message.channel === 'execution' && message.event.type === 'execution.finished' && message.event.status === 'success') onExecutionFinished(message.workflowId, message.event.executionId);
    } catch (error) {
      logger.warn('online evaluation sampling failed', { error: (error as Error).message });
    }
  });
}

export function stopOnlineEvaluations(): void {
  subscription.stop?.();
  subscription.stop = undefined;
  subscription.stopFeedback?.();
  subscription.stopFeedback = undefined;
}
