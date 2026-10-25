/**
 * The host's database: SQLite at `<data dir>/landflow.db` by default (WAL mode), or Postgres with
 * LANDFLOW_DB=postgres and DATABASE_URL (see ./postgres for how that keeps the store API
 * synchronous, and its limits). Workflows, executions, poll state, versions, folders, settings,
 * variables, waits, checkpoints, idempotency keys, retries and Data Tables live here; credentials,
 * the encryption key, insights and the agent files stay files in the data directory.
 *
 * SQLite opens on first use. Postgres has to load first: bootstrap awaits `openDatabase()` before
 * anything touches the store. The first open of a data directory that still has the JSON files of
 * older versions imports them once (./import).
 */
import { join } from 'node:path';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { openSqlite, type Database, type DbKind } from './database';
import { importJsonData } from './import';

export { Database, openSqlite, openSqliteConnection, migrateSqlite, type DbKind, type Row, type SqlValue, type WriteOp } from './database';
export { importJsonData, type ImportSummary } from './import';
export { LATEST_VERSION, MIGRATIONS, TABLES, type Migration, type TableName } from './schema';

/** LANDFLOW_DATA_DIR, else `.data` in the working directory. */
export function dataDir(): string {
  return process.env.LANDFLOW_DATA_DIR ?? join(process.cwd(), '.data');
}

/** Which database this process uses (LANDFLOW_DB, default sqlite). */
export function dbKind(): DbKind {
  return process.env.LANDFLOW_DB?.trim().toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';
}

interface State {
  db?: Database;
  opening?: Promise<Database>;
}

const state = () => singleton<State>('database', () => ({}));

function imported(db: Database, dir: string): Database {
  try {
    const summary = importJsonData(db, dir);
    if (summary.renamed.length) logger.info('imported the JSON data files into the database', { 'landflow.db.kind': db.kind, ...summary.counts, 'landflow.db.renamed': summary.renamed.join(', ') });
  } catch (error) {
    logger.error('importing the JSON data files failed; they are left in place', { error });
  }
  return db;
}

/** The open database. SQLite opens (and imports) on first use; Postgres must have been opened by `openDatabase()`. */
export function database(): Database {
  const current = state();
  if (current.db) return current.db;
  if (dbKind() === 'postgres') throw new Error('The Postgres store is not loaded yet: bootstrap opens it (openDatabase) before the store is used');
  const dir = dataDir();
  current.db = imported(openSqlite(join(dir, 'landflow.db')), dir);
  return current.db;
}

/** Open the database (bootstrap). For Postgres: connect, migrate, replay queued writes and load the in-memory copy. */
export function openDatabase(): Promise<Database> {
  const current = state();
  if (current.db) return Promise.resolve(current.db);
  if (dbKind() === 'sqlite') return Promise.resolve(database());
  current.opening ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('LANDFLOW_DB=postgres needs DATABASE_URL');
    const { openPostgres } = await import('./postgres');
    const dir = dataDir();
    const db = imported(await openPostgres(url, dir), dir);
    current.db = db;
    return db;
  })().catch((error) => {
    current.opening = undefined;
    throw error;
  });
  return current.opening;
}

/** Close the database and forget it (tests; Postgres flushes its queue first). */
export async function closeDatabase(): Promise<void> {
  const current = state();
  const db = current.db;
  current.db = undefined;
  current.opening = undefined;
  await db?.close();
}
