# Postgres mode: lazy loading and paging for the largest tables

## Problem

[limitations.md](../limitations.md) (Scaling out): "every process keeps the whole database in memory (Postgres mode)".
`apps/web/src/lib/server/db/postgres.ts` opens an in-memory SQLite connection (`openSqliteConnection(':memory:')`)
and `loadMirror()` runs `SELECT * FROM <table>` for every table in `TABLES` at boot, so boot time and RSS grow with
executions, `execution_steps`, `execution_events`, `usage_events`, `audit_events`, `ai_usage`, versions and Data Table
rows. In queue mode (`LANDFLOW_EXECUTIONS_MODE=queue`) each main and each worker pays that, and `replication.ts` also
reloads the whole copy when its LISTEN connection drops.

## Goals / Non-goals

Goals:
- Boot loads only the small, hot tables fully; the large, append-mostly tables load a bounded window (newest N days / N rows) and fetch older rows from Postgres on demand.
- The synchronous store API (`Database.get/all/run`) is unchanged for callers that stay inside the window.
- Memory per process is bounded by retention windows, not by history; queue-mode reload on LISTEN loss stays cheap.

Non-goals:
- Making the store API asynchronous (hundreds of call sites; see the header comment of `postgres.ts`).
- Changing SQLite mode, or splitting the host into services.
- Removing the write queue (`PostgresSink`, `postgres-queue.jsonl`) or its durability rules.

## Design

**Study first (what is large).** `TABLES` in `db/schema.ts` lists 20 tables. Candidates by growth: `executions`
(`data` holds the whole record, run data trimmed to `MAX_ITEMS_PER_OUTPUT` items per output in `rows.ts`),
`execution_steps`, `execution_events` (journal, `LANDFLOW_TRACE_RETENTION_DAYS` 30), `usage_events` (90 days),
`ai_usage` (400 days), `audit_events` (+ `audit_heads`), `workflow_versions`, `chat_feedback`, `agent_sessions`,
Data Table rows, `brain_facts`. Hot and small: `workflows`, `meta`, settings, `agent_definitions`, `proposals`,
`brain_profiles`, `waits`, `execution_checkpoints`. Step 0 of the plan is a measurement: log
`counts` and bytes per table at boot (extend the `postgres store loaded` log line) and record them in the history row.

**Table classes (new, in `schema.ts`).** Next to `TABLES` add `LAZY_TABLES`, a map of table -> `{ window: string
column, keep: number days or rows, readThrough: boolean }`, e.g. `executions: { column: 'started_at', days:
`LANDFLOW_PG_MIRROR_DAYS` }`. `loadMirror()` then loads `WHERE <column> >= $1` for lazy tables and records the loaded
low-water mark per table in `meta` (new key `postgres.mirror_floor.<table>`, in memory only, not persisted).

**Read-through.** Reads that can fall outside the window are few and known: `store.getExecution(id)`, `listExecutions`
with a `before` cursor (`store.ts` lines ~154-225), `journal` event reads for an old run, usage and audit report
queries with long windows (`usage/query.ts` already reads `usage_daily` rollups for long ranges), `getVersion`.
Because the API is synchronous, read-through cannot await Postgres. Two options, decided in step 1:

1. **Async seams at the few cold entry points.** The routes (`handler()` in `http.ts`) are already async. Add
   `await db.warm(table, keys)` (new, in `database.ts`; uses `PostgresSink.direct()`, which exists) at the top of the
   handful of routes and then read synchronously from the mirror, which now holds the fetched rows. Rows fetched this
   way are marked as cold and evicted after an idle time (new cache bookkeeping `coldRows: Map<rowId, lastUse>`;
   `rowId()` from `replication.ts` already gives a row identity).
2. **Aggregates in Postgres.** Report queries over long windows run through `Database.direct` as SQL on Postgres,
   not on the mirror (`direct` already exists for "the few things that must be decided there").

Writes are unaffected: `Database.run` applies to the mirror and enqueues a `WriteOp`. A write to an evicted or never
loaded row simply upserts it; the replication notice (`replication.ts`, `['k', table, key]` by primary key) applies a
row only when its key is in the mirror or the table is not lazy, otherwise ignores it (it is read through later).

**Retention interplay.** Existing pruning (`deleteBefore` ops, executions retention in Settings -> General,
`USAGE_RETENTION_DAYS`) already bounds Postgres; the mirror window should be shorter than retention
(`LANDFLOW_PG_MIRROR_DAYS`, new, default 7; `0` = load everything, today's behaviour, the safe fallback).

**Queue mode.** Workers need only recent executions and steps; mains serve the UI and read through. On LISTEN loss
`Replica` reloads: with windows that is the same bounded query. `execution_checkpoints` and `waits` are always fully loaded
(crash recovery reads them synchronously). **Local deploy:** the compose and Kubernetes Postgres of `deploy/` only;
the new variable goes in `deploy/` env examples with development values.

## Implementation plan

1. Measure: per-table row count and bytes in the boot log (`openPostgres`), read-only. Test: `postgres.test.ts` (flag `postgres`) asserts the log fields.
2. Add `LAZY_TABLES` and `LANDFLOW_PG_MIRROR_DAYS` (default `0`, behaviour unchanged); `loadMirror` honours a window. Test: seed old and new `usage_events` rows, boot, assert only new ones are in the mirror.
3. Move the one-sided readers off the mirror: `usage/query.ts` long-window reports use `usage_daily` or `direct`. Test: `brain.test.ts` plus a Postgres test comparing results with and without a window.
4. `Database.warm()` and the cold-row cache; use it in `GET /api/executions/:id`, the executions list cursor, the Run Trace journal reads. Test: route tests against Postgres with an old execution outside the window.
5. Replication: ignore notices for unloaded rows of lazy tables; reload bounded. Test: `cluster-postgres.test.ts` (flag `queue`).
6. Flip the default to 7 days once the history row has measured memory before and after (1M `usage_events` fixture).

## Docs to update

`docs/limitations.md` (Scaling out line: the whole-database-in-memory part), `docs/roadmap.md`, `docs/architecture.md`
(the Postgres mirror paragraph), `docs/development.md` (new test notes and flags), `docs/reference/configuration.md`
(`LANDFLOW_PG_MIRROR_DAYS`), `docs/deployment.md` (sizing), `docs/history.md`.

## Risks and open questions

- Silent wrong answers: a synchronous read that falls outside the window returns "not found" or a short list. Needs an audit of every `store`/`journal`/`usage` read of a lazy table (grep `FROM executions`, `FROM execution_events`, ...), and a test helper that boots with a tiny window to flush them out.
- Aggregate SQL on the mirror (counts, `LIKE` search in `runs/search`, the 1,000-candidate limit) changes meaning with a window.
- Dialect gap: `direct` queries run on Postgres while mirror queries run on SQLite; schema stays portable, but ordering and `LIKE` collation can differ.
- Is a smaller win enough? Option: only drop `execution_steps` and `execution_events` of finished runs from the mirror (they are the bulk and are read by id).
- Eviction policy and a memory cap (LRU by bytes) versus the simple day window.

## Effort and first slice

**L.** First slice: step 1 plus step 2 for `usage_events`, `ai_usage` and `audit_events` only (append-only, read by
report queries that can use `usage_daily` or `direct`), default window off. Ships a measurable memory win with no
read-through machinery.
