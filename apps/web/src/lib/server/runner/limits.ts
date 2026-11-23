/**
 * Which runs take a concurrency slot (a workflow's own limit and the instance run cap, LANDFLOW_MAX_RUNS).
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { ExecutionRecord } from '../../shared/types';
import { CAPPED_MODES, LIMITED_MODES, maxRuns } from '../concurrency';
import { store } from '../store';
import type { RunOptions } from './types';
import { live } from './state';

/** Whether a running execution takes one of its workflow's concurrency slots: production runs at the top level. */
export function countsAgainstLimit(record: ExecutionRecord): boolean {
  return LIMITED_MODES.has(record.mode) && !record.parentExecutionId && !record.debug;
}

/** Whether the concurrency limit can hold this start back: a plain trigger start (not a re-run, retry or sub-execution). */
export function isLimitedStart(options: RunOptions): boolean {
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

/** Production runs this process runs now (the ones LANDFLOW_MAX_RUNS counts). */
export function cappedRunning(): number {
  let running = 0;
  for (const entry of live.values()) if (entry.limited && CAPPED_MODES.has(entry.record.mode)) running++;
  return running;
}

/** Whether a start in `mode` finds the instance's run cap full. */
export function overRunCap(mode: ExecutionRecord['mode']): boolean {
  const cap = maxRuns();
  return cap > 0 && CAPPED_MODES.has(mode) && cappedRunning() >= cap;
}

/** A workflow's runs that take a slot now, its waiting runs and its queue. */
export function slotCounts(workflowId: string) {
  let running = 0;
  for (const entry of live.values()) if (entry.limited && entry.record.workflowId === workflowId) running++;
  return { running, waiting: store.countExecutions(workflowId, ['waiting']), queued: store.countExecutions(workflowId, ['queued']) };
}
