# Plan: one plugin, every transport, and MCP

Status: **planned** (2026-10-26, revised the same day). Nothing here is built yet. Decisions that need a yes are in the
last section.

## Goal

Today a plugin serves `landflow.plugin/v1` over HTTP and/or gRPC, and the host calls whichever endpoint is preferred.
The goal is to make the way a plugin is reached generic, on both sides:

- **Any transport.** A plugin built with an SDK (TypeScript, Go, Python) can be reached directly (HTTP, gRPC) and through
  any common message broker: Kafka, RabbitMQ, NATS, Valkey/Redis Streams, MQTT, Amazon SQS, Google Pub/Sub, Azure Service
  Bus, AMQP 1.0 brokers and Pulsar. Brokers plug in through one small driver contract, so adding another is a driver,
  not a redesign.
- **Every plugin is also an MCP server.** The SDK exposes the plugin's actions as MCP tools automatically, and the host's
  MCP gateway lists every plugin's tools (core nodes included) for agents, with Landflow's credentials, permissions and
  audit. Nothing to write per plugin.
- **The host chooses.** It knows which transports are installed, which of them each plugin is reachable through, and
  routes each call over the one that is currently the most efficient, from live traffic. An admin can pin a transport or
  limit the choice per plugin.

The running example is a Twilio plugin reachable over gRPC, HTTP and the installed broker, and used by agents over MCP.

## What exists today (what this builds on)

| Piece | Where | What it does |
|---|---|---|
| Logical contract | `packages/protocol` (`types.ts`, `plugin.proto`) | `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health`, `WebhookMethod`, `ReceiveWebhook`; JSON bodies over HTTP, `DynamicValue` JSON inside protobuf over gRPC |
| Host clients | `apps/web/src/lib/server/plugins/clients.ts` | `PluginClient` interface; HTTP, gRPC and pooled (per-pod) clients; `transportOf()` reads the URL scheme |
| Endpoint choice | `plugins/registry.ts` `activeEndpoint()` | Several endpoints per plugin; picks the plugin's `preferredTransport` if online, else gRPC, else HTTP. The preference lives in memory only |
| SDK servers | `packages/sdk/src/serve.ts`, `http.ts`, `grpc.ts`, `handlers.ts` (Go and Python alike) | `serve(plugin, { http, grpc })` over shared handlers; announce and heartbeat every 10 s |
| Tools for agents | node descriptors' `usableAsTool`; the AI Agent node; the host's MCP server at `/api/mcp` (builds and runs workflows) and the MCP Server Trigger | Agents inside Landflow already call plugin nodes as tools; outside agents only reach workflows |
| Telemetry | `docs/observability.md` | `plugin.rpc {Method}` spans, `landflow.plugin.rpc.duration`, `landflow.transport` on `node.execute` |
| Idempotency, proofs | `ExecuteRequest.idempotencyKey`; protocol §13 registry proofs | Safe repeats; HMAC over `LANDFLOW_REGISTRY_SECRET` |

The logical RPC is already transport-neutral. What's missing is a binding interface in the SDKs, a generic messaging layer
with broker drivers, an MCP face, and a policy that chooses per call from measurements.

## The shape: one core, four faces

```
                 Landflow host                                   Agents (Claude Code, Cursor, Landflow agents)
   selector ─┬─ direct ───── HTTP ──────────────┐                      │                    │
             ├─ direct ───── gRPC ──────────────┤                      │ MCP                │ MCP
             └─ messaging ── broker driver ─▶ [ any broker ] ─┐        ▼                    ▼
                                                │             │   host MCP gateway ───────▶ (through the selector)
                                                ▼             ▼
                       ┌──────────────── plugin built with the SDK ────────────────┐
                       │  HTTP binding · gRPC binding · messaging binding · MCP     │
                       │                 dispatcher (landflow.plugin/v1)            │
                       │                 nodes (Twilio: send SMS, list messages…)   │
                       └────────────────────────────────────────────────────────────┘
```

- **Dispatcher**: today's `handlers.ts` (spans, metrics, redaction, credentials), with an `AbortSignal` and a deadline per
  call. Every face calls it; none has its own node logic.
- **Bindings** ("faces"): HTTP and gRPC (as today), **messaging** (one generic core plus a driver per broker) and **MCP**.
- **Host providers** mirror the bindings: direct clients, the same messaging core and drivers, and the MCP gateway.

## Concepts

- **Transport kind**: `http`, `grpc` (direct: the host connects to the plugin), or a broker kind (`kafka`, `amqp`,
  `nats`, `valkey`, `mqtt`, `sqs`, `pubsub`, `servicebus`, `amqp1`, `pulsar`; brokered: both connect out, the plugin needs
  no inbound port).
- **Broker connection**: one installed broker on the host side, e.g. `kafka-main`. Set up in Settings → Transports or by
  environment variables; secrets encrypted like credentials.
- **Endpoint**: how one plugin is reached over one transport. Direct endpoints stay URLs (`grpc://10.0.0.5:7204`); brokered
  endpoints are logical, `<kind>://<connectionId>/<pluginId>` (`kafka://kafka-main/twilio`), never with hosts or passwords.
- **Driver**: the broker-specific part (publish, consume, acknowledge, declare, stats), in the host and in each SDK.
- **Transport policy** (per plugin): `auto` (default), `pinned` to one transport, plus an optional allow-list.

A transport is offered for a plugin only when both sides have it: the host has the driver and a healthy connection, and
the plugin has a live endpoint on it.

## Generic messaging

### One envelope: CloudEvents

Every brokered request and reply is a **CloudEvents 1.0** event. CloudEvents is a CNCF spec with protocol bindings for
Kafka, AMQP, MQTT, NATS and HTTP, so each broker carries the envelope the way its ecosystem expects: in headers ("binary
mode") where the broker has headers, or as one JSON document ("structured mode") where it doesn't or limits them.
Existing event tooling can read, route and archive Landflow traffic without knowing Landflow.

| Attribute | Value |
|---|---|
| `specversion` | `1.0` |
| `id` | the call id (a reply has its own id) |
| `source` | `landflow://host/<instanceId>` or `landflow://plugin/<pluginId>/<instanceId>` |
| `type` | `dev.landflow.plugin.v1.execute`, `….execute.reply`, `….loadoptions`, `….testcredentials`, `….health`, `….getmanifest`, `….webhookmethod`, `….receivewebhook`, `….announce`, `….withdraw`, `….cancel` |
| `subject` | the node type (`twilio.message`) |
| `time`, `datacontenttype` | `application/json`; the body is the HTTP binding's JSON |
| `traceparent`, `tracestate` | the CloudEvents distributed tracing extension |
| `lfreplyto` | where to answer, when the broker has no native reply mechanism |
| `lfcorrelation` | on a reply, the request's `id` |
| `lfdeadline` | epoch ms after which the call must not run |
| `lfattempt`, `lfidempotency`, `lfmanifest` | delivery attempt, `idempotencyKey`, manifest hash |
| `lfkeyid`, `lfsig` | signature over the event (below) |

### One core, small drivers

The **messaging core** is written once per language and holds everything Landflow-specific: the envelope, correlation and
replies, deadlines, cancellation, delivery modes, signing and encryption, announcing over the broker, metrics and stats.
A **driver** only knows its broker:

```ts
// @landflow/transports (TypeScript; the Go package mirrors it)
export interface BrokerDriver {
  readonly kind: string;                                   // 'kafka' | 'amqp' | 'nats' | 'valkey' | 'mqtt' | 'sqs' | …
  readonly capabilities: BrokerCapabilities;               // what the core and the selector may rely on
  connect(config: BrokerConfig): Promise<void>;
  declare(channels: ChannelSpec[]): Promise<void>;         // queues, topics, subjects or streams: the broker's own word
  publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome>;   // accepted | unroutable
  consume(channel: string, options: ConsumeOptions, onEvent: (event: WireEvent, delivery: Delivery) => Promise<void>): Promise<Subscription>;
  request?(channel: string, event: WireEvent, timeoutMs: number): Promise<WireEvent>;              // native request/reply
  stats?(channel: string): Promise<{ depth?: number; consumers?: number; lag?: number }>;
  close(): Promise<void>;
}
export interface BrokerCapabilities {
  replies: 'native' | 'reply-channel';   // NATS inboxes, RabbitMQ direct reply-to, MQTT response topics… or a channel per host
  workSharing: boolean;                  // replicas share one request channel (queue, consumer group, queue group, shared subscription)
  buffering: boolean;                    // holds calls while consumers are busy
  ttl: boolean;                          // the broker drops expired calls itself
  undeliverable: 'reported' | 'inferred' | 'unknown';   // can it say "nobody took this"?
  persistence: 'memory' | 'disk';        // decides how strict secret handling must be
  maxMessageBytes: number;
  latency: 'low' | 'medium' | 'high';    // a prior for the selector before it has measurements
}
```

Channels (names use a prefix, default `landflow`, and the protocol version): a **request channel** per plugin
(`landflow.v1.plugin.<pluginId>`), shared by its replicas; an **instance channel** per plugin process for calls that must
reach one instance; a **reply channel** per host process, unless the broker replies natively; a **registry channel** for
announce and withdraw (plugins announce over the broker, with a registry proof, so the host finds them without a port);
a **control channel** for cancel.

### Brokers

Tier 1 lands first in the TypeScript and Go cores; tier 2 follows driver by driver. Every driver passes the same
conformance kit against a local container (no cloud accounts; cloud services use their official emulators).

| Broker | Request channel; replicas share it by | Replies | Holds bursts | Notes |
|---|---|---|---|---|
| **Kafka** (and Redpanda) | a topic per plugin; a share group on Kafka 4.x (queue-like, records acknowledged one by one), else a consumer group (parallelism up to the partition count); key = execution id | a reply topic per host | Yes (the log) | No per-message TTL, so the consumer checks the deadline; records stay on disk for the retention period; higher latency, a natural spill-over target |
| **RabbitMQ** (AMQP 0-9-1) | a queue per plugin; competing consumers | direct reply-to | Yes | `mandatory` returns undeliverable calls; per-message TTL |
| **NATS** | a subject per plugin; a queue group | native inboxes | Core: no; JetStream work queue: yes | "No responders" tells the host nobody took it; lowest broker latency |
| **Valkey / Redis Streams** | a stream per plugin; a consumer group | a reply stream per host | Yes | Reuses queue mode's Valkey; pending entries are claimed after a crash |
| MQTT 5 (Mosquitto, EMQX, HiveMQ) | a topic per plugin; a shared subscription | response topic and correlation data | Broker-dependent | Edge and IoT networks; message expiry |
| Amazon SQS | a queue per plugin | a reply queue per host | Yes | Messages up to 1 MiB and 10 attributes, so structured mode; larger bodies by reference |
| Google Pub/Sub | a topic and subscription per plugin | a reply subscription per host | Yes | Ack deadlines; ordering keys |
| Azure Service Bus | a queue per plugin | sessions (`ReplyToSessionId`) on a session-enabled reply queue | Yes | 256 KB on Standard; 1 MB by default on Premium, up to 100 MB over AMQP |
| AMQP 1.0 (ActiveMQ Artemis, Qpid) | an address per plugin | reply-to address | Yes | Also reaches other AMQP 1.0 brokers |
| Apache Pulsar | a topic per plugin; a shared subscription | a reply topic per host | Yes | Message TTL |

The capabilities drive behaviour: undeliverable detection decides whether a failed publish may move to another transport;
`persistence: 'disk'` makes end-to-end encryption mandatory (Kafka, Streams, SQS and the others keep messages on disk);
`maxMessageBytes` makes the selector skip a broker for a call that is too big.

Differences the core absorbs, so drivers stay small:

- **Correlation**: Kafka, SQS and Pub/Sub have no reply or correlation semantics of their own, so the envelope carries
  them (`lfreplyto`, `lfcorrelation`) and the core runs the reply consumer.
- **Reply lifetime**: RabbitMQ's direct reply-to and NATS inboxes end with the connection, so a reconnect fails the calls in
  flight with "connection lost; it may have run", never a silent wait.
- **"Nobody took it"**: only NATS (no responders) and RabbitMQ (`mandatory`) say so at once. Elsewhere the host infers it
  from consumer heartbeats on the registry channel and from consumer counts, and otherwise waits for the deadline.
- **Header budgets**: SQS allows 10 attributes, Pub/Sub 100, Azure Service Bus 64 KB of headers; drivers with tight budgets
  use structured mode.
- **Redelivery**: SQS visibility timeouts, Service Bus locks, JetStream and Pulsar ack waits and Valkey pending entries all
  redeliver; the core turns that into the delivery rules below, and the idempotency key travels in the envelope.

### Delivery rules (all brokers)

- **At most once by default**: the plugin acknowledges (or commits) an `Execute` before running it, so a crash mid-call
  never runs it twice. The host's deadline fails the node with "the plugin went away; the call may have run", and the
  node's own retry settings decide what's next.
- **At least once** for nodes marked `idempotent`, and for calls with an `idempotencyKey` when the node opts in: the
  acknowledgement comes after the reply, so another replica takes the call if an instance dies. `LoadOptions`,
  `TestCredentials` and `Health` always use this mode.
- **Deadlines** are checked by the consumer on every broker (TTL, where it exists, is only a first filter).
- **Concurrency**: each instance takes at most its `maxConcurrency` calls at once (prefetch, max in flight, or pull batch
  size, depending on the broker).
- **Size**: the envelope must fit the driver's limit (Azure Service Bus Standard 256 KB; Kafka, NATS and SQS about 1 MiB by
  default). Over it, the body goes by reference through the shared store (a claim check), or the call goes by another
  transport. Files already travel as references (§11), so a brokered plugin that handles files uses the shared binary store
  (S3/MinIO) when it can't reach the host.
- **Version skew**: a consumer whose manifest hash differs answers `manifest_mismatch` and puts the call back; the host
  pulls the manifest again.

### Security over brokers

An `ExecuteRequest` carries decrypted credentials (Twilio's auth token), and most brokers keep messages on disk.

1. **Credentials are encrypted end to end** (AES-256-GCM) under a per-plugin key,
   `HKDF(LANDFLOW_TRANSPORT_SECRET or LANDFLOW_REGISTRY_SECRET, "landflow transport v1" ‖ pluginId)`. All replicas of a
   plugin derive the same key, so work sharing keeps working; whoever reads the broker can't read the secrets.
2. **Every event is signed** (`lfsig`, HMAC from the same key family): nobody else on the broker can call a plugin or fake a
   reply. An announce without a valid registry proof is ignored; a brokered endpoint is never used without the secret.
3. **TLS** to the broker is recommended, with a warning for plain connections to a non-loopback host.
4. **Broker permissions**: one broker user per plugin that can read only its own channels, and one host user, with an
   example per broker in `deploy/README.md`.

### How each language gets every broker

Writing every driver three times would not scale. So:

- **TypeScript**: `@landflow/transports` holds the messaging core and every driver; the host and the TypeScript SDK both
  use it.
- **Go**: `sdks/go/transport` holds the core and every driver; the Go SDK and `landflow-bridge` both use it.
- **Python**: through `landflow-bridge` first; native tier 1 drivers later, when there's demand.
- Candidate client libraries: in TypeScript `@confluentinc/kafka-javascript` (Confluent's supported client; `kafkajs` has
  had no release since 2023), `amqplib`, `@nats-io/transport-node` and `mqtt`; in Go `franz-go`, `amqp091-go`, `nats.go`
  and `paho.golang`; in Python, later, `confluent-kafka`, `aio-pika`, `nats-py` and `paho-mqtt` 2.x.
- **`landflow-bridge`**: a small Go sidecar (one binary and container) that sits next to any plugin that speaks
  `landflow.plugin/v1` over HTTP or gRPC (built with any SDK, or with none) and gives it every broker driver and the MCP
  face. In Kubernetes it's a sidecar container; locally it's one more process. So every plugin is reachable through every
  transport, whatever it was written in.

## MCP: every plugin is also an MCP server

The MCP face and the gateway target the current MCP revision (2026-07-28): stateless requests (no `initialize`, no
session id; clients use `server/discover`), Streamable HTTP and stdio, and OAuth 2.1 with protected resource metadata
for authorization.

### Two ways in

1. **The host's MCP gateway** (the main path): `/api/mcp/plugins` lists the tools of every plugin the caller may use, and
   `/api/mcp/plugins/<pluginId>` one plugin's. It follows the registry live (`notifications/tools/list_changed`, on the
   `subscriptions/listen` stream of clients that ask for it, when a plugin comes, goes or changes), includes the in-process core nodes (HTTP Request, Data Table, Code…), and sends each
   call through the normal selector, so agents get the same transports as workflows.
2. **The plugin's own MCP endpoint**, added by the SDK with no code: Streamable HTTP at `/mcp` on the plugin's HTTP port,
   and stdio with `--mcp-stdio` (so a desktop agent can start a plugin directly). It's for running a plugin without
   Landflow, or next to an agent on a laptop.

### From node to tool

| Landflow | MCP |
|---|---|
| An action node's operation (resource × operation) | One tool, `<plugin>__<resource>_<operation>` (e.g. `twilio__message_send`) |
| The parameters shown for that operation (`displayOptions`) | `inputSchema` (JSON Schema): types, `required`, defaults, descriptions, collections as objects |
| Static options | `enum` with titles |
| Dynamic options (`loadOptions`) | `enum` when the bound credential lets the gateway resolve them (cached); otherwise a string, plus a read-only `<plugin>__list_options` tool |
| Credentials | Never arguments: bound by the gateway, or by the plugin's local config |
| `idempotent`; get, list, search; delete | `idempotentHint`; `readOnlyHint`; `destructiveHint`; always `openWorldHint` |
| Output items | `structuredContent` (`{ items }`, with `outputSchema` when the node declares one) and a short text |
| Files in the output | `resource_link` (the gateway signs a host URL); small images and audio inline |
| A node error | a result with `isError: true` and the message |
| Stop, timeout | the call's `AbortSignal` ↔ the client closing the request's stream (HTTP) or `notifications/cancelled` (stdio) |
| Triggers | Not tools (later: resources an agent can subscribe to) |

Which nodes become tools: the ones marked `usableAsTool` (every action node by the plugin design rules), minus anything a
node or operation opts out of with `mcp: false`.

### Credentials, permissions and audit

- **Gateway**: callers authenticate with a Landflow API key that has the new `mcp:tools` scope (OAuth for MCP clients,
  per the MCP authorization spec with Client ID Metadata Documents, comes later). A **tool grant** per key or project says which tools it may call and which
  credential each one uses, chosen from the project's credentials, so the agent never sees a token. Governance allow-lists
  (instance, project, workflow) apply; destructive tools can require an approval (Landflow's approvals, or MCP elicitation's
  `input_required` round trip where the client supports it; the gateway keeps the pending call until the client retries). Each call is audited (`mcp.tool.call`: tool, outcome, ids, no arguments) and appears as an
  execution with mode `mcp`, so costs, traces and failure alerts work as for any run.
- **Plugin's own endpoint**: on by default, but it needs a token (`LANDFLOW_MCP_TOKEN`) unless it listens only on
  loopback. Credentials come from a local file or environment variables (`LANDFLOW_MCP_CREDENTIALS`); tools whose
  credential isn't configured answer with what's missing.
- Landflow's own agents keep calling plugin nodes directly as tools (no MCP hop); the gateway is for agents outside.

## Host side

New module `apps/web/src/lib/server/transports/`:

| File | Role |
|---|---|
| `provider.ts` | Providers per kind and their registry |
| `direct.ts` | Today's HTTP, gRPC and pooled clients, unchanged |
| `messaging.ts` | The host side of `@landflow/transports`: connections, discovery over the registry channel into `registry.addEndpoint('<kind>://<conn>/<plugin>', 'broker')`, stats every 5 s |
| `connections.ts` | Broker connections in the database (migration in the 1700s), encrypted, with **Test** and health (connected, version, round trip); also from env (`LANDFLOW_TRANSPORT_<KIND>_URL`) |
| `stats.ts`, `selector.ts` | Measurements and the choice per call (below); the selector replaces `activeEndpoint()` |
| `policy-store.ts` | The per-plugin policy in the database (today's in-memory `preferredTransport` becomes `{ mode, pinned?, allowed?, objective }`), shared by mains and workers |
| `../mcp/gateway.ts` | The MCP gateway: tool generation from manifests, grants, calls through the selector |

Plus `PATCH /api/plugins/:id` with the new policy (the old body still works), `GET /api/transports`,
`/api/transports/connections` (admin), `/api/mcp/grants`; **Settings → Transports** (installed kinds, connections, which
plugins are on each); **Settings → MCP** gains the gateway, its grants and a tool browser; the **Plugins page** shows each
plugin's transports with live numbers, the current choice and why, the policy picker, and its MCP tools. Workers in queue
mode open the broker connections too and choose for themselves. In Kubernetes, a brokered plugin needs no Service; the
docs add broker manifests and a KEDA recipe that scales replicas on queue depth or consumer lag.

## SDK side

```ts
// packages/sdk: a binding is one face of the plugin
export interface TransportBinding {
  readonly kind: string;                                  // 'http' | 'grpc' | 'mcp' | a broker kind
  start(context: BindingContext): Promise<BindingInfo>;   // listen or connect; the endpoint to announce, if any
  stop(): Promise<void>;                                  // drain in-flight calls, then close
}

await serve(twilio, {
  http: 7104,                                 // also serves /mcp unless LANDFLOW_MCP=off
  grpc: 7204,
  brokers: [kafka({ brokers: ['127.0.0.1:59092'] }), nats({ servers: 'nats://127.0.0.1:54222' })],
});
```

- Environment instead of code: `LANDFLOW_TRANSPORTS=http,grpc,kafka,nats`, `LANDFLOW_<KIND>_URL`, `LANDFLOW_MCP`
  (`on`, `off`, `stdio`), `LANDFLOW_MCP_TOKEN`, `LANDFLOW_TRANSPORT_SECRET`. Broker drivers load only when used.
- Go: `landflow.Serve(p, landflow.WithHTTP(7104), landflow.WithGRPC(7204), landflow.WithBroker(kafka.New(…)))`, drivers in
  their own packages so a plugin pulls only what it uses. Python: `serve(plugin, http=…, grpc=…)` plus the bridge for brokers.
- The MCP face uses the official MCP SDK of each language: `@modelcontextprotocol/server` (the v2 packages) in TypeScript,
  `github.com/modelcontextprotocol/go-sdk` (v1) in Go, `mcp` in Python. The host's existing MCP server, on the 1.x package,
  moves to v2 in phase 3.
- Server spans keep `plugin.execute …`; brokered calls add the OpenTelemetry messaging attributes
  (`messaging.system`, `messaging.destination.name`, `messaging.operation.type`); MCP calls add `mcp.tool.name`.
- **Conformance kit** (`packages/protocol/conformance/`): request fixtures and expected replies (deadlines, cancellation,
  errors, size limits, delivery modes, MCP tool listing and calls), run by every SDK × face and every driver.

## Protocol changes (additive, still `landflow.plugin/v1`)

1. Endpoint schemes `<kind>://<connectionId>/<pluginId>` for brokers; older hosts never see them (they're announced over
   the broker).
2. Manifest hints: `transports: string[]` (faces the plugin was built with) and `maxConcurrency`.
3. Node descriptor: `idempotent?: boolean`, `mcp?: false` (per node or operation), `outputSchema?` (for MCP structured
   output), and optional tool annotations to override the derived ones.
4. New protocol sections: §14 "Messaging" (envelope, channels, delivery rules, security, one subsection per broker) and
   §15 "MCP" (tool mapping, gateway, grants).
5. The engine's `Transport` type becomes an open string union, so spans and metrics carry any kind.

## Choosing a transport per call (Auto)

**Inputs**, per plugin × endpoint, over a 60 s window with a moving average: latency per method and size bucket;
transport failures and timeouts (a node error in a normal reply doesn't count); calls in flight against
`maxConcurrency`; for brokers, depth or consumer lag, consumers and publish latency; the driver's capabilities; and the
call's context (method, run mode, item count, size, whether it may be repeated).

**Score** = expected time to finish: base latency, plus a queueing estimate (direct: a penalty that grows near the limit;
broker: depth ÷ consumers × mean service time), plus an error penalty. Lowest wins, with these rules:

1. **Skip what can't carry the call**: too big for the driver, or a delivery mode it can't give.
2. **Interactive calls stay fast**: editor runs, pickers, credential tests, webhooks with a caller waiting and MCP tool
   calls prefer gRPC, then HTTP, then a low-latency broker (NATS) while healthy.
3. **Bursts spill over instead of flipping**: production calls fill the direct transport up to about 80 % of the plugin's
   concurrency, and the rest go to a buffering broker (Kafka, RabbitMQ, JetStream, Streams, SQS…), which holds them.
4. **No flapping**: the main transport changes only when another is at least 20 % better for three 10 s windows in a row,
   then stays at least 60 s.
5. **Fresh numbers without risk**: a `Health` ping every 15 s per transport; `Execute` is never a probe.
6. **Circuit breaker** per endpoint: open after 5 failures in a row or more than half of the last 20; half-open after 15 s.
7. **A call moves to another transport only when it provably wasn't delivered** (connection refused, DNS, gRPC
   `UNAVAILABLE` before sending, a broker that reported it unroutable or that nobody took it). Otherwise the error
   surfaces, so nothing runs twice.
8. **Objective** per plugin: `balanced` (default), `latency` or `throughput`.

**Explainability**: every `plugin.rpc` span carries `landflow.transport` and `landflow.transport.reason` (`pinned`,
`only`, `auto.latency`, `auto.spillover`, `auto.failover`, `auto.breaker`, `auto.size`); metrics
`landflow.transport.calls`, `landflow.transport.switches`, `landflow.transport.queue_depth`; the feed says why, e.g.
"Twilio now spills over to Kafka: gRPC at 14 of 16 calls, p95 2.1 s".

## Walk-through: Twilio

1. **A broker is installed**, say Kafka (in dev, `deploy/compose.infra.yml` gets one profile per broker). The admin adds
   it in Settings → Transports, and Test says it's connected.
2. **The plugin starts** with `LANDFLOW_TRANSPORTS=http,grpc,kafka`. The Plugins page shows Twilio over gRPC, HTTP and
   Kafka, on Auto, and lists its MCP tools (`twilio__message_send`, `twilio__message_list`…).
3. **An editor test run** goes over gRPC (`auto.latency`).
4. **A 5,000-row campaign** fills gRPC to its limit; the rest spills over to Kafka (`auto.spillover`), keyed by execution,
   and the consumer group keeps each replica under Twilio's API limits. "Send SMS" isn't idempotent, so it's at most once.
5. **gRPC fails**: the breaker opens and everything goes through Kafka (`auto.breaker`), then comes back after recovery.
6. **An agent sends an SMS**: Claude Code connects to the gateway with an API key whose grant allows `twilio__message_send`
   with the "Twilio prod" credential. The call shows in Executions with mode `mcp`, traced and audited; the agent never
   sees the token.
7. **Without Landflow**: a developer runs the plugin with `--mcp-stdio` and a local credentials file, and adds it to
   their agent as an MCP server.
8. **Another network**: a Twilio plugin the host can't reach is pinned to the broker and works anyway.

There's no Twilio plugin yet: the pilot adds a Twilio node to the TypeScript messaging plugin (SMS, MMS, WhatsApp, calls,
list and get messages; Account SID with auth token or API key, tested with `GET /2010-04-01/Accounts/{sid}.json`) against a
fake Twilio server.

## Phases

Each phase ends with every test suite passing, a clean type check and a check in Chrome, like the roadmap's waves.

| Phase | Work | Done when | Size |
|---|---|---|---|
| 0. Spec | §14 Messaging and §15 MCP written; decisions settled; tier 1 brokers in `compose.infra.yml` (one profile each, 5xxxx ports) | Spec reviewed; every tier 1 broker starts locally | S |
| 1. Abstraction | SDK `TransportBinding` (TS, Go, Python) with HTTP and gRPC behind it; host providers; the open `Transport` type; the per-plugin policy in the database with its picker; the conformance kit | Every existing test passes, behaviour unchanged; the policy survives restarts and is the same on every process | M |
| 2. Messaging in TypeScript | `@landflow/transports`: the core and tier 1 drivers (Kafka, RabbitMQ, NATS, Valkey Streams); host connections, discovery, Settings → Transports; the TS SDK binding; encryption and signing | A workflow runs through Text Toolkit over each tier 1 broker with one joined trace; a plugin with no open port works; broker restarts and a plugin killed mid-call behave as specified | L |
| 3. MCP | The SDK MCP face (TS, Go, Python); the host gateway with grants, audit, `mcp` executions and the tool browser | An outside agent lists and calls every plugin's tools through the gateway with a bound credential; a plugin runs standalone over stdio | L |
| 4. Go and the bridge | `sdks/go/transport` (core and tier 1 drivers) and `landflow-bridge` | Conformance passes for TS and Go natively and for Python through the bridge, on every tier 1 broker | L |
| 5. Auto | Stats, scoring, spill-over, hysteresis, breaker, probes; the Plugins page numbers, reasons and feed events | Simulations with fake clients and a fake clock: low traffic stays direct, bursts spill over, oversized calls skip small-message brokers, failover and recovery, no flapping | L |
| 6. Tier 2 brokers | MQTT 5, SQS, Pub/Sub, Azure Service Bus, AMQP 1.0, Pulsar: a TS driver (host) and a Go driver (Go SDK and bridge) each, tested against local containers and emulators (Mosquitto, LocalStack, the Pub/Sub emulator, the Service Bus emulator with its SQL Server container, `apache/artemis`, Pulsar standalone) | Conformance passes for each; tests set limits explicitly, since emulators differ from the services (the Pub/Sub emulator never expires messages) | M each |
| 7. Twilio pilot, queue mode, Kubernetes | The Twilio node and fake; workers with broker connections; broker manifests and KEDA docs; `deploy/scripts/transport-bench.py` comparing every installed transport | The walk-through works end to end on the local stack and on OrbStack's cluster | M |
| 8. Python native drivers | Tier 1 drivers in the Python SDK | Conformance passes without the bridge | M |

After phase 1, phases 2 and 3 can run in parallel; 4 and 5 follow 2.

## Risks

| Risk | Answer |
|---|---|
| A repeated side effect (an SMS sent twice) | At most once by default; at least once only for idempotent nodes or with an idempotency key; a call moves only when it provably wasn't delivered |
| Secrets in brokers that keep messages on disk | End-to-end encryption and signing are required; TLS; one broker user per plugin |
| Too many drivers × languages to maintain | One core per language, small drivers, capabilities instead of special cases, the bridge for the gaps, one conformance kit |
| Brokers differ in subtle ways | Capabilities say what each can do; the conformance kit tests each driver against a real local broker |
| Agents calling destructive tools | Tool annotations, grants per key, governance allow-lists, approvals for destructive tools, audit |
| Tool schemas that don't fit a node's parameters | One tool per operation with only its parameters; generated schemas are tested on every bundled plugin |
| Auto is hard to trust | A reason on every call; pinning is always possible; simulation tests |
| Version skew during rolling deploys | The manifest-hash attribute, `manifest_mismatch` with requeue, then a fresh manifest pull |
| A broker goes down | The breaker sends calls back to direct transports or another broker |

## Decisions to make

1. **Envelope.** Recommended: CloudEvents 1.0 (headers where the broker has them, one JSON document otherwise).
2. **Brokers and their order.** Recommended: tier 1 Kafka, RabbitMQ, NATS (core and JetStream) and Valkey/Redis Streams;
   tier 2 MQTT 5, Amazon SQS, Google Pub/Sub, Azure Service Bus, AMQP 1.0 and Pulsar.
3. **How each language gets them.** Recommended: one TypeScript package for the host and the TS SDK, one Go package for the
   Go SDK and `landflow-bridge`, and Python through the bridge first.
4. **Message body.** Recommended: the HTTP binding's JSON; protobuf only if the phase 7 benchmark shows it's worth it.
5. **Delivery for `Execute`.** Recommended: at most once by default; at least once per node (`idempotent`).
6. **Secrets over brokers.** Recommended: end-to-end encryption and signing, required.
7. **MCP exposure.** Recommended: the gateway lists every plugin automatically, and each plugin also serves its own MCP
   endpoint by default (token required unless it only listens on loopback).
8. **Tool shape.** Recommended: one tool per operation; the alternative is one tool per node with resource and operation
   arguments, which agents use less reliably.
9. **Where the choice is set, and Auto's default.** Recommended: per plugin (Auto, pinned or an allow-list), `balanced` with
   spill-over; per-workflow overrides later.
10. **The pilot.** Recommended: a Twilio node in the messaging plugin, against a fake Twilio server.
