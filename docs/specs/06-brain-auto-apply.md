# Second brain: auto-apply a named set of low-risk suggestions, with undo and audit

## Problem

[second-brain.md](../second-brain.md) principle 3 says "It proposes; it never applies": every suggestion waits in the
Home inbox for a person to press Apply (`applyProposal()` in `apps/web/src/lib/server/brain/proposals.ts`). For the
dull, reversible findings (a retry on a flaky HTTP node, `flaky-call`) the inbox becomes a chore, and the weekly cap
(`LANDFLOW_BRAIN_WEEKLY_CAP`) means a skipped one blocks newer ones. This spec lets an owner opt a project into
applying a small, named set of low-risk suggestions by itself, with a visible record and a one-press undo. No
limitation line is closed; it is a follow-up named in the second brain's roadmap entries.

## Goals / Non-goals

Goals:
- A per-project allow-list of detectors (and optionally node types) whose suggestions apply on their own.
- Only suggestions with `risk: 'low'`, ops that validate (`validateOps`), and a target workflow that passes governance.
- Every automatic apply writes an audit row (`source: 'brain'`, plus `auto: true`) and a ledger event, and can be undone.
- Undo restores the workflow exactly as it was, unless a person edited it since.

Non-goals:
- Drafts (new workflows), persona rules, notebook promotions and missing-tool "Build it" never auto-apply.
- No auto-publish: an active workflow stays on its published version; the auto edit lands in the draft only when the
  workflow has one, and activation changes are refused (see Design).
- No new model calls; the decision is rules over `Proposal` fields.

## Design

**Policy.** Project settings live in `lib/server/governance/scopes.ts` (zod schema near `brainPayloads`, line 38) and
`lib/shared/project-policy.ts`. Add `brainAutoApply?: { detectors: DetectorId[] }` (new, default absent = off). Only
detectors on a hard-coded safe list may be named: first slice `flaky-call` (`setNodeSettings` retries), later
`no-safety-net` (only the "set an error workflow" variant, never the draft). The UI is one more switch group under
project **Settings → Governance** (`components/projects/project-page.tsx`, next to "Let the second brain read run data").
Env kill switch (new): `LANDFLOW_BRAIN_AUTO_APPLY=false` turns it off everywhere (documented in `docs/reference/configuration.md`).

**Data.** New migration (sketch: version 2050, name `brain_auto_applied`; append to `MIGRATIONS` in `db/schema.ts`
and add to `TABLES` with key `['id']`):

```sql
CREATE TABLE IF NOT EXISTS brain_auto_applied (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, workflow_id TEXT NOT NULL, project_id TEXT,
  detector TEXT NOT NULL, applied_at TEXT NOT NULL, status TEXT NOT NULL,  -- applied | undone | superseded
  before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
  before TEXT NOT NULL,   -- the whole Workflow JSON before (the undo image)
  undone_at TEXT, undone_by TEXT )
CREATE INDEX IF NOT EXISTS brain_auto_applied_workflow ON brain_auto_applied (workflow_id, applied_at)
```

TEXT/BIGINT only, so it runs on SQLite and Postgres. Rows are pruned with the usage ledger (`USAGE_RETENTION_DAYS`),
except `applied` ones younger than 30 days.

**Engine.** A new `autoApply(db, now)` in `brain/proposals.ts` (or `brain/auto-apply.ts`), called by `runDetectors`
in `brain/index.ts` after the `upsertProposal` loop, on the leader only (`leaderService('second brain')`, so queue mode
runs it once). For each open proposal: project allows its detector, `risk === 'low'`, `confidence >= 0.8`, no
`draft`/`agentChange`/`notebook`, at most one auto apply per workflow per 24 h, and the workflow has not been edited in
the last hour (`updatedAt`) so it never races a person in the canvas. It then calls the existing `applyProposal(id,
{actorId: undefined})`, which goes through `governedSave(..., {source: 'brain'})`; a result with
`extras.activationRefused` or `publishRequest` (four-eyes) aborts: it is left in the inbox. Before saving, the
pre-image is captured for `brain_auto_applied.before`.

**Audit and ledger.** `governedSave` already calls `recordAudit({action: 'workflow.update', details.source: 'brain'})`.
Add a second `recordAudit` action `brain.auto_apply` (new) and `brain.auto_apply.undo` (new) with the proposal id,
detector and diff summary (`summarizeDiff` in `versions.ts`). `markApplied` emits `proposal.applied`; add
`attrs.auto: true`. Effect measurement (`effect.ts` baselines) works unchanged, so a bad auto apply shows up as "worse".

**Undo.** `POST /api/proposals/:id/undo` (new). Policy: the `/api/proposals` prefix already maps to
`workflows:read` / `workflows:write` in `auth/policy.ts` (line 88), so no policy change; the route also checks edit
access to the target like `apply`. Behaviour: load the row; if the workflow's current hash differs from `after_hash`
(someone edited since), answer 409 with the hash mismatch and mark `superseded`; else `governedSave(before, current)`
and mark the row `undone`. The proposal is already `applied`, and `dismissProposal` refuses applied ones (409), so undo
needs a small change there: allow `applied` -> `dismissed` with reason `not-relevant` when an undo row exists, so the
fingerprint stays away 30 days and the detector gets quieter. Add the
route to `openapi.ts` next to `/api/proposals/{id}/apply` (tag `Second brain`, id `undoProposal`).

**UI.** Home → Suggestions gets an **Applied automatically** card (last 7 days) with **Undo**; the canvas pill
(`components/brain/`) shows "Retry added by the second brain, 2 h ago · Undo". Phone-first: one column of cards.

**Queue mode.** Only the leader decides; undo can run on any main (it reads the row and the workflow through the store).
**Local deploy:** nothing outside the host changes.

## Implementation plan

1. Migration + `TABLES` entry + row helpers (`brain/auto-apply.ts`). Test: `apps/web/test/schema.test.ts`-style
   migration test and `postgres.test.ts` (flag `postgres`) round trip.
2. Policy field in `scopes.ts` / `project-policy.ts` + PATCH route validation. Test: `apps/web/test/brain.test.ts`
   (settings round trip, unknown detector refused).
3. `autoApply()` with the guards; unit tests for each guard (risk, confidence, recent edit, four-eyes, rate limit).
4. Wire into `runDetectors`; test that a seeded flaky workflow gets retries and an audit row `brain.auto_apply`.
5. Undo route + openapi + hash-mismatch case. Test: route test calling the handler as the synthetic owner.
6. UI: governance switch group, "Applied automatically" card, canvas pill. Test: component test beside `components/brain/`.
7. Docs, history row; run `(cd apps/web && npx vitest run) && pnpm typecheck`.

## Docs to update

`docs/second-brain.md` (principle 3 becomes "never applies unless a project opts in"; new section and the route table),
`docs/reference/api.md` (undo route), `docs/reference/configuration.md` (`LANDFLOW_BRAIN_AUTO_APPLY`), the governance
doc page for project settings, `docs/roadmap.md` (the entry for this follow-up), `docs/limitations.md` (note: drafts
and persona rules never auto-apply), `docs/history.md` (one row per commit).

## Risks and open questions

- Trust: an auto edit changes a flow nobody looked at. Mitigations: low risk only, one a day per workflow, always undoable, audit row, effect check at 7/14 days.
- Published workflows: does the retry edit apply to the live version? `governedSave` with `holdActivation` leaves activation alone, but a saved edit to an active workflow may become live on save; confirm in `publish.ts` whether drafts exist, and if not, restrict auto apply to inactive workflows in the first slice.
- Undo after a person's edit is refused rather than merged; is "revert only the ops" (inverse ops) worth it later?
- Should a dismissed-by-undo count against the detector twice (quieting)? Proposal: yes, via the existing `detectorStats`.

## Effort and first slice

**M.** First slice: the `flaky-call` detector only, behind the project switch and the env kill switch, with the table,
audit row and `POST /api/proposals/:id/undo`; no new UI beyond the switch (undo through the inbox's existing card).
