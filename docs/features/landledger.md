# Landledger

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

Landledger is the land family's cost subledger: budgets per cost center, spend from the books (cloud, AI, tools),
spend requests that an approval policy routes to people, reservations against a budget, and month close. It owns
requests, policies and decisions; Landflow carries the conversation: forms, pull requests, Slack cards, the AI budget
watch. **Agents request; people decide.** An agent raises a request as itself, with a sponsor (the person who answers for
it), and never decides; a decision is a person's own, made in Landledger's console or relayed by a key with
`decisions:relay` that names that person.

Landflow works with it in two ways:

- **The `landledger` plugin** ([plugins/landledger](../../plugins/landledger/README.md)): a node for budgets, spend,
  requests, reservations, periods and relayed decisions, usable as an agent tool and over MCP (narrower there: see
  below), and a signed webhook trigger for Landledger's events.
- **Flows**: [approve an infrastructure change](#approve-an-infrastructure-change),
  [raise or hold an AI budget](#raise-or-hold-an-ai-budget) and [ask the approver in Slack](#ask-the-approver-in-slack).

The plugin follows Landledger's wave 2 contract (its `docs/reference/api.md` and `libs/contracts/src/requests.ts`,
commit `acf95c6`) and is tested against an in-memory fake of it; see [Checked live](#checked-live) for what ran against
the real one.

## The plugin

| | |
|---|---|
| Package | `plugins/landledger` (TypeScript SDK), `pnpm plugin:landledger` |
| Ports | HTTP 7120, gRPC 7220 |
| Credential | **Landledger API (ll_…)**: Base URL (default `http://landledger-api.landflow-dev.svc.cluster.local:4810`; `http://127.0.0.1:4810` on this machine), API Key, optional Webhook Signing Secret (`whsec_…`) |
| Nodes | **Landledger** (Budget → Check · Cost → Query · Request → Create, Get, List, Mark Applied · Reservation → Create, Release · Period → Status · Decision → Relay), **Landledger Trigger** (app webhook) |
| Deploy | compose service `landledger`; Kubernetes `deploy/k8s/components/landledger` (the plugin and the `landledger-api` ExternalName Service), in the `orbstack-clickland` overlay; image `landflow/plugin-landledger` |

The operations, routes, outputs and scopes are in the [plugin README](../../plugins/landledger/README.md). The parts
that carry the rule above:

- **Request → Create** sends `origin` (this run: `landflow_run` with the workflow and execution) and an idempotency
  key (default: this step of this run), so a retried step raises nothing twice and the flow can find its own requests
  when they are decided. As an agent tool or over MCP it must say **Requested By: An Agent, With Its Sponsor**.
- **Request → Get** returns Landledger's evidence and `evidenceSha256`, the hash of exactly what was shown. A relayed
  decision names that hash, so Landledger can tell the person saw what it holds now.
- **Decision → Relay** needs `decisions:relay` and the person's Landbright identity (email or `sub`). Landledger checks
  the person is among the step's approvers and is not the requester or sponsor, and that the step is still current
  (409 otherwise). It is refused when the node runs as an agent tool or over MCP, and it is not in the MCP tool list.
- **No knowledge kind.** Landledger has no explain or search route that answers with passages, so the node is not
  offered as an agent's knowledge base; agents use `budget_check`, `cost_query`, `request_get` and the rest as tools.

The **Landledger Trigger** subscribes on publish (`POST /api/webhooks`; Landledger lets only an `admin` key manage
webhooks), or, without an admin key, checks deliveries with the `whsec_` secret of a webhook an admin made (put in the
credential). Every delivery is verified (Standard Webhooks signature, 300 s tolerance), filtered by event, kind and cost
center, and keyed by `webhook-id`, so Landledger's retries start one run. Its item lifts `requestId`, `kind` and
`costCenter` out of the request for joining.

## Flows

Three templates (Templates, from the marketplace), each tested end to end in `apps/web/test/landledger-flows.test.ts`
(the plugin's own node and trigger against its fake Landledger, a stand-in Slack, a fake Landflow API). A flow that
waits on a decision has two triggers: the one that raises the request, and a Landledger Trigger on `request.decided`
followed by **Raised by this flow**, a Filter on `request.origin.workflowId` equal to `$workflow.id`, which joins the
decision to the flow by the request itself. Nothing waits in between: a decision days later starts its own run.

### Approve an infrastructure change

[`landledger-approve-infra-change.json`](../../plugins/landledger/flows/landledger-approve-infra-change.json):

- **Infra change form** (`/form/infra-change`: what changes, cost center, monthly amount, the requester's Landbright
  email, pull request, note) or **Pull request webhook** (`POST /api/webhook/infra-change` with a header secret, the same
  fields in the body, e.g. from a CI job that sized the change) → **Shape the request** (Code) → **Ask Landledger**:
  Request → Create, `infra_change`, monthly, the person as requester, evidence `lines` / `basis` / `links`, the pull
  request as `related`.
- **Request decided** (`request.decided`, kind `infra_change`) → **Raised by this flow** → **Approved?** → yes:
  **Get the request** → **Apply the change** (a placeholder: merge, deploy, comment on the PR; then add Request → Mark
  Applied) → **Post the approval** (Slack, with who approved); no (rejected, cancelled, expired): **Tell the
  requester** (Slack, with the approver's comment).

Slots: Landledger (`requests:write`, `read`; `admin` or a webhook secret for the trigger), Slack, the webhook's header.

### Raise or hold an AI budget

[`landledger-ai-budget.json`](../../plugins/landledger/flows/landledger-ai-budget.json):

- **Agent AI calls** (On Usage Event, `ai.call`, five-minute batches) → **Settings** (Code: Landflow's URL, the cost
  center that pays for agents, the sponsor, the threshold 0.8, raise by 1.5× or 1.2× the forecast; one item per agent
  that spent) → **Read the agent** and **This month's AI cost** (HTTP Request with a Landflow `lf_` key:
  `GET /api/agents/:id`, `GET /api/usage?groupBy=agent&kinds=ai.call&agentId=&from=<month start>`) → **Over the
  threshold** (Code: the published monthly cap, the one enforced; spent ≥ 80% of it; the month's forecast; the new cap)
  → **Ask to raise the cap**: Request → Create, `ai_budget`, as the agent (`system: landflow`) with its sponsor, the
  extra monthly amount, evidence (the line, the basis in words, a link to the agent, `match: { agent }`, the cap, spent,
  forecast and `newMonthlyCap`). The idempotency key `ai-budget:<agent>:<month>:<cap>` makes it one request per agent,
  month and cap however many calls follow.
- **Request decided** (`ai_budget`) → **Raised by this flow** → **Approved?** → yes: **Raise settings** (Landflow's URL,
  `MAX_CAP`) → **Get the request** → **Read the agent now** → **Plan the raise** (Code: the request names this agent; the
  new cap is above the current one and under `MAX_CAP`; no unpublished edits, which publishing would ship too) → **Safe
  to raise?** → **Save the new cap** (`PUT /api/agents/:id` with the settings, only `monthlyCostLimit` changed) →
  **Published agent?** → **Publish the agent** (`POST /api/agents/:id/publish {"skipEval": true}`) → **Mark applied**
  (with a link to the agent). Not safe: **Hold: raise by hand**. Rejected, cancelled or expired: **Hold the cap** (the
  agent stops at it, as [agent caps](../agents.md) do).

Slots: Landledger, a Landflow API key that can read usage and read, save and publish agents.

### Ask the approver in Slack

[`landledger-slack-approver.json`](../../plugins/landledger/flows/landledger-slack-approver.json):

- **Step waits on approvers** (`request.step_pending`) → **Get the request** (the request, Landledger's evidence and
  its hash) → **One card per approver** (Code: Block Kit with the title, amount, cost center, who asked (an agent with
  its sponsor), the step and its deadline, the note, the month's numbers and the policy's reason, the evidence lines and
  links, and Approve / Reject / Open in Landledger; a button's value is `{ r: request, n: number, s: step, h: evidence
  hash }`) → **Find them in Slack** (User → Get by Email) → **Send the card** (a DM).
- **Button pressed** (Slack Trigger, **Button Pressed**: Interactivity's `block_actions`, signed) → **Approve or
  Reject** (the action ids) → **Who pressed** (User → Get: their Slack email is their Landbright identity) → **Relay the
  decision** (Decision → Relay with that email, the outcome, the hash and step from the button, channel `slack`, and for
  a reject "Rejected in Slack by <name>"; On Error: Continue) → **Say what happened** → **Update the card** (the buttons
  give way to "✅ R-12 approved by Amit Gal", or "⚠️ R-12: Landledger did not take your answer: …").

Slots: Landledger (`read`, `decisions:relay`), Slack (a bot token with `chat:write`, `users:read`, `users:read.email`,
and the signing secret). After publishing, set **Button pressed**'s URL as the Slack app's Interactivity Request URL.
The [Slack Trigger](../../plugins/messaging/README.md#slack-trigger) and User → Get were added for this flow.

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
