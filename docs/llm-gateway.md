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

When someone reaches a cap they ask for more instead of finding an admin. Nothing changes until a person decides: the
request is made by one person, decided by a different person who is an admin, and only then applied.

**Who can ask about which cap.** Anyone signed in who can open runs may ask about:

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
on the cap-raise flow first (Insights → AI)" and stores nothing. There is one cap-raise flow per instance.

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

## The AI page

<!-- LL06: Insights → AI: spend and tokens by project, agent, person, model and source; caps; the gateway; requests. -->

## Not built

<!-- Each package adds its own bullets here. -->

- Asking for a cap raise by Slack or email: the template asks in chat (an admin can switch Ask a Person's channel, but a
  Slack answer never applies, see above).
- Several cap-raise flows: one per instance.
- Asking about a credential's caps (an admin sets those directly).
