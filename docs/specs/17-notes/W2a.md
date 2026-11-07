# W2a notes: attribution and the "Chat with a team" template

Rows for the integrator (W2a edited none of the shared docs).

## docs/features/ai.md, under "Hosted chat and widget"

- **Who answered**: a flow can label the agent that writes a streamed chunk (`agent: { id, name, face? }`). The hosted page and widget show the name and a face (an emoji, else the first letter) above the bubble, start a new bubble when the speaker changes, and show a short line "asked Billing: <reason>" when an agent delegates (a tool call whose input has a `reason`, as Run an Agent and Run a Team tools do). Stored transcript messages keep `agentKey` and `agentName`, so "Load Previous Session" shows the same names. A flow that labels nothing streams and renders exactly as before.
- **Chat with a team** template (Templates, categories AI, Support, Agent teams): a Chat trigger, a Guardrails node (Fail answers a polite refusal), a Lead (Run an Agent) with the Billing and Technical agents and a Chat notes data table as tools, and a Simple Memory. Using it creates the three agents and their team.

## docs/reference/api.md, wire table

| Where | Change |
|---|---|
| Stream chunk (`node.chunk` wire chunk, SSE and NDJSON) | optional `agent: { id, name, face? }` (`face` is a string or an avatar object), also typed as `StreamChunk.agent` in the SDK; absent for unlabelled nodes |
| `GET /chat/<key>/history` message | optional `agentKey`, `agentName` on assistant messages |

## docs/limitations.md

- Run an Agent labels its chunks with the agent's id, name and avatar; Run a Team with the team's id and name (one label per team node, not per member). The AI Agent, chains and other nodes stay unlabelled. The chat route stores `agentKey` / `agentName` from the last labelled text chunk, so only Streaming Response Mode stores them (a "When Last Node Finishes" chat has no chunks).
- Agent faces are avatar objects; the page shows an emoji face or the first letter, not the drawn face.
- The template's agents run on an Ollama model (`qwen3:8b` at host.docker.internal:11434), like the Plugin builders template: change it in the agent builder.

## docs/roadmap.md

Chat with agents (spec 16), step 1 built (labels from Run an Agent and Run a Team, stored on the transcript, shown on the page, the template); next step 2 (roster, W2b). Open: labels for non-streaming chats and for the AI Agent node.

## docs/history.md

Row: "Chat with agents, step 1: optional `agent` label on stream chunks and `agentKey` / `agentName` on transcript messages, the page shows who answered and 'asked <Agent>', and the built-in 'Chat with a team' template."
