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
  stored hashed; OpenAPI 3.1 at `/api/openapi.json` and the API reference on the Developers page.
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
  [observability.md](observability.md#8-token-and-cost-tracking). Wave 6 ✅: caps per credential and
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
- **Agents outside Landflow through the LLM gateway** ([llm-gateway.md](llm-gateway.md#agents-outside-landflow)): with a
  gateway cluster URL and the server's admin key, a deployed kagent agent gets a virtual key of its own (budget = its
  dollar limit, blocked when removed, never deleted), kagent's ModelConfig and the Claude Code harness call the gateway
  with it, and the leader's spend import copies the calls into `ai_usage` once each, so caps and Insights count them.
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
- **Plainer agents list and persona (B25, backbone wave 4; P-ag-1 to P-ag-3, P-ag-8)**: the persona strip only with no
  agents, filter chips with no agents hidden (one row), cards with a name, description and status, **Import JSON** inside
  New agent as **From a file**, one **What it does** field with the card text folded, and the system prompt behind **View
  prompt**. Team cards follow the same rule.
- **Agent detail in three tabs (B26, backbone wave 4; P-ag-4 to P-ag-7, P-ag-9)**: Persona, Abilities, Activity; the
  layers are the Abilities navigation (rows that open their card in place, router, cache and tool access under
  Advanced); one Add capability and one Add trigger menu; the kagent card only with a kagent cluster credential; the
  publish state in the header button alone. Old `?tab=` links map to the new places
  ([agents](agents.md#building-an-agent)).
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

- **Quieter run screens (B21, backbone wave 3; P-trace-1 to P-trace-5, X13 for runs)**: tabs only with content (Story and
  Trace always, Team and Artifacts when they have something), the Report merged into the Story as a summary, one status
  line, no time slider on a short or single-participant run, Debug access in the header's ⋯ without tool names.
- **The journal** (`execution_events`, migration 2000): actors, spans, messages, artifacts and checks per execution,
  written by the runner's translator, Landflow agent sessions, the A2A Agent node (every remote step kept, failed ones
  marked failed, `isError` results included), approvals (web, Slack, email) and the Run report gate. Redacted, cut to
  32 KB per event (**Content kept**: full, summaries or off), batched about twice a second, kept 30 days, live as
  `journal` events.
- **Artifacts and checks from any node**: `ctx.artifact` and `ctx.check` in the TypeScript, Python and Go SDKs,
  `ExecuteResponse.records` over every transport, the engine's `node.record` event. The GitHub plugin reports its pull
  requests, issues and branches.
- **The screens**: Run trace next to Canvas on every execution and full screen at `/runs/<id>`. They have a header with
  who is working now, Needs you, and the Story, Trace, Team and Artifacts tabs (Team and Artifacts only with something in them; the Report is in the Story). Details open in a sheet, and a time slider
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
- Next: tools of a Claude Code member on kagent asking for approval. Paperclip-style autonomy is built, behind a person's
  approval (wave 10, P7): project tasks with agent or person assignees, wake-ups that only ask and runs that need an
  **Approve** ([Tasks](projects-and-goals.md#tasks)).

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

## Clickland (built 2026-11-14)

Landflow's side of Clickland, the land family's observability system ([features/clickland.md](features/clickland.md)).
**Built:**

- The [`clickland` plugin](../plugins/clickland/README.md) (TypeScript, 7119/7219): logs, traces, services, metrics,
  patterns, alerts, notes, knowledge search and views (dashboards included) as one node usable as an agent tool and
  over MCP, the **Clickland Alert Trigger** (a Standard Webhooks subscription made on publish) and the **Clickland
  Trigger** (poll). In compose, the Kubernetes base and the OrbStack overlay.
- [Knowledge bases from a plugin](agents.md#knowledge-bases-from-a-plugin): a standalone agent takes Clickland as a
  knowledge base (`source: 'node'`), searched like a vector collection and judged by the grounded guardrail.
- Flows: [Clickland alert triage into Slack](features/clickland.md#alert-triage-into-slack) and the
  [observability assistant](features/clickland.md#the-observability-assistant) behind Clickland's Assistant panel (a
  lead with logs, traces and metrics analysts, views and dashboards), with its
  [chat contract](features/clickland.md#the-assistant-chat-contract); Normalize Alert reads Clickland alerts.
- [Telemetry to Clickland](deployment.md#telemetry-on-kubernetes), the default: the `orbstack-clickland` overlay
  (component `clickland-observability`) sends every process's OTLP, the run journals and the trace links to Clickland;
  `kagent-up.sh` bridges kagent to whichever backend the host uses. The lgtm overlay stays.

Checked live on 2026-11-14 against Clickland on this machine ([features/clickland.md](features/clickland.md#checked-live)):
the plugin, both triggers, webhook registration and signatures, knowledge search, telemetry and the assistant's chat
contract up to the model.

**Next:** the agents' answers live (the cluster's Landflow needs an Anthropic credential: the lead's view markers, its
`search_clickland` calls and the triage Slack post); stream the assistant analysts' own steps (a node used as a tool
would need the run's stream).

## Landledger (built 2026-11-14)

Landflow's side of Landledger, the land family's cost subledger ([features/landledger.md](features/landledger.md)).
**Built:**

- The [`landledger` plugin](../plugins/landledger/README.md) (TypeScript, 7120/7220): Budget → Check, Cost → Query,
  Request → Create, Get, List, Mark Applied, Reservation → Create, Release, Period → Status, and Decision → Relay
  (flows only: refused as an agent tool or over MCP), plus the **Landledger Trigger** (Standard Webhooks, subscribed on
  publish or with an admin-made secret). In compose and `deploy/k8s/components/landledger` (with an ExternalName
  `landledger-api` to the Mac), included by the `orbstack-clickland` overlay.
- Flows: [approve an infrastructure change](features/landledger.md#approve-an-infrastructure-change),
  [raise or hold an AI budget](features/landledger.md#raise-or-hold-an-ai-budget) and
  [ask the approver in Slack](features/landledger.md#ask-the-approver-in-slack).
- The Slack plugin's **Button Pressed** (`block_actions`) on the Slack Trigger and **User → Get** (`users.info`), for
  the relay.

Checked live on 2026-11-14 against Landledger's wave 2 ([features/landledger.md](features/landledger.md#checked-live)):
the credential, the infra change form and the Slack relay path's refusal.

**Review (2026-11-15), against Landledger's contract `c3c0115`:** keys split per use (requests, webhooks, a relay key
with `decisions:relay` only) with scope-reporting credential tests; Decision → Relay sends the raw signed Slack press so
Landledger verifies the presser; the infra flow's requester confirms in Landledger and the flow acts only on its own
key's approved request from one of its runs; the AI budget flow raises by the approved amount, once per agent a month,
with an hourly reconcile; the Slack flow relays only presses on cards it recorded, from its team and app, by members,
and keeps Try again on outages; the trigger's tolerance is held to 300 s and it takes the three new events.

Checked live on 2026-11-15 against Landledger `fee9b0a`: the three keys, both triggers subscribed with the webhooks
key, a form request held for its person with a signed `request.needs_confirmation` delivery, and the Slack refusals
(not an approver, a wrong signature, a card never sent).

**Month end, seats and incidents (2026-11-15), against Landledger's wave 4 contract `2ed51f3`:** Request → Release
Seats, Contract → Seats, the seat terms and a Landbright request on Request → Create; Close → Snapshot; Note →
Figures and Submit Draft with a **Landledger Notes Key** (`notes:draft` only); Cost → Window; the trigger's
`seat.released`, `notes.draft_requested`, `note.accepted`, `accrual.accepted`, `period.locked`, `period.reopened`
and `datarails.uploaded`. Three flows: [a tool or seat cost](features/landledger.md#tool-or-seat-cost) with
Landbright (raise at the contract's seat price, tell Landbright the decision, mark applied or release with the grant),
[draft variance notes](features/landledger.md#draft-variance-notes) (a local Ollama model drafts each note citing only
the snapshot's figures, one redraft on a refusal) and [an incident's cost to the room](features/landledger.md#incident-cost-to-the-room)
(Landfall's ended room → Cost → Window → an estimated note in the room).

**Review fixes (2026-11-15):** tool or seat cost recovers a Create that answered 409 (the request it names, or the
key's own request by origin) and an **Every hour** reconcile records seat requests with no row, tells Landbright a
decision it missed, cancels a cost request whose Landbright request ended first, and uses, releases or closes what the
seat needs; a granted-first seat whose cost isn't approved gets a revoke task and an unpaid-seat row (Landbright has no
revoke route); an extension inside the contract term settles citing the first request, otherwise raises its own. The
incident note says "pro-rated spend … not the incident's extra cost", "no matching services: cost unknown" instead of
$0.00, labels spend on the 1st, and asks windows over 31 days in parts; amounts in variance notes round as Landledger
does.

**Next:** a decision delivered live (once a person confirms or decides); the AI budget flow on the cluster; Slack's
reject modal (`view_submission`); a Teams and an email card for the relay; Mark Applied wired to a
real apply step in the infra flow; `SETTLE_IN_LANDBRIGHT` on once Landbright's spec 008 (PR #5) merges, checked live;
a revoke route in Landbright (for the revoke task to become a call); a postmortem operation in the landfall plugin, for the incident cost to
land in the postmortem; the incident flow run live once the cluster has a Landfall credential.

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
- **P11, `HttpError`, a generic 500 and one request pipeline** (C15, S12, contributes to C12; wave 3): `lib/server/errors.ts` holds `HttpError`; `handler()` answers it (status, code, details), a ZodError (400) and anything else as a generic 500 with the request id, never the message. `projectRoute`, `dataTableRoute`, the marketplace wrapper (its message regex is gone: `MarketplaceError` and `FetchError` extend `HttpError`) and `scimRoute` (now over `handler()` with `formatError`; gains the readiness wait, drain and request id) no longer map errors by hand; the approval email route runs through `handler()`; seven raw `request.json()` calls use `parseBody`. `PUT /api/workflows/:id` accepts `If-Match` / `baseUpdatedAt` (412 `workflow_conflict`, the editor sends it), deleting a workflow is one transaction, and `routePolicy()` marks its default with `fallback` so `test/policy-coverage.test.ts` fails a mutating route with no access rule. P27 converts the remaining domain error classes and the hand-written `catch` blocks (done, see below).
- **P12, audit coverage** (S7, S8; wave 3): permission and secret changes are domain events (`project.*`, `project.member_change`, `resource.share` / `unshare` / `transfer`, `variable.*`, `secret_provider.*`, `auth.password_change`) with `from` / `to`; failed SAML and OIDC sign-ins are `auth.sign_in_failed`; refused reads are `api.denied`, once a minute per caller and route; exports (`sync.export`, `datatable.export`), credential tests and agent tool approvals are recorded. See [audit and governance](features/audit-and-governance.md).
- **P13, safeFetch: one guarded client for outbound calls** (S5, O5; wave 3): `lib/server/net/safe-fetch.ts` refuses
  loopback, private, link-local, CGNAT and metadata addresses in the production profile unless
  `LANDFLOW_OUTBOUND_ALLOW` lists them: literal IPs before connecting, names in the socket's DNS lookup (so the address
  checked is the address connected to), and every redirect hop again (with the governance host list by name). The HTTP
  Request node (through `ContextExtras.fetch`, which `ctx.http` wraps in its span), alert channels, HTTP SIEM
  destinations, remote MCP servers, RAG embeddings and rerank, OpenAI-compatible model calls and OIDC and SAML metadata go through it; each call has
  a client span. Not covered, with the reasons in [limitations.md](limitations.md): remote plugins, configured
  infrastructure, the marketplace's git, the OAuth2 flow and anchoring webhooks.
- **P14, expressions in a sealed realm and Code nodes out of the host in production** (S1): expressions run in a fresh
  `node:vm` context with code generation off, no host object inside and only JSON text crossing the boundary
  (`packages/engine/src/sandbox/`), so `$json.constructor.constructor('return process')()` finds nothing; `async`, `await`
  and `import(` are refused because an unhandled rejection from any context would end the host process. The production
  profile runs Code nodes only in the code runner unless `LANDFLOW_CODE_IN_PROCESS=true`; the in-process context also loses
  `eval` and `new Function`. An isolate backend remains for a later package.
- **P15, database conventions** (C18; wave 3): prepared statements are cached in an LRU capped by `LANDFLOW_DB_STATEMENT_CACHE` (default 500); a test fails a new migration whose version is not above every earlier one; `withOwnership` reads shares and memberships once per list instead of per item.
- **Wave 2 carryover** (applied in wave 3): `pnpm worker` exits 1 when Valkey is unreachable and handles signals
  during its boot, the registry is required on a worker, emails are masked in the
  effective configuration, health state lives in `singleton()`, the registry normalises `grpc://` hosts and keeps
  `guardJoin` per announce, links without `LANDFLOW_PUBLIC_URL` answer 503 before any lookup, the form-wait bypass needs
  workflow access, zod is jitless before the Run Trace cards' schemas, the proxy drops client CSP request headers, an
  app icon, and the marketplace test's real cause (a shared data directory and a real network fetch). Deferred:
  - readiness in Postgres mode does not ping Postgres or check the LISTEN connection: that needs a connect timeout on
    the pool in `db/postgres.ts` first ([limitations.md](limitations.md));
  - a plugin endpoint whose DNS name resolves to a metadata address is not refused (plugins are outside `safeFetch`;
    the literal forms are);
  - `plugin.endpoint_added` is audited for every source and in every queue-mode process, so each plugin's second
    transport writes a row per boot; audit only the process that accepted an announce if the log gets noisy;
  - a refused join raises a `plugin.error` toast naming the real plugin, so in development anyone can raise toasts by
    announcing repeatedly (low impact, development only);
  - HSTS, the cookies' `Secure` flag, the OAuth2 callback, the hosted chat page and the same-origin check read
    `X-Forwarded-Proto` / `-Host` whatever `LANDFLOW_TRUSTED_PROXIES` says (P24's same-origin check `crossSite()`
    included); gating them on the hop count belongs with P27;
  - live checks no automated test covers: Go and Python SDK announces with the registry secret over HTTP and gRPC and
    the gRPC registry's UNAUTHENTICATED / UNAVAILABLE answers; a production resume by curl with and without `sig`; a
    multi-page form in a browser; client addresses behind a real ingress; a signed-in pass under the enforced CSP
    (editor, Run Trace, Brain at desktop and 390 px), which needs a person to sign in.
- **P16** (C13, S11, O4): list requests are bounded. `GET /api/executions` takes `limit` (1-500, default 100) and an
  opaque `cursor` and answers `{ executions, nextCursor? }` by keyset paging with the member filter in SQL, so pages are
  full; `?limit=Infinity` and `?limit=abc` are 400. The other limit-taking routes validate their query the same way
  (`parseQuery`). `parseBody` refuses bodies over `LANDFLOW_MAX_BODY_BYTES` (16 MiB) with 413 without reading them
  whole. The production profile rate-limits the API per principal and the public triggers per address and group, shared
  through Valkey in queue mode (429 with Retry-After). New counters: `landflow.http.denied{reason}` and
  `landflow.ratelimit.refused{bucket}`.
- **P17, logs and spans you can join; wider redaction** (O3, O6, contributes to C5; wave 4): every log line written in an
  API request carries `request_id`, `http.route`, `user.id` and the API key id, the active span gets the same
  attributes, and `/api` responses return `traceparent`. Redaction covers more key names (private keys, passphrases,
  signatures, connection strings, DSNs, session tokens), secret-shaped values in every logged string (Bearer tokens,
  `lf_` keys, URL userinfo, PEM blocks), and the credential values handed to a node, like `$secrets` values.
- **P18, configuration catalog, generated reference and a ratchet on environment reads** (C5, C7; wave 4):
  `lib/server/config/catalog.ts` lists every variable the host reads (and the few plugins read) with its default,
  description, group, secret flag, production-profile requirement and deprecated aliases; `checkConfig` takes its
  redaction and production requirements from it. `docs/reference/configuration.md` is generated from it
  (`pnpm --filter @landflow/web gen:config-docs`), one table per group and plugin-side variables in their own table. The
  per-signal `OTEL_EXPORTER_OTLP_*` variables, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_SAMPLER_ARG`,
  `OTEL_LOGS_EXPORTER`, `OTEL_BLRP_SCHEDULE_DELAY` and `LANDFLOW_VALKEY_URL=memory` are documented, and the retention
  variables are catalogued as `LANDFLOW_AI_USAGE_RETENTION_DAYS` / `LANDFLOW_USAGE_RETENTION_DAYS` with the old names
  as aliases. `config-catalog.test.ts` fails on an environment name the source reads that is not catalogued, on more
  than 88 files reading `process.env` outside `lib/server/config`, and on a stale generated page. SAML, mail, S3,
  marketplace and environment-protection flags now go through `envFlag`; the values they accept changed (`LANDFLOW_S3_FORCE_PATH_STYLE=0` is now off, `LANDFLOW_SMTP_SECURE=1` true, `LANDFLOW_MARKETPLACE_ALLOW_LOCAL=true` on, `LANDFLOW_ENVIRONMENT_PROTECTED=on`/`off` decides, an unparseable SAML flag takes its default; see history.md).
- **P19, one SSE helper** (C14; wave 4): `lib/server/sse.ts` (`sseResponse`) bounds each client's unread bytes (1 MiB, then a closing comment and the stream ends), writes `id:` / `event:` lines, heartbeats and cleans up; the bus keeps a ring of the last 500 events with `seq` and no longer raises the EventEmitter limit. `/api/events` (`lib/server/events-stream.ts`) numbers events `<boot>.<seq>`, replays after `Last-Event-ID` or sends `event: reset`, and re-checks the viewer's access every 30 s (closing when the session or user is gone). The assistant chat, agent architect, run and approvals routes use the helper.
- **P20, a store that does not call up; one way to hold process-wide state** (C10, C4, contributes to C7; wave 4):
  `store.saveExecution` emits `onExecutionFinished` and `execution-reactions.ts` subscribes insights, the usage ledger
  and retention (registered by the runtime for both roles), so the store imports no feature and the store, settings,
  insights and ledger cycle is gone. Every process-wide holder goes through `singleton()` (`resetSingleton`,
  `singletonKeys`), including the marketplace sync guard; `LANDFLOW_USAGE_RETENTION_DAYS` and
  `LANDFLOW_AI_USAGE_RETENTION_DAYS` replace the old names, which still work.
- **Wave 3 carryover** (applied in wave 4): a workflow delete tells publication listeners only after its commit and
  rolls back when the policy delete fails; the SCIM generic 500 names its request id; a marketplace plugin read is a
  422 only when it is the plugin's fault; a no-op variable PATCH records nothing; the first request boots the host
  outside its own audit and log context; the reset route says it is a reset; `api.denied` is capped at 60 a minute;
  a throwing credential test is recorded; remote MCP servers check the MCP list on every redirect hop; IPv4-compatible,
  6to4 and local NAT64 addresses are judged by their IPv4 part (or reserved); an OpenAI-compatible refusal leads with
  the Blocked message; the expression `async` check no longer trips on a variable named `asynk`; tests for the
  node:http SIEM path with blocking on and the statement cache's write path; and docs (If-Match limits, outbound
  coverage, the realm's console, newer-Node engine runs). Deferred:
  - SSO sign-in failures are one event a minute per client address, and `refused` covers a bad signature, an unknown
    and a deactivated user alike: a finer category and a per-address allowance above one need a decision on volume;
  - `test/policy-coverage.test.ts` matches its markers per route file, not per exported method, so a file with a
    guarded GET and an unguarded POST passes; matching per handler is a tightening for later;
  - audit tests still missing: SSO `refused`, `provider_error` and `error` outcomes, a refused HEAD, `api.denied` on a
    skipped path, and SSO/SCIM group-mapping member events with `source` (each needs an IdP fake or a mapping fixture);
  - `safeFetch`'s implicit endpoints (code runner, Ollama, MCP gateway) are exempt for every caller, the HTTP Request
    node and redirects included; an option that limits the exemption to the callers that own each endpoint is a
    follow-up of its own;
  - an in-cluster identity provider's token and JWKS endpoints still need `LANDFLOW_OUTBOUND_ALLOW` (only the discovery
    URL is implicit); deriving them from the discovery document needs the OIDC client to hand them over;
  - a credential test does not register the values it sends with the redactor (saved credentials handed to nodes are),
    so a plugin error that quotes one is logged as it is;
  - `db/replication.ts` keeps its own statement map (bounded in practice: one SQL text per table and column set) and
    `withOwnership` reads `resource_shares` twice per list (constant per list); both are left for P26, which owns those
    files;
  - live checks no automated test covers: editor saves after a Spotlight apply, after publishing and unpublishing,
    after restoring a version and from a read-only tab that took the edit lock (the two-tab conflict was checked at
    desktop and phone in wave 3); `{{ Promise.reject(1) }}` and `{{ (async()=>{throw 1})() }}` under `next dev` and
    `next start` ending as expression errors, not a process exit; hosted-chat POST with a malformed body and SCIM
    401/404 documents on a live host; the OIDC and SAML Keycloak suites (`LANDFLOW_INTEGRATION=oidc` / `saml`); a bad SSO assertion in the Audit
    log, member role, share and transfer events, and one `api.denied` a minute, in a dev host; a production-like
    deployment with in-cluster gateways and remote MCP, OIDC/SAML, alert and SIEM endpoints; a streaming MCP transport
    and a multipart or streamed HTTP Request body through the undici path with blocking on; the expression bench on a
    quiet machine (`LANDFLOW_BENCH=1`) and a large real workflow's expression cost.
- **P21, audit reliability** (S9, O4): a failed audit write is counted (`landflow.audit.write_failures{action}`), the
  outbox has depth, oldest-age and delivery-failure metrics, and `LANDFLOW_AUDIT_FAIL_CLOSED=true` makes role changes,
  API keys, credentials, audit settings and SCIM provisioning fail with 503 when their event cannot be stored, with the
  change and its event in one transaction where both are database writes
  ([audit-and-governance.md](features/audit-and-governance.md#reliability-and-fail-closed-mode)).
- **P22, saturation metrics, database timing, sampled reads and slow-query spans** (O4, O5): the host reports event-loop
  delay and utilisation, memory, GC pauses, every database call's duration, SSE connections, failed sign-ins and
  limiter refusals; slow database calls and slow or failed `GET`s are traced and fast reads are dropped; `landflow.workflow.id`
  is off the histogram and (unless `LANDFLOW_METRICS_WORKFLOW_LABEL=true`) off the counters. [observability.md](observability.md#5-metrics)
- **P23, an encryption key ring, rotation, scrypt and bound credential ids** (S13; wave 5): `LANDFLOW_ENCRYPTION_KEYS` (`kid:key,…`, first seals) next to the legacy key (kid `k0`); sealed values name their key (`v2`) and credential blobs are bound to the credential id; passphrases are stretched with scrypt (the old SHA-256 form still opens data); derived keys use HKDF; `POST /api/settings/encryption/rotate` (owner) and `pnpm --filter @landflow/web rotate-key` re-seal everything. See [secrets and environments](features/secrets-and-environments.md#encryption-keys-and-rotation).
- **P24** (S14): a password change ends the user's other sessions; sessions expire when idle (`LANDFLOW_SESSION_IDLE_HOURS`); a request without Origin but with a cross-site `Sec-Fetch-Site` is refused; `LANDFLOW_LOCAL_SIGN_IN` (`all`, `owner`, `off`) makes an instance SSO-only. Next: TOTP and passkeys for local accounts.
- **P25, an async read seam for run data** (C16 steps 2-3, first half; wave 5): `db/reads.ts` (`readExecutionData`,
  `readExecutionEvents`, `readRows`), `store.loadExecution` / `executionsMentioningAsync` and async journal readers, with
  every caller that may read a finished run moved onto them (execution routes, run search, lines, compare, measures,
  needs-you, OTLP export, MCP tools, Slack, approval links, the brain, the binary sweep). `store.getExecution` stays for
  runs in flight, and a source scan guards it. No behaviour change; P26 serves the seam from Postgres.
- **Wave 4 carryover** (applied in wave 5): the live stream's 30 s re-check no longer marks the session as used, and
  neither do the editor's edit-lock heartbeat, the pages' polling and their reloads after a live event (they send
  `X-Landflow-Background: 1`), so an open tab reaches `LANDFLOW_SESSION_IDLE_HOURS` (P24); a throwing re-check closes
  the stream; a resumed run is left
  out of later executions pages too; MCP `list_executions` filters a status in SQL over pages; the effective
  configuration shows catalogued non-secret variables whose name looks secret; the renamed retention variables are read
  through `envWithAliases` (an empty new name no longer hides the old one); the rate limiter caps its keys and its
  handler test freezes the clock; and docs and comment fixes (the bus ring, dev reload of the execution reactions, the
  Bearer pattern's scope, the alias notes on the configuration page). Deferred:
  - rate limits for unauthenticated paths outside the five public trigger groups (`/api/mcp`, `/api/slack`,
    `/api/teams`, `/scim/v2`, `/api/agent-trace`, the test URLs): `/api/mcp` and the chat channels can start model
    calls, so they want a bucket of their own ([limitations.md](limitations.md));
  - the redactor's remembered values grow with OAuth refreshes (each new access token is added until the 5,000 cap,
    where a 1,000-item output costs about 230 ms to scrub, and every log line is scrubbed once any credential was
    used): forget the replaced token on refresh or evict values unresolved for hours; and `remember()` also takes any
    field whose name looks secret (Twilio's `apiKeySid`), where the brief said password-typed and `secretFields` only.
    Both change what is scrubbed, so they need a decision, not a tidy-up;
  - a basic-auth run test that asserts on the stored execution (the OAuth tests already prove the path end to end);
  - a `reset` listener in `lib/client/live.ts` that tells each view to refetch: every subscriber needs its own refetch,
    so it is a client change of its own ([limitations.md](limitations.md));
  - `singletons.test.ts`'s import-closure scan misses side-effect and dynamic imports, tests still reach into
    `globalThis.__landflow` (environments-promotion, oauth2), and module-level state remains outside `singleton()`
    (`ensuredTables` in rag/stores.ts, `beating`/`sweeping` in cluster/index.ts, ai-usage/notify.ts, notebook/embed.ts,
    the marketplace `details` cache): one way to hold state strictly is a sweep of its own;
  - the log context is an AsyncLocalStorage store, so a timer or lazily created service first started inside a request
    keeps stamping that request's id and user on later lines; starting each such service outside the request needs a
    list of them;
  - `db/schema.ts` still names `USAGE_RETENTION_DAYS` in a comment inside the shipped `second_brain` migration, left
    because shipped migrations are not edited;
  - live checks no automated test covers: two mains in queue mode sharing one public limit (429 on the combined count);
    `LANDFLOW_TRUSTED_PROXIES` behind a real proxy; `landflow runs --status failed` against a host; the denied and
    refused counters on `/api/metrics`; a trace id from `traceparent` in Tempo or Jaeger with `landflow.request_id` and
    `enduser.id`; request ids and no key or password in a host's stdout after an API-key call and a credential run, and
    false positives on odd URLs and `*dsn` fields; the production boot refusals (missing public URL, open registry),
    SMTP with `SECURE` and `IGNORE_TLS` against Mailpit, the environment-protection values, a SAML login and the
    generated configuration page rendered; an `/api/events` stream on a scratch host closing after sign-out, live
    updates at desktop and 390 px, Spotlight and Agent architect streams, an approvals stream, a revoked member's stream
    and a reconnect to another main; `pnpm dev` with a `pnpm worker` recording insights and usage and pruning, a dev
    edit of a singleton-held class, and no concurrent marketplace sync across two graphs.
- **P26, Postgres mode keeps only hot run data in memory** (C16 steps 2-3, O4; wave 6): the in-memory copy holds the data
  and journal of hot runs only (in flight, finished in the last `LANDFLOW_PG_HOT_MINUTES`, with a retry waiting, children
  of a waiting run); `db/reads.ts` serves cold runs and scans from Postgres (a barrier on the write queue first), eviction
  is a copy-only write (`Database.evictLocal`), deletes on the partly mirrored tables are always replayed,
  `promoteExecution` loads a cold run back before its journal is written, queue-mode followers keep cold rows empty, and
  `landflow.db.replication.lag` reports the follower's lag. At 50,000 finished runs boot went from about 10 s and 14 GB to
  under 1 s and about 160 MB ([deployment.md](deployment.md#postgres-memory-sizing)); `scripts/seed-executions.ts` measures it.

- **P27, `HttpError` everywhere** (C12; wave 6): the 53 domain error classes that carry a status extend `HttpError` (`expose: true`, so their messages keep reaching clients), with their extra fields in `details`. 84 route `catch` blocks that only answered `error(caught.message, caught.status)` are gone, `projectRoute` and `dataTableRoute` no longer map anything, and a domain error thrown where no route caught it answers its status instead of a 500. Responses gain a `code` field (the class name in snake_case). Each subclass names itself with a literal `static readonly errorName` that `code` and `name` come from: the production bundle minifies class names, so `new.target.name` answered `code: "v"` in the built image (found in the wave 6 integration review; `test/error-mapping.test.ts` fails a subclass without one). `RerunError`, `ResumeError` and the other `runner.ts` classes follow P28's split; classes with an optional upstream status (`McpClientError`, `OAuth2Error`, `SecretProviderError`, `GatewayAdapterError`, `SystemOneApiError`) stay plain errors.

- **P28, boundaries as checks** (C11; wave 6): `lib/server/runner.ts` is a barrel over `lib/server/runner/` (types, state, limits, persist, run, resume, rerun, queue, recovery, links, live, stop, jobs; each a few hundred lines at most) and its error classes extend `HttpError`. `pnpm check:deps` (dependency-cruiser, `.dependency-cruiser.cjs`) enforces the layering (server never imports components, shared never imports server values, client components import no server values, routes never import `lib/server/db`, packages never import apps, no new cycles) and `pnpm check` is the local gate (typecheck, `pnpm test`, check:deps; no CI by decision). The `landflow-sync/v1` layout's names and path rules are in `packages/protocol/src/sync-format.ts`, imported by the host and the CLI.

- **P29, shipped alert rules, a dashboard and exception fingerprints** (finding O7): `exception.fingerprint` on error log
  lines and exception span events; `deploy/observability/prometheus-rules.yml` (13 alerts, each with a runbook link) and
  `landflow-dashboard.json`, both loaded by the `orbstack-observability` overlay ([observability.md](observability.md#alerts-and-dashboard)).

- **P30** (S1, strict mode): `LANDFLOW_EXPRESSION_SANDBOX=isolate` runs expressions in an isolated-vm isolate with a memory
  cap (`LANDFLOW_EXPRESSION_MEMORY_MB`), sharing the realm's bootstrap and bridge; `realm` stays the default. Optional
  dependency of the engine, `NODE_OPTIONS=--no-node-snapshot` in the image, refused at boot in production when it cannot load. Open: hash-table growth still aborts the process and the cap does not bound
  resident memory, so it is no defence against a memory bomb ([limitations.md](limitations.md), [engine.md](features/engine.md#the-isolate-backend-optional)).

- **Wave 5 carryover** (applied in wave 6): `Database.atomic()` has a test of its own (savepoint rollback, dropped queued
  ops, nested calls); the audit fail-closed test covers API key revoke, credential update and delete, the audit settings
  PATCH and SCIM groups; the audit outbox gauges are registered at boot even with `LANDFLOW_AUDIT_OUTBOX=off`, and the
  four `landflow.audit.*` instruments are in the observability table; a test pins `landflow.auth.sign_in_failures` to one
  count per failed sign-in; `recordDbQuery` costs about 0.15 µs a call with the metrics SDK on (measured, documented);
  the `rotate-key` script has a Postgres test (`LANDFLOW_INTEGRATION=queue`); an anchoring save after a rotation keeps
  the new seal; the reset page refuses a link before its form under `LANDFLOW_LOCAL_SIGN_IN`, Forgot password is tested
  under the mode, the login page drops its welcome line when nobody can sign in and its test renders the form; the unused
  sync `executionsMentioning` is gone and a source scan keeps the sync journal readers to runs in flight; and docs (how to
  clear a value no key opens, why the local sign-in refusal follows the password, why readiness leaves out the outbox,
  which literals `statementName` keeps). Deferred:
  - the rotation route re-seals synchronously inside the request: fine at today's sizes, but with many credentials and
    passphrase keys it blocks the event loop for the duration; a background job with progress wants its own design
    ([limitations.md](limitations.md#encryption-key-ring-backend-hardening-2026-11));
  - Settings → Users still offers a reset link for a user `LANDFLOW_LOCAL_SIGN_IN` refuses (the link is then refused):
    hiding or explaining it is a UI change of its own;
  - a CSP probe that loads a page with an inline script lacking the nonce (the CDP-injected probe runs under
    `'strict-dynamic'` and can't tell a gap from the injection);
  - live checks no automated test covers: fail-closed audit with a failing insert on a scratch host in the UI, and
    `auditedTransaction` rolling back in Postgres mode; the P22 signals on `/api/metrics` under `pnpm dev` and a
    production build (runtime, database, SSE, sign-in and limiter series), a slow GET as a whole trace with `db.query`
    children in the local collector and none for fast GETs, `db.query` spans for `sqlite`, `postgres-mirror` and
    `direct()`; key rotation on a scratch copy of a data directory (credentials, alert channels, MCP tokens; the owner
    route and an admin's 403; queue mode with workers on the new ring; an OAuth2 Connect, an approval email link and a
    resume URL made before the rotation); `/login` under `LANDFLOW_LOCAL_SIGN_IN=off` and `owner` at desktop and 390 px,
    the OIDC and SAML suites (Keycloak) with local sign-in off, the 72 h idle sign-out and a cross-site POST without
    Origin on a production-profile host; and a finished run's Run Trace, run search, compare, measures, Needs you,
    approval links, delete and rerun, and the MCP execution tools, in SQLite and Postgres mode (now that P26 serves
    old runs from Postgres).

- **Wave 6 follow-ups** (open after the last wave): routes that answer with `error('…', 404)` directly (for example
  `/api/projects/[id]`) send no `code`, only `HttpError`s do; the 5xx domain errors that wrap an upstream message
  (`PauseError`, `WikiError`, `TemplateError`, `KagentError`, `SourceControlError` with git's stderr tail) are shown to
  the client from any `handler()` route, not only the route that used to catch them, and could drop `expose`; the
  `db.query` span records its exception without a fingerprint (`database.ts` calls `recordException`); the two
  `routes-not-db` entries in the dependency baseline (`form-test/[...path]` → `db/replication`, `proposals/[id]/applied`
  → `db`); `no-circular` leaves out every cycle that touches `lib/server/runner/`, so a direct two-module cycle between an
  outside module and a runner module is not reported; a decision on an agent's command ask writes no journal event when
  its run went cold first (only with `LANDFLOW_PG_HOT_MINUTES` below the ask's 10-minute TTL); and the isolate backend
  still aborts the process on hash-table growth, so a memory bomb needs a separate evaluation process to be contained.

## Company backbone: work events and the briefing (built 2026-11-14, B05)

People's own tools can send a summary of their work to the brain, and each person gets their own day back
([work-and-briefings.md](work-and-briefings.md)). This is the first part: the visibility model (a private work event
is read by its owner alone, owners and admins included, through every reader), the `brain:read` and `brain:write` API
key scopes, `POST` and `DELETE /api/brain/work`, `GET /api/brain/briefing`, the `work.session` kind and the admin
setting `brain.workAutoSend`.

- **Built (B13)**: MCP for everyone: the instance MCP server's brain tools (`brain_ask`, `record_work`, `my_briefing`), the
  `morning-briefing` prompt and `brain://` resources, with API-key scopes checked per tool ([work-and-briefings.md](work-and-briefings.md#over-mcp)).
- **Built (B14)**: the first slice of the Claude Code mod `landflow-brain` ([landflow-brain-mod.md](landflow-brain-mod.md)):
  capture, a held journal, `/brain today|review|status|pause|resume|forget`, the status line, yesterday at session start
  and an offline queue.
- **`landflow work`** (built, backbone wave 2, B15): the harness-agnostic daily offloader (collect, summarise on the machine, hold for review, send), with cron, launchd and Task Scheduler examples ([cli.md](features/cli.md#recording-your-day-landflow-work)).
- **Built (B18)**: team and org visibility (`PATCH /api/brain/work/:sourceId`, the team clause over shared projects),
  Post as my update (`POST /api/brain/work/:sourceId/share`), related colleagues in the briefing with the reason,
  repositories as `system` entities and the link from a person page to its user (migration 2080)
  ([work-and-briefings.md](work-and-briefings.md#related-colleagues)).
- Follow-ups: `landflow work` should omit `visibility`; the briefing prompt (`briefingText`) does not render `related` yet (MOD6's clip, quote and link rules apply when it does); link a work event to its repository page and index systems by repo in the wiki; check `canEntity` before showing a person page's user link.
- **Built (B31, wave 5)**: GitHub into the brain: the **GitHub to Work Event** node and the `work-github` template turn
  pull requests, reviews and CI results (workflow runs and commit statuses) into work events, keep each repository as
  a `system` page under the same id as recorded work, and declare the five GitHub-only kinds with their own fields
  ([features/integrations.md](features/integrations.md#github-into-the-brain)). Open: a redelivered pinned event is
  recorded twice, the webhook needs a public URL, and commit-status flakes are not paired
  ([limitations.md](limitations.md)).
- **Built (B32, wave 5)**: V4, nightly SDLC velocity: the Velocity Signals and Propose Flows nodes, the template
  `brain-sdlc-velocity`, Suggest Improvement's Build Prompt, and **Build it** opening a new workflow with Spotlight
  building from the suggestion's prompt ([second-brain.md](second-brain.md#nightly-sdlc-velocity)). Closes V4.
- **Built (B29)**: the mod's colleagues: `/brain sync`, the pane, the overlap band, team or org per item, Post as my update and the admin's no-auto rule ([landflow-brain-mod.md](landflow-brain-mod.md#colleagues)).
- **Built (B30, V3's server part)**: the Tomorrow sync template and its five brain nodes, the `brain_briefings` store, briefings served over MCP and `GET /api/brain/briefing`; Slack delivery with the server's own bot (`LANDFLOW_BRIEFING_SLACK_TOKEN`), never a credential ([work-and-briefings.md](work-and-briefings.md#the-nightly-sync)). Still open: the landflow-brain mod's session start shows `summary` and `source` (`hooks/client.ts`, `register.ts`).
- **Built (B37, V3 closed on the web)**: "Your morning" on Home and at the top of the Brain index, and a one-click "Set up tomorrow sync" for admins ([work-and-briefings.md](work-and-briefings.md#on-the-web)).
- **Built (B38, MOD8 closed)**: the brain side of the mod: the Work overlap detector introduces two people on the same thing (one card to both, `org` work only, once in 14 days, mutable, inbox only; [second-brain.md](second-brain.md#work-overlap)), the mod's `brain_ask` tool, and `landflow-brain` and `landflow-harness` in the repository marketplace ([landflow-brain-mod.md](landflow-brain-mod.md#brain_ask)).
- **Next**: the mod showing the nightly text at session start, `team` work in the overlap card (needs `canProposal` to refuse non-audience readers), and an admin-named Slack credential for it. (The admin's auto-send switch is in Settings → MCP.) Also next on the web: a `finished` list on `Briefing` and the card ("what finished"), and a live "Slack is set up" check so the Delivery line does not claim Slack when the server has no token or SMTP.

## Shell: nine-item rail (built 2026-11-14)

X1 (nine rail items, section tabs in Workflows, Runs and Plugins; Runs also has a Search tab until B20 merges the
pages), X4 (theme in the user menu, the connection shown only while reconnecting), X6 (no Preview pill in the rail), X7
(a red dot for an offline plugin instead of a count), P-dev-1 (Build a plugin out of the rail), P-rb-1 (Runbooks only
with the Landfall plugin) and P-pr-1 (Manage projects in the switcher, no intro on /projects) are closed. The look
switch (`look-toggle.tsx`) was deleted by B12, which also closed X8 (developer details behind one switch).

- **Plugins, Marketplace and Templates (B33, backbone wave 5; X3, X11, P-pl-1, P-pl-2, P-mk-1, P-mk-2, P-tp-1, P-tp-2)**: Plugins is one column (the feed behind **Show feed**, **Add endpoint** in the Scan button's menu, only the list count in the header) with 12 node chips and **+N**; Marketplace has Explore and Installed (plugins and skills together, a type filter), no workflows (Templates is their home), one category dropdown and a source dropdown only with several marketplaces; Templates has no project menu, usable templates first and the rest dimmed with *Needs <plugin>*. Import left the Templates page; B34 puts it in Workflows' New menu.

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

## Backbone wave 1: one look, a plainer Home (2026-11-14)

The Classic look is retired (X5): every screen draws the New look and `useLook`, `useNewLook` and `setLook` are gone
(`look-toggle.tsx` stayed as an empty shell for one wave; B12 deleted it). Home's primary is **New workflow** (P-home-1), a Needs you tile
replaces Plugins online, the Plugins panel and the header meta are gone and an offline plugin shows one line above the
tiles (P-home-2), a suggestion is a compact card with Show more (P-home-3), and a run of one flow is one line
(P-home-4). The Executions page does not read `?status=waiting` yet, so the Needs you tile opens the unfiltered list.

## Specs for what comes next (2026-11-05)

Fifteen specs in [specs/](specs/README.md): a code sandbox, guard enforcement, a durable pause, runbooks made and run by themselves, the brain's auto-apply, lazy loading for Postgres, durable telemetry, shared trace comments, more webhook triggers, per-rule Switch outputs, agent evals, public run-report links, composite governance rules and live integration checks. The first slice of composite governance rules is built ([composites.md](composites.md#governance-rules)); the hot run data of backend wave 6 covers part of spec 07.

## The chat kit, motion and one trace (backbone wave 1)

The shared pieces every chat will use, built in `components/ui/` and ready; the surfaces adopt them in wave 2.

- CH5 ✅ Done: the hosted chat widget's bubbles rise in, its typing indicator is three dots, and Reduce motion turns both
  off ([Hosted chat and widget](features/ai.md#hosted-chat-and-widget)).
- CH1 (motion), CH6 (one activity trace), CH7 (one reply footer), CH9 (errors with actions) and CH10 (a model chip): kit
  ready, surfaces in wave 2 ([Chat surfaces](assistant.md#chat-surfaces)). Spotlight in the editor is on the kit (B08): CH1, CH6, CH7 and CH20 are closed for it, CH10 too once a route names the model before the first reply; CH3 is closed by B09.
  Agents (B10): the test chat, the Agent architect and the analyst are on the kit (CH6, CH7 done for agents); the test
  chat's raw trace id became the trace's Open trace link (CH23, the test-chat part).
- CH13 ✅ Done (B10): the Sessions tab opens on People and has Automations and All; no Auto-refresh switch
  ([agents.md](agents.md#how-a-run-works)). The architect keeps its conversation and can continue a failed design from the
  failing step.

## Spotlight history and @ tags (B16, backbone wave 3)

- CH12 ✅ Done: Spotlight keeps its conversation per workflow, brings the last one back under "Earlier", has the history
  button, and checks a waiting proposal against the workflow (stale ones lose Apply). Leaving the editor no longer loses
  an unapplied proposal ([Spotlight](spotlight.md), [Conversation history](assistant.md#conversation-history)).
- CH17 ✅ Done (B35): one Spotlight for the app. ⌘K (⌘I an alias) opens a shell panel on every page, a bottom sheet on a
  phone; a chip says what it does ("Building <flow>" in the editor, whose own column stays the builder; "Asking the brain"
  elsewhere; "About <thing>" after a `landflow:ask-about` event). The Brain page's own panel is gone and QuickOpen is ⌘P
  ([One Spotlight](spotlight.md#one-spotlight)). Left: the starters of
  "about" come from the page that sent the event (B36).
- CH14 ✅ Done: `@` in Spotlight is the app-wide picker; the server resolves the refs as the caller and shows each read as
  a step ([Tagging with @](assistant.md#tagging-with-)). The unchecked node path is gone.

## Ask the brain, docked and streamed (B09, 2026-11-14)

- CH3 ✅ Done: the brain's answer streams (what it found first, then the words) and shows its steps.
- CH18 ✅ Done (brain): Ask is a column beside the page, not a card over it, so a link opens the page and the answer stays.
- CH2, CH4, CH9, CH21, CH22 and P-ed-4 ✅ Done for Spotlight (B24): the fold eases and the canvas fits once after it, Apply folds the card into its row while the ghosts become nodes (Undo reverses it), errors have actions (Continue from step N, Open AI caps, Open the node, Ask Spotlight to fix it), the header has Asks first | Autonomous with a one-time note and an empty panel with one line (the composer's bubbles are the starters), Continue keeps the failed reply's changes, one Undo for changes applied together, the sheet's three heights ease and follow the drag, a phone's folded bar has Review and Apply, and a desktop opens Spotlight folded ([Fold, Apply and errors](assistant.md#fold-apply-and-errors)).
- CH23 ✅ Done (brain): `[n]` appears only with a source, and a follow-up knows the last two turns.
- CH8 (brain half) ✅ Done: Ask writes `ai_usage` rows with surface `brain`.
- P-br-3 ✅ Done: one **Ask** button and ⌘I; the bottom bar, the toolbar and status-bar buttons and quick open's ask row are gone
  ([second-brain.md](second-brain.md#the-brain-page)). Open: the app-wide panel (B35). History and @ tags for Ask are built (B17, below).

## Ask the brain keeps conversations and takes tags (B17, 2026-11-14)

- CH15 ✅ Done (brain): Ask keeps a conversation for each page (the last one comes back under **Earlier**), has the history
  button, and takes `@` tags (pages, people, workflows, runs and the rest) that are checked, read into the answer and shown
  as steps ([second-brain.md](second-brain.md#the-brain-page), [assistant.md](assistant.md#conversation-history)).
- Open: the index and log files keep no conversation of their own to resume (they have no page); the app-wide panel (B35).

## The editor's layout (B11, 2026-11-14)

Built ([Building and debugging a flow](features/editor.md#the-editors-chrome)): one right column (CH19: **Spotlight |
Chat**, never both, each kept mounted), the flow chat on the chat kit (CH10 for the editor: the list, the Working line,
the reply footer, the model chip, plain errors), a top bar of seven controls with autosave and a Publish button that
carries the state (P-ed-1), one canvas toolbar and a minimap only above 25 nodes (P-ed-2), and one **Import…** dialog
(P-ed-3). All of CH10 (editor), CH19 and P-ed-1 to 3 are done, but for one half of P-ed-3 dropped on purpose: **Git
history…** shows in ⋯ for every saved workflow, not only when source control is configured, because a member cannot
read the admin-only source-control settings to know, and the dialog says when it is not set up. Open: the phone's Chat is still a sheet under the canvas
with no Spotlight | Chat switch (the Execute bar's chat button opens and closes it), and a long editing session with
no pause over 10 minutes between saves folds into one version (⌘S, Publish and a tab-leave save add their own).

## The node panel and editor details (B23, 2026-11-14)

Built ([Building and debugging a flow](features/editor.md)): the node panel header is the name, a
line of description and one Run step, with Breakpoint and Run from here in Settings (P-np-1, P-np-2); Settings shows On
error, Retry and Notes, the rest under More (P-np-3); view switches show only with data (P-np-4); Events is a tab in
the open logs panel (P-ed-5); workflow settings show three fields, the rest under Advanced (P-ed-6); a node's toolbar
is Run, Disable, Delete and ⋯, and the right-click menu matches (P-ed-7). All seven are done.

## Conversation history and personal preferences (2026-11)

The first piece of the company-backbone program (wave 1, B02). Built: the `user_preferences` and `conversations` tables
(migrations 2070 and 2071), their session-only routes, the retention service, the client hooks and the history popover
([assistant.md](assistant.md#conversation-history)). Next: each chat mounts the history button and saves to the store,
and the account menu gets the switches. Deleting a person removes their conversations, preferences and private work events (wave 1 carryover). Open: a pin should decide whether retention spares a conversation, search wants a plain-text column, and `GET /api/conversations/:id` wants a `limit`.

## Tagging with @ (B04, 2026-11-14)

The foundation is built: `GET /api/mentions`, `resolveMentions` with a digest per kind, and the picker
([assistant.md](assistant.md#tagging-with-)). Closed by B16 and B17: Spotlight and Ask the brain mount the picker and
their servers resolve the tags, with one key-scope table for all three routes.

## Test chat history per person (B10, 2026-11-14)

Open: the test chat writes every session as user "you", so "Earlier tests" lists everyone's tests of that agent. The chat
route should store the caller's id (it also affects memory and the policy role check); then the sessions route can filter
`source=test` to the caller. Also: `source` wins over `audience` when both are given.

## Workflow runs and tests (B22, 2026-11-14)

Built ([the Runs tab](features/editor.md), [Run Trace](run-trace.md#the-screens)): a workflow's tabs are **Editor | Runs |
Tests** at `/workflows/:id/runs` and `/workflows/:id/tests`, and the old `executions` and `evaluations` links redirect
with their query. A run's view has no Canvas / Run trace switch (P-wfexec-1; **Full screen ↗** opens the trace), a plain
header with the run id in **⋯** and **Debug in editor** in the Re-run menu (P-wfexec-2), and no Auto refresh: the list
updates live and waits while the pointer is over it or it is scrolled down (P-wfexec-3). The Tests tab drops the yellow
"no evaluation trigger" box and says **Add an evaluation trigger** (P-eval-1). X12 (tabs three levels deep) is closed.
Links elsewhere in the app still name the old paths and go through the redirect; the retry and re-run words wait for
B20's constants.

## Company backbone: left open from the wave 1 reviews (2026-11-14)

The wave 1 review notes were fixed in wave 2's carryover where they were contained; these wait, each with its reason:

- **Token wording in the reply footer**: it reads *1,600 tokens* (`formatTokens`, as Insights does) where the brief's
  example said *1.6k tokens*. Which one the footer should use is the person's call; the docs and tests agree with the code.
- **Insights per workflow vs today**: the per-workflow report includes Spotlight's rows for a workflow while its
  `today` figure (`workflowDay`) leaves them out, so the two can differ. A surface breakdown in the report would explain it.
- **A checkpoint taken before the stream starts**: a request aborted between `takeCheckpoint` and its first failed step
  loses the checkpoint, and a resume does not carry the guard's `invented` id set. Both need the checkpoint to be
  re-saved on abort, a larger change than a carryover.
- **Section tabs**: `SectionNav` makes its own `/api/plugins` request and does not follow registry events (Runbooks shows
  after a navigation when Landfall registers), and its tabs are `role="tab"` links without arrow keys or a tabpanel (a
  `nav` with `aria-current` would be more correct). Both change the shell's markup; left for the next shell pass.
- **All projects and Manage projects** both open `/projects` in the switcher; dropping one belongs with the projects
  page (B34).

## Company backbone: left open from the wave 2 reviews (2026-11-14)

The wave 2 review notes were fixed in wave 3's carryover where they were contained; these wait, each with its reason:

- **Spotlight changed a flow when asked a question**: with Autonomous on, "What does this flow do? change nothing"
  (qwen3-coder:30b) applied a change. B24's **Asks first** lets a person keep changes for review; a server guard that
  tells a question from a request is a model-routing change, larger than a carryover.
- **Ask the brain's answer is one paragraph**: it has no short reply with **Show more** as Spotlight has. The answer's
  links need a cut that never splits a `[[link]]`; it belongs with the one Spotlight (B35), which takes over the panel.
- **The streaming caret** sits on its own line under a paragraph (`StreamingText` puts it after the Markdown block);
  moving it into the last block needs the Markdown renderer to take it. The first model step's words fading into a
  Thought row when a second step starts is as designed; revisit with B24's motion.
- **The reply footer wraps** "local" onto its own line at 1440 px in the test chat (`ReplyMeta` joins its parts in one
  span); wrapping only between parts needs a look at the phone too.
- **The architect's kept conversation** shows a retried or continued question and its error twice when reopened (a retry
  appends again); replacing the failed item is a change to how the store keeps turns.
- **Agent sessions at scale**: `listSessions` with a filter reads every summary of the agent (the Sessions tab's 6 s
  refresh does this), and on Postgres the cursor's `id` tie-break follows the collation while the code compares in JS
  (same-millisecond ties only). Filtering in SQL fixes both.
- **The test chat's activity line** keeps only a 300-character detail of a tool row: no link to a child agent's or
  workflow's run (the Sessions tab has the full row).
- **Folded-away versions**: a decided publish request, the publish log or `restoredFrom` can name a version that an
  autosave folded away; readers already allow a missing version (the 50-version cap does the same), so it is cosmetic.
- **Tests not written**: the editor's autosave effect (re-arm, queue, leave flush) is tested only through its pure
  helpers (moving it into `chrome.ts` would cover it); the user menu's two switches and the "Keep my conversations"
  delete prompt have no test; `apps/web/claude-plugins/landflow-brain/hooks/register.test.ts` runs only through
  `claude plugin test`, which the wave gate runs and `pnpm check` does not.
- **MCP internals**: `instance-tools.ts` wraps `server.registerTool` through casts to enforce key scopes, so an SDK
  signature change would pass silently (the tool-count assertions catch a tool missing from `TOOL_SCOPES`); a typed
  helper would be sturdier. `openapi.ts` has no `/api/mcp` entry, so the MCP text sits on `/api/mcp/projects/{id}`.
- **Developer details vs the reply footer**: the switch hides model lines on agent cards, the node panel and the run
  trace, but the chat kit's footer and model chip always show model, tokens and cost. Whether one rule should cover
  both is the person's call.
- **Needs you after a sign-out**: the list is a module-level store; sign-out does a full page load, which clears it.
  A sign-in as someone else without one would show the previous list until the next fetch.
- **Ask's short follow-ups** borrow the last question's words when they have three or fewer of their own, so a short
  question on another topic also pulls in the earlier pages; watch it in the Ollama live check.

## Company backbone: left open from the wave 3 reviews (2026-11-14)

The wave 3 review notes were fixed in wave 4's carryover where they were contained; these wait, each with its reason:

- **Two trace rows per tag**: Spotlight streams a `step.start` and a `tool` event per tag (C3), so the trace shows
  "Reading @X" and "Read @X" for the same 0.0 s read. Folding the pair into one row changes the stream contract the
  timeline and the stored steps read; it belongs with the one Spotlight (B35).
- **A stale proposal mid-visit**: whether a Spotlight proposal is stale is decided when the conversation is shown, so a
  card does not get its Apply back if the workflow changes again during the same visit (docs/assistant.md says so).
  Re-deciding on every canvas change needs a subscription the panel does not have yet.
- **Ask the brain after A → B → A**: following a link and coming back starts a new conversation for A, so the history
  splits (nothing is lost). Reopening the began-in conversation when the subject returns fits B35, which takes over
  `ask-panel.tsx`; the hook's wiring (`storeElsewhere`, the began-at and began-in refs) has no test until then.
- **A new `team` event on the live stream**: `notify` in `usage/ledger.ts` sends only `org` events to everyone, so a
  teammate sees a new `team` item at the next fetch, not live (the safe direction). Sending it live needs the stream to
  know each listener's projects.
- **Repository page ids can collide**: `repoEntityId` turns `acme/api-x` and `acme-api/x` into the same id, so the second
  repository gets no page of its own. A collision-free id would orphan the pages made so far; it needs a migration.
- **A viewer-style role**: `/connect` offers every workflow scope to every role because owner, admin and member all hold
  them; a role without them would need `can()` per scope on that page.
- **Run trace checkboxes** (P-trace-5): Debug access still shows its two checkboxes (both on); the review also asked to
  hide them behind the defaults. B21's brief asked only for plain words, so this waits for the person's call.
- **A paused Runs list goes stale**: while the list waits (pointer over it, scrolled down), a row that was running keeps
  saying Running until the list resumes. Applying status changes to shown rows and holding back only new rows would fix it.
- **Tests on a phone**: the Tests page's fixed 300 px sidebar squeezes the main pane to a word per line and the centred
  tabs cover the workflow name; it needs the phone layout the Runs page has.
- **Canvas details from B23**: right-click on one node no longer offers Ungroup (Shift+Cmd+G or the group's menu still
  do; the menu follows the toolbar, so adding it back is the person's call); the toolbar's Run button has no disabled
  look while a run is going on (a click does nothing); the node toolbar's ⋯ menu stays where it opened when the canvas
  pans under it.

## Company backbone: left open from the wave 4 reviews (2026-11-15)

The wave 4 review notes were fixed in wave 5's carryover where they were contained; these wait, each with its reason:

- **Auto-sent events queued before the admin's rule**: the landflow-brain mod's mode `auto` queues an event at session
  end; if the admin then forbids sending on its own, an event already queued is still flushed later. Dropping it needs
  the queue to re-check the policy at flush (or the server to refuse it), a change to the queue's contract.
- **Review resets a widened item**: `/brain visibility <id> team` on a held item, then a plain Send in `/brain review`,
  sends it private (the safe direction, and what the prompt says). Showing the current visibility in the review question
  is a wording change in `register.ts` (B38 did not do it; still open).
- **No test renders a Teams card**: the card (name, goal, status) is inline in `TeamsView` behind `useRouter`; testing
  it needs it extracted into a component of its own.
- **Live checks still open from wave 4**: Spotlight's continue-from-step with a real model stopped mid-run; importing an
  agent JSON through **From a file**, the zero-agent persona strip and a Teams card with real data; a real kagent deploy
  from Abilities → Deploy, and dark mode and Reduce motion on the new Abilities rows; the Brain with pages and Insights
  with cache or router traffic in a browser; and fresh screenshots for B24, B26, B27 and B28 at 1440×900 and 390×844
  (the review's were taken before their fix commits). They need a host and a browser, which the carryover does not run.

## Company backbone: left open from the wave 5 and LiteLLM L1 reviews (2026-11-15)

The wave 5 and L1 review notes were fixed in wave 6's carryover where they were contained; these wait, each with its reason:

- **The mod's session start and the nightly text**: still the open item under the briefing above (B38 did not build it).
- **Velocity counts a redelivered fact twice**: a pull request closed, reopened and closed again, or a delivery pinned
  and run twice, gives two ledger rows with the same `sourceId`, so a review delivered twice adds a handoff round.
  De-duplicating on `sourceId` alone would let anyone who can record an event choose a value that hides another's (and
  Record Event's `workflowId` can be chosen within a project), so it waits for a key no caller controls.
- **A takeover leaves the import's `ai.call` event**: when the spend import reads a row before Landflow's meter records
  the call, the meter takes the `ai_usage` row over, but the `ue_ll_<hash>` usage event keeps the key's agent and project
  and the import's price ([llm-gateway.md](llm-gateway.md)). Rewriting it touches who a call's money is attributed to, so
  it needs its own reviewed change.
- **A raw expression as a node's subtitle**: a tile whose subtitle names a parameter set to an expression (Record
  Event's `{{ $json.kind }}` on the GitHub template) shows the expression. Hiding expressions changes every canvas tile,
  so it waits for a design pass.
- **One marketplace, added by someone**: its Refresh and Remove card is hidden with the source menu
  ([limitations](limitations.md)); a card above every Explore page waits for a design pass.
- **Layout checks**: the Workflows and Credentials empty-state tests read source strings, which do not catch a layout
  break at 390 px; a browser check of scroll width and overlap belongs to the UI pass. `workflows-list.tsx` is still
  above 800 lines after its last run and New menu moved to `list-parts.tsx`.
- **Live checks still open from wave 5**: Build it clicked on desktop and phone, the GitHub to Work Event panel at
  390×844, the GitHub template tile after a host restart, Explore with two marketplaces and real installed plugins, and
  fresh screenshots for B30, B31, B32 and B34 (the review's predate their fix commits). They need a host and a browser.

## Company backbone: left open from the wave 6 reviews (2026-11-15)

Wave 7's carryover fixed the contained wave 6 notes (the brain wiki's dead exports, the builder given back when the brain
panel closes, run lines that name their workflow, one Ask why it failed per failed run, the run page's Ask in its ⋯ menu
on a phone, `safeHref` and `safeLink` by host, the phone's setup button, /connect's marketplace install, closing Spotlight
before the new sync workflow opens, and no Slack Apply on a build prompt). These wait, each with its reason:

- **"What finished" on the briefing card**: still the open item under the briefing above; `Briefing` has no `finished`
  list, and adding one changes B30's briefing shape and its nightly text, so it wants its own package.
- **Set up tomorrow sync twice**: the button hides when a visible workflow has a List People node, so a sync workflow in
  a project the admin cannot open leaves it up, and a second click makes a second copy. Recording the template on the
  workflow does not help (the admin still cannot list it); the fix is a server-side check in `POST /api/templates/<id>/use`
  or a "sync exists" answer on the briefing route, which reads past the caller's projects and needs its own review.
- **Team work in overlap introductions**: B38's "two people sharing team work get one introduction" is not met; the
  detector reads `org` work only until `canProposal` (`brain/scope.ts`) refuses non-audience readers for it
  ([limitations](limitations.md)).
- **The mod's nightly text and the review prompt's visibility**: still the open items above; PR05 changed the mod's
  session start for practices only, and PC11 (wave 8) for the project section only.
- **Install lines in the node-plugin READMEs**: `claude plugin validate .` advises a `/plugin install <name>` line for
  each `plugins/*` bundle. They are Landflow node plugins with flows, not Claude Code plugins, so a Claude Code install
  line would mislead; the README's install text waits for Explore's own install wording.
- **Live checks still open from wave 6**: B35's editor shots retaken after its fixes and "Ask the brain instead" / "Build
  here instead" in about mode at 390×844; the credentials menu and the brain page's Ask button with real data; B37's
  base-build and flow-briefing shots; ⌘K on Home, `/brain` and the editor; "Ask why it failed" from a phone-width ⋯ sheet
  (the sheet closing, scroll lock, focus); Your morning with the shell panel open at 390 px and at desktop width. They
  need a host and a headed browser, with wave 7's live pass, and are carried to wave 8's.

## Company backbone: left open from the wave 7 reviews (2026-11-15)

Wave 8 closed the wave 7 notes it could: `ApplicablePractice` names its id and practices resolve by id (PR08), the
pickers and the test chat follow availability and shared-only members cannot read an agent's sessions (PC06), the
practices row is in "What it saw", and a deleted project's practice suggestions are dismissed with its practices. These
wait, each with its reason:

- ~~**Home readers see other projects' briefs**~~ Done in wave 9 (PC13): a session is read and continued only from the
  project it ran in ([projects-and-goals.md](projects-and-goals.md#sessions-belong-to-a-project)).
- **kagent over MCP outside a team**: a kagent agent called over MCP gets no project block and its `practices_for`
  binds to its home project; only a team's open call carries the run's project. A run binding for it is its own package.
- **Model verdicts in `landflow practices check`**: the CLI runs machine checks only; a model's verdict reaches a flow
  through Check Practices (PR08).
- **A reminder after Write or Edit on a matching path**: the mod never denies a tool call, so a reminder hook is its own
  package.
- **Live checks owed from wave 7**: the team's goal line and the A2A compact block, and Practices Act 1; carried to wave
  8's live pass with PC12's goal picker and PR07's index line.

## Company backbone: left open from the wave 8 reviews (2026-11-15)

Wave 9 closed the wave 8 notes its packages owned: a session is read and continued only from its own project, so home
members no longer read other projects' briefs, ratings or graded replies, and whoever can read a run opens its Run an
Agent session panel (PC13); a project's repositories have a screen (PC16). Its carryover added a join test for each
contract (settings, sessions, budget, workspace and a project's deletion). These wait, each with its reason:

- **The session fold's persona**: What it saw shows the agent's persona as it is now, not as the run had it; it needs the
  persona's version on `attrs.saw`, its own package (PC08's line above).
- **Citation drift**: the practice-drift detector reads compliance only (PR09's line above); drift in what agents cite
  wants its own measure.
- **Practices for remote and in-process agents by repository**: repository-scoped practices don't reach in-process
  agents (PR06), and an A2A node outside a team binds `practices_for` to the agent's home project (PR07). A run binding
  for remote agents is its own package, with kagent over MCP outside a team (the wave 7 list above).
- **Live checks owed from wave 8**: `project_context` from Claude Code over the brain MCP key; a Claude Code session in
  a throwaway repository listed on a scratch project starting with its goals (the mod 0.4.0); the workflow and team goal
  pickers (PC12); a kagent member getting the practices index and calling `practices_for`; a tainted draft and a
  person's draft in the inbox, Apply only on the second. They need a host and a headed browser, and are carried to wave
  9's live pass with its own checks (the Settings tab's cards, a shared-only member's Run an Agent panel, a $0.01 budget
  with a hard stop, the Workspace card) and those still owed from waves 6 and 7.

## Company backbone: left open from the wave 9 reviews (2026-11-15)

Wave 10 closed the wave 9 notes it owned: Delete this project is last in Settings and the Run Trace's budget section no
longer splits the Runs paragraph (PC20); the integration fixed a raise from a warning leaving the stop open, a dropped
repository's stored workspace entry, a workspace save that changed nothing being audited, the audit labels, the
evaluations route's session reads, the team-tool exemption by name, and the two Settings cards (errors under the field
sent, viewer modes as text, "Choose a model", the budget card's dirty rule, the confirm sheet, the raise dialog's amount).
These wait, each with its reason:

- **Session summaries without a project**: summaries saved before `projectId` existed cost one session read per list
  call for a member who is not an admin; a one-time backfill or a cache is its own change.
- **The routed model on the span**: a run's span names the project's default model, not the router's cheap model when
  the run was routed (main behaves the same); the span attributes are their own change.
- **The stop's audit by import side effect**: `budgets/enforce.ts` registers the stop's audit event when it is
  imported; a process that loads only the usage meter would open stops without it. The host always loads it through
  `runtime.ts` (lesson 10 territory, its own change).
- **`callLimits` and `scopeProjectId`**: every check resolves the project again. It is cheap; measure before changing.
- **Branch names a harness fills in**: `branchFor` can leave `..`, a trailing `.` or `.lock` from a token; the harness
  plan's stage 2 must check the result with `isValidBranch` ([harnesses.md](harnesses.md)).
- **Workspace card edges**: a setup line refuses a tab inside it, and the branch example keeps the old project slug
  after a rename until the page reloads.
- **Hand-indented lines** in the PC15 cards: there is no formatter in the repository; no change.
- **Live checks owed from wave 9**: a shared-only member opening the Run an Agent panel of their run; a home member's
  Sessions tab without another project's sessions; an Ollama call running while the project is stopped; the cap on
  Insights → AI and an editor's "Ask for more" approved through the cap-raise flow; Raise and Dismiss from Needs you; the
  Workspace card and `GET /api/projects/context?repo=` as an editor and a viewer; dark mode on the cards. They need a
  host and a headed browser, and are carried to wave 10's live pass with its own checks and those still owed from
  waves 6 to 8.

## Company backbone: left open from the wave 10 reviews (2026-11-16)

Wave 11 (token spend) checked the wave 10 notes against its merge; none were in its packages' files. These wait, each with
its reason:

- **Goal progress tests (PC18)**: the progress tests build their examples through a helper rather than the contract's
  JSON literals, and there is no "today" case with a one-day window; a change for when a package next touches
  `goal-progress` tests.
- **No Cancelled filter on the Tasks tab (PC20)**: cancelled tasks show only under All; a filter is its own small UI
  change with a desktop live check.
- **Initiative caps match with `attrs LIKE` (PC17)**: documented in [projects-and-goals.md](projects-and-goals.md); no
  change.
- **Long signatures in `goals/progress.ts`** (lines over 180 characters): cosmetic, there is no formatter; no change.
- **Agent and team exports keep judge and cheap-model credential references**: documented
  ([limitations](limitations.md#project-export-wave-10)); no change.
- **Live checks owed from wave 10 and wave 11**: wave 10's Goals progress line and sheet, the project Tasks tab and its
  dialog, Approve and Deny for a task in Needs you, the project Export dialog with a downloaded zip (desktop and 390 px);
  wave 11's Insights → AI as a member (every person by name, the "Everyone" total, other projects still "Another
  project") and, on the integrated host, an agent run with a guardrail and a judge showing its purposes on Insights → AI
  and `GET /api/insights/ai-usage?executionId=`, with Grafana's AI panels drawing on the local LGTM stack. They need a
  host and a headed browser, and are carried with those still owed from waves 6 to 9.

## Company backbone: left open from the wave 11 reviews (2026-11-16)

Wave 12 (token spend) checked the wave 11 notes against its merge. SP19 pinned the team member's prompt as a literal and
tests a cache point in the middle of a real agent draft; SP07's history row says a team report's cost for Anthropic
members has been cache-aware since wave 11; SP19 rewrapped the long `// SP03:` lines. These wait, each with its reason:

- **No `knowledge` part is ever produced**: passages from an agent's knowledge bases reach the model as tool results, so
  they count under `toolResults`; [llm-gateway.md](llm-gateway.md#what-a-prompt-was-made-of) leaves `knowledge` out of
  its list and the screens show only parts that are present. Splitting them needs the knowledge tool to mark its
  results; the waste detectors (SP13, wave 14) should not expect the part until then.
- **The cache alert's 7-day baseline includes the dropped period** ([observability.md](observability.md)), so a
  sustained drop lifts its own baseline and the alert clears after a few days. An `offset` baseline is its own change to
  the rule and its promtool tests; SP19 raised the hit rate rather than dropped it.
- **Run an Agent's calls have no model span** (found by `spend-trace-join`): the Spend tab lists them with plain times
  and the per-call sheet never opens for them ([limitations](limitations.md#token-spend-what-it-cannot-do-yet)).
  Writing one `model` span per loop step from the agent's session is a Run Trace change of its own.
- **Live checks owed from wave 11 and wave 12**: Insights → AI as a member of an instance with several projects (projects
  they can't open are "Another project", a person whose only rows are there still has their figure); the Run Trace's
  Spend tab and a call's sheet at 1440×900 in light and dark (each "By" view, the cache line, a hidden sub-run for a
  member, a live run's numbers moving, "Same prefix as the previous call", a gateway split's "From the LLM gateway",
  390 px without sideways scroll); one call through the OrbStack gateway on `qwen3-coder:30b` giving a `gateway`,
  `tokenizer` split whose `requestId` is the spend log's `request_id`, with nothing posted while the secret is unset; and
  an Ollama agent run whose Spend tab says "Counted by the model's tokenizer". They need a host and a headed browser,
  and are carried with those still owed from waves 6 to 10.

## Company backbone: left open from the wave 12 reviews (2026-11-16)

Wave 13 (token spend) checked the wave 12 notes against its merge. SP10's drill sheet opens any call by its id, so a Run
an Agent call's composition is reachable from the AI page; SP11's limitation lines name the 1,024-token cache minimum
and gateway rows without cache numbers. These wait, each with its reason:

- **On Ollama `formatting` holds the chat template** (about half of a call with tools, 221 of 355 tokens on
  `qwen3-coder:30b`; [limitations](limitations.md)): it is real input, so the waste detectors (SP13, wave 14) should not
  read a large `formatting` on an Ollama call as waste. Wave 13 shows no composition on the AI page.
- **Run an Agent's calls still have no model span** in the Run Trace (above, wave 11): the AI page's drill sheet opens
  them by id, but the Spend tab's per-call sheet does not; one `model` span per loop step is its own change.
- **A Landflow call on a gateway credential keeps Landflow's estimate** even when the gateway's split counted it exactly
  ([llm-gateway.md](llm-gateway.md#what-a-prompt-was-made-of)); deciding which split wins is its own change, and no wave
  13 package touched it.
- **`MIN_CACHEABLE_TOKENS` is one figure (1,024) for every model** (`ai-usage/run-spend.ts`): a newer Claude model's
  higher minimum reads as `not-requested`; documented ([limitations](limitations.md#token-spend-what-it-cannot-do-yet)), a per-model
  table waits for a model that needs it.
- **Left after the sb3 carryover (2026-11-17)**, each with why it waits:
  - **A one-line change in long code** (sb2 live: 0 of 3): it needs a line-edit operation, since `setParameters` replaces
    the whole code string and the local model rewrites it; no op of the set does a line yet.
  - **The phone Execute/Debug pill over a failed step's card** (the same on main): a phone follow-up in
    [mobile.md](mobile.md) "What's next"; no sb3 package touched the Steps view.
  - **`useCanvas` in the diff card is memoised on nodes and edges only**: a diff whose `before` should read workflow
    settings changed after the card appeared is not re-read until a step changes. Cosmetic.
  - **The model list's embedding filter is by name only** (`models-list.ts`): a chat model with "embed" in its name is
    hidden, an embedding model without it is listed.
  - **The combined diff cache, the `LiveSteps` SSR test and `addNode` "before" in the diff** (SB08's review): small, no
    owner this wave.
  - **`expressionMisses` on a renamed step, and its broad regex** (SB09's review): SB14 reuses it as it is; a false
    send-back on a draft step costs one call and is read in the live numbers.
  - **The ask chip is marked before the send; the auto-session's destination test** (SB11's review): no owner of `AskRow`.
  - **SB14's per-step call keeps its own model call** (`build-nodes.ts` `askStep`) instead of the flow builder's
    `askModel`: the same adapters, usage note and JSON mode, a smaller token cap and its own wording; folding them is a
    tidy-up with no behaviour to gain.
- **Two concurrent counts of the same prefix both send a count request** (`ai-usage/count/anthropic.ts`): the results
  stay correct and each request is free; sharing an in-flight count would also have to share its per-minute budget slot.
- **Long unwrapped doc lines** (`llm-gateway.md`, `projects-and-goals.md`, `run-trace.md`, `agents.md`): cosmetic, there
  is no formatter, and rewrapping whole files is not done; a change rewraps the lines it edits.

## Company backbone: left open from the Spotlight wave sb1 reviews (2026-11-16)

Wave sb2 took sb1's one-step half (scope, changes that mean what they say, context, the diff, asking, credentials, the
model) and fixed the protocol-relative URL host the guard kept. These waited for wave sb3, each with the package that owns
the code. **Wave sb3 built all six** (SB13/SB14 the Linear/Slack draft, SB16/SB17 a new agent's tools, knowledge and least
privilege and the dialog's fresh start, SB18 the session's reload, review, loop and one yes per scheme), checked together
in `spotlight-sb3-joins.test.ts`; the model-dependent readings (k of 3) are the sb3 live pass's:

- **A new agent's tools and knowledge** (sb1 live: tools kept 0 of 3, knowledge base 0 of 3, fed on to the reply 1 of 3,
  Linear added as a main step with an invalid operation): SB16 (agents anywhere, D5) and SB17 (the agent brief) decide
  how a new agent's tools and knowledge reach the architect and the canvas; sb2 only placed it (SB07's insert scope).
- **The architect's tool choice** (the PR reviewer's least privilege 0 of 3; Slack and `run_an_agent` added unasked) and
  **the dialog reopening the previous conversation**: SB17 owns the brief, its evals and the dialog's start.
- **"Test and fix" and the "Run it for real" card are lost on reload**: SB18 owns `test-session.ts` and the session's
  start; a kept conversation does not keep a session's turns by design ([limitations](limitations.md)).
- **"Stopped · It runs, but doesn't do all you asked yet" after a right fix** (the review too strict) and **"Run it for
  real" re-entering `testUntilItRuns`** (the fix budget, `startNodes`, `lastApplied` and `tried` reset; each round
  still needs the person's click, so nothing runs alone): SB18 owns the session's verdict, the review and its loop.
- **`https://x` and `http://x` share one yes to send** (`run-check.ts` `destinationsOf` keys a destination by host):
  the same host, so no new destination; SB18 owns the yes ([limitations](limitations.md)).
- **The Linear/Slack first draft** reads `$json.lastRun` before the Set that defines it, turns "every morning" into
  weekdays 9:00 and assumes `$json.issues` in Slack: the first draft's prompt and checks are SB13/SB14's (the staged
  build); SB09's `change-checks.ts` (`expressionMisses`, `cronProblems`) is written to be reused there.

## Runs: one list (B20, 2026-11-14)

Closed from the wave 1 page review: X2 (Executions, Runs and Search runs are one page, **Runs** at `/runs`, the old URLs redirect), P-ex-1 (no ID or Mode column), P-ex-2 (Stop all only while a run runs), P-ex-3 (repeated failures fold into one row), P-ex-4 (two re-run words), P-runs-1 (one search box with Status and Workflow chips, the rest under More filters) and P-cmp-1 (compare with fewer than two runs goes back to the list). See [the Runs list](run-trace.md#the-runs-list).

Follow-up: the Runs list filters load only the latest 200 runs and its journal filters 100 matches; page the list server-side and bring journal word search back into the UI (see [limitations](limitations.md#runs-list-filters-b20-2026-11-14)).


## Quieter Brain and Insights (B28, 2026-11-14)

- **Quieter Brain and Insights (B28, backbone wave 4; P-br-1, P-br-2, P-in-1, P-in-2, X13 for the brain and Insights)**: an empty
  brain shows the index alone, Open editors is gone, the status bar has the page count and problems, empty index cards are
  hidden; Insights drops the migration banner, shows the Agent layers card only when the cache or router was used, hides
  "no change" deltas and puts its footer behind a help line.

## Lists, credentials, tables, projects and sign-in (B34, backbone wave 5)

Closes P-wf-1, P-wf-2, P-cr-1, P-cr-2, P-dt-1, P-pr-2 and P-auth-1; X10 closed in part (below).

- **Workflows** has one **New ▾** (Workflow, From template, Import…, Folder) in place of three buttons. **Import…** takes
  a workflow file (Landflow, n8n or Flowise) or a template file (a template page's **Export**), which goes to the
  templates library in the folder's or picked project and opens its page. A row shows its
  last run (Succeeded, Failed, … and when) instead of the step count; the list reads the newest 500 runs after it has
  drawn, so a workflow with no run among them says "Not run yet" (and nothing at all when older runs exist beyond the 500). On a
  phone the row shows the state badge beside the updated time. The "All workflows" crumb shows only inside a folder or a project.
- **Credentials** has no type grid; **New credential** opens the searchable type list, grouped by app, with no plugin
  column and no "API" suffix. `/credentials?project=<id>` lists one project's credentials (the API's `?projectId=` read).
- **Data tables**: Import CSV and Export CSV are in **⋯**; **+** at the end of the header row adds a column.
- **Projects**: four tabs, Overview (counts that open the global page for the project, a **New ▾** that makes a workflow,
  credential, data table or agent in it, and the project's data tables and agents each with **Move to project…**),
  Members, Settings (with Variables) and Audit log. The old `?tab=` values map to them.
- **Empty pages** (X10): on Workflows, Credentials and the data table's rows the header button hides while the empty state
  shows its own; the empty Workflows states carry every New action (Folder at the root, Import in an empty folder).
- **Sign-in**: no welcome sentence; an invalid or expired invite shows only the message.
- Left open: `/data-tables` and `/agents` do not read `?project=` yet, so the Overview's counts for them open the whole
  list (the Overview lists those items itself); X10 still shows twice in Settings → Variables ("Add variable" beside
  "Add your first variable", now also in a project's Settings tab) and in Agents → Teams, both outside this package.

## Ask about it (B36, backbone wave 6)

- **CH16 closed (the sending side).** Every resource's ⋯ has **Ask Spotlight** and a failed run has **Ask why it failed**;
  they fire `landflow:ask-about` with the resource and three starters ([spotlight.md](spotlight.md#ask-about-it)). The chat
  panel that listens for it is built (B35).

## Projects with goals (Paperclip program, waves 7-10)

Projects get a mission to serve, goals and a brief, and agents learn where their work fits. See
[projects-and-goals.md](projects-and-goals.md).

- **PC01, built:** the data and API. The company mission in Settings (`company`), the goal tree (levels, status, owner,
  target date, parent, four levels deep), the goals a project serves in order (its first planned or active one is primary),
  linked brain initiatives, the project brief (brief, constraints, done-when, words we use, status, target date, lead,
  decision owner) and the context data source for the "Where this work fits" block. Closes the server side of P1.
- **PC06, built:** agents across projects: shared to projects or to all of them (`GET|PUT /api/agents/:id/shares`),
  `agentAvailableIn` and `availableAgentIds`, `GET /api/agents?availableIn=`, the Run an Agent picker listing only
  available agents, the test chat's 403 for an unavailable project, and sessions read only from the home project
  ([projects-and-goals.md](projects-and-goals.md#agents-across-projects)). Closes P3-1 and P3-2 on the server; the
  screens are PC07.
- **PC02, built (wave 7):** the screens (Goals page, goal dialog, the brief on the project Overview, Settings → Company).
- **PC03, PC04 and PC05, built (wave 7):** the block and its injection into agent runs, the compact block for remote
  agents and teams, and usage by project and goal ([below](#paperclip-wave-7-project-context-pc03)).
- **PC07, built (wave 8):** the agent screens: Make available…, "Available in", Test in project with the preview, the
  Project context and Practices switches and View prompt
  ([projects-and-goals.md](projects-and-goals.md#testing-an-agent-in-a-project)).
- **PC08, PC10 and PC12, built (wave 8):** what the agent saw, project context for harnesses and builders, and the goal
  pickers ([below](#paperclip-wave-8-what-the-agent-saw-pc08)).
- **PC09, built:** cost per goal. A Goal grouping on the AI page, after Project, limited to the goals the viewer may see. Closes P4-2.
- **PC11, built (wave 8):** the landflow-brain mod 0.4.0 starts a session with the project section for the repository and
  adds `/brain project`; `landflow work context` prints the same block in the shell
  ([projects-and-goals.md](projects-and-goals.md#in-claude-code-and-the-shell)).
- **PC13 to PC16, built (wave 9):** project settings for agents (a default model, a knowledge base, the agents and tool
  kinds allowed) and sessions read and continued only from their own project (PC13); the project AI budget as one more
  cap, with a warning, an optional hard stop, incidents and Needs you items (PC14); the Settings tab's **Agents in this
  project** and **AI budget** cards and the budget rows in Needs you (PC15); and the project workspace for harness runs
  with the repositories screen (PC16) ([projects-and-goals.md](projects-and-goals.md#project-settings-for-agents),
  [below](#paperclip-wave-9-project-settings-for-agents-pc13)).
- **PC17 to PC21, built (wave 10):** goal progress, project tasks and the project export: [Paperclip wave 10](#paperclip-wave-10-progress-tasks-and-export).
- **Open:** the Paperclip plan (PC01 to PC21) is built. What is left is in the follow-ups: [wave 10's limits](limitations.md#project-tasks-wave-10)
  (no autonomous task runs, no progress history, no PROJECT.md import) and
  [the wave 9 reviews' list](#company-backbone-left-open-from-the-wave-9-reviews-2026-11-15).

## Not planned

Later, maybe: an agent code sandbox, and prompt management. Not planned:
Later, maybe: browser use, an agent code sandbox, spoken replies and realtime voice (dictation into Spotlight is built), and prompt management. Not planned:
RPA, process mining, an app builder, and a chat hub (n8n is retiring its own).

## Connect your harness

Built: `/connect` (copy-paste setup and a brain key for each harness), Settings → MCP in four collapsed sections, and the admin's switch that forbids automatic sending ([connect-your-harness.md](connect-your-harness.md)). Closes V1, MOD4 and P-set-3 of the company backbone plan.

## Settings in five groups

Built: Settings in five groups, API docs moved to Developers, the built-in price table folded and AI caps their own section, status rows with a help-tip instead of environment-variable paragraphs, an Audit Log and Configuration split with filters that apply on change, json-render under Advanced and "Prune now" in the ⋯ menu, and one sentence of help with a "?" popover in the settings intros (carry-over: the configured SAML card's key-management notes, the External secrets intro and its "Allow in node parameters" note, and the Users invite and removal notes still run longer than one sentence; ~~the cap-reached error, the cost-alert text and link, and the header comments still say "AI prices" and "Settings → API"~~ fixed in the wave 4 carryover: they say Settings → AI caps, link to `#ai-caps` and name Developers → API reference) ([settings-and-data.md](features/settings-and-data.md)). Closes P-set-1, P-set-2, P-set-4, P-set-5, P-set-6, P-set-7 and X9 of the company backbone plan.

## LiteLLM wave (L1)

LiteLLM in front of every model call, open-source build only; Landflow's caps decide and LiteLLM's budgets are the
backstop. Self-hosted Claude Managed Agents and an agent-runtime seam are deferred.

- **LL01, built:** the `llm-gateway` compose profile runs LiteLLM pinned by digest (after the 21 October 2026
  compromise), with its own database, Ollama models and the UI on loopback; a Kubernetes example for `landflow-dev`
  ([llm-gateway.md](llm-gateway.md#run-it)).
- **LL02, built:** Landflow's own calls through the gateway: the Gateway field on the Anthropic API and OpenAI API
  credentials, gateway model lists, who-is-calling headers, no fallback beta, and LiteLLM's call id and cost on each
  AI call ([llm-gateway.md](llm-gateway.md#point-landflow-at-it)).
- **LL03, built:** a virtual key per agent on kagent and Claude Code, kagent's ModelConfig through LiteLLM, and the spend
  import that counts their calls once ([llm-gateway.md](llm-gateway.md#agents-outside-landflow)).
- **LL04, built:** the budgets sync (projects as teams, people as customers, dollar caps as backstop budgets) and
  Settings → LLM gateway ([llm-gateway.md](llm-gateway.md#budgets-in-litellm)).
- **LL06, built:** Insights → AI: spend and tokens by project, agent, person, model and source, caps and how near, the
  gateway, and requests with Ask for more ([llm-gateway.md](llm-gateway.md#the-ai-page)).
- **LL05, built:** asking for a higher AI cap: requests, the Cap Raise Request trigger, the cap-raise template with Ask a
  Person, and Apply Cap Raise, which changes the Landflow cap and tells the budgets sync only after an admin other than
  the requester approved ([llm-gateway.md](llm-gateway.md#asking-for-a-higher-cap)). The Insights → AI "Ask for more" dialog
  (LL06) is built.
- **Project budgets, built (PC14):** a project's budget is a cap kind of its own ([projects-and-goals.md](projects-and-goals.md#ai-budget)).
  The LiteLLM team budget as a backstop stays deferred, for the reason in [llm-gateway.md](llm-gateway.md#budgets-in-litellm).

## Paperclip wave 7: project context (PC03)

- **PC03, built:** the "Where this work fits" block for every agent Landflow runs: the run resolves its project and goal
  (caller, workflow, team, agent home), the builder writes the block (mission, goal chain, brief, run line; full or
  compact, redacted and capped), it sits after the skills and before the date line, the date is pinned for the run,
  the block's hash is part of the cache keys, and each agent has a `projectContext` switch. The test chat takes
  `projectId`. Teams and workflows can name a goal (`goalId`). `LANDFLOW_PROJECT_CONTEXT=off` turns it off
  ([agents.md](agents.md#project-context)). The remote paths (PC04) and usage attribution (PC05) were built in wave 7,
  the availability rule (PC06) and its screens (PC07) in wave 8.

## Paperclip wave 8: what the agent saw (PC08)

- **PC08, built:** each agent run writes `attrs.saw` once per run (the block as the model got it, mode, project and goal,
  pinned time, a persona summary, practice handles). Run Trace and the agent's Sessions tab show it as **What it saw**,
  and the run's root span shows Project and Goal chips. It follows **Content kept** (`summaries` cuts the text, `off`
  keeps none and says so). Closes D7 and P4-1 ([run-trace.md](run-trace.md#what-it-saw)). PR09's practices row sits in
  it (cited and check per practice for a run). Left: the session fold shows the persona as it is now, not as the run had it.
- **PC10, built (wave 8):** project repositories (`PATCH /api/projects/:id { repos }`, migration 2500), `GET
  /api/projects/context` by repository or id, the MCP `project_context` tool and `project://{id}/context` resource,
  "Your goals" in the morning briefing, and the project's compact block in Spotlight and the Agent architect (P5-1 to
  P5-3, D8). The mod and the CLI use the route (PC11, built). The screen for a project's repositories came in wave 9 (PC16;
  [projects-and-goals.md](projects-and-goals.md#repositories-and-harnesses)).

## Paperclip wave 8: goal pickers (PC12)

- **PC12, built:** a workflow's settings and a team's page have a goal field (empty: the project's goal), and the team's
  member picker lists the agents available in the team's project, keeping current members
  ([projects-and-goals.md](projects-and-goals.md#picking-a-goal-for-a-workflow-or-team)).

## Paperclip wave 9: project AI budget (PC14, server)

- **PC14, built (server):** a project's monthly AI budget as one more cap in the LiteLLM wave's system: listed on
  Insights → AI, watched by the cost alerts, raised through "Ask for more". It adds a warning, an optional hard stop
  that refuses only priced calls and asks a person, incidents and Needs you items, with resume, raise and dismiss
  ([projects-and-goals.md](projects-and-goals.md#ai-budget)). The screens are PC15's. Deferred: a LiteLLM team budget as
  a backstop (its 30-day window does not match the calendar month and it counts calls Landflow never stops), and
  per-goal budgets. Closes P6-2 (server).
- **PC15, built (screens):** the **AI budget** card in a project's Settings tab and the budget rows in Needs you (Home
  and the Runs page) with Resume, Raise, Dismiss and Open project ([run-trace.md](run-trace.md#needs-you-for-a-project-budget)).
- **Left:** Landledger's AI budget flow raises agents' caps only
  ([features/landledger.md](features/landledger.md#raise-or-hold-an-ai-budget)); a version for a project's budget is later.

## Paperclip wave 9: project settings for agents (PC13)

- **PC13, built (P6-1):** a project can name a default model, one knowledge base, the agents and the tool kinds allowed
  in it, and a run in the project obeys them; sessions are read and continued only from their own project
  ([projects-and-goals.md](projects-and-goals.md#project-settings-for-agents)). The settings card is PC15's. Left: a
  run-time wall for availability (decision 6 stands: the allow-list is the opt-in wall) and pre-filling a new agent's
  model from the project.
- **PC16, built (wave 9):** a project's **Workspace** card (Settings tab): repositories, a default branch and setup commands
  for each, a worktree per run or shared, a branch template; saved in `project_workspaces` (migration 2701), served by
  `GET/PUT /api/projects/:id/workspace`, `GET /api/projects/context` and the MCP `project_context` tool. Closes P6-3.
  Open: the harness plan's stage 2 using it ([projects-and-goals.md](projects-and-goals.md#workspace)).

## Paperclip wave 10: progress, tasks and export

- **PC17 and PC18, built:** goal progress (runs, spend and work updates per goal over 7 or 30 days, through the
  visibility rule for the person it is for) on the Goals page, the goal sheet and the project Overview, and "Goals that
  moved" in the nightly sync ([projects-and-goals.md](projects-and-goals.md#progress)). Closes P7-1.
- **PC19 and PC20, built:** project tasks with agent or person assignees, checkout, wake-ups that only ask, runs a person
  approves (through `runAgent` and the project's limits), the Tasks tab and Approve and Deny in Needs you
  ([projects-and-goals.md](projects-and-goals.md#tasks)). A task run counts toward goal progress only as spend, never as
  a run. Closes P7-2.
- **PC21, built:** a project exported as a Claude Code plugin with `PROJECT.md` and its home agents, without people or ids
  ([marketplace.md](marketplace.md#export-a-project)). Closes P7-3.
- **Left on purpose:** autonomous task runs, a progress history chart, and importing `PROJECT.md`
  ([limitations.md](limitations.md#project-tasks-wave-10)).

## Token spend wave 11

- **SP01, attribution on each call.** Each `ai_usage` row now has the node, span, purpose, iteration, caller agent,
  duration and stop reason (migration 2900); the AI metrics gain `cache_read`/`cache_write` token types and a purpose
  label; the `ai.call` event gains purpose, node, session, iteration and usage id; the engine's `aroundNode` hook tells
  the host the active node. Setting purposes at the call sites is SP02, prompt parts SP03 ([llm-gateway.md](llm-gateway.md#what-each-call-was-for)).
- **SP02, purpose at the call sites, built**: guardrail verdicts (chat model or judge), cache embeddings, the LLM reranker, evaluation judges and online
  grading, an evaluation run's calls, and summaries (run report, briefing, workflow descriptions, wiki pages) say why they
  are made (`guardrail`, `cache-embed`, `rerank`, `judge`, `eval`, `summary`). Jev and Strands judge calls are counted
  (unpriced). Cohere's reranker is not a token call and stays unmetered.
- **SP03, prompt parts, built**: each chat call Landflow builds a prompt for gets a split into parts (instructions, project block, practices, memory,
  tool notes, tool definitions, history, tool results, message, images) as an estimate, with keyed prompt, prefix and
  per-part hashes, kept 30 days; an agent session's usage keeps its cache numbers
  ([llm-gateway.md](llm-gateway.md#what-a-prompt-was-made-of)). Exact counts, the gateway's split and the screens come
  in wave 12.
- **SP04, telemetry out (with SP16), built**: the overview dashboard gains an "AI" row (tokens by type, Anthropic cache hit rate, cost by purpose) and
  `prometheus-rules.yml` the 14th alert, `LandflowAiCacheHitRateDropped` (volume-guarded, promtool-tested, and a full
  cache loss still fires). A test pins the `ai.call` event's keys that Landledger reads. SP16 (the cache alert and
  panels) is folded into SP04.
- **SP20, who sees spend, built**: every member sees every person's AI spend by name on the AI page, with the instance's total above the
  person list (`peopleTotals`; admins get the caption alone, and a person with no name is "Unnamed person" to a member);
  the rules are in [llm-gateway.md](llm-gateway.md#the-ai-page) "Who sees what".

## Token spend wave 12

- **Exact counts per part (SP22), built**: a call's split is counted with the provider's own count (Anthropic's count endpoint, as cumulative prefixes
  cached by a keyed hash and spent from a per-credential per-minute budget), OpenAI's encodings offline (`gpt-tokenizer`)
  or an Ollama model's own vocabulary (a byte-level BPE in TypeScript, `qwen2` and `llama-bpe`), and says which
  (`method`: `provider`, `tokenizer` or `estimate`). `formatting` is the reported input minus the counted parts. Two
  variables, `LANDFLOW_AI_PARTS_COUNT` and `LANDFLOW_AI_PARTS_COUNT_PER_MINUTE`. The BPE is tested against a shared
  fixture made with Hugging Face `tokenizers` (`apps/web/test/fixtures/bpe-fixture.json`, which SP21's Python counter
  also reads). Against Ollama 0.40.14 and `qwen3-coder:30b` the count of a 1,200-token text and of a mixed-script
  text with code matched `prompt_eval_count` minus the template to the token. The LLM gateway's
  `/v1/messages/count_tokens` answers, but with its own local estimate, so a call through it stays an estimate
  ([limitations.md](limitations.md)).
- **The gateway's split (SP21), built**: a LiteLLM callback (`deploy/llm-gateway/custom_callbacks.py`) counts the parts of each call kagent's agents and
  Claude Code make through the gateway with the model's own tokenizer and posts numbers and hashes to
  `POST /api/gateway-parts`, under the gateway's response id; the spend import pairs them. Off until both sides have the
  shared secret ([llm-gateway.md](llm-gateway.md#the-gateways-split)). Not built: a response id on the harness mod's step
  events (Claude Code gives a mod none).
- **Cache fixes (SP19), done:** the system prompt's cache point moved after the stable part (persona, skills, project block, practices); the
  memory, intro line and date line follow it; the conversation has a breakpoint; memory is read once per run. Measured on
  a fake Anthropic cache: see [agents.md](agents.md#prompt-cache). Still open: the AI Agent node asks for no cache, and no
  real Anthropic call has confirmed the hit rate.
- **A run's spend and one call's view (SP05), built**: `GET /api/executions/:id/spend` (totals, slices by purpose, model, node, agent and loop step, the prompt's
  composition, the cache line with its miss reasons and the saving, up to 500 calls) and `GET /api/ai-calls/:id` (one
  call, its split in tokens from Landflow or the gateway, what changed against the call before it, a link to its run).
  Both follow [llm-gateway.md](llm-gateway.md#the-ai-page) "Who sees what" (rule 3) and hold no prompt text
  ([run-trace.md](run-trace.md#spend)). The Run Trace opens them (SP06, SP07); the AI page's views of them are SP09 and SP10.
- **The run's Spend tab (SP06), built**: the Run Trace gains a **Spend** tab for a run with model tokens: totals, spend by purpose, model, node, agent and step,
  the cache line, the prompt's composition as one bar with the method named, and the calls list, refreshed every 10
  seconds while the run is live ([run-trace.md](run-trace.md#spend)). A call opens its model span.
- **One call's view (SP07), built:** a model step's sheet in the Run Trace shows the call's composition, cache line and what changed since the previous call; sessions show cached tokens ([run-trace.md](run-trace.md#one-call)).

## Token spend wave 13

- **The daily rollup and the AI page's report (SP08; plan items G6 and G7, and the `unpriced` part of G8; G9, one waste
  detector, is not touched), built**: `ai_usage_daily` (migration 2902, backfilled from the
  rows already there) is rewritten every 10 minutes for today, yesterday, any day a late import marked and every day
  since its last pass (so a host that was off for days loses nothing; a week of days at a time, the event loop free
  between steps); the AI page's `GET /api/insights/ai` answers 90 days and custom ranges of up to 400 days, ten groups
  (workflow, credential, surface and purpose are new), a daily series, a stack, the previous period with movers,
  filters, distinct runs and an `unpriced` flag on model rows, with people per D1
  ([llm-gateway.md](llm-gateway.md#the-ai-page)). Yesterday and today are read from the raw rows (always exact); the
  screens are SP10 to SP12. A model row's `unpricedCalls` counts a combination's calls when it has no price and no cost,
  so a gateway-costed call among unpriced ones of one model is not told apart.
- **Left open (SP08, SP09): distinct runs per group in SQL.** The report's `loadRuns` selects `DISTINCT run` plus the
  twelve key columns over the range from raw `ai_usage` (and again for the previous period), and the lists scan the raw
  rows, so a wide range of a busy instance moves many rows into JS. Counting distinct runs per group in SQL (or a
  run-day rollup) would do it in the database; not built.
- **The runs and calls behind a number (SP09), built**: `GET /api/insights/ai/runs` and `GET /api/insights/ai/calls`
  list what is behind one row of the AI page's report (a `group` and its `key`, over the report's period and filters),
  costliest or newest first, 50 a page with a cursor, or as a CSV (`format=csv`, at most 10,000 rows, never prompt
  text). They list only what the viewer may open (rule 3 of [llm-gateway.md](llm-gateway.md#the-ai-page) "Who sees
  what", run-spend.ts's own checks) and count the rest in `hidden` (runs, calls, cost; no names, no ids). The screens
  that use them are SP10's.
- **The AI page's trend, movers and drill-down (SP10), built:** the AI page gains 90 days and a custom range, ten groups
  in a menu, filters as chips in the URL, a cost-or-tokens trend with the period before as a faint line and a stack of
  any group's top 5, the biggest rises and falls, and a drill sheet from any row with the runs and calls behind it, "N
  runs you can't open: $X", one call's composition and CSV ([llm-gateway.md](llm-gateway.md#the-ai-page)). The AI page's
  wave 13 parts (trend, movers, drill sheet, forecast and cache cards, You card) are made for desktop; on a phone the
  page keeps its earlier row cards and never scrolls sideways.
- **The cache card and the forecast to month end (SP11), built**: the AI page gains a **Forecast to month end** card
  (the month's total as a range, "$410 to $520 by Nov 30", the most likely figure in words, "early" under 7 days of
  data, and each cap or budget the viewer may see with the day the P50 line reaches its limit or "stays under"; a daily
  cap shows today's pace) and a **Prompt cache** card (hit rate, dollars saved, misses, the five agents with the most
  uncached input with why they missed, and the AI Agent node's uncached calls). `forecastMonth`
  (`lib/shared/ai-forecast.ts`) is the one method; SP23 alerts on it and SP12's My AI spend takes it for its own caps.
  The forecast reads `ai_usage` by day through one function (`dayRows` in `lib/server/ai-usage/forecast.ts`), not the
  daily rollup (SP08): exact, and moving it onto the rollup is a speed change for when a month of rows gets slow. Live
  check: owner and member views on a seeded month, light and dark, desktop and phone; the seed had the same spend on
  each day (no spread), so the range form was covered by unit tests only. Misses are also counted in distinct runs ("in
  3 of 40 runs"), each call grouped by its own session, else execution.
- **Local models priced in Settings (SP12), built**: Settings → AI prices lists the local models seen in the last 30
  days (calls, tokens, "Not priced" or the price) with an inline "Set a price"; one `ollama/<model>` price covers
  Landflow's own `ollama` calls and the gateway's `ollama_chat` rows
  ([observability.md](observability.md#8-token-and-cost-tracking)). The AI page's You card gives everyone their own
  spend and caps, and its Model group says "Not priced" and can rank by tokens
  ([llm-gateway.md](llm-gateway.md#the-ai-page)). By decision D5 (2026-11-16) there is no "equivalent cost" for a local
  model: it costs $0 until someone prices it, and an unpriced one is ranked by tokens. Equivalent cost is dropped, not
  postponed. The You card's caps carry SP11's forecast (the forecast card's figure and words for the same cap, wired at
  integration). Follow-ups: the You card leaves out by purpose and by surface (the API returns them), and F's "by agent"
  and "most expensive runs" are not built.
- **Wave 13 join tests (integration), built**: `spend-local-price-join` (an imported `ollama_chat` row, a paired
  Landflow row and Landflow's own Ollama call, priced once in Settings: the report's model row, "Not priced", Local
  models, the You card and the rollup after a pass), `spend-forecast-join` (each own cap's figure and words equal on the
  forecast card and the You card, as the person and as an owner, for a set cap and everyone's default) and
  `spend-report-join` (for every group key and every filter a row can become, `none`, `provider/model` and
  `surface=none` included, the runs and calls lists count the calls, cost and runs the report counts, owner and members,
  24 hours, 7 and 30 days). The last found the lists reading `model=provider/model` and `surface=none` as literal values
  (nothing listed); they now take the report's filter forms.
- **Live checks (wave 13, run before the merge on b69627fe)**: a production-profile host (CSP enforced,
  `local-only.cjs`), headed Chrome at 1440×900 in light and dark, local Ollama `qwen3-coder:30b`, 100 days of made-up
  rows for an owner and two made-up members in two projects. 7, 30 and 90 days and a custom range with compare: series
  of 7, 30, 90 and 19 points, movers and the new groups; the 90-day report answered in 57 to 198 ms. The drill sheet's
  runs, calls, one call's composition, the run link to its Spend tab and Back; the CSV quotes a workflow name with a
  comma and quotes. Filters, `provider/model` and `surface=none` included, narrow the lists and the cache card. A member
  sees every person's spend by name and no closed workflow or agent; another project's runs show as "30 runs you can't
  open: $468.00". The You card's cap outlook equals the forecast card's. A price set in Settings priced the next real
  Ollama calls and left 229 earlier rows at $0. After 11 minutes the rollup held today and yesterday, and 30 days read
  458 calls and $832.50 on the page, in the raw rows and in the rollup alike. At 390 px nothing scrolls sideways. No
  request left the machine, no CSP report, no console error but the member's deliberate 404s. The fix passes after
  b69627fe (the rollup's dirty marks taken in each day's own transaction, the page's view helpers, the calls CSV's run
  link, the chain nodes' prompt split) are covered by tests and Opus's last review, not by the browser.

## Token spend wave 14

- **Waste detectors (SP13).** Six brain detectors find what the model was sent that it did not need: context bloat, fat tool results, unused tools, cache misses, repeated calls and agent loops ([second-brain.md](second-brain.md#4-detectors-and-suggestions)). The AI cost detector also judges an unpriced local model on tokens, naming a smaller local model of the same family seen on this instance. The brain's study no longer fails on a stale fact (`brain_facts.subject_type`).

- **Built (SP14)**: your own AI spend from a brain key. The MCP tool `my_ai_spend { period? }` (`brain:read`), `GET /api/brain/my-spend?period=`
  (`brain:read`; the same answer as `GET /api/insights/ai/me`, which stays `executions:read`) and `landflow spend [--period] [--json]`
  show today, this month, the period by model (and purpose over MCP) and your caps with their forecast or pace. Only your own rows and
  caps, an owner or admin included; other people's spend stays on the AI page. The wire is `lib/shared/my-spend-wire.ts` (the CLI keeps
  its own copy; the landflow-brain mod's status line, SP15, reads it). See [llm-gateway.md](llm-gateway.md#the-ai-page).

- **SP15, today's spend in your own Claude Code (landflow-brain 0.5.0).** The mod's status line adds today's own spend
  from `GET /api/brain/my-spend?period=24h` (SP14's route), with the option `showSpend`. Tests: `claude-brain-mod.test.ts`
  and `hooks/register.test.ts`. Left: the live check in a real Claude Code session.

- **Forecast and unusual-spend alerts (SP23, decision D6), built**: a leader service (**AI spend flags**, every 10
  minutes) writes `ai_spend_flags` (migration 2904): Landledger's check (median and MAD in millionths, score 3.5, half the
  median, 7 observed days) for each person, agent, workflow, project and model on today and yesterday, tokens for a key
  with no cost, and a flag for each monthly cap whose forecast reaches it. The AI cost rule's channels get "forecast over
  the cap" once per cap and month and "unusual spend" once per dimension, key and day (again at twice the value), with
  an **Open** link to the AI page at the day; Needs you gets kind **AI spend** with **Acknowledge**
  (`POST /api/insights/ai/flags/:id/ack`); the brain gets the detector **Unusual AI spend** for agents and workflows,
  naming no person; **Landledger alerts on agent and model spikes** keeps those two from going out twice
  ([llm-gateway.md](llm-gateway.md#forecasts-and-unusual-spend)).
- **Left open (SP23)**: an anomaly view on the AI page, a Landledger trigger event for `cost.anomaly`, reading Landledger's
  own flags, a weekday-aware baseline and a way to mute one key.
- **Still owed from wave 13 (SP11's live pass)**: the cache card on real Anthropic cache reads and a daily cap's pace line
  late in the day. The first needs a vendor key (live checks never send off this machine); the second a live host late
  in its day. Both stay owed, not dropped.
- **Wave 14 join tests (integration), built**: `spend-alert-forecast-join` (a month through the real meter, one rollup
  pass, one flags pass and one alert tick to a local webhook catcher: one forecast notice per cap over, none for the cap
  under or an early one; the notice's, Needs you's, the forecast card's and the You card's P50 and date equal
  `capForecaster`'s to the cent; each person's Needs you, a second tick, Acknowledge), `spend-anomaly-join` (each flag's
  value, baseline median and runs equal the AI page's report for that day and key, through the flag's own Open link;
  the inbox names no person; the Landledger option sends only the person's and workflow's notices),
  `spend-detectors-join` (a real agent loop on a fake model, Spotlight calls with a `workflowId`, a flow on a large local
  model: SP13's detectors on what the meter and the parts listener recorded, the local `aiCost` on the rollup's token
  sums, SP13's and SP23's detectors in one `runBrain('all')` past a stale fact, no prompt word stored),
  `spend-mcp-you-join` (`my_ai_spend` over `POST /api/mcp`, `GET /api/brain/my-spend` with the same key and the You card
  are equal for an owner and a member in every period; the instance token is refused) and `spend-status-line-join` (the
  mod's `getMySpend` and `statusLine` against the real route through the real guard). The detectors join found that
  `repeated-calls` could not see a Landflow agent's own repeats (fixed in the fix pass below).
- **Fixed (join tests)**: `repeated-calls` could not judge an agent, because its system prompt ends with the time to the
  millisecond and `promptHash` covered it. `promptHash` now leaves the `formatting` segments out (the gateway's callback
  too); the date stays in `prefixHash`.

## Token spend (waves 11–14): where it stands

The program that made every model call visible, attributable and forecastable, closed on 2026-11-17 (SP17). The per-wave
sections above stay and are linked from here; what the program cannot do yet is gathered in
[limitations.md](limitations.md#token-spend-what-it-cannot-do-yet). Who sees spend follows
[llm-gateway.md](llm-gateway.md#the-ai-page) "Who sees what" (D1).

**What each package built** (one line each; the section has the detail):

- Wave 11 ([section](#token-spend-wave-11)): **SP01** attribution on each call (node, span, purpose, iteration, caller,
  duration, stop reason); **SP02** purposes at the call sites; **SP03** the prompt split into parts with keyed hashes;
  **SP04** telemetry out (the AI row on the overview dashboard, the cache hit-rate alert; **SP16** is folded into it);
  **SP20** everyone sees everyone's spend by name.
- Wave 12 ([section](#token-spend-wave-12)): **SP05** a run's spend and one call's view over HTTP; **SP06** the Run
  Trace's Spend tab; **SP07** one call's sheet; **SP19** cache fixes (memory out of the cached prompt, a history
  breakpoint); **SP21** the gateway's split of kagent and Claude Code calls; **SP22** exact counts per part (the
  provider's, OpenAI's encodings, an Ollama model's own vocabulary).
- Wave 13 ([section](#token-spend-wave-13)): **SP08** the daily rollup and the AI page's report; **SP09** the runs and
  calls behind a number; **SP10** trend, movers, ten groups and the drill sheet; **SP11** the cache card and the
  forecast to month end; **SP12** local model prices and the You card.
- Wave 14 ([section](#token-spend-wave-14)): **SP13** the six waste detectors; **SP14** your own spend over MCP, the
  route and `landflow spend`; **SP15** today's spend in the landflow-brain status line; **SP23** forecast and
  unusual-spend alerts; **SP17** this close-out (docs, the map, the owed live checks).

**Decisions** (the user's, `spend/decisions.md`, 2026-11-15; D5 was applied when SP12 dropped the equivalent cost,
2026-11-16): **D1** every member sees every person's spend by name, never run contents; **D2** split kagent and harness
calls at the gateway, as exact as the model's own tokenizer allows; **D3** drill down to one call; **D4** per-call splits
and hashes 30 days, daily rollups 400; **D5** real prices per local model, no "equivalent cost"; **D6** forecasts and
anomalies in Landflow too, never double-alerting through Landledger without saying so; **D7** Claude Code per person is
later (SP18); **D8** cache blind spots fixed now (SP19).

**Live checks closed by SP17 (2026-11-17, on `29ef4cb0`)**: a production-profile host (CSP enforced,
`local-only.cjs`, `LANDFLOW_OUTBOUND_ALLOW=127.0.0.1`), headed Chrome at 1440×900 in light and dark, local Ollama
`qwen3-coder:30b`, made-up people (an owner and a member with a role in one of two projects). No request left the
machine (`local-only] refused` 0 in every log, no aborted browser request); the only console errors are 404s for a run
page that does not exist (an agent session's id, below).

  - **Real LiteLLM import (done, on the development profile).** The production profile refuses the gateway's development
    key at boot ("LANDFLOW_LLM_GATEWAY_ADMIN_KEY is a development value"), so the import was run on a second host on the
    development profile against the running `landflow-infra` gateway (`127.0.0.1:54100`, development key from
    `deploy/.env.example`), on a copy of the seed data with the import's last-run mark set to 2026-11-15 05:00Z
    (otherwise the first run reads only the last 24 hours). It imported 51 rows (40 of 2026-11-15, 11 of 2026-11-16),
    every one with `gateway_provider = 'ollama_chat'`. Three fresh calls of `qwen3-coder:30b` through the gateway then
    imported with that provider too. A local price (0.30 in, 0.90 out per million, Settings → AI prices, which listed the
    model under Local models with providers `ollama` and `ollama_chat`) priced the next import: 26 in and 4 out became
    $0.0000114, `gateway_cost` 0. Rows imported before the price kept their cost (no repricing). The import of
    2026-11-15 (a day before yesterday) left `ai_usage_daily` without that day and a dirty mark `["2026-11-15"]`; the next
    rollup pass wrote it (40 calls, $0.084, 515 input tokens, equal to the raw rows) and cleared the mark.
  - **The gateway's split (not possible without the person).** The callback (`custom_callbacks.py`) is mounted and
    configured, but the container's `LANDFLOW_PARTS_SECRET` is empty (the gateway was created without
    `LANDFLOW_LLM_GATEWAY_PARTS_SECRET` set), so it posts nothing: a listener on the port the callback targets saw no post
    for three calls. A `gateway`, `tokenizer` split with the spend log's `request_id` still needs the container recreated
    with the secret set on both sides, which is the person's call; not done.
  - **Ask the brain and the AI Agent node write `ai_call_parts` (done).** The Brain page's streamed form: surface `brain`,
    purpose `answer`, source `landflow`, method `tokenizer`, parts instructions 21, user message 338, formatting 13. An AI
    Agent node on Ollama: purpose `answer`, `tokenizer`, 26 input tokens. The JSON form of `POST /api/brain/ask` wrote a
    usage row with no purpose and no split (found; listed under what is left). A Landflow agent's test-chat session also
    wrote its row (`tokenizer`).
  - **The Spend tab for a member with a hidden sub-run (done).** A workflow in one project ran a sub-workflow of a project
    the member cannot open, with three Ollama calls in all. The owner's tab: 3 calls, 92 in, 1,442 out. The member's:
    2 calls, 61 in, 962 out, "1 run you can't open: 31 in · 480 out", the hidden call in neither the table nor the list.
    Light and dark. At 390 px the page's `scrollWidth` is 390.
  - **A live run's numbers moving (done).** Sampled every 3 seconds on `GET /api/executions/:id/spend` while the run was
    live: 0, 1, 1, 2, 2 and 3 calls (539, 1,050 and 1,534 tokens); the open tab went 1 call, 2 calls and 3 calls with the
    10-second refresh.
  - **"Counted with the model's own tokenizer" (done).** On the Spend tab of an AI Agent node run on Ollama and of the
    three-call run above, in light and dark. A Landflow agent's test chat has no Run Trace page (`/runs/<session id>` is a
    404), so the phrase was not seen for one.
  - **Still owed, needing a vendor key**: the cache card and the cache fixes on real Anthropic cache reads, and a daily
    cap's pace line late in a host's day. Evidence: `backbone/live/SP17/` (the host logs, `c1`–`c4` scripts and logs)
    and `backbone/shots/SP17/` in the session's scratchpad.

**What is left:**

- **SP18, one gateway key per person** (D7: later). Today a person's Claude Code calls through the gateway cannot be told
  from the instance's other calls.
- **Caching for the AI Agent node**: it asks for no cache; the cache fixes covered Landflow agents.
- **Distinct runs per group in SQL**, or a run-day rollup (open since wave 13; [above](#token-spend-wave-13)).
- **Deferred from the wave 14 carryover**, each with its reason: a `knowledge` part (the knowledge tool would have to mark
  its results); a per-model cache minimum (`MIN_CACHEABLE_TOKENS` is 1,024 for all; waits for a model that needs more); the
  previous-period request sent once more after a filter change (one wasted request, no wrong number); Run an Agent's
  calls have no model span (a Run Trace change of its own); which split wins for a Landflow call on a gateway
  credential; sharing an in-flight Anthropic count between two callers; long unwrapped doc lines (no formatter; a change
  rewraps its own lines); the cache alert's baseline that includes the dropped period; the anomaly view, a `cost.anomaly`
  Landledger event, a weekday-aware baseline and muting one key ([SP23](#token-spend-wave-14)).
- **Ask the brain's JSON form** (`POST /api/brain/ask` without `Accept: text/event-stream`) writes no purpose and no
  prompt split, where the streamed form the Brain page uses does (seen on the live host, 2026-11-17). Not a package yet.
- **Left from the last pass of wave 14**: the `promptHash` comment ("of the whole prompt") in the s11 contract copies
  (`apps/web/src/lib/shared/ai-call-parts.ts` line 76 is byte-identical to the contract, so the two change together later:
  it should say the date stamp is left out); the spend-anomaly backtests read today's acknowledgement state, not the state
  at the day judged. Three findings from the live checks: the AI page's Gateway card says "No models listed" while the
  gateway is healthy and serving models (`llm-gateway/status.ts` turns a failed `client.models()` into an empty list with
  no word, so the cause is not visible; it needs a look at the live call before a fix); `POST /api/workflows` ignores a
  `projectId` in the body (only `?projectId=` puts the flow in a project; what wins when both are given is a decision, so
  not a one-line fix). The JSON form of Ask the brain is the item above and in the limitations.
- **Still owed, needing a vendor key (live checks never use one)**: the cache card and SP19's cache fixes on real
  Anthropic cache reads; a daily cap's pace line late in a host's day; a real Claude Code session with the landflow-brain
  status line (SP15 left it: a session would call a vendor).
- **Owed with the gateway's secret**: the gateway's split on a live call (`gateway`, `tokenizer`, the spend log's
  `request_id`): the local gateway's callback is mounted but its `LANDFLOW_PARTS_SECRET` is empty, so it posts nothing;
  recreating the container with the secret is the person's call.

## Practices (waves P1 and P2)

Rules in the brain that connected agents follow, each approved by a person ([practices.md](practices.md)). Decided
2026-11-15: org practices are approved by instance owners and admins, project practices by that project's admins; no
four-eyes; agents may draft, as tainted drafts; `required` blocks only in flows; no practices ship in code.

- **PR01, built (wave P1):** the store, versions and the hash, approval with taint and conflicts, reject, retire and
  waivers, the `/api/practices` routes, `LANDFLOW_PRACTICES` and the port other packages read.
- **PR02 to PR05 (wave P1):** the Brain page, learning (Draft Practice, the Learn practices template, `/brain learn`),
  selection and the block, MCP tools, the mod and `landflow practices`.
- **PR08, built (wave P2):** `ApplicablePractice` names the practice id and project id, `GET /api/practices/resolve` takes `id`, and `landflow practices check` reads each listed practice by it; the Check Practices step (a failed required check fails the step until fixed or waived), the pull request and blocked templates, and `/practices/waive`.
- **PR09, built (wave P2):** compliance (how often a practice was given, cited, passed and waived, and who follows it; the run's practices row), the practice-drift detector, and an inbox suggestion for every draft, applied by owners and admins only and never for a draft read from outside ([practices.md](practices.md#compliance)). Left: citation drift.
- **PR06 and PR07, built (wave P2):** delivery to Landflow agents through the seam's practices slot, with `delivered` and
  `cited` rows and the agent's Practices switch (PR06), and to kagent agents: the index, `practices_for` and
  `practice_cite` on the agent's MCP server (PR07) ([practices.md](practices.md#following)).
- **Next:** the demo on a branch of the Landflow repository that ends at a draft pull request (PR10).

## Practices in Claude Code and the shell (PR05, wave P1)

- **Built**: the landflow-brain mod 0.3.0 adds a practices section (`landflow-brain:practices`) inside the 2-second bound, the `practices` and `practice_draft` tools, `/brain practices` and `/brain learn [paths]`; the CLI adds `landflow practices list|show|check|learn`, with the machine checks run locally ([landflow-brain-mod.md](landflow-brain-mod.md#practices), [features/cli.md](features/cli.md#practices-landflow-practices)). Closes PRAC-5.
- **Left (deferred)**: model verdicts in the CLI's `check` (a model's verdict reaches a flow through Check Practices, PR08;
  the CLI runs machine checks only) and a reminder after `Write` or `Edit` on a matching path (the mod never denies a
  tool call, so a reminder hook is its own package).

## Spotlight wave sb1

- **SB00, the scenario suite, built:** the evaluation's builds, one-step fixes and agent asks are scenarios in the
  repo (`apps/web/test/spotlight-scenarios/sb00.ts`), each with a scripted form that always runs and a live form on
  the local model (`LANDFLOW_INTEGRATION=spotlight`) that prints the Build, Fix one step and Agents scorecards and
  writes them as JSON, so a package's fix has a before and an after
  ([development.md](development.md#spotlight-scorecard)). A guard, `local-only.cjs`, makes any connection to anything
  but this machine fail, for the suite and for a live host (`NODE_OPTIONS`). Not built: the browser scorecard (each
  package checks its own screens) and the agents' guardrails, eval cases and test-run columns of the evaluation (the
  scenario outcome carries no such fields yet).
- **SB01, the first draft fills its collections, built:** the first draft asks Ollama for `format: "json"` with the
  schema in the system prompt (a schema-held reply left every list empty: 9 of 9 drafts), parses the reply with a
  schema (one send-back, then the error), checks the draft for empty lists (`emptyParts`) and sends it back once with
  a line for each, keeps what is still empty as `FlowDraft.left`, maps a near-miss step type to the one it can mean,
  and pins test items on an app trigger or on the app step that reads data after a schedule. Not built: the staged
  build (wave sb3).
- **SB02, the first draft is guarded, built:** a first draft is guarded as the chat guards a proposal: made-up
  channels, tables, owners, addresses, ids and URL hosts are cleared and listed, one trigger, no empty Set,
  credentials listed, and the build applies the workflow's allowed node types ([The empty
  canvas](assistant.md#spotlight)). The chat's made-up values guard widened to destinations and URL hosts. Left: the
  credential picker (SB12) and the full build summary (SB15).
- **SB03, a test session cannot wreck a flow, built:** a run blocked by the host's outbound policy is **Needs you**
  (no fix); the yes to sending is per destination and asked before every run (**Run it for real**, **Undo that
  change**); a fix may not remove a step the person asked for or change a value they gave (client and chat route); a
  pass after a fix is reviewed again before **Ready for production**, and not at all after steps were removed;
  asks-first workflows, and a new draft's fixes that remove a step, wait for **Apply**
  ([assistant.md](assistant.md#test-and-fix)).
- **SB04, a question is answered and autonomy only on a brand-new draft, built (2026-11-16):** Finding 2.1 (4 of 4
  "why did the last run fail?" changed the flow) and decision D1: `askKind` decides question or change once, the chat
  offers no `propose_changes` for a question and the editor applies nothing for it, with a **Fix it** bubble after the
  answer; Spotlight acts alone only while it builds a brand-new draft (`spotlight-autonomy.ts`), a saved or published
  workflow shows the card and waits for Apply, and a removal waits for a click even on a new draft (finding 3.4's own
  confirm). Docs: [assistant.md](assistant.md#autonomous-mode). Left: the scope of a change and `ask_user` (sb2), a
  real diff on the card (sb2).
- **SB05, a new agent survives a send-back, built:** Spotlight's `newAgent` keeps its name unrecorded until its
  proposal is held, so a proposal sent back to be completed is no longer dropped as a stand-in of itself (findings
  3.2); it carries `tools` and `knowledge` to the Agent architect; "after <step>" places it after the step (3.5); an
  Ollama tool-call parse error is retried once (3.9). Wave sb3 SB16 builds on these hints.
- **SB06, the Agent architect on a local model, built:** the dialog offers the flat `propose_design` (with the persona
  fields as plain strings) on an Ollama model, and a parse error is retried with it
  ([agents.md](agents.md#agent-architect)).
- **Live checks (run before the merge, production profile, Ollama qwen3-coder:30b, headed Chrome, under
  `local-only.cjs`, nothing refused):** the httpbin incident replayed: without `LANDFLOW_OUTBOUND_ALLOW` the test stops
  at "Needs you · This host blocks …", both HTTP steps keep their local addresses, nothing is sent and there is no
  "Ready for production"; with the allow list a saved flow asks first, a fix waits as a card and Apply runs again (1500
  to /vip, 500 to /standard). "Why did the last run fail?" is answered with no change and a Fix it bubble 3 of 3. First
  drafts fill their collections 3 of 3 for every build (the evaluation had 0 of 9), B4 runs right 3 of 3, and the
  Linear/Slack draft clears the made-up channel and lists it with both credentials. The Agent architect drafts 6 of 6
  on the local model (0 of 7 before). Left for wave sb2: a new agent's placement and tools (placed right 1 of 3, the
  Linear tool kept 0 of 3), the 401 fix touching only the asked step (1 of 3 on the scorecard), a suggestion chip that
  offers an outside address after a host block, the live form of the session scenarios, and "Test and fix" after a
  reload.
- **Owed to a person:** the asks-first wording and the **Needs you** rows on a real phone, and whether "saved" should
  end autonomy at the first autosave rather than at the next open (decision D1 reads it at the next open).

## Spotlight wave sb2

- **SB07, scope lock, built:** a request about one step carries a scope (the selected step, steps tagged with @, steps named with "only", or the step a new one goes after or before); the composer shows it as a chip (**Only “X”**, **New step after “X”**) whose × lifts it, the prompt says it, and `propose_changes` sends a change outside it back once and then leaves it out and lists it (finding 2.4; carryover item 3's "only the asked node" and item 2's placement half). Docs: [assistant.md](assistant.md#the-builder-chat). Left: asking "which step?" (SB11), what the model reads about the scope's steps (SB10).
- **SB09, changes that mean what they say, built (2026-11-16):** "retry 3 times" sets `retryOnFail` with `maxTries`
  (the engine read the tries only with it: 0 of 3 right in sb1), settings are checked for range, an expression that
  reads a field the step's input has no sample, pin or schema for is sent back once with the fields it has, a schedule
  must parse and name the days the request named, an Authorization header read from the data is sent back, and a
  credential with a hand-written header is a caution. After a run the host blocked, Spotlight makes no model call and
  offers no suggestion, and a suggestion that moves a step's destination is advice with no chip
  ([assistant.md](assistant.md#after-run-suggestions)). Left: the credential picker (SB12), asking which step (SB11).
- **SB10, the model sees what it edits, and the scorecard reads what happened, built:** the chat's model gets the whole
  parameters, the settings and the credential state (names only) of the selected step and of every step in the change's
  scope, and the outline gives those steps 2 000 characters (finding 2.8: a long Code step lost its tail); it is offered
  `setWorkflowSettings` (a settings-only proposal is no longer read as "already there"); a node's docs list the output
  fields of the operation its parameters select, and Linear issue create, add link and comment create, Slack send,
  update and get permalink, and GitHub pull request and issue writes declare an `outputSchema` (finding 1.4). The
  scorecard: a blocked scenario's live run is blocked (`start.outbound`, the policy set outright), SB03's flows hit the echo server and a session's "changed nothing" ignores refused or waiting cards, builds' "credentials named", "said what is
  left" and "sent back once" read the draft (`draft.left`, `draft.calls`), and the outcome names the model. Docs:
  [assistant.md](assistant.md#the-builder-chat). Left: the live scorecard's before and after side by side (the run is slow; its numbers go with the merge report), and the schemas of the
  rest of GitHub, Slack and Linear.
- **SB08, a real diff before Apply, built (2026-11-16):** finding 2.3 (the card printed the new value cut at 64 characters): the waiting card, the proposal row and the after-run suggestion show per step each parameter, setting, credential and wire old → new, long text behind **Show all**, and "N other steps untouched" (`diffOps`, `change-diff.tsx`). Docs: [assistant.md](assistant.md#fold-apply-and-errors).
- **SB11, Spotlight asks when it is not clear, built:** finding 2.5 and the "retry 3 times" with nothing selected: an
  `ask_user` tool (one question, 2 to 4 choices as chips, *or type your own answer*) for several steps that fit or a
  channel, table or id that is missing; asking never needs the switch (decision D1), is not offered in a test session,
  ends the reply with no further model call, and a backstop sends back a change to one of several steps of a kind with
  none named or selected (a settings change fits every step that calls out). Live on the local model: "it should retry 3
  times" asks which step 3 of 3 (0 of 3 before). Docs: [assistant.md](assistant.md#the-builder-chat). A made-up destination in a typed proposal is also sent back once to ask: the destination parameters `channel`, `table`, `to`, `cc`, `email`, `owner`, `repo`, `repository`, `team`, `project`, `board` and `sheet`, and the destination ids `channelId`, `dataTableId` and the like (`sheetId`, `boardId`, `projectId`, `teamId`, `chatId`, `repoId`: a key of the form channel, table, dataTable, sheet, board, project, team, chat or repo followed by `Id` or `Ids`; Slack's channel and a Data Table's table are these)
  (not a plain id, not a URL host, not in a test session). Left: "post the summary to Slack" with no channel asked first 1 of 3
  live (qwen3-coder:30b) before the send-back covered `channelId`: the live scorecard does register `messaging.slack` (`prepareLive`), and its
  `channelId` was an id the guard cleared and listed, not a destination it sent back; re-run live (3 runs) after this fix, so open. The chips are not kept in a stored conversation.
- **SB12, never empty, never a false claim, credentials offered, built:** a reply that the guards left empty says one
  line (*The card shows the change.* or *Nothing changed, because …*), a change claimed with no card is sent back once
  (`claimsAChange`), and a step that needs a credential gets a **Needs you** row with the credentials you may use, **Use
  it** and **Create one**, with nothing picked by Spotlight (decision D2; the `credential` chat event). Docs:
  [assistant.md](assistant.md#the-builder-chat).
- **SB19, the model Spotlight uses, built:** a default in Settings → AI → Spotlight, a per-tab pick in the panel's desktop header, only models the server is configured for (Ollama, the gateway, the server's own keys), local the default. Every Spotlight call counts under token spend, the first draft and the after-run suggestion included (the draft used a bare `fetch` to Ollama and wrote nothing). The chat, build, design, agent and suggest routes refuse an unlisted model with 400. Docs: [assistant.md](assistant.md#the-model-spotlight-uses). Left: a per-person default; a picker on a phone.
- **Live checks (wave sb2, run before the merge on a4e2899d)**: a production-profile host (CSP enforced, `local-only.cjs`),
  headed Chrome at 1440×900, local Ollama `qwen3-coder:30b`, an echo server for every address. The scorecard, 3 runs for
  the scenarios this wave owns or moved and 1 for the rest, against sb1's record and the base read with sb2's readings:
  the 401 fix with the step selected right 3 of 3 (sb1 1 of 3), autonomous 3 of 3 (0 of 3), the vague retry 3 of 3 (0 of
  3, it now asks); every SB07, SB09, SB11, SB12 and SB19 scenario's own checks 3 of 3; SB03's blocked and no-change
  readings 3 of 3 once the harness read what happened (SB10). In the browser: the chip "Only “Open status incident”", a
  card touching only that step, the diff open and the credential row with nothing chosen, 3 of 3 each; picking a made-up
  "Echo token", Apply and run reached the echo server with auth, and Undo took it back. "It should retry 3 times" with
  two HTTP steps asked which step 3 of 3, and the chip's answer changed only that step. With the host blocking local
  addresses, the run was blocked 3 of 3 with no suggestion and no change; sb1's incident replay stopped at "Needs you ·
  This host blocks …" with both HTTP steps intact and nothing sent. "Send the whole order" gave a card 3 of 3. Picking
  `litellm/qwen3-coder:30b` (the local gateway to Ollama) named it in the reply and showed under Spotlight on the AI page;
  a reload went back to the default; a first draft is now counted. Every Spotlight and architect call had its
  `ai_call_parts` row. No request left the machine. The gateway pick ran on the development profile, since the production
  profile refuses the gateway's development key. The two fix rounds after a4e2899d (neighbour wording, the failed answer,
  the models cache, the focus budget) are covered by tests and Opus's last review, not the browser.
- **Left after sb2's live checks (for sb3):** the retry backoff fix (0 of 3 in every column), "every morning" (1 of 3), a
  one-line change in long code (0 of 3), asking for a Slack channel live (0 of 3, not re-run since the `channelId`
  send-back), sb03's new-destination row (0 of 3, also on the base); a 401 fix once proposed
  `Authorization: Bearer {{ $cred('my-api-key') }}`, a credential name nobody has, which the made-up value check does
  not catch yet (**both fixed in the sb3 integration**: `retryProblems` sends back a retry without the asked
  `retryBackoff: "exponential"`, `authHeaderProblems` a token header with a `$` name expressions do not have; the live
  re-runs are the sb3 live pass's); one click on a credential row's radio did nothing before Apply (the label works; unconfirmed). The
  phone Execute/Debug pill overlap is the same on main (a phone follow-up). Not Spotlight: after runs the host logged
  "the brain's run failed: NOT NULL constraint failed: brain_facts.subject_type" 6 times. **Fixed in wave 14 (SP13):** `staleFactsBefore` writes the whole row, so the study finishes, is stamped, and the detectors run on the brain's own loop.

## Spotlight wave sb3
- **SB13, plan first** ([assistant.md](assistant.md#building-a-flow-in-stages)): the first draft on an empty canvas is planned before it is built. The catalog is searched for the ask's words (at most 24 candidate types, one line each, no properties), the model answers a plan of steps (one node type each, what it assumed, what no node here can do), the plan is checked, sent back once and repaired in code, and shown as a plan card that waits for **Build it** in asks-first (autonomous on a brand-new draft builds at once). The build is sent only the plan's types' docs, and every model call's prompt size is recorded (`draft.stages`). Live quality left open (for SB14 and the integrator): the cannot-do ask passes its own check 1 of 3, the chat-support plan has the right types 2 of 3, and the Linear numbers were measured on code a little older than the last build-stage prompt. The interim plan-constrained build sends the plan's lines only (`from`, `output` and `attach` are not sent, so a removed step's rewiring and an If's outputs are honoured when SB14 wires in code), and `askModel`'s note gained a `system` field. A step the card's menu offers is never a sub-node for a main step. Left for the next packages: the parameters step by step (SB14), the summary after the build (SB15); the editor's build route still takes no plan from other callers (the brain's writer), which build in one call.
- **SB14, build in stages: parameters and wiring (built 2026-11-17):** given a plan, the first draft is one node per step wired exactly as the plan (`planEdges`, no model call draws a connection) and one small call per step: that node's docs only, the fields the step before really writes (its output schema, the trigger's test items, a schedule's `firedAt`), the reply checked (empty If, Set, Switch and schedule lists, option values, expressions against what the step receives, a schedule's days) and sent back once to that step alone. Closes the first-draft side of findings 1.1, 1.4 and 1.6 and the sb1 leftover (`$json.lastRun`, `$json.issues`, "every morning" read as weekdays). Plan first is now the default and the scripts are migrated (the integrator, wave sb3); the one-shot draft stays behind `staged: false`. Left: the limits in `limitations.md` ("What the per-step check does not see").
- **SB15, the build summary, built (2026-11-17):** a first draft's reply is one sentence and a card: the steps in words (the plan's lines, else one per node), what was assumed, what is left as buttons (**Open “If”** for an empty or made-up item, **Pick a Linear credential** for a credential item, which opens SB12's picker inline and never picks, decision D2) and what no node here can do; a row reads done from the canvas. The build route adds `summary` to the draft after the guards. Scenarios `sb15-linear-summary` and `sb15-nothing-left`.
- **SB17, an agent brief worth publishing** (closes sb1's finding 3.6 and the sb1 and sb2 leftovers above on the architect's tool choice, the dialog reopening the previous conversation and, for the architect's half, a new agent's tools and knowledge): the Agent architect's drafts, and Spotlight's design, are made to a brief in code: instructions in four parts (Input, Steps, Output, Hand over when), the approved practices and the Check Practices tool when the request asks for "our practices", only the tools the request names or its job needs (a Slack tool or an agent delegation nobody asked for is left out, with its reason), approval on every write, guardrail defaults (secrets masked in messages, instructions in tool results ignored) and 3 to 5 test cases that reach the eval gate on Create. The dialog starts fresh, with the last design offered as "Earlier: … · Continue". Not judged: whether a case is a good one; the practice and write words are English ([limitations.md](limitations.md)). See [agents.md](agents.md#agent-architect).
- **SB16, agents from Spotlight, anywhere, built:** "create an agent …" is recognised on any canvas (`agentAsk`) and designed as an agent card to review and create (the design route's `preview` form saves nothing; Create imports a draft and its test cases); on an empty canvas it also lays out Chat message → Run an Agent with a pinned sample, one ⌘Z (finding 3.3, decision D5; a brand-new draft in autonomous mode creates alone, D1); the chat's new agent keeps the tools and knowledge the message asked for (sb1's leftover). Docs: [assistant.md](assistant.md#agents-and-teams). Left: the brief's tools, guardrails, practices and cases (SB17), the smoke test and publishing (SB18).
- **SB18, test before publish (D3):** an agent Spotlight makes is run once on the item that reaches its step
  (`POST /api/agents/:id/smoke-test`) and published only after a pass, by itself only on a brand-new draft and through the
  eval gate; asks-first offers **Publish** on the row after the pass; **Undo** removes an agent nothing else uses
  (`DELETE /api/agents/design`). The test session's leftovers: **Run it for real** goes on with the same session (its
  fixes are not reset), a review's "no" names what is missing (or reads as a pass), a yes is per `scheme://host:port`, a
  "Publish … first" at an agent Spotlight made is not a fix round, and a pending **Run it for real** row survives a
  reload. Left: the smoke test is one item, not the eval gate (SB17's cases are what the gate runs).
- **Left in `agentUsedBy` (older than sb3, noted at its re-review):** Undo of an agent the starter flow made checks the
  workflows' published versions and the open ⌘Z steps, but not a scheduled publish or a pending four-eyes publish request
  whose version contains the step (it would run or be approved against an agent Undo has removed), nor another agent that
  delegates to this one (its delegation list still names it). Both are older gaps in the same check and are not fixed here.

## Spotlight wave sb3: the live pass on Claude (partly read)

Run on the integrated head (`9d247d44`) on the production profile (`next build`, `next start`, port 3258), on Claude: the
host with `LANDFLOW_BUILDER_MODEL=anthropic/claude-sonnet-5-5` (the default the design path uses too: an agent Spotlight
designs takes the model the picker names, else this default), the key read from the environment of the host and the
runner only. Ollama was stopped by decision, so this pass is not like for like with sb2's numbers (all on
`qwen3-coder:30b`). The local-only guard was a scratch copy that lets `api.anthropic.com:443` through and nothing else:
**0 refused** in the host, the three plugins and every runner, **0 aborted** in the browser (every Anthropic call was the
host's or the runner's). The scorecard was run in-process (`LANDFLOW_INTEGRATION=spotlight`, the model named
`anthropic/claude-sonnet-5-5`) from a scratch copy of the runner that skips its Ollama check; the repo's runner still
requires Ollama (see "Left").

**The pass stopped early.** At about 07:38 local time the Anthropic account answered every call with 400 "You have reached
your specified API usage limits. You will regain access on 2026-12-01", a limit on the key's organisation, not a Landflow
cap. Nothing was retried or routed elsewhere (no Ollama, no other key). What was read before it, and what was not:

| §4 item | State | k of n |
|---|---|---|
| 1. Scorecard, build and fix rows (sb2 as recorded, one-shot path on the sb3 head, sb3) | read for 18 scenarios; the sb3 owners' own scenarios from `sb13-chat-plan` on and `sb03` on are not read (the runs after the limit are API errors, not readings) | table below |
| 2. B1 to B9 and the prompt budget | the three asks (B1 = B2, B4 = B5, B8 = B9) built 3 of 3 on both paths; B1 through the browser once, asks-first | see below |
| 3. Leftovers (retry backoff, `$cred` 401, "every morning", the Slack channel) | retry backoff read: right-change 2 of 3 (sb2: 0 of 3); the rest not read | `sb00-fix-retry-backoff` |
| 4. PR-review ask on an empty canvas | not read: the architect's call was refused, so the card was a fallback design (see below) | the card was asked 3 times, contents not valid |
| 5. D4, gateway to Ollama | not run: Ollama is stopped by the user's decision; D4 is unit-tested only | n/a |
| 6. The test session | not run | |
| 7. Spend rows | plan and node calls read (below); a design preview and a smoke test not run | |
| 8. Screenshots | desktop for B1's four steps and the three fallback cards; phone only the header (`phone-02-spotlight-header-phone.png`); the plan, summary and agent cards on the phone not taken | |

Evidence: `backbone/live/wave-sb3/` (`tables.md`, `scorecard-after-a.json`, `scorecard-after-b.json`,
`scorecard-oneshot.json`, `b1.json`, `b1-workflow.json`, `pr-cards.json`, `spend.json`) and `backbone/shots/wave-sb3/`.

**B1 in the browser, asks-first** (`b1-*.png`): the plan card in 5 s (7 steps, the assumptions, **Build it**); the canvas
stayed visible while it built (the folded card "Building 7 steps…" at the side); the build took 19 s; the summary card
named the steps, four assumptions (8:00 on weekdays, since the previous run, a generic AI Agent, the agent's fields) and
two "Left for you" items with **Pick a Linear API credential** and **Pick a Slack API credential**; clicking the first
opened the picker and no step had a credential until **Use it** (checked through the API). The saved flow had the
schedule `0 8 * * 1-5`, Linear reading since "" (empty, so listed), Slack text reading `$json.output` and no made-up
channel or table id. Two findings: the plan and the flow carry a seventh step **Unused (Data Table)** wired after the
table step, which `no-junk` did not flag in the scorecard (3 of 3 on `sb00-build-linear-bugs`); and my own script guard first refused the flow because a Linear sample item holds
`https://linear.app/acme/issue/ENG-482` in its pinned data: the guard now reads nodes' parameters and credentials, not
pinned data.

**Prompt sizes, B1** (the host's `ai_usage` rows, the provider's reported input tokens): plan 3,064; the eight node
calls 2,216, 3,271, 3,263, 1,796, 4,257, 2,610, 3,121 and 2,548. Largest 4,257, under 6,000; total 26,146 input and
2,159 output tokens, $0.0739 for 9 calls. The base's one prompt is not measured here (the one-shot runs' own usage went to
the runner's throw-away data directory); the evaluation measured 88k characters of catalog with these three plugins, about
22k tokens, so the staged build is about five times smaller at its largest call.

**The scorecard** (n = 3 unless shown; "one-shot" is `staged: false` on the sb3 head, not the base commit, because the
sb3 harness needs sb3's modules and cannot run on `d98d66e3` without changing it):

| scenario | check | sb2 (Ollama) | one-shot (Claude) | sb3 (Claude) |
|---|---|---|---|---|
| sb00-build-linear-bugs | all 8 checks | 1/1 | 3/3 | 3/3 |
| sb00-build-webhook-branch | all but `runs-right` | 1/1 | 3/3 | 3/3 |
| sb00-build-webhook-branch | runs-right | 1/1 | 0/3 | 0/3 |
| sb00-build-chat-support | all 6 | 1/1 | 3/3 | 3/3 |
| sb13-linear-plan, sb13-webhook-plan | one-trigger, prompt-under, right-types | - | - | 3/3 each |
| sb13-chat-plan | all 4 | - | - | 1/1 |
| sb01-webhook-branch | 3 checks | 3/3 | - | 3/3 |
| sb02-linear-made-up | ids-asked-not-made-up | 1/1 | - | 0/3 |
| sb02-linear-made-up, sb02-two-triggers | no-junk-nodes, schedule-kept | 1/1 | - | 3/3 |
| sb19-default-local | local-default | 3/3 | - | 0/3 |
| sb00-fix-slack-link | 4 checks | 1/1 | - | 3/3 |
| sb00-fix-schedule | only-asked-node, right-change | 1/1 | - | 0/3 |
| sb00-fix-schedule | proposed, no-outside | 1/1 | - | 3/3 |
| sb00-fix-401-selected, -401-autonomous, -retry-only, -retry-vague | all | 3/3 | - | 3/3 |
| sb00-fix-retry-backoff | right-change | 0/3 | - | 2/3 |
| sb00-fix-why-last-run, sb02-chat-url-swap | all | 1/1 | - | 3/3 |
| sb03-blocked-session | needs-blocked / no-change / kept-the-flow | 3/3 / 0/3 / 0/3 | - | 0/1 / 0/1 / 0/1 |

Every check that moved, with its cause:
- `sb19-default-local` `local-default` 0 of 3 (was 3 of 3): a **reading**, not a product fault. The check asks for a local
  default, and this host's default is Claude by the user's decision.
- `sb00-fix-retry-backoff` `right-change` 2 of 3 (was 0 of 3): the model changed and this head carries the integrator's
  `retryBackoff` send-back, so which one moved it is not separable from this run (the replies were not kept).
- `sb00-fix-schedule` `only-asked-node` and `right-change` 0 of 3 (was 1 of 1): not established. Both read the step by its
  old name ("Weekdays at 8"); a change that renames it fails both with a correct cron. The runs' cards were not kept
  (the scorecard keeps checks, not replies), so this is a hypothesis; re-read it with the replies.
- `sb02-linear-made-up` `ids-asked-not-made-up` 0 of 3 (was 1 of 1): not established, replies not kept.
- `sb00-build-webhook-branch` `runs-right` 0 of 3 on both paths (sb2: 1 of 1 on a single run): the same on the one-shot
  path, so not the staging; not established (the check needs the pinned item to hold every path the If reads).
- `sb03-blocked-session`: one run only (the other two hit the limit); not a reading.
- `sb00-build-*` otherwise: the one-shot and the staged paths are equal on Claude (3 of 3 on every check but one); the
  difference sb3 makes is the prompt (a catalog of about 22k tokens down to 4.3k at most) and the plan the person sees,
  not these checks.

**The PR-review card was a fallback.** With the architect's call refused (400), `/api/agents/design` answered its
non-model fallback (`designed: false`): a card with **no tools, no cases**, only the guardrail "Masks secrets in
messages", the practices line and "Left: Add test cases on the Evaluations tab", and the model row
`anthropic/claude-opus-5-5` (chosen from the models listed, not the default). The card does not say the design failed.
That is a product gap worth a line and is the only thing this pass read about the card; the brief's contents (Check
Practices, a read-only GitHub tool, guardrails in words, 3 to 5 cases), the eval-gate verdict and Undo are not read.

Anthropic spend: the host's AI page shows 9 calls, $0.0739 (the B1 build). The runner's calls (three build asks on two
paths, 9 scenarios' fixes, the rest) are not in that page: the runner writes to a temporary data directory, and the
account's own console is the figure.

**Left for a later wave (k of n 3 where a model is involved), with the reason**
- The whole pass above after `sb13-chat-plan` once the key works again: the sb3 owners' scenarios (sb13 to sb18), items 3
  to 7 and the browser flows of items 4 and 6; the phone shots of the plan card, the summary card, the agent card and the
  agent row.
- ~~The runner requires Ollama even for a cloud model name; the scenario `sb19-default-local` reading "the default is the one the server names"~~ done in wave ag1 (AG02): a `provider/model` name needs that provider's key and no Ollama, and `local-default` compares with the server's own default (`hostModel`). Left: the scorecard JSON keeping each run's reply and the stage prompt sizes.
- The seventh **Unused (Data Table)** step in B1's plan and flow (a plan step with no use) and a `no-junk` reading that
  sees it.
- ~~The design fallback saying so on the card (and not choosing a different model than the default for it)~~ the fallback now takes the host's model (AG02), and the card says it was designed without the architect, and why (wave ag1 integration).


## Platform guide and the landflow-dev plugin

- **Built (2026-11-17):** [`docs/platform/`](platform/README.md), a guided tour of the platform (overview, the host's layers, agents, Kubernetes, the three SDKs with runnable samples in `examples/sdk/`), and `claude-plugins/landflow-dev`, a Claude Code plugin with a skill for each topic and two agents (`landflow-platform-guide`, `landflow-plugin-builder`). The plugin is in the repository's marketplace; opening the repository with Claude Code loads the same skills and agents from `.claude/` (`scripts/sync-claude-plugin.mjs`, run by `pnpm check`, keeps the copies equal).
- **Left open:** the queue overlay's workers get no code runner, SMTP or LLM gateway settings (see [limitations.md](limitations.md)); the plugin has no `LICENSE` file, which the Claude plugin directory asks for before a listing; the skills have no eval suite.

## Real app icons and nodes that say what they do

- **Built (2026-11-17):** the Linear, Attio and Fathom plugin icons are the apps' real marks (they were drawn stand-ins), and `brand-icons.ts` holds the real mark of every app a plugin or core node stands for, with sources and licences ([plugins.md](plugins.md#branding-and-real-marks)); the Messaging, Databases and Productivity bundles show a grid of their apps' icons. A node says what it will do under its name (the descriptor's `subtitle`, else the operation's action label, else "Issue · Get many") on the canvas and in the node panel; the node creator lists an app's actions (a search such as "send message" lists matching actions first) and picking one adds the node set to do it; Marketplace entries and agent tools named after an app wear its mark.
- **Left open:** Microsoft Teams (the Microsoft bot credential) keeps a Landflow glyph, no clean source for its mark; Slack and Twilio come from Simple Icons 15.0.0, the last version that has them, and are one colour, not the multi-colour Slack logo; a Marketplace entry that is not running and whose name is not the app's gets no app mark.

## Agents that work locally (wave ag1)

- **Built (2026-11-17, AG01):** the editor chat runs on the typed message: items a run was given (a chat message) beat the start node's pin, and Unpin is saved (the draft always sends `pinData`, `{}` when none are left), so a reload does not bring the pin back ([features/engine.md](features/engine.md), [features/editor.md](features/editor.md)).
- **AG02, built (2026-11-17):** Spotlight's agent design follows the ask: the agent runs on the host's builder model (or Spotlight's picked one) and the card's Model is a select; the whole ask is read (the address kept, tools named by display name added or listed under Not added); names are short nouns; the steps name only the agent's own tools; writes are asked per app so reads never ask first; a token-reading job is not secret-masked on input; the runner takes a cloud model without Ollama. **Left open:** the live pass on Claude with the Go and Python plugins, and the Opus defaults outside Spotlight's design (the Anthropic Chat Model node, `evaluations/online.ts`, the team builder).
- **Built (AG03, 2026-11-17):** a node used as an agent's tool that reads its whole input item gets a required `item` argument (the data to work on), in the host's agent tools and in a workflow AI Agent's tool sub-nodes, so Normalize Alert and Extract IOCs no longer run on the model's settings alone; the Grafana tools declare their credential (two reads idempotent) and trim a trailing `/` from its URL; a local Grafana with a firing alert is the `grafana` compose profile.
- **Built (AG04):** Spotlight changes an agent. A follow-up under a pending agent card revises the card in place (no plan card, no flow, the canvas untouched); a change to an agent that exists (under its card, or on its page, where the shell Spotlight's chip reads "Changing <name>") is a card of what would change with **Apply to its draft**, which saves the draft and smoke-tests it, and **Publish** only after a pass, through the eval gate; a question is answered, never applied ([assistant.md](assistant.md#agents-and-teams), [agents.md](agents.md#changes-from-spotlight)). Teams and the Agent architect dialog still only create.
- **AG05, an honest smoke test, a publish you can follow, approval cards that settle (2026-11-17):** the smoke test is `untested` with *needs a credential: <tool>* before it runs when a node tool's visible required credential is unset, lists each tool call (`tools`), fails on an erroring tool or on every call returning nothing, and reports a denied write instead of failing on it; the publish shows *publishing: the eval gate runs N cases…* on Spotlight's row and card and the agent page, and a held verdict stays until the next publish; a decided tool call loses its Approve and Deny, a 409 refreshes quietly, and two waiting calls get **Approve all (n)**.
- **Built (2026-11-17, AG06):** credentials that work locally: the SQLite credential has **Create If Missing**, an agent's node-tool dialog lists only the credentials its settings use, and Send Email over SSL/TLS to a plain local server (Mailpit) says to turn SSL/TLS off ([integrations.md](features/integrations.md), [agents.md](agents.md)).

**Left after ag1 (deferred, with the reason)**
- The other Opus defaults: the Anthropic Chat Model node's default `claude-opus-5-5` (`lib/server/nodes/ai.ts`), the online evaluations' fallback (`lib/server/evaluations/online.ts`), the team builder's model list order (`components/agents/team-builder.tsx`) and the marketplace mapping (`lib/server/marketplace/map.ts`). Changing a node's parameter default changes what saved workflows without an explicit model run on, which is not a Spotlight design question: a person decides whether `LANDFLOW_BUILDER_MODEL` should also be every Anthropic node's and the online evaluations' default.
- A per-node tool input schema for every triage node: AG03's generic `item` argument closes "node tools get no data"; a schema per node (the alert's fields, the email's parts) would let the model fill them, and is a plugin protocol change of its own.
- The Spotlight scorecard's JSON keeping each run's reply and the stage prompt sizes (sb3's leftover): a runner-reporting change with no ag1 finding behind it; the next Spotlight wave.
- B1's **Unused (Data Table)** plan step that `no-junk` does not flag stays in sb3's list above (the build path, not agents).
- Revising teams, and the Agent architect dialog changing agents: wave ag1 changes a single agent from Spotlight only ([limitations.md](limitations.md)).
- The live pass's leftovers (found by running the four agents; each is a small fix for the next agents wave, none blocks):
  - ~~"Pull out the IOCs" does not name Extract IOCs, so the triage card drops it silently and Not added is empty.~~ built in ag2, AG07
  - Generated eval cases were descriptions, not inputs (built in ag2, AG08: the cases are now the alert's or question's own text), but a good agent that ends in an approval-gated send can still be held: the gate runs with approvals denied and the expected answers say the email was sent (live: the alert triager's draft scored 2.5 and 3.0 / 5; a read-only Grafana agent 3.75 / 5 and published).
  - ~~The editor's chat cannot approve a tool call (only the agent page's Test chat shows approval cards).~~ built in ag2, AG10
  - ~~The Grafana agent's instructions name node types (`grafana.getAlerts`, `core.httpRequest`) instead of tool names~~ built in ag2, AG07; ~~its HTTP Request tool is preset to `http://127.0.0.1:3000/api/health`~~ (built in ag2, AG08).
  - ~~Send Email's To and From are fixed empty and its Subject and Body unset on the card.~~ built in ag2, AG08 (To is the ask's address, Subject and Body are `$fromAI`; From stays the person's).
  - ~~After an agent-page change is applied the card has no Test button, does not update after a credential pick, its Left row repeats credentials that are set, and it does not say Acknowledge Alert asks first.~~ built in ag2, AG09
  - ~~Spotlight's history loses the smoke row and the card results after a reload.~~ built in ag2, AG11
  - ~~A revise adds a tool to the Tools line without a step for it, and the reply spells "Extract Iocs".~~ built in ag2, AG09
  - ~~The created agent's name can differ from the card's ("Crypto Toolkit agent" against "Utility helper").~~ built in ag2, AG09
  - ~~Grafana 11.4's Acknowledge Alert returns 404 from the plugin.~~ built in ag2, AG10
  - ~~The before/after scorecard and the phone screenshots were not run in the ag1 live pass.~~ run in ag2's live pass, partly: an Anthropic usage limit stopped it (see "Left after ag2").
- Owed to a person, not the pipeline: whether a denied write may count as a pass in a smoke test (AG05's rule; SB18 said no); whether the agent page keeps its own **Publish anyway** (Spotlight never offers it); whether the Grafana observer should ever get Acknowledge Alert by default (it writes: today only when asked, with approval).

## Agents that work locally, wave ag2 (the leftovers of ag1)

- Run an Agent asks in the editor's chat (AG10): the node's **Tool Approvals** (default *Refuse*; the starter flow lays out *Ask in the editor's chat*) makes a tool that needs approval wait for Approve in a chat-mode run, and resumes the same agent session. Grafana's Acknowledge Alert posts to Alertmanager's `/api/v2/silences` (an Editor token; a Viewer gets a clear message) and Get Alert Details reads the alert by name. Against Grafana 11.4 the old `/api/v2/silence` and `/api/v2/alerts/<name>` answered 404; `/api/v2/silences` answered 202.
- **AG08, a design fills a tool's settings honestly and writes real test cases.** A node tool's destination holds only what the request gives (Send Email goes to the ask's address with a `$fromAI` subject and body, From stays the person's; HTTP Request's preset URL is left empty and asked for), a property the model fills per call (Acknowledge Alert's Alert Name) is not a need, the eval cases are inputs a person would send, and a node tool takes only the arguments its schema offered ([agents.md](agents.md#agent-architect)).
- **Built (AG07):** the steps name the agent's own call names: a node type in a step is renamed to its call name or its clause goes, a rename needs the same meaning (never one shared word), a sub-agent's `ask_<agent>`, GitHub's and an open MCP server's names are kept, a revise's removed tool leaves no step, and a node is named by its distinctive word ("pull out the IOCs" is Extract IOCs) ([agents.md](agents.md#agent-architect)).
- **AG09, changing an agent follows the agent**: a tool a revise adds gets its own step ("N. When <the task named, or the first sentence of what the tool is for>, call <tool>.", with "it asks the person first" for a write) and the Changes row says "(asks first)"; the Left row lists only what the agent's draft still lacks and follows a credential picked on the agent's page (`landflow:agent-saved`); **Test again** after Apply; acronyms stay in capitals ("Extract IOCs"); a pending card's design-made name follows its tools ("Renames it to … (its tools changed)"), and Create names the agent what the card shows ([agents.md](agents.md#changes-from-spotlight)).
- **Built (AG11):** Spotlight's history keeps the agents it designed: the card with its smoke test and publish rows comes back after a reload, a card still waiting offers Create only while it fits, and a created one says what happened and opens the agent, or says it was deleted ([assistant.md](assistant.md#conversation-history)).

**Left after ag2 (deferred, with the reason)**
- Not run in ag2's live pass: Anthropic answered with a usage limit at 15:28 UTC on 2026-11-17 (access back on 2026-12-01). Not read: the Grafana observer's change on its page ("also let it acknowledge an alert": the change card, Apply, the editor credential's pick, Test again, Publish, the chat's acknowledge read back from `/api/v2/silences`, "what is firing?"); the utility helper (D) entirely; the reload after C's change; the scorecard after `ag04-add-tool-to-card` run 3 and its 0dc53863 column (wave ag2's runner needs AG02's `builderModel`; that base's own runner needs Ollama); the phone shots of the agent-page change card, the chat's approval card and the row while publishing and held. Joins 2, 3 and 5 of `agents-ag2-joins.test.ts` cover these paths with fakes; the live reading is owed to the next pass.
- Read in ag2's live pass (2026-11-17, on Claude): the triage card names Extract IOCs, its Send Email goes to the ask's address with `$fromAI` Subject and Text, Left asks for the credential and From only (3 of 3); its draft passed the smoke test and the eval gate at 3.0 / 5 (ag1: held at 1–2); in the editor's chat Approve sent exactly one mail to `oncall@landflow.test` naming 203.0.113.45 and web-01, Deny sent none. "Also pull out the IOCs" under a created card: "Adds the tool Extract IOCs", Apply, a step calling `extract_iocs`. The SQLite analyst answered North 4,150, South 2,730, West 1,980, North highest, as `sqlite3` does. The Grafana cards held no node type and no URL nobody gave (3 of 3) and passed the smoke test. The pin is used by Execute workflow and stays gone after Unpin and a reload. The scorecard moved `ag02-triage-email` asked-tools-accounted 1/3 → 3/3 and `ag04-add-tool-to-card` card-has-slugify 1/2 → 2/2.
- The other Opus defaults, a per-node tool input schema, the scorecard JSON keeping each run's reply, revising teams and the Agent architect dialog changing agents: carried from "Left after ag1" with the same reasons.
- ~~The eval gate runs with approvals denied, so an agent that ends in an approval-gated send scores low (the triage agent passed at 3.0 / 5, the threshold).~~ built in ag3, AG15: the design side (the cases expect the ask); the gate's scoring stays a person's decision.
- The live pass's findings (each small; none blocks):
  - A made-up tool's clause drops its whole step, so the address the ask gave can leave the instructions with it (joins: "email it with send_summary to oncall@…" loses the address); live, a card once listed "Not available here: send the summary to oncall@landflow.test; its node type id was not confirmed here".
  - A step cut by the steps check can leave a fragment: the Grafana agent's "3. For dashboard questions, GET) on the dashboard URL or API path given in the message."
  - ~~Spotlight's created card keeps its Left row ("pick a smtp credential; fill in From Email") after the pick on the agent page opened by **Pick it** in another tab (`landflow:agent-saved` is window-local), also after a reload and once published.~~ built in ag3, AG12: the agent tabs tell each other over a `BroadcastChannel`.
  - ~~A change card's Left row drops "fill in From Email" while From is still empty.~~ fixed after ag2's review: a kept tool keeps a parameter need while that parameter is empty on the base's tool.
  - ~~In the editor's chat a tool call waiting for approval, and a denied one, reads **Failed** in the step list.~~ fixed after ag2's review: *Waiting for approval*, *Denied*, *Done*.
  - The editor's chat conversation does not come back after a reload.
  - ~~Once, the first **Apply to its draft** under a change card did nothing; the second applied it.~~ two causes found by reading the code, neither reproduced live. In the editor, the input's blur folded Spotlight's bubbles at once on desktop, moving the timeline between a click's mousedown and mouseup so the click on Apply landed on nothing (the fold now waits 250 ms on desktop as on a phone, and a focus cancels it). On the agent's page, Apply compared the draft's JSON text with the snapshot taken at design time, so a moved `updatedAt` or a save that wrote the same settings in another key order showed "The draft changed since this was designed" and saved nothing until the second click (it now compares the settings as data). The live check of both is owed: it could not be run because Anthropic's usage limit lasts until 2026-12-01, so the fix is reasoned from code and tested offline only.
  - ~~A usage-limit answer reads "Couldn't design the change: the model proposed nothing" on the host~~ (fixed after ag2's review: it says the usage limit was reached); the scorecard runner records the checks as failed with no error.
  - ~~The Grafana credential's API Token field is a plain text input, so a pasted token shows on the screen.~~ built in ag3, AG14: the field is a password field (masked, never returned by the vault).
  - ~~Spend: an agent's smoke tests, eval-gate cases and chat runs carry no surface, so the AI page cannot tell them apart~~ built in ag3, AG15 (surface `agent-test`); the scorecard's calls are on no host's page.
- Owed to a person: whether a denied write may count as a pass in a smoke test; whether the agent page keeps its own **Publish anyway**; whether the Grafana observer should ever get Acknowledge Alert by default; whether every Run an Agent in the editor's chat should ask (saved flows keep Refuse); whether a fixed destination on a heuristic-schema tool should be closed to the model (`lib/server/agents/tools.ts`).

## Agents that show what they are connected to, wave ag3

- **AG15**: an agent that asks before it writes can pass its eval gate honestly: the cases for a tool that asks first expect the ask, not the send, and an agent's smoke test, gate runs and test chat show as **agent tests** in Insights → AI.
  - Read live (ag3's live pass, 2026-11-17): the triage agent's eval gate held at 2.8 / 5 on the clause the cases were written with (ag2: 3.0), and the database's AI usage rows show the agent's smoke tests, gate cases and test-chat calls under the `agent-test` surface. Still owed: the gate after the fix in `2362f54b` (designs 2 and 3 were shown on the rebuilt host, not published), Insights → AI read before and after for AG15 (the **agent tests** surface as a person sees it), and the phone shot of the Tests row; k of 3 designs on the production profile with the cases expecting the ask.
  - Known edges: the chat route also serves the Sessions tab's continuation of sessions started by a schedule or a channel, so those continuations are labelled agent-test; calls resumed after Approve go through `sessions/[sid]/approvals`, which opens no agent-test scope and writes no surface. The judge's calls carry the agent's id, so they count toward its daily and monthly caps and its per-agent spend.
- **Built (AG14):** every tool call shows what it reached: the credential's name, type and where (host and port, or a file's last part; never a secret) as a via line in the editor's chat and the agent timeline and a Reached row in the Run Trace, and a knowledge search's passages with their source chips; the Grafana credential's API Token is masked.
- **AG13, Spotlight gives an agent its knowledge**: the card's Knowledge row says what will be indexed (the folder the ask named and its files), from where and how it is searched; Create indexes the folder into the new knowledge base (`POST /api/agents/:id/knowledge/:toolId/folder`) before the smoke test; an ask with no source asks which folder and invents nothing; a knowledge base with no embeddings model is searched by keywords (BM25, built in, SQLite and in-memory stores). Built; read live in ag3's live pass (2026-11-17): the card's row `runbooks/ · 4 files · keyword search (BM25, built in)`, Create's *indexed 4 files, 4 passages*, the band's *4 docs*, and the three runbook questions answered with the right file ([assistant.md](assistant.md#agents-and-teams), [agents.md](agents.md#agent-architect)).
- **Built (AG12):** a Run an Agent node (and a Run a Team node, for its lead) shows what its agent is connected to in a read-only band under its name: model, memory, tools and knowledge bases above the Chat Model, Memory and Tool slots, with *asks first*, documents, *replaced by* a wired model or memory, *Not published* and *Draft has changes*; a click opens the agent's page at that ability. One function, `agentConnections`, feeds the band (`GET /api/agents/:id/connections`) and the Run Trace, and the tabs tell each other about agent changes over a `BroadcastChannel`. A phone's step card says it in one line. See [agents.md](agents.md#from-workflows).

**Left after ag3 (wave ag3's live pass, 2026-11-17, on Claude `anthropic/claude-sonnet-5-5`)**
- Read live: five agents made from typed Spotlight asks on new workflows, each recorded and shot (triage, analyst, Grafana observer, utility helper, runbooks answerer). The triage agent's gate held at 2.8 / 5 before the clause fix (ag2: 3.0), so its proof ran in the agent's Test chat: Approve sent exactly one mail to `oncall@landflow.test` via *Mailpit SMTP · SMTP 127.0.0.1:51188*, read back in Mailpit. The analyst's SQLite call went *via Sales DB · SQLite sales.db* and answered North 4,150, South 2,730, West 1,980 (as `sqlite3` prints). The Grafana observer got Acknowledge Alert from the agent page's Spotlight (*Adds the tool Acknowledge Alert (asks first)*), the band said *Draft has changes* without a reload, and after Approve the silence for `alertname=High CPU on web-01` was on Grafana's Silences page and in `/api/v2/silences`. The utility helper answered the four tasks (JWT payload, `printf landflow | shasum -a 256`, a v4 UUID, `wave-ag1-agents-that-work-locally`), each *via <plugin> plugin · <node> 127.0.0.1:<port>*. The runbooks answerer found 730 MB in `runbooks/disk-full.md` 3 of 3, 19 days and 45 minutes once each, with passages, sources and scores in the chat and the Run Trace. G2 (the Left row drops a picked credential in another tab) and G3 (the token field is masked) held.
- Fixed during the pass (each with a test): a change that gives Send Email's sender sets From; the created card's Left row drops a field the draft now holds; a case's send clause expects the ask even when another clause negates something; ag2's case-order flake; the Test chat's steps carry the via line; a plugin tool's via line names where the plugin answers; Publish on Spotlight's row, and Create's indexing, tell the canvas band (it read *Not published* and *0 docs* until a reload); a design drops a test case naming a URL nobody gave (`grafana.example.com`); a change that adds a tool takes its verb out of the Hand over line (the Grafana agent answered "I can't acknowledge alerts"); a case keeps its own quotes (`Hash "password`); "from the folder runbooks" under a card revises it (it went to the flow builder).
- ~~Not read again live after its fix: the triage gate with the clause fix.~~ closed by the ag4 live pass: Alert triager was published at gate 4/5/5/5 (`backbone/shots/wave-ag4/116-B1-gate-running-desktop.png`, `117-B1-publish-verdict-desktop.png`).
- Findings left (small; none blocked the proof):
  - In the editor, after a reload, "set Send Email's From Email to …" was read as a flow build (a separate Send Email node, "None of your credentials fits"); the same ask works on the agent page's Spotlight. ~~Still carried after AG17: needs the live E-ask.~~ closed by the ag4 live pass: S1's From Email was set through a typed ask in the editor (`backbone/shots/wave-ag4/`, S1 series) with AG17's changeAgent routing.
  - The agent page's Spotlight answered "when I ask it to acknowledge an alert, it should call acknowledge_alert instead of handing it over" as a question; **Change it instead** switched to change mode but did not send the text again.
  - A step fragment after the steps check, again: "5. When asked to acknowledge an alert." (with ag2's "…GET) on the dashboard URL…").
  - A Grafana call's via line names the credential type's display name (*Grafana Alertmanager API Token 127.0.0.1:53188*), not "Grafana".
  - ~~The canvas band shows a tool a change added only after it is published (the band shows what runs; *Draft has changes* says the rest).~~ (closed by AG16: the bubbles show the draft's changes, marked)
  - A Spotlight conversation brought back after a reload shows the card's knowledge as *Knows: The “runbooks” knowledge base*, without the Knowledge row.
  - A knowledge agent's cases are written without reading its folder: on the phone, Spotlight's own Create (a brand-new draft, D1) smoke-tested "How do I fail over the primary database?", the search found nothing, and the test failed (*Search Runbooks returned nothing to work with*).
  - With the take's `runbooks` knowledge base on the host, the no-folder ask reused it (a base that fits), so its *no source given* row was read only in the scorecard (`ag13-no-source`, 3 of 3 live).
  - An editor left open across host restarts piles up *lease expired* toasts (28 and more), covering the chat's input.
  - The Spotlight mode switch reads *Autonomous (now)* on a saved flow while its line says it asks first, and on a phone the explainer comes back on every editor load; zoomed on a phone, the canvas toolbar covers the node's right edge.
  - The live scorecard (`AG13,AG15,AG08,SB16`, 1 run each): every live check passed but `ag15-triage-cases`'s *send-cases-expect-approval*; the JSON keeps no cases or replies, so why is not known. The scenarios' scripted forms fail under the live environment (23, as ag2's 27): the runner runs them with the live variables set.
  - Video: the screen was locked (no avfoundation screen device), so each take is Playwright's per-tab recording, the tabs one after the other with idle frames dropped, not a crop of the Chrome window.
- ~~Once a team node has run, its summary, budgets and ribbon make the tile taller, so sub-nodes placed at +200 can still sit on its slot labels; Tidy up fixes it. A possible follow-up: fold the summary into one line.~~ built in ag4, AG16: the bubbles go below a taller tile (height + 64) and Tidy up measures it; real sub-nodes saved at +200 in older flows and templates still sit where they were saved (see [limitations](limitations.md)).
- Deferred (carried, same reasons): a made-up tool's clause dropping the address; the editor's chat not coming back after a reload; the scorecard JSON keeping each run's reply; revising teams; the Agent architect dialog changing agents; the other Opus defaults; A2A Agent nodes and team members other than the lead on the band.
- A code finding (Ollama stays off by the person's decision, so no live check): `assistantModel('ollama/qwen3.8:latest')` passes the `ollama/` prefix to Ollama, and `qwen3.8` is not `qwen3.8:latest` in `agentResources`' rank and `chooseModel` (`lib/server/assistant/model.ts`, `agent-resources.ts`).
- Owed to a person: embeddings for knowledge bases (keyword search finds the runbooks' words, not their meaning: an embeddings model is Ollama when it is on again or a paid provider's key, not added without the person); whether the gate's judge should read a refused approval as the intended action, and whether a denied write may pass a smoke test; whether someone may click **Publish anyway** for a gate-held proof agent; whether `LANDFLOW_BUILDER_MODEL` becomes every Anthropic node's and the online evaluations' default; whether the agent page keeps its own **Publish anyway**; whether the Grafana observer should get Acknowledge Alert by default; whether every Run an Agent in the editor's chat should ask; whether a fixed destination on a heuristic-schema tool should be closed to the model; whether knowledge folders may come from outside the files directory; whether the band should show A2A agents and every team member.

## Agents aligned with workflows, built by Spotlight end to end, wave ag4

- **AG18, Spotlight knows the tenant through tools**: in its own tool loops (the editor chat and the Agent architect's dialog) Spotlight reads the agents (drafts too, with model, tools, plugin, asks first, credential by name, knowledge and the workflows that run them), the nodes usable as tools with their plugin and credential needs, the knowledge bases (documents, search mode, source folder, the files directory's folders), the models, the credentials by name and the written [agent best practices](platform/agent-best-practices.md), each a step of the trace and never usage. The flow builder's roster lists drafts and says it read them. The instance MCP server answers the same reads and adds `create_agent`, `update_agent`, `test_agent` and `publish_agent` (the eval gate, no skip) on the existing scopes (decision 4: no `agents:*` scope). Docs: [assistant.md](assistant.md#agents-and-teams), [features/ai.md](features/ai.md#mcp).
- AG17: a Run an Agent node follows its agent: wired model, tool and knowledge sub-nodes move into the agent's draft on editor open and in a host start pass, recorded in `agent_flow_moves` and said in a notice and a pill; memory and what can't move stay with a reason; production keeps its published version until republished; new wiring is refused; Spotlight's `changeAgent` op shows the agent's change card ([agents.md](agents.md#from-workflows)).
  - Left after AG17: a Run a Team node's wired model, memory and tools are not moved into its lead's draft (`run-team.ts` has no R11 overlay yet), so team flows are not yet aligned with their lead; AG17's live check ran in the wave's §4 pass (the E series, `backbone/shots/wave-ag4/189-E1-import-dialog-desktop.png` onward, desktop and phone).
- **AG21, workflow versions pin agent versions**: publishing pins the agent version each node was tested with and production keeps it; a differing agent draft refuses the publish (409 `agent_changes_unpublished`); each run records both versions; "v3 is available" offers test-then-publish in the editor and Spotlight; each agent version lists the workflow versions that pin it; versions are kept past the 20; a backfill pins what runs today. Built, with tests; the live F run on Claude has not been run yet (the review pass had no network beyond localhost), so no live reading is claimed ([agents.md](agents.md#versions-and-the-workflows-that-pin-them)).
- **AG19, Spotlight reuses an agent or builds one from the tenant**: `Reuses “<name>”: <why>.`, plugins found by the job, an existing knowledge base, the person's model, the agent card as bubbles (`BubbleDiagram`). Built; the live pass ran on 2026-11-18 (production profile, port 3294, Claude, all seven plugins, Mailpit; shots in `backbone/shots/AG19/`, captions in `CAPTIONS.txt`): reuse 3 of 3 for ask A (Agents 7 to 7; the flow builder still added a Send Email step 3 of 3), ask B first reused the triage agent (fixed: an agent with gaps is the closest, never used by itself; Create then builds Haiku, Extract IOCs, the runbooks base attached, nothing indexed again), S1 typed again offered Use and bound the starter flow to S1 (Agents 8 to 8), phone card without horizontal scroll. Live findings fixed: a saved card lost `reuse`, `attached`, `modelWhy`, `modelNote`, `catalog` and `knowledgeSetup` on reload (the conversation schema); gaps written as "None known" counted as gaps. Left open: the Pick it credential was set by a scripted PUT (the agent page's own picker was not driven), the real task of ask B and `k of 3` for B were not run, the sales agent picked Postgres, not SQLite, and ~~the editor's Spotlight does not design an unbound Run an Agent after Apply (the person picks the agent or asks Spotlight to create it)~~ built in ag5, AG25.
- **AG20, Spotlight runs the flow, reads the run's log and fixes from it**: a fix round names the run's execution; `get_run_log` (also an MCP tool) gives the failing node's error with an HTTP status and the response body's first 400 characters, the plugin's lines and a Run an Agent step's tool calls; Spotlight says the cause in one clause and makes one focused change to the flow, or, when the log shows the cause inside the agent, proposes a change to the agent (the AG04 change card with the failed run's `fix`: Apply, smoke test, Publish through the gate, run again); two runs failing the same way, or four fixes, stop it with *Still failing at … Left: …*; a run that writes outside asks first. Tests: `run-log-ag4`, `session-fix-ag4`, `ag20-*` scenarios.
- **Built (AG16):** the canvas draws a Run an Agent node's agent (a Run a Team node's lead) as bubbles on dashed edges to its Chat Model, Memory and Tool slots, and the node card says nothing about it (AG12's band is removed); the + under a slot and a bubble's menu edit the agent's draft (live after Publish, with a Publish chip and a confirm when several workflows run it); moved and kept wiring is marked *moved here* / *this flow only* with Try again and *Use for <agent> everywhere*; *Your agents* in the node creator places a bound node by click or drag; Tidy up and Spotlight's placement keep the bubbles' row clear (never a node beside the agent in its own row); the steps list shows mini bubbles; a version preview and a run's canvas draw the pinned agent version read-only with a chip "<name> v1" when the pins route (AG21) answers, and the plain node when it does not. Left: a tenant list of knowledge bases for the + under Tool. The production-profile live pass ran as the wave's §4 pass (`backbone/shots/wave-ag4/`, 240 shots, listed in `shots.log`).

**Left after ag4 (wave ag4's live pass, 2026-11-18, production profile on port 3298, Claude `anthropic/claude-sonnet-5-5`, all seven plugins, Mailpit; shots in `backbone/shots/wave-ag4/`, listed in `shots.log`)**
- Read live, each from a typed Spotlight ask: four seed agents (Alert triager published at gate 4/5/5/5, Runbooks answerer at 3.0, Question answerer on the *Sales DB* SQLite credential, Crypto Toolkit agent); A reused *Alert triager* (`Reuses “Alert triager”: …`, the bubbles equal to the seed's starter, no leaks, the agent count unchanged); B designed and created an agent on Haiku with Extract IOCs and the existing `runbooks` (4 documents, not indexed again) and answered the brute-force alert with both IOCs and RB-103's steps; C ran, read the 400's body and the fix sent `report_text` (201 at the strict receiver: North 4,150, South 2,730, West 1,980); D changed the agent on its page (both tabs' bubbles marked, then cleared after Publish); F1 to F5 pinned and moved agent versions (*Publish v2: runs Alert triager v1*, production read *workflow v2 · Alert triager v1* until *Publish v4: Alert triager v1 → v2 (test first)*, then *workflow v4 · Alert triager v2* with the runbooks search in its Run Trace); E1 moved Slugify into the utility helper's draft on open (Window Memory kept, the notice's lines as specified), the notice's Publish passed the gate and the published agent lists `slugify`; E2's start pass removed the already-moved Slugify (*Already in Crypto Toolkit agent*) and a second restart changed nothing (updatedAt, the agent's draft and the record equal); E3's *Wire a Sentiment tool into this step.* gave the agent change card.
- Fixed during the pass (each with a test, all on the branch): the design brief lists the person's credentials and the node a credential fits ranks first (S3 got Postgres for a SQLite *Sales DB*); the plan leaves a reused agent's own send to it (A: 3 of 3 plans added a Send Email); the card draws the proposed agent when the closest one has gaps, and a fallback name stops before *someone* (B); a typed *Run it now and fix it if it fails.* starts Test and fix (C: *I can't run the workflow from here*); a fix applied before the reply ended counts (C: *I found no fix*); Apply on a read-only canvas says so (F3: *Applied*, nothing changed); a typed *Run this step …* runs the selected step (E1: *I can't run steps from here*); a moved tool is named in the agent's instructions (E1: *Slugifying text is outside what I handle*); a `changeAgent` on the selected step is in scope (E3: sent back twice as outside the scope).
- Findings left (deferred; none blocked the proof):
  - ~~**No approval in a production run**: Run an Agent's `toolApprovals` is *refuse* or *askInChat*, and a webhook or schedule run has no person to ask, so the published triager's `send_email` (asks first) was refused (*needs a person's approval, which isn't available in this kind of run*) and Mailpit got 0 mails (F1, `backbone/shots/wave-ag4/148-F1-run-trace-desktop.png`).~~ built in ag5, AG23: Spotlight approves its own fix-session test runs to given destinations; production keeps refusing and says so before publishing. ~~Still needs an approval inbox for trigger runs (a person's decision on where it is answered).~~ built in ap1 (AP01 to AP03): a step set to Ask waits in Needs you ([approval-inbox.md](approval-inbox.md)).
  - ~~The Runbooks answerer's gate held at exactly 3.0 (2, 1, 5, 4): its generated cases asked about payments and failover runbooks the folder does not have (S2, `backbone/shots/wave-ag4/40-S2-agent-evaluations-gate-desktop.png`); carried from ag3's "cases written without reading the folder".~~ built in ag5, AG24
  - The created card's *Left* row kept a stale *Not available here* line after the knowledge base was attached (S2, `backbone/shots/wave-ag4/36-S2-card-bubbles-desktop.png`).
  - The plan card is not brought back when a flow is reopened (A, `backbone/shots/wave-ag4/89-A1-reopened-plan-desktop.png`).
  - While a production run is in progress, its Run Trace canvas draws the draft's new filter step, not the version that runs (F3).
  - The agent's History panel, where F2 expected *v2 used by workflow v2*, was not found on the agent page (`backbone/shots/wave-ag4/164-F2-S1-history-desktop.png`); the pins are in the Publish menu and the run header.
  - The filter Spotlight wrote for *high or critical* matches the agent's free-text reply with a `(?i)` regex and says it may miss other wordings (F3, `backbone/shots/wave-ag4/177-F3-applied-desktop.png`); a structured severity field in the agent's reply is the fix.
  - The card says *“Alert someone agent” already does this* in the same reply that lists gaps for another closest agent; the wording should follow the gaps.
  - `cardLeaks` (a contract file, unchanged) reads a node's own name inside its card as a leak unless the name is stripped first; the pass stripped it in the reader.
  - On a phone, a run's node detail opens beside the logs and is cut at 390 px (*Alert …*, *Re-ru…*; `backbone/shots/wave-ag4/219-F5-phone-run-trace-header-phone.png`); and the editor opens on Steps with the chat sheet over half the canvas, so a zoomed bound node needs Canvas first (`backbone/shots/wave-ag4/221-S1-phone-canvas-zoom-phone.png`).
  - Not read live: the scripted legacy setup of E2 (an import by the owner's API) stays a setup step; undoing a move; a team's lead aligned with its flow (AG17's left item).
- **Found in the final live run (on `eba7ba33`; shots in `backbone/shots/wave-ag4-final3/`), carried into the next wave's fix-path quality items:**
  - ~~After an agent fix, the eval gate compares the draft's score with the published version's on different cases (3.7 against 4.3) and holds it; on a second attempt the held card shows no score.~~ built in ag5, AG24
  - ~~A review round after the fix can propose removing the tool the session itself just added (the run did post *North 4,150*, yet the check said *the run didn't match*).~~ built in ag5, AG22 (the session keeps its own fixes, drops a proposal that undoes one, and the review reads the agent step's reply; the design route's `keep` is AG24's)
  - ~~Revised instructions can come out garbled (*1. read-only SELECT) to read…*).~~ built in ag5, AG24
  - ~~The replacement test cases still hand the agent the figures in the text, and one re-adds the removed case unchanged.~~ built in ag5, AG24
  - ~~The first flow ask uses an inline AI Agent step instead of reusing or creating a saved agent.~~ built in ag5, AG25.
  - ~~A trigger or webhook run cannot answer a tool approval (same gap as *No approval in a production run* above; the decision is owed: see *Owed to a person*).~~ said before publishing in ag5, AG23 (the publish card and menu name each tool; production still refuses; where approvals go stays the person's decision). The inbox itself: built in ap1 ([approval-inbox.md](approval-inbox.md)).
- Carried, same reasons: **Change it instead**; ag3's carried items (the editor chat after a reload, the scorecard JSON keeping replies, revising teams, the Agent architect dialog changing agents); knowledge cases read from the folder (closed by AG24: a folder not indexed yet is judged by its file names); A2A agents and team members as bubbles; the `ollama/` model naming (Ollama stays off); the Run Trace *works with* list; team membership versions; a bulk *update every workflow to v3*; an MCP publish tool; deleting an agent a workflow version pins.
- **The scorecard, after only** (`LANDFLOW_SPOTLIGHT_ONLY=AG19,AG20,AG13,SB16`, live on Claude, 1 run each, all six local plugins; `backbone/live/wave-ag4/scorecard.json`): AG13 (`ag13-runbooks-card`, `ag13-no-source`) and SB16 (five scenarios) passed every check; AG19 `ag19-reuse-card` and `ag19-draft-reuse` passed, `ag19-reuse-chat` reused but its *read-tenant* check was 0 of 1, `ag19-build-plugin-kb-model` chose the model and added no Send Email but *built-and-placed* was 0 of 1, `ag19-no-fit-no-reuse` 0 of 1 on *built-and-placed* and *no-reuse*; AG20 `ag20-keeps-url` passed, while `ag20-fix-from-log` (*fixed-from-logs*, *one-focused-fix*, *stops-and-says*), `ag20-agent-fix` (*agent-fix-card*, *no-flow-change*, *read-the-log*) and `ag20-same-twice` were 0 of 1, each ending in 5 to 20 s. The live pass's C read the same AG20 path in the browser (the log read, one field changed, 201), so the scenario form, not the product path, is the first suspect; the JSON keeps no reply (carried), so why is not known. The scripted scenarios fail in the live form as in ag3's run (24 here, 23 there); they pass in the gate's unit run. Owed: a look at the AG19/AG20 live scenarios with their replies kept.
- Counts: the secret grep (the Mailpit password, the key's first 12 characters, the binary, registry and runner secrets) found 0 in the host, plugin and receiver logs, the executions, their events and steps and the agent sessions; the browser aborted 0 requests and the host refused 0; Ollama's 11434 was not listening; spend after: 825.3k tokens and 277 calls ($1.61 on Claude, from 19.4k and 79 before). The test credentials *Mailpit SMTP* and *Sales DB* were deleted in the UI at the end.
- Owed to a person: where a trigger run's tool approval is answered (an inbox, Slack or mail); the payments and failover runbooks (cases limited to the folder: done by AG24).

## Spotlight fixes and publishes by itself, wave ag5

- **An agent change that is right, and a gate that compares like with like** (AG24): the gate compares a draft with the published version on the cases both ran, or judges it against 3.0 alone when the change replaced them, and a held verdict carries its score and basis everywhere; revised instructions are checked line by line to read as sentences; a data agent's replacement cases ask for what its tool holds without stating it, never re-add a removed case and name only what a knowledge agent's folder holds; the design route's `keep` never removes a tool the session added (the session's side is AG22's).
- **AG23: Spotlight approves its test runs' tool calls to given destinations, and production approvals are said before they bite.** The run body takes `approvals: 'spotlight'` (with `sessionId`, `destinations`), only for an editor test run; the Run an Agent step lets Spotlight approve a call that asks first when every destination was given (the agent's fixed parameters, the flow, the person), else it waits or is refused, never run; the Run Trace says *Approved by Spotlight (autonomous fix session)*. Production still refuses an asks-first tool in a run nobody watches; `GET /api/workflows/:id/unattended-approvals` and a line on the publish card and the Publish menu say which tools, before publishing. Where production approvals go (an approval inbox, approval at publish, or refusing) stays the person's decision.
- **AG25, the first flow ask uses a saved agent**: a flow ask that needs an agent (the ask says "agent", or the step is a specialist's) gets a Run an Agent step, never an inline AI Agent: the builder's rule and `savedAgentSteps` after the model (the plan path too) turn an AI Agent the ask called an agent into a Run an Agent step; an AI Agent that stays always has the builder model's Chat Model wired. An unbound Run an Agent step is designed after Apply: on a brand-new draft with the switch on it is created, smoke-tested and published by itself and the step bound; asks first, a saved flow or a design that needs something from the person leaves the agent card waiting. Closes *the first flow ask uses an inline AI Agent step* (found in the final live run) and AG19's left *not designed after Apply*. Live check by a person: `contracts/ag5/asks.md` G1 twice (no sales agent, then after W1) and the *Classify each message* ask on the production profile.
- **The autonomous fix session (AG22)**: in Autonomous mode a test-and-fix session applies its own flow and agent fixes on saved and published flows, runs to given destinations without asking, picks the one fitting credential, sends Spotlight's approvals with its test runs, keeps its own fixes (no undoing, no loops; the review reads the agent's reply), treats a held eval gate as a finding (one more fix from the lowest cases) and, once it applied a fix of its own, publishes the agent and then the workflow by itself (*Published: workflow v4 · Agent v5*; a session that fixed nothing ends with the Publish card); Asks first is unchanged. The decision of 2026-11-18 replaces *autonomy only on a brand-new draft* for fix sessions. [assistant.md](assistant.md#autonomous-mode)

**Left after ag5 (wave ag5's live pass, 2026-11-18, production profile on port 3348, Claude `anthropic/claude-sonnet-5-5`, all seven plugins, Mailpit; shots in `backbone/shots/wave-ag5/`, listed in `shots.log`)**

The readings: W1–W3 set up *Short writer* v1 (no tools) on a published Webhook flow (*Reports webhook → Short writer → Post to reports*, `{"summary": …}`, workflow v2); P0's `curl` was a 400 (`summary`), the Run Trace read *workflow v2 · Short writer v1* and the agent said it had no data. **G** (Autonomous, typed *The numbers look made up. Test it and fix it.*, no click): the first try stopped at *The trigger waits for a test event* (fixed in this carryover: the session tests with the trigger's last call); the rerun went 400 → the flow fix (`report_text`) → the agent fix (SQLite on *Sales DB*, picked alone) → held at 2.67 and 1.67 / 5 *(judged on its new cases)* → a third fix passed at 3.0 → *Short writer* v2 → the workflow published as v3, in 167 s with no click (shots 62–73). **P1** (shots 74–77): one `curl`, 201, the Run Trace *workflow v3 · Short writer v2*, the post's `report_text` names October's sales from the database. **G1** (shot 82): a Schedule → *Short writer* (reused, *Reuses “Short writer”: …*) → HTTP flow, no AI Agent step, agents 6 → 6, not published. **G2**: Spotlight approved Send Email in its test run (*Approved by Spotlight (autonomous fix session)* on the run and in the Run Trace), one mail to `oncall@landflow.test` in Mailpit, *Published: workflow v2 · Messaging agent v5* and the `unattendedLine`, also in the Publish menu (shots 145–148). **G3** (shot 151): Asks first waited at *Needs you · A test runs “Post to reports” for real* with no run; stopped with ■. Spend $0 → $2.07 (19.4k → 961.1k tokens, 79 → 269 calls); `[local-only] refused` 0 for the host and every plugin; the browser aborted 0 requests; the secret greps (Mailpit password, the key's first 12 characters, the three host secrets) 0 each across the host, plugin and receiver logs and every run, event list and agent session read.

Fixed in this carryover: the session's test of a Webhook flow with nothing pinned (above); a held round whose design takes back the session's own tool (the design route kept it, so AG22's undo check never fired: join 1); a sender given as *set send_email's fromEmail parameter to …* (live G2: *No change*, every mail failed *From Email is required*).

Still open:
- G2's From Email: the created agent's Send Email has no sender (*fill in From Email*, the person's) and the fix session stops on it, as designed; the typed *Send the email from …* needs **Apply** and **Apply to its draft** on a saved flow (D1), and the session does not publish a draft the person changed but left unpublished (it stops with *Publishing the workflow stopped: “Messaging agent” has changes that are not published*): the person publishes it (shot 135).
- ~~A fix round whose design changes nothing (*No change: the agent already has what you asked*) still published a new agent version (G2's first sessions took *Messaging agent* from v1 to v4).~~ fixed in the ag5 fix pass (a no-op design stops before Apply).
- ~~G's agent fix also gave *Short writer* a *Change Case* tool that asks first, which nothing asked for; the Publish menu then names it in the unattended line.~~ fixed in the ag5 fix pass (a tool that asks first or writes must be named by the cause or the person's ask).
- The New credential dialog for SMTP leaves **SSL/TLS** on for port 51348 (a plain Mailpit): the first G2 mails failed with a TLS error until it was turned off by hand.
- The session's timeline row and its `publishedLine` are not brought back after a reload, so the phone shots show the Publish menu's lines, not the session's (shots 154–162).
- A passing gate returns its `basis` in the publish answer and the held card, but the stored eval run (`agent_eval_runs`) does not keep it.
- Carried from the plan's deferred table: ~~production approvals (the person: a/b/c)~~ built in ap1, AP01 (the server side; the step and the screens are AP02 and AP03); a "run the live version now" for schedule-only flows; the created card's stale *Left* line, *already does this* beside gaps and `cardLeaks`; a running production run's canvas drawing the draft, the agent page's History panel, the severity filter on free text, a test-update run read like production; Run a Team's wired sub-nodes, A2A agents and team members as bubbles, team membership versions, bulk "update every workflow", an MCP publish tool, deleting a pinned agent; the stop line after a reload, the scorecard JSON keeping replies, **Change it instead**; an agent fix that also needs a step removed waits for the click.

Decided by the person (2026-11-18): **production approvals** go to an approval inbox (a run waits in Home's *Needs you* with a mail or Slack nudge and expires after a set time), built as its own wave after ag5; **removing a step during a fix** applies without a click only for the session's own steps and steps that repeat the agent's work (built in the ag5 fix pass).

Seen in the ag5 confirm run (b7ac9bc4, port 3351, shots in `backbone/shots/wave-ag5-confirm/`), still open:
- After Apply the new step stays selected, so the next ask is scoped to that one step (*Remove the step I just added* answered that it needs a second change); a typed fix ask should not inherit a selection Apply made.
- *Reports webhook* sits on top of the *Short writer* card after the session's changes (shots 66, 104).
- A passing gate's score and basis are not shown in the session (only *tested, 1 of 1 passed · published*).
- The agent page's capability row names *sqlite* but not the credential (*Sales DB*) it uses.
- *Run a Team* still records its run version after the input checks, so a team run that fails early has no version label.

## Production approvals in an inbox, wave ap1

The person decided on 2026-11-18 that production approvals go to an approval inbox, and on 2026-11-19: 24 hours, anyone with run access decides, and every one of them gets the mail ([approval-inbox.md](approval-inbox.md)).

- **AP01: the approval inbox on the server.** Migration 2907 `approval_inbox` (the durable record per waiting tool call, masked parameters, kept for the audit); one conditional claim behind every door (`decideApproval` claims first, so a call runs at most once; an API key is refused; the agent-session route answers 409 for a call that waits in Needs you; the execution route and the emailed links go through the same claim); `GET /api/approval-inbox`, `GET /api/approval-inbox/:id`, `POST /api/approval-inbox/:id/approve` and `/deny`; `LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES` (default 1440); a mail to every active user with run access on the workflow and to the agent's approval emails (each once), and a new alert event `approval` for the person's own rules; Needs you items with the inbox fields; a cancelled run settles its rows. The Run an Agent step that pauses and resumes (AP02) and Home's panel, the Run Trace card and the publish card (AP03) follow.
- **AP02: a run nobody watches pauses at an asks-first tool and waits in Needs you** (the person's decision of 2026-11-18, accepted from ag5's option a; replaces "keep refusing, said before publishing"): Run an Agent in a webhook, schedule, form or app-trigger run with Tool Approvals *Ask* (the default of newly placed steps; a step saved without the value or set to *Refuse* still refuses) runs its agent with `approvals: 'ask'` and `inbox: true`; each held call opens one request through the inbox port (the masked parameters it would run with, the destination, the workflow and agent versions, the trigger word), the execution waits with the request's expiry as its `until`, and on every resume the node reads the record: approved runs once, denied, expired or cancelled is refused and the run goes on. Durable across a restart (`waits.start()` re-arms the expiry) and in queue mode; no agent-session approval mail for a workflow's session; a remote A2A agent's own pause is still auto-rejected. The publish card's line says `waitLine` or `refusesLine` with why. Left: kagent agents and Run a Team members are not in the inbox ([agents.md](agents.md#from-workflows)).
- **AP03, the approver's view**: Home lists every request waiting for your approval (*Waiting for your approval · n*) with Approve and Deny and a Details sheet (the parameters it would run with, masked; the destination; the agent and workflow versions; the run; the expiry; a bottom sheet on a phone), the Runs list's Needs you draws the same row, `/?approval=<id>` opens one, the Run Trace card reads *Waiting for your approval since … · expires …* and decides through the inbox's one claim, the publish card and the Publish menu draw a clock for a step that will wait and the shield for one that still refuses, and the agent page's session says *Waiting in Needs you* with no buttons. Never an approve-all. Seen on seeded responses only (AP01 and AP02 are not on this base): the person's live pass of `contracts/ap1/asks.md` P1 to P5 is open.
- **Integration (the hosted chat refuses, the joins)**: with AP01's port registered, a hosted-chat run (mode `webhook`) of a step set to *Ask* waited in Needs you, though the publish line said it refuses; the execution now keeps its trigger's type (`triggerType`, the hosted chat's chat trigger also when it starts at a roster target), and Run an Agent refuses for the hosted chat, an MCP trigger and a workflow either calls, with the line's reason in the tool's answer. `approval-inbox-ap1-joins.test.ts` joins AP01, AP02 and the doors with both real sides (pause → Needs you → nudge → approve, deny, expiry, restart, cancel, publish lines against the runtime for every trigger word, races, doors, no secret, guards). The live pass and *Left after ap1* follow before the merge.

**Left after ap1 (wave ap1's live pass, 2026-11-19, on 845b568d, Claude only, about $0.74; P1 to P5 on the desktop and P6 on a phone; Mailpit's oncall mailbox +1/0/+1/0/+1 over the five runs; secret greps 0; shots in `backbone/shots/wave-ap1/`, named by their number)**

- Fixed in the final pass (not left): the Run Trace read *waited 2m 00s · Answered* after an expiry (93) and now reads *Expired*, with the inbox's line; the late-link page (96) now says *at <time>*; the Publish card's *Publish with … as published* button ran past the card's edge (53) and now wraps.
- Spotlight added an unrequested **Get Alerts** tool to the agent; its credential blocked **Pick it** for Mailpit (20 to 23); one extra ask removed it.
- The agent card left **From** empty (ag5's open item, still open) (20).
- The webhook was made with Authentication *None*; Spotlight said so, but nobody asked (61).
- The editor's canvas **Publish** pill next to Spotlight published an agent version by a stray click; the menu then said *Up to date* while *agent v4 is available* (58, 59, 60, 106).
- The workflow keeps the name *Chat with <agent>* after its chat trigger became a webhook; Home's row and the nudge subject show it.
- A second tab's list refreshes on its own, so a stale double-approve is hard to reach (70, 73); the 409 path was shown after a Deny (80).
- The Agent architect added a Home suggestion *Build a tool for Model* from the *no local model is listed* note (91).
- Decisions owed by the person: an error workflow fired by a failing hosted-chat or MCP run waits (its input carries the outsider's data); a workflow called from a chat or MCP run refuses though its own publish line says it waits (see [limitations.md](limitations.md#the-approval-inbox-wave-ap1)).
- Not covered by the live pass: K1 (kagent and the Claude Code harness have no inbox) and K2 (Run a Team's members). F2: the SMTP dialog leaves SSL/TLS on, seen again (06, 07).

## Notion as the brain

- **NB01, the storage seam (wave nb1).** `brainStoreFor(projectId)` gives each project a `BrainStore` (the local one today, a resolver slot for linked projects), and every brain write (entities, facts, summaries, practices, notes) goes through one change feed with its project and origin (`person`, `landflow` or `notion`). Practice source `notion` is tainted and project-level only; a note from Notion is unverified and tainted. No screen changes; no reader moved onto the store. See [features/notion-brain.md](features/notion-brain.md#how-it-is-built).
- **NB02: a Notion client in the host** ([notion-brain.md](features/notion-brain.md#how-landflow-talks-to-notion)): Notion-Version 2026-03-11 and Markdown v2, a token bucket per credential, Notion's errors and retry rules (a 503 on a write may have landed), a scoped writer that refuses any write outside the root before sending, rich-text and Markdown size limits, `LANDFLOW_NOTION_WRITE_LOG`, and the local Notion fake every test uses (`test/notion-client-nb02.test.ts`).
- **NB03 (wave nb1): a project can be linked to a Notion page** with the existing Notion API credential: migrations 2908 to 2911, the link model and resolver, the check, link, change, sync, disconnect and problem routes, `LANDFLOW_NOTION_BRAIN`. Nothing syncs yet; the copy, the push and the pull are wave nb2 ([features/notion-brain.md](features/notion-brain.md#setting-it-up)).
- **NB04 (wave nb2): the brain is written into Notion.** The initial copy (resumable, never duplicating), the outbox and the leader service `notion brain` for every later change, the render contract with its fixtures, and the carryover in the client (a write that may have landed, a 529 in the 429 streak, a fence-safe cut) ([features/notion-brain.md](features/notion-brain.md#the-sync-that-writes-into-notion-nb04)). Reading Notion back is NB05.
- **NB05 (wave nb2): what people edit in Notion comes back** ([notion-brain.md](features/notion-brain.md#what-comes-back-from-notion)): names, descriptions, owners and attributes, "Your notes" as a knowledge doc, new pages, facts, team notes and practice changes (tainted drafts) by each field's owner, conflicts put back with one suggestion a day and the later edit winning a both-sides change, trash and schema problems with `repair`, `putBack`, `deleteLocal` and `keepAsFact`; nb1's carryover: a practice approval emits after its transaction, the inbox says "a linked Notion page", a note's author.
- **NB06 (wave nb2): the company's Notion pages are knowledge** ([notion-brain.md](features/notion-brain.md#your-companys-pages-as-knowledge)): the walk from the brain page or the root into `notion_knowledge_docs` and `landflow-notion-<project>` (BM25, vectors when on), Ask's fourth source with Notion citations, the project's Notion-brain knowledge tool, `brain_search_knowledge` over MCP, and the reserved collections refused to agents' own knowledge tools.
- **Follow-up: a time cap on the check.** The check (`brain/notion/check.ts`, `findBrain`) pages the root's children, then up to 20 child pages with a database and data-source read for each, all at the key's rate with retry waits up to 120 s, and linking runs it twice; on a large root a check or link request can stay open for tens of seconds or more. A deadline (and one check per link) belongs with NB07's Brain card (wave nb3), which is what calls it from a screen.
