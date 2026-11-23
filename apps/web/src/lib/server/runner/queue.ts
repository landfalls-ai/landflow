/**
 * The concurrency queue: runs that found no free slot are saved as `queued`, started oldest first (or by priority under
 * the run cap) when a slot frees, and canceled before they start.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { ExecutionRecord } from '../../shared/types';
import { bus } from '../bus';
import { CAPPED_MODES, hasFreeSlot, maxRuns, priorityOf, queueOrder } from '../concurrency';
import { getVersion } from '../versions';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger, recordRuntimeEvent } from '../telemetry';
import { awaitRemote, cancelEverywhere, drainRemote, forgetQueued, queueRemote } from '../cluster/dispatch';
import { clusterActive } from '../cluster/state';
import type { RunOptions } from './types';
import { live, queueWaiters } from './state';
import { cappedRunning, slotCounts } from './limits';
import { runSegment } from './run';
import { failInterrupted } from './recovery';

/** Queue order is `startedAt` order: strictly increasing within the process, so runs queued in the same millisecond keep theirs. */
const lastQueued = singleton('last-queued-at', () => ({ at: 0 }));
function queueStamp(): string {
  lastQueued.at = Math.max(Date.now(), lastQueued.at + 1);
  return new Date(lastQueued.at).toISOString();
}

/** No free slot: save the run as `queued` (its workflow's FIFO queue) and settle when it has run or was canceled. */
export function enqueue(record: ExecutionRecord, options: RunOptions): Promise<ExecutionRecord> {
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
  // Queue mode: the workflow's FIFO is in Valkey, and whichever process frees a slot starts the head.
  if (clusterActive()) {
    const remote = awaitRemote(record.executionId, options);
    options.signal?.addEventListener('abort', () => void cancelEverywhere(record.executionId, record.workflowId), { once: true });
    options.onStart?.(record.executionId);
    void queueRemote(queued, options, queuedAt, startQueued);
    return remote;
  }
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
  // Queue mode: the head of the Valkey FIFO moves atomically, whoever drains (the count comes later).
  if (clusterActive()) {
    void drainRemote(workflowId, startQueued);
    return 0;
  }
  // An instance-wide run cap: queued runs of every workflow compete for the free places, higher priorities first.
  if (maxRuns() > 0) return drainByPriority();
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

/**
 * With LANDFLOW_MAX_RUNS: start the queued runs of all workflows that fit under the cap and their workflow's own limit, in
 * the order of their priority setting and queue time (`queueOrder`: a high run overtakes older normal and low ones, but a low
 * run that waited long enough still goes first).
 */
function drainByPriority(): number {
  const queue = store
    .executionsWithStatus('queued')
    .filter((record) => !live.has(record.executionId))
    .map((record) => {
      const settings = store.getWorkflow(record.workflowId)?.settings ?? record.workflow?.settings;
      return { record, settings, order: queueOrder(Date.parse(record.queued?.queuedAt ?? record.startedAt) || 0, priorityOf(settings)) };
    })
    .sort((a, b) => a.order - b.order);
  let started = 0;
  for (const { record, settings } of queue) {
    if (!CAPPED_MODES.has(record.mode)) {
      // Not counted by the cap (tool runs): only its workflow's own limit holds it.
      if (!hasFreeSlot(settings, slotCounts(record.workflowId))) continue;
    } else if (cappedRunning() >= maxRuns() || !hasFreeSlot(settings, slotCounts(record.workflowId))) continue;
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

export function drainQueueSafely(workflowId: string) {
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
  // Queue mode: out of the Valkey FIFO, and skipped by the worker that takes its job.
  if (clusterActive()) void forgetQueued(canceled.workflowId, executionId, startQueued);
  const waiter = queueWaiters.get(executionId);
  queueWaiters.delete(executionId);
  waiter?.resolve(canceled);
  return true;
}
