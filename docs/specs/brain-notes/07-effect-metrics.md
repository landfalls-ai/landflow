# Brain item 7: effect metrics declared by the flow

## What was built

- **Declaration** (`MetricSpec` in `lib/shared/brain.ts`, parsed by `metricSpecFrom` from node parameters): source
  `usage` or `workflow`, a name (`label`), `better` (`higher`|`lower`).
  - `usage`: kinds (built-in or custom), optional `attrEquals`, `aggregate` count|sum|avg, `field` (an attribute or
    cost/tokens/durationMs/items), `about` target|instance (instance = the detector flow creator's scope, `brain/scope.ts`).
  - `workflow`: `workflowId`, `field` (read from the first output item), `timeoutSeconds` (default 120, max 600). Run with
    `{ proposal, from, to, phase: 'baseline'|'check' }` as the production version via `runWorkflow`.
- **Nodes** (`nodes/usage.ts`, `metricProperties`): the Detector Trigger has `metricSource` (default|usage|workflow) and the
  `metric*` parameters; Suggest Improvement has the same with a first choice `inherit` (the default), `default` meaning
  "Landflow's own". Resolved only in a detector flow (a suggestion elsewhere ignores it). A bad declaration fails the Suggest
  Improvement item with a plain message.
- **Storage**: `Proposal.metricSpec`; `ProposalMetric` gains `label`, `pending`, `failed`; `ProposalMetricName` gains `custom`.
  `ProposalInput.metricSpec` exists but only `proposeFrom` with a flow detector keeps it (no route takes it).
- **Measurement** (`brain/effect.ts`): `metricFor` returns `custom`; `measureSpec` (usage, via the new `usageAggregate` in
  `usage/query.ts`), `measureWorkflow`, `baselineFor`, `settleBaseline`, `checkEffect` (sync) and `checkEffectAsync`,
  `outcomeOf(before, after, better)`, `formatMetric(metric, value, label)`. `checkEffects` is now async and `runBrain`
  awaits it.
- **UI**: the inbox card shows "Measured by: <name> (higher is better)". The card shows no baseline/checks anywhere today
  (Insights lists detector counts only), so there was no applied-state effect display to extend.
- Tests: `apps/web/test/brain-metrics.test.ts` (10), including the overlap example (`work.initiative_merged`, higher is
  better, "duplicate work avoided"). Docs: `docs/second-brain.md` (section 7, "A metric your flow declares"), `docs/reference/api.md`.

## Decisions

- `markApplied` and `checkEffect` stay synchronous (existing callers and tests). A usage metric is measured on Apply. A
  sub-workflow baseline is saved `pending` (value 0, not real) and `settleBaselineOf` runs it in the background right after;
  `checkEffects` settles any pending or failed baseline first on each look, so a restart or a failure self-heals.
- A failed, timed-out or non-numeric run records no value: baseline `failed: true`, a check is skipped; retried every look
  (no retry cap).
- Count and sum usage metrics are per week, so the 14-day check compares with the 7-day baseline; averages aren't scaled.
  A sub-workflow gets the exact window and does its own normalising.
- The outcome fact for a suggestion with no workflow/agent target is about the `instance` subject.
- Expressions in the Detector Trigger's `metric*` parameters aren't evaluated when Suggest Improvement inherits them (read
  statically).

## History row

Effect metrics the flow declares: a Detector Trigger (or one Suggest Improvement) names a usage query or a sub-workflow that
returns a number, with a label and which way is better; baseline and 7/14-day checks use it, the outcome respects higher-is-better.

## Roadmap paragraph

A detector flow can say how its own suggestions are judged: a query over the usage ledger (custom events included, counted,
summed or averaged, about the target or the whole instance) or a sub-workflow returning a number, with a name and a
direction. The suggestion keeps it, the baseline and the 7 and 14 day checks use it, and the outcome fact names it, so an
overlap finder can report "initiatives merged or reused" going up.

## Limitations to record

- Declared metrics are set on the nodes only: `POST /api/proposals` and the analyst can't declare one.
- A sub-workflow metric's baseline appears a moment after Apply; a failing one is retried on every brain look with no cap.
- Usage metrics cover raw events only (attribute filters and sums read raw events, kept 90 days by default).
- No chart of baseline and checks yet: only the card's "Measured by" line shows the declaration.
