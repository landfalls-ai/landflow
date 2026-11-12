# 09 Human confirm (Ask a Person)

## What was built

A plain flow node, **Ask a Person** (`core.confirmDraft`, Flow category), that sends a draft to a person, waits durably and
continues with their answer, without an AI Agent workaround.

- Parameters: Draft (expression, read from the first item), Title, Ask In (Chat / Execution View, Slack, Email), Slack channel or
  member plus Slack credential (token or OAuth2), Send To (emails), Who May Answer (emails and Slack member ids), Allow Editing,
  Timeout (Minutes), If Nobody Answers (Reject / Approve / Fail the Run).
- Once per run, not per item. One output item `{ approved, edited, text, originalText, comment, by, at, channel }` on
  **Approved** (output 0) or **Rejected** (output 1); a timeout default carries `by: "timeout"`.
- Reuses the tool-approval wait: `resume: 'webhook'`, `rerun: true`, `wait.data.approval` with one call `confirm` and an
  `approval.confirm` block `{ title, text, allowEdit, approvers?, onTimeout? }` (`lib/server/approvals.ts`). Timeouts use the wait's `until`.
  AI Agent tool approvals are unchanged (their tests pass).
- `POST /api/executions/:id/approvals` takes `text` and `comment` for a `confirm` call (403 when editing is off or the caller isn't in
  Who May Answer). No new route.
- Slack: message with Approve / Edit / Reject; Edit opens a modal (`views.open`, handled in `slack/handlers.ts` as a
  `view_submission`); the message is replaced by the draft as approved and who answered (also after a timeout).
- Email: the existing signed links, worded for a draft (Approve / Reject only; confirmation page shows the draft).
- UI: a `ConfirmCard` in the Run Trace's Needs you (draft, editable box, comment, Approve / Reject), "Waiting for <person>: <title>"
  in Needs you / runs list and the journal's wait span, and the editor chat panel shows the draft.
- Files: `nodes/confirm.ts`, `approvals.ts`, `slack/index.ts`, `slack/handlers.ts`, `approval-email.ts`, `journal/translator.ts`,
  `journal/needs-you.ts`, `run-trace/confirm-card.tsx`, `test/confirm-draft.test.ts` (12 tests). Docs: `docs/features/engine.md`,
  `docs/reference/api.md`, `docs/agents.md` (interactions row).

## History row

Ask a Person: a `core.confirmDraft` node sends a draft to a person (execution view, Slack with Approve / Edit / Reject and an edit modal, or email), waits like a tool approval, and continues on Approved or Rejected with the edited text, comment, who and when; a timeout settles with a default.

## Roadmap paragraph

**Human confirm (brain plan item 9).** A flow can now ask a person without an AI Agent: the Ask a Person node waits durably, on the
same mechanism as tool approvals, and outputs the person's answer (approved or rejected, the text as they edited it, a comment, who and
when). The Run Trace shows "Waiting for <person>: <title>" with the draft and Approve / Edit / Reject; Slack gets the same three buttons
and an edit modal; email gets signed links. A timeout settles with the node's default (reject, approve or fail). Still open: asking per item,
editing from email, and a Landflow inbox page of its own (the Run Trace's Needs you is the inbox).

## Limitations to record

- Asks once per run, from the first input item; to ask per item, put the node in a sub-workflow run per item.
- Email answers are Approve / Reject only (no edit, no comment); edit in the execution view.
- Slack's Edit modal holds 3,000 characters: longer drafts get no Edit button there, and the message shows the first 2,800 characters.
- Who May Answer is matched against the signed-in user's email or the Slack member id of the click; a Slack-channel request answered
  from the web by someone not on the list is refused, with no admin override. Email link recipients are not checked further.
- The editor's chat panel shows the draft with Approve / Reject but can't edit it.
- A call to the execution's webhook resume URL (`/api/waiting/:id`) without a decision counts as a rejection.
