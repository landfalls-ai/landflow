/**
 * Queue mode: keeping each process's view of the database in step with the writes of the others.
 *
 * Postgres: every process keeps its in-memory copy (./postgres) and replays its writes on Postgres; with several
 * processes, each batch also sends `pg_notify('landflow_changes', …)` in the same transaction, so the others hear of
 * it exactly when it commits, in commit order. A notice names the rows: small ones inline, big ones (run data) by
 * primary key, which the receiver reads back from Postgres. Rows this process wrote and has not yet replayed are left
 * alone (its own write lands later and wins on Postgres too). A lost LISTEN connection reloads the copy. The copy holds
 * only the hot part of the run history (./hot-mirror): a run's data stays out of it, and so do the journal events of a
 * cold run, and a row that arrives already cold is evicted at once.
 *
 * SQLite on one host (LANDFLOW_QUEUE_ALLOW_SQLITE): the processes share the file, so only caches need telling; the
 * cluster runtime broadcasts the names of the tables written (lib/server/cluster).
 *
 * Either way `onTablesChanged` listeners hear which tables (and keys) another process changed, so caches (workflows,
 * folders, Data Tables, the plugin list) can drop what they hold.
 */
import type { StatementSync } from 'node:sqlite';
import type { Client, Pool } from 'pg';
import { logger } from '../telemetry/logger';
import { singleton } from '../singleton';
import { upsertSql, type Database, type SqlValue, type WriteOp } from './database';
import { registerReplicationMetrics } from './replication-metrics';
import { evictCooling, hotCutoff, isCold, mirrorSelect } from './hot-mirror';
import { TABLES, type TableName } from './schema';

export const CHANGES_CHANNEL = 'landflow_changes';
/** pg_notify payloads must stay under 8000 bytes. */
const MAX_PAYLOAD = 7_000;
/** Rows up to this size travel inline; bigger ones are read back by key. */
const MAX_INLINE_ROW = 1_500;

/** One change in a notice. */
export type Change =
  | ['r', TableName, Record<string, SqlValue>, 'upsert' | 'insert']
  | ['k', TableName, SqlValue[]]
  | ['d', TableName, Record<string, SqlValue>]
  | ['b', TableName, string, SqlValue];

export interface ChangeNotice {
  /** The instance that wrote it. */
  o: string;
  c: Change[];
  /** When it was sent (ms since the epoch, just before the commit): the receiver's replication lag is measured from it. */
  t?: number;
}

/** The primary key values of a row, or undefined when the row doesn't name them all. */
export function primaryKey(table: TableName, row: Record<string, SqlValue>): SqlValue[] | undefined {
  const keys: readonly string[] = TABLES[table];
  if (!keys.every((key) => key in row)) return undefined;
  return keys.map((key) => row[key]);
}

/** A row's identity, for the set of rows with writes not yet in Postgres. */
export const rowId = (table: TableName, key: SqlValue[]) => `${table}\u0000${JSON.stringify(key.map((value) => (value === null ? null : String(value))))}`;

/** The row a write touches, when it names one row. */
export function rowIdOf(op: WriteOp): string | undefined {
  if (op.op === 'deleteBefore') return undefined;
  const key = primaryKey(op.table, op.op === 'delete' ? op.where : op.row);
  return key ? rowId(op.table, key) : undefined;
}

/** The notices (pg_notify payloads) for a batch of writes. */
export function noticesFor(origin: string, ops: WriteOp[], at?: number): string[] {
  const payloads: string[] = [];
  let changes: Change[] = [];
  let size = 0;
  const flush = () => {
    if (changes.length) payloads.push(JSON.stringify({ o: origin, c: changes, ...(at !== undefined && { t: at }) } satisfies ChangeNotice));
    changes = [];
    size = 0;
  };
  for (const op of ops) {
    let change: Change;
    if (op.op === 'deleteBefore') change = ['b', op.table, op.column, op.value];
    else if (op.op === 'delete') change = ['d', op.table, op.where];
    else {
      const inline = JSON.stringify(op.row).length <= MAX_INLINE_ROW;
      const key = primaryKey(op.table, op.row);
      change = inline || !key ? ['r', op.table, op.row, op.op] : ['k', op.table, key];
    }
    const length = JSON.stringify(change).length + 1;
    if (size + length > MAX_PAYLOAD - origin.length - 20) flush();
    changes.push(change);
    size += length;
  }
  flush();
  return payloads;
}

// ---------------------------------------------------------------------------
// Listeners: which tables another process changed
// ---------------------------------------------------------------------------

export interface TablesChanged {
  tables: Set<TableName>;
  /** Primary keys per table, where known (a delete by condition or a reload names none). */
  keys: Map<TableName, SqlValue[][]>;
}

type ChangeListener = (change: TablesChanged) => void;
const state = () => singleton('db-replication', () => ({ listeners: new Set<ChangeListener>(), replica: undefined as Replica | undefined }));

export function onTablesChanged(listener: ChangeListener): () => void {
  state().listeners.add(listener);
  return () => state().listeners.delete(listener);
}

/** Tell the listeners (also used by the SQLite broadcast). */
export function emitTablesChanged(change: TablesChanged) {
  if (!change.tables.size) return;
  for (const listener of state().listeners) {
    try {
      listener(change);
    } catch (error) {
      logger.warn('replication: change listener failed', { error: (error as Error).message });
    }
  }
}

/**
 * Read rows matching `where` straight from Postgres into this process's copy (before acting on a row another process
 * may have just written). Nothing to do on SQLite, or with one process.
 */
export async function refreshRows(table: TableName, where: Record<string, SqlValue>): Promise<void> {
  await state().replica?.refresh(table, where);
}

/** Whether this process follows other processes' writes to Postgres. */
export const replicating = () => Boolean(state().replica);

// ---------------------------------------------------------------------------
// The Postgres follower
// ---------------------------------------------------------------------------

const COLUMN = /^[a-z_][a-z0-9_]*$/;

export class Replica {
  private readonly statements = new Map<string, StatementSync>();
  private readonly backlog: ChangeNotice[] = [];
  private draining?: Promise<void>;
  private listener?: Client;
  private closed = false;
  private loading = true;
  /** Notices applied (metrics). */
  applied = 0;
  /** Milliseconds between the last applied notice's send and its apply (the `landflow.db.replication.lag` gauge). */
  lagMs = 0;
  private unregisterMetrics?: () => void;

  constructor(
    private readonly db: Database,
    private readonly pool: Pool,
    private readonly url: string,
    readonly origin: string,
    /** Rows with writes of this process not yet in Postgres. */
    private readonly pendingRows: () => { has(id: string): boolean },
    /** This process's writes not yet in Postgres (re-applied after a reload). */
    private readonly pendingOps: () => WriteOp[],
  ) {}

  /** LISTEN, then hold notices until `ready()` (the copy is loaded meanwhile). */
  async listen() {
    const { Client } = (await import('pg')).default ?? (await import('pg'));
    const client = new Client({ connectionString: this.url, application_name: `landflow-listen:${this.origin}` });
    client.on('notification', (message) => {
      if (message.channel !== CHANGES_CHANNEL || !message.payload) return;
      let notice: ChangeNotice;
      try {
        notice = JSON.parse(message.payload) as ChangeNotice;
      } catch {
        return;
      }
      if (notice.o === this.origin) return;
      this.backlog.push(notice);
      if (!this.loading) this.drain();
    });
    const lost = (error?: Error) => {
      if (this.closed || this.listener !== client) return;
      this.listener = undefined;
      logger.warn('replication: lost the Postgres LISTEN connection; reconnecting and reloading', { error: error?.message });
      client.end().catch(() => {});
      setTimeout(() => void this.reconnect(), 1_000).unref?.();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    await client.connect();
    await client.query(`LISTEN ${CHANGES_CHANNEL}`);
    this.listener = client;
    state().replica = this;
    this.unregisterMetrics ??= registerReplicationMetrics(() => this.lagMs);
  }

  /** The copy is loaded: apply what arrived meanwhile and from now on. */
  ready() {
    this.loading = false;
    this.drain();
  }

  private async reconnect() {
    if (this.closed) return;
    try {
      this.loading = true;
      await this.listen();
      await this.reload();
      this.ready();
    } catch (error) {
      logger.warn('replication: reconnect failed, retrying', { error: (error as Error).message });
      setTimeout(() => void this.reconnect(), 5_000).unref?.();
    }
  }

  private drain() {
    this.draining ??= (async () => {
      while (this.backlog.length && !this.closed) {
        const notice = this.backlog.shift()!;
        try {
          await this.apply(notice);
          this.applied++;
          if (notice.t) this.lagMs = Math.max(0, Date.now() - notice.t);
        } catch (error) {
          logger.warn('replication: could not apply a change; reloading the tables it names', { error: (error as Error).message });
          for (const table of new Set(notice.c.map((change) => change[1]))) await this.reloadTable(table).catch(() => {});
        }
      }
    })().finally(() => {
      this.draining = undefined;
      if (this.backlog.length && !this.closed) this.drain();
    });
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.sqlite.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Write a row into the copy only (Postgres has it already). */
  private putLocal(table: TableName, row: Record<string, unknown>, mode: 'upsert' | 'insert' = 'upsert') {
    const columns = Object.keys(row).filter((column) => COLUMN.test(column));
    this.statement(upsertSql(table, columns, mode, () => '?')).run(...columns.map((column) => (row[column] ?? null) as SqlValue));
  }

  private deleteLocal(table: TableName, where: Record<string, SqlValue>) {
    const columns = Object.keys(where).filter((column) => COLUMN.test(column));
    if (!columns.length) return;
    this.statement(`DELETE FROM ${table} WHERE ${columns.map((column) => `${column} = ?`).join(' AND ')}`).run(...columns.map((column) => where[column]));
  }

  private async apply(notice: ChangeNotice) {
    const pending = this.pendingRows();
    const changed: TablesChanged = { tables: new Set(), keys: new Map() };
    const note = (table: TableName, key?: SqlValue[]) => {
      changed.tables.add(table);
      if (key) changed.keys.set(table, [...(changed.keys.get(table) ?? []), key]);
    };
    // Rows to read back, grouped per table in order (a run of 'k' changes becomes one query).
    let reads: { table: TableName; keys: SqlValue[][] } | undefined;
    const readBack = async () => {
      if (!reads) return;
      const { table, keys } = reads;
      reads = undefined;
      const rows = (await this.select(table, keys)).filter((row) => !this.coldEvent(table, row));
      const found = new Set(rows.map((row) => rowId(table, primaryKey(table, row as Record<string, SqlValue>) ?? [])));
      this.db.sqlite.exec('BEGIN');
      try {
        for (const row of rows) this.putLocal(table, row);
        // Gone since: a later notice deletes it too, but the copy shouldn't hold it meanwhile.
        for (const key of keys) {
          if (found.has(rowId(table, key))) continue;
          this.deleteLocal(table, Object.fromEntries(TABLES[table].map((column, i) => [column, key[i]])));
        }
        this.db.sqlite.exec('COMMIT');
      } catch (error) {
        if (this.db.sqlite.isTransaction) this.db.sqlite.exec('ROLLBACK');
        throw error;
      }
    };
    for (const change of notice.c) {
      const [kind, table] = change;
      if (!(table in TABLES)) continue;
      if (kind === 'k') {
        const key = change[2];
        if (pending.has(rowId(table, key))) continue;
        // The journal of a cold run is not kept in the copy (Postgres serves it).
        if (table === 'execution_events' && typeof key[0] === 'string' && isCold(this.db, key[0])) continue;
        if (reads && reads.table !== table) await readBack();
        reads ??= { table, keys: [] };
        reads.keys.push(key);
        note(table, key);
        continue;
      }
      await readBack();
      if (kind === 'r') {
        const row = change[2];
        const key = primaryKey(table, row);
        if (key && pending.has(rowId(table, key))) continue;
        if (this.coldEvent(table, row)) continue;
        try {
          this.putLocal(table, row, change[3]);
        } catch {
          // A partial row for a row this copy lacks (columns without defaults): read the whole row back.
          if (key) {
            reads = { table, keys: [key] };
            await readBack();
          }
        }
        note(table, key);
      } else if (kind === 'd') {
        const where = change[2];
        const key = primaryKey(table, where);
        if (key && pending.has(rowId(table, key))) continue;
        this.deleteLocal(table, where);
        note(table, key);
      } else if (kind === 'b') {
        if (!COLUMN.test(change[2])) continue;
        this.statement(`DELETE FROM ${table} WHERE ${change[2]} < ?`).run(change[3]);
        note(table);
      }
    }
    await readBack();
    // A run that arrives already cold (an old run another process touched) keeps no data or journal here.
    const executions = changed.keys.get('executions')?.map((key) => String(key[0]));
    if (executions?.length) evictCooling(this.db, executions);
    emitTablesChanged(changed);
  }

  /** A journal event of a cold run: not kept in the copy. */
  private coldEvent(table: TableName, row: Record<string, unknown>): boolean {
    return table === 'execution_events' && typeof row.execution_id === 'string' && isCold(this.db, row.execution_id);
  }

  /** Rows of `table` by primary key, from Postgres. */
  private async select(table: TableName, keys: SqlValue[][]): Promise<Record<string, unknown>[]> {
    if (!keys.length) return [];
    const columns: readonly string[] = TABLES[table];
    const values: SqlValue[] = [];
    const tuples = keys.map((key) => `(${key.map((value) => `$${values.push(value)}`).join(', ')})`);
    const target = columns.length === 1 ? columns[0] : `(${columns.join(', ')})`;
    const list = columns.length === 1 ? tuples.map((tuple) => tuple.slice(1, -1)) : tuples;
    return (await this.pool.query(`SELECT * FROM ${table} WHERE ${target} IN (${list.join(', ')})`, values)).rows;
  }

  async refresh(table: TableName, where: Record<string, SqlValue>) {
    const columns = Object.keys(where).filter((column) => COLUMN.test(column));
    if (!columns.length) return;
    const { rows } = await this.pool.query(`SELECT * FROM ${table} WHERE ${columns.map((column, i) => `${column} = $${i + 1}`).join(' AND ')}`, columns.map((column) => where[column]));
    const pending = this.pendingRows();
    const keep = (row: Record<string, unknown>) => {
      const key = primaryKey(table, row as Record<string, SqlValue>);
      return !key || !pending.has(rowId(table, key));
    };
    // Rows this process has writes for stay as they are; the rest match Postgres.
    const local = this.db.sqlite.prepare(`SELECT * FROM ${table} WHERE ${columns.map((column) => `${column} = ?`).join(' AND ')}`).all(...columns.map((column) => where[column]));
    this.db.sqlite.exec('BEGIN');
    try {
      for (const row of local) if (keep(row)) this.deleteLocal(table, Object.fromEntries(TABLES[table].map((column) => [column, row[column] as SqlValue])));
      for (const row of rows) if (keep(row) && !this.coldEvent(table, row)) this.putLocal(table, row);
      this.db.sqlite.exec('COMMIT');
      if (table === 'executions') evictCooling(this.db, rows.map((row) => String(row.id)));
    } catch (error) {
      if (this.db.sqlite.isTransaction) this.db.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  private async reloadTable(table: TableName) {
    const query = mirrorSelect(table, hotCutoff());
    const { rows } = await this.pool.query(query.text, query.values);
    this.db.sqlite.exec('BEGIN');
    try {
      this.db.sqlite.exec(`DELETE FROM ${table}`);
      for (const row of rows) this.putLocal(table, row);
      this.db.sqlite.exec('COMMIT');
    } catch (error) {
      if (this.db.sqlite.isTransaction) this.db.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  /** Reload every table from Postgres, then re-apply this process's writes not yet there (notices may have been lost). */
  async reload() {
    for (const table of Object.keys(TABLES) as TableName[]) await this.reloadTable(table);
    for (const op of this.pendingOps()) {
      if (op.op === 'deleteBefore') this.statement(`DELETE FROM ${op.table} WHERE ${op.column} < ?`).run(op.value);
      else if (op.op === 'delete') this.deleteLocal(op.table, op.where);
      else this.putLocal(op.table, op.row, op.op);
    }
    emitTablesChanged({ tables: new Set(Object.keys(TABLES) as TableName[]), keys: new Map() });
  }

  async close() {
    this.closed = true;
    this.unregisterMetrics?.();
    if (state().replica === this) state().replica = undefined;
    const listener = this.listener;
    this.listener = undefined;
    await listener?.end().catch(() => {});
  }
}
