/**
 * Runs workflows through the engine with the registry, streams their events on the bus and
 * saves them. Also: resuming waiting executions (lib/server/waits.ts keeps their timers),
 * replies to the HTTP request that started a run (Respond to Webhook, a Form's end screen),
 * sub-executions started by Execute Workflow (a parent waits while its child waits), error
 * workflows, and the workflow settings for which executions to keep.
 *
 * The durable runtime: every execution is saved when it starts (with the workflow version it
 * runs), its node runs and a checkpoint after each main-flow node as it goes, and at boot
 * `recoverExecutions()` continues the ones a crash left `running` from their last checkpoint.
 * Trigger idempotency keys (lib/server/idempotency.ts), per-workflow concurrency and the FIFO
 * queue (lib/server/concurrency.ts), retries (lib/server/retries.ts) and stop-all live here too.
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { nanoid } from 'nanoid';
import type { ExecutionMode, JsonObject, NodeItem } from '@landflow/protocol';
import {
  executeWorkflow,
  type CheckpointState,
  type DebugCommand,
  type DebugController,
  type ExecuteWorkflowOptions,
  type ExecutionEvent,
  type NodeRun,
  type PauseInfo,
  type ResumeKind,
  type Workflow,
  type WorkflowSettings,
} from '@landflow/engine';
import type { ExecutionRecord, ExecutionState, ExecutionSummary, FormCompletion, PausedState, RerunOf, RerunScope } from '../shared/types';
import { bus } from './bus';
import { admission, hasFreeSlot, LIMITED_MODES, RunSkippedError } from './concurrency';
import { DuplicateRunError, findIdempotent, rememberIdempotent } from './idempotency';
import { retries, retryDueFor } from './retries';
import { getVersion, versionFor } from './versions';
import { credentials } from './credentials/vault';
import { registry } from './plugins/registry';
import { singleton } from './singleton';
import { store } from './store';
import { fireTrigger, logger, recordRuntimeEvent } from './telemetry';
import { variables } from './variables';
import { waits } from './waits';

/** How deep Execute Workflow may nest executions. */
export const MAX_WORKFLOW_DEPTH = 10;

/** The Error Trigger's node type (error workflows start there). */
export const ERROR_TRIGGER = 'core.errorTrigger';

/**
 * What the HTTP request behind a run is waiting for, delivered while the run continues:
 * Respond to Webhook's response, or the end screen of a Form node.
 */
export type RunReply =
  | {
      type: 'webhook';
      status: number;
      headers: Record<string, string>;
      body?: string;
      json?: unknown;
      redirect?: string;
      /** A stored file, opened by Respond to Webhook (it is streamed as the body). */
      file?: { stream: ReadableStream<Uint8Array>; mimeType: string; fileName?: string; fileSize: number };
    }
  | { type: 'form'; completion: FormCompletion };

export interface RunOptions {
  workflow: Workflow;
  mode: ExecutionMode;
  startNodeId?: string;
  triggerItems?: NodeItem[];
  /** A poll trigger's new items: that node outputs them without running again. */
  triggerOutput?: { nodeId: string; items: NodeItem[] };
  /** Stop after this node. */
  destinationNodeId?: string;
  /** Re-run part of an earlier execution, reusing its data. */
  partial?: { executionId: string; nodeId: string; scope: 'from' | 'only' };
  debug?: { breakpoints?: string[]; step?: boolean };
  rerunOf?: RerunOf;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  /** Called once the execution has an id, before the first node runs. */
  onStart?: (executionId: string) => void;
  /** Receives Respond to Webhook's reply or a Form node's end screen (the first webhook reply only). */
  onReply?: (reply: RunReply) => void;
  /** Started by an Execute Workflow node of another execution. */
  parent?: { executionId: string; nodeId?: string };
  /** An error workflow run, for this failed execution (it never starts another error workflow). */
  errorOf?: string;
  /** Use this id (from newExecutionId()): webhook and form uploads are stored under it before the run starts. */
  executionId?: string;
  /** A trigger call's Idempotency-Key: the same key within the retention window rejects with DuplicateRunError (its execution id). */
  idempotencyKey?: string;
  /** Not held back by the workflow's concurrency limit (manual retries). */
  bypassConcurrency?: boolean;
  /** A retry of this failed execution (attempt 1 = the first retry). */
  retry?: { of: string; attempt: number };
  /** Continue from this failed execution's last checkpoint: what ran before it is reused, the failed node runs again. */
  fromCheckpoint?: { executionId: string };
}

export { DuplicateRunError, RunSkippedError };

/** A fresh execution id. */
export const newExecutionId = () => `ex_${nanoid(12)}`;

/** Holds a paused run until someone sends continue, step or stop. */
class DebugSession implements DebugController {
  readonly stepping: boolean;
  paused?: PausedState;
  private points: Set<string>;
  private waiter?: (command: DebugCommand) => void;

  constructor(options: NonNullable<RunOptions['debug']>) {
    this.stepping = Boolean(options.step);
    this.points = new Set(options.breakpoints ?? []);
  }

  breakpoints() {
    return this.points;
  }

  setBreakpoints(ids: string[]) {
    this.points = new Set(ids);
  }

  pause(info: PauseInfo) {
    this.paused = { nodeId: info.nodeId, nodeName: info.nodeName, reason: info.reason, since: new Date().toISOString() };
    return new Promise<DebugCommand>((resolve) => (this.waiter = resolve));
  }

  command(command: DebugCommand): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    this.paused = undefined;
    waiter(command);
    return true;
  }
}

interface LiveExecution {
  controller: AbortController;
  debug?: DebugSession;
  record: ExecutionRecord;
  onReply?: (reply: RunReply) => void;
  replied?: boolean;
  /** Counts against its workflow's concurrency limit. */
  limited?: boolean;
}

const live = singleton('live-executions', () => new Map<string, LiveExecution>());
/** Callers of queued runs in this process: settled when the run finishes (or is canceled). */
interface QueueWaiter {
  resolve: (record: ExecutionRecord) => void;
  reject: (error: unknown) => void;
  /** The trace context of the trigger call that queued it. */
  context: ReturnType<typeof context.active>;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  onReply?: (reply: RunReply) => void;
}
const queueWaiters = singleton('queue-waiters', () => new Map<string, QueueWaiter>());
/** Sub-executions that finished while their parent was still on its way into `waiting` for them. */
const finishedChildren = singleton('finished-children', () => new Map<string, ExecutionRecord>());

/** Base of the links the host hands out (resume URLs, error workflow links): LANDFLOW_PUBLIC_URL, else localhost. */
export function publicUrl(): string {
  return (process.env.LANDFLOW_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
}

/** Where a webhook or form wait of an execution is resumed (`$execution.resumeUrl` / `resumeFormUrl`). */
export function resumeUrls(executionId: string) {
  return { webhook: `${publicUrl()}/api/waiting/${executionId}`, form: `${publicUrl()}/form/waiting/${executionId}` };
}

function summaryOf(record: ExecutionRecord, paused?: PausedState): ExecutionSummary {
  return {
    id: record.executionId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    durationMs: Date.now() - Date.parse(record.startedAt),
    nodesRun: record.executionOrder.filter((id) => !record.runData[id]?.at(-1)?.reused).length,
    ...(record.rerunOf && { rerunOf: record.rerunOf }),
    ...(record.debug && { debug: true }),
    ...(paused && { paused }),
    ...(record.parentExecutionId && { parentExecutionId: record.parentExecutionId }),
    ...(record.versionId && { versionId: record.versionId }),
    ...(record.retryOf && { retryOf: record.retryOf, retryAttempt: record.retryAttempt ?? 1 }),
    ...(record.resumedAfterRestart && { resumedAfterRestart: true }),
  };
}

/** Executions still in progress (running or paused), newest first. */
export function liveExecutions(workflowId?: string): ExecutionSummary[] {
  return [...live.values()]
    .filter((entry) => !workflowId || entry.record.workflowId === workflowId)
    .map((entry) => summaryOf(entry.record, entry.debug?.paused))
    .reverse();
}

/** A running execution as a record, with what it has done so far. */
export function liveExecution(executionId: string): ExecutionRecord | undefined {
  const entry = live.get(executionId);
  if (!entry) return undefined;
  return { ...entry.record, durationMs: Date.now() - Date.parse(entry.record.startedAt), ...(entry.debug?.paused && { paused: entry.debug.paused }) };
}

export function cancelExecution(executionId: string): boolean {
  const entry = live.get(executionId);
  entry?.controller.abort();
  return Boolean(entry);
}

/** Cancel a waiting execution: it is saved as canceled and its timer cleared. False when it isn't waiting. */
export function cancelWaitingExecution(executionId: string): boolean {
  if (live.has(executionId)) return false;
  const stored = store.getExecution(executionId);
  if (stored?.status !== 'waiting') return false;
  waits.clear(executionId);
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - Date.parse(stored.startedAt));
  const { resumeState: _state, wait: _wait, ...rest } = stored;
  const canceled: ExecutionRecord = { ...rest, status: 'canceled', finishedAt: finishedAt.toISOString(), durationMs, error: { message: 'Execution canceled' } };
  store.saveExecution(canceled);
  bus.publish({
    channel: 'execution',
    workflowId: canceled.workflowId,
    event: { type: 'execution.finished', executionId, status: 'canceled', durationMs, error: canceled.error, at: finishedAt.toISOString() },
  });
  afterRun(canceled, canceled.workflow);
  // A singleton's waiting run held its slot.
  drainQueueSafely(canceled.workflowId);
  return true;
}

/**
 * Respond to Webhook and the Form node's end screen hand their reply to the request waiting on the
 * run. A form end screen is also kept on the execution. False when no request waits for a reply.
 */
export function deliverReply(executionId: string, reply: RunReply): boolean {
  const entry = live.get(executionId);
  if (!entry) return false;
  if (reply.type === 'form') entry.record.formCompletion = reply.completion;
  if (!entry.onReply || (entry.replied && reply.type === 'webhook')) return reply.type === 'form';
  if (reply.type === 'webhook') entry.replied = true;
  entry.onReply(reply);
  return true;
}

/** The items of the last main-flow node that ran successfully: what Execute Workflow returns. */
export function lastNodeItems(record: Pick<ExecutionRecord, 'executionOrder' | 'runData'>): NodeItem[] {
  for (let i = record.executionOrder.length - 1; i >= 0; i--) {
    const run = record.runData[record.executionOrder[i]]?.filter((r) => r.source === 'main').at(-1);
    if (run?.status === 'success') return run.outputs[0] ?? [];
  }
  return [];
}

export type DebugResult = { ok: true; paused?: PausedState } | { ok: false; error: string; status: number };

/** Send a debugger command and/or replace the breakpoints of a live run. */
export function debugExecution(executionId: string, request: { command?: DebugCommand; breakpoints?: string[] }): DebugResult {
  const entry = live.get(executionId);
  if (!entry) return { ok: false, error: 'Execution is not running', status: 404 };
  if (request.breakpoints) entry.debug?.setBreakpoints(request.breakpoints);
  if (request.command) {
    if (entry.debug?.command(request.command)) return { ok: true };
    if (request.command === 'stop') {
      entry.controller.abort();
      return { ok: true };
    }
    return { ok: false, error: 'Execution is not paused', status: 409 };
  }
  return { ok: true, ...(entry.debug?.paused && { paused: entry.debug.paused }) };
}

/** Execute a workflow through the registry, stream events, persist the result. */
export async function runWorkflow(options: RunOptions): Promise<ExecutionRecord> {
  const source = options.partial ? store.getExecution(options.partial.executionId) : undefined;
  if (options.partial && !source) throw new Error(`Execution ${options.partial.executionId} not found`);
  const seed = options.fromCheckpoint ? seedFromCheckpoint(options.fromCheckpoint.executionId, options.workflow) : undefined;

  // Everything from here to runSegment's live.set() (or enqueue) is synchronous: no two calls with one key, no overbooked slot.
  const idempotencyKey = options.idempotencyKey?.trim() || undefined;
  if (idempotencyKey) {
    const existing = findIdempotent(options.workflow.id, idempotencyKey);
    if (existing) {
      recordRuntimeEvent('deduplicated', options.workflow.id);
      throw new DuplicateRunError(existing, idempotencyKey);
    }
  }
  const admitted = isLimitedStart(options) ? admission(options.workflow.settings, slotCounts(options.workflow.id)) : ({ run: true } as const);
  if (!admitted.run && !admitted.queue) {
    recordRuntimeEvent('skipped', options.workflow.id);
    throw new RunSkippedError(options.workflow.id, admitted.reason);
  }

  const executionId = options.executionId ?? newExecutionId();
  let depth = 0;
  if (options.parent) {
    const parentEntry = live.get(options.parent.executionId);
    depth = ((parentEntry?.record ?? store.getExecution(options.parent.executionId))?.depth ?? 0) + 1;
    if (depth > MAX_WORKFLOW_DEPTH) throw new Error(`Sub-workflows can be nested at most ${MAX_WORKFLOW_DEPTH} levels deep`);
    // Linked both ways: the parent lists its sub-executions, the child names its parent.
    if (parentEntry) {
      (parentEntry.record.subExecutions ??= []).push({ executionId, workflowId: options.workflow.id, ...(options.parent.nodeId && { nodeId: options.parent.nodeId }) });
    }
  }
  const debug = options.debug ? new DebugSession(options.debug) : undefined;
  // The version it starts on (an unsaved editor draft has none: its graph is saved with the execution instead).
  const versionId = versionFor(options.workflow)?.id;
  const record: ExecutionRecord = {
    executionId,
    workflowId: options.workflow.id,
    workflowName: options.workflow.name,
    mode: options.mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    durationMs: 0,
    runData: {},
    executionOrder: [],
    ...(options.rerunOf && { rerunOf: options.rerunOf }),
    ...(debug && { debug: true }),
    ...(options.parent && { parentExecutionId: options.parent.executionId, depth }),
    ...(options.parent?.nodeId && { parentNodeId: options.parent.nodeId }),
    ...(options.errorOf && { errorOf: options.errorOf }),
    ...(versionId && { versionId }),
    ...(options.retry && { retryOf: options.retry.of, retryAttempt: options.retry.attempt }),
    ...(idempotencyKey && { idempotencyKey }),
  };
  if (idempotencyKey) rememberIdempotent(options.workflow.id, idempotencyKey, executionId);
  if (!admitted.run) return enqueue(record, options);
  if (seed) {
    record.runData = seed.runData;
    record.executionOrder = seed.executionOrder;
    return runSegment({
      record,
      workflow: options.workflow,
      engine: { resume: { state: seed.state, kind: 'restart' } },
      signal: options.signal,
      onEvent: options.onEvent,
      onStart: options.onStart,
      onReply: options.onReply,
    });
  }
  return runSegment({
    record,
    workflow: options.workflow,
    engine: {
      startNodeId: options.startNodeId,
      triggerItems: options.triggerItems,
      ...(options.triggerOutput && { triggerOutput: options.triggerOutput }),
      destinationNodeId: options.destinationNodeId,
      ...(source &&
        options.partial && {
          partial: {
            executionId: source.executionId,
            runData: source.runData,
            executionOrder: source.executionOrder,
            startNodeId: options.partial.nodeId,
            scope: options.partial.scope,
          },
        }),
      ...(options.rerunOf && {
        spanAttributes: { 'landflow.execution.rerun_of': options.rerunOf.executionId, 'landflow.execution.rerun_scope': options.rerunOf.scope },
      }),
    },
    debug,
    signal: options.signal,
    onEvent: options.onEvent,
    onStart: options.onStart,
    onReply: options.onReply,
  });
}

export interface ResumeRequest {
  kind: ResumeKind;
  /** The waiting node's output (a webhook request, a form submission); default: what the node returned. */
  outputs?: NodeItem[][];
  /** Fail the waiting node instead (its sub-execution failed). */
  error?: string;
  onEvent?: (event: ExecutionEvent) => void;
  onReply?: (reply: RunReply) => void;
}

export class ResumeError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/**
 * Continue a waiting execution (same id) on the workflow version it started with. Rejects with a
 * ResumeError when it doesn't exist, isn't waiting, or is already being resumed.
 */
export async function resumeExecution(executionId: string, request: ResumeRequest): Promise<ExecutionRecord> {
  // Everything up to runSegment's live.set() is synchronous, so two resume calls can't both get through.
  if (live.has(executionId)) throw new ResumeError('This execution is already running');
  const stored = store.getExecution(executionId);
  if (!stored) throw new ResumeError('Execution not found', 404);
  if (stored.status !== 'waiting' || !stored.resumeState || !stored.wait) throw new ResumeError('This execution is not waiting', 409);
  if (!stored.workflow) throw new ResumeError('The execution has no saved workflow to resume', 409);
  waits.clear(executionId);
  // The saved state leaves out the run data, which the record already holds.
  const state = { ...stored.resumeState, runData: stored.runData, executionOrder: stored.executionOrder };
  const { resumeState: _state, wait: _wait, ...rest } = stored;
  const record: ExecutionRecord = { ...rest, status: 'running', finishedAt: '', runData: structuredClone(stored.runData), executionOrder: [...stored.executionOrder] };
  return runSegment({
    record,
    workflow: stored.workflow,
    engine: { resume: { state, kind: request.kind, ...(request.outputs && { outputs: request.outputs }), ...(request.error && { error: request.error }) } },
    onEvent: request.onEvent,
    onReply: request.onReply,
  });
}

interface Segment {
  record: ExecutionRecord;
  workflow: Workflow;
  /** Start or resume options for the engine. */
  engine: Partial<ExecuteWorkflowOptions>;
  debug?: DebugSession;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  onStart?: (executionId: string) => void;
  onReply?: (reply: RunReply) => void;
}

/** One stretch of an execution: from its start or a resume until it finishes or waits. */
async function runSegment(segment: Segment): Promise<ExecutionRecord> {
  const { record, workflow } = segment;
  const { executionId } = record;
  const controller = new AbortController();
  const signal = segment.signal ? AbortSignal.any([segment.signal, controller.signal]) : controller.signal;
  const limited = countsAgainstLimit(record);
  live.set(executionId, { controller, debug: segment.debug, record, ...(segment.onReply && { onReply: segment.onReply }), ...(limited && { limited }) });
  // Saved as running before the first node, with the workflow it runs unless a saved version has it: a crash can't lose it.
  const baseSteps = record.executionOrder.length;
  saveProgress(() => store.saveExecution(record.versionId || record.workflow ? { ...record, status: 'running' } : { ...record, status: 'running', workflow }));
  segment.onStart?.(executionId);

  let finished: ExecutionRecord;
  let checkpointed = false;
  try {
    const result = await executeWorkflow({
      ...segment.engine,
      workflow,
      resolver: registry,
      executionId,
      // A poll-started run is recorded as "poll", but only the trigger polls (and it doesn't run again here).
      mode: record.mode === 'poll' ? 'trigger' : record.mode,
      resolveCredentials: (node, descriptor) => credentials.resolveFor(node, descriptor),
      // $vars: read fresh for every run, so a change in Settings applies to the next one.
      variables: variables.record(),
      resumeUrls: resumeUrls(executionId),
      debug: segment.debug,
      signal,
      onCheckpoint: (checkpoint) => {
        // The first checkpoint of a segment also keeps where it started and the `$('Node')` outputs it started with.
        const first = !checkpointed;
        checkpointed = true;
        saveProgress(() =>
          store.saveCheckpoint(executionId, {
            stepId: checkpoint.stepId,
            steps: checkpoint.steps,
            state: { ...checkpoint.state, runData: {}, executionOrder: [], nodeOutputs: {} },
            ...(first && { baseSteps, baseOutputs: checkpoint.state.nodeOutputs }),
          }),
        );
      },
      onEvent: (event) => {
        if (event.type === 'execution.started' && event.traceId) record.traceId = event.traceId;
        if (event.type === 'node.finished') {
          (record.runData[event.nodeId] ??= []).push(event.run);
          record.executionOrder.push(event.nodeId);
          saveProgress(() => store.saveStep(executionId, record.executionOrder.length - 1, event.nodeId, event.run));
        }
        // In-process node logs also go to the process log; the node's span is active, so they carry its ids.
        if (event.type === 'node.log') {
          logger[event.level](event.message, { 'landflow.execution.id': executionId, 'landflow.node.id': event.nodeId, 'landflow.workflow.id': workflow.id });
        }
        bus.publish({ channel: 'execution', workflowId: workflow.id, event });
        segment.onEvent?.(event);
      },
    });
    finished = {
      ...record,
      ...result,
      mode: record.mode,
      nodeNames: Object.fromEntries(workflow.nodes.map((n) => [n.id, n.name])),
      // The version that ran: a waiting execution resumes on it, whatever is saved later.
      workflow,
    };
    if (result.status !== 'waiting') {
      delete finished.wait;
      delete finished.resumeState;
    }
    // An automatic retry pending: say when on the failed execution (and keep it, whatever the save settings).
    const retryDue = retryDueFor(finished, workflow);
    if (retryDue) finished.retryAt = retryDue.at;
    persist(finished, workflow.settings, Boolean(retryDue));
    // The steps are in the record now. A failed run keeps its checkpoint: a retry continues from it.
    saveProgress(() => store.clearCheckpoint(executionId, finished.status === 'error'));
    if (retryDue) {
      retries.schedule(finished, retryDue);
      recordRuntimeEvent('retry_scheduled', workflow.id);
    }
  } finally {
    live.delete(executionId);
  }
  afterRun(finished, workflow);
  // A slot may have freed (also when a run starts waiting, unless the workflow is a singleton).
  if (limited) drainQueueSafely(workflow.id);
  return finished;
}

/** A write that keeps a run recoverable: if it fails, the run goes on (it only loses its checkpoint). */
function saveProgress(write: () => void) {
  try {
    write();
  } catch (error) {
    logger.warn('could not save execution progress', { error });
  }
}

/** Whether a running execution takes one of its workflow's concurrency slots: production runs at the top level. */
function countsAgainstLimit(record: ExecutionRecord): boolean {
  return LIMITED_MODES.has(record.mode) && !record.parentExecutionId && !record.debug;
}

/** Whether the concurrency limit can hold this start back: a plain trigger start (not a re-run, retry or sub-execution). */
function isLimitedStart(options: RunOptions): boolean {
  return (
    LIMITED_MODES.has(options.mode) &&
    !options.parent &&
    !options.partial &&
    !options.debug &&
    !options.rerunOf &&
    !options.retry &&
    !options.fromCheckpoint &&
    !options.bypassConcurrency
  );
}

/** A workflow's runs that take a slot now, its waiting runs and its queue. */
function slotCounts(workflowId: string) {
  let running = 0;
  for (const entry of live.values()) if (entry.limited && entry.record.workflowId === workflowId) running++;
  return { running, waiting: store.countExecutions(workflowId, ['waiting']), queued: store.countExecutions(workflowId, ['queued']) };
}

/** settings.save*Executions (default: keep). A waiting execution is always kept: it has to be resumed. */
function keepExecution(record: ExecutionRecord, settings: WorkflowSettings = {}): boolean {
  if (record.status === 'waiting') return true;
  if (record.mode === 'manual' && settings.saveManualExecutions === false) return false;
  if (record.status === 'success' && settings.saveSuccessfulExecutions === false) return false;
  if (record.status === 'error' && settings.saveFailedExecutions === false) return false;
  return true;
}

function persist(record: ExecutionRecord, settings: WorkflowSettings | undefined, keep = false) {
  if (!keep && !keepExecution(record, settings)) {
    // It may have been saved while it waited.
    store.deleteExecution(record.executionId);
    return;
  }
  // The resume state's run data duplicates the record's: keep one copy on disk.
  const saved = record.resumeState ? { ...record, resumeState: { ...record.resumeState, runData: {}, executionOrder: [] } } : record;
  store.saveExecution(saved);
}

/** After a stretch of a run: arm its wait, hand a sub-execution's result to its parent, start the error workflow. */
function afterRun(record: ExecutionRecord, workflow: Workflow | undefined) {
  if (record.status === 'waiting') {
    waits.track(record);
    // Waiting for a sub-execution that already finished (it ran on while this run was suspending).
    const childId = record.wait?.resume === 'subworkflow' ? String(record.wait.data?.executionId ?? '') : '';
    const child = childId ? finishedChildren.get(childId) : undefined;
    if (child) {
      finishedChildren.delete(childId);
      resumeParent(record.executionId, child);
    }
    dropFinishedChildren(record.executionId);
    return;
  }
  dropFinishedChildren(record.executionId);
  if (record.parentExecutionId) handOverToParent(record);
  // An automatic retry follows: the error workflow waits for the last attempt.
  if (record.status === 'error' && workflow && !record.retryAt) void runErrorWorkflow(record, workflow);
}

/** Children kept for a parent that didn't wait for them (Execute Workflow without "wait for completion"). */
function dropFinishedChildren(parentId: string) {
  for (const [id, child] of finishedChildren) if (child.parentExecutionId === parentId) finishedChildren.delete(id);
}

/** A sub-execution finished: resume the parent if it waits for it. */
function handOverToParent(child: ExecutionRecord) {
  const parentId = child.parentExecutionId!;
  const parent = store.getExecution(parentId);
  if (parent?.status === 'waiting' && parent.wait?.resume === 'subworkflow' && parent.wait.data?.executionId === child.executionId) {
    resumeParent(parentId, child);
  } else if (live.has(parentId)) {
    finishedChildren.set(child.executionId, child);
  }
}

function resumeParent(parentId: string, child: ExecutionRecord) {
  const request: ResumeRequest =
    child.status === 'success'
      ? { kind: 'subworkflow', outputs: [lastNodeItems(child)] }
      : {
          kind: 'subworkflow',
          error:
            child.status === 'canceled'
              ? `The sub-workflow was canceled (execution ${child.executionId})`
              : `Sub-workflow failed: ${child.error?.message ?? 'unknown error'} (execution ${child.executionId})`,
        };
  // Its own trace, like any resume: not a child of whatever span is active now.
  void context
    .with(ROOT_CONTEXT, () => resumeExecution(parentId, request))
    .catch((error) => logger.warn('could not resume the parent execution', { 'landflow.execution.id': parentId, error: (error as Error).message }));
}

/** n8n's Error Trigger item for a failed execution. */
export function errorItem(failed: ExecutionRecord, workflow: Pick<Workflow, 'id' | 'name'>): JsonObject {
  const lastNode = failed.error?.nodeName ?? (failed.lastNodeId ? failed.nodeNames?.[failed.lastNodeId] : undefined);
  return {
    execution: {
      id: failed.executionId,
      url: `${publicUrl()}/workflows/${workflow.id}/executions/${failed.executionId}`,
      error: { message: failed.error?.message ?? 'Unknown error' },
      ...(lastNode && { lastNodeExecuted: lastNode }),
      mode: failed.mode,
      ...(failed.rerunOf && { retryOf: failed.rerunOf.executionId }),
    },
    workflow: { id: workflow.id, name: workflow.name },
  };
}

/** settings.errorWorkflowId: run that workflow's Error Trigger for a failed, non-manual execution. */
async function runErrorWorkflow(failed: ExecutionRecord, workflow: Workflow) {
  const errorWorkflowId = workflow.settings?.errorWorkflowId;
  // Never for manual runs, never for itself, and an error workflow's own failure doesn't start another one.
  if (!errorWorkflowId || errorWorkflowId === workflow.id || failed.mode === 'manual' || failed.errorOf) return;
  const target = store.getWorkflow(errorWorkflowId);
  const trigger = target?.nodes.find((node) => node.type === ERROR_TRIGGER && !node.disabled);
  if (!target || !trigger) {
    logger.warn('error workflow not run', { 'landflow.workflow.id': workflow.id, reason: target ? 'it has no Error Trigger' : `workflow ${errorWorkflowId} not found` });
    return;
  }
  try {
    await context.with(ROOT_CONTEXT, () =>
      fireTrigger({ source: 'error', workflowId: target.id, nodeName: trigger.name }, () =>
        runWorkflow({ workflow: target, mode: 'trigger', startNodeId: trigger.id, triggerItems: [{ json: errorItem(failed, workflow) }], errorOf: failed.executionId }),
      ),
    );
  } catch (error) {
    logger.warn('error workflow failed to start', { 'landflow.workflow.id': target.id, error: (error as Error).message });
  }
}

export interface RerunRequest {
  scope: RerunScope;
  nodeId?: string;
  /** `current` (default) runs the saved workflow; `original` the version the execution ran. */
  version?: 'current' | 'original';
}

/** The first main-flow run of an execution: its trigger, and the items it was started with. */
function recordedStart(source: ExecutionRecord): { nodeId?: string; items?: NodeItem[] } {
  const nodeId = source.executionOrder.find((id) => source.runData[id]?.some((run: NodeRun) => run.source === 'main'));
  if (!nodeId) return {};
  const items = source.runData[nodeId].find((run) => run.source === 'main')?.inputs[0];
  return { nodeId, ...(items?.length && { items }) };
}

/** Turn "re-run this execution (from this node)" into run options. */
export function planRerun(sourceId: string, request: RerunRequest, workflowOverride?: Workflow): Omit<RunOptions, 'signal' | 'onEvent' | 'onStart'> {
  const source = store.getExecution(sourceId);
  if (!source) throw new RerunError(`Execution ${sourceId} not found`, 404);
  const workflow =
    workflowOverride ?? (request.version === 'original' && source.workflow ? source.workflow : (store.getWorkflow(source.workflowId) ?? source.workflow));
  if (!workflow) throw new RerunError('The workflow of this execution no longer exists', 404);
  const rerunOf: RerunOf = { executionId: source.executionId, scope: request.scope, ...(request.nodeId && { nodeId: request.nodeId }) };

  if (request.scope === 'all') {
    const start = recordedStart(source);
    const startNodeId = start.nodeId && workflow.nodes.some((n) => n.id === start.nodeId) ? start.nodeId : undefined;
    // A poll's run replays the items that poll found, rather than polling again.
    const polled = source.mode === 'poll' && startNodeId ? source.runData[startNodeId]?.find((run) => run.source === 'main')?.outputs[0] : undefined;
    if (polled) return { workflow, mode: source.mode, startNodeId, triggerOutput: { nodeId: startNodeId!, items: polled }, rerunOf };
    return { workflow, mode: source.mode, startNodeId, triggerItems: start.items, rerunOf };
  }
  if (!request.nodeId) throw new RerunError('nodeId is required to re-run from a node');
  if (!workflow.nodes.some((n) => n.id === request.nodeId)) throw new RerunError('That node is not in the workflow any more');
  return { workflow, mode: source.mode, partial: { executionId: source.executionId, nodeId: request.nodeId, scope: request.scope }, rerunOf };
}

export class RerunError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Start a run in the background and resolve with its id once it exists. */
export function startInBackground(options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    runWorkflow({ ...options, onStart: resolve }).catch(reject);
  });
}

/** Find the trigger node a run should start from. */
export function findTrigger(workflow: Workflow, source: 'manual' | 'webhook' | 'schedule' | 'chat', nodeId?: string) {
  if (nodeId) return workflow.nodes.find((n) => n.id === nodeId);
  return workflow.nodes.find((node) => {
    if (node.disabled) return false;
    const resolved = registry.resolve(node.type);
    return !('error' in resolved) && resolved.descriptor.kind === 'trigger' && resolved.descriptor.triggerSource === source;
  });
}

// ---------------------------------------------------------------------------
// Concurrency queue
// ---------------------------------------------------------------------------

/** Queue order is `startedAt` order: strictly increasing within the process, so runs queued in the same millisecond keep theirs. */
const lastQueued = singleton('last-queued-at', () => ({ at: 0 }));
function queueStamp(): string {
  lastQueued.at = Math.max(Date.now(), lastQueued.at + 1);
  return new Date(lastQueued.at).toISOString();
}

/** No free slot: save the run as `queued` (its workflow's FIFO queue) and settle when it has run or was canceled. */
function enqueue(record: ExecutionRecord, options: RunOptions): Promise<ExecutionRecord> {
  const queuedAt = queueStamp();
  const queued: ExecutionRecord = {
    ...record,
    status: 'queued',
    startedAt: queuedAt,
    queued: {
      queuedAt,
      ...(options.startNodeId && { startNodeId: options.startNodeId }),
      ...(options.triggerItems && { triggerItems: options.triggerItems }),
      ...(options.triggerOutput && { triggerOutput: options.triggerOutput }),
    },
    // The graph it was triggered with, unless a saved version has it.
    ...(!record.versionId && { workflow: options.workflow }),
  };
  store.saveExecution(queued);
  recordRuntimeEvent('queued', record.workflowId);
  logger.info('execution queued: the workflow is at its concurrency limit', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId });
  const done = new Promise<ExecutionRecord>((resolve, reject) => {
    queueWaiters.set(record.executionId, {
      resolve,
      reject,
      context: context.active(),
      ...(options.signal && { signal: options.signal }),
      ...(options.onEvent && { onEvent: options.onEvent }),
      ...(options.onReply && { onReply: options.onReply }),
    });
  });
  // The caller gave up while the run waited for its turn: it never starts.
  options.signal?.addEventListener('abort', () => cancelQueuedExecution(record.executionId), { once: true });
  options.onStart?.(record.executionId);
  return done;
}

/** Start a workflow's queued runs, oldest first, while it has free slots. Returns how many started. */
export function drainQueue(workflowId: string): number {
  const queue = store.executionsWithStatus('queued', workflowId);
  if (!queue.length) return 0;
  // The saved workflow's settings: a changed limit applies to the runs already queued.
  const settings = store.getWorkflow(workflowId)?.settings ?? queue[0].workflow?.settings;
  let started = 0;
  for (const record of queue) {
    if (live.has(record.executionId)) continue;
    if (!hasFreeSlot(settings, slotCounts(workflowId))) break;
    // Synchronous up to runSegment's live.set(): the next round counts this run.
    startQueued(record);
    started++;
  }
  return started;
}

/** Boot: start what the queues of all workflows can run now. */
export function drainQueues(): number {
  const workflowIds = new Set(store.executionsWithStatus('queued').map((record) => record.workflowId));
  let started = 0;
  for (const workflowId of workflowIds) started += drainQueue(workflowId);
  return started;
}

// A saved workflow may have a higher limit now (or no singleton): its queue needn't wait for a run to finish.
singleton('queue-drain-on-save', () =>
  store.onWorkflowsChanged(() =>
    setImmediate(() => {
      try {
        drainQueues();
      } catch (error) {
        logger.warn('could not start queued executions', { error: (error as Error).message });
      }
    }),
  ),
);

function drainQueueSafely(workflowId: string) {
  try {
    drainQueue(workflowId);
  } catch (error) {
    logger.warn('could not start queued executions', { 'landflow.workflow.id': workflowId, error: (error as Error).message });
  }
}

/** Run a queued execution now (same id), on the workflow version it was triggered with. */
function startQueued(stored: ExecutionRecord) {
  const waiter = queueWaiters.get(stored.executionId);
  queueWaiters.delete(stored.executionId);
  const workflow =
    stored.workflow ?? (stored.versionId ? getVersion(stored.workflowId, stored.versionId)?.workflow : undefined) ?? store.getWorkflow(stored.workflowId);
  if (!workflow) {
    const failed = failInterrupted(stored, 'The workflow of this queued execution no longer exists');
    waiter?.resolve(failed);
    return;
  }
  const { queued, ...rest } = stored;
  const record: ExecutionRecord = { ...rest, status: 'running', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0 };
  // In the trace of the trigger call that queued it, if that caller is still here.
  void context
    .with(waiter?.context ?? ROOT_CONTEXT, () =>
      runSegment({
        record,
        workflow,
        engine: {
          startNodeId: queued?.startNodeId,
          triggerItems: queued?.triggerItems,
          ...(queued?.triggerOutput && { triggerOutput: queued.triggerOutput }),
        },
        signal: waiter?.signal,
        onEvent: waiter?.onEvent,
        onReply: waiter?.onReply,
      }),
    )
    .then(
      (finished) => waiter?.resolve(finished),
      (error) => {
        if (waiter) waiter.reject(error);
        else logger.warn('queued execution failed to run', { 'landflow.execution.id': stored.executionId, error: (error as Error).message });
      },
    );
}

/** Cancel a queued execution before it starts. False when it isn't queued. */
export function cancelQueuedExecution(executionId: string): boolean {
  const stored = store.getExecution(executionId);
  if (stored?.status !== 'queued' || live.has(executionId)) return false;
  const { queued: _queued, ...rest } = stored;
  const finishedAt = new Date().toISOString();
  const canceled: ExecutionRecord = { ...rest, status: 'canceled', finishedAt, durationMs: 0, error: { message: 'Execution canceled before it started' } };
  store.saveExecution(canceled);
  bus.publish({ channel: 'execution', workflowId: canceled.workflowId, event: { type: 'execution.finished', executionId, status: 'canceled', durationMs: 0, error: canceled.error, at: finishedAt } });
  const waiter = queueWaiters.get(executionId);
  queueWaiters.delete(executionId);
  waiter?.resolve(canceled);
  return true;
}

// ---------------------------------------------------------------------------
// Checkpoints: crash recovery and retries from the failed node
// ---------------------------------------------------------------------------

/** The first `count` entries of an execution's run order with their runs (runData[node][k] is the node's k-th entry). */
function prefixRuns(record: Pick<ExecutionRecord, 'executionOrder' | 'runData'>, count: number) {
  const executionOrder = record.executionOrder.slice(0, count);
  const runData: Record<string, NodeRun[]> = {};
  for (const nodeId of executionOrder) {
    const run = record.runData[nodeId]?.[(runData[nodeId] ??= []).length];
    if (!run) return undefined;
    runData[nodeId].push(run);
  }
  return { executionOrder, runData };
}

/** `$('Node')` outputs at a checkpoint: those the segment started with, then its successful main-flow runs in order. */
function outputsAt(checkpoint: { baseSteps: number; steps: number; baseOutputs?: Record<string, NodeItem[][]> }, runs: { executionOrder: string[]; runData: Record<string, NodeRun[]> }, workflow: Workflow) {
  const outputs: Record<string, NodeItem[][]> = { ...checkpoint.baseOutputs };
  const names = new Map(workflow.nodes.map((node) => [node.id, node.name]));
  const seen = new Map<string, number>();
  runs.executionOrder.forEach((nodeId, index) => {
    const run = runs.runData[nodeId]?.[seen.get(nodeId) ?? 0];
    seen.set(nodeId, (seen.get(nodeId) ?? 0) + 1);
    const name = names.get(nodeId);
    if (index >= checkpoint.baseSteps && index < checkpoint.steps && run?.source === 'main' && run.status === 'success' && name) outputs[name] = run.outputs;
  });
  return outputs;
}

/** What a retry from a failed execution's last checkpoint starts with: the runs before it (marked reused) and the scheduler state. */
function seedFromCheckpoint(executionId: string, workflow: Workflow): { runData: Record<string, NodeRun[]>; executionOrder: string[]; state: CheckpointState } {
  const source = store.getExecution(executionId);
  const checkpoint = store.getCheckpoint(executionId);
  if (!source || !checkpoint) throw new RerunError(`Execution ${executionId} has no checkpoint to continue from`, 409);
  const prefix = prefixRuns(source, checkpoint.steps);
  if (!prefix) throw new RerunError(`The run data of execution ${executionId} does not match its checkpoint`, 409);
  const nodeOutputs = outputsAt(checkpoint, prefix, workflow);
  const reused = { executionId };
  const runData = Object.fromEntries(Object.entries(prefix.runData).map(([nodeId, runs]) => [nodeId, runs.map((run) => ({ ...run, reused: run.reused ?? reused }))]));
  const state: CheckpointState = { ...checkpoint.state, startedAt: new Date().toISOString(), activeMs: 0, runData, executionOrder: prefix.executionOrder, nodeOutputs };
  return { runData: structuredClone(runData), executionOrder: [...prefix.executionOrder], state };
}

/** A run that can't go on (or start): saved as failed (or canceled) with what it had done, its parent and error workflow told. */
function failInterrupted(record: ExecutionRecord, message: string, status: Extract<ExecutionState, 'error' | 'canceled'> = 'error'): ExecutionRecord {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - Date.parse(record.startedAt));
  const { resumeState: _state, wait: _wait, queued: _queued, ...rest } = record;
  const progress = withSavedSteps(record);
  const failed: ExecutionRecord = { ...rest, ...progress, status, finishedAt: finishedAt.toISOString(), durationMs, error: { message } };
  store.saveExecution(failed);
  store.clearCheckpoint(record.executionId);
  bus.publish({ channel: 'execution', workflowId: failed.workflowId, event: { type: 'execution.finished', executionId: failed.executionId, status, durationMs, error: failed.error, at: failed.finishedAt } });
  afterRun(failed, store.getWorkflow(failed.workflowId) ?? failed.workflow);
  return failed;
}

/** A saved record with the node runs saved after it (contiguous ones only): what an interrupted run had done. */
function withSavedSteps(record: ExecutionRecord): Pick<ExecutionRecord, 'runData' | 'executionOrder'> {
  const runData = structuredClone(record.runData ?? {});
  const executionOrder = [...(record.executionOrder ?? [])];
  for (const step of store.steps(record.executionId)) {
    if (step.seq < executionOrder.length) continue;
    if (step.seq > executionOrder.length) break;
    (runData[step.nodeId] ??= []).push(step.run);
    executionOrder.push(step.nodeId);
  }
  return { runData, executionOrder };
}

export interface RecoveryReport {
  resumed: string[];
  failed: Array<{ executionId: string; reason: string }>;
}

type RecoveryPlan =
  | { resume: true; workflow: Workflow; record: ExecutionRecord; state: CheckpointState; stepId: string }
  | { resume: false; reason: string; status?: 'canceled' };

/** How a `running` execution found at boot goes on: from its last checkpoint, or not (and why). */
function planRecovery(record: ExecutionRecord, running: Map<string, ExecutionRecord>): RecoveryPlan {
  if (record.debug) return { resume: false, reason: 'The debug session ended when the host restarted', status: 'canceled' };
  // A sub-execution whose parent will run the Execute Workflow step again (that starts a new one).
  const parent = record.parentExecutionId ? running.get(record.parentExecutionId) : undefined;
  if (parent && record.parentNodeId && store.getCheckpoint(parent.executionId)?.state.stack.some((entry) => entry.nodeId === record.parentNodeId)) {
    return { resume: false, reason: `The host restarted: the parent execution ${parent.executionId} runs the step that started this one again`, status: 'canceled' };
  }
  const workflow = record.workflow ?? (record.versionId ? getVersion(record.workflowId, record.versionId)?.workflow : undefined);
  if (!workflow) {
    return {
      resume: false,
      reason: record.versionId
        ? `Could not continue after the restart: workflow version ${record.versionId} no longer exists`
        : 'Could not continue after the restart: the workflow it ran was not saved',
    };
  }
  const checkpoint = store.getCheckpoint(record.executionId);
  if (!checkpoint) return { resume: false, reason: 'Could not continue after the restart: the host stopped before the execution saved a checkpoint' };
  // The record was saved when the segment started; the node runs since are steps.
  const prefix = record.executionOrder.length >= checkpoint.baseSteps ? prefixRuns(record, checkpoint.baseSteps) : undefined;
  const steps = store.steps(record.executionId).filter((step) => step.seq >= checkpoint.baseSteps && step.seq < checkpoint.steps);
  if (!prefix || steps.length !== checkpoint.steps - checkpoint.baseSteps || steps.some((step, index) => step.seq !== checkpoint.baseSteps + index)) {
    return { resume: false, reason: 'Could not continue after the restart: its saved progress is incomplete' };
  }
  for (const step of steps) {
    (prefix.runData[step.nodeId] ??= []).push(step.run);
    prefix.executionOrder.push(step.nodeId);
  }
  const nodeOutputs = outputsAt(checkpoint, prefix, workflow);
  const at = new Date().toISOString();
  const { resumeState: _state, wait: _wait, ...rest } = record;
  return {
    resume: true,
    workflow,
    stepId: checkpoint.stepId,
    record: { ...rest, status: 'running', finishedAt: '', runData: structuredClone(prefix.runData), executionOrder: [...prefix.executionOrder], resumedAfterRestart: { at, stepId: checkpoint.stepId } },
    state: { ...checkpoint.state, runData: prefix.runData, executionOrder: prefix.executionOrder, nodeOutputs },
  };
}

/**
 * Boot: continue each execution a crash or restart left `running` from its last checkpoint (tagged "resumed
 * after restart"), on the workflow version it ran. One that can't continue (a debug session, its version is
 * gone, no checkpoint yet) is saved as failed with the reason; a sub-execution whose parent repeats the step
 * that started it is canceled. Queued executions are started separately (drainQueues).
 */
export function recoverExecutions(): RecoveryReport {
  const report: RecoveryReport = { resumed: [], failed: [] };
  const running = new Map(store.executionsWithStatus('running').filter((record) => !live.has(record.executionId)).map((record) => [record.executionId, record]));
  // Decide for all first: a parent's checkpoint decides about its children before it moves on.
  const plans = [...running.values()].map((record) => ({ record, plan: planRecovery(record, running) }));
  for (const { record, plan } of plans) {
    if (plan.resume) continue;
    failInterrupted(record, plan.reason, plan.status);
    report.failed.push({ executionId: record.executionId, reason: plan.reason });
    recordRuntimeEvent('recovery_failed', record.workflowId);
    logger.warn('execution not continued after the restart', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, reason: plan.reason });
  }
  for (const { record, plan } of plans) {
    if (!plan.resume) continue;
    report.resumed.push(record.executionId);
    recordRuntimeEvent('recovered', record.workflowId);
    logger.info('execution resumed after restart', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, 'landflow.checkpoint.step': plan.stepId });
    // Its own trace (the one it started in has ended).
    void context
      .with(ROOT_CONTEXT, () =>
        runSegment({
          record: plan.record,
          workflow: plan.workflow,
          engine: {
            resume: { state: plan.state, kind: 'restart' },
            spanAttributes: { 'landflow.execution.resumed_after_restart': true, 'landflow.checkpoint.step': plan.stepId },
          },
        }),
      )
      .catch((error) => logger.warn('could not resume the execution after the restart', { 'landflow.execution.id': record.executionId, error: (error as Error).message }));
  }
  return report;
}

/** Boot: recover interrupted executions and start what the queues can run, after `graceMs` (plugins announce first). */
export function startRecovery(graceMs = 3_000): void {
  singleton('execution-recovery', () => {
    const timer = setTimeout(() => {
      try {
        const report = recoverExecutions();
        if (report.resumed.length || report.failed.length) {
          logger.info('interrupted executions handled', { 'landflow.executions.resumed': report.resumed.length, 'landflow.executions.failed': report.failed.length });
        }
        drainQueues();
      } catch (error) {
        logger.error('execution recovery failed', { error });
      }
    }, graceMs);
    timer.unref?.();
    return true;
  });
}

// ---------------------------------------------------------------------------
// Retries and stop-all
// ---------------------------------------------------------------------------

export interface RetryRequest {
  /** `failed` (default): continue from the failed node, reusing what ran before it; `start`: run it all again. */
  from?: 'failed' | 'start';
  /** `original` (default): the version the execution ran; `current`: the saved workflow. */
  version?: 'original' | 'current';
  /** Started by the automatic retry timer. */
  automatic?: boolean;
}

/**
 * Turn "retry this failed execution" into run options. From the failed node: from its last checkpoint when it
 * has one and runs on the same version (what ran before is reused exactly), else a partial run from the failed
 * node; from the start (or when it has no failed node): the whole workflow with the same trigger input.
 */
export function planRetry(sourceId: string, request: RetryRequest = {}): Omit<RunOptions, 'signal' | 'onEvent' | 'onStart'> {
  const source = store.getExecution(sourceId);
  if (!source) throw new RerunError(`Execution ${sourceId} not found`, 404);
  if (source.status !== 'error' && source.status !== 'canceled') throw new RerunError('Only failed or canceled executions can be retried', 409);
  const original = source.workflow ?? (source.versionId ? getVersion(source.workflowId, source.versionId)?.workflow : undefined);
  const current = store.getWorkflow(source.workflowId);
  const workflow = request.version === 'current' ? (current ?? original) : (original ?? current);
  if (!workflow) throw new RerunError('The workflow of this execution no longer exists', 404);
  const retry = { of: source.executionId, attempt: (source.retryAttempt ?? 0) + 1 };
  const fromFailed = request.from !== 'start';
  if (fromFailed && workflow === original && store.getCheckpoint(sourceId)) return { workflow, mode: source.mode, retry, fromCheckpoint: { executionId: sourceId } };
  const failedNode = source.error?.nodeId;
  const scope = fromFailed && failedNode && workflow.nodes.some((node) => node.id === failedNode) ? { scope: 'from' as const, nodeId: failedNode } : { scope: 'all' as const };
  const { rerunOf: _rerunOf, ...options } = planRerun(sourceId, scope, workflow);
  return { ...options, retry };
}

/**
 * Retry a failed execution: a new execution linked to it (`retryOf`, and `retriedBy` on the failed one).
 * A manual retry replaces a pending automatic one and is never held back by the concurrency limit.
 * Resolves with the new execution's id once it has started.
 */
export function startRetry(sourceId: string, request: RetryRequest = {}): Promise<string> {
  const plan = planRetry(sourceId, request);
  retries.cancel(sourceId);
  return new Promise<string>((resolve, reject) => {
    let started = false;
    const onStart = (executionId: string) => {
      started = true;
      const source = store.patchExecution(sourceId, { retriedBy: executionId, retryAt: undefined });
      recordRuntimeEvent('retried', plan.workflow.id);
      // Kept only for its automatic retry (the workflow doesn't save failed executions): it has done its part.
      if (request.automatic && source && plan.workflow.settings?.saveFailedExecutions === false) store.deleteExecution(sourceId);
      resolve(executionId);
    };
    const run = () => runWorkflow({ ...plan, bypassConcurrency: true, onStart });
    (request.automatic ? fireTrigger({ source: 'retry', workflowId: plan.workflow.id }, run) : run()).catch((error) => {
      if (!started) reject(error);
      else logger.warn('retry failed', { 'landflow.execution.id': sourceId, error: (error as Error).message });
    });
  });
}

export interface StopAllResult {
  running: number;
  waiting: number;
  queued: number;
  retries: number;
}

/** Stop everything: queued runs and pending automatic retries are dropped, waiting runs canceled, running ones aborted. */
export function stopAllExecutions(): StopAllResult {
  const result: StopAllResult = { running: 0, waiting: 0, queued: 0, retries: 0 };
  // Queued first, so a canceled run doesn't hand its slot to the next one.
  for (const record of store.executionsWithStatus('queued')) if (cancelQueuedExecution(record.executionId)) result.queued++;
  for (const id of retries.pending()) {
    if (!retries.cancel(id)) continue;
    store.patchExecution(id, { retryAt: undefined });
    result.retries++;
  }
  // Waiting before running: canceling a waiting child resumes its parent, which the next loop then aborts.
  for (const record of store.waitingExecutions()) if (cancelWaitingExecution(record.executionId)) result.waiting++;
  for (const entry of [...live.values()]) {
    if (entry.controller.signal.aborted) continue;
    entry.controller.abort();
    result.running++;
  }
  recordRuntimeEvent('stopped', undefined, result.running + result.waiting + result.queued);
  logger.info('all executions stopped', { 'landflow.executions.running': result.running, 'landflow.executions.waiting': result.waiting, 'landflow.executions.queued': result.queued, 'landflow.retries.canceled': result.retries });
  return result;
}
