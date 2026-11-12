# Messaging plugin (`messaging`)

Telegram (with a polling trigger), Slack (with an Events API trigger), Discord, WhatsApp Business Cloud, Twilio (SMS, MMS, WhatsApp, calls) and Send Email
(SMTP) for Landflow, written with the TypeScript SDK. It is the pilot for the transport layer (docs/transports.md): the same
plugin answers over HTTP, gRPC, any installed broker and MCP. Nodes follow n8n's names and resource → operation shape.

```sh
pnpm --filter @landflow/plugin-messaging start       # HTTP :7104, gRPC :7204, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-messaging test        # vitest against in-process fake APIs and a fake SMTP server
pnpm --filter @landflow/plugin-messaging typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. Dependencies are the SDK and `@landflow/transports` (the broker
drivers); HTTP goes through the SDK's traced `ctx.http`, and the SMTP client is built on `node:net` / `node:tls`.

## Nodes

All action nodes are in the **Communication** category, set `usableAsTool: true` (an AI Agent can call them), read their
parameters per item and pair every output item with its input. A failure stops the node with the item index and the
service's own error text (HTTP status plus its message, never the token); the host's **On Error: Continue** setting then
keeps the flow going.

| Node (type) | Resource → operations | Notes |
|---|---|---|
| **Telegram** (`messaging.telegram`) | Message → Send Message, Send Photo / Document / Audio / Video (URL or file_id, or **Binary File**: the item's file uploaded as multipart), Edit Message Text, Delete Chat Message, Send Chat Action (typing, upload_photo…) · Chat → Get · File → Get (downloads into `item.binary`) | Additional Fields: caption, file name, parse mode, disable notification, disable link preview, reply to message ID |
| **Telegram Trigger** (`messaging.telegramTrigger`) | poll trigger, default every 30 s | "Trigger On": `*`, message, edited_message, channel_post, callback_query; **Download Files** puts an incoming photo / document / audio / video / voice into `item.binary.data`. See below |
| **Slack** (`messaging.slack`) | Message → Send (`chat.postMessage`: text, optional Block Kit JSON, reply in thread), Update, Delete, Get Permalink, **Get Many Since** and **Get** (activity items, see [Slack activity](#slack-activity)) · Channel → Get Many (Return All / Limit, cursor pagination, Simplify, **Name Patterns** such as `customer-*`) · User → Get by Email (`users.lookupByEmail`, Simplify), **Get Many** (`users.list` with email and title; bots and deactivated members only when asked) · Reaction → Add · File → Upload (an item file via `files.getUploadURLExternal` and `files.completeUploadExternal`, shared in a channel or thread with a title and message), Get (`files.info`, downloading `url_private_download` into item.binary) | Channel picker loads `conversations.list` live |
| **Slack Trigger** (`messaging.slackTrigger`) | app webhook trigger (docs/protocol.md §12), Events API | Events (multi-select: message, app_mention, reaction_added / removed, channel_created / rename, member_joined_channel, file_shared / public, team_join, user_change, link_shared, app_home_opened, or Any Event); filters Watch Whole Workspace / Channel(s), **Channel Name Filter** (`customer-*`), Ignore Bot Messages, Ignore Message Edits and Deletes. See [Slack Trigger](#slack-trigger) |
| **Slack Activity Trigger** (`messaging.slackActivityTrigger`) | app webhook trigger, Events API | A message posted in a channel whose name matches **Channel Names**, as an [activity item](../../docs/protocol.md#16-activity-items). See [Slack activity](#slack-activity) |
| **Discord** (`messaging.discord`) | Connection Type **Bot Token**: Message → Send (content, embeds JSON, TTS, reply), Get Many (Return All / Limit, paged with `before`, Simplify), Delete, React with Emoji · **Webhook**: Message → Send (content, username, avatar URL, embeds JSON) · both: option **Attachments** uploads item files with the message (`multipart/form-data`: `payload_json` + `files[n]`, up to 10) | Server and channel pickers (`/users/@me/guilds`, `/guilds/{id}/channels`). A 429 waits `retry_after` (up to 10 s) and retries once |
| **WhatsApp Business Cloud** (`messaging.whatsApp`) | Message → Send (Message Type: text, or image / document / audio / video with caption and filename; Media Source **URL**, **Binary File** (uploaded to `/{phone-number-id}/media`, then sent by ID) or **Media ID**), Send Template (name, language, components JSON) · Media → Upload (item file → media ID), Get (media ID → temporary URL → bytes into `item.binary`; Download off: details only) | Sender phone number picker loads `/{businessAccountId}/phone_numbers` |
| **Twilio** (`messaging.twilio`) | Message → Send SMS, Send MMS (media URLs), Send WhatsApp (`whatsapp:` is added to From and To), Get, List (To, From, date sent; paged by `next_page_uri`) · Call → Make (inline TwiML or a TwiML URL), Get, List (To, From, status, start time) · Message → Get Media (the files of a received MMS / WhatsApp message into `item.binary`, one item per file) · Recording → Download (MP3 or WAV into `item.binary`), List (optionally of one call) | Bodies go up form-encoded. From may be a number or a Messaging Service SID (`MG…`). Errors keep Twilio's code (`Twilio API error 400 (code 21211): …`) with a hint for common ones. A 429 waits `Retry-After` (up to 10 s, never past the call's deadline) and retries once. See [Twilio](#twilio) |
| **Send Email** (`messaging.emailSend`) | From, To (comma-separated, names allowed), Subject, Email Format (Text / HTML / Both), Text, HTML · Options: CC, BCC, Reply To, **Attachments** (comma-separated binary property names), **Inline Files** (binary properties embedded in the HTML as `cid:<property>`), Ignore SSL Issues | Returns `{ messageId, accepted, rejected, response }` |

Where n8n's shape differs from a flat list, n8n wins: WhatsApp "Send Media" is **Send** with a media Message Type,
Telegram's Send Chat Action is a Message operation, and Send Email's CC / BCC / Reply To sit under **Options**.

Telegram files (binary data, docs/protocol.md §11): with **Binary File** on, the send operations upload
`item.binary.<Input Binary Field>` (default `data`). The cloud Bot API takes photos up to 10 MB and other files up to 50 MB;
larger files are refused before upload unless the credential's Base URL points at a local Bot API server (2000 MB).
**File → Get** calls getFile and downloads the bytes into `item.binary.data` (the cloud API serves files up to 20 MB);
turn **Download** off for the details only. Feed it the `file_id` of a document from the Telegram Trigger.

Other files (all use `item.binary`, docs/protocol.md §11; a property that the item lacks fails with its name and the files it has):
- **Discord** *Attachments* (bot and webhook): comma-separated binary properties, sent as `files[n]` with an `attachments` entry per file; a message may then have no text.
- **WhatsApp**: *Binary File* uploads with `POST /{phone-number-id}/media` (images up to 5 MB, audio and video 16 MB, documents 100 MB, per Meta) and sends by the returned ID, defaulting the document's file name to the file's. **Media → Get** reads the `url` from `GET /{media-id}` and downloads it with the access token; media IDs live 30 days and the URL 5 minutes. Feed it `messages[].image.id` (and `document`, `audio`, `video`, `sticker`) from an incoming-message webhook.
- **Twilio** takes MMS media by URL only (the API has no upload), so sending is unchanged. Received media and recordings are files: **Message → Get Media** lists `/Messages/{sid}/Media.json` and downloads each file (Twilio redirects to a CDN; the credentials are not sent there), **Recording → Download** fetches `/Recordings/{sid}.mp3|.wav`.

### Slack Trigger

An app webhook trigger: Slack calls Landflow's `/api/webhook/app/<workflowId>/<nodeId>` URL (public; the node verifies the caller).
Slack has **no API to register an Events subscription**, so setup has one manual step:

1. Create the Slack app, add the bot scopes for the events you want (`app_mentions:read`, `channels:history`, `groups:history`,
   `im:history`, `mpim:history`, `reactions:read`, `files:read`, …) and install it. Use a **Slack API** (bot token) or **Slack OAuth2**
   credential (Connect; the bot token and the token's team are used) and fill in its **Signing Secret** (Basic Information): both
   credential types have the field, and the trigger refuses to publish without it.
2. Publish the workflow. `create` calls `auth.test` (a bad token fails here, with the base URL of the credential), stores
   `{url, teamId, botUserId, team}` in the node's static data and returns; `checkExists` is true while the stored URL is the current one;
   `delete` clears it. Landflow cannot subscribe for you.
3. Copy the node's **Request URL** from the editor's Publish menu (App webhooks) into the app's **Event Subscriptions**, turn Enable
   Events on (Slack sends a signed `url_verification` call, answered with its `challenge`) and subscribe to the bot events you picked.

Each call is verified with `verifySlackSignature` (`X-Slack-Signature` + `X-Slack-Request-Timestamp`, option **Signature Tolerance**,
default 300 s); a missing, wrong or stale signature, or a credential without a signing secret, gets **401**. After that: `url_verification`
is answered before any filter; `event_callback` events pass the **Events** selection (a message that mentions the bot is both `message` and
`app_mention`: select one), **Ignore Message Edits and Deletes** (default on: `message_changed`, `message_deleted`), **Ignore Bot Messages**
(default on: `bot_id`, subtype `bot_message`, the app's own user), and, unless **Watch Whole Workspace** (default on) is on, **Channel(s)** (IDs,
comma-separated; matched against `event.channel`, `event.item.channel`, `event.channel.id`, `event.channel_id`) and the **Channel Name Filter**
(patterns; the channel's name is looked up with `conversations.info`, needs `channels:read`, and kept six hours in the static data). Everything else is answered
`200 {"ignored": …}` so Slack does not retry. The idempotency key is the `event_id`: Slack's retries (`X-Slack-Retry-Num`, sent when
it saw no answer within 3 s) start no second run.

Item: `{eventId, eventTime, teamId, apiAppId, type, event, authorizations, channel, user, text, ts, threadTs, raw}` (`raw` is the whole
envelope, `event` the inner event; `ts` is the event's own timestamp, a reaction's message `ts` for reactions). A manual run outputs nothing.

### Slack activity

Slack messages as [activity items](../../docs/protocol.md#16-activity-items) (`source: slack`), so a flow can take them the same way as
Google Drive, Calendar or Notion changes:

- `sourceId` is `slack:<team>:<channel>:<ts>`; `url` the permalink (built from the workspace URL `auth.test` gives, a reply with its
  `thread_ts`); `actorEmail` the author's email (`users.info`, needs `users:read` and `users:read.email`; looked up once per person);
  `kind` is `work.discussion`; `title` is `#channel: first line`; `summary` the text with Slack markup made readable, at most 600 characters.
- Hints come from the channel's name: **Customer Channel Prefix** (default `customer-`: `#customer-acme` gives `customerHint: acme`),
  **Initiative Channel Prefix** (e.g. `proj-`) and **Team Map** (`eng-*=R&D`, one per line, first match).
- Joins, topic changes, pins, edits and deletions are skipped; so are bots unless **Include Bot Messages** is on (the app's own never count).
- Private channels, group DMs and DMs are left out unless **Include Private Channels and DMs** is on (and the app has `groups:history`,
  `mpim:history`, `im:history`).

**Slack Activity Trigger.** Same setup as the [Slack Trigger](#slack-trigger) (Signing Secret, publish, paste the Request URL), subscribed
to the `message.channels` bot event (plus `message.groups`, `message.mpim`, `message.im` for private ones). A message in a channel whose
name matches **Channel Names** (patterns; `*` is every channel the app is in) starts a run with one activity item; **Include Thread
Replies** is on by default. The signature is checked as above (bad or stale: 401), `url_verification` answered, the `event_id` is the
idempotency key, and channel names and emails are cached six hours in the static data. A manual run outputs nothing.

**Message → Get Many Since** is the catch-up and backfill path: the messages posted after **Since** (an ISO time or a Slack timestamp;
empty: the last 24 hours) in the channels matching **Channel Names** (or **Channel IDs Instead**), oldest first, each with
`cursor` = its `ts`. Pass the last item's `cursor` back as Since to continue. It pages `conversations.history` (200 per call) and,
with **Include Thread Replies**, `conversations.replies` for threads with new replies; a 429 waits `Retry-After` (at most 30 s) and retries.
Channels the app is not in are skipped and named in the log (invite it with `/invite`). **Message → Get** returns one message (a thread
reply too) by channel and `ts` as an activity item with its full `text`.

**Rate limits.** Since 29 May 2025 Slack limits `conversations.history` and `conversations.replies` for apps installed from outside
the Marketplace to one call a minute and 15 messages per call; apps a workspace builds for itself (internal apps) keep the normal
limits ([Slack changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)). Create your own
internal Slack app for these operations.

### Telegram Trigger

It polls [`getUpdates`](https://core.telegram.org/bots/api#getupdates) (`timeout=0`) instead of registering a webhook, so it
works without a public URL. Poll state is `{ offset }`, the last `update_id` + 1; passing it confirms older updates to Telegram.

- **First poll**: `getUpdates?offset=-1` returns only the newest update. Its id becomes the baseline; nothing is emitted, so
  activating a workflow does not replay history.
- **Later polls**: every update since the offset, oldest first (up to 10 pages of 100 per poll), filtered by "Trigger On".
- **Execute in the editor** (`mode: manual`): `getUpdates` *without* an offset, so nothing is confirmed, returning up to 5 of the
  latest matching updates. State is unchanged. Updates a running poll has already confirmed are gone from Telegram.
- Each item is the raw update plus `update_id`, `update_type`, `message`, `chat`, `from` and `text` (the message text or caption;
  for a callback query, the button's data).
- **Download Files** (off by default): for a message with a photo (largest size), document, video, audio, voice, video note,
  animation or sticker, the file goes to `item.binary.data` and `file_type` names its kind. Files over 20 MB (the cloud Bot API
  limit) or no longer available leave the update intact with `file_error` instead of failing the poll.
- **A bot with a webhook cannot be polled**: Telegram answers 409, which the node reports as "this bot has a webhook set, so
  getUpdates is unavailable", with a pointer to `deleteWebhook`. Only one poller per bot works (also a 409).

### Send Email (SMTP client)

`src/smtp.ts` is a small client: implicit TLS (port 465) or plain + STARTTLS (587/25, unless *Disable STARTTLS*), AUTH PLAIN
or LOGIN, multi-line replies, EHLO with HELO fallback, dot-stuffing, RFC 2047 encoded headers, quoted-printable bodies,
`multipart/alternative` for "Both", attachments (base64, `multipart/mixed`; inline files with a `Content-ID` in `multipart/related`), a `Message-ID`, BCC only in the envelope, and CR/LF stripped from header values. Every
step has a timeout (30 s), and errors carry the server's reply code: `SMTP AUTH PLAIN rejected: 535 5.7.8 …`. No pipelining or DSN.

## Credentials

Every type has a **Test connection** that makes one cheap authenticated call, and an overridable base URL or host so it can
point at a proxy or a test double. Tokens and passwords are `password` fields: masked in the UI and redacted from logs and spans.

| Type | Fields | Test | Getting a token |
|---|---|---|---|
| `telegramApi` | Access Token, Base URL (`https://api.telegram.org`) | `getMe` → "Authenticated as @bot" | Message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token. Add the bot to groups; users must message it first |
| `slackApi` | Access Token, Base URL (`https://slack.com/api`) | `auth.test` → team and user | api.slack.com/apps → Create App → OAuth & Permissions → bot scopes `chat:write`, `channels:read`, `groups:read`, `reactions:write`, `users:read`, `users:read.email` (plus `files:write` and `files:read` for files) → Install → copy the **Bot User OAuth Token** (`xoxb-…`). Invite the bot to private channels |
| `slackOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, Bot Scopes (comma-separated, default `chat:write,channels:read,channels:history,groups:read,reactions:write,users:read,users:read.email,files:write,files:read`; `channels:history` was added for the activity operations, so an app connected before needs reinstalling), Base URL, Signing Secret; URLs fixed to Slack's v2 OAuth, authorization code | `auth.test` → team and user | Create the app at api.slack.com/apps, add the redirect URL the dialog shows under OAuth & Permissions → Redirect URLs, then **Connect**. The bot token (`xoxb-…`) is stored by the host and renewed when token rotation is on. Nodes only get the `accessToken`, not the rest of Slack's token response: the **Slack Trigger** reads the team and the bot user with `auth.test`. For the trigger also set the Signing Secret and paste its Request URL (`{public URL}/api/webhook/app/<workflow id>/<node id>`, shown in the Publish menu) into Event Subscriptions |
| `discordBotApi` | Bot Token, Base URL (`https://discord.com/api/v10`) | `GET /users/@me` | discord.com/developers → New Application → Bot → Reset Token. Invite it with OAuth2 → URL Generator (`bot` scope; View Channels, Send Messages, Read Message History, Add Reactions, Manage Messages) |
| `discordOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, Scope (`identify guilds`), optional Bot Token, Base URL; URLs fixed to Discord's, PKCE | `GET /users/@me` | Add the redirect URL under OAuth2 in your application, then **Connect**. Discord only lets bots post to channels: enter the Bot Token for message operations, otherwise the access token is sent as a Bearer (enough for the Guilds list) |
| `discordWebhookApi` | Webhook URL (secret: it embeds its token) | `GET` the webhook URL | Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL |
| `whatsAppApi` | Access Token, Business Account ID, Base URL (`https://graph.facebook.com/v21.0`) | `GET /{businessAccountId}/phone_numbers` | developers.facebook.com → app with the WhatsApp product. API Setup shows the WhatsApp Business Account ID; create a permanent token for a System User (Business Settings) with `whatsapp_business_messaging` and `whatsapp_business_management` |
| `twilioApi` | Authentication (Auth Token or API Key), Account SID, Auth Token, or API Key SID and Secret, Base URL (`https://api.twilio.com`) | `GET /2010-04-01/Accounts/{sid}.json` → account name and status | console.twilio.com → Account Info: Account SID and Auth Token. Or Account → API keys & tokens → Create API key (the secret is shown once); the Account SID is still needed for the path |
| `smtp` | User, Password, Host, Port (465), SSL/TLS (on), Disable STARTTLS, Client Host Name | connect, EHLO, (STARTTLS), AUTH, QUIT | Your provider's SMTP settings. Gmail and Outlook need an app password |

**OAuth2 variants.** `slackOAuth2Api` and `discordOAuth2Api` extend the host's generic OAuth2 type (docs/protocol.md §7): the dialog
shows **Connect**, the host refreshes the token before it expires and, when a node fails with a 401-like error, renews it and runs the
node again (Slack's `invalid_auth` and `token_expired` answers are worded so the host recognises them). The Slack node has an
**Authentication** switch (Access Token, the default, or OAuth2); the Discord node's **Connection Type** adds OAuth2 next to Bot Token
and Webhook. Both nodes take whichever of the two credentials is set when the switch names the other, and read `accessToken` on every
call without caching it (`pickCredentials` in `src/shared.ts`). Telegram, WhatsApp Cloud, Twilio and SMTP have no OAuth2 for their APIs.

"Ignore SSL Issues" is a Send Email node option (as in n8n), so the credential test always verifies the server certificate.

## Twilio

Sends and calls are `idempotent: false`: over a broker they are delivered at most once, so an SMS never goes out twice. Get and List
are `idempotent: true` (at least once is fine). The credential's Base URL points the node at a test double.

**Fake Twilio for local use.** `test/fake-twilio.ts` is a small Twilio REST server (Basic auth, form bodies, `SM…` / `CA…` SIDs,
paging, Twilio-shaped errors). It talks to nothing outside your machine.

```sh
pnpm --filter @landflow/plugin-messaging fake-twilio --port 7560 --write-env /tmp/twilio.env --delay-ms 400   # prints the fake SID and token, writes them to the env file
# credential: Authentication = Auth Token, Account SID / Auth Token from the env file, Base URL = http://127.0.0.1:7560
curl http://127.0.0.1:7560/__fake/requests                                        # every request received (auth header removed)
curl -X POST http://127.0.0.1:7560/__fake/fail -d '{"status":429,"retryAfter":1}'  # fail the next request(s)
```

## Transports

By default the plugin serves HTTP and gRPC and announces both to the host. To add a broker, name its kind in `LANDFLOW_TRANSPORTS`
and give the connection URL (the host needs a matching connection under Settings → Transports):

```sh
LANDFLOW_TRANSPORTS=http,grpc,kafka LANDFLOW_KAFKA_URL=kafka://127.0.0.1:59092 LANDFLOW_TRANSPORT_SECRET=… pnpm --filter @landflow/plugin-messaging start
```

Kinds are those of `@landflow/transports` (`kafka`, `amqp`, `nats`, `jetstream`, `valkey`, `mqtt`, `amqp1`, `pulsar`, `sqs`, `pubsub`,
`servicebus`); each reads `LANDFLOW_<KIND>_URL`. Over a broker, calls are encrypted and signed with the transport secret
(`LANDFLOW_TRANSPORT_SECRET`, the same value as the host's). The Plugins page then lists the plugin over every face, on **Auto**
unless an admin pins it: editor test runs go over gRPC, and a campaign spills over to the broker when gRPC is full.

**`maxConcurrency`** is how many calls run node code at once across all faces (HTTP, gRPC and every broker share one limit).
The default is **16** (`DEFAULT_MAX_CONCURRENCY` in `src/main.ts`), Twilio's default API concurrency per account, so one replica
doesn't hit Twilio's 429s on its own; more replicas (a consumer group on a broker) add capacity. `LANDFLOW_MAX_CONCURRENCY`
overrides it (2 shows spill-over with a handful of calls). As many calls again wait for a slot; beyond that HTTP answers 429 and
gRPC `RESOURCE_EXHAUSTED` (`capacity`), which Auto handles by moving the call. Broker faces just wait.

## MCP

Every operation is also an MCP tool on `http://127.0.0.1:7104/mcp`: `twilio_message_send`, `twilio_message_sendMms`,
`twilio_message_sendWhatsApp`, `twilio_message_get`, `twilio_message_list`, `twilio_call_make`, `twilio_call_get`, `twilio_call_list`,
and one tool per operation of the other nodes (`telegram_message_sendMessage`…). A tool is named `<node>_<resource>_<operation>` (the
node segment is dropped only when the node is named after the plugin), and the MCP gateway prefixes the plugin id
(`messaging_twilio_message_send`). Sends carry `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`,
`openWorldHint: true`. Through the host (`/api/mcp/plugins/messaging`) or the gateway, credentials come from the caller's grant.
The face listens on loopback with no token; on any other host set `LANDFLOW_MCP_TOKEN` (clients send it as a bearer) or `LANDFLOW_MCP=off`.

Without Landflow, as a local MCP server over stdio, with credentials from a file or inline JSON:

```sh
echo '{"twilioApi":{"authType":"authToken","accountSid":"AC…","authToken":"…","baseUrl":"http://127.0.0.1:7560"}}' > creds.json
LANDFLOW_MCP_CREDENTIALS=creds.json pnpm --filter @landflow/plugin-messaging start --mcp-stdio
```

## Observability

Each API call is an `HTTP {METHOD}` client span under `plugin.execute messaging.<node>`, carrying the host's trace id and
sending `traceparent` on. The Telegram token in the URL path shows up as `bot[REDACTED]`. A Discord webhook's token is redacted
too. Send Email opens an **`smtp.send`** client span (`server.address`, `server.port`, `messaging.system=smtp`,
`smtp.recipients.accepted` / `.rejected`) with one child span per phase: `smtp.connect`, `smtp.ehlo`, `smtp.starttls`, `smtp.auth`,
`smtp.envelope`, `smtp.data`, `smtp.quit`. The credential test uses `smtp.verify` the same way.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.messaging.messages_sent` | counter | `service` (`telegram`/`slack`/`discord`/`whatsapp`/`twilio`/`email`), `operation` (`sendMessage`, `sendPhoto`, `post`, `upload`, `send`, `webhookSend`, `sendTemplate`) |
| `landflow.messaging.api_errors` | counter | `service`, `status_class`: `4xx`/`5xx` from the HTTP status or SMTP reply code (Slack's HTTP-200 `ok: false` counts as `4xx`, or `5xx` for `internal_error`/`fatal_error`…), or `network`/`timeout`/`tls`/`protocol` when there was no usable answer |
| `landflow.messaging.poll.updates` | counter | `service="telegram"`: new updates the trigger emitted |

The SDK adds `landflow.plugin.id`, `landflow.node.type` and `landflow.workflow.id`. Prometheus names on `GET :7104/metrics`:
`landflow_messaging_messages_sent_total`, `landflow_messaging_api_errors_total`, `landflow_messaging_poll_updates_total`.

## Layout

```
src/main.ts                 definePlugin + serve (ports 7104 / 7204)
src/shared.ts               metrics, API error mapping, per-item helper, smtp client span
src/smtp.ts                 SMTP client and MIME message builder
src/nodes/*.ts              one file per service, with its credential type(s)
icons/*.svg                 original icons in each brand colour
test/                       fake HTTP APIs, a fake SMTP server (STARTTLS / implicit TLS with a node:crypto self-signed cert)
```
