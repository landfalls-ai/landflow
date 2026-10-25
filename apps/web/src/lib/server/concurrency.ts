/**
 * Per-workflow flow control (workflow settings): a concurrency limit on the production runs going at
 * once, and a singleton mode that allows one run at a time with waiting runs included. A trigger run
 * that finds no free slot waits in the workflow's FIFO queue (an execution saved as `queued`, so the
 * queue survives a restart) or is skipped, by `concurrencyOverflow`; a full queue skips it too.
 *
 * Held back: webhook, form, schedule, poll, error-workflow and agent-tool runs. Never held back
 * (they start at once, but take a slot while they run): retries, resumed waits and runs recovered
 * after a restart. Not limited at all: manual and chat runs from the editor, debug runs and
 * sub-executions (their parent holds a slot), re-runs. A waiting run releases its slot, except in
 * singleton mode. The runner owns the queue; this module decides.
 */
import type { ExecutionMode } from '@landflow/protocol';
import type { WorkflowSettings } from '@landflow/engine';

export const DEFAULT_QUEUE_SIZE = 100;

/** The modes a concurrency limit applies to. */
export const LIMITED_MODES = new Set<ExecutionMode>(['webhook', 'trigger', 'poll', 'tool']);

/** `debounced` / `batched`: held by the trigger's debounce or batching (lib/server/trigger-buffers.ts), it runs later. */
export type SkipReason = 'limit' | 'singleton' | 'queue-full' | 'debounced' | 'batched';

/** A trigger run that was not started: the workflow had no free slot and does not queue (or its queue is full). */
export class RunSkippedError extends Error {
  constructor(
    readonly workflowId: string,
    readonly reason: SkipReason,
  ) {
    super(
      reason === 'singleton'
        ? 'Skipped: this workflow runs one execution at a time and one is active'
        : reason === 'queue-full'
          ? 'Skipped: the workflow is at its concurrency limit and its queue is full'
          : 'Skipped: the workflow is at its concurrency limit',
    );
    this.name = 'RunSkippedError';
  }
}

/** Whether the settings limit concurrency at all. */
export function isLimited(settings: WorkflowSettings | undefined): boolean {
  return Boolean(settings?.singleton) || Number(settings?.concurrencyLimit) > 0;
}

/** How many runs may go at once (singleton: one), or Infinity. */
export function slotsOf(settings: WorkflowSettings | undefined): number {
  if (settings?.singleton) return 1;
  const limit = Math.floor(Number(settings?.concurrencyLimit));
  return limit > 0 ? limit : Number.POSITIVE_INFINITY;
}

export type Admission = { run: true } | { run: false; queue: true } | { run: false; queue: false; reason: SkipReason };

/**
 * May a run start now? `running` counts the workflow's limited runs going now, `waiting` its waiting runs (they hold
 * a slot only in singleton mode), `queued` the runs already in its queue (a new run never jumps it).
 */
export function admission(settings: WorkflowSettings | undefined, counts: { running: number; waiting: number; queued: number }): Admission {
  if (!isLimited(settings)) return { run: true };
  const busy = counts.running + (settings?.singleton ? counts.waiting : 0);
  if (busy < slotsOf(settings) && counts.queued === 0) return { run: true };
  if (settings?.concurrencyOverflow === 'skip') return { run: false, queue: false, reason: settings.singleton ? 'singleton' : 'limit' };
  const size = Math.floor(Number(settings?.concurrencyQueueSize));
  if (counts.queued >= (size > 0 ? size : DEFAULT_QUEUE_SIZE)) return { run: false, queue: false, reason: 'queue-full' };
  return { run: false, queue: true };
}

/** May the oldest queued run start now? (The same rule, for the queue's head.) */
export function hasFreeSlot(settings: WorkflowSettings | undefined, counts: { running: number; waiting: number }): boolean {
  if (!isLimited(settings)) return true;
  return counts.running + (settings?.singleton ? counts.waiting : 0) < slotsOf(settings);
}
