# Work events and the daily briefing

What people's own tools tell the [second brain](second-brain.md) about their work, and the briefing each person gets back.
Part of the [Landflow docs](README.md). This is the first part of the company backbone: the visibility rule, the two API
key scopes, the routes to record work and the person's own day. The clients that send work (the Claude Code mod, the
`landflow work` command, any harness over MCP) come after it.

## What a work event is

A work event is a short summary of a piece of someone's work: a coding session, a review, a meeting prep. It says what
the work was, where (a repository, directory names) and how much (commits, pull requests, turns). It never holds code,
file contents, file names or absolute paths. Clients redact before they send, and the host redacts every text again
(emails, tokens, long numbers).

An unknown `work.*` kind is rejected ("Unknown work kind; an admin can declare it"); `POST /api/brain/work` declares only the 18 listed kinds itself.

An event is a row in the [usage ledger](second-brain.md#1-the-usage-ledger) with a `work.*` kind. The kind
`work.session` is declared the first time a tool sends it, with the same fields as the other `work.*` kinds
(`deploy/brain/work-kinds.json`). `work.pr_opened` and `work.pr_merged` now come from the `claude-code`, `landflow-cli`
and `mcp` sources too, not only from Git host integrations.

## Who sends them

- The Claude Code mod and `landflow work` (a later wave).
- Any harness over MCP (a later wave).
- Anything that can call `POST /api/brain/work` with an API key that has the `brain:write` scope.

An admin can say tools may not send work on their own: the setting `brain.workAutoSend` (`allowed` by default,
`forbidden`). It is set with `PATCH /api/settings` (`{ "brain": { "workAutoSend": "forbidden" } }`, an admin or owner;
audited like any settings change) and the briefing reports it as `autoSend`, so a client can ask the person instead of
sending. The setting has no screen yet.

## The fields and limits

The contract is `WorkEventInput` in `packages/protocol/src/work-events.ts`, with `validateWorkEvent()` and
`WORK_LIMITS`. No other package is needed.

| Field | Rule |
|---|---|
| `kind` | `work.<name>`: lowercase letters, digits and underscores |
| `source` | the tool, 1 to 40 characters of `a-z`, `0-9` and `-` (`claude-code`, `landflow-cli`, `mcp`) |
| `sourceId` | 1 to 200 characters, the item's id in its tool. Sending it again updates the event |
| `occurredAt`, `endedAt` | ISO 8601 times |
| `title` | 1 to 200 characters, one line, not code: a title over 80 characters that reads like code is refused |
| `summary` | up to 500 characters (the host keeps 200) |
| `repo` | `owner/name` |
| `branch` | up to 120 characters (the redaction also reads a long branch name with a digit as a token, so `feature/brain-work-api-b05` may be stored as `feature/<token>`) |
| `areas` | up to 20 directory names of up to 80 characters. An absolute path, `..` or a file name with an extension (`src/app.ts`) is refused; a comma in a name is refused too, and only the names that fit 200 characters in all are kept |
| `commits`, `turns` | whole numbers |
| `prs` | up to 10 of `{ url, state: opened \| merged }` |
| `initiative`, `customer`, `team` | up to 120 characters each, hints the brain uses to relate the work to pages |
| `url` | up to 200 characters, `http(s)` link to the item; the query and fragment are dropped |
| `visibility` | `private` (the default), `team` or `org` |

## Who sees it

Private is the default, and private means private: only the person who sent an event reads it. An owner or an admin does
not, and neither does a project's admin. Every reader of the ledger follows the same rule: the usage routes, the Brain
page, Find Similar, the MCP brain tools and the Landflow Usage node.

- An event with an owner is read by its owner. An `org` event is read by everyone. A `team` event counts as private
  until teams are linked to people. For now the routes accept only `private`.
- An event with no owner (everything the platform and the flows record) keeps its project scoping.
- Work that is the instance's own to read (the study, the detectors, a flow's Landflow Usage node, the daily rollups) sees
  no private work. The rollups in `usage_daily` count only events with no owner or shared with the organization, so
  totals never include someone's private work. A workflow does not read its creator's private work either, since its
  output can reach other people.

## The routes

All need an API key with the named scope, or a session. `brain:write` includes `brain:read`. Members can make keys with
these scopes for themselves (Settings → API keys); a key with only these scopes reaches nothing else.

| Route | Scope | What it does |
|---|---|---|
| `POST /api/brain/work` | `brain:write` | `{ events: WorkEventInput[1..50] }` records the caller's own work. Answers `{ saved: [{ sourceId, id, created }], rejected: [{ sourceId, reason }] }`: an event that fails the checks is rejected with its reason and the rest are saved. The same `source` and `sourceId` again updates the event (`created: false`; the newer values win). `team` and `org` are refused for now ("Sharing comes later"). 503 when the brain is off (`DELETE` still works while it is off) |
| `DELETE /api/brain/work/:sourceId?source=<tool>` | `brain:write` | deletes the caller's own event: 204, or 404 when they have none by that source and id (someone else's is never found) |
| `GET /api/brain/briefing?day=YYYY-MM-DD` | `brain:read` | the caller's own `today` and `yesterday` (the day before `day`), newest first, at most 50 each, in the instance time zone (today by default). `related` is empty for now; `autoSend` is the admin's setting; `brain` is `on` or `off` |
| `POST /api/brain/ask` | `brain:read` | as before, now with the narrower scope (a key with `executions:read` alone no longer reaches it) |

The two scopes are labelled "Brain: read your briefing and ask" and "Brain: record your work". A briefing is built on
request from the ledger (`source: "live"`); a flow may write its own later (`source: "flow"`).

## Where the code is

`packages/protocol/src/work-events.ts` (the contract), `lib/server/brain/work.ts` (record and delete),
`lib/server/brain/briefing.ts`, `lib/server/usage/ledger.ts` (`upsertWorkEvent`), `lib/server/usage/query.ts` (the one
visibility clause) and `lib/server/brain/scope.ts`; migration 2073 adds `owner_id`, `visibility`, `source` and
`source_id` to `usage_events`, with a unique index on `(owner_id, source, source_id)`.
