# Clickland plugin (`clickland`)

The bridge between Landflow and Clickland, the land family's observability system (logs, traces and metrics on
ClickHouse, alerts, notes and views). Flows and agents search logs and traces, read services and metrics, find log
patterns, manage alerts, write and search notes, ask Clickland's knowledge search and render views (charts, tables,
traces) that Clickland's console shows inline. Written with the TypeScript SDK; the same plugin answers over HTTP,
gRPC, any installed broker and MCP. It follows Clickland's API contract (`docs/reference/api.md` in the Clickland
repository).

```sh
pnpm plugin:clickland                                # HTTP :7119, gRPC :7219, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-clickland test        # vitest against an in-memory fake Clickland, no network
pnpm --filter @landflow/plugin-clickland typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. No dependency beyond the SDK: HTTP goes through the traced
`ctx.http`.

## Nodes

| Node (type) | What | Output |
|---|---|---|
| **Clickland** (`clickland.clickland`, usable as an AI tool) | **Log** → Search, Histogram, Patterns · **Trace** → Search, Get · **Service** → List · **Metric** → List, Query · **Alert** → List, Get, Create, Update, Delete, Events · **Note** → Create, List · **Knowledge** → Search · **View** → Render, Get, List, Pin, Update, Add Panel, Remove Panel | see below |
| **Clickland Alert Trigger** (`clickland.clicklandAlertTrigger`) | app webhook: Clickland calls Landflow when an alert fires or resolves | one item per delivery: the event's `data` plus `type`, `id`, `timestamp` |
| **Clickland Trigger** (`clickland.clicklandTrigger`) | poll trigger, default every 60 s: new alert events, new notes | `{ event: 'alert.event', alert, alertEvent }` or `{ event: 'note.created', note }` |

Parameters are read per item and every output item is paired with its input. Errors read `Clickland API error 400: …`
with Clickland's own message (a search syntax error adds its position) and a hint: 401 (a `ck_` key, not a Landflow
`lf_` key), 403 (the scope the call needs), 404, 429. A 429 with a `Retry-After` of up to 10 s waits and retries once.
**On Error: Continue** keeps the flow going with `{ error, description }`.

### Time range

Search, Histogram, Patterns, Services → List and the Metric operations read a window: **Last Minutes** (default 60)
before **To** (default now), or **From** → **To** when From is set (ISO 8601; the node sends UTC). Knowledge → Search
sends From / To only when set (Clickland's default is the last 24 hours).

### Operations

| Operation | Route | Parameters | Output |
|---|---|---|---|
| Log → **Search** | `POST /api/search` `signal: logs` | Query (Clickland's search language), time range, Limit (1-500, default 100), Before (cursor), Output | one item per row (newest first), or one item `{ rows, nextCursor, stats }` |
| Log → **Histogram** | `POST /api/search/histogram` | Query, time range, Group By | `{ bucketSeconds, series: [{ key, points }] }` |
| Log → **Patterns** | `POST /api/patterns` | Query, time range, Sample (100-20000, default 5000) | `{ patterns: [{ template, count, share, example, services }], sampled, total }` |
| Trace → **Search** | `POST /api/search` `signal: traces` | as Log → Search | span rows |
| Trace → **Get** | `GET /api/traces/:traceId` | Trace ID | `{ traceId, spans, services, durationMs, errorCount, startedAt }` |
| Service → **List** | `GET /api/services` | time range | one item per service: `{ name, requests, errors, errorRate, p50Ms, p95Ms, p99Ms, logErrors }` |
| Metric → **List** | `GET /api/metrics/names` | time range | one item per metric: `{ name, type, unit, description, services }` |
| Metric → **Query** (`getSeries`) | `POST /api/metrics/query` | Metric, Metric Type, Aggregation (avg, min, max, sum, rate, p50, p95, p99), Service, Group By, time range | the histogram shape |
| Alert → **List** / **Get** | `GET /api/alerts`, `GET /api/alerts/:id` | Alert ID | alerts with `states: [{ groupKey, state, value, changedAt }]` |
| Alert → **Create** | `POST /api/alerts` (`alerts:write`) | Name, Signal, Query, Group By, Threshold Type, Threshold, Window, Check Every, Enabled | the alert |
| Alert → **Update** | `GET` then `PUT /api/alerts/:id` | Alert ID, Update Fields (any of the above) | the alert. PUT takes the whole alert, so the node reads it and changes only the fields you set |
| Alert → **Delete** | `DELETE /api/alerts/:id` | Alert ID | `{ deleted: true, id }` |
| Alert → **Events** (`getEvents`) | `GET /api/alerts/:id/events?limit=` | Alert ID, Limit | one item per event, newest first |
| Note → **Create** | `POST /api/notes` (`notes:write`) | Title, Body (Markdown), Additional Fields: Service, Tags, Trace IDs (comma-separated), Alert Event ID, Author | the note |
| Note → **List** | `GET /api/notes` | Service, Search, Limit | one item per note |
| Knowledge → **Search** | `POST /api/knowledge/search` | Question, Limit (1-25, default 8), From, To | one item `{ results: [{ pageContent, metadata, score }] }`: the shape of Landflow's knowledge-base tools, so it is an agent's [knowledge base](../../docs/agents.md#knowledge-bases-from-a-plugin) |
| View → **Render** | `POST /api/views` | View Spec (JSON), Pin as Dashboard | `{ id, url, resourceUri, marker }`. Put `marker` (`[[clickland:view:<id>]]`) on its own line in a chat answer and Clickland's console draws the view inline |
| View → **Get** | `GET /api/views/:id` | View ID | `{ id, spec, pinned, version, … }` |
| View → **List** | `GET /api/views?pinned=true` | Dashboards Only (default on) | one item per view: `{ id, title, pinned, createdAt, createdBy }` |
| View → **Pin** | `PUT /api/views/:id` `{ pinned, title? }` | View ID, Pinned, Title | the view: saved as a dashboard (named) or unpinned |
| View → **Update** | `PUT /api/views/:id` | View ID, Update Fields: Spec, Title, Pinned, Version (a stale version answers 409) | the view |
| View → **Add Panel** | `POST /api/views/:id/panels` | View ID, Panel (JSON), Position (-1 appends) | the view |
| View → **Remove Panel** | `DELETE /api/views/:id/panels/:index` | View ID, Panel Index (0 = first) | the view |

A view spec is `{ title, description?, range: { lastMinutes } | { from, to }, panels }` with up to 12 panels of type
`timeseries`, `metric`, `stat`, `logs`, `spans`, `trace`, `services`, `patterns` or `markdown` (`width`: `half` or
`full`). The View Spec parameter's description lists every panel's fields and an example, so a model can compose one.

The read operations (Search, Histogram, Patterns, Get, List, Query, Events, Knowledge Search) carry MCP `readOnlyHint` and
are safe to repeat over a broker; the operation values start with `search`, `get` or `list` for that. Create, Update,
Delete, Render, Pin and the panel edits are at most once.

## Credential

| Type | Fields | Test |
|---|---|---|
| **Clickland API (ck_…)** (`clicklandApi`) | Base URL (default `http://clickland-api.clickland-dev.svc.cluster.local:4710`; `http://127.0.0.1:4710` on this machine), API Key (password, `ck_…`) | `GET /api/health` (no key), then `GET /api/alerts` with the key |

Scopes: `read` for every read, Render and the view edits; `alerts:write` for Create / Update / Delete Alert;
`notes:write` for Note → Create; `webhooks:write` for the Alert Trigger. A 403 names the scope that was missing.

## Clickland Alert Trigger

Publishing the workflow calls `POST /api/webhooks` with the trigger's URL (`{publicUrl}/api/webhook/app/<workflowId>/<nodeId>`),
the chosen events (`alert.firing`, `alert.resolved`) and the Alert ID filter, and keeps the returned `id` and `secret` in
the node's static data. Re-publishing runs `checkExists`: `GET /api/webhooks/:id` and a comparison of URL, events and
alert id with what the node asks for; a mismatch, a 404 or a changed option creates the subscription again (and deletes
an earlier one first, so deliveries don't double). Unpublishing calls `DELETE /api/webhooks/:id` (a 404 counts as
deleted; any other failure keeps the record so the delete is retried).

Every delivery is checked against its [Standard Webhooks](https://www.standardwebhooks.com/) signature over the raw
body: `webhook-signature: v1,<base64 HMAC-SHA256>` of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the
base64-decoded secret after `whsec_`, with the timestamp within **Signature Tolerance** (default 300 s). A missing,
forged or stale signature answers 401 and starts nothing. A signed event that isn't selected, or names another alert,
answers 200 (so Clickland doesn't retry) and starts nothing. `webhook-id` is the idempotency key: Clickland's retries of
one event start one run. Clickland must reach Landflow at the published URL (`LANDFLOW_PUBLIC_URL`).

## Clickland Trigger

Polls `GET /api/alerts` and, for alerts whose states changed since the last poll (at most 25 per poll, the most
recently changed first), `GET /api/alerts/:id/events`; with **New Note** on, `GET /api/notes`. The first poll sets a
baseline at the newest state change Clickland reports (its clock, not Landflow's) and emits nothing; each later poll
emits what is newer, oldest first, once (ids at the boundary time are remembered). **Execute** in the editor shows up
to 5 recent items and stores nothing. Use the Alert Trigger for instant delivery; the poll trigger needs no public URL.

## Flows

- [`clickland-alert-triage.json`](flows/clickland-alert-triage.json): Clickland Alert Trigger → a Filter that drops
  alerts Clickland routed straight to Landfall (`data.route: "direct"`) → an AI Agent that reads
  the alert's samples, searches Clickland's knowledge, the patterns and the traces → a Slack message with the verdict
  and a link to a rendered view.
- [`clickland-observability-assistant.json`](flows/clickland-observability-assistant.json): the chat Clickland's
  console talks to (the "Assistant" panel): a lead agent with logs, traces and metrics specialists, Clickland
  knowledge and views. Its chat contract is in [docs/features/clickland.md](../../docs/features/clickland.md#the-assistant-chat-contract).

## Deploy

`deploy/k8s/base/plugins/clickland.yaml` (discovered by its Service label, image `landflow/plugin-clickland`), the
compose service `clickland`, and [docs/features/clickland.md](../../docs/features/clickland.md) for the whole
integration (telemetry into Clickland included).
