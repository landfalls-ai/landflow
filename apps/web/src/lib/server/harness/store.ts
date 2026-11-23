/**
 * The record of harness sessions (tables `harness_sessions` and `harness_events`, migration 2914; docs/harnesses.md#live-status).
 * A session's status is in the database, not process memory, so any main takes any event. The order rule is a conditional
 * write on the session row (SQLite: inside the IMMEDIATE transaction; Postgres: `UPDATE … WHERE last_order IS NOT DISTINCT
 * FROM <what was read>` through `db.direct`, retried, then this main's copy, as approval-inbox/store.ts does), so two mains
 * cannot both apply a stale event or lose each other's counts.
 *
 * Plain server module (no Next.js import): workers load it.
 */
import { randomUUID } from 'node:crypto';
import type { HarnessStatus, StatusVerdict } from '@landflow/protocol/harnesses';
import type { HarnessSessionView } from '../../shared/harness';
import type { BlockedKind } from '../../shared/quota-block';
import { database, type Database } from '../db';
import { decodeCursor, encodeCursor, type Cursor } from '../pagination';
import { logger } from '../telemetry/logger';
import { CLOSE_AFTER_MS, STALE_AFTER_MS, isNewer, nextStatus, readStatus, type OrderKey } from './status';

export interface SessionRow {
  id: string;
  owner_id: string;
  harness: string;
  session_key: string;
  agent_id: string | null;
  project_id: string | null;
  status: HarnessStatus;
  order_kind: string | null;
  last_order: string | null;
  last_event_at: string;
  opened_at: string;
  closed_at: string | null;
  data: string;
}

export interface EventRow {
  id: string;
  session_id: string;
  order_key: string;
  name: string;
  received_at: string;
  data: string;
}

/** What the `data` column of a session holds. */
export interface SessionData {
  prompts: number;
  toolCalls: number;
  /** Events applied (newer than the last): past `MAX_EVENTS_PER_SESSION` an event keeps only its name. */
  events: number;
  /** `owner/name`, only when the sender gave it. */
  repository?: string;
  /** When the status last changed. */
  changedAt: string;
  /** The sweep already told the live stream this session went stale. */
  staleSent?: boolean;
  /** While Blocked: why (a provider limit's kind) and since when. Cleared when the status leaves Blocked. */
  blockedKind?: BlockedKind;
  blockedSince?: string;
}

export interface EventInput {
  ownerId: string;
  harness: string;
  sessionKey: string;
  /** Binds a new session to this agent. Ignored for a session that already exists: the stored row decides. */
  agentId?: string;
  name: string;
  orderKey: OrderKey;
  receivedAt: string;
  /** What the registry says the event does (`undefined`: it lists no such name). */
  verdict: StatusVerdict | undefined;
  /**
   * What may be stored of the event, chosen after the row is resolved: `bound` is whether the session the event landed in
   * belongs to an agent (privacy.ts: an own session keeps no content, whoever raced to create it).
   */
  viewFor: (bound: boolean) => Record<string, unknown>;
  /** The kind of limit that blocked it, when the event is a quota signal. */
  blocked?: BlockedKind;
  prompt: boolean;
  tool: boolean;
  repository?: string;
}

export interface Applied {
  session: SessionRow;
  eventId: string;
  created: boolean;
  /** The event was newer than the last applied one (it counted and may have moved the status). */
  applied: boolean;
  /** The status is not what it was. */
  changed: boolean;
  /** The session had gone quiet for 30 minutes or more before this event (it reads as stale until now). */
  woke: boolean;
  /** What was stored of the event (the mirror reads it). */
  view: Record<string, unknown>;
}

/** Past this many applied events a session stores only the event names; the status and counts still move. */
export const MAX_EVENTS_PER_SESSION = 5000;
/** The mirror and its rebuild read at most this many of the newest events. */
export const MIRROR_TAIL = 500;

const db = (): Database => database();
const asRow = (row: SessionRow) => row as unknown as Record<string, string | number | null>;
const parse = (text: string): SessionData => {
  try {
    const value = JSON.parse(text) as Partial<SessionData>;
    return { prompts: Number(value.prompts ?? 0), events: Number(value.events ?? 0), toolCalls: Number(value.toolCalls ?? 0), changedAt: value.changedAt ?? '', ...(value.repository && { repository: value.repository }), ...(value.staleSent && { staleSent: true }), ...(value.blockedKind && { blockedKind: value.blockedKind }), ...(value.blockedSince && { blockedSince: value.blockedSince }) };
  } catch {
    return { prompts: 0, toolCalls: 0, events: 0, changedAt: '' };
  }
};

const byKey = (handle: Database, input: { ownerId: string; harness: string; sessionKey: string }) =>
  handle.get<SessionRow>('SELECT * FROM harness_sessions WHERE owner_id = ? AND harness = ? AND session_key = ?', input.ownerId, input.harness, input.sessionKey);
export const sessionRow = (id: string): SessionRow | undefined => db().get<SessionRow>('SELECT * FROM harness_sessions WHERE id = ?', id);

/** The row an event leaves behind (pure): a new session, or `before` with the event applied when it is newer. */
function decide(before: SessionRow | undefined, input: EventInput): { next: SessionRow; applied: boolean } {
  const base: SessionRow = before ?? {
    id: `hs_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    owner_id: input.ownerId,
    harness: input.harness,
    session_key: input.sessionKey,
    agent_id: input.agentId ?? null,
    project_id: null,
    status: 'idle',
    order_kind: null,
    last_order: null,
    last_event_at: input.receivedAt,
    opened_at: input.receivedAt,
    closed_at: null,
    data: JSON.stringify({ prompts: 0, toolCalls: 0, events: 0, changedAt: input.receivedAt } satisfies SessionData),
  };
  const newer = isNewer({ orderKind: base.order_kind, lastOrder: base.last_order }, input.orderKey);
  if (!newer) return { next: base, applied: false };
  const data = parse(base.data);
  const status = nextStatus(base.status, input.verdict, input.name, true);
  const next: SessionData = {
    prompts: data.prompts + (input.prompt ? 1 : 0),
    toolCalls: data.toolCalls + (input.tool ? 1 : 0),
    events: data.events + 1,
    changedAt: status !== base.status || !before ? input.receivedAt : data.changedAt || input.receivedAt,
    ...((input.repository ?? data.repository) && { repository: input.repository ?? data.repository }),
    // Blocked keeps its kind and the time it began; leaving Blocked drops both.
    ...(status === 'blocked' && { blockedKind: input.blocked ?? data.blockedKind ?? 'unknown', blockedSince: base.status === 'blocked' && data.blockedSince ? data.blockedSince : input.receivedAt }),
  };
  return {
    applied: true,
    next: {
      ...base,
      status,
      order_kind: base.order_kind ?? input.orderKey.kind,
      last_order: input.orderKey.value,
      last_event_at: input.receivedAt,
      closed_at: status === 'ended' ? input.receivedAt : null,
      data: JSON.stringify(next),
    },
  };
}

/** Tell Postgres' other mains a row changed under `direct` (a no-op without replication). */
async function tell(handle: Database, client: { query(text: string, values?: unknown[]): Promise<unknown> }, table: 'harness_sessions', id: string): Promise<void> {
  const payload = handle.keyNotice(table, [id]);
  if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
}

/** This main's copy of a row Postgres already holds. */
async function adopt(handle: Database, row: SessionRow): Promise<void> {
  if (await handle.refresh('harness_sessions', { id: row.id })) return;
  handle.upsertLocal('harness_sessions', asRow(row));
}

/**
 * Replace `before` with `next` only if nobody changed the row since it was read (`before` undefined: only if it does not exist).
 * Undefined when another writer got in first; the caller reads again.
 */
async function swap(handle: Database, before: SessionRow | undefined, next: SessionRow): Promise<SessionRow | undefined> {
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const current = handle.get<SessionRow>('SELECT * FROM harness_sessions WHERE id = ?', next.id) ?? (before ? undefined : byKey(handle, { ownerId: next.owner_id, harness: next.harness, sessionKey: next.session_key }));
      const same = before ? current && current.last_order === before.last_order && current.data === before.data && current.status === before.status && current.closed_at === before.closed_at : !current;
      if (!same) return undefined;
      handle.upsert('harness_sessions', asRow(next));
      return next;
    });
  }
  await handle.flush();
  const written = await handle.direct(async (client) => {
    const result = before
      ? await client.query<SessionRow>(
          'UPDATE harness_sessions SET status = $1, order_kind = $2, last_order = $3, last_event_at = $4, closed_at = $5, data = $6 WHERE id = $7 AND last_order IS NOT DISTINCT FROM $8 AND data = $9 AND status = $10 AND closed_at IS NOT DISTINCT FROM $11 RETURNING *',
          [next.status, next.order_kind, next.last_order, next.last_event_at, next.closed_at, next.data, next.id, before.last_order, before.data, before.status, before.closed_at],
        )
      : await client.query<SessionRow>(
          'INSERT INTO harness_sessions (id, owner_id, harness, session_key, agent_id, project_id, status, order_kind, last_order, last_event_at, opened_at, closed_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING *',
          [next.id, next.owner_id, next.harness, next.session_key, next.agent_id, next.project_id, next.status, next.order_kind, next.last_order, next.last_event_at, next.opened_at, next.closed_at, next.data],
        );
    if (result.rows[0]) await tell(handle, client, 'harness_sessions', next.id);
    return result;
  });
  const row = written?.rows[0];
  if (!row) return undefined;
  await adopt(handle, row);
  return row;
}

/** The row to start from: Postgres is read where the truth is, SQLite from the file. */
async function readCurrent(handle: Database, input: { ownerId: string; harness: string; sessionKey: string }): Promise<SessionRow | undefined> {
  if (handle.kind !== 'postgres') return byKey(handle, input);
  const result = await handle.direct((client) => client.query<SessionRow>('SELECT * FROM harness_sessions WHERE owner_id = $1 AND harness = $2 AND session_key = $3', [input.ownerId, input.harness, input.sessionKey]));
  return result?.rows[0] ?? byKey(handle, input);
}

/**
 * Store an event and apply it to its session. An event older than the session's last applied one is stored in its own place
 * (the mirror lists it in order) but changes neither status nor counts. `handle` is for tests (two processes' databases).
 */
export async function applyEvent(input: EventInput, handle: Database = db()): Promise<Applied> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = await readCurrent(handle, input);
    const { next, applied } = decide(before, input);
    let session: SessionRow | undefined = before;
    // An event that is not newer leaves the row alone: nothing to swap.
    if (applied || !before) {
      session = await swap(handle, before, next);
      if (!session) continue;
    }
    const eventId = `he_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    // The view follows the row that won, not a read made before the write (two first events can race to create it).
    // A late event counts toward the cap too (its row is not rewritten, so the stored events are counted): past it, only the name.
    const over = applied ? parse(session!.data).events > MAX_EVENTS_PER_SESSION : eventCount(handle, session!.id) >= MAX_EVENTS_PER_SESSION;
    const view = over ? { event: input.name } : input.viewFor(Boolean(session!.agent_id));
    handle.insertNew('harness_events', { id: eventId, session_id: session!.id, order_key: input.orderKey.value, name: input.name, received_at: input.receivedAt, data: JSON.stringify(view) });
    const woke = Boolean(before) && Date.parse(input.receivedAt) - Date.parse(before!.last_event_at) >= STALE_AFTER_MS;
    return { session: session!, eventId, created: !before, applied, changed: !before || session!.status !== before.status, woke, view };
  }
  throw new Error('harness session kept changing');
}

/** A viewer's look at a row (stale reads as idle). */
export function viewOf(row: SessionRow, now = Date.now()): HarnessSessionView {
  const data = parse(row.data);
  const read = readStatus({ status: row.status, lastEventAt: row.last_event_at, closedAt: row.closed_at }, now);
  return {
    id: row.id,
    harness: row.harness,
    status: read.status,
    stale: read.stale,
    changedAt: data.changedAt || row.opened_at,
    lastEventAt: row.last_event_at,
    openedAt: row.opened_at,
    ...(row.closed_at && { closedAt: row.closed_at }),
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(data.repository && { repository: data.repository }),
    ...(read.status === 'blocked' && data.blockedKind && { blockedKind: data.blockedKind, ...(data.blockedSince && { blockedSince: data.blockedSince }) }),
    prompts: data.prompts,
    toolCalls: data.toolCalls,
  };
}

export interface ListFilter {
  /** The viewer: own sessions (no agent) are theirs alone. */
  userId: string;
  /** Agents the viewer may read: undefined means every agent (an admin). */
  readableAgents: ReadonlySet<string> | undefined;
  agentId?: string;
  open?: boolean;
  /** `own`: the viewer's own sessions only; `agent`: sessions of Landflow agents only (filtered in SQL, so a page is never short). */
  kind?: 'own' | 'agent';
  limit: number;
  cursor?: string;
}

/** Newest first by last event (ties by id), keyset-paged. Visibility is part of the SQL: own sessions, plus agent sessions of readable agents. */
export function listSessions(filter: ListFilter): { rows: SessionRow[]; nextCursor?: string } {
  const where: string[] = [];
  const args: Array<string | number> = [];
  const agents = filter.readableAgents ? [...filter.readableAgents] : undefined;
  if (filter.kind === 'own') {
    if (filter.agentId) return { rows: [] };
    where.push('(agent_id IS NULL AND owner_id = ?)');
    args.push(filter.userId);
  } else if (filter.agentId) {
    if (agents && !agents.includes(filter.agentId)) return { rows: [] };
    where.push('agent_id = ?');
    args.push(filter.agentId);
  } else if (filter.kind === 'agent') {
    if (agents) {
      if (!agents.length) return { rows: [] };
      where.push(`agent_id IN (${agents.map(() => '?').join(',')})`);
      args.push(...agents);
    } else where.push('agent_id IS NOT NULL');
  } else if (agents) {
    // Chunked IN lists are not needed: one clause, bounded by the agents the viewer may read.
    where.push(`((agent_id IS NULL AND owner_id = ?)${agents.length ? ` OR agent_id IN (${agents.map(() => '?').join(',')})` : ''})`);
    args.push(filter.userId, ...agents);
  } else {
    where.push('(agent_id IS NOT NULL OR owner_id = ?)');
    args.push(filter.userId);
  }
  if (filter.open) where.push('closed_at IS NULL');
  const after: Cursor | undefined = filter.cursor ? decodeCursor(filter.cursor) : undefined;
  if (after) {
    where.push('(last_event_at < ? OR (last_event_at = ? AND id < ?))');
    args.push(after.s, after.s, after.i);
  }
  const rows = db().all<SessionRow>(`SELECT * FROM harness_sessions WHERE ${where.join(' AND ')} ORDER BY last_event_at DESC, id DESC LIMIT ?`, ...args, filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  return { rows: page, ...(rows.length > filter.limit && last && { nextCursor: encodeCursor({ s: last.last_event_at, i: last.id }) }) };
}

/** How many events are stored for a session. */
const eventCount = (handle: Database, sessionId: string): number => Number(handle.get<{ n: number }>('SELECT COUNT(*) AS n FROM harness_events WHERE session_id = ?', sessionId)?.n ?? 0);

/** The order key of the oldest event the mirror still shows (the `tail`-th newest), or undefined when fewer are stored. */
export function tailStartKey(sessionId: string, tail: number): string | undefined {
  return db().get<{ order_key: string }>('SELECT order_key FROM harness_events WHERE session_id = ? ORDER BY order_key DESC, received_at DESC, id DESC LIMIT 1 OFFSET ?', sessionId, tail - 1)?.order_key;
}

/** The events of one session in order-key order (a late event sits in its own place). */
export function eventsOf(sessionId: string, tail?: number): Array<{ id: string; orderKey: string; name: string; receivedAt: string; data: Record<string, unknown> }> {
  // `tail`: only the newest N (by order key), still returned oldest first.
  const rows = tail
    ? db().all<EventRow>('SELECT * FROM harness_events WHERE session_id = ? ORDER BY order_key DESC, received_at DESC, id DESC LIMIT ?', sessionId, tail).reverse()
    : db().all<EventRow>('SELECT * FROM harness_events WHERE session_id = ? ORDER BY order_key, received_at, id', sessionId);
  return rows
    .map((row) => ({ id: row.id, orderKey: row.order_key, name: row.name, receivedAt: row.received_at, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/**
 * Upkeep (hourly, leader): a session quiet for 30 minutes is told to the live stream as stale once; one quiet for 24 hours is
 * closed (status `ended`). Returns the rows that changed, for the caller to publish.
 */
export async function sweep(now = Date.now(), handle: Database = db()): Promise<SessionRow[]> {
  const changed: SessionRow[] = [];
  const at = new Date(now).toISOString();
  // Close first, oldest first (a pile of stale rows must not starve the 24-hour close); then the stale ones not yet told.
  const old = handle.all<SessionRow>('SELECT * FROM harness_sessions WHERE closed_at IS NULL AND last_event_at < ? ORDER BY last_event_at ASC LIMIT 500', new Date(now - CLOSE_AFTER_MS).toISOString());
  const quiet = handle.all<SessionRow>(
    `SELECT * FROM harness_sessions WHERE closed_at IS NULL AND last_event_at < ? AND last_event_at >= ? AND status NOT IN ('error', 'blocked') AND data NOT LIKE '%"staleSent":true%' ORDER BY last_event_at ASC LIMIT 500`,
    new Date(now - STALE_AFTER_MS).toISOString(),
    new Date(now - CLOSE_AFTER_MS).toISOString(),
  );
  for (const row of [...old, ...quiet]) {
    const data = parse(row.data);
    const closing = now - Date.parse(row.last_event_at) >= CLOSE_AFTER_MS;
    const next: SessionRow = closing
      ? { ...row, status: 'ended', closed_at: at, data: JSON.stringify({ ...data, changedAt: at }) }
      : { ...row, data: JSON.stringify({ ...data, staleSent: true }) };
    const saved = await swap(handle, row, next);
    if (saved) changed.push(saved);
  }
  return changed;
}

/** Daily: events and closed sessions older than `days` (14) go. Returns the events removed. */
export function prune(now = Date.now(), days = 14): number {
  const before = new Date(now - days * 86_400_000).toISOString();
  const handle = db();
  const events = handle.deleteBefore('harness_events', 'received_at', before);
  for (const row of handle.all<{ id: string }>('SELECT id FROM harness_sessions WHERE closed_at IS NOT NULL AND closed_at < ?', before)) handle.delete('harness_sessions', { id: row.id });
  if (events) logger.info('pruned harness events', { 'landflow.harness.pruned': events });
  return events;
}

/** Open sessions of an owner, for the cap in limits.ts. */
export const openCount = (ownerId: string): number => Number(db().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM harness_sessions WHERE owner_id = ? AND closed_at IS NULL', ownerId)?.n ?? 0);
