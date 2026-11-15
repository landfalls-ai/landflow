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

Landflow mirrors its projects, people and dollar caps to LiteLLM so that what slips past Landflow (an agent on kagent,
a client that skips Landflow) is still stopped.

- **What is mirrored.** Each project is a LiteLLM team (`landflow-project-<id>`, alias the project's name; a personal
  project gets the alias "Personal project"). Each person with a cap of their own, or everyone when "every user" has a
  dollar cap, is a customer (`landflow-user-<id>`, no alias). The gateway credential's own virtual key gets that
  credential's cap, and each key Landflow minted for an agent on kagent gets the agent's dollar limits and its project's
  team. Only ids go to LiteLLM, never names or emails. Teams carry no budget yet.
- **Which caps have a backstop.** Dollar caps only: LiteLLM budgets are dollars. Token caps and workflow caps have none.
  A daily cap becomes a `1d` budget, else a monthly one a `30d` budget.
- **Headroom.** The budget sits a percentage above the Landflow cap (10% by default, rounded up to the cent), so
  Landflow's own, clearer stop comes first. Agents on kagent get none: LiteLLM is the only stop there.
- **Windows.** LiteLLM resets `1d` and `30d` budgets on its own clock (UTC), not the instance's time zone.
- **When it runs.** "Sync now" in Settings → AI → LLM gateway (admins), when caps are saved or an approval raises one
  (only the objects that cap touches), and every `LANDFLOW_LLM_GATEWAY_SYNC_SECONDS` (10 minutes by default) while "Keep
  LiteLLM budgets in step with caps" is on. Only the leader listens for changes; another process's change is caught by
  the leader's next periodic run. It looks first and writes only what differs, so a second run changes nothing.
  Customers that a gateway call already created are updated, not created again. A person whose cap was removed keeps
  their customer with no budget.
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

<!-- LL05: the request, the cap-raise flow (Ask a Person), what approval changes in Landflow and in LiteLLM. -->

## The AI page

<!-- LL06: Insights → AI: spend and tokens by project, agent, person, model and source; caps; the gateway; requests. -->

## Not built

<!-- Each package adds its own bullets here. -->

- Project budgets (until Paperclip's project budget lands), tag budgets, and budget windows in the instance's time zone (LL04).
