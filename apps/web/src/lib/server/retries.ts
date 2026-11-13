/**
 * Automatic retries of failed production runs (workflow settings `retryMaxAttempts` and
 * `retryBaseDelaySeconds`). A failed run with attempts left gets a row in the `retries` table and a
 * timer; the delay doubles for each attempt (base, 2×base, 4×base…, at most six hours). When it
 * fires, the runner starts a new execution linked to the failed one (`retryOf`), from the failed
 * node when the failed run has a checkpoint, else from the start. Retries survive a restart:
 * `start()` re-arms them at boot (overdue ones after a grace period). Queue mode: only the leader keeps the timers
 * (another process hands a new retry to it, and `sync()` re-arms them all when a main takes over the leadership).
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../shared/types';
import { delegated, forwardToLeader } from './cluster/state';
import { database } from './db';
import { promoteExecution } from './db/reads';
import { refreshRows } from './db/replication';
import { singleton } from './singleton';
import { logger } from './telemetry';

export const DEFAULT_RETRY_DELAY_SECONDS = 30;
const MAX_DELAY_MS = 6 * 3_600_000;
/** Modes started from the editor: never retried automatically. */
const MANUAL_MODES = new Set(['manual', 'chat']);

/** When the next automatic retry of a failed execution is due, or undefined when it gets none. */
export function retryDueFor(record: ExecutionRecord, workflow: Workflow | undefined, now = Date.now()): { attempt: number; at: string } | undefined {
  const settings = workflow?.settings;
  const maxAttempts = Math.floor(Number(settings?.retryMaxAttempts));
  if (record.status !== 'error' || !(maxAttempts >= 2)) return undefined;
  // Production top-level runs only: a sub-execution's failure is its parent's to retry, an error workflow's is not retried.
  if (MANUAL_MODES.has(record.mode) || record.parentExecutionId || record.errorOf || record.debug) return undefined;
  const attempt = (record.retryAttempt ?? 0) + 1; // this run's attempt number; the first run is 1
  if (attempt >= maxAttempts) return undefined;
  const base = Number(settings?.retryBaseDelaySeconds);
  const delay = Math.min(MAX_DELAY_MS, (Number.isFinite(base) && base >= 0 ? base : DEFAULT_RETRY_DELAY_SECONDS) * 1000 * 2 ** (attempt - 1));
  return { attempt: attempt, at: new Date(now + delay).toISOString() };
}

interface RetryRow {
  execution_id: string;
  workflow_id: string;
  attempt: number;
  due_at: string;
}

export const retries = singleton('retries', () => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;

  function clear(executionId: string) {
    const timer = timers.get(executionId);
    if (timer) clearTimeout(timer);
    timers.delete(executionId);
  }

  function arm(executionId: string, dueAt: string, minDelay = 0) {
    // Queue mode: the leader keeps the timers.
    if (delegated()) return forwardToLeader({ t: 'retry', id: executionId });
    clear(executionId);
    const delay = Math.min(2 ** 31 - 1, Math.max(minDelay, Date.parse(dueAt) - Date.now()));
    const timer = setTimeout(() => void fire(executionId), delay);
    timer.unref?.();
    timers.set(executionId, timer);
  }

  async function fire(executionId: string) {
    timers.delete(executionId);
    const row = database().get<RetryRow>('SELECT execution_id, workflow_id, attempt, due_at FROM retries WHERE execution_id = ?', executionId);
    if (!row) return;
    if (Date.parse(row.due_at) > Date.now() + 50) return arm(executionId, row.due_at);
    // The retries row is what kept the source hot: load it back and hold it before that row goes, so the link written once the retry starts finds it.
    await promoteExecution(executionId).catch(() => undefined);
    database().delete('retries', { execution_id: executionId });
    // Loaded lazily: the runner imports this module.
    const { startRetry } = await import('./runner');
    await context
      .with(ROOT_CONTEXT, () => startRetry(executionId, { automatic: true }))
      .catch((error) => logger.warn('automatic retry did not start', { 'landflow.execution.id': executionId, error: (error as Error).message }));
  }

  return {
    /** Save and arm the retry of a failed execution (see retryDueFor). */
    schedule(record: ExecutionRecord, due: { attempt: number; at: string }) {
      database().upsert('retries', { execution_id: record.executionId, workflow_id: record.workflowId, attempt: due.attempt, due_at: due.at, created_at: new Date().toISOString() });
      arm(record.executionId, due.at);
      logger.info('automatic retry scheduled', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, 'landflow.retry.attempt': due.attempt + 1, 'landflow.retry.at': due.at });
    },

    /** Boot: arm every saved retry; overdue ones fire after `graceMs`. */
    start(graceMs = 3_000) {
      if (started) return;
      started = true;
      const rows = database().all<RetryRow>('SELECT execution_id, workflow_id, attempt, due_at FROM retries');
      for (const row of rows) arm(row.execution_id, row.due_at, graceMs);
      if (rows.length) logger.info('automatic retries loaded', { 'landflow.retries.pending': rows.length });
    },

    /** Drop a pending retry. Returns whether there was one. */
    cancel(executionId: string): boolean {
      clear(executionId);
      return database().delete('retries', { execution_id: executionId }) > 0;
    },

    /** Queue mode, on the leader: arm saved retries that have no timer, drop timers of retries gone (or only `executionId`'s, read fresh). */
    async sync(executionId?: string) {
      if (executionId) await refreshRows('retries', { execution_id: executionId });
      const rows = database().all<RetryRow>('SELECT execution_id, workflow_id, attempt, due_at FROM retries');
      if (executionId) {
        const row = rows.find((r) => r.execution_id === executionId);
        if (row) arm(row.execution_id, row.due_at);
        else clear(executionId);
        return;
      }
      const ids = new Set(rows.map((row) => row.execution_id));
      for (const id of [...timers.keys()]) if (!ids.has(id)) clear(id);
      for (const row of rows) if (!timers.has(row.execution_id)) arm(row.execution_id, row.due_at, 1_000);
    },

    /** Failed executions with a retry pending. */
    pending(): string[] {
      return database()
        .all<{ execution_id: string }>('SELECT execution_id FROM retries ORDER BY due_at')
        .map((row) => row.execution_id);
    },

    /** Drop every timer and allow start() again (tests simulate a restart with it). */
    stop() {
      for (const id of [...timers.keys()]) clear(id);
      started = false;
    },
  };
});
