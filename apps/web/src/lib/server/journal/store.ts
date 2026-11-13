/**
 * The journal table (lib/server/db, migration 2000): `execution_events`, one row per event of an execution, `data` the
 * whole JournalEvent. Written in batches by the writer (./writer), read by `GET /api/executions/:id/events`.
 */
import type { JournalEvent } from '../../shared/run-trace';
import { database } from '../db';
import { readExecutionEvents, readRows } from '../db/reads';
import { parse } from '../db/rows';

/** A batch hit a sequence number somebody else wrote (a resumed run's other process): nothing of it was stored. */
export class SeqClash extends Error {
  constructor() {
    super('journal sequence clash');
  }
}

/** The highest seq stored for an execution (0 = none). */
export function lastSeq(executionId: string): number {
  return Number(database().get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM execution_events WHERE execution_id = ?', executionId)?.seq ?? 0);
}

/** Store a batch in one transaction. Throws SeqClash (and stores nothing) when one of the numbers is taken. */
export function append(executionId: string, events: JournalEvent[]) {
  const db = database();
  db.transaction(() => {
    for (const event of events) {
      const inserted = db.insertNew('execution_events', {
        execution_id: executionId,
        seq: event.seq,
        at: event.at,
        type: event.type,
        span_id: event.spanId,
        parent_span_id: event.type === 'span.started' ? (event.parentSpanId ?? null) : null,
        trace_id: event.traceId ?? null,
        data: JSON.stringify(event),
      });
      if (!inserted) throw new SeqClash();
    }
  });
}

/** Events after `after`, in order. */
export function read(executionId: string, after = 0, limit = 500): JournalEvent[] {
  return database()
    .all<{ data: string }>('SELECT data FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?', executionId, Math.max(0, Math.floor(after)), Math.max(1, Math.floor(limit)))
    .flatMap((row) => parse<JournalEvent>(row.data) ?? []);
}

const MAX_READ = 20_000;

/** Every event of an execution's journal (the first 20,000). */
export function readAll(executionId: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (let after = 0; events.length < MAX_READ; ) {
    const page = read(executionId, after, 2000);
    events.push(...page);
    if (page.length < 2000) break;
    after = page[page.length - 1].seq;
  }
  return events;
}

/** The check events written since `since` (ISO), oldest first: the needs-you list reads the failed ones. */
export function checksSince(since: string): JournalEvent[] {
  return database()
    .all<{ data: string }>("SELECT data FROM execution_events WHERE type = 'check' AND at >= ? ORDER BY at, seq", since)
    .flatMap((row) => parse<JournalEvent>(row.data) ?? []);
}

/** The `span.started` event of a span, when it has one. */
export function spanStart(executionId: string, spanId: string): Extract<JournalEvent, { type: 'span.started' }> | undefined {
  const row = database().get<{ data: string }>("SELECT data FROM execution_events WHERE execution_id = ? AND span_id = ? AND type = 'span.started' ORDER BY seq LIMIT 1", executionId, spanId);
  return parse<Extract<JournalEvent, { type: 'span.started' }>>(row?.data);
}

/** Delete the events older than `before` (ISO). Returns how many went. */
export function prune(before: string): number {
  return database().deleteBefore('execution_events', 'at', before);
}

/** Delete the events of these executions. */
export function deleteFor(executionIds: string[]) {
  const db = database();
  db.transaction(() => {
    for (const id of executionIds) db.delete('execution_events', { execution_id: id });
  });
}

/** The span events of an execution, in order (a resumed segment rebuilds what is open from them). */
export function spanEvents(executionId: string): JournalEvent[] {
  return database()
    .all<{ data: string }>("SELECT data FROM execution_events WHERE execution_id = ? AND type LIKE 'span.%' ORDER BY seq", executionId)
    .flatMap((row) => parse<JournalEvent>(row.data) ?? []);
}

// Async readers over the read seam (db/reads.ts), for callers that may read a finished run's journal. The synchronous
// ones above stay for writers that run during an execution.

/** `read`, async. */
export async function readEventsAsync(executionId: string, after = 0, limit = 500): Promise<JournalEvent[]> {
  return (await readExecutionEvents(executionId, after, limit)).flatMap((text) => parse<JournalEvent>(text) ?? []);
}

/** `readAll`, async. */
export async function readAllAsync(executionId: string): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  for (let after = 0; events.length < MAX_READ; ) {
    const page = await readEventsAsync(executionId, after, 2000);
    events.push(...page);
    if (page.length < 2000) break;
    after = page[page.length - 1].seq;
  }
  return events;
}

/** `lastSeq`, async. */
export async function lastSeqAsync(executionId: string): Promise<number> {
  const rows = await readRows<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM execution_events WHERE execution_id = ?', executionId);
  return Number(rows[0]?.seq ?? 0);
}

/** `checksSince`, async. */
export async function checksSinceAsync(since: string): Promise<JournalEvent[]> {
  const rows = await readRows<{ data: string }>("SELECT data FROM execution_events WHERE type = 'check' AND at >= ? ORDER BY at, seq", since);
  return rows.flatMap((row) => parse<JournalEvent>(row.data) ?? []);
}

/** `spanStart`, async. */
export async function spanStartAsync(executionId: string, spanId: string): Promise<Extract<JournalEvent, { type: 'span.started' }> | undefined> {
  const rows = await readRows<{ data: string }>("SELECT data FROM execution_events WHERE execution_id = ? AND span_id = ? AND type = 'span.started' ORDER BY seq LIMIT 1", executionId, spanId);
  return parse<Extract<JournalEvent, { type: 'span.started' }>>(rows[0]?.data);
}

/** `spanEvents`, async. */
export async function spanEventsAsync(executionId: string): Promise<JournalEvent[]> {
  const rows = await readRows<{ data: string }>("SELECT data FROM execution_events WHERE execution_id = ? AND type LIKE 'span.%' ORDER BY seq", executionId);
  return rows.flatMap((row) => parse<JournalEvent>(row.data) ?? []);
}
