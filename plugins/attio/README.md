# Attio plugin

Attio (the CRM) for Landflow flows, in TypeScript. HTTP on `:7117`, gRPC on `:7217`, plugin id `attio`.

```bash
pnpm --filter @landflow/plugin-attio start      # LANDFLOW_REGISTRY_URL=off to skip announcing to the host
pnpm --filter @landflow/plugin-attio typecheck
pnpm --filter @landflow/plugin-attio test
```

Tests run against a fake Attio REST server (`test/fake-attio.ts`); no real token is used anywhere. The live test
(`test/live.test.ts`) skips unless `LANDFLOW_INTEGRATION` contains `attio` and `ATTIO_TOKEN` is set.

## Nodes

| Node | What it does |
| --- | --- |
| **Attio Trigger** (`attioTrigger`, app webhook) | Registers its own webhook in Attio when the workflow is published, removes it when unpublished, verifies every delivery, and outputs one activity item per event. |
| **Attio** (`attio`, `usableAsTool`) | Reads and writes through the REST API. No delete and no merge operation exists. |

Operations of the Attio node:

| Resource | Operation | Notes |
| --- | --- | --- |
| Record | Get | An activity item plus `text` (attribute values and up to 5 recent notes). |
| Record | Get Many Changed Since | For an object (`companies`, `people`, `deals`, a custom one). Activity items, oldest first, each with a `cursor`. |
| Record | Add to List | Creates a list entry for a record, with optional entry values (JSON). |
| List Entry | Get Many Changed Since | For a list (a sales pipeline). Same output. |
| Note | Create | A note on a record (plain text or markdown). |
| Task | Create | Plain-text task, optional deadline, linked record and assignee emails. |
| Workspace Member | Get Many | `id`, `email`, `firstName`, `lastName`, `accessLevel`, `createdAt`. |

## Trigger setup

1. Create a credential (below). Webhooks need a **workspace-level** token with `webhook:read-write`.
2. Publish the workflow. The node calls `POST /v2/webhooks` with `target_url` = the node's webhook URL and one
   subscription per chosen event, and keeps the webhook id and the **secret** in the node's static data. Attio returns
   the secret only in that create response, so it cannot be fetched again; publishing again creates a new webhook.
3. Attio requires an HTTPS target URL, so Landflow's public URL must be https (a tunnel in development). The node
   refuses an http URL with a clear message.

Events (parameter **Events**, default all six): `record.created`, `record.updated`, `list-entry.created`,
`list-entry.updated`, `note.created`, `task.created`. **Objects** (default `companies,people,deals`; empty = all)
filters records, list entries and notes by the object slug, in the node, because Attio's webhook filter documents only
`parent_object_id`-style fields. Tasks always pass.

`checkExists` asks Attio (`GET /v2/webhooks/{id}`): it is true only while the webhook exists, is not inactive, points at
this URL and the secret is stored. `delete` removes it (`DELETE /v2/webhooks/{id}`; a webhook already gone is fine).

Deliveries: `Attio-Signature` (or the legacy `X-Attio-Signature`) is the hex HMAC-SHA256 of the raw body, keyed with the
webhook secret; anything else gets 401 and starts no run. The idempotency key is the `Idempotency-Key` header (stable
across Attio's retries; a hash of the body if it is missing). Attio expects an answer within 5 seconds, and the node
fetches the record, entry, note or task before answering (payloads carry ids only); an Attio API failure answers 500 so
Attio retries.

## Activity item mapping

| Field | Value |
| --- | --- |
| `source` | `attio` |
| `sourceId` | `attio:<object slug or list slug>:<id>:<time>`; notes `attio:notes:<id>:<time>`, tasks `attio:tasks:<id>:<time>`. `<time>` is the item's `occurredAt` (millisecond ISO). |
| `occurredAt` | Records and entries: created time for `*.created`, else the newest `active_from` of any value (Attio events carry no time). Notes and tasks: `created_at`. |
| `url` | The record's `web_url`; entries and notes use their parent record's; tasks their first linked record's. |
| `actorEmail` | The event's actor when it is a workspace member (matched in `GET /v2/workspace_members`, cached), else the creator of the note or task; for listed rows the actor of the latest value change. Tokens, apps and the system give none. |
| `kind` | `work.deal_won` when the stage is a won stage and it is the latest change (or the row is new); `work.deal_moved` otherwise (also the fallback for companies and people); `work.discussion` for a note; `work.action_item` for a task. |
| `customerHint` | The company name: the record itself for companies; the Company of a person; the Associated company of a deal (and of a list entry's parent). Notes and tasks use their parent or first linked record. |
| `teamHint` | Option **Team Hint** (a constant, e.g. `Sales`), else null. |
| `initiativeHint` | Always null. |
| `summary` | `<title>. <attr: value; …>` clipped to 600 characters. |
| `raw` | Trimmed: ids, `web_url`, `created_at` and attribute values as plain text. |
| `cursor` | Only on the Get Many Changed Since operations: the item's `occurredAt`. |

Options (**Won Stages**, **Stage Attribute**, **Team Hint**) sit in the trigger's Options and the node's Options for Get
and Get Many Changed Since. Won Stages default `Won`, compared with case, emoji and punctuation ignored, so Attio's
default stage `Won 🎉` matches. Stage Attribute defaults to `stage`.

## Changed since: Attio has no "updated at"

Records and list entries carry `created_at`, and each attribute value carries `active_from` (when it got its current
value), but **no last-updated timestamp that can be filtered or sorted**. So *Changes To Look For* picks the workaround:

- **Any Value Changed** (default): reads every row (`POST .../query`, 200 per page by `limit`/`offset`), takes each row's
  newest `active_from` (or `created_at`), keeps rows after **Since**, sorts them oldest first. Complete, but one call per
  200 rows; stops after 5000 rows with a warning. A value removed without another being set is not seen.
- **Stage Changed**: a server filter `{ "<stage attr>": { "active_from": { "$gte": since } } }`, documented for status
  attributes; one cheap query for "a deal moved".
- **Created**: server filter `{ "created_at": { "$gte": since } }` for records. For list entries Attio does not document
  a `created_at` filter, so Landflow reads the entries and filters here.

Rows are sorted here, because Attio's query sort is documented for attributes, not for these timestamps. Pass the last
item's `cursor` back as **Since** (the filter is `$gte`, the check here is strictly after, so the last item is not
repeated). Attio's timestamps have nanoseconds; cursors are milliseconds.

## Credentials

- **Attio API** (`attioApi`): a workspace access token (Settings, Developers), sent as `Authorization: Bearer`. Base URL
  field (default `https://api.attio.com`) so tests can point at a fake.
- **Attio OAuth2 API** (`attioOAuth2Api`, `extends: ['oAuth2Api']`): Connect uses `https://app.attio.com/authorize` and
  `https://app.attio.com/oauth/token`, authorization code, client id and secret in the body. Create the app at
  build.attio.com, add the Landflow redirect URL on the OAuth tab, and enable scopes on its Scopes tab: Attio's authorize
  request has no scope parameter, so the credential's Scope stays empty. Attio documents no refresh token.
- **Credential test**: `GET /v2/self`. An unknown or revoked token is `200 {"active": false}`; that is reported as
  failure. Success names the workspace, token level and scopes.

Scopes per operation (from each endpoint's page): records and list entries `record_permission:read`,
`object_configuration:read`, `list_entry:read`, `list_configuration:read`; notes `note:read` (read) and `note:read-write`
(Note → Create); tasks `task:read` (the trigger fetches the task) and `task:read-write` (Task → Create, which also needs
`user_management:read`); members `user_management:read`; Add to List `list_entry:read-write` with
`list_configuration:read`; the trigger `webhook:read-write` on a workspace token. Read-only flows need no write scope.

## Limits

- No updated-at (above): "any change" is a scan. Companies and people have no stage, so their rows are
  `work.deal_moved` items by the brief's fallback; filter on `raw` or the title if that is too loose.
- A `record.updated` event does not say what changed, so the stage check is "the stage is the newest value change".
- Listed items have one lookup per distinct parent/company (cached in the call); a large scan costs extra reads.
- Rate limits: 100 reads and 25 writes per second; a 429 error includes the `Retry-After` value.
- Webhooks created with an OAuth token do not show in Attio's settings page, and a webhook that stays degraded for 7 days
  becomes inactive (then `checkExists` is false and publishing registers a new one).
- Task → Create takes plain text only (an Attio limit); Note → Create titles are plain text.
- No delete, no merge, no update of records.

## Verified against

Fetched from docs.attio.com on 2026-11-12.

| Fact | URL |
| --- | --- |
| `Attio-Signature` (and legacy `X-Attio-Signature`), hex HMAC-SHA256 of the raw body with the webhook secret; `Idempotency-Key` header; 5 s timeout, retries up to 10 times; at-least-once; HTTPS target; secret shown only on create | https://docs.attio.com/rest-api/guides/webhooks |
| `POST /v2/webhooks` body (`target_url`, `subscriptions[{event_type, filter}]`), event type list, response `data.id.webhook_id`, `data.secret`, `status`, 409 on duplicates, scope `webhook:read-write` | https://docs.attio.com/rest-api/endpoint-reference/webhooks/create-a-webhook |
| `GET /v2/webhooks/{id}` (no secret in the response, `webhook:read`), `DELETE` (200 `{}`, 404 `not_found`) | https://docs.attio.com/rest-api/endpoint-reference/webhooks/get-a-webhook and https://docs.attio.com/rest-api/endpoint-reference/webhooks/delete-a-webhook |
| Payload envelope `{ webhook_id, events: [{ event_type, id, actor }] }`, per event id fields, `parent_object_id`, `parent_record_id`, actor `{type, id}` | https://api.attio.com/openapi/webhooks |
| Base URL `https://api.attio.com`, `/v2/...` | https://docs.attio.com/rest-api/endpoint-reference/webhooks/list-webhooks (OpenAPI servers) |
| Bearer auth; OAuth `https://app.attio.com/authorize` and `/oauth/token`; scopes set in the developer console | https://docs.attio.com/rest-api/guides/authentication and https://docs.attio.com/rest-api/tutorials/connect-an-app-through-oauth |
| Authorize params (`client_id`, `response_type=code`, `redirect_uri`, `state`, `token_level`; no scope param); token params (`grant_type`, `code`, `client_id`, `client_secret`; no refresh token documented) | https://docs.attio.com/docs/oauth/authorize and https://docs.attio.com/docs/oauth/token |
| `GET /v2/self`: `active: false` for unknown tokens, `workspace_name`, `scope`, `token_level` | https://docs.attio.com/rest-api/endpoint-reference/meta/identify |
| Record query: `filter`, `sorts`, `limit` (default 500), `offset`; response `created_at`, `web_url`, `values` with `active_from`; scopes | https://docs.attio.com/rest-api/endpoint-reference/records/list-records |
| Entry query and get: `entry_values`, `parent_record_id`, `parent_object`, `created_at`; scopes | https://docs.attio.com/rest-api/endpoint-reference/entries/list-entries and https://docs.attio.com/rest-api/endpoint-reference/entries/get-a-list-entry |
| Filter operators `$gt/$gte/$lt/$lte` on timestamps and dates; every object has a filterable `created_at`; limit/offset paging | https://docs.attio.com/rest-api/guides/filtering-and-sorting, https://docs.attio.com/rest-api/attribute-types/attribute-types-timestamp, https://docs.attio.com/rest-api/guides/pagination |
| Status filter `{"stage": {"active_from": {"$gte": ...}}}`; status value `status.title` | https://docs.attio.com/rest-api/attribute-types/attribute-types-status |
| Record reference value `target_object`, `target_record_id` | https://docs.attio.com/rest-api/attribute-types/attribute-types-record-reference |
| Deal attributes `name`, `stage` (default "Won 🎉"), `owner`, `value`, `associated_company`; people `company`; companies `name` | https://docs.attio.com/docs/standard-objects/standard-objects-deals, .../standard-objects-people, .../standard-objects-companies |
| `GET /v2/objects/{object}` and `GET /v2/lists/{list}` (`api_slug`, `name`) | https://docs.attio.com/rest-api/endpoint-reference/objects/get-an-object and https://docs.attio.com/rest-api/endpoint-reference/lists/get-a-list |
| `GET /v2/workspace_members` (`email_address`, `access_level`, scope `user_management:read`) | https://docs.attio.com/rest-api/endpoint-reference/workspace-members/list-workspace-members |
| `POST /v2/notes` (`parent_object`, `parent_record_id`, `title`, `format`, `content`; `note:read-write`), `GET /v2/notes` (limit max 50), `GET /v2/notes/{id}` | https://docs.attio.com/rest-api/endpoint-reference/notes/create-a-note, .../notes/list-notes, .../notes/get-a-note |
| `POST /v2/tasks` (all of `content`, `format: plaintext`, `deadline_at`, `is_completed`, `linked_records`, `assignees` required; `task:read-write`), `GET /v2/tasks/{id}` | https://docs.attio.com/rest-api/endpoint-reference/tasks/create-a-task and .../tasks/get-a-task |
| `POST /v2/lists/{list}/entries` (`parent_record_id`, `parent_object`, `entry_values`; `list_entry:read-write`) | https://docs.attio.com/rest-api/endpoint-reference/entries/create-an-entry-add-record-to-list |
| Rate limits (100 reads, 25 writes per second), 429 with `Retry-After` | https://docs.attio.com/rest-api/guides/rate-limiting |

Not verified against a live workspace (no real token was used): whether an entries query accepts a `created_at`
filter, and the exact scope a token needs for `GET /v2/self` (the page lists none).
