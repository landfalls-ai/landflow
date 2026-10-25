# Roadmap: closing the gaps with other workflow platforms

Status: **in progress** (started 2026-10-25). The list comes from a pass over Landflow's code and
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

**A. Engine and flow** ✅ Done. Not yet: waiting children in "each item" mode, a test URL for forms.
- Executions that pause and resume: a node can put the run in a `waiting` state. The run's
  state is saved to disk and resumed later, also after a restart, at a time, on a webhook call
  or on a form submission.
- **Wait** node: after an interval, at a date and time, on a webhook call (resume URL), or on a
  form submission.
- **Form Trigger** and **Form** nodes: hosted form pages, multi-page forms through waiting, and
  a completion page.
- **Respond to Webhook** node, and the Webhook trigger's response modes: immediately, when the
  last node finishes, or from Respond to Webhook.
- **Loop Over Items** (batches), with node state kept for the length of a run.
- **Execute Workflow** node (sub-workflows), and the workflow trigger called by workflows as well
  as agents. Covers run once or per item, waiting or not, and the caller policy.
- **Error Trigger** and the workflow setting *Error workflow*.
- **Schedule** trigger: cron expressions, times of day, weekdays, a time zone, and several rules.
- Workflow timeout, and the settings for which executions to keep.

**B. Editor and organisation** ✅ Done. Renaming a node updates `$('Old')` references. Not yet: undo doesn't cover settings, tags or the name.
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
  "Code runner". Not yet: syntax highlighting in the code editor, `$('Node')` in in-process code.
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
  attachments, Telegram uploads and downloads, and a Binary tab in the run view; see the README's
  "Files and binary data". Not yet: Google Drive, Slack and the other integrations' files, binary
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
  sync publish through `lib/server/publish.ts`. Not yet: four-eyes approval of a publish, scheduled publishes.
- App webhook triggers (a register/unregister lifecycle in the protocol) with signature checks;
  webhook authentication. ✅ Done: `triggerSource: "appWebhook"` with `WebhookMethod`
  (checkExists/create/delete) and `ReceiveWebhook` over HTTP and gRPC, static data per workflow
  and node, retries with backoff, and `/api/webhook/app/<workflowId>/<nodeId>`; GitHub, Stripe and
  Slack signature helpers in the TypeScript, Go and Python SDKs; a GitHub Webhook Trigger in the
  productivity plugin (docs/protocol.md §12). The Webhook and Form triggers authenticate callers
  with Basic Auth, a header (`httpHeaderAuth`) or a JWT (HS256 secret, PEM key or JWKS URL, issuer
  and audience checks), plus an IP allow-list. Not yet: Stripe and Slack triggers, OAuth app
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
  section. Not yet: OAuth for MCP servers, a test URL for the trigger, resources and prompts.

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

- Queue mode with workers on Valkey and Postgres, and high availability.
- Audit log, written as events through the existing OpenTelemetry pipeline, plus streaming to a
  SIEM.
- External secrets: OpenBao/Vault, 1Password and cloud secret managers.
- Environments and promotion.
- Projects, sharing, SAML and SCIM.
- Templates library and canvas groups.
- An allowlist for nodes and MCP servers; four-eyes publish; ownership transfer.
- Kubernetes discovery for plugins, tested on OrbStack's local cluster.

## Not planned

Later, maybe: browser use, an agent code sandbox, voice, and prompt management. Not planned:
RPA, process mining, an app builder, and a chat hub (n8n is retiring its own).
