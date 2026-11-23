# Durable pause and take-over of team members

Status: proposed. Closes the pause clauses of two [limitations.md](../limitations.md) bullets ("Agent teams": "the pause
is held in the memory of the process running the execution (lost on a restart, and unreachable from another process in
queue mode)") and [run-trace.md#not-built](../run-trace.md#not-built) ("only in the process that runs the execution, and
is lost on a host restart").

## Problem

`apps/web/src/lib/server/agent-teams/pause.ts` keeps every held member in a module-level `Map`
(`singleton('team-pauses', ...)`). `holdMember()` is called by the team runtime (`agent-teams/runtime.ts`) when a member
starts; the agent loop (`agents/runtime.ts`, around line 355) asks `pause.requested()` at each step boundary and awaits
`pause.wait()`. The routes `GET /api/executions/:id/agents`, `POST .../agents/:member/pause` and `.../continue`
(`apps/web/src/app/api/executions/[id]/agents/...`) read that map. Consequences:
- In queue mode a worker runs the execution, a main serves the route, and the main's map is empty, so the route answers
  404 "not working in this run now (or the run is on another server)".
- A restart drops the slot, the waiting `Promise` and any instruction typed but not yet picked up.
- Several mains cannot even list the members.

## Goals / Non-goals

Goals:
- Pause state (`working | pausing | paused`), who asked and the instruction are stored in the database, so any main can
  list, pause and continue a member, and the worker running it picks the change up within about a second.
- After a restart, the run's recovery (it continues from the last checkpoint, see
  [features/engine.md](../features/engine.md), "Saved as it runs") does not lose a person's instruction.
- Behaviour in a single process stays as it is (same journal spans, same timeout `LANDFLOW_TEAM_PAUSE_MINUTES`).

Non-goals:
- Stopping a Landflow agent inside a model call (still only between steps).
- Resuming a member's in-memory session after a crash: a checkpoint is per node, so a restarted Run a Team node starts
  its members again. Only the person's pending instruction and the "was paused" fact carry over.
- Pausing members of a Run an Agent node or sub-agents.

## Design

**Data model.** Migration sketched as `2043` (the last shipped is `2041`; renumber at merge) adds
`team_pauses(execution_id TEXT NOT NULL, member TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, since TEXT,
under_span TEXT, holder TEXT, requested_by TEXT, requested_by_name TEXT, instruction TEXT, instruction_by TEXT,
instruction_by_name TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, holders INTEGER NOT NULL DEFAULT 0,
updated_at TEXT NOT NULL, PRIMARY KEY (execution_id, member))` and an index on `(execution_id)`. Add it to `TABLES`
with `['execution_id','member']`. `member` is stored lower-cased and trimmed, like `keyOf()` does today. `holder` is
the process instance id (the id the cluster relay uses) so a dead holder can be detected; `holders` mirrors
`Slot.holders` (a member consulted from two places).
Pattern to copy: `agent_asks` (`lib/server/a2a/agent-asks.ts`), which already solves "run on a worker, decision on a main"
with a table the three routes share and a polled read.

**Store interface.** Split `pause.ts` into a `PauseStore` with the current in-memory implementation and a
`DbPauseStore`. `holdMember`, `requestPause`, `continueMember`, `activeMembers` keep their signatures; the routes do not
change. In-process pieces that cannot be stored stay in memory in the holding process: the waiting `Promise`/`wake`
callback, the `stop` closure that cancels an A2A task, and the abort signal.

**How the holder notices a change.**
1. `requestPause` (any main): update the row `working` to `pausing` and `since`, write the journal note as today if it is
   the holder, else publish a relay message `team-pause` (new channel in `cluster/relay.ts` `RelayChannel`) to wake the
   holder early. Without Valkey (single process) the store is memory-backed and nothing changes.
2. The holder polls its own rows every `LANDFLOW_TEAM_PAUSE_POLL_MS` (new, default 1000) only while it holds a slot, and
   also reacts to the relay message. `requested()` stays synchronous by reading a cached copy refreshed by the poll.
3. `wait()` marks the row `paused`; `continueMember` (any main) writes `instruction` plus the person and sets state to
   `resuming`; the holder's poll or relay wake resolves the promise, then clears the row to `working`.
4. A remote member: `requestPause` sets `stop_requested`; the holder runs `slot.stop()` (the `CancelTask` call) and sets
   the state back or reports the error. The route waits up to 5 s for the result so the HTTP answer carries the same
   502 text as today.
Journal events (`wait` span `<Member> is paused`, `attrs.wait: 'pause'`, the person's message) are still written by the
holder, because only it has `liveJournal(executionId)`; `continueMember` on another main writes only the row.

**Restart and recovery.**
- On boot, rows whose `holder` is no longer a live instance are marked `orphaned`. Because a restarted Run a Team node
  re-runs, `holdMember()` for a (execution, member) with an `orphaned` row and a stored `instruction` delivers that
  instruction as the first person message ("A person left you this instruction before the run restarted: ...") and
  deletes the row. An orphaned row with no instruction is deleted and the journal gets a note that the pause was lost.
- Rows of finished executions are deleted when the execution ends (hook where `release()` runs) and by `maintenance.ts`
  after 24 hours.

**Routes, policy, openapi.** No new routes. `GET .../agents` now reads the table, and gains an optional
`holder` and `orphaned` field in its members (update the schema near the other execution routes in
`apps/web/src/lib/server/openapi.ts`). Access rules in `auth/policy.ts` stay: the routes are under the execution's
workflow access. Audit (`recordAudit`) stays in the route.

**Engine/UI.** `apps/web/src/components/editor/team-pause.tsx` and the Run Trace strip read the same GET; add an
"orphaned: the run restarted, your instruction will be delivered" state. No other UI.

**Queue mode.** This is the main change. Mains serve the routes; workers hold slots. The database is the shared state
(in Postgres mode all processes share it through the existing spool). The relay is only a latency optimisation; with it
down, the poll still works.

**Local-only constraints.** None beyond tests: Postgres/Valkey tests run against the compose infra stack only when
`LANDFLOW_INTEGRATION` names them ([development.md](../development.md)).

## Implementation plan

1. Extract `PauseStore` from `pause.ts` with a memory implementation. Test: `apps/web/test/pause-team.test.ts` passes unchanged.
2. Migration `2043` and `DbPauseStore` (rows, `holders`, `since`). Test: store unit tests on SQLite for hold, request,
   wait, continue, release, timeout.
3. Holder-side poll and cached `requested()`. Test: fake clock; a request written by "another process" (a second store
   handle on the same database) pauses the agent loop at the next boundary.
4. Remote members: `stop_requested` handled by the holder. Test: fake A2A client sees one `CancelTask`; error returns 502.
5. Relay channel `team-pause` and `LANDFLOW_TEAM_PAUSE_POLL_MS`. Test: with a fake coordinator, latency below one poll.
6. Boot reconciliation and instruction replay. Test: kill-and-reopen the store with an instruction pending; the re-run
   member receives it.
7. Routes and UI states. Test: route tests as a synthetic owner for 404/409 paths and the new fields.
8. Queue-mode integration test (flag name added to `docs/development.md`): main route pauses a member held by a worker.

## Docs to update

[run-trace.md](../run-trace.md#pause-and-take-over) (the "How the wait works" paragraph and the Not built list);
[limitations.md](../limitations.md) (Agent teams bullet); [agent-teams.md](../agent-teams.md) if it repeats the claim;
[features/engine.md](../features/engine.md) queue section; reference for `LANDFLOW_TEAM_PAUSE_POLL_MS` under
`docs/reference/`; [development.md](../development.md); `docs/history.md`.

## Risks and open questions

- The poll costs a read per second per held member; acceptable at team sizes (single digits) but cap it by batching one
  query per process.
- Split brain: two workers cannot hold the same member because the engine hands a job to one worker; `holder` makes any
  violation visible.
- Replaying an instruction into a restarted member may not fit the new session; a person should see it as a message.
  Alternative: show it in Needs you and let them resend.
- True resume of a member session needs per-step checkpoints inside the team node, which is a separate project.

## Effort and first slice

Effort: **M**.
First slice: steps 1 to 3 on SQLite: a table-backed store plus holder poll, so two handles in one test (a "main" and a
"worker") can pause and continue a member. No relay, no restart replay yet.
