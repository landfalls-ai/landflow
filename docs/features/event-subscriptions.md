# Event subscriptions

Part of the [Landflow docs](../README.md). A project's admins can send the run events of the project's workflows to a URL: a signed POST for each run that starts, finishes or fails, and for chosen steps. Landflow writes each event down in the same step that saves the run, so a restart between the save and the send loses nothing, and keeps trying for 72 hours.

## Setting one up

Project → Settings → **Event subscriptions** (project admins, and instance owners and admins, add and change; every member of the project sees the list, but only admins see the whole URL, which may carry a token, and the receiver's own error text: members see the origin and the HTTP status). **Add subscription** takes:

- a name and the URL events go to (http or https). The address must be one the [outbound policy](audit-and-governance.md#outbound-requests) allows: in the production profile a private address is refused when you save, with the reason, unless `LANDFLOW_OUTBOUND_ALLOW` lists it. The same check runs again on every send, so a name that starts to resolve to a private address stops being called;
- the events: **A run starts** (`run.started`), **A run finishes** (`run.finished`, also for a canceled run), **A run fails** (`run.failed`), **A chosen step finishes** (`node.finished`, needs at least one step name);
- optionally the workflows (all of the project's by default);
- **Include the last step's first 5 items** (off by default), and **Deliver one at a time, in order** (on by default).

Landflow makes the signing secret (`whsec_…`), shows it once when the subscription is added, and keeps it sealed like a credential. **Edit** can make a new one, which replaces the old at once. Changing the URL of a subscription that was turned off by a 410 turns it on again. Deleting a project deletes its subscriptions and their waiting events (audited per subscription). An API key can only turn on the output option with the `executions:read` scope. At most 20 subscriptions per project. A subscription only gets events from runs saved after it was made.

## What is sent

One `POST` per event, `content-type: application/json`, with these headers:

| Header | Value |
|---|---|
| `x-landflow-event` | the type: `run.started`, `run.finished`, `run.failed`, `node.finished` or `test` |
| `x-landflow-event-id` | the event's stable id; the same on every try |
| `x-landflow-timestamp` | seconds since the epoch when this try was sent |
| `x-landflow-signature` | `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>` with the secret, the same as alert webhooks |

```json
{ "id": "ex_ab12:run.failed", "type": "run.failed", "createdAt": "2026-11-22T10:00:03.000Z", "projectId": "prj_…",
  "workflow": { "id": "wf_…", "name": "Invoices" },
  "execution": { "id": "ex_ab12", "status": "error", "mode": "trigger", "startedAt": "…", "finishedAt": "…", "url": "https://landflow.example.com/executions/ex_ab12" },
  "error": { "message": "…", "node": "HTTP Request" } }
```

`node.finished` adds `node: { name, status }`. The body holds ids, status and times: **no run data**, unless the subscription asks for the last step's output: then `output` is the first 5 items (`[{ "json": … }]`), the whole body is cut to 64 KB, and `outputTruncated: true` says items were left out. The output is what the run's page shows, and it may hold personal or secret values a workflow produced, which is why it is opt-in.

Event ids are `<executionId>:run.started`, `<executionId>:run.finished` or `:run.failed`, and `<executionId>:node.finished:<step name>`.

**Checking the signature** (Node): `createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')` equals the part after `sha256=`; compare in constant time, and refuse a timestamp more than a few minutes old if replays matter to you.

## Delivery

- **At least once.** A 2xx answer settles the event. Anything else (a 4xx, a 5xx, no answer in 10 seconds, a refused address) is tried again after 2 seconds, doubling up to 5 minutes, with jitter. A host that stops between the send and the settle, or whose lease runs out, sends the event again with the same id: **drop duplicates by `x-landflow-event-id`**. Exactly once is not possible over HTTP.
- **In order.** An ordered subscription gets its events one at a time in the order the runs were saved; a later event never passes an earlier one that is waiting to be tried again. A subscription set to **not** ordered sends up to 10 at once and is not held up by one failing event.
- **A 410 Gone** turns the subscription off ("The receiver answered 410 Gone"); turn it on again from Edit once the receiver is back.
- **72 hours.** An event still failing 72 hours after it was made is **given up on**: it stays, the card shows "N given up" with the last error, and **Retry now** queues it again (and makes waiting events due at once). Given-up events are removed after 30 more days.
- **Backlog.** Up to 10,000 waiting events and 128 MB of waiting payload per subscription; beyond either the dispatcher gives up on the oldest ("backlog full"), never the save of a run.
- **Which events.** A run that is `waiting` (a person or a wait node) sends nothing; its end sends `run.finished` or `run.failed`. A run saved twice never queues an event twice. A workflow that does not keep its successful or failed runs still sends the end event: it is written in the transaction that deletes the run. `node.finished` is worked out from the finished run's data, so it arrives after the run, in the order run start, steps, run end.

**Send test** posts one signed `test` event straight to the URL (not through the queue) and says what the receiver answered. The card shows the last delivery and, for a subscription that is behind, how many are waiting and for how long.

## How it is built

- Rows are written by a save hook inside the transaction that saves the execution (`onExecutionSaving`, `lib/server/store.ts`; the hook is `writeOutboxRows` in `lib/server/outbox/events.ts`, registered by `execution-reactions.ts` on every process that saves runs, main or worker). A project with no enabled subscription costs one map lookup. Subscriptions are in `event_subscriptions`, rows in `event_outbox` (migration 2924).
- The **leader** delivers (`event outbox`, a leader service in `runtime.ts`: `lib/server/outbox/dispatcher.ts`), every 2 seconds and when rows are written. In queue mode only the leader main runs it, and a lease of a minute on each claimed row makes a takeover safe.
- `lib/server/outbox/core.ts` is the one claim, settle, backoff and prune code; the [audit SIEM outbox](audit-and-governance.md) uses it too, with its table, its delivery from every main and its behaviour unchanged.
- The signing secret is in `event_subscriptions.secret`, sealed, and is re-sealed by the encryption key rotation. Audit events: `event_subscription.created`, `.updated`, `.deleted` (the URL's host, never the path or the secret).
- Metrics: [observability.md](../observability.md) (`landflow.outbox.*`). Routes: [api.md](../reference/api.md).

## What is unchanged

Failure alerts (email, Slack, signed webhooks) and the error workflow stay best-effort as they were. The audit SIEM outbox keeps its guarantee and its process model. Notion's own outbox and approval tickets keep their separate retry queues.

Tests: `apps/web/test/event-outbox-core.test.ts`, `event-outbox.test.ts`, `event-subscriptions-routes.test.ts`, `event-subscriptions-ui.test.ts`; `event-outbox.postgres.test.ts` under `LANDFLOW_INTEGRATION=queue`.
