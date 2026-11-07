# ChatFix notes: fixes to "Chat with a team" found while showcasing it

Rows for the integrator (this change edited none of the shared docs).

## What was wrong and what changed

1. **A picked specialist failed with "The message is empty".** The Billing and Technical nodes read their message with `$fromAI('message', ...)`, which is empty unless an agent calls them as a tool; the roster router runs them as plain nodes. The template now uses `$fromAI('message', '...', 'string', $json.chatInput)`, so the same node works both ways. Run an Agent also falls back to the item's `chatInput` when its message comes out empty (`nodes/agents.ts`).
2. **Letter avatars.** The label carries the agent's avatar object, which the page showed as a letter. `speakerFace` (`chat-client.ts`) now picks, in order: an emoji sent with the label, the roster entry's face (matched by key or by name), the agent's own avatar (an image, initials, or the first letter on the skin tone of a drawn face), then the first letter. Stored transcript messages resolve the same way by name.
3. **No "asked Billing: <reason>" line.** The page was right; Run an Agent never offered a `reason` argument, because only A2A Agent set `delegates: true` on its descriptor. Run an Agent now sets it, so its tool schema has a required `reason` (stripped before the agent runs, kept on the tool chunk). Run a Team (`nodes/run-team.ts`, outside this change's paths) has the same gap and still needs `delegates: true`; spec 16 says it already carries `reason`.
4. **Canvas overlap.** New node positions: a row for the chat path, a row below for the lead's sub-nodes (memory, Billing, Technical, Chat notes at least 300 px apart; Run an Agent draws about 280 px wide).
5. **Model.** The agents pointed at `qwen3:8b` on `host.docker.internal`. They now use `qwen3-coder:30b`, as the other local templates do, and set no address, so it follows `OLLAMA_URL` (127.0.0.1 on a host; the Docker and Kubernetes deployments set it). The setup steps say to `ollama pull qwen3-coder:30b` and where to change it.

Tests: `apps/web/test/chat-team-template.test.ts`.

## docs/features/ai.md, under "Hosted chat and widget"

- Replace the "Chat with a team" sentence's model note: the agents run on the Ollama model `qwen3-coder:30b` at `OLLAMA_URL`, the same as the other local templates; change it per agent in the agent builder.
- "Who answered": the face is the roster entry's emoji (matched by key or name), else the agent's avatar (image, initials, or a letter on the drawn face's skin tone), else the first letter.
- Run an Agent, used as a tool, takes a `message` and a required `reason`; the page shows "asked <Agent>: <reason>". Its `message` falls back to the chat input when empty.

## docs/limitations.md

- Remove the line "The template's agents run on an Ollama model (`qwen3:8b` at host.docker.internal:11434) ..." (W2a); the model is now `qwen3-coder:30b` at `OLLAMA_URL`.
- Adjust "Agent faces are avatar objects; the page shows an emoji face or the first letter, not the drawn face": it now shows an image avatar, initials, or a letter on the skin tone, still not the drawn face.
- Add: Run a Team has no `reason` argument when used as a tool (no "asked" line for it) until its descriptor sets `delegates: true`.

## docs/history.md

Row: "Chat with a team fixes: a picked specialist gets the visitor's message ($fromAI fallback to chatInput, and Run an Agent falls back too), roster face and avatar beside answers, Run an Agent delegates (a required `reason`, so the page shows 'asked <Agent>: <reason>'), a clean template layout, and the agents on qwen3-coder:30b at OLLAMA_URL."

## Live check

Scratch host on port 3500: template used as is, Technical picked from the roster answered with the tools face; an unpicked question made the lead ask Billing and the page showed "asked Billing: ..." with the lead's avatar. Screenshots: `scratchpad/showcase/fix-chat-{canvas,technical,lead-asked}.png`.
