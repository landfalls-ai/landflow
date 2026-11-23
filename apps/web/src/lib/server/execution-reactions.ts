/**
 * What the host does when an execution finishes saving: record its insights, record its usage, prune by retention, and
 * revoke the leased secrets it was issued (C30).
 * store.ts only emits the event (`onExecutionFinished`); this module subscribes, so the store imports no feature and
 * the cycle store <-> settings <-> insights <-> usage ledger is gone. The runtime (runtime.ts) calls
 * `ensureExecutionReactions()` for both roles (workers save executions too); tests that assert on insights or usage after
 * `saveExecution` call it themselves.
 */
import { recordExecutionInsights } from './insights';
import { revokeRun } from './secrets/leases';
import { retentionTick } from './settings';
import { singleton } from './singleton';
import { writeOutboxRows } from './outbox/events';
import { onExecutionFinished, onExecutionSaving } from './store';
import { logger } from './telemetry/logger';
import { recordExecutionUsage } from './usage/ledger';

/** Register the reactions once per process (idempotent across module graphs). */
export function ensureExecutionReactions(): void {
  singleton('execution-reactions', () => {
    // Run events for event subscriptions (outbox/events.ts): written in the save's own transaction, so a saved run always has its rows.
    onExecutionSaving(writeOutboxRows);
    // Insights first: its rollup keeps the run's counts after retention deletes the execution.
    onExecutionFinished(({ summary }) => recordExecutionInsights(summary));
    // The usage ledger too (docs/second-brain.md): what ran, failed and was slow, without the items.
    onExecutionFinished(({ record, workflow }) => recordExecutionUsage(record, workflow));
    // Retention (Settings → General): count and age, every LANDFLOW_RETENTION_EVERY finished runs;
    // running and waiting executions are never pruned.
    onExecutionFinished(() => void retentionTick());
    // C30: the run's leased secrets end with it, wherever it ended (a worker saves its runs too). A run that only waits keeps them
    // (its TTL still applies), and a failure here is the sweeper's to retry (secrets/lease-sweeper.ts), so a save never waits for it.
    onExecutionFinished(({ record }) => {
      if (record.status === 'waiting') return;
      void revokeRun(record.executionId, 'finish').catch((error: Error) => logger.warn('revoking a run’s leased secrets failed; the sweeper retries', { 'landflow.execution.id': record.executionId, error: error.message }));
    });
    return true;
  });
}
