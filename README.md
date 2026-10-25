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
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait  # host + 7 plugins + code runner on http://localhost:53000
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
- **Version history**: every save that changes the workflow records a version (the last 50 per workflow, identical saves are skipped) in the database. The panel lists them with a summary of what changed, previews a version read-only on the canvas, and restores it (the restore is a new version, so it can be undone the same way).
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
services/     code-runner: the Code node's sandbox (JavaScript and Python, one locked-down process per run)
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
- **Errors**: `onError: continue` (sent to the plugin as `continueOnFail`, so integrations turn a failing item into `{ error }` and keep the rest), `retryOnFail`/`maxTries`, a per-node `timeoutSeconds` (an attempt that takes longer fails with "Node timed out after N s" through the node's abort signal; retries and `continue` apply), disabled nodes pass data through, plus pin data, `executeOnce` and `alwaysOutputData`.
- **Live events**: `execution.started`, `node.started`, `node.finished` (with item counts and the run), `node.log` and `execution.finished`, streamed over SSE to light up the canvas.
- **Waiting executions**: a node can suspend the run (`ctx.putExecutionToWait`, in-process nodes). The engine returns status `waiting` with a JSON resume state; the host saves it under the same execution id and resumes it on the workflow version it started with, when its time comes (timers are re-armed at boot), on a call to `/api/waiting/<id>`, on a form submission, or when the sub-execution it waits for finishes. Waiting runs show as **Waiting** in the executions lists; `DELETE /api/executions/:id` cancels one.
- **Loops**: an edge back to an earlier node runs it again (Loop Over Items keeps per-node state for the execution, also across waits); `$('Node')` sees that node's latest run. Partial runs and "run up to here" work inside loops.
- **Workflow settings**: `timeoutSeconds` fails a run with "Workflow timed out after N s" (time spent waiting doesn't count); `saveSuccessfulExecutions`, `saveFailedExecutions` and `saveManualExecutions` (default on) drop runs from the history, though their events still stream; `errorWorkflowId` runs that workflow's Error Trigger when a non-manual run fails (unless an automatic retry follows); `timezone` is the Schedule trigger's zone; `callerPolicy` / `callerIds` decide which workflows may run this one; `concurrencyLimit`, `singleton`, `concurrencyOverflow`, `concurrencyQueueSize`, `retryMaxAttempts` and `retryBaseDelaySeconds` are the durable runtime's (below).

### Durable runtime

- **Store**: workflows, executions, poll state, versions, folders, settings, variables, waits, checkpoints, idempotency keys, retries and Data Tables live in SQLite at `<data dir>/landflow.db` (WAL mode, versioned migrations recorded in `schema_version`, `lib/server/db/`). `LANDFLOW_DB=postgres` with `DATABASE_URL` uses Postgres instead: the host loads the whole database into an in-memory copy at boot, serves reads from it and writes to Postgres in order through a queue that is spooled to `<data dir>/postgres-queue.jsonl` first (replayed at the next boot), so the store API stays synchronous. An advisory lock allows one host per database until Wave 4's queue mode. Credentials, the encryption key, insights and the agent files stay files. The first boot on a data directory with the JSON files of older versions imports them once and renames each to `<name>.imported-<date>` (nothing is deleted; the import is idempotent).
- **Saved as it runs**: an execution is saved when it starts, with the workflow version it runs (`versionId`; an unsaved editor draft keeps its graph instead), then every node run and a checkpoint after each main-flow node under a stable step id (`<nodeId>#<runIndex>`). At boot, executions left `running` by a crash or restart continue from their last checkpoint on the same version (tagged **Resumed after restart**; nodes before the checkpoint don't run again). Those that can't (their version is gone, a debug session, no checkpoint yet) are saved as failed with the reason.
- **Idempotency**: an `Idempotency-Key` header on a webhook or form call (or `idempotencyKey` on `POST /api/workflows/:id/run`) starts at most one run per workflow and key within `LANDFLOW_IDEMPOTENCY_TTL_HOURS` (default 24); a repeat gets the first run's answer with `Idempotent-Replayed: true`. Every Execute request also carries a per-step `idempotencyKey` (`<executionId>:<nodeId>:<runIndex>`, the same for retries of that step and after a restart) that plugins can pass to the APIs they call ([docs/protocol.md](docs/protocol.md)).
- **Concurrency**: `concurrencyLimit` caps a workflow's production runs (webhook, form, schedule, poll, error-workflow and agent-tool runs) at once, and `singleton` allows one, waiting runs included. A trigger run with no free slot waits in the workflow's FIFO queue (status **Queued**, at most `concurrencyQueueSize`, default 100; it survives a restart) or, with `concurrencyOverflow: 'skip'`, is skipped (webhooks and forms answer 429). Manual and chat runs from the editor, debug runs, sub-executions, re-runs and retries are never held back.
- **Retries**: with `retryMaxAttempts` of 2 or more, a failed production run is retried automatically after `retryBaseDelaySeconds` (default 30), doubling per attempt up to 6 hours; retries survive a restart. Each retry is a new execution linked to the failed one (`retryOf`, `retryAttempt`, and `retriedBy` on the failed run) that continues from the failed node, reusing what ran before it. **Retry** on a failed execution (`POST /api/executions/:id/retry`) does the same by hand, or from the start.
- **Stop all**: the Executions page's **Stop all** (`POST /api/executions/stop-all`) aborts running executions, cancels waiting and queued ones and drops pending automatic retries.

### Triggers and flow nodes

- **Webhook** (`/api/webhook/<path>`): **Respond** immediately (202 with the execution id), when the last node finishes (its output as JSON), or using a **Respond to Webhook** node (first item, all items, JSON, text, no data or a redirect, with status code and headers; sent when that node runs while the run goes on). A run that starts waiting before it answers returns `{ status: "waiting", executionId }`. An `Idempotency-Key` header makes retried calls safe (see Durable runtime); a workflow at its concurrency limit queues the call's run (`status: "queued"`) or answers 429.
- **On Form Submission** (`core.formTrigger`) and **Form** (`core.form`): server-rendered forms (text, textarea, number, email, password, date, dropdown, checkboxes, radio buttons; required fields, placeholders, button label) at `/form/<path>` while the workflow is active. A submission becomes `{ <field>: value, submittedAt, formMode }`. The trigger answers on submit or when the workflow finishes; each Form page makes the run wait at `/form/waiting/<executionId>`, and a Form ending shows a message or redirects.
- **Schedule**: n8n's Trigger Rules (every N seconds, minutes, hours at a minute, days, weeks on weekdays or months on a day, at a time of day, or a five- or six-field cron), in the workflow's time zone, else the server's. Older "every N seconds / minutes / hours" schedules keep counting from activation.
- **Error Trigger**: the start of an error workflow; it receives n8n's `{ execution: { id, url, error, lastNodeExecuted, mode, retryOf? }, workflow: { id, name } }`.
- **When Called by a Workflow or Agent** (`core.workflowTrigger`): defined arguments or "accept all data"; called by an agent tool or by **Execute Workflow**, which runs the workflow once or once per item, maps arguments or passes items through, waits for it (or not) and returns its last node's output. The child is its own execution linked to the parent (`parentExecutionId`), at most 10 levels deep; if it starts waiting, the parent waits too and resumes with its output.
- **Wait**: a time interval, a date and time, a webhook call (`$execution.resumeUrl`) or a form (`$execution.resumeFormUrl`), with an optional time limit. Waits up to ~65 s stay in memory; longer ones suspend the run.
- **Loop Over Items** (Split in Batches v3): batches on its "loop" output, everything that came back on "done".

### Code node

JavaScript or Python, run once for all items or once for each item, as in n8n. Code can run in two places:

- **Sandbox**: the code runner ([services/code-runner](services/code-runner)), a fresh locked-down process per run, normally in its own container with no network. JavaScript gets n8n's globals: `$input.all()`, `.first()`, `.last()`, `.item`, `$json`, `$('Node').all()/.first()/.item`, `$vars`, `$execution`, `$workflow`, `$now`/`$today` and Luxon's `DateTime`, plus `await`. Python (CPython, standard library only) gets `_input`, `_json`, `_('Node')`, `_vars`, `_execution`, `_now` and so on. `console.log`/`print` go to the node's logs, and errors carry the line (`TypeError: … [line 3, for item 0]`). Python always runs here.
- **In-process**: JavaScript in a `node:vm` context of the host (`items`, `$json`, `$input`, `$vars`), as before. It isn't isolated.

With `LANDFLOW_CODE_RUNNER_URL` and `LANDFLOW_CODE_RUNNER_SECRET` set, **Run In: Default** means the sandbox; `LANDFLOW_CODE_IN_PROCESS=false` turns in-process code off altogether, as the Docker stack does. Start a runner with `CODE_RUNNER_SECRET=dev pnpm --filter code-runner dev` (port 7300) or the Docker one (`127.0.0.1:53300`). How it is locked down, and how to check that, is in [deploy/README.md, "Code runner"](deploy/README.md#code-runner).

## AI agents

The **AI Agent** is a root node with typed sub-node ports (`ai_languageModel` required/max 1, `ai_memory`, `ai_tool`), following n8n's cluster nodes. Models are provider-neutral `LanguageModel` adapters:

- **Ollama Chat Model** works locally with no API key, and its model list loads live via `loadOptions`.
- **Anthropic Chat Model** defaults to `claude-opus-5-5` with effort control and server-side refusal fallback. It uses `ANTHROPIC_API_KEY` or an `ant auth login` profile, and replays Claude's content blocks verbatim across tool turns.

**Any `usableAsTool` node becomes a tool, including remote plugins in any language.** The tool schema comes from the plugin's `toolInputSchema`, from n8n-style `{{ $fromAI('key', 'description', 'type') }}` placeholders, or from a heuristic. Tool calls in a turn run concurrently, and each call is recorded as its own sub-node run, so tool nodes light up on the canvas and the timeline shows model, tool and memory calls.

**Model fallback**: the AI Agent, Basic LLM Chain, Text Classifier, Information Extractor and Question and Answer Chain have n8n's **Enable Fallback Model** switch. It shows a second chat-model slot (`ai_languageModel` port 1); when a call to the first model throws, the same call is retried on the fallback, logged as a warning and marked with a `landflow.ai.fallback` span event. The agent's output says which model answered (`model`, `fallbackUsed`).

### Retrieval (RAG)

n8n's RAG cluster nodes, with the same names and modes:

- **Vector stores**: **In-Memory** (`core.vectorStoreInMemory`, until the server restarts), **SQLite** (`core.vectorStoreSqlite`, `vectors.sqlite` in the data folder) and **Postgres PGVector** (`core.vectorStorePGVector`, a `Postgres` credential; it creates the extension, table and index). Each works in four modes, and its ports follow the mode: **Insert Documents** and **Get Many** in the main flow, **Retrieve Documents (As Tool for AI Agent)** on `ai_tool`, and **(As Retriever for Chain)** on `ai_retriever`. Documents live in named collections; searches are by vector (cosine) or **hybrid** (vector plus BM25 / Postgres full-text, fused with reciprocal rank fusion, k = 60), with exact-match metadata filters.
- **Embeddings Ollama** (nomic-embed-text, mxbai-embed-large…, with optional `search_document:` / `search_query:` prefixes) and **Embeddings OpenAI** (any OpenAI-compatible API) on `ai_embedding`.
- **Default Data Loader** (`ai_document`): all input data or one expression per item, metadata per item, and a built-in splitter or a **Recursive Character** / **Token Text Splitter** (`ai_textSplitter`, with code and Markdown presets).
- **Reranker (LLM)** (`ai_reranker`): the attached chat model scores the candidates and the store keeps the best; turn on **Rerank Results** on the store.
- **Question and Answer Chain** (`core.chainRetrievalQa`): answers from what its retriever finds, optionally with the source documents.

A vector store dropped on an agent's Tool slot switches itself to "As Tool". Agents (below) take a collection as a **knowledge base**.

### Guardrails

The **Guardrails** node (`core.guardrails`) follows n8n's: **Check Text for Violations** sends each item to **Pass** or **Fail**, **Sanitize Text** replaces what it finds and sends every item on. Checks: PII (email, phone, Luhn-checked card numbers, checksum-verified IBANs, IPv4/IPv6, US SSN, crypto wallets), secret keys (known key formats, assignments, high-entropy strings, at three strictness levels), keywords, URLs outside an allow-list (schemes, subdomains, credentials in URLs), custom regex, jailbreak / prompt-injection heuristics, and checks the optional chat model judges (jailbreak, topical alignment, NSFW, custom rules) with a threshold. Sanitizing redacts (`<EMAIL_ADDRESS>`) or masks (`j***@example.com`, `****-****-****-4242`). Reports carry masked matches only, and a model check that can't run counts as a violation.

### Agents (Preview)

**Agents** (sidebar) are standalone assistants modelled on n8n's Agents tab ([docs/agents.md](docs/agents.md)). An agent has:
- a model (Anthropic, any OpenAI-compatible API, or Ollama) and instructions;
- [skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) it loads on demand;
- capabilities: any plugin action node, workflows that start with **When Called by an Agent**, other agents as sub-agents, MCP servers (each tool the server lists), and knowledge bases (a vector store collection searched with a tool). Each capability can require a person's approval.
- session memory, plus optional cross-session memory per user.

You test it in a chat that streams tool calls and approval cards, then publish it as a version. The published version runs on schedules (cron, in a time zone), answers in Telegram, and is callable from workflows through the **Message an Agent** node. Every run is an `invoke_agent` trace with `execute_tool` and `gen_ai.chat` children.

### MCP

Landflow speaks the [Model Context Protocol](https://modelcontextprotocol.io) both ways, with the official TypeScript SDK. Node and credential names follow n8n's.

- **MCP Client Tool** (`core.mcpClientTool`, an `ai_tool` sub-node) gives an AI Agent the tools of an MCP server: Streamable HTTP or the older SSE transport, no auth, a **Bearer Auth** or a **Header Auth** credential, and all tools, the selected ones or all except some (the pickers load the server's tool list). Each MCP tool becomes an agent tool with the server's name, description and JSON schema. Connections are pooled per server and credential, closed after 30 s idle, and reconnected once when the server forgot the session.
- **MCP Client** (`core.mcpClient`) calls one tool per item in the main flow and outputs `{ tool, text, content, structuredContent? }`.
- **Agents** take MCP servers as a capability (Capabilities → **Add MCP server**), with the same settings.
- **MCP Server Trigger** (`core.mcpTrigger`) serves the tools attached to its `ai_tool` input (any tool sub-node, or a node used as a tool such as **Execute Workflow**, whose arguments come from `$fromAI()`) at `/mcp/<path>`, over Streamable HTTP, with optional bearer or header auth. Only active workflows answer; there is no test URL. `tools/list` runs the trigger alone and isn't recorded; each `tools/call` is an execution with mode `mcp`. The node panel shows the URL to copy (the Webhook and Form triggers show theirs too).
- **Instance MCP server** at `/api/mcp`, for coding agents such as Claude Code: list, read, create, update and validate workflows; list and search node types and read a type's parameters; execute a workflow with input and get the result; list executions and read one. It is off by default. **Settings → MCP** turns it on, shows the access token once (regenerate for a new one) and the client config, for example:

  ```bash
  claude mcp add --transport http landflow http://localhost:3000/api/mcp --header "Authorization: Bearer <token>"
  ```

Both servers are stateless (a fresh server per request, JSON responses), so they need no session affinity; GET and DELETE answer 405.

## Integrations

The integrations people use most in n8n, chosen from its catalogue and public usage data ([research](docs/research/04-n8n-integrations.md)), are built as plugins, one per language family, with n8n's resource → operation shape, names and options (Return All / Limit, Simplify, live pickers, usable as AI tools):

| Plugin | Language, ports | Nodes | Credentials |
|---|---|---|---|
| `core` (in the host) | TypeScript, in-process | Switch, Split Out, Aggregate, Remove Duplicates, Summarize, Rename Keys, Date & Time, Record Metric, Read/Write Files from Disk, Extract from File, Convert to File; OpenAI Chat Model (any OpenAI-compatible API, Ollama's `/v1` included), OpenAI (message a model, embeddings), Basic LLM Chain, Text Classifier, Information Extractor; RAG (vector stores, embeddings, data loader, text splitters, reranker, Question and Answer Chain), Guardrails | OpenAI API, Anthropic API, Postgres |
| [`messaging`](plugins/messaging) | TypeScript, 7104/7204 | Telegram, **Telegram Trigger**, Slack, Discord, WhatsApp Business Cloud, Send Email (SMTP) | Telegram, Slack, Discord bot and webhook, WhatsApp, SMTP |
| [`productivity`](plugins/productivity) | Python, 7105/7205 | Notion, Airtable, GitHub, **GitHub Trigger**, Jira Software, HubSpot, RSS Read, **RSS Feed Trigger** | Notion, Airtable, GitHub, Jira Cloud and Server (PAT), HubSpot |
| [`google`](plugins/google-workspace) | Go, 7106/7206 | Google Sheets, **Sheets Trigger**, Gmail, **Gmail Trigger**, Google Drive, Google Calendar, Google Docs | Service account (JWT, optional impersonation), OAuth2 refresh token |
| [`databases`](plugins/databases) | Go, 7107/7207 | Postgres, MySQL, SQLite, Redis, **Postgres Trigger**, **SQLite Trigger** | Postgres, MySQL, Redis, SQLite |

Run them with `pnpm plugin:messaging`, `plugin:productivity`, `plugin:google` and `plugin:databases` (all included in `pnpm dev:all`). Every credential has an overridable base URL or host, so each plugin's tests run against local fakes of the service; no test needs a real account.

**Credentials.** Plugins declare credential types (fields, secrets, a connection test) in their manifest. The host keeps saved credentials in an AES-256-GCM vault (`.data/credentials.json`, key from `LANDFLOW_ENCRYPTION_KEY` or a generated `.data/encryption.key`). Workflows only reference them by id, the API never returns secrets, and each Execute call carries just the decrypted credentials that node declared. The **Credentials** page and the picker at the top of a node's parameters create, edit and test them ("Authenticated as @landflow_bot"). The SDKs mask credential values in logs, span attributes and error messages.

**Polling triggers.** A node with `triggerSource: "poll"` is called by the host every `pollInterval` seconds with the state it returned last time, and a run starts only when it returns new items. The first poll records a baseline, so activating a workflow never replays history; **Execute** in the editor shows the latest few items. The node panel shows the poll status (last poll, new items, errors) with **Poll now**.

## Settings, variables, data tables and insights

- **Settings** (bottom of the sidebar) → **General**: the instance's default time zone (schedules, Date & Time nodes and the days in Insights; until you pick one, `GENERIC_TIMEZONE` or the host's) and execution retention. Retention keeps at most N finished executions (default 300) and/or drops those older than D days (0 = off). It applies whenever an execution is saved, at boot and every hour, and never touches running or waiting executions; **Prune now** applies it on demand. Stored in the database.
- **Settings → Variables**: instance-wide string values (in the database, keys like `API_BASE`). Read them as `{{ $vars.API_BASE }}` in any expression, as `$vars` in the Code node and in AI tool parameters. Unknown names resolve to `undefined`. Variables aren't secrets; keep secrets in credentials.
- **Data tables** (sidebar): tables of typed columns (string, number, boolean, date) plus `id`, `createdAt` and `updatedAt`. The grid edits cells in place, adds, renames and deletes columns, and searches, sorts, pages, deletes selected rows and imports or exports CSV. The **Data Table** node (`core.dataTable`, usable as an AI tool) inserts, gets, updates, upserts and deletes rows, with all/any conditions (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `isEmpty`, `isNotEmpty`), mapping columns one by one or straight from the input, and a dry run. A run that writes to one table is all-or-nothing. Rows live in the database (one row per table row, written row by row), at most 50,000 per table; the JSON-file storage (one file per table, also capped at 32 MB) remains as an alternative backend.
- **Insights** (sidebar): runs, failed runs, failure rate, time saved and average run time for the last 24 hours, 7 or 30 days against the period before; runs per hour or day; and a sortable row per workflow. Manual runs (editor and chat tests) are left out unless **Include manual runs** is on. Time saved = successful runs × the workflow's minutes saved per run (`settings.timeSavedMinutes`, editable in the table). Counts come from a rollup (`.data/insights.json`) updated as each execution is saved, so pruning executions doesn't change them. It is filled from the stored executions on first boot and keeps 400 days.

## Files and binary data

Items carry files next to their JSON: `item.binary.<name>` is a reference (`{ id, mimeType, fileName, fileExtension, fileSize, fileType }`), never the bytes, so files of any size move through a workflow without bloating executions ([docs/protocol.md §11](docs/protocol.md#11-binary-data)). The bytes live in the **binary store**: `<data dir>/binary/<execution id>/` by default, or S3 / MinIO with `LANDFLOW_BINARY_STORE=s3`. Files belong to their execution and are deleted with it (retention, **Delete**, or an hourly sweep of orphans).

- **Nodes**: Read/Write Files from Disk (only under `LANDFLOW_FILES_DIR`), Extract from File (CSV, XLSX, HTML tables, JSON, text, PDF text, base64), Convert to File (CSV, HTML, JSON, text, base64 → file), HTTP Request (Response Format **File**, autodetected for PDFs, images and octet-stream; multipart bodies with item files or one file as the raw body), Respond to Webhook (**Binary File**), and nodes like Edit Fields, Merge and Loop Over Items keep the files of their items.
- **Uploads**: the Webhook trigger stores multipart files (`files[]` → `files`, several → `files0`, `files1`…) and non-text bodies (or any body with **Raw Body**) as `item.binary`; Form Trigger and Form pages have a **File** element. Uploads past `LANDFLOW_BINARY_MAX_BYTES` get 413.
- **Plugins** read and write files through the host's `/api/binary` with a short-lived token that comes with each call; the SDK helpers hide that: `ctx.helpers.getBinaryDataBuffer` / `prepareBinaryData` (TypeScript), `ctx.BinaryBytes` / `ctx.PrepareBinary` (Go), `ctx.get_binary_bytes` / `ctx.prepare_binary_data` (Python). Small files (≤ 64 KiB) can travel inline. Gmail sends item files as attachments; Telegram uploads photos, documents, audio and video and downloads files.
- **UI**: the run view's **Binary** tab lists each item's files with a preview (images, PDF, audio, video, text) and a download link.

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
| `POST /api/workflows/:id/run` | run (optionally with unsaved `workflow`, `chat`, `items`, and an `idempotencyKey` or `Idempotency-Key` header) and stream SSE events |
| `POST /api/workflows/import` | `{ data, name?, folderId?, create? }` → `{ workflow, report }`: converts Landflow or n8n workflow JSON (placeholders for unknown n8n nodes); `create: false` converts without saving |
| `GET /api/workflows/:id/versions`, `GET /api/workflows/:id/versions/:versionId` | version history (summaries, newest first) and one version with its workflow |
| `POST /api/workflows/:id/versions/:versionId/restore` | restore a version (keeps the current name, tags, folder and active state) and record it as a new version |
| `POST /api/workflows/:id/move` | `{ folderId }` (`null` = top level) |
| `GET/POST /api/folders`, `PATCH/DELETE /api/folders/:id` | folders (`{ name, parentId? }`); deleting a folder that isn't empty answers 409 |
| `GET /api/executions[?workflowId]`, `GET /api/executions/:id` | history |
| `DELETE /api/executions/:id` | cancel a live, waiting or queued run, or delete a finished one |
| `POST /api/executions/:id/rerun` | re-run in the background: the whole run, from a node, or one node |
| `POST /api/executions/:id/retry` | retry a failed (or canceled) run in the background, linked to it: `{ from: 'failed' \| 'start', version: 'original' \| 'current' }` (defaults: from the failed node, original version) → 202 `{ executionId }` |
| `POST /api/executions/stop-all` | abort every running execution, cancel waiting and queued ones, drop pending automatic retries → `{ running, waiting, queued, retries }` |
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
| `ANY /api/webhook/:path` | production webhooks (active workflows); `Idempotency-Key` header supported |
| `GET/HEAD /api/binary/:id`, `POST /api/binary` | a stored file (`?download=1` for an attachment); plugins upload with `Authorization: Bearer <binaryAccess.token>` and `X-Landflow-File-Name` → 201 with the ref (docs/protocol.md §11) |
| `ANY /api/waiting/:executionId` | resume a run waiting on a Wait node's webhook (`$execution.resumeUrl`); answers like the Wait node's Respond setting |
| `GET/POST /form/:path`, `GET/POST /form/waiting/:executionId` | hosted forms: a Form Trigger's form (active workflows), and the next Form page of a waiting run (HTML) |
| `POST /mcp/:path` | an MCP Server Trigger's tools over Streamable HTTP (active workflows; 404 otherwise, 401 when its auth fails) |
| `POST /api/mcp` | the instance MCP server (403 while off, 401 without `Authorization: Bearer <token>`) |
| `GET/PATCH/POST /api/settings/mcp` | Settings → MCP: state; `PATCH { enabled }`; `POST` replaces the token. A response that created a token carries it as `token`, once |

## Configuration

| Variable | Default | |
|---|---|---|
| `LANDFLOW_DATA_DIR` | `apps/web/.data` | data directory: the SQLite database (`landflow.db`), credentials, binary files and the other host files |
| `LANDFLOW_DB` | `sqlite` | `postgres` keeps the store in Postgres (`DATABASE_URL`); one host per database |
| `DATABASE_URL` | – | Postgres connection string for `LANDFLOW_DB=postgres`, e.g. the infra stack's `postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow` |
| `LANDFLOW_IDEMPOTENCY_TTL_HOURS` | `24` | how long trigger idempotency keys are remembered |
| `LANDFLOW_PUBLIC_URL` | `http://localhost:$PORT` | public base URL in the links the host hands out: resume URLs (`$execution.resumeUrl`, `resumeFormUrl`) and error workflow execution links |
| `GENERIC_TIMEZONE` | the host's zone | the instance's default time zone until one is chosen in Settings → General |
| `LANDFLOW_ENCRYPTION_KEY` | generated into `.data/encryption.key` | key for the credentials vault: 64 hex characters, or a passphrase (hashed with SHA-256) |
| `LANDFLOW_REGISTRY_GRPC_PORT` | `7070` | gRPC RegistryService (`off` to disable) |
| `LANDFLOW_PLUGINS` | – | static plugin endpoints |
| `LANDFLOW_SCAN_HOSTS` / `LANDFLOW_SCAN_PORTS` | `127.0.0.1` / `7100-7299` | pull discovery |
| `LANDFLOW_SCAN_ON_START` | `true` | scan at boot |
| `LANDFLOW_EXECUTE_TIMEOUT_MS` | `120000` | per remote Execute call (and per call to the code runner) |
| `LANDFLOW_CODE_RUNNER_URL` | – | the Code node's sandbox, e.g. `http://127.0.0.1:7300` (pnpm) or `http://127.0.0.1:53300` (Docker); set: the sandbox is the default and Python works |
| `LANDFLOW_CODE_RUNNER_SECRET` | – | shared secret, the runner's `CODE_RUNNER_SECRET` |
| `LANDFLOW_CODE_IN_PROCESS` | `true` | `false`: no in-process (`node:vm`) JavaScript; every Code node needs the runner |
| `ANTHROPIC_API_KEY` | – | for the Anthropic Chat Model |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | the Ollama used by the AI flow builder and the editor assistant, and the default of the Ollama chat and embeddings nodes |
| `LANDFLOW_BUILDER_MODEL` | `qwen3-coder:30b` | model the AI flow builder and the editor assistant use |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | OTLP/HTTP endpoint for traces and metrics, e.g. `http://localhost:4318`; unset: nothing is exported |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER[_ARG]`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_SDK_DISABLED` | standard | see docs/observability.md |
| `LANDFLOW_LOG_LEVEL` / `LANDFLOW_LOG_FORMAT` / `LANDFLOW_LOG_SPANS` | `info` / `json` / `true` | log level, `json` or `pretty`, one log line per finished span |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve `GET /api/metrics` |
| `LANDFLOW_TRACE_URL` | – | trace link template, e.g. `http://localhost:16686/trace/{traceId}` |
| `LANDFLOW_BINARY_STORE` | `filesystem` | where files live: `filesystem` or `s3` |
| `LANDFLOW_BINARY_DIR` | `<data dir>/binary` | the filesystem store's directory |
| `LANDFLOW_S3_BUCKET`, `LANDFLOW_S3_ENDPOINT`, `LANDFLOW_S3_REGION`, `LANDFLOW_S3_ACCESS_KEY_ID`, `LANDFLOW_S3_SECRET_ACCESS_KEY`, `LANDFLOW_S3_FORCE_PATH_STYLE`, `LANDFLOW_S3_PREFIX` | – / AWS / `us-east-1` / AWS chain / AWS chain / `true` / `binary/` | the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`) |
| `LANDFLOW_BINARY_MAX_BYTES` | `268435456` (256 MiB) | largest stored file or upload (413 above it) |
| `LANDFLOW_BINARY_MAX_INLINE_BYTES` | `16777216` (16 MiB) | largest inline (base64) file a node may return |
| `LANDFLOW_BINARY_SECRET` | random per process | key that signs plugins' binary tokens; set it when several host processes serve one store |
| `LANDFLOW_INTERNAL_URL` | `http://127.0.0.1:$PORT` | the host URL plugins use for `/api/binary` (e.g. `http://web:3000` in Docker) |
| `LANDFLOW_FILES_DIR` | `<data dir>/files` | the only directory Read/Write Files from Disk may use |
| plugin side: `LANDFLOW_REGISTRY_URL`, `LANDFLOW_ADVERTISE_HOST`, `LANDFLOW_HTTP_PORT`, `LANDFLOW_GRPC_PORT` | | see docs/protocol.md |

## Tests

```bash
pnpm test                                          # protocol/sdk/engine/plugin/code-runner (vitest)
pnpm typecheck
deploy/scripts/smoke.sh code                       # the dockerised code runner: health + network/file-system isolation
for m in sdks/go plugins/go-crypto plugins/google-workspace plugins/databases; do (cd $m && go test ./...); done
plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests
(cd plugins/productivity && .venv/bin/python -m unittest discover -s tests)
pnpm gen:proto                                     # after editing plugin.proto (re-embeds + JSON Schema)
(cd apps/web && LANDFLOW_INTEGRATION=postgres,ollama npx vitest run test/pgvector.test.ts test/postgres.test.ts test/rag-live.test.ts)
```

`LANDFLOW_INTEGRATION` turns on tests against real services: `postgres` (PGVector against the infra stack's `landflow_test` database, or `LANDFLOW_PG_URL`; the Postgres store in that database's `landflow_runtime_test` schema, or `LANDFLOW_TEST_DATABASE_URL`) and `ollama` (nomic-embed-text and qwen3-coder:30b at `OLLAMA_URL`).

## Research

Agents read the source of the running n8n 2.44 container, its node catalogue and its docs. Their reports drove this design:

- [docs/research/01-n8n-node-interface.md](docs/research/01-n8n-node-interface.md): `INodeType`, the property vocabulary, loaders and lazy manifests
- [docs/research/02-n8n-workflow-engine.md](docs/research/02-n8n-workflow-engine.md): workflow JSON, `WorkflowExecute`, expressions and push events
- [docs/research/03-n8n-ai-agents.md](docs/research/03-n8n-ai-agents.md): cluster nodes, `supplyData`, tools and `$fromAI`, agent v3 and `@n8n/agents`
- [docs/research/04-n8n-integrations.md](docs/research/04-n8n-integrations.md): which of n8n's 445 integrations people use, how n8n shapes them, and the set Landflow builds

## Known limitations / next steps

- **Isolation**: expressions and in-process Code nodes run in `node:vm` with timeouts. That is not a security boundary. Code you don't trust belongs in the code runner's container (see [deploy/README.md](deploy/README.md#code-runner)); started with pnpm, the runner only has OS limits.
- **Single host**: the store runs on SQLite or Postgres, but the scheduler, waits, retries, the concurrency queue and crash recovery run in one process, and Postgres mode keeps the whole database in memory and takes an advisory lock so a second host refuses to start. Leader election and a queue (Wave 4) are the path to multi-instance. Checkpoints add a write per node run (Postgres mode also appends it to the spool). The SQL Data Tables storage still caches a table's rows in memory when it is used (50,000 rows per table).
- **Integrations are tested against fakes**: every plugin's tests use local fakes of the service. Postgres has been checked against mocked SQL only, and MySQL against an in-process MySQL-compatible server, not real database servers. Switch and Text Classifier have a fixed set of outputs (4 plus a fallback): ports can be shown or hidden by parameters, but not repeated per rule. Google Drive transfers still travel inside the item JSON (capped at 10 MB down, 5 MB up); the protocol carries binary data now, but the Drive node hasn't moved to it yet.
- **Not yet built**: OAuth2 consent flows (credentials take tokens directly), webhook-based app triggers (app triggers poll), remote model/memory providers over the protocol (tools already work remotely), mDNS/Kubernetes discovery providers, n8n v3-style engine-driven agent steps with human-in-the-loop approval, and streaming partial outputs.
