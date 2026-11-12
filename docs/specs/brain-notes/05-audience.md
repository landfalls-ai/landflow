# Brain item 5: suggestions with an audience

## What was built
- `Proposal.audience` (`AudienceMember`: userId, email, slackUserId, name; max 10), `Proposal.slack` (`ProposalSlackMirror`: credential + message refs channel/ts per member), `ProposalInput.audience` / `slackCredential` (`lib/shared/brain.ts`).
- `lib/server/brain/audience.ts`: `cleanAudience` (emails resolved to Landflow users), `inAudience`, `canSee`, `canDecide`, the Slack mirror (`mirrorNew`, `mirrorDecision`, `mirrorBlocks`), `handleProposalClick`, `settleMirrors`. No new table or migration (audience and refs live in the proposal JSON).
- `proposals.ts` (additive): `saveProposal` export, `listProposals` takes `viewer` and `forMe`, `proposeFrom` takes the audience, `upsertProposal` keeps message refs on a refresh and calls `mirrorNew`, apply/dismiss/snooze call `mirrorDecision`.
- Routes: `GET /api/proposals` (audience members see theirs, `?for=me`), `POST` accepts `audience`; `[id]` GET/PATCH, `act` and `apply` use `canSee` / `canDecide`. Slack: `slack/handlers.ts` routes `landflow_pr_*` action ids to `handleProposalClick`.
- Suggest Improvement: **Send To**, **Mirror to Slack**, Slack Authentication, Slack credential (found on the running workflow's node, since the node context doesn't carry it).
- UI: "For Dana, Lee" and a chat mark on the card; Home inbox **For me** switch; a 403 on a suggestion with an audience toasts instead of hiding the inbox.
- Tests: `apps/web/test/brain-audience.test.ts` (8, fake Slack server). Docs: `docs/second-brain.md` (section, API table, code map), `docs/reference/api.md`, openapi.

## Decisions
- Audience may dismiss, snooze and take buttons without edit access; Apply needs edit access unless the suggestion changes nothing (advice).
- Slack Dismiss uses reason `not-relevant`.
- Slack actor: the Landflow user (by audience userId or email) else `slack:<id>`; apply from Slack requires a Landflow user with edit access.
- `POST /api/proposals` has no `slackCredential` (it would let any API caller DM through a credential); only the node mirrors.
- Mirror work is in the background of the request that decided; a failed post/update is logged, not retried.
- Email-only members are looked up with `users.lookupByEmail` at post time (needs `users:read.email`); not found: no DM, still in the inbox.

## History row
Suggestions with an audience: addressed to named people (inbox "For me", `audience`), Suggest Improvement's Send To and Mirror to Slack (DMs with the suggestion's buttons; a click or any decision keeps inbox and Slack in step).

## Roadmap paragraph
A suggestion can now be about two people in two projects. A flow addresses it to named people (emails or Slack ids); they see it in their inbox whatever it is about, with only what it says, and optionally get it as a Slack DM with the suggestion's own buttons plus Apply, Dismiss and Snooze. Deciding in either place updates the other: one record, every message shows who decided what.

## Limitations to record
- The audience sees the suggestion, not its target; applying changes still needs edit access (Slack Apply also needs the member matched to a Landflow user).
- The mirror is only started by Suggest Improvement; `POST /api/proposals` can address people but not mirror.
- DMs only (no channel posts); a failed post or update is logged, not retried; a snoozed suggestion that wakes is not re-posted.
- Slack matching by email needs `users:read.email`; unmatched emails get no DM.
- Dismiss from Slack always records `not-relevant`.
