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
  requests, reservations, periods, the key in use and relayed Slack presses, usable as an agent tool and over MCP (narrower there: see
  below), and a signed webhook trigger for Landledger's events.
- **Flows**: [approve an infrastructure change](#approve-an-infrastructure-change),
  [raise or hold an AI budget](#raise-or-hold-an-ai-budget) and [ask the approver in Slack](#ask-the-approver-in-slack).

The plugin follows Landledger's contract as of `c3c0115` ("Review of wave 2: contract"; its `docs/reference/api.md`
and `libs/contracts/src/requests.ts`) and is tested against an in-memory fake of it; see [Checked live](#checked-live) for what ran against
the real one.

## The plugin

| | |
|---|---|
| Package | `plugins/landledger` (TypeScript SDK), `pnpm plugin:landledger` |
| Ports | HTTP 7120, gRPC 7220 |
| Credentials | **Landledger API (ll_…)**: Base URL (default `http://landledger-api.landflow-dev.svc.cluster.local:4810`; `http://127.0.0.1:4810` on this machine), API Key, optional Webhook Signing Secret (`whsec_…`); one with `read` + `requests:write` for the node, one with `webhooks:write` for the trigger. **Landledger Relay Key (decisions:relay)**: Base URL, a key with `decisions:relay` only, for Decision → Relay |
| Nodes | **Landledger** (Budget → Check · Cost → Query · Request → Create, Get, List, Mark Applied · Reservation → Create, Release · Period → Status · Key → Who Am I · Decision → Relay), **Landledger Trigger** (app webhook) |
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
- **No knowledge kind.** Landledger has no explain or search route that answers with passages, so the node is not
  offered as an agent's knowledge base; agents use `budget_check`, `cost_query`, `request_get` and the rest as tools.

The **Landledger Trigger** subscribes on publish (`POST /api/webhooks` with its `webhooks:write` key, which manages
only its own webhooks) and keeps the `whsec_` secret Landledger returns once in the node's static data, which no
Landflow API or page shows; or it checks deliveries with the secret of a webhook an admin made (put in the credential).
Every delivery is verified (Standard Webhooks signature, at most 300 s old), filtered by event, kind and cost center,
and keyed by `webhook-id`, so Landledger's retries start one run. It handles `request.needs_confirmation`,
`decision.relayed` and `report.exceptions` besides the request, budget and period events. Its item lifts `requestId`, `kind` and
`costCenter` out of the request for joining.

## Flows

Three templates (Templates, from the marketplace), each tested end to end in `apps/web/test/landledger-flows.test.ts`
(20 tests: the plugin's own node and trigger against its fake Landledger, a stand-in Slack, a fake Landflow API). A
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
