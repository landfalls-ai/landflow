/**
 * Tamper evidence for the audit log: a hash chain over `audit_events` (migration 1500). Each event stores its place in
 * the chain (`chain_seq`, 1, 2, 3…), the previous event's hash (`prev_hash`; 64 zeros for the first) and its own
 * (`hash`): SHA-256 over a canonical form of what is stored, a JSON array of a version tag, the sequence number, the
 * previous hash and every column in a fixed order (`details` as the JSON text it is stored as). Changing a stored field
 * changes the event's hash; deleting an event leaves a gap in the sequence and a `prev_hash` that matches nothing.
 * `audit_chain` keeps the chain's ends: `head` (the newest chained event, so dropping the newest events shows too) and
 * `anchor` (the last event retention pruned: the chain goes on from its hash, so pruning keeps it verifiable). Events
 * recorded before the migration stay unchained ("legacy"; the migration's time in `schema_version` is the line).
 *
 * Insert order, with several writers:
 * - SQLite, and Postgres with one host: the event is chained inside its insert transaction. `transaction` is BEGIN
 *   IMMEDIATE, the database's write lock held for the transaction, so processes sharing the file take turns: each reads
 *   the head and writes the next link before the next writer can.
 * - Postgres in queue mode, where each process writes to its in-memory copy and replays to Postgres later: events are
 *   stored unchained and sealed in Postgres itself, in transactions holding a transaction-level advisory lock
 *   (`pg_advisory_xact_lock`), so mains and workers never chain two events off the same head. Every process that runs
 *   the audit log seals (kicked after it records an event, and on a 5 s tick); the links reach every process's copy as a
 *   change notice (lib/server/db/replication.ts). Retention prunes there too, under the same lock.
 *
 * `verifyChain` walks the chain in order (straight from Postgres in Postgres mode, so changes made behind the hosts'
 * backs show) and says where it breaks. Retention prunes from the oldest end only (`pruneChain`): up to the first event
 * still within the retention or still waiting for a SIEM destination.
 */
import { createHash } from 'node:crypto';
import type { AuditChainProblem, AuditChainReport } from '../../shared/audit';
import { clusterConfig } from '../cluster/config';
import { database, migrateSqlite, type Database, type DirectClient, type SqlValue, type WriteOp } from '../db';
import { upsertSql } from '../db/database';
import { CHANGES_CHANNEL, noticesFor } from '../db/replication';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';

export const GENESIS = '0'.repeat(64);
const VERSION = 'landflow.audit/1';
/** The migration that added the chain: its `applied_at` separates legacy events from chained ones. */
const CHAIN_MIGRATION = 1500;
/** pg_advisory_xact_lock key for sealing and pruning ("LFAC"). */
export const CHAIN_LOCK = 0x4c464143;
/** Notices of the sealer carry this origin, which no process has, so every process (the sealer's too) applies them. */
const NOTICE_ORIGIN = 'audit-chain';
const SEAL_BATCH = 500;
const MAX_PROBLEMS = 20;

/** The columns the hash covers, in order (every stored field but the hash itself; the sequence and previous hash lead). */
export const CHAIN_FIELDS = [
  'id',
  'at',
  'action',
  'category',
  'outcome',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'api_key_id',
  'ip',
  'user_agent',
  'request_id',
  'method',
  'route',
  'status',
  'target_type',
  'target_id',
  'target_name',
  'project_id',
  'summary',
  'details',
] as const;

export type ChainRow = { [K in (typeof CHAIN_FIELDS)[number]]?: unknown } & { id: string; at: string; chain_seq?: unknown; prev_hash?: unknown; hash?: unknown };

/** The audit tables' database: on SQLite, a connection opened before migration 1500 (a hot-reloaded dev server) migrates first. */
export function auditDb(): Database {
  const db = database();
  const checked = singleton('audit-schema-checked', () => new WeakSet<Database>());
  if (!checked.has(db)) {
    if (db.kind === 'sqlite' && !db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_chain'`)) migrateSqlite(db.sqlite);
    checked.add(db);
  }
  return db;
}

/** The canonical form the hash is taken over (Postgres hands BIGINTs back as text: numbers are normalized). */
export function canonicalEvent(row: ChainRow, seq: number, prevHash: string): string {
  const values = CHAIN_FIELDS.map((field) => {
    const value = row[field];
    if (value === null || value === undefined) return null;
    return field === 'status' ? Number(value) : String(value);
  });
  return JSON.stringify([VERSION, seq, prevHash, ...values]);
}

export const eventHash = (row: ChainRow, seq: number, prevHash: string) => createHash('sha256').update(canonicalEvent(row, seq, prevHash)).digest('hex');

interface ChainEnd {
  id: string;
  seq: number;
  hash: string;
  event_id: string | null;
  at: string | null;
}

const endOf = (row: Record<string, unknown> | undefined): ChainEnd | undefined =>
  row ? { id: String(row.id), seq: Number(row.seq), hash: String(row.hash), event_id: (row.event_id as string | null) ?? null, at: (row.at as string | null) ?? null } : undefined;

const queueMode = () => clusterConfig().mode === 'queue';

/** Whether this database chains events as they are inserted (SQLite, Postgres with one host) or seals them in Postgres later (queue mode). */
export function chainsAtInsert(db: Database): boolean {
  return db.kind === 'sqlite' || !queueMode();
}

// ---------------------------------------------------------------------------
// Chaining at insert (inside the insert's transaction)
// ---------------------------------------------------------------------------

/** The link to chain the next event off: the head record, else the newest chained event, else the anchor, else the start. */
function currentHead(db: Database): { seq: number; hash: string } {
  const head = endOf(db.get(`SELECT * FROM audit_chain WHERE id = 'head'`));
  const newest = db.get<{ chain_seq: number; hash: string }>('SELECT chain_seq, hash FROM audit_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1');
  const anchor = endOf(db.get(`SELECT * FROM audit_chain WHERE id = 'anchor'`));
  // A head record behind the events (edited, or a crash between the two writes, which share a transaction): the events win.
  const candidates = [head, newest && { seq: Number(newest.chain_seq), hash: newest.hash }, anchor].filter((c): c is { seq: number; hash: string } => Boolean(c));
  return candidates.sort((a, b) => b.seq - a.seq)[0] ?? { seq: 0, hash: GENESIS };
}

/** Chain `row` as the next event (call inside the transaction that inserts it). Returns the row with its link. */
export function linkEvent<T extends ChainRow>(db: Database, row: T): T & { chain_seq: number; prev_hash: string; hash: string } {
  const head = currentHead(db);
  const seq = head.seq + 1;
  const hash = eventHash(row, seq, head.hash);
  db.upsert('audit_chain', { id: 'head', seq, hash, event_id: row.id, at: row.at, updated_at: new Date().toISOString() });
  return { ...row, chain_seq: seq, prev_hash: head.hash, hash };
}

// ---------------------------------------------------------------------------
// Sealing in Postgres (queue mode)
// ---------------------------------------------------------------------------

/** Write rows into this process's copy only (Postgres has them already). */
function putLocal(db: Database, table: 'audit_events' | 'audit_chain', rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  db.sqlite.exec('BEGIN');
  try {
    for (const row of rows) {
      const columns = Object.keys(row).filter((column) => /^[a-z_][a-z0-9_]*$/.test(column));
      db.sqlite.prepare(upsertSql(table, columns, 'upsert', () => '?')).run(...columns.map((column) => (row[column] ?? null) as SqlValue));
    }
    db.sqlite.exec('COMMIT');
  } catch (error) {
    if (db.sqlite.isTransaction) db.sqlite.exec('ROLLBACK');
    throw error;
  }
}

async function chainStart(client: DirectClient): Promise<string | undefined> {
  return (await client.query<{ applied_at: string }>('SELECT applied_at FROM schema_version WHERE version = $1', [CHAIN_MIGRATION])).rows[0]?.applied_at ?? undefined;
}

/** Run `fn` in a Postgres transaction holding the chain's advisory lock. */
async function underChainLock<T>(client: DirectClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Tell every process (this one too) about rows the chain wrote straight to Postgres. */
async function notify(client: DirectClient, ops: WriteOp[]) {
  for (const payload of noticesFor(NOTICE_ORIGIN, ops)) await client.query('SELECT pg_notify($1, $2)', [CHANGES_CHANNEL, payload]);
}

/**
 * Queue mode on Postgres: chain the events stored unchained so far, oldest first, in Postgres under the chain's lock
 * (several processes may run it at once: they take turns). Returns how many it sealed; 0 on SQLite.
 */
export async function sealPending(db: Database = auditDb()): Promise<number> {
  if (db.kind !== 'postgres') return 0;
  // This process's own events reach Postgres first.
  await db.flush().catch(() => {});
  let total = 0;
  for (;;) {
    const sealed = await db.direct((client) =>
      underChainLock(client, async () => {
        const start = await chainStart(client);
        const ends = (await client.query(`SELECT * FROM audit_chain WHERE id IN ('head', 'anchor')`)).rows.map((row) => endOf(row)!);
        const newest = (await client.query<{ chain_seq: string; hash: string }>('SELECT chain_seq, hash FROM audit_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1')).rows[0];
        const candidates = [...ends, ...(newest ? [{ seq: Number(newest.chain_seq), hash: newest.hash }] : [])].sort((a, b) => b.seq - a.seq);
        let { seq, hash } = candidates[0] ?? { seq: 0, hash: GENESIS };
        const rows = (await client.query<Record<string, unknown> & ChainRow>(`SELECT * FROM audit_events WHERE chain_seq IS NULL ${start ? 'AND at >= $2' : ''} ORDER BY at, id LIMIT $1`, start ? [SEAL_BATCH, start] : [SEAL_BATCH])).rows;
        if (!rows.length) return [];
        const linked: Record<string, unknown>[] = [];
        for (const row of rows) {
          const link = { chain_seq: seq + 1, prev_hash: hash, hash: eventHash(row, seq + 1, hash) };
          await client.query('UPDATE audit_events SET chain_seq = $1, prev_hash = $2, hash = $3 WHERE id = $4 AND chain_seq IS NULL', [link.chain_seq, link.prev_hash, link.hash, row.id]);
          linked.push({ ...row, ...link });
          seq = link.chain_seq;
          hash = link.hash;
        }
        const last = linked.at(-1)!;
        const head = { id: 'head', seq, hash, event_id: last.id, at: last.at, updated_at: new Date().toISOString() };
        await client.query(
          `INSERT INTO audit_chain (id, seq, hash, event_id, at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, event_id = excluded.event_id, at = excluded.at, updated_at = excluded.updated_at`,
          [head.id, head.seq, head.hash, head.event_id, head.at, head.updated_at],
        );
        await notify(client, [...linked.map((row) => ({ op: 'upsert' as const, table: 'audit_events' as const, row: row as Record<string, SqlValue> })), { op: 'upsert', table: 'audit_chain', row: head as Record<string, SqlValue> }]);
        return [linked, head] as const;
      }),
    );
    if (!sealed?.length) break;
    const [linked, head] = sealed;
    putLocal(db, 'audit_events', linked as Record<string, unknown>[]);
    putLocal(db, 'audit_chain', [head as Record<string, unknown>]);
    total += (linked as unknown[]).length;
    if ((linked as unknown[]).length < SEAL_BATCH) break;
  }
  return total;
}

interface SealerState {
  timer?: ReturnType<typeof setInterval>;
  kickTimer?: ReturnType<typeof setTimeout>;
  running?: Promise<number>;
  /** The database it seals (the one events were stored in). */
  db?: Database;
}

const sealer = () => singleton<SealerState>('audit-chain-sealer', () => ({}));

function sealSoon(delayMs = 200) {
  const s = sealer();
  if (s.kickTimer) return;
  s.kickTimer = setTimeout(() => {
    s.kickTimer = undefined;
    void runSealer();
  }, delayMs);
  s.kickTimer.unref?.();
}

function runSealer(): Promise<number> {
  const s = sealer();
  if (s.running) return s.running;
  const run = sealPending(s.db ?? auditDb()).catch((error) => {
    logger.warn('audit chain: sealing failed, retrying', { error: (error as Error).message });
    return 0;
  });
  s.running = run;
  void run.finally(() => {
    if (s.running === run) s.running = undefined;
  });
  return run;
}

/** An event was stored unchained in `db` (queue mode on Postgres): seal it shortly. */
export function kickSealer(db: Database) {
  if (db.kind !== 'postgres') return;
  sealer().db = db;
  sealSoon();
}

/** Queue mode on Postgres: seal on a 5 s tick (and when kicked). Idempotent; nothing to do elsewhere. */
export function startChainSealer() {
  const s = sealer();
  const db = auditDb();
  if (s.timer || chainsAtInsert(db)) return;
  s.db = db;
  s.timer = setInterval(() => void runSealer(), 5_000);
  s.timer.unref?.();
  sealSoon(0);
}

export async function stopChainSealer() {
  const s = sealer();
  if (s.timer) clearInterval(s.timer);
  if (s.kickTimer) clearTimeout(s.kickTimer);
  s.timer = s.kickTimer = undefined;
  await s.running?.catch(() => 0);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Prune chained events from the oldest end, up to the first one still within the retention (`cutoff`, ISO) or still
 * waiting for a SIEM destination, and keep the last pruned event's hash as the anchor; legacy (unchained) events go
 * by their time. SQLite and Postgres with one host. Returns how many events went.
 */
export function pruneChain(db: Database, cutoff: string): number {
  return db.transaction(() => {
    let removed = 0;
    const newest = db.get<{ seq: number | null }>('SELECT MAX(chain_seq) AS seq FROM audit_events')?.seq;
    if (newest !== null && newest !== undefined) {
      const keep = db.get<{ seq: number | null }>('SELECT MIN(chain_seq) AS seq FROM audit_events WHERE chain_seq IS NOT NULL AND (at >= ? OR id IN (SELECT event_id FROM audit_outbox))', cutoff)?.seq;
      const keepFrom = Number(keep ?? Number(newest) + 1);
      const last = db.get<ChainRow & { chain_seq: number; hash: string }>('SELECT * FROM audit_events WHERE chain_seq = ?', keepFrom - 1);
      if (last) {
        db.upsert('audit_chain', { id: 'anchor', seq: Number(last.chain_seq), hash: last.hash, event_id: last.id, at: last.at, updated_at: new Date().toISOString() });
        removed += db.deleteBefore('audit_events', 'chain_seq', keepFrom);
      }
    }
    const start = db.get<{ applied_at: string }>('SELECT applied_at FROM schema_version WHERE version = ?', CHAIN_MIGRATION)?.applied_at;
    const legacyBefore = start && start < cutoff ? start : cutoff;
    for (const row of db.all<{ id: string }>('SELECT id FROM audit_events WHERE chain_seq IS NULL AND at < ? AND id NOT IN (SELECT event_id FROM audit_outbox) LIMIT 10000', legacyBefore)) {
      removed += db.delete('audit_events', { id: row.id });
    }
    return removed;
  });
}

/** `pruneChain` for queue mode on Postgres: decided in Postgres under the chain's lock, then applied to this copy (and the others'). */
export async function pruneChainInPostgres(db: Database, cutoff: string): Promise<number> {
  await db.flush().catch(() => {});
  const result = await db.direct((client) =>
    underChainLock(client, async () => {
      let removed = 0;
      const ops: WriteOp[] = [];
      const newest = (await client.query<{ seq: string | null }>('SELECT MAX(chain_seq) AS seq FROM audit_events')).rows[0]?.seq;
      let keepFrom: number | undefined;
      if (newest !== null && newest !== undefined) {
        const keep = (await client.query<{ seq: string | null }>('SELECT MIN(chain_seq) AS seq FROM audit_events WHERE chain_seq IS NOT NULL AND (at >= $1 OR id IN (SELECT event_id FROM audit_outbox))', [cutoff])).rows[0]?.seq;
        keepFrom = Number(keep ?? Number(newest) + 1);
        const last = (await client.query<ChainRow & { chain_seq: string; hash: string }>('SELECT * FROM audit_events WHERE chain_seq = $1', [keepFrom - 1])).rows[0];
        if (last) {
          const anchor = { id: 'anchor', seq: Number(last.chain_seq), hash: last.hash, event_id: last.id, at: last.at, updated_at: new Date().toISOString() };
          // Never behind an anchor another process already moved further.
          await client.query(
            `INSERT INTO audit_chain (id, seq, hash, event_id, at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, event_id = excluded.event_id, at = excluded.at, updated_at = excluded.updated_at WHERE audit_chain.seq < excluded.seq`,
            [anchor.id, anchor.seq, anchor.hash, anchor.event_id, anchor.at, anchor.updated_at],
          );
          removed += (await client.query('DELETE FROM audit_events WHERE chain_seq < $1', [keepFrom])).rowCount ?? 0;
          ops.push({ op: 'upsert', table: 'audit_chain', row: anchor as Record<string, SqlValue> }, { op: 'deleteBefore', table: 'audit_events', column: 'chain_seq', value: keepFrom });
        } else keepFrom = undefined;
      }
      const start = await chainStart(client);
      const legacyBefore = start && start < cutoff ? start : cutoff;
      const legacy = (await client.query<{ id: string }>('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE chain_seq IS NULL AND at < $1 AND id NOT IN (SELECT event_id FROM audit_outbox) LIMIT 10000) RETURNING id', [legacyBefore])).rows;
      removed += legacy.length;
      for (const row of legacy) ops.push({ op: 'delete', table: 'audit_events', where: { id: row.id } });
      await notify(client, ops);
      return { removed, ops, keepFrom };
    }),
  );
  if (!result) return 0;
  // This copy follows at once (the notice repeats it, harmlessly).
  db.sqlite.exec('BEGIN');
  try {
    for (const op of result.ops) {
      if (op.op === 'deleteBefore') db.sqlite.prepare('DELETE FROM audit_events WHERE chain_seq < ?').run(op.value);
      else if (op.op === 'delete') db.sqlite.prepare('DELETE FROM audit_events WHERE id = ?').run(op.where.id);
    }
    db.sqlite.exec('COMMIT');
  } catch (error) {
    if (db.sqlite.isTransaction) db.sqlite.exec('ROLLBACK');
    throw error;
  }
  const anchor = result.ops.find((op) => op.op === 'upsert');
  if (anchor && anchor.op === 'upsert') putLocal(db, 'audit_chain', [anchor.row]);
  return result.removed;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

type StoredRow = ChainRow & { chain_seq: unknown; prev_hash: unknown; hash: unknown };
interface Unchained {
  /** Unchained events since the chain began (the first few), how many, and how many from before it (legacy). */
  since: Array<{ id: string; at: string }>;
  sinceCount: number;
  legacy: number;
}

/** The walk along the chain, fed pages of events in order (synchronously from SQLite, or from Postgres). */
class ChainWalk {
  readonly head?: ChainEnd;
  readonly anchor?: ChainEnd;
  readonly problems: AuditChainProblem[] = [];
  private expected: number;
  private prev: string;
  private checked = 0;
  private firstSeq?: number;
  private lastSeq?: number;
  /** Read events after this sequence number next. */
  after: number;
  readonly maxSeq: number;

  constructor(ends: ChainEnd[]) {
    this.head = ends.find((end) => end.id === 'head');
    this.anchor = ends.find((end) => end.id === 'anchor');
    this.expected = (this.anchor?.seq ?? 0) + 1;
    this.prev = this.anchor?.hash ?? GENESIS;
    this.after = this.anchor?.seq ?? 0;
    this.maxSeq = this.head?.seq ?? Number.MAX_SAFE_INTEGER;
  }

  private problem(p: AuditChainProblem) {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push(p);
  }

  /** One page; returns whether there may be more. */
  page(rows: StoredRow[], limit: number): boolean {
    for (const row of rows) {
      const seq = Number(row.chain_seq);
      const storedPrev = String(row.prev_hash ?? '');
      const storedHash = String(row.hash ?? '');
      if (seq > this.expected) {
        const gap = seq - this.expected;
        this.problem({ seq: this.expected, eventId: row.id, at: row.at, reason: gap === 1 ? `Event #${this.expected} is missing: it was deleted` : `Events #${this.expected}–#${seq - 1} are missing: they were deleted` });
      } else if (storedPrev !== this.prev) {
        this.problem({ seq, eventId: row.id, at: row.at, reason: 'Its link to the previous event doesn’t match: the event before it was changed or replaced' });
      }
      if (eventHash(row, seq, storedPrev) !== storedHash) this.problem({ seq, eventId: row.id, at: row.at, reason: 'The event was changed after it was recorded' });
      this.firstSeq ??= seq;
      this.lastSeq = seq;
      this.prev = storedHash;
      this.expected = seq + 1;
      this.checked++;
    }
    if (rows.length) this.after = Number(rows.at(-1)!.chain_seq);
    return rows.length >= limit;
  }

  /** The report, once every page went through. `sealsLater`: queue mode, where unchained new events are pending, not suspicious. */
  report(unchained: Unchained, sealsLater: boolean): AuditChainReport {
    const { head, anchor } = this;
    if (head) {
      if (this.expected - 1 < head.seq) {
        const missing = head.seq - this.expected + 1;
        this.problem({ seq: this.expected, reason: missing === 1 ? `The newest event (#${head.seq}) is missing: it was deleted` : `The newest ${plural(missing, 'event')} (#${this.expected}–#${head.seq}) are missing: they were deleted` });
      } else if (this.prev !== head.hash) this.problem({ seq: head.seq, ...(head.event_id && { eventId: head.event_id }), reason: 'The newest event doesn’t match the chain’s head record' });
    } else if (this.checked) this.problem({ reason: 'The chain’s head record is missing' });
    // Outside queue mode every event since the chain began is chained as it is stored: one without a link was put there behind Landflow's back.
    if (!sealsLater) for (const row of unchained.since) this.problem({ eventId: row.id, at: row.at, reason: 'The event isn’t chained: it was added outside Landflow' });
    const problems = this.problems;
    return {
      ok: problems.length === 0,
      checked: this.checked,
      ...(this.firstSeq !== undefined && { firstSeq: this.firstSeq }),
      ...(this.lastSeq !== undefined && { lastSeq: this.lastSeq }),
      ...(head && { head: { seq: head.seq, hash: head.hash, ...(head.event_id && { eventId: head.event_id }), ...(head.at && { at: head.at }) } }),
      ...(anchor && { anchor: { seq: anchor.seq, hash: anchor.hash, ...(anchor.event_id && { eventId: anchor.event_id }), ...(anchor.at && { at: anchor.at }) } }),
      pending: sealsLater ? unchained.sinceCount : 0,
      legacy: unchained.legacy,
      ...(problems[0] && { brokenAt: problems[0] }),
      problems,
      verifiedAt: new Date().toISOString(),
    };
  }
}

const PAGE = 1_000;

/** SQLite (and the in-memory copy): all of it synchronously, inside one read transaction. */
function verifySqlite(db: Database): AuditChainReport {
  db.sqlite.exec('BEGIN');
  try {
    const walk = new ChainWalk(db.all<Record<string, unknown>>(`SELECT * FROM audit_chain WHERE id IN ('head', 'anchor')`).map((row) => endOf(row)!));
    while (walk.page(db.all<StoredRow>('SELECT * FROM audit_events WHERE chain_seq > ? AND chain_seq <= ? ORDER BY chain_seq LIMIT ?', walk.after, walk.maxSeq, PAGE), PAGE));
    const start = db.get<{ applied_at: string }>('SELECT applied_at FROM schema_version WHERE version = ?', CHAIN_MIGRATION)?.applied_at;
    const unchained: Unchained = {
      since: start ? db.all<{ id: string; at: string }>('SELECT id, at FROM audit_events WHERE chain_seq IS NULL AND at >= ? ORDER BY at, id LIMIT ?', start, MAX_PROBLEMS) : [],
      sinceCount: start ? Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events WHERE chain_seq IS NULL AND at >= ?', start)?.n ?? 0) : 0,
      legacy: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE chain_seq IS NULL${start ? ' AND at < ?' : ''}`, ...(start ? [start] : []))?.n ?? 0),
    };
    return walk.report(unchained, false);
  } finally {
    if (db.sqlite.isTransaction) db.sqlite.exec('COMMIT');
  }
}

/** Postgres itself, in one REPEATABLE READ snapshot. */
async function verifyPostgres(client: DirectClient, sealsLater: boolean): Promise<AuditChainReport> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const walk = new ChainWalk((await client.query(`SELECT * FROM audit_chain WHERE id IN ('head', 'anchor')`)).rows.map((row) => endOf(row)!));
    while (walk.page((await client.query<StoredRow>('SELECT * FROM audit_events WHERE chain_seq > $1 AND chain_seq <= $2 ORDER BY chain_seq LIMIT $3', [walk.after, walk.maxSeq, PAGE])).rows, PAGE));
    const start = await chainStart(client);
    const unchained: Unchained = {
      since: start ? (await client.query<{ id: string; at: string }>('SELECT id, at FROM audit_events WHERE chain_seq IS NULL AND at >= $1 ORDER BY at, id LIMIT $2', [start, MAX_PROBLEMS])).rows : [],
      sinceCount: start ? Number((await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM audit_events WHERE chain_seq IS NULL AND at >= $1', [start])).rows[0]?.n ?? 0) : 0,
      legacy: Number((await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM audit_events WHERE chain_seq IS NULL${start ? ' AND at < $1' : ''}`, start ? [start] : [])).rows[0]?.n ?? 0),
    };
    return walk.report(unchained, sealsLater);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

/**
 * Check the whole chain: every event's hash against its stored fields, every link against the event before it (from
 * the anchor, or from the start), no gaps, and the newest event against the head record. Reads one consistent
 * snapshot: a read transaction on SQLite, a REPEATABLE READ transaction straight on Postgres (so changes made behind
 * the hosts' backs, which their in-memory copies don't see, show too).
 */
export async function verifyChain(db: Database = auditDb()): Promise<AuditChainReport> {
  if (db.kind === 'postgres') {
    const report = await db.direct((client) => verifyPostgres(client, !chainsAtInsert(db)));
    if (report) return report;
  }
  return verifySqlite(db);
}
