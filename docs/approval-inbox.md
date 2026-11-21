# The approval inbox

Production approvals wait for a person. When a run nobody watches (a webhook, a schedule, a poll, an app trigger, a form, an
error or called workflow) reaches an agent tool that asks first, the run pauses instead of refusing; the question waits in
**Needs you** with a nudge; **Approve** runs the call, **Deny** refuses it, and a request that nobody answers in time expires and
refuses the call too. *The person's decision of 2026-11-18, with the choices of 2026-11-19: 24 hours, anyone with run access,
a mail to everyone who may approve.*

This page is the server side (wave ap1, package AP01): the record, the one claim behind every door, the routes, the nudges, the
expiry and Needs you. The node that pauses and resumes is the Run an Agent step (AP02); Home's panel, the Needs you rows and the
Run Trace card are AP03's: see [What you see](#what-you-see). Part of the [Landflow docs](README.md).

## What waits, and who decides

- **What waits**: one request per undecided tool call of a Run an Agent step whose Tool Approvals is *Ask*, in a run whose mode is
  not manual, not the editor's chat and not an MCP or tool call (`inboxMode` in `lib/shared/approval-inbox.ts`), and that neither
  the hosted chat page nor an MCP trigger started: the hosted chat starts its runs in mode `webhook`, so the node reads the
  execution's `triggerType` (the start node's type; the hosted chat sets it to its chat trigger also when the run starts at a roster
  target), and a workflow such a run called inherits that trigger when it starts (stamped from the parent while its record is readable; a parent that cannot be read refuses too, never opens a request), a retry or re-run keeps the trigger of the run it replays, and a run from before the wave with no `triggerType` is judged by the first node it ran (a re-run, a retry and the node's own check derive it the same way; a pre-wave sub-execution is judged by its parent's verdict, recursively to the nesting limit, before its own first node, in a re-run, a retry and the node's own check; a called workflow whose parent cannot be read, or started at anything but a known trigger that can wait, refuses too, saying *this run's start could not be shown to come from a trigger that may wait*, not the hosted chat's reason; a plugin's trigger is looked up in its manifest, so one whose plugin is offline right now still waits); whatever type a run ends with, stamped or derived, anything but a known trigger that can wait (or the manual one) refuses; it refuses with the publish line's reason (*the hosted chat page cannot show an
  approval*, *an MCP call answers its caller at once*). A step set to *Refuse* keeps refusing. Spotlight's own test runs, the editor's chat, manual runs, the eval gate and sub-agents are unchanged. The publish line for a *called workflow* reads that workflow alone, so it says *waits* even though a call from a hosted chat or MCP run refuses; an error workflow fired by a failing hosted-chat run, or by a failing MCP run, waits (its input carries the caller's data; a decision for the person to confirm); a plugin's chat trigger has its own word, *chat app*, and waits.
  Not covered: an agent deployed to kagent (its pause lives in kagent's own task) and Run a Team's members (they already wait in
  production with no expiry and no nudge).
- **Judge requests** (C13): an [AI Judge](features/ai.md#ai-judge) step that could not decide (low confidence, no or invalid decision, an error, a limit) and whose fallback is *Ask a person* opens one request of kind `judge` per undecided item, in the same runs and with the same expiry, claim and access rules. A run that cannot wait denies instead. See [Judge requests](#judge-requests).
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

Migration **2920** adds `kind` (`judge`; NULL, every older row, is a tool request) and `evidence` (JSON, judge requests only). Rows are **kept** (the audit of who decided). A deleted workflow keeps its rows, which then only instance owners and admins read; a
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

## Judge requests

A judge request is a row with `kind = 'judge'`. It is asked about the request itself, not a tool: `tool` is the judge step's name, `call_id` is `judge:<execution>:<step>:<run of the step>:<item number>` (unique per step and per run of the step, so two judge steps, or the batches of a loop through one judge, never share a request; a settled request is never waited on again), the agent and session columns hold `''` and `agent_name` reads *AI Judge*; `params` is the **item** the judge read. **Approve** lets that item continue on the judge's Approved output (`decidedBy` the person); **Deny**, expiry and a cancelled run continue on Denied, and the settled line says so (*nobody decided “Refund check” in time, so it was denied*).

`evidence` (the view's `evidence`) holds `fallbackReason` (one of *no decision, invalid decision, two decisions, low confidence, round limit, tool call limit, model error, tool error, usage cap*), `rounds`, `toolCalls`, the judge's `reason`, `confidence` and the way it leaned (`decision`) when it gave a valid one, and `steps` (each tool call: tool, input, output cut to 500 characters, whether it failed). It passes the host's secret redaction and the key mask like `params`, and is at most 16 KB (steps are dropped from the end past it).

It follows the run's **trace content mode**: with `full` the item and evidence are kept as above; with `summaries` every text is cut to 400 characters; with `off` the item is **not kept at all** (`params` is empty), and the evidence keeps only the reason code, the counts and the tool names. The wait's own data (what the Run Trace and the journal show of the waiting run) follows the same mode. The row never holds more of the item than the Run Trace does. Who may see and decide it is the same as for a tool request: run access on the workflow decides.

## Nudges

Existing channels only, only ones that are set up, once per request (the call that inserts the row nudges; a re-open sends
nothing), in the background, never failing the run.

- **Mail** over the host's SMTP, only when it is configured: one message to **every active user with run access** on the workflow
  and to the agent's own approval emails (Settings of the agent), deduplicated by address. The subject is
  `Approval needed: “Send Email” in “Alert mailer flow”`; the body has the masked parameters, the destination, the workflow and
  agent versions, the expiry, **Approve** and **Deny** links (signed, one use per recipient, expiring with the request) and the
  Needs you link (`<public URL>/?approval=<id>`). A link opens a confirmation page (mail scanners fetch links); the page's button
  decides. After the request settled the page says who won (409) or that it expired (410); a link used after its time says *This approval link has expired at <time>* (the request's expiry).
- **A judge request** mails *Decision needed: “Refund check” in “Refund flow”*: which judge could not decide and why in fixed words, the masked item, the judge's reason (cut to 500 characters) and the same links; the Approve link means *the item continues as approved*.
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
to run “Send Email”* and the detail the destination and *workflow v4*. A settled request never shows. A judge request adds `inboxKind: 'judge'` and `judgeWhy` (the fixed reason code) and reads *“Refund check” could not decide: it was not sure enough (0.52)*.

## What you see

Shots are from a development host with made-up requests, at 1440 by 900 and 390 by 844.

- **Home, one and three requests.** *Waiting for your approval · 3* under the four tiles: each row is the tool, *Alert mailer v2 · Alert intake v4*, where it goes, *Waiting for your approval since 06:36 · expires 06:46*, then **Approve**, **Deny** and **Details**. Nothing shows when no request waits.
- **Details.** The parameters it would run with as a two-column list (`smtpPassword` reads `••••••`), where it goes, *Started by a webhook run*, the agent, the workflow, **Open the run**, since and expires, and the same two buttons. A side-by-side dialog on a desk, a bottom sheet on a phone.
- **After Approve.** The row reads *Approved by Owner in Needs you · 06:40* for four seconds, then leaves.
- **A lost race.** The row reads *Already approved by Owner at 14:05.* (the server's 409 words) and leaves on the next refresh.
- **`?approval=<id>`.** Opens that request's Details; a request that ended shows how it ended.
- **The Runs page.** The same rows in **Needs you**, next to the old link rows for waits that are not inbox requests.
- **The Run Trace card.** *Waiting for your approval since … · expires …*, the versions and the destination, **Approve: Send Email** and **Deny**, no **Edit**.
- **The publish card and the Publish menu.** A clock line for a step that will wait, the shield line for one that still refuses.
- **The agent page's session.** *Waiting in Needs you · Open it* under the waiting call, no **Approve** or **Deny**.

- **A judge request.** The row is badged *Decision* and reads *“Refund check” could not decide: it was not sure enough (0.52)* with the workflow, no agent. **Details** list the item (a `token` key reads `••••••`; *This run keeps no item text* when its trace content is off), what the judge concluded with its confidence, and each tool it used. The Run Trace card shows the same under the judge's title. Everything is shown as text.

There is no *Approve all*, no select-many and no keyboard shortcut that approves.

## What is not covered

kagent and the Claude Code harness; Run a Team's members; a remote A2A agent's own pause in a run nobody watches (still
auto-rejected); Slack as a place to approve. See [limitations.md](limitations.md).
