/**
 * Run events and the rows that carry them. `runEvents()` turns one saved execution into the events it announces (pure);
 * `writeOutboxRows()` is the save hook (store.ts `onExecutionSaving`, registered in ../execution-reactions) that writes a
 * row per matching subscription inside the transaction that saves the execution, so a run that is saved always has its
 * rows and one that is not has none. The dispatcher (./dispatcher) delivers them afterwards.
 *
 * Ids are deterministic (`<executionId>:run.finished`, `<executionId>:node.finished:<node name>`), and each event is
 * announced by the first save that shows its state (a run that was already running, or already finished, announces
 * nothing again), so saving a run twice never doubles an event. A run that is `waiting` announces nothing; it announces
 * its end when it ends. `node.finished` is derived from the finished run's data, so it arrives after the run (C19-D4).
 */
import type { ExecutionRecord, ExecutionState } from '../../shared/types';
import { MAX_EVENT_BODY_BYTES, MAX_OUTPUT_ITEMS, type RunEventType } from '../../shared/event-subscriptions';
import { homeProjectId } from '../projects/store';
import { publicUrl } from '../config/urls';
import { logger } from '../telemetry/logger';
import { enqueue, SUBSCRIPTION_OUTBOX } from './core';
import { matching, projectSubscriptions, type EventSubscription } from './subscriptions';

export interface RunEvent {
  id: string;
  type: RunEventType;
  /** The event's own time: the run's start, its end, or the node's start. */
  at: string;
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionState;
  mode: string;
  startedAt: string;
  finishedAt?: string;
  error?: { message: string; node?: string };
  /** `node.finished` only. */
  node?: { id: string; name: string; status: string };
}

const TERMINAL = new Set<ExecutionState>(['success', 'error', 'canceled']);

/** A node's display name in this run. */
function nodeName(record: ExecutionRecord, nodeId: string): string | undefined {
  return record.nodeNames?.[nodeId] ?? record.workflow?.nodes.find((node) => node.id === nodeId)?.name;
}

/**
 * The events a save announces. `previous` is the status the execution had before this save (undefined: none stored).
 * `wantedNodes` are the node names some subscription asked `node.finished` for; no name, no node events.
 */
export function runEvents(record: ExecutionRecord, previous: ExecutionState | undefined, wantedNodes: ReadonlySet<string> = new Set()): RunEvent[] {
  const base = { executionId: record.executionId, workflowId: record.workflowId, workflowName: record.workflowName, status: record.status, mode: record.mode, startedAt: record.startedAt, ...(record.finishedAt && { finishedAt: record.finishedAt }) };
  if (record.status === 'running') {
    // Announced once: a run that goes waiting -> running again is not a second start.
    return previous === undefined || previous === 'queued' ? [{ ...base, id: `${record.executionId}:run.started`, type: 'run.started', at: record.startedAt }] : [];
  }
  if (!TERMINAL.has(record.status) || (previous !== undefined && TERMINAL.has(previous))) return [];
  const at = record.finishedAt || new Date().toISOString();
  const events: RunEvent[] = [];
  if (wantedNodes.size) {
    const seen = new Set<string>();
    for (const [nodeId, runs] of Object.entries(record.runData ?? {})) {
      const name = nodeName(record, nodeId);
      const last = runs.filter((run) => run.source === 'main').at(-1);
      if (!name || !last || !wantedNodes.has(name) || seen.has(name)) continue;
      seen.add(name);
      events.push({ ...base, id: `${record.executionId}:node.finished:${name}`, type: 'node.finished', at: last.startedAt, node: { id: nodeId, name, status: last.status } });
    }
  }
  const failed = record.status === 'error';
  events.push({
    ...base,
    id: `${record.executionId}:${failed ? 'run.failed' : 'run.finished'}`,
    type: failed ? 'run.failed' : 'run.finished',
    at,
    ...(record.error && { error: { message: record.error.message, ...(record.error.nodeName && { node: record.error.nodeName }) } }),
  });
  return events;
}

/** The first items of a node's main output, as plain JSON. */
function outputItems(record: ExecutionRecord, nodeId: string | undefined, limit: number): unknown[] {
  const run = nodeId ? record.runData?.[nodeId]?.filter((r) => r.source === 'main').at(-1) : undefined;
  return (run?.outputs?.flat() ?? []).slice(0, limit).map((item) => ({ json: item.json }));
}

/** The JSON body a subscription receives: ids, status and times; the last step's items only when it asked for them (cut to 64 KB). */
export function eventPayload(event: RunEvent, record: ExecutionRecord, subscription: Pick<EventSubscription, 'projectId' | 'includeOutput'>): string {
  const body: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    createdAt: event.at,
    projectId: subscription.projectId,
    workflow: { id: event.workflowId, name: event.workflowName },
    execution: { id: event.executionId, status: event.status, mode: event.mode, startedAt: event.startedAt, ...(event.finishedAt && { finishedAt: event.finishedAt }), url: `${publicUrl()}/executions/${event.executionId}` },
    ...(event.error && { error: event.error }),
    ...(event.node && { node: { name: event.node.name, status: event.node.status } }),
  };
  if (!subscription.includeOutput || event.type === 'run.started') return JSON.stringify(body);
  const all = outputItems(record, event.node?.id ?? record.lastNodeId, Number.POSITIVE_INFINITY);
  let items = all.slice(0, MAX_OUTPUT_ITEMS);
  // Over the cap: drop items from the end until the body fits.
  while (items.length && Buffer.byteLength(JSON.stringify({ ...body, output: items, outputTruncated: true })) > MAX_EVENT_BODY_BYTES) items = items.slice(0, -1);
  const truncated = items.length < all.length;
  return JSON.stringify({ ...body, output: items, ...(truncated && { outputTruncated: true }) });
}

/** Strictly increasing creation times, so two events written in the same millisecond keep their order (run.started before node.finished before run.finished). */
let lastMs = 0;
function nextCreatedAt(): string {
  lastMs = Math.max(lastMs + 1, Date.now());
  return new Date(lastMs).toISOString();
}

/** Called after rows are written, outside the dispatcher's module (set by it): wakes the dispatcher on this process. */
let kick: (() => void) | undefined;
export function setEventKick(fn: (() => void) | undefined) {
  kick = fn;
}

/**
 * The save hook: write a row for each (event, matching subscription) of this save, in the caller's transaction.
 * A project with no enabled subscription costs one lookup. It never throws: a bad subscription must not stop a save.
 */
export function writeOutboxRows(record: ExecutionRecord, previousStatus: () => ExecutionState | undefined): void {
  try {
    if (record.status === 'waiting' || !record.workflowId) return;
    const projectId = homeProjectId('workflow', record.workflowId);
    if (!projectId) return;
    const subscriptions = projectSubscriptions(projectId);
    if (!subscriptions.length) return;
    const wanted = new Set(subscriptions.filter((s) => s.events.includes('node.finished') && (!s.workflowIds || s.workflowIds.includes(record.workflowId))).flatMap((s) => s.nodeNames));
    const events = runEvents(record, previousStatus(), wanted);
    let written = 0;
    for (const event of events) {
      for (const subscription of matching(projectId, event.workflowId, event.type, event.node?.name)) {
        if (enqueue(SUBSCRIPTION_OUTBOX, subscription.id, { eventId: event.id, createdAt: nextCreatedAt(), payload: eventPayload(event, record, subscription) })) written += 1;
      }
    }
    if (written) kick?.();
  } catch (error) {
    logger.warn('could not queue run events', { 'landflow.execution.id': record.executionId, error: (error as Error).message });
  }
}
