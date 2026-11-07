# Landflow docs

Everything about Landflow, the low-code workflow platform where every node is a plugin: what it does, how it is built,
how to run it and how to change it. The [project README](../README.md) has the quick start.

## Start here

1. **[architecture.md](architecture.md)**: the processes and what each owns, a run from trigger to result, every
   subsystem, and a map of the code.
2. **The feature page** for the area you care about (the [feature map](#feature-map) below).
3. **[development.md](development.md)**: setup, where to start reading the code, conventions, and every test command.
4. **[limitations.md](limitations.md)** and **[roadmap.md](roadmap.md)**: what is not there yet, and what each wave
   built. [history.md](history.md) lists every change in order.

## Feature map

| Feature | Page | Contract or deeper doc |
|---|---|---|
| Editor: canvas, node creator, runs, pinned data, debugging, versions, templates; importing from n8n and Flowise | [features/editor.md](features/editor.md) | [ui-review.md](ui-review.md) |
| Editor assistant: suggestions after a run, Spotlight (the builder chat) | [assistant.md](assistant.md) | |
| Second brain: the usage ledger, detectors and the Suggestions inbox, facts, the Platform analyst, your own conclusions | [second-brain.md](second-brain.md) | [observability.md](observability.md) |
| Composite nodes: groups typed by a contract (slots, rules, ports), checked in the editor, run as one step | [composites.md](composites.md) | [protocol.md](protocol.md) §3 |
| Engine: data model, durable runtime, queue mode and HA, triggers and flow nodes, debounce and rate limits, Code node | [features/engine.md](features/engine.md) | [architecture.md](architecture.md) |
| Plugins: the node interface in each SDK, autodiscovery, branding | [plugins.md](plugins.md) | [protocol.md](protocol.md) |
| Transports: HTTP, gRPC, ten brokers, Auto, the claim check, MCP faces | [transports.md](transports.md) | [protocol.md](protocol.md) §14–15 |
| MCP gateway (agentgateway): sync, identity, tokens | [mcp-gateway.md](mcp-gateway.md) | [transports.md](transports.md) |
| AI: AI Agent and sub-nodes, hosted chat and widget, RAG, guardrails, evaluations, MCP | [features/ai.md](features/ai.md) | |
| Standalone agents: personas, skills, capabilities, channels (Telegram, Slack, Teams), schedules, memory | [agents.md](agents.md) | |
| The agent roster: teams, persona templates, faces and other avatars, the Agent architect chat | [agents.md](agents.md#the-roster) | [second-brain.md](second-brain.md) |
| Agent teams: agents with a lead, reporting lines and reviewers, the org chart, budgets, publishing | [agent-teams.md](agent-teams.md) | [agents.md](agents.md#teams) |
| The team notebook: notes members write while they work, search by meaning, disputes, promotion to team and project, the Notebook tab, Claude Code members over MCP | [team-notebook.md](team-notebook.md) | [agent-teams.md](agent-teams.md), [second-brain.md](second-brain.md) |
| Remote agents over A2A (a capability and the A2A Agent node), kagent next to Landflow, tracing across both | [a2a.md](a2a.md) | [observability.md](observability.md#remote-agents-a2a) |
| Searching and comparing runs, measures over time, and exporting each run's journal over OTLP with OpenInference kinds | [run-trace.md](run-trace.md#search-compare-and-measures) | [reference/api.md](reference/api.md), [reference/configuration.md](reference/configuration.md) (`LANDFLOW_OTLP_TRACES_URL`) |
| Claude Code agents' real usage, cost and guardrails (the landflow-harness mod) | [a2a.md](a2a.md#the-landflow-harness-mod) | [run-trace.md](run-trace.md), [agent-teams.md](agent-teams.md) |
| Run Trace: each run's journal (who did what, requests between agents, waits, artifacts, checks), the Story, Trace, Team and Report screens, profiles, the Run report node and its gate | [run-trace.md](run-trace.md) | [protocol.md](protocol.md) (`records`) |
| Marketplace: Claude Code plugin marketplaces as agents, skills, node plugins and flows; flow share pages; agents and teams exported as Claude Code plugins | [marketplace.md](marketplace.md) | |
| Team templates: a team, its agents and its flow saved as one template and created again with fresh ids and credentials | [templates.md](templates.md) | [features/editor.md](features/editor.md), [agent-teams.md](agent-teams.md) |
| Alert triage and Landfall war rooms: the triage, Landfall and threat-intel plugins and their flows | [triage.md](triage.md) | each plugin's README |
| Runbooks made from closed Landfall war rooms, found by alert kind | [runbooks.md](runbooks.md) | [triage.md](triage.md) |
| Integrations: messaging, productivity, Google Workspace, databases | [features/integrations.md](features/integrations.md) | each plugin's README |
| Web Search: SearXNG, Brave Search and Tavily as an agent tool, titles, links and snippets only | [web-search.md](web-search.md) | [plugins/web-search](../plugins/web-search/README.md) |
| Browser: read a page, run listed steps, extract values, take a screenshot, packaged as its own image | [plugins/browser](../plugins/browser/README.md) | [deployment.md](deployment.md#browser-plugin) |
| Agent Shell: a safe in-memory bash an agent can use as a tool, no host files and no network (opt-in plugin) | [plugins/agent-shell](../plugins/agent-shell/README.md) | [research/just-bash-verdict.md](research/just-bash-verdict.md) |
| AI SDK: a Generate with AI SDK node over Ollama, OpenAI-compatible, Anthropic or Google, with OpenTelemetry spans, usage in AI usage and the caps, and a model span in Run Trace (opt-in plugin, `pnpm plugin:ai-sdk`) | [research/ai-sdk-verdict.md](research/ai-sdk-verdict.md) | [limitations.md](limitations.md#debugging-chat-with-agents-browser-and-web-search-built-2026-11-07) |
| Spec cards in Run Trace drawn with json-render, behind `LANDFLOW_JSON_RENDER` | [research/json-render-verdict.md](research/json-render-verdict.md) | [reference/configuration.md](reference/configuration.md) |
| Debug token: a read-only key to one execution for a debugging agent (`landflow debug-token`, or Debug access on the Run Trace page) | [specs/19-debug-token.md](specs/19-debug-token.md) | [reference/api.md](reference/api.md), [features/cli.md](features/cli.md) |
| Images in tool results: a tool can return a screenshot or other image to the AI Agent's model | [features/ai.md](features/ai.md) | [specs/18-desktop-agent-node.md](specs/18-desktop-agent-node.md) |
| Specs: proposals written before the code (chat with agents, the parallel build plan, the Desktop agent node, the debug token) | [specs/README.md](specs/README.md) | |
| Files and binary data | [features/files.md](features/files.md) | [protocol.md](protocol.md) §11 |
| Settings, variables, data tables, insights | [features/settings-and-data.md](features/settings-and-data.md) | |
| Authentication: users, roles, projects, API keys, OIDC, SAML, SCIM | [features/authentication.md](features/authentication.md) | |
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
- [observability.md](observability.md): the OpenTelemetry contract: span names, attributes, metrics, logs.

**Features**: the twelve pages under [features/](#feature-map), plus [plugins.md](plugins.md),
[assistant.md](assistant.md), [second-brain.md](second-brain.md), [composites.md](composites.md), [agents.md](agents.md), [agent-teams.md](agent-teams.md), [team-notebook.md](team-notebook.md), [a2a.md](a2a.md),
[run-trace.md](run-trace.md), [web-search.md](web-search.md) and [marketplace.md](marketplace.md).

**Reference**: [reference/api.md](reference/api.md) (every route), [reference/configuration.md](reference/configuration.md)
(every host environment variable).

**Running and changing Landflow**

- [deployment.md](deployment.md): Compose stacks, ports and credentials, queue mode, the code runner, Kubernetes on
  OrbStack, telemetry on Kubernetes, kagent beside it, stop and reset.
- [development.md](development.md): setup, code tour, conventions, the full verification list, integration flags.
- [limitations.md](limitations.md): what Landflow does not do yet.
- [roadmap.md](roadmap.md): the waves, what each built, and what remains.
- [history.md](history.md): every change in order, the decisions along the way, and where each is documented.

**Reviews, plans and research**

- [ui-review.md](ui-review.md): a screen-by-screen comparison of the UI with n8n.
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
| [plugins/messaging](../plugins/messaging/README.md), [productivity](../plugins/productivity/README.md), [google-workspace](../plugins/google-workspace/README.md), [databases](../plugins/databases/README.md), [github](../plugins/github/README.md), [browser](../plugins/browser/README.md), [web-search](../plugins/web-search/README.md) | the integration plugins |
| [research/json-render-verdict](research/json-render-verdict.md), [ai-sdk-verdict](research/ai-sdk-verdict.md), [just-bash-verdict](research/just-bash-verdict.md) | what each Vercel open-source prototype showed and whether to keep it (all three stay as flags) |
| [research/workflow-sdk-spike](research/workflow-sdk-spike.md) | a test of Vercel's Workflow SDK as a home for runs: events per node, replay cost, crash recovery |
| [plugins/triage](../plugins/triage/README.md), [landfall](../plugins/landfall/README.md), [threat-intel](../plugins/threat-intel/README.md) | the triage plugins ([triage.md](triage.md)) |
| [deploy/k8s/examples/keda](../deploy/k8s/examples/keda/README.md) | KEDA autoscaling examples |
| [sdks/go/transport/testdata/live-brokers](../sdks/go/transport/testdata/live-brokers/README.md), [live](../sdks/go/transport/testdata/live/README.md) | the cross-language broker checks |

## Keeping the docs current

A change updates the page for its feature, [reference/](reference/api.md) for new routes or variables,
[limitations.md](limitations.md) when it adds or lifts a limit, and [roadmap.md](roadmap.md) when it closes or opens
an item. Each commit gets a row in [history.md](history.md). New pages go in this index. [development.md](development.md#conventions) has the rest of the conventions.
