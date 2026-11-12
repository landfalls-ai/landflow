# Linear plugin (`linear`)

Linear for flows, written with the TypeScript SDK: a **trigger** that registers its own Linear webhook, **changed-since reads** and
an **issue read** that output [activity items](../../docs/protocol.md) (§16), a **user list** with email, and three **actions**. It talks to Linear's
GraphQL API with `fetch` through the SDK's traced `ctx.http`, and answers over HTTP, gRPC, any installed broker and MCP.
**Nothing deletes, archives, closes or merges** (the only delete is the trigger removing its own webhook on unpublish).

```sh
pnpm --filter @landflow/plugin-linear start       # HTTP :7116, gRPC :7216, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-linear test        # vitest against test/fake-linear.ts, an in-memory GraphQL double
pnpm --filter @landflow/plugin-linear typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. The tests never reach linear.app. `test/live.test.ts` reads from the real
API only when `LANDFLOW_INTEGRATION` contains `linear` and `LINEAR_API_KEY` is set (use a throwaway workspace).

## Credentials

| Type | Fields | Notes |
|---|---|---|
| **Linear API** (`linearApi`) | **API Key** (secret), **Base URL** | Sent as `Authorization: <key>`, no `Bearer` |
| **Linear OAuth2 API** (`linearOAuth2Api`, extends `oAuth2Api`) | **Scopes**, **Base URL**; the host fills in the access token | Connect runs the authorization-code flow; sent as `Authorization: Bearer <token>` |

Both **Test** with a `viewer` query. Base URL defaults to `https://api.linear.app` (the endpoint is `<base>/graphql`); change it for a proxy or a test double.

**Scopes.** The OAuth2 default is `read,issues:create,comments:create`: read for every read operation, `issues:create` for Issue → Create and Add Link
(it covers attachments), `comments:create` for Comment → Create. No `write`. **The Linear Trigger needs more**: creating a webhook takes a
workspace admin's API key or the `admin` scope (add it to Scopes before Connect). `actor=app` and agent scopes are not used.

Linear access tokens last about a day and refresh tokens 30 days; the host renews the token before use.

## Node: Linear Trigger (`linear.linearTrigger`, app webhook)

Publishing the workflow registers a webhook through the API; unpublishing, changing the trigger or deleting the workflow removes it.

| Parameter | |
|---|---|
| **Team** | One team, or empty for every public team including teams created later (`allPublicTeams`) |
| **Resources** | Issue, Comment, Project Update, Project, Cycle (default: Issue, Comment, Project Update) |
| **Options** | Customer Label Prefix (default `customer:`), Signature Tolerance (default 60 s) |

- **`create`** calls `webhookCreate` with the public URL, the resource types, `teamId` or `allPublicTeams: true`, the label `Landflow` and a
  **signing secret Landflow generates** (32 random bytes, hex). The webhook id and the secret are kept in the node's static data.
- **`checkExists`** reads `webhook(id)` and is true when it is still enabled with the same URL. **`delete`** calls `webhookDelete`; a webhook already gone is not an error.
- **Each delivery** is verified before anything else: `Linear-Signature` must be the hex HMAC-SHA256 of the raw body with the stored secret
  (constant-time compare), and the body's `webhookTimestamp` (Unix ms) must be within the tolerance of now, else `401` and no run.
  A missing secret (a publish that did not complete) also rejects.
- **Answers fast.** Linear gives up after 5 s. A complete payload is mapped without calling Linear; when the payload lacks the team, project or
  labels the hints use, one read (2.5 s cap) fills them in, and a failed read leaves the hints empty rather than failing the delivery.
- **Idempotency key** is the `Linear-Delivery` header (a UUID), so a redelivery starts no second run.
- Removals (`action: remove`), resource types not selected, and Project/Cycle changes that are not a completion answer `200 {"ignored": …}` and start nothing.
- Output: one activity item per event. A manual run outputs nothing (Issue → Get Many Changed Since reads recent changes).

## Node: Linear (`linear.linear`, usable as a tool)

| Resource → Operation | What it does | Output |
|---|---|---|
| **Issue → Get Many Changed Since** | Issues with `updatedAt` after **Since**, oldest first | Activity items with `cursor` |
| **Issue → Get** | One issue by identifier (`ENG-123`) or id | Activity item plus `text`: the description, then each comment as `Name (date): body` |
| **Issue → Create** | `issueCreate`: Team, Title, Description; optional priority, assignee id, label ids, project id, status id, due date | `{id, identifier, title, url}` |
| **Issue → Add Link** | `attachmentCreate`: Issue, URL, Title (default: the URL), Subtitle. The same URL on the same issue updates that attachment | `{id, url, title, subtitle}` |
| **Comment → Create** | `commentCreate`: Issue, Comment (Markdown), optional thread root | `{id, url, body, createdAt}` |
| **Comment → Get Many Changed Since** | Comments created or edited after Since | Activity items with `cursor` |
| **Project Update → Get Many Changed Since** | Project updates posted or edited after Since | Activity items with `cursor` |
| **User → Get Many** | `users`: id, name, displayName, `email` (lowercase), active, admin, guest, team names; deactivated users only with Include Deactivated | one item per user |

**Since / cursor.** Since is an ISO 8601 time (a date alone is UTC; empty is the last 24 hours). Every item's `cursor` is its own `updatedAt`
(ISO), so the next run passes the last item's `cursor` as Since. Linear can only list **newest first** (`orderBy: updatedAt`), so the node reads
all pages (`first: 50`, `after` = `pageInfo.endCursor`, until `hasNextPage` is false, at most 5,000 records) and sorts oldest first itself. With a Limit,
the oldest N are returned, extended to the end of a run of records sharing the same `updatedAt` so the next read (`gt`) loses none. Options: **Team Key** (issues),
**Read Customer Needs** (default on), **Customer Label Prefix**.

Failures name the Linear error (`Linear API error 401: …`), never the key. A `429` (or `RATELIMITED`) waits `Retry-After` (at most 30 s) and retries twice.

## Activity item mapping

| Field | Value |
|---|---|
| `source` | `linear` |
| `sourceId` | `linear:<entity>:<id>:<updatedAt>`; entity is `issue`, `comment`, `project-update`, `project` or `cycle` |
| `url` | the record's `url`, or the webhook payload's `url` |
| `actorEmail` | webhook: the payload's `actor.email`. Reads: the issue's creator, the comment's or update's author (Linear does not say who last edited an issue). Lowercase, or null |
| `occurredAt` | `updatedAt` |
| `title` | `ENG-1: Title` for issues, `ENG-1: <first line>` for comments, `<Project> update (onTrack): <first line>` for project updates |
| `summary` | the description or body, whitespace collapsed, at most 600 characters (issue moved by a state change: `Moved to <state>. <description>`) |
| `teamHint` | the Linear team name |
| `initiativeHint` | the project name |
| `customerHint` | the customer of the issue's first customer need (`needs`), else a label `<prefix><name>` (default `customer:Acme` gives `Acme`) |
| `raw` | a short object: entity, ids, action, state, labels, priority, … |
| `cursor` | only on Changed Since output |

**`kind`** (a suggestion; a flow may change it):

| Event | Kind |
|---|---|
| New issue labelled `Bug` | `work.bug_reported` |
| New issue labelled `Feature` | `work.feature_request` |
| Issue state change, and any other issue update | `work.ticket_moved` |
| Comment | `work.discussion` |
| Project update | `work.self_update` |
| Project or cycle completed (`completedAt` set by the event) | `work.release` |

Label match is case-insensitive and by prefix (`Bug`, `Bug: UI`, `Feature`, `Feature Request`). A poll cannot see events, so it treats an issue as new when its
`updatedAt` is within 2 s of its `createdAt`; any other changed issue is `work.ticket_moved`.

## Limits

- Linear **cannot order oldest first**; the node reads all matching pages and sorts (5,000-record cap per read). Narrow with Since or Team Key for busy workspaces.
- Reads do not return who edited an issue, so `actorEmail` on a poll is the creator; the trigger has the real actor.
- Creating a webhook needs admin rights (see Scopes). Workspace-less or non-public teams need a Team picked; `allPublicTeams` covers public teams only.
- The payload shapes of Issue, Comment and Project Update events are not spelled out in Linear's docs page (only the envelope and a Comment example are); the
  mapper reads only fields it finds and enriches from the API when the team or issue details are missing. Check a real delivery before relying on `customerHint`/`teamHint` from a payload.
- Customer needs (`Issue.needs`) exist on plans with Customers; turn **Read Customer Needs** off elsewhere if the query is refused.
- Rate limits (per hour): API key 2,500 requests / 3,000,000 complexity points, OAuth app 5,000 / 2,000,000, 10,000 points per query.
- Linear disables a webhook whose URL stays unresponsive; re-enable it in Linear or republish.
- No delete, archive, close or merge operation exists, by design.

## Verified against

Fetched on 2026-11-12.

| Fact | Source |
|---|---|
| Header `Linear-Signature` = hex HMAC-SHA256 of the raw body with the webhook's signing secret; `Linear-Delivery` (UUID), `Linear-Event`, `Linear-Timestamp` headers; `webhookTimestamp` (Unix ms) in the body to be checked "within a minute"; endpoint must answer 200 within 5 s; retries after 1 minute, 1 hour, 6 hours; payload `action` (`create`/`update`/`remove`), `type`, `actor` (with `email`), `data`, `url`, `updatedFrom`, `organizationId`, `webhookId`; resource types; `webhookCreate` with `url`, `teamId` or `allPublicTeams: true`, `resourceTypes`; admin or `admin` scope required; `webhooks` query; `webhookDelete(id)` | https://linear.app/developers/webhooks |
| `WebhookCreateInput` accepts `secret` (up to 256 characters, generated when omitted), `label`, `enabled`, `teamId`, `allPublicTeams`, and `resourceTypes` (Attachment, Comment, Customer, CustomerNeed, Cycle, Document, Initiative, InitiativeUpdate, Issue, IssueLabel, IssueSLA, Project, ProjectLabel, ProjectUpdate, Reaction, Release, … case-sensitive); `Webhook.secret`; `webhook(id)` query | https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql (Linear's published GraphQL schema) |
| GraphQL endpoint `https://api.linear.app/graphql`; personal API key sent as `Authorization: <API_KEY>` with no prefix; OAuth token as `Authorization: Bearer <token>`; errors in an `errors` array, possibly with HTTP 200 | https://linear.app/developers/graphql |
| OAuth2: authorize `https://linear.app/oauth/authorize`, token `https://api.linear.app/oauth/token` (form-encoded `client_id`/`client_secret`), scopes `read`, `write`, `issues:create`, `comments:create`, `admin`; access token about 24 h; refresh token 30 days | https://linear.app/developers/oauth-2-0-authentication |
| Relay pagination `first`/`after`, `pageInfo { hasNextPage endCursor }`, 50 by default, `orderBy: updatedAt` returns the most recently updated first | https://linear.app/developers/pagination |
| Page size 1 to 250; `orderBy` is `createdAt` or `updatedAt`; `IssueFilter`/`CommentFilter`/`ProjectUpdateFilter` accept `updatedAt` with `gt`; `Issue.needs` and `CustomerNeed.customer`; `Cycle.completedAt`, `Project.completedAt`; `issueCreate`, `commentCreate`, `attachmentCreate` inputs (`issueId` accepts an identifier like `ENG-123`; attachment `title` and `url` required, the same URL on the same issue is updated); `users(includeDisabled)` with `email`, `active`, `admin`, `guest`, `teams` | the same published schema |
| Rate limits: API key 2,500 requests and 3,000,000 complexity points per hour, OAuth app 5,000 and 2,000,000, 10,000 points per query; HTTP 429 with `extensions.code` `RATELIMITED` and `Retry-After` | https://linear.app/developers/rate-limiting |
| Not documented, so handled defensively: the `data` shape of Issue and Project Update webhooks (no example on the webhooks page) | https://linear.app/developers/webhooks |
