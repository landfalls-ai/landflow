/**
 * The synchronous database API the stores use, on SQLite through `node:sqlite`.
 *
 * Reads are plain SQL (`all`, `get`). Writes go through row-level calls (`upsert`, `insertNew`,
 * `delete`, `deleteBefore`) so that, in Postgres mode, the same change can be replayed on Postgres:
 * there the SQLite connection is an in-memory copy loaded at boot, and every committed write is also
 * queued for Postgres in order (see ./postgres). `transaction` groups writes; nested calls join the
 * outer one, and Postgres receives the group as one transaction.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { envInt } from '../config';
import { singleton } from '../singleton';
import { telemetryConfig } from '../telemetry/config';
import { recordDbQuery, type DbOperation } from '../telemetry/metrics';
import { addColumnSql, MIGRATIONS, pendingMigrations, SCHEMA_VERSION_TABLE, TABLES, type Migration, type TableName } from './schema';

export type DbKind = 'sqlite' | 'postgres';
export type SqlValue = string | number | bigint | null;
/** A row to write: booleans become 0/1 and undefined becomes NULL. */
export type Row = Record<string, SqlValue | boolean | undefined>;

/** One committed write, as Postgres mode replays it. */
export type WriteOp =
  | { op: 'upsert' | 'insert'; table: TableName; row: Record<string, SqlValue> }
  | { op: 'delete'; table: TableName; where: Record<string, SqlValue> }
  | { op: 'deleteBefore'; table: TableName; column: string; value: SqlValue };

/** A connection straight to Postgres (`Database.direct`), for the few things that must be decided there. */
export interface DirectClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** How the write queue to Postgres is doing (SQLite: always ok, all zeros). */
export interface WriteHealth {
  state: 'ok' | 'retrying' | 'blocked';
  queuedBatches: number;
  queuedOps: number;
  oldestAgeMs: number;
  lastError?: string;
  blockedSeq?: number;
}

/** Thrown by a write while Postgres rejects a batch: the in-memory copy must not run ahead of it. */
export class StoreUnavailableError extends Error {
  readonly status = 503;
  constructor(seq?: number) {
    super(`The database is refusing writes; see the host log (postgres store blocked at batch ${seq})`);
    this.name = 'StoreUnavailableError';
  }
}

/** Receives the writes of each committed transaction (Postgres mode). */
export interface WriteSink {
  enqueue(ops: WriteOp[]): void;
  flush(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  /** Run `fn` on a Postgres connection of its own (Postgres mode). */
  direct?<T>(fn: (client: DirectClient) => Promise<T>): Promise<T>;
  health?(): WriteHealth;
}

const COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * Timing (docs/observability.md §5): every call is measured with performance.now (about 50 ns) into the
 * `landflow.db.query.duration` histogram, labelled by operation only. A `db.query` span is opened after the fact, and
 * only for calls at or over LANDFLOW_DB_SLOW_MS (default 50), named by the statement with its literals stripped:
 * the first 60 characters of the SQL with string and number literals stripped and whitespace collapsed.
 */
export function statementName(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** A finished slow call as a `db.query` span under the active one. */
function slowSpan(system: string, operation: string, sql: string, ms: number) {
  const end = Date.now();
  const span = trace.getTracer('landflow-host').startSpan('db.query', { startTime: end - ms, attributes: { 'db.system': system, 'db.operation': operation, 'db.query.summary': statementName(sql) } }, context.active());
  span.end(end);
}

/** Rows pass through this before an upsert or insert, when set (lib/server/secrets/install.ts redacts run data with it). */
export type RowFilter = (table: TableName, row: Row) => Row;
const filters = singleton<{ row?: RowFilter }>('db-row-filter', () => ({}));
export function setRowFilter(filter: RowFilter | undefined) {
  filters.row = filter;
}
const filtered = (table: TableName, row: Row): Row => (filters.row ? filters.row(table, row) : row);

function clean(row: Row): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!COLUMN.test(key)) throw new Error(`Invalid column name ${key}`);
    out[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return out;
}

/** `INSERT … ON CONFLICT` for one table and column list; the same text runs on SQLite and (with $n placeholders) Postgres. */
export function upsertSql(table: TableName, columns: string[], mode: 'upsert' | 'insert', placeholder: (index: number) => string): string {
  const keys: readonly string[] = TABLES[table];
  const values = columns.map((_c, i) => placeholder(i + 1)).join(', ');
  const updates = columns.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
  const action = mode === 'insert' || !updates.length ? 'DO NOTHING' : `DO UPDATE SET ${updates.join(', ')}`;
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values}) ON CONFLICT (${keys.join(', ')}) ${action}`;
}

export class Database {
  /** Prepared statements by SQL text, least recently used first: `IN (?, ?, …)` lists of every length would otherwise grow it for ever. */
  private readonly statements = new Map<string, StatementSync>();
  private readonly statementCap = envInt('LANDFLOW_DB_STATEMENT_CACHE', { fallback: 500, min: 1 });
  private depth = 0;
  private pending: WriteOp[] = [];
  /** Told of every committed write (queue mode on SQLite: other processes drop their caches). */
  private readonly observers = new Set<(ops: WriteOp[]) => void>();

  constructor(
    readonly sqlite: DatabaseSync,
    readonly kind: DbKind,
    /** The SQLite file, or `:memory:` for Postgres mode's copy. */
    readonly location: string,
    private readonly sink?: WriteSink,
  ) {}

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement) {
      // A hit moves to the end; Map keeps insertion order, so the first key is the stalest.
      this.statements.delete(sql);
    } else {
      statement = this.sqlite.prepare(sql);
      if (this.statements.size >= this.statementCap) this.statements.delete(this.statements.keys().next().value as string);
    }
    this.statements.set(sql, statement);
    return statement;
  }

  /** Statements held now (for tests). */
  get statementCount(): number {
    return this.statements.size;
  }

  /** Run one call, record its duration and trace it when slow; `sql` is only read then. */
  private timed<T>(operation: DbOperation, sql: string, run: () => T): T {
    const started = performance.now();
    try {
      return run();
    } finally {
      const ms = performance.now() - started;
      recordDbQuery(operation, ms);
      if (ms >= telemetryConfig.dbSlowMs) slowSpan(this.kind === 'postgres' ? 'postgres-mirror' : 'sqlite', operation, sql, ms);
    }
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.timed('select', sql, () => this.statement(sql).all(...(params as SQLInputValue[])) as T[]);
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.timed('select', sql, () => this.statement(sql).get(...(params as SQLInputValue[])) as T | undefined);
  }

  /** Insert a row or replace the columns it names (by primary key). */
  upsert(table: TableName, row: Row) {
    this.write({ op: 'upsert', table, row: clean(filtered(table, row)) });
  }

  /** Insert a row unless its primary key exists. Returns whether it was inserted. */
  insertNew(table: TableName, row: Row): boolean {
    return this.write({ op: 'insert', table, row: clean(filtered(table, row)) }) > 0;
  }

  /** Delete the rows whose columns equal `where`. Returns how many went. */
  delete(table: TableName, where: Row): number {
    const clauses = clean(where);
    if (!Object.keys(clauses).length) throw new Error('delete() needs a condition');
    return this.write({ op: 'delete', table, where: clauses });
  }

  /** Delete the rows whose `column` is less than `value`. */
  deleteBefore(table: TableName, column: string, value: SqlValue): number {
    if (!COLUMN.test(column)) throw new Error(`Invalid column name ${column}`);
    return this.write({ op: 'deleteBefore', table, column, value });
  }

  /** The state of the write queue (Postgres mode); SQLite is always ok. */
  writeHealth(): WriteHealth {
    return this.sink?.health?.() ?? { state: 'ok', queuedBatches: 0, queuedOps: 0, oldestAgeMs: 0 };
  }

  private write(op: WriteOp): number {
    // Before the in-memory copy changes (a transaction fails at its first write and rolls back).
    const health = this.sink?.health?.();
    if (health?.state === 'blocked') throw new StoreUnavailableError(health.blockedSeq);
    let changes: number;
    if (op.op === 'delete') {
      const columns = Object.keys(op.where);
      const sql = `DELETE FROM ${op.table} WHERE ${columns.map((c) => `${c} = ?`).join(' AND ')}`;
      changes = this.timed('delete', sql, () => Number(this.statement(sql).run(...columns.map((c) => op.where[c] as SQLInputValue)).changes));
    } else if (op.op === 'deleteBefore') {
      const sql = `DELETE FROM ${op.table} WHERE ${op.column} < ?`;
      changes = this.timed('delete', sql, () => Number(this.statement(sql).run(op.value as SQLInputValue).changes));
    } else {
      const columns = Object.keys(op.row);
      const sql = upsertSql(op.table, columns, op.op, () => '?');
      changes = this.timed(op.op === 'insert' ? 'insert' : 'upsert', sql, () => Number(this.statement(sql).run(...columns.map((c) => op.row[c] as SQLInputValue)).changes));
    }
    // Only changes that happened are replayed (an insert that hit an existing key, a delete of nothing: no op).
    if ((this.sink || this.observers.size) && (changes > 0 || op.op === 'upsert')) {
      if (this.depth > 0) this.pending.push(op);
      else this.committed([op]);
    }
    return changes;
  }

  private committed(ops: WriteOp[]) {
    this.sink?.enqueue(ops);
    for (const observer of this.observers) observer(ops);
  }

  /** Hear of every committed write; returns a function that stops it. */
  observe(observer: (ops: WriteOp[]) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Run `fn` as one transaction (nested calls join the outer one). `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sqlite.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Database transactions must be synchronous');
      this.sqlite.exec('COMMIT');
      if (this.pending.length) this.committed(this.pending);
      return result;
    } catch (error) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
      this.pending = [];
    }
  }

  /** Postgres mode: wait until every committed write reached Postgres. SQLite: nothing to do. */
  flush(timeoutMs?: number): Promise<void> {
    return this.sink?.flush(timeoutMs) ?? Promise.resolve();
  }

  /**
   * Postgres mode: run `fn` on a connection straight to Postgres, past the in-memory copy (a transaction-level lock or a
   * one-use claim several processes must agree on: lib/server/audit/chain.ts, lib/server/auth/saml-state.ts). Undefined on
   * SQLite, where the file itself is shared and `transaction` (BEGIN IMMEDIATE) already serializes writers.
   */
  direct<T>(fn: (client: DirectClient) => Promise<T>): Promise<T> | undefined {
    const call = this.sink?.direct;
    if (!call) return undefined;
    // Always a span: these are the calls that cross the network and decide something (locks, one-use claims).
    const span = trace.getTracer('landflow-host').startSpan('db.query', { attributes: { 'db.system': 'postgresql', 'db.operation': 'direct' } }, context.active());
    const started = performance.now();
    return (call.call(this.sink, fn) as Promise<T>).then(
      (result) => {
        recordDbQuery('direct', performance.now() - started);
        span.end();
        return result;
      },
      (error) => {
        recordDbQuery('direct', performance.now() - started);
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        span.end();
        throw error;
      },
    );
  }

  async close() {
    await this.sink?.close();
    this.statements.clear();
    if (this.sqlite.isOpen) this.sqlite.close();
  }

  /** The schema version recorded in this database (0 = none). */
  schemaVersion(): number {
    return Number(this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_version')?.version ?? 0);
  }
}

/** node:sqlite, without its one-time "experimental feature" warning (it works on every Node version Landflow supports). */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (text?.includes('SQLite is an experimental feature')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // process.getBuiltinModule keeps the bundler out of it; node:sqlite has no non-prefixed name.
    return process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

/** Apply the migrations this SQLite database lacks, in one transaction. Returns the versions applied. */
export function migrateSqlite(sqlite: DatabaseSync, migrations: Migration[] = MIGRATIONS): number[] {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(SCHEMA_VERSION_TABLE);
    const done = (sqlite.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>).map((row) => Number(row.version));
    const pending = pendingMigrations(migrations, done);
    const applied: number[] = [];
    for (const migration of pending) {
      for (const column of migration.addColumns ?? []) {
        const have = (sqlite.prepare(`PRAGMA table_info(${column.table})`).all() as Array<{ name: string }>).some((c) => c.name === column.column);
        if (!have) sqlite.exec(addColumnSql(column));
      }
      for (const statement of migration.statements) sqlite.exec(statement);
      sqlite.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    }
    sqlite.exec('COMMIT');
    return applied;
  } catch (error) {
    if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
    throw error;
  }
}

/** Open (or create) a SQLite database: WAL mode, a busy timeout for other processes, and the migrations applied. */
export function openSqliteConnection(location: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
  const sqlite = new DatabaseSync(location);
  if (location !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA busy_timeout = 10000');
    sqlite.exec('PRAGMA synchronous = NORMAL');
  }
  sqlite.exec('PRAGMA foreign_keys = OFF');
  migrateSqlite(sqlite);
  return sqlite;
}

/** A Database on a SQLite file (the default store). */
export function openSqlite(location: string): Database {
  return new Database(openSqliteConnection(location), 'sqlite', location);
}
