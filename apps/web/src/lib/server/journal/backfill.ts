/**
 * A journal for a run recorded before Run Trace (or with the journal lost): rebuilt once, from the run data it kept, the
 * first time someone opens its trace. Every node and sub-node run becomes the engine events it would have sent (a
 * request to a remote agent brings its steps from its result), fed through the same translator. What only lived in the
 * live stream is missing: progress notes, artifacts and checks nodes reported, approvals. The run span says
 * `attrs.rebuilt`.
 */
import type { ExecutionEvent, NodeRun, Workflow } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import type { ExecutionRecord } from '../../shared/types';
import { logger } from '../telemetry';
import { lastSeq } from './store';
import { createTranslator } from './translator';
import { journalOf, liveJournal, releaseJournal } from './writer';

const iso = (ms: number) => new Date(ms).toISOString();

interface Timed {
  at: number;
  /** -1 the run starting, 0 a node starting, 1 a node ending, 2 the run ending. */
  kind: number;
  /** Where the run is in the order nodes finished (ties at the same millisecond). */
  order: number;
  nodeId?: string;
  parentNodeId?: string;
  event: ExecutionEvent;
}

const childOf = (a: Timed, b: Timed) => Boolean(a.parentNodeId) && a.parentNodeId === b.nodeId;

/** At the same instant: a sub-node runs inside its parent; other runs one after the other, in the order they finished. */
function tie(a: Timed, b: Timed): number {
  if (a.kind < 0 || b.kind > 1) return -1;
  if (b.kind < 0 || a.kind > 1) return 1;
  if (a.kind === 0 && b.kind === 1) {
    // A start before the end of its parent, of its own sub-node, and of its own run; after the end of a run that finished first.
    if (childOf(a, b) || childOf(b, a) || (a.nodeId === b.nodeId && a.order === b.order)) return -1;
    return b.order < a.order ? 1 : -1;
  }
  if (a.kind === 1 && b.kind === 0) return -tie(b, a);
  if (a.kind === 0) return childOf(b, a) ? -1 : childOf(a, b) ? 1 : a.order - b.order;
  return childOf(a, b) ? -1 : childOf(b, a) ? 1 : a.order - b.order;
}

/** The engine events a finished run's data stands for, in time order. */
export function eventsOf(record: ExecutionRecord, workflow: Pick<Workflow, 'nodes'>): ExecutionEvent[] {
  const { executionId } = record;
  const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
  // The k-th time a node finished is its k-th run.
  const finishOrder = new Map<string, number[]>();
  (record.executionOrder ?? []).forEach((nodeId, i) => finishOrder.set(nodeId, [...(finishOrder.get(nodeId) ?? []), i]));
  const t0 = Date.parse(record.startedAt);
  const timed: Timed[] = [{ at: t0, kind: -1, order: -1, event: { type: 'execution.started', executionId, workflowId: record.workflowId, mode: record.mode, ...(record.traceId && { traceId: record.traceId }), at: record.startedAt } }];
  for (const [nodeId, runs] of Object.entries(record.runData)) {
    (runs as NodeRun[]).forEach((run, k) => {
      if (run.reused) return;
      const start = Date.parse(run.startedAt);
      const end = start + (run.durationMs ?? 0);
      const order = finishOrder.get(nodeId)?.[k] ?? Number.MAX_SAFE_INTEGER;
      const nodeName = record.nodeNames?.[nodeId] ?? names.get(nodeId) ?? nodeId;
      const input = run.source === 'tool' ? (run.inputs?.[0]?.[0]?.json as JsonObject | undefined) : undefined;
      const common = { executionId, nodeId, nodeName, source: run.source, ...(run.parentNodeId && { parentNodeId: run.parentNodeId }) };
      const where = { order, nodeId, ...(run.parentNodeId && { parentNodeId: run.parentNodeId }) };
      timed.push({ at: start, kind: 0, ...where, event: { type: 'node.started', ...common, ...(input && { input }), at: iso(start) } });
      timed.push({
        at: end,
        kind: 1,
        ...where,
        event: { type: 'node.finished', ...common, status: run.status, durationMs: run.durationMs ?? 0, itemCounts: (run.outputs ?? []).map((o) => o.length), run, at: iso(end) },
      });
    });
  }
  if (record.status !== 'running' && record.status !== 'queued') {
    const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : Math.max(...timed.map((t) => t.at));
    timed.push({
      at: finishedAt,
      kind: 2,
      order: Number.MAX_SAFE_INTEGER,
      event: {
        type: 'execution.finished',
        executionId,
        status: record.status,
        durationMs: record.durationMs ?? Math.max(0, finishedAt - t0),
        ...(record.error && { error: record.error }),
        ...(record.wait && { wait: record.wait }),
        at: iso(finishedAt),
      },
    });
  }
  return timed.sort((a, b) => a.at - b.at || tie(a, b)).map((t) => t.event);
}

/**
 * Rebuild the journal of a finished or waiting run that has none. Returns how many events were written (0 when it had a
 * journal already, is still running, or kept no workflow to read its nodes from).
 */
export function backfillJournal(record: ExecutionRecord, workflow: Workflow | undefined): number {
  if (!workflow || record.status === 'running' || record.status === 'queued' || !Object.keys(record.runData ?? {}).length) return 0;
  if (liveJournal(record.executionId) || lastSeq(record.executionId) > 0) return 0;
  try {
    const journal = journalOf(record.executionId, { workflowId: workflow.id, ...(workflow.settings?.traceContent && { content: workflow.settings.traceContent }) });
    let written = 0;
    const translator = createTranslator({
      workflow,
      executionId: record.executionId,
      emit: (draft) => {
        written++;
        // The run data was redacted when it was saved.
        journal.record(draft.type === 'span.started' && draft.spanId === 'run' ? { ...draft, attrs: { ...draft.attrs, rebuilt: true } } : draft, { redacted: true });
      },
      onTrace: (traceId) => (journal.traceId = traceId),
    });
    for (const event of eventsOf(record, workflow)) translator.feed(event);
    releaseJournal(record.executionId);
    return written;
  } catch (error) {
    logger.warn('could not rebuild the run journal', { error: (error as Error).message, 'landflow.execution.id': record.executionId });
    return 0;
  }
}
