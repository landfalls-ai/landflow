/**
 * Boot-time upkeep of the platform data, started once by bootstrap: fill the
 * insights rollup from the executions on disk (first boot only), then apply the
 * execution retention settings now and every hour, and forget expired idempotency keys.
 */
import { leads } from './cluster/state';
import { pruneIdempotencyKeys } from './idempotency';
import { backfillInsights } from './insights';
import { pruneExecutions } from './settings';
import { singleton } from './singleton';
import { logger } from './telemetry';

const HOUR_MS = 3_600_000;

function attempt(label: string, fn: () => number): number {
  try {
    return fn();
  } catch (error) {
    logger.warn(`${label} failed`, { error: (error as Error).message });
    return 0;
  }
}

/** Backfill insights (before pruning, so pruned runs are counted), prune, and schedule hourly pruning. Idempotent. */
export function startDataMaintenance(): { backfilled: number; pruned: number } {
  return singleton('data-maintenance', () => {
    const backfilled = attempt('insights backfill', backfillInsights);
    const pruned = attempt('execution retention', () => pruneExecutions());
    attempt('idempotency key pruning', () => pruneIdempotencyKeys());
    if (backfilled || pruned) logger.info('platform data ready', { 'landflow.insights.backfilled': backfilled, 'landflow.executions.pruned': pruned });
    const timer = setInterval(() => {
      // Queue mode: the leader main prunes.
      if (!leads()) return;
      const removed = attempt('execution retention', () => pruneExecutions());
      if (removed) logger.info('pruned executions', { 'landflow.executions.pruned': removed });
      attempt('idempotency key pruning', () => pruneIdempotencyKeys());
    }, HOUR_MS);
    timer.unref?.();
    return { backfilled, pruned };
  });
}
