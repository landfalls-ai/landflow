/**
 * The database for the auth tables. On SQLite, the first use in a process also applies migrations the open
 * connection hasn't run yet: a dev server that hot-reloads this code keeps its connection (opened before the
 * auth tables existed, or before the Wave 4 user columns), and would otherwise fail on every page until it restarts.
 */
import { database, migrateSqlite, type Database } from '../db';
import { singleton } from '../singleton';

export function authDb(): Database {
  const db = database();
  const checked = singleton('auth-schema-checked', () => new WeakSet<Database>());
  if (!checked.has(db)) {
    const has = (table: string) => Boolean(db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table));
    if (db.kind === 'sqlite' && (!has('users') || !has('saml_replay') || !has('projects'))) migrateSqlite(db.sqlite);
    checked.add(db);
  }
  return db;
}
