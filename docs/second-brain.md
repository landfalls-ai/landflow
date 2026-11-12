# Second brain: learning from how Landflow is used

Status: **built** (2026-10-31). The second brain studies what people and agents do on the platform and remembers what
it learns. It turns that into suggestions: fixes, cheaper or faster versions, a schedule for work run by hand, and new
workflows for what people keep asking for. You can build your own conclusions too: workflows that read the same usage
and post suggestions next to the built-in ones.

```
 observe ─────────► remember ─────────► conclude ─────────► propose ─────────► measure
 usage ledger       profiles, facts     12 detectors, your  Home inbox, canvas  did it help?
 (every run, edit,  and a searchable    workflows, the      card, a digest;     back into the
 AI call, action)   index               Platform analyst    Apply with a diff   facts
```

Try it: open **Insights → What Landflow knows** and press **Run now** (owners and admins). Then open Home: suggestions
show up in the **Suggestions** card, and on the canvas of the workflow they are about.

## Principles

1. **Metadata, not payloads.** The brain learns from node types, shapes, error messages, durations, counts and costs.
   Before an error message is stored, emails, URLs with secrets, tokens, card-like and long numbers are replaced
   (`redact()` in `lib/server/usage/ledger.ts`). A failed run's input and output reach the model only when a project
   turns on **Let the second brain read run data** (project **Settings → Governance**, `brainPayloads`).
2. **Rules find, the model explains.** Detectors are SQL over the ledger with thresholds: cheap, testable and
   explainable. The model only writes what needs words: a fix for a failure, tips for a slow step, persona rules, a
   draft workflow. Every suggestion shows its evidence.
3. **It proposes; it never applies.** A suggestion is a list of [edit operations](assistant.md#edit-operations), checked
   against the workflow as it is now, or a draft workflow, or persona rules. Apply goes through the same governed save
   as an edit by hand (audit source `brain`).
4. **Built from Landflow where it can be.** The ledger, the detectors and the inbox are code. Three nodes and an agent
   let you write conclusions of your own, and those are the same kind of thing as the built-in ones.
5. **Projects stay walls.** Members see usage, facts and suggestions only for the workflows and agents they can open.
   Owners and admins see everything, including what spans projects (node types, credentials, the instance).
6. **Local by default.** The brain writes with the builder model (Ollama unless set otherwise) and embeds with
   `nomic-embed-text`. `LANDFLOW_BRAIN_MODEL=off` keeps it to rules only.

## The pieces

### 1. The usage ledger

`usage_events` (migration 1890) is append-only. Each event has a time and kind; the project, workflow, node id and
type, agent and actor; an error signature and a redacted message; numbers (duration, items, tokens, cost); and a few
attributes.

| Kind | Recorded where |
|---|---|
| `run.finished`, `node.failed`, `node.slow` | `store.saveExecution`: one per run; one per failed node run (with the signature); one per node run that took 2 s or more, or half of a run of 1 s or more |
| `ai.call` | the `ai_usage` writer: provider, model, operation, tokens and cost |
| `workflow.saved`, `workflow.published`, `credential.used`, `plugin.installed` | the audit writer (create, update, import; publish, rollback; credential use; marketplace install) |
| `agent.session`, `feedback` | the bus (an agent run finished) and chat feedback (thumbs up or down) |
| `spotlight.asked`, `assistant.applied`, `assistant.dismissed` | the assistant's chat and feedback routes; the [Agent architect](agents.md#agent-architect)'s asks are `spotlight.asked` too, with `architect: true` and `proposals` (the drafts it made) |
| `tool.missing` | the Agent architect: a part of an agent's job no node online can do (what it would do as the message, with `system`, `agent` and `source: architect`), once per reply |
| `template.used` | `POST /api/templates/:id/use` |
| `search.empty` | the node picker: a search of three or more characters with no results for 1.5 s (`POST /api/usage/signal`) |
| `proposal.applied`, `proposal.dismissed` | the brain's own decisions |

- **Signature**: the same failure on the same node type has the same signature, whatever its numbers, ids and quoted
  values. A report grouped by signature labels each one with its latest message.
- **Stable ids**: ids come from the execution or audit event, so saving a record again, or the backfill, never counts
  twice.
- **Backfill**: on the first start, the ledger fills once from the executions still on disk (the newest 2,000), the
  `ai_usage` rows and the audit events of the retention window.
- **Rollups**: `usage_daily` has rollups per day, kind, workflow, node type, signature and agent, and is kept 400 days.
  Raw events are kept `USAGE_RETENTION_DAYS` (90). A report over a longer window reads the rollups.
- **Off switch**: `LANDFLOW_BRAIN=false` stops recording and the brain.

### 2. Memory: profiles and facts

**Study** runs once a day on the leader, and on **Run now**.

- It profiles each workflow (at most 20 per run, only those changed since their last profile):
  - its purpose, written by the model from the outline, or described from the nodes without one;
  - runs, failure rate, p95, cost, its top failure signatures and slowest nodes;
  - what it depends on (sub-workflows, credentials, agents: a Run an Agent node's, and the Landflow agents of a Run a
    Team node's team, from the version it runs).
- It also profiles each agent, node type, credential and the instance.
- Profiles become **facts** in `brain_facts`: subject, kind (`purpose`, `health`, `cost`, `failure`, `slow`, `change`,
  `dependency`, `usage`, `quality`, `intended`), statement, evidence, confidence, first and last seen, active or
  stale.
- Facts are embedded into the vector store. Each project has a collection `landflow-brain-<project>`; facts that span
  projects go in `landflow-brain`.
- Search (`GET /api/brain/facts?q=`, the Landflow Usage node, the analyst) fuses keyword (BM25) and vector hits.

### 3. The loop

The leader runs the brain (`leaderService('second brain')`). Every `LANDFLOW_BRAIN_INTERVAL_MINUTES` (60) it:

1. rolls up and prunes the ledger;
2. expires detector suggestions no detector confirmed for 14 days;
3. checks the effect of applied ones ([7](#7-measuring-the-effect));
4. runs the detectors, then the published [detector flows](#flow-detectors) one after another, and studies when the
   last study is a day old.

The first tick is 30 s after start.

### 4. Detectors and suggestions

| Detector | Finds | Suggests |
|---|---|---|
| Failure hot spot | one signature failing 5+ times in 7 days on one node (not the transient kind) | a fix the model writes from the latest failing run (with payloads only if the project allows); for a Stop and Error, which fails on purpose, advice to send the rejected items somewhere instead |
| Flaky call | 3+ timeouts, 429s or 5xx on one node in 7 days while most runs succeed, and no retries | `setNodeSettings`: retry 3 times, 5 s apart |
| Slow step | a node slow 5+ times in 7 days with p95 ≥ 5 s, or 1.5× the week before | tips for the node type (batching, pagination, parallel) |
| AI cost | 20+ calls a week to one model with short answers (≤ 400 output tokens) where a model under half the price exists | `setParameters` with the smaller model, after the workflow's evaluations |
| Hand-run rhythm | a workflow run by hand on 4+ of the last 21 days, on days nobody edited it | a Schedule trigger at the usual hour, connected like the manual one |
| Repeated by hand | two workflows run by hand one after the other (within 30 min) on 3+ days | a draft workflow that runs both with Execute Workflow |
| Copy and paste | the same chain of three node types in 3+ workflows | a draft sub-workflow |
| Dead weight | active workflows that didn't run in 60 days (only once the ledger reaches back that far) | archive it (advice) |
| Agent quality | 3+ thumbs down that are 30%+ of an agent's feedback in 14 days | persona rules the model writes from the comments, for the agent's draft |
| Unmet demand | 3+ Spotlight asks that changed nothing, or empty node searches, about the same term, from 2 people or on 2 days | a draft workflow for the request |
| Missing tool | something the Agent architect needed and no node online does, grouped by the app (or the first telling word, with spellings like "Text Toolkit" and "TextToolkit" as one); one need is enough, the same person asking again the same day counts once | "Build a tool for Grafana", with a sketch of the node plugin the model writes (nodes, parameters, credential) and a link to **Build a plugin**. Its button is **Build it**: approving it starts the workflows that build one (below) |
| No safety net | an active workflow with 3+ failed production runs in 14 days and no error workflow | `setWorkflowSettings` with the error workflow you have, or a draft "Failure alerts" workflow when there is none |

- **What a suggestion holds** (`proposals`): a title; why, with evidence; the expected effect; its changes (ops, a
  draft or persona rules); a risk tier and confidence; and its target. Its status is open, applied, dismissed (with a
  reason), snoozed or expired.
- **No repeats**: the same finding refreshes the open suggestion (by fingerprint) instead of adding one. Advice
  (no changes) about a node that already has open advice, from any source, is held back too: the analyst and a detector
  word the same finding differently, so their fingerprints differ.
- **Held back**: a suggestion dismissed as *intended* never comes back. One dismissed as *wrong* or *not relevant*
  stays away 30 days, and an applied one 14 days.
- **Weekly cap**: at most `LANDFLOW_BRAIN_WEEKLY_CAP` (3) per workflow per week. A stronger suggestion replaces the
  weakest open one.
- **Quieter detectors**: a detector whose decided suggestions (5 or more) are mostly dismissed as wrong or not relevant
  gets its thresholds multiplied (×1.5 from 40% rejected, ×2 from 60%, ×3 from 80%). A [flow detector](#flow-detectors)
  gets the multiplier as `quiet`, and its findings also need a minimum confidence (0.5, 0.65, 0.8).

### 5. Where you see it

- **Home → Suggestions**: the open suggestions the viewer can see, best first. Each shows its evidence and
  **Changes** (the diff, as in Spotlight). The buttons:
  - **Apply**, which saves through governance; **Create workflow** for a draft; **Mark done** for advice.
  - **Build it** for a missing tool. It records the go-ahead (`proposal.applied`, with the detector), and published
    workflows that start from On Usage Event on `proposal.applied` with **Suggestion From: Missing tool** get the
    whole suggestion and build the tool, for example agents writing the plugin and opening a draft pull request. The
    toast names them. With none published it is approved all the same, with a warning saying what to publish
    (`POST /api/proposals/:id/apply` returns `started`).
  - **Dismiss** with a reason: intended, not relevant, wrong, or already done.
  - **Snooze 7 days**.
- **The canvas**: a "N suggestions" pill at the top left of the workflow it is about. It folds out into a side card,
  and the canvas stays visible. Apply here changes the open canvas (one undo), and you save it like any edit. Clicking
  the node name selects the node.
- **Insights → What Landflow knows**:
  - the ledger's size, the facts, the model, and when the brain last studied and detected;
  - a search over the facts;
  - each detector's record (made, applied, dismissed, quieted) with **Run**, which runs that detector alone. Flow
    detectors are listed from the moment they exist, linked to their workflow; one not yet published says so and has
    no **Run**;
  - **Create the Platform analyst**;
  - **Run now**.
- **Project settings → Governance**: **Let the second brain read run data**.

### 6. Your own conclusions

Six nodes make the brain something workflows can use:

- **Landflow Usage** (`core.landflowUsage`, usable as an agent tool). Its operations:
  - Report: grouped by day, kind, workflow, node type, signature, agent, model or one attribute (`groupAttr`);
  - Events;
  - Search Facts;
  - Workflow Knowledge: the outline, profile, facts and open suggestions;
  - Suggestions.
- **Record Event** (`core.recordEvent`, usable as a tool) writes your own event into the ledger (below).
- **On Usage Event** (`core.usageTrigger`) fires on ledger kinds, built-in and custom.
  - Filters: an **Attribute Filter** (`{"team": "billing"}` or `team=billing`, for any kind), one workflow, *only new failures* (a signature never seen before), a minimum AI-call cost, and for
    `proposal.applied` the detector that made the suggestion (**Suggestion From**).
  - It batches events for `batchSeconds`. Items carry `workflowName` and `agentName`, and a `proposal.applied` item the
    whole suggestion in `proposal` (id, detector, title, why, target, evidence, effect, appliedBy): an event's
    attributes keep 200 characters, too few for a plugin sketch.
  - Events from workflows that have this trigger never start one, nor do events such a workflow records with Record
    Event (no loops).
- **Suggest Improvement** (`core.suggestImprovement`, usable as a tool) posts a suggestion to the inbox: a title, why,
  the workflow and node, the expected effect, ops as JSON (checked against the workflow; `[]` for advice), risk,
  confidence, and a fingerprint.
- **Detector Trigger** (`core.detectorTrigger`) makes the workflow one of the brain's detectors (below).
- **Find Similar** (`core.findSimilar`, usable as a tool) asks whether something like this already exists ([below](#find-similar)).
- **Entity** (`core.brainEntity`, usable as a tool) keeps initiatives, people, customers and systems ([below](#entities)).

#### Find Similar

"Is anyone already doing this?" Give the node a title and a goal; it returns one item per nearest workflow, agent, entity or
fact, best first (`score` 0 to 1). Settings: what to search (workflows, agents, entities, facts), a limit (10), a minimum score
(0.15) and **Include Other Projects**.

- **Ranking.** The words the text shares with a candidate (its name, description and the purpose the brain wrote; for
  a fact, its statement), a light stem so "reminders" meets "reminder". With embeddings on, the subject of every fact
  the vector search finds gets a bonus. With `LANDFLOW_BRAIN_EMBEDDINGS=off` only the words count, so it needs no model.
- **Your projects.** A match in a project the workflow's creator can open (an agent's tools: its own project) carries
  `yours: true`, its `id`, `description`, `active`, and for a fact its `kind`, `statement` and `subject`.
- **Other projects.** With **Include Other Projects**, a match in a project they can't open is a projection of six
  fields: `type` (workflow, agent or entity), `title`, `owner`, `goal` (one line), `project` and `score`. It has no id, no link,
  no fact statements and no evidence, and facts of other projects are never listed: they only raise the score of the
  workflow or agent they are about. The point is to find out whom to ask, not to read their work.
- Code: `brain/similar.ts` (`findSimilar(text, { scope, kinds, limit, minScore, includeOthers, exclude })`), shared by the
  node and the MCP tool `check_overlap`.

#### Entities

The brain knows workflows, agents, node types, credentials and the instance. **Entities** add the things people talk
about that no workflow holds: `initiative`, `person`, `customer` and `system` (one list, `ENTITY_TYPES` in
`lib/shared/brain.ts`). An overlap finder is the point: "two teams run the same initiative".

- **The registry.** Table `brain_entities` (migration 2063): `type`, `id`, `name`, `description` (an initiative's goal),
  `owner` (a user id or a free name such as "Platform team"; `ownerName` is the user's name when it is an id), `projectId`,
  flat `attrs` (text, numbers, true/false; at most 20), `source` (api, workflow, agent) and timestamps. An id is lowercase
  letters, digits, `_`, `-` and `.`; left out, it is made from the name. Code: `brain/entities.ts`.
- **Walls.** An entity lives in a project (the creator's personal project unless another is named) and the people who can
  open the project see it; owners and admins see all. The usage scope gained `entities` (`<type>/<id>`), so facts,
  suggestions, Find Similar and the MCP tools cut entities down like workflows. A workflow or agent's Entity node sees the
  entities of its creator's projects (an agent's: its own project) and creates new ones in its own project.
- **Facts and suggestions.** A fact about an entity has `subjectType: entity` and `subjectId: <type>/<id>`, plus the name;
  a suggestion's target is `entity:<type>/<id>` (`target.type: entity`, `target.id: <type>/<id>`), made with
  `entity: { type, id }` in `POST /api/proposals`, the Suggest Improvement node's *About Entity* or `brain_suggest`. The inbox
  card shows the entity's name and type. Entity suggestions are advice: *Mark done* closes them. Dismissed as *intended*, one
  writes the `intended` fact on the entity and is never suggested again. Deleting an entity removes its facts and profile
  and expires its open suggestions.
- **Facts people add.** *Add Fact* on the node (or `POST /api/entities/:type/:id/facts`) writes a statement of any fact kind.
  The study refreshes the facts it writes itself and lets them go stale when the entity is gone, but never stales these.
- **The study** writes a profile for every entity without a model: the purpose is its description, or a sentence from its
  type, owner and attributes; a `purpose` fact says the same with the attributes, and a `usage` fact counts the statements
  on file. They are embedded per project like workflow facts, so meaning-search finds them. (With a model it is the same:
  the study does not ask it about entities.)
- **Find Similar** has the kind `entity`: ranked by words in the name, description and purpose (and the facts' vector
  bonus). A match you can open carries `id` (`<type>/<id>`), `entityType` and detail; one in another project is the same
  six-field projection as for workflows (`type: entity`).
- **Reading.** Landflow Usage's *Search Facts* can be limited to *Entities* (`subjectType`), and its *Entity Knowledge*
  operation returns an entity, its profile, facts and open suggestions (the way *Workflow Knowledge* does for a workflow).
  `check_overlap` (`what: ["entity"]`) and `brain_search_facts` (`subjectType: "entity"`) include entities over MCP.
  The Platform analyst has the tools `entity_knowledge`, `entities` (list only) and `note_entity_fact`; it cannot
  delete one. Insights counts entities, and its facts list shows an entity's type next to its name.

#### The vector collections

Workflows and agents can't read or write `landflow-brain` and `landflow-brain-<project>` with a Vector Store node: the
node refuses any collection with that name (case ignored) and points at Find Similar and Landflow Usage, which return
only what the workflow's creator can see. The brain itself writes them and searches the ones the caller's projects own.

#### The brain over MCP

The instance MCP server ([reference/api.md](reference/api.md), `POST /api/mcp`) serves the brain, so a coding agent needs
no hand-built MCP Server Trigger workflow:

| Tool | Does |
|---|---|
| `brain_search_facts` | facts best matching a query (`subjectType`, `kind`, `limit`) |
| `brain_list_suggestions` | the inbox (`status`, `workflowId`, `detector`, `limit`) |
| `brain_workflow_knowledge` | a workflow's profile, facts and open suggestions |
| `brain_usage_report` | the usage report (`groupBy`, `kinds`, `days`, `workflowId`) |
| `check_overlap` | Find Similar for a title and a goal; other projects as the projection above (`includeOthers`, default true) |
| `brain_suggest` | post a suggestion (source `analyst`, like `POST /api/proposals`) |

Each tool sees what the token's user sees (an instance access token sees everything), cut down to the project on a
project server (`/api/mcp/projects/<id>`, a project token), where `brain_suggest` must name a workflow or agent of it.
A workflow the user can't open is "not found". `brain_suggest` needs edit access to the workflow or agent. Code:
`mcp/brain-tools.ts`.

#### Your own event kinds

Landflow's kinds are a fixed list. A flow can add its own, so a board sync, an agent's self-update or a billing step
shows up in the ledger and can start other flows.

- **A kind** is `<namespace>.<name>` in lowercase letters, digits and underscores (`work.ticket_moved`,
  `work.self_update`; 3 to 64 characters, more dots allowed). The namespace can't be one Landflow uses: `run`, `node`,
  `ai`, `workflow`, `credential`, `assistant`, `spotlight`, `search`, `agent`, `feedback`, `template`, `plugin`,
  `proposal` or `tool`.
- **A declared shape** comes first: `POST /api/usage/kinds` with a description and up to 20 fields, each a name, a type
  (`string`, `number` or `boolean`), whether it is required, and a description. The declarations live in the
  `usage_kinds` table. Deleting one leaves the events already recorded.
- **Record Event** picks a declared kind, takes **Attributes (JSON)** and checks them against the shape:
  - a missing required field, or a value of the wrong type, fails the node with the field's name (a string that plainly
    reads as the declared number or boolean, such as `"12"` or `"true"`, is accepted);
  - attributes the kind doesn't declare are dropped, not rejected, and the output's `dropped` lists them;
  - an undeclared kind fails, unless **Declare Kind If New** is on: it declares the kind from the attributes' names and
    types, all optional;
  - the event is about **About Workflow** or **About Agent**, by default the workflow that records it (the agent, for
    a tool call). A flow may only record about workflows and agents its creator can see;
  - **Message**, **Duration**, **Items** and **Cost** fill the ledger's own columns. The message is redacted and clipped
    like any other, and a string attribute keeps 200 characters. The event carries `attrs.recordedBy`, the workflow that wrote it.
- **On Usage Event** lists declared kinds in its Kinds picker. Its **Attribute Filter** compares as text, so `3` equals
  `"3"`. A workflow that starts from On Usage Event never starts anything with the events it records, whatever they
  are about.
- **Reports** take custom kinds in the `kinds` filter. `groupBy=attr&groupAttr=team` gives "tickets moved per team",
  and `attr.team=billing` keeps matching events. Both read the raw events (the daily rollups keep no attributes), so
  they reach back `USAGE_RETENTION_DAYS`; the rollups themselves count a custom kind like any other.

#### Flow detectors

A suggestion a workflow posts is source `workflow`: it never expires, never quiets anything and isn't in Insights. A
published workflow that starts from **Detector Trigger** is a detector instead, as first-class as the built-in ones,
with the id `flow:<workflowId>` and its workflow's name as its label:

- **When it runs**: on the brain's tick after the built-in detectors, on **Insights → Run now**, and alone from its
  **Run** in the detectors table (`POST /api/brain/run { what: "detect", detector: "flow:<id>" }`). Flows run one
  after another, each for at most 10 minutes. Only the published version runs; **Run** in the editor starts at the
  trigger with this workflow's real values.
- **What it gets**: one item, `{ detector, name, quiet, minConfidence, at, lastRunAt, reason }`. `quiet` is the
  multiplier above (1 is normal): multiply your thresholds by it. `lastRunAt` is when the brain last ran it, for a flow
  that reads only what is new. `reason` is `tick`, `run-now` or `manual`.
- **What it returns**: its findings, through Suggest Improvement nodes. In a workflow with a Detector Trigger they post
  as the detector (source `detector`). Their fingerprints are the detector's own, so the same finding refreshes the open
  suggestion, and a finding under `minConfidence` is held back (the node's item says why).
- **What follows**: everything a built-in detector has. People's dismissals quiet it. A suggestion it stops finding
  expires after 14 days. An applied one is measured ([7](#7-measuring-the-effect)). Insights lists its record. **Suggestion
  From** on On Usage Event lists it, so a flow can act when one of its suggestions is applied.

For example, an overlap finder: Detector Trigger → Landflow Usage (Search Facts) → an AI Agent judging which pairs are
the same work, with its threshold times `quiet` → Suggest Improvement per pair, confidence from the agent.

A workflow reads what the person who created it can see. A workflow nobody created, and an agent's tools, see their
own project.

Templates built from these nodes:

- **New failure alerts to Slack**;
- **Weekly failure hot spots**;
- **Weekly AI cost review** (email);
- **Second brain weekly digest** (Slack).

#### The analyst agent

**Create the Platform analyst** (Insights, or `POST /api/brain/analyst`) makes and publishes an ordinary agent:

- its persona: an analyst that looks numbers up before it answers, never invents them and files one concrete change at
  a time;
- its tools: four Landflow Usage tools (`usage_report`, `search_facts`, `workflow_knowledge`, `open_suggestions`) and
  `suggest_improvement`, with the arguments filled by the model.

In its chat (Test agent), the **new look** draws the analyst differently (the classic look keeps the plain chat):

- **What it reads**: chips above the chat, one per source its tools read (Runs, Usage & cost, Facts, Suggestions, and
  Team notebook when it has a notebook tool). The analyst is recognised by its tools: a Landflow Usage tool named
  `usage_report`.
- **While it looks**: the tool calls fold into one line, "Looking across N sources…" (N = the sources it has called in
  this turn), with **Show steps** for the raw calls. A call waiting for your approval is always shown in full.
- **The answer card**: when the turn is done and a `usage_report` with at least two groups came back, one card with the
  period and scope ("This week · Tech Review Workflow", the scope from `workflow_knowledge`), the model's answer, a small
  chart (days as columns in time order; workflows, nodes or models as one labelled bar each, biggest first, with its
  value), and up to two of the model's own bullet lines as drivers. The bars are cost, else failures, else event
  counts, **taken from the tool results** (`lib/shared/analyst-chart.ts`), never parsed from the model's text; a dashed
  line shows a budget when a result states one (`budget`, `costBudget`, `budgetUsd` or `target` on the result or a
  workflow's profile). With nothing chartable the plain answer shows as before.
- **Next steps**: **Open the runs** (`/executions`, filtered to the workflow when a result names one) and **Suggest a
  fix**, which asks the analyst to call `suggest_improvement`; the suggestion still waits in the inbox for your Apply.

Ask it in its chat, from Slack, or use it in a flow with [Run an Agent](agents.md). Its suggestions have the source
`workflow`. Suggestions from `POST /api/proposals` have the source `analyst`.

### 7. Measuring the effect

- **Baseline**: on Apply, the suggestion records a baseline from the week before. The metric depends on the detector:
  failure rate; p95; cost per run; runs by hand; or the thumbs-down rate for agents. A flow detector's suggestion about
  a workflow is measured by that workflow's failure rate; one about the instance isn't measured.
- **Checks**: after 7 days it checks again. After 14 days it marks the outcome: worked, no effect, or worse (a 10%
  change either way decides).
- **Memory**: the outcome becomes a `change` fact ("Applying “Retry the CRM call” helped: 12% of runs failing before,
  2% after").
- **Dismissals**: *intended* becomes an `intended` fact, so the brain and the analyst know it isn't a problem.

## API and settings

Routes are also in [reference/api.md](reference/api.md), and variables in
[reference/configuration.md](reference/configuration.md).

| Route | What | Who |
|---|---|---|
| `GET /api/usage` | a grouped report (`groupBy=attr&groupAttr=`, `attr.<name>=` for custom attributes) | `executions:read`, scoped |
| `GET /api/usage/events` | the events | `executions:read`, scoped |
| `GET /api/usage/kinds`, `GET /api/usage/kinds/:kind` | the custom event kinds and their fields | `executions:read` |
| `POST /api/usage/kinds`, `DELETE /api/usage/kinds/:kind` | declare or update a kind; forget one | `workflows:write` |
| `POST /api/usage/signal` | an editor signal (`search.empty`) | `workflows:write` |
| `GET /api/proposals`, `GET /api/proposals/:id` | suggestions (`?detector=` a built-in id or `flow:<workflowId>`) | `workflows:read`, scoped |
| `POST /api/proposals` | a suggestion from outside (source `analyst`) | edit access to its workflow or agent |
| `PATCH /api/proposals/:id` | dismiss with a reason, or snooze | edit access to its target |
| `POST /api/proposals/:id/apply` | apply on the server | edit access to its target; any builder for a draft |
| `POST /api/proposals/:id/applied` | the editor applied it itself | edit access to its target |
| `GET /api/brain/status`, `/api/brain/facts`, `/api/brain/workflows/:id` | what it knows | `executions:read`, scoped |
| `GET /api/entities`, `GET /api/entities/:type/:id` | entities (`?type=&owner=&q=&projectId=&limit=`), one with its profile, facts and open suggestions | `workflows:read`, scoped to the caller's projects |
| `POST /api/entities`, `PATCH`/`DELETE /api/entities/:type/:id` | add or update (by `id`), change, delete | `workflows:write`, editor of the entity's project |
| `POST /api/entities/:type/:id/facts` | add a fact about an entity | `workflows:write`, editor of the entity's project |
| `POST /api/brain/run` | detect, study, effects or all, now; `detector` runs one detector alone (built-in or `flow:<id>`, published) | owners and admins |
| `POST /api/brain/analyst` | make the Platform analyst | `workflows:write` |

## Limits

- Dead weight needs 60 days of ledger. On a new instance it waits, and the backfill only reaches as far as executions
  and audit events on disk.
- In queue mode, each process records its own events and starts On Usage Event workflows for them, so a trigger's batch
  holds one process's events.
- Ollama calls cost $0, so the AI-cost detector never suggests a smaller local model.
- The model writes fixes and drafts one at a time on the leader. A slow local model makes a study or detect run take
  minutes. `POST /api/brain/run` waits for it, detector flows included (up to 10 minutes each).
- A flow detector's effect is measured by its target workflow's failure rate, the default. It can't name its own
  metric yet. Apply does something only when the suggestion carries ops, a draft or persona rules; otherwise it is
  advice, marked done.

## Where the code is

- `apps/web/src/lib/server/usage/`: the ledger (`ledger.ts`), queries, reports and rollups (`query.ts`), the listeners
  and the backfill.
- `apps/web/src/lib/server/brain/`:
  - the loop (`index.ts`);
  - detectors, suggestions (`proposals.ts`), effects, the model's writing (`writer.ts`);
  - study and facts;
  - scope, the analyst and On Usage Event (`usage-trigger.ts`);
  - flow detectors (`flow-detectors.ts`);
  - Find Similar (`similar.ts`);
  - entities (`entities.ts`; `apps/web/src/app/api/entities/` for their routes).
- `apps/web/src/lib/server/usage/kinds.ts`: the declared custom kinds and the attribute checks;
  `apps/web/src/app/api/usage/kinds/`: their routes.
- `apps/web/src/lib/server/mcp/brain-tools.ts`: the brain's tools on the instance MCP server.
- `apps/web/src/lib/server/nodes/usage.ts`: the six nodes, `nodes/entities.ts` the Entity node; `nodes/vector-stores.ts` refuses the brain's collections.
- `apps/web/src/components/brain/`: the inbox, the canvas card and the Insights panel.
- Tests: `apps/web/test/brain.test.ts`, `apps/web/test/brain-events.test.ts` (custom kinds), `apps/web/test/brain-entities.test.ts` (entities).
