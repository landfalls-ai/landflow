/**
 * The audit tables (lib/server/db, migrations 900 and 1500): `audit_events` and the SIEM outbox `audit_outbox`. An
 * event, its link in the hash chain (./chain) and its outbox rows (one per enabled destination) are written in one
 * transaction, so an event that is stored is also chained and queued for every destination. Reads: filtered (a project
 * admin's reads limited to their projects, ./access), newest first, with an opaque cursor for the next page.
 */
import type { AuditDestinationScope, AuditEvent, AuditFilters, AuditOutcome, AuditPage, AuditValue } from '../../shared/audit';
import type { Database, SqlValue } from '../db';
import { parse } from '../db/rows';
import { auditDb, chainsAtInsert, kickSealer, linkEvent, pruneChain, pruneChainInPostgres } from './chain';

const database = auditDb;

/** Filters as the store applies them: `projectIds` limits a project admin's reads to their projects. */
export type StoreFilters = AuditFilters & { projectIds?: string[] };

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  category: string;
  outcome: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  api_key_id: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  project_id: string | null;
  summary: string;
  details: string | null;
  chain_seq?: number | null;
  prev_hash?: string | null;
  hash?: string | null;
}

export function toRow(event: AuditEvent): AuditRow {
  return {
    id: event.id,
    at: event.at,
    action: event.action,
    category: event.category,
    outcome: event.outcome,
    actor_type: event.actor.type,
    actor_id: event.actor.id ?? null,
    actor_name: event.actor.name ?? null,
    actor_email: event.actor.email ?? null,
    api_key_id: event.apiKeyId ?? null,
    ip: event.ip ?? null,
    user_agent: event.userAgent ?? null,
    request_id: event.requestId ?? null,
    method: event.method ?? null,
    route: event.route ?? null,
    status: event.status ?? null,
    target_type: event.target?.type ?? null,
    target_id: event.target?.id ?? null,
    target_name: event.target?.name ?? null,
    project_id: event.projectId ?? null,
    summary: event.summary,
    details: event.details && Object.keys(event.details).length ? JSON.stringify(event.details) : null,
  };
}

export function fromRow(row: AuditRow): AuditEvent {
  const details = parse<Record<string, AuditValue>>(row.details);
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    category: row.category,
    outcome: row.outcome as AuditOutcome,
    actor: {
      type: row.actor_type as AuditEvent['actor']['type'],
      ...(row.actor_id && { id: row.actor_id }),
      ...(row.actor_name && { name: row.actor_name }),
      ...(row.actor_email && { email: row.actor_email }),
    },
    ...(row.api_key_id && { apiKeyId: row.api_key_id }),
    ...(row.ip && { ip: row.ip }),
    ...(row.user_agent && { userAgent: row.user_agent }),
    ...(row.request_id && { requestId: row.request_id }),
    ...(row.method && { method: row.method }),
    ...(row.route && { route: row.route }),
    ...(row.status !== null && row.status !== undefined && { status: Number(row.status) }),
    ...(row.target_type && { target: { type: row.target_type, ...(row.target_id && { id: row.target_id }), ...(row.target_name && { name: row.target_name }) } }),
    ...(row.project_id && { projectId: row.project_id }),
    summary: row.summary,
    ...(details && { details }),
    ...(row.chain_seq !== null && row.chain_seq !== undefined && row.hash && { chain: { seq: Number(row.chain_seq), prevHash: String(row.prev_hash ?? ''), hash: row.hash } }),
  };
}

/** Whether a destination with this scope (absent: everything) receives an event of `projectId` (absent: an instance-wide event). */
export function inScope(scope: AuditDestinationScope | undefined, projectId: string | null | undefined): boolean {
  if (!scope) return true;
  return projectId ? scope.projectIds.includes(projectId) : scope.instance;
}

/** Destinations that receive an event of `projectId` (all of them when omitted): enabled ones whose scope takes it. */
export function enabledDestinationIds(db: Database = database(), projectId?: string | null): string[] {
  return db
    .all<{ id: string; data: string }>('SELECT id, data FROM audit_destinations WHERE enabled = 1')
    .filter((row) => projectId === undefined || inScope(parse<{ scope?: AuditDestinationScope }>(row.data)?.scope, projectId))
    .map((row) => row.id);
}

/**
 * Store an event, chain it (SQLite and Postgres with one host: in this transaction, whose write lock orders writers;
 * queue mode on Postgres: sealed shortly, ./chain) and queue it for every enabled destination, in one transaction.
 * Sets `event.chain` when it was chained here. Returns how many destinations it was queued for.
 */
export function insertEvent(event: AuditEvent, db: Database = database()): number {
  const destinations = enabledDestinationIds(db, event.projectId ?? null);
  const atInsert = chainsAtInsert(db);
  const row = db.atomic(() => {
    const stored = atInsert ? linkEvent(db, toRow(event)) : toRow(event);
    db.insertNew('audit_events', { ...stored });
    for (const destinationId of destinations) {
      db.insertNew('audit_outbox', { destination_id: destinationId, event_id: event.id, created_at: event.at, attempts: 0, next_at: event.at, lease_until: null, last_error: null });
    }
    return stored;
  });
  if (row.chain_seq) event.chain = { seq: Number(row.chain_seq), prevHash: String(row.prev_hash), hash: String(row.hash) };
  else kickSealer(db);
  return destinations.length;
}

export function getEvent(id: string): AuditEvent | undefined {
  const row = database().get<AuditRow>('SELECT * FROM audit_events WHERE id = ?', id);
  return row && fromRow(row);
}

export function getEvents(ids: string[]): AuditEvent[] {
  if (!ids.length) return [];
  return database()
    .all<AuditRow>(`SELECT * FROM audit_events WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids)
    .map(fromRow);
}

export const countEvents = () => Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events')?.n ?? 0);

/** `at|id` of the last event of a page, base64url. */
export const encodeCursor = (event: Pick<AuditEvent, 'at' | 'id'>) => Buffer.from(`${event.at}|${event.id}`).toString('base64url');

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return at && id ? { at, id } : undefined;
  } catch {
    return undefined;
  }
}

/** `%` and `_` are LIKE wildcards: escape them in user text. */
const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The WHERE clause and parameters for `filters`. */
function where(filters: StoreFilters, cursor?: { at: string; id: string }): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (filters.actor?.trim()) {
    const actor = filters.actor.trim();
    clauses.push(`(actor_id = ? OR LOWER(actor_name) LIKE ? ESCAPE '\\' OR LOWER(actor_email) LIKE ? ESCAPE '\\')`);
    params.push(actor, like(actor.toLowerCase()), like(actor.toLowerCase()));
  }
  const actions = (filters.action ?? []).map((a) => a.trim()).filter(Boolean);
  if (actions.length) {
    const parts: string[] = [];
    for (const action of actions) {
      if (action.endsWith('.*') || !action.includes('.')) {
        parts.push('category = ?');
        params.push(action.replace(/\.\*$/, ''));
      } else {
        parts.push('action = ?');
        params.push(action);
      }
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }
  if (filters.targetType?.trim()) {
    clauses.push('target_type = ?');
    params.push(filters.targetType.trim());
  }
  if (filters.targetId?.trim()) {
    clauses.push('target_id = ?');
    params.push(filters.targetId.trim());
  }
  if (filters.projectId?.trim()) {
    clauses.push('project_id = ?');
    params.push(filters.projectId.trim());
  }
  if (filters.projectIds) {
    // A project admin: only their projects' events (none at all when that is no project).
    clauses.push(filters.projectIds.length ? `project_id IN (${filters.projectIds.map(() => '?').join(', ')})` : '1 = 0');
    params.push(...filters.projectIds);
  }
  if (filters.outcome) {
    clauses.push('outcome = ?');
    params.push(filters.outcome);
  }
  if (filters.from) {
    clauses.push('at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('at <= ?');
    params.push(filters.to);
  }
  if (filters.q?.trim()) {
    const q = like(filters.q.trim().toLowerCase());
    clauses.push(`(LOWER(summary) LIKE ? ESCAPE '\\' OR LOWER(target_name) LIKE ? ESCAPE '\\' OR LOWER(target_id) LIKE ? ESCAPE '\\' OR LOWER(route) LIKE ? ESCAPE '\\')`);
    params.push(q, q, q, q);
  }
  if (cursor) {
    clauses.push('(at < ? OR (at = ? AND id < ?))');
    params.push(cursor.at, cursor.at, cursor.id);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** One page of events, newest first. */
export function queryEvents(filters: StoreFilters, options: { limit?: number; cursor?: string } = {}): AuditPage {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 10_000));
  const { sql, params } = where(filters, decodeCursor(options.cursor));
  const rows = database().all<AuditRow>(`SELECT * FROM audit_events ${sql} ORDER BY at DESC, id DESC LIMIT ?`, ...params, limit + 1);
  const events = rows.slice(0, limit).map(fromRow);
  return { events, ...(rows.length > limit && events.length && { nextCursor: encodeCursor(events[events.length - 1]) }) };
}

/**
 * Delete events older than `days`, keeping the hash chain verifiable (./chain `pruneChain`: from the oldest end, up to
 * the first event still within the retention or still waiting for a SIEM destination, with the last pruned event's
 * hash as the anchor). SQLite and Postgres with one host; `pruneEventsAsync` covers queue mode too. Returns how many went.
 */
export function pruneEvents(days: number, now = Date.now(), db: Database = database()): number {
  if (!(days > 0)) return 0;
  return pruneChain(db, new Date(now - days * 86_400_000).toISOString());
}

/** `pruneEvents` wherever it runs (queue mode on Postgres decides it in Postgres, under the chain's lock). */
export async function pruneEventsAsync(days: number, now = Date.now(), db: Database = database()): Promise<number> {
  if (!(days > 0)) return 0;
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  return chainsAtInsert(db) ? pruneChain(db, cutoff) : pruneChainInPostgres(db, cutoff);
}
