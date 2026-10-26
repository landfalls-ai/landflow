# Roadmap: closing the gaps with other workflow platforms

Status: **all waves landed** (started and finished 2026-10-25; Wave 5, closing Wave 4's "Not yet" lists and the gaps the follow-ups left, landed 2026-10-26; each item's "Not yet" list is what remains). The list comes from a pass over Landflow's code and
from research on n8n, Zapier, Make, Power Automate, the developer-first engines (Temporal,
Inngest, Trigger.dev, Windmill, Pipedream, Activepieces, Node-RED, Kestra), the AI-native
builders (Dify, Langflow, Flowise, Gumloop, Lindy) and team and operations features. The
research report is in `reports/Workflow platform feature gaps.md`, with the notes in
`research_notes/Workflow platform feature gaps/`.

The work goes in waves. Each wave ends with the web tests passing, a clean type check and a
check in Chrome, and this file is updated as items land. The Claude Code harness plan
([harnesses.md](harnesses.md)) is parked and not part of this list.

## Wave 1: runs that can wait, flow building blocks, organisation, built-in data

Three streams in parallel, split by the files they own.

**A. Engine and flow** ✅ Done.
- Executions that pause and resume: a node can put the run in a `waiting` state. The run's
  state is saved to disk and resumed later, also after a restart, at a time, on a webhook call
  or on a form submission.
- **Wait** node: after an interval, at a date and time, on a webhook call (resume URL), or on a
  form submission.
- **Form Trigger** and **Form** nodes: hosted form pages, multi-page forms through waiting, and
  a completion page.
- **Respond to Webhook** node, and the Webhook trigger's response modes: immediately, when the
  last node finishes, or from Respond to Webhook.
- Test URLs for the Webhook and Form triggers (n8n's "Listen for test event"). ✅ Done:
  `/api/webhook-test/<path>` and `/form-test/<path>` answer while the editor listens (120 s, with a
  countdown and Stop; Execute listens when the workflow starts at such a trigger without pinned
  data), run the editor's workflow as a manual run shown live on the canvas, and work across mains
  in queue mode (listeners in Valkey). The MCP Server Trigger has one too (`/mcp-test/<path>`: the
  editor's tools, each tool call a live manual run). Test calls are traced like production ones
  (`landflow.trigger.test`), and listening again on another main ends the old editor's stream. ✅
- **Loop Over Items** (batches), with node state kept for the length of a run.
- **Execute Workflow** node (sub-workflows), and the workflow trigger called by workflows as well
  as agents. Covers run once or per item, waiting or not (waiting children in "each item" mode too ✅, started 4 at a time with outputs over 256 KB read back from the child on resume ✅), and the caller policy.
- **Error Trigger** and the workflow setting *Error workflow*.
- **Schedule** trigger: cron expressions, times of day, weekdays, a time zone, and several rules.
- Workflow timeout, and the settings for which executions to keep.

**B. Editor and organisation** ✅ Done. Renaming a node updates `$('Old')` references. Undo and redo cover the workflow's name, tags and settings too, in the same history as canvas edits.
- Sticky notes on the canvas.
- Copy, paste and duplicate nodes, using the clipboard JSON format n8n uses.
- Import and export workflow JSON, including import from n8n workflows.
- Workflow settings dialog (error workflow, time zone, timeout, callers, saved executions).
- Version history: every save is a version, with a list, a preview, a diff and restore.
- Tags and folders, plus search and sort in the workflows list.
- An expression editor with autocomplete for `$json`, `$('Node')`, `$vars` and functions.

**C. Platform data** ✅ Done.
- **Settings** page: general settings (default time zone, execution retention) and variables.
- **Variables**, used in expressions as `$vars.NAME`.
- **Data Tables**: built-in tables with a page to edit them, and a Data Table node (insert,
  get, update, upsert, delete) that can also be used as an AI tool.
- Execution retention by count and by age.
- **Insights**: runs, failure rate and duration per workflow over time.

**D. Docker (OrbStack)**, running alongside streams A–C. ✅ Done; see [deploy/README.md](../deploy/README.md).
- `deploy/compose.infra.yml` holds the infrastructure the later waves build and test against:
  - Postgres with pgvector;
  - Valkey;
  - Mailpit (MailHog has no arm64 image);
  - MinIO (the community `pgsty/minio` build, since the official images are gone);
  - OpenBao;
  - Keycloak, under the `auth` profile;
  - Jaeger, under the `observability` profile;
  - MySQL, under the `mysql` profile.

  It uses its own project name and ports, and leaves other projects' containers alone.
- `deploy/compose.yml` runs Landflow itself from images: the host plus every plugin, with the
  plugins announcing themselves to the host.
- Opt-in tests that run the databases plugin against real Postgres, Valkey and MySQL.

## Wave 1.5: a durable runtime

Wave 1 makes the store the system of record for waits and approvals, so the runtime comes
before sign-in and AI. ✅ Done; see the README's Durable runtime section.
- A SQLite store, with Postgres as an option (Docker infra). The JSON files stay as an import
  and export format. ✅ Done: `<data dir>/landflow.db` in WAL mode with versioned migrations,
  workflows, executions, poll state, versions, folders, settings, variables, waits and Data
  Tables in it; a one-time import renames the old files to `<name>.imported-<date>`.
  `LANDFLOW_DB=postgres` keeps an in-memory copy and writes to Postgres through a spooled
  queue, one host per database until Wave 4. Credentials and the encryption key stay files.
- Crash recovery: node outputs are saved as checkpoints under stable step ids. A run
  interrupted by a restart continues from its last finished node, the way Inngest and Hatchet
  work. ✅ Done: node runs and a checkpoint per main-flow node (`<nodeId>#<runIndex>`); at boot a
  `running` execution continues from its checkpoint ("Resumed after restart") or fails with the
  reason.
- Every execution records the workflow version it started on. ✅ Done (`versionId`).
- Idempotency keys for triggers, and per-step keys sent to plugins. ✅ Done: `Idempotency-Key`
  on webhooks and forms and `idempotencyKey` on the run API (24 h window); `ExecuteRequest`
  carries `idempotencyKey` (`<executionId>:<nodeId>:<runIndex>`), exposed by the TS, Go and
  Python SDKs.
- Per-workflow concurrency limits and singleton runs. n8n offers neither at any tier. ✅ Done:
  extra trigger runs wait in a bounded FIFO queue or are skipped; manual runs bypass it.
- Automatic retry of failed runs with backoff, per-node timeouts, and a stop-all control.
  ✅ Done: linked retries (`retryOf`) that continue from the failed node, a Retry action,
  `timeoutSeconds` per node and Stop all on the Executions page.

## Wave 2a: what a network-reachable install needs

- Sign-in: owner setup, users, roles (owner, admin, member), invites (Mailhog), and a lock so
  two people don't edit the same workflow at once. ✅ Done: setup page or `LANDFLOW_OWNER_*`,
  scrypt passwords, hashed expiring sessions, sign-in rate limits, one `can()` role check, invites
  and password resets by email (Mailpit) or as links to copy, an edit lock with take-over, and
  `createdBy` / `updatedBy` / `startedBy`; see the README, "Authentication".
- Scoped API keys and a documented public API. ✅ Done: `lf_…` keys with scopes and expiry,
  stored hashed; OpenAPI 3.1 at `/api/openapi.json` and Settings → API docs.
- Free OIDC login (Keycloak in Docker). n8n charges for it. ✅ Done: authorization code + PKCE,
  just-in-time users, role mapping from a claim, tested against the infra stack's Keycloak.
- A sandboxed Code node running out of process in a locked-down container, with JavaScript and
  Python. ✅ Done: the code runner service, one fresh child process per run with n8n's globals,
  on an internal Docker network with a read-only root; see [deploy/README.md](../deploy/README.md),
  "Code runner". Syntax highlighting and `$json`/`_json` completions in the code editor ✅ (Wave 5).
  Not yet: `$('Node')` in in-process code; line numbers, bracket matching and search in the editor.
- OAuth2 *Connect* buttons for credentials. ✅ Done: a generic OAuth2 API credential with
  presets (Google, GitHub, Slack, Microsoft, Notion, Discord) and plugin types that `extends` it
  (n8n's `extends: ['oAuth2Api']`, in the protocol and the three SDKs; Google OAuth2 uses it);
  authorization code with PKCE in a popup, client credentials, tokens encrypted on the host,
  "Connected as …" and expiry in the dialog, refresh before expiry and a renew-and-rerun on a 401,
  and the HTTP Request node's Authentication; tested against a fake provider and the infra
  stack's Keycloak. Not yet: the other plugins' credential types still take tokens directly.
- **Binary data** across the protocol and the three SDKs, stored on disk or in S3 (MinIO):
  - file nodes: Read/Write Files, Extract from File, Convert to File;
  - HTTP downloads;
  - webhook and form uploads;
  - attachments in the integrations.

  ✅ Done: `item.binary` refs in the protocol (JSON and gRPC), a filesystem or S3 store with files
  deleted with their execution, `/api/binary` with per-call tokens for plugins, helpers in the
  three SDKs, the file nodes (CSV, XLSX, HTML, JSON, text, PDF text, base64), HTTP Request file
  responses and multipart bodies, webhook and form uploads, Respond to Webhook files, Gmail
  attachments, Telegram and Slack uploads and downloads, and a Binary tab in the run view; see the README's
  "Files and binary data". Not yet: Google Drive and the other integrations' files, binary
  in the Code node, range requests for video, XLSX/ODS writing.
- Failure alerts by email or chat, without writing an error workflow. ✅ Done: Settings → Alerts
  with email (the host's SMTP settings), Slack, signed webhook and Telegram channels with a test
  send; rules by workflow, tag and event (failed, timed out, retries exhausted, waiting too long);
  one alert per workflow per window with a digest of the rest; and a "Notify on failure" switch in
  a workflow's settings; see the README's Durable runtime section. Not yet: Microsoft Teams and
  Discord channels, alerts on a workflow's failure rate or on plugins going offline.

## Wave 2b: safe deploys and outside agents

- Draft and publish on pinned versions. ✅ Done: saves are drafts; Publish (with a note) puts a
  saved version live for webhooks, forms, schedules, polls, app webhooks, MCP triggers, error
  workflows and sub-workflow calls, while editor runs use the draft. The editor shows "Unpublished
  changes", the version history marks the published version and publishes older ones (rollback),
  Unpublish turns production triggers off, and executions say which version ran ("ran version 7
  (published)"). Workflows that were active before were published on their newest version
  (migration 200); `active` still reads as "has a published version". The API, the CLI and Git
  sync publish through `lib/server/publish.ts`. Four-eyes approval of a publish arrived in Wave 4 (Settings →
  Governance). Not yet: scheduled publishes.
- App webhook triggers (a register/unregister lifecycle in the protocol) with signature checks;
  webhook authentication. ✅ Done: `triggerSource: "appWebhook"` with `WebhookMethod`
  (checkExists/create/delete) and `ReceiveWebhook` over HTTP and gRPC, static data per workflow
  and node, retries with backoff, and `/api/webhook/app/<workflowId>/<nodeId>`; GitHub, Stripe and
  Slack signature helpers in the TypeScript, Go and Python SDKs; a GitHub Webhook Trigger in the
  productivity plugin (docs/protocol.md §12). The Webhook and Form triggers authenticate callers
  with Basic Auth, a header (`httpHeaderAuth`) or a JWT (HS256 secret, PEM key or JWKS URL, issuer
  and audience checks), plus an IP allow-list; the auth credential must belong to the workflow's
  project ✅ (Wave 5). Not yet: Stripe and Slack triggers, OAuth app
  installs for app webhooks.
- An inbound-email trigger. ✅ Done: Email Trigger (IMAP) in the core plugin, polling or IMAP IDLE,
  then mark read, move to a folder or leave the message; from, to, subject, text, HTML and headers,
  attachments as binary files; GreenMail in `deploy/compose.infra.yml` (`mail` profile) for tests.
  Not yet: custom IMAP search rules, a raw-message output format.
- A CLI with stable JSON output, and Git sync of workflows as files. ✅ Done: `packages/cli`
  (`landflow`: workflows, publish, runs with `--wait`, executions, n8n import, export, data tables,
  variables) with one JSON document per command and fixed exit codes; `landflow sync pull/push/
  status/diff` over a `landflow-sync/v1` directory (one directory per folder, stable key order,
  credentials by name and type), with conflict checks both ways; and Settings → Source control,
  which commits and pushes or pulls and applies a branch; see the README's "CLI" and "Git sync".
  Not yet: per-workflow commits, a Git history view, SSH keys from a credential.
- **MCP Server Trigger** (a workflow serves tools over MCP), **MCP Client Tool** (an agent uses
  an MCP server), and an instance-level MCP server so coding agents can build and run workflows.
  ✅ Done, with an MCP Client node and MCP servers as an agent capability; see the README's MCP
  section; a test URL for the trigger ✅ (Wave 5). Not yet: OAuth for MCP servers, resources and prompts.

## Wave 3: AI

- RAG:
  - vector stores (in memory, SQLite, pgvector);
  - Ollama embeddings, a document loader and a text splitter;
  - hybrid search with a reranker;
  - a retriever usable as an agent tool;
  - knowledge bases for agents.

  ✅ Done, with OpenAI-compatible embeddings, a token splitter, an LLM reranker and a Question and
  Answer Chain; see the README's RAG section. Not yet: files (PDF, DOCX) in the data loader, a
  Cohere reranker, uploading documents from the agent builder.
- Streamed replies, a hosted chat page and an embeddable widget for the Chat trigger. ✅ Done:
  the Anthropic, OpenAI-compatible and Ollama adapters stream tokens, the AI Agent and the chains
  send them as `node.chunk` events (text and tool calls) to the editor's chat panel, and the Chat
  and Webhook triggers have a "Streaming" response mode (SSE or NDJSON, n8n's chunk format). A
  public Chat trigger serves `/chat/<path>` (title, initial messages, Basic Auth, previous
  sessions, file uploads) and `<script src="/chat/widget.js" data-workflow="…">` on other sites,
  with allowed origins checked; see the README's "Hosted chat and widget". Not yet: Basic Auth
  from the widget, chat feedback (thumbs up/down), custom CSS beyond the theme colours.
- Guardrails node (PII, prompt injection, moderation). ✅ Done, after n8n's: check (Pass/Fail) or
  sanitize, plus secret keys, keywords, URL allow-lists, topical alignment and custom checks. Not
  yet: guardrails as a setting of standalone agents.
- Model fallbacks. ✅ Done: "Enable Fallback Model" on the AI Agent and the chains.
- Token and cost tracking with per-agent and per-workflow caps. ✅ Done: every model call is
  priced (Anthropic and OpenAI list prices, Ollama free, overrides in Settings → AI prices) and
  stored; totals per model in the execution view, a cost column and total in Insights, usage on
  agent pages; caps per execution and per workflow per day (tokens or dollars, Workflow settings)
  and per agent per day or month, which stop the run with a clear error; see
  [observability.md](observability.md#token-and-cost-tracking). Not yet: caps per credential or
  per user, cost alerts before a cap is reached, cached-token prices.
- Evaluations, both offline (test datasets from Data Tables) and online (grading agent
  conversations). ✅ Done, after n8n's: an Evaluation Trigger runs the workflow once per Data Table
  row, and the Evaluation node sets outputs, sets metrics (exact match, contains, regex, JSON
  equality, numeric closeness, string similarity, tools used, LLM-judge correctness, helpfulness
  and faithfulness, custom expressions) or checks whether it is evaluating. The Evaluations tab
  runs them, lists runs with metric averages, links each case to its execution and compares two
  runs; evaluation runs stay out of Insights and production counts. Online grading samples
  finished agent sessions and AI Agent node runs, scores them 1–5 against a rubric and flags low
  scores, shown with a trend on the agent's Evaluations tab. Not yet: a dataset other than a Data
  Table, scheduled evaluation runs, alerts on a falling score.
- A Slack agent channel with approval buttons. ✅ Done: agents answer mentions and DMs through
  the Events API (signing-secret checks, replies in threads, one session per thread), and tools
  that need approval post Approve / Reject buttons; the AI Agent node can ask for tool approvals
  in the editor's chat panel or in a Slack channel (with named approvers), resuming the waiting
  execution; tested against a fake Slack server; see [agents.md](agents.md#slack). Not yet: Slack
  slash commands, Microsoft Teams, approvals by email.
- Files and images as model inputs. ✅ Done: "Include Binary as Input" on the AI Agent, the
  chains and the OpenAI node sends images, PDFs and text files as Anthropic image/document blocks,
  OpenAI `image_url`/`file` parts or Ollama `images` (PDFs read into the prompt); the hosted chat
  and the editor's chat panel attach files. Not yet: audio and video inputs, files from memory
  in later turns (memory keeps the file names only).
- Debounce, batching and rate limits. ✅ Done: a trigger's Debounce (per-key quiet window, last
  or all events, max wait) and Batch (size or timeout) hold production events in SQLite and start
  one run for them (re-armed after a restart; webhooks answer 202), and every node has a Rate
  limit next to its retry settings (calls per interval, queued across runs); see the README's
  "Debounce, batching and rate limits". Not yet: rate limits per credential, priorities.
- A Flowise importer, since Flowise has shut down. ✅ Done: chatflows and agentflows (v2) through
  the same import dialog and report as n8n, detected by shape; see the README's "Importing from
  n8n and Flowise". Not yet: Flowise credentials, custom JS functions as Code nodes, document stores.

## Wave 4: operations and teams

- Queue mode with workers on Valkey and Postgres, and high availability. ✅ Done:
  `LANDFLOW_EXECUTIONS_MODE=queue` (regular mode is unchanged) makes mains enqueue production runs
  on a Valkey stream (consumer group, XAUTOCLAIM takeover) for `pnpm worker` processes (concurrency,
  `/healthz` and `/metrics`, heartbeats, graceful SIGTERM that re-queues what doesn't finish); a
  run whose worker dies continues from its last checkpoint on another worker after 30 s. Editor runs
  stay in the main (or `LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS`); events, Respond to Webhook replies and
  results come back over pub/sub; stop, stop all, idempotency, concurrency and singletons, retries,
  rate limits, debounce and batching work across processes. Mains elect a leader (TTL lock with a
  fencing token) that runs schedules, polls, IMAP IDLE, timers and retention and adopts orphaned
  runs; failover in about 13 s. Postgres is shared (each process follows the others' writes through
  LISTEN/NOTIFY, migration 700 keeps plugin registrations), SQLite is refused without the
  single-host override, and S3/MinIO is the binary store (a warning for the filesystem). OTel
  metrics and a read-only Settings → Workers; `deploy/compose.queue.yml` runs two mains behind a
  load balancer and two workers, with `deploy/scripts/queue-e2e.py` (load spread, a killed worker,
  a killed leader). See the README, "Queue mode, workers and high availability". Wave 5 ✅: plugin
  restarts with the same version reach workers; marketplace node plugins run in every main and
  worker; credentials and settings files live in the database (`LANDFLOW_CONFIG_STORE`, default in
  queue mode, each file imported once; migration 1300); Valkey Sentinel (`LANDFLOW_VALKEY_SENTINELS`,
  `deploy/compose.sentinel.yml`, failover in about 5 s); debug sessions and OIDC and SAML sign-ins
  work on any main, so no sticky sessions. Not yet: Valkey Cluster (the queue's stream and its Lua
  scripts would all sit on one hash tag, so it can't scale out; Sentinel covers failover), agent
  definitions, sessions and memory in the database, sign-in rate limits shared across mains,
  Kubernetes manifests for queue-mode workers.
- Audit log, written as events through the existing OpenTelemetry pipeline, plus streaming to a
  SIEM. ✅ Done: `audit_events` (migration 900) with its own retention records actor, API key id,
  IP, user agent, request id, route, target and outcome for sign-in, sign-out and failed sign-ins,
  password resets, invites, user and role changes, API keys, workflow create, update, delete,
  import, publish, rollback and unpublish, publish requests, credential changes and credential use
  in runs (ids only), settings, stopped and deleted executions, Git push and pull, plugins and
  marketplace installs; a generic layer in the route `handler` records every other change and every
  denied request. Each event is also an OTel log record (`event.name`, OTLP/HTTP JSON when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set). `GET /api/audit` (filters, cursor) and
  `/api/audit/export` (CSV, JSON) need the `audit:read` scope and an admin; Settings → Audit log
  has the filters and export. SIEM streaming through a durable outbox (queued in the event's
  transaction, leased, retried with backoff, kept past retention until delivered): syslog RFC 5424
  over UDP, TCP and TLS, HTTP JSON lines signed with HMAC, Datadog and Elasticsearch presets and
  Splunk HEC, with **Send test event**; tested against fake receivers, and the infra stack's `siem`
  profile runs a Vector receiver. See the README, "Audit log and SIEM streaming". Wave 5 ✅: events
  carry their target's project (filter, and project admins read and export their projects' events
  on the project page), mTLS client certificates for syslog over TLS and HTTPS destinations, and a
  SHA-256 hash chain (migration 1500; sealed in order under an advisory lock on Postgres) checked by
  `GET /api/audit/verify` and **Verify chain**, still verifiable after pruning. Not yet: a CLI
  `audit verify`, external anchoring or signing of the chain head, SIEM routing per project.
- External secrets: OpenBao/Vault, 1Password and cloud secret managers. ✅ Done: Settings →
  External secrets connects, tests, refreshes and lists the names (never values) of OpenBao/Vault
  (KV v2; token, AppRole and pluggable Kubernetes auth; namespaces; lease renewal), 1Password
  Connect, AWS Secrets Manager (SigV4 without an SDK), GCP Secret Manager and Azure Key Vault, with
  their settings encrypted like credentials (migration 1000). Credential fields read
  `{{ $secrets.<provider>.<name>[.<key>] }}` (with **Use secret** and autocomplete), resolved at run
  time in the host or a worker with a short cache, never stored in executions or checkpoints, and
  redacted from outputs, errors and logs. Tested against the infra stack's OpenBao
  (`LANDFLOW_INTEGRATION=secrets`) and local fakes of the others; see the README, "External secrets
  and environments". Wave 5 ✅: `$secrets` in node parameters behind Settings → External secrets →
  **Allow in node parameters** (off by default; host and workers; values redacted from everything
  kept; names autocompleted), in the OAuth2 Connect client fields, and in the credentials Landflow
  uses itself (agents' models and channels, alert channels, the Git token); a misspelled key in a
  JSON secret fails instead of resolving empty; LocalStack (`aws` profile, port 54566) with a
  `LANDFLOW_INTEGRATION=aws` test. Not yet: a Respond to Webhook reply built from a secret isn't
  redacted (by design: it's the caller's answer).
- Environments and promotion. ✅ Done: `LANDFLOW_ENVIRONMENT` with a badge in the shell; protected
  environments (read-only editor with a banner, the API and the instance MCP server refuse workflow
  changes; runs and publishing stay open); a Git branch per environment; **Promote** (all or picked
  workflows, a preview with diffs, conflicts when the target branch changed a workflow since the
  last promotion, force) in Settings → Environments, the API and `landflow env promote`; pulls with
  publish on pull (`file`, `all`, `none`) and `landflow env pull`; variable values per environment
  (migration 1001); credentials matched by name or mapped explicitly, `$secrets` resolving against
  the target's providers. `landflow-sync/v1` gained only optional fields. Wave 5 ✅: a protected
  environment disables every create and change button (with the reason); promotion carries
  credential definitions (secret fields empty or mapped to `$secrets`, never their values) and the
  rows of opted-in data tables, with a diff per file; with four-eyes on, a promotion is a request
  someone else approves (migration 1650). Not yet: per-project four-eyes on promotion, updating a
  credential the target already has, merging rows (a table's rows are replaced).
- Projects, sharing, SAML and SCIM, and ownership transfer. ✅ Done: a personal project per user
  and team projects with admin, editor and viewer roles; workflows, credentials, data tables and
  agents belong to one project (migration 800 moves existing data into the owner's personal
  project); sharing workflows (edit or view) and credentials ("can use", the secret stays hidden)
  with people and projects; checks in the route guard for every resource route, in lists, search,
  the credential picker, live events and runs (a workflow only uses its project's credentials);
  Move to project, deleting a team project and removing a user hand what they own to a person or
  project in one transaction; a project switcher, project pages, Share and Move dialogs. SAML 2.0
  sign-in (signed assertions, replay protection, just-in-time users, role and project mapping,
  single logout; tested against the infra stack's Keycloak) and SCIM 2.0 provisioning (Users and
  Groups for Okta and Entra ID, deactivation, group-to-role and group-to-project mapping, a
  scim-only token). See the README, "Authentication". Wave 5 ✅: folders and variables per project
  (`$vars` reads the project's value first, then the instance's), a per-project node allow-list,
  the Data Table node and its pickers limited to the workflow's project, webhook and MCP trigger
  auth credentials checked against the project (migrations 1400, 1401); encrypted SAML assertions
  (generate or upload a key, published in the metadata, can be required) and SAML state in the
  database so any main finishes a sign-in or logout (migration 1501). Not yet: data table names
  unique per project, evaluation datasets and agents' table pickers per project, folders from Git
  sync in their project, the instance MCP server per project, SAML key rotation with two certificates.
- Templates library and canvas groups. ✅ Done: a Templates page with 18 built-in templates
  (validated against the core nodes and the bundled plugins' manifests in a test), search,
  categories, cards with node icons, a detail page with a read-only canvas, setup steps and the
  credential slots and data tables a template needs; **Use template** remaps each slot to a
  credential of its type (or one created there), creates missing data tables, makes webhook paths
  unique and opens the new draft (optionally in a folder); **Save as template** from the workflow
  menu (credentials become slots, pinned data and instance details are left out; stored in the
  `templates` table, migration 1100), export and import of template files, templates with missing
  or governance-blocked nodes marked unusable, and an optional n8n-compatible remote library
  (`LANDFLOW_TEMPLATES_URL`, converted by the n8n importer with its report). Canvas groups: frames
  around nodes (`⌘G` / `⇧⌘G`, context menu) that move their nodes, resize, rename, recolour,
  collapse (edges merged per neighbour) and take nodes in and out by dragging, saved in
  `workflow.groups` (the engine ignores them) and handled by undo, copy and paste, duplicate,
  import and export, version diffs and Git sync. See the README, "Building and debugging a flow".
  Wave 5 ✅: templates belong to a project or the whole instance (a project picker on the library),
  edit in place (and replace the workflow from a saved one), remote results 30 at a time with
  **Load more**; nested groups (`parentId`, kept through undo, clipboard, import/export, diffs and
  Git sync); collapsed groups stay collapsed in the Executions view with a run summary; waiting
  nodes are marked on the canvas with what they wait for. Not yet: grouping across different parents.
- An allowlist for nodes and MCP servers; four-eyes publish; ownership transfer. ✅ Done (ownership
  transfer is part of projects, above): Settings → Governance allows or blocks node types (ids,
  globs, whole plugins, Code nodes), HTTP Request hosts (globs, `host:port`, IPv4 CIDR) and MCP
  servers. Saving warns, publishing is refused, and blocked nodes fail at run time with a clear node
  error, in the host and in workers, for manual, trigger and agent runs (agents' MCP tools too); the
  node creator hides blocked nodes and importers report them. Four-eyes publishing (migration 901):
  publish, rollback and unpublish become requests that someone else approves or rejects (no
  self-approval; any builder or admins only), go stale when the draft or the live version changes,
  notify approvers by email and alert channels, are audited, and show in the editor's Publish menu;
  the CLI exits 8 (`approval_pending`). See the README, "Governance". Wave 5 ✅: a project picks
  who approves its requests (its admins, admins and editors, or instance admins), a workflow can
  require four-eyes and a stricter node allow-list on its own, and the HTTP host allow-list takes
  IPv6 addresses, CIDR ranges and `[addr]:port`.
- Kubernetes discovery for plugins, tested on OrbStack's local cluster. ✅ Done:
  `LANDFLOW_PLUGIN_DISCOVERY=kubernetes` watches Services labelled `landflow.dev/plugin=true` and
  their EndpointSlices in `LANDFLOW_K8S_NAMESPACES` (in-cluster, or a kubeconfig with an explicit
  context), with relists, a resync and backoff; a plugin with no ready pod goes offline and comes
  back, a deleted Service removes it; the registry secret is proven with an HMAC challenge in the
  three SDKs; kustomize manifests in `deploy/k8s/` (the host with a namespaced Role, the seven
  plugins, optional Postgres and Valkey) and an integration test (`LANDFLOW_INTEGRATION=k8s`); see
  [deploy/README.md](../deploy/README.md), "Kubernetes". Wave 5 ✅: calls spread over the ready pods
  behind a Service, fewest in flight first (`LANDFLOW_K8S_SPREAD`), and `LANDFLOW_K8S_NAMESPACES=*`
  watches every namespace (the `cluster-discovery` component: a read-only ClusterRole).

## Planned next

- One plugin, every transport, and MCP: plugins reachable over HTTP, gRPC and any common message
  broker (Kafka, RabbitMQ, NATS, Valkey Streams, MQTT, SQS, Pub/Sub, Service Bus, AMQP 1.0, Pulsar)
  through one messaging core and small drivers, chosen per call from live traffic, and every plugin
  also an MCP server (its own endpoint and the host's gateway): see [transports.md](transports.md).

## Not planned

Later, maybe: browser use, an agent code sandbox, voice, and prompt management. Not planned:
RPA, process mining, an app builder, and a chat hub (n8n is retiring its own).
