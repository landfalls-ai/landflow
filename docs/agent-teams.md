# Agent teams

An agent team is a set of agents with standing relations, like an org chart: one **lead** runs the work, every other
member **reports to** exactly one manager, and a member can **review** another's work, so its manager can't report done
until the reviewer signs off. Members are Landflow [agents](agents.md) or remote agents over [A2A](a2a.md) (Claude Code on
kagent, say). Teams live on the **Agents** page, in the **Teams** view next to the roster.

Not to be confused with the agent's **team label** (a grouping on the roster, see [agents.md](agents.md#teams)) or the
Microsoft Teams channel of an agent (`/api/teams/...`). This resource is `agent-teams` everywhere: routes
`/api/agent-teams`, table `agent_teams`, resource kind `agentTeam`.

## What a team holds

| Field | |
|---|---|
| `name`, `goal`, `description` | the goal is what the team is for; every request inside the team carries it |
| `members[]` | `kind: 'agent'` (`agentId`) or `kind: 'a2a'` (`parameters` of the A2A Agent node: `agentUrl`, `authentication`, `options`; `credentials`) |
| per member | `id`, `title` (how its manager calls it), `role` (a sentence: when to ask it), `reportsTo`, `reviews[]`, `budgetTokens`, `questionsTo` (`manager`, the default, or `person`) |

The types and the checks are in [`apps/web/src/lib/shared/agent-teams.ts`](../apps/web/src/lib/shared/agent-teams.ts).

## The rules

`teamIssues` lists what stops a team from running, in plain words. A draft saves with issues (they show above Publish as a
list); **publishing is refused** until there are none:

- the team has a name and at least one member; every member has a title, and titles differ (managers call members by title);
- exactly one member leads (reports to nobody), and every reporting line ends at the lead: no circles;
- everyone reports to, and reviews, a member who is in the team; nobody reviews themselves;
- **a remote agent can't manage**: only Landflow agents run a tool-calling loop, so nobody reports to a remote member;
- a Landflow member names its agent, a remote member its address; a budget is more than 0 tokens.

A budget is the tokens a member may spend in one run: a warning at 80%, a stop at 100%. No budget, no limit. **Questions go
to** the member's manager first (who may pass them on to a person), or straight to a person.

## The chart

The team page (`/agents/teams/:id`) draws the team as an aligned org chart of equal cards: the lead on top (tinted),
then one section per manager ("Reports to Tech Lead · 3") in chart order, each a grid of same-size cards, one column on a
phone, two from `sm`, three from `lg`. A card has a header (face, title, where it runs: **Landflow agent**, **<agent> on
kagent** or **Remote agent over A2A**), what it does in up to three lines, and a footer with **Reviews**, **Reviewed by**,
the budget and where questions go (**Reports to** only outside the chart), so cards in a row line up. A remote member
that calls a Landflow agent on kagent (its address is that agent's on kagent's controller, `…/agents/<namespace>/<name>`)
wears that agent's face, here, on the Teams cards, above the Run a Team node and in Run Trace; any other remote member
gets the A2A radio icon.
Tap a card to edit it in a sheet; **+ Add a report** on a manager adds a member under it. A new member reports to the lead
unless asked otherwise (the first one becomes the lead). Removing a member hands its reports to its manager and drops it
from reviews. Members not connected to the lead yet are listed under the chart. The page autosaves the draft after a
pause. Each agent's card on the roster shows the teams it is in.

## Publishing

**Publish** snapshots the draft as the next version (`published`, with `version` and `publishedAt`); flows run the
published version, so edits to the draft change nothing until published again. **Unpublish** stops flows from running the
team; the draft and the version count stay. Deleting a team asks first, on the page.

Access follows agents and workflows: a team belongs to a project (`?projectId=` when creating, else the caller's personal
project), is listed to the people who can see that project, and is changed by its editors. The routes need the same scopes
as agents (`workflows:read` / `workflows:write`).

## The routes

| Route | |
|---|---|
| `GET /api/agent-teams` | `{ teams }`: `TeamSummary` (name, goal, member count, `lead`, `published`, `agentIds`, `remote`, `issues`) with `ownership`; `?projectId=` |
| `POST /api/agent-teams` | `{ name?, goal?, description?, members? }` → `{ team }` (201) |
| `GET /api/agent-teams/:id` | `{ team, issues, ownership }` |
| `PUT /api/agent-teams/:id` | replaces the draft (unknown fields dropped, text trimmed) → `{ team, issues }` |
| `DELETE /api/agent-teams/:id` | `{ ok }` |
| `POST /api/agent-teams/:id/publish` | `{ team }`; 400 with `issues` while the draft can't run |
| `POST /api/agent-teams/:id/unpublish` | `{ team }` |
| `GET /api/agent-teams/:id/export` | the team as a Claude Code plugin zip ([marketplace.md](marketplace.md#export-agents-as-plugins)); `?marketplace=1`, `?preview=1` |
| `GET /api/agent-teams/:id/flows` | `{ flows: [{ id, name, active, nodes }] }`: the workflows you can see with a Run a Team node set to this team |
| `POST /api/agent-teams/:id/template` | `{ name, description?, categories?, setup?, workflowId?, projectId? }` → `{ template }` (201): the team and its agents as a [team template](templates.md) |

Storage is the `agent_teams` table (migration 1910): `draft` and `published` as JSON, `version` the last published version.
The code is in `apps/web/src/lib/server/agent-teams/` (`store.ts`, with `teamsOfAgent(agentId)`).

## Export and templates

The team page has two ways to take a team elsewhere. **Export as Claude Code plugin** downloads a plugin zip
([marketplace.md](marketplace.md#export-agents-as-plugins)) with a file per Landflow agent and the chart in
`.landflow/team.json`. **Save as template** keeps the team, its agents and, if you pick one, a flow that runs it, as a
template that **Use template** recreates with fresh ids and credentials of the new person's choosing ([templates.md](templates.md)).
When a team has flows, the page lists them (`GET /api/agent-teams/:id/flows`), and the team a template creates opens with
its new flow marked.

## Running a team in a flow

The **Run a Team** node (`core.runTeam`, under AI) runs a published team as one step. Code:
[`nodes/run-team.ts`](../apps/web/src/lib/server/nodes/run-team.ts) (the node) and
[`agent-teams/runtime.ts`](../apps/web/src/lib/server/agent-teams/runtime.ts) (the run).

| | |
|---|---|
| **Team** | a published team (the options list every team and say which are published) |
| **Message** | the task, for the lead; default `{{ $json.chatInput ?? $json.text }}` like Run an Agent |
| **Version** | **Published** (default) or **Draft** (to try a change before publishing) |
| Inputs | the flow's items, plus Run an Agent's optional **Chat Model**, **Memory** and **Tool** slots: whatever is connected goes to the **lead**, so a flow keeps its model or a tool such as a GitHub branch check on the team node |
| Outputs | **Done** and **Needs a person** |

Done carries `{ reply, team: { id, name, version }, members: [{ title, asked, tokens, overBudget?, estimated?,
inputTokens?, outputTokens?, cacheReadTokens?, costUsd?, model?, requests?, ms? }], usage, activity }` (`usage` is the
whole team's `{ inputTokens, outputTokens, costUsd? }`: the lead, its agent members and what remote members reported).
A member's cost is its agent's model price (Ollama's is free), or for a Claude Code member on kagent what its
landflow-harness mod reported, priced ([a2a.md](a2a.md#the-landflow-harness-mod)); `ms` is the time it spent on its
requests (the lead's whole run). Needs a
person the same plus `reason`. `activity` is what the run did, for the canvases: `{ durationMs, turns: [{ member, start,
end }], moments: [{ at, member, tone, text }], steps: { <title>: count } }` (times in milliseconds since the team started). A team that was never published, a deleted team or an empty message fails the node (or the item, with
Continue on fail), like Run an Agent does. The node shows the team's name under its title (the hidden `teamName`
parameter, filled in when the team is picked or turned from a lead), the lead's face instead of the team icon, and every
member's face and title above it.

### How a team run goes

1. The lead runs as a Landflow agent through the same loop as Run an Agent (`runAgent`), with the team's goal in front of the
   message and one tool per direct report: `ask_<title>` (lower snake case: `ask_tech_lead`), described by the member's role
   and "<title> reports to you", with `message` and a required `reason`. The reason is recorded with the request. Every
   member that runs as a Landflow agent is also told, under *Your tools in this run*, the tools it has here, and that a
   tool its instructions name but the list doesn't (written for another flow, like a `Check_branch` the flow doesn't
   connect) isn't there: not to say it used it or what it would have returned.
2. A **Landflow agent** member runs its own loop when asked, with *its* reports as tools, so a team can have several
   levels. It keeps one session for the whole run: a second ask continues the first. Tools of its own agent that need
   approval are refused (nobody is there), as for any agent in a flow.
3. A **remote** member is called over [A2A](a2a.md) with the tool of the `a2a` capability, keeping **one A2A conversation
   per member for the run** (its context id lives on its manager's session). The title, not the card's name, is what the
   journal and the trace call it.
4. **Goal ancestry.** Every request a member gets starts with `Team goal: …` and `<manager>'s current task: …` (the
   manager's own task, cut to 600 characters), then the message. An answer to a remote member's question goes as it is.
5. **Questions.** A remote member's question goes to its manager by default (`questionsTo: manager`): the manager gets it as
   the tool result and answers with its next call to the same member. With `questionsTo: person` **the run waits for a
   person**: the question passes up to the lead (through every manager in between), the node pauses on a form (`<Member>
   asks`, the question, an Answer field; it shows under Needs you), and the team's state is kept with the node: every
   session, what each manager was told and heard, the review ledger, budgets. The answer goes down to the member's paused
   A2A task, and the team goes on from there; the node's activity joins the turns before and after. Outside a flow (a run
   that can't wait) the old way stays: the manager is told a person will answer, and the run leaves by **Needs a person**
   with the question. Tool approvals a remote member waits on are refused, as everywhere in a flow.
6. **Reviews.** A review is seen to by the nearest manager of both the reviewer and the reviewed (their own manager when
   they share one; the lead when the Reviewer sits under QA and the Developer under the lead). That manager, giving its
   final answer while the work has not been looked at (the reviewer was not asked after the work came back), is told to
   ask the reviewer first (`Ask Reviewer through QA (ask_qa)` when it isn't a direct report), and its loop goes on: at most
   twice. A reviewer's `VERDICT:` line is the sign-off: `VERDICT: CHANGES` (or request changes, reject) holds the manager
   too, until the work came back and the reviewer was asked again (`Send them to Developer (ask_developer), then ask
   Reviewer (ask_reviewer) to review it again`). Still unreviewed, or changes never reviewed again, the run leaves by
   **Needs a person** and a failed *Review* check is recorded; a review records a passed check (`approved` with
   `VERDICT: APPROVE`, `was asked` without a verdict) or a warn one for changes. A reviewer above or below the member it
   reviews isn't held to it: a manager reads its report's work when it comes back.
7. **Budgets.** Tokens are counted per member: a Landflow agent's model usage, a remote member's A2A usage, and for a
   Claude Code member on kagent what the landflow-harness mod reported for each request (cache reads included). A remote
   member that reports none is estimated from what crossed the wire (its requests, answers, and its steps' arguments and results,
   about four characters a token): a floor, so it stops late rather than early. The estimate counts against its budget
   (the check says `about … (estimated: it reports no usage)`, and `members[]` marks it `estimated`) but not in the team's
   `usage`. At 80% a warn *Budget* check is recorded, at 100% a fail one: an agent member stops (`budget`), and its tool
   answers that it is over budget and is not called again. The lead's budget stops the lead at the limit and routes the
   run to Needs a person.
8. **Answers from what was reported.** A manager (the lead, or a member with reports) is told to name only the files,
   tests, commands and results its reports gave it. Its final answer is checked against its task, its reports' answers
   and steps, and its own tools' results for what it could make up: file names (`get-alerts.ts`, `PLAN.md`, or the last
   part of a path), commits (a short SHA counts when a report gave it in full), test counts (`14/14 tests`, `3 tests
   passed`, `Tests passed: 14/14`: each number has to sit next to a test word in what it was given) and pull requests
   (`PR #7`, `/pull/7`). Anything nothing gave it sends it back once to answer the person again without it, told the files
   its reports did name (or that none did) and to say where its instructions ask for something no report gave; a warn
   *Grounded* check is recorded. Its next answer replaces that check: a pass when the details are gone, a warn when it
   still names them. Then the answer stands with a note after it, `(Not in any team member's report: index.ts, utils.ts.
   Check before relying on them.)`, so a comment or ticket posted from it doesn't pass them off as reported. A manager
   that asked nobody is not checked.
9. The run ends when the lead answers. Its answer is `reply`; the lead's other ends (iteration limit, budget) go to Needs a
   person with a reason, an error fails the node.

### Watching a team work

While a Run a Team node runs it reports who works now and on what (`node.progress`, folded from the lead's stream, and
from the stream of every member that is a Landflow agent, by
[`lib/shared/team-progress.ts`](../apps/web/src/lib/shared/team-progress.ts)): so the Tester a Developer asks shows at work
too ("Developer asked the Tester"), and the Developer's own tools fill its ticker. The report holds the member working, what it does as the step
reads ("Bash: pnpm test") and in plain words ("Running the tests"), the command, how many steps it took in this turn, its
last five steps, every member's state (idle, working, done, failed) and how often it was asked, each member's turns, and
the moments that matter. On the editor's canvas during a run and on the execution view of a running execution
([`components/editor/team-live.tsx`](../apps/web/src/components/editor/team-live.tsx)):

- **The node becomes the worker.** It wears the working member's face, title and colour (the running frame too), with the
  lead's face as a small badge ("for Tech Lead"); the line under the title says what it does in plain words, then the exact
  command in small mono, then the clock and the step ("1:06 · step 5"). When the lead takes over again, the node swaps back.
- **A ticker** under the head shows the last three steps, each with a check, a cross or a spinner and how long it took.
- **A ribbon** at the bottom of the node has one segment per turn in that member's colour, growing while it works. Tap a
  segment to open that member in the Run Trace (`/runs/<execution>?tab=team&member=<title>`: the Team tab with the
  member's sheet open); from the editor it opens in a new tab so the flow stays open.
- **Budget bars.** A member with a token budget gets a bar under the ticker (the member at work, and any member past 80%)
  that turns amber at 80% and red once used up, with "42k / 60k" beside it (`~` when estimated: a remote member that
  reports no usage). Tokens move after each model call of the lead and of agent members (`onUsage` in
  `agents/runtime.ts`), mid-task for a Claude Code member whose landflow-harness mod reports them, and when a member
  answers. The report's `usage` lists each member's tokens and budget.
- **The roster** above the node shows faces only: the member at work is ringed in its colour, done members have a check,
  one that failed is ringed red and members not asked yet fade.
- **Moments** appear above the roster for 25 seconds: "Asked the Reviewer", "Tests failed · exit 1", "14 tests pass",
  "Typecheck passed", "Pull request #4 opened", "Branch pushed", "Reviewer: approve" or "Reviewer asks for changes" (from a
  `VERDICT:` line in the answer), "Developer failed", "Developer used 80% of its budget" (amber), "Developer used up its
  budget", "Planner asks a person" (amber, with the question).
- **A question for a person** turns the node amber: the asker's face with an hourglass, "Planner asks a person", the
  question, and an **Answer** button that opens the run's waiting form (`/form/waiting/<execution>`); the answer goes back
  to the member that asked. The node reads it from the waiting execution's `wait.data.teamQuestion`, so a reload or
  another device shows the same; on a phone the execution view pins a **Needs you** card with the question in full.

Plain words come from `narrate()`: a shell command reads by what its chain ends with (`cd x && pnpm install && pnpm test`
is "Running the tests"; also installs, typechecks, lint, builds, clones, commits, pushes, `gh pr create` and `gh pr merge`),
Read and Edit name the file, Grep names the pattern, a web fetch names the host, and a tool with no rule keeps its name as
a sentence ("Check branch"). Captions of other nodes that report progress (an A2A Agent node) use the same words, with the
exact step in their tooltip.

After the run the node keeps the ribbon, a one-line summary of its output's `activity` (the results that mattered and
each member's step count) and each budgeted member's bar (`activity.usage`), in the editor and on the execution view. A
run that waited for a person keeps one activity across the wait: the second part's turns and moments follow the first's,
and its usage carries on, so 80% isn't told twice. The team's page shows a **Last run** card: the flow and time (a link
into its Run Trace), each member's tokens against its budget, and the run's last results (`GET
/api/agent-teams/:id/last-run`). The execution view's **Agent session** panel follows
the lead's session live, its header names the member working ("Tech Lead · Reviewer working"), and it gives way to the
canvas on a short screen so the flow stays in view. On a phone the execution view pins a **Now card** over the canvas or
the Run Trace: the face, a sentence ("Reviewer is running the tests"), the command, the ticker and a way into the Run Trace;
and the workflow's executions page shows the list and an open execution one at a time, with a back arrow to the list.

### In the Run Trace

The journal names members by title and records each request with its reason, under the request of the manager that asked
it (a developer's tester hangs under the developer). The node's span carries the team as it was when the run began
(`attrs.team`: id, name, version, goal, members with `reportsTo`, `reviews`, `budgetTokens` and `connections`), and the
**Team** tab draws the chart from it, as an indented tree with who reviews whom and how often each was asked, instead of
guessing from who called whom. Each row has chips for what the member [works with](run-trace.md#what-each-agent-works-with):
the lead's model, memory, tools and knowledge; a remote member on kagent's Claude Code, model, plugins and network
policies, with their own logos. A member with a budget has a bar under its chips, its tokens in the run against the
budget (amber at 80%, red once used up). The node's usage names the lead's model and counts its model calls. Runs without
a recorded team keep the generic who-called-whom graph. The **Story** tab opens with the team's **Headlines**: the moments
its node kept (see [Run Trace](run-trace.md#headlines)). A team member's question waits as a form: Needs you's **Answer**
opens the run's form page.

### Turn into a team

On a canvas, a selected **Run an Agent** node that has **A2A Agent** (or Run an Agent) nodes attached as tools gets a
**Turn into a team** button in its toolbar. It saves a team (the lead is that agent; each delegating tool is a member
reporting to it, titled by the node's name, with its notes or tool description as the role, its URL, options and
credential references, and `questionsTo: person` when the node sent questions to a person), publishes it when it can, and
swaps the lead and those tools for one Run a Team node in the same place and under the same name, so connections and
`$('…')` references hold. The lead's model, memory and other tools stay connected. It is one undo step (the toast has
Undo). A team that can't be published yet is left as a draft, and the node says to publish it. The graph rewrite is pure,
in [`lib/shared/turn-into-team.ts`](../apps/web/src/lib/shared/turn-into-team.ts).

### Spotlight

[Spotlight](assistant.md#spotlight) is given the published teams (names, ids, members by title and who reports to whom),
in its context and in the docs of `core.runTeam`, so "run the plugin team on this" proposes a Run a Team node with that team's
id. A model that writes the team's name or its lead's title where the id goes ("Tech Lead") has it turned into the id, with
`teamName` filled in, before the proposal reaches the editor. It has a `turnIntoTeam` op (`{"op":"turnIntoTeam","node":"<lead>"}`) for "turn the Tech Lead and its agents into a
team": applying the proposal does what the toolbar button does.

### What is not enforced

- Only Landflow agents lead or manage; the lead must be a Landflow agent.
- A reviewer that manages the member it reviews (or reports to it) isn't held to the review; a verdict is read from a
  `VERDICT:` line only.
- A middle manager's own budget is enforced for agents asked as members; the lead's is checked by the session limit.
- Heartbeats, a task backlog, consults and hand-offs between peers are not built.
