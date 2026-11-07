# Workflow SDK spike (2026-11-07)

Part of the [Landflow docs](../README.md). A time-boxed test of Vercel's Workflow SDK (`workflow` 5.2.3, `@workflow/world-postgres` 5.0.5, Next 16.4.3 with Turbopack, Node 22) as a possible home for Landflow's runs. One `"use workflow"` interpreter receives a graph as JSON and calls one generic `"use step"` function per node. One laptop, single runs. The code was in a scratch directory outside the repository and is not kept.

## What worked

`withWorkflow` built and ran on Turbopack. The interpreter handled linear chains, an If branch, a loop-back edge (5 passes), `sleep()` for a wait node and a real HTTP call to a local plugin server.

## Numbers

Each step costs 3 events, so a graph of N nodes costs 3N + 3 events.

| Graph | Steps | Events | Wall time | Cold replay (every step replays) |
|---|---|---|---|---|
| 10 linear | 10 | 33 | 1.4 s | 0.6 s |
| 50 linear | 50 | 153 | 0.8 s | 0.9 s |
| 200 linear | 200 | 603 | 2.1 s | 4.7 s |
| 50 nodes, a 5x loop over 10 | 89 | 270 | 0.9 s | 1.6 s |
| 200 linear, Postgres world | 200 | 603 | 2.3 s | not run |

- By default the workflow function runs once and keeps its VM between steps. With `WORKFLOW_RETAINED_VM=0` and `WORKFLOW_TURBO=0` a resume replays after every step: the 200-node graph re-ran the function 201 times and the time per cycle grew from about 16 ms to about 31 ms, so replay cost grows with the log (quadratic in total).
- The event ceiling is `WORKFLOW_MAX_EVENTS`, 25,000 by default (about 8,300 interpreter steps). At 300, a 200-node run failed with `MAX_EVENTS_EXCEEDED`.
- Every step persists its input and output: 1 MB of incompressible data per step wrote about 1.4 MB per step. 30 MB through three steps took 4.5 s.

## Crash and restart (`kill -9` of the dev server)

| Test | Local world | Postgres world |
|---|---|---|
| A 50-node run, left alone | stuck; the in-flight step never finished | resumed on its own after about 14 minutes (the dead worker's job lock) |
| Steps that ran twice | n/a | the step in flight at the kill (51 calls for 50 nodes) |
| `sleep(10s)` across a restart | stuck until `reenqueueRun` after the due time | finished on its own, about 10 s after restart |

The Local world keeps its queue in memory, so it is for development only. On Postgres, a plugin node must tolerate being called twice, which Landflow's per-step idempotency key already allows for.

## Reading it

The interpreter pattern works at 50 to 200 nodes and stays far below the event ceiling. It is not a better fit than Landflow's own engine today: recovery after a crash took minutes on defaults against Landflow's lease takeover of about 30 s, the packages say "beta", the Postgres world is documented as not tuned for scale, and Landflow's governance, SQLite support and per-node semantics would all have to be rebuilt around it. What is worth borrowing is the idea of durable timers and hooks, which are the open parts of [limitations.md](../limitations.md).
