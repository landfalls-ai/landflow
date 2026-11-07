# W2b notes: the roster ("Agents the visitor can pick")

Rows for the integrator (W2b edited none of the shared docs).

## docs/features/ai.md, under "Hosted chat and widget"

- **Agents the visitor can pick** (Chat trigger option, when public): a list of `{ key, label, face?, target, seesTranscript }`. `target` is the name (or id) of a node in the same flow (Run an Agent, Run a Team or AI Agent). The page and widget show the roster above the input as chips (a face and a label; one column with big tap targets on a phone); tapping one picks it, tapping it again goes back to the lead. A picked agent starts the run at its node instead of the trigger's first node; nothing picked means the flow's lead, exactly as before. A visitor can name only a key on the roster: any other `agentKey` is refused with 400 "That agent isn't available in this chat", and the node is never started. Entries whose key is invalid or duplicated, or whose target is missing, disabled or a trigger, are dropped.
- **Memory per agent.** A picked agent's input item has `sessionId` = `<visitor session>:<agentKey>` (also `agentKey` and `visitorSessionId`), so Run an Agent's `Session Key` (default `{{ $json.sessionId }}`) and the AI Agent's `Session Key` option, and with them Simple Memory (`<workflowId>:<memoryNodeId>:<sessionKey>`), keep a separate history per agent. The lead keeps the plain session id. The transcript stays one conversation under the visitor's session; each message carries `agentKey` (the user's message the agent it was addressed to, the answer the agent that wrote it).
- **Sees the conversation** (roster entry, default on): the item also carries `transcript`, the last 20 visible messages `{ role, text, agentName? }`, read-only (only when Load Previous Session is on, since that is what stores them). Off: no `transcript` field.

## docs/reference/api.md, wire table

| Where | Change |
|---|---|
| `GET /chat/<key>/config` | optional `agents: [{ key, label, face? }]` when the trigger has a roster (never the node) |
| `POST /chat/<key>` | optional `agentKey` (JSON or multipart field); not on the roster: 400 `{ error }` |
| Transcript message (`/session`) | user messages sent to a picked agent carry `agentKey`, `agentName` |

## docs/limitations.md

- A picked agent's run starts at its own node, so the nodes between the trigger and the lead (a Guardrails node, a Set node, a Switch) do not run for it. Put the same guardrail before each roster target, or connect the trigger through it to a node that routes on `agentKey`.
- Per-agent memory works where the target reads its session key from `$json.sessionId` (the default of Run an Agent and the AI Agent). A key typed as a fixed string, or read from the trigger node by name, is not changed.
- The roster's Node field is typed as a name or id; there is no node picker yet. Answer labels (W2a) still come from the node's own chunks; with none, the roster label is stored.
- Answer feedback for a picked agent skips the "belongs to this session" check (the trigger did not run, so there is no trigger item to compare).

## docs/roadmap.md

Chat with agents (spec 16), step 2 built (roster option, config, `agentKey`, start at the target, per-agent memory ids, the page's chips). Next: voice (step 3). Open: a node picker for the roster, a guardrail that also covers roster targets.

## docs/history.md

Row: "Chat with agents, step 2: Chat trigger option 'Agents the visitor can pick', `agents` in the public config, `agentKey` on send (off-roster refused), the run starts at the picked node with its own memory session `<sessionId>:<agentKey>`, roster chips on the page and widget."
