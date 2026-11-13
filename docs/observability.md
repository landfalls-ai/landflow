# Observability

Every Landflow process (the host and every plugin, whatever its language) is instrumented with
**OpenTelemetry**. One workflow execution is one trace: the host's execution span, a span per
node run, the RPC to the plugin, the plugin's own server span and the plugin's outbound calls
(Slack API, Postgres query…) all share a trace id. Every log line carries that trace id. Built-in
metrics cover flows, jobs (triggers, schedules, polls) and services (plugins, RPCs, AI calls), and
both node authors and workflow authors can add their own metrics.

This document is the contract. The host and the three SDKs implement the same names.

## 1. Configuration

Standard OpenTelemetry environment variables, plus a few Landflow ones. They are the same for the
host and for plugins.

| Variable | Default | |
|---|---|---|
| `OTEL_SERVICE_NAME` | host: `landflow-host`; plugin: `landflow-plugin-<pluginId>` | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | e.g. `http://localhost:4318`. Unset: spans and metrics are still recorded (logs, `/metrics`) but not exported |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_HEADERS`, `…_PROTOCOL` | standard | OTLP over HTTP/protobuf (`http/protobuf`) is the default; `grpc` where the SDK supports it. The host and the TypeScript SDK (plugins) send OTLP/HTTP **JSON** (`http/json`, same port and `/v1/*` paths), which the Collector and Jaeger accept; the host logs a warning when `OTEL_EXPORTER_OTLP_PROTOCOL` asks for anything else. `OTEL_EXPORTER_OTLP_TRACES_EXPORTER=none` / `…_METRICS_EXPORTER=none` turn off one signal |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | standard |
| `OTEL_RESOURCE_ATTRIBUTES` | – | standard, e.g. `deployment.environment=dev` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | ms between OTLP metric exports |
| `OTEL_SDK_DISABLED` | `false` | `true` turns all telemetry into no-ops |
| `LANDFLOW_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `LANDFLOW_LOG_FORMAT` | `json` | `json` (one object per line) or `pretty` (human-readable, still with ids) |
| `LANDFLOW_LOG_SPANS` | `true` | write one log line per finished span (see §3) |
| `LANDFLOW_LOG_OTLP` | `true` | host: with an OTLP endpoint, also export every log line (but the `span.end` lines) as an OTel log record (see §3) |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve Prometheus text: host `GET /api/metrics`, plugins `GET /metrics` on their HTTP port |
| `LANDFLOW_TRACE_URL` | – | host UI only: link template for a trace, e.g. `http://localhost:16686/trace/{traceId}` (Jaeger) or a Grafana Tempo URL |
| `NEXT_OTEL_FETCH_DISABLED` | host: `1` | Next.js' own `fetch` spans stay off: the host already opens `plugin.rpc` and `gen_ai.chat` client spans for its outbound calls. Set `0` to get them back |

**Resource attributes** on every span and metric: `service.name`, `service.version`,
`service.namespace=landflow`, and for plugins `landflow.plugin.id`, `landflow.plugin.language`,
plus `telemetry.sdk.*` and whatever `OTEL_RESOURCE_ATTRIBUTES` adds.

## 2. Trace context propagation ("metadata")

W3C Trace Context and Baggage: `traceparent`, `tracestate`, `baggage`.

| Hop | Carried in |
|---|---|
| Browser / client → host API | HTTP headers (an incoming `traceparent` is continued) |
| Host → plugin, HTTP binding | HTTP headers on `/landflow/v1/*` |
| Host → plugin, gRPC binding | gRPC metadata (lower-case keys) |
| Plugin → external API | HTTP headers, through the SDK's instrumented HTTP client |
| Plugin → host (announce, heartbeat) | headers/metadata; the host does not open spans for heartbeats |

The host also returns `traceparent` in API responses that start or run an execution
(`POST /api/workflows/:id/run`, `POST /api/executions/:id/rerun`, webhooks), and stores the trace
id on the execution record (`ExecutionRecord.traceId`) and the span id on each node run
(`NodeRun.spanId`), so the UI can link to the trace. `GET /api/executions/:id` adds `traceUrl`
when `LANDFLOW_TRACE_URL` is set; the execution view shows the trace id with a copy button and
that link.

**No spans** for health checks, heartbeats, manifest polling or the SSE event stream: they would
drown the useful traces. They are counted in metrics instead. On the host, a request is traced
when it is an API request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) or any
webhook request. Read-only API requests (`GET`/`HEAD`/`OPTIONS`, which the UI polls), pages and
assets, `/api/events`, `/api/health`, `/api/metrics` and `/api/plugins/announce` get no trace.
Their server spans are still recorded but not sampled, so they still count in
`http.server.request.duration`. An announce that (re-)registers a plugin starts its own
`registry.register` trace.

## 3. Logs

One JSON object per line on stdout. Every line written while a span is active carries its ids.

```json
{"ts":"2026-10-25T10:00:00.123Z","level":"info","service":"landflow-plugin-messaging","msg":"telegram sendMessage ok","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","landflow.node.type":"messaging.telegram","landflow.execution.id":"ex_8h2…"}
```

With `LANDFLOW_LOG_SPANS=true` (the default) every finished span is also written as a log line:

```json
{"ts":"…","level":"info","service":"landflow-host","msg":"span.end","span":"node.execute messaging.telegram","kind":"internal","trace_id":"…","span_id":"…","parent_span_id":"…","duration_ms":182.4,"status":"ok","attributes":{"landflow.node.name":"Notify team","landflow.items.in":3,"landflow.items.out":3}}
```

- `level` is `error` for spans with error status, plus an `error` field holding the message.
- Field names: `ts`, `level`, `service`, `msg`, `trace_id`, `span_id`, then attributes flattened
  with their OTel names. `pretty` format prints `HH:MM:SS level service msg (trace=…/span=…) k=v`.
- **Never log** credential values, `Authorization` headers or item payloads. Log counts and ids. The
  host and the SDKs redact attribute keys matching `/(token|secret|password|authorization|api[-_]?key|cookie)/i`
  when the value is a string (numbers and booleans such as `gen_ai.usage.input_tokens` are kept), in
  log fields and span attributes alike. The SDKs also replace the credential values of the current
  request wherever they appear (messages, URLs, errors).
- Node logs (`ctx.logger.*` / `ExecuteResponse.logs`) are also written to the process log with the
  trace context, besides being returned to the host.
- **Over OTLP** (host): with `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) set and
  `LANDFLOW_LOG_OTLP` on (the default), every line is also an OTel log record (scope `landflow-host.log`, the message as
  the body, the fields as attributes, the active trace and span ids), so a backend such as Loki links each line to its
  trace. `span.end` lines are left out (the spans themselves are exported); audit events are their own records
  ([audit](features/audit-and-governance.md)). `OTEL_LOGS_EXPORTER=none` turns all of it off.

## 4. Spans

Span names are low-cardinality (`node.execute core.httpRequest`, never a user-chosen name). The
details go into attributes. Attribute names use the `landflow.` namespace or the OTel semantic
conventions.

### Host (`landflow-host`)

| Span | Kind | Attributes |
|---|---|---|
| `{METHOD} {route}` (e.g. `POST /api/workflows/[id]/run`) | server | `http.request.method`, `url.path` (no query string), `http.route`, `http.response.status_code` (Next.js also sets the older `http.method`, `http.target`, `http.status_code`). Created by Next.js' built-in OpenTelemetry support, which adds one child, `executing api route (app) {route}`; its other internal spans are dropped |
| `workflow.execute` | internal | `landflow.workflow.id`, `landflow.workflow.name`, `landflow.execution.id`, `landflow.execution.mode`, `landflow.execution.status` (also `waiting`), `landflow.execution.debug`, `landflow.execution.rerun_of`, `landflow.execution.rerun_scope` · a run that stops to wait: `landflow.wait.node`, `landflow.wait.resume` (`time`/`webhook`/`form`/`subworkflow`), `landflow.wait.until` · a resumed run (one more `workflow.execute` span per resume, see below): `landflow.execution.resume_of` (the execution id it continues), `landflow.execution.resume_kind` (`time`/`webhook`/`form`/`timeout`/`subworkflow`, or `restart` for a run continued from its checkpoint after a restart, which also sets `landflow.execution.resumed_after_restart=true` and `landflow.checkpoint.step`, the step id it continued after) · events `debugger.paused` (`landflow.node.name`, `landflow.debugger.reason`) / `debugger.resumed` (`landflow.debugger.command`) · error status on a failed run |
| `node.execute {node type}` | internal | `landflow.node.id`, `landflow.node.name`, `landflow.node.type`, `landflow.plugin.id`, `landflow.transport` (`in-process`/`http`/`grpc`), `landflow.node.source` (`main`/`ai_tool`/`ai_languageModel`/`ai_memory`/`ai_embedding`/`ai_document`/`ai_textSplitter`/`ai_retriever`/`ai_reranker`), `landflow.execution.id`, `landflow.items.in`, `landflow.items.out`, `landflow.node.status` (`success`/`error`/`canceled`/`waiting`), `landflow.node.reused`, `landflow.node.pinned`, `landflow.node.disabled` · the node that suspends the run: `landflow.node.status=waiting`, `landflow.wait.resume`, `landflow.wait.until`; when the run resumes, that node's result is a short `node.execute` span with `landflow.node.resumed=true` and `landflow.wait.resume_kind` · an `exception` event per failed attempt (with `retryOnFail`), error status when the node fails |
| `plugin.rpc {Method}` (`Execute`, `LoadOptions`, `TestCredentials`, `GetManifest`) | client | `rpc.system` (`grpc`/`http`), `rpc.service=landflow.plugin.v1.PluginService`, `rpc.method`, `server.address`, `server.port`, `landflow.plugin.id` |
| `gen_ai.chat {model}` | client | OTel GenAI conventions: `gen_ai.system` (`anthropic`/`ollama`/`openai`), `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `landflow.ai.cost_usd` (estimated, when the call ran in an execution or agent run; [§8](#token-and-cost-tracking)) |
| `gen_ai.embeddings {model}` | client | same conventions with `gen_ai.operation.name=embeddings`: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.embeddings.dimension.count`. Counts in the `landflow.ai.*` metrics like chat (input tokens only) |
| `vector_store.insert {store}`, `vector_store.query {store}` | client (child of the vector store's `node.execute`, or of `execute_tool` for an agent knowledge base) | RAG ([Retrieval](features/ai.md#retrieval-rag)): `landflow.vector_store` (`memory`/`sqlite`/`pgvector`), `db.system.name` (`landflow.memory`/`sqlite`/`postgresql`), `db.collection.name` (the collection), `db.operation.name` (`insert`/`query`), `landflow.retrieval.documents` (written or returned); query: `landflow.retrieval.mode` (`vector`/`hybrid`), `landflow.retrieval.top_k`, `landflow.retrieval.filtered`. The query is embedded just before, by the embeddings sub-node (`node.execute`, `landflow.node.source=ai_embedding`, with its `gen_ai.embeddings` child; a knowledge base embeds directly). Document text never reaches span attributes |
| `retrieval.rerank` | internal | `landflow.rerank.method` (`llm`), `gen_ai.request.model`, `landflow.rerank.documents` (candidates), `landflow.retrieval.top_k`; the judge's call is a `gen_ai.chat` child |
| `guardrails.check` | internal (child of the Guardrails node's `node.execute`, one per item) | `landflow.guardrails.mode` (`check`/`sanitize`), `landflow.guardrails.checks` (the checks that ran), `landflow.guardrails.passed`, `landflow.guardrails.violations` (count), `landflow.guardrails.failed` (the checks that found something); model checks are `gen_ai.chat` children. Matched values never reach spans |
| `trigger.fire` | internal (root for schedule/poll/error/retry; child of the HTTP span for manual runs, webhooks, forms, MCP Server Trigger calls and chat) | `landflow.trigger.source` (`manual`/`webhook`/`form`/`mcp`/`schedule`/`poll`/`chat`/`error`/`retry`/`usage`), `landflow.workflow.id`, `landflow.node.name`; `landflow.trigger.test=true` (on the span and the `landflow.trigger.fires` metric) for a call to a test URL (`/api/webhook-test/…`, `/form-test/…`, `/mcp-test/…`), which is otherwise traced exactly like the production call (those URLs are sampled like webhooks: any method, form and MCP POSTs). `error`: an error workflow started for a failed execution, as its own trace; `retry`: an automatic retry of a failed execution (a manual Retry runs under its request's span); `usage`: an On Usage Event trigger started by the [second brain](second-brain.md)'s ledger |
| `trigger.listen` | internal (child of `POST /api/workflows/:id/listen`) | The editor listening for a test event, for as long as its stream is open: `landflow.trigger.source` (`webhook`/`form`/`mcp`), `landflow.trigger.test=true`, `landflow.workflow.id`, `landflow.node.name`, `landflow.listener.id`, `landflow.execution.id` (the test run's id; MCP tool calls are `<id>-<suffix>`); at the end `landflow.listen.outcome` (`received`/`timeout`/`stopped`/`closed`) and, for MCP, `landflow.listen.calls` |
| `trigger.poll {node type}` | internal (root) | `landflow.workflow.id`, `landflow.node.name`, `landflow.node.type`, `landflow.poll.items`, `landflow.poll.first` |
| `registry.scan`, `registry.register` | internal | `landflow.plugin.id`, `landflow.plugin.endpoint`, `landflow.discovery.source` (register); `landflow.scan.targets`, `landflow.scan.found` (scan) |

| `invoke_agent {agent name}` | internal (root for schedule, Telegram and Slack runs; child of the HTTP span for the test chat; child of `execute_tool` for a sub-agent) | OTel GenAI agent conventions: `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id` (the session), `gen_ai.system`, `gen_ai.request.model`, `landflow.agent.source` (`test`/`schedule`/`telegram`/`slack`/`workflow`/`agent`), `landflow.agent.version` (`draft` or N), `landflow.agent.end_reason` |
| `execute_tool {tool name}` | internal (child of `invoke_agent`) | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type=function`, `landflow.agent.tool.kind` (`node`/`workflow`/`agent`/`skill`/`memory`/`a2a`), plus the agent attributes; contains the node's spans, a workflow's `workflow.execute`, a sub-agent's `invoke_agent` or a remote agent's client `invoke_agent` |
| `assistant.suggest {node type}`, `assistant.chat` | internal (child of the request span) | The editor assistant ([assistant.md](assistant.md)). `landflow.assistant.request` (`suggest`/`chat`), `landflow.workflow.id`, `gen_ai.request.model`; suggest: `landflow.node.type`, `landflow.assistant.suggestions`, `landflow.outcome=skipped` for a node not worth a model call; chat: `landflow.assistant.turns`, `landflow.assistant.steps` and an `assistant.tool` event per tool call (`gen_ai.tool.name`, `landflow.outcome`). The model calls are `gen_ai.chat` children |

A tool call by an AI agent is a `node.execute` span with `landflow.node.source=ai_tool`, a child
of the agent's span, so the trace shows agent → model → tool → plugin → external API. Sub-nodes
called by sub-nodes nest the same way: an agent's vector store tool → `node.execute` of the
embeddings node (`landflow.node.source=ai_embedding`) with its `gen_ai.embeddings` child, then
`vector_store.query`.

**Model fallback.** When a root node with *Enable Fallback Model* retries a failed call on its
fallback model, its `node.execute` span gets a `landflow.ai.fallback` event
(`gen_ai.request.model` of the failed model, `landflow.ai.fallback.model`,
`landflow.ai.fallback.provider`, `error.message`). The failed call stays an errored model run
(`landflow.node.source=ai_languageModel`, error status) next to the fallback's successful one.

**Durable runtime.** A run queued by its workflow's concurrency limit gets its `workflow.execute`
span when it starts, inside the trace of the trigger call that queued it while that call still
waits for it. A run continued after a restart is a new root trace (`resume_kind=restart`). A node
that runs past its `timeoutSeconds` ends with error status and "Node timed out after N s" (an
`exception` event per attempt with `retryOnFail`). The node's `ExecuteRequest` carries the step's
`idempotencyKey`, which is not put on spans.

**Waiting executions.** An execution that waits (Wait node, Form page, a sub-workflow that waits)
ends its `workflow.execute` span with `landflow.execution.status=waiting`. Each resume is a new
`workflow.execute` span for the same `landflow.execution.id`, with `landflow.execution.resume_of`
set to that id and `landflow.execution.resume_kind` saying what resumed it. A resume by a webhook
call or form submission is a child of that request's HTTP span; a timer (`time`, `timeout`) or a
finished sub-execution (`subworkflow`) starts a new root trace. **Execute Workflow** runs the child
execution inside the calling node's span, so parent and child share a trace until a wait splits it.
The execution's `traceId` is the trace of its latest part.

<a id="remote-agents-a2a"></a>

**Remote agents (A2A).** Each call to a remote agent ([a2a.md](a2a.md)), from an agent's A2A capability or the A2A
Agent node, is an `invoke_agent {card name}` **client** span (`lib/server/telemetry/a2a.ts`), a child of the
capability's `execute_tool` or the node's `node.execute`. Its trace context goes to the agent as `traceparent`, so an
agent that continues it (kagent does) adds its own spans to the trace. Attributes: `gen_ai.operation.name=invoke_agent`,
`gen_ai.provider.name=a2a`, `gen_ai.agent.name`, `rpc.system=jsonrpc`, `rpc.service=lf.a2a.v1.A2AService`,
`rpc.method` (`SendMessage`/`SendStreamingMessage`/`GetTask`/`CancelTask`), `rpc.jsonrpc.version`, `server.address`,
`server.port`, `url.full`, `landflow.a2a.caller` (`agent`/`node`); from the task it ends with: `a2a.task.id`,
`a2a.task.state`, `gen_ai.conversation.id` (the A2A context), `gen_ai.usage.input_tokens` / `output_tokens` (and the
cache-read and reasoning counts when reported), `landflow.a2a.tool_calls`, `landflow.a2a.pause` (`approval`/`question`).
Each tool call the agent made is an `a2a.tool_call` event at its own time (`gen_ai.tool.name`, `gen_ai.tool.call.id`,
`landflow.a2a.tool.status`, `error.message`). A failed, rejected or canceled task sets error status. What kagent adds to
the trace, and its quirks, are in [a2a.md](a2a.md#tracing).

### Plugins (every SDK)

| Span | Kind | Attributes |
|---|---|---|
| `plugin.execute {node type}` | server (parent: the host's `plugin.rpc Execute`) | `landflow.plugin.id`, `landflow.node.type` (qualified), `landflow.node.name`, `landflow.workflow.id`, `landflow.execution.id`, `landflow.execution.mode`, `landflow.items.in`, `landflow.items.out` · error status + `exception` event on failure |
| `plugin.load_options {method}` | server | `landflow.plugin.id`, `landflow.node.type`, `landflow.load_options.method` |
| `plugin.test_credentials {credential type}` | server | `landflow.plugin.id`, `landflow.credential.type`, `landflow.credential.ok` |
| `HTTP {METHOD}` | client | from the SDK's instrumented HTTP client: `http.request.method`, `server.address`, `url.full` (query string stripped), `http.response.status_code` |
| `db.query` / `{db.operation} {db.collection}` | client | database integrations: `db.system` (`postgresql`/`mysql`/`redis`/`sqlite`/…), `db.operation.name`, `db.collection.name`, `db.namespace`; statements only without literal values |

Node authors add their own child spans through the SDK (§6).

## 5. Metrics

OTel instrument names below. Prometheus names replace `.` with `_` and add the unit suffix
(`landflow.execution.duration` in ms → `landflow_execution_duration_milliseconds`), plus `_total`
for counters (`landflow.executions` → `landflow_executions_total`), as the OTel Prometheus exporters
do. Durations are
histograms in **milliseconds** with buckets `1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000`.

### Flows and jobs (host)

| Metric | Type | Attributes |
|---|---|---|
| `landflow.executions` | counter | `landflow.workflow.id`, `landflow.workflow.name`, `landflow.execution.mode`, `landflow.execution.status` (a run that waits counts once per part: `waiting`, then its final status) |
| `landflow.execution.duration` | histogram (ms) | same; for a run that waits, each part (start → wait, resume → end) is recorded separately, without the time spent waiting |
| `landflow.executions.active` | up-down counter | `landflow.execution.mode` |
| `landflow.node.runs` | counter | `landflow.node.type`, `landflow.plugin.id`, `landflow.transport`, `landflow.node.status` (`success`/`error`), `landflow.node.source` |
| `landflow.node.duration` | histogram (ms) | same |
| `landflow.node.items` | counter | `landflow.node.type`, `landflow.plugin.id`, `landflow.direction` (`in`/`out`) |
| `landflow.trigger.fires` | counter | `landflow.workflow.id`, `landflow.trigger.source` |
| `landflow.poll.runs` | counter | `landflow.node.type`, `landflow.poll.result` (`items`/`empty`/`error`) |
| `landflow.poll.duration` | histogram (ms) | `landflow.node.type` |
| `landflow.schedule.lag` | histogram (ms) | `landflow.workflow.id`: how late a scheduled run started |
| `landflow.webhook.requests` | counter | `landflow.workflow.id`, `http.response.status_code` |
| `landflow.runtime.events` | counter | `landflow.runtime.event`: `deduplicated` (a trigger call repeated an idempotency key), `skipped` (no free concurrency slot, or a full queue), `queued`, `recovered` (continued after a restart), `recovery_failed`, `retry_scheduled`, `retried` (a retry started), `stopped` (by Stop all); `landflow.workflow.id` (not on `stopped`) |

### Postgres write queue (host, `LANDFLOW_DB=postgres`)

| Metric | Type | Attributes |
|---|---|---|
| `landflow.db.write_queue.batches` | gauge | write batches not yet applied on Postgres |
| `landflow.db.write_queue.oldest_age` | gauge (s) | age of the oldest of them |
| `landflow.db.write_blocked` | gauge | 1 while Postgres rejects a batch and the store refuses writes (`StoreUnavailableError`) |
| `landflow.db.write_rejections` | counter | batches Postgres rejected with a non-connection error |
| `landflow.db.write_retries` | counter | retries of a blocked batch |

See [postgres-write-queue.md](features/postgres-write-queue.md); `Database.writeHealth()` reports the same state.

### Services (host)

| Metric | Type | Attributes |
|---|---|---|
| `landflow.plugin.rpc.duration` | histogram (ms) | `landflow.plugin.id`, `rpc.system`, `rpc.method`, `landflow.outcome` (`ok`/`error`/`timeout`) |
| `landflow.plugins.online` | gauge | `landflow.plugin.language` |
| `landflow.plugin.heartbeats` | counter | `landflow.plugin.id` |
| `landflow.ai.requests` | counter | `gen_ai.system`, `gen_ai.request.model`, `landflow.outcome` |
| `landflow.ai.duration` | histogram (ms) | `gen_ai.system`, `gen_ai.request.model` |
| `landflow.ai.tokens` | counter | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.token.type` (`input`/`output`) |
| `landflow.ai.cost` | counter (USD) | `gen_ai.system`, `gen_ai.request.model`: estimated cost by the price table ([§8](#token-and-cost-tracking)) |
| `landflow.ai.caps_reached` | counter | `gen_ai.system`, `gen_ai.request.model`, `landflow.ai.cap.when` (`before`: a call refused, `after`: a call that went over) |
| `landflow.retrieval.requests` | counter | `landflow.vector_store`, `db.operation.name` (`insert`/`query`), `landflow.outcome` |
| `landflow.retrieval.duration` | histogram (ms) | `landflow.vector_store`, `db.operation.name` |
| `landflow.retrieval.documents` | counter | `landflow.vector_store`, `db.operation.name`: documents written or returned |
| `landflow.guardrails.checks` | counter | `landflow.guardrails.mode`, `landflow.guardrails.result` (`pass`/`fail`) |
| `landflow.agent.runs` | counter | `gen_ai.agent.id`, `gen_ai.agent.name`, `landflow.agent.source`, `landflow.agent.end_reason` |
| `landflow.agent.run.duration` | histogram (ms) | `gen_ai.agent.id`, `gen_ai.agent.name`, `landflow.agent.source` |
| `landflow.agent.tool.calls` | counter | agent attributes, `gen_ai.tool.name`, `landflow.agent.tool.kind`, `landflow.outcome` |
| `landflow.agent.tool.duration` | histogram (ms) | agent attributes, `gen_ai.tool.name`, `landflow.agent.tool.kind` |
| `landflow.agent.approvals` | counter | agent attributes, `gen_ai.tool.name`, `landflow.agent.approval.decision` (`approved`/`denied`) |
| `landflow.agent.tokens` | counter | agent attributes, `gen_ai.token.type` (`input`/`output`) |
| `landflow.a2a.calls` | counter | `gen_ai.agent.name` (the card's name), `rpc.method`, `landflow.a2a.caller` (`agent`/`node`), `a2a.task.state`, `landflow.outcome` |
| `landflow.a2a.call.duration` | histogram (ms) | `gen_ai.agent.name`, `rpc.method`, `landflow.a2a.caller`: until the task settles or pauses |
| `landflow.a2a.tokens` | counter | `gen_ai.agent.name`, `gen_ai.token.type`: what the remote agent reports using (kagent's usage extension) |
| `landflow.a2a.tool.calls` | counter | `gen_ai.agent.name`, `gen_ai.tool.name`, `landflow.a2a.tool.status` (`success`/`error`/`awaiting_approval`): the remote agent's own tool calls |
| `landflow.assistant.requests` | counter | `landflow.assistant.request` (`suggest`/`chat`), `landflow.outcome` (`ok`/`error`/`timeout`/`skipped`) |
| `landflow.assistant.duration` | histogram (ms) | `landflow.assistant.request` |
| `landflow.assistant.suggestions` | counter | `landflow.assistant.kind` (`fix`/`param`/`data`/`next`, or `proposal` for a chat proposal): what the editor was shown |
| `landflow.assistant.applied`, `landflow.assistant.dismissed` | counter | `landflow.assistant.kind`: reported by the editor (`POST /api/assistant/feedback`) |
| `http.server.request.duration` | histogram (s) | standard: `http.request.method`, `http.route`, `http.response.status_code`. The host measures it from the Next.js request spans, untraced requests included |

### Plugins (every SDK, automatic)

| Metric | Type | Attributes |
|---|---|---|
| `landflow.plugin.executions` | counter | `landflow.node.type`, `landflow.node.status` |
| `landflow.plugin.execute.duration` | histogram (ms) | same |
| `landflow.plugin.items` | counter | `landflow.node.type`, `landflow.direction` |
| `landflow.plugin.load_options` | counter | `landflow.load_options.method`, `landflow.outcome` |
| `http.client.request.duration` | histogram (s) | standard (OTel semantic conventions: seconds, `http.request.method`, `server.address`, `server.port`, `http.response.status_code`, `error.type`), from the instrumented HTTP client |

### Custom metrics

- **Node authors** record their own through the SDK (§6), e.g. `telegram.messages.sent` or
  `postgres.rows.returned`. Names must match `^[a-z][a-z0-9_.]{0,100}$` and should start with the
  integration's name. The SDK adds `landflow.plugin.id`, `landflow.node.type` and
  `landflow.workflow.id`.
- **Workflow authors** use the core **Record Metric** node (`core.metric`). Per item it records a
  counter increment, a histogram value or a gauge value under `landflow.flow.<name>`, with
  attributes from expressions plus `landflow.workflow.id` and `landflow.workflow.name`. Items
  pass through unchanged. Examples: count orders by country, record the size of each processed
  invoice, gauge a queue length read from an API.
- **Cardinality guard**: attribute values are truncated to 100 characters, and each custom metric
  keeps at most 1000 attribute sets. Extra sets fold into one series marked
  `otel.metric.overflow=true`.

### Integration metrics

Metrics and spans that the integration plugins add on top of the automatic ones.

#### Productivity plugin (`productivity`, Python)

Notion, Airtable, GitHub, Jira, HubSpot and RSS ([README](../plugins/productivity/README.md)). Paginated
reads get a child span (`notion.query`, `notion.search`, `airtable.search`, `github.list`, `jira.search`,
`hubspot.search`) with `landflow.pages` and `landflow.items`; feed parsing gets `rss.parse` with
`landflow.items` and `rss.format`. The API calls themselves are `HTTP {METHOD}` client spans from `ctx.http`.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.productivity.records_written` | counter | `service` (`notion`/`airtable`/`github`/`jira`/`hubspot`), `operation` (`create`/`update`/`upsert`/`delete`/`comment`/`archive`/`append`/`transition`) |
| `landflow.productivity.poll.new_items` | counter | `trigger` (`github`/`rss`) |
| `landflow.productivity.api_errors` | counter | `service` (the five above plus `rss`), `status_class` (`4xx`/`5xx`/`network`) |

#### Messaging plugin (`messaging`, TypeScript)

Telegram (+ Telegram Trigger), Slack, Discord, WhatsApp Business Cloud and Send Email ([README](../plugins/messaging/README.md)).
API calls are `HTTP {METHOD}` client spans from `ctx.http` (the Telegram token in the path shows as `bot[REDACTED]`). Send Email
opens an `smtp.send` **client** span (`server.address`, `server.port`, `messaging.system=smtp`, `smtp.recipients.accepted`,
`smtp.recipients.rejected`) with child spans `smtp.connect`, `smtp.ehlo`, `smtp.starttls`, `smtp.auth`, `smtp.envelope`,
`smtp.data` and `smtp.quit`. The SMTP credential test uses `smtp.verify` the same way.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.messaging.messages_sent` | counter | `service` (`telegram`/`slack`/`discord`/`whatsapp`/`email`), `operation` (`sendMessage`, `sendPhoto`, `post`, `send`, `webhookSend`, `sendTemplate`) |
| `landflow.messaging.api_errors` | counter | `service`, `status_class` (`4xx`/`5xx` from the HTTP status or SMTP reply code, Slack's HTTP-200 `ok: false` included; `network`/`timeout`/`tls`/`protocol` without a usable answer) |
| `landflow.messaging.poll.updates` | counter | `service` (`telegram`) |

#### Google Workspace plugin (`google`, Go)

Google Sheets (+ trigger), Gmail (+ trigger), Drive, Calendar and Docs ([README](../plugins/google-workspace/README.md)).
API calls and the OAuth token exchange are `HTTP {METHOD}` client spans from `landflow.HTTPClient`. Getting an access
token is a `google.oauth.token` span with `google.auth` (`service_account`/`oauth2`) and `landflow.cache_hit`.
Paginated reads get a child span (`google.gmail.messages.list`, `google.drive.files.list`,
`google.calendar.events.list`, `google.calendar.calendar_list`) with `google.limit`, `google.pages` and `google.items`.
Message fetches run in `google.gmail.messages.fetch`, and sheet reads in `google.sheets.read` / `google.sheets.poll`.
Tokens, private keys and the token request body never appear in spans or logs.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.google.sheets.rows_appended` | counter | `mode` (`auto`/`manual`) |
| `landflow.google.gmail.messages_sent` | counter | `operation` (`send`/`reply`) |
| `landflow.google.token_refreshes` | counter | `auth` (`service_account`/`oauth2`), `outcome` (`success`/`error`) |
| `landflow.google.api_errors` | counter | `api` (`sheets`/`gmail`/`drive`/`calendar`/`docs`), `status_class` (`4xx`/`5xx`/`network`) |
| `landflow.google.poll.new_items` | counter | `trigger` (`gmail`/`sheets`) |

#### Databases plugin (`databases`, Go)

Postgres, MySQL, SQLite (+ Postgres and SQLite poll triggers) and Redis ([README](../plugins/databases/README.md)).
Every statement and Redis command is a `{operation} {table}` client span from `DBSpan` (`SELECT customers`, `HSET customer`)
with `db.system`, `db.operation.name`, `db.collection.name` (for Redis, the key prefix), `db.namespace`, `db.query.text`,
`server.address`, `server.port`, `db.response.returned_rows` and `landflow.db.affected_rows`. `db.query.text` never holds
values: generated SQL only has placeholders, Execute Query has its literals replaced by `?`, Redis reads as `GET ?`.
Multi-statement work runs in a `db.transaction` span with `landflow.statements` and `landflow.db.rolled_back`, and
credential tests get a span too.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.db.query.duration` (ms) | histogram | `db.system` (`postgresql`/`mysql`/`sqlite`/`redis`), `operation` (statement verb from a fixed list or `OTHER`; Redis command) |
| `landflow.db.rows` | counter | `db.system`, `operation`, `direction` (`read`/`written`; Redis counts values: fields or elements read, keys written) |
| `landflow.db.errors` | counter | `db.system`, `operation` |
| `landflow.db.pool.connections` | gauge | `db.system`, `state` (`in_use`/`idle`) |
| `landflow.db.poll.new_rows` | counter | `db.system` |

## 6. SDK API for node authors

| | TypeScript | Python | Go |
|---|---|---|---|
| Child span | `await ctx.span('telegram.send', { 'telegram.chat_type': t }, async (span) => …)` | `with ctx.span("telegram.send", {"telegram.chat_type": t}) as span:` | `ctx.Span("telegram.send", attrs, func(span landflow.Span) error {…})` |
| Counter | `ctx.metrics.counter('telegram.messages.sent').add(1, attrs)` | `ctx.metrics.counter("telegram.messages.sent").add(1, attrs)` | `ctx.Metrics().Counter("telegram.messages.sent").Add(1, attrs)` |
| Histogram | `ctx.metrics.histogram('x.duration', { unit: 'ms' }).record(v, attrs)` | `ctx.metrics.histogram(...).record(v, attrs)` | `ctx.Metrics().Histogram(...).Record(v, attrs)` |
| Client span (non-HTTP) | `await ctx.span('smtp.send', attrs, fn, { kind: 'client' })` | `ctx.span(...)` (internal only) | `ctx.DBSpan(landflow.DBSpanInfo{…}, fn)` for databases |
| Gauge | `ctx.metrics.gauge('x.depth').set(v, attrs)` | `ctx.metrics.gauge(...).set(v, attrs)` | `ctx.Metrics().Gauge(...).Set(v, attrs)` |
| Traced HTTP | `ctx.http(url, init)`, a fetch with a client span and `traceparent` | `ctx.http.request(method, url, …)` | `landflow.HTTPClient(ctx)`, an `*http.Client` with `otelhttp` |
| Model call (AI usage) | `ctx.model({ model, provider, inputTokens, outputTokens, … })`, see [protocol.md](protocol.md) | return a `model` record by hand | return a `model` record by hand |
| Logger | `ctx.logger.info(msg, attrs)` | `ctx.logger.info(msg, **attrs)` | `ctx.Logger.With(attrs...).Info(msg)` (`Logger` is a field; `Info(format, args...)` stays printf-style for compatibility) |

Spans and metrics are no-ops, never errors, when telemetry is disabled. The Python SDK works
**without** the `opentelemetry` packages installed: it then parses `traceparent` itself, generates
span ids, writes span and log lines with the ids, and serves `/metrics` from its own in-memory
counters. Install `landflow-sdk[otel]` to export OTLP.

## 7. Seeing it locally

Every process writes JSON logs with `trace_id`. To browse traces, run any OTLP backend and set
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` for the host and the plugins
(`pnpm dev:all` passes it through). Some options:

- Jaeger: `docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest`, then
  `LANDFLOW_TRACE_URL=http://localhost:16686/trace/{traceId}`.
- The OpenTelemetry Collector with [`docs/otel-collector.yaml`](otel-collector.yaml)
  (OTLP in; debug, Prometheus and file out). The `docker run` line is at the top of the file. It
  writes `.otel/{traces,metrics,logs}.jsonl` and serves every process's metrics at
  `http://localhost:9464/metrics`.
- Prometheus scraping `http://localhost:3000/api/metrics` and each plugin's `http://host:port/metrics`.
- On the OrbStack cluster, the `orbstack-observability` overlay runs Grafana with Tempo, Prometheus and Loki in
  `landflow-dev`, points every Landflow process at it and ships the "Landflow · agent runs" dashboard
  ([deployment.md](deployment.md#telemetry-on-kubernetes)). kagent in the kind cluster exports there too
  ([a2a.md](a2a.md#kagent-next-to-landflow)).

<a id="token-and-cost-tracking"></a>

## 8. Token and cost tracking

Every model call made in an execution or an agent run (chat and embeddings, from AI Agent and chain
nodes, the OpenAI node, RAG embeddings and rerankers, agents and their sub-agents) goes through the
same `gen_ai.*` wrapper (`lib/server/telemetry/ai.ts`), which asks the current **usage scope**
(`lib/server/ai-usage/scope.ts`, an AsyncLocalStorage per execution segment and agent run) whether
the call may start, then prices and records what it used.

- **Prices** (`lib/server/ai-usage/prices.ts`): USD per million input and output tokens. Built-in
  defaults are the Anthropic and OpenAI list prices; Ollama and other local models cost $0.
  **Settings → AI prices** (`GET/PUT /api/settings/ai-prices`) overrides any model, Ollama
  included. A model id matches exactly, else by the longest prefix (`claude-sonnet-4-6` prices
  `claude-sonnet-4-6-20260101`); a `vendor/` prefix (OpenRouter style) is ignored, and an
  OpenAI-compatible server's model falls back to the other providers' prices. Unknown models cost
  $0. Costs are estimates: batch prices aren't modelled.
- **Cached tokens**: a price also has **cache read** and **cache write** columns (USD per million;
  Settings → AI prices). `inputTokens` is the whole prompt; the cached part is priced at the cache
  price and the rest at the input price. Anthropic: `cache_read_input_tokens` and
  `cache_creation_input_tokens` (defaults 0.1x and 1.25x the input price); OpenAI:
  `prompt_tokens_details.cached_tokens` (explicit cached-input default prices, no write price).
  A cache price left empty falls back to the input price. Totals carry `cacheReadTokens` and
  `cacheWriteTokens` (execution view, Insights, `GET /api/insights/ai-usage`), and spans carry
  `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens`.
- **Storage**: one row per call in `ai_usage` (migration 400: time, day in the instance time zone,
  execution, workflow, agent, session, provider, model, operation, tokens, cost; migration 1821 adds
  `cache_read_tokens`, `cache_write_tokens`, `user_id` (who started the run) and `credential_id`), kept
  `AI_USAGE_RETENTION_DAYS` (default 400). An execution record carries its own totals per model
  (`aiUsage`), earlier segments included when it resumed after a wait; sub-executions keep their
  own. Calls outside executions and agents (the editor assistant, the AI builder) aren't counted.
- **Where it shows**: the execution view (tokens, cost and calls per model), Insights (a cost
  column and the period's total), an agent's Settings tab (today and this month), and
  `GET /api/insights/ai-usage` (totals, per model, per day; `group=workflow|agent`).
- **Caps** stop spending:

  | Cap | Set in | Counts |
  |---|---|---|
  | Max tokens / max cost per execution | Workflow settings → AI usage limits | the execution, its earlier segments and its sub-workflows |
  | Max tokens / max cost per day | Workflow settings → AI usage limits | every execution of the workflow today |
  | Daily token limit, daily and monthly cost limit | Agent → Settings | every run of the agent (sessions, schedules, channels, Run an Agent) |
  | Tokens or cost per day or month, per model credential | Settings → AI prices → AI usage caps (`GET/PUT /api/settings/ai-caps`) | every call made with the credential, by any workflow or agent |
  | Tokens or cost per day or month, per user, or one cap for every user | the same | every run the user started (a manual run, an agent session); runs without a user, such as triggers, aren't counted |

  A call is refused before it starts once a cap is reached, and a call that takes the total over a
  cap is counted and then stops the run with `UsageCapError`: *AI usage cap reached: this workflow
  today used 40,210 tokens of its 40,000 tokens limit (Workflow settings → AI usage limits)*. The
  workflow run fails on the node that made the call (Model fallbacks don't retry it); an agent run
  ends with the reason `budget` and that notice. Each refusal or stop counts in
  `landflow.ai.caps_reached`. The credential and user caps read the same message form: *AI usage cap
  reached: credential “Team OpenAI” today used 2,200 tokens of its 1,500 tokens limit (Settings → AI
  prices → AI usage caps)*; a zero or empty limit means no cap.
- **AI usage of plugin nodes**: a remote plugin node that returns a `model` record ([protocol.md](protocol.md), `ctx.model`) is counted like the models node: priced, one `ai_usage` row (Insights, `ExecutionRecord.aiUsage`, the per-credential and per-user caps through the credential tag on the request, the `ai.call` ledger event) and the `landflow.ai.tokens` metric (`ai-usage/plugin.ts`, `withAiUsage`). A call over a cap fails the node and run with the same `UsageCapError`; a node with `meterAiUsage` is refused before it runs once a cap is reached. Several records in one response are all counted before the error is thrown. The record's span in Run Trace has `costUsd` from the same price table (overrides included); an unpriced model is $0 with a `costNote`, and a capped call keeps its span. Ollama's cache-read tokens are provider-reported, not an artefact.
- **Cost alerts**: an alert rule of kind *AI cost* (Settings → Alerts, a threshold percent, default
  80) sends a message through its channels when a workflow, agent, credential or user cap reaches the
  threshold, once per cap per period (day or month; `alert_state`, migration 1820), checked when usage
  is recorded and by the alerts ticker on the leader. Per-execution caps aren't watched (they have
  no period).
