# Agent evals: saved task sets, run on every change, scored and diffed

## Problem

[ai.md](../features/ai.md#evaluations) has two kinds of evaluation and neither fits a standalone agent's own changes:

- **Offline** runs (`evaluation_runs`, `evaluation_cases`, `lib/server/evaluations/runner.ts`) belong to a *workflow*:
  an Evaluation Trigger reads a Data Table or file and runs the workflow once per row. An agent can only be evaluated by
  wrapping it in a flow.
- **Online** grading (`online_eval_configs`, `online_eval_scores`, `evaluations/online.ts`) samples real conversations
  with an LLM judge. It tells you the agent was bad after users met it, and it cannot compare "before the persona edit"
  with "after".

Nothing re-runs a fixed set of tasks when an agent's persona, instructions, tools or model change
(`AgentStore.saveDraft()` / `publish()` in `lib/server/agents/store.ts`), so a regression from a prompt tweak or a model
swap is found by hand. [run-trace.md](../run-trace.md) already has per-run checks (`ctx.check`, the Run Report's
built-in checks, guardrail stops) but only for a single run, not across runs over time.

## Goals / Non-goals

Goals
- Saved **task sets** per agent: input message(s) plus expected checks (text contains / not contains / regex, tools
  called or not called, step and token ceilings, a judge rubric, and named Run Trace checks that must pass).
- A **run** executes every case against a chosen agent version (draft or published), scores it 0-1 per case and overall,
  and stores the agent config that produced it, so two runs can be **diffed**: score deltas, cases that flipped, and
  which config fields changed (persona, instructions, model, tools).
- Run on demand, on a schedule, and automatically on draft save / publish when the set opts in.
- A drop below a threshold raises an alert through the existing alert channels.

Non-goals
- Replacing online grading or the workflow Evaluations tab (reuse their metrics and alert code, do not merge the UIs).
- Evaluating teams (`agent-teams`) or remote A2A agents; a first version covers Landflow agents on Landflow's runtime.
- Auto-tuning prompts (that belongs to the second brain's proposals).

## Design

### Data model (new; sketch, numbers follow the latest migration, 2041)

Migration `2060 agent_evals`, in `MIGRATIONS` and with each table added to `TABLES` (primary keys listed):

```sql
CREATE TABLE IF NOT EXISTS agent_eval_sets (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL   -- cases, auto-run, threshold, judge model
);
CREATE INDEX IF NOT EXISTS agent_eval_sets_agent ON agent_eval_sets (agent_id);
CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id TEXT PRIMARY KEY, set_id TEXT NOT NULL, agent_id TEXT NOT NULL, number BIGINT NOT NULL,
  status TEXT NOT NULL, trigger TEXT NOT NULL,            -- manual | schedule | save | publish
  agent_version TEXT NOT NULL, config_hash TEXT NOT NULL, -- 'draft' or the published number; hash of the AgentConfig
  score DOUBLE PRECISION, started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT,
  data TEXT NOT NULL                                      -- config snapshot, per-metric averages, cost
);
CREATE INDEX IF NOT EXISTS agent_eval_runs_set ON agent_eval_runs (set_id, started_at);
CREATE TABLE IF NOT EXISTS agent_eval_cases (
  run_id TEXT NOT NULL, idx BIGINT NOT NULL, session_id TEXT, execution_id TEXT,
  status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, idx)  -- per-expectation results, reply, tools, tokens
);
```

It mirrors `evaluation_runs` / `evaluation_cases` (migration 500) and the `heartbeat_at` column of migration 1880s.
Agents live in files or in `agent_definitions` depending on `LANDFLOW_CONFIG_STORE`, so sets are database rows keyed by
`agent_id` in both modes (no file store), and are deleted with the agent (`AgentStore.delete`). Keep the last 100 runs per
set (`MAX_RUNS_PER_WORKFLOW` pattern in `evaluations/store.ts`).

### Running a case

New module `lib/server/evaluations/agent-runner.ts`. For each case: `newSession(agent, { version, ... })` and
`runAgent({ agent, session, message, approvals: 'deny', rootTrace: true })` from `lib/server/agents/runtime.ts`.
`approvals: 'deny'` means a tool that needs approval fails instead of waiting, as schedules do. Memory is not written
(the `remember` tool is disabled for eval sessions), and the session is marked as an evaluation run so online grading
and Insights skip it (as `evaluation_run_id` does for executions). `configFor(agent, version)` picks the draft or a
published version, so a run can compare "published v3" with "draft".

Scoring reuses `evaluations/metrics.ts`: `contains`, `regexMatch`, `toolsUsed`, `judge(model, 'rubric', ...)` (the judge
defaults to the agent's own model, as online grading does). New small metrics: `toolsNotCalled`, `maxToolCalls`,
`maxTokens`. **Run Trace checks**: agent sessions already journal (`journal/agent-session.ts`: a guardrail block becomes
a check). An expectation `{ check: 'Guardrail', status: 'pass' }` reads the session's journal (`journal/store.ts`
`readAll(executionId)`) and passes when no check of that name failed. A case's score is the share of its expectations
that pass (judge scores map 1-5 to 0-1); the run's score is the mean; `failed` cases are listed first.

### Triggers and diff

- `AgentStore.saveDraft()` and `publish()` call `onAgentChanged(agentId, trigger)` (the same hook style as
  `onAgentRunFinished` in `evaluations/online.ts`). If a set has `autoRun: 'save' | 'publish'`, it enqueues a run with a
  debounce (a draft saved 20 times in a minute runs once) and a per-agent concurrency of 1.
- The config is hashed on the fields that change behaviour (persona, instructions, model, tools, guardrails, skills); an
  unchanged hash skips the run. The diff view shows changed fields from the stored snapshot of both runs.
- Schedule: reuse `evaluations/schedule.ts` (cron + time zone; the leader fires it in queue mode).
- Alert: extend `evaluations/alerts.ts` (`alertOnEvaluation`) with a target kind so a drop under the set's threshold, or
  by more than X% against the previous successful run, goes to the chosen alert channels (`evaluation_settings`, 1822,
  is keyed by workflow today; add `scope` handling or a sibling `agent_eval_settings` JSON on the set).

### Routes (all new; under `/api/agents/[id]/`)

`eval-sets` (GET, POST), `eval-sets/[setId]` (GET, PUT, DELETE), `eval-sets/[setId]/runs` (GET, POST start),
`eval-runs/[runId]` (GET with cases, DELETE), `eval-runs/compare?a=&b=` (GET). `handler()`, `json()`, `error()`,
`parseBody()` from `lib/server/http.ts`; a zod schema next to `evaluations/http.ts`. Access: `policy.ts` already puts
`/api/agents` under `workflows:read` / `workflows:write`, so no rule change; verify that the project resource rule for an
agent (`ResourceRule`, `lib/server/projects/access.ts`) covers the deeper paths. List each route in `openapi.ts` with a
tag "Agents".

### UI

A new **Evals** card in the agent's existing Evaluations tab (`components/evaluations/`, which already holds
`online-eval-panel.tsx`): the set editor (case list, expectations), a run table with the score trend, a diff view with
phone-first cards (one column, no wide table), and a "Run on save" switch. "Save this chat as a case" in the Sessions
tab turns a session into a case with the agent's reply as the starting expectation.

### Queue mode and local-only

Runs go on the process that received the request, like `evaluations/runner.ts` (an in-memory `active` map, heartbeat so a
dead process's run is marked failed by `heartbeat_at`); the scheduler runs on the leader. Model calls go to whatever the
agent uses; the default local model is Ollama (`OLLAMA_URL`, qwen3-coder:30b). No cloud model is called unless the agent
already uses one; the run records its tokens and cost in the AI usage ledger with source `eval`.

## Implementation plan

1. Migration 2060 and `TABLES` entries; `evaluations/agent-store.ts` (CRUD, pruning). Test: schema test that the tables
   exist in both SQLite and Postgres modes (`apps/web/test/schema*.test.ts` pattern).
2. Shared types in `lib/shared/agent-evals.ts` and the new metrics. Test: unit tests for each expectation type.
3. `agent-runner.ts` with a fake model (the existing agent runtime tests use scripted models). Test: a set of 3 cases,
   one failing; session flagged as evaluation; approvals denied.
4. Routes + openapi + zod. Test: route tests calling handlers as the synthetic owner (`apps/web/test/setup.ts`).
5. Compare and config snapshot/diff. Test: two runs, one persona edit, deltas and flipped cases.
6. Triggers: `onAgentChanged`, debounce, hash skip, schedule, alert. Test: save twice runs once; unchanged hash skips.
7. UI card and "save as case". Test: component test for the diff; manual check in the running app.
8. Live: `LANDFLOW_INTEGRATION=ollama` test beside `evaluations-live.test.ts` using qwen3-coder as agent and judge.

## Docs to update

`docs/features/ai.md` (Evaluations: a new "Agent evals" paragraph), `docs/agents.md` (the Evaluations tab),
`docs/run-trace.md` (checks that evals read), `docs/reference/api.md` (routes), `docs/roadmap.md` (a wave line),
`docs/limitations.md` (teams and remote agents not covered; one local model judges), `docs/history.md` rows,
`docs/README.md` only if a page is added.

## Risks and open questions

- Nondeterminism: one run per case flips on noise. Add `repeat: n` per case and report pass rate, and show a run's
  variance before calling a diff a regression. Default 1 for cost.
- A judge on the same local model as the agent grades itself leniently; let the set pick a judge model.
- Tools with side effects (HTTP, workflow tools) run for real. Default eval sessions to read-only tools, require an
  explicit "allow tool" list per set, otherwise the tool call is stubbed with a recorded fixture.
- Cost and time on a slow local model: cap cases per set (50) and per day.
- Where does "persona change" start for kagent-deployed agents? Their Landflow draft is the source; the eval runs on
  Landflow's runtime, not kagent's, so it checks the persona and model but not kagent-only behaviour. State it.

## Effort and first slice

Effort: L overall (new tables, runner, routes, UI, triggers).

First slice (M): steps 1-4 with manual start only and three expectation types (contains, tools called, judge rubric).
One set per agent, a run list with scores, no diff view, no auto-run. It already answers "did this persona edit break
these 10 tasks" when someone clicks Run; diff, triggers and alerts follow.
