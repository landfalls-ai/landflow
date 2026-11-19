# Landflow docs

Everything about Landflow, the low-code workflow platform where every node is a plugin: what it does, how it is built,
how to run it and how to change it. The [project README](../README.md) has the quick start.

## Platform guide

**[platform/README.md](platform/README.md)** is the guided tour of the whole platform: an [overview](platform/overview.md),
the [layers of the host server](platform/server-layers.md), [agents](platform/agents.md) and their [best practices](platform/agent-best-practices.md), the
[Kubernetes components](platform/kubernetes.md) and the three [SDKs](platform/sdk/README.md) with runnable samples in
[`examples/sdk/`](../examples/sdk/README.md). Each page has a matching skill for Claude in the `landflow-dev` plugin
([`claude-plugins/landflow-dev`](../claude-plugins/landflow-dev/README.md)): open this repository with Claude Code and
the skills and agents load from `.claude/`; in another repository, install the plugin from this repository's
marketplace.

## Start here

1. **[architecture.md](architecture.md)**: the processes and what each owns, a run from trigger to result, every
   subsystem, and a map of the code.
2. **The feature page** for the area you care about (the [feature map](#feature-map) below).
3. **[development.md](development.md)**: setup, where to start reading the code, conventions, and every test command.
4. **[limitations.md](limitations.md)** and **[roadmap.md](roadmap.md)**: what is not there yet, and what each wave
   built. [history.md](history.md) lists every change in order.
5. **[constitution.md](constitution.md)** before you change anything: the rules every research and implementation
   starts from, and the order a feature goes through.
6. **[specs/](specs/README.md)**: proposals for the features not built yet, one spec each.

## Feature map

| Feature | Page | Contract or deeper doc |
|---|---|---|
| Editor: canvas, node creator, runs, pinned data, debugging, versions, templates; importing from n8n and Flowise | [features/editor.md](features/editor.md) | [ui-review.md](ui-review.md) |
| Editor assistant: suggestions after a run, Spotlight (the builder chat) | [assistant.md](assistant.md) | |
| Spotlight fixes and publishes by itself: an Autonomous test-and-fix session applies its flow and agent fixes on saved and published flows, approves its test runs' tool calls to given destinations, picks the one fitting credential, publishes the agent through the eval gate and then the workflow; the production-approval line | [assistant.md](assistant.md#autonomous-mode) | [agents.md](agents.md) |
| Landflow on a phone: the tab bar, full-screen pages, the app bar, the editor's header, touch and type | [mobile.md](mobile.md) | |
| Second brain: the usage ledger, detectors and the Suggestions inbox, facts, the Platform analyst, your own conclusions, flow detectors (Detector Trigger), custom event kinds (Record Event), entities, flow buttons (On Suggestion Decided), audiences and Slack DMs, Find Similar and `check_overlap`, declared metrics, backtests, the nightly SDLC velocity flow (Velocity Signals, Propose Flows, **Build it**) | [second-brain.md](second-brain.md) | [observability.md](observability.md), [second-brain.md](second-brain.md#nightly-sdlc-velocity) |
| Connect your harness: `/connect`, copy-paste setup and a brain key for Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code and any MCP client; the admin's switch for automatic sending | [connect-your-harness.md](connect-your-harness.md) | [landflow-brain-mod.md](landflow-brain-mod.md) |
| The landflow-brain Claude Code mod: your own session as a held, private `work.session`, reviewed before it is sent, with yesterday back at the next session, and the colleagues whose work overlaps yours (`/brain sync`, a pane, a band) | [landflow-brain-mod.md](landflow-brain-mod.md) | [work-and-briefings.md](work-and-briefings.md) |
| Work events and the daily briefing: what people's tools tell the brain about their work, private to the person (even from admins) until they share it with a team or the organization, related colleagues, repos as systems, the `brain:read` and `brain:write` API key scopes, `POST/DELETE /api/brain/work`, `GET /api/brain/briefing`, the nightly Tomorrow sync template that writes each person's briefing | [work-and-briefings.md](work-and-briefings.md) | [second-brain.md](second-brain.md#1-the-usage-ledger) |
| The Brain page: the second brain as Markdown files in an editor's workbench (Explorer, tabs, Preview and Source, quick open, Problems), a file per person, customer and initiative with a summary the model writes, Spotlight to ask it, and work shared across teams | [second-brain.md](second-brain.md#the-brain-page) | [research/brain-ui-research.md](research/brain-ui-research.md) |
| Practices: rules in the brain that connected agents follow, each with versions, a scope and a strength, approved by a person (owners and admins for the organization, a project's admins for the project); drafts from people, agents and flows are tainted until read against their sources; conflicts, waivers, the API and `LANDFLOW_PRACTICES` | [practices.md](practices.md) | [reference/api.md](reference/api.md) |
| Practices delivered to Landflow and kagent agents (the block, the index, `practices_for`, citations) | [practices.md](practices.md#following) | [run-trace.md](run-trace.md#what-it-saw) |
| Check Practices: a required practice fails a flow's step until fixed or waived, the pull request check and blocked templates, the waive page | [practices.md](practices.md#the-check-practices-step) | [features/cli.md](features/cli.md) |
| Notion as the brain: how Landflow talks to Notion (version, Markdown v2, limits, retries, the write scope, the write log) | [features/notion-brain.md](features/notion-brain.md#how-landflow-talks-to-notion) | [development.md](development.md#the-notion-fake) |
| Practice compliance and the inbox: given, cited, passed and waived per practice, the run's practices row, the practice-drift detector, a suggestion for every draft | [practices.md](practices.md#compliance) | [second-brain.md](second-brain.md) |
| Composite nodes: groups typed by a contract (slots, rules, ports), checked in the editor, run as one step | [composites.md](composites.md) | [protocol.md](protocol.md) §3 |
| Postgres mode's write queue: the spool, the blocked state, recovery and metrics | [features/postgres-write-queue.md](features/postgres-write-queue.md) | [features/engine.md](features/engine.md) |
| Engine: data model, durable runtime, queue mode and HA, triggers and flow nodes (Ask a Person), debounce and rate limits, Code node | [features/engine.md](features/engine.md) | [architecture.md](architecture.md) |
| Plugins: the node interface in each SDK, autodiscovery, branding | [plugins.md](plugins.md) | [protocol.md](protocol.md) |
| Transports: HTTP, gRPC, ten brokers (eleven kinds, JetStream counted apart from NATS), Auto, the claim check, MCP faces | [transports.md](transports.md) | [protocol.md](protocol.md) §14–15 |
| LLM gateway (LiteLLM): run it, image pin, models, Kubernetes example | [llm-gateway.md](llm-gateway.md) | [deployment.md](deployment.md#the-llm-gateway) |
| MCP gateway (agentgateway): sync, identity, tokens | [mcp-gateway.md](mcp-gateway.md) | [transports.md](transports.md) |
| AI: AI Agent and sub-nodes, hosted chat and widget, RAG, guardrails, evaluations, MCP | [features/ai.md](features/ai.md) | |
| Spotlight knows the tenant: tools for agents (drafts included), tool nodes with their plugin and credential needs, knowledge bases, models and credentials by name, and the written agent best practices; the same tools and `create_agent`, `update_agent`, `test_agent`, `publish_agent` on the instance MCP server | [assistant.md](assistant.md#agents-and-teams) ([MCP](features/ai.md#mcp), [best practices](platform/agent-best-practices.md)) | [reference/api.md](reference/api.md) |
| Standalone agents: personas, skills, capabilities, channels (Telegram, Slack, Teams), schedules, memory; the bubbles under a Run an Agent node showing what the agent is connected to; knowledge from a folder the Spotlight ask names | [agents.md](agents.md) ([the canvas bubbles](agents.md#from-workflows), [knowledge folders](agents.md#agent-architect)) | |
| Agent versions pinned in workflows: publishing pins each agent's version, production keeps it until a republish, "v3 is available" offers test-then-publish | [features/editor.md](features/editor.md) | [agents.md](agents.md#from-workflows) |
| Wiring moving into the agent: a model, tool or knowledge sub-node wired into a Run an Agent node moves into the agent's draft, with a notice and what stays "this flow only" | [agents.md](agents.md#from-workflows) | [assistant.md](assistant.md) |
| The LLM gateway: LiteLLM in front of the models, the Gateway field on the Anthropic API and OpenAI API credentials, who is calling, the call id and cost on each AI call | [llm-gateway.md](llm-gateway.md) | [agents.md](agents.md), [observability.md](observability.md) |
| Project context: the mission, goals and project brief an agent is given in each run, the pinned date, the per-agent switch | [agents.md](agents.md#project-context) | [agent-teams.md](agent-teams.md) |
| The agent roster: teams, persona templates, faces and other avatars, the Agent architect chat | [agents.md](agents.md#the-roster) | [second-brain.md](second-brain.md) |
| Agent teams: agents with a lead, reporting lines and reviewers, the org chart, budgets, publishing | [agent-teams.md](agent-teams.md) | [agents.md](agents.md#teams) |
| The team notebook: notes members write while they work, search by meaning, disputes, promotion to team and project, the Notebook tab, Claude Code members over MCP | [team-notebook.md](team-notebook.md) | [agent-teams.md](agent-teams.md), [second-brain.md](second-brain.md) |
| Remote agents over A2A (a capability and the A2A Agent node), kagent next to Landflow, tracing across both | [a2a.md](a2a.md) | [observability.md](observability.md#remote-agents-a2a) |
| Searching and comparing runs, measures over time, and exporting each run's journal over OTLP with OpenInference kinds | [run-trace.md](run-trace.md#search-compare-and-measures) | [reference/api.md](reference/api.md), [reference/configuration.md](reference/configuration.md) (`LANDFLOW_OTLP_TRACES_URL`) |
| Agents on kagent through the LLM gateway: a virtual key per agent, kagent's ModelConfig through LiteLLM, the spend import that counts their calls once | [llm-gateway.md](llm-gateway.md#agents-outside-landflow) | [a2a.md](a2a.md#landflow-agents-on-kagent) |
| Claude Code agents' real usage, cost and guardrails (the landflow-harness mod) | [a2a.md](a2a.md#the-landflow-harness-mod) | [run-trace.md](run-trace.md), [agent-teams.md](agent-teams.md) |
| Run Trace: each run's journal (who did what, requests between agents, waits, artifacts, checks), the Story, Trace, Team and Report screens, profiles, the Run report node and its gate, what each tool call reached | [run-trace.md](run-trace.md) ([what a tool call reached](run-trace.md#what-a-tool-call-reached)) | [protocol.md](protocol.md) (`records`) |
| Marketplace: Claude Code plugin marketplaces as agents, skills, node plugins and flows; flow share pages; agents and teams exported as Claude Code plugins | [marketplace.md](marketplace.md) | |
| Team templates: a team, its agents and its flow saved as one template and created again with fresh ids and credentials | [templates.md](templates.md) | [features/editor.md](features/editor.md), [agent-teams.md](agent-teams.md) |
| Asking for a higher AI cap: the Cap Raise Request trigger, the cap-raise template with Ask a Person, and Apply Cap Raise (LiteLLM wave) | [llm-gateway.md](llm-gateway.md#asking-for-a-higher-cap) | [templates.md](templates.md), [reference/api.md](reference/api.md) |
| Alert triage and Landfall war rooms: the triage, Landfall and threat-intel plugins and their flows | [triage.md](triage.md) | each plugin's README |
| Runbooks made from closed Landfall war rooms, found by alert kind | [runbooks.md](runbooks.md) | [triage.md](triage.md) |
| Integrations: messaging, productivity, Google Workspace, databases, the work ingest templates and GitHub into the brain (pull requests, reviews and CI as work events) | [features/integrations.md](features/integrations.md) | each plugin's README, [GitHub into the brain](features/integrations.md#github-into-the-brain) |
| Clickland observability: the plugin, Clickland as a knowledge base, alert triage, the assistant chat, telemetry into Clickland | [features/clickland.md](features/clickland.md) | [plugins/clickland](../plugins/clickland/README.md), [agents.md](agents.md#knowledge-bases-from-a-plugin) |
| Notion as the brain: a project linked to a Notion page, the check, the link routes and their rules (nothing syncs until wave nb2) | [features/notion-brain.md](features/notion-brain.md#setting-it-up) | [reference/api.md](reference/api.md), [limitations.md](limitations.md#what-the-notion-brain-does-not-do) |
| Approval inbox: production approvals wait in Needs you with a mail or alert nudge, Approve or Deny, an expiry, one claim behind every door | [approval-inbox.md](approval-inbox.md) | [reference/api.md](reference/api.md), [agents.md](agents.md#from-workflows) |
| Landledger cost approvals: the plugin, infra change and AI budget requests, Slack approvals relayed to Landledger, tool-or-seat costs with Landbright, variance-note drafts at month end, an incident's cost in the Landfall room | [features/landledger.md](features/landledger.md) | [plugins/landledger](../plugins/landledger/README.md) |
| Web Search: SearXNG, Brave Search and Tavily as an agent tool, titles, links and snippets only | [web-search.md](web-search.md) | [plugins/web-search](../plugins/web-search/README.md) |
| Browser: read a page, run listed steps, extract values, take a screenshot, packaged as its own image | [plugins/browser](../plugins/browser/README.md) | [deployment.md](deployment.md#browser-plugin) |
| Agent Shell: a safe in-memory bash an agent can use as a tool, no host files and no network (opt-in plugin) | [plugins/agent-shell](../plugins/agent-shell/README.md) | [research/just-bash-verdict.md](research/just-bash-verdict.md) |
| AI SDK: a Generate with AI SDK node over Ollama, OpenAI-compatible, Anthropic or Google, with OpenTelemetry spans, usage in AI usage and the caps, and a model span in Run Trace (opt-in plugin, `pnpm plugin:ai-sdk`) | [research/ai-sdk-verdict.md](research/ai-sdk-verdict.md) | [limitations.md](limitations.md#debugging-chat-with-agents-browser-and-web-search-built-2026-11-07) |
| Spec cards in Run Trace drawn with json-render, behind `LANDFLOW_JSON_RENDER` | [research/json-render-verdict.md](research/json-render-verdict.md) | [reference/configuration.md](reference/configuration.md) |
| Debug token: a read-only key to one execution for a debugging agent (`landflow debug-token`, or Debug access on the Run Trace page) | [specs/19-debug-token.md](specs/19-debug-token.md) | [reference/api.md](reference/api.md), [features/cli.md](features/cli.md) |
| Images in tool results: a tool can return a screenshot or other image to the AI Agent's model | [features/ai.md](features/ai.md) | [specs/18-desktop-agent-node.md](specs/18-desktop-agent-node.md) |
| Specs: proposals written before the code (fifteen next features from 2026-11-05, chat with agents, the parallel build plan, the Desktop agent node, the debug token) | [specs/README.md](specs/README.md) | |
| Files and binary data | [features/files.md](features/files.md) | [protocol.md](protocol.md) §11 |
| The LLM gateway (LiteLLM) and the AI page: spend by project, agent, person, model and source, caps, requests | [llm-gateway.md](llm-gateway.md) | [observability.md §8](observability.md) |
| The AI page's trend, movers, drill-down to one call, forecast to month end, prompt cache card and your own spend (You card), over 24 hours to 400 days | [llm-gateway.md](llm-gateway.md#the-ai-page) | [reference/api.md](reference/api.md) |
| The Run Trace's Spend tab and one call's view: totals, spend by purpose, model, node, agent and step, the cache line and what the prompt was made of | [run-trace.md](run-trace.md#spend) | [run-trace.md](run-trace.md#one-call) |
| Forecasts over a cap and unusual spend: alerts, Needs you and the brain's inbox | [llm-gateway.md](llm-gateway.md#forecasts-and-unusual-spend) | [run-trace.md](run-trace.md#needs-you-for-ai-spend) |
| The waste detectors: context bloat, fat tool results, unused tools, cache misses, repeated calls and agent loops | [second-brain.md](second-brain.md#4-detectors-and-suggestions) | [llm-gateway.md](llm-gateway.md#what-each-call-was-for) |
| Your own spend in MCP (`my_ai_spend`), the CLI (`landflow spend`) and the landflow-brain mod's status line | [features/cli.md](features/cli.md#your-ai-spend-landflow-spend) | [landflow-brain-mod.md](landflow-brain-mod.md) |
| Local model prices: Settings → AI prices, Ollama and gateway rows priced once | [observability.md](observability.md#8-token-and-cost-tracking) | [llm-gateway.md](llm-gateway.md#the-ai-page) |
| The gateway's split of each call (kagent, Claude Code) with the model's own tokenizer | [llm-gateway.md](llm-gateway.md#the-gateways-split) | [llm-gateway.md](llm-gateway.md#what-a-prompt-was-made-of) |
| Token spend, wave by wave: what was built, the decisions, what is left | [roadmap.md](roadmap.md#token-spend-waves-1114-where-it-stands) | [limitations.md](limitations.md#token-spend-what-it-cannot-do-yet) |
| Settings, variables, data tables, insights | [features/settings-and-data.md](features/settings-and-data.md) | |
| LLM gateway (LiteLLM), budgets in LiteLLM | [llm-gateway.md](llm-gateway.md) | |
| Authentication: users, roles, projects, API keys, OIDC, SAML, SCIM | [features/authentication.md](features/authentication.md) | |
| Projects and goals: the company mission, the goal tree, the goals a project serves, initiative links and the project brief | [projects-and-goals.md](projects-and-goals.md) | [reference/api.md](reference/api.md) |
| Agents across projects: sharing an agent to projects or all of them, Available in, Test in project with the preview, View prompt | [projects-and-goals.md](projects-and-goals.md#agents-across-projects) | [agents.md](agents.md#project-context) |
| What an agent saw: the block, practices and persona a run's agent was given, in Run Trace and the agent's sessions | [projects-and-goals.md](projects-and-goals.md#what-an-agent-saw) | [run-trace.md](run-trace.md#what-it-saw) |
| Cost per goal: the Goal grouping on the AI page | [projects-and-goals.md](projects-and-goals.md#what-a-goal-costs) | [llm-gateway.md](llm-gateway.md#the-ai-page) |
| Project context for harnesses: a project's repositories, `GET /api/projects/context`, MCP `project_context`, the mod's project section and `landflow work context` | [projects-and-goals.md](projects-and-goals.md#repositories-and-harnesses) | [connect-your-harness.md](connect-your-harness.md) |
| Project settings for agents: a project's default model, knowledge base, allowed agents and tool kinds, the Agents in this project card | [projects-and-goals.md](projects-and-goals.md#project-settings-for-agents) | [agents.md](agents.md), [reference/api.md](reference/api.md) |
| Sessions belong to a project: an agent's session is read and continued only from the project it ran in; sharing an agent never shares its sessions | [projects-and-goals.md](projects-and-goals.md#sessions-belong-to-a-project) | [agents.md](agents.md) |
| Project AI budget: a monthly budget per project as one more cap, the warning, the optional hard stop, incidents, Needs you items, Resume, Raise and Ask for more | [projects-and-goals.md](projects-and-goals.md#ai-budget) | [llm-gateway.md](llm-gateway.md#asking-for-a-higher-cap), [run-trace.md](run-trace.md#needs-you-for-a-project-budget) |
| Project workspace for harness runs: the repositories screen, a default branch and setup commands per repository, worktree per run or shared, the branch template | [projects-and-goals.md](projects-and-goals.md#workspace) | [connect-your-harness.md](connect-your-harness.md), [harnesses.md](harnesses.md) |
| Audit log and governance: SIEM streaming, signed heads, approvals, four-eyes | [features/audit-and-governance.md](features/audit-and-governance.md) | |
| External secrets and environments | [features/secrets-and-environments.md](features/secrets-and-environments.md) | |
| Git sync | [features/git-sync.md](features/git-sync.md) | |
| Observability: traces, metrics, logs | [features/observability.md](features/observability.md) | [observability.md](observability.md) |
| CLI: workflows, runs and executions, and debugging a run (`debug-bundle`, `replay`, `claude init`, `executions watch`) | [features/cli.md](features/cli.md) | [packages/cli](../packages/cli/README.md) |
| HTTP API | [reference/api.md](reference/api.md) | `GET /api/openapi.json` |
| Environment variables | [reference/configuration.md](reference/configuration.md) | |
| Docker, Kubernetes, the infra stack, telemetry on Kubernetes | [deployment.md](deployment.md) | [deploy/](../deploy/README.md) |

## Every document

**Design and contracts**

- [architecture.md](architecture.md): how the pieces fit, end to end.
- [protocol.md](protocol.md): `landflow.plugin/v1`, the descriptor, Execute, manifests, credentials, binary data, app
  webhooks, messaging and MCP mapping.
- [transports.md](transports.md): the transport plan as built: generic brokers, Auto, the bridge, MCP faces and the
  bundled gateway.
- [mcp-gateway.md](mcp-gateway.md): agentgateway in Landflow, what was verified and how to rerun the spike.
- [practices.md](practices.md): rules agents follow, approved by a person: drafts and taint, versions and the hash, conflicts,
  waivers, globs and checks, the API and `LANDFLOW_PRACTICES`.
- [observability.md](observability.md): the OpenTelemetry contract: span names, attributes, metrics, logs.
- [llm-gateway.md](llm-gateway.md): the LLM gateway (LiteLLM) in front of every model call, its budgets, and asking for a higher cap.

**Features**: the twelve pages under [features/](#feature-map), plus [plugins.md](plugins.md),
[assistant.md](assistant.md), [second-brain.md](second-brain.md), [composites.md](composites.md), [agents.md](agents.md), [agent-teams.md](agent-teams.md), [team-notebook.md](team-notebook.md), [a2a.md](a2a.md),
[landflow-brain-mod.md](landflow-brain-mod.md), [run-trace.md](run-trace.md), [web-search.md](web-search.md) and [marketplace.md](marketplace.md).

**Reference**: [reference/api.md](reference/api.md) (every route), [reference/configuration.md](reference/configuration.md)
(every host environment variable).

**Running and changing Landflow**

- [deployment.md](deployment.md): Compose stacks, ports and credentials, queue mode, the code runner, Kubernetes on
  OrbStack, telemetry on Kubernetes, kagent beside it, stop and reset.
- [constitution.md](constitution.md): the rules every research and implementation starts from (Claude Code reads it in
  every session).
- [development.md](development.md): setup, code tour, conventions, the full verification list, integration flags, and
  [working with Claude Code](development.md#working-with-claude-code-constitution-agents-feature-skill): the
  repository's own agents (`.claude/agents/`) and the feature skill (`.claude/skills/landflow-feature/`).
- [limitations.md](limitations.md): what Landflow does not do yet.
- [roadmap.md](roadmap.md): the waves, what each built, and what remains.
- [history.md](history.md): every change in order, the decisions along the way, and where each is documented.

**Reviews, plans and research**

- [ui-review.md](ui-review.md): a screen-by-screen comparison of the UI with n8n, the [words](ui-review.md#words) every screen uses and the [controls](ui-review.md#controls) every screen shares.
- [spotlight.md](spotlight.md): a new Home, the ⌘K Spotlight assistant and the action layer every AI or MCP change goes
  through (a plan; Spotlight in the editor is built, see [assistant.md](assistant.md#spotlight)).
- [ux-simplification.md](ux-simplification.md): what each screen asks of the user, and how to make it simpler (a plan,
  not built).
- [harnesses.md](harnesses.md): running Landflow agents inside Claude Code and other harnesses (a plan, parked; only
  its spike was run).
- [research/01-n8n-node-interface.md](research/01-n8n-node-interface.md),
  [02-n8n-workflow-engine.md](research/02-n8n-workflow-engine.md),
  [03-n8n-ai-agents.md](research/03-n8n-ai-agents.md),
  [04-n8n-integrations.md](research/04-n8n-integrations.md): the n8n research that drove the design.
- [research/company-brain-next-sources.md](research/company-brain-next-sources.md): what the Company Brain's P1 and P2
  sources (Base44 Report Scheduler, the Brandlight platform, Shapes, Clay, Mesh, Scytale, Microsoft 365) would need.
- [research/brain-ui-research.md](research/brain-ui-research.md): how other products show a company brain or LLM wiki,
  and what the Brain page took from them.
- [reports/Workflow platform feature gaps.md](<../reports/Workflow platform feature gaps.md>) and its notes in
  [research_notes/](<../research_notes/Workflow platform feature gaps>): the 2026 comparison with other workflow
  platforms that the roadmap's waves came from.

**Package and plugin READMEs**

| README | Covers |
|---|---|
| [packages/sdk](../packages/sdk/README.md) | the TypeScript SDK |
| [sdks/go](../sdks/go/README.md) | the Go SDK, its transport core and drivers |
| [sdks/python](../sdks/python/README.md) | the Python SDK, its transport core and drivers |
| [packages/transports](../packages/transports/README.md) | the messaging core and broker drivers (TypeScript) |
| [packages/protocol/conformance](../packages/protocol/conformance/README.md) | the conformance kit every SDK face and driver passes |
| [packages/cli](../packages/cli/README.md) | every `landflow` command and its JSON output |
| [services/landflow-bridge](../services/landflow-bridge/README.md) | broker kinds for plugins whose SDK lacks a driver |
| [plugins/text-toolkit](../plugins/text-toolkit/README.md), [py-insights](../plugins/py-insights/README.md), [go-crypto](../plugins/go-crypto/README.md) | the example plugins, one per SDK |
| [plugins/messaging](../plugins/messaging/README.md), [productivity](../plugins/productivity/README.md), [google-workspace](../plugins/google-workspace/README.md), [databases](../plugins/databases/README.md), [github](../plugins/github/README.md), [browser](../plugins/browser/README.md), [web-search](../plugins/web-search/README.md), [linear](../plugins/linear/README.md), [attio](../plugins/attio/README.md), [fathom](../plugins/fathom/README.md), [clickland](../plugins/clickland/README.md), [landledger](../plugins/landledger/README.md) | the integration plugins |
| [research/json-render-verdict](research/json-render-verdict.md), [ai-sdk-verdict](research/ai-sdk-verdict.md), [just-bash-verdict](research/just-bash-verdict.md) | what each Vercel open-source prototype showed and whether to keep it (all three stay as flags) |
| [research/workflow-sdk-spike](research/workflow-sdk-spike.md) | a test of Vercel's Workflow SDK as a home for runs: events per node, replay cost, crash recovery |
| [plugins/triage](../plugins/triage/README.md), [landfall](../plugins/landfall/README.md), [threat-intel](../plugins/threat-intel/README.md) | the triage plugins ([triage.md](triage.md)) |
| [deploy/k8s/examples/keda](../deploy/k8s/examples/keda/README.md) | KEDA autoscaling examples |
| [sdks/go/transport/testdata/live-brokers](../sdks/go/transport/testdata/live-brokers/README.md), [live](../sdks/go/transport/testdata/live/README.md) | the cross-language broker checks |

## Keeping the docs current

[constitution.md](constitution.md) has every rule in one place. A change updates the page for its feature,
[reference/](reference/api.md) for new routes or variables, [limitations.md](limitations.md) when it adds or lifts a
limit, and [roadmap.md](roadmap.md) when it closes or opens an item. Each commit gets a row in [history.md](history.md). New pages go in this index. [development.md](development.md#conventions) has the rest of the conventions.
