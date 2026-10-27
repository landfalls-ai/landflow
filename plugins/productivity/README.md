# productivity: Notion, Airtable, GitHub, Jira, HubSpot, Stripe and RSS (Python)

Ten nodes built with [`landflow-sdk`](../../sdks/python), served over HTTP (`:7105`) and gRPC (`:7205`).
Standard library only (plus the SDK): every API call goes through the SDK's traced `ctx.http`, feeds are
parsed with `xml.parsers.expat` + `xml.etree.ElementTree`.

| Node | Type | Resources and operations |
|---|---|---|
| Notion | `productivity.notion` | **Database Page**: Create (database picker, title, typed key/value properties, Properties (JSON)), Get Many (filter / sorts JSON, `start_cursor` paging) · **Page**: Get, Archive, Search · **Block**: Append After (paragraph text or blocks JSON, 100 per request) · **Block** Append File, **Page** Attach File: binary data uploaded with the file upload API (image / video / audio / PDF / file block by MIME type, or a Files property) |
| Airtable | `productivity.airtable` | **Record**: Create, Create or Update (`performUpsert.fieldsToMergeOn`), Get, Search (formula, sort, view, fields, `offset` paging), Update, Delete. Base and table pickers. Fields: map the input item, define below, or JSON. Writes are batched 10 records per request · **Attachment**: Upload (`uploadAttachment`, base64 JSON, up to 5 MB), Download (one item per file of a field) |
| GitHub | `productivity.github` | **Issue**: Create, Get, Edit, Create Comment, Get Many (state, labels, since…, `Link` paging, pull requests excluded) · **Repository**: Get · **Release**: Get Many · **File**: Get (base64 decoded into `content`; a directory lists its entries). Owner + name, or a picker from `/user/repos` · **File** Download, Create or Update (from binary), **Release** Download Asset, Upload Asset, **Repository** Download Archive |
| GitHub Trigger | `productivity.githubTrigger` | poll (60 s): New Issue, New Pull Request, New Release |
| GitHub Webhook Trigger | `productivity.githubWebhookTrigger` | app webhook (docs/protocol.md §12): registers a repository webhook with a random secret when the workflow is published, deletes it when unpublished; verifies `X-Hub-Signature-256`, one run per event (`push`, `pull_request`, `issues`, … or any), item `{event, action, deliveryId, body, headers}`, redeliveries deduplicated by `X-GitHub-Delivery`. The token needs `admin:repo_hook` (classic) or Webhooks read and write (fine-grained); with **GitHub App** authentication the hook is registered through the app's installation token (permission Repository webhooks: read and write), its secret still the per-hook random one |
| Stripe Trigger | `productivity.stripeWebhookTrigger` | app webhook: registers a webhook endpoint (`POST /v1/webhook_endpoints`, form-encoded `url`, `enabled_events[]`, description) when the workflow is published and deletes it when unpublished (404 is fine); keeps the endpoint id, the signing secret `whsec_…` Stripe returns once, and the events in the static data. Events: a multi-select of the common ones, **Additional Events** (free text, comma-separated) and **Any Event** (`*`). `checkExists` compares URL, status and events. Verifies `Stripe-Signature` (option **Signature Tolerance**, default 300 s), ignores events not selected (200), item `{id, type, created, livemode, data, apiVersion, request, body}` (+ `account` for Connect), idempotency key = event id (Stripe retries for days). Option **Listen to Connected Accounts** registers a Connect endpoint. Stripe has no other node in this plugin: the trigger is the whole integration so far |
| Jira Software | `productivity.jira` | `jiraVersion` Cloud (REST v3, Basic email + API token, ADF descriptions and comments), **Cloud (OAuth2)** (the same REST v3 through `api.atlassian.com/ex/jira/{cloudId}` with a Bearer token) or Server / Data Center (REST v2, PAT). **Issue**: Create (project, issue type and priority pickers), Get, Get Many (JQL; Cloud `POST /search/jql` + `nextPageToken`, Server `/search` + `startAt`), Update, Transition (transition picker) · **Issue Comment**: Add · **Issue Attachment**: Add (multipart, several files), Get (download), Get Many (list, optional download) |
| HubSpot | `productivity.hubspot` | **Contact**: Create or Update (search by email, then create or patch), Get, Search (property filters, free text, sort, `after` paging) · **Deal**: Create (pipeline and stage pickers, amount, close date, associated contacts) · **File**: Upload (Files API), Get (details, optional download) |
| RSS Read | `productivity.rssFeedRead` | RSS 2.0, RSS 1.0 (RDF) and Atom; one item per entry (option Download Enclosures: each item's enclosure as a binary file) |
| RSS Feed Trigger | `productivity.rssFeedReadTrigger` | poll (300 s) |

Every action node has a resource / operation picker with n8n's names, Return All + Limit on list
operations, Simplify (default on) where the API is verbose (Notion pages → `{id, name, url, <property>: value}`,
HubSpot → `{id, ...properties}`, Jira issues → summary, status, assignee… with ADF descriptions as text),
per-item parameters with `pairedItem`, and `usableAsTool`. API failures become node errors such as
`GitHub API error (HTTP 422): Validation Failed; Issue title missing_field` with the item index, so the
host's "continue on fail" applies (the SDK has no per-item continue flag; the host continues the whole node).

## Binary data

Files move as binary data on the items ([docs/protocol.md §11](../../docs/protocol.md#11-binary-data), the SDK's
`ctx.get_binary_bytes` / `ctx.prepare_binary_data`, see [`landflow-sdk`](../../sdks/python#binary-data)). Upload operations read the
file of the input item's binary property named by **Input Binary Field** (default `data`); downloads put the bytes in **Output
Binary Field** (default `data`) of the output item, whose JSON is the service's metadata. File names and MIME types travel with the file.

| Node | In (item binary → service) | Out (service → item binary) |
|---|---|---|
| GitHub | File **Create or Update**: `PUT /contents/{path}` with the bytes as base64 (the existing blob `sha` is looked up, so it updates when the file exists; commit message and branch optional). Release **Upload Asset**: `POST` to the release's own `upload_url` with the raw bytes (`name`, `label`; release by id, tag or `latest`) | File **Download** (any size the contents API serves; over 1 MB it fetches the raw bytes). Release **Download Asset** (by id, or by file name within a release). Repository **Download Archive** (zip or tar.gz of a branch, tag or commit) |
| Jira | Issue Attachment **Add**: `POST /issue/{key}/attachments`, multipart `file` parts, `X-Atlassian-Token: no-check`; one or several binary properties (`data, report`) in one request | Issue Attachment **Get** (by id: metadata, then `/attachment/content/{id}`) and **Get Many** (one item per attachment, **Download Files** adds the content) |
| Notion | Block **Append File** and Page **Attach File**: `POST /v1/file_uploads`, then `POST /v1/file_uploads/{id}/send` (multipart, up to 20 MB), then the upload is attached as an image, video, audio, pdf or file block (by MIME type; optional caption) or added to a Files property (existing files are kept unless **Replace Existing Files**) | not supported: Notion's file URLs expire after an hour, so read them from the Simplify output and fetch them with an HTTP Request node |
| Airtable | Attachment **Upload**: `POST https://content.airtable.com/v0/{base}/{record}/{field}/uploadAttachment` with `{contentType, file (base64), filename}`; 5 MB limit (checked before sending); a custom credential `baseUrl` serves both hosts | Attachment **Download**: reads the record, one output item per file of the field, fetched from Airtable's signed CDN URLs (the token is not sent there) |
| HubSpot | File **Upload**: Files API `POST /files/v3/files` (multipart `file`, `options` with access and overwrite, `folderPath`, `fileName`); needs the `files` scope | File **Get** with **Download File**: private files go through `/files/v3/files/{id}/signed-url`, public ones through their URL |
| RSS Read | not applicable | option **Download Enclosures** (RSS `enclosure`, Atom `rel="enclosure"`): one binary file per item that has one, default size limit 25 MB (**Max Enclosure Size**), no credentials sent |

Not covered: HubSpot attachments on engagements (notes, emails) and contact file properties (the Files API is the clean fit; linking a file
to a CRM record is a separate engagement call), Notion and Jira file bytes above their upload limits, RSS Feed Trigger enclosures (the
trigger emits feed items only; follow it with RSS Read for the files), and multipart or resumable uploads beyond the single requests above.
Downloads are held in memory (100 MB cap); the host stores the result in its binary store (over 64 KiB through `binaryAccess`).

**Redirects.** File downloads often redirect to a signed URL on a CDN (GitHub assets and archives, Jira Cloud media). `ctx.http` drops the
`Authorization` and `Cookie` headers when a redirect changes host (`_RedirectHandler` in `sdks/python/landflow_sdk/http_client.py`), since such
URLs refuse a request that also carries a token.


## Credentials

| Type | Fields (secrets are `password`) | Test |
|---|---|---|
| `notionApi` | `apiKey`, `baseUrl` = `https://api.notion.com` (sends `Notion-Version: 2022-06-28`) | `GET /v1/users/me` |
| `airtableTokenApi` | `accessToken`, `baseUrl` = `https://api.airtable.com` | `GET /v0/meta/whoami` |
| `githubApi` | `accessToken`, `baseUrl` = `https://api.github.com` (Enterprise: `https://host/api/v3`) | `GET /user` → login |
| `jiraSoftwareCloudApi` | `email`, `apiToken`, `domain` (`https://your-domain.atlassian.net`) | `GET /rest/api/3/myself` |
| `jiraSoftwareCloudOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, `domain` (the site, `https://your-domain.atlassian.net`; optional when the grant covers one site), `apiBaseUrl` = `https://api.atlassian.com`; URLs fixed to `auth.atlassian.com` (authorization code, `audience=api.atlassian.com`, `prompt=consent`), `scope` = `read:jira-work write:jira-work read:jira-user offline_access` | `GET /oauth/token/accessible-resources` → site name, then `GET /rest/api/3/myself` |
| `jiraSoftwareServerPatApi` | `domain`, `personalAccessToken` | `GET /rest/api/2/myself` |
| `hubspotAppToken` | `appToken`, `baseUrl` = `https://api.hubapi.com` | `GET /crm/v3/objects/contacts?limit=1` |
| `githubAppApi` | `appId`, `privateKey` (PEM, PKCS#1 or PKCS#8; `password` field: a pasted key whose newlines were lost still works), `installationId` (optional: found per repository with `GET /repos/{owner}/{repo}/installation` using the app JWT, or the app's only installation), `baseUrl` | `GET /app` with the app JWT (and an installation token when an Installation ID is set) |
| `stripeApi` | `apiKey` (`sk_…` or restricted `rk_…`), `baseUrl` = `https://api.stripe.com`, `stripeVersion` (optional `Stripe-Version`) | `GET /v1/balance` → test or live mode |
| `githubOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, `scope` = `repo read:user admin:repo_hook`, `baseUrl`; URLs fixed to github.com (authorization code) | `GET /user` → login |
| `notionOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, `baseUrl`; Notion has no scopes (the user picks pages), `owner=user`, Basic client auth, tokens do not expire | `GET /v1/users/me` |
| `airtableOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, `scope` = `data.records:read data.records:write schema.bases:read user.email:read`, `baseUrl`; PKCE (required by Airtable), Basic client auth | `GET /v0/meta/whoami` |
| `hubspotOAuth2Api` | extends `oAuth2Api`: Client ID and Secret, `scope` = `oauth crm.objects.contacts.read/write crm.objects.deals.read/write`, `baseUrl`; authorization code | `GET /crm/v3/objects/contacts?limit=1` |

**GitHub App.** GitHub, GitHub Trigger and GitHub Webhook Trigger have a third **Authentication** option, **GitHub App** (`githubAppApi`): the nodes act as an app installation instead of a person. `landflow_sdk.jwt` (pure standard library, no `cryptography`) signs an RS256 JWT with the private key (`iss` = App ID, `iat` = now − 60 s, `exp` = now + 540 s), `POST /app/installations/{id}/access_tokens` trades it for an installation token, and `productivity/github_app.py` (`GitHubApi`, the one helper every GitHub call goes through) caches that token in the process until 60 s before `expires_at` and mints a new one after a 401 (one retry). Create the app (Settings, Developer settings, GitHub Apps), generate a private key, and install it on the repositories. Permissions: **Repository webhooks** read and write (webhook trigger), **Contents**, **Issues** and **Pull requests** read (write to create or change them), Metadata read. The repository picker lists the installation's repositories (`/installation/repositories`). For GitHub Enterprise Server set the credential's Base URL. Tests: `tests/test_github_app.py` (a fake GitHub that verifies the JWT signature).

**OAuth2 variants.** The four `…OAuth2Api` types extend the host's generic OAuth2 type (`extends: ["oAuth2Api"]`, docs/protocol.md §7):
the dialog shows **Connect** (register the redirect URL it shows with the provider), the host keeps the tokens, refreshes them
before they expire and renews them and runs the node again after a 401. GitHub, Notion, Airtable, HubSpot and the GitHub
triggers have an **Authentication** switch (token, the default, or OAuth2) and list both credential types; they read the
`accessToken` of whichever the host sent on every call and cache nothing (`pick_credentials` in `productivity/common.py`). Jira's OAuth2 is a
`jiraVersion` option (**Cloud (OAuth2)**) rather than an Authentication switch. Atlassian's 3LO flow addresses sites by cloud id, so the node first calls
`GET api.atlassian.com/oauth/token/accessible-resources`, keeps the sites that have a Jira scope and picks the one whose host matches the
credential's `domain` (a grant with a single site needs no domain; several sites without one is an error that lists them), then calls
`api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…` with the Bearer token. The lookup is cached for an hour per site and token.
Register the callback `<LANDFLOW_PUBLIC_URL>/api/oauth2/callback` in the Atlassian developer console (OAuth 2.0 (3LO), with the Jira API scopes above).

The Jira node declares both Jira credentials with `displayOptions` on `jiraVersion`, so the host asks for
(and sends) only the one that matches. Failed tests return the service's own message, e.g.
`GitHub API error (HTTP 401): Bad credentials`.

## Polling triggers

| Trigger | State | First poll | Later polls | Manual (Execute in the editor) |
|---|---|---|---|---|
| GitHub Trigger | `{lastId}`: the highest id seen | baseline, no items | list sorted newest first (following `Link` pages until `lastId` is reached, at most 10), emit `id > lastId` oldest first | the latest 5, oldest first |
| RSS Feed Trigger | `{lastIsoDate, seen}`: newest item date and the last ~200 guids (or links) | baseline, no items | emit items not in `seen` and not older than `lastIsoDate`, oldest first, so items sharing a date or without a date are deduplicated | the latest item, as n8n does |

A failed poll returns an error and no state, so the host retries from the same point.

## Feeds are untrusted

RSS items carry rss-parser's fields: `title`, `link`, `pubDate`, `isoDate`, `creator`, `content`,
`contentSnippet` (text without HTML, about 300 characters), `guid`, `categories`, `enclosure`, plus
`content:encoded`, `dc:creator`, `comments` (RSS) and `author`, `summary`, `id` (Atom) when present, and any
custom fields (`media:thumbnail, itunes:duration`). The parser drives expat directly: any `<!ENTITY>`
declaration (billion laughs, XXE, parameter entities) is refused, external DTDs are never fetched, bodies
above 10 MB are rejected, undeclared HTML entities (`&nbsp;`) and legacy encodings (windows-1252) are decoded,
and HTML is only stripped to text (scripts and styles dropped), never interpreted.

**Not implemented: "Ignore SSL Issues".** `ctx.http` has no TLS-verification switch, and bypassing it
would lose the client span and trace propagation. See "SDK requests" below.

## Observability

Each API call is an `HTTP {METHOD}` client span from `ctx.http` under `plugin.execute productivity.<node>`
(the host's trace continues through `traceparent`). Paginated reads and feed parsing get a child span:

| Span | Attributes |
|---|---|
| `notion.query`, `notion.search`, `airtable.search`, `github.list`, `jira.search`, `hubspot.search` | `landflow.pages`, `landflow.items`, `landflow.return_all` (`github.list`: `github.resource`; `jira.search`: `jira.deployment`) |
| `rss.parse` | `landflow.items`, `landflow.bytes`, `rss.format` (`rss` / `rdf` / `atom`) |

| Metric | Type | Attributes |
|---|---|---|
| `landflow.productivity.records_written` | counter | `service` (`notion`, `airtable`, `github`, `jira`, `hubspot`), `operation` (`create`, `update`, `upsert`, `delete`, `comment`, `archive`, `append`, `transition`) |
| `landflow.productivity.poll.new_items` | counter | `trigger` (`github`, `rss`) |
| `landflow.productivity.api_errors` | counter | `service` (also `rss`), `status_class` (`4xx`, `5xx`, `network`) |

The SDK adds `landflow.plugin.id`, `landflow.node.type` and `landflow.workflow.id`. No ids, names or URLs
go into metric attributes; tokens are redacted from logs, spans and errors by the SDK.
`GET :7105/metrics` serves them as Prometheus text (`landflow_productivity_records_written_total` …).

## Run

```bash
./setup.sh                    # creates .venv and installs the SDK editable with the grpc extra
.venv/bin/python main.py      # HTTP :7105 + gRPC :7205, announces to http://127.0.0.1:3000
```

`python3 main.py` also works without the venv (SDK from `../../sdks/python`, HTTP only).
Environment: `LANDFLOW_REGISTRY_URL=off`, `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT`, `LANDFLOW_LOG_LEVEL=debug`,
`LANDFLOW_LOG_FORMAT=pretty` (see the SDK README).

## Test

```bash
.venv/bin/python -m unittest discover -s tests      # or python3 -m unittest discover -s tests
```

The tests start local fake servers (`tests/_support.py: FakeApi`) imitating each API, use fake tokens
(`test-token-123`) and never call the real services. They cover each operation's request shape and
response mapping, pagination, error mapping, credential tests, the RSS 2.0 / Atom / RDF fixtures in
`tests/fixtures`, hostile XML, both poll triggers, metrics, and a call through the SDK's HTTP server that
checks the trace continues into the client spans.
`tests/test_binary.py` covers the binary operations (multipart bodies, base64 uploads, signed-URL redirects that must not carry the token,
size limits, missing files) against the same fakes.

```bash
curl -s localhost:7105/landflow/v1/execute -d '{"protocol":"landflow.plugin/v1","executionId":"ex1","mode":"manual",
  "node":{"id":"n1","name":"RSS","type":"productivity.rssFeedRead","typeVersion":1},
  "parameters":{"url":"https://www.rssboard.org/files/sample-rss-2.xml"},"itemParameters":[],"inputs":[[{"json":{}}]]}'
```

## SDK requests

- `ctx.http.request(..., verify=False)` (or an `ssl_context=`) would allow n8n's "Ignore SSL Issues" option.
- `http_client.py` reads 4xx/5xx bodies from `urllib.error.HTTPError` without closing it, which prints
  `ResourceWarning` under `-W default` (wrap the read in `with exc:`).

## Transports

By default the plugin serves HTTP and gRPC and announces both to the host. To add a broker, name its kind in `LANDFLOW_TRANSPORTS` and give the
connection URL (the host needs a matching connection under Settings → Transports):

```sh
LANDFLOW_TRANSPORTS=http,grpc,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=… .venv/bin/python main.py
```

`./setup.sh` installs the SDK with the `grpc`, `mcp` and `brokers` extras: `kafka`, `amqp` (RabbitMQ), `nats` (also `jetstream`) and `valkey` run on
native Python drivers. The other kinds (`mqtt`, `amqp1`, `pulsar`, `sqs`, `pubsub`, `servicebus`) go through `landflow-bridge`, which the SDK starts
as a child process when it finds the binary (`LANDFLOW_BRIDGE_BIN`, `landflow-bridge` on PATH, or `services/landflow-bridge/bin/landflow-bridge`);
the container image carries it. Over a broker, calls are encrypted and signed with `LANDFLOW_TRANSPORT_SECRET` (the host's value).

**`max_concurrency`** is how many calls run at once across all faces: the default is **8** (`DEFAULT_MAX_CONCURRENCY` in `main.py`): the upstream APIs are rate limited per token (Notion about 3 requests/s, Airtable 5/s per base, HubSpot about 100 per 10 s, GitHub's secondary limit, Jira's per-tenant throttle); more replicas add capacity. `LANDFLOW_MAX_CONCURRENCY` overrides it.

**`idempotent`.** The action nodes are at most once over a broker (`idempotent: false`: creates, updates, upserts, archives, deletes, transitions, comments), and these read operations opt in with `idempotent: true`: Notion `page` get/search and `databasePage` getAll; Airtable `record` get/search; GitHub `file`/`repository`/`issue` get, `release`/`issue` getAll; Jira `issue` get/getAll; HubSpot `contact` get/search. `rssFeedRead` only reads a feed, so it is `idempotent: true`. The polling triggers and the GitHub webhook trigger keep the default (they hold poll state or webhooks).

**MCP.** Every operation is a tool (`github_issue_create`, `notion_page_archive`, `jira_issue_getAll`, `rssFeedRead`, …), with `idempotentHint` following the flags above; credentials come from the caller's grant through the host. The face listens on the HTTP port at `/mcp`; the bind address follows the SDK (`LANDFLOW_BIND_HOST`, else loopback unless
`LANDFLOW_ADVERTISE_HOST` is set, as in a container, when it is `0.0.0.0` and `LANDFLOW_MCP_TOKEN` is required). In dev it is on, on loopback, with
no token. Containers and the Kubernetes manifest set `LANDFLOW_MCP=off`: agents reach the plugin through the host's per-plugin endpoint and the
gateway.
