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
  // 100–199: sign-in and access control (lib/server/auth).
  {
    version: 100,
    name: 'auth',
    statements: [
      // Users: a scrypt password hash (none for SSO-only users) and the OIDC identity they signed in with.
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT,
        oidc_issuer TEXT,
        oidc_subject TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)`,
      `CREATE INDEX IF NOT EXISTS users_oidc ON users (oidc_subject)`,
      // Sessions by the SHA-256 of their cookie token.
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT,
        method TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
      `CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at)`,
      // Personal API keys by the SHA-256 of the key; scopes as a JSON array.
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        hint TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash)`,
      `CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id)`,
      // One-time links: invites (kind 'invite', with the role) and password resets (kind 'reset', with the user).
      `CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        email TEXT NOT NULL,
        user_id TEXT,
        role TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_hash ON auth_tokens (token_hash)`,
      `CREATE INDEX IF NOT EXISTS auth_tokens_expires ON auth_tokens (expires_at)`,
    ],
  },
  // 200–299: safe deploys and triggers (draft/publish, app webhook triggers).
  {
    version: 200,
    name: 'workflow_publications',
    statements: [
      // The version production triggers run, per workflow (lib/server/publish.ts); no row = not published.
      `CREATE TABLE IF NOT EXISTS workflow_publications (
        workflow_id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT,
        note TEXT
      )`,
      // Every publish and unpublish, for the version history's timeline.
      `CREATE TABLE IF NOT EXISTS workflow_publish_log (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        action TEXT NOT NULL,
        version_id TEXT,
        version_number BIGINT,
        at TEXT NOT NULL,
        actor TEXT,
        note TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS workflow_publish_log_workflow ON workflow_publish_log (workflow_id, at)`,
      // Workflows that were active before draft/publish: their newest version (what they ran) counts as published.
      `INSERT INTO workflow_publications (workflow_id, version_id, published_at, published_by, note)
        SELECT w.id, (SELECT v.id FROM workflow_versions v WHERE v.workflow_id = w.id ORDER BY v.number DESC LIMIT 1),
          COALESCE(w.updated_at, w.created_at, '1970-01-01T00:00:00.000Z'), 'migration', 'Active before draft and publish'
        FROM workflows w
        WHERE w.active = 1 AND EXISTS (SELECT 1 FROM workflow_versions v WHERE v.workflow_id = w.id)
        ON CONFLICT (workflow_id) DO NOTHING`,
      `INSERT INTO workflow_publish_log (id, workflow_id, action, version_id, version_number, at, actor, note)
        SELECT 'pl_migrated_' || p.workflow_id, p.workflow_id, 'publish', p.version_id,
          (SELECT v.number FROM workflow_versions v WHERE v.id = p.version_id), p.published_at, p.published_by, p.note
        FROM workflow_publications p WHERE p.published_by = 'migration'
        ON CONFLICT (id) DO NOTHING`,
    ],
  },
  {
    version: 201,
    name: 'node_static_data',
    statements: [
      // A trigger node's static data (an app webhook's id and secret) and the registration the host made for it (lib/server/app-webhooks.ts).
      `CREATE TABLE IF NOT EXISTS node_static_data (
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        data TEXT NOT NULL,
        registration TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      )`,
    ],
  },
  // 400–499: chat and AI operations (streaming, hosted chat, AI usage and caps, Slack approvals, flow control).
  {
    version: 400,
    name: 'ai_usage',
    statements: [
      // One row per model call: tokens and estimated cost, by execution, workflow, agent and session (lib/server/ai-usage).
      `CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        execution_id TEXT,
        workflow_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS ai_usage_workflow ON ai_usage (workflow_id, day)`,
      `CREATE INDEX IF NOT EXISTS ai_usage_agent ON ai_usage (agent_id, day)`,
      `CREATE INDEX IF NOT EXISTS ai_usage_execution ON ai_usage (execution_id)`,
      `CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage (at)`,
    ],
  },
  {
    version: 401,
    name: 'chat_messages',
    statements: [
      // Hosted chat transcripts per workflow and session, for "Load previous session" (lib/server/chat).
      `CREATE TABLE IF NOT EXISTS chat_messages (
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT,
        PRIMARY KEY (workflow_id, session_id, seq)
      )`,
      `CREATE INDEX IF NOT EXISTS chat_messages_at ON chat_messages (at)`,
    ],
  },
  {
    version: 402,
    name: 'trigger_buffers',
    statements: [
      // Debounced and batched trigger events waiting for their run, so a restart doesn't lose them (lib/server/flow-control).
      `CREATE TABLE IF NOT EXISTS trigger_buffers (
        key TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        first_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        count BIGINT NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      )`,
    ],
  },
  // 500–599: evaluations (lib/server/evaluations).
  {
    version: 500,
    name: 'evaluation_runs',
    statements: [
      // An offline evaluation run over a Data Table (the EvaluationRunSummary in `data`), and one row per test case.
      `CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        number BIGINT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS evaluation_runs_workflow ON evaluation_runs (workflow_id, started_at)`,
      `CREATE TABLE IF NOT EXISTS evaluation_cases (
        run_id TEXT NOT NULL,
        idx BIGINT NOT NULL,
        execution_id TEXT,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, idx)
      )`,
      `CREATE INDEX IF NOT EXISTS evaluation_cases_execution ON evaluation_cases (execution_id)`,
      // Evaluation executions are left out of production counts (store.stats) and Insights.
      `ALTER TABLE executions ADD COLUMN evaluation_run_id TEXT`,
    ],
  },
  {
    version: 501,
    name: 'online_evaluations',
    statements: [
      // Online grading per agent (`agent:<id>`) or AI Agent node (`node:<workflowId>:<nodeId>`): its settings and the judge's scores.
      `CREATE TABLE IF NOT EXISTS online_eval_configs (target TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS online_eval_scores (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        created_at TEXT NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        flagged BIGINT NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS online_eval_scores_target ON online_eval_scores (target, created_at)`,
    ],
  },
  // 600–699: failure alerts (lib/server/alerts).
  {
    version: 600,
    name: 'alerts',
    statements: [
      // Where alerts go (email, Slack, webhook, Telegram) and which failures send them; settings in `data` (secrets sealed).
      `CREATE TABLE IF NOT EXISTS alert_channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BIGINT NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)`,
      // One throttle window per rule and workflow: alerts within it are counted, and sent as one digest when it ends.
      `CREATE TABLE IF NOT EXISTS alert_throttle (
        rule_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        window_until TEXT NOT NULL,
        suppressed BIGINT NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        PRIMARY KEY (rule_id, workflow_id)
      )`,
      // "Waiting too long" goes out once per execution and rule.
      `CREATE TABLE IF NOT EXISTS alert_waiting_sent (rule_id TEXT NOT NULL, execution_id TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (rule_id, execution_id))`,
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
  users: ['id'],
  sessions: ['id'],
  api_keys: ['id'],
  auth_tokens: ['id'],
  workflow_publications: ['workflow_id'],
  workflow_publish_log: ['id'],
  node_static_data: ['workflow_id', 'node_id'],
  ai_usage: ['id'],
  chat_messages: ['workflow_id', 'session_id', 'seq'],
  trigger_buffers: ['key'],
  evaluation_runs: ['id'],
  evaluation_cases: ['run_id', 'idx'],
  online_eval_configs: ['target'],
  online_eval_scores: ['id'],
  alert_channels: ['id'],
  alert_rules: ['id'],
  alert_throttle: ['rule_id', 'workflow_id'],
  alert_waiting_sent: ['rule_id', 'execution_id'],
} as const satisfies Record<string, readonly string[]>;

export type TableName = keyof typeof TABLES;

/** The newest schema version this build knows. */
export const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/**
 * The migrations a database still needs, in version order. Every migration not yet recorded runs, not just
 * those above the highest recorded version, so features developed side by side can number theirs in separate
 * ranges. A recorded version this build doesn't know means the database comes from a newer build.
 */
export function pendingMigrations(migrations: Migration[], done: number[]): Migration[] {
  const known = new Set(migrations.map((m) => m.version));
  const unknown = done.filter((v) => !known.has(v));
  if (unknown.length) {
    throw new Error(`The database has schema version ${Math.max(...unknown)}, newer than this Landflow build knows (${Math.max(...known)})`);
  }
  const applied = new Set(done);
  return migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
}
