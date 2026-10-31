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
  agent's own `tool` spans under the request. When the node finishes, every step in its result is reconciled, so all
  steps are kept, not only the latest 20. A step whose result says `isError: true` counts as failed.
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
  failed checks appear inline. Tool and model calls fold into "n steps" rows that open.
- **Trace**: the span tree with timing bars, down to a remote agent's single tool calls. A request shows why it was
  asked.
- **Team**: who called whom, with ×n counts (laid out top to bottom, no sideways scrolling), plus a card per actor with
  its time, tokens, how often it was asked and its results. A card opens to the actor's **turns** and shows its **fix
  cycles** ([iterations](#iterations-rounds-turns-and-fix-cycles)).
- **Report**: the run report, computed live with the run's profile, plus the counts, failed steps, who called whom,
  each request's result, cycles, waits and artifacts. **Checked** can pick another profile to look at the run through
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
  did in order (its words between tool calls, then its tool calls), and what came back (result, reply, steps). The Team
  tab shows them under each card, collapsed.
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
  reply and is not repeated. They are cut like all journal content (`traceContent`, 32 KB per event).

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
- the checks;
- who called whom;
- cycles;
- problems (found by, fixed by, confirmed);
- claims against evidence;
- each actor;
- artifacts;
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
  wrote, formatted when opened. **Links**: artifacts with a URL (pull requests, commits). **Data**: JSON artifacts as a
  collapsible tree.

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
journal's view alone and says why.

**In the detail sheet.** A `Write`, `Edit` or `MultiEdit` step opens as the same line diff instead of JSON. A Markdown
artifact opens formatted. When the run names a repository, commit SHAs (7 to 40 hex digits), the run's branch and `#12` pull
request numbers in replies become GitHub links. Everything an agent writes is untrusted: Markdown is rendered without raw HTML
(`react-markdown` with `remark-gfm` and `rehype-sanitize`), links open in a new tab and only when they are http or https, and
images are not loaded.

## HTTP API

| Route | What it does |
|---|---|
| `GET /api/executions/:id/events?after=&limit=` | The journal after `seq` (up to 2000 events): `{ events, last, more }`. A page opened mid-run reads it, then follows the live stream. |
| `GET /api/executions/:id/changes` | The run's branch compared with its base on GitHub (Repository → Compare, flow's credential): `{ available: true, repository, branch: { base, head, aheadBy, behindBy, totalCommits, url, files: [{ path, status, additions, deletions, patch? }], truncated, note? }, fetchedAt }`, or `{ available: false, reason }`. |
| `POST /api/executions/:id/checks` | `{ spanId, name, decision: 'accepted' \| 'sent_back', note? }`: a person's decision on a failed check. |
| `POST /api/executions/:id/gate` | `{ decision, note? }`: answers a Run report waiting on its failed checks, and resumes the run. |
| `GET /api/runs/needs-you` | Across the runs you can see: waits for a person (`approval`, `form`, `question`, `gate`) and failed checks of the last 7 days nobody decided on. |

## Not built

- Other agents' own telemetry (Claude Code's model calls between its tool calls) joined by trace id, OTLP and
  OpenInference export, search and comparison across runs, measures over time, re-running from a span, Copy to editor,
  and pausing a running agent so a person can take over. These are phase 4 in the roadmap.
- **Content kept** is per workflow, not per project.
- Claims are extracted with the profile's patterns. No model reads replies that lack a structured block.
- A remote agent's steps arrive only through its A2A progress and result. A step taken while the progress stream was
  down shows up only when the result reconciles it.
- Built-in checks see only what the journal recorded. A tool that fails silently (exit code 0) passes.
- Models, memory and other non-tool sub-nodes can't report artifacts or checks.
- A trace rebuilt from an older run's data has no progress notes, artifacts, checks or decisions.
