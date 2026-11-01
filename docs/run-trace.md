# Run Trace

What happened in a run, told so a person can follow it: live while it runs and afterwards, on a phone as well as on a
desk. It is generic: the same journal and screens serve a team of agents building software, agents answering customers,
or a flow with no agents at all. A flow's **profile** adds the domain's words and checks. At the end of a flow, the
**Run report** node checks what every actor said against what the record shows, and reports who did what.

Code: the journal in `apps/web/src/lib/server/journal/`, its types in `apps/web/src/lib/shared/run-trace.ts`, the fold
the screens read in `apps/web/src/lib/shared/run-trace-model.ts`, the checks and report in
`apps/web/src/lib/shared/run-report.ts`, profiles in `apps/web/src/lib/shared/run-profiles.ts`, the screens in
`apps/web/src/components/run-trace/`, the node in `apps/web/src/lib/server/nodes/run-report.ts`.

## The journal

Every execution keeps an append-only journal (`execution_events`, migration 2000): one row per event, numbered
`seq` 1, 2, 3… within the execution. A run is told in five things:

- **Actors**: who takes part. The flow itself (`workflow`), agent nodes (`node:<id>`), remote A2A agents
  (`remote:<name>`), Landflow agents, models (`model:<name>`), people (`human:<id>`), and system actors for timers,
  webhooks and sub-workflows.
- **Spans**: interactions, each with an actor, often a caller, a start, an end and a status. The kinds are `run`,
  `step`, `agent`, `delegate` (a request another agent works on while the caller waits), `handoff`, `wait` (for a person
  or a timer), `tool` and `model`.
- **Messages**: something said that is not a span's input or output, such as a chat message that started the run or a
  person's decision.
- **Artifacts**: what was made, such as a pull request, a branch, a ticket, a reply or the run report.
- **Checks**: what was verified: by a node (`ctx.check`), by the Run report, or a person's decision on a failed one.

Span kinds follow the OpenTelemetry GenAI conventions (`invoke_workflow`, `invoke_agent`, `execute_tool`, `chat`), A2A's
task states and OpenInference's span kinds, so an exporter can map them later. Span ids are deterministic:
`node:<nodeId>:<n>` is a node's n-th run, `<parent>/step:<id>` a remote agent's tool call. Each event carries the run's
OTel trace id when telemetry recorded one, and a step's own span id in `attrs.otelSpanId`.

### Who writes it

- **The runner** feeds every engine event of a run to a translator (`journal/translator.ts`). Node runs become `step`
  or `agent` spans, sub-node runs become `model`, `tool` or `delegate` spans, and waits become `wait` spans. A chat or
  form trigger's input becomes a message from the person.
- **Remote agents**: an A2A Agent node's progress (the remote task's state and its tool calls) becomes the remote
  agent's own `tool` spans under the request, whether the node is an agent's tool or a step on the canvas. When the node
  finishes, every step in its result is reconciled, so all steps are kept, not only the latest 20. A step whose result
  says `isError: true` counts as failed. A Claude Code agent with the landflow-harness mod ([a2a.md](a2a.md#the-landflow-harness-mod))
  also reports each model request: it is recorded as a `model` span named after the model, under that member's
  request (`<request>/model:<n>`), with the request's tokens, cache reads and writes, cost and model and its own start
  and end. The request keeps the mod's totals; the fold counts a model span as one request and takes its share off the
  request's usage, so nothing counts twice (a model span without a `requests` count is one). The first 300 requests of
  a call are kept as spans; the totals count all of them. (Before 2026-11-01 an A2A Agent node on the canvas kept its progress as a text
  note and its output cut whole, so those runs show none of its steps or files.)
- **Landflow agents** started by Run an Agent write their turns, tool calls and sub-agent requests under that node's
  span (`journal/agent-session.ts`). A guardrail that blocked or sanitized a turn becomes a check.
- **People**: approving or rejecting a tool call (from the web, Slack or email) is a message in the wait it answers.
  So is answering a Run report's gate.
- **Plugins** in every SDK report artifacts and checks (below).
- **Older runs**: a run recorded before Run Trace has no journal. The first time its trace is opened, one is rebuilt
  from its run data (`journal/backfill.ts`): every node and sub-node run, and a remote agent's steps from its result.
  Progress notes, artifacts, checks and decisions lived only in the live stream, so they are missing; the header says
  **Rebuilt from the run data**. A run older than the retention is not rebuilt.

Events are redacted like the run's data before they are written. Writes are batched about twice a second, flushed at
once when a run finishes or starts waiting, and never fail the run. Each flushed batch goes out on the live stream
(`/api/events`) as a `journal` event.

### Content, size and retention

- **Content kept** (workflow setting `traceContent`, else `LANDFLOW_TRACE_CONTENT`): `full` (the default) keeps
  everything redacted, cut to 32 KB per event. `summaries` keeps the first 400 characters of each text. `off` keeps only
  who did what and when: no inputs, outputs or message text, and error messages cut to 400 characters.
- **Retention**: events older than `LANDFLOW_TRACE_RETENTION_DAYS` (default 30, `0` keeps them) are pruned at boot and
  daily. Deleting an execution deletes its journal.

## Artifacts and checks from any node

| SDK | Artifact | Check |
|---|---|---|
| TypeScript | `ctx.artifact({ name, kind?, url?, mimeType?, text?, data? })` | `ctx.check({ name, status, message?, subject?, evidence? })` |
| Python | `ctx.artifact(name, kind=None, url=None, mime_type=None, text=None, data=None)` | `ctx.check(name, status, message=None, subject=None, evidence=None)` |
| Go | `ctx.Artifact(landflow.Artifact{...})` | `ctx.Check(landflow.Check{...})` with `landflow.CheckPass`, `CheckFail`, `CheckWarn`, `CheckSkip` |

A check's status is `pass`, `fail`, `warn` or `skip`. In-process nodes send them as they happen. Remote plugins return
them with the response (`ExecuteResponse.records`, [protocol.md](protocol.md)) over HTTP, gRPC and the brokers. Either
way the engine emits a `node.record` event and the journal keeps it in the node's span. The GitHub plugin reports the
pull requests, issues and branches it creates.

## The screens

**Run trace** sits next to **Canvas** above every execution. It opens by itself when the run has agents (the choice is
remembered). **Full screen** opens `/runs/<executionId>`, a page made for a phone.

- **The header**: live or finished, the time, who is working on what right now, the outcome as reported (the last
  agent's answer) and as checked (the Run report's verdict in the profile's words, with how many checks failed). A live
  run with no new event for 5 minutes says **Quiet for n min**.
- **Needs you**: the approvals a run waits for (Approve and Reject in place), a Run report's gate (**Accept as is** or
  **Send back for a fix**), other waits (**Open to answer**), and failed checks nobody has decided on.
- **Story** (the default): the run as a conversation. It shows messages, requests between agents (with **Why** they
  were asked) and their result (Delivered, Answered, Left undelivered, Working, Waiting), waits for people, round
  dividers when the flow loops, and artifacts as cards. Failed steps and
  failed checks appear inline. Tool and model calls fold into "n steps" rows that open; each tool call there says what
  it did, in the agent's own words when it gave a `description` (Claude Code does with every command), else in plain
  words ("Cloning the repository", "Reading get-alerts.ts"), with the tool's name beside it.
- **Trace**: the span tree with timing bars, down to a remote agent's single tool calls. A request shows why it was
  asked.
- **Team**: who called whom, with ×n counts (laid out top to bottom, no sideways scrolling), plus a card per actor with
  its time, tokens, how often it was asked, its results and chips for what it [works with](#what-each-agent-works-with). A card opens to the actor's **turns** and shows its **fix
  cycles** ([iterations](#iterations-rounds-turns-and-fix-cycles)). Tokens come from every span that reports usage (a
  model call, an agent or team node, a remote agent's answer); a span keeps what the spans under it don't account for,
  so a team's total is counted once and each member keeps its own. Cost, cache reads and model requests go the same
  way where a span reports them: a Claude Code agent on kagent reports its real usage through the landflow-harness mod
  ([a2a.md](a2a.md#the-landflow-harness-mod)), so its card says "4 model calls · 52,310 in (48,000 cached) · 1,204 out
  · $0.0213 · claude-sonnet-5-5" and its guardrail stops are checks on its request.
- **Report**: the run report, computed live with the run's profile, plus the counts (tokens with the run's cost when
  some was priced), failed steps, who called whom, each request's result, what each agent used (time, model calls,
  tokens, cost, model with its provider's logo), cycles, waits and artifacts. **Checked** can pick another profile to look at the run through
  (a flow without one through Software delivery, say) without changing the flow; the header follows it. **Copy as Markdown** copies it. When a Run report node saved one,
  **Saved report** opens it.
- **Artifacts**: what the run made (below). Code changes first when agents changed files, then documents, links and data.
- **The detail sheet**: tap anything to open it. It is a bottom sheet on a phone and a side panel on a wide screen,
  showing the actor and caller, times, input, output or error, and the artifacts and checks inside.
- **The time slider**: scrub or replay the run. Tapping a time in the sheet moves it there. A live run follows the end
  until you move the slider.

**Executions** (the list across workflows) starts with **Needs you** across every run you can see, and a card for each
running execution showing who is working on what.

On a phone (below 768 px) the app's left rail is a drawer behind a slim top bar with a menu button, so these pages get
the whole width.

### What each agent works with

Each agent actor carries its **connections** (`RunActor.connections`): its model, memory, knowledge, tools, skills, the
agents it can ask, where it runs, its plugins and what its sandbox may reach. They show as chips on its card and on the
team chart, and as a **Works with** list in its sheet (name, kind, one line of detail, and where it is set: in the flow,
in the agent's settings, on kagent). Each wears the thing's own icon: the node type's (a plugin's logo), else a brand's
(`brand:<slug>` from `lib/shared/brand-icons.ts`: Ollama, Anthropic, Claude, OpenAI, Gemini, Mistral, Hugging Face,
GitHub, Kubernetes, Docker, MCP, kagent, PostgreSQL, SQLite), else its kind's.

| Where | What the run records |
|---|---|
| An agent node in the flow | Its sub-nodes when the span starts: the chat model (model name, the node's name and server), memory (turns), tools (a node's resource and operation), knowledge (a vector store or retriever: its collection), A2A and agent sub-nodes as agents it can ask. Disabled sub-nodes are left out. |
| A Run an Agent node | The agent's published settings beside the sub-nodes, without the model or memory a sub-node already gives (`lib/server/agents/connections.ts`). |
| An A2A Agent node or tool, a team's remote member | When the URL is a Landflow agent deployed to kagent (by the URL its deployment recorded, else the kagent name it ends with): **Claude Code** (when it has plugins, the mod or a Claude harness) and **kagent** (the deployment's name, sandbox and hot start), its Claude Code plugins (the landflow-harness mod among them), each EgressPolicy (GitHub, package registries, Landflow) and the agent's own model, tools and skills. Any other URL: an A2A agent and its host. |
| A team | Each member's connections on the chart the node's span records (`attrs.team.members[].connections`); the lead's leaves out the model and memory the flow gives. The model folds them onto the member's actor by title. |

A team node's usage names the lead's model, and an agent session counts each of its model calls, so the lead's card and
the report say "3 model calls · 5,443 in · 714 out · $0 · qwen3-coder:30b" beside a member's reported usage.

## Iterations: rounds, turns and fix cycles

A run that goes back and forth is told at three levels. The first two are folds of the journal (`foldJournal` in
`lib/shared/run-trace-model.ts`); the third is `lib/shared/fix-cycles.ts`.

- **Rounds.** When a flow loops (a node runs more than once: span ids `node:lead:0`, `node:lead:1`), the node that came
  round again starts each round, and what ran before its first start belongs to round 1. The Story puts a **Round n**
  divider in at each start. From round 2 on, the divider says why the work went back: the Run report's send-back text
  and the checks it failed (`output.sendBack`, `output.checks`), or a person's note. A node that ran again only
  because it waited and resumed has `attrs.resumed` and starts no round. Nothing is recorded for rounds beyond what
  the spans and the Run report already hold. A flow that never loops has no rounds.
- **Turns.** An agent with a model has one turn per model call: **why** (the model's words before acting, else the
  `reason` it gave each request), what it **did** (requests and tool calls) and what came back, with the duration and
  steps of each request. A member that is asked things has one turn per request: why it was asked, what it said and
  did in order (its words between tool calls, then its tool calls), and what came back (result, reply, steps). A remote
  agent on the canvas (an A2A Agent node, not an agent's tool) has one turn with its tool calls and the words it said
  between them, in order. The Team tab shows them under each card, collapsed.
- **Fix cycles.** For each actor, its runs of a check command in order, each passed or failed with the errors the
  output counts (`error TS…` lines, "Found n errors", "n failed", Go `--- FAIL`, linter "n problems"), and the changes
  made between the runs (edits and writes, or the profile's delivery work pattern): "typecheck 19 → 13, never passed",
  "tests 1 → passed". Which commands are checks comes from the profile: its `tests`, `typecheck`, `lint` and `build`
  claims' evidence patterns, so a profile without them (Generic, Customer support) has no fix cycles and a custom
  profile names its own. A step that failed is read from its status, `isError` in its output, an exit code or `error
  TS` lines. A single clean run is not a cycle.

Two things in the journal make turns readable:

- **A reason for every request.** A node flagged `delegates: true` in its descriptor (`core.a2aAgent`) gets a required
  `reason` argument on its tool schema ("Why you are asking and what done looks like, in one sentence"). The engine
  keeps it out of the node's parameters and input item, and the translator moves it from the tool call's input to
  `attrs.reason` of the delegate span. The agents' capabilities (`ask_<name>` for A2A agents and sub-agents) ask for it
  the same way and `journal/agent-session.ts` records it. The model is asked for it by the schema; a call without one
  still runs and simply has no reason.
- **What members said.** A remote agent's text between its tool calls (the text of every task artifact that a later
  artifact follows) is journaled as `message` events with `inline: true` under the delegate span, in order with the
  steps, once each. They belong to the member's turn and are left out of the Story. The last artifact's text is the
  reply and is not repeated. A streaming agent (kagent's) appends its words to the artifact a token at a time, each a
  part with its own spacing, so the text parts between two tool calls are joined as sent into one message. (Before
  2026-11-01 each token was its own message, trimmed of its spaces.) They are cut like all journal content
  (`traceContent`, 32 KB per event).

## Profiles

A profile (Workflow settings → **Run Trace** → **Profile**) gives the checks a flow's own words: claims to verify, role
rules, deliveries, the words that sign work off, and what the gate does. Without one, a flow gets **Generic**.

| Profile | Claims checked | Role rules | Deliveries | Outcome words | Gate |
|---|---|---|---|---|---|
| Generic | none | none | none | Done / Needs attention | warn |
| Software delivery | typecheck, tests, lint, build, pushed | reviewers only read (no Edit, Write or git push/commit) | every change pushed | Ready to merge / Not ready to merge | route |
| Customer support | email sent, refund issued, ticket updated | the front desk doesn't refund | none | Resolved / Needs attention | warn |

**Custom (JSON)** takes the same shape: `id`, `name`, `words`, `artifacts`, `claims` (`{ id, label, claim, evidence }`),
`roles` (`{ label, actor, deny }`), `deliveries` (`{ label, work, delivery }`), `approval`, `gate` (`route`, `ask` or
`warn`) and `mute` (built-in check ids to skip). Patterns are regular expressions, matched case-insensitively. `claim`
is matched against what an agent says; a role's `actor` against the actor's name and id (not its description); and
`evidence`, `deny`, `work` and `delivery` against a tool step as text: its name, what it worked on, then its input
(`Bash pnpm test {"command":"pnpm test"}`, `Write src/api.ts {"file_path":"src/api.ts",…}`).

Software delivery leaves an agent's notes out of its role and delivery rules: Claude Code's `MEMORY.md` and files in
`memory/` or `.claude/` folders are not changes to the code. A test run counts through a filter too
(`pnpm --filter @landflow/plugin-grafana test`).

## The built-in checks

Each check names what it compared and points to its evidence. Only each actor's latest answer is judged, so a flow that
sends work back is judged on the fix.

**Rounds**: once work was sent back (by a Run report's gate or a person) and someone worked on it again, the next report
judges that round's steps. Role rules, deliveries, hidden failures and node checks from before the send-back were handed
over and no longer count. Until new work starts, the failures stay, so a report saved right after a decision still shows
them.

1. **Claims against evidence**: an agent says something was done. The latest matching step by that agent must have
   succeeded. If it failed, the claim is contradicted (fail); if no step shows it, it is not shown (warn). Every claim
   is listed; each rule is checked once per answer.
2. **Role rules**: an actor used a tool its role excludes.
3. **Unfinished work**: a request was left undelivered (by its latest round), something was still running when the run
   ended, or work was never delivered (edits after the last push).
4. **Problems sent back**: a problem an answer knew about (its findings, or a failing check-type step it ran last) that
   was signed off anyway, or that no later request took up. A problem counts as fixed when someone's later step of the
   same kind passes.
5. **Hidden failures**: a step failed, was never redone successfully, and the answer above it doesn't mention it.
6. **Agent notes committed**: an agent's own notes reached the branch: `MEMORY.md` at any depth, or Claude Code's local
   `.claude/` state (`settings.local.json`, `projects/`, `memory/`); a project's own `memory/` folder is code and doesn't
   count. When the run names a repository and a branch, the Run report node reads the branch's files from GitHub (the same
   **Compare** as the Artifacts tab; files a commit removed don't count), so notes count however they got there (a
   `git add -A`, a harness). Without the branch, a `git add` in this round that names them fails. It is how pull request
   #3 carried `MEMORY.md` into main unflagged (removed since; the repository ignores `MEMORY.md`).

### Structured replies

An agent can say exactly what it did by ending its reply with a block:

````
```landflow
{"claims": ["tests pass", "typecheck passes"], "findings": ["api.ts ignores 429s"], "fixes": ["retry on 429"]}
```
````

Without one, the sentences that match a claim pattern of the profile count as claims, and the report marks them
*extracted from the reply*.

## The Run report

The **Run Report** node (AI › Flow) goes at the end of a flow. It reads the run's journal, runs the checks, records them
(each on the span it is about), saves the report as a `report` artifact of the run, and outputs it:

- `verdict` (`pass`, `warn` or `fail`), `label`, `profile`, `failed`, `checks`, `next`;
- `report`: the Markdown, to post with the next node (GitHub Pull Request Comment, a ticket note, Slack);
- `sendBack`: on "Send back", the failed checks and what should happen next, ready to hand to whoever fixes the work;
- `decision`, `note`, `decidedBy` after a person answered the gate.

Parameters: **Profile** (from the workflow settings, or one of the three), **When a Check Fails**, **Title**, and **Add a
Summary**. The summary needs a chat model on the node's Chat Model slot, which writes two to four sentences from the
report's facts only. The report's sections are the same for every flow:

- the outcome, as reported and as checked;
- the checks: the six built-in ones, worked out again each time, and every check recorded during the run (a node's
  `ctx.check`, a team's *Grounded*, *Review* and *Budget*, a guardrail's), so a warn or fail from any of them sets the
  verdict. A check is one per span, name and subject, and its latest event is its word: a team's Budget for the Planner and
  for the Developer are two checks on the node, and a Grounded warn the lead answered again without becomes a pass;
- who called whom;
- cycles;
- problems (found by, fixed by, confirmed);
- claims against evidence;
- each actor;
- artifacts;
- files written: every file an agent's Write or Edit step changed, with who and how many lines, as the Artifacts tab's
  code changes show them (the Report tab counts them as artifacts too);
- a timeline;
- what should happen next.

**When a check fails** (the gate):

- **Send the work back** (`route`): the item goes out on **Send back**. Connect that output to whoever fixes the work,
  for example back to the Tech Lead with `{{ $json.sendBack }}`. The gate settles this round's failed checks as sent
  back, and the next report judges the fix. Put a limit on the loop (an If node on a round count), and a way out after
  it, such as a draft pull request for a person. The flow that builds plugins from suggestions works this way: Passed
  opens a pull request, posts the report as its first comment and merges it (GitHub's **Pull Request → Merge**, only if
  the head is still the checked commit); Send back gives the failed checks to the Tech Lead as the next task, up to 3
  rounds.
- **Ask a person** (`ask`): the run waits. **Needs you** shows **Accept as is** and **Send back for a fix**, which call
  `POST /api/executions/:id/gate`. The same wait has a form page at `/form/waiting/<id>`, for a link in an email. The
  decision is written to the journal and settles each failed check, and the run goes on out of **Passed** or **Send
  back**.
- **Only warn** (`warn`): always **Passed**, with the failures in the report.
- **As the profile says**: Software delivery sends the work back; Generic and Customer support only warn.

## Artifacts and code changes

The **Artifacts** tab (code in `components/run-trace/artifacts.tsx`) opens everything a run made. It starts with one line
(`11 files · 3 agents · 1 document · 11 changes never pushed`), then groups:

- **Code changes** appear when agents wrote or edited files, or the run names a branch. One card per file: its path (relative to the clone root),
  `+`/`−` counts, and one line per agent saying what it did (`Planner wrote it`, `Reviewer edited it twice`) and whether it
  reached the branch (`pushed in 0039ded`, `2 of 3 pushed`, `never pushed`). Tap a card for the diff: **Combined** or one
  agent's changes, each as a line diff. The diff box scrolls sideways by itself, so the page never does.
- **Documents**: Markdown artifacts (a `mimeType` of `text/markdown`, or kind `report` or `document`) and `.md` files agents
  wrote, formatted when opened.
- **Images**, **Tables**, **Pages** and **PDFs** (`components/run-trace/artifact-preview.tsx`): an artifact is read once as
  what it is (`lib/shared/artifact-kinds.ts`), from its `mimeType`, its kind (`image`, `screenshot`, `pdf`, `csv`, `html`),
  its name or URL's extension and what it carries. An image or a PDF needs a URL it can load: http(s), or an inline
  `data:image/…` or `data:application/pdf`. One on another server loads only when tapped (**Load the image from
  cdn.example.com**), since loading it tells that server who looked, and with no referrer. A **table** (CSV or TSV, quoted
  fields as RFC 4180 has them) shows one card per row with each column as a label, 25 rows first and 100 more per tap. A
  **page** (HTML) shows in a frame with `sandbox=""` (no script, forms, navigation or same origin) behind a policy that
  loads nothing from the network, and its links do nothing; **Show the source** gives the text. `.csv` and `.html` files
  agents wrote show here too, from their last text.
- **Links**: artifacts with an http(s) URL (pull requests, commits), except images and PDFs, which open from their own
  cards. **Data**: JSON artifacts as a collapsible tree.

**Where the changes come from.** `lib/shared/run-changes.ts` folds the journal: a remote agent's `Write`, `Edit` and
`MultiEdit` tool steps (their `input` is the Claude Code tool input; a remote agent's arguments that arrive as JSON text are
read as the object). The A2A Agent node sends each step's arguments whole the first time a progress report carries the step
(each text up to 16,000 characters) and shortened after, so the journal keeps the path and text; runs recorded before
2026-10-31 kept only the first 400 characters of the arguments, so most of their files show only on the branch. A `Write` is diffed against the last text of that path
earlier in the run, else every line counts as added. An `Edit` is applied to the text the run showed, so a tool that passes
the **whole file** as `old_string` still diffs line by line; an edit to a file the run never showed is compared as the two
fragments it passed. Agent memory notes (`MEMORY.md`, `memory/`, `.claude/`) are left out, as the profiles do. Tool input is
cut at 32 KB per event (**Content kept**): a diff of cut text says so.

**Pushed or never pushed.** A change is pushed when the same agent later committed that file (a `git add` that names it, or
`git commit -a`) and then ran a `git push` that succeeded. A push that carried only `PLAN.md` leaves the agent's other files
never pushed, which is the case the Run report's single "every change pushed" check cannot show. A run in which no agent
used git shows no pushed markers.

**The branch as GitHub sees it.** When the run names a repository and a branch (the GitHub steps' `owner` and `repository`
parameters or a github.com URL in the journal; Create branch's output, the pull request's head, or an agent's push target),
the tab asks `GET /api/executions/:id/changes`. The host runs the GitHub plugin's **Repository → Compare**
(`GET /compare/{base}...{head}`) with the flow's own GitHub credential, the way a node of the flow would, and keeps the answer
per run (10 minutes; 15 seconds while the run is live). With it, each file card also says **On the branch** or **Not on the
branch**, the diff switches between **What the agents did** and **On the branch** (GitHub's own patch), and the files the
branch holds that no step in the record changed come last as their own cards (**not in the run's record**, GitHub's patch).
That is also how a committed agent note (`MEMORY.md`) shows up. GitHub lists at most 300 files of a comparison, patches only for files that are
not large or binary: the tab says when the list is cut. Without a GitHub step, a credential, or an answer, the tab shows the
journal's view alone and says why: a run with no GitHub step reads "Not checked against GitHub", the others "could not be
read" with the reason.

**Line comments.** Tap a line of any diff in the tab (or its line number, which is a button for a keyboard) and write what
should change; the comment shows under the diff, and the line number is marked. A card above the files counts them, with
**Copy them** and **Clear all**. They are kept in this browser per run (`localStorage`, so a reload keeps a review in
progress) and matched by file, side, number and the line's text. When the run waits on a Run report's gate, its card in
**Needs you** shows a **Note for Send back** filled with them (`- src/a.ts line 12 (`quote`): comment` per line), which you
can edit; **Send back for a fix** sends it as the gate's `note`, and the comments are cleared. **Add a note** writes one
without comments.

**In the detail sheet.** A `Write`, `Edit` or `MultiEdit` step opens as the same line diff instead of JSON. A Markdown
artifact opens formatted; an image, a PDF, a table or a page opens as in the tab. When the run names a repository, commit SHAs (7 to 40 hex digits), the run's branch and `#12` pull
request numbers in replies become GitHub links. Everything an agent writes is untrusted: Markdown is rendered without raw HTML
(`react-markdown` with `remark-gfm` and `rehype-sanitize`), links open in a new tab and only when they are http or https, and
images are not loaded.

## Search, compare and measures

Three routes read across runs, and two screens use them (made for a phone: one column of cards, no wide tables).

- **Search** (`/runs`, **Search runs** in the side bar; `GET /api/runs/search`): words (span names, inputs and outputs,
  messages, artifacts, checks), workflow, an agent or actor by name, a tool by name, status, **has failed steps**,
  **a check failed** (by name, or any) and from/to dates. Results are cards (status, workflow, when, how long, the
  failed steps and checks, and where the words were found) that open `/runs/<id>`, 20 at a time with **Show more**.
  Only the runs of workflows you can see are searched. The queries are plain SQL on `execution_events` (`LIKE` and
  `EXISTS`, the same on SQLite and Postgres, no schema change); each candidate run's events are then checked in code,
  so a word that is only a field name of the stored event doesn't match. A run recorded before Run Trace is searched by
  workflow, status and date only, until its journal is rebuilt by opening it.
- **Compare** (`/runs/compare?a=&b=`; pick two cards in the search and press **Compare**; `GET /api/runs/compare`):
  each run is folded with `foldJournal` and shown as a card: duration, tokens in and out, cost, model calls, steps,
  failed steps, checks passed, failed and warned, the failed checks' names and the artifacts. The cards sit side by
  side on a wide screen and stack on a phone; the second shows what changed from the first (a rise is red). Under them,
  a card per actor of either run with its steps, failed steps, tokens and model calls in both runs and the
  difference; an actor that took part in only one says so.
- **Measures over time** (`GET /api/runs/measures?workflowId=`; the chart appears on the search page once a workflow is
  chosen): the workflow's last runs (30 by default) as duration, tokens in and out, cost, failed steps and failed
  checks per run. The chart is a line with a dot per run for one measure at a time (duration, tokens or cost), the
  latest dot larger and labelled with its value, the largest value and the first and last dates on the axes; a run
  with a failed step, a failed check or an error is a red dot. A run profile can't define measures of its own yet.

## Export over OTLP

Set `LANDFLOW_OTLP_TRACES_URL` to an OTLP/HTTP traces endpoint (`http://landflow-lgtm:4318/v1/traces` in the
`orbstack-observability` overlay) and every execution's journal is sent there when the run ends
(`journal/otlp-export.ts`; a run that waits for a person or a timer is sent when it finishes):

- **One trace per execution**, with the run's own OTel trace id when telemetry recorded one (so the spans join the
  host's spans of that run), else an id derived from the execution. Each journal span is an OTLP span with its parent,
  start and end, and a status (success OK, error ERROR with the message; a canceled or unfinished span has none). A
  span's checks, artifacts and messages are span events.
- **OpenInference attributes**: `openinference.span.kind` is `AGENT` for agent, delegate and handoff spans, `LLM` for
  model spans, `TOOL` for tool spans, `EVALUATOR` for a Run report (or evaluation) node and `CHAIN` for the rest;
  `llm.model_name`, `llm.token_count.prompt`, `.completion` and `.total` (and `.prompt_details.cache_read` and
  `.cache_write`, `llm.cost.total` when reported) where the span has usage; `input.value` and `output.value` with their
  mime types; `landflow.actor`, `landflow.execution_id`, `landflow.span_kind`, `landflow.status`.
- **Redaction and size** are the journal's: the export reads what was stored (secrets redacted, content cut by
  `traceContent`, so `off` sends no inputs or outputs) and cuts each value to 4,000 characters.
- **Never in the way**: it runs after the run, in the background; spans go out in batches of 200, each request is
  tried twice, and a failure is logged and dropped.

## HTTP API

| Route | What it does |
|---|---|
| `GET /api/executions/:id/events?after=&limit=` | The journal after `seq` (up to 2000 events): `{ events, last, more }`. A page opened mid-run reads it, then follows the live stream. |
| `GET /api/executions/:id/changes` | The run's branch compared with its base on GitHub (Repository → Compare, flow's credential): `{ available: true, repository, branch: { base, head, aheadBy, behindBy, totalCommits, url, files: [{ path, status, additions, deletions, patch? }], truncated, note? }, fetchedAt }`, or `{ available: false, reason }`. |
| `POST /api/executions/:id/checks` | `{ spanId, name, subject?, decision: 'accepted' \| 'sent_back', note? }`: a person's decision on a failed check (`subject` picks one of a span's checks of that name, as a team's Budget for each member). |
| `POST /api/executions/:id/gate` | `{ decision, note? }`: answers a Run report waiting on its failed checks, and resumes the run. |
| `GET /api/runs/needs-you` | Across the runs you can see: waits for a person (`approval`, `form`, `question`, `gate`) and failed checks of the last 7 days nobody decided on. |
| `GET /api/runs/search`, `/api/runs/compare?a=&b=`, `/api/runs/measures?workflowId=` | Search, compare and measures across runs ("Search, compare and measures" below). |

## Not built

- Re-running from a span, Copy to editor, and pausing a running agent so a person can take over. These are phase 4 in
  the roadmap.
- Other agents' own spans (Claude Code's OpenTelemetry) are not joined to the trace by trace id yet.
- Search reads the journal of runs that have one. It matches the stored text of an event with `LIKE`, so it is not
  ranked or stemmed, and a request reads at most 1,000 candidate runs. A run profile can't define measures of its own
  yet: the measures over time are the generic ones.
- The OTLP export sends JSON (not protobuf), once, when a run ends; a run that was waiting is sent when it finishes, and
  a run the host loses before it ends is never sent.
- **Content kept** is per workflow, not per project.
- Claims are extracted with the profile's patterns. No model reads replies that lack a structured block.
- A remote agent's steps arrive only through its A2A progress and result. A step taken while the progress stream was
  down shows up only when the result reconciles it.
- Built-in checks see only what the journal recorded. A tool that fails silently (exit code 0) passes.
- Models, memory and other non-tool sub-nodes can't report artifacts or checks.
- Connections are what the flow and the agent's published settings said when the span started: a tool an agent
  didn't call still shows, and a change made during the run doesn't. A kagent agent's runtime is told from its
  deployment (plugins, the mod, the harness name), not read from the cluster.
- A trace rebuilt from an older run's data has no progress notes, artifacts, checks or decisions.
