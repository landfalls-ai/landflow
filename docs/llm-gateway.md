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

<!-- LL01: compose profile and project, image pin and how it was verified, database, keys, models, Kubernetes example. -->

## Point Landflow at it

<!-- LL02: the Gateway field on the Anthropic API and OpenAI API credentials, agents, chat model nodes, Spotlight and the
router, the headers that say who is calling, the call id and cost on each AI call, the fallback beta. -->

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
  first run reads the last 24 hours) to one minute ago, in pages of 500 until a page is empty. The log answers at most
  10,000 rows for one query: when a window holds more, the run says so in its status and the next one continues from the
  newest row it read.
- **Skipped.** Failed calls; rows marked `in-process` (Landflow's meter counted them); rows made with Landflow's own
  virtual key; rows with no tokens and no spend; a call id that is already in `ai_usage`.
- **Attribution.** The key's row in `llm_gateway_keys` gives the runtime, the agent and the project; else the row's
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

- **Agents outside Landflow** (LL03): LiteLLM sees the agent's key, not the person who asked, so a call kagent makes
  has no person in `ai_usage` (a call made with an end user named, such as an agent calling the gateway for someone, has
  one). The import lags by up to its interval plus LiteLLM's batch (about 10 s), so a cap counts an agent's calls a few
  minutes late. Token limits of an agent on kagent are counted but not enforced there (LiteLLM budgets are in dollars).
  The sandbox of a Claude Code agent can reach the gateway. Keys are blocked, never deleted, and not rotated.
