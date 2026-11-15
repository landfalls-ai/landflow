# Landledger plugin (`landledger`)

The bridge between Landflow and Landledger, the land family's cost subledger (budgets per cost center, spend from the
books, spend requests with approval policies, reservations, month close). Flows and agents check what a budget has
left, query spend, raise and read spend requests (a tool-or-seat request on a contract among them), reserve and release
budget, release a request's seats, read a month's status, its frozen close snapshot and the figures its variance notes
may cite, submit a note's draft, and estimate what a set of services cost over a time window; flows also relay a Slack
press, exactly as Slack signed it, for Landledger to verify. A signed webhook trigger starts a flow when a request waits
on its approvers or on a person's confirmation, is decided (also through a relay) or applied, a budget is at risk, a
seat goes back to its contract, a month starts closing, the close asks for variance notes, a note or an accrual is
accepted, a month is locked or reopened, the Datarails upload ran, or the exceptions report is stored. Written with the
TypeScript SDK; the same plugin answers over HTTP, gRPC, any installed broker and MCP. It follows Landledger's contract
as of commit `2ed51f3` ("Wave 4 contract: periods, close, accruals, notes, exports"; wave 3's contracts and seats from
`3fa1df4`; `docs/reference/api.md` and `libs/contracts/src/` in the Landledger repository) and `28dcf5a`'s rule that a
seat on a contract reserves seats, not money.

Landledger owns requests, policies and decisions; Landflow carries the conversation. **Agents request; people decide**:
an agent raises a request as itself, with a sponsor (the person who answers for it), and never decides. A key that
names a person (requester or sponsor) only proposes: the request waits in `awaiting_confirmation` until that person
confirms it in Landledger. A decision is a person's own, made in Landledger's console, or a Slack press that Landledger
verifies itself (Slack's signature, team and app, the presser's own link to a Landledger person). No key decides, and
no flow names who decided.

```sh
pnpm plugin:landledger                               # HTTP :7120, gRPC :7220, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-landledger test       # vitest against an in-memory fake Landledger, no network
pnpm --filter @landflow/plugin-landledger typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. No dependency beyond the SDK: HTTP goes through the
traced `ctx.http`.

## Credentials

Keys are split by what they may do; each node and trigger takes only the one it needs.

| Credential | Key | Used by |
|---|---|---|
| **Landledger API (ll_…)** (`landledgerApi`) | `read` and `requests:write` (`reservations:write` to reserve) | the Landledger node's every resource but Decision |
| the same type, a second credential | `webhooks:write` only | the Landledger Trigger: it subscribes itself on publish |
| **Landledger Relay Key (decisions:relay)** (`landledgerRelayApi`) | `decisions:relay` only | Decision → Relay |
| **Landledger Notes Key (notes:draft)** (`landledgerNotesKey`) | `notes:draft` only | Note → Figures and Note → Submit Draft |

Fields: **Base URL** (default `http://landledger-api.landflow-dev.svc.cluster.local:4810`, the ExternalName Service of
the `orbstack-clickland` overlay; `http://127.0.0.1:4810` on this machine, `http://host.docker.internal:4810` from
compose) and the key. `landledgerApi` also has an optional **Webhook Signing Secret** (`whsec_…`, see the trigger).

The test calls `GET /api/health`, then `GET /api/auth/me`, and reports the scopes: "Connected to Landledger <version>
as <key's name> (<key id>): read, requests:write". It warns when the key also holds `decisions:relay` (relays take
their own key) or `admin`. The relay credential's test **fails** when the key lacks `decisions:relay`, or holds it
together with `requests:write`, `reservations:write`, `webhooks:write`, `ingest` or `admin` (Landledger refuses to mint
such a key; this catches an old one); it warns about `read`. The notes key's test likewise **fails** without
`notes:draft` or with any of those write scopes, and warns about others (`read`). A drafting agent may hold the notes
key: it drafts, and an analyst in Landledger accepts or rejects. Landledger checks scopes on every call: `read` for
reads, `requests:write` to create a request, mark it applied or release its seats, `reservations:write` to reserve or
release, `webhooks:write` to manage the key's own webhooks, `decisions:relay` to relay, `notes:draft` to read a month's
note figures and submit drafts.

## Nodes

| Node (type) | What | Output |
|---|---|---|
| **Landledger** (`landledger.landledger`, usable as an AI tool) | **Budget** → Check · **Cost** → Query, Window · **Request** → Create, Get, List, Mark Applied, Cancel, Release Seats · **Contract** → Seats · **Reservation** → Create, Release · **Period** → Status · **Close** → Snapshot · **Note** → Figures, Submit Draft · **Key** → Who Am I · **Decision** → Relay (flows only) | see below |
| **Landledger Trigger** (`landledger.landledgerTrigger`) | app webhook: Landledger calls Landflow on `request.step_pending`, `request.needs_confirmation`, `request.decided`, `decision.relayed`, `request.applied`, `seat.released`, `budget.at_risk`, `period.closing`, `notes.draft_requested`, `note.accepted`, `accrual.accepted`, `period.locked`, `period.reopened`, `datarails.uploaded`, `report.exceptions` (and `request.created`, off by default) | one item per delivery: the event's `data` plus `type`, `id`, `timestamp`, `requestId`, `kind`, `costCenter` |

Parameters are read per item and every output item is paired with its input. Amounts are decimal strings with at most
six decimals (`1840`, `1840.5`; Landledger keeps micro-units). Errors read `Landledger API error 400: …` with
Landledger's own message and a hint: 401 (an `ll_` key, not a Landflow `lf_` key; for a relay, Slack's signature,
its age, team or app), 403 (the scope the call needs; for a relay, the presser is not linked, not an approver of the
step, is the requester or sponsor, or the step is not the budget owner's), 404, 409 (the request moved on, the evidence
was served more than 30 minutes ago, an idempotency key came back with another body, no seats are held, or a note's
snapshot is no longer the month's), 422 (USD only; for a note, the cited figures that differ from the snapshot, listed
as `mismatches`), 429, 503. A 429 waits for `Retry-After` (up to 10 s) and
retries once. **On Error: Continue** keeps the flow going with `{ error, description }`.

### Operations

| Operation | Route | Parameters | Output |
|---|---|---|---|
| Budget → **Check** | `GET /api/budgets?month=` | Cost Center, Month (default this month, UTC), Planned Amount | `{ costCenter, name, owner, month, currency, budget, actual, reserved, remaining, forecast, state, plannedAmount?, remainingAfter?, fits? }`: remaining is budget − actual (month to date) − reserved; with no budget, `fits` is false (an approval decides) |
| Cost → **Query** (`spend_by`) | `GET /api/spend` | Group By (cost center, team, product, service, namespace, agent, model, provider, P&L class, category, resource, workflow), A Month or A Range of Days, Filter (`dimension:value,…`), Layer (direct or spread), Include Today, Output (one item with total and groups, one item per group, or everything with the daily series) | the spend |
| Request → **Create** | `POST /api/requests` (`requests:write`) | Kind (`infra_change`, `ai_budget`, `tool_or_seat`, `other`), Title, Cost Center, Amount, Currency, Recurrence (monthly or once), Requested By (a person, or an agent with its sponsor), Note, Evidence (JSON: `lines`, `basis`, `links`, `match`); for `tool_or_seat`, Seat: Contract ID, Seats, Price per Seat a Month (sent as `seat`; amount = seats × price, monthly); Additional Fields: Start, End, Pull Request URL, Landbright Request (`REQ-n`) and its URL (kept as `related`), Break-Glass (Landbright) (the Landbright request becomes the origin with `breakGlass: true` and this run a related source: Landbright granted first, and Landledger lists the cost in its exceptions report until approved), Run URL, Origin Title, Submit, Idempotency Key | `{ request, created }`. `origin` is this run (`landflow_run`: workflow and execution; refused in a workflow not yet saved); Landledger sets `origin.verified` only for a key bound to that workflow, and `createdBy` to the key. A request naming a person waits in `awaiting_confirmation` for them. The idempotency key defaults to this step of this run, so a retried step raises nothing twice; `created: false` is a repeat with the same body, 409 the same key with another |
| Request → **Get** | `GET /api/requests/:id` | Request ID | `{ request, evidence, evidenceSha256 }`: the request with its steps, decisions and reservations, Landledger's evidence (the month now and with the request, the policy's reason, similar requests) and the hash of exactly that, which a relayed decision names |
| Request → **List** | `GET /api/requests?box=` | Box (waiting, mine, decided, open, all), Filters (status, kind, cost center), Limit | one item per request |
| Request → **Mark Applied** | `POST /api/requests/:id/applied` (`requests:write`) | Request ID, Note, Links (JSON) | the request, now `applied` |
| Request → **Cancel** | `POST /api/requests/:id/cancel` (`requests:write`) | Request ID, Reason | the request, `cancelled` (Landledger sends `request.decided`). Only a request not yet decided (`draft`, `awaiting_confirmation`, `pending`); 409 after. The creating key may cancel its own |
| Request → **Release Seats** | `POST /api/requests/:id/seats/release` (`requests:write`) | Request ID, Reason (`access_denied`, `grant_revoked`, `not_needed`), Note | the request, its seats back on the contract. 409 when it holds none; an applied seat is released only with `grant_revoked` |
| Contract → **Seats** | `GET /api/contracts/seats?landbrightApp=` | Landbright App | `{ found, landbrightApp, contract, seatPrice, left }`; no contract for that app: `found: false` (not an error) |
| Cost → **Window** | `GET /api/cost/window?services=&from=&to=` | Services (comma-separated, at most 50), From, To (at most 31 days) | `{ from, to, currency, basis: 'estimated', method, total, services: [{ service, known, amount, days }] }`: each day's cost by the share of the day inside the window; an unknown name is `known: false` and $0 |
| Close → **Snapshot** | `GET /api/close/:month/snapshot` | Month | the frozen snapshot of a month whose accrual was accepted, with its `sha256` |
| Note → **Figures** | `GET /api/notes/:month/figures` (`notes:draft`, the notes credential) | Month | `{ snapshotSha256, needed }`: per note (`TOTAL` and each cost center), the figures it may cite (actual, budget, day-10 forecast, the variances, drivers by key) |
| Note → **Submit Draft** | `POST /api/notes/:month/drafts` (`notes:draft`, the notes credential) | Month, Cost Center, Snapshot SHA-256, Text (10–8,000), Cited Figures (JSON `[{ figure, key?, amount }]`), Agent ID, Agent Name, Agent Runs In, Sponsor | the note's new version. Every cite must equal the snapshot's to the cent, else 422 with the mismatches; another snapshot, 409. `runId` is this run. As an agent tool, the agent fields are required. An analyst accepts it in Landledger; no key does |
| Reservation → **Create** | `POST /api/reservations` (`reservations:write`) | Request ID, Month (default: Landledger picks the next month of the window), Amount | `{ reservation, created }` |
| Reservation → **Release** | `POST /api/reservations/:id/release` | Reservation ID, Reason | the reservation |
| Period → **Status** | `GET /api/periods` | Month | `{ month, status (open, closing, locked), known, … }`; a month Landledger has not seen is open |
| Key → **Who Am I** | `GET /api/auth/me` | | `{ kind, id, name, scopes }`: the key this credential holds; a flow compares a request's `createdBy.id` with it |
| Decision → **Relay** | `POST /api/relays/slack` (`decisions:relay`, the relay credential) | Channel (Slack), Slack Body (default `{{ $json.rawBody }}`), Slack Signature (`{{ $json.headers['x-slack-signature'] }}`), Slack Timestamp (`{{ $json.headers['x-slack-request-timestamp'] }}`), Relay Channel ID (optional) | `{ request, decision }`. The body goes as Slack sent it; Landledger checks the signature with the channel's secret (5 minutes), the team and app, maps the presser through their own link, and records the decision as that person's. Only the budget owner's step of `infra_change`, `ai_budget`, `tool_or_seat` and `other` is relayable, and a reject needs a comment (Slack's modal), so a button reject is refused |

As an AI tool or over MCP the node is narrower, by design:

- **Request → Create** must say **Requested By: An Agent, With Its Sponsor**: an agent asks as itself, never in a
  person's name ("An agent raises a request as itself, with a sponsor").
- **Decision → Relay** is refused ("Decision → Relay is for flows only: an agent never decides") and the Decision
  resource is left out of the MCP tool list (`mcp: false`).
- MCP tools: `budget_check`, `close_getSnapshot`, `contract_getSeats`, `cost_query`, `cost_window`, `key_me`,
  `note_getFigures`, `note_submitDraft`, `period_getStatus`, `request_cancel`, `request_create`, `request_get`, `request_list`,
  `request_markApplied`, `request_releaseSeats`, `reservation_create`, `reservation_release`; the reads (`key_me`,
  `close_getSnapshot`, `contract_getSeats`, `cost_window` and `note_getFigures` among them) carry `readOnlyHint`.
- **Note → Submit Draft** as a tool must name the agent (Agent ID and Name): a draft is an agent's, sponsored by a
  person, and only a person accepts it.

There is no knowledge kind: Landledger has no explain or search route to answer a question with passages, so the node
is not offered as an agent's knowledge base. An agent reads Landledger through the tools above.

### Landledger Trigger

Landledger's webhooks follow Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`
over `id.timestamp.body` with the `whsec_` secret. Give the trigger its own credential with a `webhooks:write` key:
publishing the workflow subscribes it (`POST /api/webhooks` with the node's URL and the chosen events; a
`webhooks:write` key manages only its own webhooks) and keeps the id and the secret Landledger returns once in the
node's static data, which goes only to the plugin and is never shown by any Landflow API or page. `checkExists` lists
the key's webhooks and compares the URL and events, so a changed choice re-subscribes (the old subscription is removed
first); unpublishing deletes it (already gone is fine).

Or have a Landledger admin add a webhook for the node's URL (Publish menu → App webhooks) and put its `whsec_` secret in
the credential's **Webhook Signing Secret**: the trigger then registers nothing and checks every delivery with that
secret.

A missing, forged or stale signature (option **Signature Tolerance**, default and at most 300 s: a larger value is
held to 300) gets **401**. An event not chosen,
or a request of another **Kind** or **Cost Center** (comma-separated filters), gets `200 {"ignored": …}` and starts
nothing. The `webhook-id` (the same across Landledger's retries) is the idempotency key. A manual run outputs nothing.

Item, per event (`data` as Landledger sends it):

| Event | Item |
|---|---|
| `request.step_pending` | `request` (a summary: no evidence, steps or related), `step` `{ position, key, label, groups, deadlineAt, escalated }`, `approvers` `[{ name, email, sub, via, group }]`, `url` (the console's page), `evidenceSha256` |
| `request.step_pending` also | `relayable`: whether a Slack press may decide this step (the budget owner's) |
| `request.needs_confirmation` | `request`, `person` (who must confirm), `createdBy` (the key), `url` (where they confirm) |
| `request.decided` | `request`, `outcome` (`approved`, `rejected`, `cancelled`, `expired`), `decision` (the person's, or null), `reservations` |
| `decision.relayed` | `request`, `decision`, `person`, `channel`, `url` |
| `report.exceptions` | `id`, `sha256`, `from`, `to`, `generatedAt`, `rows`, `url` |
| `request.applied`, `request.created` | `request` |
| `budget.at_risk` | `month`, `costCenter`, `name`, `owner`, `state` (`risk`, `over`), `budget`, `actual`, `reserved`, `forecast` |
| `period.closing` | `month`, … |
| `seat.released` | `request`, the seats and the reason (`requestId` also from `data.requestId`) |
| `notes.draft_requested` | `month`, `snapshotSha256`, `needed` (the notes and the figures each may cite), `draftUrl`, `url` |
| `note.accepted`, `accrual.accepted`, `period.locked`, `period.reopened`, `datarails.uploaded` | the month and the record, as Landledger sends them |

plus `type`, `id` (the `webhook-id`), `timestamp`, and `requestId`, `kind`, `costCenter` lifted out of the request (null
for events without one), for joining a flow that raised the request: its `request.origin.workflowId` is that flow.

## Flows

Six templates in [`flows/`](flows) (Templates, from the marketplace), each with a runner test in
`apps/web/test/landledger-flows.test.ts`; see [docs/features/landledger.md](../../docs/features/landledger.md#flows).
Each has a slot per key (requests, webhooks and, for Slack, relay) and a Data Table of what it did, created with it.

- **Approve an infrastructure change** (`landledger-approve-infra-change.json`): a form or a pull request webhook →
  Request → Create (`infra_change`, naming the person who asks) → a row in **Landledger infra requests** (request,
  this run). The person confirms in Landledger (`request.needs_confirmation` → the flow posts the confirm link). On
  `request.decided` the flow acts only on a request its own key created (`createdBy` = Key → Who Am I), of kind
  `infra_change`, still `approved`, whose `origin.executionId` is a run of this workflow (its row); anything else is
  refused.
- **Raise or hold an AI budget** (`landledger-ai-budget.json`): On Usage Event (`ai.call`) → each agent past 80% of its
  monthly cap → Request → Create (`ai_budget`, as the agent with its sponsor; once a month per agent). On approval, or
  hourly for approved requests not yet applied: the new cap is the published cap plus the approved `amount` (never the
  evidence's figure), only for this key's verified request, at most one raise per agent a month; a raise already in
  place is only marked applied, and a failed publish puts the draft back and is retried (three tries) or reported.
  **Set Landflow's URL by hand** in **Settings** and **Raise settings** (`const LANDFLOW_URL`; in the cluster
  `http://landflow-host.landflow-dev.svc.cluster.local:3000`).
- **Ask the approver in Slack** (`landledger-slack-approver.json`): `request.step_pending` → a card per approver,
  recorded in **Landledger Slack cards** (request, step, evidence hash, channel, ts), with the hash's prefix and Approve
  only on a relayable step · Slack Trigger **Button Pressed** → only a press from the configured team and app
  (`SLACK_TEAM_ID`, `SLACK_APP_ID` in **Check the press**), on a recorded card, by a member who is not a guest, from
  another organization, deactivated or a bot → Decision → Relay (the raw press, the relay key) → the card says what
  happened; on 5xx or no answer it keeps its buttons and says Try again; a stale card is rebuilt with a fresh hash.
- **Tool or seat cost** (`landledger-tool-or-seat.json`), with Landbright's cost gate (spec 008, verified against
  Landbright's PR #5, not merged): Landbright's `request.created` for a request whose `costs` name a seat (signed event,
  JWT) → read it in Landbright → Contract → Seats → Request → Create (`tool_or_seat`, the seat terms, the Landbright
  request as `related`, idempotency `landbright-REQ-n`) → a row in **Landledger seat requests** and an annotation on the
  Landbright request (`landflow.seat_cost`). On `request.decided`: only this key's request raised by this flow → the
  annotation says approved or denied, and, behind `SETTLE_IN_LANDBRIGHT` (off until the PR merges), `POST
  /api/v1/requests/:id/steps/0/settle { outcome: approve | deny, reference: { system: Landledger, id, url }, reason }`
  while the gate waits. Break-glass skips the gate: the cost is raised afterwards with `breakGlass`, never settled, and
  marked used once approved. `grant.activated` → Mark Applied; access denied, or the gate run out (`expired`, `waitedOn:
  Landledger`) → Cancel an undecided cost request, or Release Seats (`access_denied`); the grant revoked or expired →
  Release Seats (`grant_revoked` or `not_needed`).
- **Draft variance notes** (`landledger-variance-notes.json`): `notes.draft_requested` → Close → Snapshot and Note →
  Figures (both must name the event's snapshot) → an AI Agent on a local Ollama model (`MODEL`, `OLLAMA_URL` in
  **Settings**; default `qwen3-coder:30b`) drafts one note per needed note, citing only the listed figures → Note →
  Submit Draft. A 422 (a figure that isn't the snapshot's) is redrafted once with Landledger's refusal; a second refusal
  is recorded and left to Landledger's template draft. Every outcome is a row in **Landledger note drafts**.
- **Incident cost to the room** (`landledger-incident-cost.json`), with the landfall plugin: Landfall Trigger (room
  ended) → Room → Get → the services (the alert's entity and hints, attached context) and the window (opened to the
  last `status.changed` to an ended state) → Cost → Window → Timeline → Add Note in the room: the estimated total and
  each service, "Estimated: … Not an invoiced figure.", and a link to Landledger's Explore. The landfall plugin has no
  postmortem operation, so it is a room note, and the note says so. Landfall knows nothing of Landledger.

## Tests

`test/landledger.test.ts` (every operation against the fake, the four credentials' tests, tool-or-seat requests,
break-glass origins, cancels and releases, Contract → Seats, Close → Snapshot, Note → Figures and Submit Draft with its 422 and 409, Cost → Window, the relay's raw press and
its refusals: forged signature, another team, unlinked, not an approver, the requester, stale evidence, Finance's
step, a key without the scope; the tool and MCP refusals, amounts, idempotency), `test/trigger.test.ts`
(subscription with a `webhooks:write` key and only its own, the secret never in an item, an admin-made subscription,
signed / forged / stale / filtered deliveries, the tolerance held to 300 s, the new events, `seat.released` and
`notes.draft_requested`) and `test/plugin.test.ts` (the manifest over HTTP and gRPC, the credentials per resource, the
MCP tool list and annotations): 58 tests. The fake (`test/fake-landledger.ts`) follows contract `2ed51f3`: scopes,
`createdBy`, bound keys, confirmation, person-only decisions, the Slack relay's checks, the 30-minute evidence window,
contracts and seats, the frozen snapshot, note figures and drafts checked to the cent, and the cost of a window.
