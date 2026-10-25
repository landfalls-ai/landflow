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
import { MIGRATIONS, pendingMigrations, SCHEMA_VERSION_TABLE, TABLES, type Migration, type TableName } from './schema';

export type DbKind = 'sqlite' | 'postgres';
export type SqlValue = string | number | bigint | null;
/** A row to write: booleans become 0/1 and undefined becomes NULL. */
export type Row = Record<string, SqlValue | boolean | undefined>;

/** One committed write, as Postgres mode replays it. */
export type WriteOp =
  | { op: 'upsert' | 'insert'; table: TableName; row: Record<string, SqlValue> }
  | { op: 'delete'; table: TableName; where: Record<string, SqlValue> }
  | { op: 'deleteBefore'; table: TableName; column: string; value: SqlValue };

/** Receives the writes of each committed transaction (Postgres mode). */
export interface WriteSink {
  enqueue(ops: WriteOp[]): void;
  flush(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const COLUMN = /^[a-z_][a-z0-9_]*$/;

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
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private pending: WriteOp[] = [];

  constructor(
    readonly sqlite: DatabaseSync,
    readonly kind: DbKind,
    /** The SQLite file, or `:memory:` for Postgres mode's copy. */
    readonly location: string,
    private readonly sink?: WriteSink,
  ) {}

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.sqlite.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...(params as SQLInputValue[])) as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  /** Insert a row or replace the columns it names (by primary key). */
  upsert(table: TableName, row: Row) {
    this.write({ op: 'upsert', table, row: clean(row) });
  }

  /** Insert a row unless its primary key exists. Returns whether it was inserted. */
  insertNew(table: TableName, row: Row): boolean {
    return this.write({ op: 'insert', table, row: clean(row) }) > 0;
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

  private write(op: WriteOp): number {
    let changes: number;
    if (op.op === 'delete') {
      const columns = Object.keys(op.where);
      changes = Number(this.statement(`DELETE FROM ${op.table} WHERE ${columns.map((c) => `${c} = ?`).join(' AND ')}`).run(...columns.map((c) => op.where[c] as SQLInputValue)).changes);
    } else if (op.op === 'deleteBefore') {
      changes = Number(this.statement(`DELETE FROM ${op.table} WHERE ${op.column} < ?`).run(op.value as SQLInputValue).changes);
    } else {
      const columns = Object.keys(op.row);
      changes = Number(this.statement(upsertSql(op.table, columns, op.op, () => '?')).run(...columns.map((c) => op.row[c] as SQLInputValue)).changes);
    }
    // Only changes that happened are replayed (an insert that hit an existing key, a delete of nothing: no op).
    if (this.sink && (changes > 0 || op.op === 'upsert')) {
      if (this.depth > 0) this.pending.push(op);
      else this.sink.enqueue([op]);
    }
    return changes;
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
      if (this.sink && this.pending.length) this.sink.enqueue(this.pending);
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
