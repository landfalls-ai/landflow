/**
 * Postgres mode keeps only the hot part of the run history in the in-memory copy (docs/architecture.md, Storage).
 *
 * An execution is hot while it is in flight (running, waiting, queued), finished within LANDFLOW_PG_HOT_MINUTES, has an
 * automatic retry waiting for it, or is a child of an execution still in flight (its parent reads it when it wakes). A
 * hot execution keeps its row, its `data` and its `execution_events` in the copy. A cold one keeps its row with `data`
 * set to '' (every other column, the summary included, is what lists and filters read) and no events in the copy; the
 * async read seam (./reads) fetches what it lacks from Postgres. Boot loads only the hot part, a timer evicts what
 * cooled down (`Database.evictLocal`, which bypasses the sink: nothing is sent to Postgres), and `promoteExecution`
 * loads a cold run back for a writer that must append to its journal.
 */
import { envNumber } from '../config';
import { logger } from '../telemetry/logger';
import { singleton } from '../singleton';
import type { Database, SqlValue } from './database';

/** Statuses of a run still going (also kept hot while a person acts on it). */
const IN_FLIGHT_SQL = "('running', 'waiting', 'queued')";
/** How often each process evicts what cooled down. */
export const EVICT_INTERVAL_MS = 60_000;
const EVICT_CHUNK = 500;

/** Minutes a finished run stays hot (LANDFLOW_PG_HOT_MINUTES, default 15). */
export const hotMinutes = () => envNumber('LANDFLOW_PG_HOT_MINUTES', { fallback: 15, min: 1 });

export const hotCutoff = (now = Date.now(), minutes = hotMinutes()) => new Date(now - minutes * 60_000).toISOString();

/** The condition "this execution is hot" on table alias `alias`, with one placeholder (the cutoff) written by `placeholder`. */
export function hotCondition(alias: string, placeholder: string): string {
  return `(${alias}.status IN ${IN_FLIGHT_SQL} OR COALESCE(${alias}.finished_at, ${alias}.started_at) >= ${placeholder} OR ${alias}.id IN (SELECT execution_id FROM retries) OR (${alias}.parent_id IS NOT NULL AND ${alias}.parent_id IN (SELECT p.id FROM executions p WHERE p.status IN ${IN_FLIGHT_SQL})))`;
}

/** The SQL that loads one table into the copy at boot (and reloads it in queue mode): `data` and events of cold runs left out. */
export function mirrorSelect(table: string, cutoff: string): { text: string; values: SqlValue[] } {
  if (table === 'executions') {
    return { text: `SELECT e.id, e.workflow_id, e.status, e.mode, e.started_at, e.finished_at, e.duration_ms, e.version_id, e.parent_id, e.retry_of, e.wait_until, e.evaluation_run_id, e.summary, CASE WHEN ${hotCondition('e', '$1')} THEN e.data ELSE '' END AS data FROM executions e`, values: [cutoff] };
  }
  if (table === 'execution_events') {
    return { text: `SELECT v.* FROM execution_events v JOIN executions e ON e.id = v.execution_id WHERE ${hotCondition('e', '$1')}`, values: [cutoff] };
  }
  return { text: `SELECT * FROM ${table}`, values: [] };
}

/** Executions whose data is in the copy but who went cold (and aren't promoted): ids, at most one chunk. */
function coolingIds(db: Database, cutoff: string, promoted: Map<string, number>, now: number): string[] {
  const rows = db.all<{ id: string }>(`SELECT e.id FROM executions e WHERE e.data <> '' AND NOT ${hotCondition('e', '?')} LIMIT ${EVICT_CHUNK}`, cutoff);
  return rows.map((row) => row.id).filter((id) => {
    const until = promoted.get(id);
    if (until === undefined) return true;
    if (until > now) return false;
    promoted.delete(id);
    return true;
  });
}

/** Promoted runs stay in the copy this long past the promotion (ms by id; Database.evictLocal and the evictor read it). */
// A singleton: a route's module graph and the evictor started at boot must see the same promotions.
const promotedUntil = singleton('hot-promotions', () => new WeakMap<Database, Map<string, number>>());
const promotions = (db: Database) => {
  let map = promotedUntil.get(db);
  if (!map) promotedUntil.set(db, (map = new Map()));
  return map;
};

/** Hold a run in the copy for the hot window from now (a loaded cold run). */
export function keepHot(db: Database, executionId: string, now = Date.now()) {
  promotions(db).set(executionId, now + hotMinutes() * 60_000);
}

/** Evict what cooled down. Returns how many executions left the copy. */
export function evictCold(db: Database, now = Date.now()): number {
  const promoted = promotions(db);
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const ids = coolingIds(db, hotCutoff(now), promoted, now);
    if (!ids.length) break;
    const gone = db.evictLocal(ids);
    total += gone.length;
    // Everything in the chunk was pending: the next minute's pass tries again.
    if (gone.length < ids.length || ids.length < EVICT_CHUNK) break;
  }
  return total;
}

/** Evict every minute; the returned function stops it. */
export function startEviction(db: Database): () => void {
  const timer = setInterval(() => {
    try {
      const n = evictCold(db);
      if (n) logger.debug('postgres store: evicted cold runs from the in-memory copy', { 'landflow.db.evicted': n });
    } catch (error) {
      logger.warn('postgres store: evicting cold runs failed', { error });
    }
  }, EVICT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Whether an execution's row is in the copy without its data and journal (cold). Always false on SQLite. */
export function isCold(db: Database, executionId: string): boolean {
  if (db.kind !== 'postgres') return false;
  return db.get<{ x: number }>("SELECT 1 AS x FROM executions WHERE id = ? AND data = ''", executionId) !== undefined;
}

/** Evict those of `ids` that are cold now (rows another process wrote, read back into the copy). */
export function evictCooling(db: Database, ids: string[], now = Date.now()) {
  if (!ids.length) return;
  const promoted = promotions(db);
  const cutoff = hotCutoff(now);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = db.all<{ id: string }>(`SELECT e.id FROM executions e WHERE e.id IN (${chunk.map(() => '?').join(', ')}) AND e.data <> '' AND NOT ${hotCondition('e', '?')}`, ...chunk, cutoff);
    const cold = rows.map((row) => row.id).filter((id) => (promoted.get(id) ?? 0) <= now);
    if (cold.length) db.evictLocal(cold);
  }
}
