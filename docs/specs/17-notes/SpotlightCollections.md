# Spotlight collections and agent wiring: rows for the integrator

Rows for `docs/history.md` / `docs/roadmap.md` / `docs/limitations.md`, written here because those files are not mine to edit.

## history.md row

| `<hash>` | Spotlight blind spots: `get_node_docs` and the flow-builder catalog spell out how a collection / fixedCollection is stored (group names, field names, option values, a one-line example); `validateOps` warns, and sends the proposal back once, on a wrong collection shape, an unknown key and an option value outside the list; a new tool node wired after an agent as a normal step, or a sub-node with a main connection, is warned; a new node whose required credential is unset gets a card chip; the builder's test data drops chat-trigger junk (`chatInput`, the trigger's own parameters) and is not pinned when no node reads it. Chat prompt: collection shapes, ai_* connections, say what you can't set | [assistant.md](assistant.md) |

## assistant.md notes

- New warnings (sent back once): `“Node” stepList.step[0].action: "extract" is not one of …`, `… has no field “value” (fields: …)`, `… must be an object keyed by group`, `“Shell” is wired after “Agent” as a normal step; … ai_tool`.
- New caution chip (not sent back): `“Search” needs the credential braveSearchApi and none is set: pick one in the node's panel`. Shown only when the credential slot is visible for the node's parameters.
- Pinning: the chat has no pin operation; test data is pinned only by the empty-canvas builder (`cleanTestItems` in `flow-builder.ts`).

## limitations.md

- The option check covers `options` values written as plain text; expressions and dynamically loaded options are not checked.
- A model that is told a shape can still omit a step the user asked for (live check: the first reply left out the Extract step; a follow-up added it with the right `getText` action).
- Naming a model the editor doesn't know ("qwen3.8") is only handled in the prompt (say so), not checked in code.
