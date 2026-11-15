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

<!-- LL03: kagent's ModelConfig and the Claude Code harness through the gateway, the key per agent, the spend import. -->

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

Runs → Insights → **AI** (`/insights/ai`) is the one place to see AI spend and how near each cap is. It has a switch
for the period (24 hours, 7 days, 30 days) and shows, from top to bottom:

- **Totals**: the estimated cost, the tokens (in and out, and cached) and the calls. Cost comes from Landflow's own price
  table (Settings → AI prices), as everywhere else; a cost the gateway reports is not used for these totals.
- **Spend by** project, agent, person, model or source. Each row has its cost, tokens, calls and a bar for its share of
  the cost. A project row with no project on it counts under the workflow's or agent's home project; calls from no
  agent (workflows, Spotlight) are "No agent". Sources are "Landflow" (calls Landflow made), "kagent", "Claude Code on
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
and their own calls; in the person list, other people's calls add up to one row, "Teammates", never by name. Calls they
may not see are in no total. A member sees only their own user cap and the caps of workflows and agents they can open;
credential caps and the gateway's address, keys and sync detail are for admins. The page never shows a key.

**Ask for more.** A member sees **Ask for more** on their own user cap and on the caps of workflows and agents they can
edit. It asks for a new maximum above the current one and a reason, and sends it to `POST /api/ai/cap-requests` (see
[Asking for a higher cap](#asking-for-a-higher-cap)); a request that is already open shows "Asked". When the cap-raise
flow is not installed and published, members see "Asking for more is off" and admins see **Turn on cap requests**, which
installs and publishes the flow. Admins change caps where they are set (the link on each cap), so they are not offered it.

The page reads `GET /api/insights/ai` and `GET /api/llm-gateway/status` ([reference/api.md](reference/api.md)) and
refreshes every minute while the tab is visible.

## Not built

<!-- Each package adds its own bullets here. -->

- **The AI page:** charts over time (it shows the totals of the period), and an export of the report.
