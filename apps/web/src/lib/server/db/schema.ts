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
