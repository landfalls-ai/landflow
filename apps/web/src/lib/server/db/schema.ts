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
  /**
   * Columns added only where the table lacks them, before `statements`: for a column that a shipped migration's
   * `CREATE TABLE` gained later, so databases created before have it missing and newer ones have it already. SQLite checks
   * `PRAGMA table_info`; Postgres uses `ADD COLUMN IF NOT EXISTS`.
   */
  addColumns?: Array<{ table: string; column: string; definition: string }>;
}

/** The `ALTER TABLE … ADD COLUMN` of an `addColumns` entry (identifiers come from this file, never from input). */
export const addColumnSql = (c: { table: string; column: string; definition: string }, ifNotExists = false) =>
  `ALTER TABLE ${c.table} ADD COLUMN ${ifNotExists ? 'IF NOT EXISTS ' : ''}${c.column} ${c.definition}`;

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
  // 700–799: queue mode, workers and high availability (lib/server/cluster).
  {
    version: 700,
    name: 'plugin_registrations',
    statements: [
      // Plugins the mains' registries know (address, transport and manifest), so workers connect to them directly.
      `CREATE TABLE IF NOT EXISTS plugin_registrations (
        endpoint TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        version TEXT,
        registered_by TEXT,
        updated_at TEXT NOT NULL,
        manifest TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS plugin_registrations_plugin ON plugin_registrations (plugin_id)`,
    ],
  },
  // 800–899: projects, sharing, SAML and SCIM (lib/server/projects, lib/server/auth/saml.ts, lib/server/scim).
  {
    version: 800,
    name: 'projects',
    statements: [
      // Personal projects (one per user, `owner_id`) and team projects.
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        owner_id TEXT,
        description TEXT,
        icon TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id)`,
      // Members with a project role (admin, editor, viewer); `source` is who manages the row (a person, saml or scim).
      `CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT, PRIMARY KEY (project_id, user_id))`,
      `CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id)`,
      // The home project of each workflow, credential, data table and agent (credentials and agents live in files).
      `CREATE TABLE IF NOT EXISTS project_resources (kind TEXT NOT NULL, resource_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, resource_id))`,
      `CREATE INDEX IF NOT EXISTS project_resources_project ON project_resources (project_id, kind)`,
      // Workflows (editor/viewer) and credentials (user) shared with other projects.
      `CREATE TABLE IF NOT EXISTS resource_shares (
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        PRIMARY KEY (kind, resource_id, project_id)
      )`,
      `CREATE INDEX IF NOT EXISTS resource_shares_project ON resource_shares (project_id, kind)`,
      // Every existing user gets a personal project; what exists goes to the instance owner's (only inserts, nothing changes).
      // `WHERE true`: without a WHERE, SQLite reads `ON CONFLICT` after `FROM users u` as a join constraint.
      `INSERT INTO projects (id, name, type, owner_id, created_at, updated_at)
        SELECT 'personal_' || u.id, u.name, 'personal', u.id, u.created_at, u.created_at FROM users u WHERE true
        ON CONFLICT (id) DO NOTHING`,
      `INSERT INTO project_members (project_id, user_id, role, created_at, source)
        SELECT 'personal_' || u.id, u.id, 'admin', u.created_at, 'personal' FROM users u WHERE true
        ON CONFLICT (project_id, user_id) DO NOTHING`,
      `INSERT INTO project_resources (kind, resource_id, project_id, created_at)
        SELECT 'workflow', w.id, 'personal_' || u.id, COALESCE(w.created_at, u.created_at) FROM workflows w, users u WHERE u.role = 'owner'
        ON CONFLICT (kind, resource_id) DO NOTHING`,
      `INSERT INTO project_resources (kind, resource_id, project_id, created_at)
        SELECT 'dataTable', t.id, 'personal_' || u.id, u.created_at FROM data_tables t, users u WHERE u.role = 'owner'
        ON CONFLICT (kind, resource_id) DO NOTHING`,
    ],
  },
  {
    version: 801,
    name: 'saml_scim',
    statements: [
      // Deactivated users (SCIM `active: false`) can't sign in; SAML identities; the IdP's id of a provisioned user.
      `ALTER TABLE users ADD COLUMN disabled_at TEXT`,
      `ALTER TABLE users ADD COLUMN saml_issuer TEXT`,
      `ALTER TABLE users ADD COLUMN saml_subject TEXT`,
      `ALTER TABLE users ADD COLUMN external_id TEXT`,
      `ALTER TABLE users ADD COLUMN provisioned_by TEXT`,
      `CREATE INDEX IF NOT EXISTS users_saml ON users (saml_subject)`,
      `CREATE INDEX IF NOT EXISTS users_external ON users (external_id)`,
      // SAML response and assertion ids seen, until they expire (replay protection).
      `CREATE TABLE IF NOT EXISTS saml_replay (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS saml_replay_expires ON saml_replay (expires_at)`,
      // SCIM groups and their members; a mapping turns them into project memberships or instance roles.
      `CREATE TABLE IF NOT EXISTS scim_groups (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS scim_group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (group_id, user_id))`,
      `CREATE INDEX IF NOT EXISTS scim_group_members_user ON scim_group_members (user_id)`,
    ],
  },
  // 900–999: governance (lib/server/audit, lib/server/governance).
  {
    version: 900,
    name: 'audit_log',
    statements: [
      // Who did what, when and from where; `details` is a flat JSON object of ids, names and counts (never bodies or secrets).
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        category TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT,
        actor_email TEXT,
        api_key_id TEXT,
        ip TEXT,
        user_agent TEXT,
        request_id TEXT,
        method TEXT,
        route TEXT,
        status BIGINT,
        target_type TEXT,
        target_id TEXT,
        target_name TEXT,
        summary TEXT NOT NULL,
        details TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at)`,
      `CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events (actor_id, at)`,
      `CREATE INDEX IF NOT EXISTS audit_events_action ON audit_events (action, at)`,
      `CREATE INDEX IF NOT EXISTS audit_events_target ON audit_events (target_type, target_id, at)`,
      // SIEM destinations (syslog, HTTP, Splunk HEC); settings in `data`, secrets sealed.
      `CREATE TABLE IF NOT EXISTS audit_destinations (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled BIGINT NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)`,
      // The durable outbox: one row per event and destination until it is delivered; retried with backoff.
      `CREATE TABLE IF NOT EXISTS audit_outbox (
        destination_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts BIGINT NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        PRIMARY KEY (destination_id, event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS audit_outbox_due ON audit_outbox (destination_id, next_at)`,
    ],
  },
  {
    version: 901,
    name: 'publish_requests',
    statements: [
      // Four-eyes publishing: a publish, rollback or unpublish waiting for (or decided by) a second person.
      `CREATE TABLE IF NOT EXISTS publish_requests (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        version_id TEXT,
        draft_version_id TEXT,
        base_version_id TEXT,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        note TEXT,
        comment TEXT,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS publish_requests_workflow ON publish_requests (workflow_id, status)`,
      `CREATE INDEX IF NOT EXISTS publish_requests_status ON publish_requests (status, requested_at)`,
    ],
  },
  // 1000–1099: external secrets and environments (lib/server/secrets, lib/server/environments).
  {
    version: 1000,
    name: 'external_secret_providers',
    statements: [
      // An external secrets provider (`$secrets.<name>`): non-secret settings in `settings`, the secret ones sealed in `secrets`,
      // the secret names of the last connect or refresh in `names` (never values), the last test in `last_check`.
      `CREATE TABLE IF NOT EXISTS external_secret_providers (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        enabled BIGINT NOT NULL DEFAULT 1,
        settings TEXT NOT NULL,
        secrets TEXT,
        names TEXT,
        last_check TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 1001,
    name: 'variable_environment_values',
    statements: [
      // A variable's value in one environment: `$vars.KEY` reads it on an instance whose LANDFLOW_ENVIRONMENT matches.
      `CREATE TABLE IF NOT EXISTS variable_environment_values (
        key TEXT NOT NULL,
        environment TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key, environment)
      )`,
    ],
  },
  // 1100–1199: templates library (lib/server/templates).
  {
    version: 1100,
    name: 'templates',
    statements: [
      // Templates saved on this instance ("Save as template", imported template files): the template document in `data`
      // (workflow without credentials or pinned data, credential slots, setup steps, data tables); built-in ones ship in code.
      `CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
    ],
  },
  // 1400–1499: projects for folders, variables, plugins, templates; per-project and per-workflow governance (lib/server/projects).
  {
    version: 1400,
    name: 'project_folders_variables',
    statements: [
      // A folder belongs to one project (its subfolders too); NULL is the default project (the instance owner's personal one).
      `ALTER TABLE folders ADD COLUMN project_id TEXT`,
      `CREATE INDEX IF NOT EXISTS folders_project ON folders (project_id)`,
      // Existing folder trees go to the project most of their workflows are in…
      `UPDATE folders SET project_id = (
        WITH RECURSIVE tree (id, root) AS (
          SELECT f.id, f.id FROM folders f WHERE f.parent_id IS NULL OR f.parent_id NOT IN (SELECT p.id FROM folders p)
          UNION ALL
          SELECT c.id, t.root FROM folders c JOIN tree t ON c.parent_id = t.id
        )
        SELECT pr.project_id FROM tree mine
          JOIN tree t ON t.root = mine.root
          JOIN workflows w ON w.folder_id = t.id
          JOIN project_resources pr ON pr.kind = 'workflow' AND pr.resource_id = w.id
        WHERE mine.id = folders.id
        GROUP BY pr.project_id ORDER BY COUNT(*) DESC, pr.project_id LIMIT 1
      ) WHERE project_id IS NULL`,
      // …else to the instance owner's personal project.
      `UPDATE folders SET project_id = (SELECT 'personal_' || u.id FROM users u WHERE u.role = 'owner' ORDER BY u.created_at LIMIT 1) WHERE project_id IS NULL`,
      // Project variables: `$vars.KEY` reads the workflow's project's value first, then the instance's.
      `CREATE TABLE IF NOT EXISTS project_variables (project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, key))`,
      // A project variable's value in one environment (as variable_environment_values, migration 1001, for instance variables).
      `CREATE TABLE IF NOT EXISTS project_variable_environment_values (
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        environment TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key, environment)
      )`,
    ],
  },
  {
    version: 1401,
    name: 'project_and_workflow_policies',
    statements: [
      // A project's settings: the plugins and node types its workflows may use, who approves its publish requests.
      `CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
      // A workflow's own, stricter policy: four-eyes publishing, a node allow-list.
      `CREATE TABLE IF NOT EXISTS workflow_policies (workflow_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
      // Saved templates belong to a project; NULL is instance-wide (what existed, and what owners and admins publish).
      `ALTER TABLE templates ADD COLUMN project_id TEXT`,
      `CREATE INDEX IF NOT EXISTS templates_project ON templates (project_id)`,
    ],
  },
  // 1200–1299: sub-workflows that wait, test URLs and trigger auth (lib/server/sub-executions.ts, lib/server/binary).
  {
    version: 1200,
    name: 'binary_scope_links',
    statements: [
      // A sub-execution its parent waits for writes its files into the parent's scope (`scope`), so the files it returns
      // live as long as the parent run: kept here, not only in memory, so a restart or another worker keeps the link.
      `CREATE TABLE IF NOT EXISTS binary_scope_links (execution_id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS binary_scope_links_scope ON binary_scope_links (scope)`,
    ],
  },
  // 1300–1399: queue mode without a shared data directory: credentials and settings files in the database (lib/server/config-store.ts).
  {
    version: 1300,
    name: 'config_store',
    statements: [
      // Credentials when LANDFLOW_CONFIG_STORE=database (the default in queue mode): one row per credential, `data` the
      // AES-256-GCM sealed values (JSON {iv, tag, value}) as in credentials.json; the key stays where it is.
      `CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        secret_fields TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The data directory's settings files in that mode (mcp.json, marketplaces.json, skill-library.json, agent-channels.json): one JSON document each.
      `CREATE TABLE IF NOT EXISTS config_files (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
    ],
  },
  // 1500–1599: the audit log per project and its hash chain, SAML state shared by every main (lib/server/audit, lib/server/auth/saml*).
  {
    version: 1500,
    name: 'audit_projects_and_chain',
    statements: [
      // The project of the event's target (workflow, credential, data table, agent, an execution's workflow, a project); NULL for
      // instance-wide events and for events recorded before this migration.
      `ALTER TABLE audit_events ADD COLUMN project_id TEXT`,
      // Tamper evidence (lib/server/audit/chain.ts): the event's place in the chain, the previous event's hash and its own
      // (SHA-256 over its stored fields). NULL for events recorded before the chain began (and, in queue mode on Postgres, until sealed).
      `ALTER TABLE audit_events ADD COLUMN chain_seq BIGINT`,
      `ALTER TABLE audit_events ADD COLUMN prev_hash TEXT`,
      `ALTER TABLE audit_events ADD COLUMN hash TEXT`,
      `CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events (project_id, at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain ON audit_events (chain_seq)`,
      // The chain's ends: `head` (the newest chained event), `anchor` (the last event retention pruned), `start` (the newest event
      // from before the chain began, in `event_id`).
      `CREATE TABLE IF NOT EXISTS audit_chain (id TEXT PRIMARY KEY, seq BIGINT NOT NULL, hash TEXT NOT NULL, event_id TEXT, at TEXT, updated_at TEXT NOT NULL)`,
    ],
  },
  {
    version: 1501,
    name: 'saml_state',
    statements: [
      // SAML sign-ins and logouts in flight, readable by every main: RelayStates (`relay`), the AuthnRequest and LogoutRequest ids
      // InResponseTo must match (`request`, one use) and the NameID and SessionIndex of SAML sessions for single logout (`session`).
      `CREATE TABLE IF NOT EXISTS saml_state (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (kind, id))`,
      `CREATE INDEX IF NOT EXISTS saml_state_expires ON saml_state (expires_at)`,
      `CREATE INDEX IF NOT EXISTS saml_state_user ON saml_state (kind, user_id)`,
    ],
  },
  // 1650–1699: environments, promotion approvals (lib/server/environments/approvals.ts).
  {
    version: 1650,
    name: 'promotion_requests',
    statements: [
      // Four-eyes on promotion: a promotion to another environment waiting for (or decided by) a second person. `input` is what was
      // asked for (target, workflows, prune, force, message, row tables), `digest` what its preview would write, `data` the preview.
      `CREATE TABLE IF NOT EXISTS promotion_requests (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        digest TEXT NOT NULL,
        input TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        comment TEXT,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS promotion_requests_status ON promotion_requests (status, requested_at)`,
    ],
  },
  // 1700–1709: transports (docs/transports.md; lib/server/transports): the per-plugin transport policy and broker connections.
  {
    version: 1700,
    name: 'plugin_transport_policies',
    statements: [
      // One row per plugin with a non-default policy: `policy` is the JSON { mode, pinned?, allowed?, objective } (lib/shared/transports.ts).
      // Shared by mains and workers in queue mode; it replaces the registry's in-memory preferredTransport.
      `CREATE TABLE IF NOT EXISTS plugin_transport_policies (
        plugin_id TEXT PRIMARY KEY,
        policy TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`,
    ],
  },
  {
    version: 1701,
    name: 'transport_connections',
    statements: [
      // Broker connections (Settings → Transports): `config` the non-secret fields as JSON, `secrets` the secret fields sealed with
      // the credential vault's key (`v1.<iv>.<tag>.<ciphertext>`, like alert channel secrets), `last_check` the last Test's result.
      `CREATE TABLE IF NOT EXISTS transport_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled BIGINT NOT NULL DEFAULT 1,
        config TEXT NOT NULL,
        secrets TEXT,
        last_check TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS transport_connections_kind ON transport_connections (kind)`,
    ],
  },
  // 1720–1722: the per-plugin MCP endpoints (docs/transports.md "Expose to agents"; lib/server/mcp/plugin-servers.ts).
  {
    version: 1720,
    name: 'plugin_mcp_exposure',
    statements: [
      // One row per plugin whose "Expose to agents" differs from the default (on): `exposed` 0 hides the plugin's tools from
      // the gateway and its /api/mcp/plugins/<id> endpoint. Shared by mains and workers in queue mode (lib/server/mcp/exposure.ts).
      `CREATE TABLE IF NOT EXISTS plugin_mcp_exposure (
        plugin_id TEXT PRIMARY KEY,
        exposed BIGINT NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )`,
    ],
  },
  // 1723–1729: MCP identity and catalog (docs/transports.md "Sign-in and identity", docs/protocol.md §15.4–15.5; lib/server/mcp).
  {
    version: 1723,
    name: 'mcp_tokens',
    statements: [
      // Landflow-issued MCP tokens (Settings → MCP): signed JWTs whose `jti` is the row id; `token_hash` is the SHA-256 of the
      // whole JWT (shown once), `scopes` a JSON list, `revoked_at` set when revoked (the host checks it on every call).
      `CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        hint TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_tokens_user ON mcp_tokens (user_id)`,
    ],
  },
  {
    version: 1724,
    name: 'mcp_grants',
    statements: [
      // Tool grants (§15.5): who (`subject_kind` user | group | project | role | token, `subject_id`) may use which tools of a plugin
      // (`tools` is the JSON list of tool names, `!name` excludes, or the string "*"), with the credential to bind per credential
      // type (`credentials` JSON) and whether destructive tools need an approval (`require_approval` 1/0, NULL = instance default).
      `CREATE TABLE IF NOT EXISTS mcp_grants (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        tools TEXT NOT NULL,
        credentials TEXT NOT NULL,
        require_approval BIGINT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_grants_subject ON mcp_grants (subject_kind, subject_id)`,
      `CREATE INDEX IF NOT EXISTS mcp_grants_plugin ON mcp_grants (plugin_id)`,
    ],
  },
  {
    version: 1725,
    name: 'mcp_catalog_servers',
    statements: [
      // The MCP registry catalog (§15.4): one row per plugin version ever exposed, `server_json` its server.json, `status`
      // active | deprecated | deleted as plugins come and go (the registry API answers from here, refreshed from the plugin registry).
      `CREATE TABLE IF NOT EXISTS mcp_catalog_servers (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        status TEXT NOT NULL,
        server_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (name, version)
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_catalog_servers_plugin ON mcp_catalog_servers (plugin_id)`,
    ],
  },
  // 1730–1739: the MCP gateway sync (docs/transports.md "Automatic registration"; lib/server/mcp/gateway-sync.ts).
  {
    version: 1730,
    name: 'mcp_gateway_resources',
    statements: [
      // The gateway resources Landflow created (`kind` mcp.target | traffic.route, `name` = the resource id in agentgateway) for
      // which plugin, so the sync changes only its own targets and routes and leaves what an admin added in the gateway alone.
      `CREATE TABLE IF NOT EXISTS mcp_gateway_resources (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, name)
      )`,
    ],
  },
  // 1750–1759: approvals for destructive MCP tools (lib/server/mcp/approvals.ts).
  {
    version: 1750,
    name: 'mcp_grants_approval_mode',
    statements: [
      // When a grant's tools need a person's OK: `always` | `destructive` | `never` (NULL = the instance default, destructive). Replaces
      // the older boolean `require_approval` (still written and read as an alias: 1 = destructive, 0 = never); existing values carry over.
      `ALTER TABLE mcp_grants ADD COLUMN approval_mode TEXT`,
      `UPDATE mcp_grants SET approval_mode = 'destructive' WHERE require_approval = 1`,
      `UPDATE mcp_grants SET approval_mode = 'never' WHERE require_approval = 0`,
    ],
  },
  {
    version: 1751,
    name: 'mcp_approvals',
    statements: [
      // An MCP tool call waiting for a person (`status` pending | approved | denied | expired | used). `args_hash` binds the answer to the
      // exact arguments, `summary` is what the approver sees (clipped), `credentials` the names of the bound credentials (JSON), `used_at` is set when a retried call consumes an approval.
      `CREATE TABLE IF NOT EXISTS mcp_approvals (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        caller_user_id TEXT,
        args_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        credentials TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        used_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_approvals_status ON mcp_approvals (status, created_at)`,
      `CREATE INDEX IF NOT EXISTS mcp_approvals_call ON mcp_approvals (plugin_id, tool, args_hash)`,
    ],
  },
  // 1770–1779: triggers as MCP resources (lib/server/mcp/triggers.ts).
  {
    version: 1770,
    name: 'mcp_trigger_subscriptions',
    statements: [
      // One row per (caller, trigger URI) a client subscribed to. `node` is the registered node (type, parameters, bound credentials) that
      // `delete` of an app webhook needs once the subscription is gone, `static_data` what the plugin stored for the hook, `poll_state` the poll
      // state (`ready` 0 until the baseline poll ran). `heartbeat_at` is the owning main's pulse: a row nobody pulses for is an orphan, and the
      // sweep removes its webhook. `stopping` marks a subscription whose last stream ended: nothing runs for it, its events stay readable for a while.
      `CREATE TABLE IF NOT EXISTS mcp_trigger_subs (
        sub_key TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        uri TEXT NOT NULL,
        user_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        node TEXT NOT NULL,
        static_data TEXT NOT NULL,
        poll_state TEXT,
        ready INTEGER NOT NULL DEFAULT 0,
        registered INTEGER NOT NULL DEFAULT 0,
        stopping INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        polls INTEGER NOT NULL DEFAULT 0,
        last_polled_at TEXT,
        last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS mcp_trigger_subs_user ON mcp_trigger_subs (user_key)`,
      // The newest events of a subscription (`id` sorts by time), pruned to a few dozen; `item` is the node item as JSON.
      `CREATE TABLE IF NOT EXISTS mcp_trigger_events (
        sub_key TEXT NOT NULL,
        id TEXT NOT NULL,
        at TEXT NOT NULL,
        item TEXT NOT NULL,
        PRIMARY KEY (sub_key, id)
      )`,
    ],
  },
  // 1780: the checkpoint columns that migration 1 gained on 2026-10-25 (resumed segments), for databases created before.
  {
    version: 1780,
    name: 'execution_checkpoints_base',
    statements: [],
    addColumns: [
      { table: 'execution_checkpoints', column: 'base_steps', definition: 'BIGINT NOT NULL DEFAULT 0' },
      { table: 'execution_checkpoints', column: 'base_outputs', definition: 'TEXT' },
    ],
  },
  // 1820–1829 (wave 6): alert monitors' state, cached-token and per-user/credential AI usage.
  {
    version: 1820,
    name: 'alert_state',
    statements: [
      // What the time-based alert rules remember between ticks (lib/server/alerts/monitors.ts): the window a failure-rate alert
      // was sent for, a plugin's offline spell, the period a cost threshold was reported for, the evaluation run last checked.
      `CREATE TABLE IF NOT EXISTS alert_state (
        rule_id TEXT NOT NULL,
        key TEXT NOT NULL,
        expires_at TEXT,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (rule_id, key)
      )`,
    ],
  },
  {
    version: 1821,
    name: 'ai_usage_cache_user_credential',
    statements: [
      `CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage (user_id, day)`,
      `CREATE INDEX IF NOT EXISTS ai_usage_credential ON ai_usage (credential_id, day)`,
    ],
    addColumns: [
      // Cached input tokens (a part of input_tokens): Anthropic cache reads and writes, OpenAI cached input.
      { table: 'ai_usage', column: 'cache_read_tokens', definition: 'BIGINT NOT NULL DEFAULT 0' },
      { table: 'ai_usage', column: 'cache_write_tokens', definition: 'BIGINT NOT NULL DEFAULT 0' },
      // Who started the run and which model credential made the call (caps per user and per credential).
      { table: 'ai_usage', column: 'user_id', definition: 'TEXT' },
      { table: 'ai_usage', column: 'credential_id', definition: 'TEXT' },
    ],
  },
  {
    version: 1822,
    name: 'evaluation_settings',
    statements: [
      // Per workflow: the uploaded file dataset (its bytes are in the binary store under `scope`) and the evaluation schedule (lib/server/evaluations).
      `CREATE TABLE IF NOT EXISTS evaluation_settings (
        workflow_id TEXT PRIMARY KEY,
        scope TEXT,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS evaluation_settings_scope ON evaluation_settings (scope)`,
    ],
  },
  // 1830–1839 (wave 6, triggers and agent channels): approval emails.
  {
    version: 1830,
    name: 'approval_email_used',
    statements: [
      // The approve / reject links of approval emails are signed and carry everything they need; this table only makes them single-use:
      // one row per link group (an approve and a reject link of one tool call share the group), inserted by whoever uses a link first
      // (lib/server/approval-email.ts). `expires_at` lets old rows go.
      `CREATE TABLE IF NOT EXISTS approval_email_used (
        group_id TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        email TEXT NOT NULL,
        used_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 1840,
    name: 'scheduled_publishes',
    statements: [
      // Publish or unpublish a saved version at a chosen time (lib/server/publish-schedule.ts). `request_id` is the four-eyes publish request that approves it.
      `CREATE TABLE IF NOT EXISTS scheduled_publishes (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        action TEXT NOT NULL,
        version_id TEXT,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        request_id TEXT,
        finished_at TEXT,
        result TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS scheduled_publishes_workflow ON scheduled_publishes (workflow_id, run_at)`,
      `CREATE INDEX IF NOT EXISTS scheduled_publishes_due ON scheduled_publishes (status, run_at)`,
    ],
  },
  // 1860–1869 (wave 6, chat and rate limits): chat feedback, credential rate limits.
  {
    version: 1860,
    name: 'chat_feedback',
    statements: [
      // Thumbs up/down (and a comment) on an answer: of a hosted chat or widget (an execution of a public Chat trigger workflow),
      // of the editor, or of an agent session (lib/server/chat-feedback.ts). One row per answer: `id` is `execution:<id>` or
      // `agent:<session>:<entry>`.
      `CREATE TABLE IF NOT EXISTS chat_feedback (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workflow_id TEXT,
        execution_id TEXT,
        agent_id TEXT,
        session_id TEXT,
        entry_id TEXT,
        rating TEXT NOT NULL,
        comment TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS chat_feedback_workflow ON chat_feedback (workflow_id, updated_at)`,
      `CREATE INDEX IF NOT EXISTS chat_feedback_agent ON chat_feedback (agent_id, session_id)`,
      `CREATE INDEX IF NOT EXISTS chat_feedback_execution ON chat_feedback (execution_id)`,
    ],
  },
  {
    version: 1861,
    name: 'credential_rate_limit',
    statements: [],
    // A rate limit set on a credential (JSON {limit, intervalSeconds}); not secret, so it sits next to the sealed data (lib/server/credentials/vault.ts).
    addColumns: [{ table: 'credentials', column: 'rate_limit', definition: 'TEXT' }],
  },
  // 1870–1879 (wave 6, MCP): the instance MCP server per project (lib/server/mcp/project-servers.ts).
  {
    version: 1870,
    name: 'mcp_token_project',
    statements: [],
    // A Landflow MCP token scoped to one project: the instance MCP server then lists and changes only that project's workflows.
    addColumns: [{ table: 'mcp_tokens', column: 'project_id', definition: 'TEXT' }],
  },
  {
    version: 1871,
    name: 'mcp_project_servers',
    statements: [
      // Projects whose scoped MCP server (/api/mcp/projects/<id>) the gateway sync registers a route for.
      `CREATE TABLE IF NOT EXISTS mcp_project_servers (
        project_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  // 1880–1889 (wave 6, queue mode at scale and the audit log): evaluation run heartbeats, agents in the database, audit signing.
  {
    version: 1880,
    name: 'evaluation_run_heartbeat',
    statements: [],
    // A running evaluation's process saves this every few seconds, so another main doesn't take it for one a restart interrupted
    // (lib/server/evaluations/runner.ts `settleInterrupted`).
    addColumns: [{ table: 'evaluation_runs', column: 'heartbeat_at', definition: 'TEXT' }],
  },
  {
    version: 1881,
    name: 'agents_in_database',
    statements: [
      // Agents, their sessions and cross-session memories when LANDFLOW_CONFIG_STORE=database (the default in queue mode):
      // `data` is the document the files hold (agents/, agent-sessions/, agent-memory/), imported once (lib/server/agents/store.ts).
      `CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      // `summary` is the SessionSummary (the list needs no timeline); `conversation_key` finds a channel conversation's session.
      `CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        conversation_key TEXT,
        updated_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_sessions_agent ON agent_sessions (agent_id, updated_at)`,
      `CREATE INDEX IF NOT EXISTS agent_sessions_conversation ON agent_sessions (agent_id, conversation_key)`,
      // One row per agent and user: the notes the agent remembers across sessions (a JSON array).
      `CREATE TABLE IF NOT EXISTS agent_memory (
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (agent_id, user_id)
      )`,
    ],
  },
  {
    version: 1882,
    name: 'audit_signed_heads',
    statements: [
      // Ed25519 keys that sign the audit chain's head (lib/server/audit/signing.ts): the public key (SPKI PEM) and the private key
      // sealed with the credentials key. A retired key stays so older heads verify.
      `CREATE TABLE IF NOT EXISTS audit_signing_keys (
        key_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      )`,
      // Signed heads, one per chain sequence number (the envelope as JSON), and whether they reached the anchor stores.
      `CREATE TABLE IF NOT EXISTS audit_heads (
        seq BIGINT PRIMARY KEY,
        signed_at TEXT NOT NULL,
        key_id TEXT NOT NULL,
        envelope TEXT NOT NULL,
        anchored_at TEXT,
        anchor_error TEXT
      )`,
    ],
  },
  {
    version: 1883,
    name: 'composite_types',
    statements: [
      // Composite types saved on this instance (lib/server/composites.ts, docs/composites.md), listed as `local.<name>`: one row
      // per version, `data` the CompositeTypeDescriptor. Frames pin a version, so older ones stay until the type is deleted.
      `CREATE TABLE IF NOT EXISTS composite_types (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (name, version)
      )`,
    ],
  },
  {
    version: 1890,
    name: 'second_brain',
    statements: [
      // The usage ledger (lib/server/usage, docs/second-brain.md): one row per thing that happened, metadata only. Kept
      // USAGE_RETENTION_DAYS (90); `attrs` is a small JSON object.
      `CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        workflow_id TEXT,
        node_id TEXT,
        node_type TEXT,
        agent_id TEXT,
        actor_id TEXT,
        execution_id TEXT,
        signature TEXT,
        message TEXT,
        duration_ms DOUBLE PRECISION,
        items BIGINT,
        tokens BIGINT,
        cost DOUBLE PRECISION,
        attrs TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at)`,
      `CREATE INDEX IF NOT EXISTS usage_events_kind ON usage_events (kind, at)`,
      `CREATE INDEX IF NOT EXISTS usage_events_workflow ON usage_events (workflow_id, at)`,
      `CREATE INDEX IF NOT EXISTS usage_events_signature ON usage_events (signature)`,
      // Daily rollups of the ledger, recomputed from it for recent days and kept 400 days ('' for an absent key column).
      `CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        workflow_id TEXT NOT NULL DEFAULT '',
        node_type TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        count BIGINT NOT NULL DEFAULT 0,
        failures BIGINT NOT NULL DEFAULT 0,
        duration_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
        duration_max DOUBLE PRECISION NOT NULL DEFAULT 0,
        items BIGINT NOT NULL DEFAULT 0,
        tokens BIGINT NOT NULL DEFAULT 0,
        cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kind, workflow_id, node_type, signature, agent_id)
      )`,
      // What the brain knows about each workflow, agent, node type and credential (lib/server/brain/study.ts); `data` is
      // the BrainProfile.
      `CREATE TABLE IF NOT EXISTS brain_profiles (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        project_id TEXT,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (subject_type, subject_id)
      )`,
      // Facts with their evidence (lib/server/brain/facts.ts); `data` is the BrainFact.
      `CREATE TABLE IF NOT EXISTS brain_facts (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS brain_facts_subject ON brain_facts (subject_type, subject_id)`,
      // Suggestions (lib/server/brain/proposals.ts); `data` is the Proposal. One open suggestion per fingerprint.
      `CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,
        detector TEXT,
        project_id TEXT,
        workflow_id TEXT,
        status TEXT NOT NULL,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS proposals_fingerprint ON proposals (fingerprint)`,
      `CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, score)`,
      `CREATE INDEX IF NOT EXISTS proposals_workflow ON proposals (workflow_id, status)`,
    ],
  },
  {
    version: 1900,
    name: 'agent_templates',
    statements: [
      // Personas saved from agents to start new ones from (lib/server/agents/templates.ts, docs/agents.md#templates): shared
      // in a project, or the whole instance when project_id is NULL. `data` is the template without its id, name and
      // project; built-in ones ship in code.
      `CREATE TABLE IF NOT EXISTS agent_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 1910,
    name: 'agent_teams',
    statements: [
      // Agent teams (lib/server/agent-teams/store.ts, docs/agent-teams.md): agents with standing relations. `draft` is the
      // AgentTeamConfig being edited, `published` the version flows run (NULL until first published) with its `version`.
      // The project is kept with the other resources' homes (projects/store.ts), not here.
      `CREATE TABLE IF NOT EXISTS agent_teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        draft TEXT NOT NULL,
        published TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2000,
    name: 'execution_events',
    statements: [
      // The Run Trace journal (lib/server/journal, docs/run-trace.md): the events of one execution in order. `data` is the
      // whole JournalEvent; the other columns are for reading and pruning. Kept LANDFLOW_TRACE_RETENTION_DAYS (30).
      `CREATE TABLE IF NOT EXISTS execution_events (
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        trace_id TEXT,
        data TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      )`,
      `CREATE INDEX IF NOT EXISTS execution_events_at ON execution_events (at)`,
    ],
  },
  {
    version: 2010,
    name: 'team_notes',
    statements: [
      // The team notebook (lib/server/notebook/store.ts, docs/team-notebook.md): typed notes a team's members write while a run
      // goes, kept per run, per team or per project. `source` is JSON ({ executionId, spanId, tool, url, excerpt });
      // `embedding` a JSON array of numbers (NULL until made, e.g. when Ollama is unreachable); `tainted` is 1 for a note read
      // from outside the team; `dispute_of` and `superseded_by` link two notes that disagree.
      `CREATE TABLE IF NOT EXISTS team_notes (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        project_id TEXT,
        run_id TEXT,
        workflow_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        author TEXT NOT NULL,
        author_id TEXT,
        source TEXT NOT NULL,
        tainted INTEGER NOT NULL DEFAULT 0,
        answer TEXT,
        embedding TEXT,
        embedding_model TEXT,
        dispute_of TEXT,
        superseded_by TEXT,
        promoted_from TEXT,
        proposal_id TEXT,
        verified_at TEXT,
        verified_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_access_at TEXT NOT NULL,
        expires_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS team_notes_team ON team_notes (team_id, scope)`,
      `CREATE INDEX IF NOT EXISTS team_notes_run ON team_notes (run_id)`,
      `CREATE INDEX IF NOT EXISTS team_notes_expires ON team_notes (expires_at)`,
    ],
  },
  {
    version: 2040,
    name: 'agent_asks',
    statements: [
      // Commands a Claude Code member's guard asks a person about (lib/server/a2a/agent-asks.ts, docs/a2a.md): one row per ask,
      // where the trace route that takes the ask, the route that records the decision and the route the mod polls meet (in queue
      // mode they run in different processes). `trace_key` is a hash of the call's trace id (the id is the mod's credential),
      // `mod_id` the id the mod gave the ask, `status` pending | approved | denied | expired | canceled.
      `CREATE TABLE IF NOT EXISTS agent_asks (
        id TEXT PRIMARY KEY,
        trace_key TEXT NOT NULL,
        mod_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT NOT NULL,
        member TEXT,
        command TEXT NOT NULL,
        cwd TEXT,
        reason TEXT,
        status TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_asks_trace ON agent_asks (trace_key, mod_id)`,
      `CREATE INDEX IF NOT EXISTS agent_asks_execution ON agent_asks (execution_id, status)`,
    ],
  },
  {
    version: 2041,
    name: 'agent_asks_edited_command',
    statements: [
      // The command a person changed before allowing it (lib/server/a2a/agent-asks.ts): the mod runs this one instead of its own.
      `ALTER TABLE agent_asks ADD COLUMN edited_command TEXT`,
    ],
  },
  {
    version: 2042,
    name: 'agent_eval_gate',
    statements: [
      // Test cases a standalone agent is checked against before a publish (lib/server/agents/eval-gate.ts), and each run of them.
      // `data` is the case or the run (with every case's reply, score and reasoning); `average` and `version` list runs without parsing it.
      `CREATE TABLE IF NOT EXISTS agent_eval_cases (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_eval_cases_agent ON agent_eval_cases (agent_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS agent_eval_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        average REAL NOT NULL,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_eval_runs_agent ON agent_eval_runs (agent_id, created_at)`,
    ],
  },
  {
    version: 2043,
    name: 'agent_response_cache',
    statements: [
      // Answers of agents with the response cache on (lib/server/agents/response-cache.ts). `id` is a hash of the agent's config and
      // the question; `expires_at` is an ISO time; `hits` counts the times the answer was served again.
      `CREATE TABLE IF NOT EXISTS agent_response_cache (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        reply TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_response_cache_agent ON agent_response_cache (agent_id, expires_at)`,
    ],
  },
  {
    version: 2044,
    name: 'agent_semantic_cache',
    statements: [
      // Questions kept with their embedding for the semantic cache (lib/server/agents/semantic-cache.ts). `config_hash` is a hash of the agent's
      // answer-shaping config, so an edit starts a fresh cache; `vector` is a JSON array of numbers; `hits` counts the times it was served.
      `CREATE TABLE IF NOT EXISTS agent_semantic_cache (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        question TEXT NOT NULL,
        reply TEXT NOT NULL,
        vector TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_semantic_cache_agent ON agent_semantic_cache (agent_id, config_hash, expires_at)`,
    ],
  },
  {
    version: 2045,
    name: 'debug_tokens',
    statements: [
      // Debug tokens (docs/specs/19-debug-token.md, lib/server/auth/debug-tokens.ts): short-lived, read-only, bound to one
      // execution; only the SHA-256 of the token is kept. `scopes` is a JSON list, `use_count` counts audited tool calls.
      `CREATE TABLE IF NOT EXISTS debug_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        hint TEXT NOT NULL,
        label TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_by TEXT,
        last_used_at TEXT,
        use_count BIGINT NOT NULL DEFAULT 0
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS debug_tokens_hash ON debug_tokens (token_hash)`,
      `CREATE INDEX IF NOT EXISTS debug_tokens_execution ON debug_tokens (execution_id)`,
    ],
  },
  {
    version: 2062,
    name: 'usage_kinds',
    statements: [
      // Custom usage event kinds (lib/server/usage/kinds.ts, docs/second-brain.md#your-own-event-kinds): a name like
      // work.ticket_moved and the attributes its events declare. `fields` is a JSON list of { name, type, required, description }.
      `CREATE TABLE IF NOT EXISTS usage_kinds (
        kind TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2063,
    name: 'brain_entities',
    statements: [
      // The entity registry (lib/server/brain/entities.ts, docs/second-brain.md#entities): initiatives, people, customers
      // and systems the brain reasons about next to workflows and agents. `attrs` is a JSON object of flat values.
      `CREATE TABLE IF NOT EXISTS brain_entities (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        attrs TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (type, id)
      )`,
      `CREATE INDEX IF NOT EXISTS brain_entities_project ON brain_entities (project_id)`,
    ],
  },
  {
    version: 2064,
    name: 'brain_backtests',
    statements: [
      // Backtests of detectors against past decisions (lib/server/brain/backtest.ts): the result is JSON in `data`; the
      // columns are what the list filters and sorts on.
      `CREATE TABLE IF NOT EXISTS brain_backtests (
        id TEXT PRIMARY KEY,
        detector TEXT NOT NULL,
        created_at TEXT NOT NULL,
        precision_rate REAL,
        failing INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS brain_backtests_detector ON brain_backtests (detector, created_at)`,
    ],
  },
  {
    version: 2065,
    name: 'brain_pages',
    statements: [
      // The Brain page's summaries (lib/server/brain/wiki.ts): the text the model wrote for an entity's page, and `basis`,
      // a hash of the facts and work it was written from, so the page can say when it is out of date.
      `CREATE TABLE IF NOT EXISTS brain_pages (
        subject TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        model TEXT NOT NULL,
        basis TEXT NOT NULL,
        generated_at TEXT NOT NULL
      )`,
    ],
  },
  // B03: which surface made a model call (spotlight, architect, brain), so Insights counts the assistant's spend.
  {
    version: 2072,
    name: 'ai_usage_surface',
    statements: [],
    addColumns: [{ table: 'ai_usage', column: 'surface', definition: 'TEXT' }],
  },
];

/** Every table with its primary key columns (upserts conflict on them; Postgres mode copies them at boot). */
export const TABLES = {
  meta: ['key'],
  workflows: ['id'],
  executions: ['id'],
  execution_steps: ['execution_id', 'seq'],
  execution_events: ['execution_id', 'seq'],
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
  debug_tokens: ['id'],
  workflow_publications: ['workflow_id'],
  workflow_publish_log: ['id'],
  node_static_data: ['workflow_id', 'node_id'],
  ai_usage: ['id'],
  chat_messages: ['workflow_id', 'session_id', 'seq'],
  trigger_buffers: ['key'],
  evaluation_runs: ['id'],
  evaluation_cases: ['run_id', 'idx'],
  online_eval_configs: ['target'],
  evaluation_settings: ['workflow_id'],
  online_eval_scores: ['id'],
  alert_channels: ['id'],
  alert_rules: ['id'],
  alert_throttle: ['rule_id', 'workflow_id'],
  alert_waiting_sent: ['rule_id', 'execution_id'],
  alert_state: ['rule_id', 'key'],
  projects: ['id'],
  project_members: ['project_id', 'user_id'],
  project_resources: ['kind', 'resource_id'],
  resource_shares: ['kind', 'resource_id', 'project_id'],
  saml_replay: ['id'],
  scim_groups: ['id'],
  scim_group_members: ['group_id', 'user_id'],
  audit_events: ['id'],
  audit_destinations: ['id'],
  audit_outbox: ['destination_id', 'event_id'],
  publish_requests: ['id'],
  external_secret_providers: ['name'],
  variable_environment_values: ['key', 'environment'],
  plugin_registrations: ['endpoint'],
  templates: ['id'],
  project_variables: ['project_id', 'key'],
  project_variable_environment_values: ['project_id', 'key', 'environment'],
  project_settings: ['project_id'],
  workflow_policies: ['workflow_id'],
  binary_scope_links: ['execution_id'],
  credentials: ['id'],
  config_files: ['name'],
  audit_chain: ['id'],
  saml_state: ['kind', 'id'],
  promotion_requests: ['id'],
  plugin_transport_policies: ['plugin_id'],
  transport_connections: ['id'],
  plugin_mcp_exposure: ['plugin_id'],
  mcp_tokens: ['id'],
  mcp_grants: ['id'],
  mcp_catalog_servers: ['name', 'version'],
  mcp_gateway_resources: ['kind', 'name'],
  mcp_approvals: ['id'],
  mcp_trigger_subs: ['sub_key'],
  mcp_trigger_events: ['sub_key', 'id'],
  mcp_project_servers: ['project_id'],
  scheduled_publishes: ['id'],
  approval_email_used: ['group_id'],
  chat_feedback: ['id'],
  agent_definitions: ['id'],
  agent_sessions: ['id'],
  agent_memory: ['agent_id', 'user_id'],
  audit_signing_keys: ['key_id'],
  audit_heads: ['seq'],
  composite_types: ['name', 'version'],
  usage_events: ['id'],
  usage_daily: ['day', 'kind', 'workflow_id', 'node_type', 'signature', 'agent_id'],
  usage_kinds: ['kind'],
  brain_entities: ['type', 'id'],
  brain_profiles: ['subject_type', 'subject_id'],
  brain_facts: ['id'],
  proposals: ['id'],
  agent_templates: ['id'],
  agent_teams: ['id'],
  team_notes: ['id'],
  agent_asks: ['id'],
  agent_eval_cases: ['id'],
  agent_eval_runs: ['id'],
  agent_response_cache: ['id'],
  agent_semantic_cache: ['id'],
  brain_backtests: ['id'],
  brain_pages: ['subject'],
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
