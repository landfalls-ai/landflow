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

Try it: open **Brain** in the sidebar, then **What Landflow knows** (the gear at the bottom left), and press **Run now** (owners and admins). Then open Home: suggestions
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
  Raw events are kept `LANDFLOW_USAGE_RETENTION_DAYS` (90). A report over a longer window reads the rollups.
- **Work events**: people's own tools send summaries of their work (`work.session`, with a repository, directory names
  and counts) to `POST /api/brain/work`. Such a row has an owner and a visibility, private by default, and nobody else
  reads a private one, not even an admin; the rollups leave them out. See [work-and-briefings.md](work-and-briefings.md).
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

- **Home → Suggestions**: the open suggestions the viewer can see, best first. Each card is compact: the title, one
  line of why (its first sentence), one button and **⋯**. **Show more** adds the kind, the subject, risk and
  confidence, the whole why, the evidence, what to expect and the **Changes** (the diff, as in Spotlight). The
  Brain index uses the same card and can link to Home with **All suggestions**. The buttons:
  - **Apply**, which saves through governance; **Create workflow** for a draft; **Mark done** for advice.
  - **Build it** for a missing tool. It records the go-ahead (`proposal.applied`, with the detector), and published
    workflows that start from On Usage Event on `proposal.applied` with **Suggestion From: Missing tool** get the
    whole suggestion and build the tool, for example agents writing the plugin and opening a draft pull request. The
    toast names them. With none published it is approved all the same, with a warning saying what to publish
    (`POST /api/proposals/:id/apply` returns `started`).
  - **Your own buttons**, when a flow added [actions](#actions-decided-by-the-flow) ("Intro us"). They sit next to
    Apply, and replace **Mark done** on advice.
  - **Dismiss** (under **⋯**) with a reason: intended, not relevant, wrong, or already done.
  - **Snooze 7 days**.
- **The canvas**: a "N suggestions" pill at the top left of the workflow it is about. It folds out into a side card,
  and the canvas stays visible. Apply here changes the open canvas (one undo), and you save it like any edit. Clicking
  the node name selects the node.
- **[The Brain page](#the-brain-page)** (`/brain`): the brain as a repository of Markdown files in an editor's workbench,
  a file per entity, Ask to ask it, and what more than one team worked on.
- **Brain → What Landflow knows** (the gear at the foot of the Brain page's activity bar; it was on Insights, which now
  links to it):
  - the ledger's size, the facts, the model, and when the brain last studied and detected;
  - a search over the facts;
  - each detector's record (made, applied, dismissed, quieted) with **Run**, which runs that detector alone, and
    **Backtest** ([below](#backtesting-a-detector)), which shows a small card of how it would have fared. Flow
    detectors are listed from the moment they exist, linked to their workflow; one not yet published says so and has
    no **Run** or **Backtest**;
  - **Create the Platform analyst**;
  - **Run now**.
- **Project settings → Governance**: **Let the second brain read run data**.

### 6. Your own conclusions

Seven nodes make the brain something workflows can use (and On Suggestion Decided, [below](#actions-decided-by-the-flow)):

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
  delete one. The Brain page counts entities, and its facts list shows an entity's type next to its name and links to its
  page.

#### The Brain page

`/brain` (**Brain** in the sidebar) opens the brain as a repository of Markdown files in an editor's workbench, in the
manner of an LLM-kept wiki: every entity is a file, the `work.*` events the
[activity integrations](features/integrations.md#work-ingest-templates) record are its sources, the model writes the
prose and a person keeps the facts. Spotlight asks it questions.

- **Work joins pages by its hints.** A `work.*` event names its pages through `customer` and `initiative` (matched by id or
  by the id a template makes from a name: "Acme" and `#customer-acme` both meet `acme`) and through `actor`, the email of a
  person page (its `email` attribute or its id). Its team is the event's `team`, else that person's `department`.
- **The files.** `initiatives/`, `customers/`, `people/<department>/` and `systems/`, a file per entity named from its
  name (`kestrel-bank.md`); `index.md`, the week's briefing; and `log.md`, the latest work with a heading per day. The
  Explorer marks each file with its work this week, an **S** when two or more teams worked on it this week, and amber
  with **!** when it needs a person.
- **The workbench.**
  - **Activity bar**: Explorer (Open Editors, the tree, the open file's **Outline** and its **Backlinks**: the pages
    whose summary links to it or whose description names it, and the pages sharing its work), **Search** (pages, facts
    and the latest work), **Timeline** (the latest work as a history), and **What Landflow knows** (status, fact
    search, detectors with Run and Backtest, the analyst, Run now; it moved here from Insights), which opens as a tab.
  - **Tabs**: one click opens a file in the preview tab (italic), which the next replaces; a double click or a change
    keeps it. Breadcrumbs show its path. The tabs and the side bar's width are kept in the browser, and the address
    names the open file (`/brain`, `/brain/log`, `/brain/settings`, `/brain/<type>/<id>`).
  - **Preview or Source** (⌘⇧V): the Preview is the page with its controls; the Source is the same file as Markdown
    (`lib/shared/brain-files.ts`): frontmatter (type, owner, teams, sources, attributes, when the summary was written),
    the summary with its `[[type/id|Name]]` links and `[n]` references, then the work, people, related pages, facts,
    suggestions and mentions. In the Source, a link opens its page and a reference jumps to its work line. **Copy**
    takes the Markdown. The Source is read-only.
  - **Ask** (the **Ask** button in the title bar, or ⌘I): the one way to ask the brain. On a desktop it is a 360 px
    column docked at the right of the editor: the page narrows and nothing overlaps, and a link in an answer opens
    that page in the editor beside it while the answer stays. With a page open, the question is about that page (the
    `@` chip) until the chip is removed. The answer streams: first **Found 3 pages · 2 facts · 5 work items** (with
    the pages as links), then its steps and its words, then the model, time, tokens and cost under it (a local model
    says "local"). A follow-up ("and since when?") knows the last two turns of the conversation. A source is numbered
    only when the answer cites it, and a `[n]` that points at no work item is dropped. **New conversation** clears
    it. On a phone Ask is a bottom sheet; a link closes it to show the page, and the Ask button brings it back with
    its answers.
  - **Quick open** (⌘P or ⌘K): go to a file by name or path, or `>` for commands (open index or log, toggle Source,
    Problems, Suggestions, run the brain). It only finds pages; it does not ask.
  - **Panel** (⌘J): **Problems** (initiatives and customers without an owner, pages quiet for 30 days, summaries behind
    their work) and **Suggestions** with their buttons. **Status bar**: problems, shared pages, open suggestions, pages
    and facts, the last study, the model.
  - **On a phone**: the side bar is a drawer behind the Files button, with the views at its top; tabs scroll; the Ask
    button stays in the title bar and the status bar at the bottom.
- **index.md**: **Shared across teams** (customers and initiatives two or more teams worked on in the last 7 days, most
  teams first, with their teams, people and latest items: no other product flags this, and it is what the Company
  Brain is for), **Suggestions**, **Teams this week** and **Needs a person**.
- **A page**:
  - **Kept by people**: name, what it is and owner, editable by editors of its project (`PATCH /api/entities/…`), and
    chips for owner (amber when none, not on people), teams, sources and last work.
  - **Summary, written by the brain**: 2–4 paragraphs, marked with the model and when, with page links and numbered
    references to the work below; a reference scrolls to its item. It is written the first time the page is opened
    with a model and work to go on, again on **Regenerate**, and shows **new work since** when the page's facts or work
    changed after it (a hash of what it was written from, table `brain_pages`, migration 2065). The model sees only the
    page, its facts, its last 40 work items, its people and related pages, each with its name, all within what the
    reader can open. Links to pages the reader can't open become plain names, and a page's name the model wrote plainly
    is linked on its first mention.
  - **Work** (90 days, numbered), **People** (or **Works with** on a person's page), **Related pages** (the pages named
    in the same work, with how often), **Facts** with **Add a fact**, **Suggestions** and **Mentioned in**.
- **Ask** (`POST /api/brain/ask`, what the Ask panel calls) finds pages by words in names, descriptions, owners and
  attributes, facts by search (by meaning too when embeddings are on), and work by words and by the pages found; then
  the model answers from those alone, in a few sentences with page links and numbered work. Without a model it returns
  what it found. A short follow-up borrows the words of the last question to find its pages. It streams when asked
  with `Accept: text/event-stream` and is one JSON body otherwise (MCP and older callers). **Ask is metered**: each
  model call writes an `ai_usage` row with surface `brain` under the asker, so the per-user caps apply and a cap shows
  as an error in the panel ([observability.md](observability.md)).
- **Walls.** Everything goes through the reader's scope: a page, a link, a person or a work item from a project the reader
  can't open is not shown, not linked and not sent to the model.
- Code: `brain/wiki.ts`, `lib/shared/brain-wiki.ts`, `lib/shared/brain-files.ts` (the tree and the Markdown),
  `components/brain/wiki/` (`workbench.tsx`, `side-views.tsx`, `spotlight.tsx`, `source-view.tsx`, `page-doc.tsx`,
  `index-doc.tsx`), `app/brain/[[...path]]/`; routes under `app/api/brain/wiki/` and `app/api/brain/ask/`. Tests:
  `apps/web/test/brain-wiki.test.ts`, `apps/web/test/brain-files.test.ts`. Why it looks this way:
  [research/brain-ui-research.md](research/brain-ui-research.md).

#### The vector collections

Workflows and agents can't read or write `landflow-brain` and `landflow-brain-<project>` with a Vector Store node: the
node refuses any collection with that name (case ignored) and points at Find Similar and Landflow Usage, which return
only what the workflow's creator can see. The brain itself writes them and searches the ones the caller's projects own.

#### The brain over MCP

What a person's tools send the brain about their work, and the briefing that comes back, are in
[work-and-briefings.md](work-and-briefings.md); over MCP they arrive in a later wave.

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
  they reach back `LANDFLOW_USAGE_RETENTION_DAYS`; the rollups themselves count a custom kind like any other.
- **The `work.*` kinds** the activity integrations suggest (`work.discussion`, `work.doc_edited`, `work.meeting_held`,
  `work.deal_moved`…) are catalogued in `deploy/brain/work-kinds.json` with one shared set of fields (`source`,
  `sourceId`, `url`, `actor`, `title`, `summary`, `team`, `initiative`, `customer`, `occurredAt`). `pnpm brain:work-kinds
  [url]` declares them all on an instance (again: it updates them), signing in with `LANDFLOW_API_KEY` or the owner in
  `LANDFLOW_OWNER_EMAIL` / `LANDFLOW_OWNER_PASSWORD`. The [work ingest templates](features/integrations.md#work-ingest-templates)
  record into them.

#### Flow detectors

A suggestion a workflow posts is source `workflow`: it never expires, never quiets anything and isn't in the detector list. A
published workflow that starts from **Detector Trigger** is a detector instead, as first-class as the built-in ones,
with the id `flow:<workflowId>` and its workflow's name as its label:

- **When it runs**: on the brain's tick after the built-in detectors, on **Brain → Run now**, and alone from its
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
  expires after 14 days. An applied one is measured ([7](#7-measuring-the-effect)). What Landflow knows lists its record. **Suggestion
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

#### Backtesting a detector

Detectors are tuned only after people dismiss their suggestions. A backtest checks one, or a change to its thresholds,
against what people already decided, before it ships. It reruns the detector "as of" past points (one a day for the
last 30 days by default) **without writing any suggestion**, then scores its findings against the suggestions the same
detector made before, matched by fingerprint:

| Finding | People decided | Counts as |
| --- | --- | --- |
| found | applied, or dismissed as *done* | hit |
| found | dismissed as *wrong*, *not relevant* or *intended* | false alarm |
| found | expired, still open, snoozed, or never suggested | unknown |
| not found | decided in the window: applied or done | miss |
| not found | decided in the window: dismissed as unwanted | avoided (right to stay quiet) |

**Precision** is hits / (hits + false alarms); **recall** is hits / (hits + misses). A finding the detector makes at
several points counts once (the card says at how many). **quiet** is the threshold multiplier to test ("what if quiet
were 2"); without one the detector's own current multiplier is used, and the result says which.

- **Built-in detectors** run with the ledger cut at each point (`asOfView` in `brain/backtest.ts` hides every event after
  it, whatever the query), so a backtest never sees the future. The detectors all read time from `ctx.now`.
- **Detector flows** run for real at each point, from the published version, with the trigger item carrying `asOf` and
  `backtest: true` next to the usual fields (`at` is the point, `lastRunAt` the one before, `reason` is `backtest`, and
  `quiet` is the multiplier under test). The run is marked a backtest without any wiring in the flow:
  **Suggest Improvement** posts nothing and returns the finding it would have posted (`saved: false, backtest: true,
  fingerprint, title, confidence`; a finding under the bar for that quiet comes back without a fingerprint and is not
  counted), **Landflow Usage** reads reports and events up to `asOf`, and the run is deleted afterwards and recorded
  neither in the ledger nor in Insights. **Find Similar** and Landflow Usage's *Search Facts*, *Workflow Knowledge* and
  *Suggestions* do **not** honour `asOf`: they answer as of now. Every other node in the flow really runs (an HTTP call, a
  message, Record Event), once per point, so a detector flow meant for backtests should only read.
- **What is not replayed**: workflows and agents as they were (their definitions are as they are now), the weekly cap
  and the hold-backs of a suggestion (30 days after a dismissal, recently applied), the model's enrichment.
- **Limits**: at most 90 days back; 200 points for a built-in detector and 40 for a flow (raise `step`); a backtest
  stops with the points it has after 5 minutes (`partial`). A flow backtest needs regular execution mode, not queue mode.
- **The gate**: a precision under `threshold` (default 0.5) marks the result failing (`gate.ok: false`), as the eval gate
  does for an agent's draft; nothing is blocked by it, the result says so. A backtest in which nothing found was decided
  passes with "nothing to score". Results are kept in `brain_backtests` (the last 30 per detector) and listed with
  `GET /api/brain/backtest?detector=`.

#### The analyst agent

**Create the Platform analyst** (Brain → What Landflow knows, or `POST /api/brain/analyst`) makes and publishes an ordinary agent:

- its persona: an analyst that looks numbers up before it answers, never invents them and files one concrete change at
  a time;
- its tools: four Landflow Usage tools (`usage_report`, `search_facts`, `workflow_knowledge`, `open_suggestions`) and
  `suggest_improvement`, with the arguments filled by the model.

In its chat (Test agent), the analyst draws differently from a plain chat:

- **What it reads**: chips above the chat, one per source its tools read (Runs, Usage & cost, Facts, Suggestions, and
  Team notebook when it has a notebook tool). The analyst is recognised by its tools: a Landflow Usage tool named
  `usage_report`.
- **While it looks**: the tool calls fold into the chat kit's activity line ("N steps · time"), which opens into the
  steps and ends with **Open trace**. A call waiting for your approval is always shown in full.
- **The answer card**: when the turn is done and a `usage_report` with at least two groups came back, one card with the
  period and scope ("This week · Tech Review Workflow", the scope from `workflow_knowledge`), the model's answer, the reply footer (time, steps, tokens, cost), a small
  chart (days as columns in time order; workflows, nodes or models as one labelled bar each, biggest first, with its
  value), and up to two of the model's own bullet lines as drivers. The bars are cost, else failures, else event
  counts, **taken from the tool results** (`lib/shared/analyst-chart.ts`), never parsed from the model's text; a dashed
  line shows a budget when a result states one (`budget`, `costBudget`, `budgetUsd` or `target` on the result or a
  workflow's profile). With nothing chartable the plain answer shows as before.
- **Next steps**: **Open the runs** (`/executions`, filtered to the workflow when a result names one) and **Suggest a
  fix**, which asks the analyst to call `suggest_improvement`; the suggestion still waits in the inbox for your Apply.

Ask it in its chat, from Slack, or use it in a flow with [Run an Agent](agents.md). Its suggestions have the source
`workflow`. Suggestions from `POST /api/proposals` have the source `analyst`.

#### Actions decided by the flow

A suggestion is no longer limited to "apply" or "mark done": the flow that makes it can say what the buttons are, and
other flows react to what was decided.

- **Buttons.** Suggest Improvement's **Actions** (or `actions` in `POST /api/proposals`) add up to four buttons:
  `{ id, label, style?: primary|default, confirm? }`. An id is lowercase letters, digits, `-` or `_` (up to 32) and
  can't be `applied`, `dismissed`, `snoozed` or `action`. `confirm` asks first. Both cards (Home and the canvas) show
  them next to Apply; Dismiss and Snooze stay.
- **Taking one.** `POST /api/proposals/:id/act { action, note? }` (edit access, like apply) saves
  `decision: { action, label, by, at, note }` on the suggestion, marks it applied (so effect measurement and quieting
  count it as applied) and starts the listening flows. It changes nothing else: what a button means is up to the flow.
  Apply, Dismiss (with its reason) and Snooze record a decision too (`applied`, `dismissed`, `snoozed`). Applying advice
  that has a listening flow no longer fails: it records the go-ahead, as a missing tool does.
- **On Suggestion Decided** (`core.suggestionDecidedTrigger`) starts a published workflow when a decision is made. Its
  filters are **Suggestion From** (a built-in detector or `flow:<id>`), **Label**, **Decisions** (a comma-separated
  list of `applied`, `dismissed`, `snoozed` and action ids; empty is all) and **About Workflow**. One run per decision,
  one item: the whole suggestion (`id, source, detector, label, title, why, evidence, effect, target, actions, ops,
  risk, confidence`) and `decision` (`applied`, `dismissed`, `snoozed` or `action`), `action` (the button's id),
  `actionLabel` (the button's text: `label` is the suggestion's), `reason`, `note`, `by`, `at`. The run starts in the
  background after the decision is saved. A trigger sees the suggestions its workflow's creator could see.
  No loops: a decision made by a workflow that starts from this trigger, or about one, starts nothing.
- **Build it** still works through On Usage Event on `proposal.applied`, and an On Suggestion Decided on missing-tool
  applies counts as a builder too. `started` in the apply and act replies lists every workflow a decision starts, and
  the toast names them.

#### Suggestions with an audience

An overlap alert concerns two owners in two projects; a suggestion that belongs to one project can't reach both. So a
suggestion may be addressed to named people.

- **Audience.** `audience: [{ userId?, email?, slackUserId?, name? }]` (up to 10) on `POST /api/proposals`, or Suggest
  Improvement's **Send To** (emails and Slack member ids, comma-separated, expressions allowed). An email is resolved to
  the Landflow user who has it (their id and name are filled in). The people in it see the suggestion in their Home
  inbox (`GET /api/proposals`, and `?for=me` for only what is addressed to them; Home's **For me** switch) even when it
  is about something outside their projects, and `GET /api/proposals/:id` opens it. They get only what the suggestion says
  (title, why, evidence, actions), not the target.
- **What they may do.** Dismiss, snooze and take a flow's buttons: yes. Apply: only when it changes nothing (advice, so
  "Mark done"); changes to a workflow or agent still need edit access to it, and a draft is any builder's, as before.
- **Mirror to Slack.** Suggest Improvement's **Mirror to Slack** (a Slack credential, as Ask a Person and tool approvals
  use) sends each audience member with a Slack id (or an email Slack's `users.lookupByEmail` knows) a direct message: title,
  why, evidence, and the buttons: the suggestion's own actions, **Apply** (only when there is something to apply),
  **Dismiss** (reason `not-relevant`) and **Snooze 7 days**. The message refs (channel and ts) are kept on the suggestion
  (`slack`), so a refresh with the same fingerprint doesn't post again (a member added since gets a message).
- **A click in Slack** reaches `/api/slack/interactions` (button ids start with `landflow_pr_`), must be signed by the app
  that posted it, and must come from a member of the audience. It calls the inbox's own functions (`applyProposal`,
  `dismissProposal`, `snoozeProposal`, `actOnProposal`), so one record holds both. The actor is the Landflow user behind
  the member (by user id, or email) or else `slack:<member id>`. Apply from Slack needs that Landflow user to have edit
  access; otherwise the member is told to open it in Landflow.
- **Both ways.** After any decision, from the inbox, the API or Slack, every mirrored message is updated to show what was
  decided and by whom (a snooze keeps the buttons).
- The card shows "For Dana, Lee" and a small chat mark when mirrored.

### 7. Measuring the effect

- **Baseline**: on Apply, the suggestion records a baseline from the week before. The metric depends on the detector:
  failure rate; p95; cost per run; runs by hand; or the thumbs-down rate for agents. A flow detector's suggestion about
  a workflow is measured by that workflow's failure rate, unless the flow [declares its own metric](#a-metric-your-flow-declares);
  one about the instance isn't measured unless it does.
- **Checks**: after 7 days it checks again. After 14 days it marks the outcome: worked, no effect, or worse (a 10%
  change either way decides; "better" is lower unless the metric says higher).
- **Memory**: the outcome becomes a `change` fact ("Applying “Retry the CRM call” helped: 12% of runs failing before,
  2% after").
- **Dismissals**: *intended* becomes an `intended` fact, so the brain and the analyst know it isn't a problem.

#### A metric your flow declares

A detector flow says how its own suggestions are judged, on the **Detector Trigger** (for all its suggestions) and,
optionally, on a **Suggest Improvement** node (for that one: *Same as the Detector Trigger*, *Landflow's own*, or its own
declaration). The suggestion keeps the declaration as `metricSpec`, and the card shows "Measured by: <name>".

- **Metric Name** ("Initiatives merged or reused") and **Better When** (higher or lower).
- **A usage query** (`usage`): event kinds (built-in, or custom ones from [Record Event](#your-own-event-kinds), such as
  `work.initiative_merged`), an optional attribute filter (as On Usage Event takes it), a measure (how many events; the
  sum of an attribute or of `cost`, `tokens`, `durationMs`, `items`; or their average), and whether it is about the
  suggestion's workflow or agent, or the whole instance. The instance is what the flow's creator can see
  ([scope](#principles)). Counts and sums are per week, so the 7-day and 14-day checks compare with the week before;
  an average is compared as it is.
- **A sub-workflow** (`workflow`): a workflow with a *When Called by a Workflow or Agent* trigger, run with one item
  `{ proposal, from, to, phase }` (`phase` is `baseline` or `check`, `from` and `to` ISO times of the window to
  measure). The number is read from a named field of its first output item (a numeric string counts). It runs as the
  production version with a timeout (120 s unless set, at most 600). If it is missing, fails, times out or answers with no
  number, **no value is recorded** (never a 0): a baseline is marked `failed` and a check is skipped, and the brain's
  next look tries again.
- **When it is measured**: a usage query is measured on Apply, like the built-in metrics. A sub-workflow takes a run, so
  Apply doesn't wait: the baseline is saved `pending` and filled in a moment later (`checkEffects` also settles any
  that are still pending or failed before it checks). The checks at 7 and 14 days run on the brain's effects look.
- **Words**: the card shows the name and the numbers ("Initiatives merged or reused: 9"), and the outcome fact says
  "Applying “…” helped: Initiatives merged or reused was 2 before and 9 in the two weeks after (higher is better)."

For example, the overlap finder: Detector Trigger with *A usage query*, name "Initiatives merged or reused", kinds
`work.initiative_merged`, how many, about the whole instance, better when higher. When people apply "merge these two
initiatives" and the flow (or whatever merges them) records `work.initiative_merged` events, the report can say how much
duplicate work was avoided.

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
| `GET /api/proposals`, `GET /api/proposals/:id` | suggestions (`?detector=` a built-in id or `flow:<workflowId>`; `?for=me`: only those addressed to the caller) | `workflows:read`, scoped; plus the ones addressed to the caller |
| `POST /api/proposals` | a suggestion from outside (source `analyst`; `audience` up to 10 people) | edit access to its workflow or agent |
| `PATCH /api/proposals/:id` | dismiss with a reason, or snooze | edit access to its target |
| `POST /api/proposals/:id/apply` | apply on the server | edit access to its target; any builder for a draft |
| `POST /api/proposals/:id/act` | take a flow-defined action `{ action, note? }`: records the decision, counts as applied, starts the listening flows → `{ proposal, warnings, started? }` | edit access to its target |
| `POST /api/proposals/:id/applied` | the editor applied it itself | edit access to its target |
| `GET /api/brain/status`, `/api/brain/facts`, `/api/brain/workflows/:id` | what it knows | `executions:read`, scoped |
| `GET /api/entities`, `GET /api/entities/:type/:id` | entities (`?type=&owner=&q=&projectId=&limit=`), one with its profile, facts and open suggestions | `workflows:read`, scoped to the caller's projects |
| `POST /api/entities`, `PATCH`/`DELETE /api/entities/:type/:id` | add or update (by `id`), change, delete | `workflows:write`, editor of the entity's project |
| `POST /api/entities/:type/:id/facts` | add a fact about an entity | `workflows:write`, editor of the entity's project |
| `POST /api/brain/run` | detect, study, effects or all, now; `detector` runs one detector alone (built-in or `flow:<id>`, published) | owners and admins |
| `POST /api/brain/backtest` | backtest a detector `{ detector, days?, step?, quiet?, threshold? }`: precision, recall, hits, false alarms, misses; waits for it | owners and admins |
| `GET /api/brain/backtest?detector=` | past backtests, newest first | owners and admins |
| `POST /api/brain/analyst` | make the Platform analyst | `workflows:write` |

## Limits

- Dead weight needs 60 days of ledger. On a new instance it waits, and the backfill only reaches as far as executions
  and audit events on disk.
- In queue mode, each process records its own events and starts On Usage Event workflows for them, so a trigger's batch
  holds one process's events.
- Ollama calls cost $0, so the AI-cost detector never suggests a smaller local model.
- The model writes fixes and drafts one at a time on the leader. A slow local model makes a study or detect run take
  minutes. `POST /api/brain/run` waits for it, detector flows included (up to 10 minutes each).
- A flow detector's effect is measured by its target workflow's failure rate unless it [declares a metric](#a-metric-your-flow-declares).
  A declared metric is a usage query or a sub-workflow, set on the nodes (not through `POST /api/proposals`). A
  sub-workflow metric's baseline lands a moment after Apply, and one that never gives a number is retried on every look.
  Apply does something only when the suggestion carries ops, a draft or persona rules; otherwise it is advice, marked done.

## Where the code is

- `apps/web/src/lib/server/usage/`: the ledger (`ledger.ts`), queries, reports and rollups (`query.ts`), the listeners
  and the backfill.
- `apps/web/src/lib/server/brain/`:
  - the loop (`index.ts`);
  - detectors, suggestions (`proposals.ts`), effects and declared metrics (`effect.ts`; the usage query is `usageAggregate` in `usage/query.ts`), the model's writing (`writer.ts`);
  - study and facts;
  - scope, the analyst and On Usage Event (`usage-trigger.ts`);
  - On Suggestion Decided (`decision-trigger.ts`; the decisions and actions are in `proposals.ts`);
  - flow detectors (`flow-detectors.ts`);
  - Find Similar (`similar.ts`);
  - entities (`entities.ts`; `apps/web/src/app/api/entities/` for their routes);
  - audiences and the Slack mirror (`audience.ts`; the Slack side of a click is in `slack/handlers.ts`);
  - backtests (`backtest.ts`; the run-level flag nodes read is `backtest-scope.ts`; table `brain_backtests`).
- `apps/web/src/lib/server/usage/kinds.ts`: the declared custom kinds and the attribute checks;
  `apps/web/src/app/api/usage/kinds/`: their routes.
- `apps/web/src/lib/server/mcp/brain-tools.ts`: the brain's tools on the instance MCP server.
- `apps/web/src/lib/server/nodes/usage.ts`: the seven nodes, `nodes/entities.ts` the Entity node; `nodes/vector-stores.ts` refuses the brain's collections.
- `apps/web/src/components/brain/`: the inbox, the canvas card, What Landflow knows (`brain-panel.tsx`) and the Brain page
  (`wiki/`); `apps/web/src/lib/server/brain/wiki.ts` builds the Brain page and Ask.
- Tests: `apps/web/test/brain.test.ts`, `apps/web/test/brain-events.test.ts` (custom kinds), `apps/web/test/brain-metrics.test.ts` (declared effect metrics), `apps/web/test/brain-actions.test.ts` (actions and On Suggestion Decided), `apps/web/test/brain-entities.test.ts` (entities), `apps/web/test/brain-audience.test.ts` (audiences and the Slack mirror).
- The newer pieces have their own limits, listed in their sections and in [limitations.md](limitations.md): custom kinds
  have no UI; entities are four fixed types without relations (the Brain page relates them only through shared work); a flow's button only records a decision unless a flow
  listens; Slack mirroring is DMs only and not retried; a flow backtest runs every node of the flow once per point.
