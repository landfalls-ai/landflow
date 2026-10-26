/**
 * The database for the MCP identity tables (`mcp_tokens`, `mcp_grants`, `mcp_catalog_servers`, `mcp_approvals`; migrations 1723–1725, 1750–1751, 1770).
 * Like lib/server/auth/db.ts: on SQLite, the first use in a process applies migrations the open connection hasn't run
 * yet, so a dev server that hot-reloads this code (its connection opened before these tables existed) works at once.
 */
import { database, migrateSqlite, type Database } from '../db';
import { singleton } from '../singleton';

export function mcpDb(): Database {
  const db = database();
  const checked = singleton('mcp-schema-checked-1770', () => new WeakSet<Database>());
  if (!checked.has(db)) {
    const has = (table: string) => Boolean(db.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table));
    const hasColumn = (table: string, column: string) => db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
    if (db.kind === 'sqlite' && (!has('mcp_tokens') || !has('mcp_grants') || !has('mcp_catalog_servers') || !has('mcp_gateway_resources') || !has('mcp_approvals') || !has('mcp_trigger_subs') || !has('mcp_trigger_events') || !hasColumn('mcp_grants', 'approval_mode'))) migrateSqlite(db.sqlite);
    checked.add(db);
  }
  return db;
}
