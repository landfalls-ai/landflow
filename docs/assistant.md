# Editor assistant

The workflow editor has an AI assistant with two faces on one backend:

- **After-run suggestions**: once a node has run, a "✨ Suggestions" card in its panel offers fixes for errors, parameter tweaks, data-quality notes and the next node to add. Each comes with **Apply** and **Dismiss**.
- **Spotlight**: a bar floating at the bottom of the canvas, next to Execute workflow. Bubbles above it suggest what to ask and complete what you type. The builder chat behind it researches the node catalog, node docs, the workflow and the last run, then **proposes** changes. You review each proposal as a diff and apply it. **Test and fix** runs the workflow and has failures fixed until a run passes, then offers to publish it.

The assistant never edits a workflow by itself. Everything it suggests is a list of [edit operations](#edit-operations) that the server checks against the live registry. The editor applies them only when you click Apply, as one step with an **Undo** in the toast. Applying doesn't save by itself; autosave saves it 2 seconds later (`⌘S` saves at once).

By default the assistant runs on the local builder model: Ollama at `OLLAMA_URL` with `LANDFLOW_BUILDER_MODEL` (`qwen3-coder:30b`). These are the same settings as "Describe a workflow". `LANDFLOW_BUILDER_MODEL=anthropic/claude-sonnet-5-5` (with `ANTHROPIC_API_KEY` for the server) runs both on Claude, the first draft included: it asks for the draft's JSON schema in the system prompt (up to 16,000 output tokens, with Anthropic's server-side fallback on a refusal) and takes the object out of the reply; `openai/<model>` works the same way. On Ollama the first draft asks for `format: "json"` and the schema goes in the system prompt, as it does for Claude and `openai/<model>`: held to the schema with the whole catalog in the prompt, the local model wrote empty objects where `parameters` is a bare object (every If without a condition, every Set without fields, every schedule without a rule). The reply is parsed with a schema of its own (`nodes` a list of `{key, type, name, parameters}`, `connections` a list); one that does not parse is sent back once with the first three problems in plain words, and a second failure is the error "The model did not return valid JSON". Then the draft is checked before it reaches the canvas (`emptyParts` in `flow-builder.ts`): a list a step cannot work without that is missing, `{}` or only empty rows (an If's conditions, a Set's fields in manual mode, a Switch's rules, a schedule's rules, a table's columns), a collection written in the wrong shape, and a node left unwired. With anything found, the model gets its own draft back once, with a line for each part and how it is written; the second draft is taken when it parses, keeps every step type of the first and is no worse, else the first stands. Nothing is sent back more than once for each cause, and both calls share the one timeout. What is still empty comes with the draft as `left` (kind `empty`, one line each: "“Check total”: no condition yet: it keeps every item"), and a step type the catalog does not have is mapped to the one it can mean (`core.linear.linear` to the Linear plugin's `linear`, listed as kind `dropped` so the person can check it is the one meant) or dropped and listed (kind `dropped`). A reply is read leniently where a field does not shape the draft: a `name`, `testData` or connection `output` of the wrong type is ignored and a numeric node `key` is taken as text. A list the node ships filled (a workflow trigger's `inputs`, a form's `formFields`, a schedule rule whose rows name their kind, `{ field: 'days' }`) is not sent back when it is missing. A failed send-back (an Ollama 500, the timeout) keeps the first draft. The timeout message names `LANDFLOW_BUILDER_TIMEOUT_SECONDS` and its configured value. A first draft waits up to `LANDFLOW_BUILDER_TIMEOUT_SECONDS` (600) for the model, which reads the whole node catalog before it writes; past that it fails with a message that names the model and the setting, not "Could not reach Ollama".

The assistant only uses the node types the workflow may use: those online, minus what governance blocks for the instance, the workflow's project and the workflow itself (`lib/server/assistant/scope.ts`, the same filter as the node creator).

## After-run suggestions

Open a node that has run in the editor. The card sits at the top of the output pane.

- **Auto** (the default) asks once per run, 0.6 s after the panel shows it. The toggle is stored per browser (`localStorage["landflow-assistant-auto"]`). With Auto off, a **✨ Suggest** button asks on demand. ↻ asks again.
- Results are cached per run (node id + run start time). A new run gets new suggestions. When a run fails, the failed node's suggestions are fetched right away, so they are usually ready by the time you open it.
- Badges: **Fix** (the node failed), **Tweak** (a parameter), **Data** (a problem in the input or output), **Next step** (a node to add). The percentage is the model's confidence.
- The diff shows what Apply does: `+` a node, `~` parameters, `→` a connection, `−` a removal, `✎` a rename. ⚠ lines warn when a change would leave something dangling.
- A suggestion is applied in full or not at all. If any of its changes doesn't fit the workflow, it is shown as advice only, with no Apply button. A tweak or next step with no applicable change is left out.
- A manual trigger, No Operation, Wait or Stop and Error node that succeeded is skipped without a model call.
- **Nothing after a host block.** A run that failed with "Blocked: <host> resolves to a private address" gets no model call and no suggestion ("This host blocks that address: only an admin can allow it"): moving a step's destination because the host refused it is the httpbin incident. A suggestion that changes where an existing step sends (a URL's host or port, a channel, an address, a table) keeps its words but loses its changes, so it is advice with no Apply and no chip, and its title never says "external", "public" or a host nobody gave (`destinationChanges` in `lib/server/assistant/change-checks.ts`).

One request makes one model call with JSON output (`responseFormat: 'json'`). The prompt contains:
- the workflow outline;
- the node's parameters and type docs, including options, defaults, which fields are visible, and credentials;
- the first 3 input and output items of the run (clipped), and the error;
- the upstream and downstream node names;
- a one-line-per-type catalog for "next" ideas.

The reply is checked with zod, and each suggestion's ops are validated. Suggestions are ranked fix first, then by confidence. Duplicates (the same change twice) are dropped, and at most 3 are kept.

## Spotlight

Spotlight is the one AI surface in the editor: a panel at the right of the canvas, never over it. Press **⌘K** (or **⌘I**) to put the cursor in its box. A chip above it, "Building <workflow>", says what it does here; it offers "Ask the brain instead" ([one Spotlight](spotlight.md#one-spotlight)). Its conversation lasts while the workflow is open. ✎ starts over.

### The Spotlight panel

One place for everything Spotlight says and does, whether you asked or it is drafting, testing, fixing or designing an agent on its own (`SpotlightPanel` in `components/editor/spotlight/`):

- **Where.** On a desktop it is a 360 px column beside the canvas and its logs: the canvas narrows, so the flow is never covered. When the workflow has a Chat Message trigger the flow chat takes the same column (a **Spotlight | Chat** strip switches; never both). The button at the right of its header folds it to a 44 px strip that still says what Spotlight is doing (written down the strip); a click unfolds it. On a phone it is a sheet under the canvas, which shrinks to the space above it, with three heights ([mobile.md](mobile.md#spotlights-dock)): folded, it shows its header, the latest step and the box; peek, a third of the screen with the newest of the timeline; half, half the screen. Open, the run logs give way to it (its rows say how each run went); with the workflow's chat open, the chat takes its place. The editor fills the screen under the phone bar, so the box stays on screen. Folded by default everywhere until you choose: a desktop starts with the strip, a phone with the bar, where the open sheet would cover the steps. Only you fold or unfold it: a reply, a drafted flow, a test session or autonomous mode leave it as it is (`collapsed` in the store, kept in `localStorage` `landflow-spotlight-collapsed`). ⌘I unfolds it.
- **Header.** What Spotlight is doing, worked out from the conversation (`titleOf` in `components/editor/timeline.ts`): *Drafting the flow*, *Designing “Contract Reviewer”*, *Fixing “Post to Slack”*, *Testing the flow*, *Working on it*, then how the last test since your last message ended (*Needs you: pick a credential*, *Passed*, *Stopped at “X”*). While a flow is drafted, the header counts its seconds, and ■ cancels the request (*Stopped: nothing was drafted.*). The icon has one set of colours: violet while Spotlight works, amber when it needs you, green when the last test passed, grey when it stopped; red is kept for a failed run's row. Beside it: the **Autonomous** switch (filled when on, outlined when off; just its icon while Spotlight works, so the title keeps its room), ■ Stop while a test runs (while a reply streams, Stop is in the box, and only there unless the panel is folded), ✎ New conversation and the fold button.
- **Timeline.** Your messages, and Spotlight's replies as rows: each test run, one line each, *Run 3 · “Post to Slack” · No Bearer Auth credential selected* (the error's first clause; **Show more** opens the rest, which often says what to do; `runRow`), numbered on through the conversation rather than from 1 in each session (`nextRound`); a failed run is a button that opens the node it failed at; each change it applied, titled by what its ops did rather than the model's words (*Fixed · Set channel on “Post to Slack”*, `opsTitle` in `lib/shared/assistant-ops.ts`; the model's sentence and the diff open on a click; *(1 part skipped)* when an op no longer fit), with **Undo** on the newest (a phone has no ⌘Z), each **Needs you** row ([Test and fix](#test-and-fix)), each agent it designs (*Agent “Legal Clause Reviewer” published · ollama/qwen3-coder:30b*, with **Open** to its page) after the turn that created it. A reply in a test session, or an autonomous reply that changed the flow, shows its first sentence and **more**. While a change is being built, its steps show in the reply ([Building, step by step](#building-step-by-step)). A finished test session folds to one line, *Tested 2× · 1 fix · passed* (`sessionFold`; *stopped* when an outcome card or **Needs you** follows it, even after a passing run), which opens to its runs and fixes; the session that is running stays open, and what came after it (*Ready for production*, **Needs you**, the outcome card) stays out of the fold.
- **Outcome card.** A session that stops without passing ends in a card: *Stopped ·* why, in one line, then **Open “X”** (the node it stopped at), **Undo all fixes** (shown while the session's fixes are still applied and nothing changed since: no edit, ⌘Z or later Spotlight change; it puts the flow back as it was before the session, and ⌘Z brings the fixes back) and **Try again**.
- **What you see while Spotlight works** (`ReplyView` in `components/editor/spotlight/reply.tsx`). The *Working* line (or, while a trace or the build's steps are on screen, an empty line in its place) stays mounted for the whole live reply, also in the builder chat, and cross-fades to the reply's words when the first ones arrive (`swapState` in `spotlight/swap.ts`) (a fade of 160 ms, none under Reduce motion), and they stream in with a soft caret (`StreamingText`); the words are provisional, and the checked text replaces them at the end. Above them is one **activity trace**: one line with the step it is on (*Reading your request · step 1*) while it works; once done, *12 steps · 30.2 s ›*, closed on desktop and phone, which opens to timed rows with a tick or cross each (what it searched, read, wrote or thought: the model's thinking aloud goes there, never into the reply). While a change is built, the stream's rows keep their times and the plan's changes are added to them (`mergeTrace`); the change rows carry no time, and they leave the trace's count when the build ends, so the count can drop on Apply. Model-call rows read *Thinking*. The finished reply is its first two sentences and **Show more** (one sentence in a test session). Under it, the footer: *ollama/qwen3-coder:30b · 6.2 s · 2 steps · 8,887 tokens · local* (or *≈$0.004* for a paid model). The turn keeps `steps`, `text`, `thinking` and `meta` in the store (`applyStreamEvent` in `components/editor/assistant.ts` reads the chat stream); a reply that failed keeps its `checkpoint` (`lastCheckpoint`) so it can be continued from the step it stopped at (the buttons come later). The timeline is the kit's `ChatList`: it stays at the bottom while a reply grows, and **Jump to latest** shows when you scrolled up.
- **Box.** At the bottom of the panel, with the bubbles above it, on the kit's `ChatComposer`. The selected node's chip sits above the text, with the **model chip** (the short name of the model that answered last, *local* after it) at its right; there is no chip before the first reply, because no route tells the page which model will answer.
- **One chip per node.** Above a node Spotlight works on, one chip in the panel's words: *Fixing…* and *Designing its agent…* (violet), *Needs you* (amber), or what the last fix did. It shows whether or not the node is selected (Spotlight's own changes don't select what they add).
- **Fix bubbles.** When a fix is applied, a bubble above one node says what it changed (*Fixed · Set channel on “Post to Slack”*), and only the newest fix has one; a new session clears it: the node the fix was asked for (where the spinner was) when the fix touched it, else the first node it changed. One bubble per fix, so a small canvas isn't covered. It closes with ×, or by itself after a minute (`noteFix`, `dismissFix` and `fixedNodes` in `components/editor/assistant.ts`; `FixNote` in `components/editor/flow-node.tsx`).
- **Quiet.** A run Spotlight started is a row of its timeline, not a toast: its run command carries `by: 'spotlight'`, and a run followed from the server after the stream dropped is matched by its execution id (`ownRun`, `spotlightOwnsRun`), so a run that ends after the session asked the person still makes no toast. An autonomous apply makes no toast either. Once a session's fix is applied, the reply's prose folds into the fix row. A new **Needs you** replaces an open one, so only one waits at a time, and undoing a fix takes its bubble off the canvas. Other toasts sit left of the column on a desktop and above the sheet on a phone.
- **In view.** While Spotlight drafts or tests, the canvas fits the whole flow again when it grows or the canvas changes size, until you zoom or pan. Once it is on one node (fixing it, or a **Needs you** about it), the camera goes to that node instead, rather than shrinking the whole flow: on a phone it centres it at 85% or more; on a desktop it moves only when the node is out of the clear part of the canvas (under the minimap, the toolbar or the Execute bar) or below 75%, and then pans rather than zooms. A new session fits the flow again even while an older **Needs you** is open. A drafted flow's nodes fade in left to right. On a phone the Execute bar steps aside while Spotlight drafts or tests, the **Autonomous** switch is its icon, there is no ⌘I hint, and the Undo toast of a change you applied lasts 5 seconds (15 on a desktop) so it leaves the run bar sooner. The box says *Ask or describe a change* on both; the empty panel says that @ points at a node. The timeline follows new rows only when you are at its end, and stays there when its content grows (a card opening, a reply streaming); it does not re-pin when the scroll area itself shrinks (the bubbles row appearing, a dock height), see [limitations](limitations.md).
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

**Empty canvas.** The first message on an empty canvas drafts the whole flow in one go with the flow builder (`/api/ai/build`), lays it out and pins test data on the trigger (an app trigger gets it on itself; a schedule whose next step is an app step that reads data, like Get all, gets it on that step so a test runs on sample records; any other schedule flow gets none, since a schedule's item is only a time). A draft's empty lists are filled by a second ask before it arrives, and what is still empty is listed with the draft. One ⌘Z undoes it. While it drafts, the canvas shows a placeholder instead of the templates. The message becomes the workflow's description (when it has none), and the reply ends with **Test and fix**. Later messages go to the builder chat. The draft is guarded as the chat guards a proposal (`lib/server/assistant/draft-guards.ts`): a channel, table, owner, address, id or URL host nobody gave is cleared, a second trigger is dropped (the one the message names stays, else the first), an empty Set nothing reads is removed, and each step that needs a credential is listed (the person picks it; a draft never holds one). The reply's "Left for you:" line names the first three of these and how many more. The build takes the workflow's id, so a node type its policy blocks is neither offered to the model nor kept (the same filter as the chat). A build without a workflow id goes through the same filter, so the instance-level node policy now applies to it too. A credential is listed only when its slot is required and shown for the step's parameters (an AI Agent step needs none unless it asks for approval in Slack), and a URL is judged by its literal host even when an expression follows it.

**Dictation.** The microphone button beside Send records (up to two minutes; click again to stop), posts the clip to `POST /api/assistant/transcribe` and appends the text to the box. Nothing is sent by voice alone: the text is yours to edit, then Enter, and any change still waits for Apply on its plan card. The button shows only where the browser can record (`getUserMedia`, `MediaRecorder`; needs https or localhost) and the person has not denied the microphone. Speech-to-text is an OpenAI-compatible `/audio/transcriptions` server the operator sets with `LANDFLOW_STT_URL` (default `http://127.0.0.1:8000/v1`, e.g. a local faster-whisper or whisper.cpp server, so audio stays on the machine), `LANDFLOW_STT_MODEL` (`whisper-1`) and `LANDFLOW_STT_API_KEY`. Without a server the button reports why. To run one locally: `docker --context orbstack run -d --name landflow-stt -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu`, download a model once with `curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small`, and set `LANDFLOW_STT_MODEL=Systran/faster-whisper-small` (this server wants the full model id, not `whisper-1`). Code: `lib/server/assistant/transcribe.ts`, `components/editor/use-dictation.ts`. Spoken replies and a hands-free mode are not built.

### The builder chat

**A change means what its card says.** Before a proposal is shown (`lib/server/assistant/change-checks.ts`, run on every proposal, inside or outside a scope), it is sent back once with one line per problem, then shown with the lines on the card: retry settings out of range or hidden failures nobody asked for (`retryProblems`); an expression that reads a `$json.<field>` (or `$('Step').item.json.<field>`) the step's input does not have, by the upstream step's last run sample, its pinned data and its output schema (`expressionMisses`; a source with no run, no pin and no schema is not checked); a schedule that does not parse, or that limits the days when the request named none ("every morning" as Mon-Fri; `cronProblems`); an Authorization header built from the data, which is a credential the person picks (`authHeaderProblems`). A credential with a hand-written Authorization header is a caution on the card (the header wins at run time).

**A question is answered, not applied.** What you type is read as a question or a change by fixed rules (`askKind` in `lib/shared/ask-kind.ts`, the same on the server and in the browser): an imperative (*fix*, *remove*, *make it retry 3 times*), *it should…* or *make sure…* is a change; *why*, *what*, *how*, *is*, a question mark or *explain* is a question; a message with both (*why did it fail? fix it*), an empty one and an unclear one are changes, so a request is never dropped. For a question the model is not offered `propose_changes` (a call it writes as text is answered *Not offered: this is a question.* and shows no card), it is told to answer from the workflow and the run data in at most two sentences naming the cause, and a message sent as autonomous is not applied. After the answer to a question about something that went wrong (its words say *fail*, *error*, *broke*, *wrong*, *stuck*, *not work*, a 40x or 50x), a **Fix it** bubble sends *Fix it: <the answer's first sentence>* as a change. A test-and-fix session's own messages are never questions. A request misread as a question outside that gets no bubble: retype it as a change. Tests: `test/ask-kind.test.ts`, `test/ask-question.test.ts`, `test/answered-question.test.ts`.

**Scope: one step means one step.** A request about particular steps may change only those (`lib/shared/spotlight-scope.ts`, the same rules in the browser and on the server). The scope is, in order: nothing when you lifted the chip; the steps named with "only" or "just" (`only Open status incident: retry 3 times`), or the selected step for "only that one node", "just this step", "nothing else" (**only**); the steps you tagged with @ (**tagged**); where a new step goes (`add an agent after “Sample PR”`: **insert**, new steps go there and existing ones stay as they are); else the selected step when the message names no other step and adds none (**selected**). A message that names another step besides the one a new step goes beside has no scope. The composer shows the scope above the box as a chip, **Only “Open status incident”** or **New step after “Sample PR”**, in the selection chip's place when the scope is the selection (otherwise both chips show); its × lifts the scope for this message (the chip disappears and the request carries `scope: null`, so any step may change, as before; it comes back with an empty box or another selection). Spotlight tells the model the scope in its prompt, and `propose_changes` checks every proposal against it (`outsideScope`): a change to a step outside it, a new step placed elsewhere, a rewire between other steps or a workflow setting goes back once ("Not shown: … change only that, then propose again"); if the next proposal still reaches outside, those changes are left out, the rest is shown, and each left-out change is listed on the card as **Left out: …**; a proposal with nothing left says so in a sentence. A new step is read from an adding word (add, insert, then, send, email, notify, post, filter, use a, follow with, next …) or from "after" / "before" a named step or "this" ("remove duplicates after Code" puts the new step after Code; but "the step after Code fails with 401, fix it" and "it breaks right after this" only locate a step, so they keep the selected-step scope); a next step asked in other words, with a step selected, stays held to that step: lift the chip. A new step beside a scope step may take over the step it fed. When the composer shows no chip it sends `scope: null`, so the server never applies a scope you did not see. A Test and fix session (`fix` or `review`) has no scope: its own rules apply ([test-and-fix](#test-and-fix)); a message you type in autonomous mode has one. A caller of the API that sends no `scope` gets the one derived from the message, the selection and the tags.

**Asking when it is not clear (`ask_user`).** When several steps could be the one a request means and it names none (*it should retry 3 times* with nothing selected and two HTTP steps), or a value only you know is missing and has no default (the channel of *post the summary to Slack*, a table, an id, a recipient), Spotlight asks one question with 2 to 4 short choices instead of guessing. The reply ends with the question: a row with one chip per choice and the hint *or type your own answer*. A chip is sent as your next message, typed by you (never an autonomous message, no session), so the scope and question rules read it like any typed message; the picked chip stays marked and the others dim. It never asks what `search_nodes`, `get_workflow` or `get_run_data` can answer, never together with a change in the same step, and never for a credential (that is a picker, not a question). Not offered in a test-and-fix session, which asks through its own *Needs you* rows. As a backstop, a change to one of several steps of a kind, with no step named or selected, is sent back once with *Several steps fit (A, B): ask_user which one*. An answer asked in this way needs no switch: asking changes nothing. A second backstop covers a channel, table or recipient nobody gave: when a typed proposal's made-up destination would be cleared (see the made-up-values guard), it is sent back once with *The request does not say which: ask_user for it with 2 to 4 likely choices*, or the model may propose again without it. It applies to typed requests only (also under Autonomous), never in a test-and-fix session, and only to destinations: not to ids, and not to a URL host nobody gave, which is still cleared and listed on the card. The question costs one model call and no more. Code: `ask_user` in `lib/server/assistant/chat.ts`, the shapes in `lib/shared/spotlight-wire.ts`, the row (`AskRow`) in `components/editor/spotlight/reply.tsx`.

**Goals.** When the workflow lives in a project, the model also gets that project's compact "Where this work fits" block (goal chain, brief) as one more system entry marked as background data, not instruction; a workflow in no project gets nothing. The [Agent architect](agents.md#agent-architect) gets the same for the project named in its request (`projectId`; the route answers 404 when you have no role in it). See [projects-and-goals.md](projects-and-goals.md#repositories-and-harnesses).

**What the model reads about the steps it edits.** The selected step, and every step in the change's scope (the steps tagged,
named with "only", or the one a new step goes after), come with their parameters whole (a string up to 8 000 characters,
all of them up to 12 000, then "… (N more characters)"), their settings (`retryOnFail`, `maxTries`, `waitBetweenTriesMs`,
`retryBackoff`, `onError`, `timeoutSeconds`, `executeOnce`, `alwaysOutputData`, `disabled`: only those set, else
"defaults") and each credential slot the step shows for its parameters: `httpHeaderAuth: set (“Echo token”)` or
`httpHeaderAuth: not set`, names only, never an id or a value. In the outline those steps keep 2 000 characters of
parameters and the others 300, so a one-line change to a long Code step is written back whole (finding 2.8). A node's docs
list the output fields of the operation its parameters select (`resource` and `operation`: Linear issue → create names
`url`, `identifier`), then of the node as a whole.

Each message sends the conversation so far, the current workflow (`toWorkflow()`, saved or not), the selected node and a digest of every node's last main run. Proposals from earlier replies that are still waiting (neither applied nor dismissed) go with it as `pending` (summary and ops, at most 20; the route validates the shape and the server checks the ops against the workflow). The server runs a tool-calling loop per message. It goes on while a step makes progress (a new proposal, or a tool result not seen before in this reply), up to **20 model calls** (`MAX_STEPS`), and stops early, with a note that the last steps only repeated, when two steps in a row add nothing. Only the ceiling gives "Stopped after 20 steps":

| Tool | What it returns | Activity line |
|---|---|---|
| `search_nodes(query)` | Keyword matches over display names, type ids, keywords, categories, plugin names and descriptions | Searched nodes for "sheets" |
| `get_node_docs(type)` | The type's ports, credentials and parameters (accepts a node name too) | Read Google Sheets docs |
| `get_workflow()` | The outline, including pending changes (marked `[pending: proposed, not applied yet]`, with a list of the pending proposals); a node with two or more main outputs lists each output, its name and what it feeds | Read the workflow |
| `get_run_data(node)` | The node's parameters, neighbours, run status, error and first items | Read run data of "Code" |
| `propose_changes(summary, ops)` | Validates the ops and shows them as a proposal card | Proposed 2 changes |

#### The stream

The route streams with `trace` on. What each step sends, and where it goes in Spotlight:

| Event | Fields | Goes in |
|---|---|---|
| `step.start` | `step`, `label` | the trace: a model call begins |
| `text.delta` | `step`, `text` | provisional text, as tokens come (at most one event per 50 ms); the step's `text` replaces it |
| `thinking` | `step`, `text` | the trace, never the reply: the text of a step that also called tools, or that was sent back, after the guards |
| `text` | `text`, `step` | the reply: the checked text of the last step (empty when the guards left nothing, so the deltas clear) |
| `tool` | `id`, `step`, `name`, `label`, `ok`, `durationMs`, `detail?` | the trace: one line per tool call, timed; `detail` (300 characters at most) is the query, a count or what was read, never a result body |
| `proposal` | as before | a card |
| `done` | `model`, `durationMs`, `steps`, `usage`, `costUsd?`, `local` | the end: `costUsd` is what the reply's model calls cost (absent when nothing was priced), `local` is true for an Ollama model |
| `error` | `message`, `kind`, `checkpoint?`, `step?` | the end: `kind` is `model`, `cap` (a usage cap was reached), `stalled` (the last steps only repeated) or `internal` |

Only the last step's text is the reply: narration a model writes before a tool call arrives as `thinking`. A caller that does not ask for the trace (`runChat` without `trace`) gets the older events, `text` for every step and errors thrown.

**Continuing after an error.** When a model call fails, or the reply stalls, after at least one tool step, the `error` event carries a `checkpoint` (the messages so far with the tool results, and the proposals sent) and the `step` a resume runs next: the step that failed, or after a stall the step after the last one that ran (so *Continue from step N* is right for both). Send the same request with `resume: { checkpoint }` and the chat goes on from that step: nothing already done runs again, the step count continues, and a stalled reply gets a fresh budget of 20 steps. A checkpoint is used once, belongs to the user who made it and lives in the host's memory for 15 minutes (200 at most, the oldest dropped). An unknown, expired or another user's checkpoint answers 409 `checkpoint_expired`. A `cap` error carries none: it would stop again. Details a client should know:

- A checkpoint is tagged with its surface: a Spotlight checkpoint sent to the architect route (or the reverse) answers 409 too. Each user keeps at most 10; past that their own oldest goes, so one user's stalls never evict another's.
- It keeps the messages and the proposals the failed reply had sent, which the resume replays. The client must therefore leave those cards out of `pending` when it resumes (listing them would hold them twice). It does not keep the once-only nudges (a fix sent back once, a card announced and never made, a press to propose); a resumed reply may send each once more.
- No checkpoint is kept when the history ends on a user message (a failure right after a "press" or "apply" prompt), nor when no tool step finished.
- With `trace`, a stall or an error ends the stream with `error` and no `done`: the reply's usage and cost are in AI usage, not in the stream.
- **Provisional text.** `text.delta`s of a step are provisional. A step that continues sends its checked text as `thinking`; if the guards leave nothing of it, it sends nothing, so a client must drop a step's provisional deltas at the next `tool` or `step.start`. The last step's checked text, or an empty `text`, replaces its deltas. Deltas are the model's raw tokens, so a local model's tool-call markup (`<tool_call>`, `<function=…>`) and `<think>` text arrive in them: Spotlight and Ask the brain show provisional words through `provisionalText` (`lib/shared/leaked-markup.ts`), which removes that markup and holds back half a tag still arriving.

**AI usage.** Spotlight's and the architect's model calls count like any other: each writes an `ai_usage` row with `surface` (`spotlight`, `architect`, and `brain` for Ask the brain) and the caller's id. A Spotlight row carries the workflow (`workflowId`, or the body's `workflow.id`) only when the caller can read it (`meteredWorkflowId`); otherwise, and for the architect, it carries none, and a row with no workflow is visible to owners and admins only. The calls show in Insights' AI usage totals, and the caller's per-user caps (Settings → AI caps) apply: a reached cap ends the reply with `error { kind: 'cap' }` and the cap's message. A workflow's own per-day caps and alerts count its runs only (`workflowDay` skips rows with a surface), so chatting about a workflow never makes its runs fail on a cap, while Insights' per-workflow figures include the surface rows. A reply that ends in an `error` event still counts as `error` in `landflow.assistant.requests`, and its span records the exception and `landflow.error.kind`.

Before showing a proposal, `propose_changes` makes these checks. A change it sends back to the model shows as one neutral step, *Reworked the change* (the model still gets it as an error, with the reason), not as a failure the person has to read:
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

More guards cover what local models get wrong (all in `lib/server/assistant/guards.ts`, re-exported by `chat.ts`):
- **Made-up values**: a parameter named like an id (`channelId`, `sheetId`, `id`…) or like a destination (`channel`, `table`, `owner`, `repo`, `email`, `to`, `cc`, `team`, `project`, `board`, `sheet`, or a `url`) whose value appears nowhere in the conversation, the workflow, its run data or the node type's own options is left out of the proposal, and the card lists it as left for the user to fill in. A plain word (`bugs`) counts as given only after a naming cue (the kind of thing: "table bugs"; "called", "named", "into", "in", "to", "on", "at", "by", "with", "as") or in quotes, since it is in most asks (not after "for" or "from": "a summary for the team" names no channel); the word for the kind (`channel`, `table`…) and the app's own name (`channel: 'slack'` for "post it to Slack") are never a name; a value with `#`, `@`, `.`, `/`, `_`, `-` or a digit counts when the text holds it. A URL is judged by its host as `new URL` reads it: another path on a host somebody gave is kept, a host nobody gave (`httpbin.org`) is left out, and so are `https://evil.com#@good.com/x` and `https://evil.com?@good.com/x` (their host is evil.com), a URL with a backslash or one that does not parse (an address that cannot be read), `https://evil.com:{{ $json.port }}/x` (a port expression is judged by the host before it), and a literal host followed straight by an expression (`https://good.com{{ '.evil.com' }}`, `https://evil.com{{ $json.path }}`: the host may be anything). An expression that is the whole host, one in the user name, or one that cuts the host short (`api.{{ env }}.com`) is kept. A destination with an expression in its host reads "evil.com{{ … }}" in the Needs-you row, the literal start shown. The first draft gets the same guard (below). The prompt also says not to invent ids, channels, addresses, URLs or keys.
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

A `newAgent` can say what the agent needs: `tools` (at most 8 apps or actions, such as "Linear: read issues") and `knowledge` (the documents it answers from). They reach the Agent architect's request ("It needs: …", "It answers from: …: give it a knowledge base"), which ranks the nodes matching the tool hints first. When the request says "after <a step>" the agent is placed after it, not before, and in front of the one step that step feeds, so its answer reaches on (`placedAsAsked`, for a `before` the message does not ask for and for an `after` written alone; a request that says "before" keeps `before`; the note "placed … as asked" reaches the model in its own sentence, not in "Left out"). A new agent's name counts as proposed (so that an AI Agent named after it is a stand-in and left out) only once its proposal is held: a proposal sent back to be completed leaves it unrecorded, so the second try is not dropped. A tool-call parse error from Ollama is retried once with the same request (`withParseRetry`; the span event `assistant.retry` carries the error's message and description, cut to 200): it is one whose message or description says "XML syntax error" or "unexpected end", or a bare "Ollama error 500" with no detail. A 500 that says what it was ("out of memory"), an abort and a usage cap are not retried.

A new AI Agent step the chat proposes that wouldn't run here, with no chat model attached (so OpenAI's) or a hosted one, becomes a `newAgent` with its name, its system message as the instructions and its prompt as the message (`asNewAgents`); the chat model attached to it goes, its tool nodes' names become the new agent's `tools`, and the model is told why. One with an Ollama chat model stays a small inline step.

Ids are checked like team ids: a name written where `agentId` goes becomes the id of the one published agent with that name (`withAgentId`, with or without "agent"); the builder clears an id no agent has, so the node asks for one, and the chat leaves it out as made up. A `newAgent` never carries an `agentId`. Its node runs the agent with the agent's own model and instructions, so the prompt says to attach nothing to it; a local model that then adds an AI Agent named after the new agent ("Legal Clause Reviewer 2"), or a chat model or tool for its node, has those left out, with the connections that use them, and is told why (`withoutAgentStandIns`, in the same reply or while the newAgent is pending). With no published agents the chat's prompt says *Your agents: none published yet.*, and `get_node_docs("core.messageAgent")` lists them (or says to propose a `newAgent`). Tests: `test/spotlight-agents.test.ts`, `test/flow-builder.test.ts` (AI builder agents).

### Fold, Apply and errors

What the panel does between states (the rules for the states themselves are in [The Spotlight panel](#the-spotlight-panel); the pure parts are in `components/editor/spotlight/states.ts`, tested in `test/spotlight-states.test.ts`):

- **Folded by default.** A first visit opens Spotlight folded: a strip on a desktop, the bar on a phone. Your last choice per browser is kept (`landflow-spotlight-collapsed`).
- **Fold motion.** The desktop column eases its width (240 ms) and its content cross-fades; when it stops, the canvas fits the flow again once. On a phone the sheet's three heights (the bar as measured, peek and half) ease over 240 ms; the sheet follows the header drag and settles on the nearest height. Under Reduce motion nothing moves and the canvas fits at once.
- **Apply and Undo.** Apply folds the proposal card (200 ms) into its one-line row with a tick, while the dashed ghosts on the canvas fade out as the real nodes appear in the same places. Undo opens the row again; the ghosts come back for a moment, then fade out. The row has the **Undo**.
- **Errors with actions.** A reply that failed after some steps offers **Continue from step N** (the chat route's `resume` with the checkpoint) and **Try again**; a usage cap offers **Open AI caps** to admins (it opens Settings at its own `#ai-caps` section), else only its text; a stalled reply offers **Try again**. A run that failed at a node in a test-and-fix has **Open the node** and **Ask Spotlight to fix it**, which puts *Fix <node>: <error>* in the box.
- **What Apply changes.** A change waiting for Apply shows a diff, open by default, read from its ops and the canvas (`diffOps` in `lib/shared/assistant-ops.ts`, drawn by `components/editor/change-diff.tsx`): one block per touched step (+ added, ~ changed, − removed, ✎ renamed), each parameter named as the node panel names it, each setting (*Retry on fail: off → on*, *Max tries: default → 3*), credential name and wire, with the old value struck through and the new one plain, and a last line *N other steps untouched*. A value over 120 characters or with a line break shows two lines and **Show all**, which opens the old and the new text whole (monospace, at most 240 px tall, scrolling inside). The header folds the block. Once the change is applied its row keeps the diff the card showed, folded; a change Spotlight applied alone (a new draft) has no waiting card, so its row keeps the one-line list. The after-run suggestions card uses the same diff.
- **Empty panel.** One line, *Describe a flow, or ask about this one*; the suggestion bubbles above the composer are its starters (the panel adds no chips of its own).
- **Phone bar.** With a change waiting, the folded bar shows the amber needs-you icon, **Review** (opens the sheet to the proposal) and **Apply** (44 px).

### Building, step by step

A change Spotlight builds in the builder chat is watched taking shape instead of read afterwards. While the reply is going, and while a proposal waits for Apply, the reply in the [panel](#the-spotlight-panel) lists the steps and the canvas, beside it, shows them:

- **Steps you can follow.** While the reply works it shows one live line, the step it is on (*Searched nodes for “slack” · step 3*); once the change is whole it is *N steps · T s ›*, closed on a desktop and a phone alike, and Apply, Dismiss and the warnings stay visible under it. It opens to rows with a tick or cross each. Tool calls are the first rows, as they stream, with their times (*Read the workflow · 4 nodes*, *Searched nodes for “slack”*); the proposal's ops add the rest, one row per added node (*Add Ask for approval · If · after Code*), one for consecutive connections (*Wire 3 connections*), and one per parameter edit, rename, removal, team and settings change (`mergeTrace` in `lib/shared/build-steps.ts` joins the two; the plan's own read rows are left out, the stream's already say it). `buildSteps()` and `planOf()` in the same file derive the plan, pure and unit-tested (`test/build-steps.test.ts`); `planOf()` runs the ops through `applyOps()`, so a step only exists for an op that would apply. A proposal arrives whole, not as a stream, so the editor ticks its steps off one by one on a short timer (about half a second each): the steps and ghosts show the plan taking shape, not the model's progress. The trace counts rows; the footer counts model calls, so the two numbers can differ.
- **The canvas fills in.** The nodes the plan adds appear as dashed ghosts at the positions `applyOps()` gives them (after their source node), each when its step is reached; the one being made shimmers, and new connections are drawn as dashed violet lines when their step is reached. Ghosts are extra nodes and edges handed to React Flow beside the real ones (`GhostNodeView`, `GhostEdgeView` in `components/editor/building.tsx`); they are not in the editor's store, are not selectable or draggable and are never saved. A thin bar on top of the canvas shows how far the plan is (done steps over all; it never reaches the end while the assistant is still working). A ghost that lands outside the view (a node added after the last one is often past the right edge) brings the whole flow and its ghosts into view, without zooming in (`KeepGhostsInView` in `components/editor/editor.tsx`).
- **Still a plan.** With autonomous mode off, nothing in the workflow changes until **Apply** under the steps (the same `applyChanges()` path, one Undo in the toast; **Dismiss** drops the plan and the ghosts). A message sent while the reply is still going stops it first, so the follow-up redirects it. With autonomous mode on, the plan is applied when the reply ends.

The Agent architect (a dialog with a draft preview, not a canvas) does not show steps this way yet.

### Test and fix

**Test and fix** (`components/editor/test-session.ts`) runs the workflow and, while a run doesn't pass, has the assistant fix it and runs it again. It starts by itself in [autonomous mode](#autonomous-mode) (on by default); otherwise from the button at the end of an empty-canvas draft, or from the *Test it and fix what fails* bubble on any workflow with a trigger. Starting it is your go-ahead for the fixes: each is applied as it comes, with its own Undo. ■ in the panel's header ends the session; a run already going finishes.

**Needs you.** Before the first run, and after any failed one, Spotlight checks for what only a person can do, and asks instead of spending a fix. The row has the button that does it and **Test again**; the header says *Needs you: …*, and the node shows an amber *Needs you* chip:
- **No trigger**: *Nothing starts this flow yet*, with **Add a manual trigger** (one op).
- **No agent or team picked** on a Run an Agent or Run a Team step Spotlight isn't designing: **Pick an agent** opens the node.
- **A credential**: an error that says a credential isn't selected, or a refusal (401, 403, `invalid_auth`, an API key): **Pick the credential** opens the node (`needsPerson` in `lib/shared/run-check.ts`).
- **Sending for real**: a flow with a step that sends or changes things outside it (an HTTP call that isn't a GET, an operation that sends, posts, creates, updates or deletes, an email step; `sendingSteps`) asks before the first run: *A test runs “Notify VIP” for real: it sends to 127.0.0.1:3399*, **Run it for real** or **Not now**. The yes is kept per workflow **and destination** while the page is open (`destinationsOf`: an HTTP step's `host:port`, an app step's type and operation; an expression host, or a URL with a backslash or that does not parse, is `{{ … }}`: its yes is per step and covers the one run that follows it, as the step's URL was shown; it is never kept, and a step added later, a changed expression or a step deleted and added back asks on its own), and it is checked before **every** run of a session, the first too, after the session's agents are settled (a URL that changed meanwhile asks). A user-name expression (`https://{{ $json.u }}@good.com/x`) shows its host but asks every run, since a value with `/`, `?`, `#` or `@` moves the host; an `@` inside `{{ }}` makes the host unreadable. After a yes on such a row the card says it covers the next run only. A destination a fix brought in, or one you never approved, stops the session before the run: *“Notify VIP” now sends to api.example.net, which you haven't approved.*, with **Run it for real** and **Undo that change** (it takes back the last applied fix). A step whose URL is empty is no destination: the row says *“Notify VIP” sends to an address not filled in yet: open the step and fill it in*, with **Open the step**, before any run. While a fix waits for Apply the panel's title says *Needs you: apply the fix?*, not *Testing the flow*. This holds in autonomous mode too. A heuristic: it reads the method and the operation's name.
- **Blocked by the host**: a run that failed because the host's outbound policy refused the destination (the error starts `Blocked:`, or is an `OutboundBlockedError`; read before the credential rules, since the policy answers 403) is the person's or an admin's to resolve: *This host blocks “Notify VIP” from reaching localhost:3399. An admin can allow it (LANDFLOW_OUTBOUND_ALLOW), or change the address yourself.* with **Open the step**. The session ends and asks for no fix; the chat's session prompt says the same (`PERSON_ONLY` also holds `blocked`, `outbound`, `not allowed to reach`).

**What a session never changes.** A fix that would remove a step the goal, the description or your messages name, or change a URL, email address, channel or id you gave, is not applied. The session ends with a card saying what it wanted and why it was kept from it (*The fix wanted to remove “Notify VIP”, which you asked for. I kept it.*). The client checks every proposal (`givenKept` in `lib/shared/run-check.ts`); the chat route checks too, once per reply (`givenValuesKept` in `lib/server/assistant/guards.ts`) and tells the model only the person can change it (*Kept what the person gave*). A session that ends with steps removed that the flow had when it started never shows **Ready for production**: the card names them.

**Asks-first sessions.** `testUntilItRuns(goal, { autonomy })` takes the autonomy of the workflow (`autonomyOf`, `spotlight-autonomy.ts`: autonomous only on a brand-new draft that was never published, see [Autonomous mode](#autonomous-mode)). On any other workflow, and, even on a new draft, for a fix that removes a step, turns one off or leaves one without its input (`needsAClick`, with *Waits for you: removes “X”* or *turns off “X”* on the card), the session shows the fix as a change card and waits: **Apply** runs again, **Dismiss** or ■ ends it (*You kept the flow as it was.*). Publishing from Spotlight ends autonomy for that workflow (`notePublished`). The session's request carries `autonomy` (`auto` or `asks-first`; the route defaults to `asks-first`), and the assistant's prompt and the result of its `propose_changes` call say what follows: under `asks-first` the proposal is a card that waits for Apply, never "applied by itself".

**Wasted rounds.** The same failure after a fix (`sameFailure`: numbers and ids aside) undoes that fix and stops. A fix that touches neither the failing step nor what feeds it, removes a node and adds the same kind back, or only adds a No Operation step is sent back to the model once (`wastedFix` in `lib/server/assistant/chat.ts`). A passing run is reviewed against the goal, and again after any fix since the last review; with no goal there is nothing to review against, so a pass after fixes shows the publish card (the removed or turned-off steps check still applies). The review must start with "Yes" to show the publish card, and a "no" without a change says so instead.

Each round:
1. Runs the workflow, as Execute workflow does, and adds a line: *Test run 2 · failed at “Join Titles”: No fields to aggregate*, or *no errors: 4 steps, 1 item reached “Join Titles”*.
2. Judges the run (`checkRun`, `lib/shared/run-check.ts`). A run passes when the execution succeeded, no node failed, and items reached the end of a branch. A run where every branch ended with no items stopped somewhere, which is more often a bug than not, so it doesn't pass.
3. Looks for steps that run but don't do the job. Some do nothing (`hollowSteps`): an If or Filter without conditions (it keeps every item), a Set in manual mode with no fields. Some repeat every result (`multipliedSteps`): a Code node in "each" mode that put out several items for each one it got (10 in, 100 out), because its code handled all the items each time. Drafted flows often have both.
4. When the run failed or a step is hollow, asks the assistant for a fix: what failed, the fixes already tried, and the node it happened at as the selected node. The request is a fresh conversation (the run data is in the context) with `session: "fix"`.
5. When the run passed and the workflow has a goal (its description: an empty-canvas draft sets it to your message), asks whether the result does what was asked (`session: "review"`); a pass that followed any fix is reviewed again, so **Ready for production** comes only after a review that says yes. The request carries what the last step put out (its first items), so the assistant compares that with each part of the goal, then fixes what doesn't match or says that it does.
6. Applies what the assistant proposed (asks-first workflows, and a change that removes or turns off a step, wait for the person's Apply or Dismiss; a New conversation or another workflow ends the wait silently) and goes round again, up to **4 fixes**.

With `session` set, the chat route tells the model that Spotlight applies the proposal and runs again by itself, drops "click Apply", "run it again" and lines that are only a JSON object (a tool call written as text) from the reply, and sends a fix request that proposed nothing back to the model once.

It stops when:
- a run passes and the review has nothing to change (a pass after a fix is reviewed once more): **Ready for production**;
- 4 fixes are spent and the run still fails: Spotlight says so and names the node whose panel shows what happened;
- a run can't be judged: the trigger waits for a test event (pin test data on it or send one), the run waits (a Wait node, a form or an approval), or it was canceled. A drafted flow seldom waits: the builder pins its test items on a Manual, Webhook or Form trigger (with a Webhook, each item is what a call brings, `{"body": {…}}`), and when the model gave none that carry the fields the steps read, it pins one made-up item with those fields (`sampleItems`: `$json.ticketDescription` → `"Sample ticket description"`, `$json.body.x` under `body`);
- the assistant has no fix for a failed run (*I can’t fix “X” myself: …*), or its fix no longer fits the canvas (*The canvas changed while I worked…*);
- the same failure comes back after a fix (*The last fix didn’t change the error at “X”, so I undid it and stopped.*);
- only the person can go on (**Needs you**, above). The header then says *Needs you: pick a credential*, or *Stopped at “X”* when a session ended on a failure.

**Ready for production.** The card says what publishing does: with a trigger that starts the workflow on its own (a schedule, a webhook, an app trigger), the published version runs from then on; a workflow that only starts by hand is just recorded. **Publish to production** saves the draft if needed and publishes it, or files a publish request when the workflow needs [four-eyes approval](features/audit-and-governance.md). **Not now** leaves it as a draft. Nothing is published without that click.

### Autonomous mode

The panel's header has a switch, **Asks first | Autonomous** (a `Segmented`; on a desktop it has a row of its own under the header so the title keeps its width, on a phone it is in the header as *Ask* and a bolt). On a desktop the first-run note sits under the switch's row and pushes the conversation down until **Got it**; on a phone it is a card at the bottom of the screen. The first time it shows, a note explains the two, once per browser (`landflow-spotlight-autonomous-explained`). Autonomous is the default; the choice is kept in `landflow-spotlight-autonomous`.

**Only on a brand-new draft** (decision D1, 2026-11-16: "New drafts only"). The switch is your choice, but Spotlight acts alone only while it builds a new draft. That is a workflow this tab opened with no nodes that has never been published (`autonomyOf` in `components/editor/spotlight-autonomy.ts`; the editor notes each workflow it loads, `noteOpened`; one that loads active ends it at once, and one opened empty is also read once for its versions). Everything else, a saved or published workflow, a template, an import or a workflow you reopen after a reload, asks first: Spotlight shows the change as a card with **Apply** and **Dismiss** and waits, and Test and fix waits for a click too. "Saved" means it had nodes when this tab opened it: the autosave of the draft being built does not end autonomy, a reload does, and so does publishing from this tab, by any route (the editor's `active` flag turning on ends it). With the switch on and the workflow saved, a note under the switch says *Spotlight acts alone only while it builds a new draft. This workflow is saved, so it asks first.* (the same line on a phone's switch). Even on a brand-new draft, a change that removes a step, turns one off or leaves one without its input is shown and waits for **Apply**: its card says *Waits for you: removes “Notify VIP”* (with Apply and Dismiss, also while the switch is on); the other changes of the same reply are applied. Tests: `test/spotlight-autonomy.test.ts`.

On by default, Spotlight doesn't wait for clicks (`components/editor/autonomous.ts`):
- **A new flow**: when it drafts a flow on an empty canvas, Test and fix starts right away (the reply says *Testing it now.*), instead of waiting for the **Test and fix** button.
- **A chat request**: when the reply ends, what it proposed is applied as one step (⌘Z undoes it), the cards turn to *applied*, and Test and fix runs with your message as the goal. A reply that proposed nothing, failed or was stopped changes nothing.

**Asking needs no switch.** A question back (`ask_user`, [The builder chat](#the-builder-chat)) changes nothing, so it is asked in either mode, on a saved workflow or a new draft; the answer you tap is an ordinary typed message, so on a saved workflow the change it leads to waits for Apply as any other.

Each fix in the session is applied the same way, as before. An agent Spotlight creates is designed by the Agent architect and **published**, so the flow can run it while it's tested ([Agents and teams](#agents-and-teams)); unpublishing it is one click on its page. **Publish to production** still waits for a person. The **Autonomous** switch in the conversation's header turns it off (kept in the browser, `localStorage` `landflow-spotlight-autonomous`); off, every proposal waits for Apply and a drafted flow for Test and fix. Test runs execute the workflow as Execute workflow does, with the pinned test data, so a step that sends a message or writes to an app would do so for real: before the first such test of a workflow, Spotlight asks (**Run it for real** or **Not now**, [Test and fix](#test-and-fix)). A change that only renames nodes isn't tested; any other is tested against the workflow's description plus your message. Tests: `test/spotlight-autonomous.test.ts`.

## Ask about it

A resource's ⋯ menu and a failed run open the chat about that resource with its chip set and three starter questions.
The contract and the starters are in [spotlight.md](spotlight.md#ask-about-it).

## Tagging with @

Typing `@` (at the start of the box or after a space) opens a list above the box where you pick what the model should
read: a workflow, one of its nodes, a run, an agent, a team, a data table, a template, a node type, a plugin, a brain
page, a person or a credential. A choice turns the `@text` you typed into `@Name` (so the message still reads as a sentence, in the box and in history) and adds a chip you can remove with its ×; the chip is what the server reads.

- **Where it is.** The picker and the search behind it are built and tested ([B04](history.md)). Spotlight uses it
  ([B16](history.md)): the open workflow's nodes are its "On this page" group, the chips sit above the box beside the
  selected-node chip, and a node type chosen from a suggestion still counts as a tag. Ask the brain uses it
  ([B17](history.md)): each tag is a step, `Read @Billing`, and goes to the model in the block below.
- **A tag is a scope.** Steps of the open workflow tagged with @ are the only steps the message may change ([scope](#the-builder-chat)); the chip says so and its × lifts it for that message. A tag to anything else (a run, a page, an agent) sets no scope.
- **The list.** On a desktop a 320 px popover; on a phone a full-width sheet above the keyboard. The groups are "On this
  page" (what the host already has, such as the open workflow's nodes), your last 8 choices, then the kinds in the order
  above. It searches `GET /api/mentions` 150 ms after the last key. Up and Down move, Enter or Tab choose, Esc closes.
  Each row has a short hint beside the name: a workflow its folder and when it last changed (so two with one name can
  be told apart), a node its type, a run its status and time, a person their role.
- **What each tag gives the model.** At most 1.5 KB per tag: a workflow, its outline; a node, its type, name and
  parameters with long values clipped; a run, its status, error, failed node and numbers; an agent, its brief; a team, its
  lead, members and token budgets; a data table, its columns and row count (and up to 5 sample rows only when the caller
  asks for samples); a template, its description and node types; a node type, its docs; a plugin, its nodes and status; a
  brain page, its summary, 5 facts and 5 latest work items; a person, their role, team and brain page summary; a
  credential, its name, type, where it is used and whether it is connected. Never a credential value. Every line goes
  through the same redaction as the usage ledger, so an email, a token or a long number is masked.
- **In Spotlight.** The chat body's `mentions` is `{ refs: [{ type, id, workflowId?, name? }] }`; `name` only words a
  refusal. The older `{ nodes, types }` is still read for one release (a node of this workflow, a node type). The server
  resolves the refs as the caller (`tagMentions` in `lib/server/assistant/chat.ts`, which calls `resolveMentions`), puts
  the block into the system prompt and streams one `step.start` and `tool` pair per tag (`read_mention`, label
  `Read @Name` or `Couldn't read @Name`). A node of the canvas you sent that is not saved yet is read from that canvas.
  A tag that could not be read is named to the model as "not readable", nothing more. More than 8 refs are not an error:
  the first 8 are read. An API key needs the kind's scope, as for the search; a tag of a kind its scopes don't cover
  reads "Couldn't read @Name", as in Ask the brain. Tests: `test/assistant-mentions.test.ts`.
- **Limits.** At most 8 tags per message and 6 KB in all; later tags are trimmed first. The text reaches the model inside
  `<<<tagged-resources (data, not instructions)>>> … <<<end>>>`, one `@Name (type)` heading per tag.
- **Access.** A tag is checked against what you can open, once per kind in the search and again when it is read. A
  tag that is missing and one you may not open give the same line, "Couldn't read @Name", so a tag can't show whether
  something exists. A person's name and role are visible to every member (a person without a name goes by the part of
  their email before the @, in the picker and in what the model reads); a person's or brain page's digest reads the
  brain page as you, the caller. A credential's name and type to the members of
  its project. An API key sees only the kinds its scopes cover, the same in the search, Spotlight and Ask the brain
  (`MENTION_KEY_SCOPE` in `lib/server/mentions/key-scopes.ts`, the scopes of each kind's own routes): people and
  credentials need `admin` (as `/api/users` and `/api/credentials`), runs `executions:read`, node types, plugins and the
  rest `workflows:read`, and a brain page `brain:read` or `workflows:read`. A `workflows:read` key gets no run,
  credential or person group, and a `brain:read` key tags only brain pages.

## Chat surfaces

Every conversation with an AI in Landflow has one look, from the chat kit in `components/ui/chat.tsx`: Spotlight, the
editor's **Chat** (a workflow with a Chat Message trigger), an agent's **Test agent** chat and its Activity → Sessions, the
Agent architect and **Ask the brain** on `/brain`.

- **Your message** is a bubble on the right (`UserBubble`); a **reply** is text beside a small mark (Spotlight's
  sparkle, the agent's icon or avatar; `AssistantRow`), written in Markdown: bold, lists (a model's "•" bullets too),
  inline code, code blocks, links and tables, each line break kept (`ChatMarkdown`). The brain's answers keep their page
  links and numbered sources and read lists, bold and code the same way.
- **Under a finished reply**: what answered and how (model · time · steps or tokens) and **Copy** (`ReplyMeta`). An
  agent's reply keeps its 👍 / 👎 there.
- **The box** (`ChatComposer`): it grows with the text; Enter sends, Shift+Enter adds a line, nothing sends while an
  input method is composing; ↑ sends and, while a reply comes, Stop takes its place (the brain's Stop cancels the
  question). Attach (editor Chat) and the page chip (brain) sit at its left.
- **Working** is one line with a spinner: *Thinking…*, or what it is doing (*Using tools…*, *Reading the pages, facts and
  work…*).
- **An error** (`ChatError`) says what went wrong in words; a provider's raw error (*Ollama error 500: {…}*) reads *The
  model returned an error*, with the raw text under **Details**, and **Try again** sends the same message again.
- **Empty**: a mark, one line, one line of help and up to three starters that fill the box (`ChatEmpty`).

New pieces of the kit, ready to use (the surfaces adopt them one by one):

- **Motion** (`components/ui/chat-motion.tsx`, on `motion`, loaded lazily): `ChatList` scrolls a conversation, rises new
  messages in and stays at the bottom unless you scrolled up, when **Jump to latest** shows (its glide ends on
  `scrollend`, or after a second where a browser has no such event, and a reply that grew meanwhile is scrolled to its new
  bottom at once); `StatusSwap` cross-fades the
  Working line into the reply (its `silent` prop keeps the line empty when a trace already speaks); `Collapsible` opens and closes a block; `StreamingText` adds a soft caret while a reply
  streams. Only opacity and a 6 px rise move, never width or padding, and Reduce motion stops the movement. Use CSS
  (`animate-in`, `animate-pulse-soft`) for a thing that just appears; use these when a block changes size or swaps.
- **The activity trace** (`ActivityTrace`): while it works, one line with the step it is on (*Searching the brain · step
  3*, where the number counts the rows so far, so it never goes down and ends at the closed trace's count); once done, *10 steps · 14.5 s ›*, which opens a list of what it read, searched, ran and wrote, each with its time
  and a tick or a cross. A step with a detail opens it; a failed one reads in red; `traceUrl` adds **Open trace**. On a
  phone it starts closed and the list scrolls inside itself. The steps are `ActivityStep` in `lib/shared/activity.ts`.
- **The reply footer** (`ReplyMeta` with `info`): *model · 14.5 s · 10 steps · 1,600 tokens · ≈$0.004*, with *local* in
  place of the cost for a local model; what is unknown is left out. `parts` still works.
- **The model chip** (`ModelChip`, and the composer's `chip`): the model's short name in a small pill before Send. Spotlight's 360 px column puts it above the text, beside the selected node's chip.
- **Error actions** (`ChatError` `actions`): buttons beside **Try again**, one of them filled (*Open settings*).
- **Short replies** (`ShortReply`, `firstSentences`): the first two sentences and **Show more**.
- **The header**: **New conversation** (✎) and close or fold (*Hide the conversation*); a session's id is in the New
  conversation button's tooltip, not the header. On a phone every button is 44 px, the Test agent chat fills the screen
  above the home bar, the editor's Chat is a sheet with a handle, the Agent architect shows **Chat | Draft** one at a time
  (Draft when one arrives), and the brain's suggestions sit on a card.

## Conversation history

Spotlight, Ask the brain, the Agent architect and an agent's test chat can keep what you said, so leaving a page no
longer loses the conversation. This page describes the store; each chat gets its **history** button (a clock) as it
mounts it.

- **What is kept**: your messages and the assistant's replies, with the steps it took, its proposals (and whether you
  applied or dismissed them), the pages it linked and its sources. **Never kept**: the store takes only those message
  parts, so no attached files and no credentials.
- **Only yours**: a conversation belongs to the person who had it. Nobody else can open it, an owner or an admin
  included: another person's id answers 404. API keys are refused too (the routes need a session). Deleting a person
  deletes their conversations and preferences.
- **A question back comes back as words**: Spotlight's question (`ask_user`) is kept as the reply's text; its chips are not kept, so a reopened conversation shows the question without them and typing the answer works the same.
- **The brain re-checks links**: when you reopen a brain answer, a page you can no longer open loses its link, and the
  reply says how many were left out. Tags (`mentions` parts) are checked the way the @ picker checked them: a brain
  page by its entity, a team as an agent team, a node or a run through its workflow, a person while their account is
  active, and a node type or plugin always. A kept proposal is checked again when it is shown.
- **90 days**: a conversation is deleted, with its messages, 90 days after its last message
  (`LANDFLOW_CHAT_RETENTION_DAYS`; `0` keeps them). The leader checks daily.
- **Delete is real**: **Delete** in the history popover removes the conversation and its messages from the database at
  once. **Rename** edits the title; a new conversation is named after your first message.
- **The switch**: **Keep my conversations** is a personal preference (on by default). With it off nothing is stored and
  the popover says so; chats work as before. Turning it off keeps what is already stored: those conversations stay
  listed and can be deleted one by one.
- **A pin changes nothing yet**: `pinned` is stored, but it does not change the order, the display or retention, so a
  pinned conversation is deleted after 90 days like the rest. Whether a pin should exempt it is open.
- **Spotlight** (B16): one conversation per workflow (`surface: spotlight`, `subjectType: workflow`). A person's message
  is stored when it is sent and the reply when it has finished; it holds the steps (names, status, time), the words and
  each proposal with its state, and the tags chosen (names only). It never holds the digest a tag was read as, a tool
  result or the model's thoughts. A test-and-fix session's own notes are not kept. The route has no way to change a stored
  item, so a proposal's later state (applied, dismissed, undone) is stored as a small marker item that names the proposal
  and replaces its state when the conversation is read back. The kept record (which turns and proposal states are stored, and the conversation) lives in the assistant store beside the chat, so leaving the editor and coming back does not store the turns again. A stale state is recomputed on each visit, never stored. An item is at most 32 KB: when a reply is bigger, its steps
  go first, then the proposals' ops (the proposal is then stored as stale).
  **Resume.** When the editor has loaded a workflow, its last conversation comes back under an "Earlier" divider, dimmed;
  nothing is fetched when you keep nothing or have already started typing. **Stale proposals.** A proposal that was still
  waiting is dry-run against the workflow as it is now (the same `applyOps` the Apply uses): every op must apply and
  something must change, and waiting proposals are checked in order, each on what the one before leaves. If not, its card
  says "This no longer fits the workflow" and has no Apply, and the model is not told of it. The check runs each time the
  conversation is shown. The **history button** (clock) sits beside New conversation and opens the popover for this
  workflow; choosing one replaces the chat with it (not while Spotlight is working); New conversation starts a new one.
  Autonomous mode applies only what the newest reply proposed, never an earlier turn. Tests: `test/spotlight-history.test.ts`.
- **The popover** (`components/ui/conversation-history.tsx`): a search box (titles and your own messages), the
  conversations about this workflow or page, then everywhere. The two groups are separate requests (the subject group
  asks for its `subjectType` and `subjectId`, with the search text), and each pages on its own with **Show more**. A sheet on a phone, with 44 px rows.
  A chat that can only show its own kind of conversation passes `ownSurfaceOnly`, and both groups then ask for its
  `surface` too: the Agent architect does, so it never opens a Spotlight conversation as a design.
- **Ask the brain's conversations** are kept per page (subject type `brainPage`, subject id the page's `<type>/<id>`;
  the index and log have no subject). The panel resumes the page's newest one under **Earlier**, appends each finished
  question and answer (the question's text and a `mentions` part of names, the `answer` with its links and cited
  sources, the `steps`), and sends the last two stored turns as `history`. See [the Brain page](second-brain.md#the-brain-page).
- **The footer comes back**: an assistant item keeps its `meta` (model, time, steps, tokens, cost, and `local` when a
  local model answered), so a reopened reply shows the same footer. A title is clipped to 80 characters by code point,
  so an emoji at the cut is never split.

The routes are `/api/conversations` and `/api/me/preferences` ([reference/api.md](reference/api.md)).

## Edit operations

A card's diff (`diffOps`) applies these same ops with `applyOps` and compares the result with the canvas, so it shows what Apply does, including parameters a change resets, and nothing the ops drop.

Proposals use `lib/shared/assistant-ops.ts`. A node reference is a node **name**, an id, or the `ref` of a node added earlier in the same list.

| Op | Fields | Notes |
|---|---|---|
| `addNode` | `type`, `ref?`, `name?`, `parameters?`, `after?`, `before?`, `output?` | `after`: the new node is wired from that node's `output`. If the new node is a sub-node, it attaches to `after` instead; a node the same ops then `connect` to `after` as a tool (or model, memory) is only that, and the main edge goes. `before`: inserts the node in front of another. Whatever fed that node feeds the new one, and the downstream nodes move one column right. Names are made unique, and defaults are filled in |
| `setParameters` | `node`, `parameters` | Merged one parameter at a time, in declaration order, the way the editor sets them: dependent fields reset and new defaults fill in. A bare `$fromAI` (or the call without braces) becomes `{{ $fromAI('<name>', '<display name>', '<type>') }}`, what **Let the model decide** writes; `addNode` parameters too |
| `connect` | `from`, `to`, `output?`, `input?`, `type?` | A connection that already exists counts as done, not as a second edge. Edges touching a sub-node take its capability type. An agent → sub-node edge is flipped to run sub-node → agent. A Merge's inputs fill in turn. On a port with a connection limit, the new edge replaces the oldest |
| `disconnect` | `from`, `to`, `type?` | The edges from `from` to `to`; when there are none, a sub-node edge the other way (they run sub-node → agent). "Disconnect Lead → Check Branch" removes the main edge after the lead, not the tool edge into it |
| `removeNode` | `node` | Its connections and pinned data go too |
| `renameNode` | `node`, `name` | `$('Old')` and `$node["Old"]` in other nodes' parameters are renamed too |
| `newAgent` | `name`, `description`, `instructions`, `tools?`, `knowledge?`, `ref?`, `parameters?`, `after?`, `before?`, `output?` | an agent none of the published ones is, and a Run an Agent node for it: parsed as an `addNode` of `core.messageAgent` carrying `newAgent`, placed and wired like one; applying it saves the agent as a draft and sets the node's `agentId` ([Agents and teams](#agents-and-teams)) |
| `turnIntoTeam` | `node` | a Run an Agent node with agents attached as tools becomes one Run a Team node; applying it saves the team ([agent-teams.md](agent-teams.md#turn-into-a-team)) |
| `setNodeSettings` | `node`, `settings` | A node's settings, not its parameters: `retryOnFail`, `maxTries`, `waitBetweenTriesMs`, `retryBackoff` (`fixed` or `exponential`), `onError`, `timeoutSeconds`, `alwaysOutputData`, `disabled`. Other keys are dropped. Ranges: `maxTries` a whole number 1-10, `waitBetweenTriesMs` a whole number of milliseconds 0-60000, `timeoutSeconds` 0.1-86400; a value outside is dropped and named. `maxTries` above 1, a `retryBackoff` or a `waitBetweenTriesMs` without `retryOnFail` turns `retryOnFail` on (the engine reads the tries only with it, so the card says so); `retryOnFail: false` with `maxTries` above 1 drops the tries and names it. The [second brain](second-brain.md) uses it for retries |
| `setWorkflowSettings` | `settings` | `errorWorkflowId`, `timeoutSeconds`, `retryMaxAttempts`, `retryBaseDelaySeconds`; other keys are dropped |

The chat offers this op too (its op list and the system prompt name it): a time limit for the whole workflow ("stop it if it runs longer than 5 minutes") is `{"op":"setWorkflowSettings","settings":{"timeoutSeconds":300}}`, not a step's `timeoutSeconds`. A change that only touches the workflow's settings is a proposal like any other.

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

Shown on the card without sending the change back (cautions): a fix that hides an error, and a step with a credential and a hand-written Authorization header (the header wins at run time, so the credential goes unused).

## API

| Route | Body | Response |
|---|---|---|
| `POST /api/assistant/suggest` | `{ workflow, workflowId?, nodeId, run: RunDigest, model? }` | `{ suggestions: [{ id, kind, title, detail, confidence, ops, dropped?, warnings? }], model, durationMs, skipped? }` · 404 for an unknown node, 502 when the model fails |
| `POST /api/assistant/chat` | `{ messages: [{ role, content }], workflow, workflowId?, selectedNodeId?, runs?: { [nodeId]: RunDigest }, mentions?: { nodes?: string[], types?: string[] }, pending?: [{ summary, ops }], session?: fix\|review\|auto, autonomy?: auto\|asks-first, model?, resume?: { checkpoint } }` (`session`: a [Test and fix](#test-and-fix) request, or `auto` for a message typed in autonomous mode; `autonomy`: what Spotlight does with the session's proposal, default `asks-first`; `resume`: [continue after an error](#the-stream)) | SSE: `step.start`, `text.delta`, `thinking`, `text`, `tool`, `proposal`, then `done` or `error` (events in [The stream](#the-stream)) · 409 `checkpoint_expired` |
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

## How Spotlight is measured

Spotlight is scored on three jobs, the way the 2026-11-16 evaluation did it by hand: **build** a flow from an empty canvas,
**fix one step** of a working flow (one-step asks, questions, a failed run), and **create an agent**. The scenarios live in
`apps/web/test/spotlight-scenarios/` (`sb00.ts` is the evaluation's baseline; each later package adds its own file), each
with a scripted form that pins a fix forever and a live form on the local model whose scorecard is printed before and after
a change. The checks are the evaluation's: right node types, wiring, collections filled, ids asked rather than made up,
credentials named, no junk nodes, only the asked node changed, the right change, no change for a question, and that nothing
tried to leave this machine. Collections are judged by a heuristic (a condition, field, rule or schedule list with nothing in
it counts as empty); "runs right with the pinned data" is judged on what the draft sends, not by running it. How to run it and
what the variables do: [development.md](development.md#spotlight-scorecard).

The scorecard reads what happened in the places SB10 fixed. A live session sets the host's outbound policy outright
(`LANDFLOW_OUTBOUND_BLOCK_PRIVATE=true`, since the scorecard runs in vitest, whose development profile does not block
private addresses): with `LANDFLOW_OUTBOUND_ALLOW` unset a run to loopback is refused as production refuses it, and a
scenario's `start.outbound: 'allowed'` lists `127.0.0.1,localhost` and nothing wider; `sb03-blocked-session` is
`blocked`, the other SB03 scenarios `allowed`. SB03's flows point at the echo port (`127.0.0.1:3399`, rewritten to the
run's echo server), and `?fail=404|500|503` makes the echo answer with that status. In a session, "changed nothing"
counts only what was applied: a card the guard refused or one waiting for Apply changes nothing (`Outcome.unapplied`).
A build's
checks read the draft, not the one-line summary: "credentials named" is a `credential` item in `draft.left`, "said what is
left" is `draft.left` having items (not applicable when the draft lacks nothing), and "sent back once" is `draft.calls`
(2) rather than a count of model calls (not applicable for one call and no empty part).

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
