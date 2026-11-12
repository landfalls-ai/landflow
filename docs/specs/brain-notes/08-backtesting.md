# 08 Backtesting detectors against past decisions

## What was built
- `brain/backtest.ts`: `backtestDetector(detector, { days=30, step=1, quiet?, threshold=0.5 })`, `listBacktests`, `asOfView` (the database with `usage_events`/`usage_daily` cut at a moment), `decisionOf`. Scores hits / false alarms / unknown per finding (matched by fingerprint), misses and "avoided" among decided suggestions the replay did not reproduce, precision, recall, a gate on precision.
- `brain/backtest-scope.ts`: async-local `{ asOf, quiet }` so nodes know a run is a backtest without wiring. `store.saveExecution` skips ledger/Insights while it is set.
- `brain/flow-detectors.ts` `backtestFlowAt`: runs a published detector flow as of a point (trigger item gets `asOf`, `backtest: true`, `reason: 'backtest'`), deletes the execution, collects Suggest Improvement's would-be findings.
- `nodes/usage.ts`: Suggest Improvement posts nothing in a backtest (returns `{ saved:false, backtest:true, fingerprint, title, confidence }`); Landflow Usage reads reports/events with `to = asOf`. Detector Trigger notice documents the new fields.
- `brain/proposals.ts` `proposeFrom`: new `preview` option (no write, quiet override).
- Migration 2064 `brain_backtests` (id, detector, created_at, precision_rate, failing, data JSON; last 30 per detector kept), in `TABLES`.
- Route `POST/GET /api/brain/backtest` (admin, like `/api/brain/run`; policy and OpenAPI updated). UI: Backtest button next to Run in `brain-panel.tsx`, with a one-column card.
- Tests: `apps/web/test/brain-backtest.test.ts` (10).
- Docs: second-brain.md (section "Backtesting a detector", API table, code map), reference/api.md.

## History row
Backtests: a detector (built-in or flow) reruns as of past points without writing suggestions and is scored against what people decided (precision, recall, misses), with a precision gate, `POST/GET /api/brain/backtest`, a Backtest card on Insights.

## Roadmap paragraph
Backtesting closes the loop on tuning: detectors were quieted only after people dismissed noise. Now a detector, or a threshold change (the `quiet` override), is replayed over the last 30 days and scored against the decisions already made, so a change can be judged before it ships. Built-ins run on a ledger view that stops at each point; detector flows run with a run-level backtest flag that makes Suggest Improvement return findings instead of posting.

## Limitations to record
- Workflow and agent definitions, the weekly cap, hold-backs and the model's enrichment are not replayed (as of now).
- Find Similar and Landflow Usage's facts/workflow/suggestions operations ignore `asOf`; reports and events honour it.
- A flow backtest really runs every node of the flow once per point (HTTP calls, messages, Record Event); only Suggest Improvement is neutralised. At most 40 points, 5 minutes, regular execution mode only.
- Precision needs decided suggestions; a detector with none passes the gate with "nothing to score". The gate informs, it blocks nothing.
- Default quiet is the detector's own current multiplier, which already reflects past dismissals; pass `quiet: 1` for the raw detector.
