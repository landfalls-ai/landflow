# Plan: one plugin, every transport, and MCP

Status: **built** (planned 2026-10-26, revised the same day: generic brokers, then the bundled MCP gateway; built
in waves T1 to T5 the same day, and the follow-ups in wave T6). Every phase is in: the messaging core and all ten brokers
in TypeScript and Go, the Python native drivers and `landflow-bridge`, Auto, the per-plugin MCP endpoints, identity,
tokens, grants and the catalog, the MCP face in all three SDKs, the bundled gateway, the Twilio pilot, queue mode,
Kubernetes with KEDA, the benchmark, and every bundled plugin on the new SDKs. Wave T6 added approvals for destructive
tools (elicitation or Landflow approvals), `resource_link` files, `list_options` and cached `enum`s on the host,
triggers as MCP resources, the instance server and MCP-trigger workflows behind the gateway, the claim check for
oversized broker bodies, per-workflow transport overrides, a gateway Ingress for Kubernetes, and fixes for Go Kafka's
group mode and MQTT's small-message latency ([Phases](#phases), [roadmap](roadmap.md)). The decisions are settled (2026-10-26): agentgateway is the bundled MCP gateway, and agents
sign in through the instance's identity provider or with Landflow-issued MCP tokens. The rest follow the
recommendations ([last section](#decisions)). Where the code chose a detail this plan left open, the plan now states
the detail; `docs/protocol.md` §14 and §15 are the normative wire description.

## Goal

Today a plugin serves `landflow.plugin/v1` over HTTP and/or gRPC, and the host calls whichever endpoint is preferred.
The goal is to make the way a plugin is reached generic, on both sides:

- **Any transport.** A plugin built with an SDK (TypeScript, Go, Python) can be reached directly (HTTP, gRPC) and through
  any common message broker: Kafka, RabbitMQ, NATS, Valkey/Redis Streams, MQTT, Amazon SQS, Google Pub/Sub, Azure Service
  Bus, AMQP 1.0 brokers and Pulsar. Brokers plug in through one small driver contract, so adding another is a driver,
  not a redesign.
- **Every plugin is also an MCP server.** The SDK exposes the plugin's actions as MCP tools automatically. Landflow ships
  an open-source MCP gateway ([agentgateway](https://github.com/agentgateway/agentgateway)), and every installed plugin
  registers into it on its own, so agents find every plugin's tools (core nodes included) at one URL, with Landflow's
  credentials, permissions and audit. Nothing to write or configure per plugin.
- **The host chooses.** It knows which transports are installed, which of them each plugin is reachable through, and
  routes each call over the one that is currently the most efficient, from live traffic. An admin can pin a transport or
  limit the choice per plugin.

The running example is a Twilio plugin reachable over gRPC, HTTP and the installed broker, and used by agents over MCP.

## What existed before (what this builds on)

| Piece | Where | What it does |
|---|---|---|
| Logical contract | `packages/protocol` (`types.ts`, `plugin.proto`) | `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health`, `WebhookMethod`, `ReceiveWebhook`; JSON bodies over HTTP, `DynamicValue` JSON inside protobuf over gRPC |
| Host clients | `apps/web/src/lib/server/plugins/clients.ts` | `PluginClient` interface; HTTP, gRPC and pooled (per-pod) clients; `transportOf()` reads the URL scheme |
| Endpoint choice | `plugins/registry.ts` `activeEndpoint()` | Several endpoints per plugin; picks the plugin's `preferredTransport` if online, else gRPC, else HTTP. The preference lives in memory only |
| SDK servers | `packages/sdk/src/serve.ts`, `http.ts`, `grpc.ts`, `handlers.ts` (Go and Python alike) | `serve(plugin, { http, grpc })` over shared handlers; announce and heartbeat every 10 s |
| Tools for agents | node descriptors' `usableAsTool`; the AI Agent node; the host's MCP server at `/api/mcp` (builds and runs workflows) and the MCP Server Trigger | Agents inside Landflow already call plugin nodes as tools; outside agents only reach workflows |
| Telemetry | `docs/observability.md` | `plugin.rpc {Method}` spans, `landflow.plugin.rpc.duration`, `landflow.transport` on `node.execute` |
| Idempotency, proofs | `ExecuteRequest.idempotencyKey`; protocol §13 registry proofs | Safe repeats; HMAC over `LANDFLOW_REGISTRY_SECRET` |

The logical RPC was already transport-neutral. What was missing: a binding interface in the SDKs, a generic messaging
layer with broker drivers, an MCP face, and a policy that chooses per call from measurements. The binding interface,
the host's providers, policy and connections, the messaging cores (TypeScript and Go) with the tier 1 drivers, the
host's broker connections, the SDK's messaging and MCP faces and the host's per-plugin MCP endpoints exist now; the
sections below say what each piece is, and the [Phases](#phases) table says what is built.

## The shape: one core, four faces

```
                 Landflow host                                   Agents (Claude Code, Cursor, Landflow agents)
   selector ─┬─ direct ───── HTTP ──────────────┐                      │                    │
             ├─ direct ───── gRPC ──────────────┤                      │ MCP                │ MCP
             └─ messaging ── broker driver ─▶ [ any broker ] ─┐        ▼                    ▼
                                                │             │   MCP gateway (agentgateway) ─▶ host MCP endpoints
                                                │             │                                  (through the selector)
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
- **Host providers** mirror the bindings: direct clients, the same messaging core and drivers, and one MCP endpoint per
  plugin, which the bundled gateway joins into one.

## Concepts

- **Transport kind**: `http`, `grpc` (direct: the host connects to the plugin), or a broker kind (`kafka`, `amqp`,
  `nats`, `jetstream`, `valkey`, `mqtt`, `sqs`, `pubsub`, `servicebus`, `amqp1`, `pulsar`; brokered: both connect out,
  the plugin needs no inbound port). `nats` and `jetstream` are two kinds on one NATS server, because their
  capabilities differ (core: lowest latency, nothing buffered; JetStream: buffered, on disk, redelivered). Both kinds run
  side by side on one server and one prefix: JetStream puts a `js.` token in front of every subject it uses (and names
  its streams `js_<channel>`), so a work-queue stream never captures core NATS requests or announces. When upgrading,
  delete streams that older drivers created (subjects without the `js.` token).
- **Broker connection**: one installed broker on the host side, e.g. `kafka-main`. Set up in Settings → Transports or by
  environment variables; secrets encrypted like credentials.
- **Endpoint**: how one plugin is reached over one transport. Direct endpoints stay URLs (`grpc://10.0.0.5:7204`); brokered
  endpoints are logical, `<kind>://<connectionId>/<pluginId>` (`kafka://kafka-main/twilio`), never with hosts or passwords.
- **Driver**: the broker-specific part (publish, consume, acknowledge, declare, stats), in the host and in each SDK.
- **Transport policy** (per plugin): `auto` (default), `pinned` to one transport, plus an optional allow-list. A workflow
  can override it for its own runs (workflow settings → Transports, `settings.transports` by plugin id): the override's
  mode, pin and objective replace the plugin's, and its allow-list only narrows the plugin's, so an admin keeps every
  workflow off a transport with the plugin's allow-list. A pin the plugin's allow-list leaves out fails the call with the
  reason. Calls outside a run (the Plugins page, the editor's pickers, MCP tool calls) use the plugin's policy.

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
| `type` | `dev.landflow.plugin.v1.<method>.request` and `….<method>.response`, with `<method>` one of `getmanifest`, `execute`, `loadoptions`, `testcredentials`, `health`, `webhookmethod`, `receivewebhook`; plus `dev.landflow.plugin.v1.cancel`, `….announce`, `….withdraw`. A heartbeat is an announce repeated every 10 s (TTL 30 s) |
| `subject` | the node type (`twilio.message`) |
| `time`, `datacontenttype` | `application/json` for a plain body, `application/octet-stream` for an encrypted one; the body is the HTTP binding's JSON |
| `traceparent`, `tracestate` | the CloudEvents distributed tracing extension |
| `lfreplyto` | where to answer, when the broker has no native reply mechanism |
| `lfcorrelation` | on a response or a cancel, the request's `id` |
| `lfdeadline` | epoch ms after which the call must not run |
| `lfattempt`, `lfidempotency`, `lfmanifest` | delivery attempt, `idempotencyKey`, manifest hash |
| `lfdelivery` | the delivery mode the host asks for: `at-most-once` or `at-least-once` |
| `lferror` | on a response, the error code: `manifest_mismatch`, `expired`, `bad_request`, `not_found`, `internal`, `cancelled`, `unavailable` or `too_large`; the body is then `{ "error": "<message>", … }` |
| `lfenc` | `aes-256-gcm` when the body is encrypted (every request and response) |
| `lfkeyid`, `lfsig` | the key id and the signature over the event (below) |

The full attribute rules (lengths, character sets, the two CloudEvents modes and each broker's header prefix) are in
`docs/protocol.md` §14.3; the code is `packages/transports/src/envelope.ts`.

### One core, small drivers

The **messaging core** is written once per language and holds everything Landflow-specific: the envelope, correlation and
replies, deadlines, cancellation, delivery modes, signing and encryption, announcing over the broker, metrics and stats.
A **driver** only knows its broker:

```ts
// @landflow/transports/driver (TypeScript; the Go package mirrors it)
export interface BrokerDriver<C extends BrokerConfig = BrokerConfig> {
  readonly kind: BrokerKind;                               // 'kafka' | 'amqp' | 'nats' | 'valkey' | 'mqtt' | 'sqs' | … | 'memory'
  readonly capabilities: BrokerCapabilities;               // what the core and the selector may rely on
  connect(config: C): Promise<void>;                       // a rejection means nothing was sent anywhere
  declare(channels: ChannelSpec[]): Promise<void>;         // queues, topics, subjects or streams: the broker's own word
  publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome>;   // 'accepted' | 'unroutable'
  consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription>;
  request?(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome>;  // native request/reply:
                                                           // { outcome: 'replied', event } | { outcome: 'unroutable' } | { outcome: 'timeout' }
  stats?(channel: string): Promise<ChannelStats>;          // { depth?, consumers?, lag? }
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
  headers: boolean;                      // string headers per message: CloudEvents binary mode; else structured mode
  maxHeaderBytes?: number;               // a header budget (Azure Service Bus: 64 KiB)
  orderingKeys: boolean;                 // PublishOptions.orderingKey is honoured (record key, ordering key, session id)
  nack: boolean;                         // Delivery.nack({ requeue: true }) puts the event back for another consumer
  attempts: boolean;                     // Delivery.attempt counts redeliveries truthfully
}
```

`publish()` and `request()` throw `NotConnectedError` when the connection is down **before anything was sent**; the
core reports that as provably undelivered (`not_connected`), so the selector may use another transport. Any other
rejection is "maybe sent". `BrokerConfig` carries the host-side `connectionId` and the channel `prefix`; drivers extend
it (`KafkaConfig extends BrokerConfig`). A driver never reads or changes headers or bodies, except to carry them.

**Layout.** One directory per broker kind, `packages/transports/src/drivers/<kind>/`, exported from `package.json` as
`@landflow/transports/<kind>` (`./kafka`, `./amqp`, `./nats`, `./valkey`…). The broker's client library is an
**optional peer dependency** of the package, imported lazily inside the driver module (`await import('amqplib')` in
`connect()`), so the host and the SDK load only the clients they use; the core imports no client library. The
**in-memory driver** (`@landflow/transports/memory`: a `MemoryBroker` shared by several driver instances in one process,
with configurable capabilities) is the reference the conformance suite compares every real driver with, and runs the
core without a broker in tests. The **driver conformance suite** (`@landflow/transports/conformance`,
`runConformance(target)` in a vitest file) checks every driver member and every capability claim, then the core end to
end over the driver (call and reply, deadline, cancel, at most once against at least once, a replica dying mid-call,
discovery with registry proofs, manifest mismatch, tampered and unsigned events, size limits, concurrency, drain).
Each driver ships `<kind>.conformance.test.ts` next to it, gated on an env var (`LANDFLOW_TEST_KAFKA=127.0.0.1:59092`)
and skipping with a message when the broker is not reachable.

**Channels** (`packages/transports/src/channels.ts`; names use a prefix, default `landflow`, set per broker connection,
and the protocol version): a **request channel** per plugin, `landflow.v1.plugin.<pluginId>`, shared by its replicas;
an **instance channel** per plugin process, `landflow.v1.instance.<pluginId>.<instanceId>`, for calls that must reach
one instance; a **reply channel** per host process, `landflow.v1.reply.<hostInstanceId>`, unless the broker replies
natively; a **registry channel**, `landflow.v1.registry`, for announce and withdraw (plugins announce over the broker,
with a registry proof, so the host finds them without a port); a **control channel** per plugin,
`landflow.v1.control.<pluginId>`, for cancel. There is no discover probe: a host that starts after the plugins learns
them from their next heartbeat, within 10 s.

### Brokers

Tier 1 and tier 2 are built in the TypeScript and Go cores (`@landflow/transports/<kind>`, `sdks/go/transport/<kind>`),
wire-compatible with each other; the client libraries are listed [below](#how-each-language-gets-every-broker). Python
has native drivers for tier 1. Every driver passes the same conformance suite (`@landflow/transports/conformance`, above; `conformance.Run(t, target)` in
Go) against a local container (no cloud accounts; cloud services use their official emulators); the brokers run
locally (`deploy/compose.infra.yml`, one profile each). The exact mapping per broker is protocol §14.9.

| Broker | Request channel; replicas share it by | Replies | Holds bursts | Notes |
|---|---|---|---|---|
| **Kafka** (and Redpanda), `kafka` | a topic per plugin; key = execution id. TS: a consumer group (the Confluent JS client has no share consumer), KIP-848 `group.protocol=consumer` by default, `classic` for Kafka < 4.0 and Redpanda. Go: a consumer group by default too (since wave T6), or a Kafka 4.2+ **share group** with `LANDFLOW_KAFKA_MODE=share` (queue-like, per-record acks and delivery counts, `share.auto.offset.reset=earliest`). All replicas of one plugin must use the same mode | a reply topic per host | Yes (the log) | No per-message TTL, so the consumer checks the deadline; records stay on disk for the retention period; higher latency, a natural spill-over target. In group mode a nack and a graceful close re-publish the record with its attempt count, a partition that moves under a running call commits that call so the new owner doesn't run it twice, and a record re-read after a hard crash counts as attempt 1 |
| **RabbitMQ** (AMQP 0-9-1), `amqp` | a quorum queue per plugin; competing consumers | direct reply-to | Yes | `mandatory` returns a call to a missing queue, and a consumer-count check before publishing reports "nobody took it" (`immediate` no longer exists); attempts from `x-delivery-count`; per-message TTL; 16 MiB by default (RabbitMQ 4's default), headers about 120 KiB (`frame_max`) |
| **NATS** core, `nats` | a subject per plugin; a queue group | native inboxes | No | "No responders" tells the host nobody took it; lowest broker latency. A nack re-publishes the event with a `Landflow-Attempt` header, so attempts count while the process lives; a hard kill loses the call |
| **NATS JetStream**, `jetstream` | a work-queue stream per durable request channel (subjects `js.<channel>`, stream `js_<channel>`); a durable pull consumer per group | native inboxes | Yes | Redelivered after a crash (`NumDelivered` is the attempt), kept for `max_age`; `Nats-TTL` is set as a best-effort first filter (1 s granularity, not claimed as TTL) |
| **Valkey / Redis Streams**, `valkey` | a stream per plugin; a consumer group | a reply stream per host | Yes | Reuses queue mode's Valkey; binary mode (entry fields `h:<header>` and `b`), so stream tooling reads the attributes; pending entries are reclaimed with `XAUTOCLAIM` after a crash, attempts from `XPENDING`; 1 MiB cap, lowered to `proto-max-bulk-len` |
| **MQTT 5** (Mosquitto, EMQX, HiveMQ), `mqtt` | a topic per plugin (`.` becomes `/`); a shared subscription (`$share/<group>/…`) at QoS 1 | response topic and correlation data | No (clean sessions) | Edge and IoT networks; user properties carry the attributes bare; message expiry in whole seconds. A publish nobody subscribed to is reported (PUBACK `0x10`). A nack re-publishes with a `landflow-attempt` property, like NATS core |
| **Amazon SQS**, `sqs` | a standard queue per plugin; long polling, with a visibility keep-alive while a call runs | a reply queue per host | Yes | Structured mode only (10 attributes), 1 MiB per message. Broadcast is a queue per consumer with publisher-side fan-out (no SNS). "Nobody took it" is unknown (registry heartbeats only). Refuses to start without an explicit endpoint unless `allowAws` is set |
| **Google Pub/Sub**, `pubsub` | a topic per channel and one shared subscription per plugin, with ordering and a dead-letter policy (so `delivery_attempt` is filled in) | a reply topic and subscription per host | Yes | Ordering keys; 10 MB; per-consumer subscriptions for broadcast; no TTL claimed; "nobody took it" is unknown. The emulator host is required unless `allowCloud` is set |
| **Azure Service Bus**, `servicebus` | a queue per plugin; peek-lock competing receivers | sessions on a session-enabled reply queue; instance channels use sessions too | Yes | 240 KiB by default (a 256 KiB AMQP message on Standard and the emulator) and a 64 KiB header budget. Broadcast is one topic with 16 session-enabled subscriptions, claimed by session lock. TTL per message; no ordering keys; "nobody took it" is unknown. The emulator's entities are declared up front in `deploy/infra/servicebus/Config.json`, written by `deploy/scripts/servicebus-config.py` (the bundled plugins plus any ids you pass; only the per-plugin queues vary); on a real namespace the driver creates missing entities through the administration API (`createEntities`, on by default, needs Manage rights) |
| **AMQP 1.0** (ActiveMQ Artemis, Qpid), `amqp1` | an anycast queue per plugin, created on first attach; competing receivers | a dynamic reply queue per host | Yes | `cloudEvents_` application properties; `ttl` header; `group-id` as the ordering key. A consumer-count check (the management API) infers "nobody took it". A nack is `modified{delivery-failed}`, which counts as an attempt. Also reaches other AMQP 1.0 brokers |
| **Apache Pulsar**, `pulsar` | a topic per plugin; a Shared subscription named after the channel | a reply topic per host | Yes | Non-durable readers for broadcast; 5 MiB; TTL is a namespace policy, so it is not claimed; attempts are `redeliveryCount + 1`. The admin API (`adminUrl`) infers "nobody took it" |

The capabilities drive behaviour: undeliverable detection decides whether a failed publish may move to another transport;
`persistence: 'disk'` makes end-to-end encryption mandatory (Kafka, Streams, SQS and the others keep messages on disk);
`maxMessageBytes` makes the selector skip a broker for a call that is too big.

Differences the core absorbs, so drivers stay small:

- **Correlation**: Kafka, SQS and Pub/Sub have no reply or correlation semantics of their own, so the envelope carries
  them (`lfreplyto`, `lfcorrelation`) and the core runs the reply consumer.
- **Reply lifetime**: RabbitMQ's direct reply-to and NATS inboxes end with the connection, so a reconnect fails the calls in
  flight with "connection lost; it may have run", never a silent wait.
- **"Nobody took it"**: only NATS core (no responders), RabbitMQ (`mandatory` for a missing queue, plus a
  consumer-count check before publishing, since `immediate` no longer exists) and MQTT 5 (a PUBACK that says no
  subscriber matched) say so at once. Elsewhere the host infers
  it from consumer heartbeats on the registry channel and from consumer counts, and otherwise waits for the deadline.
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
  size, depending on the broker). Behind every face the rule is the same in the three SDKs: up to `maxConcurrency` run,
  up to `maxQueue` (default = `maxConcurrency`) wait, and beyond that a call is refused at once (HTTP `429` with
  `Retry-After: 1`, gRPC `RESOURCE_EXHAUSTED`; it never ran, so the host may take it elsewhere); a waiting call whose
  deadline passes fails `deadline_exceeded`. A call that arrives over a broker is never refused: it waits for a slot,
  and the consumer holds at most its prefetch (`maxConcurrency`), so the rest stays in the broker. The bridge
  (`landflow-bridge`) holds a call its plugin refuses at capacity and retries after `Retry-After` until the deadline;
  it never answers `capacity` over a broker.
- **Size**: the encoded event (headers plus body) must fit the driver's `maxMessageBytes` (Azure Service Bus 240 KiB
  by default; Kafka, NATS and SQS about 1 MiB) and its header budget. The host refuses a request that doesn't fit
  **before publishing** (`too_large`, provably undelivered, so the selector may use another transport); a plugin whose
  response doesn't fit answers `lferror: too_large`. With a claim store (an S3-compatible bucket, MinIO in dev) set the
  same on the host, every brokered plugin and landflow-bridge (`LANDFLOW_CLAIM_STORE=s3://<bucket>/<prefix>?endpoint=<url>&forcePathStyle=true`
  with `LANDFLOW_CLAIM_ACCESS_KEY_ID` and `LANDFLOW_CLAIM_SECRET_ACCESS_KEY`), an oversized body goes by reference
  instead (a claim check, protocol §14.6): the store sees only ciphertext, objects go once the event is acknowledged,
  and a sweeper removes orphans after the TTL. An S3 store without an explicit `endpoint` is refused unless the URL says
  `aws=true`. Credentials: the TypeScript store uses the AWS SDK's default chain; the Go and Python stores implement its
  in-cluster part with the standard library, in this order: static keys (`LANDFLOW_CLAIM_ACCESS_KEY_ID` /
  `_SECRET_ACCESS_KEY`, then `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`), web identity (EKS IRSA:
  `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` at STS `AssumeRoleWithWebIdentity`, the token file re-read on each
  refresh), container credentials (EKS Pod Identity, ECS: `AWS_CONTAINER_CREDENTIALS_FULL_URI` / `_RELATIVE_URI`),
  renewed 5 minutes before they expire. They read no `~/.aws` files and ask no EC2 instance metadata; the regional AWS
  STS endpoint is used only with `aws=true`, otherwise `AWS_ENDPOINT_URL_STS` / `AWS_ENDPOINT_URL` must be set.
  `GET /api/transports` and Settings → Transports say whether one is configured. Files already travel as references (§11), so a brokered plugin that handles files uses the shared
  binary store (S3/MinIO) when it can't reach the host.
- **Version skew**: a consumer whose manifest hash differs from `lfmanifest` puts the call back **once** (nack with
  requeue, so a replica on the right version can take it); on the next delivery it acknowledges and answers
  `manifest_mismatch` with its own hash. The host pulls the manifest again and retries. The node never runs on a
  mismatch.

### Security over brokers

An `ExecuteRequest` carries decrypted credentials (Twilio's auth token), and most brokers keep messages on disk.

1. **The whole body of every request and response is encrypted end to end** (AES-256-GCM), not only the credentials:
   they sit in different fields per method (`credentials` in Execute, `data` in TestCredentials) and are easy to miss in
   a new field, and the items themselves hold personal data (an SMS text, a phone number) that shouldn't sit on a
   disk-backed broker either. The attributes stay in clear, so routing, tracing and archiving by metadata keep working;
   announce, withdraw and cancel bodies hold no secrets and stay readable, so broker-side tooling can read the registry
   channel. Keys: one shared secret, `LANDFLOW_TRANSPORT_SECRET` (falling back to `LANDFLOW_REGISTRY_SECRET`), and per
   plugin two 32-byte keys by HKDF-SHA256 with info `"landflow transport v1\n" + pluginId + "\nenc"` and `…"\nsig"`. All
   replicas of a plugin derive the same keys, so work sharing keeps working; whoever reads the broker can't read the
   bodies. The body is `nonce ‖ ciphertext ‖ tag` with additional authenticated data `id + "\n" + type`. Rotation:
   `LANDFLOW_TRANSPORT_SECRET_PREVIOUS` (comma-separated) lists secrets that still verify and decrypt but no longer
   sign; `lfkeyid = hex(SHA-256("landflow transport keyid v1\n" + secret))[0..16]` says which one an event used.
2. **Every event is signed** (`lfsig`, HMAC-SHA256 with the plugin's signing key, encrypt-then-MAC) over the canonical
   attribute lines (`name=value\n`, in a fixed order, never `lfsig`) plus the hash of the on-wire body: nobody else on
   the broker can call a plugin or fake a reply. A receiver refuses unsigned events, unknown key ids, bad signatures,
   clocks more than 5 min off and replayed ids. An announce without a valid registry proof is ignored; a brokered
   endpoint is never used without the secret: **without `LANDFLOW_TRANSPORT_SECRET` the host opens no broker
   connection**, every broker kind and connection reports unhealthy with that message, and Settings → Transports and
   the plugin card say so. The exact forms are in `docs/protocol.md` §14.7; the code is
   `packages/transports/src/security.ts` (`sdks/go/transport/security.go` in Go).
3. **TLS** to the broker is recommended, with a warning for plain connections to a non-loopback host.
4. **Broker permissions**: one broker user per plugin that can read only its own channels, and one host user, with an
   example per broker in `deploy/README.md`.

### How each language gets every broker

Writing every driver three times would not scale. So:

- **TypeScript**: `@landflow/transports` holds the messaging core and every driver; the host and the TypeScript SDK both
  use it. Built: the core (`MessagingClient` on the host side, `MessagingServer` on the plugin side), the envelope,
  security, the in-memory driver, the conformance suite, the tier 1 and tier 2 drivers, the host's `brokers.ts` and the
  SDK's messaging binding.
- **Go**: `sdks/go/transport` holds the core (byte-compatible with the TypeScript one: the TS test vectors pass, and
  Go ↔ TS over NATS runs both ways) and every driver; the Go SDK and `landflow-bridge` both use it. Each driver is a
  **nested Go module** (`sdks/go/transport/<kind>`, with its own `go.mod`), so `sdks/go` stays free of client
  libraries: a plugin adds `require github.com/landflow/landflow/sdks/go/transport/kafka` (plus a `replace` to the
  directory while the repo is unpublished) and either calls `kafka.New(kafka.Config{…})` or blank-imports the package,
  whose `init()` registers the kind (`transport.RegisterDriver`) for use from the environment.
- **Python**: `landflow_sdk.transport` is a native core, byte-compatible with the TypeScript one (the test vectors pass,
  and a TS host calls a Python plugin over all five tier 1 kinds), with drivers for Kafka, RabbitMQ, NATS and JetStream,
  and Valkey, as the extras `landflow-sdk[kafka]`, `[amqp]`, `[nats]`, `[valkey]` and `[brokers]` (all four). Tier 2
  kinds go through `landflow-bridge`: `serve()` starts it as a child for each kind that has a `LANDFLOW_<KIND>_URL` and
  no native driver (`LANDFLOW_BRIDGE_BIN` names the binary, `LANDFLOW_BRIDGE=off` turns it off). Kafka uses a consumer
  group by default (as in TypeScript and Go) and a share group with `LANDFLOW_KAFKA_MODE=share`; all replicas of one
  plugin must use one mode.
- Client libraries: in TypeScript `@confluentinc/kafka-javascript` 1.11 (Confluent's supported client; `kafkajs` has
  had no release since 2023), `amqplib` 2.2, `@nats-io/transport-node` with `@nats-io/jetstream`, `iovalkey`, `mqtt` 5.16,
  `rhea` 3.0, the AWS SDK v3, `@google-cloud/pubsub` 6.3, `pulsar-client` 1.18 (a native addon with prebuilt glibc, musl
  and darwin binaries) and `@azure/service-bus` 7.10; in Go `franz-go`, `amqp091-go`, `nats.go`, `valkey-go`,
  `paho.golang`, Azure's `go-amqp`, `aws-sdk-go-v2`, `pubsub` v2, `pulsar-client-go` and `azservicebus`; in Python
  `confluent-kafka` 2.16, `pika` 1.4 (not `aio-pika`: the SDK is threaded), `nats-py` 2.16 and `valkey` 6.2.
- **`landflow-bridge`** (`services/landflow-bridge`, `deploy/docker/bridge.Dockerfile`): a small Go sidecar (one binary
  and container) that sits next to any plugin that speaks `landflow.plugin/v1` over HTTP or gRPC (built with any SDK,
  or with none) and gives it every broker driver and the MCP face. In Kubernetes it's a sidecar container; locally it's one more process. So every plugin is reachable
  through every transport, whatever it was written in. It answers `GetManifest` itself and reads the manifest again when
  its hash changes or a call answers `manifest_mismatch`.

## MCP: every plugin is also an MCP server

The MCP face and the gateway target the current MCP revision (2026-07-28): stateless requests (no `initialize`, no
session id; clients use `server/discover`), Streamable HTTP and stdio, and OAuth 2.1 with protected resource metadata
for authorization.

### Two ways in

1. **The bundled MCP gateway** (the main path, [below](#the-bundled-mcp-gateway)): one URL, `/mcp` on the gateway,
   lists the tools of every plugin the caller may use, and `/mcp/plugins/<pluginId>` one plugin's. Behind it, the host
   serves one MCP endpoint per plugin, `/api/mcp/plugins/<pluginId>`, which binds credentials, applies grants, records
   the call as an execution and sends it through the normal selector, so agents get the same transports as workflows.
   The in-process core nodes (HTTP Request, Data Table, Code…) are one more endpoint, `core`. Plugins register into the
   gateway on their own as they come and go; a new plugin version changes the tools behind the same endpoint
   (`notifications/tools/list_changed` on the `subscriptions/listen` stream of clients that ask for it; the gateway
   relays an upstream's notification but emits none of its own, so the `core` endpoint emits one after each sync).
2. **The plugin's own MCP endpoint**, added by the SDK with no code: Streamable HTTP at `/mcp` on the plugin's HTTP port,
   and stdio with `--mcp-stdio` (so a desktop agent can start a plugin directly). It's for running a plugin without
   Landflow, or next to an agent on a laptop.

### From node to tool

| Landflow | MCP |
|---|---|
| An action node's operation (resource × operation) | One tool, `<node>_<resource>_<operation>` on the plugin's endpoint, the node segment dropped when the node is named after its plugin (Twilio's `twilio` node: `message_send`; the messaging plugin's `telegram` node: `telegram_message_sendMessage`); through the gateway `<plugin>_<tool>` (`twilio_message_send`), since the gateway prefixes each tool with its plugin. Names are `[A-Za-z0-9_-]`, at most 64 characters, unique per plugin |
| The parameters shown for that operation (`displayOptions`) | `inputSchema` (JSON Schema 2020-12): types, `required`, defaults, descriptions, collections as objects |
| Static options | `enum`, with the option names in the description |
| Dynamic options (`loadOptions`) | A string, with a note that the values come from the connected account. A read-only `list_options` tool (one contract on the plugin's own endpoint and the host's) lists them when a credential is configured or the caller has one; on the host's endpoints `tools/list` also carries an `enum` from a lookup remembered for the caller's credential (`LANDFLOW_MCP_OPTIONS_CACHE_SECONDS`, 300), with `tools/list_changed` when it changes |
| Credentials | Never arguments: bound by the gateway, or by the plugin's local config. The node and credential selectors travel in `_meta["dev.landflow/node"]`, which the server strips from what agents see |
| `idempotent`; get, list, search; delete | `idempotentHint`; `readOnlyHint`; `destructiveHint`; always `openWorldHint`. A node's (or an operation option's) `toolAnnotations` override the derived hints |
| Output items | `structuredContent` (`{ items }`, with `outputSchema` when the node or the operation option declares one) and a short text |
| Files in the output | One `resource_link` per file, its URL signed by the host (no session needed; expires after `LANDFLOW_MCP_FILE_URL_TTL_SECONDS`, 900); small images and audio also inline (`LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES`, 512 KiB, up to 4 per result). `structuredContent` keeps references only |
| A node error | a result with `isError: true` and the message |
| Stop, timeout | the call's `AbortSignal` ↔ the client closing the request's stream (HTTP) or `notifications/cancelled` (stdio) |
| Triggers | Resources, not tools: a plugin's poll and app-webhook triggers are resource templates (`landflow://triggers/<plugin>/trigger_<name>{?parameters}`) for callers whose grant covers `trigger_<name>`; a 2026-07-28 client subscribes on `subscriptions/listen`, Landflow runs the trigger for that caller and sends `notifications/resources/updated` as events arrive, and `resources/read` returns them; it stops with the last stream, the grant, or an idle hour (protocol §15.6) |

Which nodes become tools: the ones marked `usableAsTool` (every action node by the plugin design rules), minus anything
that opts out with `mcp: false`: a node, or a `resource` or `operation` option (a resource with `mcp: false` removes all
its operations). The mapping is one pure function in `@landflow/protocol` (`packages/protocol/src/mcp-tools.ts`:
`mcpToolsFromManifest()`, and `mcpToolsFromDescriptors('core', …)` for the host's core nodes), so a plugin lists the
same tools wherever it is reached; `toolCallToParameters()` is the way back. Protocol §15.1 has the full rules.

### Credentials, permissions and audit

- **Gateway**: agents sign in at the gateway with OAuth, per the MCP authorization spec, and the host learns who calls
  without ever receiving their token ([sign-in and identity](#sign-in-and-identity)). A **tool grant** says which tools
  the caller may call and which credential each one uses, chosen from the project's credentials, so the agent never
  sees a token; its subject is a user, a SCIM group, a project, a role, or one Landflow MCP token. There are no
  implicit grants: owners and admins may browse every tool but call none without a grant. Governance allow-lists
  (instance, project, workflow) apply. Each call is audited (`mcp.tool.call`: caller, tool, outcome, execution id, no
  arguments) and appears as an execution with mode `mcp` (workflow id `mcp_<pluginId>`), so costs, traces and failure
  alerts work as for any run; it runs at most `LANDFLOW_MCP_TOOL_TIMEOUT_SECONDS` (default 120). Credentials come from
  the grant, else from `_meta["dev.landflow/node"].credentials` in the call, else the caller's newest visible
  credential of the type. **Destructive tools wait for a person**: a 2026-07-28 client that declared `elicitation` is
  asked through it (an `input_required` form, its `requestState` signed and bound to the call); any other client gets a
  Landflow approval, answered in Settings → MCP → Approvals (or `POST /api/mcp/approvals/:id`): the call waits
  `LANDFLOW_MCP_APPROVAL_WAIT_SECONDS` (20), then answers where to approve, and the same call runs once after approval
  (within `LANDFLOW_MCP_APPROVAL_TTL_SECONDS`, 600). A grant's `approval` is `always`, `destructive` or `never` (default
  `LANDFLOW_MCP_APPROVAL`, `destructive`); the strictest grant that allows the tool wins, and only the grant's creator
  may turn it down.
- **Plugin's own endpoint**: on by default, but it needs a token (`LANDFLOW_MCP_TOKEN`) unless it listens only on
  loopback; without one on a non-loopback host the face stays off, an error line says so, and the plugin still serves.
  Credentials come from a local file or environment variables (`LANDFLOW_MCP_CREDENTIALS`); tools whose credential
  isn't configured answer with what's missing.
- Landflow's own agents keep calling plugin nodes directly as tools (no MCP hop); the gateway is for agents outside.

## The bundled MCP gateway

Landflow comes with an MCP gateway, and every installed plugin registers into it automatically. Rather than build the
gateway, Landflow bundles an open-source one and builds only what's specific to Landflow. Research on 2026-10-26 covered
about 25 projects (the gateways, their docs, releases and licenses, and the MCP registry and discovery standards). The
phase 0 spike ran agentgateway 1.6.0 locally and verified the config API, the identity headers, sign-in through Keycloak
and the file fallback: [mcp-gateway.md](mcp-gateway.md) has the exact payloads, timings and gaps, and this section
follows its findings.

### Why agentgateway

| Candidate | License, backing | Adding servers at runtime | Agent sign-in (MCP OAuth) | Per-tool rules | MCP 2026-07-28 | Verdict |
|---|---|---|---|---|---|---|
| **agentgateway** 1.6 | Apache-2.0; Linux Foundation (Agentic AI Foundation), from Solo.io; Rust, one binary | Config API, a hot-reloaded file, or Kubernetes (xDS) | Yes: a resource server with protected resource metadata; any JWKS issuer; presets for Keycloak, Okta, Entra, Auth0, Authentik, Descope | CEL rules, which also hide tools from `tools/list` | Yes, the default; older revisions are negotiated | **Chosen** |
| IBM ContextForge 1.1 | Apache-2.0; IBM; Python, needs Postgres and Redis | REST (`POST /gateways`), a catalog file | Only per virtual server | Roles, teams and virtual servers; plugins for finer rules | Negotiated since 1.1 | Runner-up: a second control plane with its own users, teams and credentials, which Landflow already has |
| ToolHive | Apache-2.0; Stacklok | A Kubernetes operator; its aggregator reads the server list at start | Yes | Cedar | Not stated | Kubernetes-first; adding a server needs a restart today |
| LiteLLM | MIT plus a commercial `enterprise/` folder | REST and UI, in Postgres | JWT/OIDC sign-in is Enterprise | Per key and team | Not stated | Open core where we need it |
| Obot | MIT, but a license key caps Community at 100 users | UI, Git catalogs | A full OAuth server | Yes | Not stated | License-gated |
| Microsoft mcp-gateway | MIT | Deploys images on Kubernetes | Entra ID only | App roles | Only that revision | Azure-bound, Kubernetes-only |
| Docker MCP Gateway | MIT; every release a pre-release | CLI profiles, no API | A shared static token | Allow-lists | Not stated | A workstation tool; rejects private upstream URLs by default |

Also looked at: Kong and Traefik (their MCP features are enterprise-only), Agent Router (formerly Envoy AI Gateway; full
MCP features only on Kubernetes with Envoy Gateway), Higress, APISIX, Pomerium (sign-in and per-tool rules, but no
aggregation), MetaMCP and Lasso (no release in 2026), MCPJungle, 1MCP, Unla, Kuadrant and plain MCP proxies.

agentgateway does every job at the edge: one URL, MCP sign-in, joining many servers into one with prefixed tool names,
version negotiation, per-tool rules, rate limits and OpenTelemetry. It needs no database (SQLite or Postgres are optional),
and it's a small Rust binary (tens of MB of memory), under a vendor-neutral foundation with releases every few weeks.
Landflow keeps what it already owns: users, grants, credentials and the plugin registry.

### How a call flows

```
agent (Claude Code, Cursor…)
   │  MCP 2026-07-28, OAuth bearer token
   ▼
agentgateway   /mcp  (one URL for every plugin)  ·  /mcp/plugins/<id>  (one plugin)
   │  sign-in (protected resource metadata, JWKS) · CEL rules · rate limits · OpenTelemetry · tool prefixes
   │  sends the gateway secret and the caller's identity, never the caller's token
   ▼
host   /api/mcp/plugins/<id>  (one MCP server per plugin)
   │  tools from the manifest · grants · bound credential · approvals · audit · an execution with mode mcp
   ▼
selector ─▶ HTTP, gRPC or any broker ─▶ the plugin
```

- The gateway joins the per-plugin endpoints into one: `tools/list` on `/mcp` returns every plugin's tools, each prefixed
  with its plugin (`prefixMode: always`, so names don't change when a second plugin arrives), and a call goes to that
  plugin's endpoint. `failureMode: failOpen`, so one failing plugin doesn't hide the others.
- Each plugin also gets a URL of its own on the gateway, `/mcp/plugins/<name>`, for agents that should see only one. It
  is not a target but an agentgateway `traffic.routes` entry with an inline MCP backend, so it needs its own
  `mcpAuthentication` (`LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` merges a JSON object into every route's policies).
- `<name>`, the target name that prefixes the plugin's tools, is the plugin id when the id fits agentgateway's rules
  (`[a-z0-9.-]`, at most 63 characters; every bundled plugin does). Any other id becomes a lowercase slug plus six hex
  digits of its FNV-1a hash (`My_Plugin` → `my-plugin-<hash>`), so names are predictable and never collide
  (`gatewayTargetName()` and `gatewayToolName()` in `@landflow/protocol`).
- The gateway doesn't cache lists (its rules make them differ per caller); the host's endpoints answer lists with
  `cacheScope: private`, since grants filter them.

### Automatic registration

The host's `McpGatewaySync` watches the plugin registry and keeps the gateway's targets equal to the plugins that are
online, exposed to agents and have at least one tool. It reacts to every registry change, and reconciles every 30 s too.

| Event | In the gateway |
|---|---|
| A plugin announces itself, is installed from the marketplace, or is discovered in Kubernetes | Its target is added; agents see it on their next `tools/list`; the `core` endpoint emits `tools/list_changed` for subscribers after each sync (the gateway relays upstream notifications but emits none when its own target set changes) |
| A new version with other nodes | The target stays (same URL); the host's endpoint lists the new tools and sends "tool list changed", which the gateway relays |
| Offline for 60 s | The target is removed, and added back when the plugin returns |
| Uninstalled, removed, or "Expose to agents" turned off | The target is removed |
| The gateway restarts, or someone edits it | The next reconcile puts Landflow's targets back |

- **How it writes**: through agentgateway's config API, `PUT /api/config/resources/mcp.target` (a list, upsert) and
  `DELETE …/mcp.target/{id}` on the admin port; **the target id is its name**, so a second PUT with the same name is an
  update. The target points at the host through `LANDFLOW_MCP_GATEWAY_HOST_URL` (the sidecar's own view of the host). A change is on the traffic path within milliseconds. That port has no authentication and listens only on
  loopback, so the gateway runs next to each main as a sidecar and the main calls it on `127.0.0.1`. Storage is
  agentgateway's `hybrid` mode: the base config is a read-only file, the targets live in SQLite inside the sidecar and
  are rebuilt from the registry when the sidecar restarts.
- **No leader needed**: each main keeps its own sidecar in step. In queue mode every main already sees every plugin
  through the shared registry, so all sidecars end up with the same targets.
- **Token purge**: the same tick deletes revoked and expired MCP tokens 30 days after they died (at most hourly).
- **Only its own targets**: Landflow keeps the ids of the targets it created and changes only those, so servers an admin
  adds in agentgateway's UI stay.
- **Fallback**: for a gateway that runs on its own, Landflow writes the targets into a YAML file that agentgateway
  reloads when it changes (a volume in Compose, a ConfigMap in Kubernetes; about 0.2 s). In file mode `GET` lists
  nothing, so the sync treats the file as write-only and re-renders every target on each change. The phase 0 spike
  tried both with real targets and chose the config API as the primary adapter.

One target, as the sync writes it (the shape the spike verified against 1.6.0):

```json
{ "resources": [ { "value": {
  "name": "twilio",
  "mcp": { "host": "http://127.0.0.1:3000/api/mcp/plugins/twilio" },
  "policies": {
    "backendAuth": { "key": { "value": "<the gateway secret>", "location": { "header": { "name": "x-landflow-gateway" } } } },
    "transformations": { "request": {
      "set": {
        "x-landflow-caller-iss": "jwt.iss",
        "x-landflow-caller-sub": "jwt.sub",
        "x-landflow-caller-jti": "jwt.jti"
      },
      "remove": ["authorization"]
    } }
  }
} } ] }
```

### Standard descriptions

Every plugin is described once in the MCP ecosystem's own formats. The agentgateway target is generated from that
description, so another gateway would only need another generator.

- **`server.json`** (the MCP Registry schema, `2025-12-11`) per plugin: `name` `<namespace>/<pluginId>` (namespace
  `LANDFLOW_MCP_NAMESPACE`, default `local.landflow`), `version` = the plugin's version, `remotes[]` = its gateway URL
  and its direct endpoint on the host (Streamable HTTP), and Landflow hints (plugin id, transports, health) under
  `_meta["dev.landflow/plugin"]`.
- **A private MCP Registry API**, read-only, at `/api/mcp/registry/v0.1/servers` (also `/{name}/versions` and
  `/{name}/versions/{version|latest}`; cursor pagination; status `active`, `deprecated` or `deleted` as plugins come
  and go, kept in `mcp_catalog_servers`). Tools that read registries can then find Landflow's plugins: GitHub Copilot's
  organisation registry setting, Obot, MLflow and Docker's `catalog import`. Open to signed-in users and Landflow tokens
  only.
- **Server Cards** (SEP-2127): per plugin at `/api/mcp/plugins/<id>/server-card`, and for the instance at
  `/.well-known/mcp/server-card.json`, for clients that look before connecting. The gateway proxies
  `/mcp/plugins/<name>/server-card` to the plugin's, with the client's own bearer.

### Sign-in and identity

- **Agents sign in at the gateway with OAuth 2.1**, per the MCP authorization spec: agentgateway's `mcpAuthentication`
  serves protected resource metadata (`/.well-known/oauth-protected-resource/mcp`), answers 401 with `WWW-Authenticate`,
  and checks each token's signature (JWKS), issuer and audience (the gateway's URL).
- **The authorization server is the instance's identity provider**, the one Landflow's SSO sign-in already uses:
  Keycloak in the dev stack, or Okta, Entra, Auth0 and others through agentgateway's provider presets.
- **Without an identity provider**, Landflow issues MCP tokens itself: ES256 JWTs, created in Settings → MCP like API
  keys (shown once, with an expiry and a last-used time; issue and revoke at `/api/mcp/tokens`), with keys at
  `/api/mcp/jwks` and audiences `<instance>/api/mcp` and `<gateway>/mcp`. The gateway validates them the same way.
  Revoking one takes effect on the next call, because the host checks the token id (`jti`).
- **To the host**, the gateway never forwards the caller's token (the MCP spec forbids passing tokens through). It sends
  the gateway secret (`backendAuth`) and the caller's issuer, subject and token id, set from the validated token (a CEL
  `transformations` rule, `x-landflow-caller-iss`, `-sub` and `-jti`, which also overwrites any such headers a client
  sent). The host's MCP endpoints accept a call with that secret; directly with a Bearer token (a Landflow MCP token, an
  identity provider's access token checked against its discovery document and JWKS with an audience the host accepts
  or `LANDFLOW_MCP_IDP_AUDIENCE`, or a Landflow API key); or from a signed-in session, for the tool browser. Anything
  else is `401` pointing at the protected resource metadata (RFC 9728, `/.well-known/oauth-protected-resource/api/mcp…`).
  They map issuer and subject to a Landflow user through the SSO link; an unknown caller gets no tools.

### Who may call what

- **Landflow decides per tool**: the grants (which tools a user, group or project may call, and which credential each
  uses), the governance allow-lists, and approvals for destructive tools. The host checks them on every call and filters
  every list.
- **The gateway adds instance-wide rules** an admin writes once in CEL, which also hide the tools they deny. For example,
  agents only for one group, and Twilio only for support:

  ```yaml
  mcpAuthorization:
    rules:
    - '"landflow-agents" in jwt.groups && (mcp.tool.target != "twilio" || "support" in jwt.groups)'
  ```
- **Rate limits per caller** (`localRateLimit` keyed by `jwt.sub`), on top of Landflow's node rate limits.

### Deployment

- **Image** `cr.agentgateway.dev/agentgateway:v1.6.0`, pinned by digest (distroless: no shell, so no Docker
  healthcheck; readiness on port 15021, metrics on 15020, inside the network only). The base config is
  `deploy/mcp-gateway/config.yaml`: the listener, `mcpAuthentication`, the rules, `prefixMode: always`,
  `failureMode: failOpen`, `statefulMode: stateless`, and tracing to the OTLP collector under
  `frontendPolicies.tracing` (`config.tracing` is deprecated in 1.6). The targets come from the host.
- **Compose** (`deploy/compose.yml`): a `mcp-gateway` service with `network_mode: service:web`, so it shares the web
  container's loopback. It's published on `127.0.0.1:54000` (`LANDFLOW_MCP_GATEWAY_PORT`). In queue mode there's one
  sidecar per main (`mcp-gateway-1`, `-2`), and the load balancer sends `/mcp` (and the protected resource metadata) to
  port 4000 of the main it picks. The protocol is stateless, so any main's gateway can serve any request. The sidecar
  configs carry no sign-in: add `mcp.policies.mcpAuthentication` for the instance's identity provider.
- **Kubernetes**: a second container in the host Deployment (`deploy/k8s/base/host`), an `mcp` port (4000) on the host
  Service. From outside the cluster: the `gateway-ingress` component (a standard Ingress: `/` to the web app, `/mcp` and
  `/.well-known/oauth-protected-resource` to the sidecar) or `gateway-httproute` (Gateway API), with the streaming
  settings (no buffering, long timeouts) for Traefik, ingress-nginx, F5 NGINX, HAProxy and Envoy Gateway. ingress-nginx
  was retired in March 2026; Traefik serves both forms, or Envoy Gateway for Gateway API. `gateway-landflow-tokens` makes
  the sidecar accept Landflow-issued MCP tokens (the base config has no sign-in). Checked on OrbStack: the pod is 2/2
  ready, the sync registers core and every plugin (`in-step`), the gateway end-to-end checks pass through the Service's
  port 4000 (17 of 17), and through Traefik 3.7 with both forms (`overlays/orbstack-ingress`, `orbstack-gateway-api`)
  an anonymous session sees no tools, a bad token gets 401 and a granted Landflow token lists and calls tools.
- **Dev** (`pnpm dev`, host outside Docker): the `mcp-gateway` profile in `deploy/compose.infra.yml` (built): MCP on
  `127.0.0.1:54000`, the admin API and UI on `127.0.0.1:55000` only (`LANDFLOW_MCP_GATEWAY_ADMIN_URL`), targets pointing
  at `host.docker.internal:3000`, a one-shot `mcp-gateway-init` that gives the SQLite volume to the image's uid.
  `deploy/scripts/mcp-gateway-spike.mjs` reruns the phase 0 checks against it. The base config has no sign-in;
  `mcp-gateway/compose.tokens.yml` adds Landflow-token sign-in (with `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` for the
  per-plugin routes), so an agent connected with a token from Settings → MCP gets its grants
  ([mcp-gateway.md](mcp-gateway.md#sign-in-with-landflow-mcp-tokens-dev)).
- **Settings**: `LANDFLOW_MCP_GATEWAY` (`bundled` by default, `file` for a gateway that runs on its own, or `off`),
  `LANDFLOW_MCP_GATEWAY_SECRET`, `LANDFLOW_MCP_GATEWAY_PUBLIC_URL`, `LANDFLOW_MCP_GATEWAY_HOST_URL`,
  `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES`.
- **Telemetry**: the gateway's spans join the host's traces (W3C trace context in headers and `_meta`), its Prometheus
  metrics (`agentgateway_requests_total{protocol="mcp"}`, `agentgateway_request_duration_seconds`…) sit next to
  Landflow's, and its access log carries the MCP method (`mcp.method.name`), the target (`mcp.target`), the tool
  (`gen_ai.tool.name`) and the caller.

### What Landflow builds, and what it reuses

| From agentgateway | Built in Landflow |
|---|---|
| One URL for every plugin, prefixed tool names, per-plugin URLs | The per-plugin MCP endpoints: tools from manifests, grants, bound credentials, approvals, audit, executions |
| MCP OAuth (resource server), JWKS validation, identity provider presets | The identity mapping to Landflow users, and Landflow-issued MCP tokens |
| Version negotiation (2026-07-28 and older clients) | `server.json`, the registry API and Server Cards |
| CEL rules, rate limits, OpenTelemetry, access logs | `McpGatewaySync` and its agentgateway adapter (config API, or the file) |
| Its admin UI with a tool playground (for admins, on the dev port or by port-forward) | Settings → MCP (built): the gateway card and connect snippets, tokens, grants, the tool browser; "Expose to agents" on each plugin card. Gateway status (targets in step, last error) comes with the sync |

The same sync registers Landflow's other MCP servers (built in wave T6): the instance server (when Settings → MCP has it
on) as `landflow-mcp` at `/mcp/landflow`, and each published workflow's enabled MCP Server Trigger as `wf-<path>` at
`/mcp/workflows/<name>`, removed when they go, so every MCP server in Landflow sits behind one URL. A signed-in gateway
caller runs as that Landflow user under their project access; an anonymous one meets the trigger's own authentication. External servers
that an admin adds get routes of their own: agentgateway does no MCP version translation (it forwards `server/discover`
and the client's protocol version to every target as is), so one older server in the shared endpoint would break
2026-07-28 clients for every plugin. The host's endpoints therefore speak 2026-07-28 natively, and external servers
keep their own routes.

### Swapping the gateway

```ts
// apps/web/src/lib/server/mcp/gateway-sync.ts
interface McpGatewayAdapter {
  readonly kind: string;                              // 'agentgateway' | 'file' | 'contextforge' …
  list(): Promise<GatewayTarget[]>;                   // the targets Landflow created
  upsert(target: GatewayTarget): Promise<void>;       // generated from the plugin's server.json
  remove(name: string): Promise<void>;
  health(): Promise<{ ok: boolean; version?: string }>;
}
```

ContextForge is the documented alternative (`POST`, `PUT` and `DELETE /gateways`) if agentgateway stops fitting.
Gateways that read registries can use the registry API directly.

## Host side

Module `apps/web/src/lib/server/transports/` (built, except where marked):

| File | Role |
|---|---|
| `provider.ts` | `TransportProvider` per kind (`kind`, `label`, `direct`, `capabilities`, `createClient`, `health`, `test`) and the `TransportProviderRegistry` (`transportProviders`). `http` and `grpc` register at start; a broker kind without a driver is "known but not installed": Settings → Transports lists it, connections can be saved, Test answers "No driver for <kind> yet" |
| `direct.ts` | Today's HTTP, gRPC and pooled clients behind the provider interface, unchanged in behaviour; `DIRECT_PREFERENCE = ['grpc', 'http']` |
| `policy-store.ts` | `TransportPolicyStore` (`transportPolicies`): the per-plugin policy `{ mode: 'auto' \| 'pinned', pinned?, allowed?, objective }` in `plugin_transport_policies` (migration 1700), shared by mains and workers (cache dropped on the replication broadcast). It replaces the in-memory `preferredTransport`: choosing "gRPC" on the Plugins page is now `{ mode: 'pinned', pinned: 'grpc' }` |
| `selector.ts` | `select(pluginId, candidates, policy, context, inputs)` → `{ endpoint, kind, reason }` or `{ error }`; replaces `activeEndpoint()`. `CallContext` carries `method`, `mode` (`manual` \| `production` \| `mcp`), `items`, `payloadBytes`, `idempotent`, `executionId`; `SelectorInputs` is where the phase 5 measurements plug in (every input optional) |
| `connections.ts` | `TransportConnections` (`transportConnections`): broker connections in `transport_connections` (migration 1701), secret fields sealed with the credential vault's key and only opened for the provider (the API sees which are set, never their values); `test(id)` asks the provider for a round trip; `LANDFLOW_TRANSPORT_<KIND>_URL` adds a read-only `env-<kind>` connection without a row. Changes are audited as `settings.update` on the `transports` target |
| `schema.ts`, `view.ts` | The zod bodies of the connection routes (shared with the OpenAPI document) and what the API shows: kinds, connections, the plugins whose brokered endpoints name each connection |
| `brokers.ts` | `BrokerConnectionManager` (`brokerConnections`): one `MessagingClient` per enabled broker connection in every main and worker (each process has its own `hostInstanceId` and reply channel), reopened when the connection is edited, closed when it is disabled or deleted; discovery from the registry channel into `registry.addEndpoint('<kind>://<conn>/<plugin>', 'broker')`; queue stats every 5 s (depth, consumers, lag) and the announced `maxConcurrency` as selector inputs; connection health (`connecting`, `connected`, `reconnecting`, `error`; a round trip every 30 s) shown in `GET /api/transports` and Settings → Transports. Without `LANDFLOW_TRANSPORT_SECRET` nothing opens and every broker kind says why |
| `broker-provider.ts` | One `TransportProvider` per broker kind with a driver module (`registerBrokerProviders()`); `BrokerPluginClient`, the `PluginClient` for a brokered endpoint: every method is one `MessagingClient.call()` with the deadline, the abort signal, the trace context, the idempotency key, the manifest hash and the delivery mode (`at-least-once` only for an `Execute` of an idempotent node or operation), with the OpenTelemetry messaging attributes on the `plugin.rpc` span. A call that provably wasn't delivered fails over once to another online endpoint (`auto.failover`); a pinned policy has nowhere to go |
| `../mcp/plugin-servers.ts`, `server.ts`, `exposure.ts` | The per-plugin MCP endpoints (`/api/mcp/plugins/<id>`, `core` too): tools from the manifests, grants, `mcp` executions through the selector, `tools/list_changed`; both protocol eras; "Expose to agents" (`plugin_mcp_exposure`) |
| `../mcp/identity.ts`, `tokens.ts`, `grants.ts` | The gateway secret and the caller's identity, Landflow-issued MCP tokens and their keys (`mcp_tokens`), grants (`mcp_grants`) |
| `../mcp/registry.ts` | `server.json` per plugin, the registry API and Server Cards (`mcp_catalog_servers`) |
| `../mcp/gateway-sync.ts` | `McpGatewaySync` and the gateway adapters (agentgateway's config API, the file): targets, per-plugin routes, the Server Card proxy, token purge |

Routes (built): `PATCH /api/plugins/:id` with `{ policy }` (the old `{ preferredTransport }` still works and becomes a
pinned policy), audited as `plugin.transport` with the mode, pinned kind, allow-list and objective; `GET /api/transports`
(kinds and connections, with the plugins on each); `GET`/`POST /api/transports/connections`, `GET`/`PATCH`/`DELETE
/api/transports/connections/:id` and `POST /api/transports/connections/:id/test` (a body tests the form's values before
they are saved); reads need `workflows:read`, writes the admin action `settings:manage`. **Settings → Transports**
(`/settings#transports`) lists the kinds and connections and edits them; the **Plugins page** shows each plugin's
transports, the choice the next call would take and why (`choice` / `choiceError` on the plugin summary), and the
**policy picker** on the plugin card. Every `plugin.rpc` span carries `landflow.transport` and
`landflow.transport.reason` (`lib/server/telemetry/rpc.ts`). `GET /api/transports` also carries each connection's
health, and the plugin card shows a brokered endpoint's queue numbers (depth, consumers, lag, instances × their
`maxConcurrency`, sampled every 5 s). MCP routes (built): `/api/mcp/plugins/:id` and `/api/mcp/plugins/:id/server-card`,
`/api/mcp/tools`, `/api/mcp/grants` (`/:id`), `/api/mcp/tokens` (`/:id`), `/api/mcp/jwks`, `/api/mcp/status`,
`/api/mcp/registry/v0.1/servers…`, `/.well-known/mcp/server-card.json` and the protected resource metadata under
`/.well-known/oauth-protected-resource/api/mcp…`; `PATCH /api/plugins/:id { mcp: { exposed } }`. **Settings → MCP** has
the gateway card and connect snippets, tokens, grants and the tool browser; the plugin card has "Expose to agents" and
the plugin's tools; `GET /api/mcp/gateway` and `POST /api/mcp/gateway/sync` are the sync's status and resync. Workers in queue mode open the
broker connections too (built).

**Queue mode.** Every main and every worker opens the instance's enabled broker connections. They are saved in the
shared database, so a connection added, edited, disabled or deleted through any main reaches every other process through
the replication broadcast, with no restart. A worker keeps its own `hostInstanceId` and reply channel, discovers plugins
over the brokers, and chooses a transport per call with Auto, so a plugin announced only on a broker, with no HTTP or gRPC
endpoint, runs in the workers. `LANDFLOW_TRANSPORT_SECRET` must be set on every process (`deploy/compose.queue.yml` sets
one for dev). Workers don't run the MCP gateway sync; each main's sidecar does. Checked on the local queue stack with
NATS: a TMP connection opened in all four processes within a second, the workers called a broker-only Text Toolkit over
NATS, and disabling the connection closed it in all four.

**Kubernetes.** `deploy/k8s/components/{kafka,rabbitmq,nats}` and Valkey (all four together as `brokers`) run the tier 1
brokers in the namespace, and `broker-transports` points the host (`LANDFLOW_TRANSPORT_<KIND>_URL`,
`LANDFLOW_TRANSPORT_SECRET`) and the plugins (`LANDFLOW_TRANSPORTS`, `LANDFLOW_<KIND>_URL`, `LANDFLOW_TRANSPORT_SECRET`,
`LANDFLOW_MAX_CONCURRENCY`) at them through a ConfigMap and a Secret; `overlays/orbstack-brokers` does both. Without them
the base manifests change nothing. NATS is wired as the `jetstream` kind, because it buffers and KEDA can read it. A
broker-only plugin lists no `http` or `grpc` face and needs no Service. Checked on OrbStack: Text Toolkit consumed from
all four brokers, the host discovered it over AMQP, JetStream and Valkey, and workflow calls pinned to each of the three
went where they were pinned, 5 of 5.

**Autoscaling with KEDA** uses the backlog of the plugin's request channel (`landflow.v1.plugin.<pluginId>`), which is the
signal a brokered plugin has. The scalers are Kafka `kafka` (consumer group lag), RabbitMQ `rabbitmq` (`QueueLength` of
the quorum queue), NATS JetStream `nats-jetstream` (consumer pending) and Valkey `redis-streams` (pending entries and lag),
with one `ScaledObject` each in `deploy/k8s/examples/keda/`. Set the per-replica target to `maxConcurrency`. Each replica
adds `floor(maxConcurrency × share)` to the spill-over threshold, and the replicas the scaler adds are what drain the
spilled backlog. Cap replicas at the partition count for Kafka. KEDA's Kafka scaler can't see a share group, so keep the
default group mode there. Scale to zero only a broker-only plugin: a plugin that is also served over HTTP or gRPC is found through
its Service, and with zero pods its calls would go nowhere. Checked on OrbStack with KEDA 2.21.0: about 230 pending
messages took a Text Toolkit Deployment from 1 to 5 replicas in about 15 s, then to 6, and back to 1 once the backlog
drained and the 30 s window passed. KEDA was uninstalled afterwards.

## SDK side

```ts
// packages/sdk (binding.ts): a binding is one face of the plugin
export interface TransportBinding {
  readonly kind: string;                                  // 'http' | 'grpc' | 'mcp' | a broker kind; one binding per kind
  start(context: BindingContext): Promise<BindingInfo>;   // listen or connect; resolves with the endpoints to announce, if any
  stop(): Promise<void>;                                  // stop taking calls, drain in-flight ones (dispatcher.drain()), close
}
// BindingContext: plugin, manifest (hints filled in), dispatcher, telemetry, logger, advertiseHost, hints, announce(), withdraw()

import { kafka } from '@landflow/transports/kafka';
import { nats } from '@landflow/transports/nats';

await serve(twilio, {
  http: 7104,                                 // also serves /mcp unless LANDFLOW_MCP=off
  grpc: 7204,
  host: '127.0.0.1',                          // loopback: the MCP face then needs no token
  bindings: [myBinding],                      // any TransportBinding
  maxConcurrency: 16,                         // calls running node code at once, across every face
  brokers: [kafka({ brokers: ['127.0.0.1:59092'] }), nats({ servers: 'nats://127.0.0.1:54222' })],   // BrokerTargets
  mcp: { token: process.env.LANDFLOW_MCP_TOKEN },                                                      // or false
});
```

`brokers` takes `BrokerTarget`s from the driver modules' helpers (`kafka({ brokers })`, `amqp({ url })`,
`nats({ servers })`, `jetstream({ servers })`, `valkey({ url })`), which `serve()` wraps in the messaging binding
(`messaging.ts`). A brokered endpoint is announced over the broker's registry channel, with a registry proof, not in
the HTTP announce: the host names its own connections.

- **Dispatcher** (`dispatcher.ts`): the one entry point every face calls (`execute`, `loadOptions`, `testCredentials`,
  `webhookMethod`, `webhook`, `health`), with the deadline, the `AbortSignal`, the spans and the concurrency limit. HTTP
  and gRPC are bindings behind it (`http.ts`, `grpc.ts`); the HTTP binding reads the call's deadline from the
  `x-landflow-deadline` header (epoch ms) and a closed connection cancels the call. `serve()` announces the kinds that
  started as the manifest's `transports` hint (`mcp` included when the face is on) and the limit as `maxConcurrency`.
  The limit behaves the same in the three SDKs: up to `maxConcurrency` run, up to `maxQueue` (default =
  `maxConcurrency`) wait, beyond that a call is refused at once (HTTP `429` + `Retry-After: 1`, gRPC
  `RESOURCE_EXHAUSTED`); a call that arrives over a broker waits for a slot instead (`DispatchCall.wait` in TypeScript,
  `CallOptions.Wait` in Go, `wait=True` in Python), so the messaging server holds at most its prefetch; a waiting call
  whose deadline passes fails `deadline_exceeded`.
- Environment instead of code: `LANDFLOW_TRANSPORTS=http,grpc,kafka,nats` (which faces start; default: every face
  given), `LANDFLOW_MAX_CONCURRENCY`, `LANDFLOW_<KIND>_URL` with `LANDFLOW_<KIND>_USERNAME`, `_PASSWORD`, `_TLS` and
  `_PREFIX` (the channel prefix; the driver module for the kind loads only then, and the connection is `env-<kind>`, the
  id the host gives `LANDFLOW_TRANSPORT_<KIND>_URL`), `LANDFLOW_TRANSPORT_SECRET`, `LANDFLOW_MCP` (`on`, `off`,
  `stdio`), `LANDFLOW_MCP_TOKEN`, `LANDFLOW_MCP_CREDENTIALS`, and the `--mcp-stdio` flag.
- **MCP face** (all three SDKs; TypeScript shown): Streamable HTTP at `/mcp` on the HTTP port, both protocol eras
  (`@modelcontextprotocol/server` 2.4.0's `createMcpHandler`: 2026-07-28 natively, 2025-era clients statelessly over
  SSE), or stdio. Without `LANDFLOW_MCP_TOKEN` on a non-loopback host the face stays off and an error line says so; the
  plugin still serves its other faces. `LANDFLOW_TRANSPORTS` selects every face, the MCP face included, so a list
  without `mcp` turns it off. In dev the bundled plugins listen on loopback and serve `/mcp` with no token. In containers
  the face is off (`LANDFLOW_MCP=off`): agents reach a plugin through the host's endpoints and the gateway.
- Go: `landflow.Serve(ctx, p, landflow.WithHTTP(7104), landflow.WithGRPC(7204), landflow.WithBinding(b),
  landflow.WithBroker(kafka.New(kafka.Config{Brokers: …})), landflow.WithMaxConcurrency(16), landflow.WithMaxQueue(16),
  landflow.WithTransports("http", "grpc", "kafka"))`; the `Binding` interface (`Kind`, `Start`, `Stop`) and the
  dispatcher mirror the TypeScript ones. Drivers are nested modules (`sdks/go/transport/<kind>`; `require` + `replace`)
  so a plugin pulls only what it uses; a blank import registers the kind (`init()`) for `LANDFLOW_<KIND>_URL`, with
  `LANDFLOW_<KIND>_USERNAME`, `_PASSWORD`, `_TLS`, `_PREFIX` (default `LANDFLOW_TRANSPORT_PREFIX`) and
  `LANDFLOW_<KIND>_<FIELD>` for driver-specific fields (`LANDFLOW_KAFKA_MODE`, `_PARTITIONS`, `LANDFLOW_AMQP_QUEUE_TYPE`,
  `LANDFLOW_JETSTREAM_ACKWAITMS`…). A deadline that passes inside the Go dispatcher answers `expired`. Python:
  `serve(plugin, http=…, grpc=…, bindings=[…], transports=[…], max_concurrency=…, max_queue=…)` with the same `Binding`
  protocol, plus the bridge for brokers. All three read `LANDFLOW_TRANSPORTS` and `LANDFLOW_MAX_CONCURRENCY`.
- The MCP face uses the official MCP SDK of each language: `@modelcontextprotocol/server` 2.4.0 (the v2 packages) in
  TypeScript, `github.com/modelcontextprotocol/go-sdk` v1.8.0 in Go (`landflow.WithMCP` / `WithoutMCP`, `sdks/go/mcpface`)
  and `mcp` 2.3.0 in Python (`serve(plugin, mcp=…)`, the optional `mcp` extra); all built. The conformance kit runs over
  every face of the Go SDK (HTTP, gRPC, memory messaging, MCP) and the Python SDK (HTTP, gRPC, MCP). The host's MCP
  code (the instance server, the trigger, the per-plugin endpoints, the MCP Client node) is on the v2 packages too
  (server and client 2.4.0; `@modelcontextprotocol/sdk` 1.x is gone).
- Server spans keep `plugin.execute …`; brokered calls add the OpenTelemetry messaging attributes
  (`messaging.system`, `messaging.destination.name`, `messaging.operation.type`); MCP calls add `mcp.tool.name`.
- **The bundled plugins** are all on these SDKs (built). Each takes broker faces from `LANDFLOW_TRANSPORTS` and
  `LANDFLOW_<KIND>_URL`. The TS images carry `@landflow/transports` and all eleven client libraries. The Go images link
  the tier 1 drivers; linking all ten would add another 17 MB and the cloud SDKs, so tier 2 goes through
  `landflow-bridge`. The Python images install the `brokers` extra and carry the bridge. Each plugin sets a
  `maxConcurrency` default with its reason in code:
  - Twilio's API concurrency: 16.
  - CPU-bound string work: 8.
  - One per core: `NumCPU`, `cpu_count()`.
  - Google's per-user quotas: 10.
  - The database pool: 10.
  - The productivity APIs' rate limits: 8.

  Each also marks every read and pure operation `idempotent`; sends, writes and deletes stay at most once.
- **Conformance kit** (`packages/protocol/conformance/`, `@landflow/protocol/conformance`): request fixtures and
  expected replies (deadlines, cancellation, errors, size limits, delivery modes, MCP tool listing and calls), run by
  every SDK × face. Drivers have their own suite, `@landflow/transports/conformance` (above).

## Protocol changes (additive, still `landflow.plugin/v1`; all in)

1. Endpoint schemes `<kind>://<connectionId>/<pluginId>` for brokers (`parseEndpoint()`, `formatEndpoint()`,
   `transportKindOf()` in `@landflow/protocol`); older hosts never see them (they're announced over the broker).
2. Manifest hints: `transports: string[]` (faces the plugin was built with) and `maxConcurrency` (default assumed 16,
   `DEFAULT_MAX_CONCURRENCY`); gRPC fields 5 and 6 of `GetManifestResponse`.
3. Node descriptor: `idempotent?: boolean` (per node or `operation` option), `mcp?: false` (per node, `resource` or
   `operation` option), `outputSchema?` (for MCP structured output), and `toolAnnotations?` to override the derived ones.
4. New protocol sections: §14 "Messaging" (envelope, channels, delivery rules, security, one subsection per broker) and
   §15 "MCP" (tool mapping, the per-plugin endpoints, gateway registration and identity, grants).
5. The engine's `Transport` type is `'in-process' | TransportKind`, an open string, so spans and metrics carry any kind.

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
3. **Bursts spill over instead of flipping**: production calls fill the direct transport up to `floor(maxConcurrency ×
   share)` calls in flight, the share being 0.8 for `balanced`, 1.0 for `latency` and 0.6 for `throughput`, and the rest
   go to a buffering broker (Kafka, RabbitMQ, JetStream, Streams, SQS…), which holds them. Below the threshold the direct
   kinds come first: a broker is for bursts and failures, not a faster path.
4. **No flapping**: the main transport changes only when another is at least 20 % better for three 10 s windows in a row,
   then stays at least 60 s. The windows compare the `Health` probe round trip (the same ping on every transport) plus
   queueing and errors, not `Execute` times, and the main stays a direct kind while the plugin has one. Near-equal kinds
   keep the static order (gRPC, then HTTP): a kind must also be at least 2 ms faster to count as better, so two
   transports a few milliseconds apart don't trade places on noise. A policy change resets the main kind, and the next
   window chooses afresh.
5. **Fresh numbers without risk**: a `Health` ping every 15 s per transport; `Execute` is never a probe.
6. **Circuit breaker** per endpoint: open after 5 failures in a row, or more than half of the last 20 once at least 10
   outcomes are in; half-open after 15 s, which lets one trial (a probe or a real call) through.
7. **A call moves to another transport only when it provably wasn't delivered** (connection refused, DNS, gRPC
   `UNAVAILABLE` before sending, a broker that reported it unroutable or that nobody took it). Otherwise the error
   surfaces, so nothing runs twice.
8. **Objective** per plugin: `balanced` (default), `latency` or `throughput`.
9. **Capacity**: an endpoint that refuses a call for lack of room (HTTP `429` with `Retry-After`, gRPC
   `RESOURCE_EXHAUSTED`, `lferror: capacity`) never ran it, so the call moves once to another endpoint
   (`auto.failover`), and the refused endpoint is held for the `Retry-After` (1 s when there is none) and counts as full
   for spill-over.

Without measurements (a new plugin, or an endpoint with no samples yet) the selector falls back to the static rules:
`pinned` → the pinned kind; the allow-list filters; `only` when one kind is left; otherwise gRPC, then HTTP, then a
broker by its latency prior, as `auto.latency`. The scoring, spill-over, breaker, hysteresis and probes are built
(`apps/web/src/lib/server/transports/auto.ts`, `selector.ts`, `breaker.ts`, `stats.ts`).

**Explainability**: every `plugin.rpc` span carries `landflow.transport` and `landflow.transport.reason` (`pinned`,
`only`, `auto.latency`, `auto.spillover`, `auto.failover`, `auto.breaker`, `auto.size`); metrics
`landflow.transport.calls`, `landflow.transport.switches`, `landflow.transport.queue_depth`; the feed event
`plugin.transport` says why, e.g. "Twilio now spills over to Kafka: gRPC at 14 of 16 calls, p95 2.1 s".

## Walk-through: Twilio

1. **A broker is installed**, say Kafka (in dev, `deploy/compose.infra.yml` has one profile per broker: `--profile
   kafka`, port 59092). The admin adds it in Settings → Transports (or sets `LANDFLOW_TRANSPORT_KAFKA_URL`), and Test
   says it's connected.
2. **The plugin starts** with `LANDFLOW_TRANSPORTS=http,grpc,kafka`. The Plugins page shows Twilio over gRPC, HTTP and
   Kafka, on Auto, and lists its MCP tools (`twilio_message_send`, `twilio_message_list`…). It's in the MCP gateway
   already: nobody registered it. On the gateway's shared `/mcp` the tools carry the plugin's target name as a prefix
   (`messaging_twilio_message_send`); the plugin's own endpoint and the host's per-plugin endpoint use the bare names.
3. **An editor test run** goes over gRPC (`auto.latency`).
4. **A 5,000-row campaign** fills gRPC to its limit; the rest spills over to Kafka (`auto.spillover`), keyed by execution,
   and the consumer group keeps each replica under Twilio's API limits. "Send SMS" isn't idempotent, so it's at most once.
5. **gRPC fails**: the breaker opens and everything goes through Kafka (`auto.breaker`), then comes back after recovery.
6. **An agent sends an SMS**: Claude Code connects to the gateway (`http://localhost:54000/mcp` in dev), gets a 401 that
   points at Keycloak, and the user signs in. Their grant allows `twilio_message_send` with the "Twilio prod" credential.
   The call shows in Executions with mode `mcp`, traced from the gateway down to the plugin and audited; the agent never
   sees the Twilio token, and the host never sees the agent's.
7. **Without Landflow**: a developer runs the plugin with `--mcp-stdio` and a local credentials file, and adds it to
   their agent as an MCP server.
8. **Another network**: a Twilio plugin the host can't reach is pinned to the broker and works anyway.

The pilot is built: a Twilio node in the TypeScript messaging plugin (SMS, MMS, WhatsApp, calls, list and get messages;
Account SID with auth token or API key, tested with `GET /2010-04-01/Accounts/{sid}.json`), with a fake Twilio server
(`plugins/messaging/test/fake-twilio.ts`, `--delay-ms` to slow it down). `maxConcurrency` defaults to 16, Twilio's API
concurrency per account. The walk-through ran on the local stack against the fake: an editor run over gRPC, a burst that
spilled from gRPC to Kafka with every SMS sent exactly once, the plugin pinned to Kafka, an MCP call (an `mcp` execution)
and `--mcp-stdio`.

## Phases

Each phase ends with every test suite passing, a clean type check and a check in Chrome, like the roadmap's waves.

| Phase | Work | Done when | Size | Status |
|---|---|---|---|---|
| 0. Spec | §14 Messaging and §15 MCP written; every broker and agentgateway in `compose.infra.yml` (one profile each, 5xxxx ports); a spike that registers a target over agentgateway's config API and checks "tool list changed" and the identity headers | Spec reviewed; every broker and the gateway start locally; the spike passes, or the file fallback is chosen | S | ✅ Done: all ten brokers and the gateway run locally (`deploy/README.md`, "Message brokers and the MCP gateway"; `deploy/scripts/brokers-smoke.sh`); the spike chose the config API ([mcp-gateway.md](mcp-gateway.md)) |
| 1. Abstraction | SDK `TransportBinding` (TS, Go, Python) with HTTP and gRPC behind it; host providers; the open `Transport` type; the per-plugin policy in the database with its picker; the conformance kit | Every existing test passes, behaviour unchanged; the policy survives restarts and is the same on every process | M | ✅ Done: bindings and dispatchers in the three SDKs, `maxConcurrency` and the hints; host providers, policy store, selector, connections, `GET /api/transports`, the connections API, Settings → Transports, the policy picker |
| 2. Messaging in TypeScript | `@landflow/transports`: the core and tier 1 drivers (Kafka, RabbitMQ, NATS, Valkey Streams); host connections, discovery, Settings → Transports; the TS SDK binding; encryption and signing | A workflow runs through Text Toolkit over each tier 1 broker with one joined trace; a plugin with no open port works; broker restarts and a plugin killed mid-call behave as specified | L | ✅ Done: the core, envelope, encryption and signing, the in-memory driver and the conformance suite; the `kafka`, `amqp`, `nats`, `jetstream` and `valkey` drivers (live conformance against the local brokers); the host's `brokers.ts` and `broker-provider.ts` (connections, discovery, stats, health, fail-over once); the TS SDK's `brokers` option and `LANDFLOW_<KIND>_URL` |
| 3. MCP endpoints | The SDK MCP face (TS, Go, Python); the host's per-plugin MCP endpoints with grants, audit, `mcp` executions and the tool browser | A client lists and calls a plugin's tools on its host endpoint with a bound credential; a plugin runs standalone over stdio | L | ✅ Done: the SDK's `/mcp` and stdio face (TypeScript; Go and Python since wave T3); `/api/mcp/plugins/<id>` and `core` speaking both protocol eras; `mcp` executions, audit, `tools/list_changed`, "Expose to agents", `GET /api/mcp/tools`; the host's MCP code on SDK v2. Since wave T6: `resource_link` and inline media for files, approvals for destructive tools (elicitation or Landflow approvals), `list_options` and cached `enum`s on the host. |
| 3b. Bundled MCP gateway | agentgateway in Compose, queue mode and Kubernetes; `McpGatewaySync` and its adapters; `server.json`, the registry API and Server Cards; sign-in through the identity provider, Landflow-issued tokens, the identity mapping; Settings → MCP gateway status | An outside agent signs in through Keycloak and calls every plugin's tools at one URL; a plugin installed while it's connected shows up without a restart and disappears when removed; a forged identity header is refused | M | ✅ Done: `McpGatewaySync` and its adapters (the config API, the file) with per-plugin routes, target names and the Server Card proxy; offline plugins removed after 60 s; token purge; the `x-landflow-caller-jti` transformation; the sidecar in Compose, queue mode and Kubernetes (with an Ingress or Gateway API route since wave T6); identity, grants, tokens, `server.json`, the registry API, Server Cards and Settings → MCP |
| 4. Go and the bridge | `sdks/go/transport` (core and tier 1 drivers) and `landflow-bridge` | Conformance passes for TS and Go natively and for Python through the bridge, on every tier 1 broker | L | ✅ Done: the Go core (byte-compatible with TS), the in-memory driver, `conformance.Run`, `WithBroker` and the tier 1 drivers as nested modules; `landflow-bridge` (`services/landflow-bridge`), which Python's `serve()` starts for kinds it has no native driver for. The Go and Python MCP faces are next |
| 5. Auto | Stats, scoring, spill-over, hysteresis, breaker, probes; the Plugins page numbers, reasons and feed events | Simulations with fake clients and a fake clock: low traffic stays direct, bursts spill over, oversized calls skip small-message brokers, failover and recovery, no flapping | L | ✅ Done: the measurements, scoring, spill-over, hysteresis, breaker, probes and the capacity rule (`auto.ts`, `selector.ts`, `breaker.ts`, `stats.ts`); reasons, `plugin.transport` feed events and the `landflow.transport.*` metrics; simulations with fake clients and a fake clock |
| 6. Tier 2 brokers | MQTT 5, SQS, Pub/Sub, Azure Service Bus, AMQP 1.0, Pulsar: a TS driver (host) and a Go driver (Go SDK and bridge) each, tested against local containers and emulators (Mosquitto, LocalStack, the Pub/Sub emulator, the Service Bus emulator with its SQL Server container, `apache/artemis`, Pulsar standalone) | Conformance passes for each; tests set limits explicitly, since emulators differ from the services (the Pub/Sub emulator never expires messages) | M each | ✅ Done for all six, in TypeScript and Go: conformance 37/37 and the cross-language check pass against the local containers and emulators |
| 7. Twilio pilot, queue mode, Kubernetes | The Twilio node and fake; workers with broker connections; broker manifests and KEDA docs; `deploy/scripts/transport-bench.py` comparing every installed transport | The walk-through works end to end on the local stack and on OrbStack's cluster | M | ✅ Done: the Twilio node and fake, and the walk-through on the local stack (spill-over from gRPC to Kafka with every SMS sent once, pinned Kafka, MCP, stdio); queue-mode workers on brokers, checked on the local queue stack over NATS; the broker components, `broker-transports` and KEDA examples, with Text Toolkit called over AMQP, JetStream and Valkey on OrbStack's cluster and KEDA scaling it from 1 to 6 replicas and back; `deploy/scripts/transport-bench.py` (below) |
| 8. Python native drivers | Tier 1 drivers in the Python SDK | Conformance passes without the bridge | M | ✅ Done: `landflow_sdk.transport`, byte-compatible with the TS core, with the Kafka, RabbitMQ, NATS/JetStream and Valkey drivers (the extras `[kafka]`, `[amqp]`, `[nats]`, `[valkey]`, `[brokers]`); a TS host calls a Python plugin over all five tier 1 kinds |

After phase 1, phases 2 and 3 can run in parallel; 3b follows 3; 4 and 5 follow 2.

**Benchmark.** `deploy/scripts/transport-bench.py` starts a one-node echo plugin (`plugins/transport-bench`) with a face for
every transport. It pins the plugin to each kind in turn and times webhook calls end to end at 100 B and 256 KiB, one at a
time and with 8 callers, then subtracts a workflow that uses only core nodes. Read the results as relative: they come
from single-container emulators on one busy machine. On the local stack, for 100 B and over that baseline:

- gRPC adds 0.3 ms, NATS 1.2, JetStream 2.3, HTTP 2.7, Valkey 2.9 and RabbitMQ 3.5.
- Kafka adds 6.5 ms, AMQP 1.0 7.7 and SQS 10.9.
- Pub/Sub adds about 94 ms.
- MQTT added 45 ms at 100 B (5.6 ms at 256 KiB): Mosquitto's `TCP_NODELAY` was off, so Nagle met the client's delayed ACK on
  every small publish. With `set_tcp_nodelay true` (`deploy/infra/mosquitto/mosquitto.conf`; any MQTT broker you run
  should have it) it adds 1.4 ms at 100 B and 4.2 ms at 256 KiB (wave T6). The TS driver also sets `TCP_NODELAY` on its socket.

At 256 KiB the direct kinds and the fast brokers add 4–9 ms. Every call succeeded. Measured later (wave T6, against the same
kind of baseline): Pulsar adds about 12 ms at 100 B and 10 ms at 256 KiB. Service Bus over its emulator adds about 45 ms
(two peek-locked hops, each a SQL write in the emulator) and, with 8 callers, does 20 calls/s at 100 B with no errors. The
emulator throttles its whole namespace (error 50002, "wait 10 seconds") above roughly 100 small operations a second or 4 to
5 messages of 64 KiB a second, which used to stall every caller for 7–12 s. On the emulator only, the drivers now pace
themselves (`maxOpsPerSecond`, default 40: 25 ms plus 2 ms per KiB per publish or settlement), retry a throttled operation
for about 11 s, and name the cause in the error. Large messages stay throughput-bound there: at 64 KiB a call takes about
300 ms one at a time and 8 callers get about 1 call/s, without errors. That is the emulator (Microsoft lists it for
sequential testing), not Service Bus; a real namespace is not paced. Its 256 KiB size is above the driver's 240 KiB cap.

## Risks

| Risk | Answer |
|---|---|
| A repeated side effect (an SMS sent twice) | At most once by default; at least once only for idempotent nodes or with an idempotency key; a call moves only when it provably wasn't delivered |
| Secrets in brokers that keep messages on disk | End-to-end encryption and signing are required; TLS; one broker user per plugin |
| Too many drivers × languages to maintain | One core per language, small drivers, capabilities instead of special cases, the bridge for the gaps, one conformance kit |
| Brokers differ in subtle ways | Capabilities say what each can do; the conformance kit tests each driver against a real local broker |
| Agents calling destructive tools | Tool annotations, grants per user, group or project, gateway rules, governance allow-lists, approvals for destructive tools, audit |
| Tool schemas that don't fit a node's parameters | One tool per operation with only its parameters; generated schemas are tested on every bundled plugin |
| Auto is hard to trust | A reason on every call; pinning is always possible; simulation tests |
| Version skew during rolling deploys | The manifest-hash attribute, `manifest_mismatch` with requeue, then a fresh manifest pull |
| A broker goes down | The breaker sends calls back to direct transports or another broker |
| agentgateway's admin API has no authentication | It only listens on loopback, inside the sidecar; nothing else can reach it |
| The config API for MCP targets is barely documented | The phase 0 spike verified it against 1.6.0 (exact payloads in [mcp-gateway.md](mcp-gateway.md)); the hot-reloaded file is the fallback, and it is documented |
| Forged caller identity | The host trusts the identity headers only with the gateway secret; the gateway overwrites them on every call |
| The gateway project changes direction | Apache-2.0 under a foundation; the adapter interface and `server.json` keep a swap (ContextForge) small |
| An older MCP server lowers the shared endpoint's version | Landflow's endpoints all speak 2026-07-28; external servers get routes of their own |

## Decisions

Settled on 2026-10-26. You confirmed 11 and 12; the others went with the recommendation, as the plan proposed.

1. **Envelope.** Decided: CloudEvents 1.0 (headers where the broker has them, one JSON document otherwise).
2. **Brokers and their order.** Decided: tier 1 Kafka, RabbitMQ, NATS (core and JetStream) and Valkey/Redis Streams;
   tier 2 MQTT 5, Amazon SQS, Google Pub/Sub, Azure Service Bus, AMQP 1.0 and Pulsar.
3. **How each language gets them.** Decided: one TypeScript package for the host and the TS SDK, one Go package for the
   Go SDK and `landflow-bridge`, and Python through the bridge first.
4. **Message body.** Decided: the HTTP binding's JSON; protobuf only if the phase 7 benchmark shows it's worth it.
5. **Delivery for `Execute`.** Decided: at most once by default; at least once per node (`idempotent`).
6. **Secrets over brokers.** Decided: end-to-end encryption and signing, required.
7. **MCP exposure.** Decided: every plugin is in the gateway automatically ("Expose to agents" on by default), and
   each plugin also serves its own MCP endpoint by default (token required unless it only listens on loopback).
8. **Tool shape.** Decided: one tool per operation; the alternative was one tool per node with resource and operation
   arguments, which agents use less reliably.
9. **Where the choice is set, and Auto's default.** Decided: per plugin (Auto, pinned or an allow-list), `balanced` with
   spill-over; a workflow may override it for its runs (built in wave T6), within the plugin's allow-list.
10. **The pilot.** Decided: a Twilio node in the messaging plugin, against a fake Twilio server.
11. **The MCP gateway** (you confirmed it). Decided: agentgateway, as a sidecar of each main, kept in step through its config API. The
    alternative was IBM ContextForge, which brings a richer registry and admin UI but also its own users, teams,
    credentials, Postgres and Redis.
12. **Who signs agents in** (you confirmed it). Decided: the instance's identity provider through the gateway (Keycloak in dev), plus
    Landflow-issued MCP tokens when there's no identity provider. The alternative was Landflow as a full OAuth
    authorization server, which is much more to build.
