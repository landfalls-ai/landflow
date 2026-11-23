/**
 * Boot-time upkeep of the platform data, started once by bootstrap: fill the
 * insights rollup from the executions on disk (first boot only), then apply the
 * execution retention settings now and every hour, forget expired idempotency keys, and prune the run journal daily; sweep harness sessions hourly and prune their events daily.
 */
import { leads } from './cluster/state';
import { pruneIdempotencyKeys } from './idempotency';
import { backfillInsights } from './insights';
import { pruneAsks } from './a2a/agent-asks';
import { pruneJournal } from './journal';
import { bus } from './bus';
import { prune as pruneHarness, sweep as sweepHarness, viewOf as harnessView } from './harness/store';
import { noteStore } from './notebook/store';
import { pruneExecutions } from './settings';
import { singleton } from './singleton';
import { logger } from './telemetry';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function attempt(label: string, fn: () => number): number {
  try {
    return fn();
  } catch (error) {
    logger.warn(`${label} failed`, { error: (error as Error).message });
    return 0;
  }
}

/** The team notebook's time passing (docs/team-notebook.md#how-long-notes-live): expired notes are marked, long-expired ones deleted. */
function expireNotes(): number {
  const { expired, deleted } = noteStore.expire();
  if (expired || deleted) logger.info('team notebook expiry', { 'landflow.notebook.expired': expired, 'landflow.notebook.deleted': deleted });
  return expired + deleted;
}

/** Harness sessions (C04): quiet ones are told to the live stream as stale, 24-hour-quiet ones close. */
async function sweepHarnessSessions(): Promise<number> {
  try {
    const changed = await sweepHarness();
    for (const row of changed) bus.publish({ channel: 'harness', ownerId: row.owner_id, ...(row.agent_id && { agentId: row.agent_id }), session: harnessView(row) });
    return changed.length;
  } catch (error) {
    logger.warn('harness session sweep failed', { error: (error as Error).message });
    return 0;
  }
}

/** Backfill insights (before pruning, so pruned runs are counted), prune, and schedule hourly pruning. Idempotent. */
export function startDataMaintenance(): { backfilled: number; pruned: number } {
  return singleton('data-maintenance', () => {
    const backfilled = attempt('insights backfill', backfillInsights);
    const pruned = attempt('execution retention', () => pruneExecutions());
    attempt('idempotency key pruning', () => pruneIdempotencyKeys());
    attempt('run journal retention', () => pruneJournal());
    attempt('team notebook expiry', expireNotes);
    attempt('command ask retention', () => pruneAsks());
    attempt('harness event retention', () => pruneHarness());
    void sweepHarnessSessions();
    if (backfilled || pruned) logger.info('platform data ready', { 'landflow.insights.backfilled': backfilled, 'landflow.executions.pruned': pruned });
    const timer = setInterval(() => {
      // Queue mode: the leader main prunes.
      if (!leads()) return;
      const removed = attempt('execution retention', () => pruneExecutions());
      if (removed) logger.info('pruned executions', { 'landflow.executions.pruned': removed });
      attempt('idempotency key pruning', () => pruneIdempotencyKeys());
      void sweepHarnessSessions();
    }, HOUR_MS);
    timer.unref?.();
    // The Run Trace journal (LANDFLOW_TRACE_RETENTION_DAYS): once a day.
    const daily = setInterval(() => {
      if (!leads()) return;
      const removed = attempt('run journal retention', () => pruneJournal());
      if (removed) logger.info('pruned run journal events', { 'landflow.journal.pruned': removed });
      attempt('team notebook expiry', expireNotes);
      attempt('command ask retention', () => pruneAsks());
      attempt('harness event retention', () => pruneHarness());
    }, DAY_MS);
    daily.unref?.();
    return { backfilled, pruned };
  });
}
