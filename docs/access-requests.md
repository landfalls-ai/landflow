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

`POST /api/access/chat { message, sessionId }` runs the chat flow as the session user and answers `{ reply, requestId? }`. Each message can start a model call, so a person gets 20 a minute (429 with `Retry-After`).

## The Access page

`/access` (the rail's Access item shows once Access is set up, or to an admin before). Tabs scroll sideways on a phone; every list is cards there and a grid on desktop.

- **Setup** (admins, first visit): pick the project and, optionally, an Anthropic key for the chat, then one button (`access-setup-go`) installs the request flow and the chat flow. Admins then see links to both flows and, when the flows are admin-only, the sentence saying so.
- **Ask**: the Form (entry, GitHub username when the system needs one, remembered for next time, duration chips from the entry's list, reason) and the Chat. The chat says "It can only file a request; an approver decides." and links the request it filed under My requests.
- **My requests**: state word, what was asked, the reason of a denial or failure, the note of a give-back, Cancel while waiting, Give it back when granted, Retry when a grant failed (a failed grant counts as live, so it can't be asked again).
- **To decide** (approvers): the same confirm card as Needs you, with an *Allow* select of the entry's durations (never longer than asked) and a comment. The question and the durations come from the server (`question` and `choices` on each `?scope=decide` item): the target, the permission or role, and the GitHub username marked "unverified: typed by the requester" are the text the flow asked, never rebuilt in the browser.
- **Grants**: *Everyone* (admins) or *What I manage* (approvers and owners) or *Mine*; Revoke now, Done (by-hand entries) and Retry; a red overdue banner when removing an automatic grant has kept failing for more than a day after it was due.
- **Catalog** (admins and owners): entries in a grid; the sheet is full height on a phone. GitHub Projects can't be added. An owner who isn't an admin is only offered times up to the entry's current longest (and no end only if it already has one); the server refuses the rest too.

Sentences say "with no end" for an unlimited grant; a grant whose time ran out is *Expired* (*Ended* in Grants), and *Removed* is for one taken back or removed outside Landflow. The tab strip scrolls the chosen tab into view on a phone, with a fade at the edge. The Access page loads the visible tab again every 15 s and counts To decide only for approvers; the rail asks for the setup once when the app opens (and when an admin sets it up), not on every page.

The Run Trace's Ask a Person card also shows the *Allow for* select when the request carries Answer Choices.

## The nodes

- **Access Request** (`core.accessRequestTrigger`) starts the flow once per request; a manual run emits an example item.
- **Apply Access Decision** (`core.accessDecision`): *Request ID*, *Decision* (Approved or Rejected), *Approval Steps*, *Fail the Run on a Failed Grant* (off: a failed grant is an item with `status: "failed"` and the reason). Outputs `{ requestId, status, grantId?, until?, note?, dryRun? }`.
- **File Access Request** (`core.fileAccessRequest`, an agent tool).

## Signing in without an account

People who have no Landflow account can ask for access too (C36): an admin opens a page for them, they prove their work email, and they file requests that approvers decide inside Landflow as always. This part is **who they are** (signing in, the session, the limits); what they can ask for and see is described with the page itself. Nothing about approving, granting or expiry changes.

**Setting it up.** Access → Settings (instance admins; `GET/PUT /api/access/outside`): switch **People without a Landflow account can ask** on (off by default), list the **email domains** that may ask (the organization's own, lower case; free mail providers such as gmail.com, wildcards and IP addresses are refused; at most 50) and copy the page link, `<public URL>/request-access` (set `LANDFLOW_PUBLIC_URL`). Optionally switch **Google sign-in** on and choose an **OpenID Connect client** credential (type `oidcClient`: issuer, client ID, client secret, and a discovery URL only where the host reaches the provider at another address). Register the redirect URL the settings show (`<public URL>/request-access/api/sign-in/google/callback`) with the OAuth client. While the switch is off, every route of the page answers 404 and the page says asking is switched off; only `config` answers, and it says nothing but whether asking, Google and the email link are available.

**The email link.** On the page the person types their work email. If its domain is allowed, a link arrives: 32 random bytes of which only the SHA-256 is kept, valid **15 minutes**, usable **once** (one conditional update, so two clicks, even from two Landflow processes, sign in once), one live link per address (a new one replaces the older). The link carries its token in the URL fragment (`/request-access#t=…`), which a browser never sends to a server, a proxy log or a Referer, and the page does not sign in by itself: the person presses Continue, so a mail scanner that opens the link burns nothing. The link is not tied to the browser that asked: asking on a laptop and opening the mail on a phone works. Without SMTP the link can't be sent; the page then offers only Google.

**The same answer every time.** Asking for a link answers 202 with one sentence ("If that address may ask here, a sign-in link is on its way. It works once, for 15 minutes.") whatever happens: a domain no one allowed, an address with a `+tag` (use the plain work address), a blocked person, a limit, a Landflow user's address, a missing mail server. The mail goes out after the answer, so how long the answer takes tells nothing either. The one visible refusal is the limit per network address (429 with `Retry-After`). Every refusal is audited (`access.outside.link`, outcome denied, with the reason `domain`, `subaddress`, `blocked`, `landflow_user`, `limit` or `mail`).

**Google sign-in.** The OpenID Connect code flow with PKCE (S256), a `state` bound to the browser by a cookie (`landflow_requester_oidc`, SameSite=Lax, only on the start and callback paths, 10 minutes, used once) and a `nonce`; the ID token's signature, issuer (Google's `accounts.google.com` spelling too), audience and expiry are checked. Landflow accepts only `email_verified: true`, an **`hd`** (Workspace domain) claim that is one of the allowed domains **and equals the address's own domain**: a personal Gmail account, or a Google account registered on a work address with no Workspace behind it, has no `hd` and is refused ("Use your work Google account"). The `hd` parameter is sent to Google as a hint only when exactly one domain is allowed. Google's `sub` is kept the first time and pinned: a later sign-in for the same address with another `sub` (a mailbox reassigned inside Workspace) is refused until an admin looks. Landflow's own SSO and this flow keep their pending sign-ins apart (`purpose`), so neither state can finish the other's sign-in. A refused sign-in returns to `/request-access?error=<code>`.

**A Landflow user's address.** One address is never two identities. An address that belongs to a Landflow user (active or disabled; compared lower-cased and without any `+tag`) gets no outside identity: asking for a link mails them a pointer to Landflow's own Access page (no token); a sign-in with it, by link or Google, answers 409 `landflow_user` and the page says the same; and an outside person who is invited to Landflow loses their outside session on the next request. Their earlier requests and grants stay with the outside record.

**The requester session.** Cookie `landflow_requester`: a random token of which only the SHA-256 is kept, HttpOnly, **SameSite=Strict**, `Path=/request-access` (Secure behind https), **8 hours at most and 2 hours idle**. It is created only by a verified link or Google sign-in (never taken from a request, so there is no fixation: every sign-in makes a new token and ends the browser's old one), at most 5 are live per person (the oldest ends), and every request checks again that the feature is on, the domain is still allowed, the person is not blocked and the address is not a Landflow user's; if not, the session is deleted. **The cookie opens nothing of Landflow's:** Landflow's guard reads only `landflow_session`, so the requester cookie against `/api/access`, `/api/auth/me` or any other route is a 401, and a Landflow session cookie is none on the page's routes (both are tested).

**CSRF.** Landflow's guard lets the public paths through without a same-origin check, so every write of the page checks it itself: `Origin` (or, without one, `Sec-Fetch-Site`) must be this site, the body must be JSON (a form post is refused with 415) and no CORS header is ever sent. The two Google GETs that change state are protected by the state cookie, PKCE and the nonce. Pages answer `Cache-Control: no-store`.

### Limits

| What | Limit | What the asker sees |
|---|---|---|
| Sign-in links for one address | 3 in 15 minutes, 10 a day | the same 202, no mail (audited `limit`) |
| Sign-in links for one email domain | 200 an hour | the same 202, no mail (audited once an hour with `scope: domain`) |
| Asks for a link from one network address | 10 in 15 minutes | 429 with `Retry-After` |
| Wrong or used links from one network address | 20 in 15 minutes | 429 |
| Starts of Google sign-in from one network address | 20 in 15 minutes | back to the page with `?error=limited` |
| Every public route of the page, per network address | the public trigger limit (`LANDFLOW_RATE_LIMIT_PUBLIC`, 120 a minute in production) | 429 |

None is a setting. The network address is the one behind `LANDFLOW_TRUSTED_PROXIES` proxies: set it, or the limits are only as good as a header the caller controls. The address limits count in process memory, or in Valkey in queue mode (shared by every main); `takeOutside(bucket, key, limit, windowMs)` (used for the chat) counts in the process, and `takeOutsideShared` through the API limiter's shared store. An abuser who owns a whole allowed domain can still use up that domain's 200 an hour: Block the person, or remove the domain.

### Blocking

Settings lists the people who signed in (email, how verified, first and last seen, open requests, live grants) with **Block** and **Unblock** (instance admins, `access.outside.block` / `.unblock`). A block ends their sessions, cancels their open requests, and stops new links (the answer to the asker stays the same: nothing says they are blocked); grants they already hold stay until they end or an admin revokes them. A blocked person's open link no longer signs them in.

### Audit

`access.outside.settings` (before and after), `access.outside.link` (success, or denied with the reason), `access.outside.sign_in` (method `link` or `google`; denied with the reason), `access.outside.sign_out`, `access.outside.block`, `access.outside.unblock`. An address appears in these events (it is what an admin investigates with); a token, a code or a client secret never does.

### Trying it without Google

`apps/web/scripts/fake-oidc.ts` serves the fake Google OpenID Connect server (`@landflow/test-fakes/google-oidc`) on a free loopback port: `pnpm --filter @landflow/web exec tsx --tsconfig tsconfig.json scripts/fake-oidc.ts http://localhost:3100` prints the issuer, client ID and secret to put in an `oidcClient` credential, and registers the callbacks for that Landflow URL. Its accounts are Workspace accounts of `acme.test`; `POST /_fake/accounts { email, hd?, email_verified? }` adds more (`hd: null` is a personal account) and `POST /_fake/next-error { mode }` scripts a refusal. Mail goes to Mailpit.

## Routes

All under `/api/access`, session only: an API key never asks, decides or edits the catalog. The page for people without an account has its own public routes under `/request-access/api` and the admin settings under `/api/access/outside` ([signing in without an account](#signing-in-without-an-account)). Listed in [reference/api.md](reference/api.md) and the OpenAPI document. The Ask a Person options are in [features/engine.md](features/engine.md) (Ask a Person).

## What Landbright will take over

The built-in modules sit behind one port (`lib/server/access/port.ts`): routes and nodes call it, never the modules. A later backend that calls Landbright's machine API registers itself with `registerAccessBackend` and its sweeper replaces ours. The names map one to one: an entry is a bundle with one target, `steps` are the policy's steps, `AccessDecision` is a vote, and `GrantStatus` maps onto grant and target statuses.

## Limits

See [limitations.md](limitations.md#access-requests).
