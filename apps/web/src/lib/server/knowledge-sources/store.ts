/**
 * C22: the tables of knowledge sources: the source rows, what each item looked like at the last sync (its version marker), and the
 * sync history. Plain rows and keyset paging; no feature code (the claim is ./claim, the sync ./sync). Writes go through the
 * Database's write methods so Postgres mode can replay them; one transaction wherever several rows change together.
 */
import { randomUUID } from 'node:crypto';
import { EMPTY_COUNTS, SOURCE_LIMITS, type SyncCounts, type SyncRunView, type SyncStatus } from '../../shared/knowledge-sources';
import { decodeCursor, encodeCursor } from '../pagination';
import { database } from '../db';
import { HttpError } from '../errors';

export interface SourceRow {
  id: string;
  agent_id: string;
  tool_id: string;
  collection_key: string;
  kind: string;
  name: string;
  location: string;
  /** JSON. */
  settings: string;
  credential_id: string | null;
  schedule: string;
  paused: number;
  paused_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  source_id: string;
  item_key: string;
  version: string;
  name: string | null;
  size: number | null;
  /** A connector's own note on the item (the crawl keeps the page's links here, so a 304 still leads on). */
  extra: string | null;
  synced_at: string;
}

interface RunRow {
  id: string;
  source_id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  counts: string;
  errors: string | null;
  note: string | null;
}

/** The same place (collection, kind, location) added twice. */
export class DuplicateSourceError extends HttpError {
  static readonly errorName: string = 'DuplicateSourceError';
  constructor() {
    super('This knowledge base already has that source', 409);
  }
}

const db = () => database();
const asRow = (row: object) => row as Record<string, string | number | null>;

// ---- sources ------------------------------------------------------------------------------------------------

/**
 * Another source of the same place (collection, kind, location), if any. The index on those columns is not unique on purpose: in
 * Postgres mode a write is replayed later, so a unique violation there would never reach the caller (and would stall the replay);
 * this in-process check names the problem instead. Two processes adding the same place at the same moment could both succeed: that
 * leaves two sources doing the same sync, which wastes work and harms nothing.
 */
export const findDuplicate = (collectionKey: string, kind: string, location: string, exceptId?: string): SourceRow | undefined =>
  db().get<SourceRow>('SELECT * FROM knowledge_sources WHERE collection_key = ? AND kind = ? AND location = ? AND id <> ?', collectionKey, kind, location, exceptId ?? '');

export function insertSource(row: SourceRow): void {
  if (findDuplicate(row.collection_key, row.kind, row.location)) throw new DuplicateSourceError();
  db().upsert('knowledge_sources', asRow(row));
}

export const getSource = (id: string): SourceRow | undefined => db().get<SourceRow>('SELECT * FROM knowledge_sources WHERE id = ?', id);

export const listSourceRows = (agentId: string, toolId: string): SourceRow[] => db().all<SourceRow>('SELECT * FROM knowledge_sources WHERE agent_id = ? AND tool_id = ? ORDER BY created_at, id', agentId, toolId);

/** Every source, for the scheduler (bounded: at most 20 per base). */
export const allSourceRows = (): SourceRow[] => db().all<SourceRow>('SELECT * FROM knowledge_sources ORDER BY created_at, id');

export const countSources = (agentId: string, toolId: string): number => db().get<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_sources WHERE agent_id = ? AND tool_id = ?', agentId, toolId)?.n ?? 0;

/** Change columns of one source row (never its state: a lease lives in its own row). */
export function updateSourceRow(id: string, patch: Partial<Omit<SourceRow, 'id'>>): SourceRow | undefined {
  const row = getSource(id);
  if (!row) return undefined;
  const next = { ...row, ...patch, updated_at: new Date().toISOString() };
  db().upsert('knowledge_sources', asRow(next));
  return next;
}

/** A source, its state, items and runs, in one transaction. */
export function deleteSource(id: string): void {
  db().transaction(() => {
    db().delete('knowledge_sources', { id });
    db().delete('knowledge_source_state', { source_id: id });
    db().delete('knowledge_source_items', { source_id: id });
    db().delete('knowledge_sync_runs', { source_id: id });
  });
}

// ---- items ----------------------------------------------------------------------------------------------------

export function itemsOf(sourceId: string): Map<string, ItemRow> {
  return new Map(db().all<ItemRow>('SELECT * FROM knowledge_source_items WHERE source_id = ?', sourceId).map((row) => [row.item_key, row]));
}
export const putItem = (row: ItemRow): void => db().upsert('knowledge_source_items', asRow(row));
export const deleteItem = (sourceId: string, key: string): void => void db().delete('knowledge_source_items', { source_id: sourceId, item_key: key });

// ---- runs -----------------------------------------------------------------------------------------------------

const parse = <T>(text: string | null, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function viewOfRun(row: RunRow): SyncRunView {
  return {
    id: row.id,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    startedAt: row.started_at,
    ...(row.finished_at && { finishedAt: row.finished_at }),
    status: row.status as SyncStatus,
    counts: { ...EMPTY_COUNTS, ...parse<Partial<SyncCounts>>(row.counts, {}) },
    errors: parse<SyncRunView['errors']>(row.errors, []),
    ...(row.note && { note: row.note }),
  };
}

/** Start a run record (`running`). `id` lets the caller name it before it is written (a claim is taken on the same id). */
export function insertRun(sourceId: string, trigger: 'schedule' | 'manual', at: Date, id: string = randomUUID()): SyncRunView {
  const row: RunRow = { id, source_id: sourceId, trigger, started_at: at.toISOString(), finished_at: null, status: 'running', counts: JSON.stringify(EMPTY_COUNTS), errors: null, note: null };
  db().upsert('knowledge_sync_runs', asRow(row));
  return viewOfRun(row);
}

export const getRun = (id: string): RunRow | undefined => db().get<RunRow>('SELECT * FROM knowledge_sync_runs WHERE id = ?', id);

/** Close a run: its status, counts, at most 50 errors and a note. */
export function finishRun(id: string, result: { status: Exclude<SyncStatus, 'running'>; counts: SyncCounts; errors?: SyncRunView['errors']; note?: string; at?: Date }): void {
  const row = getRun(id);
  if (!row) return;
  db().upsert(
    'knowledge_sync_runs',
    asRow({ ...row, finished_at: (result.at ?? new Date()).toISOString(), status: result.status, counts: JSON.stringify(result.counts), errors: JSON.stringify((result.errors ?? []).slice(0, SOURCE_LIMITS.errorsKept)), note: result.note ?? null }),
  );
}

/** The runs of a source, newest first, by keyset `(started_at, id)`; `limit` at most 50. */
export function listRuns(sourceId: string, page: { limit?: number; cursor?: string } = {}): { runs: SyncRunView[]; next?: string } {
  const limit = Math.min(50, Math.max(1, Math.floor(page.limit ?? 20)));
  const at = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = at
    ? db().all<RunRow>('SELECT * FROM knowledge_sync_runs WHERE source_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?', sourceId, at.s, at.s, at.i, limit + 1)
    : db().all<RunRow>('SELECT * FROM knowledge_sync_runs WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', sourceId, limit + 1);
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { runs: shown.map(viewOfRun), ...(rows.length > limit && last && { next: encodeCursor({ s: last.started_at, i: last.id }) }) };
}

/** Keep the newest `SOURCE_LIMITS.runsKept` runs of a source. */
export function pruneRuns(sourceId: string): void {
  const kept = db().all<{ started_at: string; id: string }>('SELECT started_at, id FROM knowledge_sync_runs WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET ?', sourceId, SOURCE_LIMITS.runsKept - 1)[0];
  if (!kept) return;
  const old = db().all<{ id: string }>('SELECT id FROM knowledge_sync_runs WHERE source_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))', sourceId, kept.started_at, kept.started_at, kept.id);
  if (old.length) db().transaction(() => old.forEach((row) => db().delete('knowledge_sync_runs', { id: row.id })));
}
