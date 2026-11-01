# Editor assistant

The workflow editor has an AI assistant with two faces on one backend:

- **After-run suggestions**: once a node has run, a "✨ Suggestions" card in its panel offers fixes for errors, parameter tweaks, data-quality notes and the next node to add. Each comes with **Apply** and **Dismiss**.
- **Spotlight**: a bar floating at the bottom of the canvas, next to Execute workflow. Bubbles above it suggest what to ask and complete what you type. The builder chat behind it researches the node catalog, node docs, the workflow and the last run, then **proposes** changes. You review each proposal as a diff and apply it. **Test and fix** runs the workflow and has failures fixed until a run passes, then offers to publish it.

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

Spotlight is the one AI surface in the editor: a bar at the bottom of the canvas, beside the run controls (on a narrow canvas, with the chat or another side panel open, it moves to its own line above them). Click it or press **⌘I**. Its conversation opens above the bar and lasts while the workflow is open. ✎ starts over; the chevron or **esc** hides it, and **Apply** hides it too so the change shows on the canvas (the toast has **Undo**). A count on the bar's conversation button shows proposals not yet applied or dismissed.

While Spotlight works on its own (drafting a flow, then [testing and fixing](#test-and-fix) it), the conversation steps aside so the flow stays in view. A card at the top left of the canvas shows what Spotlight is doing (*Drafting the flow*, *Testing and fixing*, *Fixing “Join Titles”*) and one line per step: each test run, each fix applied, the reply to a review. ⤢ shows the whole conversation, and ⤡ (or **esc**) puts it back in the card. The node a fix is being asked for carries a *Spotlight is fixing this* badge. When the work is over, the conversation comes back with the session folded into one line (*Test and fix · 5 runs · 4 fixes applied*, which opens on a click) and the outcome below it.

**Bubbles.** Small suggestions float above the bar. They come from `lib/shared/spotlight.ts`, with no model call, so they change as you type:

| When | Bubbles |
|---|---|
| The canvas is empty | Starters for the triggers the workflow may use: *When a webhook is called, …*, *Every morning at 9, …*, *Answer chat messages with an AI agent*, *Fetch a JSON API and keep the items where …* |
| The box is empty and focused | At most three, most urgent first: *Why did “X” fail?*, *Connect a chat model to “Agent”*, *Explain “Selected node”*, *Add a trigger that starts this workflow* (or, when there is one, *Test it and fix what fails*, which starts [Test and fix](#test-and-fix)), *After “Last node”, …*, *What does this workflow do?* |
| The box is empty, not focused | Only a failure: *Why did “X” fail?*, and *Fix: …* once the after-run suggestions for the failed node are ready |
| Typing `@` | Nodes on the canvas by name (spaces allowed): choosing one inserts `@Node name` |
| Typing a word | Node types this workflow may use, by name, keyword or plugin (`sla` → Slack, Slack Trigger), and, when the word is all there is, the whole step: *Add Slack after “Selected node”* (else the last node) |
| Typing the start of a suggestion | The rest of the sentence |

A bubble that ends in “…” fills the box to finish; a complete question or step sends at once. **Tab** takes the first (or highlighted) bubble, **↑ ↓** move between them, **Enter** sends. *Fix: …* puts the suggestion in the conversation as a proposal card.

**Context.** The selected node shows as a chip in the bar; × leaves it out of the next message. Tagged nodes and node types go with the message as `mentions` (ids, not text), and the server adds them to the prompt: a tag the workflow can't use is dropped.

**Empty canvas.** The first message on an empty canvas drafts the whole flow in one go with the flow builder (`/api/ai/build`), lays it out and pins test data on the trigger. One ⌘Z undoes it. While it drafts, the canvas shows a placeholder instead of the templates. The message becomes the workflow's description (when it has none), and the reply ends with **Test and fix**. Later messages go to the builder chat.

### The builder chat

Each message sends the conversation so far, the current workflow (`toWorkflow()`, saved or not), the selected node and a digest of every node's last main run. Proposals from earlier replies that are still waiting (neither applied nor dismissed) go with it as `pending` (summary and ops, at most 20; the route validates the shape and the server checks the ops against the workflow). The server runs a tool-calling loop per message. It goes on while a step makes progress (a new proposal, or a tool result not seen before in this reply), up to **20 model calls** (`MAX_STEPS`), and stops early, with a note that the last steps only repeated, when two steps in a row add nothing. Only the ceiling gives "Stopped after 20 steps":

| Tool | What it returns | Activity line |
|---|---|---|
| `search_nodes(query)` | Keyword matches over display names, type ids, keywords, categories, plugin names and descriptions | Searched nodes for "sheets" |
| `get_node_docs(type)` | The type's ports, credentials and parameters (accepts a node name too) | Read Google Sheets docs |
| `get_workflow()` | The outline, including pending changes (marked `[pending: proposed, not applied yet]`, with a list of the pending proposals); a node with two or more main outputs lists each output, its name and what it feeds | Read the workflow |
| `get_run_data(node)` | The node's parameters, neighbours, run status, error and first items | Read run data of "Code" |
| `propose_changes(summary, ops)` | Validates the ops and shows them as a proposal card | Proposed 2 changes |

Before showing a proposal, `propose_changes` makes these checks:
- **Nothing valid**: if none of the ops apply, the reasons go back to the model to fix.
- **Parts failed**: if some ops apply and others don't (a type that doesn't exist, a connection to a `ref` no `addNode` gave, a number outside its field's range such as a timeout of `30` in a field measured in milliseconds, which is left out), it goes back **once** with the reasons, so a "replace X with Y" that only removed X isn't shown as is. The second attempt is shown, with what it still leaves out.
- **Units**: if the latest message names a duration ("a 30 minute timeout") and the proposal sets a number field whose label or description gives its unit ("Timeout (ms)") to that duration in another unit (30 or 1800), it goes back **once** saying the number it should be (`30 minutes is 1800000, not 1800`). `get_node_docs` lists a collection's fields with their labels and number ranges, so the unit is in front of the model.
- **Dangling**: if the change leaves something dangling, it goes back **once** with the [warnings](#warnings) and a hint to use `before`. The second attempt is shown, warnings and all.
- **Repeat**: if the change alters nothing (already in the workflow, or proposed earlier in the reply), it is skipped. An `addNode` for a node of the same type and name as one that is pending (an earlier reply, or this one) is dropped, and later ops that name its `ref` use the pending node.
- **Added back**: an `addNode` for a node a pending proposal removes (same name, or same type unless the latest message names that type, as in "replace Check with a new If node") is skipped, unless the latest message asks to add one by that name ("remove Check, then add a new Check after Code"; an add verb before the name, with no remove or delete between them), and the model is told not to add it, or a node doing its job, back. `get_workflow` lists the nodes pending proposals remove.
- **Branching twice**: an If, Filter or Switch (`core.if`, `core.filter`, `core.switch`) added right after a node that already has two or more named main outputs, without an `output`, goes back **once** with a note such as *Run Report already branches: output 0 “Passed”, output 1 “Send back”. Connect from those outputs instead.* If it is proposed again, it is shown.

Later proposals build on earlier ones, in the same reply and in later replies while they are pending. Once everything the latest message asks for is proposed, the model is told to stop and say in one line what the cards do, rather than go on improving the workflow unasked (both the prompt and each proposal's tool result say so). A request with several parts is meant to go in as one proposal (or a few): the prompt asks for a short numbered plan first, then new nodes wired to each other with `ref`, `after` and `connect`, branches and loops included.

**Loops.** A `connect` back to an earlier node makes a loop; the engine runs loops, and neither the op validation nor the structural warnings treat an edge from downstream as a second input to complete. The prompt describes the round counter: a Code node that adds 1 to a round number, then an If “round < N” whose true branch connects back and whose false branch goes on.

 If you apply only a later proposal, any ops that depend on an earlier one are skipped, and the toast says so.

Each card has **Apply** and **Dismiss**. When a reply has two or more open proposals, **Apply all** applies them in one step with one undo. Earlier turns go back to the model as text, with a note on each proposal: `[Proposed "…": applied | dismissed | not applied yet]`.

Local models sometimes write a tool call as text (`<function=propose_changes><parameter=…>`) instead of a structured call. The chat reads those back as calls.

More guards cover what local models get wrong (all in `lib/server/assistant/chat.ts`):
- **Made-up ids**: a parameter named like an id (`channelId`, `sheetId`, `id`…) whose value appears nowhere in the conversation, the workflow, its run data or the node type's own options is left out of the proposal, and the card lists it as left for the user to fill in. The prompt also says not to invent ids, channels, addresses, URLs or keys.
- **"It has been added"**: in a reply that proposed something, sentences that say the change was made ("has been added", "I've updated…", "The workflow now has…", "is ready to…") are dropped, because nothing changes until Apply. Lists keep their lines; if nothing is left, the reply says to review the card and click Apply.
- **Teams by name**: a Run a Team node whose `teamId` is a published team's name (with or without "team") or its lead's title, as models write it, gets that team's id and `teamName`; a name no team has, or that fits more than one, is left as written (`withTeamIds`).
- **Made-up ids in the text**: an id the proposal left out as made up (an id-like token: a capital letter, 9 or more capitals, digits, `_` or `-`, with a digit) is removed from the reply's text as well; in brackets it goes, elsewhere it becomes "the right id".
- **Repeats**: a sentence the reply already said earlier in the message (the same words, or six or more content words of which 80% were said before) is dropped, and a proposal identical to an earlier one in the reply is skipped.
- **Echoed notes**: the model sometimes copies the notes it gets in the history (`[Proposed “…”: applied]`, `[Test run 2 failed: …]`) into its reply; those lines are removed. More wordings of "it's done" count as claims too: "was set up", "will now", "now sends …".
- **Tool-call parse errors**: Ollama parses tool calls itself, and some samples fail its parser (qwen3-coder's XML: `XML syntax error … element <parameter> closed by </function>`, a 500). The Ollama adapter retries those up to twice, and in a stream only while nothing has been shown yet. This also covers the AI Agent on an Ollama model.

### Test and fix

**Test and fix** (`components/editor/test-session.ts`) runs the workflow and, while a run doesn't pass, has the assistant fix it and runs it again. It starts from the button at the end of an empty-canvas draft, or from the *Test it and fix what fails* bubble on any workflow with a trigger. Starting it is your go-ahead for the fixes: each is applied as it comes, with its own Undo. Spotlight's stop button (or ■ on its card) ends the session; a run already going finishes.

Each round:
1. Runs the workflow, as Execute workflow does, and adds a line: *Test run 2 · failed at “Join Titles”: No fields to aggregate*, or *no errors: 4 steps, 1 item reached “Join Titles”*.
2. Judges the run (`checkRun`, `lib/shared/run-check.ts`). A run passes when the execution succeeded, no node failed, and items reached the end of a branch. A run where every branch ended with no items stopped somewhere, which is more often a bug than not, so it doesn't pass.
3. Looks for steps that run but don't do the job. Some do nothing (`hollowSteps`): an If or Filter without conditions (it keeps every item), a Set in manual mode with no fields. Some repeat every result (`multipliedSteps`): a Code node in "each" mode that put out several items for each one it got (10 in, 100 out), because its code handled all the items each time. Drafted flows often have both.
4. When the run failed or a step is hollow, asks the assistant for a fix: what failed, the fixes already tried, and the node it happened at as the selected node. The request is a fresh conversation (the run data is in the context) with `session: "fix"`.
5. When the run passed and the workflow has a goal (its description: an empty-canvas draft sets it to your message), asks whether the result does what was asked (`session: "review"`). The request carries what the last step put out (its first items), so the assistant compares that with each part of the goal, then fixes what doesn't match or says that it does.
6. Applies what the assistant proposed and goes round again, up to **4 fixes**.

With `session` set, the chat route tells the model that Spotlight applies the proposal and runs again by itself, drops "click Apply", "run it again" and lines that are only a JSON object (a tool call written as text) from the reply, and sends a fix request that proposed nothing back to the model once.

It stops when:
- a run passes and the review has nothing to change (or 4 fixes are spent and the last run passed): **Ready for production**;
- 4 fixes are spent and the run still fails: Spotlight says so and names the node whose panel shows what happened;
- a run can't be judged: the trigger waits for a test event (pin test data on it or send one), the run waits (a Wait node, a form or an approval), or it was canceled;
- the assistant has no fix for a failed run, or its fix no longer fits the canvas.

**Ready for production.** The card says what publishing does: with a trigger that starts the workflow on its own (a schedule, a webhook, an app trigger), the published version runs from then on; a workflow that only starts by hand is just recorded. **Publish to production** saves the draft if needed and publishes it, or files a publish request when the workflow needs [four-eyes approval](features/audit-and-governance.md). **Not now** leaves it as a draft. Nothing is published without that click.

## Edit operations

Proposals use `lib/shared/assistant-ops.ts`. A node reference is a node **name**, an id, or the `ref` of a node added earlier in the same list.

| Op | Fields | Notes |
|---|---|---|
| `addNode` | `type`, `ref?`, `name?`, `parameters?`, `after?`, `before?`, `output?` | `after`: the new node is wired from that node's `output`. If the new node is a sub-node, it attaches to `after` instead; a node the same ops then `connect` to `after` as a tool (or model, memory) is only that, and the main edge goes. `before`: inserts the node in front of another. Whatever fed that node feeds the new one, and the downstream nodes move one column right. Names are made unique, and defaults are filled in |
| `setParameters` | `node`, `parameters` | Merged one parameter at a time, in declaration order, the way the editor sets them: dependent fields reset and new defaults fill in. A bare `$fromAI` (or the call without braces) becomes `{{ $fromAI('<name>', '<display name>', '<type>') }}`, what **Let the model decide** writes; `addNode` parameters too |
| `connect` | `from`, `to`, `output?`, `input?`, `type?` | A connection that already exists counts as done, not as a second edge. Edges touching a sub-node take its capability type. An agent → sub-node edge is flipped to run sub-node → agent. A Merge's inputs fill in turn. On a port with a connection limit, the new edge replaces the oldest |
| `disconnect` | `from`, `to`, `type?` | The edges from `from` to `to`; when there are none, a sub-node edge the other way (they run sub-node → agent). "Disconnect Lead → Check Branch" removes the main edge after the lead, not the tool edge into it |
| `removeNode` | `node` | Its connections and pinned data go too |
| `renameNode` | `node`, `name` | `$('Old')` and `$node["Old"]` in other nodes' parameters are renamed too |
| `turnIntoTeam` | `node` | a Run an Agent node with agents attached as tools becomes one Run a Team node; applying it saves the team ([agent-teams.md](agent-teams.md#turn-into-a-team)) |
| `setNodeSettings` | `node`, `settings` | A node's settings, not its parameters: `retryOnFail`, `maxTries`, `waitBetweenTriesMs`, `onError`, `timeoutSeconds`, `alwaysOutputData`, `disabled`. Other keys are dropped. The [second brain](second-brain.md) uses it for retries |
| `setWorkflowSettings` | `settings` | `errorWorkflowId`, `timeoutSeconds`, `retryMaxAttempts`, `retryBaseDelaySeconds`; other keys are dropped |

`applyOps(workflow, ops, lookup)` is pure: workflow in, workflow out. It is also the validator. Validation follows the same rules as the flow builder:
- unknown types, unknown nodes and impossible connections are **dropped with a reason**;
- parameters a node doesn't have are **ignored**.

The server runs it against the registry's available node types. The editor runs it again against the current canvas when you click Apply, so ops that no longer fit (because you edited the workflow in the meantime) are skipped rather than applied blindly.

### Warnings

`structuralWarnings(before, after)` flags:
- a node that lost its only input (not one attached to an agent as a tool, which needs none);
- a single-input node that now gets input from two nodes (an insert that forgot its disconnect);
- a new node with no input (unless attached as a tool), or a new sub-node attached to nothing;
- a new root node missing a required sub-node (for example, an AI Agent without a chat model).

## API

| Route | Body | Response |
|---|---|---|
| `POST /api/assistant/suggest` | `{ workflow, workflowId?, nodeId, run: RunDigest, model? }` | `{ suggestions: [{ id, kind, title, detail, confidence, ops, dropped?, warnings? }], model, durationMs, skipped? }` · 404 for an unknown node, 502 when the model fails |
| `POST /api/assistant/chat` | `{ messages: [{ role, content }], workflow, workflowId?, selectedNodeId?, runs?: { [nodeId]: RunDigest }, mentions?: { nodes?: string[], types?: string[] }, pending?: [{ summary, ops }], session?: fix\|review, model? }` (`session`: a [Test and fix](#test-and-fix) request) | SSE, one event per step: `text {text}`, `tool {name, label, ok}`, `proposal {id, summary, ops, dropped, warnings}`, then `done {model, durationMs, steps, usage}` or `error {message}` |
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
| `lib/shared/run-check.ts` | `checkRun` (did a test run pass), `hollowSteps` (steps that do nothing) and `multipliedSteps` (per-item code that repeats every result) |
| `components/editor/assistant.ts` | client stores: suggestion cache, chat conversation, `applyChanges` with undo |
| `components/editor/test-session.ts` | Test and fix: `testUntilItRuns`, `productionNote`, `publishToProduction` |
| `components/editor/suggestions-card.tsx`, `spotlight.tsx` | the after-run card, and Spotlight (bar, bubbles, conversation, proposal cards, the activity card while it works) |
| `components/editor/ai-builder.tsx` | `useBuildFlow`: the empty canvas's one-shot flow draft |
| `apps/web/test/assistant.test.ts` | ops, suggestion parsing and the chat loop with scripted models |
| `apps/web/test/spotlight.test.ts` | the bubbles |
| `apps/web/test/run-check.test.ts` | what passes a test run, and hollow steps |
