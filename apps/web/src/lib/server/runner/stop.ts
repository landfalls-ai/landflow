/**
 * Stop-all and canceling a waiting execution.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { ExecutionRecord } from '../../shared/types';
import { bus } from '../bus';
import { retries } from '../retries';
import { store } from '../store';
import { logger, recordRuntimeEvent } from '../telemetry';
import { waits } from '../waits';
import { cancelChildrenOf } from '../sub-executions';
import { broadcastStopAll, remoteRunning } from '../cluster/dispatch';
import { clusterActive } from '../cluster/state';
import { live } from './state';
import { afterRun } from './links';
import { drainQueueSafely, cancelQueuedExecution } from './queue';

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
  // Nothing waits for its sub-executions any more.
  cancelChildrenOf(stored);
  // A singleton's waiting run held its slot.
  drainQueueSafely(canceled.workflowId);
  return true;
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
  // Queue mode: every other process aborts its own runs.
  if (clusterActive()) {
    result.running += remoteRunning(new Set(live.keys())).length;
    broadcastStopAll();
  }
  recordRuntimeEvent('stopped', undefined, result.running + result.waiting + result.queued);
  logger.info('all executions stopped', { 'landflow.executions.running': result.running, 'landflow.executions.waiting': result.waiting, 'landflow.executions.queued': result.queued, 'landflow.retries.canceled': result.retries });
  return result;
}
