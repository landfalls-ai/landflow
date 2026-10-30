# Build history

Every change to Landflow, in order: what each one built and the page that documents it. Part of the
[Landflow docs](README.md). The project was built between 2026-10-25 and 2026-10-29, in 27 commits on `main`, and the
docs were brought up to date on 2026-10-30.
[roadmap.md](roadmap.md) has the detail of each wave: what it built, the bugs found while checking it, what was checked
live and what remains. This page is the map from a commit to those sections.

## How the work was done

- **In waves.** The waves came from a 2026 comparison with other workflow platforms
  ([reports/Workflow platform feature gaps.md](<../reports/Workflow platform feature gaps.md>)) and from the n8n
  research in [research/](research/01-n8n-node-interface.md). Larger features were first written up as plans and their
  open questions settled ([transports.md](transports.md#decisions), [composites.md](composites.md)).
- **Checked three ways.** Each wave ended with every suite passing and a clean type check
  ([development.md](development.md#verification)). It was then checked live: on the local stack, on a scratch host and in
  the browser ([development.md](development.md#checking-a-change-live)). The bugs those checks found were fixed in the same wave and listed
  in its roadmap section.
- **Documented with the change.** Each commit updates its feature page, [reference/](reference/api.md),
  [limitations.md](limitations.md) and [roadmap.md](roadmap.md) ([CLAUDE.md](../CLAUDE.md) states the rule).
- **On this machine only.** Everything ran on the OrbStack Docker engine and its Kubernetes cluster (namespace
  `landflow-dev`). AWS APIs were exercised only against LocalStack, outside services only through local fakes or
  emulators, and with the development credentials in `deploy/.env.example`. No image was pushed and nothing was
  deployed to a cloud ([CLAUDE.md](../CLAUDE.md), "Local only").

## Decisions along the way

| Date | Decision | Recorded in |
|---|---|---|
| 2026-10-25 | Running Landflow agents inside Claude Code and other harnesses is parked; only its spike was run | [harnesses.md](harnesses.md) |
| 2026-10-26 | One messaging core with small broker drivers, chosen per call from live traffic. Every plugin is also an MCP server, and agentgateway is the bundled gateway. Agents sign in through the identity provider or with Landflow MCP tokens | [transports.md](transports.md#decisions) |
| 2026-10-27 | Spotlight is the editor's one AI surface. The Home, ⌘K across the app and the action layer stay a plan until its open decisions are settled | [spotlight.md](spotlight.md), [assistant.md](assistant.md#spotlight) |
| 2026-10-29 | Triage safety rules: fail open, sev1 is never held, the AI can't drop an alert, only people approve noise rules, Shadow before Enforce | [triage.md](triage.md#safety-rules) |
| 2026-10-29 | Composites: the nodes are copied in and the contract is linked. Errors block Publish, warnings don't, and Save is never blocked. Free nodes are allowed unless the type is `closed`, and slots can take nested composites. The UI says "Composite" and "slot" | [composites.md](composites.md) |

## 2026-10-25: the platform and waves 1 to 4

| Commit | What it built | Documented in |
|---|---|---|
| `ab05ef6` | The monorepo: the Next.js host and editor, the engine, the protocol, the TypeScript, Go and Python SDKs, and the plugins (databases, messaging, productivity, Google Workspace, text toolkit, go-crypto, py-insights). Also the research report and the first roadmap | [architecture.md](architecture.md), [plugins.md](plugins.md), [protocol.md](protocol.md) |
| `b72a093` | Wave 1. Runs that wait and resume (timers, webhooks, forms, sub-workflows). Wait, Form, Respond to Webhook, Loop Over Items, Execute Workflow, Error Trigger, Schedule v2. Sticky notes, clipboard, undo, n8n import, versions, tags and folders. Variables, Data Tables, Insights. The Compose stacks | [roadmap.md](roadmap.md#wave-1-runs-that-can-wait-flow-building-blocks-organisation-built-in-data), [features/engine.md](features/engine.md), [features/editor.md](features/editor.md), [deployment.md](deployment.md) |
| `e2d40d2` | Wave 1.5 and parts of 2 and 3. The durable runtime (SQLite or Postgres, checkpoints, idempotency, retries). Binary data in every SDK. The sandboxed code runner. RAG and Guardrails. MCP client, server trigger and instance server | [roadmap.md](roadmap.md#wave-15-a-durable-runtime), [features/files.md](features/files.md), [features/ai.md](features/ai.md), [deployment.md](deployment.md#code-runner) |
| `22178fa` | Sign-in, roles, API keys and OIDC. Draft and publish. Webhook auth and app webhooks. The CLI and Git sync. Hosted chat and the widget. AI costs and caps. Evaluations, OAuth2 Connect and failure alerts | [features/authentication.md](features/authentication.md), [features/cli.md](features/cli.md), [features/git-sync.md](features/git-sync.md), [features/ai.md](features/ai.md) |
| `5b6006a` | Wave 4. Queue mode and HA on Valkey Streams. Projects, SAML and SCIM. The audit log, SIEM streaming and governance. External secrets and environments. Templates and canvas groups. Kubernetes discovery | [roadmap.md](roadmap.md#wave-4-operations-and-teams), [features/engine.md](features/engine.md#queue-mode-workers-and-high-availability), [features/audit-and-governance.md](features/audit-and-governance.md), [features/secrets-and-environments.md](features/secrets-and-environments.md) |

## 2026-10-26: wave 5 and transports

| Commit | What it built | Documented in |
|---|---|---|
| `b34bc65` | Test URLs for webhooks and forms. "Each item" sub-workflows that wait. Plugin instance ids, so a restarted plugin's manifest is pulled again. Undo for the workflow's name, tags and settings | [features/engine.md](features/engine.md), [plugins.md](plugins.md#autodiscovery) |
| `399b171` | Wave 5, Wave 4's open items: folders, variables and node allow-lists per project, the audit hash chain, encrypted SAML assertions, `$secrets` in node parameters, Valkey Sentinel, marketplace plugins on workers, nested groups. Also the first transports plan | [roadmap.md](roadmap.md) (items marked "Wave 5 ✅") |
| `611e771`, `72505e6`, `d8bd833` | Plans: every plugin on every transport and as an MCP server, agentgateway as the bundled gateway, and the decisions settled | [transports.md](transports.md), [mcp-gateway.md](mcp-gateway.md) |
| `d7732a7`, `b2bd3f6` | Transports wave T1: protocol §14 (messaging) and §15 (MCP), the messaging core and conformance kit, the SDK bindings, the broker infra | [protocol.md](protocol.md), [transports.md](transports.md) |
| `2506790` | T2: Kafka, RabbitMQ, NATS, JetStream and Valkey drivers. Host messaging. An MCP server per plugin, with identity and grants. The Go transport core | [transports.md](transports.md), [mcp-gateway.md](mcp-gateway.md) |
| `77de19c` | T3: the gateway sync, Auto (scoring and spill-over), the bridge, MCP faces in Go and Python, the tier 2 brokers, the Python drivers | [transports.md](transports.md), [services/landflow-bridge](../services/landflow-bridge/README.md) |
| `dfa8e24` | T4–T5: the Twilio pilot, brokers in queue mode and on Kubernetes, KEDA examples, the benchmark, every bundled plugin on the new SDKs | [transports.md](transports.md), [deployment.md](deployment.md#kubernetes) |
| `4d4de28` | T6: MCP approvals, files, options and triggers. The claim check. Per-workflow transport overrides. Gateway routes and tokens | [transports.md](transports.md), [protocol.md](protocol.md) |
| `49c8ae9` | Fix: the gateway sync writes the host's JWKS inline, so a gateway restarted while the host was down no longer crash-loops | [mcp-gateway.md](mcp-gateway.md) |

All of it is summed up in [roadmap.md, "Transports and MCP"](roadmap.md#transports-and-mcp-built-2026-10-26).

## 2026-10-27: wave 6, the docs and Spotlight

| Commit | What it built | Documented in |
|---|---|---|
| `e67a07e` | Wave 6, closing every remaining "Not yet": Code node and file work, OAuth2 variants, Stripe, Slack and Teams triggers and channels, approval emails, AI caps and scheduled evaluations, scheduled publishes, MCP OAuth, Valkey Cluster, signed audit heads. Also the architecture doc | [roadmap.md](roadmap.md#wave-6-every-remaining-not-yet-built-2026-10-27), [architecture.md](architecture.md) |
| `493177a` | The docs move into `docs/`: feature pages, the reference, deployment, the development guide, this index and `CLAUDE.md` | [README.md](README.md), [development.md](development.md) |
| `48e9882` | Plans: a new Home, ⌘K Spotlight and an action layer. A screen-by-screen simplification review | [spotlight.md](spotlight.md), [ux-simplification.md](ux-simplification.md) |
| `eae93d9` | Spotlight in the editor: the bar, bubbles and completions, drafting on an empty canvas | [assistant.md](assistant.md#spotlight) |
| `cb54d91`, `0758a6f` | Fixes from testing Spotlight: the bar's width, claims and made-up ids in replies, Ollama tool-call retries, parameter defaults in display rules, Turbopack tracing and its stale dev cache | [roadmap.md](roadmap.md#spotlight-in-the-editor-built-2026-10-27), [development.md](development.md#setup) |
| `e7dbd42` | Test and fix (run, judge, fix up to 4 times, review against the goal, offer to publish), and the side card while Spotlight works | [assistant.md](assistant.md#test-and-fix) |

## 2026-10-29: triage, the marketplace and composites

| Commit | What it built | Documented in |
|---|---|---|
| `2f47130` | The triage, Landfall and threat-intel plugins and their flows. Flows shipped by plugins, through the marketplace. Read-only share pages | [triage.md](triage.md), [marketplace.md](marketplace.md#flows) |
| `8628d72` | The Plugins page as small cards that unfold. The marketplace's Explore, across every source (`GET /api/marketplaces/explore`). Fix: a free-port probe that could hand out a busy port | [plugins.md](plugins.md#autodiscovery), [marketplace.md](marketplace.md) |
| `da3f313` | Composite nodes: groups typed by a contract (slots, ports, rules), checked in the editor and on publish, and run as one step with a fallback, a timeout and properties | [composites.md](composites.md), [roadmap.md](roadmap.md#composite-nodes-built-2026-10-29) |

Both are summed up in [roadmap.md, "Alert triage, Landfall and the flow marketplace"](roadmap.md#alert-triage-landfall-and-the-flow-marketplace-built-2026-10-29)
and ["Composite nodes"](roadmap.md#composite-nodes-built-2026-10-29).

## 2026-10-30: the docs brought up to date

This page; Spotlight's section in [roadmap.md](roadmap.md#spotlight-in-the-editor-built-2026-10-27); composites in
[architecture.md](architecture.md); [checking a change live](development.md#checking-a-change-live); and the host
variables that were missing from [reference/configuration.md](reference/configuration.md) (the MCP, gateway, marketplace,
transport and Valkey Cluster settings).

## What is next

[roadmap.md, "Planned next"](roadmap.md#planned-next): runbooks built from closed Landfall war rooms. The open items of
each wave are in its roadmap section and in [limitations.md](limitations.md).
