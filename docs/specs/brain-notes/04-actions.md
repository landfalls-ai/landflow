# Brain item 4: actions decided by the flow

## What was built
- `ProposalAction` / `ProposalDecision` types, `Proposal.actions` and `Proposal.decision`, `ProposalInput.actions` (`lib/shared/brain.ts`).
- Suggest Improvement's **Actions** (fixedCollection `buttons`) and `POST /api/proposals` `actions` (max 4, slug ids, reserved ids refused) via `cleanActions` in `brain/proposals.ts`.
- `POST /api/proposals/:id/act { action, note? }` (`actOnProposal`): saves the decision, marks applied, fires the trigger. Apply, Dismiss and Snooze save a decision too; `/applied` (editor) fires it through `finishApplied`.
- `core.suggestionDecidedTrigger` (On Suggestion Decided, `nodes/usage.ts`) and `brain/decision-trigger.ts`: filters detector, label, decisions, target workflow; scope check; background start; no loops (decision by, or suggestion about, a flow with the trigger fires nothing).
- Advice-only suggestions with a listening flow can be applied. `builders()` counts decided flows; `ApplyResult.started` lists every flow started. `TriggerSource` gained `'suggestion'`.
- UI: action buttons on the shared card (Home and canvas), `confirm` via window.confirm, toasts name started workflows. Tests: `apps/web/test/brain-actions.test.ts`.

## Decisions
- In the trigger item `label` is the suggestion's label; the button's text is `actionLabel`. `decision` is `action` for buttons and `action` holds the id.
- Action ids are not part of the fingerprint; a refresh replaces the actions.
- A button does nothing but record; ops of a suggestion with actions still apply through Apply.
- Fires one run per decision, no batching.

## History row
Actions decided by the flow: suggestions carry flow-defined buttons, `POST /api/proposals/:id/act`, and On Suggestion Decided starts flows on every decision (apply, dismiss, snooze, action); advice can be applied when a flow listens.

## Roadmap paragraph
The brain's suggestions are no longer dead ends. A flow can put its own buttons ("Intro us", "Book 15 min") on a suggestion, and every decision (apply, dismiss, snooze or a button) starts the workflows on On Suggestion Decided with the whole suggestion and what was decided, so the loop closes in a flow: the detector finds, a person decides, a flow acts. Build it for missing tools runs on the same path.

## Limitations to record
- A button only records a decision; nothing else happens unless a flow listens (the act reply warns).
- Decisions fire in the process that handled the request; no retry if the run fails to start.
- Only the latest decision is stored on the suggestion (the ledger keeps `proposal.applied` / `proposal.dismissed`).
- Snooze/auto-wake and expiry do not fire the trigger.
- Suggestions about a workflow that itself starts from On Suggestion Decided never fire it.
- Action `confirm` uses the browser's confirm dialog.
