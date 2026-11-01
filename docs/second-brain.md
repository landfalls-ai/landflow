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
4. runs the detectors, and studies when the last study is a day old.

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
- **Quieter detectors**: a detector whose decided suggestions are mostly dismissed as wrong or not relevant gets its
  thresholds multiplied (×1.5, ×2, ×3).

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
  - each detector's record;
  - **Create the Platform analyst**;
  - **Run now**.
- **Project settings → Governance**: **Let the second brain read run data**.

### 6. Your own conclusions

Three nodes make the brain something workflows can use:

- **Landflow Usage** (`core.landflowUsage`, usable as an agent tool). Its operations:
  - Report: grouped by day, kind, workflow, node type, signature, agent or model;
  - Events;
  - Search Facts;
  - Workflow Knowledge: the outline, profile, facts and open suggestions;
  - Suggestions.
- **On Usage Event** (`core.usageTrigger`) fires on ledger kinds.
  - Filters: one workflow, *only new failures* (a signature never seen before), a minimum AI-call cost, and for
    `proposal.applied` the detector that made the suggestion (**Suggestion From**).
  - It batches events for `batchSeconds`. Items carry `workflowName` and `agentName`, and a `proposal.applied` item the
    whole suggestion in `proposal` (id, detector, title, why, target, evidence, effect, appliedBy): an event's
    attributes keep 200 characters, too few for a plugin sketch.
  - Events from workflows that have this trigger never start one (no loops).
- **Suggest Improvement** (`core.suggestImprovement`, usable as a tool) posts a suggestion to the inbox: a title, why,
  the workflow and node, the expected effect, ops as JSON (checked against the workflow; `[]` for advice), risk,
  confidence, and a fingerprint.

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

Ask it in its chat, from Slack, or use it in a flow with [Run an Agent](agents.md). Its suggestions have the source
`workflow`. Suggestions from `POST /api/proposals` have the source `analyst`.

### 7. Measuring the effect

- **Baseline**: on Apply, the suggestion records a baseline from the week before. The metric depends on the detector:
  failure rate; p95; cost per run; runs by hand; or the thumbs-down rate for agents.
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
| `GET /api/usage` | a grouped report | `executions:read`, scoped |
| `GET /api/usage/events` | the events | `executions:read`, scoped |
| `POST /api/usage/signal` | an editor signal (`search.empty`) | `workflows:write` |
| `GET /api/proposals`, `GET /api/proposals/:id` | suggestions | `workflows:read`, scoped |
| `POST /api/proposals` | a suggestion from outside (source `analyst`) | edit access to its workflow or agent |
| `PATCH /api/proposals/:id` | dismiss with a reason, or snooze | edit access to its target |
| `POST /api/proposals/:id/apply` | apply on the server | edit access to its target; any builder for a draft |
| `POST /api/proposals/:id/applied` | the editor applied it itself | edit access to its target |
| `GET /api/brain/status`, `/api/brain/facts`, `/api/brain/workflows/:id` | what it knows | `executions:read`, scoped |
| `POST /api/brain/run` | detect, study, effects or all, now | owners and admins |
| `POST /api/brain/analyst` | make the Platform analyst | `workflows:write` |

## Limits

- The vector collections aren't access-controlled by themselves. The routes and nodes only search the collections of
  the caller's projects, but a Vector Store node pointed at `landflow-brain-<project>` reads it directly.
- Dead weight needs 60 days of ledger. On a new instance it waits, and the backfill only reaches as far as executions
  and audit events on disk.
- In queue mode, each process records its own events and starts On Usage Event workflows for them, so a trigger's batch
  holds one process's events.
- Ollama calls cost $0, so the AI-cost detector never suggests a smaller local model.
- The model writes fixes and drafts one at a time on the leader. A slow local model makes a study or detect run take
  minutes. `POST /api/brain/run` waits for it.

## Where the code is

- `apps/web/src/lib/server/usage/`: the ledger (`ledger.ts`), queries, reports and rollups (`query.ts`), the listeners
  and the backfill.
- `apps/web/src/lib/server/brain/`:
  - the loop (`index.ts`);
  - detectors, suggestions (`proposals.ts`), effects, the model's writing (`writer.ts`);
  - study and facts;
  - scope, the analyst and On Usage Event (`usage-trigger.ts`).
- `apps/web/src/lib/server/nodes/usage.ts`: the three nodes.
- `apps/web/src/components/brain/`: the inbox, the canvas card and the Insights panel.
- Tests: `apps/web/test/brain.test.ts`.
