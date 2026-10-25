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
  two people don't edit the same workflow at once.
- Scoped API keys and a documented public API.
- Free OIDC login (Keycloak in Docker). n8n charges for it.
- A sandboxed Code node running out of process in a locked-down container, with JavaScript and
  Python. ✅ Done: the code runner service, one fresh child process per run with n8n's globals,
  on an internal Docker network with a read-only root; see [deploy/README.md](../deploy/README.md),
  "Code runner". Not yet: syntax highlighting in the code editor, `$('Node')` in in-process code.
- OAuth2 *Connect* buttons for credentials.
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
- Failure alerts by email or chat, without writing an error workflow.

## Wave 2b: safe deploys and outside agents

- Draft and publish on pinned versions.
- App webhook triggers (a register/unregister lifecycle in the protocol) with signature checks;
  webhook authentication.
- An inbound-email trigger.
- A CLI with stable JSON output, and Git sync of workflows as files.
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
- Streamed replies, a hosted chat page and an embeddable widget for the Chat trigger.
- Guardrails node (PII, prompt injection, moderation). ✅ Done, after n8n's: check (Pass/Fail) or
  sanitize, plus secret keys, keywords, URL allow-lists, topical alignment and custom checks. Not
  yet: guardrails as a setting of standalone agents.
- Model fallbacks. ✅ Done: "Enable Fallback Model" on the AI Agent and the chains.
- Token and cost tracking with per-agent and per-workflow caps.
- Evaluations, both offline (test datasets from Data Tables) and online (grading agent
  conversations).
- A Slack agent channel with approval buttons.
- Files and images as model inputs.
- Debounce, batching and rate limits.
- A Flowise importer, since Flowise has shut down.

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
