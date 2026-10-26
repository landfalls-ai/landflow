/**
 * The database for project-scoped folders, variables, settings, workflow policies and templates (migrations 1400 and
 * 1401). Like ../auth/db.ts: on SQLite, the first use in a process applies migrations the open connection hasn't run
 * yet, so a dev server that hot-reloads this code (and keeps a connection opened before these tables existed) works
 * without a restart.
 */
import { database, migrateSqlite, type Database } from '../db';
import { singleton } from '../singleton';

export function projectsDb(): Database {
  const db = database();
  const checked = singleton('project-scope-schema-checked', () => new WeakSet<Database>());
  if (!checked.has(db)) {
    const has = (table: string) => Boolean(db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table));
    if (db.kind === 'sqlite' && (!has('project_variables') || !has('workflow_policies'))) migrateSqlite(db.sqlite);
    checked.add(db);
  }
  return db;
}
