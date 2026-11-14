# Landledger plugin (`landledger`)

The bridge between Landflow and Landledger, the land family's cost subledger (budgets per cost center, spend from the
books, spend requests with approval policies, reservations, month close). Flows and agents check what a budget has
left, query spend, raise and read spend requests, reserve and release budget and read a month's status; flows also
relay a person's own decision from Slack, Teams or an email. A signed webhook trigger starts a flow when a request waits
on its approvers, is decided or applied, a budget is at risk, or a month starts closing. Written with the TypeScript
SDK; the same plugin answers over HTTP, gRPC, any installed broker and MCP. It follows Landledger's wave 2 contract
(`docs/reference/api.md` and `libs/contracts/src/requests.ts` in the Landledger repository, commit `acf95c6`).

Landledger owns requests, policies and decisions; Landflow carries the conversation. **Agents request; people decide**:
an agent raises a request as itself, with a sponsor (the person who answers for it), and never decides. A decision is a
person's own, made in Landledger's console or relayed by a key with `decisions:relay` that names that person.

```sh
pnpm plugin:landledger                               # HTTP :7120, gRPC :7220, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-landledger test       # vitest against an in-memory fake Landledger, no network
pnpm --filter @landflow/plugin-landledger typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. No dependency beyond the SDK: HTTP goes through the
traced `ctx.http`.

## Credential

**Landledger API (ll_…)** (`landledgerApi`): **Base URL** (default `http://landledger-api.landflow-dev.svc.cluster.local:4810`,
the ExternalName Service of the `orbstack-clickland` overlay; `http://127.0.0.1:4810` on this machine,
`http://host.docker.internal:4810` from compose), **API Key** (an `ll_` key from Landledger's console or
`pnpm keys:create`), and an optional **Webhook Signing Secret** (`whsec_…`, see the trigger). The test calls
`GET /api/health`, then `GET /api/auth/me`, and reads "Connected to Landledger <version> as <key's name> (<scopes>)". The scopes a call needs: `read` for reads, `requests:write` to create a request or
mark it applied, `reservations:write` to reserve or release, `decisions:relay` to relay, `admin` to manage webhooks.

## Nodes

| Node (type) | What | Output |
|---|---|---|
| **Landledger** (`landledger.landledger`, usable as an AI tool) | **Budget** → Check · **Cost** → Query · **Request** → Create, Get, List, Mark Applied · **Reservation** → Create, Release · **Period** → Status · **Decision** → Relay (flows only) | see below |
| **Landledger Trigger** (`landledger.landledgerTrigger`) | app webhook: Landledger calls Landflow on `request.step_pending`, `request.decided`, `request.applied`, `budget.at_risk`, `period.closing` (and `request.created`, off by default) | one item per delivery: the event's `data` plus `type`, `id`, `timestamp`, `requestId`, `kind`, `costCenter` |

Parameters are read per item and every output item is paired with its input. Amounts are decimal strings with at most
six decimals (`1840`, `1840.5`; Landledger keeps micro-units). Errors read `Landledger API error 400: …` with
Landledger's own message and a hint: 401 (an `ll_` key, not a Landflow `lf_` key), 403 (the scope the call needs, or
for a relay: the person is not an approver of the step, or is the requester or sponsor), 404, 409 (the request moved
on: decided, or the step the person saw is no longer current), 429, 503. A 429 waits for `Retry-After` (up to 10 s) and
retries once. **On Error: Continue** keeps the flow going with `{ error, description }`.

### Operations

| Operation | Route | Parameters | Output |
|---|---|---|---|
| Budget → **Check** | `GET /api/budgets?month=` | Cost Center, Month (default this month, UTC), Planned Amount | `{ costCenter, name, owner, month, currency, budget, actual, reserved, remaining, forecast, state, plannedAmount?, remainingAfter?, fits? }`: remaining is budget − actual (month to date) − reserved; with no budget, `fits` is false (an approval decides) |
| Cost → **Query** (`spend_by`) | `GET /api/spend` | Group By (cost center, team, product, service, namespace, agent, model, provider, P&L class, category, resource, workflow), A Month or A Range of Days, Filter (`dimension:value,…`), Layer (direct or spread), Include Today, Output (one item with total and groups, one item per group, or everything with the daily series) | the spend |
| Request → **Create** | `POST /api/requests` (`requests:write`) | Kind (`infra_change`, `ai_budget`, `tool_or_seat`, `other`), Title, Cost Center, Amount, Currency, Recurrence (monthly or once), Requested By (a person, or an agent with its sponsor), Note, Evidence (JSON: `lines`, `basis`, `links`, `match`), Additional Fields: Start, End, Pull Request URL, Run URL, Origin Title, Submit, Idempotency Key | `{ request, created }`. `origin` is this run (`landflow_run`: workflow and execution); the idempotency key defaults to this step of this run, so a retried step raises nothing twice. `created: false` is a repeat of the same key |
| Request → **Get** | `GET /api/requests/:id` | Request ID | `{ request, evidence, evidenceSha256 }`: the request with its steps, decisions and reservations, Landledger's evidence (the month now and with the request, the policy's reason, similar requests) and the hash of exactly that, which a relayed decision names |
| Request → **List** | `GET /api/requests?box=` | Box (waiting, mine, decided, open, all), Filters (status, kind, cost center), Limit | one item per request |
| Request → **Mark Applied** | `POST /api/requests/:id/applied` (`requests:write`) | Request ID, Note, Links (JSON) | the request, now `applied` |
| Reservation → **Create** | `POST /api/reservations` (`reservations:write`) | Request ID, Month (default: Landledger picks the next month of the window), Amount | `{ reservation, created }` |
| Reservation → **Release** | `POST /api/reservations/:id/release` | Reservation ID, Reason | the reservation |
| Period → **Status** | `GET /api/periods` | Month | `{ month, status (open, closing, locked), known, … }`; a month Landledger has not seen is open |
| Decision → **Relay** | `POST /api/requests/:id/decisions` (`decisions:relay`) | Request ID, Outcome (approve, reject), Person (their Landbright email or `sub`), Evidence SHA-256, Comment (3 characters or more to reject), Step (0: not checked), Channel (slack, teams, email, landflow) | `{ request, decision }` |

As an AI tool or over MCP the node is narrower, by design:

- **Request → Create** must say **Requested By: An Agent, With Its Sponsor**: an agent asks as itself, never in a
  person's name ("An agent raises a request as itself, with a sponsor").
- **Decision → Relay** is refused ("Decision → Relay is for flows only: an agent never decides") and the Decision
  resource is left out of the MCP tool list (`mcp: false`).
- MCP tools: `budget_check`, `cost_query`, `period_getStatus`, `request_create`, `request_get`, `request_list`,
  `request_markApplied`, `reservation_create`, `reservation_release`; the first five carry `readOnlyHint`.

There is no knowledge kind: Landledger has no explain or search route to answer a question with passages, so the node
is not offered as an agent's knowledge base. An agent reads Landledger through the tools above.

### Landledger Trigger

Landledger's webhooks follow Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`
over `id.timestamp.body` with the `whsec_` secret. Publishing the workflow subscribes it (`POST /api/webhooks` with the
node's URL and the chosen events; Landledger lets only an `admin` key manage webhooks) and keeps the id and secret in
the node's static data; `checkExists` lists Landledger's webhooks and compares the URL and events, so a changed choice
re-subscribes (the old subscription is removed first); unpublishing deletes it (already gone is fine).

Without an admin key, have a Landledger admin add a webhook for the node's URL (Publish menu → App webhooks) and put its
`whsec_` secret in the credential's **Webhook Signing Secret**: the trigger then registers nothing and checks every
delivery with that secret.

A missing, forged or stale signature (option **Signature Tolerance**, default 300 s) gets **401**. An event not chosen,
or a request of another **Kind** or **Cost Center** (comma-separated filters), gets `200 {"ignored": …}` and starts
nothing. The `webhook-id` (the same across Landledger's retries) is the idempotency key. A manual run outputs nothing.

Item, per event (`data` as Landledger sends it):

| Event | Item |
|---|---|
| `request.step_pending` | `request` (a summary: no evidence, steps or related), `step` `{ position, key, label, groups, deadlineAt, escalated }`, `approvers` `[{ name, email, sub, via, group }]`, `url` (the console's page), `evidenceSha256` |
| `request.decided` | `request`, `outcome` (`approved`, `rejected`, `cancelled`, `expired`), `decision` (the person's, or null), `reservations` |
| `request.applied`, `request.created` | `request` |
| `budget.at_risk` | `month`, `costCenter`, `name`, `owner`, `state` (`risk`, `over`), `budget`, `actual`, `reserved`, `forecast` |
| `period.closing` | `month`, … |

plus `type`, `id` (the `webhook-id`), `timestamp`, and `requestId`, `kind`, `costCenter` lifted out of the request (null
for events without one), for joining a flow that raised the request: its `request.origin.workflowId` is that flow.

## Flows

Three templates in [`flows/`](flows) (Templates, from the marketplace), each with a runner test in
`apps/web/test/landledger-flows.test.ts`; see [docs/features/landledger.md](../../docs/features/landledger.md#flows):

- **Approve an infrastructure change** (`landledger-approve-infra-change.json`): a form or a pull request webhook →
  Request → Create (`infra_change`, evidence) · Landledger Trigger `request.decided` → this flow's requests → approved:
  Get, the change (a placeholder), a Slack post; otherwise a Slack post with the comment.
- **Raise or hold an AI budget** (`landledger-ai-budget.json`): On Usage Event (`ai.call`) → each agent past 80% of its
  monthly cap → Request → Create (`ai_budget`, as the agent with its sponsor) · `request.decided` → approved: save and
  publish the raised cap through Landflow's API, Mark Applied; rejected, or an agent with unpublished edits: hold.
- **Ask the approver in Slack** (`landledger-slack-approver.json`): `request.step_pending` → Get → a card per approver
  with Approve / Reject · Slack Trigger **Button Pressed** → who pressed (their Slack email) → Decision → Relay → the
  card says what happened.

## Tests

`test/landledger.test.ts` (every operation against the fake, errors and hints, the tool and MCP refusals, amounts),
`test/trigger.test.ts` (registration with an admin key, an admin-made subscription, signed / forged / stale / filtered
deliveries, the Standard Webhooks signature) and `test/plugin.test.ts` (the manifest over HTTP and gRPC, the MCP tool
list and annotations): 33 tests. The fake (`test/fake-landledger.ts`) keeps requests, approvers, reservations and
webhooks in memory and answers with the contract's shapes and errors.
