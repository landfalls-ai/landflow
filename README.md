# Landflow

**A low-code workflow platform where every node is a plugin, written in any language, and autodiscovered over HTTP or gRPC.**

Landflow follows n8n's model (items flowing between nodes, typed ports, cluster nodes for AI agents) and rebuilds the plugin layer around one language-neutral contract. A node is a JSON **descriptor** plus an **`execute`** behaviour. Built-in nodes implement exactly the same interface as external ones; they just run in-process.

![Workflow editor after a run, with the Logs panel](docs/images/editor-run.jpg)

| | |
|---|---|
| ![Node creator: categories, then one segment per plugin with its published icon](docs/images/node-creator.jpg) | ![Executions tab: an AI agent run with its model, memory and tool calls nested](docs/images/agent.jpg) |
| ![Plugin registry](docs/images/plugins.jpg) | ![Home](docs/images/overview.jpg) |

## Quick start

```bash
pnpm install
(cd plugins/py-insights && ./setup.sh)    # venv with grpcio for the Python plugin (one-off)
pnpm dev:all                              # host :3000 + the example and integration plugins
```

Open http://localhost:3000. The plugins announce themselves within a second and their nodes appear in the editor. Three example workflows are seeded on first boot:

| Workflow | Shows |
|---|---|
| **Polyglot review pipeline** | TS slugify → Python sentiment → Go hash → IF → branches + Python stats, all over gRPC |
| **Polyglot AI agent** | Chat → AI Agent with a local Ollama model, memory, and tools written in Go, Python and TS |
| **Webhook text enrichment** | `curl -XPOST localhost:3000/api/webhook/enrich -d '{"text":"…"}'` |

To run the pieces separately: `pnpm dev`, `pnpm plugin:ts`, `pnpm plugin:py`, `pnpm plugin:go`, and the integrations (see [Integrations](#integrations)). `plugins/productivity/setup.sh` makes the Python integrations' venv.

## Run with Docker

```bash
docker compose -f deploy/compose.infra.yml up -d --wait                     # Postgres+pgvector, Valkey, Mailpit, MinIO, OpenBao
docker compose -f deploy/compose.infra.yml --profile auth --profile observability up -d --wait   # + Keycloak, Jaeger
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait  # host + 7 plugins on http://localhost:53000
```

The first command starts the development and test infrastructure. The last one runs Landflow itself from images: the host as Next.js standalone output with its data in a volume, and one image per plugin, each announcing itself to the host by its service name. Ports, credentials, how the dev server uses the infra, the databases plugin's real-server tests and how to reset everything are in **[deploy/README.md](deploy/README.md)**.

## Building and debugging a flow

The editor follows n8n's layout, in Landfall's monochrome style. Colour comes from the nodes, the plugins' brand colours and run states. A screen-by-screen comparison with n8n, including what is still missing, is in **[docs/ui-review.md](docs/ui-review.md)**.

**Start a flow fast**
- **Describe it**: the empty canvas (or the ✨ button) takes a sentence such as "score review sentiment, keep the negative ones and hash them". A local Ollama model drafts the flow from the live node catalogue. The host validates the draft and lays it out, and sample items are pinned on the trigger so it can run straight away. This takes about 10 s on `qwen3-coder:30b`.
- **Templates**: four starter flows on the empty canvas (plugins pipeline, branch and merge, webhook with test data, AI agent).
- **Node creator** (`+`, `Tab` or `N`): n8n's side menu. It asks "What triggers this workflow?" first, then "What happens next?" with AI, Data transformation, Flow and Core, followed by **one segment per plugin**. Each segment shows the plugin's own icon and colour, an online dot, and its language and transport. New nodes chain onto the selected node, a "+" on an edge inserts into it, and the node opens ready to configure.
- **Tidy up** (`⇧⌥T`) lays the graph out in layers.

**See that it works**
- **Execute workflow** (`⌘↵`): nodes light up as they run, edges turn green with item counts, and dots travel along edges while items flow.
- **Logs panel**: every node run in order, with a mini waterfall, sub-node calls (model, memory, tools) nested under the node that made them, and the selected run's input and output as **Schema, Table or JSON**. **Re-run task** runs one node again with its earlier input. **Run from here** reuses the upstream results. **Events** shows the raw stream.
- **Node details**: Input | Parameters | Output. Drag a field from the input schema into a parameter to insert `{{ $json.path }}`. Expressions show their **resolved value** for the first input item as you type. You can pin output or set test data on a trigger.
- **Debug**: breakpoints (`F9`), Step (`F10`), Continue (`F8`) and Stop. While paused, the node glows amber and its waiting input can be inspected.
- **Assistant** ([docs/assistant.md](docs/assistant.md)): after a node runs, its panel shows **✨ Suggestions** from the local model: fixes for the error, parameter tweaks, data problems and the next node to add, each with Apply / Dismiss. **✨ Assistant** (`⌘I`) opens a builder chat. It searches the node catalog, reads node docs, the workflow and the last run, then proposes changes as diffs you apply, with an undo. Changes are validated against the registry before you see them.
- **Executions tab** (Editor | Executions): n8n's list of runs with a read-only canvas, an error banner, the Logs panel, Debug in editor, and Retry/Re-run with the saved or the original workflow. The global **Executions** page is a filterable table of every run.

**Edit and organise**
- **Sticky notes** (`⇧S` or the note button on the canvas): Markdown notes behind the nodes. Double-click to edit, drag the corners to resize, and pick one of seven colours from the toolbar above a selected note. They are saved in `workflow.stickyNotes` (never as nodes) and show read-only in the Executions tab.
- **Copy, cut, paste, duplicate** (`⌘C` `⌘X` `⌘V` `⌘D`): selections, with the connections between them, sticky notes and pinned data, go through the system clipboard as JSON, so they move between workflows and browser tabs. Pasted nodes get new ids and n8n-style names when a name is taken (`HTTP Request` → `HTTP Request1`). `$('Name')` references between pasted nodes follow the rename; references to nodes outside the selection keep pointing at the original. Pasting **n8n clipboard JSON** converts it with the importer and reports nodes that became placeholders.
- **Undo / redo** (`⌘Z`, `⇧⌘Z`): canvas edits, parameter typing (coalesced per node), pasting, deleting and tidying up. `?` lists every shortcut.
- **Expressions**: inside `{{ }}` the parameter field highlights the expression and suggests `$json` fields from the node's input, upstream nodes (`$('Node').item.json.…`), `$input`, `$now`, `$today`, `$workflow`, `$execution`, `$itemIndex`, `$vars` and methods for the value's type (↑↓, Enter or Tab, Esc; `⌃Space` opens the list). Typing `{{` closes the braces.
- **Workflow menu** (`…` in the top bar): **Settings** (error workflow, time zone, timeout, which workflows may call this one, which executions to save), **Version history**, **Download** as JSON, and **Import** from a file or pasted JSON into the open workflow (Landflow or n8n).
- **Version history**: every save that changes the workflow records a version (the last 50 per workflow, identical saves are skipped) under `.data/workflow-versions/<id>/`. The panel lists them with a summary of what changed, previews a version read-only on the canvas, and restores it (the restore is a new version, so it can be undone the same way).
- **Tags** in the top bar, and **folders** on the Workflows page: nested folders with a breadcrumb, create / rename / delete (only when empty), move a workflow from its menu or by dragging it onto a folder or breadcrumb step, search by name, filter by tag and sort by last updated, name or created. **Import** on the Workflows page creates a workflow from a Landflow or n8n JSON file and shows what was mapped, what became a placeholder and any warnings.

## Architecture

```
                         ┌───────────────────────── Next.js host (apps/web) ─────────────────────────┐
  Browser  ── SSE ─────▶ │  UI: editor · node creator · NDV · logs · executions · chat · registry    │
                         │  API: /api/workflows · /run (SSE) · /plugins · /announce · /webhook/*      │
                         │                                                                            │
                         │  Engine (packages/engine) ── NodeTypeResolver ──▶ Plugin registry          │
                         │   depth-first scheduler          │                 ├ core (in-process)     │
                         │   {{ expressions }} · $fromAI    │                 ├ HTTP client           │
                         │   sub-nodes / agent tools        │                 └ gRPC client           │
                         │                                  │   gRPC RegistryService :7070            │
                         └──────────────────────────────────┼─────────────────────────────────────────┘
                     announce + heartbeat ▲    Execute/GetManifest/LoadOptions ▼
          ┌──────────────────────────────┬┴───────────────────────────────┬──────────────────────────┐
          │ text-toolkit (TypeScript)    │ py-insights (Python)           │ go-crypto (Go)           │
          │ HTTP :7101 · gRPC :7201      │ HTTP :7102 · gRPC :7202        │ HTTP :7103 · gRPC :7203  │
          └──────────────────────────────┴────────────────────────────────┴──────────────────────────┘
```

```
packages/
  protocol/   wire contract: TS types, zod schemas → JSON Schema, plugin.proto, gRPC converters
  sdk/        TypeScript SDK: INodeType, runtime, HTTP + gRPC servers, announcer
  engine/     executor: scheduling, expressions, sub-node wiring, tool schemas
sdks/
  python/     landflow_sdk: Node ABC, stdlib HTTP server, optional gRPC, announcer
  go/         landflow: Node interface, net/http + gRPC servers, announcer
plugins/      one example plugin per SDK, plus the integrations: messaging (TS),
              productivity (Python), google-workspace and databases (Go)
apps/web/     Next.js host: UI, API routes, registry, built-in "core" nodes
docs/         protocol spec + the n8n research this design is based on
```

## The node interface

The **methodology**: every node implements one interface. The descriptor is plain JSON, so any language can produce it.

```ts
interface INodeType {
  description: NodeDescriptor;                     // name, kind, ports, properties, icon, usableAsTool…
  execute?(ctx: IExecuteContext): ExecuteResult;   // items in → items out (one array per output)
  supplyData?(ctx): unknown;                       // sub-nodes: supply a model / tool / memory (in-process)
  methods?: { loadOptions?: Record<string, (ctx) => PropertyOption[]> };
}
```

| | TypeScript | Python | Go |
|---|---|---|---|
| Interface | `class X implements INodeType` / `defineNode({...})` | `class X(Node)` (ABC) | `Description()` + `Execute()` |
| Serve | `serve(plugin, { http, grpc })` | `serve(plugin, http_port=, grpc_port=)` | `landflow.Serve(ctx, p, ServeOptions{...})` |
| Params | `ctx.getNodeParameter(name, i)` | `ctx.get_node_parameter(name, i)` | `ctx.ParamString(name, i, def)` |
| Errors | `NodeOperationError` | `NodeOperationError` | `landflow.ItemError(...)` |

Plugins publish their own branding: `icon: 'file:icons/x.svg'` in the plugin or node descriptor is read by the SDK and sent as a `data:` URL (SVG or PNG, up to 64 KB). A hex `color` tints the plugin's segment in the node creator and its nodes on the canvas.

Descriptor fields mirror n8n's `INodeTypeDescription` / `INodeProperties`: 13 property types, `displayOptions`, `typeOptions.loadOptionsMethod`, typed ports with `required`/`maxConnections`. The editor renders every plugin's UI from its descriptor, so plugins need no frontend code. Full spec: **[docs/protocol.md](docs/protocol.md)**.

## Autodiscovery

| Source | How |
|---|---|
| **Announce** (push) | Plugin `POST /api/plugins/announce` (or gRPC `RegistryService.Announce` on `:7070`) with a 30 s lease, then heartbeats every 10 s; `SIGTERM` withdraws |
| **Static** | `LANDFLOW_PLUGINS=http://host:7101,grpc://host:7203` |
| **Scan** (pull) | Probes `LANDFLOW_SCAN_HOSTS × LANDFLOW_SCAN_PORTS` (default `127.0.0.1:7100-7299`) with TCP, then `/.well-known/landflow`, then gRPC `Health`; runs at startup and from the UI |
| **Built-in** | the host's `core` plugin, registered in-process through the same interface |

Every manifest is validated against the zod/JSON Schema before its nodes become available. A plugin can expose HTTP and gRPC at once. The registry executes through the preferred online endpoint (gRPC first) and you can switch transports live from the Plugins page. Expired leases turn a plugin offline: its nodes grey out and saved workflows still open.

## Engine

- **Data model** (n8n's): items `{ json, pairedItem }`, nodes return one array per output, and an empty output stops that branch.
- **Scheduling**: n8n v1 "depth-first by branch", with siblings ordered by canvas position. Multi-input nodes (Merge) wait for every connected input, or run with what they have once the stack drains.
- **Expressions**: `{{ $json.x }}`, `$('Node').item`, `$input`, `$now`, `$workflow`, `$execution`, `$itemIndex`, `$vars.NAME`. They are resolved by the host per item, so plugins only ever see concrete values.
- **Errors**: `onError: continue` (sent to the plugin as `continueOnFail`, so integrations turn a failing item into `{ error }` and keep the rest), `retryOnFail`/`maxTries`, disabled nodes pass data through, plus pin data, `executeOnce` and `alwaysOutputData`.
- **Live events**: `execution.started`, `node.started`, `node.finished` (with item counts and the run), `node.log` and `execution.finished`, streamed over SSE to light up the canvas.
- **Waiting executions**: a node can suspend the run (`ctx.putExecutionToWait`, in-process nodes). The engine returns status `waiting` with a JSON resume state; the host saves it under the same execution id and resumes it on the workflow version it started with, when its time comes (timers are re-armed at boot), on a call to `/api/waiting/<id>`, on a form submission, or when the sub-execution it waits for finishes. Waiting runs show as **Waiting** in the executions lists; `DELETE /api/executions/:id` cancels one.
- **Loops**: an edge back to an earlier node runs it again (Loop Over Items keeps per-node state for the execution, also across waits); `$('Node')` sees that node's latest run. Partial runs and "run up to here" work inside loops.
- **Workflow settings**: `timeoutSeconds` fails a run with "Workflow timed out after N s" (time spent waiting doesn't count); `saveSuccessfulExecutions`, `saveFailedExecutions` and `saveManualExecutions` (default on) drop runs from the history, though their events still stream; `errorWorkflowId` runs that workflow's Error Trigger when a non-manual run fails; `timezone` is the Schedule trigger's zone; `callerPolicy` / `callerIds` decide which workflows may run this one.

### Triggers and flow nodes

- **Webhook** (`/api/webhook/<path>`): **Respond** immediately (202 with the execution id), when the last node finishes (its output as JSON), or using a **Respond to Webhook** node (first item, all items, JSON, text, no data or a redirect, with status code and headers; sent when that node runs while the run goes on). A run that starts waiting before it answers returns `{ status: "waiting", executionId }`.
- **On Form Submission** (`core.formTrigger`) and **Form** (`core.form`): server-rendered forms (text, textarea, number, email, password, date, dropdown, checkboxes, radio buttons; required fields, placeholders, button label) at `/form/<path>` while the workflow is active. A submission becomes `{ <field>: value, submittedAt, formMode }`. The trigger answers on submit or when the workflow finishes; each Form page makes the run wait at `/form/waiting/<executionId>`, and a Form ending shows a message or redirects.
- **Schedule**: n8n's Trigger Rules (every N seconds, minutes, hours at a minute, days, weeks on weekdays or months on a day, at a time of day, or a five- or six-field cron), in the workflow's time zone, else the server's. Older "every N seconds / minutes / hours" schedules keep counting from activation.
- **Error Trigger**: the start of an error workflow; it receives n8n's `{ execution: { id, url, error, lastNodeExecuted, mode, retryOf? }, workflow: { id, name } }`.
- **When Called by a Workflow or Agent** (`core.workflowTrigger`): defined arguments or "accept all data"; called by an agent tool or by **Execute Workflow**, which runs the workflow once or once per item, maps arguments or passes items through, waits for it (or not) and returns its last node's output. The child is its own execution linked to the parent (`parentExecutionId`), at most 10 levels deep; if it starts waiting, the parent waits too and resumes with its output.
- **Wait**: a time interval, a date and time, a webhook call (`$execution.resumeUrl`) or a form (`$execution.resumeFormUrl`), with an optional time limit. Waits up to ~65 s stay in memory; longer ones suspend the run.
- **Loop Over Items** (Split in Batches v3): batches on its "loop" output, everything that came back on "done".

## AI agents

The **AI Agent** is a root node with typed sub-node ports (`ai_languageModel` required/max 1, `ai_memory`, `ai_tool`), following n8n's cluster nodes. Models are provider-neutral `LanguageModel` adapters:

- **Ollama Chat Model** works locally with no API key, and its model list loads live via `loadOptions`.
- **Anthropic Chat Model** defaults to `claude-opus-5-5` with effort control and server-side refusal fallback. It uses `ANTHROPIC_API_KEY` or an `ant auth login` profile, and replays Claude's content blocks verbatim across tool turns.

**Any `usableAsTool` node becomes a tool, including remote plugins in any language.** The tool schema comes from the plugin's `toolInputSchema`, from n8n-style `{{ $fromAI('key', 'description', 'type') }}` placeholders, or from a heuristic. Tool calls in a turn run concurrently, and each call is recorded as its own sub-node run, so tool nodes light up on the canvas and the timeline shows model, tool and memory calls.

### Agents (Preview)

**Agents** (sidebar) are standalone assistants modelled on n8n's Agents tab ([docs/agents.md](docs/agents.md)). An agent has:
- a model (Anthropic, any OpenAI-compatible API, or Ollama) and instructions;
- [skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) it loads on demand;
- capabilities: any plugin action node, workflows that start with **When Called by an Agent**, and other agents as sub-agents. Each capability can require a person's approval.
- session memory, plus optional cross-session memory per user.

You test it in a chat that streams tool calls and approval cards, then publish it as a version. The published version runs on schedules (cron, in a time zone), answers in Telegram, and is callable from workflows through the **Message an Agent** node. Every run is an `invoke_agent` trace with `execute_tool` and `gen_ai.chat` children.

## Integrations

The integrations people use most in n8n, chosen from its catalogue and public usage data ([research](docs/research/04-n8n-integrations.md)), are built as plugins, one per language family, with n8n's resource → operation shape, names and options (Return All / Limit, Simplify, live pickers, usable as AI tools):

| Plugin | Language, ports | Nodes | Credentials |
|---|---|---|---|
| `core` (in the host) | TypeScript, in-process | Switch, Split Out, Aggregate, Remove Duplicates, Summarize, Rename Keys, Date & Time, Record Metric; OpenAI Chat Model (any OpenAI-compatible API, Ollama's `/v1` included), OpenAI (message a model, embeddings), Basic LLM Chain, Text Classifier, Information Extractor | OpenAI API, Anthropic API |
| [`messaging`](plugins/messaging) | TypeScript, 7104/7204 | Telegram, **Telegram Trigger**, Slack, Discord, WhatsApp Business Cloud, Send Email (SMTP) | Telegram, Slack, Discord bot and webhook, WhatsApp, SMTP |
| [`productivity`](plugins/productivity) | Python, 7105/7205 | Notion, Airtable, GitHub, **GitHub Trigger**, Jira Software, HubSpot, RSS Read, **RSS Feed Trigger** | Notion, Airtable, GitHub, Jira Cloud and Server (PAT), HubSpot |
| [`google`](plugins/google-workspace) | Go, 7106/7206 | Google Sheets, **Sheets Trigger**, Gmail, **Gmail Trigger**, Google Drive, Google Calendar, Google Docs | Service account (JWT, optional impersonation), OAuth2 refresh token |
| [`databases`](plugins/databases) | Go, 7107/7207 | Postgres, MySQL, SQLite, Redis, **Postgres Trigger**, **SQLite Trigger** | Postgres, MySQL, Redis, SQLite |

Run them with `pnpm plugin:messaging`, `plugin:productivity`, `plugin:google` and `plugin:databases` (all included in `pnpm dev:all`). Every credential has an overridable base URL or host, so each plugin's tests run against local fakes of the service; no test needs a real account.

**Credentials.** Plugins declare credential types (fields, secrets, a connection test) in their manifest. The host keeps saved credentials in an AES-256-GCM vault (`.data/credentials.json`, key from `LANDFLOW_ENCRYPTION_KEY` or a generated `.data/encryption.key`). Workflows only reference them by id, the API never returns secrets, and each Execute call carries just the decrypted credentials that node declared. The **Credentials** page and the picker at the top of a node's parameters create, edit and test them ("Authenticated as @landflow_bot"). The SDKs mask credential values in logs, span attributes and error messages.

**Polling triggers.** A node with `triggerSource: "poll"` is called by the host every `pollInterval` seconds with the state it returned last time, and a run starts only when it returns new items. The first poll records a baseline, so activating a workflow never replays history; **Execute** in the editor shows the latest few items. The node panel shows the poll status (last poll, new items, errors) with **Poll now**.

## Settings, variables, data tables and insights

- **Settings** (bottom of the sidebar) → **General**: the instance's default time zone (schedules, Date & Time nodes and the days in Insights; until you pick one, `GENERIC_TIMEZONE` or the host's) and execution retention. Retention keeps at most N finished executions (default 300) and/or drops those older than D days (0 = off). It applies whenever an execution is saved, at boot and every hour, and never touches running or waiting executions; **Prune now** applies it on demand. Stored in `.data/settings.json`.
- **Settings → Variables**: instance-wide string values (`.data/variables.json`, keys like `API_BASE`). Read them as `{{ $vars.API_BASE }}` in any expression, as `$vars` in the Code node and in AI tool parameters. Unknown names resolve to `undefined`. Variables aren't secrets; keep secrets in credentials.
- **Data tables** (sidebar): tables of typed columns (string, number, boolean, date) plus `id`, `createdAt` and `updatedAt`. The grid edits cells in place, adds, renames and deletes columns, and searches, sorts, pages, deletes selected rows and imports or exports CSV. The **Data Table** node (`core.dataTable`, usable as an AI tool) inserts, gets, updates, upserts and deletes rows, with all/any conditions (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `isEmpty`, `isNotEmpty`), mapping columns one by one or straight from the input, and a dry run. A run that writes to one table is all-or-nothing. Each table is one JSON file in `.data/data-tables/`, capped at 50,000 rows and 32 MB.
- **Insights** (sidebar): runs, failed runs, failure rate, time saved and average run time for the last 24 hours, 7 or 30 days against the period before; runs per hour or day; and a sortable row per workflow. Manual runs (editor and chat tests) are left out unless **Include manual runs** is on. Time saved = successful runs × the workflow's minutes saved per run (`settings.timeSavedMinutes`, editable in the table). Counts come from a rollup (`.data/insights.json`) updated as each execution is saved, so pruning executions doesn't change them. It is filled from the stored executions on first boot and keeps 400 days.

## Observability

The host and every plugin are instrumented with OpenTelemetry ([docs/observability.md](docs/observability.md) is the contract). Each execution is one trace: `trigger.fire` → `workflow.execute` → `node.execute {type}` → `plugin.rpc Execute` → the plugin's `plugin.execute` span and its outbound calls. Agents show model (`gen_ai.chat`), tool and memory runs as children of the agent node. W3C `traceparent` goes to plugins as HTTP headers or gRPC metadata, an incoming `traceparent` is continued, and run/webhook responses return one.

- **Logs**: JSON lines with `trace_id`/`span_id`, plus a `span.end` line per finished span (`LANDFLOW_LOG_FORMAT=pretty` for humans).
- **Metrics**: Prometheus text at `GET /api/metrics` (executions, node runs, triggers, polls, schedule lag, webhooks, plugin RPCs, heartbeats, plugins online, AI requests and tokens, HTTP durations). The **Record Metric** node (`core.metric`) lets a workflow record its own counters, histograms and gauges as `landflow.flow.<name>`. Each plugin serves its own `/metrics` with execution metrics plus integration metrics such as `landflow.messaging.messages_sent`, `landflow.productivity.records_written`, `landflow.google.sheets.rows_appended` and `landflow.db.query.duration`.
- **Integrations**: every API call or query is a client span under the plugin's `plugin.execute` (`HTTP POST`, `INSERT issues`, `google.oauth.token`), so one run of "GitHub → SQLite → Telegram" is a single trace across the host and three plugins in three languages. Query strings and credential values never reach spans or logs; SQL spans carry the parameterised statement only.
- **Export**: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (OTLP/HTTP JSON) to send traces and metrics to Jaeger, Tempo or the Collector ([docs/otel-collector.yaml](docs/otel-collector.yaml)). With `LANDFLOW_TRACE_URL`, the execution view links each run's trace id to your trace UI.

## API

| Route | |
|---|---|
| `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id` | CRUD (`active: true` turns on webhooks, schedules and polling triggers) |
| `POST /api/workflows/:id/run` | run (optionally with unsaved `workflow`, `chat`, `items`) and stream SSE events |
| `POST /api/workflows/import` | `{ data, name?, folderId?, create? }` → `{ workflow, report }`: converts Landflow or n8n workflow JSON (placeholders for unknown n8n nodes); `create: false` converts without saving |
| `GET /api/workflows/:id/versions`, `GET /api/workflows/:id/versions/:versionId` | version history (summaries, newest first) and one version with its workflow |
| `POST /api/workflows/:id/versions/:versionId/restore` | restore a version (keeps the current name, tags, folder and active state) and record it as a new version |
| `POST /api/workflows/:id/move` | `{ folderId }` (`null` = top level) |
| `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id` | folders (`{ name, parentId? }`); deleting a folder that isn't empty answers 409 |
| `GET /api/executions[?workflowId]`, `GET /api/executions/:id` | history |
| `DELETE /api/executions/:id` | cancel a live or waiting run, or delete a finished one |
| `POST /api/executions/:id/rerun` | re-run in the background: the whole run, from a node, or one node |
| `POST /api/executions/:id/debug` | debugger: step / continue / stop, breakpoints |
| `POST /api/ai/build` | `{ prompt }` → a validated flow draft from the local model |
| `POST /api/assistant/suggest`, `POST /api/assistant/chat`, `POST /api/assistant/feedback` | editor assistant: after-run suggestions, the builder chat (SSE) and apply/dismiss feedback ([docs/assistant.md](docs/assistant.md#api)) |
| `POST /api/expressions/preview` | resolve an expression against sample items (the parameter editor's preview) |
| `GET/POST /api/plugins`, `PATCH/DELETE /api/plugins/:id`, `POST /api/plugins/:id/refresh`, `POST /api/plugins/scan` | registry |
| `POST/DELETE /api/plugins/announce` | plugin self-registration |
| `GET /api/node-types`, `POST /api/node-types/load-options` | catalog |
| `GET/POST /api/credentials`, `GET/PATCH/DELETE /api/credentials/:id` | credentials vault (secrets are never returned) |
| `POST /api/credentials/test` | `{ type, data, id? }` → `{ ok, message, durationMs }`, the plugin's connection test |
| `GET /api/credential-types` | credential types published by the plugins |
| `GET/POST /api/workflows/:id/polls` | polling-trigger status; `POST { nodeId }` polls now |
| `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`, `POST/DELETE /api/agents/:id/publish` | agents: draft, publish / unpublish ([docs/agents.md](docs/agents.md#api)) |
| `POST /api/agents/:id/chat`, `POST /api/agents/:id/sessions/:sid/approvals` | test chat and approvals, streamed as SSE |
| `GET /api/agents/:id/sessions[/:sid]`, `GET /api/agents/models`, `GET /api/agents/workflow-tools`, `POST /api/agents/import` | sessions, model picker, workflow tools, import |
| `GET/PATCH /api/settings`, `POST /api/settings/prune` | instance settings (`{ timezone, executions: { maxCount, maxAgeDays } }`) with stored and prunable execution counts; apply retention now → `{ removed, remaining }` |
| `GET/POST /api/variables`, `GET/PATCH/DELETE /api/variables/:key` | variables: `GET` lists `[{ key, value }]` sorted by key; `PATCH { key?, value? }` renames or changes one |
| `GET/POST /api/data-tables`, `GET/PATCH/DELETE /api/data-tables/:id` | data tables (`{ name, columns: [{ name, type }] }`); `GET :id` includes `rowCount` |
| `POST /api/data-tables/:id/columns`, `PATCH/DELETE /api/data-tables/:id/columns/:column` | add, rename (`{ name }`) or delete a column |
| `GET/POST/PATCH/DELETE /api/data-tables/:id/rows` | `GET ?offset&limit&sortBy&sortDirection&search&filter=<json>` → `{ rows, total }`; `POST { rows }`; `PATCH { filter, values }`; `DELETE { ids }` or `{ filter }` (an empty filter is refused) |
| `PATCH/DELETE /api/data-tables/:id/rows/:rowId`, `POST /api/data-tables/:id/rows/upsert` | change (`{ values }`) or delete one row; upsert `{ matchColumns, rows }` → `{ rows, inserted, updated }` |
| `POST /api/data-tables/:id/import`, `GET /api/data-tables/:id/export` | append rows from CSV (`text/csv` body, header row names the columns, missing ones are added unless `?createColumns=false`); download the table as CSV |
| `GET /api/insights?period=24h\|7d\|30d&includeManual=true`, `PATCH /api/insights/workflows/:id` | the Insights report; set `{ timeSavedMinutes }` (`null` clears) for a workflow |
| `GET /api/events` | SSE feed of registry, execution and agent events |
| `GET /api/metrics` | Prometheus metrics (see Observability) |
| `ANY /api/webhook/:path` | production webhooks (active workflows) |
| `ANY /api/waiting/:executionId` | resume a run waiting on a Wait node's webhook (`$execution.resumeUrl`); answers like the Wait node's Respond setting |
| `GET/POST /form/:path`, `GET/POST /form/waiting/:executionId` | hosted forms: a Form Trigger's form (active workflows), and the next Form page of a waiting run (HTML) |

## Configuration

| Variable | Default | |
|---|---|---|
| `LANDFLOW_DATA_DIR` | `apps/web/.data` | workflow and execution JSON store |
| `LANDFLOW_PUBLIC_URL` | `http://localhost:$PORT` | public base URL in the links the host hands out: resume URLs (`$execution.resumeUrl`, `resumeFormUrl`) and error workflow execution links |
| `GENERIC_TIMEZONE` | the host's zone | the instance's default time zone until one is chosen in Settings → General |
| `LANDFLOW_ENCRYPTION_KEY` | generated into `.data/encryption.key` | key for the credentials vault: 64 hex characters, or a passphrase (hashed with SHA-256) |
| `LANDFLOW_REGISTRY_GRPC_PORT` | `7070` | gRPC RegistryService (`off` to disable) |
| `LANDFLOW_PLUGINS` | – | static plugin endpoints |
| `LANDFLOW_SCAN_HOSTS` / `LANDFLOW_SCAN_PORTS` | `127.0.0.1` / `7100-7299` | pull discovery |
| `LANDFLOW_SCAN_ON_START` | `true` | scan at boot |
| `LANDFLOW_EXECUTE_TIMEOUT_MS` | `120000` | per remote Execute call |
| `ANTHROPIC_API_KEY` | – | for the Anthropic Chat Model |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | the Ollama used by the AI flow builder and the editor assistant |
| `LANDFLOW_BUILDER_MODEL` | `qwen3-coder:30b` | model the AI flow builder and the editor assistant use |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | OTLP/HTTP endpoint for traces and metrics, e.g. `http://localhost:4318`; unset: nothing is exported |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER[_ARG]`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_SDK_DISABLED` | standard | see docs/observability.md |
| `LANDFLOW_LOG_LEVEL` / `LANDFLOW_LOG_FORMAT` / `LANDFLOW_LOG_SPANS` | `info` / `json` / `true` | log level, `json` or `pretty`, one log line per finished span |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve `GET /api/metrics` |
| `LANDFLOW_TRACE_URL` | – | trace link template, e.g. `http://localhost:16686/trace/{traceId}` |
| plugin side: `LANDFLOW_REGISTRY_URL`, `LANDFLOW_ADVERTISE_HOST`, `LANDFLOW_HTTP_PORT`, `LANDFLOW_GRPC_PORT` | | see docs/protocol.md |

## Tests

```bash
pnpm test                                          # protocol/sdk/engine/plugin (vitest)
pnpm typecheck
for m in sdks/go plugins/go-crypto plugins/google-workspace plugins/databases; do (cd $m && go test ./...); done
plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests
(cd plugins/productivity && .venv/bin/python -m unittest discover -s tests)
pnpm gen:proto                                     # after editing plugin.proto (re-embeds + JSON Schema)
```

## Research

Agents read the source of the running n8n 2.44 container, its node catalogue and its docs. Their reports drove this design:

- [docs/research/01-n8n-node-interface.md](docs/research/01-n8n-node-interface.md): `INodeType`, the property vocabulary, loaders and lazy manifests
- [docs/research/02-n8n-workflow-engine.md](docs/research/02-n8n-workflow-engine.md): workflow JSON, `WorkflowExecute`, expressions and push events
- [docs/research/03-n8n-ai-agents.md](docs/research/03-n8n-ai-agents.md): cluster nodes, `supplyData`, tools and `$fromAI`, agent v3 and `@n8n/agents`
- [docs/research/04-n8n-integrations.md](docs/research/04-n8n-integrations.md): which of n8n's 445 integrations people use, how n8n shapes them, and the set Landflow builds

## Known limitations / next steps

- **Isolation**: expressions and the Code node run in `node:vm` with timeouts. That is not a security boundary; run untrusted code in a worker or sandbox.
- **Single host**: the file store, in-process scheduler and memory are fine for one instance. Postgres, leader election and a queue are the path to multi-instance. Data tables sit behind a storage interface, but the JSON-file backend holds each table in memory (50,000 rows, 32 MB); bigger tables need a SQL backend.
- **Integrations are tested against fakes**: every plugin's tests use local fakes of the service. Postgres has been checked against mocked SQL only, and MySQL against an in-process MySQL-compatible server, not real database servers. Switch and Text Classifier have a fixed set of outputs (4 plus a fallback), because ports can't yet depend on parameters. Drive transfers travel inside the item JSON (capped at 10 MB down, 5 MB up) until the protocol carries binary data.
- **Not yet built**: OAuth2 consent flows (credentials take tokens directly), webhook-based app triggers (app triggers poll), binary data, remote model/memory providers over the protocol (tools already work remotely), mDNS/Kubernetes discovery providers, n8n v3-style engine-driven agent steps with human-in-the-loop approval, and streaming partial outputs.
