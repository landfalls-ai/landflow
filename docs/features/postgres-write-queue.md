# Postgres write queue

In Postgres mode (`LANDFLOW_DB=postgres`) the host serves reads from an in-memory SQLite copy and replays each committed
write on Postgres, in order, from a queue ([engine.md](engine.md), `lib/server/db/postgres.ts`). This page is about what
happens when that replay goes wrong.

## The spool

A batch is appended to `<data dir>/postgres-queue.jsonl` before it is queued (one descriptor, opened once). The file is
fsynced per `LANDFLOW_PG_SPOOL_FSYNC`: `interval` (the default: at most every 100 ms), `always` (after each append) or
`off`. It is emptied when the queue drains, and replayed from Postgres' last applied batch at the next boot.

## A batch Postgres rejects

Connection failures are retried until Postgres is back. Any other error is a rejection; after five of the same batch the
store is **blocked**:

- the batch stays at the head of the queue and nothing after it is applied; it is never dropped;
- every write (`Database.write`, so a write in a transaction fails at its first statement) throws `StoreUnavailableError`
  (it carries `status = 503` and the message "The database is refusing writes; see the host log (postgres store blocked
  at batch N)"), so the in-memory copy cannot run ahead of Postgres. Reads keep working. Today `handler()` answers any
  error it does not know with a 500 carrying that message, and routes with their own `catch` answer 400; the 503 reaches
  clients once `handler()` maps the error's `status` (the HttpError mapping of P11). Background writers (schedulers,
  pollers, checkpoints) get the same throw, so each must catch it or the process error handler decides;
- the host logs one error (the batch's sequence number, op count, the first 2,000 characters of its ops, the Postgres
  error code and message) and a warning on each failed retry;
- the batch is retried every `LANDFLOW_PG_BLOCKED_RETRY_SECONDS` (60); when it applies, the store logs that and accepts
  writes again.

`Database.writeHealth()` returns `{ state: 'ok' | 'retrying' | 'blocked', queuedBatches, queuedOps, oldestAgeMs,
lastError?, blockedSeq? }` (SQLite: always ok), and the metrics `landflow.db.write_queue.*`, `landflow.db.write_blocked`,
`landflow.db.write_rejections` and `landflow.db.write_retries` ([observability.md](../observability.md)) report it.

## Recovery

1. Read the error in the host log, fix the cause in Postgres (data, a missing column or constraint) and wait for the
   retry: no restart is needed.
2. Or give the batch up: restart with `LANDFLOW_PG_SKIP_BATCH=<seq>`. Replay at boot writes that batch to
   `<data dir>/postgres-rejected-<seq>.jsonl` (`postgres-rejected-<instance>-<seq>.jsonl` in queue mode; kept, for replaying by hand), logs it at error and goes on. The row changes
   it held are then missing in Postgres. Without the variable, a replay that meets a rejected batch fails the boot with a
   message naming the sequence number and the variable.
   The variable applies to every process that reads it and matches sequence numbers per process (in queue mode each main
   and worker has its own spool, `postgres-queue-<instance>.jsonl`, and its own numbers), so set it on the one process
   that is blocked and remove it after that boot.

The host log and the rejected file hold row data (the block log line carries the first 2,000 characters of the ops), and
`lastError` carries the Postgres message: keep both off unauthenticated endpoints.
