# productivity: Notion, Airtable, GitHub, Jira, HubSpot and RSS (Python)

Eight nodes built with [`landflow-sdk`](../../sdks/python), served over HTTP (`:7105`) and gRPC (`:7205`).
Standard library only (plus the SDK): every API call goes through the SDK's traced `ctx.http`, feeds are
parsed with `xml.parsers.expat` + `xml.etree.ElementTree`.

| Node | Type | Resources and operations |
|---|---|---|
| Notion | `productivity.notion` | **Database Page**: Create (database picker, title, typed key/value properties, Properties (JSON)), Get Many (filter / sorts JSON, `start_cursor` paging) · **Page**: Get, Archive, Search · **Block**: Append After (paragraph text or blocks JSON, 100 per request) |
| Airtable | `productivity.airtable` | **Record**: Create, Create or Update (`performUpsert.fieldsToMergeOn`), Get, Search (formula, sort, view, fields, `offset` paging), Update, Delete. Base and table pickers. Fields: map the input item, define below, or JSON. Writes are batched 10 records per request |
| GitHub | `productivity.github` | **Issue**: Create, Get, Edit, Create Comment, Get Many (state, labels, since…, `Link` paging, pull requests excluded) · **Repository**: Get · **Release**: Get Many · **File**: Get (base64 decoded into `content`; a directory lists its entries). Owner + name, or a picker from `/user/repos` |
| GitHub Trigger | `productivity.githubTrigger` | poll (60 s): New Issue, New Pull Request, New Release |
| Jira Software | `productivity.jira` | `jiraVersion` Cloud (REST v3, Basic email + API token, ADF descriptions and comments) or Server / Data Center (REST v2, PAT). **Issue**: Create (project, issue type and priority pickers), Get, Get Many (JQL; Cloud `POST /search/jql` + `nextPageToken`, Server `/search` + `startAt`), Update, Transition (transition picker) · **Issue Comment**: Add |
| HubSpot | `productivity.hubspot` | **Contact**: Create or Update (search by email, then create or patch), Get, Search (property filters, free text, sort, `after` paging) · **Deal**: Create (pipeline and stage pickers, amount, close date, associated contacts) |
| RSS Read | `productivity.rssFeedRead` | RSS 2.0, RSS 1.0 (RDF) and Atom; one item per entry |
| RSS Feed Trigger | `productivity.rssFeedReadTrigger` | poll (300 s) |

Every action node has a resource / operation picker with n8n's names, Return All + Limit on list
operations, Simplify (default on) where the API is verbose (Notion pages → `{id, name, url, <property>: value}`,
HubSpot → `{id, ...properties}`, Jira issues → summary, status, assignee… with ADF descriptions as text),
per-item parameters with `pairedItem`, and `usableAsTool`. API failures become node errors such as
`GitHub API error (HTTP 422): Validation Failed; Issue title missing_field` with the item index, so the
host's "continue on fail" applies (the SDK has no per-item continue flag; the host continues the whole node).

## Credentials

| Type | Fields (secrets are `password`) | Test |
|---|---|---|
| `notionApi` | `apiKey`, `baseUrl` = `https://api.notion.com` (sends `Notion-Version: 2022-06-28`) | `GET /v1/users/me` |
| `airtableTokenApi` | `accessToken`, `baseUrl` = `https://api.airtable.com` | `GET /v0/meta/whoami` |
| `githubApi` | `accessToken`, `baseUrl` = `https://api.github.com` (Enterprise: `https://host/api/v3`) | `GET /user` → login |
| `jiraSoftwareCloudApi` | `email`, `apiToken`, `domain` (`https://your-domain.atlassian.net`) | `GET /rest/api/3/myself` |
| `jiraSoftwareServerPatApi` | `domain`, `personalAccessToken` | `GET /rest/api/2/myself` |
| `hubspotAppToken` | `appToken`, `baseUrl` = `https://api.hubapi.com` | `GET /crm/v3/objects/contacts?limit=1` |

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

```bash
curl -s localhost:7105/landflow/v1/execute -d '{"protocol":"landflow.plugin/v1","executionId":"ex1","mode":"manual",
  "node":{"id":"n1","name":"RSS","type":"productivity.rssFeedRead","typeVersion":1},
  "parameters":{"url":"https://www.rssboard.org/files/sample-rss-2.xml"},"itemParameters":[],"inputs":[[{"json":{}}]]}'
```

## SDK requests

- `ctx.http.request(..., verify=False)` (or an `ssl_context=`) would allow n8n's "Ignore SSL Issues" option.
- `http_client.py` reads 4xx/5xx bodies from `urllib.error.HTTPError` without closing it, which prints
  `ResourceWarning` under `-W default` (wrap the read in `with exc:`).
