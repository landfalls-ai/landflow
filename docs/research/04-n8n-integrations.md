# 04: n8n integrations, which ones matter, and what Landflow builds

> Research target: **n8n 2.44** (the Docker container `n8n`). The node catalogue was dumped from the container's
> `n8n-nodes-base` and `@n8n/n8n-nodes-langchain` packages: every node's name, group, categories, credentials,
> resources and operations. Usage comes from public deployment statistics. Researched 2026-10-25.

## Sources

| Source | What it gave us |
|---|---|
| The `n8n` container (`n8n-nodes-base` 2.44.4, `@n8n/n8n-nodes-langchain` 2.44.4) | The full catalogue: 445 base nodes, 123 AI nodes, 412 credential types, operations per node |
| [n8n-stats.gui.do/nodes](https://n8n-stats.gui.do/nodes) | Popularity: nodes ranked by estimated deployments across public workflows |
| [restyler/awesome-n8n](https://github.com/restyler/awesome-n8n) | The community-node landscape and which integrations people extend most |
| [nexos.ai: n8n integrations](https://nexos.ai/blog/n8n-integrations/) | How integrations are grouped and used in practice (messaging, Google Workspace, CRM, databases, AI) |

## 1. The catalogue at a glance

n8n 2.44 ships **445 nodes** in `n8n-nodes-base` plus **123** in the LangChain package. 108 of the base nodes are triggers.
They reference **412 credential types**, because most services have two or three ways to authenticate (API key, OAuth2, service
account, self-hosted variants).

| Category | Nodes | | Category | Nodes |
|---|---:|---|---|---:|
| Development | 119 | | Sales | 46 |
| Communication | 108 | | Utility | 26 |
| Core Nodes | 73 | | Finance & Accounting | 16 |
| Data & Storage | 62 | | Analytics | 13 |
| Marketing | 54 | | Human in the loop | 9 |
| Productivity | 51 | | | |

(A node can be in more than one category.)

## 2. What people actually use

Usage is heavily skewed: the long tail of 400+ integrations matters far less than the top 50. Ranked by estimated deployments
([n8n-stats](https://n8n-stats.gui.do/nodes)), the top of the list is core nodes and AI, then a handful of app families:

1. **Core and flow**: Sticky Note, HTTP Request, Edit Fields (Set), Code, If, Wait, Manual Trigger, Merge, Schedule, Switch,
   Filter, Split Out, Loop Over Items (Split In Batches), Aggregate, Webhook, Extract From File, Convert to File, Cron, Error Trigger,
   GraphQL.
2. **AI**: OpenAI Chat Model, AI Agent, OpenAI, Simple Memory, Structured Output Parser (all in the top 15).
3. **Google Workspace**: Google Sheets (#7 overall), Google Drive, Gmail, Google Docs, Google Drive Trigger, Google Calendar.
4. **Messaging**: Telegram (#9) and Telegram Trigger, WhatsApp Business Cloud, Slack, Microsoft Outlook, Discord, Email.
5. **Productivity, dev and CRM**: Airtable, Notion, GitHub, Jira, HubSpot, RSS Read and RSS Feed Trigger.
6. **Databases**: Postgres, Redis, Supabase, MySQL.
7. **Other**: Facebook Graph API, X (Twitter), OpenWeatherMap.

The pattern behind the ranking: people chain a trigger (schedule, webhook, chat, a poll on Gmail/RSS/Sheets), an AI step, a
handful of data-shaping nodes, and one or two app actions (post to Telegram or Slack, append a row to Sheets, write to Notion
or Postgres).

## 3. How n8n integrations are shaped

Reading the descriptors of the top integrations shows a consistent design. Landflow copies it.

- **Resource → operation.** One node per service, with a `resource` picker (message, chat, file…) and an `operation` picker per
  resource. Telegram has 4 resources and 26 operations, Slack 7 and 38, GitHub 9 and 30. Most workflows use two or three of
  them: send a message, append or read rows, create an issue, run a query.
- **Credentials as separate, testable objects.** Nodes reference saved credentials; secrets never sit in workflow JSON. Many
  credential types implement a test request (Telegram `getMe`, Slack `auth.test`), shown as "Connection tested successfully".
  Services offer several auth variants (Slack: API token and OAuth2; Jira: Cloud, Server and PAT).
- **Two kinds of triggers.** *Webhook* triggers register a callback with the service (Telegram Trigger, GitHub Trigger, Slack
  events) and need a public URL. *Polling* triggers (`polling: true`: Gmail, Google Sheets, Google Drive, RSS Feed, Airtable)
  call the API every N minutes and keep "static data" (the newest id or timestamp seen) between polls. The first poll only
  records where to start.
- **Pickers load live.** `loadOptions` methods list channels, spreadsheets, databases or labels with the user's credential.
- **"Return All" or "Limit"** on every list operation, with pagination handled by the node.
- **"Simplify"** on verbose APIs (Notion, HubSpot) returns flat fields instead of the raw API object.
- **Self-hosted variants.** Base URLs or hosts are configurable where the service can be self-hosted (Jira Server, GitHub
  Enterprise, any SQL server).
- **Usable as AI tools.** Most action nodes set `usableAsTool`, so an AI Agent can call them.

## 4. What Landflow builds

Landflow already has the core nodes people use most: Manual, Webhook, Schedule and Chat triggers, HTTP Request, Edit Fields,
Code, If, Filter, Merge, Wait, Limit, Sort, No Operation, Stop and Error, the AI Agent, Anthropic and Ollama chat models, Simple
Memory and Calculator. The plan below adds the rest of the top 50 that fits the plugin model. Every integration is a plugin in
its own process, built on the SDK of a different language, so the catalogue also exercises all three SDKs.

| Plugin (language, id) | Nodes | Credential types | Triggers |
|---|---|---|---|
| **Core** (TypeScript, in the host) | Switch, Split Out, Aggregate, Remove Duplicates, Summarize, Date & Time, Rename Keys, Record Metric; OpenAI Chat Model (any OpenAI-compatible API, so it also runs on Ollama's `/v1`), OpenAI, Basic LLM Chain, Text Classifier, Information Extractor | OpenAI API | — |
| **Messaging** (TypeScript, `messaging`) | Telegram, Slack, Discord, WhatsApp Business Cloud, Send Email (SMTP) | Telegram API, Slack API, Discord Bot / Webhook, WhatsApp Cloud API, SMTP | Telegram Trigger (polls `getUpdates`) |
| **Productivity** (Python, `productivity`) | Notion, Airtable, GitHub, Jira, HubSpot, RSS Read | Notion API, Airtable token, GitHub token, Jira (Cloud email + token, or Server PAT), HubSpot private app token | GitHub Trigger (new issues, PRs or releases), RSS Feed Trigger |
| **Google Workspace** (Go, `google`) | Google Sheets, Gmail, Google Drive, Google Calendar, Google Docs | Google service account, Google OAuth2 (refresh token) | Gmail Trigger (new messages), Google Sheets Trigger (new rows) |
| **Databases** (Go, `databases`) | Postgres, MySQL, Redis, SQLite | Postgres, MySQL, Redis, SQLite file | Postgres Trigger (new rows) |

Operations follow n8n's names, cut down to the ones most workflows use:

| Node | n8n operations | Landflow v1 |
|---|---|---|
| Telegram | 26: send/edit/delete/pin messages, media, chat admin, callbacks | Send message, send photo, edit message text, delete message, send chat action, get chat |
| Slack | 38: channels, messages, files, reactions, users | Post message, update, delete, get permalink, list channels (live picker), look up user by email, add reaction |
| Google Sheets | 9: append, appendOrUpdate, read, update, clear, create… | Append row, append or update, read rows (with filters), update row, clear, create spreadsheet |
| Gmail | 13: send, reply, get, getAll, labels, read state, trash | Send, reply, get, get many (search query), add/remove labels, mark as read/unread |
| Notion | 9: pages, data sources, blocks, search | Create page, get page, search, query database, append blocks, archive page |
| Airtable | 8: create, upsert, get, search, update, delete, getMany | Create, upsert, get, search (formula), update, delete |
| GitHub | 30: issues, PRs, files, releases, repos | Create/get/edit issue, comment, list issues, get repository, list releases, get file |
| Jira | 10: issues, comments, transitions | Create, get, search (JQL), update, transition, add comment |
| HubSpot | 11: contacts, companies, deals | Create or update contact, get contact, search contacts, create deal |
| Postgres / MySQL | 6: executeQuery, select, insert, upsert, update, delete | Execute query (parameterised), select, insert, upsert, update, delete |
| Redis | 10: get, set, delete, incr, keys, push, pop, publish, info | All ten |

Three decisions deserve a note:

- **Telegram Trigger polls instead of using a webhook.** n8n's Telegram Trigger registers a webhook, which needs a public HTTPS
  URL. A self-hosted or local Landflow usually has none, so the trigger uses Telegram's long-poll API (`getUpdates`) with the
  update offset as poll state. A webhook mode can come later, through the host's existing Webhook trigger.
- **Polling is a protocol feature, not a node trick.** A node declares `triggerSource: "poll"` and a `pollInterval`. The host
  calls it on schedule with the state the last poll returned, persists the new state, and starts a run only when there are new
  items ([protocol §8](../protocol.md#8-polling-triggers)). Plugins stay stateless, and any SDK gets polling triggers for free.
- **Every integration takes a base URL.** Each credential (or node) has an overridable API base URL or host, as n8n does for
  self-hosted services. It also lets every plugin's tests run against a local fake of the API, with no real accounts or tokens.

## 5. Observability built into every integration

Each plugin is instrumented the same way (names in [observability.md](../observability.md)):

- Incoming calls continue the host's trace. A workflow run shows up as one trace: `workflow.execute` → `node.execute` →
  `plugin.rpc Execute` → the plugin's `plugin.execute` → its HTTP or database client spans (`GET api.telegram.org`,
  `db.query SELECT orders`).
- Every log line carries `trace_id` and `span_id`, and secrets are redacted.
- Automatic metrics per plugin (executions, duration, items) plus integration metrics, for example messages sent by Telegram
  or Slack, rows appended to Sheets, query duration by database system, and new items found per poll.
- The **Record Metric** node lets a workflow publish its own business metrics (`landflow.flow.<name>`), next to the host's
  execution, node, trigger, plugin and AI metrics.

## 6. Left out, and why

- **Sticky Note** (the #1 node) is a canvas feature, not an integration. It is tracked as a UI gap in [ui-review.md](../ui-review.md).
- **Loop Over Items, Error Trigger and Execute Workflow** need engine features (loops in the graph, error workflows,
  sub-workflows) rather than plugins.
- **Extract From File and Convert to File** need binary data in the protocol, which Landflow does not carry yet.
- **OAuth2 consent flows.** Landflow credentials take tokens directly: API tokens, service-account keys, or an OAuth2
  refresh token obtained elsewhere. A hosted "Connect with Google" button needs a redirect URL and an OAuth app per deployment.
- **Facebook Graph API, X, Supabase, Microsoft Outlook and Teams** come next. They fit the same plugin shape. Supabase also works
  today through the Postgres node or HTTP Request.
