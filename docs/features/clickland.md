# Clickland

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

Clickland is the land family's observability system: logs, traces and metrics in ClickHouse, alerts, notes (what people
and agents learned) and views (charts, tables and traces built on demand, kept as dashboards). Landflow works with it
in four ways:

- **The `clickland` plugin** ([plugins/clickland](../../plugins/clickland/README.md)): a node for every read and write of
  Clickland's API, usable as an agent tool and over MCP, a signed alert webhook trigger and a polling trigger.
- **Clickland as an agent's knowledge base** ([agents.md](../agents.md#knowledge-bases-from-a-plugin)): a standalone
  agent searches Clickland's knowledge (notes, alert events, log patterns, services) the way it searches a vector store
  collection.
- **Flows**: Clickland alerts [triaged by an AI agent into Slack](#alert-triage-into-slack), and the
  [chat behind Clickland's Assistant panel](#the-observability-assistant) with its [contract](#the-assistant-chat-contract).
- **Telemetry**: Landflow's own traces, metrics and logs go to Clickland's collector on the OrbStack cluster.

Clickland's API is specified in its repository (`docs/reference/api.md`); the plugin was built against that contract,
is tested against a local fake of it, and was [checked live](#checked-live) against Clickland on this machine.

## The plugin

| | |
|---|---|
| Package | `plugins/clickland` (TypeScript SDK), `pnpm plugin:clickland` |
| Ports | HTTP 7119, gRPC 7219 |
| Credential | **Clickland API (ck_…)**: Base URL (default `http://clickland-api.clickland-dev.svc.cluster.local:4710`, `http://127.0.0.1:4710` on this machine), API Key |
| Nodes | **Clickland** (Log, Trace, Service, Metric, Alert, Note, Knowledge, View), **Clickland Alert Trigger** (app webhook), **Clickland Trigger** (poll) |
| Deploy | compose service `clickland`; Kubernetes `deploy/k8s/base/plugins/clickland.yaml`, image `landflow/plugin-clickland` |

The operations, their routes and outputs, the scopes each needs and how the triggers register and verify are in the
[plugin README](../../plugins/clickland/README.md). Every read operation is named so that its MCP tool carries
`readOnlyHint` (`logs_search`, `traces_get`, `services_list`, `views_list`…), and View → Render answers with a marker
(`[[clickland:view:<id>]]`) that Clickland's console draws as a live view inline in a chat answer.

## Clickland as a knowledge base

A standalone agent takes Clickland as a knowledge base: **Add knowledge base → Knowledge from → From a plugin:
Clickland**, with the Clickland credential. The agent's `search_clickland({ query })` runs the plugin's Knowledge →
Search (notes, recent alert events, log patterns, services), its passages count for the grounded guardrail, and there
is nothing to upload. See [agents.md](../agents.md#knowledge-bases-from-a-plugin).

## Alert triage into Slack

[`clickland-alert-triage.json`](../../plugins/clickland/flows/clickland-alert-triage.json) (Templates, from the
marketplace): **Clickland alert** (the Alert Trigger, `alert.firing`) → **Triage the alert**, an AI Agent on Claude with
five Clickland tools (`search_clickland_knowledge`, `log_patterns`, `search_spans`, `get_trace`, `render_view`) → **Post to
Slack**. The agent reads the alert's samples, looks for earlier notes, the patterns and the traces, renders one view of
what it found and writes a Slack message: *Real*, *Noise* or *Unsure* first, the evidence (counts, pattern templates,
trace ids, the window in UTC), what earlier notes say, the next step, and `View: <url>` (the rendered view's link; never
a `[[clickland:view:…]]` marker, which Slack does not draw). The message ends with a link to the alert page. Slots:
Clickland (`read`, `webhooks:write`), Anthropic, Slack.

Alerts from Clickland also go through the triage plugin's flows: **Normalize Alert** reads Clickland's deliveries and
both triggers' items (`format: clickland`, also auto-detected; [plugins/triage](../../plugins/triage/README.md)).

## The observability assistant

[`clickland-observability-assistant.json`](../../plugins/clickland/flows/clickland-observability-assistant.json) is the
chat behind Clickland's **Assistant** panel. Using the template creates the **Clickland observability** team and four
agents, with the picked Clickland and Anthropic credentials:

| Agent | Runs on | Tools |
|---|---|---|
| **Clickland observability lead** | the flow's Anthropic Chat Model (Claude Sonnet 5.5) and Simple Memory (20 turns) | Clickland as its knowledge base (`search_clickland`); the three analysts; `render_view`; dashboards: `list_dashboards`, `get_view`, `save_as_dashboard`, `add_panel`, `remove_panel`, `update_view`; `write_note` |
| **Logs analyst** | Claude Sonnet 5.5 (its own config) | `search_logs`, `log_patterns`, `log_volume`, `render_view` |
| **Traces analyst** | Claude Sonnet 5.5 | `list_services`, `search_spans`, `get_trace`, `render_view` |
| **Metrics analyst** | Claude Sonnet 5.5 | `list_metrics`, `query_metric`, `list_alerts`, `alert_history`, `render_view` |

The flow: **Clickland Assistant chat** (public, path `clickland-assistant`, Streaming, Basic Auth user `clickland`,
Load Previous Session) → **Observability lead** (Run an Agent, `conversation: key` on the chat's `sessionId`). The
analysts are Run an Agent nodes on the lead's tool input: the lead asks each with a `message` (the whole question) and a
`reason`. Every Clickland tool's parameters are `$fromAI()` placeholders over a fixed resource and operation, so a model
can't switch a read into a delete.

The prompts ask for evidence on every claim (trace ids, counts and error rates, the window in UTC, pattern templates as
they appear, metric names and values, alert names), never an invented number or id, and links into the console
(`http://127.0.0.1:4711/traces/<traceId>`, `http://127.0.0.1:4711/search?signal=logs&query=…`). When a chart, a table, a
trace or patterns say it better, the lead (or an analyst, whose answer the lead keeps) renders a view and puts its
marker `[[clickland:view:<id>]]` on its own line; the text says what the view shows, so it reads in Slack too.
Dashboards: "save that as a dashboard called X" pins the view under that name; "add p99 latency to the Checkout
dashboard" is `list_dashboards` → `get_view` → `add_panel` (or `update_view` with the whole spec and the version read: a
conflict means someone saved meanwhile, so the lead reads it again); every save or edit is confirmed with the
dashboard's name, its link and its marker. The lead writes a note only when asked.

The lead's own tool calls stream as `tool` events (an analyst's call shows its `reason`); what an analyst does inside
its call (its own Clickland queries) is not streamed: the analyst's answer comes back as the call's output
([limitations](../limitations.md#clickland-built-2026-11-14)).

### The assistant chat contract

How an app (Clickland's API) talks to the flow, server to server. All of it is the hosted chat of a public Chat
Message trigger ([features/ai.md](ai.md#hosted-chat-and-widget)); nothing here is specific to Clickland.

**Address.** `POST {LANDFLOW_URL}/chat/clickland-assistant` (the trigger's **Path**). The workflow must be published;
otherwise every call answers 404. In the OrbStack cluster, Landflow is `http://landflow-host.landflow-dev.svc.cluster.local:3000`
(or wherever `LANDFLOW_PUBLIC_URL` points).

**Auth: a shared secret.** Basic Auth with the trigger's user (`clickland`) and password:
`Authorization: Basic base64("clickland:<password>")`. The password is the shared secret: set it on the trigger and give
Clickland the same value. While it is empty, every call is refused (fail closed). A wrong or missing header answers
`401 { "error": "Sign in to use this chat", "authRequired": true, … }`. A server-side call sends no `Origin` header,
so **Allowed Origins** does not apply to it (it limits browsers, which get 403 from another origin; the template allows
the console's `http://127.0.0.1:4711` and `http://localhost:4711`).

**Request.** `Content-Type: application/json`:

```json
{ "sessionId": "ck-user-42:thread-7", "message": "Why is checkout slow in the last hour?" }
```

- `sessionId` (required): 1-128 of letters, digits, `_ . : -`. One per conversation: the lead's memory and the stored
  history are per session. Clickland picks it (for example its user and thread ids).
- `message` (or `chatInput`): up to 32,000 characters (413 above). Multipart (`sessionId`, `message`, `files`) also
  works but this flow has uploads off.
- 400 for a bad body or `sessionId`.

**Response: streamed.** The trigger is in Streaming mode, so a 200 answer is a stream of JSON chunks:
`Accept: text/event-stream` gets SSE (each chunk one `data: {…}` event, a blank line after it); any other `Accept` gets
NDJSON (`application/x-ndjson`, one JSON object per line). Chunks, in order:

```jsonc
{ "type": "begin", "metadata": { "nodeId": "lead", "nodeName": "Observability lead", "itemIndex": 0, "timestamp": 1794669048071 } }
{ "type": "tool", "tool": { "id": "toolu_1", "name": "Logs_analyst", "status": "started",
  "input": { "message": "What do checkout's error logs say in the last hour?", "reason": "to see what the errors are" } },
  "agent": { "id": "ag_…", "name": "Clickland observability lead", "face": { … } }, "metadata": { … } }
{ "type": "tool", "tool": { "id": "toolu_1", "name": "Logs_analyst", "status": "finished", "input": { … }, "output": "{\"reply\":\"Top pattern: …\"}" }, "agent": { … }, "metadata": { … } }
{ "type": "tool", "tool": { "id": "toolu_2", "name": "render_view", "status": "started", "input": { "spec": { … } } }, … }
{ "type": "tool", "tool": { "id": "toolu_2", "name": "render_view", "status": "finished", "output": "{\"id\":\"vw_1\",\"url\":\"…\",\"marker\":\"[[clickland:view:vw_1]]\"}" }, … }
{ "type": "item", "content": "Checkout's errors are refused connections (812 in the last hour).\n", "agent": { … }, "metadata": { … } }
{ "type": "item", "content": "[[clickland:view:vw_1]]", "agent": { … }, "metadata": { … } }
{ "type": "end", "metadata": { … } }
{ "type": "done", "executionId": "ex_…", "sessionId": "ck-user-42:thread-7", "status": "success",
  "output": "Checkout's errors are refused connections (812 in the last hour).\n[[clickland:view:vw_1]]" }
```

- `item`: a text delta of the answer; join them in order. `tool`: one of the lead's tool calls, `status` `started`,
  `finished` (with `output`, the result as the model saw it), `failed` or `approval` (waits for a person; this flow asks
  for none). The analysts are tools named `Logs_analyst`, `Traces_analyst`, `Metrics_analyst`. `error`: a node's error
  message in `content`. `agent` says who wrote the chunk.
- `done` is always last: `status` `success` with the whole answer in `output`, or `error` with `error.message`. Use
  `output` as the final text (it equals the joined `item`s).
- Before the stream starts: `202 { "output": "", "status": "<reason>", "sessionId" }` when the run was buffered or
  debounced, `429` when the concurrency limit skipped it.

**History.** `GET {LANDFLOW_URL}/chat/clickland-assistant/session?sessionId=<id>` with the same `Authorization` →
`{ "sessionId", "messages": [{ "role": "user" | "assistant", "text", "at", "executionId"?, "agentKey"?, "agentName"?, "feedback"? }] }`,
oldest first (an assistant `text` keeps its markers). An unknown or malformed session answers `{ "messages": [] }`.

**Also there:** `GET …/chat/clickland-assistant/config` (`title`, `subtitle`, `initialMessages`, `inputPlaceholder`, `responseMode`, `loadPreviousSession`…)
and `POST …/feedback` `{ sessionId, executionId, rating: "up" | "down" | null, comment? }` to rate an answer.

**Setting it up.** Use the template with the Clickland and Anthropic credentials, set the trigger's **Password**,
publish. Clickland's side needs the URL, the user `clickland` and the password (its API holds them; the browser never
sees them).

## Checked live

On 2026-11-14, with Clickland's API, collector and ClickHouse running on the Mac and reached from the cluster through
Clickland's `deploy/k8s/bridge` (ExternalName Services `clickland-api`, `clickland-collector` and `clickland-console` in
`clickland-dev`, all pointing at `host.orb.internal`), and Landflow from `orbstack-clickland`:

| Check | Result |
|---|---|
| Plugin registered | `GET /api/plugins`: `clickland` online from `kubernetes` with its 3 nodes; 13 plugins online |
| Credential | a `ck_` key with `read`, `alerts:write`, `webhooks:write`, `notes:write`, `views:write`; Test: "Connected to Clickland 0.1.0" over `http://clickland-api.clickland-dev.svc.cluster.local:4710` |
| Telemetry | the host's spans and logs (`service:landflow-host`) and the plugin's (`landflow-plugin-clickland`) searchable in Clickland seconds after they happen |
| Plugin nodes | a manual run: Log → Search returned rows with stats, Knowledge → Search returned service passages in the knowledge-tool shape |
| Clickland Trigger | a manual run emitted recent alert events |
| Alert Trigger | publishing created the webhook (`GET /api/webhooks`); an alert that fired was delivered signed and started the triage flow with the event (alert, value, 5 samples); an unsigned delivery got 401 `invalid signature` |
| Assistant | Clickland's `POST /api/assistant/chat` reached the published chat with Basic Auth (a wrong or missing password gets 401) and started the lead's run |

Not seen live yet: the agents' answers. The cluster's Landflow had no Anthropic credential, so the lead and the triage
agent stopped at the model ([limitations](../limitations.md#clickland-built-2026-11-14)). To finish the check, pick an
Anthropic credential on both flows' **Anthropic Chat Model** and on the three analysts, republish, and ask Clickland's
assistant "Which land services had errors in the last hour, and why? Show me a view.": the stream should show the
analysts as `tool` events, `search_clickland` on the lead, and a `[[clickland:view:vw_…]]` marker whose view
`GET /api/views/:id` returns.
