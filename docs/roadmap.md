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

**A. Engine and flow**
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

**B. Editor and organisation**
- Sticky notes on the canvas.
- Copy, paste and duplicate nodes, using the clipboard JSON format n8n uses.
- Import and export workflow JSON, including import from n8n workflows.
- Workflow settings dialog (error workflow, time zone, timeout, callers, saved executions).
- Version history: every save is a version, with a list, a preview, a diff and restore.
- Tags and folders, plus search and sort in the workflows list.
- An expression editor with autocomplete for `$json`, `$('Node')`, `$vars` and functions.

**C. Platform data**
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
before sign-in and AI.
- A SQLite store, with Postgres as an option (Docker infra). The JSON files stay as an import
  and export format.
- Crash recovery: node outputs are saved as checkpoints under stable step ids. A run
  interrupted by a restart continues from its last finished node, the way Inngest and Hatchet
  work.
- Every execution records the workflow version it started on.
- Idempotency keys for triggers, and per-step keys sent to plugins.
- Per-workflow concurrency limits and singleton runs. n8n offers neither at any tier.
- Automatic retry of failed runs with backoff, per-node timeouts, and a stop-all control.

## Wave 2a: what a network-reachable install needs

- Sign-in: owner setup, users, roles (owner, admin, member), invites (Mailhog), and a lock so
  two people don't edit the same workflow at once.
- Scoped API keys and a documented public API.
- Free OIDC login (Keycloak in Docker). n8n charges for it.
- A sandboxed Code node running out of process in a locked-down container, with JavaScript and
  Python.
- OAuth2 *Connect* buttons for credentials.
- **Binary data** across the protocol and the three SDKs, stored on disk or in S3 (MinIO):
  - file nodes: Read/Write Files, Extract from File, Convert to File;
  - HTTP downloads;
  - webhook and form uploads;
  - attachments in the integrations.
- Failure alerts by email or chat, without writing an error workflow.

## Wave 2b: safe deploys and outside agents

- Draft and publish on pinned versions.
- App webhook triggers (a register/unregister lifecycle in the protocol) with signature checks;
  webhook authentication.
- An inbound-email trigger.
- A CLI with stable JSON output, and Git sync of workflows as files.
- **MCP Server Trigger** (a workflow serves tools over MCP), **MCP Client Tool** (an agent uses
  an MCP server), and an instance-level MCP server so coding agents can build and run workflows.

## Wave 3: AI

- RAG:
  - vector stores (in memory, SQLite, pgvector);
  - Ollama embeddings, a document loader and a text splitter;
  - hybrid search with a reranker;
  - a retriever usable as an agent tool;
  - knowledge bases for agents.
- Streamed replies, a hosted chat page and an embeddable widget for the Chat trigger.
- Guardrails node (PII, prompt injection, moderation).
- Token and cost tracking with per-agent and per-workflow caps; model fallbacks.
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
