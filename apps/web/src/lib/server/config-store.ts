/**
 * Where credentials and the data directory's settings files live (README "Queue mode, workers and high availability").
 *
 * - `files` (the default outside queue mode): credentials.json, mcp.json, marketplaces.json, skill-library.json and
 *   agent-channels.json in LANDFLOW_DATA_DIR, exactly as before.
 * - `database` (the default in queue mode, or LANDFLOW_CONFIG_STORE=database): the `credentials` and `config_files`
 *   tables (migration 1300), so mains and workers see one copy whether or not they share a data directory, and two
 *   processes changing different credentials no longer overwrite each other's file. Postgres mode follows the other
 *   processes' writes (db/replication.ts), so a change made on one main reaches every process within moments.
 *
 * The first use of a store in `database` mode imports its file once, if there is one (recorded in `meta` as
 * `config_store.imported.<name>`; rows already in the table win), and leaves the file in place. LANDFLOW_CONFIG_STORE=files
 * keeps the files in queue mode (every process must then share the data directory, last writer wins). The encryption
 * key stays where it is: LANDFLOW_ENCRYPTION_KEY, or <data dir>/encryption.key.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clusterConfig } from './cluster/config';
import { database, dataDir, type Database } from './db';
import { onTablesChanged } from './db/replication';

export type ConfigStoreKind = 'files' | 'database';

/** LANDFLOW_CONFIG_STORE (`files` or `database`); unset: `database` in queue mode, else `files`. */
export function configStoreKind(env: NodeJS.ProcessEnv = process.env): ConfigStoreKind {
  const setting = env.LANDFLOW_CONFIG_STORE?.trim().toLowerCase();
  if (setting === 'database' || setting === 'db') return 'database';
  if (setting === 'files' || setting === 'file') return 'files';
  return clusterConfig(env).mode === 'queue' ? 'database' : 'files';
}

const importedKey = (name: string) => `config_store.imported.${name}`;

/**
 * Run `load` once per database for the file `name` (its import), recorded in `meta`. `load` writes with insertNew, so a
 * second process importing the same file at the same moment changes nothing, and rows written since are never replaced.
 */
export function importOnce(db: Database, name: string, load: () => void): void {
  if (db.get('SELECT value FROM meta WHERE key = ?', importedKey(name))) return;
  db.transaction(() => {
    load();
    db.upsert('meta', { key: importedKey(name), value: new Date().toISOString() });
  });
}

/** JSON through a temp file and a rename, so readers never see half a file (files mode). */
export function writeJsonFile(path: string, data: unknown, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const mtimeOf = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
};

export interface ConfigFileOptions {
  /** The data directory (default LANDFLOW_DATA_DIR). */
  dir?: () => string;
  /** The store kind (default configStoreKind()). */
  kind?: () => ConfigStoreKind;
  /** The database (default the process's). */
  db?: () => Database;
  /** Who writes, for `config_files.updated_by` (default LANDFLOW_INSTANCE_ID, or the pid). */
  writer?: string;
}

/**
 * One settings document of the data directory: `<data dir>/<name>` in files mode, the `config_files` row `name` in
 * database mode (the file imported once). Reads are cached until the file or the row changes (another process too).
 * Callers treat the value as theirs only until they write it back.
 */
export class ConfigFile<T> {
  private cached?: { stamp: string; value: T | undefined };

  constructor(
    readonly name: string,
    private readonly options: ConfigFileOptions = {},
  ) {}

  get kind(): ConfigStoreKind {
    return (this.options.kind ?? configStoreKind)();
  }

  /** The file's path (files mode, and the source of the one-time import). */
  get path(): string {
    return join((this.options.dir ?? dataDir)(), this.name);
  }

  private get db(): Database {
    return (this.options.db ?? database)();
  }

  read(): T | undefined {
    if (this.kind === 'files') {
      const stamp = `file:${mtimeOf(this.path)}`;
      if (this.cached?.stamp !== stamp) this.cached = { stamp, value: readJsonFile<T>(this.path) };
      return this.cached.value;
    }
    const db = this.db;
    importOnce(db, this.name, () => {
      const saved = readJsonFile<T>(this.path);
      if (saved !== undefined) db.insertNew('config_files', { name: this.name, data: JSON.stringify(saved), updated_at: new Date().toISOString(), updated_by: 'import' });
    });
    const row = db.get<{ updated_at: string; updated_by: string | null; size: number }>('SELECT updated_at, updated_by, length(data) AS size FROM config_files WHERE name = ?', this.name);
    const stamp = row ? `row:${row.updated_at}:${row.updated_by ?? ''}:${row.size}` : 'row:none';
    if (this.cached?.stamp !== stamp) {
      let value: T | undefined;
      try {
        const data = row && db.get<{ data: string }>('SELECT data FROM config_files WHERE name = ?', this.name)?.data;
        value = data ? (JSON.parse(data) as T) : undefined;
      } catch {
        value = undefined;
      }
      this.cached = { stamp, value };
    }
    return this.cached.value;
  }

  write(value: T): void {
    if (this.kind === 'files') {
      writeJsonFile(this.path, value);
      this.cached = { stamp: `file:${mtimeOf(this.path)}`, value };
      return;
    }
    const db = this.db;
    const updatedAt = new Date().toISOString();
    const data = JSON.stringify(value);
    const writer = this.options.writer ?? (process.env.LANDFLOW_INSTANCE_ID?.trim() || `pid-${process.pid}`);
    db.upsert('config_files', { name: this.name, data, updated_at: updatedAt, updated_by: writer });
    this.cached = { stamp: `row:${updatedAt}:${writer}:${data.length}`, value };
  }

  /** Forget the cached value (the next read goes to the file or the row). */
  invalidate(): void {
    this.cached = undefined;
  }
}

/**
 * Hear when another process changed one of these tables (Postgres replication, or the SQLite broadcast in queue mode).
 * Returns a function that stops listening.
 */
export function onConfigChanged(tables: Array<'credentials' | 'config_files'>, listener: () => void): () => void {
  return onTablesChanged((change) => {
    if (tables.some((table) => change.tables.has(table))) listener();
  });
}
