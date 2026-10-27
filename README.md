# Landflow

**A low-code workflow platform where every node is a plugin, written in any language, and autodiscovered over HTTP or gRPC.**

Landflow follows n8n's model (items flowing between nodes, typed ports, cluster nodes for AI agents) and rebuilds the plugin layer around one language-neutral contract. A node is a JSON **descriptor** plus an **`execute`** behaviour. Built-in nodes implement exactly the same interface as external ones; they just run in-process.

![Workflow editor after a run, with the Logs panel](docs/images/editor-run.jpg)

| | |
|---|---|
| ![Node creator: categories, then one segment per plugin with its published icon](docs/images/node-creator.jpg) | ![Executions tab: an AI agent run with its model, memory and tool calls nested](docs/images/agent.jpg) |
| ![Plugin registry](docs/images/plugins.jpg) | ![Home](docs/images/overview.jpg) |

## Quick start

```bash
pnpm install
(cd plugins/py-insights && ./setup.sh)    # venv with grpcio for the Python plugin (one-off)
pnpm dev:all                              # host :3000 + the example and integration plugins
```

Open http://localhost:3000 and create the owner account on the setup page (or start with `LANDFLOW_OWNER_EMAIL` and `LANDFLOW_OWNER_PASSWORD` set; see [Authentication](docs/features/authentication.md)). The plugins announce themselves within a second and their nodes appear in the editor. Three example workflows are seeded on first boot:

| Workflow | Shows |
|---|---|
| **Polyglot review pipeline** | TS slugify → Python sentiment → Go hash → IF → branches + Python stats, all over gRPC |
| **Polyglot AI agent** | Chat → AI Agent with a local Ollama model, memory, and tools written in Go, Python and TS |
| **Webhook text enrichment** | `curl -XPOST localhost:3000/api/webhook/enrich -d '{"text":"…"}'` |

To run the pieces separately: `pnpm dev`, `pnpm plugin:ts`, `pnpm plugin:py`, `pnpm plugin:go`, and the integrations (see [Integrations](docs/features/integrations.md)). `plugins/productivity/setup.sh` makes the Python integrations' venv.

## Run with Docker

```bash
docker compose -f deploy/compose.infra.yml up -d --wait                     # Postgres+pgvector, Valkey, Mailpit, MinIO, OpenBao
docker compose -f deploy/compose.infra.yml --profile auth --profile observability up -d --wait   # + Keycloak, Jaeger
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait  # host + 7 plugins + code runner on http://localhost:53000
```

The first command starts the development and test infrastructure. The last one runs Landflow itself from images: the host as Next.js standalone output with its data in a volume, and one image per plugin, each announcing itself to the host by its service name. Ports, credentials, how the dev server uses the infra, the databases plugin's real-server tests and how to reset everything are in **[docs/deployment.md](docs/deployment.md)**.

**Kubernetes:** `deploy/k8s/` (kustomize) runs the host and the plugins on a cluster, where the host discovers the plugins from labelled Services (`kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack` on OrbStack); see [docs/deployment.md, "Kubernetes"](docs/deployment.md#kubernetes).

## Features

Each area has its own page under [docs/](docs/README.md):

- **[Editor](docs/features/editor.md)**: canvas, node creator, runs and pinned data, the Logs panel, debugging, importing from n8n and Flowise. The [editor assistant](docs/assistant.md) suggests fixes after a run and proposes changes in a builder chat.
- **[Engine](docs/features/engine.md)**: n8n's data model, the durable runtime (checkpoints, retries, waits), queue mode with workers and high availability, triggers and flow nodes, debounce and rate limits, the Code node.
- **[Plugins](docs/plugins.md)**: the node interface in TypeScript, Python and Go, autodiscovery, the [plugin protocol](docs/protocol.md), [transports](docs/transports.md) (HTTP, gRPC and ten brokers) and the [Marketplace](docs/marketplace.md).
- **[AI](docs/features/ai.md)**: the AI Agent and its sub-nodes, hosted chat and the widget, retrieval (RAG), guardrails, evaluations, [standalone agents](docs/agents.md) and MCP (client, server trigger, the [MCP gateway](docs/mcp-gateway.md)).
- **[Integrations](docs/features/integrations.md)**: the most used n8n integrations as plugins (messaging, productivity, Google Workspace, databases), with OAuth2 and live pickers.
- **[Files and binary data](docs/features/files.md)**, **[settings, variables, data tables and insights](docs/features/settings-and-data.md)**.
- **[Authentication](docs/features/authentication.md)**: users, invites, roles, projects, API keys, and single sign-on with OIDC and SAML.
- **Governance**: [audit log and governance](docs/features/audit-and-governance.md), [external secrets and environments](docs/features/secrets-and-environments.md), [Git sync](docs/features/git-sync.md).
- **[Observability](docs/features/observability.md)**: OpenTelemetry traces, metrics and logs across the host and every plugin ([contract](docs/observability.md)).
- **[CLI](docs/features/cli.md)**, the **[HTTP API](docs/reference/api.md)** and every **[environment variable](docs/reference/configuration.md)**.

## Documentation

[docs/README.md](docs/README.md) is the index: where to start, every document with one line on what it covers, and which
document covers each feature. [docs/development.md](docs/development.md) covers working on Landflow: setup, conventions
and the full test list. [docs/deployment.md](docs/deployment.md) covers Docker, Kubernetes and the infra stack.

## Architecture

[docs/architecture.md](docs/architecture.md) describes the machinery: the processes and what each one owns, a run from
trigger to result, the engine, the protocol and SDKs, finding plugins, transports, MCP, storage, queue mode, identity and
governance, AI, the code runner, observability, deployment and a map of the code.

```
  Browser ──HTTP/SSE──┐        Agents (Claude Code, Cursor…) ──MCP──▶ agentgateway :4000 ──▶ host /api/mcp/plugins/<id>
                      ▼
   ┌──────────────────────────── Landflow host (apps/web, Next.js) ─────────────────────────────┐
   │ UI ─ API routes ─ runner ─ engine (packages/engine) ─ registry ─ transport selector        │
   │ store (SQLite or Postgres) · binary store (disk or S3) · bus · scheduler/poller/leader     │
   └───────┬──────────────────────────────┬───────────────────────────────┬─────────────────────┘
           │ direct: HTTP, gRPC            │ brokers: Kafka, RabbitMQ,      │ code runner :7300
           ▼                               │ NATS, Valkey, MQTT, SQS…       ▼ (sandboxed Code node)
   plugins built with the SDKs ◀───────────┘
   TypeScript (text-toolkit, messaging) · Python (py-insights, productivity) · Go (go-crypto, google-workspace, databases)
```

```
apps/web/                 the host: UI pages, API routes, server libs (src/lib/server), tests
packages/                 engine (executor), protocol (wire contract, schemas, plugin.proto, MCP mapping),
                          sdk (TypeScript SDK), transports (messaging core and broker drivers), cli
sdks/                     the Go and Python SDKs, with their transport cores and drivers
plugins/                  one example plugin per SDK, plus the integrations: messaging (TS),
                          productivity (Python), google-workspace and databases (Go)
services/                 code-runner (the Code node's sandbox), landflow-bridge (broker kinds for Go and Python)
deploy/                   compose stacks, Dockerfiles, Kubernetes manifests, the MCP gateway config
docs/                     every document: features, architecture, protocol, deployment, development, roadmap (docs/README.md)
```

## Tests

```bash
pnpm test && pnpm typecheck                        # protocol/sdk/engine/plugin/code-runner, then every package's types
(cd apps/web && npx vitest run)                    # the host: route handlers, store, runner, auth, AI…
```

The full list (every package and SDK, the live broker suites, `LANDFLOW_INTEGRATION` tests against the infra stack and
the cluster) is in [docs/development.md](docs/development.md#verification).

## Known limitations

[docs/limitations.md](docs/limitations.md) lists what Landflow does not do yet; [docs/roadmap.md](docs/roadmap.md)
lists what each wave built and what remains.

## Research

Agents read the source of the running n8n 2.44 container, its node catalogue and its docs. Their reports drove this design:

- [docs/research/01-n8n-node-interface.md](docs/research/01-n8n-node-interface.md): `INodeType`, the property vocabulary, loaders and lazy manifests
- [docs/research/02-n8n-workflow-engine.md](docs/research/02-n8n-workflow-engine.md): workflow JSON, `WorkflowExecute`, expressions and push events
- [docs/research/03-n8n-ai-agents.md](docs/research/03-n8n-ai-agents.md): cluster nodes, `supplyData`, tools and `$fromAI`, agent v3 and `@n8n/agents`
- [docs/research/04-n8n-integrations.md](docs/research/04-n8n-integrations.md): which of n8n's 445 integrations people use, how n8n shapes them, and the set Landflow builds

