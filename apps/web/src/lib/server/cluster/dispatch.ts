/**
 * Queue mode, the side that starts runs (mains, and workers for the runs they start themselves): the runner hands a
 * stretch of an execution (runSegment) to `dispatchSegment` instead of running it, and waits for a worker to finish
 * it. Which stretches go to the queue: production runs (webhooks, forms, hosted chat, schedules, polls, MCP, app
 * webhooks, agent tools, error workflows, retries and resumes of waiting runs), and editor runs too with
 * LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS. Debug sessions, and sub-executions their parent waits for (they run on the
 * parent's worker, as in n8n), stay in the process that started them.
 *
 * The caller still gets everything an in-process run gives it: `onStart` once the job is queued, `onEvent` (engine
 * events and streamed chunks), `onReply` (Respond to Webhook, a form's end screen) and the finished record, all sent by
 * the worker to this instance's inbox; the caller's abort signal cancels the run wherever it is.
 *
 * Also here: idempotency keys and concurrency slots claimed in Valkey before a run is created (`preflight`), the
 * per-workflow FIFO queue across processes (`queueRemote`, `drainRemote`), cancel and stop-all across processes, and
 * the runs other processes are running, for the Executions list.
 */
import { createHash } from 'node:crypto';
import type { ExecutionEvent } from '@landflow/engine';
import type { WorkflowSettings } from '@landflow/engine';
import type { ExecutionRecord, ExecutionSummary } from '../../shared/types';
import { bus } from '../bus';
import { DEFAULT_QUEUE_SIZE, RunSkippedError, slotsOf, type Admission } from '../concurrency';
import { database } from '../db';
import { refreshRows } from '../db/replication';
import { summarize } from '../db/rows';
import { DuplicateRunError, idempotencyTtlMs } from '../idempotency';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger, recordRuntimeEvent, traceHeaders } from '../telemetry';
import type { RunOptions, RunReply, Segment } from '../runner';
import type { QueueJob, SlotRule } from './coordinator';
import { clusterActive, clusterState, coordinator, instanceId, type ControlMessage } from './state';

const DAY_MS = 86_400_000;
/**
 * A concurrency slot taken before the run reaches a worker lasts this long (the worker renews it every heartbeat once
 * it runs, and frees it at the end): a backlog in the job queue doesn't free slots that are spoken for.
 */
export const QUEUED_SLOT_LEASE_MS = 10 * 60_000;
/** The job marker lives this long until the job is in the stream (a main that dies in between leaves no stuck marker). */
const MARKER_SETUP_MS = 120_000;
/** Inline file replies (Respond to Webhook with a file) up to this size travel through Valkey. */
export const MAX_RELAYED_FILE_BYTES = 16 * 1024 * 1024;

/** A webhook reply as it travels (a file as base64). */
export type WireReply =
  | (Omit<Extract<RunReply, { type: 'webhook' }>, 'file'> & { file?: { data: string; mimeType: string; fileName?: string; fileSize: number } })
  | Extract<RunReply, { type: 'form' }>;

/** What a worker sends the instance that waits for a run. */
export type InboxMessage =
  | { t: 'event'; id: string; event: ExecutionEvent }
  | { t: 'reply'; id: string; reply: WireReply }
  | { t: 'done'; id: string; record: ExecutionRecord }
  | { t: 'rejected'; id: string; message: string; status: number }
  | { t: 'failed'; id: string; message: string };

/** What the main that queued a run in the FIFO wants from it (read by whoever dispatches it later). */
interface RunOpts {
  origin: string;
  events?: boolean;
  streaming?: boolean;
  replies?: boolean;
}

interface Waiter {
  id: string;
  resolve: (record: ExecutionRecord) => void;
  /** Rejects with an error of the caller's module graph (instanceof checks in routes keep working). */
  fail: (message: string, status?: number) => void;
  onEvent?: (event: ExecutionEvent) => void;
  onReply?: (reply: RunReply) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
  /** A resume: the stored record stays `waiting` until a worker takes it. */
  resume: boolean;
}

const waiters = singleton('cluster-waiters', () => new Map<string, Waiter>());

// ---------------------------------------------------------------------------
// Which stretches go to the queue
// ---------------------------------------------------------------------------

/** Whether this stretch of a run goes to the workers. */
export function shouldDispatch(segment: Pick<Segment, 'record' | 'debug' | 'signal' | 'dispatched'>): boolean {
  if (!clusterActive() || segment.dispatched || segment.debug) return false;
  const { record } = segment;
  // A sub-execution its parent waits for (Execute Workflow passes its signal then): on the parent's worker.
  if (record.parentExecutionId && segment.signal) return false;
  if ((record.mode === 'manual' || record.mode === 'chat') && !clusterState().config.offloadManual) return false;
  return !record.debug;
}

const isResume = (segment: Pick<Segment, 'engine'>) => {
  const resume = segment.engine.resume as { kind?: string } | undefined;
  return Boolean(resume && resume.kind !== 'restart');
};

/** Queue a stretch of a run for the workers; resolves with the record once a worker has run it. */
export async function dispatchSegment(segment: Segment): Promise<ExecutionRecord> {
  const { record, workflow, engine } = segment;
  const id = record.executionId;
  const valkey = coordinator();
  const me = instanceId();
  const resume = isResume(segment);
  const { ResumeError } = await import('../runner');
  if (resume && !(await valkey.setIfAbsent(`resume:${id}`, me, 60_000))) throw new ResumeError('This execution is already running');
  // Queued in the workflow's FIFO by a main earlier: its events and result go to that main.
  const opts = parseOpts(await valkey.get(`run-opts:${id}`));
  const queued: ExecutionRecord = {
    ...record,
    status: 'queued',
    queued: { queuedAt: new Date().toISOString(), worker: true, ...(engine.partial || engine.resume ? {} : pick(engine, ['startNodeId', 'triggerItems', 'triggerOutput'])) },
    ...(!record.versionId && !record.workflow && { workflow }),
  };
  if (!resume) {
    // Saved as queued until a worker takes it: the Executions list shows it, Stop cancels it before it starts.
    store.saveExecution(queued);
    // Postgres: the row is there before a worker reads it.
    await database().flush().catch(() => {});
  }
  const foreign = Boolean(opts && opts.origin !== me);
  const origin = foreign ? opts!.origin : me;
  const done = foreign ? undefined : watch(id, segment, resume, ResumeError);
  const job: QueueJob = {
    executionId: id,
    workflowId: workflow.id,
    expect: resume ? 'waiting' : 'queued',
    record,
    workflow,
    engine,
    origin,
    ...((foreign ? opts!.events : Boolean(segment.onEvent)) && { events: true }),
    ...((foreign ? opts!.streaming : segment.streaming) && { streaming: true }),
    ...((foreign ? opts!.replies : Boolean(segment.onReply)) && { replies: true }),
    trace: traceHeaders(),
    enqueuedAt: new Date().toISOString(),
  };
  try {
    await valkey.set(`job:${id}`, me, MARKER_SETUP_MS);
    await valkey.enqueue(job);
    await valkey.set(`job:${id}`, me, DAY_MS);
  } catch (error) {
    settle(id);
    if (resume) await valkey.del(`resume:${id}`).catch(() => {});
    throw new Error(`Could not queue the execution: ${(error as Error).message}`);
  }
  segment.onStart?.(id);
  // The caller gave up (a webhook client went away, a parent run was canceled): cancel it wherever it is.
  segment.signal?.addEventListener('abort', () => void cancelEverywhere(id, record.workflowId), { once: true });
  // Another main waits for this run (it queued it): this process is done with it.
  return done ?? queued;
}

const pick = <T extends object>(source: T, keys: string[]) => Object.fromEntries(Object.entries(source).filter(([key, value]) => keys.includes(key) && value !== undefined));

function parseOpts(raw: string | undefined): RunOpts | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RunOpts;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Waiting for a run another process runs
// ---------------------------------------------------------------------------

type ErrorClass = new (message: string, status?: number) => Error;

/** Wait for an execution a worker runs: resolves with its record (finished, or waiting again). */
function watch(id: string, callbacks: Pick<Segment, 'onEvent' | 'onReply'>, resume: boolean, ResumeError: ErrorClass): Promise<ExecutionRecord> {
  return new Promise<ExecutionRecord>((resolve, reject) => {
    const previous = waiters.get(id);
    const waiter: Waiter = {
      id,
      resolve,
      fail: (message, status) => reject(resume || status === 409 ? new ResumeError(message, status ?? 409) : new Error(message)),
      ...(callbacks.onEvent && { onEvent: callbacks.onEvent }),
      ...(callbacks.onReply && { onReply: callbacks.onReply }),
      settled: false,
      resume,
    };
    // Its result reaches the earlier caller too (a FIFO-queued run dispatched by this same process).
    if (previous && !previous.settled) {
      const first = previous;
      const chained = waiter.resolve;
      waiter.resolve = (record) => {
        chained(record);
        first.resolve(record);
      };
      waiter.onEvent ??= first.onEvent;
      waiter.onReply ??= first.onReply;
      clearInterval(first.timer);
    }
    // Missed messages (a Valkey blip): check the database now and then.
    waiter.timer = setInterval(() => void poll(waiter), 15_000);
    waiter.timer.unref?.();
    waiters.set(id, waiter);
  });
}

/** For runs queued in the FIFO: wait for the run, whoever dispatches it later. */
export function awaitRemote(executionId: string, options: Pick<RunOptions, 'onEvent' | 'onReply' | 'streaming'>): Promise<ExecutionRecord> {
  return watch(executionId, options, false, Error as ErrorClass);
}

function settle(id: string): Waiter | undefined {
  const waiter = waiters.get(id);
  if (!waiter || waiter.settled) return undefined;
  waiter.settled = true;
  clearInterval(waiter.timer);
  waiters.delete(id);
  return waiter;
}

/** A message in this instance's inbox. */
export function handleInbox(message: InboxMessage) {
  const waiter = waiters.get(message.id);
  if (!waiter || waiter.settled) return;
  switch (message.t) {
    case 'event':
      waiter.onEvent?.(message.event);
      return;
    case 'reply':
      waiter.onReply?.(fromWire(message.reply));
      return;
    case 'done':
      settle(message.id)?.resolve(message.record);
      return;
    case 'rejected':
      settle(message.id)?.fail(message.message, message.status);
      return;
    case 'failed':
      settle(message.id)?.fail(message.message);
  }
}

/** A run finished somewhere (bus): if its worker's result didn't arrive (it was canceled before it ran), read it. */
export function noticeFinished(executionId: string) {
  const waiter = waiters.get(executionId);
  if (!waiter || waiter.settled) return;
  setTimeout(() => void poll(waiter, true), 1_000).unref?.();
}

async function poll(waiter: Waiter, afterFinish = false) {
  if (waiter.settled || !clusterActive()) return;
  try {
    const valkey = coordinator();
    const [job, lease] = await valkey.getMany([`job:${waiter.id}`, `lease:${waiter.id}`]);
    // Still queued or running somewhere.
    if (lease || (job && !afterFinish)) return;
    await refreshRows('executions', { id: waiter.id });
    const record = store.getExecution(waiter.id);
    if (!record) return;
    if (record.status === 'running' || record.status === 'queued') return;
    // A resume whose job is gone while the record still waits: it was turned away (or lost).
    if (record.status === 'waiting' && waiter.resume && !afterFinish) return;
    settle(waiter.id)?.resolve(record);
  } catch (error) {
    logger.debug('cluster: could not check a queued run', { 'landflow.execution.id': waiter.id, error: (error as Error).message });
  }
}

/** Runs this process waits for (metrics, status). */
export const awaitedRuns = () => waiters.size;

// ---------------------------------------------------------------------------
// Replies over the wire
// ---------------------------------------------------------------------------

/** A reply as it travels: a file is read into memory (up to MAX_RELAYED_FILE_BYTES). */
export async function toWire(reply: RunReply): Promise<WireReply> {
  if (reply.type !== 'webhook' || !reply.file) return reply as WireReply;
  const { file, ...rest } = reply;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = file.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RELAYED_FILE_BYTES) {
      await reader.cancel().catch(() => {});
      return { type: 'webhook', status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `Respond to Webhook: files over ${MAX_RELAYED_FILE_BYTES} bytes can't be sent back in queue mode` };
    }
    chunks.push(value);
  }
  return { ...rest, file: { data: Buffer.concat(chunks).toString('base64'), mimeType: file.mimeType, ...(file.fileName && { fileName: file.fileName }), fileSize: size } };
}

export function fromWire(reply: WireReply): RunReply {
  if (reply.type !== 'webhook' || !reply.file) return reply as RunReply;
  const { file, ...rest } = reply;
  const bytes = Buffer.from(file.data, 'base64');
  return { ...rest, file: { stream: new Blob([bytes]).stream(), mimeType: file.mimeType, ...(file.fileName && { fileName: file.fileName }), fileSize: file.fileSize } };
}

// ---------------------------------------------------------------------------
// Idempotency and concurrency before a run exists
// ---------------------------------------------------------------------------

/** The slot rule of a workflow's settings (lib/server/concurrency.ts), with its waiting runs counted for singletons. */
export function slotRule(workflowId: string, settings: WorkflowSettings | undefined): SlotRule {
  const size = Math.floor(Number(settings?.concurrencyQueueSize));
  return {
    slots: slotsOf(settings),
    waiting: settings?.singleton ? store.countExecutions(workflowId, ['waiting']) : 0,
    overflow: settings?.concurrencyOverflow === 'skip' ? 'skip' : 'queue',
    queueSize: size > 0 ? size : DEFAULT_QUEUE_SIZE,
  };
}

export const idempotencyClaim = (workflowId: string, key: string) => `idem:${workflowId}:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

/**
 * Queue mode, before runWorkflow creates the execution: claim the idempotency key (two mains with the same key: one
 * run) and, for a limited trigger start, a concurrency slot or a FIFO place. Throws DuplicateRunError or RunSkippedError.
 */
export async function preflight(options: RunOptions, limited: boolean, newId: () => string): Promise<{ executionId: string; admitted: Admission }> {
  const valkey = coordinator();
  const executionId = options.executionId ?? newId();
  const workflowId = options.workflow.id;
  const key = options.idempotencyKey?.trim();
  const claim = key ? idempotencyClaim(workflowId, key) : undefined;
  if (claim && !(await valkey.setIfAbsent(claim, executionId, idempotencyTtlMs()))) {
    const existing = await valkey.get(claim);
    if (existing && existing !== executionId) {
      recordRuntimeEvent('deduplicated', workflowId);
      throw new DuplicateRunError(existing, key!);
    }
  }
  if (!limited) return { executionId, admitted: { run: true } };
  const settings = options.workflow.settings;
  const result = await valkey.admit(workflowId, executionId, slotRule(workflowId, settings), QUEUED_SLOT_LEASE_MS);
  if (result === 'run') return { executionId, admitted: { run: true } };
  if (result === 'queue') return { executionId, admitted: { run: false, queue: true } };
  if (claim) await valkey.deleteIfValue(claim, executionId).catch(() => {});
  recordRuntimeEvent('skipped', workflowId);
  throw new RunSkippedError(workflowId, result === 'full' ? 'queue-full' : settings?.singleton ? 'singleton' : 'limit');
}

/** A run saved as queued (no free slot): put it in the workflow's FIFO across processes, and try to start the head. */
export async function queueRemote(record: ExecutionRecord, options: Pick<RunOptions, 'onEvent' | 'onReply' | 'streaming'>, queuedAt: string, start: StartQueued): Promise<void> {
  try {
    const valkey = coordinator();
    const opts: RunOpts = { origin: instanceId(), ...(options.onEvent && { events: true }), ...(options.streaming && { streaming: true }), ...(options.onReply && { replies: true }) };
    await valkey.set(`run-opts:${record.executionId}`, JSON.stringify(opts), DAY_MS);
    await database().flush().catch(() => {});
    await valkey.addToQueue(record.workflowId, record.executionId, Date.parse(queuedAt));
  } catch (error) {
    logger.warn('cluster: could not queue the execution', { 'landflow.execution.id': record.executionId, error: (error as Error).message });
  }
  await drainRemote(record.workflowId, start);
}

/** The runner's start for a queued execution (startQueued). */
export type StartQueued = (stored: ExecutionRecord) => void;

/** Start a workflow's queued runs that fit in free slots now (any process may; the head moves atomically in Valkey). */
export async function drainRemote(workflowId: string, start: StartQueued): Promise<number> {
  if (!clusterActive()) return 0;
  const valkey = coordinator();
  const settings = store.getWorkflow(workflowId)?.settings;
  let started = 0;
  try {
    const ids = await valkey.drain(workflowId, slotRule(workflowId, settings), QUEUED_SLOT_LEASE_MS);
    for (const id of ids) {
      await refreshRows('executions', { id });
      const stored = store.getExecution(id);
      if (stored?.status !== 'queued') {
        // Canceled meanwhile (or its row hasn't arrived yet: back to the head of the queue).
        await valkey.releaseSlot(workflowId, id);
        if (!stored) await valkey.addToQueue(workflowId, id, 0);
        continue;
      }
      start(stored);
      started++;
    }
  } catch (error) {
    logger.warn('cluster: could not start queued executions', { 'landflow.workflow.id': workflowId, error: (error as Error).message });
  }
  return started;
}

// ---------------------------------------------------------------------------
// Cancel, stop all, and runs going elsewhere
// ---------------------------------------------------------------------------

/** Cancel an execution that may run in another process: its worker aborts it, a job not taken yet is skipped. */
export async function cancelEverywhere(executionId: string, workflowId?: string): Promise<void> {
  if (!clusterActive()) return;
  const valkey = coordinator();
  await valkey.set(`canceled:${executionId}`, '1', 3_600_000).catch(() => {});
  if (workflowId) await valkey.removeFromQueue(workflowId, executionId).catch(() => {});
  const { cancelQueuedExecution } = await import('../runner');
  // Still queued (in the FIFO, or a job no worker took yet): saved as canceled now.
  await refreshRows('executions', { id: executionId }).catch(() => {});
  cancelQueuedExecution(executionId);
  await clusterState().relay?.broadcast<ControlMessage>('control', { t: 'cancel', id: executionId });
}

/** A queued run was canceled here: a worker that takes its job skips it, it leaves the FIFO and frees a slot it was given. */
export async function forgetQueued(workflowId: string, executionId: string, start: StartQueued): Promise<void> {
  if (!clusterActive()) return;
  const valkey = coordinator();
  try {
    await Promise.all([valkey.set(`canceled:${executionId}`, '1', 3_600_000), valkey.removeFromQueue(workflowId, executionId), valkey.releaseSlot(workflowId, executionId)]);
    // A worker may have started it a moment ago.
    await clusterState().relay?.broadcast<ControlMessage>('control', { t: 'cancel', id: executionId });
    await drainRemote(workflowId, start);
  } catch (error) {
    logger.debug('cluster: could not forget a queued run', { 'landflow.execution.id': executionId, error: (error as Error).message });
  }
}

/** Ask every process to abort its running executions. */
export function broadcastStopAll() {
  void clusterState().relay?.broadcast<ControlMessage>('control', { t: 'stop-all' });
}

/** Executions other processes are running (saved as running, not live here), newest first. */
export function remoteRunning(local: ReadonlySet<string>, workflowId?: string): ExecutionSummary[] {
  if (!clusterActive()) return [];
  return store
    .executionsWithStatus('running', workflowId)
    .filter((record) => !local.has(record.executionId))
    .map((record) => ({ ...summarize(record), status: 'running' as const, durationMs: Math.max(0, Date.now() - Date.parse(record.startedAt)) }))
    .reverse();
}

/** Bus events from other processes end the waits for them too. */
singleton('cluster-finished-watch', () =>
  bus.subscribe((message) => {
    if (message.channel === 'execution' && message.event.type === 'execution.finished') noticeFinished(message.event.executionId);
  }),
);
