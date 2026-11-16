# Landledger

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

Landledger is the land family's cost subledger: budgets per cost center, spend from the books (cloud, AI, tools),
spend requests that an approval policy routes to people, reservations against a budget, and month close. It owns
requests, policies and decisions; Landflow carries the conversation: forms, pull requests, Slack cards, the AI budget
watch. **Agents request; people decide.** An agent raises a request as itself, with a sponsor (the person who answers for
it), and never decides. A key that names a person (a requester or a sponsor) only proposes: the request waits in
`awaiting_confirmation` until that person confirms it in Landledger. A decision is a person's own, made in Landledger's
console, or a Slack press Landledger verifies itself: the flow relays the press exactly as Slack signed it, and
Landledger checks the signature, the team and app and the presser's own link. No key decides, and no flow says who
decided.

Landflow works with it in two ways:

- **The `landledger` plugin** ([plugins/landledger](../../plugins/landledger/README.md)): a node for budgets, spend,
  requests, seats, reservations, periods, the month's close snapshot, variance-note drafts, the cost of a time window,
  the key in use and relayed Slack presses, usable as an agent tool and over MCP (narrower there: see below), and a
  signed webhook trigger for Landledger's events.
- **Flows**: [approve an infrastructure change](#approve-an-infrastructure-change),
  [raise or hold an AI budget](#raise-or-hold-an-ai-budget), [ask the approver in Slack](#ask-the-approver-in-slack),
  [a tool or seat cost](#tool-or-seat-cost) (with Landbright), [draft variance notes](#draft-variance-notes) (month
  end) and [an incident's cost to the room](#incident-cost-to-the-room) (with Landfall).

The plugin follows Landledger's contract as of `2ed51f3` ("Wave 4 contract: periods, close, accruals, notes, exports";
its `docs/reference/api.md` and `libs/contracts/src/`; wave 3's contracts and seats from `3fa1df4`) and is tested against an in-memory fake of it; see [Checked live](#checked-live) for what ran against
the real one.

## The plugin

| | |
|---|---|
| Package | `plugins/landledger` (TypeScript SDK), `pnpm plugin:landledger` |
| Ports | HTTP 7120, gRPC 7220 |
| Credentials | **Landledger API (ll_…)**: Base URL (default `http://landledger-api.landflow-dev.svc.cluster.local:4810`; `http://127.0.0.1:4810` on this machine), API Key, optional Webhook Signing Secret (`whsec_…`); one with `read` + `requests:write` for the node, one with `webhooks:write` for the trigger. **Landledger Relay Key (decisions:relay)**: Base URL, a key with `decisions:relay` only, for Decision → Relay. **Landledger Notes Key (notes:draft)**: Base URL, a key with `notes:draft` only, for Note → Figures and Submit Draft |
| Nodes | **Landledger** (Budget → Check · Cost → Query, Window · Request → Create, Get, List, Mark Applied, Cancel, Release Seats · Contract → Seats · Reservation → Create, Release · Period → Status · Close → Snapshot · Note → Figures, Submit Draft · Key → Who Am I · Decision → Relay), **Landledger Trigger** (app webhook) |
| Deploy | compose service `landledger`; Kubernetes `deploy/k8s/components/landledger` (the plugin and the `landledger-api` ExternalName Service), in the `orbstack-clickland` overlay; image `landflow/plugin-landledger` |

The operations, routes, outputs and scopes are in the [plugin README](../../plugins/landledger/README.md). The parts
that carry the rule above:

- **Separate keys.** The node's key holds `read` and `requests:write`; the trigger's, `webhooks:write`; the relay's,
  `decisions:relay` alone. Each credential's test reports its key's scopes; the relay credential's test fails for a key
  that also holds `requests:write`, `reservations:write`, `webhooks:write`, `ingest` or `admin`, and the node's warns
  when its key also holds `decisions:relay`.
- **Request → Create** sends `origin` (this run: `landflow_run` with the workflow and execution; a workflow not yet
  saved raises nothing) and an idempotency key (default: this step of this run), so a retried step raises nothing
  twice. Landledger records `createdBy` (the key) and sets `origin.verified` only when the key is bound to that
  workflow, so a flow acting on a decision checks both rather than trusting the origin it is shown. As an agent tool or
  over MCP it must say **Requested By: An Agent, With Its Sponsor**.
- **Request → Get** returns Landledger's evidence and `evidenceSha256`, the hash of exactly what was shown. A Slack
  card's button carries that hash; Landledger takes a press only on a hash it served in the last 30 minutes.
- **Decision → Relay** sends a Slack press as received (the raw body, `x-slack-signature`,
  `x-slack-request-timestamp`) to `POST /api/relays/slack` with the relay key. Landledger verifies the signature (5
  minutes), the team and app, maps the presser to a person through their own link, and decides as that person, only on
  the budget owner's step; the flow names no one. It is refused as an agent tool or over MCP and not in the MCP list.
- **Notes are drafted, never accepted, by a key.** Note → Submit Draft takes the notes key (`notes:draft` alone; its
  test fails for a key that also holds a write scope). Every cited figure must equal the frozen snapshot's to the
  cent: Landledger answers 422 with the mismatches, which the node's error carries, and 409 when the snapshot is no
  longer the month's. An analyst accepts or rejects the draft in Landledger. As an agent tool it must name the agent.
- **A seat on a contract** (Request → Create, kind `tool_or_seat`, Seat: Contract ID, Seats, Price) holds seats on the
  contract, not money (Landledger `28dcf5a`: "within contract" until Landbright prices seats); Request → Release Seats
  gives them back (`access_denied`, `grant_revoked`, `not_needed`), and Request → Cancel withdraws a request not yet
  decided. **Break-Glass (Landbright)** on Create makes the Landbright request the origin with `breakGlass: true` (this
  run a related source): Landledger reads break-glass only from the origin and lists the cost in its exceptions report
  until it is approved.
- **Cost → Window** is an estimate: each day's cost by the share of the day inside the window (`basis: 'estimated'`),
  for at most 50 services; an unknown name is `known: false` and $0. Landledger answers at most 31 days a call, so the
  node asks a longer window in 31-day parts (at most 12, a year) and adds them up to the micro-unit (`chunks`).
- **A 409 for an idempotency key names the request** Landledger already has (its `details.requestId`): the node's error
  ends `(request <id>)`, so a flow that lost the first answer finds the request again.
- **No knowledge kind.** Landledger has no explain or search route that answers with passages, so the node is not
  offered as an agent's knowledge base; agents use `budget_check`, `cost_query`, `request_get` and the rest as tools.

The **Landledger Trigger** subscribes on publish (`POST /api/webhooks` with its `webhooks:write` key, which manages
only its own webhooks) and keeps the `whsec_` secret Landledger returns once in the node's static data, which no
Landflow API or page shows; or it checks deliveries with the secret of a webhook an admin made (put in the credential).
Every delivery is verified (Standard Webhooks signature, at most 300 s old), filtered by event, kind and cost center,
and keyed by `webhook-id`, so Landledger's retries start one run. It handles `request.needs_confirmation`,
`decision.relayed`, `report.exceptions`, `seat.released` and wave 4's `notes.draft_requested`, `note.accepted`,
`accrual.accepted`, `period.locked`, `period.reopened` and `datarails.uploaded` besides the request, budget and period
events. Its item lifts `requestId`, `kind` and
`costCenter` out of the request for joining.

## Flows

Six templates (Templates, from the marketplace), each tested end to end in `apps/web/test/landledger-flows.test.ts`
(38 tests, and one live test under `LANDFLOW_INTEGRATION=ollama`: the plugin's own node and trigger against its fake Landledger, a stand-in Slack, Landbright and Ollama, a
fake Landflow API, and the landfall plugin against its fake Landfall). A
flow that waits on a decision has two triggers: the one that raises the request, and a Landledger Trigger on Landledger's
events. Nothing waits in between: a decision days later starts its own run, and the flow decides whether the request
is its own from Landledger's record, not from the event: who created it (`createdBy` against **Who is this flow**, Key
→ Who Am I), its kind and status now, and its origin (a row the raising run wrote, or `origin.verified`). Each flow has
a slot per key and a Data Table it creates with it.

### Approve an infrastructure change

[`landledger-approve-infra-change.json`](../../plugins/landledger/flows/landledger-approve-infra-change.json):

- **Infra change form** (`/form/infra-change`: what changes, cost center, monthly amount, who asks (their Landbright
  email; they confirm it in Landledger), pull request, note) or **Pull request webhook** (`POST
  /api/webhook/infra-change` with a header secret, the same fields in the body) → **Shape the request** → **Ask
  Landledger** (Request → Create, `infra_change`, monthly, that person as requester, evidence, the pull request as
  `related`) → **Remember the request** (a row in **Landledger infra requests**: the request, `$execution.id`, the
  workflow).
- The form is public and Landflow's form trigger has no signed-in user, so the requester is a claim: Landledger holds
  the request in `awaiting_confirmation`, and **Landledger events** (`request.needs_confirmation` and
  `request.decided`, kind `infra_change`, on its own webhooks credential) → **Which event** → **Raised here?** (the
  table) → **Post the confirm link** (Slack: "R-12 … waits for Eden Tzur to confirm it in Landledger before the
  approvers see it: <url>"). Only that person, signed in to Landledger, confirms it.
- `request.decided` → **Get the request** → **Who is this flow** → **Find the run that raised it** → **Ours to act
  on?** (Code): `createdBy` is this flow's key, the kind is `infra_change`, the origin names this workflow and a run of
  it that raised this request (its row), and the status is still `approved` → **Apply the change** (a placeholder) →
  **Post the approval**; rejected, cancelled or expired → **Tell the requester**; anything else → **Not this flow's:
  refused** (a forged origin, a request raised with the key outside the flow, one no longer approved).

Slots: Landledger requests (`read`, `requests:write`), Landledger webhooks (`webhooks:write`), Slack, the webhook's
header.

### Raise or hold an AI budget

[`landledger-ai-budget.json`](../../plugins/landledger/flows/landledger-ai-budget.json):

- **Agent AI calls** (On Usage Event, `ai.call`) → **Settings** → **Read the agent** and **This month's AI cost**
  (Landflow's API with an `lf_` key) → **Over the threshold** (spent ≥ 80% of the published cap) → **Ask to raise the
  cap** (Request → Create, `ai_budget`, as the agent with its sponsor, the extra monthly amount, evidence; idempotency
  key `ai-budget:<agent>:<month>`) → **Asked, or already asked** (Landledger's 409 for the same key with newer figures
  means it was asked this month). The sponsor confirms it in Landledger.
- **Request decided** → **Approved?** (rejected, cancelled, expired: **Hold the cap**) and **Every hour** → **Approved,
  not applied** (Request → List, this key's approved `ai_budget` requests) both go to **Raise settings** → **Get the
  request** → **Who is this flow** → **Read the agent now** → **Raises this month** (the table **Landledger AI cap
  raises**) → **Plan the raise** (Code):
  - only this key's request (`createdBy`), kind `ai_budget`, status `approved`, `origin.verified` for this workflow;
  - new cap = the published cap + the approved `amount` (the evidence's `newMonthlyCap` is ignored), under `MAX_CAP`;
  - one automatic raise per agent a month (an applied raise this month holds the next);
  - reconcile: a raise recorded for this request whose cap is already in force is only marked applied; a recorded
    publish failure is retried up to three tries, then held; an agent with unpublished edits is held.
- **What to do** → raise: **Record the raise** → **Save the new cap** → **Published agent?** → **Publish the agent** →
  **Published?** → **Mark applied** → **Record it applied**; a failed publish: **Put the cap back** (the draft returns
  to the published cap, so later raises aren't held for unpublished edits) → **Record the failed publish** → **Report:
  publish failed**, retried by the hourly run; publish only: **Record the retry** → **Publish the agent**; hold:
  **Hold: raise by hand**.

Slots: Landledger requests (a key bound to this workflow in Landledger, so its origins are verified), Landledger
webhooks, a Landflow API key that can read usage and read, save and publish agents. Set `LANDFLOW_URL` in **Settings**
and **Raise settings**.

### Ask the approver in Slack

[`landledger-slack-approver.json`](../../plugins/landledger/flows/landledger-slack-approver.json):

- **Step waits on approvers** (`request.step_pending`) → **Get the request** → **One card per approver** (Block Kit:
  title, amount, cost center, who asked, the step, the note, the month's numbers, the evidence; "Evidence <first 12 of
  the hash>… Finance and CFO steps are decided in Landledger, not Slack."; on a relayable step **Approve** (value
  `ll1|<request>|<step>|<hash>`) and **Reject in Landledger**, always **Open in Landledger**) → **Find them in Slack**
  → **Send the card** → **Record the card** (**Landledger Slack cards**: request, step, hash, channel, ts, approver).
- **Button pressed** (Slack Trigger, Button Pressed: the parsed press plus `rawBody` and the two Slack headers) →
  **Check the press** (team and app equal `SLACK_TEAM_ID` / `SLACK_APP_ID`, set in its code; a Landledger action; the
  presser's team) → **A press to relay** → **Find the card** (by channel and ts: an unknown card stops here) → **Who
  pressed** (User → Get) → **Check the card and who pressed** (the button matches the recorded card; not a guest, from
  another organization, deactivated or a bot) → **Relay it?** → **Relay the press** (the raw press, the relay key; On
  Error: Continue) or **Not relayed** → **Say what happened** → **Stale card?** → **Get the request now** → **Fresh
  card** → **Record the fresh card** → **Update the card**.
- Answers: approved ("✅ R-12 approved by Amit Gal", Open stays); refused ("⚠️ R-12: Landledger did not take your
  answer: …", Open stays); 5xx, 429 or no answer: the card keeps its buttons with "Landledger did not answer (…). Try
  again."; 409: the card is rebuilt with a fresh hash and recorded, to press again.
- A reject is made in Landledger: Landledger needs a comment for one, which a button can't carry.

Slots: Landledger requests (`read`), Landledger webhooks, Landledger relay (`decisions:relay` only), Slack (a bot token
with `chat:write`, `users:read`, `users:read.email`, and the signing secret). After publishing, set **Button pressed**'s
URL as the Slack app's Interactivity Request URL, and the same signing secret on Landledger's Slack relay channel.

### Tool or seat cost

[`landledger-tool-or-seat.json`](../../plugins/landledger/flows/landledger-tool-or-seat.json): a paid seat is spend.
Landledger's approvers decide the cost, Landbright's the access, and the flow carries the conversation, through
Landbright's **cost gate** (spec 008): a bundle's target says what a grant of it costs (`cost: { kind: seat,
landbrightApp }`), and its policy opens with an external step (always step 0) that Landledger's answer settles.
Checked against Landbright's branch `spec-008-seat-costs` (PR #5, `096d778`, not merged) with a stand-in in the tests,
not live: settling stays behind `SETTLE_IN_LANDBRIGHT`, off, until the PR merges.

1. **Landbright events** (Webhook, JWT Auth against Landbright's JWKS; Landbright's signed events) and **Landledger
   events** (`request.decided`, kind `tool_or_seat`) → **Settings** → **What happened** → **Raise, cost or access**.
2. `request.created` (its data carries `costs: ["linear"]` and `waitsOn: "Landledger"`) → **Read the Landbright
   request** (Landbright's API with the Landflow application's client credentials) → **Costs a seat?** (the request's
   `costs`; pending at the gate, or approved under break-glass; not an extension; `SEAT_APPS` in **Settings** only for
   a Landbright without spec 008) → **Find the contract** (Contract → Seats); none → **No contract: say so in
   Landbright** (an annotation).
3. **Ask Landledger for the seat** (Request → Create, `tool_or_seat`, the requester as the person, the contract's seat
   price, idempotency `landbright-<REQ-n>`; the Landbright request as `related`, or, after break-glass, as the origin
   with `breakGlass: true`) → **Asked, or already asked** → **Seat request in hand** → **Remember the seat request**
   (**Landledger seat requests**, an upsert) → **Note it in Landbright** (annotation `landflow.seat_cost`:
   `cost_asked`). The requester confirms it in Landledger. A 409 for the same key is a redelivery, or a run that stopped
   between Create and its row: **Get the request asked before** reads the request Landledger's 409 names (or, from a
   Landledger that names none, **This key's seat requests** → **Which request was it** finds it by its origin) → **Ours
   to record?** (this key, this workflow's run, this Landbright request) → the row, with the run Landledger's origin
   names, so its decision is acted on. A request already decided gets no `cost_asked` note: **Every hour** tells
   Landbright the decision.
4. `request.decided` → **Get the request** → **Who is this flow** → **Find the run that raised it** → **Ours to act
   on?** (this key's request, kind `tool_or_seat`, raised by a run of this workflow: its origin, or for break-glass the
   related `landflow_run`) → **Tell Landbright the cost** (`cost_approved` or `cost_denied`), or **Not this flow's:
   refused**.
5. **Read the gate** → **What Landbright needs**: the gate (step 0, `kind: external`, `system: Landledger`) still
   waiting and the setting on → **Settle the cost gate**: `POST /api/v1/requests/:id/steps/0/settle { outcome:
   "approve" | "deny", reference: { system: "Landledger", id: <request id>, url: <its console page> }, reason }` (scope
   `steps:settle`; only the application the gate's `settledBy` names, `landflow-local` in dev) → **Settled?** (Landbright
   answers 200 for the same answer again and 409 for another, or once the request moved on: said, not retried).
   Approve passes the request to Landbright's people; deny ends it (`step_denied`). Granted before the cost was decided
   (break-glass skipped the gate, or an extension's new grant): **Mark the seat used (granted first)** once Landledger
   approves. Not approved, with the grant live: Landbright's machine API has no route to revoke a grant (only an
   administrator or the holder can, in Landbright), so **Ask the approvers to revoke** puts a task on the Landbright
   request (annotation `landflow.seat_revoke`: `status: open`, `assignees` the request's approvers, the reason) and
   **Count the seat in use, unpaid** records it in **Landledger unpaid seats**: Landledger counts no seat for a request
   it did not approve, so the flow counts it until the grant is revoked or expires, when **Close the revoke task** marks
   the task `done` and the row `revoked`. Otherwise **Nothing to settle**, with why (the setting off, no gate, settled
   already).
6. Landbright's decision or a grant change → **Find its seat request** → **What the seat needs**: `grant.activated`
   (its data carries `requestId`) → **Mark the seat used** (Request → Mark Applied); access denied, or the gate run out
   (`request.decided` with `outcome: expired`, `waitedOn: Landledger`): a cost request not yet decided → **Cancel the
   cost request** (Request → Cancel), an approved one → **Release the seat** (`access_denied`); the grant revoked or
   expired → `grant_revoked` for a used seat, `not_needed` for one never used. **Pick the seat request** takes the
   newest row; with none, a `grant.activated` goes to **Costs a seat?** (an extension's new grant, or a break-glass
   grant whose `request.created` was missed).
7. An extension (Landbright's `extends`: the grant and the request it came from) at the gate → **Find the first seat
   request** → **Get the first seat request** → **Read the grant** (`GET /api/v1/grants/:id`) → **Extension or new
   seat?**: it rides on the first request's seat when that seat request is this flow's with its seat held (reserved or
   in use), the grant is still active and the new end (the grant's end plus the extension) is before the contract's
   renewal date. Riding: **Link it to the first seat request** (a row for the extension naming the first seat
   request), **Say it rides** (`cost_rides`), and, with the setting on and the gate waiting, **Settle the extension's
   gate** at once (`approve`, citing the first request). Otherwise (the grant ended, the seat went back, the new end
   crosses the renewal) **Ask Landledger for the seat** raises one of its own (`landbright-<REQ-n>` of the extension),
   saying why. An extension approved after its grant ended gets a new grant from Landbright: on its `grant.activated`,
   **What the seat needs** sees the row is the first request's and raises a seat request for the new grant, marked used
   once Landledger approves it.
8. **Every hour** (Schedule) → **Our seat requests** (this key's `tool_or_seat` requests) → **Which to look at** (no row,
   or not finished, from the last 35 days; and every unpaid seat) → **Get each seat request** → **Ours, with their
   Landbright request** → **Read each in Landbright** → **Plan the reconcile**: **Record the seat request** for one with
   no row (with the run that raised it); **Tell Landbright the decision** for one decided whose annotation doesn't say
   so (and settle the gate when the setting is on and it waits); then use, release or cancel the seat as step 6 would
   (a cost request whose Landbright request ended before its row existed is cancelled: a cancel that raced the Create),
   post the revoke task a stopped run missed, or close it once the grant has gone.

With the setting off, Landbright's gate is never settled: Landbright's approvers see the annotation, and a request
expires at the gate's deadline (24 hours by default), which the flow then answers by cancelling or releasing the seat.
The setting stays off: the two things the review asked for before it can be turned on (a rejected break-glass seat
and extensions at the gate) are built and tested against the stand-in, and Landbright's PR #5 is still not merged.

Slots: Landledger requests, Landledger webhooks, Landbright events (JWT Auth), Landbright API (OAuth2 client
credentials, `requests:read`, `annotations:write` and `steps:settle`). Subscribe **Landbright events**' URL in
Landbright to `request.created`, `request.decided`, `grant.activated`, `grant.revoked` and `grant.expired`.

### Draft variance notes

[`landledger-variance-notes.json`](../../plugins/landledger/flows/landledger-variance-notes.json), month end:

- **Notes requested** (`notes.draft_requested`: the month, the snapshot's hash, the notes needed) → **Settings**
  (`MODEL`, default `qwen3-coder:30b`, the local Ollama model the cluster's agents use; `OLLAMA_URL`, default
  `http://host.docker.internal:11434`; the agent's id `landflow:<workflow>` and name; `SPONSOR`) → **Get the snapshot**
  (Close → Snapshot, the read key) → **Get the figures** (Note → Figures, the notes key).
- **One note per cost center**: nothing when the snapshot, the figures and the event name different hashes (a newer
  close wins). Each needed note gets a prompt with its figures, one per line, each as the exact cite to copy
  (`{"figure":"variance_budget","amount":"-799.50"}: actual minus budget: under budget`), with the direction in words.
  Each amount is rounded as Landledger checks a cite: to the cent, half away from zero, on the decimal itself (a float's
  `toFixed(2)` said `1.00` for `1.005`, which Landledger refuses).
  A first prompt that listed names and values apart had qwen3-coder:30b cite a driver's change as the actual, twice
  (the redraft repeated it); with the cites as a menu it drafted both notes right on the first try in five runs
  (`LANDFLOW_INTEGRATION=ollama`, the fake Landledger checking every cite).
- **Draft the note** (AI Agent, JSON only, on **Local model**: Ollama with `{{ $json.model }}` at temperature 0.1) →
  **Shape the draft** (the text and the cites, taken leniently) → **Submit the draft** (Note → Submit Draft as the
  agent, with this run's id; On Error: Continue) → **Submitted or refused**.
- A refusal for a figure (Landledger's 422, its mismatches in the message) → **Redraft with the refusal** (the same
  prompt plus "Landledger refused your previous draft: …") → **Submit the redraft**. A second refusal gives up: the
  note is left to Landledger's template draft (`POST /api/notes/:month/template`, the controller's), which an analyst
  accepts as well.
- **Record the draft**: a row per note in **Landledger note drafts** (month, cost center, snapshot, outcome, attempt,
  note id and version, the refusal, the run).

Slots: Landledger (read), Landledger webhooks, Landledger notes (`notes:draft` only).

### Incident cost to the room

[`landledger-incident-cost.json`](../../plugins/landledger/flows/landledger-incident-cost.json), with the
[landfall plugin](../../plugins/landfall/README.md); Landfall knows nothing of Landledger and its code is unchanged:

- **Room ended** (Landfall Trigger, a room's status reaching an ended state; polls every 60 s) → **Settings**
  (`LANDLEDGER_CONSOLE_URL` for the link; `SERVICE_KINDS`, the entity kinds that are services; `SERVICE_NAMES`, a
  Landfall name → the name Landledger's Explore uses) → **Read the room** (Room → Get) → **Window and services**: the
  services from the alert's entity and entity hints and the context attached to the room; the window from the room's
  opening to its last `status.changed` to an ended state.
- **Services named?** → **Cost of the window** (Cost → Window; a room open longer than 31 days is asked in 31-day
  parts and added up) → **Write the note** → **Post it in the room** (Timeline → Add Note): "Pro-rated spend of these
  services during the incident (estimated), not the incident's extra cost: $53.25 (USD), … UTC (…)", a line per
  service (an unknown one: "no cost in Landledger under this name"), "Estimated: each day's cost of these services in
  Landledger, by the share of the day inside the incident's window: what they cost while it was open, not what the
  incident added. Not an invoiced figure.", a link to Landledger's Explore filtered to the services and month, and
  "Posted by Landflow as a room note: it can't write a postmortem section."
- When Landledger knows none of the services, the note opens "No matching services: cost unknown." and gives no
  total, never $0.00. A window over the 1st of a month says how much falls on that day: Landledger charges invoice lines
  that have no daily estimate on the 1st, whole, so that share may be part of a month's invoice rather than spend
  during the incident. A window asked in parts says so. Amounts are rounded as Landledger posts them (half away from
  zero). No service named → **No service named: nothing to cost**.
- The landfall plugin has no postmortem operation, so the cost goes in as a room note rather than a postmortem section.

Slots: Landfall (its API key), Landledger (read).

## Who flags what

Landledger flags a day of cost far from usual per cost center, service, agent and model, in its console and webhooks (a robust
score over the 14 days before it). Landflow flags the same way for a person, agent, workflow, project and model, from its own
AI spend, with Landledger's own check (same baseline, same 3.5 score, same half-the-median rule; see
[Forecasts and unusual spend](../llm-gateway.md#forecasts-and-unusual-spend)), and adds the forecast over a cap. The two
overlap on agents and models. By default both tell you, and the Landflow alert says so; turn on **Landledger alerts on agent
and model spikes** in the AI cost rule (Settings → Alerts) and Landflow sends no channel alert for those two (they still
show in Needs you and the inbox), so a spike is not announced twice. Landledger's trigger has no `cost.anomaly` event yet,
so a flow cannot start from Landledger's alert.

## Deploying

`deploy/k8s/components/landledger` adds the plugin (image `landflow/plugin-landledger:k8s-dev`, built on this machine)
and `landledger-api`, an **ExternalName Service** in `landflow-dev` pointing at `host.orb.internal`, where Landledger's
API listens on the Mac (`127.0.0.1:4810`, its own compose project). The credential's default Base URL,
`http://landledger-api.landflow-dev.svc.cluster.local:4810`, therefore works in the cluster without Landflow knowing
where Landledger runs; when Landledger moves into the cluster, the Service changes and the credentials stay. The
`orbstack-clickland` overlay includes the component before `clickland-observability`, so the plugin's telemetry goes to
Clickland like the rest:

```sh
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/node-plugin.Dockerfile \
  --build-arg PLUGIN=landledger --build-arg HTTP_PORT=7120 --build-arg GRPC_PORT=7220 -t landflow/plugin-landledger:k8s-dev .
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-clickland
```

Landledger's webhooks need to reach Landflow's published URL (`LANDFLOW_PUBLIC_URL`); from the Mac that is a port
forward or Landflow's compose stack, since the cluster's host URL is cluster-internal.

## Checked live

On 2026-11-14, on the OrbStack cluster (`orbstack-clickland`), against Landledger's wave 2 (`f78f8fc`) on the Mac:

| Check | Result |
|---|---|
| Plugin registered | `GET /api/plugins`: `landledger` online from `kubernetes` with its 2 nodes; `GET /api/health`: 14 plugins, 14 online |
| Credential | an `ll_` key with `read`, `requests:write` and `decisions:relay` (key name `landflow-cluster`), stored through `POST /api/credentials` with Base URL `http://landledger-api.landflow-dev.svc.cluster.local:4810` (the ExternalName); Test: "Connected to Landledger 0.1.0 as landflow-cluster (read, requests:write, decisions:relay)" |
| Infra change form | the template used and published; one submission (Live check: Landflow plugin, ENG-PLATFORM, USD 600 a month, Eden Tzur) ran `ex_4Msy4BrPfZWc` and raised `req_KKKMAdhv9Vr1Vp0f3KxS` (R-2). Landledger's `GET /api/requests/:id`: `pending`, step 1 of 2 (Budget owner: Amit Gal, Shira Navon; then Finance), `origin` `{ type: landflow_run, workflowId, executionId: ex_4Msy4BrPfZWc }`, created by the key, the policy's reason in the evidence |
| Slack relay path | the approver template published with a Slack credential whose Base URL was a local Slack stand-in; a `block_actions` press signed with that credential's signing secret, Approve by Tal Levi (`tal.levi@landbright.test`), ran `ex_MedAVqdSRVyq`: Who pressed → his email, Decision → Relay refused by Landledger (403 "This step is for Budget Owners; you aren't in it"), the card updated to say so. The request stayed pending with no decision. The same press with a wrong signature got 401 |
| Landledger → Landflow | the cluster's published URLs (`http://landflow-host.landflow-dev.svc.cluster.local:3000/…`) answer from the Mac directly (OrbStack resolves `*.svc.cluster.local` on the host), so Landledger can deliver without a port forward |

Not done: a real Landledger webhook delivery. Landledger lets only an `admin` key or a controller's session manage
webhooks, and the key has no `admin`, so publishing both flows reported "Landledger API error 403: This needs the admin
scope" for their Landledger Triggers. To finish it, a Landledger admin adds a webhook (events `request.step_pending`)
for `http://landflow-host.landflow-dev.svc.cluster.local:3000/api/webhook/app/<workflowId>/pending`, and puts its
`whsec_` secret in a Landledger credential of its own on that trigger. The next step pending delivers it, signed.
See [limitations](../limitations.md#landledger-built-2026-11-14).

### After the review (2026-11-15)

On the same cluster, against Landledger `fee9b0a` ("Review of wave 2: the fixes", contract `c3c0115`), with the
plugin and messaging images rebuilt and rolled out:

| Check | Result |
|---|---|
| Credentials | three replace `cred_y7J-Ss838xQT` (deleted once no workflow used it), all through the ExternalName URL: `cred__r3A-4itQ3HC` "Connected to Landledger 0.1.0 as landflow requests (key key_38RRNMBzm68Qf52nShJF): read, requests:write"; `cred_YxKARfZzGSxR` "… landflow webhooks …: webhooks:write"; `cred_RJzOergKTqUz` (Landledger Relay Key) "… landflow relay …: decisions:relay". The relay type's test with the requests key fails: "the key has no decisions:relay" |
| Republished | `wf_Vr8xJxZfFx` (infra) and `wf_M-jYpZuZfS` (Slack) took the new templates' graphs through the API (`PUT`, then publish; their tables created; Slack team `T_LANDDEV`, app `A_LANDLEDGER`). Both triggers subscribed with the webhooks key: Landledger lists `wh_FwBpmWDdbdr6e4hgdHVN` (`request.decided`, `request.needs_confirmation`) and `wh_4Tt1jg9cPrZRXaPQbJSK` (`request.step_pending`), created by "key:landflow webhooks", no secret in the listing |
| Infra form, naming Shira Navon | $700 a month on ENG-PLATFORM, submitted in a visible Chrome: run `ex_sunnxGgP-KtD` raised `req_nrdRQWwsfZDJQjGcY5GM` (R-3), `awaiting_confirmation` for Shira, `createdBy` the requests key, the run recorded in **Landledger infra requests**. Landledger's signed `request.needs_confirmation` (`evt_ebJH8eqy5wYAPHnYZbTH`) ran `ex_kK2hABXXr7gh`, which posted the confirm link to #infra-changes. The same URL with a forged signature: 401. R-3 is left for Shira |
| Slack cards for R-2 | R-2 was pending at the budget owner's step. Its `step_pending` predates the subscription, so the card path ran by hand with that step pinned on the trigger (`ex_MqfqBw9VgAGQ`): cards to Amit and Shira on the Slack stand-in, recorded (hash `4103d99a5d5c…`), Approve with `ll1|req_KKKMAdhv9Vr1Vp0f3KxS|1|<hash>`, Reject and Open in Landledger, the hash prefix and the Finance and CFO line |
| Presses (signed with Landledger's relay channel secret, team `T_LANDDEV`, app `A_LANDLEDGER`) | Tal Levi on a recorded card (`ex_x7RysiRpwSDx`): relayed raw with the relay key, Landledger answered 403 "This step is for Budget Owners; you aren't in it", the card kept Open in Landledger only. A wrong signature: 401 at the Slack Trigger, no run. A signed press on a card never sent (`ex_q7wJ_dt5JNri`): stopped at **Find the card**, nothing relayed. No press as Shira; R-2 stays pending with no decision |

The Slack stand-in was stopped; the Slack credential stays, named "Slack: simulated (no real Slack)".

### Month end, seats and incidents (2026-11-15)

On the same cluster, against Landledger's wave 4 (`b3616c3`, contract `2ed51f3`), with the plugin image rebuilt and
rolled out (17 MCP tools):

| Check | Result |
|---|---|
| Notes key | `LANDLEDGER_NOTES_KEY` from the land-family env file, piped into `POST /api/credentials` without printing it: `cred_0RU_DzuCRDcD` "Landledger notes (notes:draft)"; Test: "Connected to Landledger 0.1.0 as landflow notes (key key_xn2q9bbXpzvkVk8Mh87E): notes:draft" |
| Variance notes | the template imported (`tpl_fTbP6v_OoD`) and used as `wf_4RLZn8ZPgJ` with the requests, webhooks and notes credentials; published, its trigger subscribed with the webhooks key (`wh_CNc3ZfG6BjkdCD895kAV`, `notes.draft_requested`) |
| October's close | Landledger accepted October's accrual at 03:44:46 UTC, 18 minutes before the subscription, so its `notes.draft_requested` (once per snapshot) reached no Landflow URL. The event was replayed by hand from Landledger's own figures (the snapshot `9502767b…`, one note needed: TOTAL, $0.00, no budget or forecast) with it pinned on the trigger: run `ex_il6pr0k24cb-` → Close → Snapshot, Note → Figures, qwen3-coder:30b on the Mac's Ollama, Note → Submit Draft → `note_H42bbNJfcHT0Denz6dPF` version 1, `drafted`, "by landflow notes", agent `landflow:wf_4RLZn8ZPgJ`, the cite `actual 0.000000` checked against the snapshot; recorded in **Landledger note drafts** (`submitted`, attempt 1). An analyst accepts it in Landledger |
| Cost → Window | `GET /api/cost/window` answers in the shape the fake follows (`basis: estimated`, `method`, per-service `known`, `amount`, `days`) |
| Tool or seat cost | the template imported (`tpl_SXW930LlkK`) and not used: dev Landbright's gate requests REQ-9 and REQ-10 were settled with made-up references, so the flow runs only against its stand-in until Landbright's PR #5 merges |
| Incident cost | the template imported (`tpl_LTvyzkMAlD`) but can't be used on the cluster: it has no landfall plugin and no Landfall credential, so the flow ran only in its tests (`apps/web/test/landledger-flows.test.ts`, the landfall plugin against its fake Landfall) |

After the review fixes (`7c176b2`), the plugin image was rebuilt and rolled out again (17 MCP tools) and the three changed templates re-imported in place of the old ones: tool or seat cost `tpl_4797PIXfJL` (was `tpl_SXW930LlkK`; still not run), incident cost `tpl_6UTyN84CP2` (was `tpl_LTvyzkMAlD`; still needs the landfall plugin) and variance notes `tpl_TtvrSj_XDn` (was `tpl_fTbP6v_OoD`). `wf_4RLZn8ZPgJ` took the new money helper in **One note per cost center** and was published as version 4.

To draft a month's notes by hand when the event was missed, run the published workflow with the event pinned on
**Notes requested**: `POST /api/workflows/wf_4RLZn8ZPgJ/run` with `{ startNodeId: <the trigger's id>, workflow: { …the
workflow, pinData: { <the trigger's id>: [{ json: { type: 'notes.draft_requested', month, snapshotSha256, needed,
draftUrl, url } }] } } }`, where `snapshotSha256` and `needed` are `GET /api/notes/:month/figures` with the notes key.
