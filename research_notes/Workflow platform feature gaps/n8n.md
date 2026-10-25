# n8n feature set (1.x through 2.45, late 2026) vs. Landflow

Snapshot date: 2026-10-25. The latest n8n release on the official release-notes page is **2.45 (2026-10-20)**, and **n8n 3.0 is announced as "releasing soon"** with no date given ([release notes](https://docs.n8n.io/release-notes/); [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes)). Facts marked **[not re-fetched]** come from long-standing n8n docs pages that I did not reopen this session. They describe stable, years-old behaviour, but the report writer should treat their exact details (env-var names, defaults) as unverified. n8n restructured its docs in 2026 (new paths such as `docs.n8n.io/build/...` and `docs.n8n.io/deploy/...`), so some older URLs may redirect.

## What did n8n ship in 2025–2026 (n8n 2.0 and later), by feature area?

### Takeaway
n8n changed in two big steps. Through 2025 (1.85 to 1.123) it added a large AI and data layer: folders, MCP, Insights, Evaluations, Data Tables, the AI Workflow Builder and the Python runner. **n8n 2.0 (December 2025)** was a security-hardening release: task runners on by default, env access blocked, a draft/publish model, and legacy modes removed. Then 2.1 to 2.45 (2026) added autosave plus version compare, Chat Hub, a standalone **Agents** product (preview), instance-level MCP, data redaction, webhook signature verification, an AI gateway, and Browser/Computer Use. n8n 3.0 is about to require Docker for self-hosting, remove many legacy nodes and **retire Chat Hub**.

### Cited Findings

#### Release timeline and versioning
- **n8n 2.0 dates:** n8n's pre-launch announcement planned "Version 2.0.0 (beta) on Dec 8th. Version 2.0.x (stable) on Dec 15th" (2025). Third-party write-ups say stable shipped December 15, 2025 after five release candidates — [community announcement](https://community.n8n.io/t/announcing-n8n-version-2-0-coming-soon/226475); [Zeabur blog](https://zeabur.com/blogs/whats-new-in-n8n-2-0); [GrowwStacks](https://growwstacks.com/blog/n8n-2-update-breaking-changes). The official release notes, however, date **2.1 at 2025-12-15** ([release notes](https://docs.n8n.io/release-notes/)), so the exact 2.0 stable date is not confirmed by a primary source.
- The **1.x line kept getting patches in parallel**. The last 1.x release listed is **1.123.62, dated 2026-06-29**, and the 1.x notes page is now archived as "Release notes pre 2.0" — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Release channels were renamed in 2.0:** `latest` became `stable` and `next` became `beta` — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes).
- **Release cadence in 2026 is weekly minor versions:** 2.3 (2026-01-05), 2.4 (01-12), 2.5 (01-20) … 2.43 (10-06), 2.44 (10-13), 2.45 (10-20) — [release notes](https://docs.n8n.io/release-notes/).

#### n8n 2.0 breaking changes (what "2.0" actually means)
Source for all bullets: [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes).
- **Publish model:** The active/inactive toggle is replaced by **Publish/Unpublish**, "so work-in-progress changes don't go live by accident." The CLI `update:workflow` is deprecated in favour of `publish:workflow` (id plus optional versionId) and `unpublish:workflow`. The external hook `workflow.published` replaces `workflow.activeChange`.
- **Security defaults:**
  - **Task runners are on by default** for all Code node executions.
  - `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, so Code nodes can't read env vars.
  - `$evaluateExpression` is removed from the Code node.
  - The `n8nio/n8n` image no longer bundles the external runner (use `n8nio/runners`).
  - Config files must have 0600 permissions.
  - `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK=false`, so OAuth callbacks need authentication.
  - `N8N_RESTRICT_FILE_ACCESS_TO` limits the file nodes to `~/.n8n-files`.
  - Git node bare repos are blocked.
  - **Execute Command and Local File Trigger nodes are disabled by default.**
- **Python:** The Pyodide-based Python Code node and tool are removed. Python now requires **external-mode task runners** (native Python, no `_input` dot notation).
- **Sub-workflows:** When a child workflow pauses (Wait, webhook, form, human-in-the-loop), the parent now receives the child's **final output** rather than its input.
- **Start node removed.** Use Manual Trigger or Execute Workflow Trigger instead.
- **Data and storage:**
  - MySQL/MariaDB are dropped as the n8n DB (Postgres or SQLite only).
  - The legacy SQLite driver is removed. The pooled WAL driver (pool size 2) is "up to 10x faster."
  - The in-memory `default` **binary data mode is removed**. The options are `filesystem`, `database` and `s3`.
- **Queue mode:** `QUEUE_WORKER_MAX_STALLED_COUNT` and the Bull stalled-job retry are removed, so stalled jobs no longer auto-retry.
- **Other removals:** `N8N_CONFIG_FILES` and `n8n --tunnel`. A **Migration Report** tool (Settings, global admins) flags affected workflows.

#### n8n 3.0 (upcoming as of 2026-10-25)
Source for all bullets: [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Docker is required for self-hosting.** npm/`npx n8n` installs are no longer supported, and no runnable `n8n` npm package is published.
- **Many legacy nodes are removed:** Function, Function Item, Item Lists, LangChain Code, Cron, Interval, HTML Extract, iCalendar, Read PDF, Workflow Trigger, legacy OpenAI/Assistant, legacy HTTP Request Tool, SerpApi, Manual Chat Trigger, Motorhead, Zep, and several loader and vector-store nodes.
- **AI Agent v1** is removed along with its SQL, Conversational, OpenAI Functions, Plan-and-Execute and ReAct modes. Tools Agent is the only mode left.
- **AI Transform** nodes auto-migrate to Code nodes. `$getPairedItem` is removed. Execute Sub-workflow loses its Local File and URL sources.
- **Chat Hub is off by default in 3.0 and removed in 4.0.** It can be kept on via `N8N_ENABLED_MODULES=chat-hub`. "Import from URL" and the Code node's "Ask AI" tab are also removed.
- **Security:**
  - Encryption key rotation is on by default.
  - A Slack signing secret is required.
  - The SSRF block list is extended.
  - Compression limits are 256 MiB and 1,000 zip entries.
  - `N8N_UNVERIFIED_PACKAGES_ENABLED=false`.
  - `N8N_RUNNERS_TASK_TIMEOUT` drops from 300 to 60 s.
  - In queue mode, manual executions always run on workers.

#### Data Tables
- **Introduced in 1.113.1 (2025-09-23)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/). A Medium post called native tables "the missing feature in n8n" — [Medium](https://medium.com/@julio.pessan.pessan/the-missing-feature-in-n8n-has-arrived-native-tables-0aff45e761e1).
- **Later additions** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.1 (2025-12-15): column renaming
  - 2.3 (2026-01-05): Data Table node CRUD for whole tables
  - 2.10 (2026-02-23): CSV import column controls
  - 2.11 (2026-03-03): search, sort and project badges
  - 2.16 (2026-04-07): agent permissions on data tables
  - 2.18 (2026-04-21): favorites
  - 2.27 (2026-06-16): create from the universal add menu
  - 2.30 (2026-07-07): Clear operation, and Update renamed to Rename
- **Limits:** The default total storage per instance is **200 MiB** (older docs said 50 MB). Self-hosters can change it with `N8N_DATA_TABLES_MAX_SIZE_BYTES`. A warning appears at 80%. Once over the limit, manual additions are disabled and inserts/updates fail. The docs position tables as "light to moderate data storage" — [Data tables docs](https://docs.n8n.io/build/work-with-data/data-tables); [older Data tables page](https://docs.n8n.io/data/data-tables/).
- There is also a public API resource for data tables — [n8n API: Data Table](https://docs.n8n.io/connect/n8n-api/data-table).
- **Plans:** Data tables are listed for Starter, Pro and Enterprise on Cloud — [pricing](https://n8n.io/pricing/).

#### Evaluations (AI testing)
- **Introduced in 1.95.0 (2025-05-26).** You test an AI workflow against a dataset of inputs and score the outputs with metrics. Datasets initially lived in Google Sheets — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Built-in metric-based evaluations arrived in 1.103.0 (2025-07-14)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **2.21 (2026-05-12):** redesigned evaluation run detail page, live run status, cancel/re-run, and a concurrency cap — [release notes](https://docs.n8n.io/release-notes/).
- **Plan gating** — [pricing](https://n8n.io/pricing/):
  - Starter: "Light" evaluations on all workflows, but metric-based on only 1 workflow.
  - Pro and Enterprise: unlimited light and metric-based evaluations.

#### MCP (Model Context Protocol)
- **MCP Server Trigger and MCP Client Tool both arrived in 1.88.0 (2025-04-10).** The Server Trigger "turns n8n into an MCP server, providing n8n tools to models running outside of n8n." The Client Tool lets n8n agents use tools from external MCP servers — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Later 1.x additions:** MCP Client Tool OAuth support in 1.119.0. **Instance-level MCP connections (beta) in 1.121.0 (2025-11-18).** A standalone MCP Client node (not just a tool) in 1.122.0 (2025-11-24) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **2.x additions** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.2 (2025-12-22): connect workflows to MCP from settings
  - 2.17 (2026-04-13): MCP tool names prefixed with the server name
  - 2.25.1: project/folder bulk MCP access changes
  - 2.26: paginated MCP workflows table
  - 2.27 (2026-06-16): n8n OAuth2 option on the MCP Server Trigger
  - 2.31 (2026-07-14): **instance-level MCP settings GA**
  - 2.32 (2026-07-21): scope selection on the MCP OAuth consent screen, plus Mine/All tabs and filters for connected MCP clients
  - 2.36 (2026-08-18): MCP Server Trigger "instructions" field
- Agents can be managed through n8n's instance-level MCP server — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- n8n ships **official skills** that work with MCP, so coding agents (Claude Code, Codex) can build production workflows. They install as Claude Code/Codex plugins — [CreateWith](https://www.createwith.com/tool/n8n/updates/n8n-ships-official-skills-for-agent-driven-workflow-creation); [agent-builder skill](https://www.skills.sh/n8n-io/n8n/agent-builder).

#### AI Workflow Builder / n8n Assistant
- **AI Workflow Builder (beta) arrived in 1.115.0 (2025-10-06)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **2.x additions** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.9 (2026-02-16): "Focused Nodes" for the AI Builder and a setup panel with credential setup cards
  - 2.11: rich messages
  - 2.25.1: plan review in the chat input
  - 2.23: separate Deny button on plan approval
  - 2.28: "Instance AI" editor hand-offs open threads with the current workflow attached
  - 2.33 (2026-07-28): redesigned instance settings for the n8n Assistant (model, sandbox and search connections stored as instance-scoped credentials)
  - 2.40 (2026-09-15): "n8n Assistant rename"
- **Cloud billing:** Each builder message that creates or modifies a workflow counts as one interaction, worth one credit. Cloud plans include Assistant credits (Starter 1,600/mo, Pro up to 9,600/mo) — [AI Workflow Builder docs](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder); [pricing](https://n8n.io/pricing/).
- **Self-hosted:** n8n Assistant uses no credits and runs on your own AI provider account. It is listed for Community, Registered Community and Business, but **not yet for Enterprise** — [n8n Assistant docs](https://docs.n8n.io/build/ways-of-building-workflows/n8n-assistant); [Assistant credits](https://docs.n8n.io/deploy/use-n8n-cloud/assistant-credits); [AI Assistant docs](https://docs.n8n.io/build/ways-of-building-workflows/ai-assistant).
- **AI gateway / "Gateway credits":** n8n-provided model access billed in credits, available from 2.36.0. Cloud only, not on Cloud Enterprise or self-hosted. Gateway usage rows link to executions (2.18.5) — [Gateway credits](https://docs.n8n.io/deploy/use-n8n-cloud/gateway-credits); [release notes](https://docs.n8n.io/release-notes/).

#### Agents (standalone, preview), Browser Use, Computer Use
- **Status and availability:** Agents are a **Preview** feature on all Cloud plans and on all self-hosted plans **from n8n 2.32.3**. They are on by default, and admins can disable them. One agent turn counts as one execution — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- **Components** — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents):
  - Model and instructions
  - Tools: workflows, JSON-schema custom tools, built-in integrations and MCP servers
  - Web search: the model's native search, with Brave or SearXNG as fallback
  - **Skills**
  - **Knowledge base:** csv, pdf, md or txt files. Cloud has it; self-hosted needs a sandbox and is in preview.
  - **Memory:** session memory by default, plus *episodic* memory across sessions (requires an OpenAI credential)
  - **Sub-agents** with a parallelism cap
  - **Channels:** Slack, Telegram, Linear
  - **Schedules:** hourly to monthly, or cron
  - **Approvals:** Approve/Reject in chat
  - **Sessions tab**
- **Versioning:** The draft autosaves. Publishing snapshots it, with publish history and restore. Agents can't run in queue mode yet — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- **Using agents from workflows:** The **Message an Agent** node (streaming, session reuse, JSON-schema output) and the **Message an Agent Tool** let AI Agents delegate to agents — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- **2026 agent iterations** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.16: agent permissions for workflows and data tables
  - 2.25.1: fallback web search
  - 2.27: Computer Use can read local PDF and image files
  - 2.34: URL-addressable review inbox
  - 2.35: enhanced HITL approval for Slack/Telegram
  - 2.36: docked agent preview chat
  - 2.37: streaming for Message an Agent, and a Slack Agent view
  - 2.41: skills in their own agent card
  - 2.42: agent builder write lock, and queued messages in preview
  - 2.43 (2026-10-06): **Browser Use available to all users**, plus agent usage and budget settings
  - 2.44: agent setup checklist

#### Chat Hub and chat features
- **What it is:** Chat Hub is n8n's built-in chat UI for talking to multiple AI models, workflow agents and personal agents. It is available on all plans including Community Edition, while the "chat user" role is paid-only. A workflow is exposed via a Chat Trigger with "Make Available in n8n Chat" and a streaming-enabled AI Agent — [Chat Hub docs](https://docs.n8n.io/advanced-ai/chat-hub/); [Introducing Chat Hub](https://blog.n8n.io/introducing-chat-hub/); [beta announcement](https://community.n8n.io/t/announcing-chat-hub-beta/236446).
- **Known issue:** The Basic LLM Chain doesn't stream, so it breaks in Chat Hub — [community thread](https://community.n8n.io/t/chat-hub-breaks-basic-llm-chain/283939).
- **Chat Hub updates** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.6: newer models prioritized
  - 2.10: streaming canvas chat via the Chat SDK
  - 2.11: dynamic credentials in Chat Hub, and Chat Trigger suggested prompts
- **Deprecation:** Off by default in 3.0, removed in 4.0 — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes). Some users also asked how to hide it — [community thread](https://community.n8n.io/t/option-to-disable-or-hide-chat-hub-in-self-hosted-n8n-instances/246174).
- **Streaming:** AI Agent streaming, Chat and Webhook response streaming, and the **AI Agent Tool** node (agent-as-tool) all arrived in 1.103.0 (2025-07-14) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **3.0 change:** Chat Trigger WebSocket frames become typed JSON, and custom clients need `@n8n/chat` ≥1.31.0 — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Hosted/embedded chat** is listed on Cloud plans — [pricing](https://n8n.io/pricing/).

#### Other AI nodes
- **Model Selector node:** 1.100.0 (2025-06-23). **Guardrails node:** 1.119.0 (2025-11-03) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **New vector stores and embeddings** — [release notes](https://docs.n8n.io/release-notes/):
  - ChromaDB vector store (2.5)
  - Weaviate hybrid search (2.3)
  - Oracle Vector Store and ONNX Embeddings (2.23)
  - NVIDIA Nemotron Embeddings (2.26)
  - Pinecone Quick Connect (2.10)
- **AI Agent features** — [release notes](https://docs.n8n.io/release-notes/):
  - passes binary PDFs to models (2.28)
  - "force tool call" option (2.40)
  - Anthropic prompt caching (2.37, 2.42)
  - Text Classifier confidence scores (2.45)
- The Simple (in-memory) Vector Store still exists — [Simple Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreinmemory).

#### Insights dashboard
- **Introduced in 1.89.0 (2025-04-14)** as a dashboard of workflow performance over time, with a summary banner and time-saved tracking — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Plan gating** — [pricing](https://n8n.io/pricing/):
  - Starter: banner only
  - Pro: 7–14 day dashboard
  - Business: 30 days
  - Enterprise: up to 365 days, with hourly/daily/weekly granularity

#### Forms and human-in-the-loop (HITL)
- **n8n Form node (multi-page forms paired with the Form Trigger): 1.65.0 (2024-10-24)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Form updates** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.1: form name/label split
  - 2.3: **dynamic form fields**
  - 2.7: IP allowlisting
  - 2.25.1: **Form Trigger with n8n User Auth** (visitors must be logged in)
  - 2.31: Form node returns multiple binary files
- **Send and wait (HITL approvals in Gmail/Slack): 1.63.0 (2024-10-09)**, expanded in 1.73.0 (2024-12-19) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **HITL updates** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.5: Chat node send-and-wait approvals
  - 2.6: denial messages with feedback
  - 2.30: `respondedAt` timestamp
  - 2.35 (2026-08-11): enhanced HITL approval for Slack/Telegram
- The 2.0 sub-workflow change explicitly covers forms and HITL nodes inside child workflows — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes).

#### Workflow history, versions, publishing, autosave, collaboration
- **Autosave:**
  - **Autosave replaced manual save in 2.4 (2026-01-12)**, along with history retention set in hours or days.
  - 2.5: autosave retry with backoff. 2.7: autosave pauses offline.
  - 2.20: env var to disable autosave.
  - Source: [release notes](https://docs.n8n.io/release-notes/).
- **Version history:** 2.8 "Name version". **2.11 compare history versions (diff)**. 2.12 switch versions from the diff. 2.14 filter executions by workflow version. **2.22 Workflow Publish Timeline**. 2.6 unpublish from the list — [release notes](https://docs.n8n.io/release-notes/).
- **Collaboration and organization:** 2.10 tab-scoped collaboration locks. 2.15 canvas-only mode. **2.31/2.32 canvas groups** (with descriptions and stickies inside groups). 2.32 sub-workflow extraction includes AI sub-nodes. 2.18 favorites — [release notes](https://docs.n8n.io/release-notes/).
- **Workflow history retention by plan:** Starter 1 day, Pro 5 days, Enterprise 365+ days — [pricing](https://n8n.io/pricing/).
- **Folders (nested, in personal space or projects): 1.85.0 (2025-03-24)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Logs view** (bottom panel listing steps in execution order with I/O and status): 1.92.0 (2025-05-05) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Partial execution engine** aligned with production behaviour: 1.81.0 (2025-02-24) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Sub-workflow debugging:** 1.69.0 (2024-11-20) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).

#### Sub-workflows, error workflows, loops, webhooks (long-standing core)
- **Sub-workflows:** Execute Workflow / Execute Sub-workflow node plus Execute Workflow Trigger. Sub-workflows can also be exposed as AI tools. **[not re-fetched]** — [Execute Workflow docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/).
- **Recent sub-workflow changes** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.23 (2026-05-27): Execute Workflow Trigger v1.2 returns items from every run of the last node
  - 2.37: the "Any workflow" caller policy is deprecated (restricting which workflows may call a sub-workflow)
  - 2.15: error workflows appear in dependency tracking
- **Error workflows:** An Error Trigger node runs a designated "error workflow" when another workflow fails. It is set per workflow in workflow settings. **[not re-fetched]** — [Error handling docs](https://docs.n8n.io/flow-logic/error-handling/); [Error Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.errortrigger/).
- **Loop Over Items (Split in Batches):** processes items in batches of N with a loop-back and "done" output. Used for rate limiting and pagination. **[not re-fetched]** — [Loop Over Items](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/).
- **Respond to Webhook:** returns a custom HTTP response (JSON, text, binary, redirect, status code, headers) mid-workflow. **[not re-fetched]** — [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/). Webhook response streaming arrived in 1.103.0 — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Webhook security:** 2.21/2.22 (May 2026) added **webhook signature verification** to many trigger nodes (Microsoft Teams, AWS SNS, Box, Netlify, Linear and others). 2.28 added a Webhook **"Only Run If"** filter — [release notes](https://docs.n8n.io/release-notes/).
- **Execution control:** **2.3 (2026-01-05) "Stop All Executions"** — [release notes](https://docs.n8n.io/release-notes/).

#### Projects, RBAC, SSO, credentials
- **Custom project roles (Enterprise): 1.122.0 (2025-11-24)** — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
- **Role updates** — [release notes](https://docs.n8n.io/release-notes/):
  - Custom **instance** roles: Roles settings area in 2.28, create/edit/view pages in 2.29 (both behind a flag), and a confirmation when editing roles with assigned users in 2.33
  - 2.17: role management locked when mapped by SSO
  - 2.20: "Reveal redacted data" permission
  - 2.42: SSO as the primary sign-in
  - 2.34: OIDC logout opt-in
  - 2.14: secure invite links
- **Credentials** — [release notes](https://docs.n8n.io/release-notes/):
  - **2.1: credential resolvers for dynamic credentials**
  - 2.11: Quick Connect in the credential modal
  - 2.12: credential overwrite hiding
  - 2.25.1/2.31: "private credentials" renamed **"end-user credentials"**
  - many new OAuth2 options added through 2026 (Notion, Jira, Supabase, Snowflake PKCE, and others)
  - 2.35.4: `N8N_MANAGED_OAUTH_SHOW_SCOPES`
- **API keys:** users can rotate their own (2.28); redesigned settings pages (2.26, 2.34) — [release notes](https://docs.n8n.io/release-notes/).
- **Data redaction:** redacted execution data with a reveal flow (2.14), data redaction behind a license (2.16), redaction settings lockable at instance level (2.23) — [release notes](https://docs.n8n.io/release-notes/). "Enforce 2FA / execution data redaction" is Enterprise on Cloud — [pricing](https://n8n.io/pricing/).

#### Source control, environments, variables, external secrets, log streaming
- **Source control (Git):** 2.4 added a Git reflog operation, and 2.13 a folder tree in push/pull — [release notes](https://docs.n8n.io/release-notes/). Git source control and environments are Business/Enterprise only — [pricing](https://n8n.io/pricing/); [Community Edition features](https://docs.n8n.io/hosting/community-edition-features/).
- **Variables:**
  - Project-level variables arrived in 1.118.0 (2025-10-27) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
  - Project-scoped edit/delete came in 2.5 — [release notes](https://docs.n8n.io/release-notes/).
  - "Custom variables" are excluded from Community Edition — [CE features](https://docs.n8n.io/hosting/community-edition-features/).
  - "Global variables" are on Pro and Enterprise Cloud — [pricing](https://n8n.io/pricing/).
  - Variables are read in expressions via `$vars` **[not re-fetched]** — [Variables docs](https://docs.n8n.io/code/variables/).
- **External secrets** — [release notes](https://docs.n8n.io/release-notes/):
  - 2.7: multi-provider secret-store connection modal
  - 2.8: sharing and a project settings section
  - 2.9: deletion
  - 2.12: read-only mode
  - 2.13: opt-in roles (removed in 3.0, when project editors and admins get access by default — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes))
  - Enterprise only — [pricing](https://n8n.io/pricing/)
- **Log streaming** (forwarding audit and workflow events to external destinations such as syslog, webhook or Sentry): Enterprise only, and excluded from CE. **[not re-fetched for details]** — [CE features](https://docs.n8n.io/hosting/community-edition-features/); [pricing](https://n8n.io/pricing/); [Log streaming docs](https://docs.n8n.io/log-streaming/).

#### Scaling: queue mode, workers, task runners, binary data, pruning
- **Queue mode:** a main instance plus Redis plus worker processes. It is **included in CE**, while **multi-main** (HA) is not — [CE features](https://docs.n8n.io/hosting/community-edition-features/); [Queue mode docs](https://docs.n8n.io/hosting/scaling/queue-mode/) **[docs page not re-fetched]**. On Cloud, queue mode is Business/Enterprise — [pricing](https://n8n.io/pricing/). In 3.0, manual executions always run on workers — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Task runners:**
  - First appeared in 1.71.0 (2024-12-04) as opt-in beta, moving Code node JS to a separate process with "internal" and "external" modes — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
  - Native Python task runner (beta): 1.113.2 (2025-09-24) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
  - Default in 2.0 — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes).
  - Task timeout drops to 60 s in 3.0 — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Binary data:** modes are `filesystem`, `database` and `s3` (2.0). "External storage for binary data" (S3) is not in CE — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes); [CE features](https://docs.n8n.io/hosting/community-edition-features/). In 3.0, `~/.n8n/binaryData` is renamed `~/.n8n/storage` — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Execution data pruning** — **[not re-fetched]** — [Execution data docs](https://docs.n8n.io/hosting/scaling/execution-data/):
  - Old executions are pruned automatically (env vars `EXECUTIONS_DATA_PRUNE`, `EXECUTIONS_DATA_MAX_AGE` and `EXECUTIONS_DATA_PRUNE_MAX_COUNT`).
  - Each workflow can choose whether to save successful, failed or manual executions.
- **Retention on Cloud:** Starter 7 days and 2.5K saved executions, Pro 30 days and 25K, Enterprise unlimited and 50K — [pricing](https://n8n.io/pricing/).
- "Custom execution data" (tagging executions with searchable metadata) is unlocked by free registration — [CE features](https://docs.n8n.io/hosting/community-edition-features/). "Search executions by data" is Pro and above — [pricing](https://n8n.io/pricing/).

#### Templates, community nodes, API, CLI
- **Templates:** a public templates gallery at n8n.io/workflows. Template IDs now exceed 13,000, e.g. the Chat Hub web-search template is #13271 — [example template](https://n8n.io/workflows/13271). That is my inference about scale, not an official count, since IDs may not be contiguous. 2.9: "Setup Template" opens the setup panel — [release notes](https://docs.n8n.io/release-notes/). 3.0 removes "Import from URL" — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Community nodes:**
  - **Verified community nodes installable on Cloud: 1.94.0 (2025-05-19)** (shield badge) — [1.x release notes](https://docs.n8n.io/release-notes/1-x/).
  - 2.8: previews of uninstalled community tools — [release notes](https://docs.n8n.io/release-notes/).
  - 3.0: unverified packages disabled by default, `n8n-node dev` requires Docker/Podman, and `defaults.color` removed — [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Public REST API:**
  - 2.8: credentials list shows shared-with info
  - 2.14: dependency endpoints
  - 2.18: favorites endpoints
  - 2.28: users rotate API keys
  - Source: [release notes](https://docs.n8n.io/release-notes/). API reference: [n8n API](https://docs.n8n.io/api/) **[not re-fetched]**.
- **CLI:** `publish:workflow`/`unpublish:workflow` (2.0), and `n8n --tunnel` removed — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes). The long-standing export/import commands are covered in the [CLI docs](https://docs.n8n.io/hosting/cli-commands/) **[not re-fetched]**.

### Inferences
- n8n's 2026 product direction is **agents first**: standalone Agents, Instance AI/n8n Assistant, Browser/Computer Use, MCP everywhere, an AI gateway. Meanwhile it **retires its own Chat Hub** after under a year (beta around Dec 2025, deprecated in 3.0). That suggests n8n sees agent-specific channels (Slack, Telegram, Linear, MCP) as the chat surface, not a ChatGPT-style hub.
- 2.0 and 3.0 are mostly **hardening and cleanup** releases (sandboxing, env/file access, signature verification, SSRF, Docker-only), not feature releases. Security posture is now a baseline expectation for self-hosted automation tools.
- The **draft → publish + autosave + version diff** model now covers both workflows (2.0/2.4/2.11) and agents. For anyone matching n8n, this is now table stakes for editor UX.

### Gaps
- No primary-source confirmation of the exact n8n 2.0 stable date. The community post gives a plan of Dec 15, 2025, but the release notes date 2.1 at 2025-12-15. The 3.0 release date is not given anywhere official.
- The release-notes excerpts did not reveal the version where Chat Hub (beta) first shipped, nor when "Debug in editor", the Think tool or workflow history were introduced (the latter two predate 2025).
- Whether the AI Workflow Builder (as distinct from n8n Assistant) is available on self-hosted Enterprise could not be confirmed. Docs and old release notes conflict.
- I did not re-fetch the individual docs pages for the long-standing core features marked [not re-fetched]. Details such as env-var defaults should be verified before quoting.

## Which features are paid/enterprise-only vs. community edition?

### Takeaway
Community Edition (free, self-hosted) has "almost the complete feature set," including queue mode, task runners, Data Tables, MCP, Chat Hub and Agents. Free registration unlocks folders, debug-in-editor and custom execution data. Team/governance features are paid (Business/Enterprise): projects, sharing, SSO, Git/environments, variables, external secrets, log streaming, multi-main and S3 binary storage.

### Cited Findings
- **Excluded from Community Edition** — [CE features](https://docs.n8n.io/hosting/community-edition-features/):
  - custom variables
  - environments
  - external secrets
  - external storage for binary data
  - log streaming (basic logging is included)
  - **multi-main mode** (queue mode *is* included)
  - **projects**
  - SSO (SAML, LDAP)
  - **sharing of workflows and credentials** (only the owner and the creator can access them)
  - **version control using Git**
- **Registered Community Edition** (free license key by email) unlocks **folders, debug in editor and custom execution data** — [CE features](https://docs.n8n.io/hosting/community-edition-features/).
- **Cloud plans (annual billing, as shown on the pricing page)** — [pricing](https://n8n.io/pricing/):
  - **Starter:** €20/mo, 2.5K executions, 5 concurrent, 1 shared project, 7-day logs, 1-day history, insights banner only, no SSO/Git/queue mode, 1,600 Assistant credits.
  - **Pro:** €50/mo, 10K executions, 20–50 concurrent, 3 projects, project editor/admin roles, global variables, search executions by data, 5-day history.
  - **Business:** €667/mo, **self-hosted only** (hosted Business is waitlisted), 40K executions, 6 projects, **SSO/LDAP, Git source control, multiple environments, queue mode**, 30-day insights.
  - **Enterprise:** custom pricing, unlimited projects, project viewers and **custom roles**, external secrets, log streaming/audit logging, enforced 2FA and execution-data redaction, 365-day history and insights, 200+ concurrent.
  - All plans have "unlimited users & workflows." Pricing is based on executions.
- **Plan columns are incomplete:** the pricing-page parse marked many Business entries as "not listed." Business support for external secrets, log streaming and variables is not confirmed from that page — [pricing](https://n8n.io/pricing/).
- **Custom project roles** are flagged Enterprise in 1.122.0 — [1.x release notes](https://docs.n8n.io/release-notes/1-x/). Data redaction went "behind license" in 2.16 — [release notes](https://docs.n8n.io/release-notes/).
- **Available on all plans including CE:** Chat Hub, though the "chat user" role is paid — [Chat Hub docs](https://docs.n8n.io/advanced-ai/chat-hub/). Agents, from 2.32.3 — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents). n8n Assistant on self-hosted CE, Registered CE and Business using your own provider key, but not Enterprise yet — [n8n Assistant docs](https://docs.n8n.io/build/ways-of-building-workflows/n8n-assistant).
- **Cloud only:** Gateway credits (not self-hosted, not Cloud Enterprise) — [Gateway credits](https://docs.n8n.io/deploy/use-n8n-cloud/gateway-credits). Agent knowledge bases (self-hosted requires a sandbox, preview) — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- **Licensing complaints:** Users on third-party forums complain that Git version control, SSO, easy workflow sharing, customizable variables and organized project directories are missing from self-hosted CE. They also ask for rollback and better workflow versioning with change logs — [Latenode thread 1](https://community.latenode.com/t/self-hosted-n8n-which-key-functionalities-are-missing-in-the-community-version/6189); [Latenode thread 2](https://community.latenode.com/t/self-hosted-n8n-which-additional-features-do-you-wish-were-available-in-the-community-edition/4311). One guide calls the omissions a deliberate monetisation choice — [CompareCrest](https://comparecrest.com/blog/n8n-community-edition-limits/).
- n8n is licensed under the Sustainable Use / n8n Community License (with a license FAQ) rather than OSI open source — [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq).

### Inferences
- n8n's paywall line is **multi-user governance** (sharing, projects, RBAC, SSO, Git, environments, variables, secrets). Single-user power features (queue mode, AI, data tables, MCP) are free. Landflow could differentiate by shipping **variables, Git-based versioning and basic sharing for free**, since those are the items CE users most resent losing.

### Gaps
- The exact Business-plan contents for variables, external secrets and log streaming were not legible from the pricing page.
- Prices were captured as displayed (EUR, annual) and may vary by region or currency.

## What do n8n users most often request or complain about that n8n still lacks?

### Takeaway
The open feature-request board is dominated by integration requests, plus a cluster of **engine and observability gaps**: credential selection via expression, LLM token-usage access, per-workflow concurrency limits and blocking parallel runs, automatic retry of failed workflows, a WebSocket trigger, Langfuse/Opik-style tracing, PDF creation, HTTP streaming, a mobile editor, and execution tags. Several long-standing asks (autosave, folders, data tables, headless browser, agent skills) shipped in 2025–2026.

### Cited Findings
- **Top open topics by replies** on community.n8n.io Feature Requests (vote counts not shown) — [Feature Requests](https://community.n8n.io/c/feature-requests/5?order=votes):

  | Request | Replies | Views |
  |---|---|---|
  | Etsy integration | 59 | 10.2K |
  | **Select credentials via expression** | 53 | 8.7K |
  | **Retrieve LLM token usage in AI Agents** | 50 | 8.2K |
  | **A text replace node** | 47 | 16.2K |
  | CalDAV | 44 | — |
  | **Create PDF** | 42 | — |
  | Access saved credentials from expressions | 34 | 12.6K |
  | **Streaming in HTTP Request/OpenAI nodes** | 31 | — |
  | **Automatic retry of workflows** | 30 | 8.3K |
  | Reasoning parameters across all models in AI Agent | 27 | — |
  | **Concurrency in workflow settings** | 26 | — |
  | Discord Trigger | 25 | — |
  | Instagram Business API | 24 | — |
  | **WebSockets trigger** | 16 | 8K |
  | **Observability/evaluation platforms (Langfuse, Opik)** | 15 | — |
  | Mem0 memory | 15 | — |
  | Signal | 14 | — |
  | Allow expression for credential selection | 14 | — |
  | **Agent Skills (SKILL.md) for n8n agents** | 13 | 7.3K |
  | **Option for blocking parallel workflow execution** | 12 | — |
  | **Mobile-friendly editor** | 10 | — |
  | Headless browser (Puppeteer) | 7 | — |
  | **Export cURL from HTTP Request node** | 6 | — |
  | **Add tag to execution** | 6 | — |

- **Requests since addressed (at least partly)** — [release notes](https://docs.n8n.io/release-notes/); [1.x release notes](https://docs.n8n.io/release-notes/1-x/):
  - **Autosave** was the most-discussed open request (60 replies, 8.4K views as of January 2026) — [summary of community board](https://community.n8n.io/c/feature-requests/ui/8). It shipped in **2.4 (2026-01-12)**.
  - **Folders** for workflows shipped in 1.85.
  - **Data tables** shipped in 1.113.1.
  - **Headless browser:** Browser Use went to all users in 2.43.
  - **Agent skills:** Agents have "Skills" (2.x preview), though not necessarily SKILL.md-format — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
  - **Credentials via expression:** partly addressed by "credential resolvers for dynamic credentials" (2.1) and end-user credentials. Whether this fully satisfies the request is unclear.
- **Self-hosted users' complaints** focus on paywalled governance (Git, SSO, sharing, variables, environments), plus missing rollback and advanced debugging logs — [Latenode thread](https://community.latenode.com/t/self-hosted-n8n-which-key-functionalities-are-missing-in-the-community-version/6189).
- **Migration pain** is a recurring theme: 2.0 broke Code nodes (env access, `$evaluateExpression`), Python (Pyodide removal) and sub-workflow Wait semantics, and 3.0 removes many nodes and npm installs — [2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes); [v3.0 breaking changes](https://docs.n8n.io/changelog/v30-breaking-changes). Users ask about the Chat Hub deprecation — [community thread](https://community.n8n.io/t/chat-hub-deprectiation-v3/305651).
- **2.0 sandboxing:** "code nodes can no longer access your entire system by default" — [GrowwStacks](https://growwstacks.com/blog/n8n-2-update-breaking-changes) (third party).

### Inferences
- Several open n8n requests line up with things Landflow already has or could ship cheaply. These would make strong "n8n can't do this" differentiators:
  - **Token usage per AI node** and **OTel/Langfuse-style tracing.** Landflow already emits OpenTelemetry traces.
  - **Per-workflow concurrency limits / single-flight execution.**
  - **Workflow-level auto-retry of failed executions** (n8n only has node-level retry plus manual retry).
  - A **WebSocket trigger**.
  - **Execution tags.**
  - **Export as cURL.**
  - **Step-debugging.** Landflow's breakpoint debugger has no n8n equivalent among the sources reviewed.

### Gaps
- I did not survey GitHub issues or Reddit directly (only the n8n forum and third-party forums), so the complaint list over-weights forum users.
- Vote counts were not visible, so ranking is by replies.

## How does Landflow compare — which n8n features does it lack, what do they do, and how much do they matter?

### Takeaway
Landflow matches n8n's **single-user editor and engine core** and is ahead in a few places: breakpoint debugger, polyglot out-of-process plugins, OTel tracing, a local-LLM builder. It lacks most of what n8n added for **production operation** (sub-workflows, error workflows, publish/versioning, binary data, pruning, sandboxing, OAuth2, auth) and the **2025–26 AI/data layer** (Data Tables, MCP, RAG, evaluations, forms/HITL in workflows). The core gaps to close first are sub-workflows, error workflows, Respond to Webhook, binary data, versioning/publish, cron, OAuth2, sandboxing, pruning and basic auth.

### Cited Findings
Landflow's status in the table comes from the assignment brief's inventory. n8n facts are cited inline. The "Importance" column is my assessment (core / important / nice-to-have).

| n8n feature (version) | What it does for users | Landflow today | Importance |
|---|---|---|---|
| **Sub-workflows**: Execute Workflow + Execute Workflow Trigger, also usable as an AI tool ([docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/) [not re-fetched]; trigger v1.2 in 2.23 per [notes](https://docs.n8n.io/release-notes/)) | Reuse logic, break up big flows, expose workflows as agent tools; caller policies restrict who can call | Missing | **Core** |
| **Error workflows**: Error Trigger set per workflow ([docs](https://docs.n8n.io/flow-logic/error-handling/) [not re-fetched]) | Central alerting and recovery when any production workflow fails | Missing (only node-level onError/retry) | **Core** |
| **Respond to Webhook**, plus response streaming (1.103.0, [notes](https://docs.n8n.io/release-notes/1-x/)) | Build real HTTP APIs: custom status, headers, body, binary, mid-flow response | Missing | **Core** |
| **Loop Over Items / Split in Batches** ([docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/) [not re-fetched]) | Batching for rate limits, pagination, per-batch processing | Missing | **Important** (core for API-heavy flows) |
| **Draft/Publish, autosave, version history with diff and restore, publish timeline** (2.0, 2.4, 2.11, 2.22; [2.0](https://docs.n8n.io/2-0-breaking-changes), [notes](https://docs.n8n.io/release-notes/)) | Edit safely without breaking live flows; roll back; audit changes | Missing for workflows (Landflow Agents do have versions) | **Core** |
| **Schedule Trigger with cron** (n8n's dedicated Cron/Interval nodes are removed in 3.0 in favour of Schedule Trigger, [3.0](https://docs.n8n.io/changelog/v30-breaking-changes)) | Run at specific times or calendar rules | Interval only | **Core** (cheap) |
| **Binary data**: filesystem, DB or S3 modes ([2.0](https://docs.n8n.io/2-0-breaking-changes)); Form returns files (2.31); AI Agent passes PDFs (2.28) ([notes](https://docs.n8n.io/release-notes/)) | Files, attachments, images and PDFs through flows and into LLMs | Missing | **Core** |
| **Code sandboxing via task runners** (JS and native Python, external mode, env access blocked) ([2.0](https://docs.n8n.io/2-0-breaking-changes); 1.71.0 / 1.113.2 [notes](https://docs.n8n.io/release-notes/1-x/)) | Safe multi-tenant code execution; Python Code node | node:vm, not sandboxed; no Python Code node | **Core** (security) |
| **OAuth2 credential flows**, with managed OAuth and many new OAuth2 options in 2026 ([notes](https://docs.n8n.io/release-notes/)) | One-click connections to Google, Microsoft, Slack, Notion, etc. | No OAuth2 consent flows | **Core** for integrations |
| **Execution pruning and per-workflow save settings** ([docs](https://docs.n8n.io/hosting/scaling/execution-data/) [not re-fetched]) | Keeps storage bounded; control what gets saved | Missing (JSON file storage will grow) | **Core** (ops) |
| **Users / auth / owner login**, then projects, sharing and RBAC (custom roles 1.122.0, [notes](https://docs.n8n.io/release-notes/1-x/); [pricing](https://n8n.io/pricing/)) | Secure any non-localhost deployment; team collaboration | None | **Core** (auth) / **Important** (RBAC) |
| **Database storage** (SQLite pooled WAL / Postgres) ([2.0](https://docs.n8n.io/2-0-breaking-changes)) | Durability and concurrency beyond JSON files | JSON files, single process | **Important** (prerequisite for queue mode) |
| **Queue mode with workers**, plus multi-main (paid) ([CE features](https://docs.n8n.io/hosting/community-edition-features/)) | Horizontal scale and isolation of heavy executions | Single process | **Important** (later) |
| **Data Tables**: built-in tables, Data Table node, CSV import, 200 MiB default (1.113.1; [docs](https://docs.n8n.io/build/work-with-data/data-tables)) | State, dedupe, lookup and logging without external DBs; heavily used by AI flows | Missing | **Important** |
| **Variables** (`$vars`, project-level from 1.118.0, [notes](https://docs.n8n.io/release-notes/1-x/)) | Shared config across workflows and environments | Missing | **Important** (cheap) |
| **Forms**: Form Trigger + multi-page Form node, dynamic fields, auth-gated (1.65.0; 2.3; 2.25.1, [notes](https://docs.n8n.io/release-notes/)) | User-facing intake forms and multi-step wizards with no front-end | Missing | **Important** |
| **HITL send-and-wait in workflows** (Gmail, Slack, Telegram, Chat approvals; Wait on webhook/form) (1.63.0; 2.5; 2.35, [notes](https://docs.n8n.io/release-notes/)) | Pause a workflow for human approval or input, then resume | Wait is seconds only; approvals exist only in Landflow Agents | **Important** |
| **MCP Server Trigger + MCP Client Tool/node**, instance-level MCP server with OAuth scopes (1.88.0; 1.121.0; 2.31 GA; 2.32, [notes](https://docs.n8n.io/release-notes/)) | Expose workflows as tools to Claude/Cursor; consume any MCP server; let external coding agents build workflows | Missing | **Important** (high leverage, low cost) |
| **Vector stores / RAG** (Pinecone, Chroma, Weaviate, Oracle, in-memory; loaders) ([notes](https://docs.n8n.io/release-notes/); [Simple Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreinmemory)) | Retrieval-augmented agents over the user's documents | Embeddings only | **Important** |
| **Evaluations**: dataset runs with metric scoring, live status, cancel/re-run (1.95.0; 1.103.0; 2.21, [notes](https://docs.n8n.io/release-notes/)) | Regression-test prompts and agents before publishing | Missing | **Important** for AI users (nice-to-have early) |
| **Guardrails node** (1.119.0); **Model Selector** (1.100.0); **AI Agent Tool** (agent-as-tool, 1.103.0); streaming ([notes](https://docs.n8n.io/release-notes/1-x/)) | Safety filters, dynamic model routing, multi-agent composition, token streaming to chat | Missing | **Important** (streaming, agent-as-tool) / nice-to-have (others) |
| **Agents extras**: sub-agents, knowledge base, web search fallback, Slack/Linear channels, Message an Agent node, budgets, Browser Use (2.43) ([Agents docs](https://docs.n8n.io/build/build-and-manage-agents); [notes](https://docs.n8n.io/release-notes/)) | Agents that delegate, ground on files, browse, and are callable from workflows | Landflow Agents have instructions, skills, tools, approvals, memory, versions, cron and Telegram, but none of these extras | **Important** (Message-an-Agent node, knowledge base) / nice-to-have (rest) |
| **Sticky notes, tags, folders (1.85.0), canvas groups (2.31), favorites (2.18)** ([notes](https://docs.n8n.io/release-notes/1-x/); [notes](https://docs.n8n.io/release-notes/)) | Document and organize large workflow libraries | Missing | **Important** (sticky notes and tags are cheap and expected) |
| **Templates library**: template IDs past 13,000 (not an official count), setup panel ([example](https://n8n.io/workflows/13271); [notes](https://docs.n8n.io/release-notes/)) | Fast start; major acquisition channel | 4 starters | **Important** (template import/export at minimum) |
| **Public REST API + CLI** (import/export, publish) ([2.0](https://docs.n8n.io/2-0-breaking-changes); [API](https://docs.n8n.io/api/) [not re-fetched]) | Automation of the automation tool; CI/CD | Not in inventory (unknown) | **Important** |
| **Source control (Git) and environments** (paid; [pricing](https://n8n.io/pricing/)) | Dev→prod promotion, review and rollback via Git | Missing | **Nice-to-have** now; differentiator if free |
| **External secrets, log streaming, SSO/LDAP, 2FA enforcement, data redaction** (Enterprise; [pricing](https://n8n.io/pricing/); [notes](https://docs.n8n.io/release-notes/)) | Enterprise compliance | Missing (Landflow has an AES-GCM vault and OTel) | **Nice-to-have** (enterprise) |
| **Insights dashboard** (1.89.0, [notes](https://docs.n8n.io/release-notes/1-x/)) | Executions, failure rate and time saved, for ROI reporting | Has Prometheus/OTel but no in-app dashboard | **Nice-to-have** |
| **Debug in editor / custom execution data / search executions by data** ([CE features](https://docs.n8n.io/hosting/community-edition-features/); [pricing](https://n8n.io/pricing/)) | Load a failed run into the editor; tag and search executions | Has retry/re-run and pin data; no execution metadata search | **Nice-to-have** |
| **Webhook signature verification, "Only Run If" filter, SSRF block list, Stop All Executions** (2.21/2.22/2.28/2.3; [notes](https://docs.n8n.io/release-notes/); [3.0](https://docs.n8n.io/changelog/v30-breaking-changes)) | Secure public triggers; emergency stop | Missing | **Important** (security) |
| **Chat Hub** ([docs](https://docs.n8n.io/advanced-ai/chat-hub/)) | ChatGPT-style UI over models and agents | Chat trigger only | **Nice-to-have**; n8n itself is retiring it in 3.0 ([3.0](https://docs.n8n.io/changelog/v30-breaking-changes)) |
| **AI gateway / managed model credits** (2.36.0, Cloud; [docs](https://docs.n8n.io/deploy/use-n8n-cloud/gateway-credits)) | Use LLMs without bringing your own keys | N/A (local Ollama and BYO keys) | **Nice-to-have** (cloud business model only) |

**Where Landflow already matches or exceeds n8n** (Landflow side from the brief):
- **AI flow builder and editor assistant with diff/undo.** The n8n equivalent is the AI Workflow Builder / n8n Assistant, which uses cloud credits or a BYO provider — [docs](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder). Landflow's runs on local Ollama.
- **Plugin marketplace.** Landflow's polyglot out-of-process plugins (TS/Python/Go over HTTP/gRPC) compare with n8n community nodes. n8n's are npm/TS-only, with unverified packages disabled by default in 3.0 — [3.0](https://docs.n8n.io/changelog/v30-breaking-changes).
- **Standalone Agents** with approvals, memory, versions and cron, roughly matching n8n's preview Agents — [Agents docs](https://docs.n8n.io/build/build-and-manage-agents).
- **Logs panel with waterfall.** The n8n analogue is the Logs view (1.92.0) — [notes](https://docs.n8n.io/release-notes/1-x/).

### Inferences
- **Suggested order** (my judgment, based on how often each feature underlies n8n templates and production use):
  1. sub-workflows, error workflows, Respond to Webhook, cron
  2. binary data, execution pruning, DB storage
  3. auth (owner login), OAuth2
  4. draft/publish and version history
  5. code sandbox with a Python Code node
  6. variables, sticky notes and tags (cheap)
  7. Data Tables, Forms + HITL Wait (webhook/form/approval resume), MCP Server/Client
  8. vector stores/RAG, Evaluations
  9. RBAC/projects, Git, queue mode, enterprise items
- **MCP and Data Tables are the cheapest high-leverage AI-era gaps.** MCP Server Trigger can largely reuse the existing webhook path and tool schemas. Data Tables can start as a SQLite-backed store with CRUD nodes.
- Landflow's existing **OTel and Prometheus** stack is a direct answer to open n8n requests: LLM token usage and Langfuse/Opik-style tracing. Adding per-workflow concurrency limits and workflow-level auto-retry would hit two more open n8n requests ([forum](https://community.n8n.io/c/feature-requests/5?order=votes)).
- Landflow's **unsandboxed node:vm Code node** is a liability against n8n 2.0's defaults (sandboxed runners, env access blocked, file access restricted). It should be closed before any multi-user or network-exposed deployment.
- **n8n's own churn gives Landflow two openings.** Chat Hub is being deprecated, and 3.0 requires Docker and removes legacy nodes. Landflow can avoid building a chat hub, and can offer a simple single-binary/npm install that n8n is dropping.

### Gaps
- The inventory doesn't say whether Landflow has a public REST API or CLI, so that comparison row is unknown.
- I could not confirm from n8n sources whether n8n offers anything like Landflow's step/continue breakpoint debugger. None was found in the release notes reviewed, which is not proof of absence.
- Prometheus metrics in n8n (a long-standing `/metrics` endpoint) were not checked this session, so the "OTel/Prometheus as differentiator" point holds for tracing but may not hold for metrics.
