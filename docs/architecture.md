# Architecture

How Landflow is put together: the processes, what each one owns, how a run moves through them, and where the code
lives. Each section links to the document that has the details. The [feature pages](README.md#feature-map) describe what it does;
this page describes the machinery under them.

- [The pieces](#the-pieces)
- [The host](#the-host)
- [A run, end to end](#a-run-end-to-end)
- [The engine](#the-engine)
- [Plugins, the protocol and the SDKs](#plugins-the-protocol-and-the-sdks)
- [Finding plugins](#finding-plugins)
- [Transports](#transports)
- [MCP](#mcp)
- [Storage](#storage)
- [Queue mode and high availability](#queue-mode-and-high-availability)
- [Identity, access and governance](#identity-access-and-governance)
- [AI](#ai)
- [The code runner](#the-code-runner)
- [Observability](#observability)
- [Deployment](#deployment)
- [Where the code is](#where-the-code-is)

## The pieces

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

| Process | What it does | Code |
|---|---|---|
| **Host** (main) | UI, REST API, webhooks, forms, hosted chat, MCP endpoints; runs executions in regular mode; the leader runs schedules, polls and timers | `apps/web` |
| **Worker** (queue mode) | takes production runs from a Valkey stream and runs them through the same runner | `apps/web` (`pnpm worker`) |
| **Plugins** | serve node types over HTTP, gRPC, brokers and MCP; one process per plugin, any language | `plugins/*`, SDKs in `packages/sdk`, `sdks/go`, `sdks/python` |
| **Code runner** | runs Code node JavaScript and Python in a fresh locked-down process per run | `services/code-runner` |
| **MCP gateway** | agentgateway: one MCP URL for every plugin, sign-in, prefixes, rate limits; the host keeps its config in step | `deploy/mcp-gateway`, `apps/web/src/lib/server/mcp/gateway-*.ts` |
| **Bridge** | gives Go and Python plugins the broker kinds their SDK has no native driver for | `services/landflow-bridge` |
| **CLI** | `landflow`: workflows, runs, Git sync, environments, n8n import, with stable JSON output | `packages/cli` |

The infrastructure around them is ordinary: Postgres, Valkey, S3 (MinIO), an SMTP server (Mailpit), an identity provider
(Keycloak), a secrets manager (OpenBao), the brokers, and an OpenTelemetry backend (Jaeger). `deploy/compose.infra.yml` runs
all of it locally.

## The host

`apps/web` is one Next.js application. The UI (React, the canvas, the node details view, run views, settings) talks to
API routes under `src/app/api`; every route goes through `handler()` in `lib/server/http.ts`, which authenticates the caller
(session cookie, `lf_` API key or MCP token), checks the role or scope and the project, records audit events and turns
errors into JSON. The server code under `src/lib/server` is organised by domain:

| Area | Directories and files |
|---|---|
| Runs | `runner.ts` (starts and finishes executions), `waits.ts`, `retries.ts`, `concurrency.ts`, `idempotency.ts`, `sub-executions.ts`, `streaming.ts`, `trigger-buffers.ts` (debounce and batching) |
| Triggers | `webhooks.ts`, `forms.ts`, `app-webhooks.ts`, `scheduler.ts`, `poller.ts`, `imap-idle.ts`, `chat.ts`, `test-webhooks.ts` |
| Plugins | `plugins/` (registry, discovery, Kubernetes watch, marketplace), `transports/` (selector, Auto, brokers, policies), `nodes/` (the built-in `core` plugin), `composites.ts` (composite types from the plugins and this instance's library, the checks the publish gate and templates run, the run's scopes) |
| Data | `db/` (SQLite and Postgres, migrations), `store.ts`, `binary/`, `datatables/`, `versions.ts`, `folders.ts`, `variables.ts`, `config-store.ts` |
| People and access | `auth/` (sessions, OIDC, SAML, API keys, the `can()` policy), `scim/`, `projects/`, `governance/`, `environments/`, `sync/` (Git), `secrets/` (external secrets), `credentials/`, `audit/` |
| AI | `agents/`, `assistant/`, `rag/`, `evaluations/`, `ai-usage/`, `guardrails.ts`, `slack/` |
| MCP | `mcp/` (instance server, per-plugin endpoints, tokens, grants, approvals, the gateway sync) |
| Cluster | `cluster/` (queue, workers, leader, control channel, shared debug sessions) |
| Telemetry | `telemetry/` (OpenTelemetry setup, metrics, logs) |

`runtime.ts` is the composition root: one service table (`SERVICES`) that both the main (`startRuntime({ role: 'main' })`,
via `instrumentation.ts` and `bootstrap.ts`) and the worker (`cluster/worker-main.ts`) run, each the entries of its role in
list order: the configuration check, the database, the cluster runtime, the registry, discovery, broker connections, the
scheduler and pollers (on the leader), the gateway sync and the shutdown steps. Route modules do not import it: `handler()` and
`scimRoute()` await `whenReady()` (`lifecycle.ts`), which boots through the bootstrapper `instrumentation.ts` (or the test setup)
registered. `bus.ts` is the in-process event bus that
carries live run events to SSE streams; in queue mode the same events travel over Valkey pub/sub.

## A run, end to end

```
 trigger (webhook, form, schedule, poll, chat, MCP, app webhook, manual)
   │ idempotency key · debounce/batch · concurrency slot (or the FIFO queue)
   ▼
 runner ── saves the execution (status running, workflow version) ─────────────▶ store
   │ regular mode: runs here        queue mode: enqueue on the Valkey stream ──▶ a worker runs it
   ▼
 engine ── for each node, depth-first by branch:
   │   resolve {{ expressions }} per item, credentials, $secrets
   │   resolve the node type ─▶ core (in process) or a plugin
   │   plugin call ─▶ transport selector ─▶ HTTP · gRPC · broker ─▶ plugin dispatcher ─▶ node.execute()
   │   ◀── items (and binary refs) back
   │   checkpoint after each main-flow node ──────────────────────────────────────▶ store
   │   node.started / node.finished / node.chunk events ──▶ bus ──▶ SSE to the editor
   ▼
 finished (success, error, waiting) ── alerts, error workflow, retries, insights, AI usage
```

A run can stop and come back: a Wait node, a form, an approval or a sub-execution saves the run as `waiting` with its
resume state; a timer, a call to `/api/waiting/<id>` or the child's result resumes it on the version it started with. A
crash leaves it `running`; the next boot (or another worker after the lease runs out) continues it from the last
checkpoint.

## The engine

`packages/engine` is the executor, with no knowledge of HTTP, databases or plugins. The host gives it a
`NodeTypeResolver` (node types from the registry), the workflow and the input, and gets events and the result back.

- **Data model and scheduling** follow n8n v1: items are `{ json, binary?, pairedItem }`, a node returns one array per
  output, and branches run depth-first, siblings ordered by canvas position. Merge-style nodes wait for all their inputs.
- **Expressions** (`expression.ts`): `{{ }}` with `$json`, `$('Node')`, `$input`, `$vars`, `$secrets`, `$now`, Luxon,
  resolved by the host per item, so plugins only ever see concrete values.
- **Sub-nodes** (`ai.ts`, `tool-schema.ts`): models, memory, tools, embeddings, retrievers, rerankers attach to typed
  ports (`ai_languageModel`, `ai_tool`…); any `usableAsTool` node becomes an agent tool with a JSON schema.
- **In-process nodes** (`in-process.ts`) can wait, keep node state and be cancelled; remote nodes are stateless calls.
- **Errors and retries** per node (`onError`, `retryOnFail`, timeouts), rate limits per node (`rate-limit.ts`), and the
  hooks the durable runtime uses (checkpoints, step ids `<nodeId>#<runIndex>`, a per-step idempotency key).
- **Scopes** (`ExecuteWorkflowOptions.scopes`): [composite frames](composites.md#in-a-run) whose type sets a fallback,
  a timeout or properties. The host builds them from the workflow's groups (`workflowScopes()` in
  `lib/server/composites.ts`). A node failing inside a frame that falls back stops the frame, not the run, and what
  entered the frame goes to its fallback targets with the error. `$composite.params` reads the frame's properties.
  What entered each frame is saved with checkpoints and waits.

## Plugins, the protocol and the SDKs

A plugin is a process that serves node types. The contract is `landflow.plugin/v1` ([protocol.md](protocol.md)):
`GetManifest` (the plugin's nodes and credential types as JSON descriptors that mirror n8n's), `Execute` (items in,
items out; poll triggers too, with their saved state), `LoadOptions` (pickers), `TestCredentials`, `Health` and the
app-webhook methods (`WebhookMethod`, `ReceiveWebhook`), over an HTTP binding and a gRPC binding
(`landflow.plugin.v1.PluginService`). The editor renders every node's UI from its
descriptor, so a plugin has no frontend code. A manifest can also carry **composite types** (contracts for a group of
nodes: slots, ports, rules; [composites.md](composites.md)). The editor and the host check frames against them with the
same code (`lib/shared/composites.ts`).

```
   face (HTTP · gRPC · broker · MCP) ─▶ dispatcher ─▶ node
                                         spans, metrics, redaction, credentials, deadline, cancel
```

Every SDK has the same shape: a node interface, `serve()` with the faces it starts (`LANDFLOW_TRANSPORTS`), one
dispatcher all faces call, an announcer, helpers for credentials, binary data, paired items, signatures and telemetry.

| SDK | Package | Faces |
|---|---|---|
| TypeScript | `@landflow/sdk` (`packages/sdk`) with `@landflow/transports` | HTTP, gRPC, every broker kind, MCP |
| Go | `sdks/go` | HTTP, gRPC, Kafka, RabbitMQ, NATS/JetStream, Valkey natively; other kinds through the bridge; MCP |
| Python | `sdks/python` (`landflow_sdk`) | HTTP, gRPC, Kafka, RabbitMQ, NATS/JetStream, Valkey (the `brokers` extra); other kinds through the bridge; MCP |

Credentials are stored and decrypted by the host and sent with each call; OAuth2 credentials (`extends: oAuth2Api`; the
plugins' Slack, Discord, GitHub, Notion, Airtable, HubSpot and Jira Cloud types have OAuth2 variants) are connected and
refreshed by the host. Binary data never travels inline: items carry references, and plugins read and write
bytes through `/api/binary` with per-call tokens (protocol §11).

## Finding plugins

The registry (`lib/server/plugins`) holds every plugin's manifest and endpoints. Plugins arrive five ways: they
**announce** themselves (HTTP or gRPC `RegistryService` on `:7070`, a 30 s lease renewed every 10 s, and over a broker's
registry channel); they are listed **statically** (`LANDFLOW_PLUGINS`); a **scan** probes a port range; **Kubernetes**
discovery watches labelled Services and their EndpointSlices; and the **core** plugin registers in process. Manifests are
validated before their nodes appear; a registry proof (an HMAC challenge with the registry secret) keeps strangers from
announcing. An expired lease turns a plugin offline: its nodes grey out and its workflows still open.

## Transports

The host reaches a plugin directly (HTTP, gRPC: the host connects to the plugin) or through a broker (both connect out,
so the plugin needs no inbound port). Eleven broker kinds have drivers: Kafka, RabbitMQ (AMQP 0-9-1), NATS, JetStream,
Valkey Streams, MQTT 5, SQS, Google Pub/Sub, Pulsar, Azure Service Bus and AMQP 1.0 ([transports.md](transports.md)).

```
 host                                                       plugin
 selector ─┬─ HTTP ──────────────────────────────────────▶ HTTP face ─┐
           ├─ gRPC ──────────────────────────────────────▶ gRPC face ─┤
           └─ messaging core ─ driver ─▶ broker ─▶ driver ─ messaging ┤──▶ dispatcher ─▶ node
                CloudEvents envelope, signed and encrypted   core      │
```

- **One messaging core per language, small drivers.** The core holds everything Landflow-specific: the CloudEvents
  envelope, correlation and replies, deadlines and cancellation, delivery modes, encryption and signing
  (`LANDFLOW_TRANSPORT_SECRET`, the same on the host and the plugins), announcing over the broker. A driver only
  publishes, consumes, acknowledges and declares, and a conformance suite checks each one against an in-memory reference.
- **Channels**: a request channel per plugin shared by its replicas (`landflow.v1.plugin.<id>`), an instance channel
  per process, a reply channel per host, a registry channel and a control channel for cancel (protocol §14.2).
- **Claim check**: a body larger than the broker allows goes to S3 and the message carries a reference (protocol §14.6),
  in the TypeScript, Go and Python cores and the bridge.
- **Choosing per call** (`transports/auto.ts`, `selector.ts`, `breaker.ts`): each plugin has a policy, **Auto** by
  default, **pinned** or an allow-list, with an objective; a workflow can override it for its own runs. Auto scores each
  transport by expected time to finish (latency, queueing, errors), keeps interactive calls on gRPC or HTTP, spills
  bursts over to a buffering broker, never flaps (hysteresis), opens a circuit breaker on failures, and moves a call to
  another transport only when it provably wasn't delivered, so nothing runs twice. Every `plugin.rpc` span says which
  transport carried the call and why.

## MCP

Landflow is an MCP server in five places and an MCP client in three ([transports.md](transports.md#mcp-every-plugin-is-also-an-mcp-server),
[protocol §15](protocol.md#15-mcp), [mcp-gateway.md](mcp-gateway.md)).

| Server | URL | What it serves |
|---|---|---|
| Per-plugin endpoints | host `/api/mcp/plugins/<id>`, gateway `/mcp/plugins/<id>` | a plugin's actions as tools (from the manifest), its triggers as resources |
| The joined endpoint | gateway `/mcp` | every exposed plugin's tools, prefixed with the plugin |
| Instance server | `/api/mcp`, gateway `/mcp/landflow` | build, validate and run workflows (for coding agents) |
| Project instance server | `/api/mcp/projects/<id>` (or a project-scoped token), gateway `/mcp/projects/<name>` | the same, limited to one project's workflows (migrations 1870, 1871) |
| MCP Server Trigger | `/mcp/<path>`, gateway `/mcp/workflows/<name>` | the tools attached to a published workflow's trigger, and its resources and prompts (static text or a sub-workflow) |

Clients: the **MCP Client Tool** sub-node, the **MCP Client** node (call a tool, list or read resources, list or get
prompts) and agents' MCP capabilities. A server that signs users in is reached with a `core.mcpOAuth2Api` credential:
the host follows the 401 to the protected resource metadata (RFC 9728) and the authorization server's metadata (RFC 8414),
registers a client when none is configured (RFC 7591), runs PKCE and names the resource on every token request (RFC 8707),
and renews the token before it expires (`lib/server/mcp/oauth.ts`).

```
 agent ──MCP + token──▶ agentgateway ── sign-in (JWKS), prefixes, rate limits ──▶ host /api/mcp/plugins/<id>
                         sends the gateway secret and the caller's identity         grants · bound credential ·
                         never the caller's token                                   approvals · audit
                                                                                     ▼
                                                                 selector ─▶ HTTP, gRPC or a broker ─▶ plugin
```

- **The gateway is agentgateway**, kept in step by `McpGatewaySync`: when a plugin comes online, changes or goes away, the
  host writes or removes its `mcp.target` and its per-plugin route through the gateway's config API (or a config file),
  and reports drift. Sign-in at the gateway checks Landflow-issued MCP tokens (the host's JWKS, written inline into the
  stored routes) and, when an identity provider is configured, its tokens too on the same route (a `jwtAuth` with two
  providers; `LANDFLOW_MCP_GATEWAY_ACCEPT_IDP=off` keeps one issuer).
- **Who may call what**: tool grants (a user, a SCIM group, a project, a role or one token; tools by name, `*` or
  `!name`), the credential each grant binds, governance (the node allow-list) and approvals for destructive tools (MCP
  elicitation, or an approval in Settings → MCP). Each tool call is an execution with mode `mcp`, audited.

## Storage

| What | Where |
|---|---|
| Workflows, versions, executions, checkpoints, waits, users, projects, settings, data tables, audit events… | SQLite (`<data dir>/landflow.db`, WAL) or Postgres (`LANDFLOW_DB=postgres`) |
| Files (binary data) | the filesystem store or S3 (MinIO), deleted with their execution |
| Credentials and settings files | encrypted files in the data directory, or the database (`LANDFLOW_CONFIG_STORE=database`, the default in queue mode) |
| Agents, their sessions and memory | files in the data directory, or the database with the same switch (migration 1881) |
| Encryption key | `LANDFLOW_ENCRYPTION_KEY` or `<data dir>/encryption.key` |
| External secrets | OpenBao/Vault, 1Password, AWS, GCP, Azure: resolved at run time, never stored |

On Postgres the host loads the database into an in-memory copy at boot, serves reads from it and writes through an
ordered queue spooled to disk, so the store API stays synchronous; other processes' writes arrive through
`LISTEN/NOTIFY`. Migrations are versioned (`db/schema.ts`, recorded in `schema_version`), each written for both
databases; a migration can add columns only where they are missing.

## Queue mode and high availability

```
            load balancer
           ┌──────┴──────┐
         main-1        main-2  ── leader election (Valkey key with TTL and fencing token)
           │  enqueue    │        the leader runs schedules, polls, IMAP IDLE, timers, alerts, retention
           ▼             ▼
      Valkey stream (consumer group) ── XAUTOCLAIM after a missed lease ──┐
           │                                                                │
       worker-1      worker-2   ◀───────────────────────────────────────────┘
           │ events, replies, results over pub/sub to the main that waits
           ▼
      Postgres (shared) · S3 (files) · plugins (each process connects to them)
```

`LANDFLOW_EXECUTIONS_MODE=queue` makes mains enqueue production runs and workers run them. A run holds a lease renewed by
heartbeats; when a worker dies, another one claims its jobs and continues each run from its checkpoint. Stop, idempotency,
concurrency slots, retries, rate limits, debounce, sign-in limits and debug sessions work across processes through Valkey.

- **Priorities**: three streams (high, normal, low); a worker takes high first, a low run after every eight others, and
  waiting runs age upwards after 15 s and 60 s, so nothing starves.
- **Failover**: Valkey Sentinel (`LANDFLOW_VALKEY_SENTINELS`) or Valkey Cluster (`LANDFLOW_VALKEY_CLUSTER`; the client
  follows `MOVED` and `ASK`). Every key carries one hash tag so the Lua scripts stay single-slot: Cluster gives failover,
  not scale-out.
- **Shared state**: with `LANDFLOW_CONFIG_STORE=database` (the default in queue mode) credentials, settings files, agents,
  their sessions and memory live in Postgres, so any main serves any request (no sticky sessions).
- **Live runs on any main**: each main keeps the latest `node.progress` of every running node from the relayed events,
  so a page opened mid-run shows a worker's live steps and team budgets; the landflow-harness mod's reports for a
  worker's call reach that worker through the main they land on (the trace id names it, the batch goes to its inbox).
- **Where**: `deploy/compose.queue.yml` runs two mains, two workers and a load balancer; `deploy/k8s/overlays/orbstack-queue`
  runs the same on Kubernetes with Postgres, Valkey and MinIO, and a KEDA example scales workers on the stream's backlog.

## Identity, access and governance

- **Sign-in**: local users (scrypt, hashed sessions, rate limits), OIDC, SAML 2.0 (signed and encrypted assertions) and
  SCIM 2.0 provisioning. SAML keys rotate with two certificates (a next signing and decryption pair is published before
  it takes over). API keys (`lf_…`) have scopes and expiry; MCP tokens are JWTs the host signs.
- **Roles and projects**: instance roles (owner, admin, member) and projects (personal and team, with admin, editor and
  viewer). Workflows, credentials, data tables, agents, folders and variables belong to a project; checks run in the
  route guard, lists, pickers, live events and runs. Sharing gives people or projects access to one workflow or credential.
- **Governance**: node, HTTP host and MCP server allow-lists; four-eyes publishing and promotion (per project too);
  scheduled publishes (`publish-schedule.ts`, run by the leader); protected environments.
- **Environments and Git sync**: workflows as files (`landflow-sync/v1`), a branch per environment, promotion with diffs,
  conflict checks, credential updates and row merges; per-workflow push, history and restore; SSH keys from a
  `core.sshPrivateKey` credential with the host key pinned.
- **Audit**: every change and denied request is an audit event and an OTel log record, in a SHA-256 hash chain, streamed
  to SIEMs (syslog, HTTP, Splunk, Datadog, Elasticsearch) through a durable outbox, optionally per project. The leader signs
  the chain's head with an Ed25519 key and anchors it in S3 or at a webhook, so a rewritten log is detectable offline.

## AI

The AI nodes are n8n's cluster nodes: the AI Agent and the chains take a model, memory, tools, retrievers and rerankers on
typed ports. Model adapters (Anthropic, OpenAI-compatible, Ollama) are provider-neutral, stream tokens and price every
call (cached tokens at their own price). Images, PDFs, audio and video go to the model as inputs (audio and video are
transcribed for models without them), and Simple Memory re-attaches earlier files in later turns. Around them:

- **RAG**: vector stores in memory, SQLite or pgvector, embeddings, loaders that read PDF, DOCX and other files,
  splitters, LLM and Cohere rerankers.
- **Safety and cost**: the Guardrails node and the same checks on an agent's input and output; tool approvals in the
  editor, Slack, Teams or by email (single-use signed links); usage caps per agent, credential and user, with cost alerts
  before a cap.
- **Quality**: offline evaluations over Data Tables or uploaded files, on a schedule, with score alerts; online grading
  by an LLM judge.
- **Reach**: hosted chat and an embeddable widget (Basic Auth, feedback, sanitized custom CSS), and **standalone agents**
  with skills, capabilities, knowledge uploads, memory, schedules and channels (Slack with slash commands, Telegram,
  Microsoft Teams).

See [agents.md](agents.md) and [assistant.md](assistant.md).

## The code runner

The Code node runs JavaScript or Python either in process (a `node:vm` context of the host, not isolated; off by default in the production profile, which
runs Code nodes in the runner unless `LANDFLOW_CODE_IN_PROCESS=true`) or in the code
runner: a separate service that starts a fresh process per run, with n8n's globals, no network, a read-only root, resource
limits and a shared secret for its callers ([deployment.md, "Code runner"](deployment.md#code-runner)).
Both paths give the code the same `$('Node')` helpers (the expression engine's accessors, `packages/engine/src/expression.ts`; expressions themselves run in a sealed realm, `packages/engine/src/sandbox/`, which `nodeAccessor` mirrors) and the same file helpers (`this.helpers.getBinaryDataBuffer` / `prepareBinaryData`): in process they use the context's binary client, and the runner, having no network, receives input file bytes in the request and returns created files as base64 for the host to store.

## Observability

Every process speaks OpenTelemetry ([observability.md](observability.md)). The host traces each execution, node and plugin
call (`plugin.rpc`, with the transport and why); the SDKs continue the trace inside the plugin, so one trace shows the
editor click, the engine, the broker hop and the node's own HTTP calls. Metrics cover flows, queues, transports, workers,
AI usage and every plugin; logs carry the trace id. `/api/metrics` serves Prometheus text; Jaeger runs locally.

## Deployment

| Where | How |
|---|---|
| Development | `pnpm dev` (host on :3000) and each plugin from its directory, or `pnpm dev:all` |
| Docker | `deploy/compose.yml`: the host (:53000) with the gateway sidecar (:54000), seven plugins and the code runner (:53300) |
| Queue mode | `deploy/compose.queue.yml`: two mains, two workers, a load balancer (:53080), gateway sidecars |
| Infrastructure | `deploy/compose.infra.yml`: Postgres, Valkey (and a six-node Valkey Cluster, profile `valkey-cluster`), MinIO, Mailpit, Keycloak, OpenBao, LocalStack, Jaeger, MySQL, GreenMail, a Git SSH server (profile `git`), every broker (one profile each), agentgateway |
| Kubernetes | `deploy/k8s`: a base (the host with its gateway sidecar and a namespaced Role, seven plugins), components (Postgres, Valkey, MinIO, the brokers, broker transports, queue mode, Ingress, Gateway API routes, gateway sign-in with one or two issuers, cluster-wide discovery) and overlays for OrbStack (`orbstack`, `orbstack-brokers`, `orbstack-queue`…); KEDA examples scale plugins on broker backlog and workers on the queue's |

See [deployment.md](deployment.md) for every stack and how each was checked.

## Where the code is

```
apps/web/                 the host: src/app (UI pages and API routes), src/components, src/lib/server,
                          src/lib/shared (code the UI and the server both run: types, composite checks, run checks,
                          Spotlight's bubbles), test/
packages/engine/          the executor
packages/protocol/        the wire contract: TypeScript types, zod schemas → JSON Schema, plugin.proto, MCP mapping
packages/sdk/             the TypeScript plugin SDK
packages/transports/      the messaging core, the broker drivers, the conformance suite, the claim check
packages/cli/             the landflow CLI
sdks/go/, sdks/python/    the Go and Python SDKs, with their transport cores and drivers
plugins/                  the bundled plugins (and transport-bench for benchmarks)
services/code-runner/     the Code node sandbox
services/landflow-bridge/ broker kinds for Go and Python plugins without a native driver
deploy/                   compose stacks, Dockerfiles, Kubernetes manifests, the gateway config, scripts
docs/                     every document (index: docs/README.md): features/, reference/, the protocol, transports,
                          deployment, development, limitations, roadmap
```

[development.md](development.md) has a finer table of where to start reading in each area, the conventions and every
test command.
