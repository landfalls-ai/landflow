/**
 * The read seam for run data: the reads of `executions.data` (a run's full record, run data included) and
 * `execution_events` (the Run Trace journal) that code serving finished runs goes through, all async. In SQLite mode and
 * in Postgres mode today the tables sit in the in-process database, so each function is the synchronous read in a
 * resolved promise; serving them from Postgres on demand (instead of loading them into the mirror at boot) changes only
 * this file. Writers and the runner, which touch runs in flight, keep the synchronous store API.
 */
import { database } from './index';
import type { SqlValue } from './database';

/** The saved record (JSON text) of an execution, or undefined. */
export async function readExecutionData(id: string): Promise<string | undefined> {
  return database().get<{ data: string }>('SELECT data FROM executions WHERE id = ?', id)?.data;
}

/** The journal rows (JSON text of each event) of an execution after `afterSeq`, in order. */
export async function readExecutionEvents(id: string, afterSeq: number, limit: number): Promise<string[]> {
  return database()
    .all<{ data: string }>('SELECT data FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?', id, Math.max(0, Math.floor(afterSeq)), Math.max(1, Math.floor(limit)))
    .map((row) => row.data);
}

/** A scan over run data or the journal (an EXISTS on events, a LIKE on data): the rows the SQL selects. */
export async function readRows<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]> {
  return database().all<T>(sql, ...params);
}
