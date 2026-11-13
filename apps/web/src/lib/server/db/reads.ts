/**
 * The read seam for run data: the reads of `executions.data` (a run's full record, run data included) and
 * `execution_events` (the Run Trace journal) that code serving finished runs goes through, all async. In SQLite mode each
 * function is the synchronous read in a resolved promise. In Postgres mode the in-memory copy holds the data and the
 * journal of hot runs only (./hot-mirror), so a cold run's data is one query to Postgres, and a scan over run data or the
 * journal (an EXISTS on events, a LIKE on data) runs on Postgres after the write queue has drained, because the copy
 * would miss the cold rows. Writers and the runner, which touch runs in flight, keep the synchronous store API.
 */
import { logger } from '../telemetry/logger';
import { database } from './index';
import { isCold, keepHot } from './hot-mirror';
import type { Database, SqlValue } from './database';

/** How long a scan waits for this process's queued writes to reach Postgres before it falls back to the copy. */
const BARRIER_MS = 2_000;

const remote = (db: Database) => db.kind === 'postgres';

/** The saved record (JSON text) of an execution, or undefined. */
export async function readExecutionData(id: string): Promise<string | undefined> {
  const db = database();
  const row = db.get<{ data: string }>('SELECT data FROM executions WHERE id = ?', id);
  if (!row || row.data || !remote(db)) return row?.data;
  // Cold: the copy keeps the row without its data. Nothing of this run is queued for Postgres (eviction waits for that).
  const result = await db.direct((client) => client.query<{ data: string }>('SELECT data FROM executions WHERE id = $1', [id]));
  return result?.rows[0]?.data;
}

/** The journal rows (JSON text of each event) of an execution after `afterSeq`, in order. */
export async function readExecutionEvents(id: string, afterSeq: number, limit: number): Promise<string[]> {
  const db = database();
  const after = Math.max(0, Math.floor(afterSeq));
  const max = Math.max(1, Math.floor(limit));
  if (isCold(db, id)) {
    const result = await db.direct((client) => client.query<{ data: string }>('SELECT data FROM execution_events WHERE execution_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [id, after, max]));
    return (result?.rows ?? []).map((row) => row.data);
  }
  return db.all<{ data: string }>('SELECT data FROM execution_events WHERE execution_id = ? AND seq > ? ORDER BY seq LIMIT ?', id, after, max).map((row) => row.data);
}

/** `?` placeholders as `$1, $2, …` (outside string literals), for the SQL the copy runs as is. */
export function postgresPlaceholders(sql: string): string {
  let n = 0;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && (sql[j] !== "'" || sql[j + 1] === "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j;
    } else out += c === '?' ? `$${++n}` : c;
  }
  return out;
}

/**
 * A scan over run data or the journal (an EXISTS on events, a LIKE on data): the rows the SQL selects. In Postgres mode
 * it runs on Postgres once the queued writes are there (so it sees what the copy holds and what it lacks); when they
 * don't arrive in time, or Postgres fails, it runs on the copy, which misses cold runs' data and events.
 */
export async function readRows<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]> {
  const db = database();
  if (remote(db)) {
    try {
      if (await db.barrier(BARRIER_MS)) {
        const result = await db.direct((client) => client.query<T>(postgresPlaceholders(sql), params));
        if (result) return result.rows;
      } else logger.warn('run scan: the write queue did not drain in time; scanning the in-memory copy (cold runs are missing)');
    } catch (error) {
      logger.warn('run scan: Postgres failed; scanning the in-memory copy (cold runs are missing)', { error });
    }
  }
  return db.all<T>(sql, ...params);
}

/**
 * Make a run writable (Postgres mode): load a cold run's data and journal back into the copy and keep them there for
 * the hot window, so a writer that appends to its journal numbers the events from what is stored. Nothing to do for a hot
 * run or on SQLite.
 */
export async function promoteExecution(id: string): Promise<void> {
  const db = database();
  if (!remote(db)) return;
  // A run unknown to the copy is nothing to hold (and a made-up id must not grow the promotions).
  if (!db.get('SELECT 1 AS x FROM executions WHERE id = ?', id)) return;
  // Even a run still hot is held for the full window: it may be about to cool, and a caller reads it after an await.
  if (!isCold(db, id)) return keepHot(db, id);
  const loaded = await db.direct(async (client) => ({
    run: (await client.query<{ data: string }>('SELECT data FROM executions WHERE id = $1', [id])).rows[0],
    events: (await client.query<Record<string, SqlValue>>('SELECT * FROM execution_events WHERE execution_id = $1 ORDER BY seq', [id])).rows,
  }));
  if (!loaded?.run) return;
  db.hydrateLocal(id, loaded.run.data, loaded.events);
  keepHot(db, id);
}
