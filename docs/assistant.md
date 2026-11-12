# Editor assistant

The workflow editor has an AI assistant with two faces on one backend:

- **After-run suggestions**: once a node has run, a "✨ Suggestions" card in its panel offers fixes for errors, parameter tweaks, data-quality notes and the next node to add. Each comes with **Apply** and **Dismiss**.
- **Spotlight**: a bar floating at the bottom of the canvas, next to Execute workflow. Bubbles above it suggest what to ask and complete what you type. The builder chat behind it researches the node catalog, node docs, the workflow and the last run, then **proposes** changes. You review each proposal as a diff and apply it. **Test and fix** runs the workflow and has failures fixed until a run passes, then offers to publish it.

The assistant never edits a workflow by itself. Everything it suggests is a list of [edit operations](#edit-operations) that the server checks against the live registry. The editor applies them only when you click Apply, as one step with an **Undo** in the toast. Applying doesn't save; Save does.

By default the assistant runs on the local builder model: Ollama at `OLLAMA_URL` with `LANDFLOW_BUILDER_MODEL` (`qwen3-coder:30b`). These are the same settings as "Describe a workflow". `LANDFLOW_BUILDER_MODEL=anthropic/claude-sonnet-5-5` (with `ANTHROPIC_API_KEY` for the server) runs both on Claude, the first draft included: it asks for the draft's JSON schema in the system prompt (up to 16,000 output tokens, with Anthropic's server-side fallback on a refusal) and takes the object out of the reply; `openai/<model>` works the same way. A first draft waits up to `LANDFLOW_BUILDER_TIMEOUT_SECONDS` (600) for the model, which reads the whole node catalog before it writes; past that it fails with a message that names the model and the setting, not "Could not reach Ollama".

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

Spotlight is the one AI surface in the editor: a panel at the right of the canvas, never over it. Press **⌘I** to put the cursor in its box. Its conversation lasts while the workflow is open. ✎ starts over.

### The Spotlight panel

One place for everything Spotlight says and does, whether you asked or it is drafting, testing, fixing or designing an agent on its own (`SpotlightPanel` in `components/editor/spotlight.tsx`):

- **Where.** On a desktop it is a 360 px column beside the canvas and its logs: the canvas narrows, so the flow is never covered. The button at the right of its header folds it to a 44 px strip that still says what Spotlight is doing (written down the strip); a click unfolds it. On a phone it is a sheet under the canvas, which shrinks to the space above it: open, it takes about half the screen and the run logs give way to it (its rows say how each run went); folded, it shows its header, the latest step and the box; with the workflow's chat open, the chat takes its place. The editor fills the screen under the phone bar, so the box stays on screen. Folded by default between 768 and 1099 px, where the column would leave the canvas too narrow. Only you fold or unfold it: a reply, a drafted flow, a test session or autonomous mode leave it as it is (`collapsed` in the store, kept in `localStorage` `landflow-spotlight-collapsed`). ⌘I unfolds it.
- **Header.** What Spotlight is doing, worked out from the conversation (`titleOf` in `components/editor/timeline.ts`): *Drafting the flow*, *Designing “Contract Reviewer”*, *Fixing “Post to Slack”*, *Testing the flow*, *Working on it*, then how the last test since your last message ended (*Passed*, *Stopped: still failing*). Beside it: the **Autonomous** switch, ■ Stop while it works, ✎ New conversation and the fold button.
- **Timeline.** Your messages, and Spotlight's replies as rows: each test run (a failed one is a button that opens the node it failed at), each change it applied, titled by what its ops did rather than the model's words (*Fixed · Set channel on “Post to Slack”*, `opsTitle` in `lib/shared/assistant-ops.ts`; the model's sentence and the diff open on a click; *(1 part skipped)* when an op no longer fit), with **Undo** on the newest (a phone has no ⌘Z), each **Needs you** row ([Test and fix](#test-and-fix)), each agent it designs (*Agent “Legal Clause Reviewer” published · ollama/qwen3-coder:30b*, with **Open** to its page) after the turn that created it. A reply in a test session, or an autonomous reply that changed the flow, shows its first sentence and **more**. While a change is being built, its steps show in the reply ([Building, step by step](#building-step-by-step)).
- **Box.** At the bottom of the panel, with the bubbles above it and the selected node's chip on its own line.
- **One chip per node.** Above a node Spotlight works on, one chip in the panel's words: *Fixing…* and *Designing its agent…* (violet), *Needs you* (amber), or what the last fix did. It shows whether or not the node is selected (Spotlight's own changes don't select what they add).
- **Fix bubbles.** When a fix is applied, a bubble above one node says what it changed (*Fixed · Set channel on “Post to Slack”*), and only the newest fix has one; a new session clears it: the node the fix was asked for (where the spinner was) when the fix touched it, else the first node it changed. One bubble per fix, so a small canvas isn't covered. It closes with ×, or by itself after a minute (`noteFix`, `dismissFix` and `fixedNodes` in `components/editor/assistant.ts`; `FixNote` in `components/editor/flow-node.tsx`).
- **Quiet.** A run Spotlight started is a row of its timeline, not a toast (`spotlightOwnsRun`), and an autonomous apply makes no toast either. Other toasts sit left of the column on a desktop and above the sheet on a phone.
- **In view.** While Spotlight drafts or tests, the canvas fits the whole flow again when it grows or the canvas changes size, until you zoom or pan. The timeline follows new rows only when you are at its end.
- **Stop.** ■ stops a reply: in autonomous mode, what a stopped reply half proposed stays a proposal (only a reply that finished is applied). **New conversation** during a test ends it without leaving text behind.

The app's left menu folds to icons with the button beside the logo (kept in `localStorage` `landflow-rail-collapsed`; `components/shell/sidebar.tsx`), so the canvas and the panel have the width.

**Voice.** Replies are written for a phone: at most two short sentences, the result first, no "Let me…" narration (`withoutNarration`) and no leaked tool-call markup (`withoutLeakedMarkup`, even an unclosed `<function=…>`). In autonomous mode the model is told its change is applied and tested as it ends (`session: "auto"`), so it never says "click Apply".

**Bubbles.** Small suggestions float above the box. They come from `lib/shared/spotlight.ts`, with no model call, so they change as you type:

| When | Bubbles |
|---|---|
| The canvas is empty | Starters for the triggers the workflow may use: *When a webhook is called, …*, *Every morning at 9, …*, *Answer chat messages with an AI agent*, *Fetch a JSON API and keep the items where …* |
| The box is empty and focused | At most three, most urgent first: *Why did “X” fail?*, *Connect a chat model to “Agent”*, *Explain “Selected node”*, *Add a trigger that starts this workflow* (or, when there is one, *Test it and fix what fails*, which starts [Test and fix](#test-and-fix)), *After “Last node”, …*, *What does this workflow do?* |
| The box is empty, not focused | Only a failure: *Why did “X” fail?*, and *Fix: …* once the after-run suggestions for the failed node are ready |
| Typing `@` | Nodes on the canvas by name (spaces allowed): choosing one inserts `@Node name` |
| Typing a word | Node types this workflow may use, by name, keyword or plugin (`sla` → Slack, Slack Trigger), and, when the word is all there is, the whole step: *Add Slack after “Selected node”* (else the last node) |
| Typing the start of a suggestion | The rest of the sentence |

A bubble that ends in “…” fills the box to finish; a complete question or step sends at once. **Tab** takes the first (or highlighted) bubble, **↑ ↓** move between them, **Enter** sends. *Fix: …* puts the suggestion in the conversation as a proposal card.

**Context.** The selected node shows as a chip above the box; × leaves it out of the next message. Tagged nodes and node types go with the message as `mentions` (ids, not text), and the server adds them to the prompt: a tag the workflow can't use is dropped.

**Empty canvas.** The first message on an empty canvas drafts the whole flow in one go with the flow builder (`/api/ai/build`), lays it out and pins test data on the trigger. One ⌘Z undoes it. While it drafts, the canvas shows a placeholder instead of the templates. The message becomes the workflow's description (when it has none), and the reply ends with **Test and fix**. Later messages go to the builder chat.

**Dictation.** The microphone button beside Send records (up to two minutes; click again to stop), posts the clip to `POST /api/assistant/transcribe` and appends the text to the box. Nothing is sent by voice alone: the text is yours to edit, then Enter, and any change still waits for Apply on its plan card. The button shows only where the browser can record (`getUserMedia`, `MediaRecorder`; needs https or localhost) and the person has not denied the microphone. Speech-to-text is an OpenAI-compatible `/audio/transcriptions` server the operator sets with `LANDFLOW_STT_URL` (default `http://127.0.0.1:8000/v1`, e.g. a local faster-whisper or whisper.cpp server, so audio stays on the machine), `LANDFLOW_STT_MODEL` (`whisper-1`) and `LANDFLOW_STT_API_KEY`. Without a server the button reports why. To run one locally: `docker --context orbstack run -d --name landflow-stt -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu`, download a model once with `curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small`, and set `LANDFLOW_STT_MODEL=Systran/faster-whisper-small` (this server wants the full model id, not `whisper-1`). Code: `lib/server/assistant/transcribe.ts`, `components/editor/use-dictation.ts`. Spoken replies and a hands-free mode are not built.

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
- **Collection shapes and options**: `get_node_docs` and the flow-builder catalog spell out how a collection or fixedCollection is stored (group names, field names, option values, a one-line example). A proposal that writes a collection in the wrong shape, uses an unknown key or sets an option to a value outside its list goes back **once** with a warning such as `“Node” stepList.step[0].action: "extract" is not one of …`, `… has no field “value” (fields: …)` or `… must be an object keyed by group`. Only plain-text option values are checked, not expressions or dynamically loaded options.
- **Branching twice**: an If, Filter or Switch (`core.if`, `core.filter`, `core.switch`) added right after a node that already has two or more named main outputs, without an `output`, goes back **once** with a note such as *Run Report already branches: output 0 “Passed”, output 1 “Send back”. Connect from those outputs instead.* If it is proposed again, it is shown.

Later proposals build on earlier ones, in the same reply and in later replies while they are pending. Once everything the latest message asks for is proposed, the model is told to stop and say in one line what the cards do, rather than go on improving the workflow unasked (both the prompt and each proposal's tool result say so). A request with several parts is meant to go in as one proposal (or a few): the prompt asks for a short numbered plan first, then new nodes wired to each other with `ref`, `after` and `connect`, branches and loops included.

**Loops.** A `connect` back to an earlier node makes a loop; the engine runs loops, and neither the op validation nor the structural warnings treat an edge from downstream as a second input to complete. The prompt describes the round counter: a Code node that adds 1 to a round number, then an If “round < N” whose true branch connects back and whose false branch goes on.

 If you apply only a later proposal, any ops that depend on an earlier one are skipped, and the toast says so.

Each card has **Apply** and **Dismiss**. When a reply has two or more open proposals, **Apply all** applies them in one step with one undo. Earlier turns go back to the model as text, with a note on each proposal: `[Proposed "…": applied | dismissed | not applied yet]`.

Local models sometimes write a tool call as text (`<function=propose_changes><parameter=…>`) instead of a structured call. The chat reads those back as calls.

More guards cover what local models get wrong (all in `lib/server/assistant/chat.ts`):
- **Made-up ids**: a parameter named like an id (`channelId`, `sheetId`, `id`…) whose value appears nowhere in the conversation, the workflow, its run data or the node type's own options is left out of the proposal, and the card lists it as left for the user to fill in. The prompt also says not to invent ids, channels, addresses, URLs or keys.
- **"It has been added"**: in a reply that proposed something, sentences that say the change was made ("has been added", "I've updated…", "The workflow now has…", "is ready to…") are dropped, because nothing changes until Apply. Lists keep their lines; if nothing is left, the reply says to review the card and click Apply.
- **Wiring and purpose warnings**: after a build, the proposal card carries warnings for (a) a connection from one If/Switch output into a node a sibling output also reaches (sent back once like other structural warnings; loops back to the branching node and Merge targets are exempt), (b) a new If/Filter/Switch, or a new Set/Code-like node that is a dead-end stub beside a sibling, that nothing reads ("has no purpose"; shown only, not sent back), and (c) a fix that hides an error: `onError: continue`, or code parameters that catch and return (shown only), (d) a new tool-capable node wired after an agent as a normal step, or a sub-node given a main connection (sent back once: `“Shell” is wired after “Agent” as a normal step; … ai_tool`), and (e) a new node whose required credential is unset, as a caution chip on the card (`“Search” needs the credential braveSearchApi and none is set: pick one in the node's panel`; shown only, and only when the credential slot is visible for the node's parameters). The prompt also covers collection shapes and `ai_*` connections, and says to tell the user what it can't set. The chat has no pin operation: the builder's test data (`cleanTestItems` in `flow-builder.ts`) drops chat-trigger junk (`chatInput`, the trigger's own parameters) and is not pinned when no node reads it.
- **A card that never appeared**: when a chat reply says to click Apply and no proposal exists (and none is waiting), Spotlight shows "No change card was created", asks the model once more to call `propose_changes`, and if it still doesn't says so. This does not apply to test-and-fix sessions, which already press once.
- **Teams by name**: a Run a Team node whose `teamId` is a published team's name (with or without "team") or its lead's title, as models write it, gets that team's id and `teamName`; a name no team has, or that fits more than one, is left as written (`withTeamIds`).
- **Made-up ids in the text**: an id the proposal left out as made up (an id-like token: a capital letter, 9 or more capitals, digits, `_` or `-`, with a digit) is removed from the reply's text as well; in brackets it goes, elsewhere it becomes "the right id".
- **Repeats**: a sentence the reply already said earlier in the message (the same words, or six or more content words of which 80% were said before) is dropped, and a proposal identical to an earlier one in the reply is skipped.
- **Echoed notes**: the model sometimes copies the notes it gets in the history (`[Proposed “…”: applied]`, `[Test run 2 failed: …]`) into its reply; those lines are removed. More wordings of "it's done" count as claims too: "was set up", "will now", "now sends …".
- **Tool-call parse errors**: Ollama parses tool calls itself, and some samples fail its parser (qwen3-coder's XML: `XML syntax error … element <parameter> closed by </function>`, a 500). The Ollama adapter retries those up to twice, and in a stream only while nothing has been shown yet. This also covers the AI Agent on an Ollama model.

### Agents and teams

Spotlight works out whether a step needs one of your agents, a plain AI Agent, or a new agent of its own. Both its chat and the first-draft builder (`lib/server/flow-builder.ts`) get the caller's published agents and teams (`roster()` in `lib/server/assistant/roster.ts`, at most 30 of each, only those the caller can see). Each agent is one line from `agentBrief()` in `lib/shared/agent-brief.ts`: its name, `agentId`, version, team, what it does (its description, else its persona's mission), its role, its skills with their "use when", and its tools (by name, and "asks <agent>" for the agents it delegates to). Agents nobody has published are left out, because a flow runs the published version.

The prompt's rule, in both places:
- **One fits**: if an agent's description, skills and tools cover the step, the flow runs it with Run an Agent (`core.messageAgent`, `agentId` and `message`), or a team with Run a Team. Spotlight says in its closing sentence which agent it picked and why.
- **A small step**: classify, summarize, extract or draft a reply is a plain AI Agent (`core.aiAgent`); it needs no specialist.
- **None fits** (the job needs its own instructions, tools or knowledge, other flows will reuse it, or the user asks for an agent): Spotlight says so and proposes `newAgent` (see [Edit operations](#edit-operations)). Applying the change adds the Run an Agent node, and the editor has the [Agent architect](agents.md#agent-architect) design the agent (`POST /api/agents/design`, `components/editor/new-agent.ts`): a model this host has (a local Ollama one first), the tools it needs from the plugins online, and a knowledge base when it works from documents (one that exists, or a new empty one to fill). The node points at the agent, and a toast says what it runs on, its tools and what is left to do, with a link. In [autonomous mode](#autonomous-mode) the agent is published, so the flow can run it while it's tested; otherwise it stays a draft for a person to check and publish (until then the node fails with *Publish “…” first*). A test run waits until the agents being designed are saved. The first-draft builder doesn't create agents; it picks one of yours or uses an AI Agent, and the chat proposes a new one when asked.

A new AI Agent step the chat proposes that wouldn't run here, with no chat model attached (so OpenAI's) or a hosted one, becomes a `newAgent` with its name, its system message as the instructions and its prompt as the message (`asNewAgents`); the chat model and tools attached to it go, and the model is told why. One with an Ollama chat model stays a small inline step.

Ids are checked like team ids: a name written where `agentId` goes becomes the id of the one published agent with that name (`withAgentId`, with or without "agent"); the builder clears an id no agent has, so the node asks for one, and the chat leaves it out as made up. A `newAgent` never carries an `agentId`. Its node runs the agent with the agent's own model and instructions, so the prompt says to attach nothing to it; a local model that then adds an AI Agent named after the new agent ("Legal Clause Reviewer 2"), or a chat model or tool for its node, has those left out, with the connections that use them, and is told why (`withoutAgentStandIns`, in the same reply or while the newAgent is pending). With no published agents the chat's prompt says *Your agents: none published yet.*, and `get_node_docs("core.messageAgent")` lists them (or says to propose a `newAgent`). Tests: `test/spotlight-agents.test.ts`, `test/flow-builder.test.ts` (AI builder agents).

### Building, step by step

In the new look ([ui-review.md](ui-review.md#the-look)), a change Spotlight builds in the builder chat is watched taking shape instead of read afterwards. While the reply is going, and while a proposal waits for Apply, the reply in the [panel](#the-spotlight-panel) lists the steps and the canvas, beside it, shows them:

- **Steps you can follow.** The reply lists the steps of the change, each ticked off with a small pop as it finishes, and names the parts of the one in progress (*Wiring the connections: Ask for approval → Approved · Ask for approval → Deny*). Tool calls are the first steps, as they stream (*Read the workflow · 4 nodes*, *Searched nodes for “slack”*). The proposal's ops are the rest, one step per added node (*Add Ask for approval · If · after Code*), one for consecutive connections (*Wire 3 connections*), and one per parameter edit, rename, removal, team and settings change. `buildSteps()` and `planOf()` in `lib/shared/build-steps.ts` derive them, pure and unit-tested (`test/build-steps.test.ts`); `planOf()` runs the ops through `applyOps()`, so a step only exists for an op that would apply. A proposal arrives whole, not as a stream, so the editor ticks its steps off one by one on a short timer (about half a second each): the steps and ghosts show the plan taking shape, not the model's progress.
- **The canvas fills in.** The nodes the plan adds appear as dashed ghosts at the positions `applyOps()` gives them (after their source node), each when its step is reached; the one being made shimmers, and new connections are drawn as dashed violet lines when their step is reached. Ghosts are extra nodes and edges handed to React Flow beside the real ones (`GhostNodeView`, `GhostEdgeView` in `components/editor/building.tsx`); they are not in the editor's store, are not selectable or draggable and are never saved. A thin bar on top of the canvas shows how far the plan is (done steps over all; it never reaches the end while the assistant is still working). A ghost that lands outside the view (a node added after the last one is often past the right edge) brings the whole flow and its ghosts into view, without zooming in (`KeepGhostsInView` in `components/editor/editor.tsx`).
- **Still a plan.** With autonomous mode off, nothing in the workflow changes until **Apply** under the steps (the same `applyChanges()` path, one Undo in the toast; **Dismiss** drops the plan and the ghosts). A message sent while the reply is still going stops it first, so the follow-up redirects it. With autonomous mode on, the plan is applied when the reply ends.

The Agent architect (a dialog with a draft preview, not a canvas) does not show steps this way yet. The classic look draws none of this: the conversation and its proposal card work as before.

### Test and fix

**Test and fix** (`components/editor/test-session.ts`) runs the workflow and, while a run doesn't pass, has the assistant fix it and runs it again. It starts by itself in [autonomous mode](#autonomous-mode) (on by default); otherwise from the button at the end of an empty-canvas draft, or from the *Test it and fix what fails* bubble on any workflow with a trigger. Starting it is your go-ahead for the fixes: each is applied as it comes, with its own Undo. ■ in the panel's header ends the session; a run already going finishes.

**Needs you.** Before the first run, and after any failed one, Spotlight checks for what only a person can do, and asks instead of spending a fix. The row has the button that does it and **Test again**; the header says *Needs you: …*, and the node shows an amber *Needs you* chip:
- **No trigger**: *Nothing starts this flow yet*, with **Add a manual trigger** (one op).
- **No agent or team picked** on a Run an Agent or Run a Team step Spotlight isn't designing: **Pick an agent** opens the node.
- **A credential**: an error that says a credential isn't selected, or a refusal (401, 403, `invalid_auth`, an API key): **Pick the credential** opens the node (`needsPerson` in `lib/shared/run-check.ts`).
- **Sending for real**: a flow with a step that sends or changes things outside it (an HTTP call that isn't a GET, an operation that sends, posts, creates, updates or deletes, an email step; `sendingSteps`) asks once per workflow while the page is open: *A test runs “Post to Slack” for real*, **Run it for real** or **Not now**. A heuristic: it reads the method and the operation's name.

**Wasted rounds.** The same failure after a fix (`sameFailure`: numbers and ids aside) undoes that fix and stops. A fix that touches neither the failing step nor what feeds it, removes a node and adds the same kind back, or only adds a No Operation step is sent back to the model once (`wastedFix` in `lib/server/assistant/chat.ts`). A passing run is reviewed against the goal once; the review must start with "Yes" to show the publish card, and a "no" without a change says so instead.

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
- a run can't be judged: the trigger waits for a test event (pin test data on it or send one), the run waits (a Wait node, a form or an approval), or it was canceled. A drafted flow seldom waits: the builder pins its test items on a Manual, Webhook or Form trigger (with a Webhook, each item is what a call brings, `{"body": {…}}`), and when the model gave none that carry the fields the steps read, it pins one made-up item with those fields (`sampleItems`: `$json.ticketDescription` → `"Sample ticket description"`, `$json.body.x` under `body`);
- the assistant has no fix for a failed run (*I can’t fix “X” myself: …*), or its fix no longer fits the canvas (*The canvas changed while I worked…*);
- the same failure comes back after a fix (*The last fix didn’t change the error at “X”, so I undid it and stopped.*);
- only the person can go on (**Needs you**, above). The header then says *Needs you: pick a credential*, or *Stopped at “X”* when a session ended on a failure.

**Ready for production.** The card says what publishing does: with a trigger that starts the workflow on its own (a schedule, a webhook, an app trigger), the published version runs from then on; a workflow that only starts by hand is just recorded. **Publish to production** saves the draft if needed and publishes it, or files a publish request when the workflow needs [four-eyes approval](features/audit-and-governance.md). **Not now** leaves it as a draft. Nothing is published without that click.

### Autonomous mode

On by default, Spotlight doesn't wait for clicks (`components/editor/autonomous.ts`):
- **A new flow**: when it drafts a flow on an empty canvas, Test and fix starts right away (the reply says *Testing it now.*), instead of waiting for the **Test and fix** button.
- **A chat request**: when the reply ends, what it proposed is applied as one step (⌘Z undoes it), the cards turn to *applied*, and Test and fix runs with your message as the goal. A reply that proposed nothing, failed or was stopped changes nothing.

Each fix in the session is applied the same way, as before. An agent Spotlight creates is designed by the Agent architect and **published**, so the flow can run it while it's tested ([Agents and teams](#agents-and-teams)); unpublishing it is one click on its page. **Publish to production** still waits for a person. The **Autonomous** switch in the conversation's header turns it off (kept in the browser, `localStorage` `landflow-spotlight-autonomous`); off, every proposal waits for Apply and a drafted flow for Test and fix. Test runs execute the workflow as Execute workflow does, with the pinned test data, so a step that sends a message or writes to an app would do so for real: before the first such test of a workflow, Spotlight asks (**Run it for real** or **Not now**, [Test and fix](#test-and-fix)). A change that only renames nodes isn't tested; any other is tested against the workflow's description plus your message. Tests: `test/spotlight-autonomous.test.ts`.

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
| `newAgent` | `name`, `description`, `instructions`, `ref?`, `parameters?`, `after?`, `before?`, `output?` | an agent none of the published ones is, and a Run an Agent node for it: parsed as an `addNode` of `core.messageAgent` carrying `newAgent`, placed and wired like one; applying it saves the agent as a draft and sets the node's `agentId` ([Agents and teams](#agents-and-teams)) |
| `turnIntoTeam` | `node` | a Run an Agent node with agents attached as tools becomes one Run a Team node; applying it saves the team ([agent-teams.md](agent-teams.md#turn-into-a-team)) |
| `setNodeSettings` | `node`, `settings` | A node's settings, not its parameters: `retryOnFail`, `maxTries`, `waitBetweenTriesMs`, `retryBackoff` (`fixed` or `exponential`), `onError`, `timeoutSeconds`, `alwaysOutputData`, `disabled`. Other keys are dropped. The [second brain](second-brain.md) uses it for retries |
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
| `components/editor/suggestions-card.tsx`, `spotlight.tsx` | the after-run card, and Spotlight's panel (header, timeline, box, bubbles, proposal rows) |
| `components/editor/timeline.ts` | the panel's header and steps, worked out from the conversation (pure) |
| `components/editor/ai-builder.tsx` | `useBuildFlow`: the empty canvas's one-shot flow draft |
| `apps/web/test/assistant.test.ts` | ops, suggestion parsing and the chat loop with scripted models |
| `apps/web/test/spotlight.test.ts` | the bubbles |
| `apps/web/test/spotlight-panel.test.ts` | the panel: timeline, header, never folding by itself, agent rows, fix bubbles, Spotlight's own runs |
| `apps/web/test/run-check.test.ts` | what passes a test run, and hollow steps |
