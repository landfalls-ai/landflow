# Integrations

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

The integrations people use most in n8n, chosen from its catalogue and public usage data (the n8n integrations research note in the repository), are built as plugins, one per language family, with n8n's resource → operation shape, names and options (Return All / Limit, Simplify, live pickers, usable as AI tools):

| Plugin | Language, ports | Nodes | Credentials |
|---|---|---|---|
| `core` (in the host) | TypeScript, in-process | Switch, Split Out, Aggregate, Remove Duplicates, Summarize, Rename Keys, Date & Time, Record Metric, Read/Write Files from Disk, Extract from File, Convert to File; OpenAI Chat Model (any OpenAI-compatible API, Ollama's `/v1` included), OpenAI (message a model, embeddings), Basic LLM Chain, Text Classifier, Information Extractor; RAG (vector stores, embeddings, data loader, text splitters, reranker, Question and Answer Chain), Guardrails, **Email Trigger (IMAP)** | OpenAI API, Anthropic API, Postgres, IMAP, Basic Auth, Header Auth, JWT Auth |
| [`messaging`](../../plugins/messaging) | TypeScript, 7104/7204 | Telegram, **Telegram Trigger**, Slack (with **Get Many Since** and **Get** as activity items, members with email), **Slack Trigger**, **Slack Activity Trigger**, Discord, WhatsApp Business Cloud, Send Email (SMTP) | Telegram, Slack (token or **OAuth2**), Discord bot, **OAuth2** and webhook, WhatsApp, SMTP |
| [`productivity`](../../plugins/productivity) | Python, 7105/7205 | Notion, **Notion Trigger**, Airtable, GitHub, **GitHub Trigger**, **GitHub Webhook Trigger**, **Stripe Trigger**, Jira Software, HubSpot, RSS Read, **RSS Feed Trigger** | Notion, Airtable, GitHub and HubSpot (token or **OAuth2**), GitHub also as a **GitHub App** installation (app JWT → installation token), Stripe, Jira Cloud (token or **OAuth2**) and Server (PAT) |
| [`google`](../../plugins/google-workspace) | Go, 7106/7206 | Google Sheets, **Sheets Trigger**, Gmail, **Gmail Trigger**, Google Drive, **Google Drive Trigger**, Google Calendar, **Google Calendar Trigger**, Google Docs, Google Directory (users, **groups and group members**: add, remove, list, has-member, change role) | Service account (JWT, optional impersonation), Google OAuth2 (**Connect**, or a refresh token) |
| [`databases`](../../plugins/databases) | Go, 7107/7207 | Postgres, MySQL, SQLite, Redis, **Postgres Trigger**, **SQLite Trigger** | Postgres, MySQL, Redis, SQLite |
| [`github`](../../plugins/github) | TypeScript, 7111/7211 | GitHub (Repository: Get, **Compare** (base...head: commits ahead and behind, changed files with patches, up to 300) · File: Get, List, Create or Update · Files: **Commit** (several files, one commit) · Branch: Create, Get (with the commit's message, author and changed files) · Pull Request: Create (draft or ready), Get, List Files, Comment, **Merge** (squash, merge or rebase; only if the head is still a given SHA) · Issue: Create, Comment; no delete) | GitHub API (token, optional Enterprise API base URL) |
| [`landfall`](../../plugins/landfall) | TypeScript, 7108/7208 | Landfall (incidents, timelines, remediation, heartbeats), **Landfall Trigger** | Landfall API, Landfall Heartbeat |
| [`triage`](../../plugins/triage) | TypeScript, 7109/7209 | Normalize Alert, Extract IOCs, Parse Email, Triage Rules, Triage Decision | none |
| [`threat-intel`](../../plugins/threat-intel) | Go, 7110/7210 | VirusTotal, AbuseIPDB, GreyNoise, urlscan.io, Shodan, AlienVault OTX, MISP, IOC Enrich | one per service |
| [`linear`](../../plugins/linear) | TypeScript, 7116/7216 | Linear (Issue, Comment and Project Update **Get Many Changed Since**, Issue **Get** as activity items, users with email; Issue Create, Add Link, Comment Create), **Linear Trigger** (webhook registered through the API, signed) | Linear (API key or **OAuth2**) |
| [`attio`](../../plugins/attio) | TypeScript, 7117/7217 | Attio (Record and List Entry **Get Many Changed Since**, Record **Get** with notes, as activity items; workspace members with email; Note Create, Task Create, Add to List), **Attio Trigger** (webhook registered through the API, signed) | Attio (API key or **OAuth2**) |
| [`fathom`](../../plugins/fathom) | TypeScript, 7118/7218 | Fathom (Meeting **Get Many Changed Since** and **Get** as activity items, one per meeting and optionally per action item; Recording Get Summary and Get Transcript; teams, members, users), **Fathom Trigger** (webhook registered through the API, signed; transcripts only when asked) | Fathom (API key) |
| [`clickland`](../../plugins/clickland) | TypeScript, 7119/7219 | Clickland (Log Search, Histogram, Patterns; Trace Search, Get; Service List; Metric List, Query; Alert List, Get, Create, Update, Delete, Events; Note Create, List; Knowledge Search; View Render, Get, List, Pin, Update, Add Panel, Remove Panel), **Clickland Alert Trigger** (webhook registered through the API, Standard Webhooks signature), **Clickland Trigger** (poll) ([clickland.md](clickland.md)) | Clickland API (`ck_` key) |
| [`landledger`](../../plugins/landledger) | TypeScript, 7120/7220 | Landledger (Budget Check; Cost Query; Request Create, Get, List, Mark Applied; Reservation Create, Release; Period Status; Decision Relay, flows only), **Landledger Trigger** (webhook registered through the API, Standard Webhooks signature) ([landledger.md](landledger.md)) | Landledger API (`ll_` key) |

The [`grafana`](../../plugins/grafana) plugin (TypeScript, 7102/7202) has Get Alerts, Get Alert Details and Acknowledge Alert; each declares the `grafana_alertmanager_api_token` credential (`url` ending in `/api/alertmanager/grafana`, and a token; the **API Token** field is a password field: masked on the screen and never returned by the credential's API), so the node panel and an agent's tool dialog offer the picker. The two reads are idempotent; Acknowledge Alert creates a silence (`POST …/api/v2/silences`, matching `alertname = <Alert Name>` for an hour; it needs an Editor service-account token, a Viewer token gets the message *The Grafana token cannot create silences*; a 404 says the URL must end in `/api/alertmanager/grafana`). Get Alert Details reads the alert by its name (`GET …/api/v2/alerts?filter=alertname="<name>"`: Alertmanager has no alert-by-id path) and answers its labels, annotations, state and start; with no match it says *No firing alert named <name>*. To check them, start the local Grafana: [deployment](../deployment.md#ports-credentials-and-urls).

Run them with `pnpm plugin:messaging`, `plugin:productivity`, `plugin:google`, `plugin:databases`, `plugin:linear`, `plugin:attio` and `plugin:fathom` (all included in `pnpm dev:all`). The last three are the [alert triage](../triage.md) plugins: they install from the repository's marketplace with their flows, or run with `pnpm plugin:landfall`, `plugin:triage` and `plugin:threat-intel` (not in `dev:all`). Every credential has an overridable base URL or host, so each plugin's tests run against local fakes of the service; no test needs a real account.

**Credentials.** Plugins declare credential types (fields, secrets, a connection test) in their manifest. The host keeps saved credentials in an AES-256-GCM vault (`.data/credentials.json`, key from `LANDFLOW_ENCRYPTION_KEY` or a generated `.data/encryption.key`). Workflows only reference them by id, the API never returns secrets, and each Execute call carries just the decrypted credentials that node declared. The **Credentials** page and the picker at the top of a node's parameters create, edit and test them ("Authenticated as @landflow_bot"). The SDKs mask credential values in logs, span attributes and error messages.

**Who changed it.** Every credential records who created it (`createdBy`) and who last changed its data (`updatedBy`,
migration 2092; the same fields in `credentials.json` in files mode), and the credential dialog shows "Last changed by".
A save that changes a value records the person who saved it: the form, `PATCH /api/credentials/:id`, a Git or
environment pull (the person who pulled). The decrypted values are compared, secrets included, and the form sends only
the fields that were edited, so a save that changes none of them (an empty `data`, the form saved as it was, a secret
left empty, which keeps its value), a rename or a rate limit alone keeps the last changer. A token operation (Connect,
Get token, Refresh now, Disconnect) by an active owner or admin keeps it, and anyone else's records them (Connect: the
person who started it, carried in the signed OAuth state). A change with no person behind it records nobody; a token
refresh, an error note and an encryption key rotation keep the last changer. Credentials from before migration 2092
show nobody. Nothing Landflow sends on everyone's behalf trusts a credential because of who changed it: the nightly
briefing's Slack delivery uses no credential at all, only the server's `LANDFLOW_BRIEFING_SLACK_TOKEN`
([work-and-briefings.md](../work-and-briefings.md#the-nightly-sync)).

**OAuth2 (Connect).** The host's **OAuth2 API** credential (`core.oAuth2Api`) and every plugin type that `extends` it (Google OAuth2 does) have a **Connect** button: it runs the provider's consent page in a popup (authorization code with PKCE, or plain authorization code; signed `state` and a per-flow cookie), stores the tokens encrypted, and shows "Connected as alice@example.com" with the expiry. The client credentials grant gets its token with **Get token** (or at first use). Presets fill in Google, GitHub, Slack, Microsoft, Notion, Discord, HubSpot and Airtable. The plugins ship OAuth2 variants of their token credentials, with the provider's URLs and default scopes fixed (a field a type marks `hidden` with a default is never stored, so neither the form nor the API can change it): Google OAuth2, Slack OAuth2 (bot scopes), Discord OAuth2 (`identify guilds`, plus an optional bot token for channel calls), GitHub OAuth2, Notion OAuth2, Airtable OAuth2 (PKCE), HubSpot OAuth2 and Jira Cloud OAuth2 (Atlassian 3LO: the node looks the site's cloud id up and calls `api.atlassian.com`; chosen with the Jira node's **Jira Version: Cloud (OAuth2)**). Their nodes have an **Authentication** switch (token, the default, or OAuth2) and also accept whichever of the two credentials is set. Register the **Redirect URL** the dialog shows with the provider: `<LANDFLOW_PUBLIC_URL>/api/oauth2/callback` (override with `LANDFLOW_OAUTH2_REDIRECT_URL`). Nodes get a fresh `accessToken` on every call: the host renews tokens that expire within a minute, and when a node fails with a 401 it renews the token and runs the node once more; a token that can't be renewed fails the node with "reconnect it in Credentials". **Refresh now**, **Reconnect** and **Disconnect** are in the dialog; the Credentials list shows connected / not connected / expired. The **HTTP Request** node's **Authentication** (Generic credential type: OAuth2, Bearer token or header auth) uses them. Protocol details: [docs/protocol.md](../protocol.md#oauth2-credentials-extends).

**Local credentials.** The **SQLite** credential has **Create If Missing** (shown while Read Only is off): with it on, a path with no file gets an empty database file when the credential is tested or a node first runs (the folder must exist, and the error names it when it does not); with it off, a missing file fails with "create it first, or turn on Create If Missing", so a typo never makes an empty database. Read Only and Create If Missing together are refused. **Send Email** over SSL/TLS to a server that answers in plain text (a local mail catcher such as Mailpit, on any port) says "The server on <host>:<port> answers without TLS: turn SSL/TLS off" instead of blaming the certificate; STARTTLS is used automatically when a server offers it, and a real certificate failure keeps the "not trusted" hint.

**HTTP Request and the outbound policy.** The node's calls (and `ctx.http` of every in-process node) go through `safeFetch`: in the production profile a URL that is, or resolves to, a loopback, private, link-local or metadata address, or that a redirect leads to, fails with "Blocked: <host> resolves to a private address" unless `LANDFLOW_OUTBOUND_ALLOW` lists the host or range ([audit-and-governance.md](audit-and-governance.md#outbound-requests)). Development is unchanged. Plugins are separate processes and make their own calls.

**Polling triggers.** A node with `triggerSource: "poll"` is called by the host every `pollInterval` seconds with the state it returned last time, and a run starts only when it returns new items. The first poll records a baseline, so activating a workflow never replays history; **Execute** in the editor shows the latest few items. The node panel shows the poll status (last poll, new items, errors) with **Poll now**.

**Activity items.** The integrations that report what people do (Slack, Google Drive and Calendar, Notion, Linear, Attio, Fathom) output one shape, the [activity item](../protocol.md#16-activity-items): a stable `sourceId`, URL, author email, time, a suggested event kind (`work.discussion`, `work.doc_edited`…), title, a summary of at most 600 characters, team, initiative and customer hints, and the trimmed vendor object. Each has a trigger (an app webhook where the vendor can call Landflow, else a poll with a cursor whose first poll replays nothing) and a **List Changed Since** operation for backfill and catch-up, so one flow can record any of them.

## Work ingest templates

Built-in templates (**Templates → Productivity**) that feed the [second brain](../second-brain.md) from the activity integrations.
Each is the source's trigger, then **Record work event** (Record Event with kind `{{ $json.kind }}`, the item's fields as the
attributes of the [`work.*` kinds](../second-brain.md#your-own-event-kinds), **Declare Kind If New** on), and two branches that
keep the item's `customerHint` as a customer and its `initiativeHint` as an initiative (Entity → Create or Update, the id made
from the name, so the same customer from Slack and Drive is one entity):

| Template | Trigger | Kinds |
|---|---|---|
| `work-slack-activity` | Slack Activity Trigger (Events API) | `work.discussion` |
| `work-google-drive` | Google Drive Trigger (poll) | `work.doc_edited` |
| `work-google-calendar` | Google Calendar Trigger (poll) | `work.meeting_scheduled`, `work.meeting_held` (`work.meeting_cancelled` when asked) |
| `work-notion` | Notion Trigger (poll) | `work.doc_edited` |
| `work-linear` | Linear Trigger (webhook) | `work.bug_reported`, `work.feature_request`, `work.ticket_moved`, `work.release`, `work.self_update`, `work.discussion` |
| `work-attio` | Attio Trigger (webhook) | `work.deal_moved`, `work.deal_won`, `work.discussion` (notes), `work.action_item` (tasks) |
| `work-fathom` | Fathom Trigger (webhook, transcripts off) | `work.meeting_held`, `work.action_item` (one item per action item) |
| `work-github` | GitHub Webhook Trigger (webhook, productivity plugin) → GitHub to Work Event | `work.pr_opened`, `work.pr_merged`, `work.pr_closed`, `work.pr_reviewed`, `work.review_requested`, `work.ci_failed`, `work.ci_passed`; the repository as a `system` |
| `work-google-directory` | Schedule, daily at 6 → Google Directory → Entity | none: each person as a `person` entity keyed by email, with title, department, org unit and manager |

Declare the kinds first with `pnpm brain:work-kinds` (the templates' fallback declares a kind from the first event's fields,
all optional; for `work-github` prefer the script, since the fallback drops any field the first event leaves unset). The events and entities show on the [Brain page](../second-brain.md#the-brain-page): a page per person, customer and
initiative with its work, and what two or more teams worked on this week.

The Linear, Attio and Fathom templates also ship as marketplace flows (`plugins/<name>/flows/work-<name>.json`, exported
from the built-in ones) with their plugins in the repository's marketplace (`.claude-plugin/marketplace.json`), so an
instance that doesn't run those plugins can install one with its flow from **Marketplace**. An instance that runs them
already (`pnpm dev:all`, compose) has the built-in templates and needs no install.

## GitHub into the brain

`work-github` ("Work from GitHub into the second brain") turns GitHub deliveries into work events, so pull requests, reviews
and CI that happen outside Claude Code show up in the brain. The flow is the productivity plugin's **GitHub Webhook Trigger**
(events `pull_request`, `pull_request_review`, `workflow_run`, `status`), then **GitHub to Work Event**, then **Record work
event**, and the repository kept as a `system` entity.

**GitHub to Work Event** (`core.githubWorkEvent`) reads a trigger item (the `x-github-event` header and the body) and outputs
zero or one flat item. Anything else, such as a push, a comment, a label or a pending status, outputs nothing.

| Delivery | Kind | `sourceId` |
|---|---|---|
| Pull request opened | `work.pr_opened` | `<repo>#<pr>:opened` |
| Pull request closed and merged | `work.pr_merged` | `<repo>#<pr>:merged` |
| Pull request closed, not merged | `work.pr_closed` | `<repo>#<pr>:closed` |
| Review requested | `work.review_requested` | `<repo>#<pr>:review_requested:<reviewer>` |
| Review submitted (approved, changes requested, commented) | `work.pr_reviewed` | `<repo>#<pr>:reviewed:<review id>` |
| Workflow run completed (success; failure, timed out) | `work.ci_passed`, `work.ci_failed` | `<repo>#<pr>:<kind>:<run id>:<attempt>` |
| Commit status (success; failure, error) | `work.ci_passed`, `work.ci_failed` | `<repo>@<sha7>:<kind>:<status id>:1` |

The `sourceId` is stable, and the trigger starts no second run for a redelivery (its `X-GitHub-Delivery` key). Record Event itself does not replace an earlier event with the same `sourceId`, so running a pinned delivery again records it again. A review also carries `waitedMs`
(from the pull request's creation to the review) and a CI result carries its conclusion, duration and attempt, recorded as
`ciConclusion`, `ciDurationMs` and `ciAttempt` because event attributes are flat.

**Recorded:** repository, pull request number and link, title, state, a review's state, timing, CI results, and the first
300 characters of a pull request's description (emails and secrets redacted). **Never recorded:** diffs, code, commit
contents, file names, or what a review or comment says.

**People.** Set **People** on the node to a JSON table of GitHub login to email, such as `{"octo-dev": "dev@example.com"}`. Only
that table sets the event's actor email, so person pages match; without it the actor is the login.

**Setup.** The productivity plugin must run. The token needs `admin:repo_hook` (or fine-grained Webhooks read and write) on the
repository, and Landflow must be reachable from GitHub, because publishing registers the webhook. To try it without GitHub,
pin a delivery on the trigger and run the flow. Declare the kinds once with `pnpm brain:work-kinds`, as the template's setup
says. **Record work event** has **Declare Kind If New** on, so a kind not declared yet is declared from its first event
instead: that works, but the kind keeps only the fields that first event set (a first commit status has no
`prNumber`, so later pull request numbers of that kind are dropped); the script declares every field. `POST
/api/brain/work` never declares the GitHub-only kinds itself. The five GitHub-only kinds list
their own fields in `deploy/brain/work-kinds.json` (a kind declares at most 20), so `work.pr_opened` and `work.pr_merged`,
which keep the shared fields for the tools that also send them, drop `prNumber`, `state` and the like.

**App webhook triggers.** A node with `triggerSource: "appWebhook"` registers a webhook at the service when its workflow is published and removes it when it is unpublished, so events arrive as they happen instead of on a poll. The TypeScript, Go and Python SDKs check GitHub (`X-Hub-Signature-256`), Stripe (`Stripe-Signature`, with a timestamp tolerance) and Slack (`X-Slack-Signature`) signatures in constant time ([docs/protocol.md §12](../protocol.md#12-app-webhook-triggers)).
