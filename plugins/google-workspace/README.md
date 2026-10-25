# Google Workspace plugin (`google`)

Google Sheets and Gmail (each with a polling trigger), Google Drive, Google Calendar and Google Docs for Landflow,
written with the Go SDK. Nodes follow n8n's names and resource → operation shape. The plugin calls the Google REST APIs
directly, with no Google client libraries.

```sh
cd plugins/google-workspace
go run .                             # HTTP :7106, gRPC :7206, announces to LANDFLOW_REGISTRY_URL (default http://127.0.0.1:3000)
LANDFLOW_REGISTRY_URL=off go run .   # standalone
go vet ./... && go test ./...        # against an in-process fake Google: no account, no network
go run ./cmd/fakegoogle -addr 127.0.0.1:7999 -key-out /tmp/fake-sa.pem   # the same fake as a server, for trying it by hand
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports.

## Nodes

All action nodes read their parameters per item, pair every output item with its input and set `usableAsTool: true`.
An API failure stops the node with the item index, the HTTP status and Google's own message, e.g.
`Google Sheets API error 404: Requested entity was not found.`, plus a hint in the description (share the file with the
service account, set up delegation, missing scope, rate limit). The host's **On Error: Continue** keeps the flow going.

Every node has an **Authentication** parameter (Service Account, the default, or OAuth2) that picks the credential.
Document, sheet, column, label, folder and calendar pickers load their options live; an expression can give an ID or a
full URL instead.

| Node (type) | Resource → operations | Notes |
|---|---|---|
| **Google Sheets** (`google.googleSheets`) | Sheet → Append Row, Append or Update Row, Clear, Get Row(s), Update Row · Spreadsheet → Create | See below |
| **Google Sheets Trigger** (`google.googleSheetsTrigger`) | poll trigger, Row Added, default every 60 s | Document, Sheet (empty: the first) |
| **Gmail** (`google.gmail`) | Message → Send, Reply, Get, Get Many, Add Labels, Remove Labels, Mark as Read, Mark as Unread | Send/Reply: To, Subject, Email Type (Text/HTML), Message; Options: CC, BCC, Reply To, Sender Name, Reply to Sender Only. Get Many: Return All / Limit, Simplify, Filters (Search, Read Status, Sender, labels, include spam and trash) |
| **Gmail Trigger** (`google.gmailTrigger`) | poll trigger, new emails, default every 60 s | Same Filters as Get Many, Simplify |
| **Google Drive** (`google.googleDrive`) | File → Upload, Download, Delete · File/Folder → Search · Folder → Create | Upload: text or base64 content (≤ 5 MB, multipart upload), parent folder, MIME type. Download: ≤ 10 MB into the item as `content` (`encoding` `utf8` for text, else `base64`); Docs, Sheets, Slides and Drawings are exported as text, CSV, text and PNG. Delete trashes unless Delete Permanently. Search by name or with a raw Drive query, filtered by folder, files/folders, MIME types, trash |
| **Google Calendar** (`google.googleCalendar`) | Event → Create, Delete, Get, Get Many, Update | Calendar picker (`calendarList`). Start/End as ISO 8601: with an offset as given, without one in the event's Time Zone or the calendar's. All Day uses dates (a same-day end becomes the next day, as the API's end date is exclusive). Additional/Update Fields: summary, description, location, attendees, time zone, send updates. Get Many: After/Before, order by start time or updated, search, single events, show deleted |
| **Google Docs** (`google.googleDocs`) | Document → Create, Get, Update | Create in a folder (moved there through Drive). Get returns `{documentId, title, content}` with the text of paragraphs, tables and the table of contents (Simplify off: the raw document). Update applies Actions in one `batchUpdate`: Insert (at the end) and Replace All (match case optional) and returns `occurrencesChanged` |

### Google Sheets

The first row of a sheet holds the column names. Rows come out as objects keyed by them plus `row_number`; reads use
unformatted values (numbers stay numbers) and formatted dates.

- **Append Row**, Mapping Column Mode **Map Automatically**: item fields whose names match a column are written; others
  are ignored. On a sheet without a header row the item's field names become the header (sorted alphabetically, since Go
  maps do not keep JSON key order). **Map Each Column Below**: pairs of column and value; an unknown column is an error.
  Consecutive appends to one sheet go out as a single `values.append`, entered as if typed (`USER_ENTERED`).
- **Update Row** finds the first row whose Column to Match On equals the item's field of that name (or Value to Match On
  in manual mode) and writes only the given cells. **Append or Update Row** appends when there is no match.
- **Get Row(s)**: every non-empty row, or the rows matching Filters (column = value, combined with AND or OR); the first
  match only unless Options → Return All Matches.
- **Clear** empties the sheet, optionally keeping the header row. **Create** makes a spreadsheet with named sheets.

### Polling triggers

Both triggers emit nothing on the first poll after activation. They record a baseline, so turning a workflow on never
replays old rows or mail. **Execute** in the editor (`mode: manual`) shows recent data without touching the state.

- **Sheets**: state `{lastRow, documentId, sheetName}`. Each poll reads the header and the rows below `lastRow`
  (one `values:batchGet`) and emits the non-empty ones oldest first. Pointing the trigger at another sheet takes a new
  baseline. Rows inserted above the last row or deleted are not detected. Manual: the last 5 rows.
- **Gmail**: state `{lastInternalDate, seenIds}`. Each poll searches `after:<last second − 1>` plus the filters, drops
  ids already seen (the newest 100 are kept), fetches the rest and emits them oldest first. Manual: the 5 newest
  matching messages.

## Credentials

Both types have **Test connection**, and the failure message is Google's own reason plus a hint, e.g.
`Google rejected the service account credential (HTTP 400 invalid_grant): Invalid JWT Signature. Check that the private
key belongs to this service account…`. Private keys, client secrets and refresh tokens are `password` fields: masked
in the UI and never logged. Access tokens are cached per credential until 60 s before they expire, and a 401 drops the
cached token and retries once. Both have **Token URL** (default `https://oauth2.googleapis.com/token`) and **API Base
URL**. A base URL replaces the host of every Google API and keeps the paths, for a proxy or a test double.

| Type | Fields | Test |
|---|---|---|
| `googleApi` (service account) | Service Account Email, Private Key, Impersonate a User (optional) | signs a JWT (RS256) and exchanges it: "Token issued for robot@… with 5 scopes[, impersonating …]" |
| `googleOAuth2Api` (refresh token) | Client ID, Client Secret, Refresh Token | refreshes, then asks `userinfo`: "Authenticated as you@… (N scopes granted)" ("Refresh token works" without the email scope) |

Service-account tokens request these scopes: `spreadsheets`, `drive`, `gmail.modify`, `calendar` and `documents`
(all under `https://www.googleapis.com/auth/`).

### Service account

1. In the [Google Cloud console](https://console.cloud.google.com/) pick or create a project and enable the
   **Google Sheets, Google Drive, Gmail, Google Calendar and Google Docs APIs** (APIs & Services → Library).
2. IAM & Admin → Service Accounts → **Create service account**. No project roles are needed.
3. Open it → Keys → Add key → **JSON**. From the downloaded file, copy `client_email` into Service Account Email and
   `private_key` into Private Key. Pasting with literal `\n` sequences, on one line or the whole JSON file also works.
4. **Share what it should use**: a service account is its own user with an empty Drive. Open the spreadsheet (or Drive
   folder, Doc or calendar), click **Share** and add the service account's email as an Editor. Calendars: Settings →
   *Share with specific people*, "Make changes to events". Without this, Google answers 403/404 and the node says so.
   Anything it creates belongs to the service account; set a folder shared with you as Parent Folder to see it.

**Gmail needs domain-wide delegation** (Google Workspace only: service accounts cannot read consumer `@gmail.com`
mailboxes, so use OAuth2 there):

1. On the service account's Details page copy its **Unique ID** (the OAuth client ID).
2. In the [Admin console](https://admin.google.com/) → Security → Access and data control → API controls →
   **Manage domain-wide delegation** → Add new: that client ID and the five scopes above, comma-separated.
3. Set **Impersonate a User** on the credential to the mailbox's address. The plugin then acts as that user for every
   API (Sheets and Drive included), so sharing with the service account is no longer needed.

### OAuth2 with a refresh token

Landflow has no in-app consent screen yet, so you mint a refresh token once and paste it:

1. Cloud console → APIs & Services → **OAuth consent screen**: configure it (External + yourself as a test user is enough;
   test-mode refresh tokens expire after 7 days, publish the app to avoid that). Enable the five APIs as above.
2. Credentials → Create credentials → **OAuth client ID** → *Web application*, with
   `https://developers.google.com/oauthplayground` as an authorized redirect URI. Copy the client ID and secret.
3. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear: **Use your own OAuth
   credentials**, paste them. In Step 1 enter the scopes, space-separated: `openid email
   https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/documents`. Authorize, then **Exchange authorization code for tokens** and copy the
   **Refresh token**. Grant fewer scopes if you only use some nodes.

With gcloud instead (a *Desktop app* OAuth client, downloaded as `client.json`):

```sh
gcloud auth application-default login --client-id-file=client.json \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/documents
# client_id, client_secret and refresh_token are now in:
cat ~/.config/gcloud/application_default_credentials.json
```

## Observability

Every Google call, the token exchange included, is an `HTTP {METHOD}` client span (through `landflow.HTTPClient`) under
`plugin.execute google.<node>`, with the host's trace id and `traceparent` sent on. The plugin adds:

| Span | Attributes |
|---|---|
| `google.oauth.token` | `google.auth` (`service_account`/`oauth2`), `landflow.cache_hit`; error status with Google's reason on failure |
| `google.sheets.read`, `google.sheets.poll` | `google.sheets.full`, `google.sheets.last_row`, `google.sheets.rows` |
| `google.gmail.messages.list`, `google.drive.files.list`, `google.calendar.events.list`, `google.calendar.calendar_list` | paginated reads: `google.limit` (−1 = all), `google.pages`, `google.items` |
| `google.gmail.messages.fetch` | `google.items`: messages fetched (5 at a time) |

Access tokens, the token request body (JWT assertion, client secret, refresh token) and private keys never appear in
spans, logs or errors. The SDK redacts the `url.full` of the token call (its path contains "token").

| Metric | Type | Attributes |
|---|---|---|
| `landflow.google.sheets.rows_appended` | counter | `mode`: `auto` / `manual` (Append, and appends by Append or Update) |
| `landflow.google.gmail.messages_sent` | counter | `operation`: `send` / `reply` |
| `landflow.google.token_refreshes` | counter | `auth`: `service_account` / `oauth2`, `outcome`: `success` / `error` (token-endpoint calls; cache hits are not counted, nor are credential tests) |
| `landflow.google.api_errors` | counter | `api`: `sheets` / `gmail` / `drive` / `calendar` / `docs`, `status_class`: `4xx` / `5xx` / `network` |
| `landflow.google.poll.new_items` | counter | `trigger`: `gmail` / `sheets` |

The SDK adds `landflow.plugin.id`, `landflow.node.type` and `landflow.workflow.id`. Prometheus names on
`GET :7106/metrics`: `landflow_google_sheets_rows_appended_total`, `landflow_google_gmail_messages_sent_total`,
`landflow_google_token_refreshes_total`, `landflow_google_api_errors_total`, `landflow_google_poll_new_items_total`.

## Trying it without Google

`cmd/fakegoogle` serves the test double: a token endpoint that verifies the JWT signature, plus enough of Sheets, Gmail,
Drive, Calendar and Docs for every operation. It generates a throwaway key and seeds spreadsheet `sheet-demo` (sheet
`Leads`) and two emails in `me@example.com`'s mailbox.

```sh
go run ./cmd/fakegoogle -addr 127.0.0.1:7999 -key-out /tmp/fake-sa.pem
```

Create a `google.googleApi` credential with email `robot@fake-project.iam.gserviceaccount.com`, the contents of
`/tmp/fake-sa.pem` as Private Key, Impersonate a User `me@example.com` (for Gmail), Token URL `http://127.0.0.1:7999/token`
and API Base URL `http://127.0.0.1:7999`. Add mail or rows while a trigger is active:

```sh
curl -X POST localhost:7999/_fake/gmail/messages -d '{"from":"ada@example.com","to":"me@example.com","subject":"Hi","text":"Hello"}'
curl -X POST localhost:7999/_fake/sheets/sheet-demo/rows -d '{"sheet":"Leads","rows":[["Dee","dee@example.com",70]]}'
curl localhost:7999/_fake/state
```

## Layout

```
main.go                 plugin info, nodes, Serve (ports 7106 / 7206)
auth.go                 credential types, JWT and refresh grants, token cache, credential tests
client.go               API hosts, base URL override, requests, 401 retry, error mapping, pagination
params.go               shared properties and parameter helpers
sheets.go, sheets_trigger.go, gmail.go, gmail_mime.go, gmail_trigger.go, drive.go, calendar.go, docs.go
icons/                  original SVG icons
internal/fakegoogle/    the fake Google used by the tests and cmd/fakegoogle
cmd/fakegoogle/         the fake as a standalone server
```
