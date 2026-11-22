/**
 * C22: which process syncs a source. The claim is a lease on the source's own state row (`knowledge_source_state`), apart from the
 * source row so that an admin's edit (a pause, a schedule) never frees or overwrites a running sync. SQLite: one synchronous
 * transaction. Postgres: a conditional UPDATE decided there (two mains can race), then this process's copy follows
 * (as the approval inbox's claim does). The runner renews the lease while it works; a lease that runs out means the process stopped.
 */
import { database, type Database } from '../db';

/** A lease lasts this long unless renewed (the runner renews about every 30 seconds). */
export const LEASE_MS = 2 * 60_000;

export interface StateRow {
  source_id: string;
  run_id: string | null;
  lease_until: string | null;
  next_at: string | null;
  last_run: string | null;
  updated_at: string;
}

const asRow = (row: StateRow) => row as unknown as Record<string, string | number | null>;
const iso = (ms: number) => new Date(ms).toISOString();

export function stateOf(sourceId: string, handle: Database = database()): StateRow | undefined {
  return handle.get<StateRow>('SELECT * FROM knowledge_source_state WHERE source_id = ?', sourceId);
}

const empty = (sourceId: string, now: number): StateRow => ({ source_id: sourceId, run_id: null, lease_until: null, next_at: null, last_run: null, updated_at: iso(now) });

/** Take what Postgres decided into this process's copy (read back with replication, else a copy-only write, never a queued stale row). */
async function adopt(handle: Database, row: StateRow): Promise<void> {
  if (await handle.refresh('knowledge_source_state', { source_id: row.source_id })) return;
  handle.upsertLocal('knowledge_source_state', asRow(row));
}

/** Send the key notice for a row changed through `direct` (a no-op without replication). */
async function tell(handle: Database, client: { query(text: string, values?: unknown[]): Promise<unknown> }, sourceId: string): Promise<void> {
  const payload = handle.keyNotice('knowledge_source_state', [sourceId]);
  if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
}

/** Make sure the state row exists in Postgres before a conditional update (insert-if-absent; a race is harmless). */
async function ensureRow(handle: Database, sourceId: string, now: number): Promise<void> {
  if (!stateOf(sourceId, handle)) handle.insertNew('knowledge_source_state', asRow(empty(sourceId, now)));
  await handle.flush();
}

/** Run one conditional UPDATE in Postgres and adopt the winner's row; `undefined` when no row matched. */
async function conditional(handle: Database, sql: string, values: unknown[], sourceId: string): Promise<StateRow | undefined> {
  const result = await handle.direct(async (client) => {
    const updated = await client.query<StateRow>(sql, values);
    if (updated.rows[0]) await tell(handle, client, sourceId);
    return updated;
  });
  const won = result?.rows[0];
  if (won) await adopt(handle, won);
  return won;
}

/** Take the source for `runId` unless another run holds an unexpired lease. Exactly one of two simultaneous callers wins. */
export async function claimSource(sourceId: string, runId: string, now: number, handle: Database = database()): Promise<boolean> {
  const until = iso(now + LEASE_MS);
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const row = stateOf(sourceId, handle) ?? empty(sourceId, now);
      if (row.run_id && row.lease_until && row.lease_until >= iso(now)) return false;
      handle.upsert('knowledge_source_state', asRow({ ...row, run_id: runId, lease_until: until, updated_at: iso(now) }));
      return true;
    });
  }
  await ensureRow(handle, sourceId, now);
  const won = await conditional(handle, 'UPDATE knowledge_source_state SET run_id = $1, lease_until = $2, updated_at = $3 WHERE source_id = $4 AND (run_id IS NULL OR lease_until < $5) RETURNING *', [runId, until, iso(now), sourceId, iso(now)], sourceId);
  return Boolean(won);
}

/** Push the holder's lease out; a run that no longer holds the claim changes nothing. */
export async function renewLease(sourceId: string, runId: string, now: number, handle: Database = database()): Promise<void> {
  if (handle.kind !== 'postgres') {
    handle.transaction(() => {
      const row = stateOf(sourceId, handle);
      if (row?.run_id === runId) handle.upsert('knowledge_source_state', asRow({ ...row, lease_until: iso(now + LEASE_MS), updated_at: iso(now) }));
    });
    return;
  }
  await conditional(handle, 'UPDATE knowledge_source_state SET lease_until = $1, updated_at = $2 WHERE source_id = $3 AND run_id = $4 RETURNING *', [iso(now + LEASE_MS), iso(now), sourceId, runId], sourceId);
}

/** End the holder's claim and say when the source is next due (`null`: not scheduled); a stale holder changes nothing. */
export async function releaseSource(sourceId: string, runId: string, nextAt: string | null, lastRun?: object, handle: Database = database()): Promise<void> {
  const now = Date.now();
  const summary = lastRun ? JSON.stringify(lastRun) : null;
  if (handle.kind !== 'postgres') {
    handle.transaction(() => {
      const row = stateOf(sourceId, handle);
      if (row?.run_id === runId) handle.upsert('knowledge_source_state', asRow({ ...row, run_id: null, lease_until: null, next_at: nextAt, last_run: summary ?? row.last_run, updated_at: iso(now) }));
    });
    return;
  }
  await conditional(handle, 'UPDATE knowledge_source_state SET run_id = NULL, lease_until = NULL, next_at = $1, last_run = COALESCE($2, last_run), updated_at = $3 WHERE source_id = $4 AND run_id = $5 RETURNING *', [nextAt, summary, iso(now), sourceId, runId], sourceId);
}

/** Set when a source is next due without touching a claim (a new source, a changed schedule). */
export async function setNextAt(sourceId: string, nextAt: string | null, handle: Database = database()): Promise<void> {
  const now = Date.now();
  if (handle.kind !== 'postgres') {
    handle.transaction(() => handle.upsert('knowledge_source_state', asRow({ ...(stateOf(sourceId, handle) ?? empty(sourceId, now)), next_at: nextAt, updated_at: iso(now) })));
    return;
  }
  await ensureRow(handle, sourceId, now);
  await conditional(handle, 'UPDATE knowledge_source_state SET next_at = $1, updated_at = $2 WHERE source_id = $3 RETURNING *', [nextAt, iso(now), sourceId], sourceId);
}

/** Free every claim whose lease ran out (its process stopped); returns each source and the run that held it, once. */
export async function freeExpired(now: number, handle: Database = database()): Promise<Array<{ sourceId: string; runId: string }>> {
  const freed: Array<{ sourceId: string; runId: string }> = [];
  const held = handle.all<StateRow>('SELECT * FROM knowledge_source_state WHERE run_id IS NOT NULL AND lease_until < ?', iso(now));
  for (const row of held) {
    const runId = row.run_id as string;
    if (handle.kind !== 'postgres') {
      const taken = handle.transaction(() => {
        const current = stateOf(row.source_id, handle);
        if (current?.run_id !== runId || !current.lease_until || current.lease_until >= iso(now)) return false;
        handle.upsert('knowledge_source_state', asRow({ ...current, run_id: null, lease_until: null, updated_at: iso(now) }));
        return true;
      });
      if (taken) freed.push({ sourceId: row.source_id, runId });
    } else if (await conditional(handle, 'UPDATE knowledge_source_state SET run_id = NULL, lease_until = NULL, updated_at = $1 WHERE source_id = $2 AND run_id = $3 AND lease_until < $4 RETURNING *', [iso(now), row.source_id, runId, iso(now)], row.source_id)) {
      freed.push({ sourceId: row.source_id, runId });
    }
  }
  return freed;
}

/** Every source's state row (the scheduler's one read). */
export const allStates = (handle: Database = database()): StateRow[] => handle.all<StateRow>('SELECT * FROM knowledge_source_state');
