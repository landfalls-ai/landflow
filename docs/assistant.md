# Editor assistant

The workflow editor has an AI assistant with two faces on one backend:

- **After-run suggestions**: once a node has run, a "✨ Suggestions" card in its panel offers fixes for errors, parameter tweaks, data-quality notes and the next node to add. Each comes with **Apply** and **Dismiss**.
- **Spotlight**: a bar floating at the bottom of the canvas, next to Execute workflow. Bubbles above it suggest what to ask and complete what you type. The builder chat behind it researches the node catalog, node docs, the workflow and the last run, then **proposes** changes. You review each proposal as a diff and apply it.

The assistant never edits a workflow by itself. Everything it suggests is a list of [edit operations](#edit-operations) that the server checks against the live registry. The editor applies them only when you click Apply, as one step with an **Undo** in the toast. Applying doesn't save; Save does.

By default the assistant runs on the local builder model: Ollama at `OLLAMA_URL` with `LANDFLOW_BUILDER_MODEL` (`qwen3-coder:30b`). These are the same settings as "Describe a workflow".

The assistant only uses the node types the workflow may use: those online, minus what governance blocks for the instance, the workflow's project and the workflow itself (`lib/server/assistant/scope.ts`, the same filter as the node creator).

## After-run suggestions

Open a node that has run in the editor. The card sits at the top of the output pane.

- **Auto** (the default) asks once per run, 0.6 s after the panel shows it. The toggle is stored per browser (`localStorage["landflow-assistant-auto"]`). With Auto off, a **✨ Suggest** button asks on demand. ↻ asks again.
- Results are cached per run (node id + run start time). A new run gets new suggestions. When a run fails, the failed node's suggestions are fetched right away, so they are usually ready by the time you open it.
- Badges: **Fix** (the node failed), **Tweak** (a parameter), **Data** (a problem in the input or output), **Next step** (a node to add). The percentage is the model's confidence.
- The diff shows what Apply does: `+` a node, `~` parameters, `→` a connection, `−` a removal, `✎` a rename. ⚠ lines warn when a change would leave something dangling.
- A suggestion is applied in full or not at all. If any of its changes doesn't fit the workflow, it is shown as advice only, with no Apply button. A tweak or next step with no applicable change is left out.
- A manual trigger, No Operation, Wait or Stop and Error node that succeeded is skipped without a model call.

One request makes one model call with JSON output (`responseFormat: 'json'`). The prompt contains:
- the workflow outline;
- the node's parameters and type docs, including options, defaults, which fields are visible, and credentials;
- the first 3 input and output items of the run (clipped), and the error;
- the upstream and downstream node names;
- a one-line-per-type catalog for "next" ideas.

The reply is checked with zod, and each suggestion's ops are validated. Suggestions are ranked fix first, then by confidence. Duplicates (the same change twice) are dropped, and at most 3 are kept.

## Spotlight

Spotlight is the one AI surface in the editor: a bar at the bottom of the canvas, beside the run controls. Click it or press **⌘I**. Its conversation opens above the bar and lasts while the workflow is open. ✎ starts over; the chevron or **esc** hides it, and **Apply** hides it too so the change shows on the canvas (the toast has **Undo**). A count on the bar's conversation button shows proposals not yet applied or dismissed.

**Bubbles.** Small suggestions float above the bar. They come from `lib/shared/spotlight.ts`, with no model call, so they change as you type:

| When | Bubbles |
|---|---|
| The canvas is empty | Starters for the triggers the workflow may use: *When a webhook is called, …*, *Every morning at 9, …*, *Answer chat messages with an AI agent*, *Fetch a JSON API and keep the items where …* |
| The box is empty and focused | At most three, most urgent first: *Why did “X” fail?*, *Connect a chat model to “Agent”*, *Explain “Selected node”*, *Add a trigger that starts this workflow*, *After “Last node”, …*, *What does this workflow do?* |
| The box is empty, not focused | Only a failure: *Why did “X” fail?*, and *Fix: …* once the after-run suggestions for the failed node are ready |
| Typing `@` | Nodes on the canvas by name (spaces allowed): choosing one inserts `@Node name` |
| Typing a word | Node types this workflow may use, by name, keyword or plugin (`sla` → Slack, Slack Trigger), and, when the word is all there is, the whole step: *Add Slack after “Selected node”* (else the last node) |
| Typing the start of a suggestion | The rest of the sentence |

A bubble that ends in “…” fills the box to finish; a complete question or step sends at once. **Tab** takes the first (or highlighted) bubble, **↑ ↓** move between them, **Enter** sends. *Fix: …* puts the suggestion in the conversation as a proposal card.

**Context.** The selected node shows as a chip in the bar; × leaves it out of the next message. Tagged nodes and node types go with the message as `mentions` (ids, not text), and the server adds them to the prompt: a tag the workflow can't use is dropped.

**Empty canvas.** The first message on an empty canvas drafts the whole flow in one go with the flow builder (`/api/ai/build`), lays it out and pins test data on the trigger. One ⌘Z undoes it. Later messages go to the builder chat.

### The builder chat

Each message sends the conversation so far, the current workflow (`toWorkflow()`, saved or not), the selected node and a digest of every node's last main run. The server runs a tool-calling loop of at most **8 model calls** per message:

| Tool | What it returns | Activity line |
|---|---|---|
| `search_nodes(query)` | Keyword matches over display names, type ids, keywords, categories, plugin names and descriptions | Searched nodes for "sheets" |
| `get_node_docs(type)` | The type's ports, credentials and parameters (accepts a node name too) | Read Google Sheets docs |
| `get_workflow()` | The outline, including changes proposed earlier in this reply | Read the workflow |
| `get_run_data(node)` | The node's parameters, neighbours, run status, error and first items | Read run data of "Code" |
| `propose_changes(summary, ops)` | Validates the ops and shows them as a proposal card | Proposed 2 changes |

Before showing a proposal, `propose_changes` makes three checks:
- **Nothing valid**: if none of the ops apply, the reasons go back to the model to fix.
- **Dangling**: if the change leaves something dangling, it goes back **once** with the [warnings](#warnings) and a hint to use `before`. The second attempt is shown, warnings and all.
- **Repeat**: if the change alters nothing (already in the workflow, or proposed earlier in the reply), it is skipped.

Later proposals in the same reply build on earlier ones. If you apply only a later proposal, any ops that depend on an earlier one are skipped, and the toast says so.

Each card has **Apply** and **Dismiss**. When a reply has two or more open proposals, **Apply all** applies them in one step with one undo. Earlier turns go back to the model as text, with a note on each proposal: `[Proposed "…": applied | dismissed | not applied yet]`.

Local models sometimes write a tool call as text (`<function=propose_changes><parameter=…>`) instead of a structured call. The chat reads those back as calls.

## Edit operations

Proposals use `lib/shared/assistant-ops.ts`. A node reference is a node **name**, an id, or the `ref` of a node added earlier in the same list.

| Op | Fields | Notes |
|---|---|---|
| `addNode` | `type`, `ref?`, `name?`, `parameters?`, `after?`, `before?`, `output?` | `after`: the new node is wired from that node's `output`. If the new node is a sub-node, it attaches to `after` instead. `before`: inserts the node in front of another. Whatever fed that node feeds the new one, and the downstream nodes move one column right. Names are made unique, and defaults are filled in |
| `setParameters` | `node`, `parameters` | Merged one parameter at a time, in declaration order, the way the editor sets them: dependent fields reset and new defaults fill in |
| `connect` | `from`, `to`, `output?`, `input?`, `type?` | A connection that already exists counts as done, not as a second edge. Edges touching a sub-node take its capability type. An agent → sub-node edge is flipped to run sub-node → agent. A Merge's inputs fill in turn. On a port with a connection limit, the new edge replaces the oldest |
| `disconnect` | `from`, `to`, `type?` | Works in either direction |
| `removeNode` | `node` | Its connections and pinned data go too |
| `renameNode` | `node`, `name` | `$('Old')` and `$node["Old"]` in other nodes' parameters are renamed too |

`applyOps(workflow, ops, lookup)` is pure: workflow in, workflow out. It is also the validator. Validation follows the same rules as the flow builder:
- unknown types, unknown nodes and impossible connections are **dropped with a reason**;
- parameters a node doesn't have are **ignored**.

The server runs it against the registry's available node types. The editor runs it again against the current canvas when you click Apply, so ops that no longer fit (because you edited the workflow in the meantime) are skipped rather than applied blindly.

### Warnings

`structuralWarnings(before, after)` flags:
- a node that lost its only input;
- a single-input node that now gets input from two nodes (an insert that forgot its disconnect);
- a new node with no input, or a new sub-node attached to nothing;
- a new root node missing a required sub-node (for example, an AI Agent without a chat model).

## API

| Route | Body | Response |
|---|---|---|
| `POST /api/assistant/suggest` | `{ workflow, workflowId?, nodeId, run: RunDigest, model? }` | `{ suggestions: [{ id, kind, title, detail, confidence, ops, dropped?, warnings? }], model, durationMs, skipped? }` · 404 for an unknown node, 502 when the model fails |
| `POST /api/assistant/chat` | `{ messages: [{ role, content }], workflow, workflowId?, selectedNodeId?, runs?: { [nodeId]: RunDigest }, mentions?: { nodes?: string[], types?: string[] }, model? }` | SSE, one event per step: `text {text}`, `tool {name, label, ok}`, `proposal {id, summary, ops, dropped, warnings}`, then `done {model, durationMs, steps, usage}` or `error {message}` |
| `POST /api/assistant/feedback` | `{ kind: fix\|param\|data\|next\|proposal, action: applied\|dismissed }` | `{ ok: true }` (feeds the metrics below) |

`RunDigest` is `{ status, durationMs, error?, inputs: [{ count, sample }], outputs: [{ count, sample }], logs? }`. `sample` holds the first 3 items' JSON, with long strings, arrays and deep objects clipped. The editor builds digests with `digestRun()`, so full run data never leaves the browser.

`workflowId` (the saved workflow being edited) limits proposals to the node types it allows; without it, the instance's governance list applies. `mentions` are node ids on the canvas and node type ids the user tagged.

`model` overrides the default model:
- a bare Ollama model name;
- `anthropic/<model>` (uses `ANTHROPIC_API_KEY` or an `ant auth login` profile);
- `openai/<model>` (uses the server's `OPENAI_API_KEY` and `OPENAI_BASE_URL`).

## Telemetry

- **Spans** ([observability §4](observability.md#4-spans)):
  - `assistant.suggest {node type}` and `assistant.chat`, children of the request span;
  - `gen_ai.chat {model}` spans inside;
  - an `assistant.tool` span event per chat tool call.
- **Metrics** ([§5](observability.md#5-metrics)):
  - `landflow.assistant.requests{landflow.assistant.request, landflow.outcome}` (`ok`, `error`, `timeout` or `skipped`);
  - `landflow.assistant.duration`;
  - `landflow.assistant.suggestions{landflow.assistant.kind}`;
  - `landflow.assistant.applied` and `landflow.assistant.dismissed{landflow.assistant.kind}`, reported by the editor through the feedback route.

## Code

| | |
|---|---|
| `lib/shared/assistant-ops.ts` | the op language: `parseOps`, `applyOps`, `structuralWarnings`, `describeOps`, `digestRun` (shared with the client) |
| `lib/server/assistant/research.ts` | node docs, catalog search, node context, workflow outline (deterministic, no model) |
| `lib/server/assistant/ops.ts` | `validateOps` against the registry |
| `lib/server/assistant/suggest.ts` | `suggestAfterRun` |
| `lib/server/assistant/chat.ts` | `runChat`, the tool loop |
| `lib/server/assistant/model.ts` | default and override models |
| `lib/server/assistant/scope.ts` | `allowedTypes`: the node types a workflow may use |
| `lib/shared/spotlight.ts` | Spotlight's bubbles: starters, attention first, `@` mentions, node types, sentence completion |
| `lib/server/telemetry/assistant.ts` | spans and instruments |
| `components/editor/assistant.ts` | client stores: suggestion cache, chat conversation, `applyChanges` with undo |
| `components/editor/suggestions-card.tsx`, `spotlight.tsx` | the after-run card, and Spotlight (bar, bubbles, conversation, proposal cards) |
| `components/editor/ai-builder.tsx` | `useBuildFlow`: the empty canvas's one-shot flow draft |
| `apps/web/test/assistant.test.ts` | ops, suggestion parsing and the chat loop with scripted models |
| `apps/web/test/spotlight.test.ts` | the bubbles |
