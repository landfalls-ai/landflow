# Plan: pluggable transports between the host and plugins

Status: **planned** (2026-10-26). Nothing here is built yet. Decisions that need a yes are in the last section.

## Goal

Today a plugin serves `landflow.plugin/v1` over HTTP and/or gRPC, and the host calls whichever endpoint is preferred.
The goal is a **transport layer** on both sides:

- The SDKs (TypeScript, Go, Python) serve a plugin over any set of transports: HTTP and gRPC as today, plus message
  brokers such as RabbitMQ, through one binding interface that third parties can implement too.
- The host knows which transports are **installed** (HTTP and gRPC always; RabbitMQ once a broker connection is set up),
  and which of them each plugin is reachable through.
- Per plugin, an admin can pin a transport, limit the choice, or leave it on **Auto**: the host measures each
  transport's traffic (latency, errors, saturation, queue depth) and routes each call over the one that is currently
  the most efficient, spilling bursts over to a queue instead of overloading a direct connection.

The running example is a **Twilio** plugin reachable over gRPC, HTTP and RabbitMQ.

## What exists today (what this builds on)

| Piece | Where | What it does |
|---|---|---|
| Logical contract | `packages/protocol` (`types.ts`, `plugin.proto`) | `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health`, `WebhookMethod`, `ReceiveWebhook`; JSON bodies for HTTP, `DynamicValue` JSON inside protobuf for gRPC |
| Host clients | `apps/web/src/lib/server/plugins/clients.ts` | `PluginClient` interface; `HttpPluginClient`, `GrpcPluginClient`, `PooledPluginClient` (calls spread over Kubernetes pods); `transportOf()` reads the URL scheme |
| Endpoint choice | `plugins/registry.ts` `activeEndpoint()` | A plugin can have several endpoints; the registry picks the plugin's `preferredTransport` if online, else gRPC, else HTTP. The preference is set by `PATCH /api/plugins/:id` and lives in memory only |
| SDK servers | `packages/sdk/src/serve.ts`, `http.ts`, `grpc.ts`, `handlers.ts` (and the Go and Python equivalents) | `serve(plugin, { http, grpc })` starts both bindings over shared handlers, announces each endpoint, heartbeats every 10 s |
| Telemetry | `docs/observability.md` | `plugin.rpc {Method}` client spans, `landflow.plugin.rpc.duration{landflow.plugin.id, rpc.system, rpc.method, landflow.outcome}`, `landflow.transport` on `node.execute` |
| Idempotency | `ExecuteRequest.idempotencyKey` | Lets a repeated step avoid repeating side effects |
| Registry proof | protocol §13 | HMAC over `LANDFLOW_REGISTRY_SECRET`, proven on `GetManifest` |

So the logical RPC is already transport-neutral. What's missing is (1) a binding interface in the SDKs instead of two
hard-wired servers, (2) host transports beyond URL schemes, (3) brokers, and (4) a policy that chooses per call from
measurements.

## Concepts

- **Transport kind**: `http`, `grpc` (direct: the host connects to the plugin's address) and `amqp` (brokered: both
  connect out to RabbitMQ; the plugin needs no inbound port). Later `nats` and `valkey`.
- **Broker connection**: one installed broker on the host side, e.g. `rabbitmq-main` = `amqps://…/landflow`. Set up in
  Settings → Transports or by environment variables; its URL and password are encrypted like credentials.
- **Endpoint**: how one plugin is reached over one transport. Direct endpoints stay URLs (`grpc://10.0.0.5:7204`).
  Brokered endpoints are logical, `amqp://<connectionId>/<pluginId>` (e.g. `amqp://rabbitmq-main/twilio`), and never
  contain broker hosts or passwords.
- **Binding** (SDK side): serves the plugin over one kind. **Provider** (host side): calls plugins over one kind and,
  for brokers, discovers plugins on it.
- **Transport policy** (per plugin): `auto` (default), `pinned` to one kind, plus an optional allow-list.

A transport is offered for a plugin only when both sides have it: the host has the provider (and, for brokers, a healthy
connection) **and** the plugin has a live endpoint on it. That intersection is what the Plugins page lists.

## Protocol changes (additive, still `landflow.plugin/v1`)

1. **Endpoint schemes**: `amqp://<connectionId>/<pluginId>` joins `http(s)://` and `grpc://`. Older hosts never see it
   (it is only announced over the broker).
2. **Manifest**: an optional `transports: string[]` (the kinds the plugin was built with, e.g. `["http","grpc","amqp"]`)
   and an optional `maxConcurrency` (calls one instance runs at once), used by the selector. Both are hints.
3. **Node descriptor**: an optional `idempotent: boolean` (default false). It allows at-least-once delivery over a broker
   (below). The Twilio "Send SMS" node is *not* idempotent; "List messages" is.
4. **New section §14, "Message transports"**, with the AMQP binding below. `docs/protocol.md` §2's endpoint table gets
   a third binding row.
5. The engine's `Transport` type widens from `'in-process' | 'http' | 'grpc'` to an open string union, so spans and
   metrics carry `amqp`.

### AMQP binding (RabbitMQ, AMQP 0-9-1)

Names use a prefix (default `landflow`, `LANDFLOW_AMQP_PREFIX`) and the protocol version, so several installs share a vhost.

| Object | Name | Notes |
|---|---|---|
| RPC exchange | `landflow.v1.rpc` (direct) | Routing key = plugin id |
| Plugin queue | `landflow.v1.plugin.<pluginId>` | Durable classic queue; every replica of the plugin consumes it (competing consumers spread the load) |
| Instance queue | `landflow.v1.plugin.<pluginId>.<instanceId>` | Exclusive, auto-delete; for calls that must reach one instance (manifest pull with a proof, per-instance health) |
| Registry exchange | `landflow.v1.registry` (topic) | Plugins publish `announce.<pluginId>` / `withdraw.<pluginId>` every 10 s with the `AnnounceRequest` body and a registry proof; the host consumes it with an exclusive queue |
| Control exchange | `landflow.v1.control` (topic) | `cancel.<pluginId>` with a call id, so the instance running it aborts (stopped executions) |
| Replies | RabbitMQ direct reply-to (`amq.rabbitmq.reply-to`) | No reply queues to declare; a reply to a closed channel is lost, and the call fails as "connection lost; it may have run" |

Requests: body = the HTTP binding's JSON (`application/json`); `type` = method (`Execute`…); `correlation_id` = call id;
`expiration` = time left until the deadline; transient delivery mode. Headers: `traceparent`/`tracestate`,
`landflow-protocol`, `landflow-deadline` (epoch ms), `landflow-manifest-hash`, `landflow-attempt`, `idempotency-key`,
`landflow-signature` and `landflow-key-id`. Replies: same correlation id, `type` = `<Method>Response` or `Error` with
`{ code, message }` (`bad_request`, `not_found`, `internal`, `deadline_exceeded`, `cancelled`, `overloaded`,
`manifest_mismatch`). A node failure is still a normal `ExecuteResponse` with `error`, as on HTTP.

Delivery rules:

- The host publishes with **publisher confirms** and **`mandatory`**. A message no queue takes comes back
  (`basic.return`), so "the plugin isn't on this broker right now" is known for sure. That is the only case where a
  call moves to another transport without risk.
- **At most once by default**: the plugin acks an `Execute` when it starts it, so a crash mid-call never runs it twice
  (an SMS isn't sent twice). The host's deadline then fails the node with "the plugin went away; the call may have run",
  and the node's own retry settings decide what happens next.
- **At least once** for `idempotent` nodes, and for calls with an `idempotencyKey` when the node opts in: the ack comes
  after the reply is published, so another replica picks the call up if an instance dies. `LoadOptions`,
  `TestCredentials` and `Health` always use this mode.
- **Deadlines**: RabbitMQ drops an expired message only when it reaches the head of the queue, so the consumer checks
  `landflow-deadline` too and answers `deadline_exceeded` without running the call.
- **Concurrency**: `prefetch` = the instance's concurrency (`LANDFLOW_AMQP_PREFETCH`, default 8). The queue absorbs bursts;
  adding replicas adds consumers.
- **Size**: at most `LANDFLOW_AMQP_MAX_MESSAGE_BYTES` (default 8 MB). Binary data already travels as references
  (§11), so a brokered plugin that handles files needs the shared binary store (S3/MinIO) when it can't reach the host.
- **Version skew** (rolling deploys): a consumer whose manifest hash differs from the header answers `manifest_mismatch`
  with `requeue`, and the host pulls the manifest again.

### Security over a broker

An `ExecuteRequest` carries decrypted credentials (Twilio's auth token). In a broker they sit in queues, can be paged to
disk and can be read from the management UI. So, for brokered transports:

1. **The credentials are encrypted end to end** with AES-256-GCM under a per-plugin key,
   `HKDF(LANDFLOW_TRANSPORT_SECRET or LANDFLOW_REGISTRY_SECRET, "landflow transport v1" ‖ pluginId)`. Every replica of a
   plugin derives the same key, so competing consumers keep working. Someone who can read the queue can't read the secrets.
2. **Every request and reply is signed** (HMAC with the same key family): a rogue publisher can't invoke a plugin, and a
   rogue consumer can't forge replies. A brokered announce without a valid registry proof is ignored. A brokered
   endpoint is never used without the secret.
3. **TLS** (`amqps://`) is recommended. Settings warns about plain `amqp://` to a non-loopback host.
4. **Broker permissions** are documented with a `definitions.json` example: one user per plugin that can read only its own
   queues and publish only to the registry exchange and to replies, and one host user.

## SDK side

One interface per SDK; HTTP and gRPC move behind it with no change in behaviour.

```ts
// packages/sdk: a binding serves the plugin over one transport
export interface TransportBinding {
  readonly kind: string;                                    // 'http' | 'grpc' | 'amqp' | …
  start(context: BindingContext): Promise<BindingInfo>;     // listen or connect; returns the endpoint to announce, if any
  stop(): Promise<void>;                                    // drain in-flight calls, then close
}
export interface BindingInfo { endpoint?: string; announcesItself?: boolean }   // brokers announce over the broker
export interface BindingContext { plugin: IPlugin; dispatch: Dispatcher; telemetry: Telemetry; instanceId: string }
// Dispatcher = today's handlers.ts (spans, metrics, redaction), with an AbortSignal and a deadline per call.

await serve(plugin, { http: 7104, grpc: 7204, transports: [amqp({ url: process.env.LANDFLOW_AMQP_URL })] });
```

- Environment: `LANDFLOW_TRANSPORTS=http,grpc,amqp` (default: the ports given), `LANDFLOW_AMQP_URL`, `LANDFLOW_AMQP_PREFETCH`,
  `LANDFLOW_AMQP_PREFIX`, `LANDFLOW_TRANSPORT_SECRET`.
- Go: `landflow.Serve(p, landflow.WithHTTP(7104), landflow.WithGRPC(7204), landflow.WithTransport(amqp.New(url)))`, with
  the AMQP binding in its own package (`sdks/go/transport/amqp`, `github.com/rabbitmq/amqp091-go`) so plugins that don't
  use it don't pull the dependency.
- Python: `serve(plugin, http=7104, grpc=7204, transports=[AmqpTransport(url)])`, behind an extra
  (`landflow-sdk[amqp]`, `aio-pika`).
- TypeScript: `amqplib`, loaded only when the binding is used (like `./grpc` today).
- Server spans keep `plugin.execute …`; brokered calls add `messaging.system=rabbitmq`,
  `messaging.destination.name` and `messaging.operation.type=process`. Metrics gain `landflow.transport`.
- **Conformance kit** (`packages/protocol/conformance/`): request fixtures and expected replies, including deadlines,
  cancellation, errors and size limits. Every SDK × binding pair runs it in its tests.

## Host side

New module `apps/web/src/lib/server/transports/`:

| File | Role |
|---|---|
| `provider.ts` | `TransportProvider { kind, label, direct, createClient(endpoint), start?(registry), health() }` and the provider registry |
| `direct.ts` | Wraps today's HTTP, gRPC and pooled clients (no behaviour change) |
| `connections.ts` | Broker connections: a table (migration in the 1700s), encrypted URL and password, **Test**, health (connected, server version, cluster name, round-trip time), config from env too (`LANDFLOW_TRANSPORT_AMQP_URL`, …) |
| `amqp/` | Connection and channel management (reconnect with backoff, topology, confirms), `AmqpPluginClient implements PluginClient` (correlation map, deadlines, cancel), discovery from the registry exchange into `registry.addEndpoint('amqp://<conn>/<plugin>', 'broker')`, queue depth and consumer counts every 5 s (passive declare, no management plugin needed) |
| `stats.ts` | Rolling stats per plugin × endpoint (below) |
| `selector.ts` | The policy engine (below); replaces `activeEndpoint()` in the registry |
| `policy-store.ts` | Per-plugin policy in the database (today's in-memory `preferredTransport` becomes `{ mode, pinned?, allowed?, objective }`), shared by mains and workers through the existing database change feed |

Also:

- `PATCH /api/plugins/:id` takes the new policy (the old `preferredTransport` body still works). New routes:
  `GET /api/transports` (kinds, connections, health) and `/api/transports/connections` (CRUD plus test), admin-only.
- **Settings → Transports**: installed kinds, broker connections (add, test, status, which plugins are on each).
- **Plugins page**: per plugin, each transport it's reachable through with live numbers (p50 and p95, error rate, in
  flight, queue depth), the current choice and why, a policy picker (Auto, pinned to one, allowed kinds), and a feed
  event when the choice changes.
- **Queue mode**: workers run nodes, so they open the broker connections too (from the database config) and make their
  own choices. Each process routes from its own measurements, because its network path is its own; queue depth is
  shared anyway.
- **Kubernetes**: a brokered plugin needs no Service and spreads over replicas by itself. The docs get an optional
  RabbitMQ manifest and a KEDA recipe that scales plugin replicas on queue depth.

## Choosing a transport per call (Auto)

**Inputs**, per plugin × endpoint, over a 60 s window with an exponential moving average:

- latency of successful calls per method and request-size bucket (the timing behind `landflow.plugin.rpc.duration`);
- transport failures and timeouts only (a node error in a normal reply doesn't count against the transport);
- calls in flight against the plugin's `maxConcurrency`, which shows saturation on direct transports;
- for brokers: queue depth, consumers and publish-confirm latency;
- the call's context: method, run mode (editor and manual, or production, triggers and workers) and item count.

**Score** = expected time to finish: base latency, plus a queueing estimate (direct: a penalty that grows as in-flight
calls near the limit; broker: depth ÷ consumers × mean service time), plus an error penalty (failure rate × timeout).
The lowest score wins, with these rules on top:

1. **Interactive calls stay direct.** Editor runs, `LoadOptions`, `TestCredentials` and webhook calls with a waiting caller
   prefer gRPC, then HTTP, while those are healthy. A broker adds two hops, roughly a millisecond or two on a LAN.
2. **Spill bursts over to a queue; don't flip everything.** In production traffic the direct transport takes calls up to
   about 80 % of the plugin's concurrency, and the rest go to the broker, which buffers them and applies back-pressure.
   A 5,000-row SMS campaign doesn't time out against a saturated gRPC endpoint.
3. **Hysteresis.** The primary transport changes only when another is at least 20 % better for three 10 s windows in a
   row, and stays at least 60 s. No flapping.
4. **Fresh numbers without risk.** A `Health` ping every 15 s keeps stats for the transports not in use. `Execute` is
   never used as a probe.
5. **Circuit breaker** per endpoint: open after 5 transport failures in a row, or more than half of the last 20 calls;
   half-open after 15 s with a `Health` probe.
6. **Failover inside one call only when it provably wasn't delivered**: connection refused, DNS failure, gRPC
   `UNAVAILABLE` before sending, or an AMQP `basic.return`. Otherwise the error surfaces and the node's retry settings
   apply, so a call never runs twice.
7. **Objective** per plugin: `balanced` (default, the rules above), `latency` (always the fastest healthy transport, no
   spill-over) or `throughput` (production calls go to the broker first).

**Explainability.** Each `plugin.rpc` span gets `landflow.transport` and `landflow.transport.reason` (`pinned`,
`only`, `auto.latency`, `auto.spillover`, `auto.failover`, `auto.breaker`). New metrics:
`landflow.transport.calls{landflow.plugin.id, landflow.transport, reason}`,
`landflow.transport.switches{landflow.plugin.id, from, to}`,
`landflow.transport.queue_depth{connection, landflow.plugin.id}`.
The feed says why, e.g. "Twilio now spills over to RabbitMQ: gRPC at 14 of 16 calls, p95 2.1 s".

## Walk-through: Twilio

1. **The broker.** RabbitMQ is installed: in dev, `deploy/compose.infra.yml` under a `broker` profile (AMQP 55672,
   management 55673, dev-only users in `.env.example`). The admin adds it in Settings → Transports as `rabbitmq-main`, and
   **Test** says it's connected.
2. **The plugin.** It starts with `LANDFLOW_TRANSPORTS=http,grpc,amqp` and `LANDFLOW_AMQP_URL`. The Plugins page shows
   Twilio reachable over gRPC, HTTP and RabbitMQ (`rabbitmq-main`), with policy Auto (balanced).
3. **An editor test run** goes over gRPC (a few ms). `reason=auto.latency`.
4. **A campaign of 5,000 rows** fills gRPC up to its limit, and the rest spills over to RabbitMQ (`auto.spillover`).
   Prefetch keeps each replica's call rate under Twilio's API limits; adding two replicas adds consumers and the queue
   drains faster. No SMS is sent twice: "Send SMS" isn't idempotent, so it's at most once.
5. **Failure.** Kill the gRPC side and the breaker opens: all calls go to RabbitMQ (`auto.breaker`). When gRPC comes
   back, a half-open `Health` probe closes the breaker, and traffic returns after the dwell time.
6. **Pinned.** A Twilio plugin running in a network with no inbound access is pinned to RabbitMQ. It's reachable even
   though the host can't connect to it.

There's no Twilio plugin yet. The pilot adds a Twilio node to the TypeScript messaging plugin:
- operations: Send SMS/MMS, Send WhatsApp, Make a call, List and Get messages;
- credentials: Account SID with an auth token or API key, tested with `GET /2010-04-01/Accounts/{sid}.json`;
- tests against a fake Twilio server, as the other integrations do.

## Phases

Each phase ends with the web, engine, SDK and plugin tests passing, a clean type check and a check in Chrome, as in the
roadmap's waves.

| Phase | Work | Done when | Size |
|---|---|---|---|
| 0. Spec | Protocol §14 written; decisions below settled; RabbitMQ in `compose.infra.yml` (`broker` profile) | Reviewed spec; broker starts locally | S |
| 1. Abstraction | SDK `TransportBinding` in TS, Go and Python with HTTP and gRPC moved behind it; host providers; widened `Transport` type; the per-plugin policy stored in the database, with the picker on the Plugins page; the conformance kit | Every existing test passes, behaviour unchanged; the policy survives restarts and is the same on every main and worker | M |
| 2. RabbitMQ (TypeScript) | Host AMQP provider, Settings → Transports, broker discovery, the AMQP client (confirms, `mandatory`, deadlines, cancel), the TS SDK binding, credential encryption and signing; text-toolkit served over AMQP first | A workflow runs through text-toolkit over RabbitMQ with one joined trace; a plugin with no open port works; pinned mode works; broker restarts and a plugin killed mid-call behave as specified (`LANDFLOW_INTEGRATION=amqp`) | L |
| 3. Go and Python | AMQP bindings in both SDKs | Conformance passes for 3 SDKs × 3 transports | M |
| 4. Auto | Stats, scoring, spill-over, hysteresis, breaker, probes, spans and metrics, the Plugins page numbers and feed events | Simulation tests with fake clients and a fake clock: steady low traffic stays direct, a burst spills over, a failing direct transport fails over, recovery comes back, no flapping | L |
| 5. Twilio pilot, queue mode, Kubernetes | The Twilio node and its fake; workers with broker connections; RabbitMQ and KEDA docs; `deploy/scripts/transport-bench.py` comparing latency and throughput per transport, with the results in this file | The walk-through above works end to end on the local stack and on OrbStack's cluster | M |
| 6. More brokers | NATS (native request/reply) and Valkey Streams (reuses queue mode's Valkey): a host provider and three SDK bindings each | Conformance passes for each | M each |

Phases 1 and 2 are the backbone. Phase 4 can start right after phase 2, in parallel with 3.

## Risks

| Risk | Answer |
|---|---|
| A redelivered call repeats a side effect (an SMS sent twice) | At most once by default; at least once only for `idempotent` nodes or with an idempotency key; failover only when the call provably wasn't delivered |
| Secrets sit in a broker | End-to-end encryption and signing, transient messages, TLS, per-plugin broker users |
| A broker adds latency | Interactive calls stay direct; the broker takes bursts and plugins with no inbound access |
| Auto routing is hard to trust | Every choice carries a reason in spans, metrics and the feed; pinning is always possible; simulation tests |
| Version skew during rolling deploys | A manifest-hash header, `manifest_mismatch` with requeue, then a fresh manifest pull |
| Large payloads | A size limit, binary data by reference, the shared binary store for brokered plugins |
| The broker goes down | The breaker sends calls back to direct transports; brokered-only plugins go offline when their announce lease expires, like any other plugin |
| Three SDKs drift apart | One conformance kit that every binding runs |

## Decisions to make

1. **Which broker first.** Recommended: RabbitMQ (your example), then NATS and Valkey Streams.
2. **Message body format.** Recommended: the HTTP binding's JSON, so every SDK reuses what it has. Protobuf only if the
   phase 5 benchmark shows it's worth it.
3. **Delivery for `Execute`.** Recommended: at most once by default, at least once as a per-node opt-in (`idempotent`).
4. **Secrets over brokers.** Recommended: end-to-end encryption and signing, required; a brokered endpoint is unusable
   without the transport secret.
5. **Where the choice is made.** Recommended: per plugin (policy plus allow-list) for now; per-workflow overrides later
   if needed.
6. **Auto's default objective.** Recommended: `balanced` with spill-over.
7. **The pilot.** Recommended: a Twilio node in the messaging plugin, with a fake Twilio server for tests.
