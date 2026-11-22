/**
 * The one implementation of a durable outbox: claim due rows with a lease, settle them (delete on delivery, back off on
 * a failure, or mark them dead), make waiting rows due now, and prune dead ones. Both outboxes use it: the audit SIEM
 * outbox (`audit_outbox`, ../audit/outbox, every main delivers) and run-event subscriptions (`event_outbox`, ./dispatcher,
 * the leader delivers). The tables differ only in the column naming the receiver, the primary key and whether a row can
 * be dead, which `OutboxTable` says; the numbers (a 60 s lease, a 2 s backoff doubling to 5 minutes with ±20 % jitter)
 * are the ones the audit outbox always had.
 *
 * Writes go through `database()` row calls inside one transaction, so on Postgres they replicate like any other write
 * and the lease is visible to the other processes.
 */
import { database } from '../db';
import type { Row, SqlValue } from '../db/database';

export const LEASE_MS = 60_000;
export const MAX_BACKOFF_MS = 300_000;
/** The longest `last_error` kept on a row. */
export const MAX_ERROR_CHARS = 500;

/** What differs between the outbox tables. */
export interface OutboxTable {
  table: 'audit_outbox' | 'event_outbox';
  /** The column naming who the row is for (a SIEM destination, a subscription). */
  target: 'destination_id' | 'target_id';
  /** `event_outbox` holds several kinds of row: this one's `topic`. */
  topic?: string;
  /** The primary key columns, for deleting and re-writing a row. */
  key: readonly string[];
  /** Whether a row can be marked dead (a `dead_at` column) instead of being retried for ever. */
  dead: boolean;
}

export const AUDIT_OUTBOX: OutboxTable = { table: 'audit_outbox', target: 'destination_id', key: ['destination_id', 'event_id'], dead: false };
export const SUBSCRIPTION_OUTBOX: OutboxTable = { table: 'event_outbox', target: 'target_id', topic: 'subscription', key: ['topic', 'target_id', 'event_id'], dead: true };

/** The columns every outbox row has (the table's own extra columns ride along untouched). */
export interface OutboxRow {
  event_id: string;
  created_at: string;
  attempts: number | bigint;
  next_at: string;
  lease_until: string | null;
  last_error: string | null;
  dead_at?: string | null;
  [column: string]: SqlValue | undefined;
}

export type SettleOutcome = { ok: true } | { error: Error; dead?: boolean };

/** The delay before attempt `attempts + 1` after `attempts` failures: 2 s doubling, at most 5 minutes, ±20 %. */
export function backoffMs(attempts: number, random = Math.random()): number {
  const base = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(Math.min(MAX_BACKOFF_MS, base * (0.8 + 0.4 * random)));
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The conditions that pick a table's rows for `targetId`: SQL and its parameters. */
function scope(t: OutboxTable, targetId: string): { sql: string; args: SqlValue[] } {
  return { sql: `${t.target} = ?${t.topic ? ' AND topic = ?' : ''}${t.dead ? ' AND dead_at IS NULL' : ''}`, args: [targetId, ...(t.topic ? [t.topic] : [])] };
}

/** The columns that identify `row`, for `delete`. */
function keyOf(t: OutboxTable, row: OutboxRow): Row {
  return Object.fromEntries(t.key.map((column) => [column, row[column] as SqlValue]));
}

/**
 * Write a row for `targetId` unless it exists, in the caller's transaction (the run's save, the audit event's write).
 * Returns whether it was written; an existing row (the same event id) is left as it is.
 */
export function enqueue(t: OutboxTable, targetId: string, row: { eventId: string; createdAt: string; payload?: string }): boolean {
  return database().insertNew(t.table, {
    ...(t.topic && { topic: t.topic, payload: row.payload ?? '{}', dead_at: null }),
    [t.target]: targetId,
    event_id: row.eventId,
    created_at: row.createdAt,
    attempts: 0,
    next_at: row.createdAt,
    lease_until: null,
    last_error: null,
  });
}

/**
 * Claim up to `limit` due rows of `targetId` for this process (a lease of a minute), oldest first, inside one
 * transaction so two processes on one database don't take the same row. `ordered` claims only the oldest live row of the
 * target, and none while that row is waiting out a backoff or is leased: a later event never overtakes an earlier one.
 */
export function claimDue<R extends OutboxRow = OutboxRow>(t: OutboxTable, targetId: string, limit: number, now: number, ordered: boolean): R[] {
  const db = database();
  const at = iso(now);
  const lease = iso(now + LEASE_MS);
  const { sql, args } = scope(t, targetId);
  return db.transaction(() => {
    let rows: R[];
    if (ordered) {
      const oldest = db.get<R>(`SELECT * FROM ${t.table} WHERE ${sql} ORDER BY created_at, event_id LIMIT 1`, ...args);
      const due = oldest && oldest.next_at <= at && (oldest.lease_until === null || oldest.lease_until < at);
      rows = oldest && due ? [oldest] : [];
    } else {
      rows = db.all<R>(`SELECT * FROM ${t.table} WHERE ${sql} AND next_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at, event_id LIMIT ?`, ...args, at, at, limit);
    }
    for (const row of rows) db.upsert(t.table, { ...row, lease_until: lease });
    return rows;
  });
}

/**
 * Settle claimed rows. Delivered: they are deleted. Failed: each gets its attempt counted, the error kept (at most 500
 * characters), the lease dropped and the next try pushed out by the backoff; with `dead` (tables that support it) the row
 * stays, marked dead, and is never claimed again. Returns the latest time (ms) a row of the batch is due again, 0 when
 * delivered or dead.
 */
export function settleRows(t: OutboxTable, rows: OutboxRow[], outcome: SettleOutcome, now: number): number {
  const db = database();
  if ('error' in outcome && outcome.dead && !t.dead) throw new Error(`${t.table} rows cannot be dead`);
  return db.transaction(() => {
    if ('ok' in outcome) {
      for (const row of rows) db.delete(t.table, keyOf(t, row));
      return 0;
    }
    let next = 0;
    for (const row of rows) {
      const attempts = Number(row.attempts) + 1;
      const last_error = outcome.error.message.slice(0, MAX_ERROR_CHARS);
      if (outcome.dead) {
        db.upsert(t.table, { ...row, attempts, lease_until: null, last_error, dead_at: iso(now) });
        continue;
      }
      const at = now + backoffMs(attempts);
      next = Math.max(next, at);
      db.upsert(t.table, { ...row, attempts, next_at: iso(at), lease_until: null, last_error });
    }
    return next;
  });
}

/**
 * Make every waiting row of `targetId` due now (after the receiver was fixed: Settings "Retry now"); with `revive`, dead
 * rows come back too. Returns how many rows changed.
 */
export function makeDue(t: OutboxTable, targetId: string, now: number, revive = false): number {
  const db = database();
  const at = iso(now);
  const deadClause = t.dead ? (revive ? '' : ' AND dead_at IS NULL') : '';
  const rows = db.all<OutboxRow>(`SELECT * FROM ${t.table} WHERE ${t.target} = ?${t.topic ? ' AND topic = ?' : ''}${deadClause} AND (next_at > ?${t.dead && revive ? ' OR dead_at IS NOT NULL' : ''})`, targetId, ...(t.topic ? [t.topic] : []), at);
  db.transaction(() => {
    for (const row of rows) db.upsert(t.table, { ...row, next_at: at, lease_until: null, ...(t.dead && { dead_at: revive ? null : row.dead_at ?? null }) });
  });
  return rows.length;
}

/** Delete the dead rows older than `olderThan` (ms since the epoch). Returns how many went. */
export function pruneDead(t: OutboxTable, olderThan: number): number {
  if (!t.dead) return 0;
  const db = database();
  const rows = db.all<OutboxRow>(`SELECT * FROM ${t.table} WHERE ${t.topic ? 'topic = ? AND ' : ''}dead_at IS NOT NULL AND dead_at < ?`, ...(t.topic ? [t.topic] : []), iso(olderThan));
  db.transaction(() => {
    for (const row of rows) db.delete(t.table, keyOf(t, row));
  });
  return rows.length;
}
