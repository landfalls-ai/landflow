# Fathom plugin

Fathom (the AI meeting recorder, fathom.video) for Landflow flows, in TypeScript. Ports: HTTP 7118, gRPC 7218. Plugin id `fathom`.

```bash
pnpm --filter @landflow/plugin-fathom start     # LANDFLOW_REGISTRY_URL=off to run without a host
pnpm --filter @landflow/plugin-fathom test
```

Fathom's API is almost all reads, so this plugin has no write operations.

## Credential: Fathom API

| Field | |
|---|---|
| API Key | created in Fathom under Settings, API Access; sent as the `X-Api-Key` header |
| Base URL | `https://api.fathom.ai/external/v1`; change it only for a proxy or a test double |

The credential test calls `GET /teams`: it passes with a valid key and fails with the HTTP status on a bad one.

There is **no OAuth2 credential**. Fathom offers OAuth for public apps (scope `public_api`, token URL
`https://api.fathom.ai/external/v1/oauth2/token`, app registration at fathom.video/marketplace_applications/new), but its docs
publish no authorize URL (the SDK builds it), and OAuth apps cannot read summaries or transcripts through the API. Add one
when Fathom documents the authorize URL.

## Nodes

### Fathom Trigger (app webhook)

Fathom's API can create webhooks, so the trigger is `triggerSource: "appWebhook"`. Publishing the workflow calls
`POST /webhooks` with the node's published URL; unpublishing calls `DELETE /webhooks/{id}`. Fathom returns a signing secret
(`whsec_…`) once, at creation; it is kept in the node's static data and used to verify every call. Nothing to paste into Fathom.

- `create` / `delete` / `checkExists`: `checkExists` is true only while the stored URL, id, secret and the chosen includes and
  Triggered For match, so changing an option makes the host re-create the webhook. Fathom has no list-webhooks endpoint, so this
  is the node's own record. A 404 on delete counts as already gone.
- Options: Triggered For (My Recordings, Shared External Recordings, My Recordings Shared With Team, Shared Team Recordings);
  Include Summary (on), Include Action Items (on), **Include Transcript (off)**; Internal Domains; Also Output One Item per Action
  Item (needs action items, so it turns them on); Signature Tolerance (default 300 s).
- Signature: `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature` (space-delimited `v1,<base64>` values).
  The signed content is `<id>.<timestamp>.<raw body>`, HMAC-SHA256 with the base64-decoded part of the secret after `whsec_`,
  base64 output, constant-time compared against every listed value. A timestamp outside the tolerance is rejected. A failure
  answers 401 and starts no run.
- Idempotency key: the `webhook-id` (Fathom keeps it stable across resends).
- The payload is a Meeting object. The output is its activity items (below). A manual run outputs nothing.

### Fathom (actions)

| Resource | Operation | Notes |
|---|---|---|
| Meeting | Get Many Changed Since | `GET /meetings` with `created_after`, all `next_cursor` pages, strictly after Since, **oldest first**, each item has a `cursor` (the meeting's `created_at`; pass it back as Since). Since is an ISO time or a cursor; empty is the last 24 hours. Filters: Recorded By, Teams, Created Before. Return All or Limit. |
| Meeting | Get | By recording ID. An activity item plus `text` (summary, action items, transcript only with Include Transcript). |
| Recording | Get Summary, Get Transcript | `GET /recordings/{id}/summary` and `/transcript`. Get Transcript is refused unless Include Transcript is on. |
| Team | Get Many | `GET /teams` |
| Team Member | Get Many | `GET /team_members`, optional team; emails lowercased. This is the user list for most keys. |
| User | Get Many | `GET /users`; Fathom allows it for admins only (403 otherwise). |
| Meeting Type | Get Many | `GET /meeting_types` |

Operations are `usableAsTool` and marked idempotent. Meeting options: Include Transcript (off), Include Summary (on),
Internal Domains, Also Output One Item per Action Item.

## Activity item mapping (docs/protocol.md section 16)

One item per meeting; with the option, each action item follows as its own item.

| Field | Meeting | Action item |
|---|---|---|
| `source` | `fathom` | `fathom` |
| `sourceId` | `fathom:meeting:<recording_id>` | `fathom:action:<recording_id>:<n>` (n from 1, in Fathom's order) |
| `url` | `share_url` (else `url`) | the item's `recording_playback_url` (else the meeting's) |
| `actorEmail` | the recorder, lowercase | the assignee's email, else the recorder |
| `occurredAt` | `recording_start_time` (else scheduled start, else created) | the meeting's |
| `kind` | `work.meeting_notes` with a summary, else `work.meeting_held` | `work.action_item` |
| `title` | the meeting title | the description |
| `summary` | Fathom's summary with markdown stripped, at most 600 characters; with none, "Meeting with <invitees>" | the description |
| `teamHint` | the recorder's team | the assignee's team, else the recorder's |
| `customerHint` | the domain of the first invitee outside Internal Domains (empty: outside the recorder's own domain) | same |
| `raw` | trimmed: ids, times, share URL, recorder, invitees (name, email, is_external), action item count; `transcript` only with Include Transcript (then clipped by the 25-entry rule) | ids, completed, timestamp, assignee |

## Privacy

Transcripts are off everywhere by default. Only **Include Transcript** adds one: to Get's `text` and `raw`, to the list's
`raw`, or to the webhook (the trigger then asks Fathom to include it, and `raw` carries it). Without it the list and
get calls do not request `include_transcript`, and the trigger's webhook is created with `include_transcript: false`.

## Limits and gaps

- **No get-meeting-by-id endpoint.** Meeting → Get reads the meetings list (up to 100 pages) until the recording ID appears; use Options → Created Before, Recorded By or Teams to narrow it.
- **Listing order is not documented**, so Get Many Changed Since reads every page after Since and sorts here. Large backlogs cost many calls: use Limit, or a recent Since.
- Cursor and Since compare `created_at`; a meeting created in the same instant as the cursor and not yet read is skipped.
- Rate limits: 60 calls a minute; 30 for heavy calls (summaries, transcripts, `include_summary` / `include_transcript` on meetings), possibly 5 at busy times. 429s are retried (Retry-After, up to 3 times). Concurrency is 4.
- No users endpoint for ordinary keys: User → Get Many is admin-only; Team Member → Get Many is the fallback.
- Recording downloads (`POST /recordings/{id}/download`) are not wrapped: their URLs are private to the API client and expire in about a day.
- CRM matches and highlights are not requested.
- The webhook needs Landflow reachable from the internet.
- Live tests skip unless `LANDFLOW_INTEGRATION` contains `fathom` (they then need `FATHOM_API_KEY`).

## Verified against

- API base URL, `X-Api-Key` and bearer security schemes, `GET /meetings` parameters (`created_after`, `created_before`, `cursor`, `include_*`, `recorded_by[]`, `teams[]`, `meeting_type`, `calendar_invitees_domains[]`), the Meeting, ActionItem, invitee and `recorded_by` shapes, `POST /webhooks` body and response (`id`, `secret`), `DELETE /webhooks/{id}` (204), `/recordings/{id}/summary` and `/transcript`, `/teams`, `/team_members`, `/users` (admin only), `/meeting_types`: https://developers.fathom.ai/api-reference/openapi.yaml (page index: https://developers.fathom.ai/llms.txt). The `X-Api-Key` name appears only in this spec; the prose docs say only "API keys".
- Webhook headers, signed content, `whsec_` secret, `v1,` signatures, 5 minute tolerance, "API-created webhooks also appear in Settings": https://developers.fathom.ai/webhooks.md
- Payload is the Meeting object; `webhook-id` stable across resends; any 2xx acknowledges: https://developers.fathom.ai/api-reference/webhook-payloads/new-meeting-content-ready.md (and the OpenAPI spec above)
- Rate limits (60/min, heavy 30/min possibly 5, 429 with `Retry-After`): https://developers.fathom.ai/api-overview.md
- OAuth: public apps, scope `public_api`, token URL, `authorization_code` and `refresh_token` grants, one-use refresh tokens, no authorize URL given: https://developers.fathom.ai/oauth.md and https://developers.fathom.ai/sdks/oauth.md. Summaries and transcripts are unavailable to OAuth apps: OpenAPI spec above.
- Pagination: cursor in `next_cursor`; ordering is not stated: https://developers.fathom.ai/sdks/pagination.md
- Not checked against a live account: the exact `created_after` inclusivity (the plugin filters strictly after on its side) and the real error body shape.
