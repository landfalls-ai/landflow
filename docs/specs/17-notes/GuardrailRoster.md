# GuardrailRoster notes: a picked agent passes the flow's Guardrails

Rows for the integrator (this change edited none of the shared docs).

## The choice

Two options were open: (A) start a picked agent's run at the trigger and let the flow route to it, or (B) run the Guardrails check server-side before starting at the target.

A was chosen. The engine already starts at the trigger for the lead, and the chat item already carries `agentKey`, so a Switch on `agentKey` after Guardrails is plain flow design: no new engine path. B would need the route to find the Guardrails node "upstream of the lead", run it outside the engine (no run record, no Pass/Fail branch, no trace, no refusal branch such as "Politely decline"), and guess which of several guardrail nodes applies. A keeps one run, one trace and the author's own refusal branch.

How it works (`apps/web/src/lib/server/chat.ts`):

- `chatStartNodeId(workflow, trigger, agent)` replaces `agent ? agent.targetId : node.id` in the chat route. A picked agent starts at the trigger when the flow routes to its target: the target is reachable from the trigger over main connections, through a node (Switch, If) whose parameters read `agentKey`. Otherwise it starts at its own node, exactly as in W2b, so existing flows behave as before.
- `unguardedRosterTargets(workflow)` gives the roster targets a visitor can reach without passing a Guardrails node (started directly, or reachable from the trigger on a path around Guardrails). `validateWorkflow` turns it into a warning: `Public chat: "Billing" can be picked by visitors without passing the Guardrails node. ...`. Only when the chat is public, has a roster and the flow has a Guardrails node (a flow with none has no guard for the roster to skip, so the lead is no better off).
- The "Chat with a team" template now has the roster (Billing, Technical) and the path Trigger, Screen the message (Guardrails), Who was asked? (Switch on `agentKey`: Billing at output 0, Technical at 1, the lead on Fallback), with the failing branch to "Politely decline". Billing and Technical stay attached to the lead as tools too. It validates with no warnings.
- A user's own flow that wants the same: connect the trigger through Guardrails to a Switch or If on `$json.agentKey` that leads to each roster target.

Tests: `apps/web/test/chat-roster-guard.test.ts` (injection blocked for the picked agent and the lead alike, clean messages reach the right node, off-roster still 400, warning cases, template shape and validation).

## docs/features/ai.md, under "Hosted chat and widget" (replace the W2b sentence about skipped nodes)

- **Roster and Guardrails.** A picked agent starts at its own node unless the flow routes to it: connect the Chat trigger through Guardrails to a Switch (or If) on `$json.agentKey` that leads to each roster target, and the run starts at the trigger, so the picked agent's message is screened exactly like the lead's. The "Chat with a team" template is built this way. Validation warns when a public chat with a roster and a Guardrails node has a target a visitor can reach without passing Guardrails.

## docs/limitations.md

- Remove the W2b row "A picked agent's run starts at its own node, so the nodes between the trigger and the lead (a Guardrails node, a Set node, a Switch) do not run for it."
- Add: the start-at-trigger rule applies when a node between the trigger and the target reads `agentKey` (found by looking for the word in its parameters); a flow that routes some other way starts the target directly. A flow with a roster but no Guardrails node gets no warning.

## docs/roadmap.md

Chat with agents: the open item "a guardrail that also covers roster targets" is built (route on `agentKey` after Guardrails; warning for targets that bypass it).

## docs/history.md

Row: "Chat with agents, guardrails for the roster: a roster agent whose target the flow routes to (a Switch on `agentKey` after Guardrails) starts at the trigger and passes the flow's Guardrails; validation warns about targets that skip Guardrails on a public chat; the 'Chat with a team' template has the roster and the router."
