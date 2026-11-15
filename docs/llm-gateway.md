# The LLM gateway (LiteLLM)

Every model call can go through one door: a [LiteLLM](https://docs.litellm.ai) proxy in front of the models. Landflow's
own calls (agents, chat model nodes, Spotlight, the brain, the model router) and the agents it deploys to kagent all
send their requests there. LiteLLM keeps a spend log, holds the virtual keys and enforces budgets; Landflow keeps the
caps people see and decide by. LiteLLM's budgets are the backstop: they stop whatever slips past Landflow, such as an
agent running on kagent.

Only LiteLLM's open-source build is used: virtual keys, teams, customers (end users), budgets and spend logs. Its
Customer Portal and organizations are not used by default (the portal is not in a release yet; organizations need
Enterprise).

## Run it

The `llm-gateway` profile of `landflow-infra` runs LiteLLM next to the infra Postgres. It is opt-in:

```bash
COMPOSE_BAKE=false docker --context orbstack compose -p landflow-infra -f deploy/compose.infra.yml --profile llm-gateway up -d --wait
```

- **Ports and URLs.** One port, `127.0.0.1:54100` (`LANDFLOW_LLM_GATEWAY_PORT`), for the API and the admin UI. It is on
  loopback on purpose, not `LANDFLOW_BIND_ADDR`, because the UI shares it. `http://127.0.0.1:54100/v1/messages` and
  `/v1/chat/completions` take calls, `/health/liveliness` is the probe, `/ui` is the login.
- **The image.** `ghcr.io/berriai/litellm:v1.108.2-lts`, pinned by index digest
  `sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d` (linux/arm64 and linux/amd64), chosen on
  2026-11-15. On 21 October 2026 a supply-chain compromise poisoned `v1.107.0` and its moving tags, and LiteLLM rotated its
  image-signing key on 23 October. Never use `v1.107.0`, `latest`, `main-latest`, `main-stable`, `-nightly` or `-dev`.
  The digest was read with `docker buildx imagetools inspect`; the pinned `cosign.pub` has the expected SHA-256
  (`e3fe3e08...`). **The signature was not verified with cosign on this machine** (it is not installed): run
  `deploy/scripts/verify-litellm-image.sh` where cosign is. It also checks the tag and the pin.
- **The database.** `litellm` in the infra Postgres (`postgresql://landflow:landflow-dev-only@postgres:5432/litellm`),
  created by the one-shot `llm-gateway-db` service when missing. LiteLLM migrates it on start (the healthcheck waits 60 s).
- **Development keys.** Master key `sk-landflow-dev-master-only`, salt key `sk-landflow-dev-salt-only` (never change it
  once keys exist: it encrypts what LiteLLM stores), UI login `admin` / `landflow-dev-only`. They come from
  `LANDFLOW_LLM_GATEWAY_MASTER_KEY`, `_SALT_KEY`, `_UI_USERNAME` and `_UI_PASSWORD` in `deploy/.env`; real ones go there.
- **Models.** [`deploy/llm-gateway/config.yaml`](../deploy/llm-gateway/config.yaml) lists `qwen3-coder:30b` and `qwen3.8`
  on the host's Ollama (`ollama_chat/` serves both `/v1/messages` and `/v1/chat/completions`). To add a model, append a
  `model_list` entry and restart the service. Every model name a client sends must be listed. Ollama models have no
  price, so LiteLLM reports cost 0 for them and Landflow prices them from its own table.
  A third name, `landflow-live-priced`, is `qwen3-coder:30b` with a made-up price of $0.001 a token. It exists only so
  the live budget test can spend a budget (a free model never does); Landflow does not use it.
- **Kubernetes.** `kubectl --context orbstack apply -k deploy/k8s/examples/llm-gateway` in `landflow-dev` (it needs the
  `postgres` component): a database Job, a one-replica Deployment and the Service `llm-gateway` on port 4000, with the
  same pinned image. The image runs as root, so the pod does not set `runAsNonRoot`. The UI: `kubectl --context orbstack
  -n landflow-dev port-forward svc/llm-gateway 54100:4000`.
- **From kagent.** In kind or on OrbStack, agents reach it at `http://host.docker.internal:54100` (compose) or
  `http://llm-gateway:4000` (the Kubernetes example).

## Point Landflow at it

Landflow's own calls (agents, the chat model nodes, Spotlight, the brain, the model router) can go through the gateway.

**On a credential.** The **Anthropic API** and **OpenAI API** credentials have a **Gateway** field: *None (call the
provider)* or *LiteLLM*. With LiteLLM, the Base URL is your proxy and the API key a LiteLLM virtual key:

| Credential | Base URL | Calls |
|---|---|---|
| Anthropic API | `http://127.0.0.1:54100` (the proxy's root) | `/v1/messages` |
| OpenAI API | `http://127.0.0.1:54100/v1` | `/v1/chat/completions` |

**Test connection** says "Connected to LiteLLM: N models" (and why not, if it can't). The credential has no admin key
field on purpose: the master key is never stored in a credential (a member who can edit a credential could point its URL
somewhere and receive it). The spend import, the budgets sync and the keys for kagent use only `LANDFLOW_LLM_GATEWAY_ADMIN_KEY`
on the server, sent only to `LANDFLOW_LLM_GATEWAY_URL`.

**Without a credential.** A deployment sets `LANDFLOW_LLM_GATEWAY_URL` and `LANDFLOW_LLM_GATEWAY_KEY` (a virtual key). Settings →
AI → LLM gateway names a credential instead and wins over them.

**Agents and chat model nodes.** An agent whose model credential has Gateway set to LiteLLM calls the proxy. So does the
Anthropic Chat Model node with such a credential, and the router's models. The model picker lists what the gateway serves
(`GET /v1/models` with the virtual key, cached for 60 seconds), each marked "via LiteLLM"; a normal Anthropic credential still
lists Claude's fixed models. The Anthropic Chat Model node's own model dropdown stays the fixed list: type the gateway's model
name in an agent, or use the OpenAI Chat Model node, whose list comes from the gateway.

**Spotlight and the brain.** `litellm/<model>` as the model override, or `LANDFLOW_BUILDER_MODEL=litellm/qwen3-coder:30b`, uses the
instance's gateway, resolved at call time, over the OpenAI-compatible path. With no gateway: "No LLM gateway: set one in Settings
→ AI → LLM gateway, or LANDFLOW_LLM_GATEWAY_URL".

**Who is calling.** Every call through a gateway sends ids (never names or emails):

| Header | Value | LiteLLM uses it for |
|---|---|---|
| `x-litellm-end-user-id` | `landflow-user-<id>` of the person who started the run | spend and budget per customer |
| `x-litellm-tags` | `landflow`, `landflow-project:<id>`, `landflow-agent:<id>`, `landflow-workflow:<id>`, `landflow-surface:<name>`, `landflow-runtime:landflow` | spend by tag |
| `x-litellm-spend-logs-metadata` | JSON with `landflow: "in-process"` (or `"unmetered"` outside a usage scope) and the ids above | the spend log, for reading; the spend import does not trust it |
| `x-litellm-trace-id` | the execution id, else the session id | grouping calls of one run |

A person is only named when a person started the run. The project is the run's: the project the caller chose or the server resolved for the run, else the home project of the agent or workflow. When the meter takes over a spend row the import read first, the row gets the run's goal too, but the usage event stays the import's and has no goal. With **Settings →
AI → LLM gateway → Customer Portal headers** on, `x-litellm-customer-org-alias` and `x-litellm-customer-member-id` are sent too. It is
off: the portal is not in a LiteLLM release yet.

**No fallback beta.** Landflow's normal Anthropic calls send `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`
so Anthropic retries a declined request on its fallback model. Through a gateway Landflow sends neither: LiteLLM routes its own
fallbacks, and an unknown beta must not reach a model that is not Anthropic's. `output_config.effort` is sent only for `claude-`
models.

**The call id and the cost.** LiteLLM answers each call with `x-litellm-call-id` and `x-litellm-response-cost`. Landflow keeps both on
the call it records: the `ai_usage` row has `call_id`, `source = landflow`, `runtime = landflow`, `project_id` and `gateway_cost`, and the
`ai.call` event has `callId` and `gatewayCost`. Through the server-configured gateway the row also keeps the id the gateway gave
the response (`gateway_request_id`: the body's `id`, a stream's first chunk or `message_start`), which LiteLLM files as the spend
row's `request_id`, so the spend import never counts the call again. The cost
that counts in caps and Insights is Landflow's own price table. For a model with no price, the gateway's cost is used only when
the call went to the gateway the server is configured with (`LANDFLOW_LLM_GATEWAY_URL`). A gateway named only by a credential could
under-report, so its cost is stored and shown as "gateway says" and nothing more.

**A spent budget is a cap.** When LiteLLM refuses a call because a budget is spent, Landflow shows "The LLM gateway stopped the call: the
budget of <customer, team or key> is spent. Ask for a higher cap on Insights → AI." like any other cap, not as a crash.

**Outbound policy.** `LANDFLOW_LLM_GATEWAY_URL` is reachable in production like `OLLAMA_URL`. A gateway named only by a credential follows
`LANDFLOW_OUTBOUND_ALLOW` like any other Base URL.

## Agents outside Landflow

Agents Landflow deploys to kagent (kagent's own runtime, and Claude Code as kagent's harness) call their model from
inside the cluster, where Landflow's meter does not see them. Through the gateway each such agent gets a virtual key of
its own, and the spend import counts its calls in `ai_usage` once each, so Insights, the AI page and the usage caps see
them.

**When an agent goes through the gateway.** All three must hold when it is deployed: the gateway has a **cluster URL**
(how kagent's agents reach it: Settings → AI → LLM gateway, or `LANDFLOW_LLM_GATEWAY_CLUSTER_URL`, for example
`http://host.docker.internal:54100`), the server has the **admin key** (`LANDFLOW_LLM_GATEWAY_URL` together with
`LANDFLOW_LLM_GATEWAY_ADMIN_KEY`; never a credential field), and the gateway **serves the agent's model**. Otherwise the
agent calls its model directly, as before, and the deploy result says why ("Calls the model directly: the gateway does not
serve qwen3.8"). An instance with no gateway at all changes and says nothing.

**The key.** One virtual key per agent and runtime, with the alias `landflow-kagent-<agent id>` or
`landflow-claude-<agent id>`. Landflow mints it with the admin key the first time the agent is deployed, seals it with the
credential vault (`llm_gateway_keys`) and writes it to the `api-key` of the agent's Secret `<name>-landflow` in kagent.

- The key may call only the agent's model.
- Its **budget is the agent's own dollar limit** (Guardrails: the daily limit as `1d`, else the monthly one as `30d`),
  with no headroom: nothing else stops a call made on kagent. An agent with no dollar limit gets a key with no budget.
- It belongs to the agent's project team (`landflow-project-<id>`) when LiteLLM has that team, and carries
  `spend_logs_metadata` (`landflow: runtime`, the runtime, the agent and the project) that LiteLLM copies to every spend
  row of the key.
- A redeploy reuses the key and updates it when the model, the team or the budget changed. Publishing a new version of the
  agent writes it again, so a changed limit follows.
- Removing the agent from kagent (the kagent card's Remove, deleting the agent, also when kagent can't be reached) **blocks**
  its keys; moving it to the other runtime blocks the old runtime's key. Landflow never deletes a key (or anything else) in
  LiteLLM: an admin does that in LiteLLM's UI. Deploying the agent again unblocks its key.
- Keys are not rotated (`/key/regenerate` is Enterprise).

**kagent's ModelConfig.** With a key, the ModelConfig calls the gateway and the Secret's `api-key` is the virtual key:

| Agent | Provider | Base URL |
|---|---|---|
| kagent's own runtime, Anthropic model | `Anthropic` | the cluster URL |
| kagent's own runtime, OpenAI or Ollama model | `OpenAI` | the cluster URL plus `/v1` |
| Claude Code, Anthropic or Ollama model | `Anthropic` | the cluster URL |

The gateway serves Ollama's models in the OpenAI format, so an Ollama agent's own Ollama address is not used. Without a
key the ModelConfig is exactly what it was without a gateway.

**The Claude Code harness.** Its sandbox only reaches the origins its EgressPolicies allow. For a Claude Code agent routed
through the gateway, the EgressPolicy `<name>-landflow` also lists the gateway's origin (next to Landflow's own, when the
landflow-harness mod is in; the policy holds the gateway alone otherwise). So the sandbox can reach the gateway, and the key's
budget is what bounds what it can spend there. The gateway origin has to be a DNS name (kagent's schema takes no IP
address).

**The spend import.** The leader reads LiteLLM's spend log (`/spend/logs/v2`) with the admin key every
`LANDFLOW_LLM_GATEWAY_INGEST_SECONDS` (300 by default; 30 to 86400; the first run 20 s after start), while Settings → AI →
LLM gateway has the import on (it is by default).

- **Window.** From the last run's end minus 15 minutes (LiteLLM writes spend in batches, so late rows must not be lost; the
  first run reads the last 24 hours) to one minute ago, in chunks of one hour, oldest first, each in pages of 500 until a
  page is empty (at most 200 pages a chunk). LiteLLM caps only the total it advertises (`total_is_capped`), never the
  data, so the import ignores that flag. The last run's end moves only over chunks read to an empty page: a run that fails
  or hits the page cap keeps its place and says so in its status, and the next run reads the rest.
- **Skipped.** Failed calls; rows with no tokens and no spend; and a spend row whose `request_id` is already in
  `ai_usage`: imported before, or a call Landflow's meter counted (it keeps the response id from the server-configured
  gateway, `LANDFLOW_LLM_GATEWAY_URL`). The response id is the gateway's, never the caller's. A caller can set its own
  call id (`x-litellm-call-id`), so the call id pairs only a call with no response id (embeddings) made with the server's
  own key (`LANDFLOW_LLM_GATEWAY_KEY`): only the server holds it and Landflow mints those call ids. One Landflow row takes
  one spend row, and the pairing is written on it (`gateway_request_id`). Nothing the caller sends (the `in-process`
  metadata) and no credential's key makes the import skip a row: a key holder could otherwise hide their spend.
- **When the import is first.** A long call can be logged before Landflow's meter records it. The meter then takes the
  imported row over (found by the response id, or on the server's key by the call id): still one row, now with the
  person and the run, at the higher of the two prices (a takeover never lowers spend). The `ai.call` event stays the
  import's, so the usage ledger keeps the key's agent and project and the import's price for that call.
- **Response caching stays off.** A LiteLLM cache hit answers with an earlier response's id. Landflow keeps no response id
  from a reply marked as a cache hit (`x-litellm-cache-key`), but the shipped configs leave LiteLLM's cache off; turning
  it on is not supported.
- **Attribution.** Only from what Landflow controls: the key's row in `llm_gateway_keys` gives the runtime, the agent
  and the project; else the project from the key's team (`landflow-project-<id>`, which an admin assigns). A row made
  with the server's own key (`LANDFLOW_LLM_GATEWAY_KEY`) is runtime Landflow. Anything else is runtime `other`, with no
  agent. No person is taken from the call: the end user, tags and metadata are the caller's word, and a key holder could
  otherwise charge another person's cap.
- **What it writes.** One `ai_usage` row per spend row: `source = 'litellm'`, the runtime, the agent and the project (no
  person, see Attribution), LiteLLM's `request_id` as `gateway_request_id` (an index keeps it to one row; the row id is
  derived from it), the call id when no other row has it yet, and LiteLLM's cost as `gateway_cost`.
  `cost` is Landflow's price-table price when the model is priced (Settings → AI prices), else LiteLLM's. One `ai.call`
  event goes to the usage ledger for each, so the second brain sees them.
- **Caps.** They sum `ai_usage`, so they count these rows without more. Only dollar budgets stop an agent on kagent, at the
  gateway: its token limits are counted, but nothing refuses a call on kagent when they are reached. A cap blocks the next
  call Landflow itself makes for the agent.
- The status (last run, rows imported and skipped, the total, the error) is on the AI page. A gateway that is down, or an
  import without `LANDFLOW_LLM_GATEWAY_ADMIN_KEY`, shows as the error and changes nothing.

## Counting each call once

A call is counted in one place only:

- **Calls Landflow makes itself** are counted by Landflow's meter, as before, when they return. Through the
  server-configured gateway they also keep LiteLLM's call id (`x-litellm-call-id`) and the response id, and the spend
  import skips the spend row with that response id. Through a credential that points elsewhere,
  only the cost is kept, for reading: such a gateway could answer with someone else's call id. So point a gateway
  credential at the same address as `LANDFLOW_LLM_GATEWAY_URL` (compared by scheme, host, port and path, so a trailing
  `/v1` or a default port does not matter); the same proxy under another address is counted twice (by the meter and by
  the import).
- **Calls Landflow makes outside a run, chat or agent** (a background job, such as the second brain's detectors, has no
  usage scope, so Landflow's meter does not count it) are marked `unmetered` instead and have no row of Landflow's, so the
  spend import counts them, as source LiteLLM and runtime Landflow; the AI page shows them under Landflow. That label
  comes from the server's own key (`LANDFLOW_LLM_GATEWAY_KEY`): when the gateway is set up only by a Settings credential,
  they show under "Other clients of the gateway".
- **Calls made outside Landflow** (an agent on kagent, Claude Code on kagent, any other client of the gateway) are
  counted from LiteLLM's spend log by the spend import, once per spend row. LiteLLM files each row under the response's id
  (`chatcmpl-…` or `msg_…`, its `request_id`) and keeps the call id in `litellm_call_id`; Landflow names its row by the
  `request_id`, and Landflow's own calls carry the same id.
- **LiteLLM's own totals** are the cross-check and the hard stop, never a second count.
- The tokens a remote agent reports over A2A stay in the Run Trace for reading; they are not counted again.

## Budgets in LiteLLM

Landflow mirrors its projects, people and dollar caps to LiteLLM so that what slips past Landflow (an agent on kagent,
a client that skips Landflow) is still stopped.

- **What is mirrored.** Each project is a LiteLLM team (`landflow-project-<id>`, alias the project's name; a personal
  project gets the alias "Personal project"). Each person with a cap of their own, or everyone when "every user" has a
  dollar cap, is a customer (`landflow-user-<id>`, no alias). The server's own gateway key (`LANDFLOW_LLM_GATEWAY_KEY`) gets no budget:
  its calls are under Landflow's caps already. A key named by a credential's data is never touched, because project
  editors can edit a credential and the admin key must not change a budget on a key that data picked. Each key Landflow minted for an agent on kagent gets the agent's dollar limits and its project's
  team. Only ids go to LiteLLM, never names or emails. Teams carry no budget: a LiteLLM team budget resets on its own 30-day window, not the calendar month a project's budget runs on, and the team's spend counts calls Landflow never stops (a local model through the gateway), so a backstop there would refuse what Landflow allows. A project's budget is enforced in Landflow ([projects-and-goals.md](projects-and-goals.md#ai-budget)).
- **Which caps have a backstop.** Dollar caps only: LiteLLM budgets are dollars. Token caps and workflow caps have none.
  A daily cap becomes a `1d` budget, else a monthly one a `30d` budget.
- **Headroom.** The budget sits a percentage above the Landflow cap (10% by default, rounded up to the cent), so
  Landflow's own, clearer stop comes first. Agents on kagent get none: LiteLLM is the only stop there.
- **How a customer's budget is written.** LiteLLM keeps a customer's budget on a budget object; `/customer/update`
  ignores a null budget (it never clears one) and drops `budget_duration`. So a new customer gets its budget with `/customer/new`, and a change
  or a removal goes through `/budget/update` on the customer's `budget_id` (or a new budget linked to it).
- **Windows.** LiteLLM resets `1d` and `30d` budgets on its own clock (UTC), not the instance's time zone.
- **When it runs.** "Sync now" in Settings → AI → LLM gateway (admins), when caps are saved or an approval raises one
  (only the objects that cap touches), and every `LANDFLOW_LLM_GATEWAY_SYNC_SECONDS` (10 minutes by default) while "Keep
  LiteLLM budgets in step with caps" is on. Only the leader listens for changes; another process's change is caught by
  the leader's next periodic run. It looks first and writes only what differs, so a second run changes nothing.
  Customers that a gateway call already created are updated, not created again. A person whose cap was removed keeps
  their customer with no budget. A disabled person keeps their customer and its budget, and is not listed as an orphan.
  A cap saved while a run is in progress is picked up by a run that starts after it. A run for one cap keeps the last
  full run's orphan list.
- **Needs the server.** The sync uses `LANDFLOW_LLM_GATEWAY_URL` and `LANDFLOW_LLM_GATEWAY_ADMIN_KEY` only; the key is
  never a credential field. Without both, the report says so and nothing is called.
- **Orphans, and why nothing is deleted.** A team or customer whose project or person is gone, and the key of a removed
  agent, are listed with "Remove it in LiteLLM's UI if it is no longer needed". Landflow never deletes, blocks or
  changes them: removing data in LiteLLM is a person's job.
- **The links.** What each run wrote is kept in `llm_gateway_links` (kind, Landflow id, LiteLLM id, state, budget, error).
- **The card.** Settings → AI → LLM gateway: the gateway (a credential or the environment), the cluster and UI addresses,
  three switches (import spend, keep budgets in step, Customer Portal headers), the headroom, "Sync now" with the last
  report (counts, errors, orphans) and "Open LiteLLM". It never shows a key. Members can read it, only admins change it.


## Asking for a higher cap

When someone reaches a cap they ask for more instead of finding an admin. Nothing changes until a person decides: the
request is made by one person, decided by a different person who is an admin, and only then applied.

**Who can ask about which cap.** Anyone who can build workflows (`workflows:write`) may ask about:

- their own user cap (`user:<their id>:…`);
- a workflow cap or an agent cap of a resource they can change (an editor or admin of its project, or an admin).

A credential's caps are an admin's to set directly, so nobody asks about those. The new cap must be more than the
current one and at most 100 times it, with a reason of 3 to 500 characters. A person has one open request per cap: a
second ask answers 409 with the id of the first. Workflows have only daily caps; agents have daily token, daily cost and
monthly cost caps; users and credentials have all four.

**Turning it on (an admin, once).** The flow is the template **Cap raise: an admin approves a higher AI cap**
(`ai-cap-raise`, [templates.md](templates.md)). An admin installs it with `POST /api/ai/cap-requests/setup`, from
Insights → AI: it lands in the admin's home project, is published and active, and its workflow id is kept in the
settings key `ai_cap_raise`. A second click answers the existing flow. Until then asking answers 409 "An admin must turn
on the cap-raise flow first (Insights → AI)" and stores nothing. There is one cap-raise flow per instance: only that flow handles a request, and Apply Cap Raise changes nothing for a run of any other workflow (a copy, or one a builder published with the same trigger).

**What the flow does.** It starts from **Cap Raise Request** (`core.capRaiseTrigger`), which runs once per request with
one item: the request id, the cap, its subject, metric and period, the current and the asked-for cap, the reason, who
asked (id and name) and `approvers`, the emails of the owners and admins other than the requester. Nothing else about
another person is in it. **Ask a Person** then asks in chat, with those approvers, no editing, and a 3 day timeout that
rejects. **Apply Cap Raise** (`core.applyCapRaise`) settles the request: the Approved branch uses it with Decision
"Approved", the Rejected branch with "Rejected" (a timeout lands there too).

**What the admin sees.** The request in Needs you as an Ask a Person: "Raise the day cost cap of user “Mia”?", with the
current and asked-for cap, the reason and who asked. The Run Trace of the flow's run is linked from the request.

**Why the requester can't approve their own.** Apply Cap Raise never trusts the item it receives (an expression or a
Code node could write one). On the Approved branch it reads the server's own record of the run: the output of the run's
Ask a Person node. The cap changes only when that record shows an approval by an active owner or admin, by email, who is
not the requester, and not a timeout; the request must be `asking` and must belong to this run's execution. Anything
else sets the request to `failed` with the reason, and nothing changes. A decision from Slack can't be matched to a
person, so it never applies; ask in chat or by email.

**What approval changes.**

- In Landflow: the cap field the period and metric name. A user under the cap for every user gets a set of their own,
  a copy of the default with the one field raised. A workflow's `aiMaxTokensPerDay` or `aiMaxCostPerDay` is raised in
  its settings; when the workflow is published, its draft must equal the published version (else the request fails and
  says to publish first), and it is published again with the new cap. An agent's `dailyTokenLimit`, `dailyCostLimit` or
  `monthlyCostLimit` is raised in the draft and, in place, in the published version and its history entry, so nothing
  else the draft changed goes live.
- In LiteLLM: Apply Cap Raise calls `capsChanged('approval', [capId])` and waits; the budgets sync of
  [Budgets in LiteLLM](#budgets-in-litellm) mirrors the change. The request then records `gateway`: `updated` (the
  object's link is `synced` after the approval), `failed` (its link is `failed`) or `skipped` (no link, the sync is off,
  or the cap has no backstop, such as a workflow's).
- The request records who decided (`decidedBy`) and when, and the comment they left.

**Rejecting, timeouts, cancelling.** A no records the comment and changes nothing. If nobody answers within 3 days the
request is rejected ("Nobody answered in time"). The requester, or an admin, can cancel a request while it is open
(`POST /api/ai/cap-requests/:id/cancel`). If no admin other than the requester exists, the request fails at once with
"No admin other than you can approve this".

The routes are in [reference/api.md](reference/api.md).

## What a prompt was made of

For every chat call that Landflow builds the prompt for, Landflow writes how the prompt split into parts, once the call is
recorded: instructions, where this work fits (the project block), practices, memory, tool notes, tool definitions, the
conversation so far, tool results, the message and images. The row is `ai_call_parts` (migration 2901), one per call,
keyed by the call's `ai_usage` row. It holds token counts, hashes and tool names, never text.

- **An estimate in this wave.** Each part's characters divided by 4 (an image counts 1,600), scaled so the parts add up to
  the call's input tokens, the rounding remainder going to the largest part. `method` says `estimate`; `formatting` is
  always 0 because only an exact count can tell what the provider added (a draft with nothing to count has no parts).
  Wave 12 makes the numbers exact with the same row.
- **Hashes.** Keyed hashes (HMAC-SHA-256 under a key derived from the instance's encryption key, 16 hex characters):
  `promptHash` for the whole prompt (the same prompt sent again), `prefixHash` for everything up to the last cache
  breakpoint (two calls with the same prefix could have shared a cache entry) and one hash per part (the instructions
  changed between two runs). A part's hash is over its segments' texts joined in order into one string, so a counter that
  holds the part whole (the gateway's callback, wave 12) gets the same hash. The prompt's date line (`Current date and
  time: …`) is a `formatting` segment: it is in `promptHash` and in no part hash (before wave 12 it was also in `prefixHash`), so the instructions' hash only changes when the instructions do. From wave 12 (SP19) `prefixHash` is the hash of the stable prefix (the tools and the system prompt up to the project block and practices): the date line and the memory are no longer in it (they stay in `promptHash`), so earlier rows don't compare with later ones. They are comparable inside one instance only and cannot be turned back into text.
- **Who writes it.** Agent runs (the system prompt is split where it is built), the AI Agent node, Spotlight, the Agent
  architect and Ask the brain. The text of a prompt is held in memory for the length of one call and is never stored,
  logged or put on a span.
- **Kept 30 days**, `LANDFLOW_AI_CALL_PARTS_RETENTION_DAYS` ([configuration](reference/configuration.md)); pruned with
  the usage rows, at most hourly.

## The AI page

Runs → Insights → **AI** (`/insights/ai`) is the one place to see AI spend and how near each cap is. It has a switch
for the period (24 hours, 7 days, 30 days) and shows, from top to bottom:

- **Totals**: the estimated cost, the tokens (in and out, and cached) and the calls. Cost comes from Landflow's own price
  table (Settings → AI prices), as everywhere else; a cost the gateway reports is not used for these totals.
- **Spend by** project, goal, agent, person, model or source. Each row has its cost, tokens, calls and a bar for its share of
  the cost. A project row with no project on it counts under the workflow's or agent's home project; calls from no
  agent (workflows, Spotlight) are "No agent". The Goal grouping uses the goal each call was stamped with
  ([what a goal costs](projects-and-goals.md#what-a-goal-costs)): "No goal" when there is none, "Another goal" for one
  you can't see. Sources are "Landflow" (calls Landflow made), "kagent", "Claude Code on
  kagent" and "Other clients of the gateway" (the last three come from the spend import, once it has run). Each list
  holds the top 50; the rest add up as "Other". On a phone each row is a card; desktop shows a table.
- **Caps**: every cap that has a period (a workflow's daily caps, an agent's guardrails, Settings → AI caps), what it has
  used and where it is set. The bar is the accent colour below 80%, amber from 80% and red at 100%. Admins also see the
  budget the gateway holds as a backstop for a person's or an agent's dollar cap, when the budgets sync is on.
- **Requests**: cap-raise requests of the last 30 days (a member's own; every one for admins), with the decision and
  "In LiteLLM: updated, skipped or failed". A member can withdraw an open one.
- **Gateway**: a health dot, the models the gateway serves, and for admins the spend import's and the budgets sync's last
  runs, **Open LiteLLM** (its admin UI, in a new tab) and **Settings**. Without a gateway the card says so. Open LiteLLM comes only from Settings' UI address, `LANDFLOW_LLM_GATEWAY_UI_URL` or the server's `LANDFLOW_LLM_GATEWAY_URL`, never from a credential's Base URL; without one the card says to set it. Only admins see the gateway's error text; members get "The gateway is not answering".

**Who sees what.** Owners and admins see everything. Anyone else sees the calls of the workflows and agents they can open
and their own calls in the page's totals and in every group but one; calls they may not see are in no total, and a
project, goal, agent or workflow they can't read is "Another ...". The person list is the exception (the user's decision
D1, 2026-11-15): every member sees every person's spend by name, from every row of the period (rows with no workflow or
agent included), with the instance's total above it ("Everyone's AI spend in this period, by person"; owners and
admins see the caption alone, since the page's totals are already that figure). A person with no name, or whose name is
their email address, is "Unnamed person" to a member, who never sees another person's email; admins, and the person
themselves, see the email. Spend views never show prompt text or run contents. A member sees only their own user cap
and the caps of workflows and agents they can open; credential caps and the gateway's address, keys and sync detail
are for admins. The page never shows a key.

**Ask for more.** A member sees **Ask for more** on their own user cap and on the caps of workflows and agents they can
edit. It asks for a new maximum above the current one and a reason, and sends it to `POST /api/ai/cap-requests` (see
[Asking for a higher cap](#asking-for-a-higher-cap)); a request that is already open shows "Asked". When the cap-raise
flow is not installed and published, members see "Asking for more is off" and admins see **Turn on cap requests**, which
installs and publishes the flow. Admins change caps where they are set (the link on each cap), so they are not offered it.

**A project's budget** is a cap too: `project:<id>:month:cost`, listed for the project's members, with the link to the project's AI budget settings. Its editors who are not its admins see **Ask for more** while the cap-raise flow is on; an approved request sets the budget's amount, settles the month's open incidents as raised by the approver, and its `gateway` is `skipped` (a project has no LiteLLM backstop). The cost alerts watch it like the other caps. See [AI budget](projects-and-goals.md#ai-budget).

The page reads `GET /api/insights/ai` and `GET /api/llm-gateway/status` ([reference/api.md](reference/api.md)) and
refreshes every minute while the tab is visible.

## What each call was for

Each model call's `ai_usage` row says, besides the run, model and tokens, where the call ran and why (migration 2900;
rows from before it, rows imported from the gateway's spend log and calls outside a run have none of these (a failed call writes no row); a call a plugin node reports in its `model` record has only `node_id`, no purpose, duration, stop reason or cache token types in its metrics yet):

| Column | What it holds |
|---|---|
| `node_id` | The workflow node the call ran under: the innermost one, so a call by a model sub-node or a tool names that sub-node. The engine tells the host which node is running (`aroundNode`), so it works with OpenTelemetry on or off |
| `span_id` | The `gen_ai.*` span's id, to open the call's span in the Run Trace |
| `purpose` | Why the call was made (below) |
| `iteration` | The agent loop's step, from 1 (a Landflow agent and the AI Agent node) |
| `caller_agent_id` | The agent that asked: the nearest agent up the chain that is not the row's own, else the call note's `callerAgentId` when that is not the row's own agent (a team member names its lead, a sub-agent its caller) |
| `duration_ms` | Wall time of the call |
| `stop_reason` | The provider's first finish reason (`end_turn`, `tool_use`, `max_tokens`, `stop`, `length`) |

**Purpose** is one of `answer`, `guardrail`, `judge`, `embed`, `cache-embed`, `rerank`, `summary`, `eval`. Code that
knows why it makes a call sets it with `withCallPurpose` (`lib/server/ai-usage/call-context.ts`); otherwise an
embeddings call is `embed`, a chat call inside a workflow run or an agent session is `answer`, and anything else stays
empty. Spotlight, the Agent architect and the brain's Ask set `answer` themselves. An agent's loop step (Run an Agent,
a team member, an agent tool) and the AI Agent node say `answer` only when no outer purpose is set: inside an
evaluation run they keep `eval`, while a guardrail check or a judge inside it still says `guardrail` or `judge`. There is no `router` purpose: the router makes no model call. The same note carries
the agent loop's iteration and the caller agent, and a listener (`setRecordedCallListener`) hears each recorded call
once its row is written, for the prompt-parts work.

The purpose and the cache token types are labels on the AI metrics, and the `ai.call` ledger event carries the purpose,
node, session, iteration and the row's id ([observability.md](observability.md#8-token-and-cost-tracking)). Nothing here
stores prompt text. These columns show on screens from wave 12; wave 11 only records them.

## Not built

- **High availability.** One replica and no Redis; a restart interrupts calls in flight.
- **TLS.** None on the loopback port; do not expose it beyond the machine.
- **Tags budgets**: LiteLLM's budgets per tag are not used (whether they are in the open-source build is not verified). Tags are for
  spend reports only.
- **The Customer Portal**: not in a LiteLLM release yet. Landflow can send its headers (a setting, off) but does nothing with it.
- **The Anthropic Chat Model node's model list** stays the fixed Claude list with a gateway credential.
- **Bare Ollama models** (the Ollama Chat Model node, an agent with the Ollama provider) call Ollama directly, not through the gateway.
- **Agents outside Landflow** (LL03): LiteLLM sees the agent's key, not the person who asked, so a call kagent makes
  has no person in `ai_usage`, even when the call names an end user (that is the caller's word). LiteLLM itself still
  charges a named end user's customer budget, so a key holder can spend someone's LiteLLM backstop (not their Landflow cap).
- **Counted twice, never hidden**: a plugin that meters its own model calls and calls the server's gateway keeps no response
  id, and an embeddings call through a credential with its own key has none either, so the import counts such a call a
  second time. The response id is trusted to be unique: LiteLLM's (in front of Ollama) or the provider's.
- **Long calls**: the import rereads 15 minutes behind its last run; a call LiteLLM logs more than about 15 minutes after
  it started can be missed. The import lags by up to its interval plus LiteLLM's batch (about 10 s), so a cap counts an agent's calls a few
  minutes late. Token limits of an agent on kagent are counted but not enforced there (LiteLLM budgets are in dollars).
  The sandbox of a Claude Code agent can reach the gateway. Keys are blocked, never deleted, and not rotated.
- A LiteLLM team budget as a backstop for a project's budget (see "Teams carry no budget" above), tag budgets, and budget windows in the instance's time zone (LL04). A project's own budget is built ([projects-and-goals.md](projects-and-goals.md#ai-budget)).
- Asking for a cap raise by Slack or email: the template asks in chat (an admin can switch Ask a Person's channel, but a
  Slack answer never applies, see above).
- Several cap-raise flows: one per instance.
- Asking about a credential's caps (an admin sets those directly).
- **The AI page:** charts over time (it shows the totals of the period), and an export of the report.
