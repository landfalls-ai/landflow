# Roadmap: closing the gaps with other workflow platforms

Status: **all waves landed** (started and finished 2026-10-25; Wave 5, closing Wave 4's "Not yet" lists and the gaps the follow-ups left, landed 2026-10-26; Wave 6, closing every remaining "Not yet", landed 2026-10-27; what remains is listed under "Wave 6" below). Spotlight in the editor landed 2026-10-27, and alert triage with Landfall, the flow marketplace and composite nodes landed 2026-10-29 (each has its own section below). [history.md](history.md) lists every change in order, with where each is documented. The list comes from a pass over Landflow's code and
from research on n8n, Zapier, Make, Power Automate, the developer-first engines (Temporal,
Inngest, Trigger.dev, Windmill, Pipedream, Activepieces, Node-RED, Kestra), the AI-native
builders (Dify, Langflow, Flowise, Gumloop, Lindy) and team and operations features. The
research report is in `reports/Workflow platform feature gaps.md`, with the notes in
`research_notes/Workflow platform feature gaps/`.

The work goes in waves. Each wave ends with the web tests passing, a clean type check and a
check in Chrome, and this file is updated as items land. The Claude Code harness plan
([harnesses.md](harnesses.md)) is parked and not part of this list. Neither are the rest of the Spotlight plan
([spotlight.md](spotlight.md): the new Home, ⌘K Spotlight across the app and the action layer) and the simplification
review ([ux-simplification.md](ux-simplification.md)), which wait on the decisions listed in spotlight.md. Spotlight in
the workflow editor is built (its section below).

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

**D. Docker (OrbStack)**, running alongside streams A–C. ✅ Done; see [deployment.md](deployment.md).
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
before sign-in and AI. ✅ Done; see [Durable runtime](features/engine.md#durable-runtime).
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
  `createdBy` / `updatedBy` / `startedBy`; see [Authentication](features/authentication.md).
- Scoped API keys and a documented public API. ✅ Done: `lf_…` keys with scopes and expiry,
  stored hashed; OpenAPI 3.1 at `/api/openapi.json` and Settings → API docs.
- Free OIDC login (Keycloak in Docker). n8n charges for it. ✅ Done: authorization code + PKCE,
  just-in-time users, role mapping from a claim, tested against the infra stack's Keycloak.
- A sandboxed Code node running out of process in a locked-down container, with JavaScript and
  Python. ✅ Done: the code runner service, one fresh child process per run with n8n's globals,
  on an internal Docker network with a read-only root; see [deployment.md,
  "Code runner"](deployment.md#code-runner). Syntax highlighting and `$json`/`_json` completions in the code editor ✅ (Wave 5).
  Wave 6 ✅: `$('Node')` and the other expression accessors in both Code node paths; line numbers, bracket
  matching and find/replace in the editor.
- OAuth2 *Connect* buttons for credentials. ✅ Done: a generic OAuth2 API credential with
  presets (Google, GitHub, Slack, Microsoft, Notion, Discord) and plugin types that `extends` it
  (n8n's `extends: ['oAuth2Api']`, in the protocol and the three SDKs; Google OAuth2 uses it);
  authorization code with PKCE in a popup, client credentials, tokens encrypted on the host,
  "Connected as …" and expiry in the dialog, refresh before expiry and a renew-and-rerun on a 401,
  and the HTTP Request node's Authentication; tested against a fake provider and the infra
  stack's Keycloak. Wave 6 ✅: OAuth2 variants for Slack, Discord, GitHub, Notion, Airtable, HubSpot and
  Jira Cloud; the services with no OAuth2 (Telegram, WhatsApp Cloud, Twilio, SMTP, the databases) take tokens.
- **Binary data** across the protocol and the three SDKs, stored on disk or in S3 (MinIO):
  - file nodes: Read/Write Files, Extract from File, Convert to File;
  - HTTP downloads;
  - webhook and form uploads;
  - attachments in the integrations.

  ✅ Done: `item.binary` refs in the protocol (JSON and gRPC), a filesystem or S3 store with files
  deleted with their execution, `/api/binary` with per-call tokens for plugins, helpers in the
  three SDKs, the file nodes (CSV, XLSX, HTML, JSON, text, PDF text, base64), HTTP Request file
  responses and multipart bodies, webhook and form uploads, Respond to Webhook files, Gmail
  attachments, Telegram and Slack uploads and downloads, and a Binary tab in the run view; see
  [Files and binary data](features/files.md). Wave 6 ✅: Google Drive, Gmail, database bytea/BLOB columns and the messaging,
  text-toolkit, productivity and py-insights files on the protocol's binary data; binary in the Code node (both
  paths); `Range` requests on `/api/binary` (206/416, disk and S3); XLSX and ODS writing.
- Failure alerts by email or chat, without writing an error workflow. ✅ Done: Settings → Alerts
  with email (the host's SMTP settings), Slack, signed webhook and Telegram channels with a test
  send; rules by workflow, tag and event (failed, timed out, retries exhausted, waiting too long);
  one alert per workflow per window with a digest of the rest; and a "Notify on failure" switch in
  a workflow's settings; see [Durable runtime](features/engine.md#durable-runtime). Wave 6 ✅: Microsoft Teams and
  Discord channels, alerts on a workflow's failure rate and on plugins going offline.

## Wave 2b: safe deploys and outside agents

- Draft and publish on pinned versions. ✅ Done: saves are drafts; Publish (with a note) puts a
  saved version live for webhooks, forms, schedules, polls, app webhooks, MCP triggers, error
  workflows and sub-workflow calls, while editor runs use the draft. The editor shows "Unpublished
  changes", the version history marks the published version and publishes older ones (rollback),
  Unpublish turns production triggers off, and executions say which version ran ("ran version 7
  (published)"). Workflows that were active before were published on their newest version
  (migration 200); `active` still reads as "has a published version". The API, the CLI and Git
  sync publish through `lib/server/publish.ts`. Four-eyes approval of a publish arrived in Wave 4 (Settings →
  Governance). Wave 6 ✅: scheduled publishes (`/api/workflows/:id/schedules`, `landflow publish --at`).
- App webhook triggers (a register/unregister lifecycle in the protocol) with signature checks;
  webhook authentication. ✅ Done: `triggerSource: "appWebhook"` with `WebhookMethod`
  (checkExists/create/delete) and `ReceiveWebhook` over HTTP and gRPC, static data per workflow
  and node, retries with backoff, and `/api/webhook/app/<workflowId>/<nodeId>`; GitHub, Stripe and
  Slack signature helpers in the TypeScript, Go and Python SDKs; a GitHub Webhook Trigger in the
  productivity plugin (docs/protocol.md §12). The Webhook and Form triggers authenticate callers
  with Basic Auth, a header (`httpHeaderAuth`) or a JWT (HS256 secret, PEM key or JWKS URL, issuer
  and audience checks), plus an IP allow-list; the auth credential must belong to the workflow's
  project ✅ (Wave 5). Wave 6 ✅: Stripe and Slack triggers; GitHub App installs (`githubAppApi`, JWT
  helpers in the three SDKs) and Slack OAuth2 installs. Slack's Events URL is pasted into the app by hand
  (Slack has no API for it).
- An inbound-email trigger. ✅ Done: Email Trigger (IMAP) in the core plugin, polling or IMAP IDLE,
  then mark read, move to a folder or leave the message; from, to, subject, text, HTML and headers,
  attachments as binary files; GreenMail in `deploy/compose.infra.yml` (`mail` profile) for tests.
  Wave 6 ✅: custom IMAP search and a raw `.eml` output, tested against GreenMail.
- A CLI with stable JSON output, and Git sync of workflows as files. ✅ Done: `packages/cli`
  (`landflow`: workflows, publish, runs with `--wait`, executions, n8n import, export, data tables,
  variables) with one JSON document per command and fixed exit codes; `landflow sync pull/push/
  status/diff` over a `landflow-sync/v1` directory (one directory per folder, stable key order,
  credentials by name and type), with conflict checks both ways; and Settings → Source control,
  which commits and pushes or pulls and applies a branch; see [CLI](features/cli.md) and [Git sync](features/git-sync.md).
  Wave 6 ✅: per-workflow push, a history view with restore, and SSH keys from a credential
  (`core.sshPrivateKey`, host key pinned), checked against the infra stack's Git SSH server.
- **MCP Server Trigger** (a workflow serves tools over MCP), **MCP Client Tool** (an agent uses
  an MCP server), and an instance-level MCP server so coding agents can build and run workflows.
  ✅ Done, with an MCP Client node and MCP servers as an agent capability; see [MCP](features/ai.md#mcp); a test URL for the trigger ✅ (Wave 5). Wave 6 ✅: OAuth for MCP servers (protected resource and
  authorization server metadata, dynamic client registration, PKCE, resource indicators; `core.mcpOAuth2Api`),
  resources and prompts in the MCP Client, the MCP Client Tool and the MCP Server Trigger.

## Wave 3: AI

- RAG:
  - vector stores (in memory, SQLite, pgvector);
  - Ollama embeddings, a document loader and a text splitter;
  - hybrid search with a reranker;
  - a retriever usable as an agent tool;
  - knowledge bases for agents.

  ✅ Done, with OpenAI-compatible embeddings, a token splitter, an LLM reranker and a Question and
  Answer Chain; see [Retrieval (RAG)](features/ai.md#retrieval-rag). Wave 6 ✅: files (PDF, DOCX…) in the data loader, a
  Cohere reranker, uploading documents to an agent's knowledge base from the builder.
- Streamed replies, a hosted chat page and an embeddable widget for the Chat trigger. ✅ Done:
  the Anthropic, OpenAI-compatible and Ollama adapters stream tokens, the AI Agent and the chains
  send them as `node.chunk` events (text and tool calls) to the editor's chat panel, and the Chat
  and Webhook triggers have a "Streaming" response mode (SSE or NDJSON, n8n's chunk format). A
  public Chat trigger serves `/chat/<path>` (title, initial messages, Basic Auth, previous
  sessions, file uploads) and `<script src="/chat/widget.js" data-workflow="…">` on other sites,
  with allowed origins checked; see [Hosted chat and widget](features/ai.md#hosted-chat-and-widget). Wave 6 ✅: Basic Auth
  from the widget, chat feedback (thumbs up/down), sanitized custom CSS under a content security policy.
- Guardrails node (PII, prompt injection, moderation). ✅ Done, after n8n's: check (Pass/Fail) or
  sanitize, plus secret keys, keywords, URL allow-lists, topical alignment and custom checks. Not
  yet: guardrails as a setting of standalone agents.
- Model fallbacks. ✅ Done: "Enable Fallback Model" on the AI Agent and the chains.
- Token and cost tracking with per-agent and per-workflow caps. ✅ Done: every model call is
  priced (Anthropic and OpenAI list prices, Ollama free, overrides in Settings → AI prices) and
  stored; totals per model in the execution view, a cost column and total in Insights, usage on
  agent pages; caps per execution and per workflow per day (tokens or dollars, Workflow settings)
  and per agent per day or month, which stop the run with a clear error; see
  [observability.md](observability.md#token-and-cost-tracking). Wave 6 ✅: caps per credential and
  per user, cost alerts before a cap is reached, cached-token prices.
- Evaluations, both offline (test datasets from Data Tables) and online (grading agent
  conversations). ✅ Done, after n8n's: an Evaluation Trigger runs the workflow once per Data Table
  row, and the Evaluation node sets outputs, sets metrics (exact match, contains, regex, JSON
  equality, numeric closeness, string similarity, tools used, LLM-judge correctness, helpfulness
  and faithfulness, custom expressions) or checks whether it is evaluating. The Evaluations tab
  runs them, lists runs with metric averages, links each case to its execution and compares two
  runs; evaluation runs stay out of Insights and production counts. Online grading samples
  finished agent sessions and AI Agent node runs, scores them 1–5 against a rubric and flags low
  scores, shown with a trend on the agent's Evaluations tab. Wave 6 ✅: datasets from uploaded CSV or
  JSON files, scheduled evaluation runs, alerts on a falling score.
- A Slack agent channel with approval buttons. ✅ Done: agents answer mentions and DMs through
  the Events API (signing-secret checks, replies in threads, one session per thread), and tools
  that need approval post Approve / Reject buttons; the AI Agent node can ask for tool approvals
  in the editor's chat panel or in a Slack channel (with named approvers), resuming the waiting
  execution; tested against a fake Slack server; see [agents.md](agents.md#slack). Wave 6 ✅: Slack
  slash commands, a Microsoft Teams channel (Adaptive Card approvals with `Action.Execute`), approvals
  by email (single-use signed links).
- Files and images as model inputs. ✅ Done: "Include Binary as Input" on the AI Agent, the
  chains and the OpenAI node sends images, PDFs and text files as Anthropic image/document blocks,
  OpenAI `image_url`/`file` parts or Ollama `images` (PDFs read into the prompt); the hosted chat
  and the editor's chat panel attach files. Wave 6 ✅: audio and video inputs (transcribed for models
  without them), files from memory re-attached in later turns (Simple Memory).
- Debounce, batching and rate limits. ✅ Done: a trigger's Debounce (per-key quiet window, last
  or all events, max wait) and Batch (size or timeout) hold production events in SQLite and start
  one run for them (re-armed after a restart; webhooks answer 202), and every node has a Rate
  limit next to its retry settings (calls per interval, queued across runs); see
  [Debounce, batching and rate limits](features/engine.md#debounce-batching-and-rate-limits). Wave 6 ✅: rate limits per credential, run priorities (high,
  normal, low; in queue mode three Valkey streams, a low run after every eight, aging after 15 s and 60 s).
- A Flowise importer, since Flowise has shut down. ✅ Done: chatflows and agentflows (v2) through
  the same import dialog and report as n8n, detected by shape; see [Importing from
  n8n and Flowise](features/editor.md#importing-from-n8n-and-flowise). Wave 6 ✅: Flowise credentials, custom JS functions as Code nodes, document stores.

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
  a killed leader). See [Queue mode, workers and high availability](features/engine.md#queue-mode-workers-and-high-availability). Wave 5 ✅: plugin
  restarts with the same version reach workers; marketplace node plugins run in every main and
  worker; credentials and settings files live in the database (`LANDFLOW_CONFIG_STORE`, default in
  queue mode, each file imported once; migration 1300); Valkey Sentinel (`LANDFLOW_VALKEY_SENTINELS`,
  `deploy/compose.sentinel.yml`, failover in about 5 s); debug sessions and OIDC and SAML sign-ins
  work on any main, so no sticky sessions. Wave 6 ✅: Valkey Cluster (`LANDFLOW_VALKEY_CLUSTER`, the
  infra stack's `valkey-cluster` profile; every key shares one hash tag, so it gives failover, not
  scale-out), agent definitions, sessions and memory in the database (migration 1881), sign-in rate
  limits shared across mains, Kubernetes manifests for queue-mode workers (`orbstack-queue`, checked
  on OrbStack with two mains and two workers; the KEDA example wasn't applied, KEDA isn't installed),
  and an evaluation run on one main no longer marked interrupted by another (migration 1880).
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
  profile runs a Vector receiver. See [Audit log and governance](features/audit-and-governance.md). Wave 5 ✅: events
  carry their target's project (filter, and project admins read and export their projects' events
  on the project page), mTLS client certificates for syslog over TLS and HTTPS destinations, and a
  SHA-256 hash chain (migration 1500; sealed in order under an advisory lock on Postgres) checked by
  `GET /api/audit/verify` and **Verify chain**, still verifiable after pruning. Wave 6 ✅: CLI
  `audit verify` (also offline against a saved head), an Ed25519-signed chain head anchored in S3
  or at a webhook (migration 1882, key rotation), SIEM routing per project.
- External secrets: OpenBao/Vault, 1Password and cloud secret managers. ✅ Done: Settings →
  External secrets connects, tests, refreshes and lists the names (never values) of OpenBao/Vault
  (KV v2; token, AppRole and pluggable Kubernetes auth; namespaces; lease renewal), 1Password
  Connect, AWS Secrets Manager (SigV4 without an SDK), GCP Secret Manager and Azure Key Vault, with
  their settings encrypted like credentials (migration 1000). Credential fields read
  `{{ $secrets.<provider>.<name>[.<key>] }}` (with **Use secret** and autocomplete), resolved at run
  time in the host or a worker with a short cache, never stored in executions or checkpoints, and
  redacted from outputs, errors and logs. Tested against the infra stack's OpenBao
  (`LANDFLOW_INTEGRATION=secrets`) and local fakes of the others; see [External secrets
  and environments](features/secrets-and-environments.md). Wave 5 ✅: `$secrets` in node parameters behind Settings → External secrets →
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
  someone else approves (migration 1650). Wave 6 ✅: per-project four-eyes on promotion, updating a
  credential the target already has, merging rows.
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
  scim-only token). See [Authentication](features/authentication.md). Wave 5 ✅: folders and variables per project
  (`$vars` reads the project's value first, then the instance's), a per-project node allow-list,
  the Data Table node and its pickers limited to the workflow's project, webhook and MCP trigger
  auth credentials checked against the project (migrations 1400, 1401); encrypted SAML assertions
  (generate or upload a key, published in the metadata, can be required) and SAML state in the
  database so any main finishes a sign-in or logout (migration 1501). Wave 6 ✅: data table names
  unique per project, evaluation datasets and agents' table pickers per project, folders from Git sync in
  their project, the instance MCP server per project (migrations 1870, 1871), SAML key rotation with two
  certificates (signing and decryption; an encrypted NameID in a logout request is read with either key).
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
  import and export, version diffs and Git sync. See [Building and debugging a flow](features/editor.md).
  Wave 5 ✅: templates belong to a project or the whole instance (a project picker on the library),
  edit in place (and replace the workflow from a saved one), remote results 30 at a time with
  **Load more**; nested groups (`parentId`, kept through undo, clipboard, import/export, diffs and
  Git sync); collapsed groups stay collapsed in the Executions view with a run summary; waiting
  nodes are marked on the canvas with what they wait for. Wave 6 ✅: grouping across different parents
  (it already worked; tests added).
- An allowlist for nodes and MCP servers; four-eyes publish; ownership transfer. ✅ Done (ownership
  transfer is part of projects, above): Settings → Governance allows or blocks node types (ids,
  globs, whole plugins, Code nodes), HTTP Request hosts (globs, `host:port`, IPv4 CIDR) and MCP
  servers. Saving warns, publishing is refused, and blocked nodes fail at run time with a clear node
  error, in the host and in workers, for manual, trigger and agent runs (agents' MCP tools too); the
  node creator hides blocked nodes and importers report them. Four-eyes publishing (migration 901):
  publish, rollback and unpublish become requests that someone else approves or rejects (no
  self-approval; any builder or admins only), go stale when the draft or the live version changes,
  notify approvers by email and alert channels, are audited, and show in the editor's Publish menu;
  the CLI exits 8 (`approval_pending`). See [Audit log and governance](features/audit-and-governance.md). Wave 5 ✅: a project picks
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
  [deployment.md, "Kubernetes"](deployment.md#kubernetes). Wave 5 ✅: calls spread over the ready pods
  behind a Service, fewest in flight first (`LANDFLOW_K8S_SPREAD`), and `LANDFLOW_K8S_NAMESPACES=*`
  watches every namespace (the `cluster-discovery` component: a read-only ClusterRole).

## Transports and MCP (built 2026-10-26)

- One plugin, every transport, and MCP: plugins reachable over HTTP, gRPC and any common message
  broker (Kafka, RabbitMQ, NATS, Valkey Streams, MQTT, SQS, Pub/Sub, Service Bus, AMQP 1.0, Pulsar)
  through one messaging core and small drivers, chosen per call from live traffic, and every plugin
  also an MCP server: its own endpoint, and a bundled open-source MCP gateway (agentgateway) that
  every installed plugin registers into automatically. Decisions settled on 2026-10-26; see
  [transports.md](transports.md). Built in waves T1 to T6 on 2026-10-26, by its phases:
  - Phase 0 (spec, infra, gateway spike) ✅ Done: protocol §14 Messaging and §15 MCP; every broker
    and agentgateway 1.6.0 in `deploy/compose.infra.yml`, one profile each, with
    `deploy/scripts/brokers-smoke.sh`; the spike (`deploy/scripts/mcp-gateway-spike.mjs`,
    [mcp-gateway.md](mcp-gateway.md)) verified the config API, the identity headers, Keycloak sign-in
    and the file fallback, and chose the config API.
  - Phase 1 (abstraction) ✅ Done: `TransportBinding` and a dispatcher with `maxConcurrency` in the
    TS, Go and Python SDKs (`LANDFLOW_TRANSPORTS`, `LANDFLOW_MAX_CONCURRENCY`, the `transports` /
    `maxConcurrency` manifest hints); the MCP tool mapping in `@landflow/protocol`; the host's
    transport providers, the per-plugin policy in the database (`PATCH /api/plugins/:id {policy}`),
    the selector with reasons on spans, broker connections with sealed secrets
    (`/api/transports/connections`, `LANDFLOW_TRANSPORT_<KIND>_URL`), Settings → Transports and the
    policy picker on plugin cards.
  - Phase 2 (messaging in TypeScript) ✅ Done: the core of `@landflow/transports` (CloudEvents
    envelope, end-to-end encryption and signing, `MessagingClient` / `MessagingServer`), the
    in-memory driver and the driver conformance suite; the tier 1 drivers `kafka`, `amqp`, `nats`,
    `jetstream` and `valkey` (live conformance against the local brokers); the host's broker
    connections (`brokers.ts`: one client per connection in every main and worker, discovery over
    the registry channel, queue stats, health, fail-over once for a provably undelivered call) and
    `BrokerPluginClient`; the TS SDK's `serve({ brokers })` with `LANDFLOW_<KIND>_URL`. Without
    `LANDFLOW_TRANSPORT_SECRET` the host opens no broker connection and says so.
  - Phase 3 (MCP endpoints) ✅ Done (the Go and Python faces in wave T3): the SDK's MCP face (`/mcp` on the HTTP port,
    `--mcp-stdio`, `LANDFLOW_MCP_TOKEN`, `LANDFLOW_MCP_CREDENTIALS`); the host's per-plugin endpoints
    `/api/mcp/plugins/<id>` and `core`, speaking MCP 2026-07-28 natively and 2025-era clients
    statelessly (`@modelcontextprotocol/server` 2.4.0), tool calls as executions with mode `mcp`,
    audit `mcp.tool.call`, `tools/list_changed`, "Expose to agents" (on by default, `PATCH
    /api/plugins/:id {mcp:{exposed}}`), `GET /api/mcp/tools`; the host's MCP code moved to SDK v2.
    Identity, grants, tokens and the catalog from phase 3b too: the gateway secret and caller
    headers, Landflow MCP tokens (ES256, `/api/mcp/jwks`), identity provider tokens, API keys,
    protected resource metadata; grants for users, SCIM groups, projects, roles or one token, with no
    implicit grants; `server.json`, `/api/mcp/registry/v0.1/servers…`, Server Cards; Settings → MCP.
    `resource_link`, approvals/elicitation and `list_options` on the host's endpoints followed in wave T6.
  - Phase 3b (bundled MCP gateway) ✅ Done: agentgateway 1.6.0 as a sidecar of each main (Compose, queue
    mode, a second container in the Kubernetes host Deployment; the Ingress came in wave T6) and `McpGatewaySync` on
    the config API, with a file fallback. A target per online plugin (named by the plugin id, or a slug plus
    six hex digits when the id doesn't fit), per-plugin routes, the Server Card proxy and the
    `x-landflow-caller-jti` transformation; offline plugins are removed after 60 s and old MCP tokens are
    purged. `LANDFLOW_MCP_GATEWAY_HOST_URL` and `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` configure it.
  - Phase 4 (Go and the bridge) ✅ Done: the Go transport core (byte-compatible with the TS one), the
    tier 1 Go drivers as nested modules (`sdks/go/transport/<kind>`), the Go SDK's `WithBroker`, and
    `landflow-bridge` (`services/landflow-bridge`, `deploy/docker/bridge.Dockerfile`), which Python's
    `serve()` starts for kinds without a native driver. The concurrency and deadline behaviour is the same
    in the TS, Go and Python SDKs (`maxQueue` / `max_queue`, `capacity`, `x-landflow-deadline`), and a call
    that arrives over a broker waits for a slot instead of being refused.
  - Phase 5 (Auto) ✅ Done: measurements, scoring, spill-over at `floor(maxConcurrency × share)`, the
    20 % / three-window hysteresis, the circuit breaker, `Health` probes and the capacity rule (a 429,
    `RESOURCE_EXHAUSTED` or `capacity` moves the call once and holds the endpoint for its `Retry-After`);
    reasons on spans, `plugin.transport` feed events and the `landflow.transport.*` metrics.
  - Phase 6 (tier 2 brokers) ✅ Done: MQTT 5, AMQP 1.0, Amazon SQS, Google Pub/Sub, Apache Pulsar and Azure
    Service Bus, each a TS and a Go driver; conformance 37/37 and the cross-language check pass against
    the local containers and emulators.
  - Phase 8 (Python native drivers) ✅ Done: `landflow_sdk.transport`, byte-compatible with the TS core,
    with the Kafka, RabbitMQ, NATS/JetStream and Valkey drivers (`landflow-sdk[kafka]`, `[amqp]`,
    `[nats]`, `[valkey]`, `[brokers]`).
  - Phase 7 (Twilio pilot, queue mode, Kubernetes) ✅ Done: the Twilio node and a fake Twilio server, and the
    walk-through on the local stack (an editor run over gRPC, a burst that spilled from gRPC to Kafka with every SMS sent
    once, the plugin pinned to Kafka, an MCP call, `--mcp-stdio`); queue-mode workers that open the broker connections
    and call broker-only plugins; Kubernetes broker components (`brokers`, `broker-transports`,
    `overlays/orbstack-brokers`) and KEDA `ScaledObject` examples, checked on OrbStack (1 to 6 replicas on a JetStream
    backlog and back); the gateway sidecar checked on OrbStack; `deploy/scripts/transport-bench.py` with
    `plugins/transport-bench`. Auto now keeps the static order between near-equal kinds (a 2 ms floor), and a policy
    change makes it choose afresh.
  - Every bundled plugin on the new SDKs ✅ Done: Text Toolkit, Messaging, Crypto Toolkit, Google Workspace,
    Databases, Insights and Productivity take broker faces from `LANDFLOW_TRANSPORTS` (TS images carry all eleven
    client libraries, Go images link the tier 1 drivers, Python images the native tier 1 drivers plus
    `landflow-bridge`), serve their own MCP face on loopback in dev (off in containers unless a token is set), set a
    `maxConcurrency` default with its reason, and mark every read or pure operation `idempotent` (writes stay at
    most once). The plugin images, Compose files and Kubernetes manifests carry the new settings.
  - A core `nats` and a `jetstream` connection on the same server keep apart: JetStream subjects carry a `js.`
    token (protocol §14.9).
  - Wave T6 (the follow-ups) ✅ Done on 2026-10-26:
    - MCP on the host's endpoints: binary outputs as `resource_link` (signed `/api/mcp/files/{id}`) or inline media,
      `list_options` and cached `enum`s, and approvals for destructive tools (MCP elicitation for clients that support
      it, otherwise a Landflow approval in Settings → MCP; a grant's `approval` is always, destructive or never).
    - Poll and app-webhook triggers as MCP resources (`landflow://triggers/<plugin>/trigger_<name>`, subscribe with
      2026-07-28 `subscriptions/listen`). The gateway sync also registers the instance server and published MCP Server
      Trigger workflows.
    - The claim check: a broker body over the broker's limit goes by reference through S3 (`LANDFLOW_CLAIM_STORE`) in
      the TS, Go and Python cores and the bridge.
    - Per-workflow transport overrides (Workflow settings → Transports).
    - The Go Kafka driver's group mode passes the hand-over case and is the default again; MQTT at 100 B went from
      +45 ms to +1.4 ms (Mosquitto `set_tcp_nodelay`).
    - Kubernetes Ingress and Gateway API routes for the gateway, with Landflow-token sign-in
      (`components/gateway-landflow-tokens`); the same sign-in for the dev gateway (`mcp-gateway/compose.tokens.yml`).
    - The Pulsar client as a pnpm patch; `deploy/scripts/servicebus-config.py` writes the emulator's entities. The Service
      Bus stall under concurrency was the emulator throttling its whole namespace: the drivers pace themselves on the
      emulator and retry a throttle, so 8 callers at 100 B run at 20 calls/s with no errors.
    - Go and Python claim stores take pod and task roles too (web identity, container credentials).
    - Databases created before 2026-10-25 lacked a checkpoint column, so crash-recovery checkpoints failed to save there;
      migration 1780 adds it (migrations can now add a column only where it's missing).
    - The gateway sync writes the host's own JWKS inline into the per-plugin routes it stores in agentgateway, so a gateway
      restarted while the host is down still starts (with the URL it crash-looped on `failed to load JWKS`). On
      Kubernetes, applying or reverting `orbstack-brokers` now rolls the plugins, which read their broker faces only at start.
  - Known follow-ups: MCP subscriptions need a 2026-07-28 client (2025-era clients read a trigger resource to poll);
    large Service Bus messages through the emulator stay throughput-bound (about 1 call/s at 64 KiB with 8 callers). The
    gateway takes Landflow tokens and the identity provider's on one route since Wave 6.

## Wave 6: every remaining "Not yet" (built 2026-10-27)

Each item above that ends with "Wave 6 ✅" landed in this wave, with its tests and docs. Migrations: 1820–1822 (alert
rules, AI caps, evaluation datasets and schedules), 1830 (single-use approval email links), 1840 (scheduled publishes),
1860–1861 (chat feedback, rate limits per credential), 1870–1871 (project MCP tokens and servers), 1880 (evaluation
heartbeats), 1881 (agents in the database), 1882 (audit signing keys and signed heads). Also in this wave:

- Bugs found and fixed: opening Evaluations on one main marked another main's running evaluation as interrupted
  (migration 1880 adds a heartbeat; only runs stale for 30 s are settled); a SAML logout request whose NameID was
  encrypted to the next certificate couldn't be read; the recorded plugin manifests the tests use had drifted from the
  plugins (`packages/protocol/scripts/record-manifests.mjs` re-records them); the Python NATS driver reported a core
  publish nobody subscribed to as accepted when the server's "no responders" came just after the flush (it now waits up
  to 1 ms for it, as the Go driver does).
- Checked live: Valkey Cluster with the slot owner stopped under a main and a worker; queue mode on OrbStack's Kubernetes
  (two mains, two workers, 24 webhook runs, a worker pod deleted mid-run); agentgateway accepting a Landflow token and a
  Keycloak token on one route; MCP OAuth against Keycloak; Git push and restore over SSH; IMAP search against GreenMail;
  approval emails through Mailpit; audit anchoring and `/api/binary` ranges against MinIO.
- What remains: Slack's Events URL is pasted into the Slack app by hand (Slack has no API for it); integrations are
  checked against local fakes, not the real Stripe, Slack, GitHub or Teams; Valkey Cluster gives failover, not
  scale-out (every queue key shares one hash tag); the KEDA worker example wasn't applied (KEDA isn't installed on the
  local cluster); with the identity provider accepted, the gateway's own 401 carries no `WWW-Authenticate` challenge;
  standalone agents' test chat takes no file uploads; a Respond to
  Webhook reply built from a secret isn't redacted (by design); MCP subscriptions need a 2026-07-28 client.

## Spotlight in the editor (built 2026-10-27)

The editor part of the Spotlight plan ([spotlight.md](spotlight.md)): one AI surface in the workflow editor, a bar at
the bottom of the canvas beside the run controls ([assistant.md](assistant.md#spotlight)). No migrations.

- **The bar.** ⌘I opens it; bubbles above it suggest what to ask (starters on an empty canvas, at most three urgent
  ones otherwise) and complete what you type: `@` for canvas nodes, node types by name, keyword or plugin, the whole
  "Add X after Y" step, and the rest of a sentence. The bubbles come from `lib/shared/spotlight.ts`, without a model
  call. Tagged nodes and types go with the message as ids, and the prompt lists only the node types the workflow may
  use (online, and allowed by governance). It replaced the Assistant header button, the side panel, the toolbar AI
  builder and the empty-canvas prompt box.
- **Drafting.** On an empty canvas the first message drafts the whole flow (`/api/ai/build`), laid out, with test data
  pinned on the trigger, as one undo step. Later messages go to the builder chat, which proposes changes as cards to
  review and apply.
- **Test and fix** (`components/editor/test-session.ts`). It runs the workflow, judges the run (`lib/shared/run-check.ts`:
  failed nodes, nothing reaching the end, If or Filter steps without conditions, Set steps without fields, Code that
  repeats every result) and has the assistant fix it, up to 4 fixes. A run that passes is checked against the goal,
  using what its last step put out. Then **Ready for production** offers to publish, and nothing is published without
  that click.
- **While it works**, the conversation steps aside: a card at the top left shows the phase and one line per step, the
  empty canvas shows a drafting placeholder, the node being fixed carries a badge, and when the work is over the
  session folds into one line.
- Bugs found and fixed:
  - On a narrow canvas the bar was squeezed to about 90 px. The dock now wraps and the bar keeps 300 px.
  - Replies claimed proposed changes were already made, and invented ids, channels and URLs. Those sentences are now
    dropped, and id-like parameters nobody gave are left out of proposals.
  - qwen3-coder's tool calls failed in Ollama's own parser (a 500). They are now retried up to twice, before anything
    is shown.
  - Display rules saw saved parameters without their defaults, so hidden fields showed. The node form, the credential
    section, the MCP server dialog and the assistant's node docs now fill defaults first, as the server does.
  - Eight file-system calls with paths known only at run time made Turbopack trace the whole project, the live `.data`
    included. They now carry `/*turbopackIgnore: true*/`.
  - A stale persistent Turbopack cache made the browser reload in a loop. `next dev` no longer keeps one
    ([development.md](development.md#setup)).
  - The SDK's MCP test reused one port across servers.
- What remains: the local model doesn't always keep replies short, Test and fix can spend its 4 fixes on one node, and
  its checks are structural ([limitations.md](limitations.md)). The Home, ⌘K across the app and the action layer are
  still a plan.
- Multi-part requests (2026-10-31): a progress-aware budget, a plan then one proposal, pending proposals kept, no
  If or Filter after a node that already branches, loops allowed, and teams (`turnIntoTeam`)
  ([assistant.md](assistant.md#the-builder-chat)).

## Alert triage, Landfall and the flow marketplace (built 2026-10-29)

Decide whether an alert is a real incident, and only then open a war room in Landfall
([triage.md](triage.md)); share and install flows through the marketplace ([marketplace.md](marketplace.md#flows)).
No migrations: a template's marketplace origin is kept in its document.

- **Plugins.** `triage` (TypeScript): Normalize Alert (Alertmanager, Grafana, Datadog, CloudWatch, Sentry, Wazuh, any
  JSON), Extract IOCs, Parse Email (SPF/DKIM/DMARC, mismatches, links, attachment hashes), Triage Rules and Triage
  Decision, with the safety rules in the nodes: fail open, sev1 never held, the AI can't drop an alert, only people
  approve noise rules, Shadow before Enforce. `landfall` (TypeScript): incidents (open from an alert with a dedup key,
  recover, open manually, declare, get), timelines, remediation records, heartbeats, a polling trigger, and a
  remote-source face that answers Landfall's health probes. `threat-intel` (Go): VirusTotal, AbuseIPDB, GreyNoise,
  urlscan.io, Shodan, AlienVault OTX, MISP and IOC Enrich (all at once, cached, one verdict).
- **Flows.** Alert triage → Landfall war room, phishing report triage, the triage digest, Landflow failures → Landfall,
  the Landflow heartbeat, learning from closed rooms, and the IOC lookup API. The repository's own
  `.claude-plugin/marketplace.json` (`landflow-soc`) lists the plugins and their flows.
- **Marketplace.** Plugins ship flows (`flows/*.json`, or a `flows` list); installing adds them to Templates with
  their origin and uninstalling removes them. Each flow has a read-only share page (the canvas, notes, setup,
  credentials, what else it needs, **Install plugin**, a share link that can add the marketplace on another
  instance). Go node plugins from this repository build against the host's `sdks/go`.
- **Plugins page and Explore.** The Plugins page is a grid of small cards (icon, status, node icons) with search and
  an online/offline filter. A card unfolds on click to its endpoints, transport policy, MCP exposure and nodes, and
  `?plugin=<id>` links to one. The marketplace's Browse tab became **Explore**: every node plugin, workflow and Claude
  Code plugin across the added marketplaces and this instance (the registry's plugins, the Templates library), with
  one search, kinds, sources and categories (`GET /api/marketplaces/explore`).
- **Tests.** The plugins' suites (Landfall against a fake Landfall, threat intel against `httptest` fakes), the host's
  marketplace tests for flows, share views, install and uninstall, and `plugin-flows.test.ts`, which validates every
  shipped flow against the recorded manifests.
- Checked live on a scratch host: the repository's marketplace added from this checkout, the three plugins installed
  (with the confirmation, the Go build, the supervisor), **Use template** and publish, then alerts against the fake
  Landfall. A critical alert opened a room, its repeat attached, its resolution recovered it. A plain JSON warning with
  the model unreachable failed open and opened a room, and its repeat attached. Uninstall removed the flows' templates
  and left the workflow.
- Bugs found and fixed: a flow's `needs` was cached with the plugin detail for 10 minutes, so the share page kept
  asking for plugins already installed; Normalize Alert's Auto threw on a payload it didn't recognise (dropping the
  alert) and now reads it as Generic; the flows stopped when threat intel or the model failed, and now continue to the
  fail-open decision; the sign-in, setup, invite and password forms had no `method`, so a submit before the page
  hydrated was a GET with the email and password in the URL (now `post`, with a test). Node plugins could be handed a
  port another process already held: the free-port probe bound 127.0.0.1 only, which macOS allows beside a wildcard
  listener. It now also connects to the port and binds every interface (with a test).
- What remains: the Landfall and threat intel calls are checked against fakes, not the live services; share pages need
  sign-in.

## Composite nodes (built 2026-10-29)

Groups typed by a contract ([composites.md](composites.md)): a composite type names the slots a frame must or may hold,
its ports, its rules and how a run treats it. The nodes are copied in once and the contract is linked, so a new version
of a type never rewrites anyone's nodes. Errors block Publish, warnings don't, Save never is; free nodes are allowed
unless the type is closed; slots can take nested composites. Migration 1883 (`composite_types`).

- **Protocol and SDKs.** `CompositeTypeDescriptor` (slots with `NodeMatcher`s, ports, the `feeds` / `onError` /
  `reaches` / `sealed` rules, `closed`, `onError: 'fallback'`, `timeoutSeconds`, `properties`, a starter), node
  `capabilities`, the manifest's `composites` (gRPC `PluginManifest` field 7). `defineComposite` in the TypeScript SDK,
  `PluginInfo.Composites` in Go and `Plugin(composites=…)` in Python, each validating them.
- **Types.** Core's **AI step** (`core.aiStep`), the triage plugin's **AI triage** (`triage.aiTriage`, which the alert
  triage and phishing flows are now typed by), and this instance's library (`local.<name>`, a version per save). Threat
  intel's nodes are tagged `ioc.enrich` / `ioc.lookup`, triage's `ioc.extract` and others.
- **Checks** (`lib/shared/composites.ts`): slots, matchers, rules, closed types, unknown types and versions, each issue
  with a fix where one exists. The publish gate refuses a version with errors (422), templates list them as `contract`
  problems, and the editor assistant gets each frame's contract and a warning for an edit that breaks one.
- **Editor.** Insert from the node creator's Composites section; the frame's badge and contract panel (slots, free
  members, properties, On failure, rules, issues and fixes, Make plain group); dashed placeholders for empty slots that
  open the node creator filtered to the slot; auto-binding on drop and unbinding on drag-out; locked slots; collapsed
  frames with named output handles; copy and paste keeping bindings; **Composite…** on a group to type it or save a new
  type from it. The Executions canvas and Explore (a Composites kind) show them too.
- **Engine.** `ExecuteWorkflowOptions.scopes`: a frame whose type falls back stops there instead of the run and sends
  what entered it, with the error, to its fallback targets; a frame's timeout fails the next node inside past it;
  `$composite.params` reads the frame's properties. What entered a frame is kept in checkpoints and waits.
- **API.** `GET/POST /api/composites`, `DELETE /api/composites/:type`.
- **Tests.** `composites.test.ts` (matching, checks on the shipped flows, binding, instantiating, proposing, scopes),
  `composite-types.test.ts` (registry, library, routes, the publish gate, the assistant, a run that falls back),
  `composites-editor.test.ts` (the store's edits), the engine's `composites.test.ts`, and the Go and Python SDK tests.
- Checked live on the scratch host: triage and threat intel reinstalled, a workflow from the alert triage template
  opens with its AI triage frame met; deleting its model leaves one error and a placeholder whose node creator lists
  only chat models, and the model picked joins, binds and wires; the node creator and Explore list both types.
- Bugs found and fixed: a template saved by `importTemplate` or Save as template stayed behind when building its detail
  then failed, so a marketplace install that rolled back left it (it is now deleted again, with a test); the contract
  panel was drawn under the frames and nodes next to it (a node toolbar sits one above its node, and a frame is far
  behind) and ran past the bottom of the window (it now fits the room below it); an inserted composite landed on what
  was at the view's centre and was nested into the frame there (it now moves down to clear space, with a test). The
  Python SDK's `CONNECTION_TYPES` lacked the newer sub-node types.
- What remains: a governance rule that requires a composite, drawing the fallback as an edge, and composite types in
  Git sync and environment promotion ([limitations.md](limitations.md)).

## Remote agents over A2A, kagent and deep tracing (built 2026-10-30)

A Landflow agent can hand work to an agent that runs on a Kubernetes-native runtime, and every step of that shows in
one trace ([a2a.md](a2a.md)). kagent (Solo.io) was chosen over Google's AX: kagent speaks A2A in and MCP out and has
human-in-the-loop approvals; AX is a sandboxed task runner with none of those yet ([harnesses.md](harnesses.md#other-harnesses)).

- **A2A client** (`lib/server/a2a/client.ts`): A2A 1.0 over JSON-RPC; cards (an older card is refused), SendMessage
  with GetTask polling, SendStreamingMessage (server-sent events merged into the task), GetTask, CancelTask; kagent's
  HITL and usage extensions and its tool call parts.
- **Agent capability** (**Add A2A agent**): `ask_<name>`, described by the card or *Use when*; streamed remote tool
  calls in the timeline; the conversation kept per session; the remote agent's tool approvals become Landflow approval
  cards (test chat, Slack, Teams, email) and its questions go to the model; where no one can approve, the pause is
  rejected for the model. Slack, Teams and the approval email name the remote agent and tool.
- **A2A Agent node** (`core.a2aAgent`): Send Message, Answer a Pause, Get Task, Cancel Task.
- **Tracing**: an `invoke_agent` client span per call, with `traceparent` sent along, `a2a.tool_call` events and
  `landflow.a2a.*` metrics; host log lines exported as OTel log records (`LANDFLOW_LOG_OTLP`).
- **kagent next to Landflow**: kagent 1.0.0-alpha17 and Agent Substrate 0.6.0-alpha3 in a kind cluster (Kubernetes
  1.37) on the OrbStack engine (`deploy/kind/`, `deploy/scripts/kagent-up.sh`), bridged both ways, with an example
  agent on the Text Toolkit's tools.
- **Landflow agents on kagent** ([a2a.md](a2a.md#landflow-agents-on-kagent)): the persona of a kagent agent comes from
  Landflow. Deploying a published agent (the **kagent** card, `PUT /api/agents/<id>/kagent`) writes an AgentTemplate
  whose system prompt is the one the runtime gives the model (`shared/persona.ts`, now shared by both), plus its
  ModelConfig, its tools (a RemoteMCPServer on the new per-agent endpoint `/api/mcp/agents/<id>`, with the tools that
  need approval in a `requireApproval` binding), the Agent and a Secret, by server-side apply. Every publish writes the
  new version; the status reads kagent back and names each field that differs (an edit made in kagent), a publish
  kagent didn't get, and the Agent's Ready condition. A **kagent cluster** credential (`core.kagentApi`) holds the
  Kubernetes API, token, namespace, harness and the two URLs; the example agent is now created in Landflow and deployed
  from there, and the hand-written AgentTemplate is gone.
- **Telemetry on Kubernetes**: the `observability` component and `orbstack-observability` overlay (Grafana, Tempo,
  Prometheus, Loki), the Collector stanzas kagent's runtime needs, and the "Landflow · agent runs" dashboard; kagent
  and Substrate export there too.
- **Tests**: `a2a.test.ts` against a fake kagent-like agent (`test/fake-a2a.ts`); `kagent.test.ts` against a fake
  Kubernetes API (the persona, the five resources, publish, drift, ownership, the MCP endpoint).
- Checked live: from the test chat in the browser, a Landflow agent on `qwen3-coder:30b` asked the kagent agent to slugify
  one text and upper-case another; kagent called Landflow's MCP tools, `changeCase` paused, the approval card showed
  in Landflow, approving finished the run, and kagent's UI showed the approval given in Landflow. One trace went
  from the Landflow run through kagent's controller, agentgateway, Substrate restoring the sandbox and the agent's model
  and tool calls, back into Landflow's MCP endpoint and the plugin; the dashboard and Loki showed the same run.
- Bugs found and fixed: the Capabilities card's buttons ran past the card's edge once **Add A2A agent** was added (the
  actions row now wraps inside the card: `Section` in `components/agents/dialog.tsx`); `kagent-up.sh` failed on its
  closing heredoc.
- Checked live for Landflow agents on kagent: `kagent-up.sh` created and published **Text formatter** in Landflow and
  deployed it as `kagent/landflow-text`; kagent's UI showed Landflow's system prompt, model and description, and kagent
  listed the agent's two tools from `/api/mcp/agents/<id>`. Publishing v2 with a new sign-off rule wrote it to kagent
  ("In sync · v2"); an edit made to the AgentTemplate with kubectl showed as **Changed in kagent** with both prompts,
  and **Redeploy** put Landflow's back. From the Text desk agent's test chat, kagent paused on `changeCase` (the tool
  marked "needs approval" in Landflow), the approval card showed in Landflow, and the reply ended with v2's sign-off;
  the tool's `execute_tool` span from Landflow's endpoint was in the same trace.
- What remains: remote tokens in the agent's AI limits, serving A2A from Landflow, a card preview in the dialog,
  memory, guardrails and usage limits for agents on kagent, and kagent's own tracing quirks
  ([limitations.md](limitations.md)).

## Agents as personas (built 2026-10-31)

An agent is configured as a persona instead of one instructions box ([agents.md](agents.md#the-persona)), the first of
four steps proposed with a design canvas: the persona editor, persona cards on the Agents page grouped by team,
templates to start from, and richer avatars.

- **The Persona tab**: who it is (name, role, who it helps, what it does, description), its voice (tone words, answer
  length, language, sign-off), Always and Never rules, examples, and free instructions. They are stored as the
  agent's `persona` (blank parts dropped) and compiled by `personaPrompt()`, moved to `lib/shared/persona.ts` so the
  builder shows **What the model reads** with the same function the runtime and kagent use. The card compares the
  prompt with the published version's (and says whether kagent runs it) and shows the changes line by line. An agent
  without persona parts keeps the prompt it had, so agents deployed to kagent don't drift.
- **Tabs by purpose**: Persona, Abilities (model, skills, capabilities, memory), Deploy (triggers, kagent), Safety
  (guardrails, limits), Sessions and Evaluations, replacing Build and Settings (their old links still open the new
  tabs); **Runs on** under the name shows where the published version runs.
- Publishing and the test chat need a persona part or instructions, instead of instructions only. The example agent
  `kagent-up.sh` creates now has a persona.
- Bug found and fixed: clearing an optional part of the draft (the model, the guardrails, now the persona) didn't stick,
  since the autosave kept the stored value under the new draft (`saveDraft` in `agents/store.ts`); a `PUT` without a
  `model` now leaves the model as it is, and `model: null` clears it. Found in the browser: the Triggers card's
  description was squeezed into a narrow column beside its four buttons (a card's title now keeps at least 220px, so
  the buttons wrap under it: `Section` in `components/agents/dialog.tsx`), and an agent with only instructions showed
  them at the bottom with nothing pointing there (a note at the top of the tab now links to them).
- Checked live: in the browser, adding a tone, a sign-off and a Never rule to **Text formatter** marked the prompt
  "Changed since v1" with the three lines in **Changes since v1**; publishing v2 wrote the same text to kagent's
  AgentTemplate ("The same as published v2, the version kagent runs"), and a test-chat run on `qwen3-coder:30b`
  answered in one sentence ending with the sign-off. `?tab=settings` opened Safety.
- **Tests**: `agent-persona.test.ts` (the compiled sections and their order, an unchanged prompt without a persona,
  cleaning, autosave, publishing on a persona alone) and a `kagent.test.ts` case that a published persona is what
  kagent's AgentTemplate gets.
- Steps 2 to 4 (persona cards grouped by team, templates and "save as template", faces, initials and image avatars)
  were built the same day: [Agent workspace and the Agent architect](#agent-workspace-and-the-agent-architect-built-2026-10-31).

## Agents on Claude Code (built 2026-10-31)

Stage 1 of running Landflow agents in Claude Code ([harnesses.md](harnesses.md)), through kagent's Claude Code
Harness ([a2a.md](a2a.md#on-claude-code)).

- **Runtime**: the kagent card lists the cluster's Harnesses with their runtimes and deploys to the one picked
  (`harness` on `PUT`). The deployment keeps it, and the card moves an agent between runtimes. Codex and own-image
  Harnesses are refused.
- **Claude Code's resources**:
  - the model is always `Anthropic`, on Ollama's Messages API with the key `ollama`, or with the credential's base
    URL and key; OpenAI models are refused;
  - the tools are split over `<name>` and `<name>-approval` (`?tools=free|approval`, filtered in `tools/list` and
    `tools/call`), so kagent's per-server pause covers exactly the tools that need approval;
  - an approval server no longer needed is deleted.
- **Claude Code plugins**: an Abilities card picks plugins from the added marketplaces, kept as `plugins`
  (`<plugin>@<marketplace>`). Deploying resolves each one (`marketplace.claudePlugin`: a GitHub source, a
  `.claude-plugin/plugin.json`, a pinned commit). The pins are kept, the status compares against them, and `plugins` is
  a drift field.
- **Landflow's OCI registry**: kagent 1.0.0-alpha17's golden snapshot has no egress, so a git plugin source crashes
  it. Landflow packs each pin into a deterministic one-layer image (`kagent/oci.ts`), keeps it in
  `LANDFLOW_DATA_DIR/oci` and serves it at `/v2` (pull only, by digest, public). The credential's new **Plugin
  Registry** says where kagent's nodes reach it; `kagent-up.sh` sets the Service's ClusterIP. A missing image is packed
  again from the deployment that pinned it.
- **In `deploy/kind`**: `harness-claude.yaml` (`landflow-claude`: Claude Code with every model name mapped to
  `qwen3-coder:30b`), applied by `kagent-up.sh`, and `agents/dev-agent.json`, a developer persona with `submit_work`
  (needs approval) and the `mattpocock-skills` plugin.
- Found while checking it: a marketplace whose catalog wasn't fetched yet (Anthropic's, until Explore opens) had no
  name to resolve a plugin against, so `claudePlugin` fetches unread catalogs first. A plugin bundle's `skills` list
  doesn't matter for a Claude-format plugin, which kagent hands to Claude Code whole.
- Checked live on 2026-10-31:
  - From Dev desk's test chat in the browser, the Dev agent on `landflow-claude` (qwen3-coder through Ollama) wrote
    `slugify.sh` and its tests in bash, ran and debugged them, and called `submit_work`. kagent's pause showed as
    Landflow's approval card, and approving ran the tool in Landflow.
  - qwen3-coder then calls `submit_work` again. A tool answer saying the task is over, a Never rule and denying the
    call didn't stop it.
  - The git plugin source crashed the golden actor as described above. With the registry, atelet pulled
    `mattpocock-skills` (pinned at `49dd158`) from `/v2` and the agent came up Ready. Claude Code ran with it as a
    `--plugin-dir`, and its Skill tool loaded `mattpocock-skills:tdd`.
- **Tests**:
  - `kagent.test.ts`, "on Claude Code": the Harnesses; the Anthropic model on Ollama; the two servers and the
    endpoint's split; plugins at their commits and as packed images; plugin drift; moving back to the ADK runtime; and
    what is refused.
  - `kagent-oci.test.ts`: the tar, the deterministic digest, the registry's answers and repacking.
  - A `marketplace.test.ts` case for pinning.
- What remains:
  - stage 2: a Harness image with real toolchains, and Claude models instead of qwen3-coder;
  - plugins from marketplaces that aren't on GitHub;
  - Codex Harnesses.

## Agents in flows (built 2026-10-31)

A published agent as a step of a workflow, with the canvas's model, tools, knowledge bases and memory
([agents.md](agents.md#from-workflows)).

- **Run an Agent** (`core.messageAgent`, formerly "Message an Agent"; the type is unchanged) has the AI Agent's three
  optional sub-node ports. A connected **Chat Model** replaces the agent's own model for the run. Connected **Tools**
  (any `usableAsTool` node, an MCP Client Tool, or a vector store searched as a tool, which is how a knowledge base
  joins) are added to the agent's capabilities as `flow` tools and run as the node's sub-nodes. A connected **Memory**
  seeds the session from its history and saves back to it.
- The agent keeps its persona, skills, own capabilities, guardrails and usage limits. Tools that need approval are
  refused, since a workflow run has nobody to approve them.
- It outputs `{ reply, sessionId, agentId, version, model, endReason, usage, steps }`. Answers and tool calls stream to
  the editor's chat panel; each run is an agent session from the workflow, traced as `invoke_agent`.
- In the runtime: `RunRequest.flow` carries the model and tools, and `buildToolset` wraps each flow tool. The timeline
  has a `flow` tool kind.
- Checked live on 2026-10-31 on the cluster: a "Returns desk" agent (a returns specialist persona) in a workflow with
  a Chat trigger, an Ollama Chat Model (qwen3-coder), Simple Memory, a SQLite vector store of the returns policy as
  `search_policy`, and a Calculator. Asked about a $240 opened jacket, it searched the policy, calculated the 15%
  restocking fee and answered $204 back; the follow-up "what if it had been on sale?" used the memory and the policy.
- **Tests**: `agent-node.test.ts`: the agent's own model and persona with nothing connected; a connected model and
  Calculator, with the tool's run data; and memory across runs by session key.
- What remains: approvals from a workflow run (a pause that waits, like Wait for Approval), and running an agent
  deployed to kagent from the node with the canvas's tools (the node runs agents on Landflow's runtime; the A2A Agent
  node calls kagent).

## Second brain (built 2026-10-31)

Landflow studies how it is used, remembers what it learns, and suggests improvements
([second-brain.md](second-brain.md)). The plan's four phases were built together, with the recommended decisions:
- its own ledger;
- the ledger, detectors and inbox in code, with nodes and an agent for conclusions of your own;
- metadata only, with payloads opt-in per project;
- Apply with a diff;
- the local model;
- scoped per project.

- **Ledger**: `usage_events` and `usage_daily` (migration 1890), fed by saved executions, the audit writer, the AI usage
  writer, the bus, the assistant routes, template use and the node picker's empty searches. Error messages are redacted
  and signed. There is a one-time backfill, and `GET /api/usage` for reports.
- **Suggestions**: eleven detectors as SQL with thresholds. The model writes fixes, slow-step tips, persona rules and
  draft workflows. Suggestions in `proposals` are refreshed by fingerprint, held back once decided, and capped per
  workflow per week. Apply goes through governance, or the canvas applies the ops itself and the person saves.
- **Memory**: a daily study profiles workflows, agents, node types, credentials and the instance into `brain_facts` and
  `brain_profiles`, embedded per project into `landflow-brain-<project>`. Search fuses keywords and vectors.
- **Learning**: a baseline on Apply, checks after 7 and 14 days, and the outcome as a `change` fact. "Intended"
  dismissals become facts, and detectors that are mostly rejected get quieter.
- **Your own conclusions**: the Landflow Usage, On Usage Event and Suggest Improvement nodes; four templates (new
  failure alerts, weekly failure hot spots, weekly AI cost review, a weekly digest); and the Platform analyst agent,
  made from Insights.
- **Where you see it**: Home's Suggestions inbox, a canvas pill and side card, Insights' "What Landflow knows", and a
  project setting for run data.
- The edit operations gain `setNodeSettings` (retries, timeout, on error) and `setWorkflowSettings` (the error workflow,
  timeout, retries), so suggestions can change settings as well as parameters.
- **Tests**: `brain.test.ts` (26): the ledger, the detectors, the suggestion lifecycle, effects, study without a model,
  the nodes, the settings operations and the routes.
- What remains:
  - acting alone on low-risk suggestions (with Spotlight's action layer);
  - access control on the vector collections;
  - dead weight for credentials and agents;
  - a cluster-wide On Usage Event in queue mode.

## Agent workspace and the Agent architect (built 2026-10-31)

Steps 2 to 4 of the persona plan, plus faces, an architect that designs agents in a chat, and installed marketplace
agents on the roster ([agents.md](agents.md#the-roster)).

- **The roster**: agent cards with avatar, role, tones, publish state, where the published version runs, model, tools,
  skills and sessions, grouped by team, with filters (published, drafts, on kagent, from marketplace) and search. Each
  card's menu opens the agent, saves it as a template or exports its JSON.
- **Templates** ([agents.md](agents.md#templates)): seven built-in personas, each with a designed face, plus a blank
  one, and **Save as template…**. A template keeps the persona, instructions, skills, model (without its credential)
  and avatar, never tools, channels, schedules or the team. Saved templates go in the `agent_templates` table
  (migration 1900), shared in the agent's project and moved with it. The New agent dialog picks a template, a name, a
  team and an avatar; `POST /api/agents` takes `templateId`, `avatar`, `color`, `icon` and `team`.
- **Avatars and faces** ([agents.md](agents.md#avatars)): a face from parts (skin, hair and its colour, eyes, brows,
  mouth, beard, glasses, an extra; one in twelve shuffled faces is a robot), an icon, initials or an image (cropped to
  256 px in the browser, at most 200 KB), on a soft or solid tile. SVG faces in `components/agents/avatar.tsx`, parts
  and cleaning in `lib/shared/faces.ts`.
- **Teams** ([agents.md](agents.md#teams)): a label under the agent's name that groups the roster.
- **Agent architect** ([agents.md](agents.md#agent-architect)): a chat (`POST /api/assistant/agent`, SSE) with its own
  face that searches every plugin online for nodes usable as tools, reads node docs, lists callable workflows, agents,
  credential names and templates, and proposes a whole agent; the draft stays beside the chat and **Create agent**
  makes it. Drafts are validated (unknown types, workflows and agents left out, the node's own parameters over its
  defaults, invented ids dropped, credentials never set; what's left to do listed).
- **Marketplace agents on the roster**: `GET /api/agents` marks agents a marketplace install created
  (`marketplace`), the roster filters them and links each to its plugin; installs give each agent a face and the
  plugin's name as its team.
- **Missing tools in the second brain** ([second-brain.md](second-brain.md#4-detectors-and-suggestions)): what the
  architect needed and no node online does (it says so, or it made up a node type for an app no plugin covers) is a
  `tool.missing` event; the new **Missing tool** detector suggests "Build a tool for Grafana" on Home, with a plugin
  sketch the model writes and a link to Build a plugin. Architect asks are `spotlight.asked` with `proposals`, so one
  that made a draft isn't counted as unmet demand.
- Bugs found and fixed while checking in the browser: the prompt's closing line doubled the full stop after a
  description ending in one (`personaPrompt`); the delete icon on a saved template overlapped the card's footer, and the
  Delete? confirmation overlapped its text (it's now a strip of its own); a saved template's card showed "Your
  templates" instead of its category. In the architect's first live run, qwen3-coder proposed the same agent four
  times, sent the tones as one string, looked a node up as `http.request`, and added a "receive alert" HTTP tool and a
  Code tool for formatting: a repeated proposal is now skipped, lists sent as one string are split, node lookups take
  the short id or the name, and the prompt says triggers belong on the Deploy tab and formatting is the model's job.
- In later live runs the model copied the format's placeholder ("App: …") as the app, sent lists as unquoted
  brackets (`[Calm, Direct]`), and listed formatting with Text Toolkit, a plugin that is online, as missing. Now a
  placeholder app is replaced by the first capitalised word after the verb, bracketed lists are split, a missing item
  whose app is an online plugin is dropped (and noted), and the detector groups spellings of one app together.
- Checked live on the cluster (OrbStack, `landflow-dev`) in Chrome, in light and dark themes: the roster grouped by
  team with faces, initials and a solid icon tile; the New agent dialog with templates; the avatar picker (shuffle,
  icon, solid tile); the team picker; Save as template and an agent made from it; and the architect on
  `qwen3-coder:30b` designing "Grafana Guardian" from the Messaging plugin's Slack node, with the missing Slack
  credential listed. Its "read firing alerts (Grafana)" became **Build a tool for Grafana** on Home after a brain run,
  with the model's sketch of the plugin (Get alerts, Get alert details, Acknowledge alert).
- **Tests**: `agent-workspace.test.ts` (8: faces, avatars, teams, summaries, templates) and `agent-architect.test.ts`
  (13: drafts, the chat with a scripted model, missing tools, marketplace agents), and a `brain.test.ts` case for the
  Missing tool detector and its plugin sketch.
- What remains:
  - exporting agents as Claude Code plugins (`agents/<name>.md`, `skills/<name>/SKILL.md`, `.claude-plugin/plugin.json`
    and a `marketplace.json`), so they can be placed in a marketplace as well as installed from one;
  - installing marketplace agents into the current project rather than the default one;
  - the architect improving an existing agent, and a model picker for it;
  - building the plugin a Missing tool suggestion sketches, from the suggestion (**Build it** now starts the workflows
    that do it; the agents and flow that build a plugin are next, below).

## Building tools from suggestions (in progress, 2026-10-31)

Approving a Missing tool suggestion starts a flow of developer agents (planner, developer, reviewer) on kagent's Claude
Code runtime that write the plugin in this repository and open a draft pull request. Built so far:

- **Build it** on Missing tool suggestions ([second-brain.md](second-brain.md#5-where-you-see-it)): it records
  `proposal.applied`, and On Usage Event's **Suggestion From** filter starts the flows that build tools, each item
  carrying the whole suggestion (`proposal`). The toast names the flows; with none published, a warning says what to
  publish.
- **Network for Claude Code** ([a2a.md](a2a.md#network-for-claude-code)): kagent's sandboxes had no egress at all.
  Landflow now writes the Agent's `egressPolicyRefs` (the kagent card's **Network access**, else the credential's
  **Egress Policies**), with drift, and `deploy/kind/egress-dev.yaml` grants the package registries (Alpine, Go, npm,
  PyPI); since 2026-11-01 only through the package cache (below).
- **A toolchain image for Claude Code** ([a2a.md](a2a.md#a-toolchain-image-for-claude-code)): the Harness
  `landflow-claude-dev` runs Claude Code on one common image (Go, Node with pnpm, Python with uv, a C toolchain), served
  from Landflow's registry by digest. Nothing project-specific is baked in: a project's dependencies come over the
  network. `/v2` serves manifests with their own media type and streams blobs.
- **A package cache and Go's standard library pre-built** ([a2a.md](a2a.md#network-for-claude-code)): sandboxes reach no
  registry. `deploy/k8s/components/package-cache` (in the OrbStack overlay) runs `landflow-cache:8080` in `landflow-dev`:
  nginx in front of Verdaccio (npm), Athens (Go modules and the checksum database), proxpi (PyPI) and an nginx
  `proxy_cache` of Alpine's mirror, each on a PVC. The bridge carries it to kind, `landflow-dev-packages` allows only
  its origin, the Harness env points the package tools at it, the image's apk repositories use it, and
  `GOCACHE=/opt/go-build` holds Go's standard library built at image build time.
- **The host's data on its volume** on OrbStack (`landflow-data`, local-path), so credentials, agents and the images
  Landflow serves kagent survive a rollout.
- **GitHub flow steps**: a bundled `github` plugin (`plugins/github`, TypeScript, 7111/7211), one **GitHub** node for
  deterministic steps over the REST API: Repository Get; File Get, List, Create or Update; Files Commit (several files
  in one commit through the Git Data API, optionally creating the branch); Branch Create, Get; Pull Request Create
  (draft by default), Get, List Files, Comment; Issue Create, Comment. No delete. Pull Request Merge was added on 2026-10-31,
  for flows that merge once a Run Report passes. Agents use GitHub's MCP
  server instead.
- **GitHub from the sandbox** ([a2a.md](a2a.md#github-from-the-sandbox)): `deploy/kind/egress-github.yaml` lets
  Claude Code reach github.com and api.github.com with a fine-grained token the gateway injects (the sandbox never sees
  it), and the Harness points git's `extraHeader` at the gateway. A clone of this repository takes about 4 s, a
  filtered `pnpm install` about 11 s.
- **The team and its flow**, set up live over the API (not yet a template): the Planner, Developer and Reviewer as
  Claude Code agents on kagent (`landflow-claude-dev`, egress for packages and GitHub), and a Tech Lead, a Landflow
  agent, in **Build plugins from suggestions**: On Usage Event (Missing tool) → Brief → GitHub Create branch → Tech Lead
  → GitHub Open draft pull request. The team are the Tech Lead's sub-nodes on the canvas: its chat model, a memory per
  suggestion, the three agents as A2A Agent tools and GitHub Check branch as a tool, so every hand-off is a sub-node
  run with its input, output and live steps.
- **Watching it run** ([agents.md](agents.md), [a2a.md](a2a.md)): the Agent session panel under the canvas, a
  teammate lit with a caption of its current step, its Claude Code steps streaming into the detail pane, and the
  steps kept in the output afterwards.
- **First runs** (2026-10-31): on "Build a tool for Grafana", the first run (the team as the Tech Lead's own A2A
  capabilities) took 42 minutes and opened draft pull request #1 with three commits: the plan, the plugin and its
  README. The work was weak: Alertmanager v1 paths, compiled `.js` committed next to the sources, a test that only
  checked the description, and a Reviewer that edited files and still approved. The agents' instructions now ask for
  the API's current version, a test per node against a fake server, no build output, a git identity per agent, and a
  Reviewer that only reads and runs. The second run uses the canvas form above.
- **Checked, then merged** (2026-10-31): v3 of the flow puts a Run report after the Tech Lead. When every check
  passes it opens the pull request, posts the report and merges it (the GitHub node's **Merge**); otherwise the failed
  checks go back to the Tech Lead, up to 3 rounds, then a draft pull request waits for a person. Its first run was
  sent back once (typecheck failing, the Reviewer editing), fixed in round 2 and merged pull request #3 after 41
  minutes.
- Next:
  - ✅ the team and flow as a template (agents, the workflow and its credentials named) instead of a setup script: built ([templates.md](templates.md)), with agents and teams exported as Claude Code plugins ([marketplace.md](marketplace.md#export-agents-as-plugins));
  - GitHub's MCP server as an agent tool, for reviews and comments on the pull request;
  - project dependencies baked into the image or a warm project cache (the package cache keeps them local, not
    installed).

## Run Trace (built 2026-10-31)

Watching and reviewing what a run did, for any flow, phone first ([run-trace.md](run-trace.md)). Phases 1 to 3 of the
approved plan:

- **The journal** (`execution_events`, migration 2000): actors, spans, messages, artifacts and checks per execution,
  written by the runner's translator, Landflow agent sessions, the A2A Agent node (every remote step kept, failed ones
  marked failed, `isError` results included), approvals (web, Slack, email) and the Run report gate. Redacted, cut to
  32 KB per event (**Content kept**: full, summaries or off), batched about twice a second, kept 30 days, live as
  `journal` events.
- **Artifacts and checks from any node**: `ctx.artifact` and `ctx.check` in the TypeScript, Python and Go SDKs,
  `ExecuteResponse.records` over every transport, the engine's `node.record` event. The GitHub plugin reports its pull
  requests, issues and branches.
- **The screens**: Run trace next to Canvas on every execution and full screen at `/runs/<id>`. They have a header with
  who is working now, Needs you, and the Story, Trace, Team and Report tabs. Details open in a sheet, and a time slider
  replays the run. Needs you and live cards appear on Executions.
- **Checks, profiles and the report**: the built-in checks (six since 2026-10-31: Agent notes committed), the Generic, Software delivery and Customer support
  profiles (or a custom one as JSON), the structured reply block, and the **Run Report** node. The node saves the
  report with the run, outputs it as Markdown to post, and gates on failed checks by sending the work back, asking a
  person or only warning.
- **What a run made** (2026-10-31): an **Artifacts** tab with code changes per file (pushed or never pushed, a diff
  per agent or combined, and the branch as GitHub sees it through the GitHub node's **Compare**), Markdown documents
  rendered, links and JSON data; file steps open as diffs in the detail sheet ([run-trace.md](run-trace.md#artifacts-and-code-changes)).
- **Iterations** (2026-10-31): rounds of a loop with why each went back, each agent's turns with the reason it gave
  for every request, members' words between their tool calls, and fix cycles from check commands
  ([run-trace.md](run-trace.md#iterations-rounds-turns-and-fix-cycles)).
- Artifacts, the rest (2026-11-01): images, CSV tables (one card per row), HTML pages in a sandboxed frame and PDFs in
  the Artifacts tab and the detail sheet, from `lib/shared/artifact-kinds.ts`; another server's image or PDF loads only
  when tapped. Line comments on any diff line, kept per run in the browser, fill the gate's **Note for Send back**.
- Still open from the artifacts plan: reasons from delegating nodes of other plugins (the Go and Python SDKs declare
  `delegates` now; plugins still have to set it); fix cycles per round; a lead's claims credited with its team's steps;
  line comments shared between people (they live in one browser).
- **Phase 4, first part** (2026-11-01): a Claude Code member's model requests are `model` spans under its request;
  `GET /api/runs/search`, `/compare` and `/measures` with a Search runs page, a compare view and a duration, tokens and
  cost trend; `LANDFLOW_OTLP_TRACES_URL` exports each finished run's journal as one OTLP trace with OpenInference kinds.
- Next (phase 4):
  - other agents' spans joined by trace id, starting with Claude Code's own OpenTelemetry;
  - ~~OTLP export with OpenInference kinds~~, ~~search and comparison across runs~~ and the generic measures over time
    are built (2026-11-01, [run-trace.md](run-trace.md#search-compare-and-measures)); a profile's own measures are open;
  - ~~re-run from a span, and Copy to editor with the run's data pinned~~ and ~~pausing a running agent so a person can
    take over~~ are built (2026-11-01, [run-trace.md](run-trace.md#run-it-again));
  - **Content kept** per project.

## Agent teams (built 2026-10-31)

Agents as a team with standing relations instead of tools under a node ([agent-teams.md](agent-teams.md)), in the
four steps of the approved plan:

- **The record**: a reason on every request between agents, members' words, rounds, turns and fix cycles in Run Trace.
- **Members that remember and ask back**: one A2A conversation per member per run; a member's question goes to the
  agent that asked it first.
- **Teams on the Agents page**: an org chart of Landflow agents and remote agents (one lead, one manager each,
  reviews, budgets, where questions go), saved, published and moved between projects like agents.
- **Run a Team** (`core.runTeam`): the team as one flow step, with goal ancestry, reviews before a manager reports
  done, budgets, members named by title in the trace, **Turn into a team** in the editor and in Spotlight.
- **Watching it work** (after the first runs): a running team node becomes the member at work (face, title, plain words,
  its last steps), with a ribbon of turns and the moments that matter (tests, typecheck, pull requests, a review's
  verdict); it keeps a summary after the run; the execution view's Agent session panel follows the lead and names the
  member working; phones get a Now card and an executions page that shows one thing at a time; the team page is an
  aligned chart of cards; Spotlight turns a team written by name into its id. Then: a run outlives the editor that
  started it (Stop asks the server, the editor picks a running run up again and keeps a growing live node in view); a
  manager answers from what its reports said (file names it made up send it back once); Spotlight stops once a request
  is proposed and doesn't add back a node it was asked to remove; the AI builder pins one sample item for agent flows.
- **Closing the gaps** (2026-11-01): a member's question for a person pauses the run and the team goes on with the
  answer; a manager's own reports show at work in the live status; reviews are seen to by the nearest manager of both,
  with a reviewer's `VERDICT:` as the sign-off; a remote member that reports no usage is budgeted on an estimate; a
  manager's made-up commits, test counts and pull requests send it back like file names, and members are told the
  tools they have in the run; a span keeps one check per member; the Go and Python SDKs declare `delegates`; the
  second brain's study knows Run a Team; a renamed team shows its new name on flows.
- **The live view, finished** (2026-11-01): a member's tokens against its budget as a bar on the node, the Now card, the
  Run Trace's Team chart and the team page's **Last run** card (amber at 80%, red once used up, with moments for both);
  a question for a person turns the node amber with the question and an **Answer** button; each turn on the ribbon opens
  that member in the Run Trace; the Story opens with the run's **Headlines**.
- **Tool approvals and consults** (2026-11-01): a tool that needs approval pauses a team run for a person (Needs you,
  Slack or email, **Approve** / **Deny** on the node and the phone card; the decision is an *Approval* check); members
  may **consult** peers and **hand a task over** (`consults`, the `consult_` and `hand_off_to_` tools), shown on the node
  with both members ringed, on the team page as dashed chips and in the Run Trace under the member that asked.
- Next: tools of a Claude Code member on kagent asking for approval; Paperclip-style autonomy (heartbeats, a team inbox of
  tasks) is left out on purpose for now.

## Claude Code agents report what they use (built 2026-11-01)

kagent's Claude Code harness sends no token usage over A2A, so runs estimated what Claude Code agents spent. Now every
Claude Code agent Landflow deploys gets Landflow's own mod ([a2a.md](a2a.md#the-landflow-harness-mod)):

- **The latest Claude Code**: `landflow-claude-dev` installs 2.1.316 (mods need 2.1.287) behind a wrapper that answers
  `claude --version` with kagent's compiled-in 2.1.285, which kagent checks strictly.
- **landflow-harness** (`apps/web/claude-plugins/landflow-harness`), packed from the host and added to every Claude
  Code deploy when the credential names a Plugin Registry: a request's marker line gives it a trace URL, and it posts
  each model request's tokens, model and time, each tool call's, the subagents and the turn's end to
  `POST /api/agent-trace/:id`. It also guards tool calls (secret files, printing the environment, pushes to main and
  force pushes, merges, git auth settings, wiping the machine, uploads, writes outside the workspace) and masks tokens
  and keys in tool results.
- **In the run**: a call's usage is the real one, priced per request (5.5 models' cache reads at 5% of input, Haiku 5.5's
  long-context tier); team members carry tokens in and out, cache reads, cost, model and time; the Team tab and the
  actor sheet show them; the Report has **What each agent used** and the run's cost; guardrail stops and masked secrets
  are checks.
- Since then: the mod's model calls are their own spans (`d211811`), and each agent has its own guard, Read-only, Normal
  or Report only, chosen when it is deployed, and in queue mode a worker's live steps, budgets and real usage show on
  any main (2026-11-01).
  Live budget use from the trace while a member works shows on the team node since 2026-11-01.
- The guard asks a person about a push to main, a force push and deleting a remote branch instead of refusing them (Normal
  mode; Read-only still refuses, Report only never blocks): an `ask` event, a wait in Needs you and on the team node, a
  long-polled answer, an Approval check; the run is not paused ([a2a.md](a2a.md#asking-a-person)). Needs the harness image rebuilt.

## Team notebook (built 2026-11-01)

Agent team members start every run from what they are handed. They now share a notebook ([team-notebook.md](team-notebook.md)):

- **Notes**: facts, decisions, open questions, task status and artifact references, each with its author, run, span and
  source; run notes (14 days), team notes (30 days after last use, unless verified) and project notes (a person's approval
  through the second brain's inbox).
- **Tools**: `note_add`, `note_search`, `note_update`, `note_dispute`, and `note_promote` for managers; Claude Code
  members on kagent get the same through the MCP server, bound to the run that is waiting on them.
- **Trust**: notes from outside are tainted until a person verifies them; disputes keep both notes until one is kept;
  `traceContent: off` keeps provenance and drops excerpts.
- **See it**: the team's Notebook tab, note moments on the canvas and in the headlines, deep links into the Run Trace.

## GitHub's MCP tools for agents (built 2026-11-01)

Agents read and review pull requests through GitHub's own MCP server ([a2a.md](a2a.md#githubs-mcp-tools-for-agents)): an
**Add GitHub MCP** capability (an `mcp` tool with `preset: 'github'`), a Bearer Auth credential holding the token, the
pinned image `ghcr.io/github/github-mcp-server:v2.0.2` as a component in the OrbStack overlay, and a server-side
allow-list per agent (read for every member; review, line comments and comments for the Reviewer; merging and every
branch, file and repository write never offered). Kagent members get the same cut through the agents' MCP endpoint, and
Run Trace shows it with GitHub's mark. Not live-checked against GitHub with a token.

## Runbooks from Landfall war rooms (built 2026-11-01)

A closed room's applied remediations, chat and outcome fold into a draft workflow ([runbooks.md](runbooks.md)): a form wait per
step, an approval before risky or production-changing steps, tagged by alert kind. **Runbooks** in the sidebar makes and
lists them; the **Find Runbook** node and the triage flow name the matching one and link it in the new room (**Timeline →
Add Runbook Link**); **Incident → Get Room** reads a room for it. Deterministic, no model.

## Browser plugin and retry backoff (2026-11-07)

From the review of [Vercel's open source](https://vercel.com/oss) for what Landflow could use. **Built:** a **Browser** node plugin on Vercel's agent-browser CLI (read a page, run listed steps, take a screenshot; a required allow-list of sites, an operator ceiling, fenced and capped page text, no shell) in [plugins/browser](../plugins/browser/README.md); and `retryBackoff: exponential` for node retries, with the wait between tries now in the node's Settings. **Looked at and left out:** the Workflow SDK (a replay engine for compiled code; Landflow already checkpoints, resumes and re-arms timers, and its graphs are user-drawn data), Streamdown (the app renders no streamed markdown; the one `react-markdown` use is a finished document with stricter rules than Streamdown's defaults), and a durable timer table (timers already re-arm from the store at boot). **Checked live:** the Browser node filled and submitted a real form (served locally) in a seven-node flow Spotlight built, and the ticket it extracted matched the one computed independently. That run found and fixed a Spotlight bug (a conditional hook call, `useWorking() || useBuilding()`, made React's hook order change whenever a build began) and added output fields to what Spotlight reads about a node. The Workflow SDK spike (interpreter workflow, Local and Postgres worlds, a 200-node graph, a `kill -9`) is in [the research notes](research/workflow-sdk-spike.md). **Built later the same day:** json-render (`@json-render/core` and `@json-render/react` 0.21.2) draws Status, Diff and Approval cards from a model-written spec behind `LANDFLOW_JSON_RENDER=1` (off by default), after a strict validator drops unknown components and rejects expressions, extra props, actions and state; a dev page shows the cards, and nothing writes specs yet ([verdict](research/json-render-verdict.md)); an opt-in **AI SDK** plugin (`plugins/ai-sdk`, `pnpm plugin:ai-sdk`, HTTP 7115, gRPC 7215) with one node, Generate with AI SDK (Ollama, an OpenAI-compatible endpoint, Anthropic or Google; text, usage and model out, optional JSON-schema output, not usable as a tool), whose `@ai-sdk/otel` spans go through the plugin's telemetry as children of the node span and reach an OTLP backend ([verdict](research/ai-sdk-verdict.md)); and just-bash as an **Agent Shell** plugin, an in-memory bash usable as an agent tool ([verdict](research/just-bash-verdict.md)). **Built after that:** the AI SDK node reports usage to the host (`ctx.model`, `meterAiUsage`), counts against the AI usage caps and shows a `model` span in Run Trace. **Built after that:** Agent Shell and Web Search are packaged (compose profiles, k8s components, `pnpm dev:all:agent-shell`, `pnpm dev:all:web-search`). The capped deepsec scan (W5d) was dropped by the user (no API key; local Ollama only).

## Debugging, chat with agents, Browser and Web Search (2026-11-07)

Built by parallel workstreams ([the plan](specs/17-parallel-build-plan.md), notes in [17-notes](specs/17-notes)); each row names its workstream.
**Debugging a remote workflow** (W1a, W1b): the instance MCP server can debug a failed run (`explain_failure`, `get_run_trace`, `get_plugin_logs`, `retry_execution`, `run_node`), `get_node_type` returns `outputSchema`, and `validate_workflow` catches a read of a field the node before it does not write; the CLI has `debug-bundle`, `replay` (minimal), `claude init` and `executions watch`. Open: a scratch host the CLI starts itself (`replay --spawn`), a fake-plugin transport for replay, and merging into an existing `.mcp.json`.
**Chat with agents** ([spec 16](specs/16-chat-with-agents.md), W2a to W2c): step 1 (labels from Run an Agent and Run a Team, stored on the transcript, shown on the page, the "Chat with a team" template), step 2 (the roster option, config, `agentKey`, start at the target, per-agent memory ids, the page's chips; later a guardrail for roster targets: route on `agentKey` after Guardrails, with a validation warning for targets that bypass it) and step 3 (the Voice option, config fields, microphone and speaker in the shared client, reading rules). Built later: the roster Node picker, the session check for a picked agent's feedback, warnings for fixed or by-name Session Keys, a remembered speaker toggle and streaming speech. Open: labels for non-streaming chats and for the AI Agent node, and a local speech service behind the same buttons.
**Browser** (W3, W3b): a step builder, Extract steps, per-step results, a screenshot after steps and a host-defaulted allow-list; the plugin packaged with its own Chrome image, a compose profile, a k8s component and `pnpm dev:all:browser`. The output-panel PNG preview needed no work: the DataView Binary tab already previews images. Built later: Continue On Failure for Act on Page (a failed step returns `ok: false`, `stepsFailed` and the results so far), and the image built and run on arm64 (arm64 installs Debian's chromium; amd64 checked for the install step only). Open: an option to keep fences on extracted text, and the whole image on amd64.
**Spotlight reliability** (W4): wiring, purpose and swallowed-error warnings on a proposal, and a retry when an announced card never appeared.
**Chat with a team fixes** (built later, 2026-11-07): a picked specialist no longer fails with "The message is empty" (the template's `$fromAI` falls back to `chatInput`, and Run an Agent does too), answers show the roster face or the agent's avatar, Run an Agent delegates with a required `reason` so the page shows "asked <Agent>: <reason>", the template's canvas layout no longer overlaps, and its agents use `qwen3-coder:30b` at `OLLAMA_URL`. Run a Team has `delegates: true` since the finish batch.
**Spotlight collections and agent wiring** (built later, 2026-11-07): the docs and flow-builder catalog show how collections are stored, `validateOps` checks collection shapes, unknown keys and option values, a tool node wired after an agent as a step is warned, a new node with an unset required credential gets a chip, and the builder's test data loses chat-trigger junk. Open: the warnings are noisy for legitimate steps after an agent, and checks for expressions and dynamic options.
**Retry backoff for composites** (W6): composite frames keep the retry wait and `retryBackoff`, in the protocol type and schema, `composites.ts` and the Go SDK's starter nodes. Jitter was left out.
**Web Search** ([web-search.md](web-search.md)): a SearXNG, Brave Search and Tavily node usable as an agent tool; this closes "agents have no web search". Candidates left: per-agent site allow-lists, a shared (cross-replica) search budget, a news and image mode, and a search-then-read helper that passes top results to the Browser node.
**Debug token** (W1c, [spec 19](specs/19-debug-token.md)), first half built: a short-lived read-only token bound to one execution (`landflow debug-token`), accepted only by `explain_failure`, `get_run_trace` and `get_execution`, redacted, audited per call, expiring, listed and revocable. The Debug access dialog on the Run Trace page (mint, list, revoke) is built. Open: the one-node local override (it needs its own design for what the local plugin may see), a Settings-wide list of tokens, and a per-minter token cap.
**Image tool results** ([spec 18](specs/18-desktop-agent-node.md), phase 1): tools can return images to the AI Agent node (`{ text, images }`, or a node tool's `item.binary`), stored by reference and read back last-N. **Built later the same day:** the persona runtime (Run an Agent, teams, members) and image limits (1568 px, 4 MB, sharp); `LANDFLOW_TOOL_IMAGES_KEPT`. **Built after that:** the thumbnail in Run Trace and the `toolImagesKept` entry in AgentSettings. Open: `computer` toolset blocks and the Desktop node.
**Specified, not built:** the rest of [spec 18](specs/18-desktop-agent-node.md), a Desktop agent node driving a disposable virtual desktop.
## Eight layers around a model

Compared a reel on what surrounds a model (system prompt, RAG, tools, access, guardrails, cache, router,
observability and evals) with Landflow. Built: **version restore** and the **eval gate** ([agents.md](agents.md#eval-gate)):
a publish that scores worse than the published version on the agent's own test cases is held; and the **model router**
([agents.md](agents.md#model-router)): easy requests go to a cheaper model by a plain rule (the savings tile and a gateway
tier header are still open); and **prompt caching** of the system prompt and tools for Anthropic agents
([agents.md](agents.md#prompt-cache)); and an exact-match **response cache** ([agents.md](agents.md#response-cache)).
Also built: **tool access by caller** ([agents.md](agents.md#tool-access): per-agent rules, plus OPA or OpenFGA through
one port) and a **layers checklist** with a fix per missing layer ([agents.md](agents.md#layers)). The router and cache cards now say how many of the newest requests each handled ([agents.md](agents.md#layers)). Also built: a **semantic cache**
([agents.md](agents.md#response-cache)), a **test panel** for tool access ([agents.md](agents.md#tool-access)) and an **LLM
gateway** (agentgateway as a compose profile and a Kubernetes example, [agents.md](agents.md#model-router); kgateway's own
Envoy AI Gateway is deprecated, so the plan's kgateway item became agentgateway). The Insights page has an **Agent layers** card with the same numbers
for every agent.

A second pass over the reel's scenes (what each shows against what Landflow has) found three guardrail gaps, all built
([agents.md](agents.md#building-an-agent)): a **tool-result guardrail stage** (an email or web page the agent reads can carry planted
instructions, which the input stage never saw), a **grounded** output check (does the answer follow from the passages the
agent's knowledge bases returned?) and **stay on topic** in the builder (the engine had it; the builder did not offer it).

Then **Jev and AWS Strands Decider as guardrail judges** ([agents.md](agents.md#building-an-agent)): TypeSafe AI’s Jev and AWS’s open-source Strands Decider are decision models (text and
yes/no questions in, a probability per question out), so it cannot be a chat provider; it answers the guardrail checks that need a
model instead, from a *TypeSafe API* credential chosen on the rule. Open: a Decide node, the model router and cost counting.

## Flow detectors (built 2026-11-12)

A workflow could already reach the same conclusions as the brain (Schedule or On Usage Event → Landflow Usage → an AI
Agent → Suggest Improvement), but its suggestions were second-class: source `workflow`, so they never quieted, expired,
were measured by detector or showed in Insights. **Built:** **Detector Trigger** (`core.detectorTrigger`). A published
workflow that starts from it is the detector `flow:<workflowId>`. The brain runs it after the built-in detectors on its
tick and on Run now, handing it `quiet`, `minConfidence` and `lastRunAt`; its Suggest Improvement nodes post as the
detector. Quieting (with a confidence bar), the 14-day expiry, the effect baseline, Insights (record and a **Run** per
detector) and **Suggestion From** all work for it unchanged ([second-brain.md](second-brain.md#flow-detectors)).

## The brain's own conclusions, wave 2 (built 2026-11-12)

The nine items planned after flow detectors, built the same day ([second-brain.md](second-brain.md)):

- **Custom event kinds and Record Event.** Flows can now write their own events into the usage ledger. A kind such as
  `work.ticket_moved` is declared once with its fields (`usage_kinds`, `/api/usage/kinds`); the Record Event node
  checks each event against that shape and records it about the workflow or agent it concerns. On Usage Event fires on
  custom kinds and filters on attributes, and Landflow Usage and `/api/usage` filter and group by an attribute ("tickets
  moved per team"). A flow that starts from On Usage Event can't start another through the events it records.
- **Entities.** The brain reasons about more than workflows and agents. An entity registry (initiatives, people, customers, systems) with
  an owner, a project and flat attributes gives it things no workflow holds; facts and suggestions are addressed to
  `entity:<type>/<id>`, the study profiles them, Find Similar and the MCP `check_overlap` search them (other projects only as
  the six-field projection), and an Entity node lets flows and agents keep the registry and note facts. This is what an
  overlap finder ("two teams run the same initiative") needs.
- **Actions decided by the flow.** The brain's suggestions are no longer dead ends. A flow can put its own buttons ("Intro us", "Book 15 min") on a suggestion, and every decision (apply, dismiss, snooze or a button) starts the workflows on On Suggestion Decided with the whole suggestion and what was decided, so the loop closes in a flow: the detector finds, a person decides, a flow acts. Build it for missing tools runs on the same path.
- **Suggestions with an audience.** A suggestion can now be about two people in two projects. A flow addresses it to named people (emails or Slack ids); they see it in their inbox whatever it is about, with only what it says, and optionally get it as a Slack DM with the suggestion's own buttons plus Apply, Dismiss and Snooze. Deciding in either place updates the other: one record, every message shows who decided what.
- **Find Similar and the brain over MCP.** a Find Similar node and `check_overlap` tool answer "is anyone already doing this?"
  with the nearest workflows, agents and facts, in full for the caller's projects and as a six-field projection (type, title,
  owner, goal, project, score) for the rest. The instance MCP server serves the brain (`brain_search_facts`,
  `brain_list_suggestions`, `brain_workflow_knowledge`, `brain_usage_report`, `check_overlap`, `brain_suggest`). Workflows and
  agents can no longer read the brain's vector collections with a Vector Store node. Open: a stricter embedding-only ranking
  mode, a per-token read-only flag for `brain_suggest`, and showing Find Similar in the editor when a workflow is created.
- **Effect metrics declared by the flow.** A detector flow can say how its own suggestions are judged: a query over the usage ledger (custom events included, counted,
  summed or averaged, about the target or the whole instance) or a sub-workflow returning a number, with a name and a
  direction. The suggestion keeps it, the baseline and the 7 and 14 day checks use it, and the outcome fact names it, so an
  overlap finder can report "initiatives merged or reused" going up.
- **Backtesting detectors.** Backtesting closes the loop on tuning: detectors were quieted only after people dismissed noise. Now a detector, or a threshold change (the `quiet` override), is replayed over the last 30 days and scored against the decisions already made, so a change can be judged before it ships. Built-ins run on a ledger view that stops at each point; detector flows run with a run-level backtest flag that makes Suggest Improvement return findings instead of posting.
- **Ask a Person.** A flow can now ask a person without an AI Agent: the Ask a Person node waits durably, on the
  same mechanism as tool approvals, and outputs the person's answer (approved or rejected, the text as they edited it, a comment, who and
  when). The Run Trace shows "Waiting for <person>: <title>" with the draft and Approve / Edit / Reject; Slack gets the same three buttons
  and an edit modal; email gets signed links. A timeout settles with the node's default (reject, approve or fail). Still open: asking per item,
  editing from email, and a Landflow inbox page of its own (the Run Trace's Needs you is the inbox).

## Integrations that report activity (built 2026-11-12)

Phase A of the Company Brain sources: integrations that report what people do, in one shape, so one flow can record any
of them ([protocol.md §16](protocol.md#16-activity-items), [integrations.md](features/integrations.md)). **Built:**

- **Activity items** in all three SDKs (`activityItem`, `landflow.ActivityItem`, `activity_item`) with a JSON Schema and
  shared cases.
- **Slack**: Message → Get Many Since and Get, User → Get Many with email, channel name patterns, the **Slack Activity
  Trigger** (Events API, signature checked).
- **Google**: the **Google Drive Trigger** (changes feed, shared drives) and **Google Calendar Trigger** (sync token,
  attendees), Drive → Get Many Changed Since and Get Item, Calendar → Get Many Changed Since, and the **Google Directory**
  node.
- **Notion**: the **Notion Trigger** (under chosen roots), Page → Get Many Changed Since and Get Content, User → Get
  Many with email, Comment → Create.

**Built (Phase B):** the [Linear](../plugins/linear/README.md), [Attio](../plugins/attio/README.md) and
[Fathom](../plugins/fathom/README.md) plugins (TypeScript, 7116–7118): each a trigger that registers its own signed
webhook, Get Many Changed Since and Get as activity items, users with email, and actions that create (Linear issues,
links and comments; Attio notes, tasks and list entries), none that delete or merge. In `pnpm dev:all`, compose and
the Kubernetes base.

**Built (Phase C, part 1):** the `work.*` kinds catalogued in `deploy/brain/work-kinds.json` and declared with
`pnpm brain:work-kinds`, and the [work ingest templates](features/integrations.md#work-ingest-templates) for Slack, Drive,
Calendar, Notion and the Directory, then for Linear, Attio and Fathom.

**Next:** the P1/P2 sources ([follow-up note](research/company-brain-next-sources.md)), and a way to join a customer named by a domain (Calendar, Fathom) with
the same customer named by a channel or folder. Open from Phase A: a Notion webhook trigger once Notion can create subscriptions over its API; push channels for Drive and Calendar
once app webhooks can renew themselves; Slack message edits and deletions; the Directory's groups and org units.

## The Brain page (built 2026-11-12)

`/brain` opens the second brain as a repository of Markdown files in an editor's workbench
([second-brain.md](second-brain.md#the-brain-page)): an activity bar (Explorer with Outline and Backlinks, Search,
Timeline, What Landflow knows), a tree of `index.md`, `log.md` and a file per entity, tabs with a Preview and a Source
(the page as Markdown with frontmatter, links and references), quick open, a Problems and Suggestions panel, a status
bar, and Spotlight at the bottom of the editor to ask the brain. A page has a summary the brain's model writes (page
links, numbered references to the work, stale once new work lands), its work, people, related pages, facts and
mentions. "What Landflow knows" moved there from Insights. The layout follows a look at how other products show a
company brain ([research/brain-ui-research.md](research/brain-ui-research.md)); the user then asked for an editor's
workbench in place of a page of cards, keeping Spotlight.

- **Found while checking it**: a local model turned person ids into surnames ("Tal Northpeak" for
  `tal@northpeak.example`); the prompt now gives every link with its name, and names the model writes plainly are
  linked on their first mention.
- **Checked live** on a scratch host with 17 made-up work events across eight people and seven teams, with
  `qwen3-coder:30b` on Ollama: the tree and its marks, Preview and Source, quick open, the Problems panel, Search and
  Timeline, a summary with links and references, Spotlight from a page (its links opening tabs), tabs kept across a
  reload, and the phone layout with its drawer.
- **Next**: relations between entities of their own (not only through shared work), editing a file's frontmatter in
  the Source, filing a good answer back as a fact, and a detector that turns shared work into a suggestion addressed to
  both teams.

## Backend hardening (2026-11)

- **P01** (C1, C2, O1): `lib/server/lifecycle.ts` is the one place for the process lifecycle. A main now stops on SIGTERM
  / SIGINT in phases (requests, services, runs, cluster, storage, telemetry): it flushes the Postgres queue, releases
  the leader lease and flushes telemetry. A failed required boot step (database, cluster) exits the process instead of
  serving 500s for ever; an optional one is logged and counted. The host logs and counts unhandled rejections and
  uncaught exceptions.
- **P02, typed configuration and the production profile** (C5, C6, C7, S15; wave 1): `lib/server/config/` (parsers that
  never give NaN, `profile()`, `publicUrl()`, `ollamaUrl()`, `checkConfig()`); the public URL and Ollama address are
  read in one place, six NaN-prone numbers fall back with a warning, and the in-repo stacks say `LANDFLOW_PROFILE=development`.
  Booting through `checkConfig()` follows in a later package.
- **P03** (C16 step 1, O4): Postgres mode never drops a write batch. A batch Postgres rejects five times blocks the store (writes refused with `StoreUnavailableError`, retried, `LANDFLOW_PG_SKIP_BATCH` to set it aside), the spool is one fsynced descriptor, and `writeHealth()` plus five metrics report the queue ([postgres-write-queue.md](features/postgres-write-queue.md)).
- **P04, execution retention in SQL off the save path (C17).** `pruneExecutions` selects ids by column in chunks and a finished run triggers it only every `LANDFLOW_RETENTION_EVERY` runs.
- **P05, SCIM audit, Stop all for admins, project scoping for AI usage and files** (S2, S4, S12 part): SCIM changes and rejected tokens are audit events; stop-all is admin-only; members' AI usage and file reads stop at their projects.
- **P06, one runtime for main and worker; routes wait on readiness; configuration checked at boot** (C9, C8, C6, S15; contributes to C5): `lib/server/runtime.ts` holds one service table for both roles, `bootstrap.ts` is a thin compatibility module, the production check runs first at boot, and `handler()` / `scimRoute()` no longer import the composition root (static closure of `http.ts`: 401 files before, 72 after).
- **P07, liveness and readiness probes** (C3, O2): `GET /api/health/live` (no I/O; Next holds requests until boot ends, so a startupProbe covers a slow boot) and `GET /api/health/ready` (boot, draining, database, write queue lag, schema version, Valkey in queue mode; 503 otherwise) replace `/api/health` as the Kubernetes, Docker and smoke-script probes; `/api/health` shows plugin and run counts only to callers with credentials.
- **P08, plugin registration closed outside development** (S3; wave 2): `registryOpen()` refuses announces without `LANDFLOW_REGISTRY_SECRET` in the production profile (HTTP and gRPC); with the secret every announced endpoint proves it holds it; joining an existing plugin from a new host needs the secret or `LANDFLOW_REGISTRY_ALLOW_JOIN`; `plugin.endpoint_added` and `plugin.updated` are audited; the announce route's 422 is generic and metadata addresses are refused in production.
- **P09, trusted proxies, public URL for emailed links, signed resume URLs** (S6, S12 part): `clientAddress()` trusts `X-Forwarded-For` only up to `LANDFLOW_TRUSTED_PROXIES` hops (sign-in limits, audit and webhook allow-lists use it); invite and reset links never come from request headers in production; resume URLs carry an HMAC `sig` that production requires (`LANDFLOW_RESUME_SIGNATURES`), old waits keep working.
- **P10, security headers and a nonce CSP** (S10): the proxy sets nosniff, referrer and permissions policies, frame denial, HSTS
  over https and a per-request nonce Content Security Policy on pages (`LANDFLOW_CSP`: enforce in production, report in
  development; `LANDFLOW_HSTS`); embeddable paths keep their own policy; `x-powered-by` is off.
- **Wave 1 carryover** (applied in wave 2): retention counts and the `LANDFLOW_RETENTION_EVERY` floor, the blocked
  Postgres store's 503 and sink fixes, an earlier shutdown registration and capped intake wait, the compose grace
  periods, a load balancer that skips a main that is not ready, AI usage groups and Stop all's key scope, capped SCIM
  failure events, URL-list redaction, an atomically created encryption key. Deferred, each for a later package:
  - a `(status, started_at, id)` index on `executions`, so the retention count pass stays cheap at a very large cap
    (a migration; nothing slow at the default 300);
  - `LANDFLOW_PG_SKIP_BATCH=<instance>:<seq>`, so in queue mode the variable can't set aside another process's batch
    with the same number (documented: set it on the blocked process only);
  - `leaderService()` in regular mode keeps its entries until shutdown, so they accumulate across a test file (tests
    only; a by-name replacement needs care for hot reload in queue mode);
  - the AI and RAG nodes' default Base URL is computed when the node list is built at import, not per request (the
    runs themselves read `ollamaUrl()` at call time);
  - tests still missing from wave 1: SCIM `PUT /Users` and `PUT /Groups` events, the 10,000-address eviction, and
    access-scope cases for evaluation-dataset files, a live run's file and an agent the member can open.

- **P14, expressions in a sealed realm and Code nodes out of the host in production** (S1): expressions run in a fresh
  `node:vm` context with code generation off, no host object inside and only JSON text crossing the boundary
  (`packages/engine/src/sandbox/`), so `$json.constructor.constructor('return process')()` finds nothing; `async`, `await`
  and `import(` are refused because an unhandled rejection from any context would end the host process. The production
  profile runs Code nodes only in the code runner unless `LANDFLOW_CODE_IN_PROCESS=true`; the in-process context also loses
  `eval` and `new Function`. An isolate backend remains for a later package.

## Planned next

1. **Declare event kinds in the UI**: kinds are declared over the API or by Record Event's *Declare Kind If New* only.
2. **Relations between entities** and a detector that looks at them (two initiatives with the same goal); the page per
   entity is built ([the Brain page](#the-brain-page-built-2026-11-12)).
3. **Find Similar in the editor**: show likely overlaps when a workflow is created; a stricter embedding-only ranking mode.
4. **Ask a Person per item**, and editing from email.
5. **A chart of a declared metric**: baseline and checks over time on the card.

Other follow-ups above are candidates too, among them making a runbook automatically when a room ends and steps that call a plugin instead of asking a person ([runbooks.md](runbooks.md#not-built)).

## Spotlight: your agents, and autonomous mode (built 2026-11-12)

Spotlight's chat and the AI flow builder were told only the published teams, so a step that needed an agent always got a
new AI Agent. Now they get the published agents too, with what each does, its skills and tools, and a rule: run one that
fits with Run an Agent, use a plain AI Agent for a small step, and otherwise say a dedicated agent is needed and propose
one (`newAgent`). The Agent architect designs it: a local model, the tools it needs and a knowledge base when it works
from documents ([assistant.md](assistant.md#agents-and-teams), [agents.md](agents.md#agent-architect)). A new AI Agent
step that wouldn't run here becomes such an agent. Autonomous mode, on by default, removes the clicks: a drafted flow
goes straight into Test and fix (with test data pinned on its trigger), a chat reply's changes are applied and tested as
it ends, and a new agent is published so the flow can run it; publishing the workflow still waits for a person
([assistant.md](assistant.md#autonomous-mode)). Next: the first-draft builder proposing a new agent too, and the Agent architect opening on the draft with the step's
context.

## Spotlight's panel (built 2026-11-12)

Spotlight's conversation used to show in three places: a bar at the bottom of the canvas, a small window above it and,
while it worked on its own, a card at the top left that covered the flow. It is now one panel at the right of the
canvas, never over it: a column on a desktop that folds to a strip, a sheet under the canvas on a phone. Its header says
what Spotlight is doing, and its timeline lists each run, fix and agent it designs as a row. A fix leaves a bubble on the
nodes it changed until you close it (or a minute passes), Spotlight's own runs make no toasts, and the app's left menu
folds to icons ([assistant.md](assistant.md#the-spotlight-panel)). A Fable review of the old layout set the design. Next:
resizing the column, and keeping a fix bubble's text after it closes (the timeline has it).

## Not planned

Later, maybe: an agent code sandbox, and prompt management. Not planned:
Later, maybe: browser use, an agent code sandbox, spoken replies and realtime voice (dictation into Spotlight is built), and prompt management. Not planned:
RPA, process mining, an app builder, and a chat hub (n8n is retiring its own).
