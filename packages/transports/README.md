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

## MQTT 5 (`@landflow/transports/mqtt`)

- **Client**: `pnpm add mqtt@5.16.1` (MQTT.js, protocol version 5; ships its own types).
- **Config** (`MqttConfig`): `url` (`mqtt://host:1883`, `mqtts://host:8883`, `ws://host/mqtt`, `wss://…`; `tcp://` and
  `ssl://` are accepted), `username`/`password` (win over the URL's, which is stripped), `tls`, `clientId` (default
  `landflow-<connectionId>-<random>`), `keepaliveSeconds` (30), `connectTimeoutMs` (10 s), `reconnectPeriodMs` (1 s),
  `maxMessageBytes` (default 1 MiB, lowered to the CONNACK Maximum Packet Size), `rejectUnauthorized`. SDK: `mqtt({ url })`;
  env `LANDFLOW_MQTT_URL` (+ `_USERNAME`, `_PASSWORD`, `_TLS`, `_PREFIX`, and `_CLIENT_ID` in Go).
- **Capabilities**: native replies (Response Topic + Correlation Data), work sharing (`$share/<group>/<topic>`), **no
  buffering** (clean sessions: a publish while no replica is subscribed is dropped), TTL (Message Expiry Interval, whole
  seconds rounded up), undeliverable `reported` (PUBACK reason `0x10` "No matching subscribers" on QoS 1: Mosquitto,
  EMQX, HiveMQ; a broker that never sends it only makes such calls wait for the deadline), disk, 1 MiB, latency `low`,
  headers (user properties under their bare names, `content-type` as the Content Type property), no ordering keys,
  nack and attempts (see below). No `stats()`: MQTT has no consumer counts.
- **How it maps**: a channel is a topic with `/` for `.`; shared channels (request, instance) are published and
  subscribed at QoS 1, broadcast channels (registry, control) at QoS 0. The broker's QoS 1 delivery is acknowledged as it
  arrives (MQTT acknowledges per connection, in order; a deferred PUBACK would stall the connection's inbound packets, our
  own PUBACKs and replies with them), so `nack({ requeue: true })` and a closed consumer **republish** the message with a
  `landflow-attempt` user property, as the core NATS driver does: another member of the shared subscription takes it with
  `attempt` + 1 while the process lives; a killed process loses what it held. Prefetch is held in the driver. A connection
  loss rejects the requests in flight (the response topic lives with the connection); MQTT.js reconnects and
  re-subscribes. Both the TypeScript and the Go driver (`sdks/go/transport/mqtt`, paho.golang) do exactly this, so mixed
  replicas share a topic.
- **Limitations**: at most once at the broker level for a crashed replica (MQTT 5 §4.8.2 only says the broker SHOULD
  redistribute); no buffering while no replica is up; topic-level ordering only per publisher, none across a shared
  subscription.

## AMQP 1.0 (`@landflow/transports/amqp1`)

- **Client**: `pnpm add rhea@3.0.5` (the base library rather than `rhea-promise`: the driver needs manual link credit as
  prefetch, per-delivery dispositions and dynamic reply nodes, which `rhea` exposes directly, with its own typings and no
  further dependencies). Tested against ActiveMQ Artemis 2.44.
- **Config** (`Amqp1Config`): `url` (`amqp://host:5672`, `amqps://host:5671`; `amqp+ssl://` accepted), `username`/`password`
  (SASL PLAIN; win over the URL's, which is stripped), `tls`, `idleTimeoutMs` (60 s), `connectTimeoutMs` (10 s),
  `maxMessageBytes` (default 1 MiB; Artemis has no fixed limit), reconnect backoff, `rejectUnauthorized`. SDK:
  `amqp1({ url })`; env `LANDFLOW_AMQP1_URL` (+ `_USERNAME`, `_PASSWORD`, `_TLS`, `_PREFIX`).
- **Capabilities**: native replies (a dynamic reply queue per driver instance, `reply-to` + `correlation-id`), work
  sharing, buffering, TTL (the header's `ttl`; Artemis checks expiry on delivery), undeliverable `inferred` (`stats()`
  asks the management address for `ConsumerCount` and `MessageCount`), disk, 1 MiB, latency `medium`, headers
  (`cloudEvents_` application properties, `content-type` as the message property), ordering keys (`group-id`: Artemis
  message groups pin a group to one consumer), nack (`modified { delivery-failed }`) and attempts (`delivery-count` + 1).
- **How it maps**: shared channels are anycast addresses with a queue of the same name (links attach with the `queue`
  capability, which auto-creates them), broadcast channels are multicast addresses (`topic` capability, a volatile
  subscription queue per receiver). Prefetch is link credit (`credit_window` 0 plus one unit back per settled delivery).
  `ack()` is `accepted`; `nack({ requeue: true })` is `modified { delivery-failed }` (redelivered with `delivery-count` +
  1); `nack({ requeue: false })` is `accepted` too (dropping; `rejected` would dead-letter or redeliver); a closed consumer
  settles what it holds as failed and detaches. A connection loss rejects the requests in flight, then the driver
  reconnects with backoff and re-attaches every subscription. The Go driver (`sdks/go/transport/amqp1`, go-amqp v1) is
  wire-compatible.
- **Limitations**: addresses and queues are never deleted by the driver (Artemis auto-deletes unused auto-created ones by
  default); a publish nobody consumes is `accepted` (inferred later from `stats()`); the management address is
  Artemis-specific, other AMQP 1.0 brokers get `{}` from `stats()` only after a timeout.

## Amazon SQS (`@landflow/transports/sqs`)

- **Client**: `pnpm add @aws-sdk/client-sqs@3.1156.0` (AWS SDK v3). Tests: `LANDFLOW_TEST_SQS=http://127.0.0.1:54566 npx vitest run
  src/drivers/sqs` against the `landflow-infra` LocalStack (profile `aws`, services `secretsmanager,sqs`); every queue carries a
  per-run `queuePrefix` (`lftest-<random>-`) and is deleted at the end. The test process sets `AWS_SHARED_CREDENTIALS_FILE` and
  `AWS_CONFIG_FILE` to `/dev/null`.
- **Local only by default** (`SqsConfig`): `endpoint` is required (`http://127.0.0.1:54566`; a real one is
  `https://sqs.<region>.amazonaws.com`) and credentials are static (`username`/`password` = access key id / secret access
  key; `test`/`test` when absent). The AWS default endpoint and credential chain (`~/.aws`, instance roles) are used only
  with `allowAws: true` and no static credentials: `configFrom()` and `connect()` refuse to start otherwise, so no test can
  reach the real service by accident. From a URL: `http(s)://host[:port]` (the endpoint), `sqs://host:port` (plain HTTP,
  `tls` for HTTPS), `sqs://aws[/<region>]` (needs `allowAws`), `?region=`. Fields: `region` (default `us-east-1`),
  `endpoint` (wins over the URL), `allowAws`, `queuePrefix`; tunables `maxMessageBytes` (≤ 1 MiB), `visibilityTimeoutSeconds`
  (30), `waitTimeSeconds` (5, ≤ 20), `retentionSeconds` (3600), `fanoutRefreshMs` (2000). SDK: `sqs({ endpoint })`
  (connection id `env-sqs`); env `LANDFLOW_SQS_URL`, `_USERNAME`, `_PASSWORD`, `_REGION`, `_ENDPOINT`, `_ALLOWAWS`, `_QUEUEPREFIX`.
- **Capabilities**: reply-channel replies, work sharing, buffering, no TTL, undeliverable `unknown` (SQS cannot count
  consumers; `stats()` reports `ApproximateNumberOfMessages` as depth only), disk, 1 MiB (SQS's limit since 2025; the driver
  sets `MaximumMessageSize` on every queue it creates, the service default being 256 KiB), latency `high`, **no headers**
  (structured mode: SQS allows 10 message attributes and the envelope has up to 19; the driver carries `content-type` and,
  only when the body is not valid SQS text, `lf-encoding: base64`), no ordering keys (standard queues; FIFO would cost 300
  messages/s per group and head-of-line blocking per `MessageGroupId`), nack and attempts (`ApproximateReceiveCount`).
- **How it maps**: a shared channel is one standard queue (`<queuePrefix><channel>` with `.` → `_`, names over 80 characters
  shortened with a hash); consumers long-poll with `MaxNumberOfMessages` = free prefetch slots (at most 10), in-flight
  deliveries extend their visibility, `ack()` = `DeleteMessage`, `nack({ requeue: true })` = `ChangeMessageVisibility 0`.
  **Broadcast channels have no fan-out in SQS**: every consumer creates a queue of its own (`<queue>--bc-<id>`, retention =
  the channel TTL, deleted on `close()`) and a publisher sends to every queue listed under that prefix (`ListQueues`, cached
  for `fanoutRefreshMs`; its own consumers' queues at once). The reply channel is therefore one queue per host; a plugin
  publishes to it without declaring it, so the driver tells broadcast channels by their role in the name
  (`<prefix>.v1.reply|registry|control…`). SNS would fan out natively but needs a second service, a queue policy per queue
  and leaves the same orphans after a crash. Queue URLs are rewritten onto the endpoint (LocalStack returns
  `sqs.<region>.localhost`, which does not resolve).
- **Limitations**: after a hard crash, redelivery waits `visibilityTimeoutSeconds` and a dead consumer's broadcast queue
  stays until an operator deletes it (`deleteQueues()`; its retention bounds what it holds); a consumer that joins a
  broadcast channel may miss events published in the next `fanoutRefreshMs` by a publisher with a warm cache (heartbeats
  repeat every 10 s); a closing subscription waits for its poll in flight (≤ `waitTimeSeconds`), because a poll the client
  aborts still runs on the server and would take the messages the close releases; publishing to many consumer queues is
  one `SendMessage` each.

## Google Pub/Sub (`@landflow/transports/pubsub`)

- **Client**: `pnpm add @google-cloud/pubsub@6.3.1`. Tests: `LANDFLOW_TEST_PUBSUB=127.0.0.1:58085 npx vitest run
  src/drivers/pubsub` against the `landflow-infra` emulator (profile `pubsub`, project `landflow-dev`); every topic and
  subscription carries a per-run `topicPrefix` (`lftest-<random>-`) and is deleted at the end, since the emulator never
  expires anything.
- **Emulator only by default** (`PubSubConfig`): `projectId` and `emulatorHost` (`127.0.0.1:58085`) are required; the real
  service (Google credentials from the environment) is used only with `allowCloud: true`, and `configFrom()`/`connect()`
  refuse otherwise. In emulator mode the client gets an insecure channel and `METADATA_SERVER_DETECTION=none` is
  defaulted so the auth library does not probe for a GCE metadata server. From a URL:
  `pubsub://127.0.0.1:58085/landflow-dev` (emulator), `pubsub://<projectId>` or `pubsub://pubsub.googleapis.com/<projectId>`
  (the service, needs `allowCloud`). Fields: `projectId`, `emulatorHost` (both win over the URL), `allowCloud`,
  `topicPrefix`; tunables `maxMessageBytes` (≤ 10 MB), `ackDeadlineSeconds` (30, 10–600), `retentionSeconds` (3600),
  `deadLetter` (true), `maxDeliveryAttempts` (100), `connectTimeoutMs`. SDK: `pubsub({ projectId, emulatorHost })`
  (connection id `env-pubsub`); env `LANDFLOW_PUBSUB_URL`, `_PROJECTID`, `_EMULATORHOST`, `_ALLOWCLOUD`, `_TOPICPREFIX`.
- **Capabilities**: reply-channel replies, work sharing, buffering, no TTL, undeliverable `unknown` (Pub/Sub exposes
  neither consumer counts nor backlog to clients; no `stats()`), disk, 10 MB, latency `medium`, headers (`ce_` attributes,
  `content-type` bare; 100 attributes × 1024 bytes), ordering keys (message ordering is on), nack (ack deadline 0) and
  attempts (`delivery_attempt`, which Pub/Sub populates only on subscriptions with a dead-letter policy: request
  subscriptions get one, `<topic>.dlq` with `maxDeliveryAttempts` 100, unless `deadLetter: false`, which makes attempts
  always 1).
- **How it maps**: a channel is a topic (channel names are valid resource ids as they are); a shared channel has one
  subscription per work-sharing group (the channel name, so Go and TS replicas share it), created in `declare()` so
  events published before the first consumer wait; consumers stream-pull with flow control = `prefetch` and the client
  extends ack deadlines of in-flight messages. Broadcast channels get one subscription per consumer (`<topic>.bc.<id>`,
  retention 10 min, expires after a day without consumers on the real service, deleted on `close()`). The Go driver
  (`sdks/go/transport/pubsub`, `cloud.google.com/go/pubsub/v2`) is wire-compatible; its client counts a message as
  outstanding until the callback returns, so in manual mode the callback blocks until the delivery is settled, and
  broadcast subscriptions take one message at a time to keep publish order.
- **Limitations**: after a hard crash, redelivery waits `ackDeadlineSeconds` and a dead consumer's subscription lingers
  (a day on the service, forever on the emulator: `deleteChannels()`); the emulator differs from the service in that a
  nack does not hold back later messages of the same ordering key; dead-letter topics are created but nothing reads them
  (a message that fails 100 deliveries lands there and is otherwise lost to the plugin).

## Apache Pulsar (`@landflow/transports/pulsar`)

- **Client**: `pnpm add pulsar-client@1.18.0` (the Apache Node.js client: a Node-API addon over the C++ client with
  prebuilt binaries for macOS, Linux glibc and musl on x64 and arm64, downloaded from archive.apache.org at install
  time; the install script must be allowed, see `pnpm-workspace.yaml` `onlyBuiltDependencies`; the host lists it in
  `serverExternalPackages` since Turbopack cannot bundle `node-pre-gyp`). Tests: `LANDFLOW_TEST_PULSAR=pulsar://127.0.0.1:56650
  npx vitest run src/drivers/pulsar` (the `pulsar` profile; `LANDFLOW_TEST_PULSAR_ADMIN` defaults to `http://127.0.0.1:58180`;
  the topics a run created are deleted through the admin API).
- **Config** (`PulsarConfig`): `serviceUrl` (`pulsar://host:6650`, `pulsar+ssl://host:6651`), `adminUrl` (the admin REST
  API; enables `stats()` and the deletion of per-process topics on `close()`), `tenant`/`namespace` (default
  `public`/`default`), `token` (JWT; the connection's password field), TLS trust settings, `maxMessageBytes` (default
  5 MB, the broker's `maxMessageSize`), `nackRedeliveryDelayMs` (100), `ackTimeoutMs` (off), `connectTimeoutMs` (10 s),
  `operationTimeoutMs` (30 s). Connection fields: `adminUrl`, `tenant`, `namespace`. SDK: `pulsar({ serviceUrl })`
  (connection id `env-pulsar`; env `LANDFLOW_PULSAR_URL`, `_PASSWORD`, `_ADMINURL`, `_TENANT`, `_NAMESPACE`).
- **Capabilities**: reply-channel replies, work sharing (a Shared subscription per channel), buffering (the subscription
  is created on `declare()`), no TTL (Pulsar's message TTL is a namespace policy in seconds, not a message attribute),
  undeliverable `inferred` (`stats()` reads the subscription's consumers and backlog through the admin API; `{}` without
  `adminUrl`), disk, 5 MB, latency `medium`, headers (properties under `ce_`), no ordering keys (a Shared subscription
  spreads a key over its consumers; the key is still set as the partition key), nack (negative acknowledgement, redelivered
  after `nackRedeliveryDelayMs`) and attempts (`redeliveryCount + 1`).
- **How it maps**: a persistent topic per channel under the tenant and namespace; shared channels are pulled with
  `receiverQueueSize = prefetch` by consumers of the Shared subscription named after the channel; broadcast channels are
  read by a non-durable reader per consumer from the latest message. A closing subscription negative-acknowledges what it
  still holds before closing its consumer, so a survivor sees a truthful attempt. `connect()` opens a producer on a
  non-persistent probe topic so an unreachable broker rejects within `connectTimeoutMs`.
- **Limitations**: what a hard-killed process held is redelivered by the broker as attempt 1 (Pulsar counts negative
  acknowledgements, not consumer deaths); the client prefetches `receiverQueueSize` messages into a local queue beyond the
  ones handed to the core, so a saturated consumer may own a few messages an idle one could have taken; per-process reply
  and instance topics stay on the broker unless `adminUrl` is set.

## Azure Service Bus (`@landflow/transports/servicebus`)

- **Client**: `pnpm add @azure/service-bus@7.10.0`. Tests: `LANDFLOW_TEST_SERVICEBUS=sb://127.0.0.1:55675 npx vitest run
  src/drivers/servicebus` against the emulator (the `servicebus` profile). The emulator cannot create entities, so the
  suite maps its random channel names onto the fixed entities of `deploy/infra/servicebus/Config.json` (`queueFor`), drains
  them first, and sets the limits explicitly (256 KiB per message on the emulator's link).
- **Config** (`ServiceBusConfig`): `connectionString` (`Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…`, with
  `UseDevelopmentEmulator=true` for the emulator), `emulator`, `createEntities` (through the administration client; on by
  default outside the emulator, untested against a real namespace), `entities` (`instanceQueue`, `replyQueue`,
  `broadcastTopic`, `broadcastSubscriptions`), `queueFor` (the queue of a request channel), `maxMessageBytes` (default
  240 KiB; the Standard tier and the emulator allow 256 KiB per AMQP message including framing; up to 1 MiB on Premium),
  `lockRenewalMs`. From a connection URL: the connection string itself, or `sb://namespace.servicebus.windows.net` with the
  key name as the username and the key as the password (`sb://127.0.0.1:55675` is the emulator). Connection fields:
  `emulator`, `maxMessageBytes`. SDK: `servicebus({ connectionString })` (connection id `env-servicebus`; env
  `LANDFLOW_SERVICEBUS_URL`, `_USERNAME`, `_PASSWORD`, `_EMULATOR`, `_MAXMESSAGEBYTES`).
- **Capabilities**: reply-channel replies, work sharing (competing peek-lock receivers), buffering, TTL (per-message
  `timeToLive`), undeliverable `unknown` (Service Bus exposes message counts but no receiver counts: `stats()` reports an
  approximate depth from a peek and the core relies on announce heartbeats and the deadline), disk, 240 KiB,
  `maxHeaderBytes` 64 KiB (the application-properties budget), latency `medium`, headers (application properties under
  `ce_`, `content-type` as the message's content type), no ordering keys (request queues are not session-enabled, so
  replicas can share them), nack (abandon) and attempts (`deliveryCount + 1`).
- **How it maps** (Service Bus has no exclusive consumers, no broadcast queues and, on the emulator, no entity creation at
  runtime): request channels are **queues named after the channel** (`landflow.v1.plugin.<pluginId>`); instance and
  reply channels are **sessions** of one session-enabled queue each (`<prefix>.v1.instance`, `<prefix>.v1.reply`, session
  id = channel name: one receiver per session is exactly the channel's contract); registry and control channels go through
  one **topic** (`<prefix>.v1.broadcast`) with a pool of session-enabled subscriptions (`bc-00` … `bc-15`): every broadcast
  message carries the session id `broadcast` and its channel in the `lfchannel` property, and a consumer claims a
  subscription by locking that session (a locked one answers `SessionCannotBeLocked`, so it tries the next), drains what
  accumulated while unclaimed, then keeps its channel's events. Message locks are renewed while a call runs; a closing
  subscription abandons what it holds, so a survivor takes it. An event for another channel on a shared queue is
  dead-lettered (`wrong-channel`), never silently dropped.
- **Limitations**: the entities must exist before the first `declare()` (the emulator: `Config.json`; a real namespace:
  `createEntities`); the broadcast pool bounds the number of simultaneous registry/control consumers per namespace (16 by
  default); session receivers always peek-lock (the emulator delivers nothing to a receive-and-delete session receiver).
