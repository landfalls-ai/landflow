# Notion as the brain

Part of the [Landflow docs](../README.md). A project's second brain can live in Notion: the pages, facts, practices and notes the project already has are copied to a Notion page a person owns, and what people change there is read back. This page is built wave by wave; the sections below are added by the package that builds each part. After wave nb1 nothing syncs yet (wave nb2 copies, pushes and pulls).

## How it is built

The brain's local SQL tables stay the working copy: runs, Ask, MCP and search read them synchronously, and nothing reads Notion. What changes is where a write is heard. Wave nb1's first package (NB01) adds a seam with three parts, and no screen changes.

- **One store per project.** `brainStoreFor(projectId)` (`apps/web/src/lib/server/brain/store/port.ts`; import `@/lib/server/brain/store`, not the port) answers a `BrainStore` (`lib/shared/brain-store.ts`). With no project, no resolver or a project the resolver calls `local`, it is the **local store** (`store/local.ts`): the existing functions (`upsertEntity`, `deleteEntity`, `addEntityFact`, `draftPractice`, `personAdd`), unchanged, with the origin passed through. A project whose resolver says `notion` (the Notion links register one, NB03) gets a store that reports `backend: 'notion'`; until a Notion store is registered (NB04) its writes are the local writes. A resolver that throws is logged and the project is local. The slot is a `singleton('brain-store')`.
- **A change feed every write goes through.** After a write is stored, the writer calls `emitBrainChange({ kind, key, projectId?, op, origin, by?, version?, at })`. `onBrainChange(listener)` hears it; listeners run in a microtask, one after the other, and one that throws is logged (kind and key, never text) without failing the write or stopping the next. A write that threw emits nothing, and nothing is emitted inside a transaction that may still throw. The writers, each marked `// NB01:`: `upsertEntity` and `deleteEntity` (`entity`; a delete also emits `fact` deletes and a `summary` delete), `upsertFact` (`fact`; `addEntityFact` calls it, so one change), `deleteFact` and `staleFactsBefore` (one per fact), `writeSummary` (`summary`), `draftPractice`, `markApproved`, `markRejected` and `markRetired` (`practice`, with the `version`), and the notebook **store**'s `insert`, `patch`, `delete`, `expire` and `deleteTeam` (`note`), which catches every notebook writer.
- **Who made it.** `changeOrigin(explicit?)` (`store/origin.ts`): an explicit `notion` (the puller, NB05) wins; else `person`, with the user's id, for a signed-in session (`via: 'session'` or `'test'`); else `landflow` (an API key, MCP, a flow, the study, the loop). It never trusts a name a caller sends.

### What comes from Notion is untrusted

- A practice drafted with `source: 'notion'` is **tainted** (like `learned` and `agent`) and may be drafted **at project level only**; an org practice is refused with 403, and approving it needs `reviewedSources: true` (409 `PracticeNeedsReview`). No route accepts `notion` from a caller: `routeOrigin` never returns it.
- A note added with origin `notion` is `unverified` and `tainted`, with `source: { tool: 'notion', url }`; it cannot be promoted until a person verifies it.
- A fact pulled from Notion carries an evidence item labelled `Notion` (`NOTION_EVIDENCE_LABEL`) whose `href` is the page's URL; a fact has no `source` field.

Tests: `apps/web/test/brain-store-nb01.test.ts`.

## How Landflow talks to Notion

One client in the host (`apps/web/src/lib/server/notion/client.ts`) makes every Notion call the brain's sync needs. It is
reached through `notionClientFor({ credentialId })` (the slot and the shapes are in `notion/port.ts`); `runtime.ts` loads
it. It never calls `api.notion.com` from a test: the only Notion a test talks to is the local fake
(`apps/web/test/fake-notion.ts`, [development.md](../development.md#the-notion-fake)).

- **The key.** The credential is of type `productivity.notionApi` (field `apiKey`) or `productivity.notionOAuth2Api`
  (`accessToken`); `baseUrl` on it is honoured (default `https://api.notion.com`; a test points it at the fake). The key is read
  from the vault right before each request and is kept nowhere else. No message, span attribute, log line or write-log line holds
  it, and none holds page text. Requests go through the guarded fetch, so `LANDFLOW_OUTBOUND_ALLOW` and the production profile's
  private-address block apply.
- **Version and Markdown.** Every request carries `Notion-Version: 2026-03-11`. Every Markdown call sends
  `markdown_version: "v2"` (a query parameter on a read, a body field on an update and on a page create with `markdown`). A page
  read follows `unknown_block_ids` (up to 20 more reads) and keeps `truncated` when Notion cut the text or the cap was reached.
  A database is created with `initial_data_source.properties`, then its data source is read, because the create answer carries no
  property ids. Lists are followed by `next_cursor` while `has_more`, never by counting; a data source query's `request_status` is
  returned as it came (`incomplete` past 10,000 results).
- **Limits.** One token bucket per credential id, shared by every link that uses the key: the rate is the highest `rps` any of
  them asked for (2 by default, at most 8), burst 3, and data source queries also take from their own bucket (at most 2.5 a
  second). Five 429s in a row halve the rate for ten minutes. Rich text is split at 2,000 characters a run, at most 100 runs
  (beyond that cut with "…"); a page body is cut at a heading before about 4,500 blocks or 450 KB and ends with "Cut here: the
  rest is in Landflow".
- **Errors and retries.** 429 and 529 wait `Retry-After` (or `additional_data.retry_after`, at most 120 s) and go again;
  429 `public_api_request_blocked` is `blocked` and is never retried. 500 backs off with jitter from 1 s to 5 min, at most 6
  tries in one call, then the caller's outbox reschedules; a read that gets 503 or 504 is treated alike. A 503 (or 504) on a
  write is not retried, because it may have landed: the error says `mayHaveLanded`, and the caller re-reads first. 409 is
  `conflict` (the caller re-reads, then retries once). 400, 401, 403 and 404 are `invalid`, `unauthorized`, `forbidden` and
  `notFound`, and are not retried; no answer is `network`. Every error is a `NotionError` with its kind, status and Notion's `code`.
- **The write scope.** `scopedWriter(client, { rootId, ownIds, ownDataSources })` wraps a client: a page may be created only under
  the root, an own page or an own data source, a database only under the root or an own page, and an update or a move to trash
  only of an own page or data source. Anything else throws a `NotionError` of kind `outsideRoot` before a request is sent and logs
  `[notion-brain] refused write <id>` (the id only). Reads are not limited by it.
- **The write log.** With `LANDFLOW_NOTION_WRITE_LOG=<file>` set, every write appends one JSON line
  `{ at, method, pathTemplate, targetId, parentId }`: ids only, never a body or a header. It is a test and live-check aid
  ([configuration.md](../reference/configuration.md)).

## Setting it up

One project links to one Notion page, with a Notion API credential the project may use. The credential is the existing
`productivity.notionApi` one (a `productivity.notionOAuth2Api` credential works too); no key leaves the vault, and no
response, audit row or log line holds it. The Notion integration must be added to the page first (in Notion: ••• → Add
connections → the integration), which gives it access to the page and everything under it.

| Route | Who | What |
|---|---|---|
| `GET /api/projects/:id/brain/notion` | project members (an API key needs `brain:read`) | `{ linked: false, canManage }`, or the link: status, credential (id and name), the page, the copy's progress, what waits, open problems |
| `POST …/check` `{ credentialId, page }` | project admins | reads the page and writes nothing: its title, whether a "Landflow brain" page is already under it, what a copy of this project would send (pages, facts, practices, project-scope notes) and about how many minutes it takes |
| `POST /api/projects/:id/brain/notion` `{ credentialId, page, knowledgeScope?, rps? }` | project admins | checks again, then makes the link in `setting_up` and answers 202 |
| `PATCH` the same | project admins | `paused`, `rps` (1 to 8 requests a second, 2 by default), `knowledgeScope` (`brain`, the default: company pages under "Landflow brain" only, or `root`) |
| `DELETE` the same | project admins | disconnects: the link is kept as `unlinked` for the history, nothing is sent to Notion, which keeps what is there, and the local brain is unchanged. The project can be linked again |
| `POST …/sync` | project admins | makes the next sync due at once (202) |
| `GET …/problems` | project members | the open sync problems: kind, Landflow's words about it, the actions it offers |
| `POST …/problems/:problemId` `{ action }` | project editors; `repair` and `deleteLocal` need an admin | `dismiss` records who and when; `putBack`, `deleteLocal`, `keepAsFact` and `repair` answer 409 "Not available yet" until the pull (wave nb2) performs them; an action the problem's kind does not offer is 400 |

`page` is a Notion link, a 32-hex id or a dashed UUID. The check answers 400 for a link to another host, a credential of
another type or a key Notion refuses, 403 for a credential the project may not use (share it with the project first), 404
"Landflow can't see this page" (with the connection to add) for a page not shared with the key, and 409 when another
project holds that page. One project has one active link and one page belongs to one project; disconnecting frees both.

A link whose project is deleted stays in the table and reads as unlinked: nothing is sent to Notion, which keeps what is there.

`LANDFLOW_NOTION_BRAIN=off` switches the whole feature off: every project's brain stays local, links read as *paused*, the
check, link, change and sync routes answer 409 "The Notion brain is switched off on this instance" and nothing calls Notion
(disconnecting still works). The tables are `notion_brain_links`, `notion_brain_items`, `notion_brain_outbox`,
`notion_brain_problems` and `notion_knowledge_docs` (migrations 2908 to 2911). A project with a link that is not `unlinked`
resolves to the `notion` backend in `brainStoreFor`; until the Notion store ships it reads and writes exactly like the local one.
