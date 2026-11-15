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

Progress against a goal is not built yet ([limitations](limitations.md#projects-and-goals)).

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
practices are retired (not deleted, not moved by `transferTo`; [practices.md](practices.md#reject-retire-waive)). A
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
[agents.md](agents.md#project-context).

## Agents across projects

An agent has one home project, and the home decides who edits it. It can also be **available** elsewhere: shared with
chosen projects, or with **All projects** in one click. A project that only uses an agent can pick it in Run an
Agent and run it from its workflows, but cannot change, delete, share or read the sessions of it.

- **Sharing.** `GET|PUT /api/agents/:id/shares` (admins of the home project, owners and admins may change them). The
  answer has `availability` (`home`, `all`, and the projects the caller has a role in) and `shares`. The "All projects"
  row is a share with the project id `*`; it shows only as `availability.all`, and only agents can have it.
- **Pickers.** `GET /api/agents?availableIn=<projectId>` lists the agents a project can use (404 for a project the caller
  has no role in). The Run an Agent node lists the agents available in the workflow's project, and a shared one says
  "From <home project>". Without a project, everything is listed as before.
- **Test in project.** The test chat with a `projectId` the agent is not available in answers 403 "This agent isn't
  available in that project".
- **Sessions stay at home.** The agent's sessions and each session are read only by members of its home project (and
  owners and admins). Others get 404 "Agent not found". A session keeps the brief of the project it ran for, so this
  keeps one project's brief from another project that only uses the agent.
- **The live feed too.** `/api/events` sends an agent's `entry` and `run.finished` events (the session itself) only to
  members of its home project and to owners and admins.
- **Still readable by a user project.** Because a share gives `read`, a project that only uses the agent can still list
  the file names of its knowledge base and save it as a template. Its secrets and sessions stay hidden.
- **Evaluations stay at home too.** The online evaluation scores and the eval gate carry session inputs and outputs, so
  they are home-only (404 for others); the Run an Agent and tool pickers scope to the agent's home project only for
  its home members.
- **All projects replaces single shares.** Turning **All projects** on drops the single-project rows; turning it off
  later leaves the agent home-only. `availability.projects` lists only projects the caller has a role in, so build a
  `PUT` from `shares`, not from it.
- **Brain and spend.** Whoever can read an agent (a share counts) sees its brain facts, suggestions and spend, which
  come from runs in every project.
- **No wall at run time.** A saved workflow that runs another project's agent keeps working, even after the share is
  removed.
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

## How it is built

- Data: migration 2300 makes `goals`, `project_goals` (a project's goals and their order) and `goal_links` (initiatives);
  migration 2301 adds the brief's columns to `projects`.
- Code: `lib/server/goals/` (`store.ts` the data and its audit, `views.ts` the rules and views, `schema.ts` the request
  bodies, `context-source.ts` the reader the context provider calls), `lib/server/projects/store.ts` (the brief),
  `lib/shared/goals.ts` (the types and limits both sides share).
- The context data source (`lib/server/goals/context-source.ts`) hands the mission, a project's brief and a goal's chain to the
  project-context seam (`lib/server/project-context/seam.ts`); reads are cached for a second.
