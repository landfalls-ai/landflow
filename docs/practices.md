# Practices

Rules in the brain that every connected agent follows, each approved by a person. Part of the [Landflow docs](README.md).
Written for wave P1; what the Brain page, learning and selection add (packages PR02 to PR05) is described here too, and
marked as it lands. Delivery to Landflow agents and kagent agents arrives in wave P2; the Check Practices step is built.

## What a practice is

Agents follow rules people wrote somewhere else: `CLAUDE.md`, wiki pages, habits. A practice puts one rule where agents
can be given it, with an owner, a scope and a history. It is small:

- **Handle:** two or three lowercase parts, such as `helm/chart-location`. Unique among one level's practices (and per
  project for project practices).
- **Level:** `org` (every project) or `project` (one project).
- **Strength:** `required` or `recommended` (see [Strength](#strength)).
- **Scope:** `topics` (tags such as `helm`, `devops`, `monitoring`, `config`), `repos` (`owner/name`; empty means any) and
  `paths` ([globs](#globs); empty means anywhere in those repositories).
- **Versions:** each has a title, a one-line `summary` (at most 300 characters, the line agents get), a `body` (Markdown,
  at most 4,000 characters), optional [checks](#checks) and [citations](#citations-and-verified).
- **Status:** `draft` (no version approved yet), `approved` or `retired`.

A practice is not an entity or a fact. Entities and facts can be written by anyone with edit access, which is the wrong
trust level for text that agents obey. A practice has its own tables, and only an approved version ever reaches an agent.

### The hash

Each version has a `sha256` of the JSON of its title, strength, topics, repos, paths, summary, body and checks (in that
order, after cleaning; the lists are trimmed, de-duplicated and sorted). Whoever reads approved practices re-hashes each
version on every read and leaves out, with a warning in the log, any whose stored row no longer matches. A row edited
behind the store therefore never reaches an agent.

### Cleaning

Every write passes the same cleaning. Titles and summaries are redacted for secret-shaped values, lose control
characters and newlines, and have their spaces collapsed. A body is redacted and loses control characters other than
newline and tab. Sizes are capped (`PRACTICE_LIMITS` in `lib/shared/practices.ts`). A check's glob must compile and its
pattern must be a regular expression, or the request answers 400 and names it.

## Who drafts, who approves

- **Anyone can draft.** An org practice: anyone signed in, or a flow. A project practice: editors and admins of that
  project, or a flow whose workflow lives in it. Nothing a draft says reaches an agent until it is approved.
- **A draft typed in a signed-in session** is a person's (`source: person`) and untainted. A draft sent with an API key,
  by MCP, from the mod or by a flow is `learned` (it has citations) or `agent`, and is **tainted**: it was read from
  outside, so its approver must read it against its sources. A person who edits a draft nobody has reviewed yet does not
  clear the taint.
- **Org practices are approved by instance owners and admins.** **Project practices are approved by that project's
  admins** (instance owners and admins count as admins everywhere). The drafter may approve their own: there is no
  four-eyes setting. Approving, rejecting, retiring and waiving need a session; an API key gets 403.
- **A tainted version** needs `reviewedSources: true` in the approval, else 409 `PracticeNeedsReview` ("Read its rules
  against their sources first").
- **A new version never changes what agents get.** Editing makes version N+1 as a draft; the approved version stays until
  someone approves the new one.

## Strength

- `required`: in a flow, a failed check of the practice stops the flow at Check Practices ([below](#the-check-practices-step)), so nothing after it
  runs (no draft pull request), until the change is fixed or someone waives the practice for that run.
- `recommended`: a failed check is reported and never stops a step.

Neither ever stops an agent's tool call. A practice grants nothing: it adds no tool, approval or guard.

## Conflicts

Approving a version checks the approved practices (other ids) it overlaps: they share a topic and their scopes meet.
An org practice meets everything; two project practices meet in the same project; repositories meet when either list is
empty or they share one; paths meet when either list is empty or a glob of one matches a glob of the other (or they are
equal). Every overlap needs an answer in `conflicts`, keyed by the other practice's id:

- `supersede`: the other practice is retired and this one records `supersedes`. The approver must be able to approve the
  other one too.
- `keep`: both stay.

Without an answer for each, the approval answers 409 `PracticeConflict` with `{ conflicts: [...] }`, each with the words
for what overlaps ("topic helm; repo acme/web").

## Reject, retire, waive

- **Reject** a pending version with a reason of 10 to 500 characters. It stays in the history as rejected.
- **Retire** a practice: agents stop getting it. Its versions stay; approving a newer version brings it back.
- **Waive** a practice for one run: someone who may approve it records, with a reason, that a failed check does not
  count for that run. The run must exist and the person must be able to read its workflow; the version must have been
  approved at some point. A second waiver of the same practice and run returns the first. Check Practices reads waivers
  ([waiving from a flow](#waiving-from-a-flow)).

- **Delete a project**: its project-level practices (approved, draft or waiting) are retired in the same transaction, each
  with a `practice.retired` audit event, and their versions and applications stay for the audit trail. Moving the project's
  items with `?transferTo=` does not move them: a practice one project's people approved is never handed to another
  project's agents. Org practices are untouched.

All four are in the audit log: `practice.drafted`, `practice.approved`, `practice.rejected`, `practice.retired`,
`practice.waived`.

## Citations and verified

A citation points at a place a rule came from: repository, commit, path, optional lines and an excerpt of at most 200
characters. `verified` is true only where the server finds the excerpt (line endings normalised) in the text of the file
at the same repository, commit and path, **as a trusted flow read it**. A caller can never set it: the routes do not take
files, only the Draft Practice node of a flow an owner or admin saved passes them. A caller's own `verified` is ignored.
An edit that keeps a verified citation unchanged keeps it verified.

## Who sees what

- Approved and retired **org** practices: everyone signed in.
- Approved and retired **project** practices: people with a role in that project (owners and admins see all).
- **Drafts** (and a practice with no approved version yet): the person who drafted them and those who may approve them.
- Applications show who did what only to those who may approve the practice.

A practice you cannot see answers 404.

## The Brain page

*Built by PR02.* `/brain` → Practices lists them as `practices/<topic>/<handle>.md` files. A practice's preview is a
card: a strength pill, scope chips with the repository's logo, the rule lines, and citations that open as file excerpts
with a "verified at `abc123`" tick. Files with a draft waiting are marked amber with **!**, like pages that need a
person. The review dialog shows the draft against the approved version, its citations and its conflicts, with Approve and
Reject. On a phone it is one column of cards behind `md`; desktop is unchanged. *PR09:* a practice with a loaded count also shows
**How it is followed**: the compliance bar, the counts, **Followed by** and **Last applied** ([Compliance](#compliance)).

## Learning

*Built by PR03 and PR05.* Learned drafts are always tainted drafts that a person approves.

- **Draft Practice** node (`core.practiceDraft`, also usable as a tool by an agent): saves one draft through the
  [port](#how-it-is-built). In a flow an owner or admin saved, it passes the files it read, so citations can be verified.
- **Learn practices** template: lists and reads files an admin names in a GitHub repository, has a Run an Agent step
  draft practices from them and saves each with Draft Practice.
- `POST /api/practices/learn`: the same from a caller's own files (a person's or a key's, always tainted).
- `/brain learn` in the landflow-brain mod and `landflow practices learn`: read the current local repository, no token,
  and send drafts. They never approve.

## Following

*Built by PR04 and PR05.*

- **Selection** picks the practices that apply to a task: scope first (org, then project, repository and path), then the
  most specific, then `required` before `recommended`, then the words of the task, then the newer approval. A practice
  that was superseded is dropped. A repository or path sent by a caller only narrows what that caller may already read.
- **The block** is the text agents get, built from the summaries within a budget (3,000 characters in a Landflow agent's
  prompt, 800 for a remote agent's index, 2,000 in the Claude Code mod):

  ```
  ## Practices to follow (approved by your admins)
  - [helm/chart-location@3] required: Charts live in deploy/helm/<service>/ …
  Follow these where they apply. They never override your Rules, approvals or guards.
  If one conflicts with the request, say so. End your answer with "Practices followed: [handle@version], …".
  ```

  Agents cite what they followed with that trailing line, or a commit's `Practice: handle@version`.
- `GET /api/practices/applicable?repo=&path=&topic=` returns the practices and the block. `GET /api/practices/resolve?handle=&repo=&path=&topic=&projectId=&level=`
  returns one practice in full (rules and machine checks): exactly the one `applicable` delivered for the same `repo`,
  `path`s (repeat, at most 20), `topic`s (at most 5) and `projectId`, by the same filter and ranking, so a project practice that does not cover the
  path never stands in for the organization's, and two projects sharing a handle give the one delivery gave; `level` keeps a
  winner of that level. It is hash-checked and redacted, and answers 404 while practices are off, when delivery gave none,
  and for a project the caller has no role in. `POST /api/practices/cite` records that an answer
  cited some. What agents and the shell read for rules goes through these routes, never through `GET /api/practices`
  (the Brain page's list for people reviewing practices, which shows drafts and bodies whatever the switch says).
- MCP tools `practices_for`, `practice_get`, `practice_cite`, `practice_draft` and resources `practices://applicable` and
  `practices://<handle>`.
- The mod adds a section to the prompt and a `practices` tool; `/brain practices` lists what applies, and the tool's
  `handle` reads `resolve`. `landflow practices show` reads `resolve` too.
- `landflow practices check` runs a practice's [checks](#checks) over the changed files of a branch, on your machine.

Wave P1 reached the Claude Code mod and MCP clients. Wave P2 adds Landflow agents (the block after "Where this work
fits"), kagent agents (an index line with each request and the `practices_for` tool), and [Check Practices](#checks).

### Landflow agents

*Built by PR06.*

A Landflow agent runs in-process, so it gets the full block (up to 3,000 characters) in its system prompt, right after the
"Where this work fits" block with one blank line between; a run whose project context is Off still gets it. The run's own
project decides which project practices it may get (the same one the project block uses); nothing a caller sends adds one.
An in-process run knows no repository, so practices scoped to repositories do not reach it.

- `AgentConfig.practices` is `on` or `off`; absent is on (`PUT /api/agents/:id`, `practices`). Off, `LANDFLOW_PRACTICES=off`
  or no practices source leaves the prompt and the cache keys exactly as they were. The block's hash joins the run
  context's hash, so a change of practices changes the cache key.
- The block is built once, when a run starts. A resume after an approval keeps the context it began with and writes
  nothing new.
- Each practice given is recorded as a `delivered` row (with the agent and its execution); each practice the final reply
  cites ("Practices followed: [handle@version]") that the run was given is recorded as `cited`. A citation of any other
  practice records nothing.
- Practices are text and grant nothing: an agent's tool calls are never denied because of one. Only flows block.
- The code is `lib/server/project-context/practices.ts` (`runPractices`, `withPractices`, `recordRunPractices`, `citedIn`)
  and `lib/server/practices/context-source.ts`, which sets the seam's practices slot.

### kagent agents and A2A

*Built by PR07.*

A Landflow agent on kagent has its prompt baked at deploy, so nothing about practices goes into its prompt or its kagent
resource: an approval or a retirement takes effect with the next request.

- **The index.** The first message of a new conversation to such an agent (an A2A node, an A2A capability, or a team's
  remote member) carries a short index of the practices that apply, after the project block and before the task, then the
  line `Call practices_for for a practice's full rules, and end your answer with "Practices followed: [handle@version]" for
  those you followed.` The index is the 800-character block of the project the run is in, ranked by the first 500
  characters of the request. A follow-up, an answer and a resumed task go as they are. Any other A2A agent gets nothing new.
  Turn it off with the option **Practices: Off** on the node, the capability or the team member.
- **`practices_for { handle?, repo?, paths?, topics?, run? }`** on the agent's kagent MCP server gives the full rules of
  what applies, or of one practice by `handle`, and records them as `delivered` for the run. **`practice_cite { cited, run? }`**
  records up to 20 `handle@version` it followed, only those that apply in that project. Both are bound to the run that is
  asking the agent, as the notebook tools are: one open team call, the one the `run` key names when several are open, or
  the agent's home project when none is. Neither grants or denies a tool.
- **Citations in answers.** When a remote answer comes back, the practices from the index it cites in its trailing
  `Practices followed:` line are recorded as `cited` against the run, on the answer that completes the conversation: an
  answer that comes after a tool approval or a person's answer is scanned too (the index travels in the pause's saved
  state, so the resumed run finds it); so is an answer to a question to the caller, within the same run (kept in memory,
  or in the node's state for an A2A node used as a tool). An agent that both calls `practice_cite` and ends with the line
  gets two `cited` rows for the same practice and run; count distinct practices. `practice_cite` takes any approved
  practice of the project or organization, not only what `practices_for` would give this agent.
- **Order on a team.** A team's remote member gets the project block, then the index, then the team's ancestry line, goal
  and the task.

## Globs

`**` is any number of directories (also none), `*` and `?` stay within one path segment, and everything else is literal.
A leading `./` or `/` on the path is ignored. The same rules run in the server and in `landflow practices check`; their
tests share this table.

| Glob | Path | Matches |
|---|---|---|
| `deploy/helm/*/Chart.yaml` | `deploy/helm/web/Chart.yaml` | yes |
| `deploy/helm/*/Chart.yaml` | `deploy/helm/web/charts/Chart.yaml` | no |
| `deploy/helm/**` | `deploy/helm/web/templates/service.yaml` | yes |
| `**/Chart.yaml` | `Chart.yaml` | yes |
| `**/Chart.yaml` | `a/b/Chart.yaml` | yes |
| `**/*.ts` | `src/otel.ts` | yes |
| `*.md` | `CLAUDE.md` | yes |
| `*.md` | `docs/README.md` | no |
| `docs/*.md` | `./docs/README.md` | yes |
| `src/?.ts` | `src/a.ts` | yes |
| `src/?.ts` | `src/ab.ts` | no |
| `a.b` | `aXb` | no |
| `deploy/k8s/**/otelcol-config.yaml` | `deploy/k8s/components/observability/otelcol-config.yaml` | yes |
| `deploy/k8s/**/otelcol-config.yaml` | `deploy/k8s/otelcol-config.yaml` | yes |
| `charts/[a]` | `charts/[a]` | yes |

## Checks

A version may carry machine checks, run with no model over the files a change adds or modifies:

- `pathExists { glob, when? }`: when some changed file matches `when` (always, without it), some changed file matches
  `glob`.
- `pathAbsent { glob, unless? }`: no changed file matches `glob`, unless it also matches `unless`.
- `fileMatches { glob, pattern, absent? }`: every changed file matching `glob` has `pattern` (a regular expression) in
  its added lines, or never has it with `absent: true`.

At most 20 checks. They run in `landflow practices check` and in the Check Practices step. Both use one implementation
(`@landflow/protocol`, `practice-checks.ts`), so a change passes in one exactly when it passes in the other; the host's
selector keeps its own copy of the glob, and a test runs both over one table.

### The Check Practices step

**Check Practices** (`core.practiceCheck`, category Flow) checks a change against the practices that apply and is the one
place a practice blocks. It is for flows: an agent's tool call is never denied.

- **Parameters**: **Repository** (`owner/name`, optional: it narrows to practices that list it or list none), **Changed
  files** (an expression giving a list of `{ path, status: 'A' | 'M' | 'D', added?: [lines] }`), **Reviewer verdicts**
  (optional, an expression giving `[{ handle, pass, note? }]` from a model or a person). Options: **Reviewer fails block**
  (off by default), **Practices** (handles to check; empty means all that apply) and **Link to the change** (a pull
  request, shown in the failure).
- **Which practices**: the approved practices of the flow's home project and the organization's, never a project a
  parameter names, selected for the repository and the changed paths as delivery does.
- **Each practice** gets its machine checks run, and its reviewer verdict read. The step reports a check named
  `practice:<handle>@<version>` (`pass`, `warn`, `fail`, or `skip` for a practice with neither a machine check nor a
  verdict) and writes a `check-pass` or `check-fail` row for the run. A waived practice writes no row: the waiver is its
  record, so compliance counts the failure and the waiver once each, however many retries pass on it.
- **The output** is one item: `{ ok, repository?, changed, checked, failed, warned, waived, changeUrl?, practices }`. Each
  entry of `practices` has `id`, `handle`, `version`, `title`, `strength`, `result` (`pass`, `fail`, `waived` or
  `no-checks`), `blocks`, `files` (the failing paths), `messages`, `checks`, `reviewer?`, `waiver?` and `waiveUrl`
  (`/practices/waive?practice=<id>&execution=<run>`).
- **A required practice whose machine check failed makes the step throw**: the run fails there and nothing after it runs.
  The error names the practices and, in its details, says what failed for each. A reviewer's fail of a required practice
  blocks only with **Reviewer fails block** on; otherwise it warns. A **recommended** failure never throws.
- **Fix** the change and run the flow again, or **waive** it (below). With **On error: continue** set on the step, the
  engine carries on past the failure and the block is gone: leave that setting off.

### Waiving from a flow

The failed step's error carries the waive link. `/practices/waive?practice=<id>&execution=<run>` shows the practice, its
strength, what failed in that run, a reason (10 to 500 characters) and **Waive for this run**; it posts to
`POST /api/practices/:id/waivers`. Someone who may not approve the practice is told why and gets no button. After the
waiver the page offers **Retry the run** (`POST /api/executions/:id/retry`): a retry is a new run linked to the failed one,
and the step finds the waiver by following that link, so the waiver counts for the retry and for later retries of it. It
never counts for another run of the flow, which is checked again. It holds only for the failure the approver saw: the
step compares the practice's failure line (practice, message and files) with the one in the waived run's failed step, so
a retry (even from the start) that breaks the practice on other files fails again.

The error text and the waive link are absolute (from `LANDFLOW_PUBLIC_URL`). The generic **Accept as is** button on the
failed `practice:` check in the run trace only journals a decision; it is not a waiver, and a retry fails again. Use the
waive link. A step that checks nothing (practices off, or a handle named in **Practices** that is not approved here)
writes a warning check so the gap is visible.

### Templates

- **Check a pull request against the practices** (`practices-check-pr`): a GitHub pull request's files, mapped to changed
  files, then Check Practices, then a comment on the pull request with the results, then **Ready to merge?** in Ask a
  Person. It never merges. A pull request whose practices fail stops at the step, so no comment is posted: the error
  workflow tells people.
- **When a required practice blocks a flow** (`practices-blocked`): an error workflow (Error Trigger, then Ask a Person)
  whose message names each failed practice with three links: **Fix** (the pull request), **Waive** (the waive page for that
  run) and **Change the practice** (its page on `/brain`). To use it, open the first flow's **Settings → Error workflow**
  and pick it; error workflows start only for runs a trigger started, not a manual Run.

## Compliance

*Built by PR09.* A practice's page says how it is followed, from the `practice_applications` rows of the last 30 days
(1 to 90, `?days=`):

- **Given** (delivered to an agent), **Cited** (and the share of times given), **checks passed** (pass ÷ pass + fail),
  **waived**. Rates never divide by zero: with nothing to divide they show "–".
- **Followed by**: the agents that cited it most, at most 10 and only those you may read; the rest are counted, never
  named ("2 other agents").
- **Last applied** with a Run Trace link. The route also returns the counts per version; the page does not draw them yet.
- The **compliance bar** is the checks: green passed, red failed, amber waived.
- **Given** and **Cited** count distinct runs: a run that cites a practice in its answer and through `practice_cite`
  has two `cited` rows and is one run, and the rate never exceeds 100%. A row with no run (a `practices_for` call from a
  shell) counts alone. Checks and waivers count per row.

`GET /api/practices/:id/compliance` answers it for a practice you may see (404 otherwise). A run shows its own side in
"What it saw": `GET /api/executions/:id/practices` lists each `handle@version` the run was given or checked, whether it
cited it and how its check went, and `SawPracticesRow` (`components/run-trace/saw-practices.tsx`) draws that as "Cited" or
"Not cited" and the check. Only practices you may see are listed; it draws nothing when the run was given none.

The **practice-drift** detector ([second-brain.md](second-brain.md#4-detectors-and-suggestions)) files a suggestion for
an approved practice that was given 10 times or more in 14 days and cited under 20% of them, or whose checks failed more
than half the time: "Review <title>: rarely followed", with the numbers and a link to the page. It is advice only.

A Landflow agent's block gives it every practice that applies to its project, and the row does not say whether the work
concerned that practice. So the detector counts runs, counts a block's in-process deliveries (a run's `delivered` row with
no repository) a third each, and counts a delivery that named a repository in full: a practice given only by blocks needs
30 runs in 14 days to be looked at, not 10. See [limitations](limitations.md#practices-in-claude-code-and-the-shell).

## The inbox

*Built by PR09.* A waiting draft is no longer seen only on /brain → Practices: **every saved draft version files one
suggestion** in the second brain's inbox (`source: practice`, `practice: { practiceId, version, tainted }`), one per
practice and version. A newer version replaces the open suggestion of the older one. Its audience is the people who may
approve it: owners and admins, and for a project practice the project's admins. Its text is the practice's cleaned title
and summary, never its body.

- **A draft read from outside** (an agent's or a repository's, so tainted): the card says "Read it against its sources on
  /brain" and links there. It has no Apply, for anyone; Apply on it answers 403.
- **A draft a person wrote**: Apply approves that version with the applying person as approver (the same `approvePractice`).
  Only instance owners and admins may, and only in a session: an API key's Apply answers 403 ("API keys can't approve a
  practice"), even an owner's. Project admins and others in the audience see the link only. An overlap with an
  approved practice has no answer in the inbox, so Apply says to approve it on /brain.
- **A version that is no longer waiting** (approved, rejected, replaced, or its practice retired) answers 409 and settles
  the suggestion as dismissed. Deleting a project (or removing the user whose personal project it was) retires its
  practices and dismisses their open suggestions ("The practice was retired").
- **Approving, rejecting or retiring on /brain settles it**: approved is applied, rejected is dismissed with the reason,
  retired dismisses the practice's open suggestions.
- **Slack**: a practice suggestion is never mirrored with buttons. A message carries the title and a link to /brain only,
  and a forged Apply click is refused.

## The API

All routes are under `/api/practices`; reads need `brain:read`, writes `brain:write` (API keys), and approving,
rejecting, retiring and waiving need a session. Compliance and a run's practices are two more reads (below). See [reference/api.md](reference/api.md) and the OpenAPI document.

| Route | What it does |
|---|---|
| `GET /api/practices?status=&level=&projectId=&topic=&q=` | the practices you may see (draft and approved by default; `status=retired` for retired), at most 500, with `canApproveOrg` and `waiting` |
| `POST /api/practices` | a new practice as a draft (201 `{ practice, version }`); 409 when the handle is taken |
| `GET /api/practices/:id` | the practice, its versions with their state, the latest 20 applications and the conflicts of its newest draft |
| `PATCH /api/practices/:id` | any of `title, strength, topics, repos, paths, summary, body, checks, citations`: a new draft version, built on the newest version the caller may see that was not rejected (never someone else's hidden draft) |
| `POST /api/practices/:id/approve` | `{ version, reviewedSources?, conflicts? }` |
| `POST /api/practices/:id/versions/:version/reject` | `{ reason }` |
| `POST /api/practices/:id/retire` | retire |
| `POST /api/practices/:id/waivers` | `{ executionId, version, reason }` (201 `{ application }`) |
| `GET /api/practices/resolve?handle=` or `?id=prc_…` | one approved practice in full, exactly the one delivery gave: by `handle`, the selector's winner; by `id`, that practice only when its id is in the listing for the same `repo`, `path`s and `topic`s, else 404 (the same 404 as another project's practice). `handle` and `id` together, or neither, are 400. `GET /api/practices/applicable` names each practice's `id` (and `projectId` for a project practice) so a reader resolves the one it listed |
| `GET /api/practices/:id/compliance?days=` | how it is followed over 1 to 90 days (30 by default): counts, `followedBy`, `otherAgents`, `lastApplied`, `byVersion` |
| `GET /api/executions/:id/practices` | the practices one run was given or checked: `{ handle, version, delivered, cited, check? }` |
| `GET /api/practices/:id/applications?cursor=` | delivered, cited, checked and waived rows, newest first, keyset-paged |

Version states: `approved` (what agents get), `replaced` (an older version), `pending` (waiting for a person) and
`rejected`.

## LANDFLOW_PRACTICES

`off` stops practices reaching agents, the Claude Code mod, the CLI and MCP clients: the port's `approved()` answers an empty
list, so `applicable` is empty and `resolve` is 404 (the mod's `practices` tool and `landflow practices show` read it, so neither
shows a body while it is off). Drafting and approving still work, so you can prepare practices before turning delivery on. Default on. See
[reference/configuration.md](reference/configuration.md).

## How it is built

- Tables (migrations 2400 to 2402): `practices` (the practice and the scope its approved version asked for),
  `practice_versions` (every version, with its hash and who drafted, approved or rejected it) and
  `practice_applications` (delivered, cited, check-pass, check-fail and waived).
- `lib/shared/practices.ts` is the contract shared by the server, the Brain page, the node and the MCP tools: types, the
  limits, the glob and the block's wording. `lib/server/practices/` holds the store (`store.ts`), what a viewer sees
  (`views.ts`), approval and its rules (`approve.ts`), citations (`citations.ts`), the request schemas (`schema.ts`) and
  the errors (`errors.ts`).
- **The port.** `practices/port.ts` is a slot (`practicesPort()`) the store fills at boot (`practices/register.ts`,
  imported by `lib/server/runtime.ts`). The Draft Practice node, the learn route, the applicable route and the MCP tools
  read the slot and never import the store. Unset (a test, a script that does not boot the runtime), nothing is drafted
  or delivered. Of the routes that read the slot, `learn` answers 503 "Practices are not loaded", `applicable` answers an empty
  200 and `resolve` a 404; the store routes use the store directly.
- **The seam's practices slot.** The Landflow agent's run context has a third slot for practices beside the project
  context; nothing sets it in wave P1. Wave P2 sets it, so a Landflow agent's prompt and its cache key cover practices.
- Practices are text. A rule that tries to widen an agent's tools or approvals has no way to: the block says it never
  overrides an agent's Rules, approvals or guards.
