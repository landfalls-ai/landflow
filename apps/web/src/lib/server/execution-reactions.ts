/**
 * What the host does when an execution finishes saving: record its insights, record its usage, prune by retention.
 * store.ts only emits the event (`onExecutionFinished`); this module subscribes, so the store imports no feature and
 * the cycle store <-> settings <-> insights <-> usage ledger is gone. The runtime (runtime.ts) calls
 * `ensureExecutionReactions()` for both roles (workers save executions too); tests that assert on insights or usage after
 * `saveExecution` call it themselves.
 */
import { recordExecutionInsights } from './insights';
import { retentionTick } from './settings';
import { singleton } from './singleton';
import { onExecutionFinished } from './store';
import { recordExecutionUsage } from './usage/ledger';

/** Register the reactions once per process (idempotent across module graphs). */
export function ensureExecutionReactions(): void {
  singleton('execution-reactions', () => {
    // Insights first: its rollup keeps the run's counts after retention deletes the execution.
    onExecutionFinished(({ summary }) => recordExecutionInsights(summary));
    // The usage ledger too (docs/second-brain.md): what ran, failed and was slow, without the items.
    onExecutionFinished(({ record, workflow }) => recordExecutionUsage(record, workflow));
    // Retention (Settings → General): count and age, every LANDFLOW_RETENTION_EVERY finished runs;
    // running and waiting executions are never pruned.
    onExecutionFinished(() => void retentionTick());
    return true;
  });
}
