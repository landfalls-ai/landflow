/**
 * The database for the MCP identity tables (`mcp_tokens`, `mcp_grants`, `mcp_catalog_servers`; migrations 1723–1725).
 * Like lib/server/auth/db.ts: on SQLite, the first use in a process applies migrations the open connection hasn't run
 * yet, so a dev server that hot-reloads this code (its connection opened before these tables existed) works at once.
 */
import { database, migrateSqlite, type Database } from '../db';
import { singleton } from '../singleton';

export function mcpDb(): Database {
  const db = database();
  const checked = singleton('mcp-schema-checked', () => new WeakSet<Database>());
  if (!checked.has(db)) {
    const has = (table: string) => Boolean(db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table));
    if (db.kind === 'sqlite' && (!has('mcp_tokens') || !has('mcp_grants') || !has('mcp_catalog_servers') || !has('mcp_gateway_resources'))) migrateSqlite(db.sqlite);
    checked.add(db);
  }
  return db;
}
