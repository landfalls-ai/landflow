/**
 * The Run Trace journal (docs/run-trace.md): what a run did, as actors, spans, artifacts and checks, kept per execution.
 * `traceSegment` is the runner's hook (one per stretch of a run); `liveJournal` lets other writers (a Landflow agent's
 * session, the approvals route) add events under a node's span; the routes read with `store.read`.
 */
import type { ExecutionEvent, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { JOURNAL_RETENTION_DAYS } from '../../shared/run-trace';
import { nodeConnections } from '../agents/connections';
import { getUser } from '../auth/users';
import { logger } from '../telemetry';
import { spanEvents } from './store';
import { createTranslator } from './translator';
import { backfillJournal } from './backfill';
import { journalOf, releaseJournal } from './writer';

export { liveJournal, journalOf, releaseJournal, resetJournals, Journal } from './writer';
export { createTranslator } from './translator';
import * as journalStore from './store';

export { journalStore };

/** Days the journal is kept (LANDFLOW_TRACE_RETENTION_DAYS, default 30; 0 keeps it until the execution is deleted). */
export function retentionDays(): number {
  const raw = process.env.LANDFLOW_TRACE_RETENTION_DAYS?.trim();
  const days = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(days) && days >= 0 ? days : JOURNAL_RETENTION_DAYS;
}

/**
 * Rebuild the journal of a run that has none from its run data (journal/backfill.ts), unless the run is older than the
 * retention: its journal was pruned, and opening it should not bring the journal back.
 */
export function rebuildJournal(record: ExecutionRecord, workflow: Workflow | undefined, now = Date.now()): number {
  const days = retentionDays();
  if (days > 0 && Date.parse(record.startedAt) < now - days * 86_400_000) return 0;
  return backfillJournal(record, workflow);
}

/** Delete the journal events older than the retention. Returns how many went. */
export function pruneJournal(now = Date.now()): number {
  const days = retentionDays();
  return days > 0 ? journalStore.prune(new Date(now - days * 86_400_000).toISOString()) : 0;
}

export interface SegmentTrace {
  /** Feed one (redacted) event of the segment. Never throws. */
  feed(event: ExecutionEvent): void;
  /** The segment ended: store what is left. */
  close(): void;
}

/** Journal one stretch of an execution: the runner feeds it every event, and it closes when the stretch ends. */
export function traceSegment(record: Pick<ExecutionRecord, 'executionId' | 'startedBy'>, workflow: Workflow): SegmentTrace {
  const noop: SegmentTrace = { feed: () => {}, close: () => {} };
  try {
    const journal = journalOf(record.executionId, { workflowId: workflow.id, ...(workflow.settings?.traceContent && { content: workflow.settings.traceContent }) });
    const user = record.startedBy ? safe(() => getUser(record.startedBy!)) : undefined;
    const translator = createTranslator({
      workflow,
      executionId: record.executionId,
      ...(record.startedBy && { startedBy: { id: record.startedBy, ...((user?.name || user?.email) && { name: user.name || user.email }) } }),
      emit: (draft) => journal.record(draft, { redacted: true }),
      onTrace: (traceId) => (journal.traceId = traceId),
      flush: () => journal.flush(),
      connectionsOf: (node, flow) => safe(() => nodeConnections(node, flow)),
    });
    translator.seed(safe(() => spanEvents(record.executionId)) ?? []);
    journal.bindSpans(translator.spanOfNode, translator.actorOfNode);
    return {
      feed(event) {
        try {
          translator.feed(event);
        } catch (error) {
          logger.warn('could not journal an event', { error: (error as Error).message, 'landflow.execution.id': record.executionId });
        }
      },
      close: () => releaseJournal(record.executionId),
    };
  } catch (error) {
    logger.warn('could not start the run journal', { error: (error as Error).message, 'landflow.execution.id': record.executionId });
    return noop;
  }
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
