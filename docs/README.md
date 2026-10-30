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
| Composite nodes: groups typed by a contract (slots, rules, ports), checked in the editor, run as one step | [composites.md](composites.md) | [protocol.md](protocol.md) §3 |
| Engine: data model, durable runtime, queue mode and HA, triggers and flow nodes, debounce and rate limits, Code node | [features/engine.md](features/engine.md) | [architecture.md](architecture.md) |
| Plugins: the node interface in each SDK, autodiscovery, branding | [plugins.md](plugins.md) | [protocol.md](protocol.md) |
| Transports: HTTP, gRPC, ten brokers, Auto, the claim check, MCP faces | [transports.md](transports.md) | [protocol.md](protocol.md) §14–15 |
| MCP gateway (agentgateway): sync, identity, tokens | [mcp-gateway.md](mcp-gateway.md) | [transports.md](transports.md) |
| AI: AI Agent and sub-nodes, hosted chat and widget, RAG, guardrails, evaluations, MCP | [features/ai.md](features/ai.md) | |
| Standalone agents: skills, capabilities, channels (Telegram, Slack, Teams), schedules, memory | [agents.md](agents.md) | |
| Marketplace: Claude Code plugin marketplaces as agents, skills, node plugins and flows; flow share pages | [marketplace.md](marketplace.md) | |
| Alert triage and Landfall war rooms: the triage, Landfall and threat-intel plugins and their flows | [triage.md](triage.md) | each plugin's README |
| Integrations: messaging, productivity, Google Workspace, databases | [features/integrations.md](features/integrations.md) | each plugin's README |
| Files and binary data | [features/files.md](features/files.md) | [protocol.md](protocol.md) §11 |
| Settings, variables, data tables, insights | [features/settings-and-data.md](features/settings-and-data.md) | |
| Authentication: users, roles, projects, API keys, OIDC, SAML, SCIM | [features/authentication.md](features/authentication.md) | |
| Audit log and governance: SIEM streaming, signed heads, approvals, four-eyes | [features/audit-and-governance.md](features/audit-and-governance.md) | |
| External secrets and environments | [features/secrets-and-environments.md](features/secrets-and-environments.md) | |
| Git sync | [features/git-sync.md](features/git-sync.md) | |
| Observability: traces, metrics, logs | [features/observability.md](features/observability.md) | [observability.md](observability.md) |
| CLI | [features/cli.md](features/cli.md) | [packages/cli](../packages/cli/README.md) |
| HTTP API | [reference/api.md](reference/api.md) | `GET /api/openapi.json` |
| Environment variables | [reference/configuration.md](reference/configuration.md) | |
| Docker, Kubernetes, the infra stack | [deployment.md](deployment.md) | [deploy/](../deploy/README.md) |

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
[assistant.md](assistant.md), [composites.md](composites.md), [agents.md](agents.md) and [marketplace.md](marketplace.md).

**Reference**: [reference/api.md](reference/api.md) (every route), [reference/configuration.md](reference/configuration.md)
(every host environment variable).

**Running and changing Landflow**

- [deployment.md](deployment.md): Compose stacks, ports and credentials, queue mode, the code runner, Kubernetes on
  OrbStack, stop and reset.
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
| [plugins/messaging](../plugins/messaging/README.md), [productivity](../plugins/productivity/README.md), [google-workspace](../plugins/google-workspace/README.md), [databases](../plugins/databases/README.md) | the integration plugins |
| [plugins/triage](../plugins/triage/README.md), [landfall](../plugins/landfall/README.md), [threat-intel](../plugins/threat-intel/README.md) | the triage plugins ([triage.md](triage.md)) |
| [deploy/k8s/examples/keda](../deploy/k8s/examples/keda/README.md) | KEDA autoscaling examples |
| [sdks/go/transport/testdata/live-brokers](../sdks/go/transport/testdata/live-brokers/README.md), [live](../sdks/go/transport/testdata/live/README.md) | the cross-language broker checks |

## Keeping the docs current

A change updates the page for its feature, [reference/](reference/api.md) for new routes or variables,
[limitations.md](limitations.md) when it adds or lifts a limit, and [roadmap.md](roadmap.md) when it closes or opens
an item. Each commit gets a row in [history.md](history.md). New pages go in this index. [development.md](development.md#conventions) has the rest of the conventions.
