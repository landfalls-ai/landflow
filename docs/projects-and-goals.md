# Projects and goals

What a project is, the company mission, the goals a company sets and the projects that serve them, and the brief that
says what a project is for. Part of the [Landflow docs](README.md).

In one sentence: people declare goals, the [second brain](second-brain.md) finds initiatives, and a goal links the
initiatives that serve it.

## What a project is

Every workflow, credential, data table and agent belongs to one **project**. Each user has a personal project; owners and
admins make team projects and give members a role there: admin, editor or viewer. Members see only their projects'
items and what is shared with them. The full rules (sharing, moving, deleting, SSO mapping) are in
[Authentication](features/authentication.md). A project also has a brief, and it serves goals.

## The mission

One company per instance, so the mission lives in **Settings → Company**: a name (up to 120 characters) and a mission (up to
500). Owners and admins change them; everyone reads them. The Goals page shows the mission above the goals, and an agent's
block starts with it. `GET /api/settings` returns it as `company` (and inside `settings`); `PATCH /api/settings` takes
`{ company: { name?, mission? } }` and `null` clears one. A change is audited as `settings.update` with the fields.

## Goals

A goal is something the company or a project wants. Each has:

- **Title** (up to 200 characters) and **why** (up to 2000): what it is, and why it matters.
- **Level**: `company` or `project`. A project goal belongs to one **home project**, and its admins edit it.
- **Status**: `planned`, `active`, `achieved` or `cancelled`. Cancelled goals stay in the tree; they are never a primary goal.
- **Owner**: a user. **Target date**: `YYYY-MM-DD`.
- **Parent**: goals form a tree, four levels deep at most (a root is level 1). A company goal's parent is a company goal; a
  project goal's parent is any goal its creator can see. Cycles are refused.
- **The projects that serve it.** A project serves up to 10 goals, in an order its admins set. Its first `planned` or
  `active` goal is its **primary goal**. Creating a project goal adds it to its home project. A company goal can name the
  projects that serve it when it is made (each one you must admin), and project admins add company goals later with
  `PUT /api/projects/:id/goals`. A project goal can only be served by its home project.
- **Linked initiatives.** Initiatives are found by the brain, not typed in. A goal links up to 50 of them, each a brain
  entity of type `initiative` the editor may read. Links to initiatives you can't read are kept when you change the rest.

Progress against a goal is read in [Progress](#progress).

## The brief

A project's brief, set by its admins (all fields optional, `null` clears one):

| Field | Limit | What it is |
| --- | --- | --- |
| `brief` | 1500 characters | What the project is and why it exists |
| `constraints` | 1000 | What must hold: budgets, tools you can't use, deadlines |
| `doneWhen` | 600 | How you will know it is finished |
| `glossary` | 800 | "Words we use": terms the team means something specific by |
| `status` | `planned`, `active`, `paused`, `done` | Where the project is |
| `targetDate` | `YYYY-MM-DD` | When it should be done |
| `leadId` | a user | Who leads it |
| `decisionOwnerId` | a user | Who decides when the team disagrees |

The lead and the decision owner must be existing users with a role in the project (a member, the owner of a personal
project, or an instance owner or admin, who are admins of every project), or the change answers 400. Renaming a project keeps its
brief. `GET /api/projects/:id` returns it as `project.brief`, with the names of the lead and decision owner, the goals the
project serves in order (`goals`) and `canEdit`.

## Who sees and edits what

| | Company goals | A project's goals | A project's brief |
| --- | --- | --- | --- |
| See | everyone signed in | members of the project; owners and admins see all | members |
| Edit | owners and admins | admins of that project (and owners and admins) | admins of that project (and owners and admins) |

Deleting a project deletes its own project goals with their initiative links and removes its goal rows; sub-goals of a
deleted goal move up to its nearest remaining parent (or become roots), and company goals the project served stay. Its project-level
practices are retired (not deleted, not moved by `transferTo`; [practices.md](practices.md#reject-retire-waive)). Its AI budget
and incidents are deleted, the meter forgets the cached budget, and open requests to raise its cap are withdrawn (their
waiting runs stop waiting). A
company goal serves up to 50 projects. `GET /api/goals?projectId=` for a project you can't see answers an empty list.

A viewer who can't see a goal's parent sees the goal as a root. A member never sees another project's project goals: they
are left out of lists and answer 404. The mission is everyone's to read.

## The screens

These are built by the screens wave (PC02).

- **Goals page**: tabs **Projects | Goals**. The Goals tab shows the mission, then the tree on a desktop and cards on a
  phone, with a **New goal** button where you may add one.
- **Goal dialog**: title, why, level, status, owner, target date, parent, the projects that serve it and linked initiatives.
- **Project Overview**: a brief card with the fields above, the primary goal and the other goals it serves.
- **Settings → Company**: the name and mission.

## The API

All routes need a signed-in user or an API key with workflow scopes; the rules above are checked in each route.

| Route | What it does |
| --- | --- |
| `GET /api/goals?projectId=&status=` | The goals you can see, as a tree (`goals`), the `mission` and `canCreateCompanyGoals`. At most 500 goals. |
| `POST /api/goals` | `{ title, why?, level, status?, ownerId?, targetDate?, parentId?, projectId?, projectIds? }` → 201 `{ goal }`. `projectId` is required for `level: project` and refused for `company`. |
| `GET /api/goals/:id` | `{ goal, chain }`: the goal and its parents, root first. 404 when you can't see it. |
| `PATCH /api/goals/:id` | `{ title?, why?\|null, status?, ownerId?\|null, targetDate?\|null, parentId?\|null }` → `{ goal }`. |
| `DELETE /api/goals/:id` | `{ ok: true }`; it also leaves the projects that serve it and unlinks its initiatives. A goal with sub-goals answers 409 `goal_has_children` ("Move or delete its sub-goals first"). |
| `PUT /api/goals/:id/initiatives` | `{ ids }` (at most 50) → `{ goal }`. 400 names ids that are not initiatives you can read. |
| `GET /api/projects/:id/goals` | `{ goals }` in order. |
| `PUT /api/projects/:id/goals` | `{ goalIds }` (at most 10) replaces the list and the order. |
| `PATCH /api/projects/:id` | gains `brief: { brief?, constraints?, doneWhen?, glossary?, status?, targetDate?, leadId?, decisionOwnerId? }`. |
| `GET/PATCH /api/settings` | gain `company: { name?, mission? }`. |

Audit events: `goal.created`, `goal.updated` (each changed field, from and to), `goal.deleted`, `project.goals_changed`
and `project.brief_changed`. The company profile rides on `settings.update`.

## What an agent sees

An agent's run gets a short "Where this work fits" block: the mission, the project's brief, and its primary goal with the
chain above it. How the block is built, how big it gets and how to turn it off are in
[agents.md](agents.md#project-context). What a past run saw is kept and shown: see
[What an agent saw](#what-an-agent-saw).

## What an agent saw

Each agent run keeps the block it got. A Run an Agent step, and a team member's request, writes a `saw` attribute on its
span once per run: the text the system prompt got, the mode (full, compact or off), the project and goal, the run's
pinned time, a short persona summary (role, mission and what-I-do, each at most 300 characters; never the instructions)
and the approved practices it was given. An approval that resumes the run does not write it again, since a resume reuses
the first run's block.

The Run Trace shows it as **What it saw** in the agent's sheet, and an agent's **Sessions** tab as a **What it saw** fold
under each session. Both split the block into the goal chain, mission, brief, words, status, this run and practices,
leave out the empty ones, and fold out the exact text. With the project context off the section says so. A run's root
span also shows **Project** and **Goal** chips. The page is [run-trace.md](run-trace.md#what-it-saw).

## Agents across projects

An agent has one home project, and the home decides who edits it. It can also be **available** elsewhere: shared with
chosen projects, or with **All projects** in one click. A project that only uses an agent can pick it in Run an
Agent and run it from its workflows, but cannot change, delete or share it, and reads only the sessions of its own project ([below](#sessions-belong-to-a-project)).

- **Sharing.** `GET|PUT /api/agents/:id/shares` (admins of the home project, owners and admins may change them). The
  answer has `availability` (`home`, `all`, and the projects the caller has a role in) and `shares`. The "All projects"
  row is a share with the project id `*`; it shows only as `availability.all`, and only agents can have it.
- **Pickers.** `GET /api/agents?availableIn=<projectId>` lists the agents a project can use (404 for a project the caller
  has no role in). The Run an Agent node lists the agents available in the workflow's project, and a shared one says
  "From <home project>". Without a project, everything is listed as before.
- **Test in project.** The test chat with a `projectId` the agent is not available in answers 403 "This agent isn't
  available in that project".
- **Sessions stay in their project.** See [Sessions belong to a project](#sessions-belong-to-a-project): sharing an agent never shares its sessions.
- **The live feed too.** `/api/events` sends an agent's `entry` and `run.finished` events (the session itself) only to
  members of the project the session ran in who can read the agent, and to owners and admins.
- **Still readable by a user project.** Because a share gives `read`, a project that only uses the agent can still list
  the file names of its knowledge base and save it as a template. Its secrets and sessions stay hidden.
- **Evaluations stay at home too.** The online evaluation scores and the eval gate carry session inputs and outputs, so
  they are home-only (404 for others), and a home member's list of scores holds only the graded replies of sessions they
  may read (the totals and the trend stay the agent's own counts); the Run an Agent and tool pickers scope to the agent's
  home project only for its home members.
- **All projects replaces single shares.** Turning **All projects** on drops the single-project rows; turning it off
  later leaves the agent home-only. `availability.projects` lists only projects the caller has a role in, so build a
  `PUT` from `shares`, not from it.
- **Brain and spend.** Whoever can read an agent (a share counts) sees its brain facts, suggestions and spend, which
  come from runs in every project.
- **No wall at run time.** A saved workflow that runs another project's agent keeps working, even after the share is
  removed. This holds only while the project's agent allow-list is off; once it is on, a run in the project may use only
  the agents it lists ([Project settings for agents](#project-settings-for-agents)).

## Testing an agent in a project

An agent keeps its home project, and its admins can make it available elsewhere: **Make available…** in the builder's
⋯ menu lists the projects as checkboxes, with **All projects** (which disables the others). Only admins of the home
project change it; everyone else sees the list read-only. The Agents list shows where each agent is available ("Available
in Operations, Billing revamp", at most two names and "+N", or "All projects") and, for one shared into your project,
"Shared from <project>". The routes behind it are in [reference/api.md](reference/api.md).

**Test in project.** The test chat has a project picker above the conversation (home first, then the projects the agent
is available in, by name). The chat is given that project's block, and the picker starts a new conversation when it
changes, because the block is part of the run. A project the agent isn't available in answers 403, and the chat says
"This agent isn't available in that project" in the conversation.

**What it will be given.** The button beside the picker opens the text a chat in that project would get: the
"Where this work fits" block in the agent's Project context mode, then the approved practices after it. It reads only
and records no delivery. The same text appears in the persona tab's **View prompt**, in the place the run puts it (after
the skills, before the date line), for the agent's home project. The preview is for editors of the agent: a share to use
the agent does not show the home project's brief.

## What a goal costs

Each AI call a run makes is stamped with the goal that run served. The AI page (Insights → AI) has a Goal option in
"Spend by", after Project. Each row is a goal's title with its cost, tokens and calls.

- Calls with no goal are "No goal".
- A goal you can't see (a project goal of a project you aren't in) is "Another goal", never its title. Owners and
  admins see every goal.
- A goal that has been deleted is "Deleted goal".
- The calls counted are the same ones the rest of the page counts: your own, and those of workflows and agents you can
  read. Grouping by goal never adds calls, so the goal rows add up to the totals.
- On a phone the six options share the width of the control.

## Repositories and harnesses

A project lists the repositories it works in, so a harness (Claude Code with the landflow-brain mod, the CLI, any MCP
client) finds the project of the repository it is in and loads its goals. Repositories are `owner/name`, lowercased, at
most 20 per project, and a project's admins set them (`PATCH /api/projects/:id { repos }`; the same rule as a practice's
repositories). The project's **Settings** tab has a **Workspace** card to add and remove them (see [Workspace](#workspace)).

- **By repository** (`GET /api/projects/context?repo=acme/web`): the projects you have a role in that list it, sorted by name.
  A repository can belong to several projects; you get the first one's block and the list of all.
- **By id:** a project you have a role in; without one it is 404.
- **Over MCP:** the `project_context` tool and the `project://{id}/context` resource. A server scoped to one project reads
  that project only.
- **The block** is the one Landflow's own agents get (compact or full), built by the same provider, with the run line "a
  request over MCP". It is data, not instructions.
- **The morning briefing** (the `morning-briefing` MCP prompt) names your open goals, at most 5 by project.
- **Spotlight and the Agent architect** read the compact block of the project they build in: Spotlight of the workflow's
  home project, the architect of the project named in the request (`projectId` in the body; the Agent dialog does not send it yet). With no project,
  they get nothing extra.

Details and the routes: [connect-your-harness.md](connect-your-harness.md#project-context).
How a harness works in those repositories (branch, setup commands, worktree) is the project's [workspace](#workspace).

### In Claude Code and the shell

At session start the landflow-brain mod (0.4.0) asks `GET /api/projects/context` for the project that lists the repository you are in and adds its compact "Where this work fits" block as its own section, before the practices; `/brain project` shows it on request ([landflow-brain-mod.md](landflow-brain-mod.md#project-context)).
In any other harness, `landflow work context` prints the same block ([cli.md](features/cli.md#recording-your-day-landflow-work)).

## Picking a goal for a workflow or team

A workflow or a team can name the goal it serves; with none, it works for its project's goal.

- **A workflow**: the **Goal** field in the workflow's settings (first under **Advanced**, so the basic settings keep their three fields). Its first choice, **The project's goal**, means
  inherit; the workflow's own project's goals come first. It saves `settings.goalId`, left out when inheriting.
- **A team**: the **Project goal** field on the team page, under the team's own **Goal**. The two differ: **Goal** is
  free text, what the team is for; **Project goal** picks one of the goals in the tree. It saves the team's `goalId`.

Both use the same picker as the goal dialog and the project brief. The team's member picker is in [agent-teams.md](agent-teams.md#picking-members).

## Project settings for agents

A project can set four things for the agents that run in it, next to its allowed nodes, approvers and four-eyes
(`GET|PATCH /api/projects/:id/settings`, the project's admins). Each is off by default, each only narrows or fills a
gap, and with none set a run, its prompt, its tools and its cache keys are what they were. The screen for them is the
project page's **Agents in this project** card; the fields and answers are in [the API](reference/api.md).

- **Default model.** An agent that runs in the project and has no model of its own uses this one. The order is: the
  workflow node's model (Run an Agent), the model router's cheap model when it sends the run there, the agent's own
  model, then the project's default. With none of them the run fails as before ("Choose a model for this agent first").
  The Run Trace names the model that answered. A credential in it must be usable in the project and of the provider's
  type.
- **Knowledge base.** One knowledge base (a vector collection or a plugin's) every agent in the project can search, as the
  tool `project_knowledge` ("Project knowledge" in the timeline). It is added after the kinds are filtered, so the list
  of kinds never withholds it, and a broken one (a plugin node that is gone) is a "Tool unavailable" notice, not a failed
  run. Its credentials must be usable in the project. The collection name is global, as an agent's own is.
- **Allowed agents.** With **Only these**, an agent runs in the project only if it is the project's own (always) or on the
  list; the list holds only agents available in the project. An agent that isn't allowed fails its run with "“Writer”
  isn't allowed in project “Payments” (Project settings → Agents)", with no model call. Run an Agent nodes, team
  members and sub-agents all reach the same check, so a sub-agent that isn't allowed is a failed tool call. The pickers
  (Run an Agent, `GET /api/agents?availableIn=`) list only agents that are available **and** allowed; the Agents page
  lists everything.
- **Allowed tool kinds.** With **Only these**, an agent in the project gets only tools of the listed kinds: nodes, MCP
  servers, knowledge bases, workflows, sub-agents, A2A agents. A withheld tool shows as a notice "Tool access: <tool>
  withheld by project “P” settings". Skills, memory, a team's own tools (its notebook, consults, reports and hand-offs), the project's own
  knowledge base and the tools connected to a Run an Agent node (already under the node allow-list) are never withheld.

The run reads the settings once, when it starts (they are cached for a second). Each level narrows: instance, project,
workflow, and now agents ([governance](features/audit-and-governance.md)). A2A and kagent agents run elsewhere, so the
allow-lists do not cover them.

### The Agents card

A project's **Settings** tab has the card **Agents in this project** (`#agents`), under the governance and MCP cards.
It holds the **Default model** ("Used when neither the workflow's step nor the agent names a model"; pick **None** to
clear it), the **Knowledge base** (a switch and **Choose…**, which opens the agent builder's dialog; every agent in the
project can search it as `project_knowledge`), **Allowed agents** (**Everything available** or **Only these**, with the
project's own agents checked and disabled) and **Allowed tools** (**Every kind** or **Only these**, one box per kind).
Project admins edit and press one **Save**, which sends only these four fields to `PATCH /api/projects/:id/settings`; a
400 (a credential the project can't use, an agent that isn't available) shows under the field the save sent, or below
the card when it sent several. With a provider and no model, Save stays off and the bar says "Choose a model". Everyone
else reads the values, the two modes as plain text. Without `availableAgents` in the answer the list says "No agents to list". A failed load hides the card without a toast.

## Sessions belong to a project

A session is read and continued only from the project it ran in; sharing an agent never shares its sessions. A
session's project is the one its run resolved (the caller's, the workflow's, the team's or the agent's home), saved as
`projectId` in its summary. A session with no project (one saved before wave 7) follows the agent's home now: move the
agent and those sessions move with it, while a session with a project stays where it ran.

- **Who reads a session:** instance owners and admins; anyone who can read the run that started it (so a member of a
  project that only uses the agent opens the Run an Agent panel of their own run); anyone with a role in the session's
  project who can also read the agent. A home member with no role in project B no longer reads the sessions, ratings
  or graded replies the agent had in B. A session of a deleted project is read by owners and admins only.
- **Who continues one** (a message, an approval, a rating or comment, a delete): who reads it and is an editor or admin
  in its project (owners and admins always), on top of the route's guard (`run` on the agent). Others get 404
  "Session not found".
- **The list.** `GET /api/agents/:id/sessions` answers 200 with only the sessions the caller may read; the store cuts by
  project before the page, so a page is full. `?executionId=` answers with that run's sessions for whoever can read the
  run, and 404 otherwise.
- **The test chat** keeps a session in its project: a `projectId` that is not the session's answers 409 "This session
  belongs to project “P”: start a new session there".
- **Live and evaluations.** The live feed sends a session's events to members of its project; a list of an agent's
  ratings and the online evaluation scores keep only those of sessions the viewer may read.

## AI budget

A project can have a monthly AI budget. It is one more cap in the same system as the caps on workflows, agents,
credentials and people ([llm-gateway.md](llm-gateway.md#asking-for-a-higher-cap)): it is listed on Insights → AI with the
others, its alerts are the cost alerts, and "Ask for more" goes through the cap-raise flow. What a cap has not got, the
budget adds: a warning, an optional hard stop, incidents and Needs you items.

- **The budget.** Dollars per calendar month, counted in the instance time zone. The spend is every AI call of the
  project this month from every source: Landflow's own calls and the calls LiteLLM reports (kagent and Claude Code
  agents). `0` means no budget, and nothing is watched or stopped.
- **The warning.** Once spend reaches the warning share (80% by default, 1 to 100) a warning opens, once for each budget
  amount. Dismiss it, or raise the budget. A raise lets a new warning open at the new amount. The cost alerts of
  Insights → AI send the message; the warning itself is a Needs you item. That message says what happens at 100%: with
  no hard stop, calls keep running and the project's admins are told; with it, priced calls are refused and local models
  keep running.
- **The hard stop.** Off by default. When it is on and spend reaches the budget, the project's **priced** AI calls are
  refused with "AI usage cap reached: project “Name” this month used … of its … limit", and a stop opens in Needs you.
  It never stops a local model (Ollama and others without a price), and never a model only the gateway prices. Calls
  of kagent and the Claude Code harness count towards the budget but are not stopped: they go to LiteLLM directly.
  Spend that arrives by import, which no call check saw, opens the stop too.
- **Resume.** A person resumes a stop, and the project's priced calls go on until the month ends. A new month starts a
  fresh count. A resumed month stays open even after a raise.
- **Raise.** A project admin sets a higher amount from a stop or a warning, or saves a higher budget. Every way of
  raising (an incident's **Raise budget…**, a `PUT` with a higher amount, an approved request) settles all the month's
  open incidents as `raised`, so a raise from a warning never leaves a stop open. An editor who is not an admin asks for more from Insights → AI ("Ask for more"); an approved request sets the new
  amount and settles the month's open incidents.
- **Dismiss.** Puts a warning away for the month.
- **Who may do what.** Project admins and instance owners and admins edit the budget and raise it. They and the
  budget's **owner** (any user with a role in the project) resume and dismiss. Any member reads it. Items in Needs you
  go to the admins, the owner and instance admins.
- **Where it shows.** The budget view (`GET /api/projects/:id/budget`), Insights → AI as the cap
  `project:<id>:month:cost`, and Needs you (`GET /api/runs/needs-you`, a `budget` item with a link to the project's
  settings). The screens are built in the project's Settings tab.
- **Deleting the project** deletes its budget and incidents. Moving a workflow or agent to another project moves no
  budget: spend follows the project the run was in.
- **Not here.** A budget per goal, and a LiteLLM team budget ([llm-gateway.md](llm-gateway.md#budgets-in-litellm)).

Routes: `GET` and `PUT /api/projects/:id/budget`, `POST /api/projects/:id/budget/incidents/:incidentId` with
`resume`, `raise` or `dismiss` ([reference/api.md](reference/api.md)). Each change is audited: `project.budget.update`,
`.stopped`, `.resumed`, `.raised` and `.dismissed`.

### The AI budget card

The card **AI budget** (`#budget`) follows **Agents in this project**. It shows this month's spend as a bar (amber from the warning percent, red
at 100 or when paused), the amounts, "N calls to local models (not counted)" and a **Paused** badge, then the month's
incidents, newest first, each with its buttons: **Resume this month** and **Raise budget…** for a stop, **Dismiss** for a
warning. Admins edit the monthly budget, **Warn at**, the **Hard stop** switch (off by default) and the owner (one of the
project's members) and press **Save**; `0` asks "Remove the budget?" first (a sheet on a phone). With no budget, Save
shows only once an amount is typed: Warn at, Hard stop or the owner alone save nothing. An editor who is not an admin sees **Ask for
more…** (an amount above the budget and a reason, sent to `POST /api/ai/cap-requests`) and **See it on Insights → AI**.
Open `/projects/<id>?tab=settings#budget` or `#agents` and the page scrolls to the card once it has loaded. The same
incidents are items in **Needs you** ([run-trace.md](run-trace.md#needs-you-for-a-project-budget)).

## Workspace

A project says how agents and harnesses work in its repositories. It is the **Workspace** card on the project's **Settings**
tab, under the project's settings and above Variables. Landflow stores and serves it. It never runs a setup command and
never makes a worktree.

- **Repositories:** the list from [above](#repositories-and-harnesses). Admins add (`owner/name`) and remove them on the
  card; each change saves at once. A repository removed here (or through the API) drops out of the workspace, and its stored branch and setup lines are
  deleted, so adding it again starts empty.
- **Default branch**, per repository: the branch a run starts from. Empty means the repository's own default.
- **Setup commands**, per repository: one per line, at most 10 lines of 300 characters, run once in a fresh worktree. Only
  the project's editors and admins see them (viewers see the repositories and branches). **Landflow never runs these. A
  harness may, in its own sandbox.** A harness that does should show them to a person first.
- **Worktree:** **One per run** (the default; each run gets its own git worktree) or **Shared** (runs use one checkout).
- **Branch template:** the branch a run works on, for example `landflow/{project}/{run}`. Tokens: `{project}` (the project's
  slug), `{run}`, `{date}`, `{task}`. The card shows an example and says why a template is not allowed (an unknown token, or
  a result git would refuse).

Admins edit with one **Save workspace**; everyone else reads. `GET /api/projects/:id/workspace` and `PUT` are in the
[API reference](reference/api.md); every change is audited as `project.workspace.update` (repository names, worktree and
template; the count of setup lines, never their text). Saving the same workspace again writes nothing and audits nothing.

A harness reads it from the project's context ([connect-your-harness.md](connect-your-harness.md#project-context)): the
answer has `workspace` when the project saved one, with `branchPattern` (the template with `{project}` filled in;
`{run}`, `{date}` and `{task}` are the harness's to fill) and setup lines only for editors and admins.

## Progress

A goal shows what moved it: runs, AI spend and work updates in the last 7 or 30 days. Each number counts the goal and every
sub-goal below it (the sub-goals you can see), and counts only what you may see. Two people can see different numbers for the
same goal.

- **Runs:** finished runs (status `success`, or `error` as a failed run) of the workflows whose home is a project that serves
  the goal or a sub-goal, or a project goal's own project, among the projects you may see. A running, waiting or cancelled
  run is not counted. Evaluation cases (runs with an evaluation run id) are not counted. A workflow with no project row is
  homed in the default project (the owner's personal one), so its runs count there. One run is one `executions` row, so a
  sub-workflow's child run and a manual test run in the editor each count. A run of a workflow shared into the project
  from another home is not counted. Runs of a deleted workflow with no project row still count in the default project
  while their rows are kept.
- **Spend:** the AI cost attributed to the goal or a sub-goal (`ai_usage.goal_id`), from projects you may see. It can be 0
  while runs are not (local models are unpriced).
- **Updates:** work events (`work.*`) linked to the goal or a sub-goal: by its goal, by a serving project, or by a linked
  initiative (an initiative you can read, by its id or its name, in any case). They are read by the ledger's one
  visibility rule, as you: your own, `team` ones of people who share a project with you, and `org` ones. Another person's
  private work never counts for you, whatever your role; owners and admins are no exception. An answer carries counts and a
  time, never a title.
- **Moved:** something happened in the window (a run, an update, or spend). `lastActivityAt` is the newest of them.

`GET /api/goals/:id/progress?window=7|30` answers one goal (404 for a goal you cannot see, 400 for another window; 7 by
default). `GET /api/goals?progress=1&window=` adds `progress`, one entry per goal in the tree; without `progress=1` the
answer is as before (`progress` must be `1` and `window` `7` or `30`, else 400; `window` alone is also 400). Every goal in an answer is counted in one query per source, never one per goal. The
nightly sync uses the same numbers for its "Goals that moved" line ([work-and-briefings.md](work-and-briefings.md#the-nightly-sync)). Code:
`lib/server/goals/progress.ts`; the answer's shape is `lib/shared/goal-progress.ts`.

### On the Goals page and the Overview

- **Where the line shows.** Under the title of each goal on the Goals page (the desktop rows and the phone cards), in the
  goal's sheet, and on each row of **Goals it serves** on a project's Overview. The rows and cards show the last 7 days;
  the sheet has a **7 days | 30 days** switch.
- **What it counts.** `12 runs · 1 failed · 3 updates · $0.42 this week`: finished runs of workflows homed in a project that
  serves the goal or a sub-goal (the failed ones are part of the run count), work updates linked to it, and AI spend
  attributed to it. Zeros are left out; a small cost reads `< $0.01`; a goal with nothing says `No activity this week`.
  A dot before the line marks a goal that moved.
- **Who sees what.** You see only what you may see, so two people can see different numbers for the same goal.
- **If the host cannot say.** An older host or a failed answer shows no line and no error.

## Tasks

A project keeps tasks: work with a title, a status (`To do`, `In progress`, `Blocked`, `Done`, `Cancelled`), a priority, an
optional goal the project serves, an optional parent (one level: a sub-task of a top-level task), an **assignee** and,
for an agent, a **wake-up** schedule. A project has at most 1000 tasks. Members read them; editors and admins create,
change, delete, check out and ask for runs. The routes are in the [API reference](reference/api.md); the screens are the
project's **Tasks** tab (wave 10).

- **Assignee.** An agent must be available in the project ([agents across projects](#agents-across-projects)) and allowed by
  the project's agent allow-list ([settings](#project-settings-for-agents)); a person needs a role in the project. Both
  are checked when the assignee is set, so a member who leaves stays the assignee until someone changes it.
- **Check out.** One person holds a task at a time. **Check out** is atomic: when two people press it at once, one gets it
  and the other is told `Checked out by <name>` (409). Holding it already is fine. The holder or a project admin releases it.
- **Wake-ups only ask.** An agent task can carry a five-field cron in the instance time zone (`0 9 * * 1-5`). The leader
  looks every `LANDFLOW_TASK_WAKEUP_SECONDS` (60; `0` turns it off) for tasks that are `To do` or `In progress` and due,
  and asks for a run: a `requested` run, merged into one the task already has open. Nothing runs. A schedule that never
  fires (`0 0 31 2 *`) is refused when you save it. A task whose agent has left the project, is no longer allowed or is
  not published gets no request (the log says why, once a day) and keeps its cron (its next wake-up moves to the next slot). **Ask to run now** does the same
  by hand.
- **Approve in Needs you.** The request is a **Needs you** item for the project's editors and admins, with **Approve**
  and **Deny**. Approving needs a signed-in person (an API key or an MCP client
  gets 403 `session_only`). Only a `requested` run is decided; a second decision is 409 `Already <status>`.
- **The run obeys the project.** Approve checks again, at that moment, that the agent exists, is published, is available
  in the project and is allowed by its rules (409 with the message, and the run stays `requested`). It then starts the agent
  in the background through the same runner as the test chat, a schedule or a team, with the task's project (and goal) in
  its context. So the project's allow-list, its default model, the tool kinds it withholds and its
  [AI budget](#ai-budget) (the hard stop included) apply exactly as they do to every other agent run in the project. The
  agent's published version runs. The workflows its tools start run for the person who approved.
- **Where the run goes.** The run is `approved`, then `running` with a link to its **session** (source `Task`, in the agent's
  Sessions tab, readable by the project's members and no one else's); it ends `done` with the agent's reply, or `failed`
  with the reason (a refused agent, the budget's stop, the step limit). A tool that needs approval leaves the run `waiting`
  and is a Needs you item that opens the session; decide it there. The status is settled from the session whenever it is
  read, so a run finished elsewhere reads `done`, and one a restart cut short reads `failed` ("Landflow restarted before the
  run finished").
- **Deleting.** Deleting a task deletes its runs. Deleting the project deletes its tasks and runs with it; they are never
  moved to another project.

### The Tasks tab and Needs you

The project page has a **Tasks** tab after **Overview** (`/projects/<id>?tab=tasks`). Its toolbar has a status filter (All,
To do, In progress, Blocked, Done), a **Mine** toggle (tasks assigned to you or checked out by you) and **New task**
(editors and admins; it sits in the tab, not in the page header). The tasks are one card, grouped by status in the
server's order (In progress, To do, Blocked, Done, Cancelled), each row showing the title with a High or Low badge, the
assignee, the goal, the next wake-up ("in 20h", the cron in a tooltip) and the last run as a status chip with its age.
On a phone each task is a card (title and chips, assignee, last run) and the page scrolls sideways inside the tab
switch instead of overflowing. **Load more** appends the next page of the keyset-paged list. An empty project says "No
tasks yet", with **New task** for editors. `?tab=tasks&task=<id>` opens the tab with that task's dialog.

The **task dialog** (a bottom sheet on a phone) has the title, description, status, priority, goal (a picker limited to the
project's goals), and an assignee chosen from the agents available in the project and its members. For an agent the
**Wake-up** choice is None, Daily 9:00, Weekdays 9:00, Weekly Monday 9:00 or Custom (a cron field), under the line "A
wake-up only asks: the agent runs after someone approves it." and, once saved, the next wake-up. **Check out** and
**Release** (the holder, or an admin) show "Checked out by <name>" when someone else holds it; **Ask to run now** asks
for a run, and an open request answers "Already asked". **Last runs** lists each run's status, who asked and decided,
the reply folded under "The reply", **Open session** and, for a run that waits, **Approve** and **Deny**. A message from the
server about the assignee, the schedule or the goal shows under that field. **Delete** asks first. Viewers read the same
task as text.

A run that waits for a person is an item in **Needs you** (kind **Task**) for the project's editors and admins; it counts
in Home's tile and the rail's badge like any other. Its title opens the task (never a run); **Approve**, **Deny** and
**Open task** sit below it. A run waiting for a tool approval has **Open session** instead. Approve and Deny post to
`POST /api/task-runs/:runId` (session only) and reload the list; a 409 ("Already approved") shows under the buttons. See
[run-trace.md](run-trace.md#needs-you-for-a-project-task).

The red **Delete this project** card is the last card of the Settings tab: settings, Agents in this project, AI budget,
Workspace, Variables, then it. The card and its dialog say what goes where: what the project owns (workflows,
credentials, data tables, agents) moves to the project you choose, and its tasks with their runs, its own goals, its AI
budget and its workspace are deleted with it (its practices are retired). The dialog counts the tasks ("Its 12 tasks and
their runs … are deleted with it") from the project view's `taskCount`, so a project that holds only tasks is never
called empty.
## Export

**Export** in the project's header downloads the project as a Claude Code plugin: `PROJECT.md` with its brief and goals
next to its home agents and their skills, without people or ids ([marketplace.md](marketplace.md#export-a-project)).

## How it is built

- Data: migration 2300 makes `goals`, `project_goals` (a project's goals and their order) and `goal_links` (initiatives);
  migration 2301 adds the brief's columns to `projects`.
- Code: `lib/server/goals/` (`store.ts` the data and its audit, `views.ts` the rules and views, `schema.ts` the request
  bodies, `context-source.ts` the reader the context provider calls), `lib/server/projects/store.ts` (the brief),
  `lib/shared/goals.ts` (the types and limits both sides share).
- The AI budget: migration 2700 (`project_budgets`, `project_budget_incidents`), `lib/server/budgets/` (`store.ts` rows
  and spend, `limit.ts` what the meter asks per call, `enforce.ts` the sweep, the actions and the Needs you items,
  `view.ts`), `lib/shared/project-budget.ts` (the types both sides share).
- The context data source (`lib/server/goals/context-source.ts`) hands the mission, a project's brief and a goal's chain to the
  project-context seam (`lib/server/project-context/seam.ts`); reads are cached for a second.
