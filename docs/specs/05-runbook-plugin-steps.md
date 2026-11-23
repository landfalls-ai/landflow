# Runbook steps that call a plugin node

Status: proposed. Closes the second "Not built" bullet of [runbooks.md](../runbooks.md#not-built) ("Steps are people's
tasks (forms), not generated nodes: the records hold words, not commands") and the same clause in the Alert triage
bullet of [limitations.md](../limitations.md); the roadmap lists it under "Planned next" with
[04-auto-runbook.md](04-auto-runbook.md).

## Problem

`runbookWorkflow()` (`apps/web/src/lib/server/runbooks.ts`) turns every `RunbookStep` into a `core.wait` form
(`step_N`, resume `form`) and, for a risky step, an `approve_N` form plus a `core.if` gate and a `reject_N` no-op. A
person does the work and says Done or Skipped. Even when the fix is a known, repeatable call (restart a deployment through
a plugin, silence an alert in Grafana, close a Landfall remediation), the runbook can only describe it. The editor lets a
person replace a form step by hand, but nothing in the review step supports it, nothing guards it, and a plugin step in an
unreviewed runbook that runs by itself in the middle of an incident would be worse than a form.

## Goals / Non-goals

Goals:
- A runbook step may carry an **action**: a plugin node type, its parameters and credential slot, chosen by a person in
  the review (never by a model from the record text).
- An action step always has an approval before it (cannot be switched off), and runs in **Shadow** first: it records what
  it would have called, then asks a person to do it by hand, until the runbook is switched to **Enforce**.
- A failed or refused action falls back to the existing form step for a person, so a runbook never dead-ends.
- The run shows, per step, "would have run" versus "ran", the plugin's output, and who approved.

Non-goals:
- Generating the action from the room's free text, or from a model. A suggestion list (nodes whose keywords match the
  step title) is allowed as a pick-list only.
- Branching logic, loops or rollbacks between steps (edit the workflow for that).
- Running a runbook automatically on an alert; starting stays manual or through `startUrl` of **Find Runbook**.

## Design

**Step model.** `RunbookStep` (and `stepSchema` in `runbooks.ts`, used by `POST /api/runbooks`) gains an optional
`action?: { nodeType: string; nodeVersion?: number; parameters: JsonObject; credentialSlot?: string; label?: string }`.
`nodeType` is checked against the plugin registry (`registry` in `apps/web/src/lib/server/plugins/registry.ts`,
`NodeTypeResolver`) at save time: unknown type or parameters failing the node's schema return 422. Credentials are not
stored in the step: a credential slot name is recorded and the person binds a credential in the editor as for any node
(CLAUDE.md: only development credentials).

**Compiled graph for an action step N** (extends `runbookWorkflow`):
1. `approve_N` (form wait) and `gate_N` (If) exactly as today; forced on for action steps even if `approval: false`.
2. `shadow_N` (`core.if`): `{{ $vars.RUNBOOK_MODE }}` equals `enforce`. `$vars` is Landflow's variables store
   (`apps/web/src/lib/server/variables.ts`), so the mode is one instance-wide switch (default `shadow`, absent means
   shadow). A per-runbook override is a tag `runbook-mode:enforce` read at save time and written into the If's right
   side, so reviewed runbooks can graduate one at a time.
3. Enforce branch: the plugin node (`act_N`, type `nodeType`) with node setting `onError: 'continue'` (the engine has
   `onError`; see `NodeSettingsPatch` in `apps/web/src/lib/shared/assistant-ops.ts`), then an `If` on the error flag to
   the fallback form.
4. Shadow branch: a `core.set` node (`would_N`) writing `{ wouldHaveRun: nodeType, parameters, step }` into the item,
   so the run history shows the exact call, then the existing `step_N` form with the notes plus "Landflow would have
   run <label>; do it by hand and report".
5. Both branches rejoin on `step_N`'s successor.
Node ids keep the `step_`, `approve_`, `reject_` prefixes `runbookView()` counts; add the `act_` prefix and count
`actions` in `RunbookView`.

**Data model.** No migration: actions live in the workflow's node parameters. `RunbookView` and the openapi `runbook` schema
gain `actions: integer` and `mode`.

**Routes.** `POST /api/runbooks` accepts `steps[].action`; `POST /api/runbooks/draft` is unchanged (it returns no actions
because records hold words). New `GET /api/runbooks/actions?q=` returns plugin node types that look relevant (keywords from
the node descriptions, like **Find Runbook**'s `keywords`) for the review pick-list. Policy: all under `/api/runbooks`,
already member-level in `auth/policy.ts` line 74. Switching a runbook to Enforce is a publish-level act: the runbook
must be published and the change goes through the existing governance for saves (`governedSave`), with a new
owner-only rule in `policy.ts` for the `runbook-mode` tag edit. Add the new route and schema changes to `openapi.ts`.

**UI.** The review page (`/runbooks`, Make a runbook): each step card gets **Add an action**: node picker, parameter form
rendered from the node's description (reuse the editor's parameter form component), credential slot name. The card shows
"Shadow: will only record" and "Approval first: always". Step cards for action steps show a plug icon.

**Interplay with auto-drafts** ([04](04-auto-runbook.md)): an auto-drafted runbook never contains actions; actions are added
only in a human review, and removing `auto-drafted` and adding actions are separate acts.

**Queue mode.** A runbook is a normal workflow: the form waits suspend the run in the store and any process resumes it,
exactly as for today's forms. `$vars` is shared through the variables store. Nothing process-local is added.

**Local-only constraints.** Plugin nodes in tests hit fakes only; an action step in docs and tests uses the bundled plugins
against local fakes, never a cloud API. AWS-shaped examples use LocalStack at `http://127.0.0.1:54566` with dummy keys.

## Implementation plan

1. Extend `RunbookStep`/`stepSchema` with `action`, validated against the registry. Test: `apps/web/test/runbooks.test.ts` (unknown
   node type 422; valid action accepted).
2. `runbookWorkflow()` emits `approve_N`/`gate_N`, `shadow_N`, `act_N`, `would_N`, fallback. Test: golden graph
   snapshot for a two-step runbook; connections all resolve; every action step has an approval.
3. Engine run test: shadow branch records `wouldHaveRun` and reaches the form wait; enforce branch calls a fake plugin
   node; an error falls to the fallback. Test in `apps/web/test` with a stub node type.
4. `RunbookView.actions`/`mode`, tag `runbook-mode:*`, owner-only rule in `policy.ts`, openapi. Test: route tests as owner and as member.
5. `GET /api/runbooks/actions` pick-list. Test: keyword match returns only plugin nodes.
6. Review UI for adding an action. Test: component test or route-level flow; manual check in the visible-browser flow the
   team uses.
7. **Find Runbook** output: `runbook.actions` and mode so a triage message can say "this runbook can act (shadow)".

## Docs to update

[runbooks.md](../runbooks.md) (the workflow section, a new "Action steps" section, shrink "Not built"); [triage.md](../triage.md)
runbook paragraph; [limitations.md](../limitations.md); [roadmap.md](../roadmap.md); `docs/reference/` for `RUNBOOK_MODE`, the new
route and the node ids; [composites.md](../composites.md) only if a composite is reused; `docs/history.md` rows.

## Risks and open questions

- Shadow on by default is safe but means nothing acts until someone sets `RUNBOOK_MODE=enforce`; that is intended. Should
  the switch be per runbook only (safer)? The spec offers both; pick before step 2.
- A plugin's side effects differ: some nodes are read-only and need no approval. Use the node's own metadata if the
  protocol exposes a "writes" hint; if not, treat all as writes.
- Parameters containing expressions of the alert (`{{ $json.alert... }}`) depend on what **Find Runbook**'s `startUrl`
  passes (`{ input: { alert } }`); validate expressions at save time only for syntax.
- Credential binding: a copied/exported runbook loses credentials (as any workflow); the step must say so in the form text.
- Governance, audit and the Run Trace need to display "would have run" distinctly from "ran".

## Effort and first slice

Effort: **M**.
First slice: steps 1 to 3: an action on a step in the API (no UI), compiled to approval, shadow `would_N` record and the
existing form fallback, with Enforce disabled in code. Engine tests prove nothing calls the plugin in shadow.
