# Notion as the brain

Part of the [Landflow docs](../README.md). The second brain keeps its working copy in Landflow and uses Notion as its home
(the person's decision of 2026-11-18); this page holds the sections of the Notion brain program, wave nb1. Other sections
(the store, the links and routes) are added by the packages that build them.

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
