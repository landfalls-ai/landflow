/**
 * A write decided where it counts, for everything the second factor may use once: a sign-in challenge, a TOTP step, a
 * recovery code (and, later, a passkey's counter). `takeOnce` changes one row only when a condition still holds and
 * says whether this caller was the one that did it. SQLite (one process, or several on the file): one transaction
 * (BEGIN IMMEDIATE) reads, checks and writes. Postgres (queue mode): one conditional `UPDATE … RETURNING` on a direct
 * connection, so of two mains given the same code exactly one wins; this main's copy and the others' follow. A plain
 * `db.upsert` here would let a replay through, because each main decides from its own copy.
 */
import type { Database, SqlValue, TableName } from '../../db';
import { TABLES } from '../../db';
import { authDb } from '../db';

type Row = Record<string, SqlValue>;

/** A column set to its old value plus `by` (a wrong-answer counter), decided where the row lives. */
export interface Increment {
  $inc: number;
}

export interface OnceSpec {
  table: TableName;
  /** The row's primary key, in the order `TABLES` lists its columns. */
  key: Row;
  /** What the winner writes. */
  set: Record<string, SqlValue | Increment>;
  /** The condition for Postgres, with `?` for each of `whenParams`; the same condition as `check`. */
  when: string;
  whenParams: SqlValue[];
  /** The condition, for the in-process copy (SQLite). */
  check(row: Row): boolean;
}

const isIncrement = (value: unknown): value is Increment => typeof value === 'object' && value !== null && '$inc' in value;

/** Apply `spec` once. Returns the row as it is after the write, or undefined when the condition no longer held (or the row is gone). */
export async function takeOnce(spec: OnceSpec, db: Database = authDb()): Promise<Row | undefined> {
  const keys = Object.keys(spec.key);
  if (db.kind !== 'postgres') {
    return db.transaction(() => {
      const row = db.get<Row>(`SELECT * FROM ${spec.table} WHERE ${keys.map((c) => `${c} = ?`).join(' AND ')}`, ...keys.map((c) => spec.key[c]));
      if (!row || !spec.check(row)) return undefined;
      const next: Row = { ...row };
      for (const [column, value] of Object.entries(spec.set)) next[column] = isIncrement(value) ? Number(row[column] ?? 0) + value.$inc : value;
      db.upsert(spec.table, next);
      return next;
    });
  }
  // Our own queued writes of this row first (a challenge made a moment ago), then the one decision that counts.
  await db.flush();
  const params: SqlValue[] = [];
  const bind = (value: SqlValue) => `$${params.push(value)}`;
  const assignments = Object.entries(spec.set).map(([column, value]) => (isIncrement(value) ? `${column} = COALESCE(${column}, 0) + ${bind(value.$inc)}` : `${column} = ${bind(value)}`));
  const where = keys.map((c) => `${c} = ${bind(spec.key[c])}`);
  let when = spec.when;
  for (const value of spec.whenParams) when = when.replace('?', bind(value));
  const result = await db.direct(async (client) => {
    const updated = await client.query<Row>(`UPDATE ${spec.table} SET ${assignments.join(', ')} WHERE ${where.join(' AND ')} AND (${when}) RETURNING *`, params);
    const won = updated.rows[0];
    if (won) {
      // The other mains read the row back; this one's copy is written at once and not sent on.
      const notice = db.keyNotice(spec.table, (TABLES[spec.table] as readonly string[]).map((c) => won[c]));
      if (notice) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', notice]);
    }
    return won;
  });
  if (result) db.upsertLocal(spec.table, result);
  return result;
}
