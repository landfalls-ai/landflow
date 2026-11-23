# Second brain: learning from how Landflow is used

Status: **built** (2026-10-31). The second brain studies what people and agents do on the platform and remembers what
it learns. It turns that into suggestions: fixes, cheaper or faster versions, a schedule for work run by hand, and new
workflows for what people keep asking for. You can build your own conclusions too: workflows that read the same usage
and post suggestions next to the built-in ones.

```
 observe ─────────► remember ─────────► conclude ─────────► propose ─────────► measure
 usage ledger       profiles, facts     21 detectors, your  Home inbox, canvas  did it help?
 (every run, edit,  and a searchable    workflows, the      card, a digest;     back into the
 AI call, action)   index               Platform analyst    Apply with a diff   facts
```

Try it: open **Brain** in the sidebar, then **What Landflow knows** (the gear at the bottom left; with an empty brain, ⌘P then `>` or the link on the index), and press **Run now** (owners and admins). Then open Home: suggestions
show up in the **Suggestions** card, and on the canvas of the workflow they are about.

## Principles

1. **Metadata, not payloads.** The brain learns from node types, shapes, error messages, durations, counts and costs.
   Before an error message is stored, emails, URLs with secrets, tokens, card-like and long numbers are replaced
   (`redact()` in `lib/server/usage/ledger.ts`). A failed run's input and output reach the model only when a project
   turns on **Let the second brain read run data** (project **Settings → Governance**, `brainPayloads`).
2. **Rules find, the model explains.** Detectors are SQL over the ledger with thresholds: cheap, testable and
   explainable. The model only writes what needs words: a fix for a failure, tips for a slow step, persona rules, a
   draft workflow. Every suggestion shows its evidence. A draft workflow is built planned first like Spotlight's (one plan
   call, then one call per step and a send-back each, on `LANDFLOW_BRAIN_MODEL`: usually 5 to 15 calls, at most 26), so a
   pass builds at most 3 drafts (`MAX_DRAFTS_PER_PASS`); a finding past the cap is saved without its draft. The only draft
   detector, *unmet demand*, already reports at most 3 requests, and a request whose suggestion is still open or snoozed keeps
   its saved draft while the prompt it was built from is the same (the suggestion stores a hash of it, `draftPromptHash`).
   When the prompt changes (its example requests change as requests leave the 30-day window) the next pass rebuilds the
   draft, and the rebuild counts against the cap; so what a pass costs is the drafts of requests not yet drafted plus those
   whose prompt changed. Dismissing a suggestion does not ask for a new draft: it holds the request back.
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
| `ai.call` | the `ai_usage` writer: provider, model, operation, tokens and cost. `attrs`: `provider`, `model`, `operation`, `input` (the whole prompt, cached tokens included), `output`, and `cacheRead` and `cacheWrite`, the parts of `input` the provider read from or wrote to its prompt cache (0 when it reports none); `cost` already prices them at the model's cache prices. The event's `projectId` is the run's (the caller's project, else the home project) and `goalId` is the goal the run served, so a ledger such as Landledger can total cost per project and per goal; filter with `GET /api/usage/events?projectId=&goalId=` |
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

#### Fact versions

A fact is a chain of versions, so a reworded fact keeps what it said before (`apps/web/src/lib/server/brain/facts.ts`).

- **The id a caller knows names the latest version.** A fact keeps its id (`workflow:w1:health`, or an entity fact's
  `entity:customer/acme:purpose:fact_…`). When the study, a suggestion, a person or Notion writes a different statement for it,
  the old row is copied to `<id>#v<n>` (not latest) and the id row becomes version n+1. Same words (spacing and case ignored):
  nothing new, only `last_seen`, confidence and evidence move. Every version's `root_id` is the chain id, and `parent_id` is the
  version before it; each row says who or what wrote it (`writtenBy`).
- **Reads see the latest live version only**: the list, the search, the Ask prompt, the MCP `brain_search_facts` tool, the
  Landflow Usage node, the Brain page and the Notion copy. The latest, not-forgotten, not-past-its-forget-after rule is in the
  SQL (`LIVE_FACT`), so a long history never reaches memory. `?history=1` on `GET /api/brain/facts` adds the old versions.
- **History**: `GET /api/brain/facts/:id/versions` (the id URL-encoded: entity fact ids hold `/`) lists the chain oldest first
  with the same visibility rule as the fact (404 when you may not see it; the versions of a forgotten fact only for people who
  may restore it); the Brain page's **History** button opens it.
- **At most 50 versions.** A chain keeps its first version and its newest 49; the oldest one past that is deleted with its row.
- **Static facts.** A fact added with `isStatic` (the Add Fact node's **Static**, the facts route's `isStatic`) never goes stale
  and the study, a suggestion's outcome and any other synchronous write leave it unchanged (logging `brain fact is static` with its id). A person's edit (Notion's pull of a person's own fact, `supersedeFact` with
  `replaceStatic`) changes it as a new version.
- **Relations.** `parentId` with `relation: 'extends'` or `'derives'` on `POST /api/entities/:type/:id/facts` (the node's
  **Linked Fact ID** and **Link**) starts a new chain whose `parent_id` is the linked fact; only `updates` moves a chain forward.
  The linked fact must be one the caller can read (404 otherwise).
- **Supersede for a person or an agent** (`supersedeFact`, `brain/fact-lifecycle.ts`) is all or nothing: the embedding is made
  first (an unreachable model answers 503 `MemoryIndexError` and writes nothing), then both rows go in one transaction (in
  Postgres one conditional write: of two writers of the same version one wins and the other gets 409 `StaleChainError`), then
  the vector, under the chain id. The study keeps its own batch: it writes rows and rebuilds the vectors once at its end.

#### Forgetting a fact

**Forget** (Brain page, `POST /api/brain/facts/:id/forget { reason, forgetAfter? }`) removes the latest version of a fact from
recall without deleting it: it leaves every list, search, prompt block and MCP tool, its vector is dropped, and the row stays
with the reason (1 to 500 characters, required), who and when. **Restore** (`POST …/restore`, the **Forgotten** list on the Brain
page) brings it back. Both are audited (`brain.fact_forgotten`, `brain.fact_restored`, with the reason and from/to) and need
editor access to the fact's subject (a workflow, an agent or an entity's project; owners and admins for node types, credentials and
the instance); a caller who cannot see the fact gets 404.

- **Forget after.** An ISO time a minute to five years ahead (`forgetAfter`, also on a new entity fact): from then on every read
  leaves the fact out, with no sweep. With it, **Forget** only sets that time.
- A forgotten fact stays forgotten when the study writes it again (a reworded statement still becomes a new version of it);
  restoring brings the current version back. A past version never becomes the latest again.
- A forgotten fact leaves the Notion copy: the next push trashes its row, and a restore writes it back as a new row. Restoring a fact that is not forgotten answers 409.
- The reason is a person's words: the audit log keeps it, and it comes back only in the forgotten list and an editor's history, never in a search, an MCP tool, the Usage node or a prompt (a live fact with a forget-after pending does not carry it either).

#### Memory backend

One interface, `MemoryBackend` (`apps/web/src/lib/server/memory/`), is how flows, MCP tools and agents read and write what Landflow
remembers. It has five operations over a **container**; the built-in backend maps containers onto the stores above, and a project
can choose a plugin instead.

| Container | Wire key | What it is | Who reaches it |
|---|---|---|---|
| Project | `project:<id>` | the brain facts of that project, plus memories added to it (subject `project`, kind `memory` or `intended`) | any member reads; editors write and forget |
| Team | `team:<id>` | the team's notebook notes (team and project scope; a run's own notes only for that run) | anyone with the team's access; notes are written only by a team run |
| Agent | `agent:<id>` | what the agent remembers about one user: private `agent-user` facts (`<agentId>/<userId>`), in their own vector collection `landflow-agent-memory` | that user, and the agent's editors (read) |

- **Operations.** `search(query, { mode, limit, threshold })` (modes `keyword`, `meaning`, `hybrid`; `limit` 1 to 50, default
  10; `threshold` 0 to 1; scores are 0..1 for both facts and notes, one formula, `fuseScores`), `profile` (static items, then the
  10 newest), `add(item, { replaces })`, `forget(id, reason)` and `list` (keyset pages). `add` with `replaces: <id>` writes the
  next version of that memory (C01, through `supersedeFact`); `<id>#v<n>` says "I read version n" and answers 409 when the chain has
  moved. A static memory is rewritten only by a person, not by a flow.
- **Access first.** Every call checks the container before reading, and a container the caller may not reach answers 404 "Memory
  not found", the same as one that does not exist. A flow acts as its creator; a seeded flow and an agent's tools act for the
  instance inside their own project only.
- **What `add` refuses.** The study's kinds (`health`, `cost`, ...) answer 400 "the study writes health facts"; a note outside a team
  run answers 400 "notes are written by a team run". `add` audits `brain.memory_added` (ids, container kind, who; never the text).
- **Private subjects.** An `agent-user` fact is left out of every brain read (the Brain page, Ask, Notion, the brain MCP tools, the
  study and its vector rebuild) unless the filter names both its type and its id.
- **No side effects.** A search from a playground or the API does not move a note's expiry; only a run that uses the result does.
- **Spans.** `memory.search`, `memory.add`, ... carry the backend, the container kind, the count and `landflow.memory.denied`; never text.
- **Fence.** Text returned to a model (the Memory nodes and the memory MCP tools) is inside the memory fence, so nothing in a memory can open or close a block.
- **Provider.** **Project → Settings → Agents in this project → Memory** (`memory` in `PATCH /api/projects/:id/settings`) chooses
  Built-in or a plugin node that declares `memoryProvider` ([protocol](protocol.md#memory-providers)) and the credential it uses. A
  provider serves the project container only. An error or a 10 s timeout fails the call with the provider's message; nothing falls
  back to the built-in store.
- **One index** (migration 2915) makes a project's facts a keyset read; there is no new table.

#### Memory nodes

Four core nodes use the backend, as steps and as agent tools (`apps/web/src/lib/server/nodes/memory.ts`): **Memory Search**,
**Memory Add**, **Memory Forget** and **Memory Profile**. Each asks for a container (a project, empty meaning the workflow's own,
or a team). In a step, Search returns one item per hit (`id`, `text`, `kind`, `source`, `score`, `version`); as a tool every node
answers a short JSON, and Search and Profile put the text inside the memory fence. Search and Profile are read-only; Forget is a
destructive change (its operation is `delete`), so an agent's Tool Approvals apply as for any other change. A flow cannot add to an
agent's own memory: only that agent's run writes it. A flow reads any project or team its creator can, but Add and Forget write only into the flow's home project or a team homed there (the flow is its creator's deputy, so it never writes into another project the creator happens to edit). Replacing or forgetting works only on a project's or an agent's own memory, never on a fact the study wrote, and the study's stale sweep never stales a memory.

#### Memory Extract

**Memory Extract** (`core.memoryExtract`, category AI, `apps/web/src/lib/server/nodes/memory-extract.ts`) turns text into facts with the
chat model on its **Chat Model** input (any model the host offers; the call goes through the model seam, so usage is metered and the
caps apply). It is not an agent tool: a model call per part that can write memory belongs in a flow a person built.

- **In.** **Text** (default `{{ $json.text }}`, at most 50,000 characters; every 8,000 is one model call and facts repeated across
  parts come out once), **Reference Date** (default `{{ $json.date }}`; empty is now; a date with a time and an offset keeps the calendar day it names, so `2026-11-20T23:30:00-08:00` is the 20th; one that is not a date fails the item naming it),
  **Memory Of** (a project, empty meaning the flow's own, or a team's notebook), an optional **Document ID**, **Compare With
  Memory** (on) and **Write to Memory** (off). Options: **Max Facts** keeps at most 200 per item; **Write Static Facts** (off) is described under Write. A team's notebook with Write on is refused before any model call.
- **Out.** One item per fact: `statement` (one claim, naming its subject: a statement that opens with a pronoun or holds two claims
  makes the model try again once), `subject`, `kind` (`static` for what stays true a long time, `dynamic`), `confidence`,
  `sourceSpan` (the words it came from), `label` and `matchId`, and for a fact with a time `timeText` (the words as written) and
  either `validAt` (an ISO date, or `from/to` for a period) or `unresolved: true`.
- **Dates.** A fixed list of English phrases is worked out by Landflow against the reference date in UTC days and overrides the
  model: today, yesterday, tomorrow, last or next a weekday (never the reference day itself), N days, weeks or months ago, in N
  days, weeks or months, and last, this or next week, month, quarter or year (a week runs Monday to Sunday). Said on a Sunday, "next Monday" is the next day and "last Monday" is six days back. Any other phrase is
  left to the model, whose date is kept only when it is real and within ten years of the reference; otherwise the words stay and
  `unresolved` is set. Other languages are left to the model.
- **Labels.** With Compare on, each fact is searched against the memory's five nearest items (a person's memories and a
  provider's items; never a fact the study wrote). The same words as a stored item are a `duplicate` without a model call; the rest
  are labelled `new`, `updates` (it replaces or corrects an item) or `duplicate` by the model in one call per 20 facts. A `matchId`
  must be one of the five the host listed: a wrong one makes the model try again, and after the second miss the fact is `new`.
- **Write.** Off, the node only labels. On, a `new` fact is added and an `updates` fact is written as the next version of the item it
  replaces (`memory.add` with `replaces`: the old version stays in its history, so it is superseded, not deleted); a `duplicate`
  writes nothing. Every fact is written as a normal (dynamic) memory, whatever `kind` the model gave it, unless option **Write Static
  Facts** is on: text a model reads can say "always remember: X is a rule", and a static memory is one only a person may change.
  Only a memory Landflow wrote is replaced: when the match was written by a person, the fact is written beside it as a new memory
  and says `label: updates`, `replaced: false` and why (`replaced: true` when it did replace). Each written item says `written`, `memoryId` and `version`. An update of a static
  memory is not written (only a person changes one): the fact says `written: false` and why, and the others carry on. A write goes
  to the flow's own project only; a team's notebook can be compared with but is never written (notes are written by a team run).
- **Provenance.** A written fact keeps its model confidence and up to five evidence rows: the run (with a link), the node, the
  Document ID if given, `validAt`, and the first 200 characters of its `sourceSpan`; never the whole text. The memory shows them as
  `confidence`, `origin` and `evidenceCount`.
- **Prompt and privacy.** The prompts are Landflow's own text (`memory/extract.ts`). The text and the stored memories reach the model
  inside the memory fence; the model's reply is schema-checked; facts are personal data and follow the memory's access rules, are
  never logged and never leave their project.
- **Fails.** A reply that is still invalid after the one retry fails the item with the model's reason; the calls are metered anyway.
  A memory provider that is down fails the item with its message and writes nothing for it.

**Memory Profile** gains **Sampled** (off: unchanged). On, it reads up to 2,000 items of the container and answers every static
fact (a person's first, then by how many distinct runs and documents back it, not evidence rows; all of them, read separately from the 2,000 newest others) plus at most **Sample Size** (60; 1 to 500) of the others, chosen by weighted buckets filled in
order: recent 35 %, high confidence 25 %, often revised (more than one version) 15 %, old 5 %, inferred 10 % (written by Landflow
with confidence under 0.8); what the weights leave goes to the newest. The weights are node options. It answers `static`, `dynamic`,
`left`, `markdown` and `fenced`: Markdown that fits **Token Budget** (1,500; 100 to 20,000; about four characters a token; a value that is not a number means the default), standing facts first, ending
"N more not shown". No model call and no randomness: the same memory gives the same profile. `fenced` is the same Markdown inside the memory fence: put that, not `markdown`, in a model's prompt, since what it holds is stored text a model must treat as data. As an agent tool the answer is the fenced Markdown. The profile is per container (a project, a team), not per person or subject.

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
| Work overlap | two people whose `org` work of the last 3 days shares an initiative, a customer, a directory of the same repository, or similar words, and who were not introduced in the last 14 days ([below](#work-overlap)) | one suggestion addressed to both: "Ana and Ben are both on billing", with the `org` titles |
| No safety net | an active workflow with 3+ failed production runs in 14 days and no error workflow | `setWorkflowSettings` with the error workflow you have, or a draft "Failure alerts" workflow when there is none |
| Unusual AI spend | an agent or a workflow with an unacknowledged flag of the last 7 days: its spend of a day was far from its usual day ([llm-gateway.md](llm-gateway.md#forecasts-and-unusual-spend)) | advice only (no operations): where to look, with the day, the figure, the baseline median and days, the score and the distinct runs; it names no person, and a person's or a model's day is not filed |
| Practice drift | an approved practice given 10+ times in 14 days and cited under 20% of them, or whose checks failed more than half the time ([practices.md](practices.md#compliance)) | advice: "Review <title>: rarely followed", with the numbers and a link to the practice; nothing is applied |
| Context bloat | an agent's or workflow's median input tokens per call this week over 1.5× the week before, with 20+ calls in each (`ai_call_parts`; `formatting` is not judged on Ollama, `knowledge` is not named) | advice: names the part that grew most (conversation so far, tool results, instructions) and what to trim |
| Fat tool results | tool results over 40% of an agent's input tokens, over 20+ calls in 14 days | advice: ask the tools for less (fewer fields, a row limit, a summary) |
| Unused tools | a tool name sent on 50+ calls of one Landflow agent in 30 days that none of its sessions called (the names of the tool calls only; not kagent agents or workflows) | advice: remove the tools from the agent |
| Cache misses | an Anthropic agent or workflow with a cache hit rate under 20% over 20+ calls in 14 days, with the most common miss reason | advice: keep the start of the prompt the same and long enough to cache |
| Repeated calls | the same prompt hash 5+ times in one day within one agent or workflow ("5 identical prompts in 3 runs"); the first prompt of a run is not counted when a call of that run carried tool results (a scheduled agent asks the same first question and fetches fresh data; the rows hold sizes and hashes, no prompt text, so tool results are read from the tool-results part) | advice: cache the answer or reuse it |
| Agent loops | an agent with 3+ sessions in 14 days that ended at its iteration limit, or whose longest session ran over 3× the typical highest iteration (5+ sessions) | advice: a stopping rule, a lower iteration limit, or a tool that answers what it keeps asking |

- **Waste detectors** (`lib/server/brain/spend-detectors.ts`, wave 14): the six above read `ai_usage`, `ai_call_parts` and the `agent.session` events of the last 14 days (30 for unused tools), count distinct runs (a session, an execution), target an agent or a workflow and name no person. Their evidence holds numbers, part names, tool names and hash prefixes, never text. Calls from Spotlight, the Agent architect and the brain (they carry a workflow id but are not the flow's own spend) are left out. **AI cost on a local model**: an unpriced local model has no cost, so it is judged on tokens from `ai_usage`: 20+ short answers a week to a large model (a `:<n>b` tag) name a smaller local model of the same family that this instance has seen in the last 30 days; none seen, no finding, and no dollar figure is made up.

- **Practice suggestions** (`source: practice`): every draft practice files one for the people who may approve it, and an approval, rejection or retirement on /brain settles it. A draft read from outside only links to /brain; one a person wrote is applied (approved) from the inbox by owners and admins only. Slack gets a link and no buttons ([practices.md](practices.md#the-inbox)).
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

### Work overlap

The detector `work-overlap` (`lib/server/brain/overlap.ts`) introduces two people who are working on the same thing.

- It reads only `org` work of the last 3 days; a private or `team` item is never selected. Two people count when their
  items share an initiative or a customer (also within one repository), a directory of the same repository, or words
  (the same repository alone is not enough, and a directory name across different repositories is none).
- Why not `team` work: the card's target is the instance, so owners and admins can open it, and a `team` title is for
  the owner's project mates only. Bringing team work in needs `canProposal` (`scope.ts`) to refuse non-audience readers
  of this detector, a change outside the detector's files (a follow-up in [limitations](limitations.md)).
- The suggestion is one card addressed to both people, in their inbox. No Slack message is sent on its own: a mirror
  needs a credential someone chose, and an admin naming one is a follow-up. It names both, and its evidence holds only
  `org` titles. A pair with a side that has no `org` item gets none.
- The same two people are not introduced again for 14 days after a card, whatever became of it. A card dismissed as
  *wrong* or *not relevant* holds the pair back for 30 days (the [held back](#4-detectors-and-suggestions) rule), and one
  dismissed as *intended* holds it for good: the pair is not introduced again. **Dismiss** with
  **Don't suggest this again** also mutes introductions for the person who pressed it (when it is one of the two): no
  pair with them is made again. A decision from Slack, or by an admin outside the pair, mutes no one, but the pair's own
  hold above still applies.
- Quieter when people dismiss it as wrong: each side must then show two or three items before it speaks.

### 5. Where you see it

- **Home → Your morning** and the top of the Brain index: your own briefing, with its delivery choice and, for an admin, **Set up tomorrow sync** ([work-and-briefings.md](work-and-briefings.md#on-the-web)).
- **Home → Suggestions**: the open suggestions the viewer can see, best first. Each card is compact: the title, one
  line of why (its first sentence), one button and **⋯**. **Show more** adds the kind, the subject, risk and
  confidence, the whole why, the evidence, what to expect and the **Changes** (the diff, as in Spotlight). What the
  change leaves out (*Leaves …*) is always shown, so nobody applies without seeing it. The Brain index uses the same card and can link to Home with **All suggestions**. The buttons:
  - **Apply**, which saves through governance; **Create workflow** for a draft; **Mark done** for advice.
  - **Build it** for a suggestion with a build prompt: it creates an empty workflow and opens the editor with Spotlight
    already building from the prompt ([below](#build-it-with-spotlight)).
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
- **Brain → What Landflow knows** (the gear at the foot of the Brain page's activity bar; it was on Insights):
  - the ledger's size, the facts, the model, and when the brain last studied and detected;
  - a search over the facts;
  - **Try a search**: the memory playground over the facts the caller may read (keywords, meaning or hybrid, threshold, rerank), with scores and what the threshold dropped; it changes nothing ([run-trace.md](run-trace.md#memory-playground));
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
- **List People**, **Gather Work**, **Write Briefing**, **Save Briefing** and **Deliver Briefing** (`core.brainListPeople`, `core.brainGatherWork`, `core.brainWriteBriefing`, `core.brainSaveBriefing`, `core.brainDeliverBriefing`) are the tomorrow sync's steps: they prepare a briefing for each person, items carrying ids and counts only ([work-and-briefings.md](work-and-briefings.md#the-nightly-sync)).

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
- **Systems from repositories, people linked to users.** The first `team` or `org` work event that names a repository makes a
  `system` entity for it ([work-and-briefings.md](work-and-briefings.md#repositories-as-systems)). A person page whose
  `attrs.email` is a user's email is linked to that user (column `user_id`, migration 2080, set when the page is saved);
  `personForUser(userId)` finds the page, falling back to the email match and storing the link. The entity then carries
  `userId` and `userName` ("This is <user>"); the screens that show it come later.
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
  - **Activity bar**: Explorer (the tree, the open file's **Outline** and its **Backlinks**: the pages
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
  - **Ask** (the **Ask** button in the title bar, or ⌘K, or ⌘I): the one way to ask the brain. It opens the app's one
    [Spotlight](spotlight.md#one-spotlight), a 360 px column at the right of the page, the same on every page of Landflow: the page narrows and nothing overlaps, and a link in an answer opens
    that page in the editor beside it while the answer stays. With a page open, the question is about that page (the
    `@` chip) until the chip is removed. The answer streams: first **Found 3 pages · 2 facts · 5 work items** (with
    the pages as links), then its steps and its words, then the model, time, tokens and cost under it (a local model
    says "local"). In a project linked to Notion, **· 2 Notion pages** joins that line and a cited `[n]` after the work items
    links to the page in Notion ([notion-brain.md](features/notion-brain.md#your-companys-pages-as-knowledge)). A follow-up ("and since when?") knows the last two turns of the conversation. A source is numbered
    only when the answer cites it, and a `[n]` that points at no work item is dropped. **New conversation** clears
    it. On a phone Ask is a bottom sheet; a link closes it to show the page, and the Ask button brings it back with
    the same answers.
  - **A key's tags follow its scopes.** A tag reads a digest, so an API key tags only what its scopes cover: the scopes of each kind's own routes, one table for the search, Spotlight and Ask (`MENTION_KEY_SCOPE` in `lib/server/mentions/key-scopes.ts`): brain pages with `brain:read` or `workflows:read`; workflows, nodes, agents, teams, data tables, templates, node types and plugins with `workflows:read`; runs with `executions:read`; people and credentials with `admin`, as `/api/users` and `/api/credentials`. A `brain:read` key tags only brain pages. The rest is told as "Couldn't read @X" with no digest. Tags past the cap of 8 (the page chip counts) are told as "Left out @X". `{ question, about }` without `mentions` answers as before, with the fact list.
  - **Ask keeps its conversations, and takes tags.** Each page has its own conversation (kept when **Keep my
    conversations** is on): open a page and its last conversation is there under **Earlier**; new questions continue
    it. Following a link in an answer (or in "Found N pages") to another page keeps the answers on screen: a turn still
    streaming finishes and is stored in the page it began on, and the page's own conversation is not resumed over them.
    They stay until you ask on the new page, press **New conversation** or open another from the history. A panel
    with no answers of this visit resumes the page's last conversation (`subjectChange`). On a phone the link closes
    the sheet; the Ask button brings it back with the same answers. The clock button in the panel header (in the row above the box on a
    phone) opens the history: this page's conversations, then all of Ask's, with rename and delete
    ([history](assistant.md#conversation-history)); **New conversation** starts a clean one. On the index and the log
    there is no page, so nothing is resumed there. `@` in the box tags a page, a person, a workflow, a run or anything else
    the picker lists ([tagging](assistant.md#tagging-with-)); "On this page" has the open page and the pages the last answers
    linked to. Each tag is checked as you and read into the answer, and shows in the steps as **Read @Billing**; one you may
    not open shows **Couldn't read @Billing** and nothing else. A kept turn holds your words, the tags' names, the answer
    with its links and the steps, never what was read from a tag. When you reopen one, a link to a page you can no longer
    open is dropped and the turn says **1 link hidden**. The model, time and cost footer comes back too.
  - **Quick open** (⌘P; ⌘K opens Spotlight): go to a file by name or path, or `>` for commands (open index or log, toggle Source,
    Problems, Suggestions, run the brain). It only finds pages; it does not ask.
  - **Panel** (⌘J): **Problems** (initiatives and customers without an owner, pages quiet for 30 days, summaries behind
    their work) and **Suggestions** with their buttons. **Status bar**: two items, the page count and the problems
    ("12 pages · 0 problems"). The Explorer has no Open editors list; the tabs are the open files.
  - **An empty brain** shows the index alone: no Explorer, activity bar or tabs, until the first page exists.
    What Landflow knows stays reachable: a link in the empty index's intro, the command bar (⌘P, then `>`), and
    `/brain/settings`. The side-bar commands and ⌘B are left out while there is no side bar.
  - **On a phone**: the side bar is a drawer behind the Files button, with the views at its top; tabs scroll; the Ask
    button stays in the title bar and the status bar at the bottom.
  - **Practices** (a view on the activity bar, with a count of drafts waiting): the rules connected agents follow. See
    [practices.md](practices.md#the-brain-page).
- **index.md**: **Shared across teams** (customers and initiatives two or more teams worked on in the last 7 days, most
  teams first, with their teams, people and latest items: no other product flags this, and it is what the Company
  Brain is for), **Suggestions**, **Teams this week** and **Needs a person**. A card with nothing in it is not shown, and the Source view leaves out its heading too.
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
  the model answers from those alone, in a few sentences with page links and numbered work. A link to a page that does
  not exist (or that the reader can't open) shows as a plain word, whatever its form (`[[Support/11]]` reads
  "Support"), and a fact about something with no name is given to the model by its kind ("a workflow"), never by its
  id. Leaving the Brain page mid-answer stops it, as **Stop** does. Without a model it returns
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

**In Notion.** When the project is linked to a Notion page, the brain is also written there (pages, facts, practices and notes, with a body per page and your own notes below Landflow's part), within seconds of each change: see [features/notion-brain.md](features/notion-brain.md#what-landflow-writes).

**Notion on the page (NB07).** For a page of a project linked to Notion, a chip in the title bar says how it syncs ("In Notion ·
synced 2 minutes ago", amber when something needs a look or it is paused, red when Notion refused the key or stopped seeing the
page; on a phone it sits in the status bar), the chips row has **Open in Notion** (the page's own row), "Changed in Notion by <name>,
replacing your edit" shows for 7 days after a later edit in Notion replaced a value, and **Your notes (from Notion)** shows what a
person wrote under the page's "Your notes" in Notion, read-only and always as text. The Problems panel gains a **Notion sync** group:
each problem the link has, in Landflow's words, with a link to its Notion page and the buttons the viewer may press (**Dismiss**,
**Put back**, **Keep as a fact**; **Repair** and **Delete in Landflow** for the project's admins), and the status bar's problem count
adds them. A project with no link shows none of it. Setting it up is the project's Brain card
([notion-brain.md](features/notion-brain.md#setting-it-up)).

#### The graph

The Brain page's **Graph** tab (the graph button in the activity bar, **Show the graph** in ⌘P, and a button in a page's
breadcrumb bar for that page's graph) draws what the brain knows as a force graph: subjects (workflows, agents, pages and
projects) as squares, facts as dots, and a thin **About** line from each fact to its subject. **Show history** adds the earlier
versions of a fact, faded, joined to the next version by an arrow: **Updates** (a new version of the same fact), **Extends** and
**Derives** (a fact built on another). **Show forgotten** adds the facts you may restore, dashed and red; stale facts are hollow.
A page's graph has **This page** and **One link away** (the pages it shares work with, or the agents and workflows it uses, at
most 50). Hover a node for its words (always as text), kind, version, confidence and dates; click a subject to open its page and
a fact to see its [versions](#fact-versions). Drag to pan, scroll or **+** and **-** to zoom, **0** or **Fit** to see everything,
arrows to pan. The layout settles in the browser in about two seconds and then stops, and it pauses while the tab is hidden.

It shows 500 facts at a time (**Load more** adds the next 500; the layout keeps where the first ones settled). Facts about
workflows, agents and pages you cannot open are left out in the query, and a person's private agent memory is never in it. A
project's memories appear in that project's own graph (`about=project/<id>`) for its members, and in the whole-brain graph only
for owners and admins. A phone shows a list grouped by subject instead, each later version indented under the one it
replaced (a **List** switch gives the same on a desktop, which is also the way to read it with a screen reader).
`GET /api/brain/graph` ([api.md](reference/api.md)) serves it. The layout code is adapted from Supermemory's MIT-licensed
`memory-graph`; its notice is in `apps/web/src/components/brain/graph/NOTICE.md` and the repository's `THIRD_PARTY_NOTICES.md`.
Code: `components/brain/graph/`, `lib/server/brain/graph.ts`; tests `test/brain-graph.test.ts`, `test/brain-graph-view.test.ts`.

#### The vector collections

Workflows and agents can't read or write `landflow-brain` and `landflow-brain-<project>` with a Vector Store node: the
node refuses any collection with that name (case ignored) and points at Find Similar and Landflow Usage, which return
only what the workflow's creator can see. The brain itself writes them and searches the ones the caller's projects own. The same holds for `landflow-notion-<project>`,
where a linked project's Notion pages are indexed as knowledge, and now also for an agent's own knowledge tool and a project's
knowledge setting: naming a collection with either prefix is refused ("is the second brain's own collection"); only the runtime
builds the tool for a project's own Notion brain, and Ask's fourth source (up to 5 Notion pages of the projects the asker can
read, only for projects with an active link) reads the collection.

#### The brain over MCP

What a person's tools send the brain about their work, and the briefing that comes back, are in
[work-and-briefings.md](work-and-briefings.md#over-mcp): `record_work`, `my_briefing`, the `morning-briefing` prompt and the `brain://` resources.

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
| `brain_ask` | ask the brain a question (`question`, `about`), like `POST /api/brain/ask` (with the Notion pages of linked projects as `knowledge`) |
| `brain_search_knowledge` | passages of the company's Notion pages in the caller's linked projects (`query`, `limit`, default 5): `{ results: [{ title, url, passage, score }] }`; `brain:read` |
| `my_briefing` | the caller's own briefing (`day`) |
| `my_ai_spend` | the caller's own AI spend and caps (`period`: `24h`, `7d`, `30d`, `90d`), as text and JSON; never anyone else's ([llm-gateway.md](llm-gateway.md)) |
| `record_work` | save the caller's own work events, private |
| `project_context` | the "Where this work fits" block of the project that lists a repository, or of a project you name (`repo`, `projectId`, `size`); the resource `project://{id}/context` is the full block ([connect-your-harness.md](connect-your-harness.md#project-context)) |

On a project linked to Notion, each fact `brain_search_facts` and `brain_workflow_knowledge` list, and each page and fact `brain_ask` names, carries `notionUrl`, the Notion row it was copied to (none when the project is not linked, the row was trashed in Notion or the link is disconnected). To read the pages in Notion itself see [Your company's tools on Notion](connect-your-harness.md#your-companys-tools-on-notion).

Practices: see [practices.md](practices.md#following) (`practices_for`, `practice_get`, `practice_cite`,
`practice_draft` and the `practices://` resources).

**What these tools return is quoted data.** The JSON of `brain_search_facts`, `brain_workflow_knowledge`, `check_overlap` and
`brain_ask` keeps its shape (a client parses it), and each `statement`, `summary` (and, in `check_overlap`, `goal`) string in it
goes through the memory fence's escaper, so a stored `</landflow-memory>` arrives as `&lt;/landflow-memory>` and honest text is
unchanged. The Brain Usage and Entities nodes do the same in tool mode (a flow's own step still sees the original). The Ask
prompt puts its pages block, with each stored summary, in one `<landflow-memory source="brain-summaries">` fence.

##### Memory over MCP

The instance server also answers to Supermemory's nine memory tool names, so a harness prompt that already knows them works
against a local Landflow ([C08](specs/20-combined/C08-memory-mcp/spec.md)). Each is a thin mapping onto the
[memory backend](#memory-backend): its access checks, its provider choice and its spans. A **space** is a memory container:
`project:<id>`, `team:<id>` or `agent:<id>` (a bare project id works); on a project server (`/api/mcp/projects/<id>`) every
tool acts in that project whatever `space` says.

| Tool | Scope | Does |
|---|---|---|
| `search_memory { query, space?, mode?, limit?, threshold? }` | `brain:read` | best matches, by keywords and meaning; with no space, every project you can open (the 20 most recently changed) |
| `get_profile { space? }` | `brain:read` | the standing memories, then the most recent |
| `list_memories { space?, cursor?, limit? }` | `brain:read` | one space's memories, newest first, `nextCursor` to continue |
| `list_documents { space?, cursor?, limit? }` | `brain:read` | the Brain pages you can open, as `<type>/<id>` plus `index` and `log` |
| `get_document { id }` | `brain:read` | one page as Markdown; a page you cannot open is "not found" |
| `list_spaces {}` | `brain:read` | the projects you can open, their teams' notebooks and your agents with memory across sessions |
| `who_am_i {}` | `brain:read` | your user, the key's scopes and the project |
| `add_memory { text, space?, kind?, isStatic?, forgetAfter? }` | `brain:write` | save a memory (kind `memory` or `intended`; default space: your own project) |
| `forget_memory { id, reason }` | `brain:write`, destructive | stop recalling a memory you may edit, with a reason |

Text a model reads is one `<landflow-memory>` fence; `structuredContent` carries the plain values (the readers declare an
`outputSchema`). `add_memory` and `forget_memory` need a person's key, not the instance access token, which only reads (as an
owner). A write is recorded as the key's person with origin `person`; its audit row (`brain.memory_added`, `brain.fact_forgotten`)
carries the key id, and `brain.memory_added` also `via: mcp`. `forget_memory` is annotated destructive, so an MCP grant set to
`destructive` waits for a person's approval ([features/ai.md](features/ai.md#mcp)). `/connect` says how many tools the chosen
scopes reach (a `brain:read` key 19, with `brain:write` 25, plus the workflow scopes).

An API key sees only the tools its scopes cover (`brain:read`, `brain:write`; [features/ai.md](features/ai.md#mcp)). Each tool sees what the token's user sees (an instance access token sees everything), cut down to the project on a
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
  record into them. The GitHub kinds (`work.pr_closed`, `work.pr_reviewed`, `work.review_requested`, `work.ci_failed`,
  `work.ci_passed`) list their own fields (`repo`, `prNumber`, `state`, `reviewState`, `ciConclusion`, `ciDurationMs`, `ciAttempt`,
  `waitedMs`); see [GitHub into the brain](features/integrations.md#github-into-the-brain).

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
  can't be `applied`, `dismissed`, `snoozed` or `action`. `confirm` asks first. Every card (Home, the Brain and the
  canvas) keeps one button: Apply, with the flow's buttons under **⋯** beside Dismiss and Snooze; for advice that has
  buttons of its own, the first of them takes Apply's place (drawn as the primary button) and the rest go under **⋯**.
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

## Nightly SDLC velocity

The company's software lifecycle, read from the brain's `work.*` events, and the flows that would raise its velocity,
as suggestions. It is the template **Nightly SDLC velocity** (`brain-sdlc-velocity`): Schedule (daily 03:00) → Velocity
Signals → Propose Flows → Suggest Improvement.

- **Velocity Signals** (`core.velocitySignals`; window in days, default 14, an optional repository list and signal
  types) outputs one item per signal above its threshold, with the numbers and the evidence (event ids, at most 12):
  - *Cycle time*: median and slowest tenth of opened to merged, per repository (flagged above 72 hours).
  - *Review wait*: median and slowest tenth of the wait for a first review, per repository (above 24 hours).
  - *Rework*: the share of pull requests that got "changes requested" (above 35%).
  - *Flaky CI*: a failure and then a pass on the same commit, per repository (2 or more).
  - *Toil*: the same work-session phrase (digits folded) or the same empty search, ask or missing-tool signature 5 or
    more times.
  - *Handoffs*: pull requests with 3 or more review rounds, 2 or more of them in a repository.
  A repository needs 3 pull requests before it is judged. The thresholds are named constants (`THRESHOLDS` in
  `brain/velocity.ts`). The pull request, review and CI kinds come from the GitHub ingest template
  ([work and briefings](work-and-briefings.md)); a flaky pair is a failed attempt and a later passing attempt of the same workflow run (its run id),
  or a failure and a pass on the same commit when an event carries a `sha`, `headSha` or `commit` attribute; an event
  with neither is skipped. The template's commit statuses are not paired: each carries its own status id and no
  commit attribute, so a failed and then a passing status on one commit count as two separate runs.
- **About the process, never a person.** A signal is about a repository, a kind of work or a phrase. No field names an
  author or a reviewer, nothing is ranked by person, and the node reads only what a system reader may: events shared
  with the organization and the platform's own, never a private one and never a `team` one (the suggestion reaches the
  whole instance).
- **Propose Flows** (`core.proposeFlows`; **Use the Brain's Model**, **Most Ideas**, default 5) turns each signal into one
  idea: a title, why (with the evidence), the expected effect and a build prompt. It asks the brain's model
  (`LANDFLOW_BRAIN_MODEL`); with the model off, or when its answer does not fit, a rule per signal type writes it ("Ping
  the reviewer when a PR waits over a day", "Re-run flaky CI once and label it", a checklist comment on new pull
  requests, a nudge when review rounds pile up, a flow for a repeated task).
- **Suggest Improvement** posts each idea as a suggestion labelled "SDLC velocity", with a fingerprint per signal, so the
  next night refreshes it instead of adding another, and a dismissed one stays away as for any suggestion.

## Build it with Spotlight

Suggest Improvement's **Build Prompt** (up to 2,000 characters; `POST /api/proposals` does not take it yet) makes
the card's button **Build it**. Applying it creates an empty workflow named after the suggestion, in the caller's home
project, records the go-ahead like any applied suggestion, and the page opens `/workflows/<id>?ask=proposal:<id>`. The
editor loads the suggestion (`GET /api/proposals/:id`), Spotlight sends its build prompt as the person's message once
(their click on Build it was the go-ahead; the parameter leaves the URL so a reload does not send it again), and builds
the flow: on the empty canvas the whole flow at once, with the chat folded to the side card and the canvas in view. The
flow is a draft until the person saves and publishes it. Spotlight sends the prompt only on the workflow Build it
created for that suggestion (the suggestion is applied and its `createdWorkflowId` is this workflow), and only while
its canvas is empty, so opening the link again after the build sends nothing; on any other workflow the parameter is
dropped. The route treats a build prompt like a stored draft: any builder may apply it, and
the workflow goes in `?projectId=` or the caller's home project, after the same create check as any new workflow.
The Slack mirror shows no Apply button for it and refuses an Apply click for it (only the web builds it).

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
  - the store seam and the change feed every brain write goes through (`store/`: `brainStoreFor`, `onBrainChange`, `changeOrigin`; [features/notion-brain.md](features/notion-brain.md#how-it-is-built));
  - the Notion pull (`notion/pull.ts`, `conflicts.ts`, `problems.ts`): a page a person adds in a linked Notion page is an entity with `source: 'notion'`, a fact they add is a fact with the evidence `Notion`, and the text under "Your notes" on a page is a knowledge doc (not an attribute) ([features/notion-brain.md](features/notion-brain.md#what-comes-back-from-notion));
  - audiences and the Slack mirror (`audience.ts`; the Slack side of a click is in `slack/handlers.ts`);
  - backtests (`backtest.ts`; the run-level flag nodes read is `backtest-scope.ts`; table `brain_backtests`).
- `apps/web/src/lib/server/usage/kinds.ts`: the declared custom kinds and the attribute checks;
  `apps/web/src/app/api/usage/kinds/`: their routes.
- `apps/web/src/lib/server/mcp/brain-tools.ts`: the brain's tools on the instance MCP server.
- `apps/web/src/lib/server/brain/velocity.ts` (the signals, pure), `nodes/velocity.ts` (Velocity Signals, Propose Flows), `templates/builtin-velocity.ts`, and `components/editor/spotlight/ask-param.ts` (`?ask=`). Tests: `apps/web/test/velocity.test.ts` (`velocity-live.test.ts` with `LANDFLOW_INTEGRATION=ollama`).
- `apps/web/src/lib/server/nodes/usage.ts`: the seven nodes, `nodes/entities.ts` the Entity node; `nodes/vector-stores.ts` refuses the brain's collections.
- `apps/web/src/components/brain/`: the inbox, the canvas card, What Landflow knows (`brain-panel.tsx`) and the Brain page
  (`wiki/`); `apps/web/src/lib/server/brain/wiki.ts` builds the Brain page and Ask.
- Tests: `apps/web/test/brain.test.ts`, `apps/web/test/brain-events.test.ts` (custom kinds), `apps/web/test/brain-metrics.test.ts` (declared effect metrics), `apps/web/test/brain-actions.test.ts` (actions and On Suggestion Decided), `apps/web/test/brain-entities.test.ts` (entities), `apps/web/test/brain-audience.test.ts` (audiences and the Slack mirror).
- The newer pieces have their own limits, listed in their sections and in [limitations.md](limitations.md): custom kinds
  have no UI; entities are four fixed types without relations (the Brain page relates them only through shared work); a flow's button only records a decision unless a flow
  listens; Slack mirroring is DMs only and not retried; a flow backtest runs every node of the flow once per point.
