# Notes for the integrator: P18 `outbox` (C19)

- `docs/limitations.md`:
  - Event subscriptions deliver at least once, ordered per subscription: receivers drop duplicates by `x-landflow-event-id`. A receiver down for 72 hours has the events given up on (kept 30 more days, back with Retry now).
  - `node.finished` events arrive after the run ends (derived from the saved run data), not while it runs, and only for named steps.
  - A subscription gets events from runs saved after it was made; nothing is replayed.
  - Failure alert channels and the error workflow stay best-effort with no retry (not on the outbox yet); Notion's outbox (`notion_brain_outbox`) and approval tickets keep their own retry queues; only the audit SIEM outbox shares the core.
  - Events carry no run data unless "Include the last step's first 5 items" is on; the output is the saved run data, cut to 64 KB.
  - The addresses are checked against the outbound policy when saved (literal addresses) and on every send (what a name resolves to); a name that resolves privately at save time is accepted and then fails at send time.
- `docs/roadmap.md`: C19 (run events through an outbox: event subscriptions per project, the shared outbox core, the audit outbox on it): built. Open: alert channels and the error workflow on the outbox; live `node.finished` (needs a durable node event); a broker sink (Kafka, NATS); Notion's outbox and approval tickets on the core; C12-style delegated approval callbacks can enqueue here.
- `docs/README.md`: feature map line: "Run events to a URL (event subscriptions: signed webhooks per project, at least once, in order, retried for 72 hours) → [features/event-subscriptions.md](features/event-subscriptions.md)".
- `docs/development.md`: test list gains `event-outbox-core.test.ts`, `event-outbox.test.ts`, `event-subscriptions-routes.test.ts`, `event-subscriptions-ui.test.ts`; `event-outbox.postgres.test.ts` runs under `LANDFLOW_INTEGRATION=queue` (a worker saves, the leader delivers; a lease across two processes), as `audit-chain.postgres.test.ts` does; `runtime.test.ts` lists the new `event outbox` leader service after `notion brain`.
- `docs/observability.md`: done on this branch (`landflow.outbox.backlog`, `landflow.outbox.oldest_age_s`, `landflow.outbox.delivered`).
- `docs/features/audit-and-governance.md`: done on this branch (the SIEM outbox on the shared core).
- `docs/reference/api.md` and `openapi.ts`: P18's last task, written after merging `combined/w4a`; the integrator resolves a conflict on the api.md row beside P15a's and P16's.
- `docs/reference/configuration.md`: no new variables (the limits are constants: 20 subscriptions per project, 10,000 waiting events, 64 KB, 10 s, 72 h).
- Migration 2924 only (`event_subscriptions`, `event_outbox`); P16's 2925 and P20's 2926 are theirs. P18's seam edited `db/schema.ts` and `lib/shared/audit.ts` (labels `event_subscription.*`); P20's `collection.*` labels are P20's own.
- `test/runtime.test.ts` (not on the ownership list) gained the `event outbox` service name in its ordered list; nothing else changed there.
