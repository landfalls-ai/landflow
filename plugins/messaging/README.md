# Messaging plugin (`messaging`)

Telegram (with a polling trigger), Slack, Discord, WhatsApp Business Cloud and Send Email (SMTP) for Landflow,
written with the TypeScript SDK. Nodes follow n8n's names and resource → operation shape.

```sh
pnpm --filter @landflow/plugin-messaging start       # HTTP :7104, gRPC :7204, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-messaging test        # vitest against in-process fake APIs and a fake SMTP server
pnpm --filter @landflow/plugin-messaging typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. No npm dependencies beyond the SDK: HTTP goes through the
SDK's traced `ctx.http`, and the SMTP client is built on `node:net` / `node:tls`.

## Nodes

All action nodes are in the **Communication** category, set `usableAsTool: true` (an AI Agent can call them), read their
parameters per item and pair every output item with its input. A failure stops the node with the item index and the
service's own error text (HTTP status plus its message, never the token); the host's **On Error: Continue** setting then
keeps the flow going.

| Node (type) | Resource → operations | Notes |
|---|---|---|
| **Telegram** (`messaging.telegram`) | Message → Send Message, Send Photo / Document / Audio / Video (URL or file_id, or **Binary File**: the item's file uploaded as multipart), Edit Message Text, Delete Chat Message, Send Chat Action (typing, upload_photo…) · Chat → Get · File → Get (downloads into `item.binary`) | Additional Fields: caption, file name, parse mode, disable notification, disable link preview, reply to message ID |
| **Telegram Trigger** (`messaging.telegramTrigger`) | poll trigger, default every 30 s | "Trigger On": `*`, message, edited_message, channel_post, callback_query. See below |
| **Slack** (`messaging.slack`) | Message → Send (`chat.postMessage`: text, optional Block Kit JSON, reply in thread), Update, Delete, Get Permalink · Channel → Get Many (Return All / Limit, cursor pagination, Simplify) · User → Get by Email (`users.lookupByEmail`, Simplify) · Reaction → Add | Channel picker loads `conversations.list` live |
| **Discord** (`messaging.discord`) | Connection Type **Bot Token**: Message → Send (content, embeds JSON, TTS, reply), Get Many (Return All / Limit, paged with `before`, Simplify), Delete, React with Emoji · **Webhook**: Message → Send (content, username, avatar URL, embeds JSON) | Server and channel pickers (`/users/@me/guilds`, `/guilds/{id}/channels`). A 429 waits `retry_after` (up to 10 s) and retries once |
| **WhatsApp Business Cloud** (`messaging.whatsApp`) | Message → Send (Message Type: text, or image / document / audio / video **by URL** with caption and filename), Send Template (name, language, components JSON) | Sender phone number picker loads `/{businessAccountId}/phone_numbers` |
| **Send Email** (`messaging.emailSend`) | From, To (comma-separated, names allowed), Subject, Email Format (Text / HTML / Both), Text, HTML · Options: CC, BCC, Reply To, Ignore SSL Issues | Returns `{ messageId, accepted, rejected, response }` |

Where n8n's shape differs from a flat list, n8n wins: WhatsApp "Send Media by URL" is **Send** with a media Message Type,
Telegram's Send Chat Action is a Message operation, and Send Email's CC / BCC / Reply To sit under **Options**.

Telegram files (binary data, docs/protocol.md §11): with **Binary File** on, the send operations upload
`item.binary.<Input Binary Field>` (default `data`). The cloud Bot API takes photos up to 10 MB and other files up to 50 MB;
larger files are refused before upload unless the credential's Base URL points at a local Bot API server (2000 MB).
**File → Get** calls getFile and downloads the bytes into `item.binary.data` (the cloud API serves files up to 20 MB);
turn **Download** off for the details only. Feed it the `file_id` of a document from the Telegram Trigger.

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
- **A bot with a webhook cannot be polled**: Telegram answers 409, which the node reports as "this bot has a webhook set, so
  getUpdates is unavailable", with a pointer to `deleteWebhook`. Only one poller per bot works (also a 409).

### Send Email (SMTP client)

`src/smtp.ts` is a small client: implicit TLS (port 465) or plain + STARTTLS (587/25, unless *Disable STARTTLS*), AUTH PLAIN
or LOGIN, multi-line replies, EHLO with HELO fallback, dot-stuffing, RFC 2047 encoded headers, quoted-printable bodies,
`multipart/alternative` for "Both", a `Message-ID`, BCC only in the envelope, and CR/LF stripped from header values. Every
step has a timeout (30 s), and errors carry the server's reply code: `SMTP AUTH PLAIN rejected: 535 5.7.8 …`. No attachments yet.

## Credentials

Every type has a **Test connection** that makes one cheap authenticated call, and an overridable base URL or host so it can
point at a proxy or a test double. Tokens and passwords are `password` fields: masked in the UI and redacted from logs and spans.

| Type | Fields | Test | Getting a token |
|---|---|---|---|
| `telegramApi` | Access Token, Base URL (`https://api.telegram.org`) | `getMe` → "Authenticated as @bot" | Message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token. Add the bot to groups; users must message it first |
| `slackApi` | Access Token, Base URL (`https://slack.com/api`) | `auth.test` → team and user | api.slack.com/apps → Create App → OAuth & Permissions → bot scopes `chat:write`, `channels:read`, `groups:read`, `reactions:write`, `users:read`, `users:read.email` → Install → copy the **Bot User OAuth Token** (`xoxb-…`). Invite the bot to private channels |
| `discordBotApi` | Bot Token, Base URL (`https://discord.com/api/v10`) | `GET /users/@me` | discord.com/developers → New Application → Bot → Reset Token. Invite it with OAuth2 → URL Generator (`bot` scope; View Channels, Send Messages, Read Message History, Add Reactions, Manage Messages) |
| `discordWebhookApi` | Webhook URL (secret: it embeds its token) | `GET` the webhook URL | Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL |
| `whatsAppApi` | Access Token, Business Account ID, Base URL (`https://graph.facebook.com/v21.0`) | `GET /{businessAccountId}/phone_numbers` | developers.facebook.com → app with the WhatsApp product. API Setup shows the WhatsApp Business Account ID; create a permanent token for a System User (Business Settings) with `whatsapp_business_messaging` and `whatsapp_business_management` |
| `smtp` | User, Password, Host, Port (465), SSL/TLS (on), Disable STARTTLS, Client Host Name | connect, EHLO, (STARTTLS), AUTH, QUIT | Your provider's SMTP settings. Gmail and Outlook need an app password |

"Ignore SSL Issues" is a Send Email node option (as in n8n), so the credential test always verifies the server certificate.

## Observability

Each API call is an `HTTP {METHOD}` client span under `plugin.execute messaging.<node>`, carrying the host's trace id and
sending `traceparent` on. The Telegram token in the URL path shows up as `bot[REDACTED]`. A Discord webhook's token is redacted
too. Send Email opens an **`smtp.send`** client span (`server.address`, `server.port`, `messaging.system=smtp`,
`smtp.recipients.accepted` / `.rejected`) with one child span per phase: `smtp.connect`, `smtp.ehlo`, `smtp.starttls`, `smtp.auth`,
`smtp.envelope`, `smtp.data`, `smtp.quit`. The credential test uses `smtp.verify` the same way.

| Metric | Type | Attributes |
|---|---|---|
| `landflow.messaging.messages_sent` | counter | `service` (`telegram`/`slack`/`discord`/`whatsapp`/`email`), `operation` (`sendMessage`, `sendPhoto`, `post`, `send`, `webhookSend`, `sendTemplate`) |
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
