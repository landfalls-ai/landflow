# Make a runbook automatically when a Landfall war room ends

Status: proposed. Closes the first "Not built" bullet of [runbooks.md](../runbooks.md#not-built) ("no flow that makes the
runbook by itself when a room ends"), the "Runbooks from closed rooms" sentence in the Alert triage bullet of
[limitations.md](../limitations.md), and the roadmap line "making a runbook automatically when a room ends"
([roadmap.md](../roadmap.md), "Planned next").

## Problem

A runbook is made by a person: **Runbooks** page, paste the room JSON, **Fold into steps**, **Save as draft**
(`POST /api/runbooks/draft`, then `POST /api/runbooks`; `draftFromRoom()` and `runbookWorkflow()` in
`apps/web/src/lib/server/runbooks.ts`). The flow that already sees every ended room, **Learn from closed Landfall rooms**
(`plugins/landfall/flows/learn-from-closed-rooms.json`: Landfall Trigger "Room ended", read the timeline, Claude, write a
**Room outcomes** row), stops at the table. Nothing joins the room's timeline to the folding rules, so the next incident of
the same kind starts from a blank room until someone remembers to paste the old one.

## Goals / Non-goals

Goals:
- When a room ends, a draft runbook for its alert kind is created without a person starting it, using the same fixed,
  model-free folding (`draftFromRoom`).
- Never publish: the result is a draft tagged for review, so **Find Runbook** (which prefers published) does not hand
  an unreviewed runbook to a new room over a reviewed one.
- Idempotent: the same room twice makes one draft.
- Tell someone: a Slack/Landfall note or the Needs you list says "a runbook was drafted from room X, review it".

Non-goals:
- Generating action nodes from free text (that is [05-runbook-plugin-steps.md](05-runbook-plugin-steps.md)).
- Merging two rooms of one kind into one runbook (open question below).
- A button inside Landfall (Landfall has no field for it; the Landfall node's timeline notes are the channel).

## Design

**A new in-process node, "Make Runbook"** next to **Find Runbook** (`apps/web/src/lib/server/nodes/runbooks.ts`,
category Flow, registered in `nodes/index.ts`). Inputs per item: the Landfall node's **Incident, Get Room** output
(`{ incident, events }`) and optionally the Room outcomes row. It calls the existing `roomSchema` parse,
`draftFromRoom(room, { alertKind, name })` and `runbookWorkflow(...)`, and saves with the same governed path as the
route (`governedSave` and `store.saveWorkflow`). Outputs: `runbook` (`RunbookView`), `created`
(`true | false`), `skipped` (reason: no remediation, duplicate room, existing reviewed runbook).
Parameters: **Skip if a published runbook exists** (default off), **Minimum steps** (default 1), **Base URL**
(as Find Runbook), **Tags** (extra).

**Idempotency.** The saved workflow already carries the tag `room:<id>` (`ROOM_PREFIX`). Before saving, the node looks
for a runbook with that tag via `findRunbooks('')`/tags and returns `created: false` with the existing view. No new table
is needed for this.

**Provenance.** New tag `auto-drafted` (alongside `runbook`, `alert-kind:<kind>`, `room:<id>`) and a line in the sticky
note: "Drafted automatically from room <id> on <date>; not reviewed". `RunbookView` gets `auto: boolean` (computed from
the tag), shown as a badge on the Runbooks page (`/runbooks`) and in **Find Runbook**'s `otherRunbooks`. Ranking in
`findRunbooks()` is unchanged (published before draft), plus: among drafts, reviewed (no `auto-drafted` tag) before
auto-drafted. A person's review removes the tag: new `POST /api/runbooks/:id/review` (sets tags, owner/member of the
workflow's project; add to `openapi.ts`; `/api/runbooks` is already a member-level prefix in
`auth/policy.ts` line 74, so only the new subpath needs checking in `policy.ts` tests).

**Project and actor.** The node runs in a workflow's context; the saved runbook must land in the same project as that
workflow and be attributed to the flow ("by" = the flow id, not a person). `createInProject()` in
`projects/http.ts` is built for an HTTP request, so add a variant that takes the project id from the executing
workflow (new helper in `projects/`). Governance (`governedSave`) may require approval to save; if it holds the save,
the node reports `skipped: 'held by governance'` and the flow continues.

**Flow changes.** Edit `plugins/landfall/flows/learn-from-closed-rooms.json` (a template; each install copies it): after the
Room outcomes write, add **Make Runbook**, then **Landfall, Timeline, Add Note** (posts "Runbook drafted: <url>") and
optionally Slack. Because the flow needs the room's events, reuse the "Read the timeline" node output. The node must work
when Claude's outcome step failed (fail open, like **Find the runbook** in the triage flow): connect from the timeline
node, not only from the outcome row. A Landfall Trigger "Incident Ended" polls (`landfall-trigger.ts`), so latency is the
poll interval.

**Data model.** No migration. A runbook is a workflow with tags.

**Routes.** Existing `POST /api/runbooks/draft` and `POST /api/runbooks` unchanged. New `POST /api/runbooks/:id/review`.
Public-route list in `openapi.ts` gets the new route only.

**Queue mode.** The node runs wherever the flow runs (a worker). It saves through the shared store like any workflow
save. The room-tag lookup plus save is not atomic across two workers handling duplicate trigger deliveries: the
`room:<id>` tag check narrows it; add an idempotency guard by deriving the workflow id deterministically from the room
(`wf_runbook_<hash(room id + instance)>`), so a second save is a no-op conflict. Use that instead of `nanoid` only for
auto-drafts.

**Local-only constraints.** Tested against the local fake Landfall (`pnpm fake-landfall`, `POST /_fake/incidents/:id/status` ends a
room); nothing calls a live Landfall.

## Implementation plan

1. `makeRunbookNode` in `nodes/runbooks.ts` using existing functions; idempotent by room tag. Test: extend
   `apps/web/test/runbooks.test.ts` (same room twice gives one workflow; no remediation gives `skipped`).
2. `auto-drafted` tag, `RunbookView.auto`, ranking tweak in `findRunbooks()`. Test: ranking cases in the same file.
3. Project-aware save helper and governance handling. Test: a flow run in project A saves into A; a governance hold
   yields `skipped`.
4. `POST /api/runbooks/:id/review` with policy and openapi entries. Test: route test as the synthetic owner; a viewer is refused.
5. Update `learn-from-closed-rooms.json` and `plugins/landfall` flow tests (the plugin's own test suite).
6. UI: badge and a "Review" action on `/runbooks`. Test: component test next to the page if one exists, else route-level.
7. Deterministic id for race safety. Test: two concurrent saves, one workflow.

## Docs to update

[runbooks.md](../runbooks.md) (a "Made automatically" section, shrink "Not built"); [triage.md](../triage.md) (lessons flow
row, flow list); [limitations.md](../limitations.md) (Alert triage bullet); [roadmap.md](../roadmap.md); the new node in the
node reference under `docs/reference/`; [reference/api.md](../reference/api.md) for the review route; `docs/history.md`.

## Risks and open questions

- Quality: rooms with chatter but no `remediation.applied-externally` records give nothing (the fold uses the outcome row's
  `runbook_steps` as a fallback). Auto-creating empty or junk drafts would be noise: hence **Minimum steps**.
- Draft pile-up: ten rooms of one kind make ten drafts. Option: when a draft of the same kind and `auto-drafted` exists,
  add the new room's steps as a comment/sticky note on it instead of a new workflow. Decide before step 1.
- Reviewed runbooks must never be overwritten: the node only creates, never updates.
- Fields of real Landfall remediation records are unverified (see "Not built" in runbooks.md); same fixtures as today.

## Effort and first slice

Effort: **S to M**.
First slice: steps 1 and 2: the **Make Runbook** node (create-only, idempotent by room tag, `auto-drafted` tag) with
tests, used by hand in a flow; the template change and the review route follow.
