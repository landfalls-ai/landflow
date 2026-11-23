# Access requests

A person asks for access to something (a GitHub team, an organization, a repository, a Google group, or anything done by hand) for a time they name, with a reason. The entry's approvers decide. Approval grants the access for the time allowed and Landflow takes it back when that time ends. Nothing is granted before an approver other than the requester says yes. It is built on the pieces Landflow already has: a workflow with **Ask a Person**, the [GitHub Access](../plugins/github/README.md#node-github-access-githubgithubaccess) and [Google Directory](../plugins/google-workspace/README.md) nodes, Needs you, the audit log and a leader service.

This page is the core: data, rules, nodes, templates, the removal service and the routes. The Access page (the form, Needs you for approvers, the catalog editor) is the second package and is described where it lands.

## What it is made of

- **The catalog.** One entry per grantable thing: a system, a target in it (for GitHub a team, `acme/platform`), the credential Landflow reaches it with, the durations a person may ask for, who approves, who owns the entry and, if wanted, the people who may ask.
- **A request.** Who, which entry (a snapshot of it is kept, so a later edit changes nothing in flight), how long, why, the account to grant to. Statuses: `pending`, `approved`, `denied`, `expired`, `cancelled`, `failed`.
- **A grant.** What a request becomes when approved: `pending` (a manual entry waiting for a person), `active` (with `since` and `until`, `null` for no end), `removing`, `expired`, `revoked`, `failed`, `revoke_failed`, `drift`. The page shows one word per request: waiting, approved, granted, denied, expired, failed, cancelled or removed.
- **The flow.** Two workflows an admin installs once. The request flow is `Access Request` → `Ask the approver` (Ask a Person) → `Grant` or `Record the no` (Apply Access Decision). The chat flow is a Chat Trigger and an AI Agent whose only tool is File Access Request.
- **Four tables** (migration 2935): `access_entries`, `access_requests`, `access_grants`, `access_accounts`. They are not data tables: the rules are per row (an owner edits an entry, a requester sees only their own requests, only the library writes a grant).

## Setting up

An admin posts `POST /api/access/setup` (the Access page's button). It installs the `access-requests` and `access-requests-chat` templates into a project (the admin's home project by default), publishes them and writes the settings key `access_requests`, which names the flows. A second call answers the existing setup. Until then a request answers `409 An admin must set up access requests first`.

**Only an instance admin edits, publishes, unpublishes (also by schedule), restores, moves or deletes the two installed flows** (the lock is in the workflow store, in publishing and in project access, so no route gets round it: a project admin only sees them) (an editor of their project can do none of it; the setup data says so: `flowsAdminOnly` and `lockedWorkflowIds`). Only the flow named by the setting handles requests, and only while it is published with its trigger enabled. A copy of the template made from the gallery does not start for a request, so what an approver is shown is what the admin put there. Every credential an entry uses must be usable by the project the flows live in; the catalog refuses one that is not.

When the host has SMTP (`LANDFLOW_SMTP_HOST`) at setup, Ask a Person asks by **email** (the approver gets signed single-use links); otherwise it asks in **chat**, in Needs you. To tell a Slack channel, add a Slack node after **Grant** in the installed flow.

## The catalog and its rules

| Who | Can |
|---|---|
| Anyone signed in | see the **enabled** entries they may ask for (an entry that lists people is hidden from everyone else with a 404), never the credential |
| An entry's owners | change the name, description, durations, approvers, owners, who may ask and whether it is on. The last owner stays. A stale `version` answers 409 |
| Instance admins | everything, and the only ones who create and delete entries, and change what an entry reaches: **system, target and credential** |

Durations are whole minutes from 1 to 129,600 (90 days) or unlimited, at most 8 per entry. An owner may shorten or remove durations; offering unlimited or a longer time than the entry ever did is an admin's. An entry with a live grant or a waiting request is **disabled, not deleted**. Every change is audited (`access.entry.create`, `.update`, `.delete`) with what it was and what it became; no credential value is ever in a request, a grant, an audit row or an email.

Systems and what each does (the operation names live in `lib/server/access/systems.ts`):

| System | Target | Grants |
|---|---|---|
| `github-team` | organization, team slug | team membership as a member |
| `github-org` | organization | an organization invitation or membership |
| `github-repo` | owner, repository, permission | a repository collaborator at that permission |
| `github-project` | organization, project number, role | **not offered**: GitHub gives no way to read a project role, so an add could lower access and an expiry could remove access the person had. The plugin operations stay; the catalog refuses new entries |
| `google-group` | group email | membership of a Google group, for the person's Landflow email |
| `manual` | instructions | nothing automatic: a person does it and says so |

## Asking

`POST /api/access/requests { entryId, durationMinutes, reason, account? }`. The requester is the **session user**, never a field of the body. The request is refused when the duration is not one the entry offers (400), the reason is outside 3 to 500 characters (400), the entry is not one the person may see (404), a request for the same entry is already open or they already hold it (409 with `existingId`), the flows are not set up (409), or nobody but the requester could approve it (409 `Nobody but you can approve this. Ask an admin to add an approver.`).

**Accounts.** A GitHub entry needs the requester's login: typed once, kept per person in `access_accounts`, shown to the approver beside their name marked *unverified* (it is typed, not checked against GitHub sign-in) and changed only by them (`access.account.set`). One login belongs to one person, whatever its case. One live grant per target and account across entries. Google access always goes to the requester's own Landflow email, whatever the body says. A manual entry needs none.

**What the approver reads.** The question is built by the server from the request: names and the reason are put on one line (control characters and line breaks become a space), and the requester's reason comes last, quoted, behind a `--- the requester wrote:` line, so nothing typed can look like the lines above it.

**Who approves.** The entry's approvers other than the requester; when none is left, the active instance admins other than the requester. **Nobody approves their own request**, at any step: the approvers list never holds the requester, the decision route refuses them (403) and Apply Access Decision checks again.

## The flow, step by step

1. The request is stored `pending` with the entry's snapshot and the id of the run that will ask.
2. The installed flow runs outside the request, as the flow's own run. The trigger's item holds the request, the approvers' emails and `durationChoices`: the asked duration first, then every shorter one the entry offers.
3. **Ask the approver** waits. It has *Who May Answer* = the approvers, *Answer Choices* = the durations, *People Only* on, *Allow Editing* off, and a 3-day timeout that rejects. The approver sees it in Needs you (or by email) and approves with one of the choices, or rejects with a comment.
4. **Grant** (Apply Access Decision) reads the decision from the **server's own record of the run**, never from the item it received. A grant happens only if all of this holds:
   - the request is `pending`, was started by this run, and the run is the installed flow;
   - the answer is to the question the server built (`askTitle` and `askText`, stored with the request: who, what, target, duration, reason) and was recorded by the Ask a Person node the request was filed with, and the flow lists as many steps as the entry has;
   - the decision was recorded by an active person who is one of the approvers **stored when the request was filed** (the fallback admins of that day included, not an admin who came later), is not the requester, and is not Slack, a timeout or unknown;
   - no other live grant already gives that account this target (through another entry);
   - the duration is one the entry offers and not longer than asked.
   Anything else records the request `failed` with the reason, grants nothing and tells the requester. In the editor, with the trigger's example item, the node only reports a dry run.
5. Approved: the request becomes `approved`, the grant is made, the requester is emailed. Rejected: `denied` with the comment. A timeout: `expired`.

Approvers who are not members of the flow's project decide through `POST /api/access/requests/:id/decision { approved, choice?, comment? }`. It checks the caller is one of the request's approvers (never the requester), then records the answer the way Ask a Person does, so the run's record is what grants. The existing `POST /api/executions/:id/approvals` also works for those who can see the run.

**Several steps.** One step is built. The data is an ordered list, and Apply Access Decision's *Approval Steps* parameter takes the names of several Ask a Person nodes in order; it then needs a recorded approval from each, by different people. A later step with no recorded answer fails the request with `waiting for step 2`.

## Grants and removal

A grant of an automatic system is made at once through the plugin node, in `trigger` mode (never `tool` or `mcp`, which the GitHub node refuses for writes). **Before the first add** the system is checked once and the answer is stored (`already_had`): a person who already had the access is never taken back at the end, and no retry or takeover works it out again (a retry's add that says "already a member" is only the first add's result). If the plugin fails, the grant is `failed` with the plugin's message (credential values scrubbed) and the requester is emailed; an owner, approver or admin presses **Retry** (only a `failed` grant is retried, one at a time). A revoke that arrives while the add is in flight is remembered and carried out the moment the access is in place (also when that add then fails, since it may have worked at the system). A grant that failed before its first check never added anything, and a system Landflow cannot check is never auto-removed after a failed add: giving those back removes nothing, and says so. GitHub never raises what a member or collaborator already has: asking for a higher team role or repository permission fails with that reason (change it in GitHub).

The `access grants` **leader service** runs every minute and every hour:

- **Minute pass.** An `active` grant whose `until` has passed is claimed (a conditional update to `removing` with a 10-minute lease, so two processes never both remove it), removed through the plugin, and becomes `expired`. A failed removal is `revoke_failed` and is tried again after 1 minute, then 2, 4 and so on, never more than an hour apart. At most 100 grants a pass. Unlimited grants never end by themselves.
- **Hourly reconcile.** A `removing` row whose lease ran out (a process stopped) is taken again, and so is a `pending` automatic grant whose lease ran out, or that has no lease and is older than one (a process stopped before it took one); it keeps the recorded `already_had`. Each live automatic grant that can be checked is checked: a person removed outside Landflow makes it `drift` (audited, **never added back**); a drifted grant still ends at its end, without a removal (the person left outside Landflow; whoever put them back owns that), and the note says so. Every write is a conditional update of the columns it changes, never a whole stale row. A grant still in place 24 hours after its end raises `access.grant.revoke_overdue` once.

**Revoke now** (`POST /api/access/grants/:id/revoke`) is the holder giving it back, or an owner, approver or admin taking it back; a stranger gets 404. **Manual entries.** An approved manual request makes a `pending` grant and emails the approvers "please grant by hand" with the entry's instructions; **Done** (never the holder) starts it from now. At its end, or on a revoke, the grant becomes `removing` and the approvers are asked to remove it by hand; **Done** ends it.

## Emails

Never blocking: without SMTP the Access page is the only notice. To the requester: granted (with the end), denied (with the comment), expired, failed (with the reason), ended (expired, given back or taken back), and approved-and-waiting for a manual entry. To the approvers: grant by hand, remove by hand. A message holds names, the entry, the duration and a link to `/access`.

## Asking in chat

The chat flow's agent has one tool, **File Access Request** (`core.fileAccessRequest`), with one operation: file. The server, not the model, enforces the confirmation:

- called **without** `confirmToken`, it validates and files nothing; it answers a summary and a token (HMAC over the entry, duration, reason, account, person and this run, valid 15 minutes);
- it files only from a run the Access page's chat started for the installed chat flow (any other chat run files nothing), and the token is **spent** when it files;
- called **with** that token, it files only from a **later run of the same person** (a later chat turn) with the same fields. The same run, another person, an old token or changed fields are refused;
- the requester is the chat run's `startedBy`; a run nobody signed in for (hosted chat) answers `Sign in on the Access page to ask for access.`;
- it can't approve, grant or name who is asking.

`POST /api/access/chat { message, sessionId }` runs the chat flow as the session user and answers `{ reply, requestId? }`.

## The nodes

- **Access Request** (`core.accessRequestTrigger`) starts the flow once per request; a manual run emits an example item.
- **Apply Access Decision** (`core.accessDecision`): *Request ID*, *Decision* (Approved or Rejected), *Approval Steps*, *Fail the Run on a Failed Grant* (off: a failed grant is an item with `status: "failed"` and the reason). Outputs `{ requestId, status, grantId?, until?, note?, dryRun? }`.
- **File Access Request** (`core.fileAccessRequest`, an agent tool).

## Routes

All under `/api/access`, session only: an API key never asks, decides or edits the catalog. Listed in [reference/api.md](reference/api.md) and the OpenAPI document. The Ask a Person options are in [features/engine.md](features/engine.md) (Ask a Person).

## What Landbright will take over

The built-in modules sit behind one port (`lib/server/access/port.ts`): routes and nodes call it, never the modules. A later backend that calls Landbright's machine API registers itself with `registerAccessBackend` and its sweeper replaces ours. The names map one to one: an entry is a bundle with one target, `steps` are the policy's steps, `AccessDecision` is a vote, and `GrantStatus` maps onto grant and target statuses.

## Limits

See [limitations.md](limitations.md#access-requests).
