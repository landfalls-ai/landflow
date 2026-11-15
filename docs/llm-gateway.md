# The LLM gateway (LiteLLM)

Every model call can go through one door: a [LiteLLM](https://docs.litellm.ai) proxy in front of the models. Landflow's
own calls (agents, chat model nodes, Spotlight, the brain, the model router) and the agents it deploys to kagent all
send their requests there. LiteLLM keeps a spend log, holds the virtual keys and enforces budgets; Landflow keeps the
caps people see and decide by. LiteLLM's budgets are the backstop: they stop whatever slips past Landflow, such as an
agent running on kagent.

Only LiteLLM's open-source build is used: virtual keys, teams, customers (end users), budgets and spend logs. Its
Customer Portal and organizations are not used by default (the portal is not in a release yet; organizations need
Enterprise).

<!-- Each section below is written by the package named in its comment; the integrator merges them. -->

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
| `x-litellm-spend-logs-metadata` | JSON with `landflow: "in-process"` and the ids above | the spend log; the spend import skips rows marked `in-process` |
| `x-litellm-trace-id` | the execution id, else the session id | grouping calls of one run |

A person is only named when a person started the run. The project is the home project of the agent or workflow. With **Settings →
AI → LLM gateway → Customer Portal headers** on, `x-litellm-customer-org-alias` and `x-litellm-customer-member-id` are sent too. It is
off: the portal is not in a LiteLLM release yet.

**No fallback beta.** Landflow's normal Anthropic calls send `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`
so Anthropic retries a declined request on its fallback model. Through a gateway Landflow sends neither: LiteLLM routes its own
fallbacks, and an unknown beta must not reach a model that is not Anthropic's. `output_config.effort` is sent only for `claude-`
models.

**The call id and the cost.** LiteLLM answers each call with `x-litellm-call-id` and `x-litellm-response-cost`. Landflow keeps both on
the call it records: the `ai_usage` row has `call_id`, `source = landflow`, `runtime = landflow`, `project_id` and `gateway_cost`, and the
`ai.call` event has `callId` and `gatewayCost`. A call id is in at most one row, so the spend import never counts the call again. The cost
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
- **Skipped.** Failed calls; rows marked `in-process` (Landflow's meter counted them) unless the key is one Landflow
  minted for a runtime (such a call is never Landflow's own, whatever its metadata says); rows made with Landflow's own
  virtual key; rows with no tokens and no spend; a call id that is already in `ai_usage`.
- **Attribution.** The key's row in `llm_gateway_keys` gives the runtime, the agent and the project (metadata never
  overrides it); else the row's
  `spend_logs_metadata`; else the project from the team (`landflow-project-<id>`). The person comes from the end user
  (`landflow-user-<id>`). Anything else is runtime `other`, with no agent.
- **What it writes.** One `ai_usage` row per call: `source = 'litellm'`, the runtime, the agent, the project, the person,
  the call id (an index keeps a call id to one row; the row id is derived from it) and LiteLLM's cost as `gateway_cost`.
  `cost` is Landflow's price-table price when the model is priced (Settings → AI prices), else LiteLLM's. One `ai.call`
  event goes to the usage ledger for each, so the second brain sees them.
- **Caps.** They sum `ai_usage`, so they count these rows without more. Only dollar budgets stop an agent on kagent, at the
  gateway: its token limits are counted, but nothing refuses a call on kagent when they are reached. A cap blocks the next
  call Landflow itself makes for the agent.
- The status (last run, rows imported and skipped, the total, the error) is on the AI page. A gateway that is down, or an
  import without `LANDFLOW_LLM_GATEWAY_ADMIN_KEY`, shows as the error and changes nothing.

## Counting each call once

A call is counted in one place only:

- **Calls Landflow makes itself** are counted by Landflow's meter, as before, when they return. Through the gateway they
  also carry LiteLLM's call id (`x-litellm-call-id`) and its cost, so the gateway's log can be matched to them. They are
  marked `in-process` in LiteLLM's spend log, and the spend import skips them.
- **Calls made outside Landflow** (an agent on kagent, Claude Code on kagent, any other client of the gateway) are
  counted from LiteLLM's spend log by the spend import, once per call id.
- **LiteLLM's own totals** are the cross-check and the hard stop, never a second count.
- The tokens a remote agent reports over A2A stay in the Run Trace for reading; they are not counted again.

## Budgets in LiteLLM

<!-- LL04: projects as teams, people as customers, caps as budgets, the headroom, keys of runtimes, orphans, Settings. -->

## Asking for a higher cap

<!-- LL05: the request, the cap-raise flow (Ask a Person), what approval changes in Landflow and in LiteLLM. -->

## The AI page

<!-- LL06: Insights → AI: spend and tokens by project, agent, person, model and source; caps; the gateway; requests. -->

## Not built

<!-- Each package adds its own bullets here. -->

- **High availability.** One replica and no Redis; a restart interrupts calls in flight.
- **TLS.** None on the loopback port; do not expose it beyond the machine.
- **Tags budgets**: LiteLLM's budgets per tag are not used (whether they are in the open-source build is not verified). Tags are for
  spend reports only.
- **The Customer Portal**: not in a LiteLLM release yet. Landflow can send its headers (a setting, off) but does nothing with it.
- **The Anthropic Chat Model node's model list** stays the fixed Claude list with a gateway credential.
- **Bare Ollama models** (the Ollama Chat Model node, an agent with the Ollama provider) call Ollama directly, not through the gateway.
- **Agents outside Landflow** (LL03): LiteLLM sees the agent's key, not the person who asked, so a call kagent makes
  has no person in `ai_usage` (a call made with an end user named, such as an agent calling the gateway for someone, has
  one). The import lags by up to its interval plus LiteLLM's batch (about 10 s), so a cap counts an agent's calls a few
  minutes late. Token limits of an agent on kagent are counted but not enforced there (LiteLLM budgets are in dollars).
  The sandbox of a Claude Code agent can reach the gateway. Keys are blocked, never deleted, and not rotated.
