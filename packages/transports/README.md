# @landflow/transports

Landflow's generic messaging over brokers: the CloudEvents envelope, signing and encryption, the host client
(`MessagingClient`) and plugin server (`MessagingServer`), the broker driver contract (`./driver`), the in-memory driver
(`./memory`), the driver conformance suite (`./conformance`) and one driver per broker kind (`./kafka`, `./amqp`,
`./nats`, `./valkey`, …), found by kind through `./drivers` (`loadDriverModule(kind)`). The design is in
`docs/transports.md`; the wire format in `docs/protocol.md` §14.

Each driver's client library is an **optional peer dependency**, imported lazily inside `connect()`: install only the
clients you use. Every driver passes `runConformance()` against its local container (`deploy/compose.infra.yml`, one
profile per broker); the tests skip with a message when the broker's `LANDFLOW_TEST_<KIND>` variable is unset or the
broker is unreachable.

```sh
cd packages/transports
npx vitest run                                                            # memory suite + unit tests, brokers skipped
LANDFLOW_TEST_KAFKA=127.0.0.1:59092 LANDFLOW_TEST_AMQP=amqp://user:password@127.0.0.1:55672 npx vitest run
```

## Kafka (`@landflow/transports/kafka`)

- **Client**: `pnpm add @confluentinc/kafka-javascript@1.11.0` (librdkafka 2.16 with prebuilt binaries; arm64 macOS and
  Linux work under Node 22; the install script must be allowed, see `pnpm-workspace.yaml` `onlyBuiltDependencies`).
- **Config** (`KafkaConfig`): `brokers` (`host:port[]`), `ssl`, `sasl` (`plain`, `scram-sha-256`, `scram-sha-512`),
  `groupProtocol` (`consumer` = KIP-848, the default, needs Kafka ≥ 4.0; `classic` for older brokers and Redpanda),
  `partitions` (request/instance topics, default 6), `replicationFactor`, `maxMessageBytes` (default 1 MiB),
  `retentionMs` (request topics, default 24 h), `publishTimeoutMs`, `connectTimeoutMs`, `assignmentTimeoutMs`,
  `rdkafka` (extra librdkafka properties). From a connection URL: `kafka://h1:9092,h2:9092`, `kafkas://…`, or a bare
  broker list; a username turns on SASL (mechanism from the `saslMechanism` field). SDK: `kafka({ brokers: [...] })`.
- **Capabilities**: reply-channel replies, work sharing, buffering, no TTL, undeliverable `inferred` (consumer-group
  members from `stats()`), disk, 1 MiB, latency `high`, headers (`ce_` prefix), ordering keys (record key), nack and
  attempts (below).
- **How it maps**: a topic per channel; shared channels are consumed by a consumer group named after the channel;
  broadcast channels by a unique group per consumer, positioned at the end of every partition when it subscribes.
  `stats()` = group members + lag (committed vs end offsets). `close()` deletes the per-process reply and instance topics
  it declared.
- **Limitations**: the client has no share-group (KIP-932) consumer yet, so acknowledgement is an offset commit: `ack()`
  commits `offset + 1` at once (at most once commits before the call runs); `nack({ requeue: true })` and a closing
  subscription **re-publish** the record with a private `lf-attempt` header (so `attempt` is truthful for every requeue
  the driver performs), and a partition about to move to another member has its held records committed first so the new
  owner does not run them again. After a hard crash, uncommitted records are re-read by a survivor as attempt 1, and an
  unacknowledged at-least-once record behind a committed one on the same partition is lost (the host's deadline fails it).
  A consumer whose `prefetch` is exhausted blocks the partition's fetch loop, so a rebalance waits for the longest call in
  flight (bounded by the deadline).

## RabbitMQ (`@landflow/transports/amqp`)

- **Client**: `pnpm add amqplib@2.2.0` (ships its own types).
- **Config** (`AmqpConfig`): `url` (`amqp://user:pass@host:5672/vhost`, `amqps://…`), `username`/`password` (win over the
  URL's), `tls`, `heartbeatSeconds` (30), `queueType` (`quorum` default, `classic`), `queueExpiresMs` (request queues'
  `x-expires`, default 24 h), `maxMessageBytes` (default 16 MiB, RabbitMQ 4's `max_message_size`), reconnect backoff.
  SDK: `amqp({ url })`.
- **Capabilities**: native replies (direct reply-to), work sharing, buffering, TTL (per-message `expiration`),
  undeliverable `reported`, disk, 16 MiB, `maxHeaderBytes` 120 KiB (the content header frame must fit `frame_max`),
  latency `medium`, headers (`cloudEvents_` prefix, `content-type` as the `contentType` property), no ordering keys,
  nack (requeue) and attempts (`x-delivery-count` on quorum queues, else the `redelivered` flag).
- **How it maps**: request queues are durable quorum queues; instance queues durable classic queues that auto-delete;
  broadcast channels are durable fanout exchanges with an exclusive auto-delete queue per consumer; prefetch is
  `basic.qos` on the consumer's own channel. Publishes are `mandatory` on a confirm channel, and a publish to a queue
  first asks the broker for its consumer count, so "nobody is consuming" is `unroutable` before anything is sent. A lost
  connection rejects the requests in flight (direct reply-to dies with it), then the driver reconnects with backoff and
  re-establishes every subscription.
- **Limitations**: a queue that already exists is used as is (no re-declare with other arguments), so changing
  `queueType` needs the old queue deleted; RabbitMQ has no ordering key (one queue is FIFO per consumer only).

## NATS (`@landflow/transports/nats` and `@landflow/transports/jetstream`)

Two kinds on one server and one URL, because their capabilities differ and a driver module has one static capability set:
`nats` is core NATS (fastest, nothing buffered), `jetstream` adds durable work-queue streams. Tests:
`LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 npx vitest run src/drivers/nats` (the `nats` profile; the JetStream suite
deletes the streams it creates, named with a per-run `streamPrefix`).

- **Client**: `pnpm add @nats-io/transport-node@3.4.0` (both kinds) and `@nats-io/jetstream@3.4.0` (JetStream only).
- **Config** (`NatsConfig`): `servers` (one or several `host:4222`), `user`/`pass` or `token`, `tls` (`true` or
  `{ ca, cert, key }` PEM), `name`, `connectTimeoutMs`, `maxMessageBytes` (default 1 MiB, lowered to the server's
  `max_payload` on connect). From a URL: `nats://h1:4222,h2:4222`, `tls://host:4222`, `nats://user:pass@host`,
  `nats://token@host`; the connection fields win. `JetStreamConfig` adds `streamPrefix`, `ackWaitMs` (30 s; in-flight
  deliveries send progress acks so a long call is not redelivered), `maxAgeMs` (request streams, 1 h), `storage`,
  `replicas`. SDK: `nats({ servers })`, `jetstream({ servers })` (connection ids `env-nats`, `env-jetstream`).
- **Capabilities, `nats`**: native replies (inboxes), work sharing (queue groups), no buffering, no TTL, undeliverable
  `reported` (a publish carries a reply inbox and is flushed: the server's 503 "no responders" arrives before the flush
  completes; requests use `nc.request()`), memory, 1 MiB, latency `low`, headers (`ce-` prefix), no ordering keys, nack
  and attempts (below).
- **Capabilities, `jetstream`**: native replies (the requester's inbox travels in a `Landflow-Reply` header, so
  `Delivery.reply()` answers the host directly), work sharing (one durable pull consumer per plugin, pulled `prefetch` at
  a time per instance), buffering, TTL not claimed (`Nats-TTL` is set as a first filter but has one-second granularity),
  undeliverable `inferred` (`stats()`: `num_pending` as depth, open pull requests plus ack-pending work as consumers), disk,
  1 MiB, latency `low`, headers (`ce-`), no ordering keys, nack (`nak`, redelivered after 25 ms) and attempts
  (`numDelivered`).
- **How it maps**: a channel is a subject (names need no translation); stream and consumer names replace `.` with `_`.
  In JetStream mode only durable shared channels (request channels) are streams (work-queue retention, file storage,
  `max_age`, `allow_msg_ttl`); instance, reply, registry and control channels are plain subjects in both kinds. A
  consumer that was declared by another process is recognised through `streams.find(subject)`.
- **Limitations**: core NATS `nack({ requeue: true })` and a closing consumer **republish** the message with a
  `Landflow-Attempt` header (so `attempt` is truthful for requeues the driver performs); a process that is killed loses
  what it held, as core NATS always does. Core prefetch is enforced in the driver (the server still sends the messages),
  so a saturated queue member holds messages an idle member could have taken; JetStream pulls exactly what it can run.

## Valkey Streams (`@landflow/transports/valkey`)

- **Client**: `pnpm add iovalkey@0.4.0` (the Valkey project's maintained fork of ioredis, same API; `redis` 6.x would
  be the alternative). Tests: `LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 npx vitest run src/drivers/valkey` against
  the shared `landflow-infra` Valkey; every key carries a per-run `keyPrefix` (`landflow-test-<random>:`) and is deleted
  at the end, never `FLUSHDB`.
- **Config** (`ValkeyConfig`): `url` (`redis://`, `rediss://`, `valkey://`, `valkeys://`, optional `/db`), `username`,
  `password`, `db`, `tls`, `keyPrefix` (default none), `maxMessageBytes` (default 1 MiB, lowered to `proto-max-bulk-len`),
  `maxLen` (`MAXLEN ~`, default 10 000), `claimIdleMs` (30 s), `blockMs` (1 s). Connection fields: `keyPrefix`, `db`.
  SDK: `valkey({ url })` (connection id `env-valkey`).
- **Capabilities**: reply-channel replies, work sharing (a consumer group per channel), buffering (groups start at `0`),
  no TTL, undeliverable `inferred` (`XINFO CONSUMERS` members with a recent `idle`), disk, 1 MiB, latency `low`, headers
  (entry fields `h:<name>` plus `b` for the body, so the core runs in binary mode and stream tooling reads the
  attributes), no ordering keys, nack and attempts (`XPENDING` delivery count).
- **How it maps**: `XADD` with `MINID ~ now - ttl` for channels declared with a TTL (reply, registry, control) or
  `MAXLEN ~` otherwise; shared channels read with `XREADGROUP COUNT <free slots> BLOCK` on a connection of their own and
  `XACK`; pending entries of a dead consumer are reclaimed with `XAUTOCLAIM` after `claimIdleMs`, and in-flight entries
  are kept alive (`XCLAIM … JUSTID` by their owner) so a slow call is not stolen; `nack({ requeue: true })` and a closing
  consumer park their entries on the `_orphans` consumer with their idle time already past `claimIdleMs`, so a survivor
  takes them on its next loop (within `blockMs`). Broadcast channels use `XREAD` from the id current at subscribe time.
- **Limitations**: after a hard crash, redelivery waits `claimIdleMs`; consumers that died stay listed in the group
  (ignored by `stats()` once idle); trimming is approximate (`~`), so a stream holds a few more entries than `maxLen`.
