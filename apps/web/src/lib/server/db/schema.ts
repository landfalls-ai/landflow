/**
 * The database schema as versioned migrations. Each migration runs once, in order, inside a
 * transaction, and is recorded in `schema_version`. The SQL is written to run unchanged on SQLite and
 * Postgres: TEXT, BIGINT and DOUBLE PRECISION columns, JSON documents in TEXT, and
 * `ON CONFLICT` upserts. A migration that needs different SQL per dialect sets `postgres`.
 *
 * Never edit a migration that has shipped: add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  /** Statements for SQLite (and Postgres, unless `postgres` is set). */
  statements: string[];
  postgres?: string[];
}

export const SCHEMA_VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_version (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

      // A workflow document in `data`; the other columns are for listing and filtering.
      `CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active BIGINT NOT NULL DEFAULT 0,
        folder_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        data TEXT NOT NULL
      )`,

      // An execution: summary columns, the ExecutionSummary in `summary` and the whole record (run data included) in `data`.
      `CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        version_id TEXT,
        parent_id TEXT,
        retry_of TEXT,
        wait_until TEXT,
        summary TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS executions_started ON executions (started_at)`,
      `CREATE INDEX IF NOT EXISTS executions_workflow ON executions (workflow_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS executions_status ON executions (status)`,

      // Crash recovery: every node run of the running segment (untrimmed), and the scheduler state after the last finished main-flow node.
      `CREATE TABLE IF NOT EXISTS execution_steps (
        execution_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        node_id TEXT NOT NULL,
        run TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS execution_checkpoints (
        execution_id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        steps BIGINT NOT NULL,
        saved_at TEXT NOT NULL,
        state TEXT NOT NULL,
        base_steps BIGINT NOT NULL DEFAULT 0,
        base_outputs TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS poll_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)`,

      `CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        number BIGINT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        workflow TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS workflow_versions_workflow ON workflow_versions (workflow_id, number)`,

      `CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,

      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

      `CREATE TABLE IF NOT EXISTS variables (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,

      // Data Tables: the table (name, columns) in `data`; one row per table row, its cells in `data`.
      `CREATE TABLE IF NOT EXISTS data_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, next_row_id BIGINT NOT NULL DEFAULT 1, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS data_table_rows (table_id TEXT NOT NULL, id BIGINT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (table_id, id))`,

      // Trigger idempotency: a key seen within the retention window maps to the execution it started.
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        workflow_id TEXT NOT NULL,
        key TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, key)
      )`,
      `CREATE INDEX IF NOT EXISTS idempotency_keys_created ON idempotency_keys (created_at)`,

      // Automatic retries waiting for their time, by the failed execution they retry.
      `CREATE TABLE IF NOT EXISTS retries (execution_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, attempt BIGINT NOT NULL, due_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ],
  },
];

/** Every table with its primary key columns (upserts conflict on them; Postgres mode copies them at boot). */
export const TABLES = {
  meta: ['key'],
  workflows: ['id'],
  executions: ['id'],
  execution_steps: ['execution_id', 'seq'],
  execution_checkpoints: ['execution_id'],
  poll_state: ['key'],
  workflow_versions: ['id'],
  folders: ['id'],
  settings: ['key'],
  variables: ['key'],
  data_tables: ['id'],
  data_table_rows: ['table_id', 'id'],
  idempotency_keys: ['workflow_id', 'key'],
  retries: ['execution_id'],
} as const satisfies Record<string, readonly string[]>;

export type TableName = keyof typeof TABLES;

/** The newest schema version this build knows. */
export const LATEST_VERSION = MIGRATIONS.at(-1)!.version;
