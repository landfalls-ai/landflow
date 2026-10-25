/**
 * Timers of waiting executions: a `time` wait resumes at its `until`, and a webhook or form wait
 * with a time limit stops waiting then (it continues with what the node returned). At boot,
 * `start()` reloads every waiting execution from the store and resumes the overdue ones after a
 * short grace period. Waits without a time (a webhook or form with no limit, a parent waiting for its
 * sub-execution) have no timer. Queue mode: only the leader keeps the timers (another process hands a new wait to
 * it, and `sync()` re-arms them all when a main takes over the leadership).
 *
 * Parents waiting for sub-executions that finished while nobody listened (a process stopped in between) are settled
 * after the same grace period at boot, and on every full `sync()` (lib/server/sub-executions.ts).
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { ExecutionRecord } from '../shared/types';
import { delegated, forwardToLeader } from './cluster/state';
import { refreshRows } from './db/replication';
import { singleton } from './singleton';
import { store } from './store';
import { logger } from './telemetry';

/** setTimeout's limit (~24.8 days); longer waits re-arm when it fires. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export const waits = singleton('waits', () => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let started = false;

  function clear(executionId: string) {
    const timer = timers.get(executionId);
    if (timer) clearTimeout(timer);
    timers.delete(executionId);
  }

  async function fire(executionId: string) {
    timers.delete(executionId);
    const record = store.getExecution(executionId);
    if (record?.status !== 'waiting' || !record.wait?.until) return;
    if (Date.parse(record.wait.until) > Date.now()) return arm(record);
    // Loaded lazily: the runner imports this module.
    const { resumeExecution } = await import('./runner');
    const kind = record.wait.resume === 'time' ? 'time' : 'timeout';
    // A resume is its own trace, not a child of the span that armed the timer.
    await context
      .with(ROOT_CONTEXT, () => resumeExecution(executionId, { kind }))
      .catch((error) => logger.warn('could not resume a waiting execution', { 'landflow.execution.id': executionId, error: (error as Error).message }));
  }

  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  /** Parents of sub-executions that finished unheard (loaded lazily: it reaches the runner, which imports this module). */
  async function reconcile(boot: boolean) {
    try {
      const { reconcileWaitingParents } = await import('./sub-executions');
      await reconcileWaitingParents({ boot });
    } catch (error) {
      logger.warn('could not check the parents of finished sub-executions', { error: (error as Error).message });
    }
  }

  function arm(record: ExecutionRecord, minDelay = 0) {
    // Queue mode: the leader keeps the timers.
    if (delegated()) return forwardToLeader({ t: 'wait', id: record.executionId });
    clear(record.executionId);
    const until = record.wait?.until ? Date.parse(record.wait.until) : NaN;
    if (record.status !== 'waiting' || Number.isNaN(until)) return;
    const delay = Math.min(MAX_DELAY_MS, Math.max(minDelay, until - Date.now()));
    const timer = setTimeout(() => void fire(record.executionId), delay);
    timer.unref?.();
    timers.set(record.executionId, timer);
  }

  return {
    /** Boot: arm the timers of every waiting execution in the store; overdue ones resume after `graceMs`. */
    start(graceMs = 2_000) {
      if (started) return;
      started = true;
      const waiting = store.waitingExecutions();
      for (const record of waiting) arm(record, graceMs);
      if (waiting.length) logger.info('waiting executions loaded', { 'landflow.executions.waiting': waiting.length, 'landflow.executions.timed': timers.size });
      reconcileTimer = setTimeout(() => void reconcile(true), graceMs);
      reconcileTimer.unref?.();
    },

    /** After a run stops to wait (or finishes): arm or drop its timer. */
    track(record: ExecutionRecord) {
      if (record.status === 'waiting') arm(record);
      else clear(record.executionId);
    },

    clear,

    /**
     * Queue mode, on the leader: arm the timers of waiting executions that have none and drop those of executions that
     * stopped waiting (or only `executionId`'s, read fresh: another process just saved it).
     */
    async sync(executionId?: string) {
      if (executionId) {
        await refreshRows('executions', { id: executionId });
        const record = store.getExecution(executionId);
        if (record?.status === 'waiting') arm(record);
        else clear(executionId);
        return;
      }
      const waiting = new Map(store.waitingExecutions().map((record) => [record.executionId, record]));
      for (const id of [...timers.keys()]) if (!waiting.has(id)) clear(id);
      for (const record of waiting.values()) if (!timers.has(record.executionId)) arm(record, 1_000);
      await reconcile(false);
    },

    /** Executions with an armed timer. */
    pending(): string[] {
      return [...timers.keys()];
    },

    /** Drop every timer and allow start() again (tests simulate a restart with it). */
    stop() {
      for (const id of [...timers.keys()]) clear(id);
      clearTimeout(reconcileTimer);
      started = false;
    },
  };
});
