# AI-native workflow and agent builders (Dify, Langflow, Flowise, Gumloop, Lindy, Relevance AI, Vellum, plus Zapier/Make/n8n AI) vs. Landflow, as of 2026-10-25

Note on dates: GitHub release pages show day and month only. Years below are inferred from release order and today's date (2026-10-25). For example, Dify v1.9.0 shipped Sep 23, 2025, so v1.16–v1.18 (Jul–Oct) are 2026. Inferred years are marked "(2026, inferred)".

## Platform status check: which of these are still active as AI workflow builders in late 2026?

### Takeaway
The market has changed a lot since 2025. Flowise is sunset (repo archived Aug 2026). Vellum has pivoted from an LLM developer platform to an open-source personal AI assistant. Lindy now sells an "AI employee/teammate" rather than a no-code agent builder. Gumloop has repositioned agent-first. Dify, Langflow, n8n and Relevance AI are still shipping builder features quickly, so they are the live comparison set for workflow-plus-AI.

### Cited Findings
- **Flowise is sunset.** Announcement and code freeze on July 29, 2026 ("Active feature development ceases immediately"). The GitHub repo moved to public archive on August 10, 2026, and npm packages and Docker images were marked deprecated. End of life was August 31, 2026, when the core team left Discord and GitHub. Code stays Apache 2.0, and the team encourages forks. — [Flowise sunset page](https://flowiseai.com/sunset)
- The stated reason: developers increasingly use coding agents for complex work, and "The typical rigid workflow low code approach quickly hits the limit when it comes to complexity." — [Flowise sunset page](https://flowiseai.com/sunset)
- The GitHub page says the repository was "archived by its owner on Aug 13, 2026". The last release is flowise@3.1.4 (29 Jul), security and fixes only. — [Flowise GitHub releases](https://github.com/FlowiseAI/Flowise/releases). The archive date differs from the sunset page (Aug 10) by 3 days.
- A secondary review reports Flowise Cloud shutting down November 30, 2026. Unverified: the sunset page fetched gives no Cloud date. — [WebSearch summary of reviews, e.g. vibecoding.app](https://vibecoding.app/blog/flowise-review); [Flowise sunset](https://flowiseai.com/sunset)
- Workday announced its acquisition of Flowise in August 2025. — [Constellation Research](https://www.constellationr.com/insights/news/workday-acquires-flowise-speed-building-ai-agents-automated-workflows); [Flowise blog: Workday + Flowise](https://blog.flowiseai.com/workday-flowise)
- **Vellum has pivoted.** The vellum.ai homepage now says "A personal AI assistant for your busywork": memory, background tasks, browsing, email and calendar, OpenAI/Anthropic/Gemini/Ollama models, local or cloud, Mac/iOS/Android/web/voice/email/Telegram/Slack/terminal, open source. Cloud plans run $30/$100/$200 per month. — [vellum.ai](https://www.vellum.ai/)
- A secondary source dates the pivot to May 2026 ("Introducing Vellum", May 7, 2026). The assistant is MIT-licensed, and a mobile app with voice mode launched Aug 27, 2026. — [automationatlas.io](https://automationatlas.io/tools/vellum/); [Vellum blog: Introducing Vellum](https://www.vellum.ai/blog/introducing-vellum); [TestingCatalog](https://www.testingcatalog.com/vellum-mobile-brings-voice-mode-and-mac-control-to-ios/)
- Vellum's developer docs (Workflows, Prompts, Evaluations, Deployments, Document Indexes) are still online. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Lindy has repositioned.** It now calls itself an "AI employee"/teammate that does whole jobs, not a chatbot or agent builder. It lists Routines, Skills (40+), file-based memory, meeting recording, 1,500+ integrations plus MCP, browser/computer use (Pro/Team and up), and Slack/iMessage/email/Chrome surfaces. Pricing: Free with $50 in credits; Team from $49.99/month for 5,000 pooled credits; Enterprise custom. — [lindy.ai](https://www.lindy.ai/)
- Lindy's doc index now lives under `/teammate/` paths (Memory, Routines, Skills, Watch and Learn, Artifacts). It has no pages on knowledge bases, agent swarms, evaluations or chat widgets. — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt)
- **Gumloop** now calls itself "an AI agent platform". Its doc set centers on Agents, Gumball (a personal agent), Skills, Brain (knowledge), Agent browser, and the MCP server. — [docs.gumloop.com](https://docs.gumloop.com/); [docs.gumloop.com/llms.txt](https://docs.gumloop.com/llms.txt)
- **Dify** is still shipping: v1.16.0 (17 Jul), v1.17.0 (25 Aug), v1.17.1 (10 Sep) and v1.18.0 (23 Oct), all 2026 (inferred). — [Dify GitHub releases](https://github.com/langgenius/dify/releases)
- **Langflow** is still shipping: 1.12.0 (01 Sep) through 1.13.0 (22 Oct), 2026 (inferred), with roughly weekly patches. — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **n8n** is at 2.45 (2026-10-20), on a weekly release cadence. — [n8n release notes](https://docs.n8n.io/release-notes/)
- **Relevance AI**'s most recent changelog entry is Sep 3, 2026 (Invent assistant). — [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- A vendor-affiliated post says "Langflow sold to DataStax and DataStax to IBM". Not verified here. — [Activepieces: Dify alternatives 2026](https://www.activepieces.com/blog/dify-alternatives-4-options-compared-2026-guide.md)

### Inferences
- Several "AI-native builders" have moved from canvas workflows toward autonomous assistants or agents: Vellum to an assistant, Lindy to a teammate, Gumloop agent-first, and Dify launching an "Agent App" (v1.16). Flowise said outright that rigid low-code canvases are losing to coding agents. Landflow's standalone Agents (skills, schedules, channels, approvals) point the same way, which is good. Its AI flow builder and editor assistant answer the "coding agents replace canvases" threat.
- Vellum's workflow/eval/prompt platform remains the best reference for evals and prompt-management design, since its docs are still public. Do not treat it as a live competitor, because its future is unclear.
- Flowise's archival leaves self-hosted Flowise users looking for a replacement (Apache 2.0, fork or migrate). A Flowise importer or migration guide could bring users to Landflow cheaply.

### Gaps
- Whether Vellum still sells or supports the enterprise Workflows/Evals platform after the pivot is unclear. The docs exist, but no end-of-life notice was found.
- No official Lindy page says whether the older Lindy "flows" builder, agent swarms and knowledge base were retired. This is inferred from the doc index.
- No official Flowise Cloud shutdown date was found.
- The IBM/DataStax/Langflow ownership claim was not verified in a primary source this session.

## RAG and knowledge: who has built-in knowledge bases, and how are they exposed in the builder?

### Takeaway
Dify has the deepest built-in RAG: a visual "Knowledge Pipeline" (sources, then extract, chunk, embed, index), hybrid search, reranking, metadata filters, and a Knowledge Retrieval workflow node. Relevance AI, Gumloop (Brain) and Zapier Agents offer managed knowledge synced from SaaS sources with little configuration. Langflow, n8n and Vellum expose vector stores or document indexes as nodes.

### Cited Findings
- **Dify Knowledge Pipeline (v1.9.0, Sep 23, 2025):**
  - Data source plugins: local files (30+ formats), Google Drive, S3, Azure Blob, Box, OneDrive, Dropbox, Notion, Confluence, SharePoint, GitLab, GitHub, and web crawlers (Firecrawl, Jina, Bright Data, Tavily).
  - Parsers: Unstructured, LlamaParse, OCR, with multiple parsers per file type and LLM descriptions of images and tables.
  - Chunking: General, Parent-Child, Q&A.
  - Indexing: a selectable embedding model; high-quality vector index or cost-efficient inverted index; metadata tags.
  - Retrieval: vector, full-text or hybrid, plus reranking.
  - Templates: seven, e.g. "Complex PDF with Images & Tables", "Contextual Enrichment Using LLM", "LLM Generated Q&A".
  - Debugging: step-by-step Test Run and a Variable Inspect panel.
  - Vector stores: Qdrant, Weaviate, Milvus, etc. via plugins.
  - — [Dify blog: Introducing Knowledge Pipeline](https://dify.ai/blog/introducing-knowledge-pipeline)
- Pipelines are created from a template, blank, or import, then orchestrated, published, given files, and managed. — [Dify docs: Knowledge Pipeline](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/readme.md)
- **Dify retrieval settings:**
  - Multi-path retrieval across all linked knowledge bases, followed by a rerank.
  - "Weighted Score" mode, a semantic/keyword weight slider with no extra model cost, or a "Rerank Model" mode (Cohere, Jina).
  - TopK default 3, score threshold default 0.5.
  - Metadata filtering in the Knowledge Retrieval node: Disabled, Automatic (LLM-derived from the query), or Manual (string/number/date conditions with AND/OR).
  - Citations toggled under "Add Features" for chatbots.
  - — [Dify docs: Integrate knowledge within application](https://docs.dify.ai/en/cloud/use-dify/knowledge/integrate-knowledge-within-application.md)
- Dify also supports connecting an external knowledge base through an API, and offers retrieval testing and document/chunk editing. — [Dify docs: Knowledge overview](https://docs.dify.ai/en/guides/knowledge-base/readme)
- Recent Dify RAG releases:
  - v1.17.0 (25 Aug 2026, inferred): TiDB full-text and hybrid search, multimodal retrieval guidance.
  - v1.17.1 (10 Sep): knowledge base API keys scoped to specific datasets.
  - v1.18.0 (23 Oct): Beta "Agent Knowledge Base", which puts document processing, metadata, retrieval traces and quality evaluations in one place.
  - — [Dify GitHub releases](https://github.com/langgenius/dify/releases)
- **Langflow:**
  - 1.12.0 (01 Sep 2026, inferred) moved knowledge bases and memory onto shared vector DB backends with pgVector support.
  - 1.12.2 lets multiple KB columns be vectorized.
  - 1.13.0 (22 Oct) replaced local Chroma KBs with SQLite, allows writing precomputed vectors without re-embedding, and supports moving vectors between backends.
  - — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Flowise (archived)** had Document Stores (chunk storage, rename/delete in 3.1.2) and a Teradata vector store (3.0.10). — [Flowise GitHub releases](https://github.com/FlowiseAI/Flowise/releases)
- **Gumloop "Brain"** is a company knowledge base that agents search once tools are connected. It has personal, team and org scopes. Its Search API does "hybrid semantic and keyword search… returning ranked snippets with citations", and it is also exposed as an MCP tool. — [Gumloop llms.txt (Brain pages)](https://docs.gumloop.com/llms.txt)
- **Relevance AI Knowledge:** upload files or sync from Google Drive, SharePoint, Notion or websites. Confluence Knowledge Sync (auto-updates on page change) shipped May 1, 2026. — [Relevance AI docs](https://relevanceai.com/docs); [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **Vellum (legacy platform):** Document Indexes with upload, Search API, metadata filtering, and a Search Node in workflows. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Zapier Agents** connect to live data in Google Drive, Box, Notion and Asana as knowledge, and have built-in web search. — [Zapier blog: Zapier Agents](https://zapier.com/blog/zapier-agents/)
- **Make AI Agents** docs include "Input files and knowledge files for AI agents". — [Make Help: AI Agents](https://help.make.com/make-ai-agents); menu seen via [help.make.com](https://help.make.com/your-profile)
- **n8n** ships vector store nodes, e.g. Databricks Vector Store, which validates inserts as of 2.44 (Oct 2026). — [n8n release notes](https://docs.n8n.io/release-notes/)

### Inferences
- There are two RAG UX models. (a) An "engineered" pipeline the builder configures (Dify, Langflow, n8n, Vellum). (b) "Connect your sources and it just works" managed knowledge (Gumloop Brain, Relevance, Zapier, Lindy). Business users favor (b). Landflow's n8n-like audience needs (a) as nodes, but a managed "Knowledge" object attachable to Standalone Agents would cover (b).
- The minimum viable RAG for Landflow is: document loaders, a chunker (recursive plus parent-child), an embeddings node (exists, OpenAI only, needs Ollama embeddings for local), a vector store node (pgvector/SQLite-vec/Qdrant), a retrieval node with hybrid search and an optional reranker, and a "knowledge as agent tool" adapter.

### Gaps
- How Gumloop Brain and Relevance knowledge chunk and embed (configurable or not) is not documented in the pages read.
- Lindy's current knowledge-base capability was not documented in its current doc index.

## Evaluation and quality: datasets, LLM-as-judge, regression tests, A/B prompts, human feedback

### Takeaway
Evals are now standard in agent platforms. There are two styles. Offline dataset or test-suite runs: Vellum, n8n, Relevance, the former Flowise. Online LLM-judge scoring of production conversations: Gumloop, Relevance, Vellum. Dify largely delegates to tracing integrations, though its 1.18 Agent KB adds retrieval-quality evals. Langflow shows no eval features in recent releases.

### Cited Findings
- **Vellum (legacy platform):** test suites and quantitative evaluation, RAG pipeline evaluation, online evaluations on live deployments, dozens of premade metrics, custom reusable metrics, metric reuse with different configs, and Test Suite Run APIs. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Relevance AI:**
  - "Evals" test-suite framework with AI-judge scoring (Feb 9, 2026, Enterprise).
  - Agent Performance Observability: LLM judges score production conversations, with sampling controls and dashboards (Mar 13, 2026, Enterprise).
  - Itemized eval-run costs, and evals over whole Workforce runs including sub-agents and tool calls (Jun 29, 2026).
  - — [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **Gumloop Evaluations:**
  - Configured per agent: yes/no criteria (each set to Flag or Notify), tags, typed data points (Text/Boolean/Integer/Number), and sentiment.
  - An LLM reads the transcript, including tool calls, and judges each criterion. The grade is computed deterministically: Notify becomes `needs_attention`, other failures become `needs_review`, otherwise Pass.
  - Runs automatically when a conversation completes and can backfill past conversations in bulk. Notify alerts go by email or Slack.
  - Limits: 30 criteria, 50 tags, 40 data points per agent. Each eval is one LLM call billed in credits.
  - Org-level evals and Data Export are Enterprise only.
  - — [Gumloop docs: Evaluations](https://docs.gumloop.com/core-concepts/evaluations.md)
- Gumloop also has an "Agent performance" page (Insights, Evaluations, Tasks) and an Evaluations CLI and API. — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **n8n Evaluations:** "light evaluation" (a handful of examples, visual comparison, pre-deployment) and "metric-based evaluation" (larger dataset built from production executions, regression re-runs after each fix, numeric metric). — [n8n docs: Evaluations overview](https://docs.n8n.io/advanced-ai/evaluations/overview/)
- **Flowise (archived)** had evaluator and dataset endpoints, hardened in 3.1.2 (14 Apr 2026, inferred) with cost-calculation fixes. — [Flowise GitHub releases](https://github.com/FlowiseAI/Flowise/releases)
- **Dify** 1.18.0 (Oct 2026) puts "quality evaluations" inside the Beta Agent Knowledge Base. No separate eval feature is listed in recent releases. Dify 1.17.0 added opt-in unified tracing with Phoenix and LangSmith adapters, which is where third-party evals usually run. — [Dify GitHub releases](https://github.com/langgenius/dify/releases)
- **Langflow:** no LLM evaluation features in the 1.12–1.13 release notes. — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Human feedback:** Vellum's "Observability in Production" covers user-feedback integration alongside cost and accuracy tracking. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Phone agents:** Relevance added browser-based testing for phone agents without live calls (Jan 18, 2026). — [Relevance AI changelog](https://relevanceai.com/docs/changelog)

### Inferences
- For an n8n-like product, the n8n eval model (a dataset from a data table plus an evaluation trigger plus metric nodes) fits the workflow paradigm best. For Standalone Agents, Gumloop's model (criteria graded by an LLM judge on every completed conversation, alerts on failure) fits better and is easy to build with Landflow's existing OTel spans.
- Pricing evals as Enterprise features (Relevance, Gumloop org-level) suggests vendors see evals as an upsell for production teams.

### Gaps
- No platform reviewed has a first-class "A/B prompt" production split test documented in the pages read. Vellum's release tags and environments make it possible, but no A/B traffic-split page was found.
- Details of n8n's built-in metrics (correctness, helpfulness, tools-used) were not on the overview page fetched.

## Prompt and model management: versioning, routing, fallbacks, cost budgets, caching

### Takeaway
Vellum (legacy) remains the most complete reference: prompt sandbox, release tags, environments, release reviews, fallback models, prompt caching, and cost tracking. Elsewhere, management is thin. n8n added agent usage and budget settings and OpenRouter provider routing. Dify added reusable LLM environment variables. No open-source builder shows a native model-fallback chain in recent notes.

### Cited Findings
- **Vellum (legacy platform)** documentation covers:
  - Prompt Sandbox collaboration and version tracking, Jinja templating and function calling, custom models.
  - Multimodal inputs (images, documents).
  - Release Tags; Deployment Lifecycle Management to promote releases across Environments; Release Reviews (formal approval of Prompt/Workflow deployments).
  - "Fallback Models" architecture (dynamic model selection with fallback on errors, cost or performance).
  - Prompt Caching; workflow execution cost tracking; Datadog and webhook monitoring.
  - — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **n8n:**
  - 2.43 (Oct 6, 2026): AI Agent "usage and budget settings".
  - 2.36 (Aug 18, 2026): provider routing options for OpenRouter.
  - 2.45 (Oct 20, 2026): the AI log shows which model answered.
  - 2.38.1: provider ordering in the "Agent Builder" model picker.
  - The release notes do not describe a model fallback feature.
  - — [n8n release notes](https://docs.n8n.io/release-notes/)
- **Dify** 1.17.0 (Aug 2026, inferred): reusable LLM environment variables, so LLM nodes share one provider and model config. No model-routing feature is listed. — [Dify GitHub releases](https://github.com/langgenius/dify/releases)
- **Langflow** 1.13.0: deploy artifacts declare their required model providers and models. 1.12.0 added LLM provider latency and error metrics. — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Gumloop:** model catalog, a "choose the right AI model" guide, a "reduce agent credit spend" guide, BYO LLM key, and rate and concurrency limits. Agent tools (MCP) manage agent "models and versions". — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **Relevance AI:** per-model selection with reasoning levels (e.g. Gemini 3.5 Flash with four levels, Jun 12, 2026). Org spend filters, per-user usage analytics, and concurrency monitoring (Jan–Jul 2026). — [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **Lindy:** pooled credits; top-ups at $10 per 1,000 credits. — [lindy.ai](https://www.lindy.ai/)

### Inferences
- Cost caps are becoming table stakes for agents because autonomous loops can burn credits: n8n's budget settings, Langflow's 100-step Assistant budget and iteration-limit notices, Relevance's spend dashboards. Landflow needs at least per-agent and per-run token/cost limits and max-iteration limits.
- Prompt versioning matters less as a standalone product (Vellum moved away from it). It matters inside versioned agent/workflow publish, which Landflow already has. A lighter "prompt as a versioned asset referenced by nodes" would cover most needs.

### Gaps
- No primary source found for LLM response caching (semantic or exact-match) in Dify, Langflow, n8n, Gumloop or Relevance. Only Vellum documents provider prompt caching, and Langflow's MCP Tools component has a `use_cache` parameter for tool results ([Langflow MCP docs](https://docs.langflow.org/mcp-client)).
- Exact semantics of n8n's "usage and budget settings" (hard stop vs warning) were not read.

## Safety: guardrail nodes, PII redaction, moderation, approval steps

### Takeaway
Guardrails are now nodes in workflow-first tools: n8n's Guardrails node (PII, jailbreak, NSFW, secrets, URLs, topical, regex, keywords, custom LLM check; check or sanitize), Langflow's Guardrails component, and Vellum's Guardrail node. Agent-first platforms rely on human approval of tool calls, often answerable in Slack (Gumloop, Relevance, n8n, Vellum Assistant). Dify uses Human Input nodes with forms.

### Cited Findings
- **n8n Guardrails node:**
  - Two operations. "Check Text for Violations" routes to a Fail branch. "Sanitize Text" replaces URLs, regex matches, secret keys and PII with placeholders.
  - Types: PII, Jailbreak, NSFW, Secret Keys, URLs (allowlist), Topical Alignment, Custom Regex, Keywords, Custom (LLM-based).
  - Jailbreak, NSFW and Topical Alignment use a connected Chat Model.
  - — [n8n docs: Guardrails node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.guardrails/)
- **Langflow** 1.12.2 (16 Sep 2026, inferred): the Guardrails component gained optional combined rule and model checks. 1.12.5 redacts credentials in MCP responses. — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Vellum** "Guardrail Node" runs an inline evaluation with a predefined metric inside a workflow. Vellum also has an "Escalation to a Human" architecture. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Dify:**
  - Human Input node pauses workflows for review (first in v1.13.0 per a secondary review).
  - v1.17.0 enabled Human Input inside Loop and Iteration nodes. v1.17.1 fixed timeout branches.
  - v1.18.0 removed the agent-specific ask-human tool but kept the shared Human Input node.
  - Dify's difyctl blog says Human Input forms support dropdowns and file uploads.
  - No AI content-guardrail feature appears in 2026 release notes.
  - — [Dify GitHub releases](https://github.com/langgenius/dify/releases); [Dify blog: difyctl](https://dify.ai/blog/dify-s-official-cli-difyctl-ships); secondary: [vantaige.io](https://vantaige.io/ai-tool/dify)
- **Gumloop** "Human in the loop": tool approval settings, app rules, and an "Ask Question" ability. A code sandbox and secrets manager provide secure code execution. Agent access controls set who can use or change an agent. Hosted and proxied MCPs add monitoring and access control (Enterprise). — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **Relevance AI:** approve or reject agent tool requests directly in Slack (Jan 19, 2026). Daily charts for Approvals, Escalated and Errors tabs (May 29, 2026). — [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **n8n:** 2.35 (Aug 11, 2026) "enhanced approval for Slack and Telegram". 2.36 separates approval requests from tool calls in agent session timelines. — [n8n release notes](https://docs.n8n.io/release-notes/)
- **Vellum Assistant** asks permission for high-stakes or security-sensitive tasks until the user marks them trusted. — [vellum.ai](https://www.vellum.ai/)
- **Flowise** (archived) had no LLM guardrails. Only HTTP deny lists by default (3.1.0) and a stdio command allowlist for MCP (3.1.4). — [Flowise GitHub releases](https://github.com/FlowiseAI/Flowise/releases)

### Inferences
- Landflow already has per-tool human approval, which matches the agent-platform norm. Its gap is approvals delivered in chat channels (Slack/Teams/Telegram buttons; Telegram exists), approval forms with structured fields (Dify), and content guardrails as a node.
- A Guardrails node modeled on n8n's would close the most visible gap cheaply: regex/PII/secret/URL checks are deterministic, and jailbreak/NSFW/topical can reuse the existing chat-model connection (e.g. local Ollama).

### Gaps
- Dify's app-level "Content Moderation" feature (OpenAI moderation, keyword lists, API extension) was not checked against 2026 docs this session.
- No source found on built-in PII redaction of traces or logs (as opposed to inline text) in any of these platforms.

## Deployment: API, chat widget/embed, Slack/Teams bots, voice, MCP server exposure

### Takeaway
"Publish once, expose everywhere" is the norm. Dify publishes every app as a web app, API, website embed (chat bubble or iframe) and MCP server. Langflow runs an MCP server per project. Gumloop and Relevance deploy agents into Slack, Teams, email and hosted pages. Voice is growing: Relevance phone agents, Lindy phone, Langflow FunASR/Plivo, Vellum mobile voice, Gumloop Talk mode.

### Cited Findings
- **Dify publishing:** web app auto-generated per app (link on the Access Point tab), API, website embed as a chat widget or iframe, and MCP server ("available to Claude Desktop, Cursor… as a native tool"). Publishing replaces the live version across all four. — [Dify docs: Publish](https://docs.dify.ai/en/use-dify/publish/README); [Dify cloud docs: Publish](https://docs.dify.ai/en/cloud/use-dify/publish/README)
- Dify v1.16.0 (17 Jul 2026, inferred) upgraded the workflow-as-MCP server protocol with version negotiation and dynamic client headers. Dify Webhook Triggers launched Nov 21, 2025. — [Dify GitHub releases](https://github.com/langgenius/dify/releases); [Dify blog: Introducing Trigger](https://dify.ai/blog/introducing-trigger)
- **Langflow as MCP server and client:**
  - "Every Langflow project runs a separate MCP server that exposes the project's flows as MCP tools". Endpoints are `/api/v1/mcp/project/PROJECT_ID/streamable` and a global `/api/v1/mcp/streamable`, and auth headers can be forwarded.
  - As a client, the MCP Tools component supports JSON/STDIO/HTTP/SSE servers, with header values from global variables and an admin lock on server management.
  - — [Langflow docs: MCP client and server](https://docs.langflow.org/mcp-client)
- Langflow deployment: deterministic deploy artifacts with KB and memory dependencies (1.12.0), atomic replacement and snapshots (1.13.0). Voice and telephony: FunASR transcription and a Plivo SMS/voice-call bundle (1.13.0). — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Flowise** (archived) 3.1.3 (25 Jun 2026, inferred) let a chatflow act as an MCP server and added scheduled flows. — [Flowise GitHub releases](https://github.com/FlowiseAI/Flowise/releases)
- **Gumloop surfaces:** agents in Slack (including a custom Slack app), Microsoft Teams channels, a per-agent email inbox, hosted pages on gumloopagents.com, Talk mode, versioned/shareable "agent artifacts", and an API. The Gumloop MCP server works with Claude/Cursor/VS Code/Windsurf and can serve as the org's "auth layer" for connected tools. — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **Relevance AI:** built-in chat with a mobile app and saved prompts. Microsoft Teams integration for triggering agents (Mar 9, 2026) with an outreach-only reply mode (May 21, 2026). Teams calendar triggers (Feb 24, 2026). Relevance MCP (May 2026 RBAC update). — [Relevance AI docs](https://relevanceai.com/docs); [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **Lindy:** Phone Calls (answers, takes messages, places calls), MCP servers (actions built from published tools), Slack commands, and Artifacts (hosted dashboards and pages on a link). — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt)
- **Make:** a "Make MCP server" and "MCP toolboxes" in its Model Context Protocol docs. — [help.make.com (menu)](https://help.make.com/your-profile)
- **n8n:**
  - MCP Server Trigger gained a server-instructions field (2.36), with more client presets in the connect dialog (2.42, 2.44).
  - "Message an Agent" workflows gained opt-in response streaming (2.37, Aug 25, 2026).
  - — [n8n release notes](https://docs.n8n.io/release-notes/)
- **Vellum Assistant** surfaces: Mac, iOS, Android, web, voice, email, Telegram, Slack, terminal. — [vellum.ai](https://www.vellum.ai/)
- **Streaming:** Dify 1.18.0 added streaming text for plain Agent v2 nodes. — [Dify GitHub releases](https://github.com/langgenius/dify/releases)

### Inferences
- MCP server exposure (flows and agents as MCP tools) and an MCP client (consuming external servers as agent tools) are now universal: Dify, Langflow, Flowise, Gumloop, Lindy, Make, n8n and Relevance all have them. Landflow's lack of MCP is its most conspicuous gap.
- An embeddable chat widget plus streaming is the default way Dify-class products ship customer-facing bots. Without it Landflow cannot serve the "build a support bot for my website" use case that drives a lot of Dify adoption.
- Slack/Teams/email as agent channels matter more than voice for most buyers. Voice is a differentiator for sales and support verticals (Relevance phone agents, Lindy phone).

### Gaps
- Dify's built-in Slack/Teams bot publishing (vs. plugins) was not confirmed this session.
- Whether Relevance offers an embeddable website chat widget in 2026 was not found in the changelog.

## Agents: multi-agent patterns, memory, planning, background/scheduled agents, browser/computer use

### Takeaway
Agent features have converged: skills (reusable instructions), schedules and event triggers, file-based or long-term memory, sandboxed code execution, browser use, and multi-agent handoffs. Relevance "Workforces" and Dify "Output Routes" are the clearest structured multi-agent and agent-routing constructs. Gumloop and Lindy lead on browser/computer use and "teach by demonstration".

### Cited Findings
- **Dify:**
  - v1.16.0: Agent App open beta.
  - v1.17.0: rebuilt agent with an E2B cloud sandbox, build-time snapshots, and workspace-level skill management.
  - v1.18.0: "Output Routes", where the agent picks the next workflow branch; nested-run drilldown.
  - — [Dify GitHub releases](https://github.com/langgenius/dify/releases)
- **Relevance AI:**
  - Workforces: multi-agent teams on a visual canvas with handoffs.
  - Invent: builds agents from a description, and from Sep 3, 2026 creates and edits Agents, Workforces, Knowledge tables, Triggers and Evals.
  - Pause, cancel and resume controls for Workforce triggers (Jan 2026) and Agent triggers (Mar 2026).
  - Marketplace of cloneable agents, tools and workforces.
  - — [Relevance AI docs](https://relevanceai.com/docs); [Relevance AI changelog](https://relevanceai.com/docs/changelog)
- **Gumloop:**
  - Agent skills (instructions, templates, scripts).
  - Agent browser with saved logins, profiles and 1Password, plus user takeover. Guidance on connector vs API vs browser.
  - Code sandbox.
  - Triggers on schedules, emails and Slack messages; "Create triggers with AI" builds polling triggers.
  - Gumball personal agent (inbox labeling, morning report, pre-meeting briefs).
  - Agent access controls.
  - — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- Gumloop's vendor comparison claims its agents write, run and iterate on code in a sandbox, while n8n agents only call prewritten code. — [gumloop.com/vs/n8n](https://gumloop.com/vs/n8n)
- **Lindy:** Memory as a versioned, browsable, editable, shareable file system; Routines; Skills; Watch and Learn (demonstrate a task, get a skill and a routine); Ad Hoc Tasks. Computer use on Team plan. — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt); [lindy.ai](https://www.lindy.ai/)
- **Langflow:**
  - Agent catalog foundations and Langflow Assistant flow-building (1.12.0).
  - Assistant slash commands and a 100-step budget (1.12.3); Ollama support restored in the Assistant (1.12.2).
  - Spans for outbound A2A (agent-to-agent protocol) calls (1.12.0).
  - Run Flow-as-tool fix (1.12.3).
  - Background execution job metrics (1.13.0).
  - — [Langflow GitHub releases](https://github.com/langflow-ai/langflow/releases)
- **Zapier Agents:** agent-to-agent calling, agentic steps inside Zaps, web search, and an activity dashboard. — [Zapier blog: Zapier Agents](https://zapier.com/blog/zapier-agents/)
- **Make AI Agents:** agents get instructions, knowledge and tools (modules, scenarios, MCP tools). There is a Make AI Agents app for use inside scenarios. — [Make Help: AI Agents](https://help.make.com/make-ai-agents)
- **n8n:**
  - AI Agent option to force a tool call on the first iteration (2.40).
  - Configurable workflow-tool inputs and an agent setup checklist (2.44).
  - Queued messages in preview chat (2.42).
  - An "Agent Builder" model picker (2.38.1), which suggests n8n now has a standalone agent builder alongside "Message an Agent".
  - — [n8n release notes](https://docs.n8n.io/release-notes/)
- **Vellum (legacy):** Agent Node with automatic schema handling and loop logic; Agent Builder from natural language. — [docs.vellum.ai/llms.txt](https://docs.vellum.ai/llms.txt)
- **Vellum Assistant:** browse web, deep research, monitor websites, recurring background tasks, configurable autonomy. — [vellum.ai](https://www.vellum.ai/); [automationatlas.io](https://automationatlas.io/tools/vellum/)

### Inferences
- Landflow's Standalone Agents (instructions, on-demand Skills, sub-agents as tools, per-tool approval, session and cross-session memory, versioned publish, cron, Telegram, a "Message an Agent" node) closely match the 2026 feature set of n8n, Dify Agent App and Gumloop. The gaps are execution environments (code sandbox, browser use), event triggers beyond cron (email inbox, Slack message, webhook-to-agent), memory transparency (Lindy's editable memory files), and structured multi-agent constructs (handoff/router/supervisor).
- Landflow's AI flow builder and editor assistant run on local Ollama, which is a privacy differentiator. Langflow (Assistant with Ollama), Relevance (Invent) and n8n (AI builder) all have builder assistants, so the feature is expected rather than unique.

### Gaps
- No primary source this session on explicit "planning" modules (plan-and-execute) in any platform. Most rely on model reasoning plus step budgets.
- Memory types beyond Lindy's (files) and Dify/Langflow's (vector-backed memory) were not documented in pages read for Gumloop and Relevance.

## Why users choose these tools over n8n/Zapier (reviews and community sentiment)

### Takeaway
Sources consistently say: Dify when the AI app itself (RAG chatbot, prompt and retrieval tuning) is the product; Langflow for Python/LangChain developers prototyping visually; Gumloop/Lindy/Relevance for business users who want agents fast without wiring; n8n for integrating business systems with AI as one step, plus self-hosting and control. Most "Reddit" sentiment found was secondhand, quoted in vendor blogs.

### Cited Findings
- "If the AI app is what you ship, Dify wins; if the work is moving data between business apps and the model is one step in it, n8n does". Langflow targets "AI developers who already live inside the LangChain ecosystem". — [Activepieces: Dify vs n8n 2026](https://www.activepieces.com/blog/dify-vs-n8n-features-pricing-and-use-cases-2026.md); [Activepieces: Dify alternatives](https://www.activepieces.com/blog/dify-alternatives-4-options-compared-2026-guide.md) (vendor-affiliated)
- Dify needs more RAM than n8n, which raises self-hosting cost. — [Activepieces: Dify alternatives](https://www.activepieces.com/blog/dify-alternatives-4-options-compared-2026-guide.md) (vendor-affiliated)
- A Reddit thread quoted by eesel calls Gumloop easy to build and run but somewhat pricier. Gumloop bills credits (Pro $37/month for 20,000 credits) while n8n bills executions (Starter $20/month for 2.5K executions, annual). n8n has about 208k GitHub stars (Oct 19, 2026) and G2 4.7/5 from 319 reviews. — [eesel.ai: Gumloop vs n8n 2026](https://www.eesel.ai/blog/gumloop-vs-n8n)
- r/automation and r/n8n discussions show non-specialists preferring simple tools for fast deployment and developers preferring n8n for step-by-step testing and control (secondhand). — [quantrimang.com](https://quantrimang.com/gumloop-vs-n8n-nen-tang-tu-dong-hoa-workflow-nao-tot-hon-216382)
- Gumloop positions itself as "built for everyone in an organization" vs n8n "built for developers and low-code builders" (vendor claim). — [gumloop.com/vs/n8n](https://gumloop.com/vs/n8n)
- Flowise's exit rationale says coding agents are displacing rigid low-code canvases for complex work. — [Flowise sunset page](https://flowiseai.com/sunset)
- Lindy's pitch is replacing jobs rather than building workflows: an "AI employee" with role pages (Paid ads, Customer support, Bookkeeping). — [lindy.ai](https://www.lindy.ai/)

### Inferences
- The AI-native tools win on time-to-first-useful-agent: managed knowledge sync, Slack-native deployment, pre-built skills, and evals out of the box. n8n-like tools win on control, determinism, self-hosting and cost. Landflow can take both positions if it ships "batteries-included" RAG and MCP while keeping n8n-style control and local models.

### Gaps
- No first-hand Reddit threads were retrieved. WebSearch returned only blogs quoting Reddit. G2/Capterra review text for Dify, Gumloop and Relevance was not read.

## Comparison to Landflow: AI features Landflow lacks, what they do for users, and how much they matter

### Takeaway
Landflow is at or near parity on agent core: tool-calling agent node, standalone agents with skills, approvals, memory, schedules, versioned publish, OTel GenAI spans, and an AI builder. It lacks the four capabilities competitors treat as table stakes in 2026: MCP (client and server), built-in RAG/knowledge, a chat embed with streaming, and evals. Guardrails, cost controls and an observability UI are the next tier.

### Cited Findings
Evidence of competitor coverage per Landflow gap:
- **MCP client and server:**
  - Dify: workflow/app as MCP server. — [Dify publish docs](https://docs.dify.ai/en/use-dify/publish/README); [Dify releases](https://github.com/langgenius/dify/releases)
  - Langflow: per-project MCP servers plus the MCP Tools client. — [Langflow MCP](https://docs.langflow.org/mcp-client)
  - Flowise: chatflow as MCP server. — [Flowise releases](https://github.com/FlowiseAI/Flowise/releases)
  - Gumloop: custom, hosted and proxied MCPs plus its own MCP server. — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
  - Lindy — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt); Make — [help.make.com](https://help.make.com/your-profile); n8n MCP Server Trigger — [n8n releases](https://docs.n8n.io/release-notes/); Relevance MCP — [changelog](https://relevanceai.com/docs/changelog)
- **Vector stores / RAG / knowledge bases / loaders / chunking / rerankers:**
  - Dify Knowledge Pipeline, hybrid search and rerank. — [Dify KP blog](https://dify.ai/blog/introducing-knowledge-pipeline); [Dify retrieval docs](https://docs.dify.ai/en/cloud/use-dify/knowledge/integrate-knowledge-within-application.md)
  - Langflow KBs on pgVector/SQLite. — [Langflow releases](https://github.com/langflow-ai/langflow/releases)
  - Gumloop Brain hybrid search with citations. — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
  - Relevance knowledge sync from Drive/SharePoint/Notion/web/Confluence. — [Relevance docs](https://relevanceai.com/docs); [changelog](https://relevanceai.com/docs/changelog)
- **Evaluations / datasets / LLM-as-judge:** Vellum — [llms.txt](https://docs.vellum.ai/llms.txt); Relevance — [changelog](https://relevanceai.com/docs/changelog); Gumloop — [Evaluations](https://docs.gumloop.com/core-concepts/evaluations.md); n8n — [Evaluations](https://docs.n8n.io/advanced-ai/evaluations/overview/)
- **Guardrails:** n8n Guardrails node — [n8n docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.guardrails/); Langflow Guardrails component — [Langflow releases](https://github.com/langflow-ai/langflow/releases); Vellum Guardrail Node — [llms.txt](https://docs.vellum.ai/llms.txt)
- **Embeddable chat widget / web app:** Dify — [Dify publish docs](https://docs.dify.ai/en/use-dify/publish/README); Gumloop hosted pages — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **Streaming to end users:** n8n 2.37 — [n8n releases](https://docs.n8n.io/release-notes/); Dify 1.18.0 — [Dify releases](https://github.com/langgenius/dify/releases)
- **Model routing / fallbacks / cost caps:** Vellum Fallback Models — [llms.txt](https://docs.vellum.ai/llms.txt); n8n budget settings and OpenRouter routing — [n8n releases](https://docs.n8n.io/release-notes/)
- **LLM observability UI (cost per run, dashboards):**
  - Vellum cost tracking and production trends. — [llms.txt](https://docs.vellum.ai/llms.txt)
  - Relevance usage and error dashboards. — [changelog](https://relevanceai.com/docs/changelog)
  - Gumloop Agent performance (Insights). — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
  - Dify nested-run drilldown and TTFT spans. — [Dify releases](https://github.com/langgenius/dify/releases)
- **Prompt management / versioning:** Vellum Prompt Sandbox, release tags, environments, release reviews. — [llms.txt](https://docs.vellum.ai/llms.txt)
- **LLM response caching:** Vellum Prompt Caching. — [llms.txt](https://docs.vellum.ai/llms.txt)
- **Image/vision/file inputs:** Vellum multimodality — [llms.txt](https://docs.vellum.ai/llms.txt); Dify multimodal retrieval (1.17.0) — [Dify releases](https://github.com/langgenius/dify/releases)
- **Voice:**
  - Relevance phone agents. — [changelog](https://relevanceai.com/docs/changelog)
  - Lindy Phone Calls. — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt)
  - Langflow FunASR/Plivo. — [Langflow releases](https://github.com/langflow-ai/langflow/releases)
  - Vellum voice mode. — [TestingCatalog](https://www.testingcatalog.com/vellum-mobile-brings-voice-mode-and-mac-control-to-ios/)
  - Gumloop Talk mode. — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
- **Structured multi-agent orchestration:**
  - Relevance Workforces. — [Relevance docs](https://relevanceai.com/docs)
  - Dify Output Routes. — [Dify releases](https://github.com/langgenius/dify/releases)
  - Zapier agent-to-agent. — [Zapier blog](https://zapier.com/blog/zapier-agents/)
  - Langflow A2A spans. — [Langflow releases](https://github.com/langflow-ai/langflow/releases)
- **Human feedback collection:** Vellum production observability with user feedback. — [llms.txt](https://docs.vellum.ai/llms.txt)
- **Gaps not on Landflow's own list but common in competitors:**
  - Agent code sandbox: Dify E2B — [Dify releases](https://github.com/langgenius/dify/releases); Gumloop — [llms.txt](https://docs.gumloop.com/llms.txt)
  - Browser/computer use: Gumloop agent browser — [llms.txt](https://docs.gumloop.com/llms.txt); Lindy — [lindy.ai](https://www.lindy.ai/); Flowise Browserless MCP — [Flowise releases](https://github.com/FlowiseAI/Flowise/releases)
  - Agent channels in Slack, Teams and email: Gumloop — [llms.txt](https://docs.gumloop.com/llms.txt); Relevance Teams — [changelog](https://relevanceai.com/docs/changelog)
  - Approvals in Slack: Relevance — [changelog](https://relevanceai.com/docs/changelog); n8n Slack/Telegram approvals — [n8n releases](https://docs.n8n.io/release-notes/)
  - Human-input forms with dropdowns and file uploads: Dify — [difyctl blog](https://dify.ai/blog/dify-s-official-cli-difyctl-ships)
  - AI-created triggers: Gumloop — [llms.txt](https://docs.gumloop.com/llms.txt)
  - Teach-by-demonstration: Lindy Watch and Learn — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt)
  - Hosted agent-built artifacts/pages: Lindy Artifacts and Gumloop agent artifacts — [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt); [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
  - Dataset-scoped knowledge API keys: Dify 1.17.1 — [Dify releases](https://github.com/langgenius/dify/releases)
  - Deploy artifacts declaring required models: Langflow 1.13.0 — [Langflow releases](https://github.com/langflow-ai/langflow/releases)
- **Where Landflow already matches the market:**
  - Per-tool human approval (Gumloop, Relevance, n8n have equivalents). — [Gumloop llms.txt](https://docs.gumloop.com/llms.txt); [Relevance changelog](https://relevanceai.com/docs/changelog); [n8n releases](https://docs.n8n.io/release-notes/)
  - On-demand skills (Dify 1.17 workspace skills, Gumloop skills, Lindy skills). — [Dify releases](https://github.com/langgenius/dify/releases); [Gumloop llms.txt](https://docs.gumloop.com/llms.txt); [docs.lindy.ai/llms.txt](https://docs.lindy.ai/llms.txt)
  - OTel GenAI tracing (Langflow OTLP export 1.12.0; Dify Phoenix/LangSmith tracing 1.17.0). — [Langflow releases](https://github.com/langflow-ai/langflow/releases); [Dify releases](https://github.com/langgenius/dify/releases)
  - AI builder assistant (Langflow Assistant, Relevance Invent). — [Langflow releases](https://github.com/langflow-ai/langflow/releases); [Relevance changelog](https://relevanceai.com/docs/changelog)
  - Scheduled agents (Flowise 3.1.3 scheduled flows; Gumloop and Relevance triggers). — [Flowise releases](https://github.com/FlowiseAI/Flowise/releases); [Gumloop llms.txt](https://docs.gumloop.com/llms.txt)
  - "Message an Agent" with streaming (n8n 2.37). — [n8n releases](https://docs.n8n.io/release-notes/)

### Inferences
Prioritized gap list. Priorities are this researcher's assessment based on how many competitors ship each feature and how central it is to the use cases in the sentiment findings.

| # | Missing AI feature | What it does for users | Who has it (2026) | Priority |
|---|---|---|---|---|
| 1 | **MCP client** (consume external MCP servers as agent tools) | Plugs thousands of third-party tools into agents with no node development, and keeps pace with the ecosystem | Langflow, Gumloop, Lindy, Make, n8n, Relevance, Flowise | **Core** |
| 2 | **MCP server** (expose workflows and agents as MCP tools) | Lets Claude Desktop, Cursor and coding agents call Landflow automations. This also hedges the "coding agents replace canvases" threat Flowise cited | Dify, Langflow (per project), Flowise, Gumloop, n8n, Make | **Core** |
| 3 | **Vector store + retrieval nodes** (pgvector/SQLite-vec/Qdrant; hybrid search) | Grounds answers in company data. This is the number-one LLM use case (doc Q&A, support bots) | Dify, Langflow, n8n, Vellum | **Core** |
| 4 | **Document loaders and chunking** (PDF/Office/HTML parsing, recursive and parent-child chunking, OCR) | Turns raw files into retrievable chunks without custom code | Dify Knowledge Pipeline (General/Parent-Child/Q&A, Unstructured/LlamaParse/OCR) | **Core** (with #3) |
| 5 | **Managed knowledge base object attachable to agents** (with sync from Drive/Notion/Confluence/web and re-index on change) | Business users connect sources once and agents can search them, with citations | Gumloop Brain, Relevance, Zapier Agents, Dify | **Important** |
| 6 | **Rerankers** (Cohere/Jina/local cross-encoder) | Raises retrieval precision, especially across multiple KBs and languages | Dify | **Important** (part of RAG quality) |
| 7 | **Streaming responses to end users** | Chat feels responsive; needed for any user-facing bot | Dify, n8n | **Core** for chat use cases |
| 8 | **Embeddable chat widget / hosted chat web app** | Ship a website support bot in minutes; drives much of Dify adoption | Dify (bubble/iframe/web app), Gumloop hosted pages | **Core** for customer-facing bots |
| 9 | **Evaluations** (datasets, offline runs, LLM-as-judge metrics, regression runs, plus online judging of production runs) | Lets teams change prompts or models without silently breaking quality; required for production confidence | Vellum, n8n, Relevance, Gumloop, (Flowise) | **Important**, trending to core for production buyers |
| 10 | **Guardrails node** (PII/secret detection and sanitize, jailbreak, NSFW, topical, regex, custom LLM check) | Blocks or sanitizes unsafe input and output; compliance checkbox for enterprises | n8n, Langflow, Vellum | **Important** |
| 11 | **Cost caps and budgets** (per agent, per run, per workspace; max iterations) | Stops runaway agent loops from burning money; predictable spend | n8n budget settings, Relevance spend dashboards, Langflow step budgets | **Important** |
| 12 | **LLM observability UI** (cost per run, token dashboards, model used, latency/TTFT, nested run drilldown) | Debug and optimize without exporting OTel to a third-party backend | Vellum, Relevance, Gumloop, Dify | **Important** (Landflow already emits the data) |
| 13 | **Model fallbacks and routing** (fallback on error or rate limit, route by cost or latency) | Reliability when a provider fails; cost optimization | Vellum, n8n (OpenRouter routing) | **Important** |
| 14 | **Image/vision/file inputs to LLM nodes and agents** | Invoice/receipt extraction, screenshot triage, document Q&A from uploads | Vellum, Dify (multimodal retrieval) | **Important** |
| 15 | **Embeddings beyond OpenAI** (Ollama/local, Cohere, etc.) | Fully local RAG, which matches Landflow's Ollama-first positioning | Dify (multiple providers), Langflow | **Important** (cheap) |
| 16 | **Agent channels: Slack, Teams, email inbox, plus approvals inside those channels** | Agents live where work happens; approve tool calls from chat | Gumloop, Relevance, n8n | **Important** (Landflow has Telegram only) |
| 17 | **Structured multi-agent patterns** (supervisor/router, handoff, workforce canvas, A2A) | Splits complex jobs across specialist agents with visible handoffs | Relevance Workforces, Dify Output Routes, Zapier agent-to-agent, Langflow A2A | **Nice-to-have** (Landflow already has sub-agents as tools) |
| 18 | **Code sandbox tool for agents** | Agents can analyze data, transform files and write scripts safely | Dify (E2B), Gumloop | **Important** for agent-first users |
| 19 | **Browser / computer use tool** | Automates sites with no API | Gumloop agent browser, Lindy, Vellum Assistant | **Nice-to-have** to important (expensive, brittle) |
| 20 | **Prompt management and versioning** (prompt library, versions, environments, release reviews) | Non-developers tune prompts safely; audit trail | Vellum | **Nice-to-have** (Landflow's versioned agent publish covers much of it) |
| 21 | **LLM response caching** (exact or semantic; provider prompt caching) | Cuts cost and latency for repeated prompts | Vellum (prompt caching) | **Nice-to-have** |
| 22 | **Human feedback collection** (thumbs up/down in chat, feedback API feeding datasets) | Closes the loop from production to evals | Vellum | **Nice-to-have** (important once evals exist) |
| 23 | **Voice** (STT/TTS nodes, phone agents via Twilio/Plivo) | Phone support and sales agents | Relevance, Lindy, Langflow, Vellum, Gumloop Talk mode | **Nice-to-have** (vertical) |
| 24 | **Structured human-input forms** (dropdowns, file upload, timeout branch) | Richer approvals than approve/deny | Dify | **Nice-to-have** |
| 25 | **AI-generated triggers / teach-by-demonstration** | Faster setup for non-technical users | Gumloop, Lindy | **Nice-to-have** |

- Suggested sequencing: (1) MCP client and server. (2) RAG basics (#3, #4, #6, #15) plus knowledge-as-agent-tool. (3) Streaming plus chat widget. (4) Guardrails node and cost caps. (5) Evals built on existing OTel spans, then an observability UI. This order covers the features nearly every competitor shipped in 2025–2026 before the differentiators.
- Landflow differentiators to keep: local-Ollama AI builder and editor assistant (privacy), multi-language plugins as agent tools, and OTel GenAI semantics. Few competitors document local-model builder assistants. Langflow restored Ollama in its Assistant only in 1.12.2.

### Gaps
- Priority ratings are judgment calls. No usage or demand data (e.g. feature-request counts) was found to weight them.
- Pricing tiers for competitor AI features (which are Enterprise-only) were checked only for Relevance Evals, Gumloop org evals, and Lindy computer use.
