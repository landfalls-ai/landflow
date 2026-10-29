# Landfall plugin (`landfall`)

The bridge between Landflow and [Landfall](https://landfalls.ai), the incident-response product: an alert opens a "war room"
(an incident), and Landfall's AI investigates and suggests fixes. Landflow triages alerts and opens a room only for real
incidents; later it runs approved runbooks and records the result back in the room. Written with the TypeScript SDK; the
same plugin answers over HTTP, gRPC, any installed broker and MCP.

```sh
pnpm --filter @landflow/plugin-landfall start        # HTTP :7108, gRPC :7208, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-landfall test         # vitest against an in-memory fake Landfall, no network
pnpm --filter @landflow/plugin-landfall typecheck
pnpm --filter @landflow/plugin-landfall fake-landfall   # the fake as a standalone server, :7398
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. No dependency beyond the SDK: HTTP goes through the traced
`ctx.http`.

## Nodes

| Node (type) | Resource → operations | Output |
|---|---|---|
| **Landfall** (`landfall.landfall`, usable as an AI tool) | **Incident** → Open From Alert, Recover, Open Manually, Declare, Get, Get Many · **Timeline** → Get Events, Add Event, Add Note · **Remediation** → Record Applied Externally · **Heartbeat** → Ping | see below |
| **Landfall Trigger** (`landfall.landfallTrigger`) | poll trigger, default every 30 s: New Incident, Incident Ended, New Timeline Events | `{ event, incident, timelineEvent? }` |

Parameters are read per item and every output item is paired with its input. Errors read `Landfall API error 422: …` with
Landfall's own message and a hint (401: which token goes where; 404: check the org slug; 409: try again; 422 on an alert:
the remote-source connection must exist and be healthy; 429: the 300 requests per 60 s limit). A 429 waits `Retry-After`
(up to 10 s) and retries once. **On Error: Continue** keeps the flow going with `{ error, description }`.

| Operation | Route | Parameters | Output |
|---|---|---|---|
| Incident → **Open From Alert** | `POST /triggers` (ingest token) | Title, Severity (sev1-4), Additional Fields: Dedup Key, Entity Hints (`service:checkout, env:prod`), Summary, URL, Occurred At, Connection ID | `TriggerResult` plus `opened: boolean`: `{ outcome: opened\|attached\|recorded\|ignored\|suppressed, reason?, incidentId, tenantId, entity, proposedSeverity, workspaceUrl, opened }` |
| Incident → **Recover** | `POST /triggers`, `kind: recovery` | Title, Severity, **Dedup Key**, same Additional Fields | same. A recovery is *recorded*; it never closes the room |
| Incident → **Open Manually** | `POST /o/:slug/triggers` | Title, Severity, Entity Hint | `TriggerResult` plus `opened`. Never suppressed, no dedup |
| Incident → **Declare** | `POST /o/:slug/incidents` | Title, Severity, Description (all optional) | `IncidentView` |
| Incident → **Get** | `GET …/incidents/:id/state` | Incident ID, Through Seq (-1 = latest) | `{ incidentId, throughSeq?, state }` |
| Incident → **Get Many** | `GET …/incidents` | Return All (follows `nextCursor`) or Limit (1-200), Filters: Status (open / closed / all), Search | one item per `IncidentView` |
| Timeline → **Get Events** | `GET …/incidents/:id/events` | Incident ID, Return All / Limit (1-500), Options: Since Seq, Before Seq | one item per `TimelineEvent`, ascending. With a limit Landfall returns the *newest* rows |
| Timeline → **Add Event** | `POST …/incidents/:id/events` | Incident ID, Event Type, Payload (JSON object) | the appended `TimelineEvent`. `expectedSeq` is read for you (newest seq + 1) and a 409 re-reads and retries once |
| Timeline → **Add Note** | same, type `chat.message` | Incident ID, Text | the appended event, written as the member who owns the API key |
| Remediation → **Record Applied Externally** | same, type `remediation.applied-externally` | Incident ID, Source Seq (seq of the `remediation.proposed` event), Additional Fields: Remediation ID, Action (≤ 500), Note (≤ 1000) | the appended event |
| Heartbeat → **Ping** | `POST /o/:slug/heartbeats/:name/ping` (heartbeat token) | Heartbeat Name | `{ ok: true, heartbeat }` |

`Get`, `Get Many` and `Get Events` are the read-only operations (MCP `readOnlyHint`, safe to repeat over a broker); the rest
are at most once. Landfall refuses `agent.step`, `incident.triggered`, `severity.proposed`, `demo.marked`, `selfmon.marked`,
`context.attached` / `detached` and `cluster.uninvolved` on the event route; Add Event passes its 400 on.

## Credentials

| Type | Fields | Used by |
|---|---|---|
| **Landfall API (lf_key_…)** (`landfallApi`) | Base URL, Org Slug, API Key (password, `lf_key_…`; acts as the member who owns it), Ingest Token (password, optional), Connection ID (optional) | every Incident / Timeline / Remediation operation and the trigger. The API key serves org routes; the ingest token serves only `POST /triggers` (Open From Alert, Recover) together with the Connection ID |
| **Landfall Heartbeat** (`landfallHeartbeatApi`) | Base URL, Org Slug, Token (password) | Heartbeat → Ping |

The name says `lf_key_…` on purpose: these are Landfall keys, not Landflow's own `lf_` API keys. The `landfallApi` test calls
`GET /o/:slug/incidents?limit=1` with the key. The heartbeat test only checks the fields are set (a ping is a write).

## Landfall Trigger

Polls `GET /o/:slug/incidents?status=all&limit=200` (one call per poll) and emits items `{ event, incident, timelineEvent? }`
(`incident` is the `IncidentView`):

| Trigger On | `event` | When |
|---|---|---|
| New Incident | `incident.opened` | an incident number above the highest seen; oldest first |
| Incident Ended | `incident.ended` | an incident seen open now has an ended status (resolved, closed, mitigated, recovered, done, archived), once |
| New Timeline Events | `timeline.event` | new events in open rooms, optionally filtered by **Event Types** (comma list, e.g. `remediation.proposed, status.changed`). Reads `sinceSeq` per incident, at most 20 incidents per poll, the longest-unread first |

The first poll sets a baseline and emits nothing. Execute in the editor shows up to 5 recent items and changes no state.
Poll state is bounded: at most 200 open incidents are tracked (the lowest numbers drop first). A room that ends gets one last
timeline read in the poll that reports it ended.

## Source face (Landfall Source Protocol v1)

Landfall accepts remote triggers only from a *remote-source connection* whose last health check passed; the check calls
`GET /v1/health` and `GET /v1/capabilities` on the connection's URL. Set `LANDFALL_SOURCE_PORT` and the plugin process also
serves a minimal `node:http` face:

| Route | Answer |
|---|---|
| `GET /v1/health` | `{ "ok": true, "detail": "Landflow Landfall plugin" }` |
| `GET /v1/capabilities` | `{ "protocolVersion": "1", "source": "landflow", "kinds": [], "operations": [] }` |
| anything else | 404 (no `/v1/invoke`, no metrics or logs reads: Landfall can receive from Landflow, not query it) |

| Variable | Meaning |
|---|---|
| `LANDFALL_SOURCE_PORT` | Port to listen on. Unset: no face. `0` picks a free port |
| `LANDFALL_SOURCE_HOST` | Interface (default loopback, or `0.0.0.0` when `LANDFLOW_ADVERTISE_HOST` is set, as in a container) |
| `LANDFALL_SOURCE_TOKEN` | Off by default. When set, every request must carry `Authorization: Bearer <token>`; enter the same token as the connection's bearer token in Landfall |

Create the connection in Landfall with this URL, run its health check, then put its id in the credential's Connection ID.

## The fake Landfall

`test/fake-landfall.ts` is an in-memory Landfall for the tests and for end-to-end flow runs: every route above, the three
token kinds, dedup by connection + `dedupKey` while a room is open (a repeat attaches and appends `trigger.repeated`; a
recovery appends `trigger.recovered`), `expectedSeq` conflicts (409), the refused event types, the applied-externally
checks, ended statuses, 422 for an unknown or unhealthy connection and 429 (a per-token counter, 300 per 60 s).

```sh
pnpm --filter @landflow/plugin-landfall fake-landfall            # FAKE_LANDFALL_PORT, default 7398
```

Seeded: org `acme`, API key `lf_key_fake_0123456789abcdef`, ingest token `fake-ingest-token-0123456789`, connection
`conn_landflow` (healthy) and `conn_down` (unhealthy), heartbeat `nightly-backup` with token
`fake-heartbeat-token-0123456789`. `GET /_fake/state` dumps incidents with their events, heartbeat pings and connections;
`POST /_fake/incidents/:id/status {"status":"resolved"}` sets a status (and appends `status.changed`);
`POST /_fake/connections/:id {"healthy":false}` flips a connection's health.

## Limits

- Only what Landfall's API offers: no incident status changes (resolving is a human decision in Landfall), and no runbook
  execution; Remediation records a fix someone or something applied elsewhere.
- Add Note is a `chat.message` event; the room shows it as a message from the API key's member.
- Open From Alert needs the ingest token and a healthy remote-source connection; the plugin does not create the connection.
- The trigger sees the 200 newest incidents of the organization per poll, and reads at most 20 timelines per poll.
- Landfall allows 300 requests per 60 s per client; a busy trigger plus actions share that budget.
