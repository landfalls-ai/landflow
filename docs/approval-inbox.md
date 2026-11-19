# The approval inbox

Production approvals wait for a person. When a run nobody watches (a webhook, a schedule, a poll, an app trigger, a form, an
error or called workflow) reaches an agent tool that asks first, the run pauses instead of refusing; the question waits in
**Needs you** with a nudge; **Approve** runs the call, **Deny** refuses it, and a request that nobody answers in time expires and
refuses the call too. *The person's decision of 2026-11-18, with the choices of 2026-11-19: 24 hours, anyone with run access,
a mail to everyone who may approve.*

This page is the server side (wave ap1, package AP01): the record, the one claim behind every door, the routes, the nudges, the
expiry and Needs you. The node that pauses and resumes is the Run an Agent step (AP02); Home's panel, the Needs you rows and the
Run Trace card are AP03's. Each of those is documented where it lands.

## What waits, and who decides

- **What waits**: one request per undecided tool call of a Run an Agent step whose Tool Approvals is *Ask*, in a run whose mode is
  not manual, not the editor's chat and not an MCP or tool call (`inboxMode` in `lib/shared/approval-inbox.ts`). A step set to
  *Refuse* keeps refusing. Spotlight's own test runs, the editor's chat, manual runs, the eval gate and sub-agents are unchanged.
  Not covered: an agent deployed to kagent (its pause lives in kagent's own task) and Run a Team's members (they already wait in
  production with no expiry and no nudge).
- **Who decides**: a signed-in person with run access on the workflow (its project's editors and admins, an editor share, instance
  owners and admins), the same people who may decide a run's approval today. Never an API key, an agent, Spotlight or the MCP
  server. There is no four-eyes rule on top: that is a different mechanism for publishing.
- **Never a bypass**: no *Approve all*, no approval at publish, no setting that approves unattended calls, an expiry never
  approves, and no API key decides. `POST /api/waiting/:id` keeps refusing an approval wait.

## The record

Migration **2907** adds `approval_inbox`: one row per waiting call, unique on (execution, call), with the workflow and its version,
the node, the agent and its version, the tool, the **masked** parameters, the destination in plain words, the trigger, the status
(`waiting`, `approved`, `denied`, `expired`, `cancelled`), when it opened and expires, how many nudges went out (counts, never an
address) and who settled it, by which door and when. Parameters pass the host's secret redaction (a value resolved from `$secrets`
becomes `[redacted]`) and then `maskParams` (a key such as `password`, `token`, `api-key`, `authorization` becomes `••••••`)
before they are stored; they are masked again when shown, so a row, a view, a list, a mail and an alert never hold a secret.

Rows are **kept** (the audit of who decided). A deleted workflow keeps its rows, which then only instance owners and admins read; a
transferred workflow's rows follow it, because visibility is worked out from the workflow at request time.

## One claim behind every door

`decideApproval` (`lib/server/approvals.ts`) is the one code path for the execution approvals route (the Run Trace), the inbox
routes and a signed email link. For a call that has an inbox row it first refuses a caller that is not a person (403 *A person
decides an approval in Needs you*: an API key, an MCP client, a Slack click or no identity; a signed email link counts as the person
it was sent to), then **claims** the row with one conditional update (`waiting` → `approved` or `denied`; on SQLite inside the
write transaction, on Postgres `UPDATE … WHERE status = 'waiting'` through the direct connection, then this process's copy). Only
the winner records the decision on the wait, writes the journal's row (*Approved by Ed Editor in Needs you · 2026-11-19 14:05 UTC*)
and resumes the run; a lost claim answers who won and changes nothing:

| Situation | Answer |
| --- | --- |
| already approved or denied | 409 *Already approved by Ed Editor at …* |
| the run was cancelled | 409 *The run was cancelled: “Send Email” did not run.* |
| the request expired | 410 *This approval expired at …: “Send Email” did not run.* |
| the request's time passed but nobody settled it yet | it is settled `expired` now and the answer is 410: an expiry never approves |

A run cancelled while it waits settles its rows `cancelled` (the bus's `execution.finished` with `canceled`), and a `waiting` row
whose run is gone, failed or finished settles `cancelled` when it is read. The agent-session route
(`POST /api/agents/:id/sessions/:sid/approvals`) never decides a workflow session's call outside its run: it answers 409
*“Send Email” waits in Needs you: decide it there*. A wait without an inbox row (the editor's chat, Ask a Person, the AI Agent node,
Run a Team) decides exactly as before.

## The routes

See [reference/api.md](reference/api.md). `GET /api/approval-inbox` (`?status=waiting|all`, `?executionId=`), `GET
/api/approval-inbox/:id`, `POST /api/approval-inbox/:id/approve` and `/deny` (body `{}` or `{ note? }`, up to 500 characters).
Approve and deny answer `200 { request }` (the settled view) as soon as the claim is won; the run goes on in the background.
`404` for a request on a workflow you cannot read, `403` for one you can read but not run (or an API key).

## Nudges

Existing channels only, only ones that are set up, once per request (the call that inserts the row nudges; a re-open sends
nothing), in the background, never failing the run.

- **Mail** over the host's SMTP, only when it is configured: one message to **every active user with run access** on the workflow
  and to the agent's own approval emails (Settings of the agent), deduplicated by address. The subject is
  `Approval needed: “Send Email” in “Alert mailer flow”`; the body has the masked parameters, the destination, the workflow and
  agent versions, the expiry, **Approve** and **Deny** links (signed, one use per recipient, expiring with the request) and the
  Needs you link (`<public URL>/?approval=<id>`). A link opens a confirmation page (mail scanners fetch links); the page's button
  decides. After the request settled the page says who won (409) or that it expired (410).
- **Slack, a signed webhook, Telegram, Teams, Discord or an alert email**: only through an **alert rule you add** (Settings →
  Alerts → New rule, event *Waits for your approval*). The alert service's ticker sends one message per request and rule; it names
  the tool, agent, workflow, destination, expiry and the link, **never a parameter value**. Nothing is sent when no rule has the
  event; there is no default channel and no Slack app message.

## Expiry

`LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES` (default 1440 = 24 hours, 1 to 43,200; [reference/configuration.md](reference/configuration.md))
is read when a request opens and stored as its `expires_at`: changing it never moves an open request. The email links of the nudge
expire at the same time. Expiry **refuses** the call and never approves it.

## Needs you

`GET /api/runs/needs-you` lists one `approval` item per waiting request, with `requestId`, `inboxStatus`, `tool`, `agentName`,
`agentVersion`, `workflowVersion`, `destination`, `expiresAt` and `canDecide` for the caller; the title reads *“Alert mailer” wants
to run “Send Email”* and the detail the destination and *workflow v4*. A settled request never shows.

## What is not covered

kagent and the Claude Code harness; Run a Team's members; a remote A2A agent's own pause in a run nobody watches (still
auto-rejected); Slack as a place to approve. See [limitations.md](limitations.md).
