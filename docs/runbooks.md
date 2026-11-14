# Runbooks from Landfall war rooms

Part of the [Landflow docs](README.md); the [feature map](README.md#feature-map) lists every feature page. It builds on
[alert triage and Landfall](triage.md).

After a war room closes, what the responders did becomes a **runbook**: an ordinary workflow with one step per fix they
applied, an approval before any step that is risky or changes production, and the chat around each step as its notes.
It is saved as a draft that a person reviews. When an alert of the same kind arrives later, triage names the runbook,
links it in the new room, and the next incident starts from a runbook instead of a blank room.

No model is used. The folding is a fixed set of rules, so the same room always gives the same draft.

## Making one

**Workflows** → **Runbooks** tab (shown when the Landfall plugin is registered; `/runbooks` still opens directly) → **New runbook** opens a dialog: paste the room (JSON), optionally give the
alert kind, then **Fold into steps**. Each step card has its title (editable), an **Approval first** switch and the
notes; remove a step with the bin. **Back** returns to the room; **Save as draft** makes the workflow and opens it.

The room is `{ incident, events, outcome? }`:

- `incident`: `{ id, displayId, title, severity, category?, alertSource? }`.
- `events`: the room's timeline (`{ seq, type, payload }`), as Landfall returns it.
- `outcome` (optional): a **Room outcomes** row from the [lessons flow](triage.md#the-other-flows) (`cause`, `fix`,
  `lessons`, `runbook_steps`).

The Landfall node's **Incident → Get Room** returns the first two in one item (it reads the state and every event); add
the outcome row from the Room outcomes data table. Over the API: `POST /api/runbooks/draft`, then `POST /api/runbooks`
([reference](reference/api.md)).

### How the room is folded

| Timeline | Becomes |
|---|---|
| `remediation.applied-externally` (also `remediation.applied`, `edge.action.applied`, `edge.action.executed`) | a step, in timeline order. Its title is the record's `action`, else the `action`/`description`/`title` of the suggestion it names with `sourceSeq` (`remediation.proposed`, `edge.action.proposed`) |
| `chat.message` between the previous step and this one, and the record's `note` | the step's notes (the last five, oldest first) |
| a record with no action text, or one whose action repeats an earlier step | left out, and listed under **Left out** |
| no remediation records at all | the outcome row's `runbook_steps`, one step each |
| the outcome's `cause`, `fix`, `lessons` | a note at the top of the workflow |

**Approval.** A step asks for approval first when, in this order: the responders marked it (`risky`, `risk`,
`destructive` or `requiresApproval` on the record or its suggestion; a plain "low", "safe" or `false` means no); its
`environment` is production; or its text has a changing word (restart, roll back, delete, scale, failover, deploy,
drain, rotate, and similar). The card says which. The rule errs towards asking, and the review is where you take an
approval off a step that does not need it, or put one on.

**Alert kind.** The lower-case words of the alert, joined by hyphens: `HighErrorRate` is `high-error-rate`, and ids,
numbers, `[brackets]` and severities are dropped. A room's kind is the one you give, else its category, else its title.
A canonical alert's kind is its `alertname` label, else its title. The kind is stored as the tag `alert-kind:<kind>`.

## The workflow

A saved runbook is a draft (not published), tagged `runbook`, `alert-kind:<kind>` and `room:<id>`:

- Two starts: **Start** (manual) and **When Called by a Workflow or Agent** (for the triage flow).
- Per step a **Wait** on a form (`step_N`): the run stops there until a person submits the form (Done or Skipped, and
  what happened). The form's description holds the notes. This is the same form wait as everywhere else, so the run
  shows under **Needs you** and resumes at `/form/waiting/<run>`.
- Before a step that needs approval: a form wait (`approve_N`, Approve or Reject, and a reason), then an **If** that
  goes on for Approve. Reject ends the run on a **No Operation** (`reject_N`), so the run finishes and the form shows
  its normal end screen; look for `reject_N` in the run to see it was turned down.
- A sticky note with the room, the cause, the fix and the lessons.

It is a normal workflow: edit it in the editor, add real nodes (HTTP requests, kubectl through a plugin) in place of or
after a form step, publish it when it is ready.

## The link back

The **Find Runbook** node (Flow category) takes an alert (by default `alert.labels.alertname ?? alert.title`, the
canonical alert of Normalize Alert) and adds to the item:

- `runbook`: `{ id, name, alertKind, match, published, approvals, url, startUrl }` or `null`. `url` is `/workflows/<id>`
  (with **Base URL** in front when set, which Slack and Landfall need); `startUrl` is the workflow's
  `POST /api/workflows/<id>/execute` (send `{ "input": { "alert": … } }`) that starts a run.
- `runbookFound`, `runbookLine` (a sentence with the link, for a Slack message) and `otherRunbooks`.

`match` is `exact` (same kind) or `similar` (the shorter kind's words, at least two, all appear in the other). Exact
before similar, published before draft, newest first.

**Alert triage → Landfall war room** now has it after **Open war room**: **Find the runbook** (fails open: an error
leaves the room as it was), **Runbook found?** and **Link the runbook in the room**, which posts the link in the room.
Set **Find the runbook**'s Base URL to this instance's address.

Landfall has no field for a link on an alert, so the room's timeline is where it goes: the Landfall node's
**Timeline → Add Runbook Link** (a `chat.message` with the runbook's name and URL; the URL must be absolute http(s)).

## Not built

- The room is pasted or passed in; there is no button on a closed room in Landfall, and no flow that makes the
  runbook by itself when a room ends (the lessons flow could call `POST /api/runbooks/draft`; a draft still needs a
  person's review).
- Steps are people's tasks (forms), not generated nodes: the records hold words, not commands.
- Matching is by the kind's words. Two kinds with different words for one problem need the tag edited by hand.
- Checked against fixtures shaped like the Landfall node's output and its local fake; not against a live Landfall,
  whose remediation records may carry other field names (the folding reads several; unknown ones are left out and
  listed).
