/**
 * `@landflow/transports/kafka`: the Kafka driver (Apache Kafka 2.x+, Redpanda), on `@confluentinc/kafka-javascript`
 * (Confluent's supported client, librdkafka underneath; an optional peer dependency imported lazily in `connect()`).
 *
 * Mapping (docs/protocol.md §14.9): a **topic** per channel; CloudEvents Kafka binding in binary mode (`ce_` headers,
 * `content-type` bare); record key = `PublishOptions.orderingKey`. Shared channels (request, instance) are consumed by a
 * **consumer group** named after the channel, with the KIP-848 group protocol by default (Kafka ≥ 4.0: assignment in
 * well under a second instead of the classic 3 s initial rebalance delay; `groupProtocol: 'classic'` for older brokers
 * and Redpanda). Broadcast channels (reply, registry, control) use a unique group per consumer, positioned at the end of
 * every partition when the subscription starts, so nothing published before it is replayed and nothing after is lost.
 *
 * **Share groups** (KIP-932, "Queues for Kafka", on in the dev broker) would give per-record acknowledgement; the
 * client's JavaScript binding (1.11.0, librdkafka 2.16) exposes no share consumer yet, so this driver uses classic
 * consumer groups and emulates per-record semantics:
 * - `ack()` commits the record's offset (`offset + 1`, monotonic per partition). At most once therefore commits before
 *   the call runs, as the spec wants; an earlier record still unacknowledged on the same partition is committed with it,
 *   so a hard crash (SIGKILL) loses it (the host's deadline fails that call) instead of re-running an acknowledged one.
 * - `nack({ requeue: true })` **re-publishes** the record to its topic with a driver-private `lf-attempt` header
 *   (dropped by `unprefixHeaders`, so the core never sees it) and commits the original; a closed subscription does the
 *   same with its unacknowledged deliveries, which is how "a replica that dies mid-call" hands its at-least-once calls to
 *   a survivor. Hence `nack: true` and `attempts: true` for every requeue the driver performs; a record a survivor
 *   re-reads after a hard crash (the committed offset lagging behind) reports attempt 1 — Kafka cannot count it.
 * - Parallelism per consumer is bounded by `prefetch` (a semaphore over outstanding deliveries) and by the partitions it
 *   owns: a record waits while its partition's previous record has not been handed to the handler.
 *
 * `declare()` creates topics idempotently (request/instance: `partitions`, default 6; reply/registry/control: 1
 * partition and a short retention), `stats()` reads the group's members and lag through the admin API, `close()`
 * deletes the reply and instance topics this driver declared (they are per process and Kafka never deletes a topic
 * itself). librdkafka reconnects on its own; a `publish()` while it is retrying waits for the delivery report
 * (`message.timeout.ms`, default 30 s) and a failure after that is "maybe sent"; `NotConnectedError` is thrown only
 * before `connect()` and after `close()`.
 */
import { randomBytes } from 'node:crypto';
import {
  NotConnectedError,
  prefixHeaders,
  unprefixHeaders,
  type BrokerCapabilities,
  type BrokerConfig,
  type BrokerDriver,
  type ChannelSpec,
  type ChannelStats,
  type ConsumeHandler,
  type ConsumeOptions,
  type Delivery,
  type PublishOptions,
  type PublishOutcome,
  type Subscription,
  type WireEvent,
} from '../../driver';
import type { BrokerTarget, ConnectionOptions, DriverModule } from '../index';

/** The CloudEvents Kafka protocol binding's header prefix. */
export const KAFKA_HEADER_PREFIX = 'ce_';
/** Driver-private record header carrying the delivery attempt of a re-published (requeued) record; never shown to the core. */
export const ATTEMPT_HEADER = 'lf-attempt';
/** Kafka's default `message.max.bytes` is 1048588: the driver advertises 1 MiB for the event and sets the topic limit a bit above. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const TOPIC_SIZE_SLACK = 4096;
const DEFAULT_PARTITIONS = 6;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const EPHEMERAL_RETENTION_MS = 60 * 60_000;
const ASSIGNMENT_TIMEOUT_MS = 10_000;
const ADMIN_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** librdkafka's `RD_KAFKA_RESP_ERR__REVOKE_PARTITIONS`, the code a rebalance callback gets when partitions leave this consumer. */
const ERR_REVOKE_PARTITIONS = -174;

export const KAFKA_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: false,
  undeliverable: 'inferred',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'high',
  headers: true,
  orderingKeys: true,
  nack: true,
  attempts: true,
};

export type KafkaSaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

export interface KafkaConfig extends BrokerConfig {
  /** Bootstrap servers, `host:port` each. */
  brokers: string[];
  /** `client.id`; default `landflow`. */
  clientId?: string;
  /** TLS to the brokers. */
  ssl?: boolean;
  sasl?: { mechanism: KafkaSaslMechanism; username: string; password: string };
  /** Consumer group protocol: `consumer` (KIP-848, Kafka ≥ 4.0; default) or `classic` (older brokers, Redpanda). */
  groupProtocol?: 'consumer' | 'classic';
  /** Partitions of request and instance topics (default 6): the parallelism ceiling across a plugin's replicas. */
  partitions?: number;
  /** Replication factor of the topics the driver creates; default: the broker's default (`-1`). */
  replicationFactor?: number;
  /** Largest event the driver accepts (headers + body); default 1 MiB. Topics get `max.message.bytes` a little above it. */
  maxMessageBytes?: number;
  /** Retention of request topics without a `ttlMs` (default 24 h). */
  retentionMs?: number;
  /** How long a `publish()` may wait for the broker before failing (librdkafka `message.timeout.ms`; default 30 s). */
  publishTimeoutMs?: number;
  /** How long `connect()` waits for the cluster's metadata before giving up (default 10 s). */
  connectTimeoutMs?: number;
  /** How long `consume()` waits for a partition assignment before returning anyway (default 10 s; a consumer may legitimately own none). */
  assignmentTimeoutMs?: number;
  /** Extra librdkafka properties applied to every client (`socket.timeout.ms`, `ssl.ca.location`, …). */
  rdkafka?: Record<string, string | number | boolean>;
}

/** The subset of the client's API the driver uses (typed loosely: the library is loaded lazily and may be absent). */
interface KafkaJsModule {
  Kafka: new (config: Record<string, unknown>) => KafkaClient;
  logLevel: Record<string, number>;
}
interface KafkaClient {
  producer(config?: Record<string, unknown>): KafkaProducer;
  consumer(config?: Record<string, unknown>): KafkaConsumer;
  admin(config?: Record<string, unknown>): KafkaAdmin;
}
interface KafkaProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: { topic: string; messages: { key?: string | Buffer | null; value: Buffer; headers?: Record<string, string> }[] }): Promise<unknown>;
}
interface KafkaRecord {
  topic: string;
  partition: number;
  message: { key: Buffer | null; value: Buffer | null; offset: string; headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined> };
}
interface KafkaConsumer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(options: { topics: string[] }): Promise<void>;
  run(options: { partitionsConsumedConcurrently?: number; eachMessage: (payload: KafkaRecord) => Promise<void> }): Promise<void>;
  assignment(): { topic: string; partition: number }[];
  seek(tpo: { topic: string; partition: number; offset: string }): void;
  commitOffsets(offsets: { topic: string; partition: number; offset: string }[]): Promise<void>;
}
interface KafkaAdmin {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTopics(options: { topics: { topic: string; numPartitions?: number; replicationFactor?: number; configEntries?: { name: string; value: string }[] }[]; timeout?: number }): Promise<boolean>;
  deleteTopics(options: { topics: string[]; timeout?: number }): Promise<void>;
  listTopics(options?: { timeout?: number }): Promise<string[]>;
  fetchTopicOffsets(topic: string, options?: { timeout?: number }): Promise<{ partition: number; offset: string; high: string; low: string }[]>;
  fetchOffsets(options: { groupId: string; topics?: string[]; timeout?: number }): Promise<{ topic: string; partitions: { partition: number; offset: string }[] }[]>;
  describeGroups(groups: string[], options?: { timeout?: number }): Promise<{ groups: { groupId: string; state: number | string; members: unknown[] }[] }>;
}

/** Bounds outstanding deliveries per subscription (`ConsumeOptions.prefetch`). */
class Semaphore {
  private waiters: ((ok: boolean) => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  acquire(): Promise<boolean> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(true);
    else this.active--;
  }
  /** Wake every waiter with `false`. */
  drain(): void {
    for (const w of this.waiters.splice(0)) w(false);
  }
}

interface Held {
  topic: string;
  partition: number;
  offset: number;
  key: Buffer | null;
  headers: Record<string, string>;
  body: Buffer;
  attempt: number;
}

/** Header values as the client hands them (`Buffer`, string or a list) → one string each. */
export function recordHeaders(headers: KafkaRecord['message']['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (value === undefined) continue;
    out[name] = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRetriableLocal = (error: unknown) => /Local: (Timed out|Broker handle destroyed|Broker transport failure)/.test(String((error as { message?: string })?.message ?? error));
const topicExists = (error: unknown) => /TOPIC_ALREADY_EXISTS|already exists/i.test(JSON.stringify((error as { errors?: unknown[] })?.errors ?? (error as Error)?.message ?? ''));

export class KafkaDriver implements BrokerDriver<KafkaConfig> {
  readonly kind = 'kafka';
  /** Per instance (the Codec keeps a reference): `connect()` applies `config.maxMessageBytes` to it. */
  readonly capabilities: BrokerCapabilities = { ...KAFKA_CAPABILITIES };
  private config?: KafkaConfig;
  private client?: KafkaClient;
  private producer?: KafkaProducer;
  private admin?: KafkaAdmin;
  private state: 'new' | 'connected' | 'closed' = 'new';
  private readonly declared = new Map<string, ChannelSpec>();
  private readonly subscriptions = new Set<{ close(): Promise<void> }>();

  async connect(config: KafkaConfig): Promise<void> {
    if (this.state !== 'new') throw new Error(`kafka driver already ${this.state}`);
    if (!config.brokers?.length) throw new Error('kafka: no brokers configured');
    let mod: KafkaJsModule;
    try {
      mod = ((await import('@confluentinc/kafka-javascript')) as unknown as { KafkaJS: KafkaJsModule }).KafkaJS;
    } catch (error) {
      throw new Error(`kafka: the client library is not installed (pnpm add @confluentinc/kafka-javascript): ${(error as Error).message}`);
    }
    const maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.capabilities.maxMessageBytes = maxMessageBytes;
    const common: Record<string, unknown> = {
      kafkaJS: {
        brokers: config.brokers,
        clientId: config.clientId ?? 'landflow',
        logLevel: mod.logLevel.NOTHING ?? 0,
        ...(config.ssl && { ssl: true }),
        ...(config.sasl && { sasl: { mechanism: config.sasl.mechanism, username: config.sasl.username, password: config.sasl.password } }),
      },
      'broker.address.family': 'v4',
      ...config.rdkafka,
    };
    const client = new mod.Kafka(common);
    const admin = client.admin();
    const producer = client.producer({
      ...common,
      kafkaJS: { ...(common.kafkaJS as object), acks: -1, idempotent: true },
      'message.max.bytes': maxMessageBytes + TOPIC_SIZE_SLACK,
      'message.timeout.ms': config.publishTimeoutMs ?? 30_000,
      'sticky.partitioning.linger.ms': 0,
      'linger.ms': 0,
    });
    try {
      await admin.connect();
      // The client connects lazily: ask for metadata so an unreachable broker rejects here, before anything is sent.
      await admin.listTopics({ timeout: config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
      await producer.connect();
    } catch (error) {
      await Promise.allSettled([admin.disconnect(), producer.disconnect()]);
      throw new Error(`kafka: cannot connect to ${config.brokers.join(',')}: ${(error as Error).message}`);
    }
    this.config = config;
    this.client = client;
    this.admin = admin;
    this.producer = producer;
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    const { admin, config } = this.ensureConnected();
    const maxBytes = String((config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES) + TOPIC_SIZE_SLACK);
    const fresh = channels.filter((spec, i) => !this.declared.has(spec.name) && channels.findIndex((s) => s.name === spec.name) === i);
    if (fresh.length === 0) return;
    const topics = fresh.map((spec) => {
      const shared = spec.delivery === 'shared';
      const retention = spec.ttlMs ?? (spec.durable ? config.retentionMs ?? DEFAULT_RETENTION_MS : EPHEMERAL_RETENTION_MS);
      return {
        topic: spec.name,
        numPartitions: shared ? config.partitions ?? DEFAULT_PARTITIONS : 1,
        replicationFactor: config.replicationFactor ?? -1,
        configEntries: [
          { name: 'retention.ms', value: String(retention) },
          { name: 'max.message.bytes', value: maxBytes },
          ...(spec.durable ? [] : [{ name: 'segment.ms', value: String(Math.max(60_000, Math.min(retention, EPHEMERAL_RETENTION_MS))) }]),
        ],
      };
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.createTopics({ topics, timeout: ADMIN_TIMEOUT_MS });
        break;
      } catch (error) {
        if (topicExists(error)) break;
        if (attempt < 3 && isRetriableLocal(error)) {
          await sleep(100 * attempt);
          continue;
        }
        throw new Error(`kafka: cannot create topics ${topics.map((t) => t.topic).join(', ')}: ${(error as Error).message}`);
      }
    }
    for (const spec of fresh) this.declared.set(spec.name, spec);
  }

  async publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome> {
    const { producer } = this.ensureConnected();
    await producer.send({ topic: channel, messages: [{ key: options?.orderingKey ?? null, value: Buffer.from(event.body), headers: prefixHeaders(event.headers, KAFKA_HEADER_PREFIX) }] });
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const { client, admin, config, producer } = this.ensureConnected();
    const shared = Boolean(options.group);
    const groupId = options.group ?? `lf-bc-${randomBytes(6).toString('hex')}`;
    const protocol = config.groupProtocol ?? 'consumer';
    const semaphore = new Semaphore(Math.max(1, options.prefetch));
    const held = new Set<Held>();
    const committed = new Map<string, number>();
    let closed = false;
    let consumer!: KafkaConsumer;
    const commit = async (topic: string, partition: number, offset: number) => {
      const key = `${topic}/${partition}`;
      if ((committed.get(key) ?? -1) >= offset + 1) return;
      committed.set(key, offset + 1);
      await consumer.commitOffsets([{ topic, partition, offset: String(offset + 1) }]).catch(() => committed.delete(key));
    };
    // A partition about to move to another member: commit the deliveries this consumer still holds on it, so the new
    // owner does not re-read (and re-run) calls that are running here. They keep running; a graceful close re-publishes them.
    const onRebalance = async (error: { code?: number } | null, partitions: { topic: string; partition: number }[]) => {
      if (error?.code !== ERR_REVOKE_PARTITIONS || closed) return;
      const revoked = new Set(partitions.map((p) => `${p.topic}/${p.partition}`));
      for (const record of held) if (revoked.has(`${record.topic}/${record.partition}`)) await commit(record.topic, record.partition, record.offset);
    };
    consumer = client.consumer({
      kafkaJS: {
        brokers: config.brokers,
        clientId: config.clientId ?? 'landflow',
        logLevel: 0,
        ...(config.ssl && { ssl: true }),
        ...(config.sasl && { sasl: { mechanism: config.sasl.mechanism, username: config.sasl.username, password: config.sasl.password } }),
        groupId,
        fromBeginning: shared,
        autoCommit: false,
      },
      'broker.address.family': 'v4',
      'group.protocol': protocol,
      'max.poll.interval.ms': 600_000,
      ...(protocol === 'classic' && { 'session.timeout.ms': 10_000, 'heartbeat.interval.ms': 3_000 }),
      ...config.rdkafka,
      rebalance_cb: onRebalance,
    });
    const republish = (record: Held) =>
      producer.send({ topic: record.topic, messages: [{ key: record.key, value: record.body, headers: { ...record.headers, [ATTEMPT_HEADER]: String(record.attempt + 1) } }] });
    const eachMessage = async ({ topic, partition, message }: KafkaRecord) => {
      if (closed) return;
      if (shared && options.ackMode === 'manual' && !(await semaphore.acquire())) return;
      if (closed) {
        if (shared && options.ackMode === 'manual') semaphore.release();
        return;
      }
      const rawHeaders = recordHeaders(message.headers);
      const attempt = Number(rawHeaders[ATTEMPT_HEADER]) || 1;
      const body = message.value ?? Buffer.alloc(0);
      const event: WireEvent = { headers: unprefixHeaders(rawHeaders, KAFKA_HEADER_PREFIX), body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
      const offset = Number(message.offset);
      const manual = shared && options.ackMode === 'manual';
      const record: Held = { topic, partition, offset, key: message.key, headers: rawHeaders, body, attempt };
      if (manual) held.add(record);
      let settled = !manual;
      const settle = () => {
        if (settled) return false;
        settled = true;
        held.delete(record);
        semaphore.release();
        return true;
      };
      const delivery: Delivery = {
        attempt,
        ack: async () => {
          if (!settle()) return;
          await commit(topic, partition, offset);
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (requeue && !closed) {
            try {
              await republish(record);
            } catch {
              return; // left uncommitted: a survivor re-reads it
            }
          }
          await commit(topic, partition, offset);
        },
      };
      if (manual) void onEvent(event, delivery).catch(() => delivery.nack({ requeue: false }));
      else await onEvent(event, delivery).catch(() => undefined);
    };
    try {
      await consumer.connect();
      await consumer.subscribe({ topics: [channel] });
      if (!shared) {
        // Position every partition at its current end before the first fetch, so nothing older is replayed and nothing
        // published between now and the assignment is lost (a pending seek is applied when the partition is assigned).
        const ends = await admin.fetchTopicOffsets(channel, { timeout: ADMIN_TIMEOUT_MS });
        for (const p of ends) consumer.seek({ topic: channel, partition: p.partition, offset: p.high });
      }
      await consumer.run({ partitionsConsumedConcurrently: Math.max(1, config.partitions ?? DEFAULT_PARTITIONS), eachMessage });
      const until = Date.now() + (config.assignmentTimeoutMs ?? ASSIGNMENT_TIMEOUT_MS);
      while (consumer.assignment().length === 0 && Date.now() < until) await sleep(20);
    } catch (error) {
      await consumer.disconnect().catch(() => undefined);
      throw new Error(`kafka: cannot consume ${channel} (group ${groupId}): ${(error as Error).message}`);
    }
    const subscription: Subscription & { close(): Promise<void> } = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        semaphore.drain();
        // Hand the unacknowledged deliveries back: commit the originals, leave the group, re-publish them for a survivor.
        const orphans = [...held];
        held.clear();
        for (const record of orphans) await commit(record.topic, record.partition, record.offset);
        await consumer.disconnect().catch(() => undefined);
        for (const record of orphans) await republish(record).catch(() => undefined);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  /** Members of the channel's consumer group and its lag (committed offsets against the end offsets): three admin calls. */
  async stats(channel: string): Promise<ChannelStats> {
    const { admin } = this.ensureConnected();
    const out: ChannelStats = {};
    try {
      const { groups } = await admin.describeGroups([channel], { timeout: ADMIN_TIMEOUT_MS });
      const group = groups[0];
      out.consumers = group && String(group.state).toLowerCase() !== 'dead' && group.state !== 4 ? group.members.length : 0;
    } catch {
      out.consumers = 0;
    }
    try {
      const [ends, committed] = await Promise.all([admin.fetchTopicOffsets(channel, { timeout: ADMIN_TIMEOUT_MS }), admin.fetchOffsets({ groupId: channel, topics: [channel], timeout: ADMIN_TIMEOUT_MS })]);
      const byPartition = new Map(committed.find((t) => t.topic === channel)?.partitions.map((p) => [p.partition, Number(p.offset)]) ?? []);
      let lag = 0;
      for (const p of ends) {
        const done = byPartition.get(p.partition) ?? -1;
        lag += Math.max(0, Number(p.high) - (done < 0 ? Number(p.low) : done));
      }
      out.lag = lag;
      out.depth = lag;
    } catch {
      // the topic may not exist yet
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.state !== 'connected') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    for (const subscription of [...this.subscriptions]) await subscription.close().catch(() => undefined);
    const ephemeral = [...this.declared.values()].filter((spec) => spec.role === 'reply' || spec.role === 'instance').map((spec) => spec.name);
    if (ephemeral.length > 0) await this.admin!.deleteTopics({ topics: ephemeral, timeout: ADMIN_TIMEOUT_MS }).catch(() => undefined);
    this.declared.clear();
    await Promise.allSettled([this.producer!.disconnect(), this.admin!.disconnect()]);
    this.producer = undefined;
    this.admin = undefined;
    this.client = undefined;
  }

  private ensureConnected(): { client: KafkaClient; admin: KafkaAdmin; producer: KafkaProducer; config: KafkaConfig } {
    if (this.state !== 'connected' || !this.client || !this.admin || !this.producer || !this.config) throw new NotConnectedError(`kafka driver is ${this.state === 'new' ? 'not connected' : this.state}`);
    return { client: this.client, admin: this.admin, producer: this.producer, config: this.config };
  }
}

const SASL_MECHANISMS: KafkaSaslMechanism[] = ['plain', 'scram-sha-256', 'scram-sha-512'];

/**
 * Broker list from a connection URL: `kafka://h1:9092,h2:9092`, `kafkas://…` or `kafka+ssl://…` (TLS), or a bare
 * `h1:9092,h2` list; a host without a port gets 9092. A username (and password) turns on SASL with `options.saslMechanism`
 * (default `plain`).
 */
export function kafkaConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): KafkaConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Kafka needs a broker list, e.g. kafka://127.0.0.1:9092');
  const match = /^(?:(kafka|kafkas|kafka\+ssl|kafka\+tls):\/\/)?([^/?#]+)(?:\/.*)?$/i.exec(trimmed);
  if (!match || (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !match[1])) throw new Error(`"${url}" is not a Kafka URL; use kafka://host:port[,host:port…]`);
  const scheme = match[1]?.toLowerCase();
  const ssl = Boolean(options.tls) || (scheme !== undefined && scheme !== 'kafka');
  const brokers = match[2].split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const hostPort = /^(\[[^\]]+\]|[^:@]+)(?::(\d{1,5}))?$/.exec(part);
    if (!hostPort) throw new Error(`"${part}" is not a host:port (credentials belong in the username and password fields)`);
    const port = hostPort[2] ? Number(hostPort[2]) : 9092;
    if (port < 1 || port > 65535) throw new Error(`"${part}" has an invalid port`);
    return `${hostPort[1]}:${port}`;
  });
  if (brokers.length === 0) throw new Error('Kafka needs at least one broker');
  const mechanism = String(options.saslMechanism ?? 'plain').toLowerCase() as KafkaSaslMechanism;
  if (options.username && !SASL_MECHANISMS.includes(mechanism)) throw new Error(`SASL mechanism "${options.saslMechanism}" is not one of ${SASL_MECHANISMS.join(', ')}`);
  return {
    connectionId,
    brokers,
    ...(options.prefix && { prefix: options.prefix }),
    ...(ssl && { ssl: true }),
    ...(options.username && { sasl: { mechanism, username: options.username, password: options.password ?? '' } }),
    ...(typeof options.groupProtocol === 'string' && { groupProtocol: options.groupProtocol as 'consumer' | 'classic' }),
    ...(typeof options.partitions === 'number' && { partitions: options.partitions }),
    ...(typeof options.maxMessageBytes === 'number' && { maxMessageBytes: options.maxMessageBytes }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [kafka({ brokers: ['127.0.0.1:59092'] })] })`. `connectionId` defaults to `env-kafka`. */
export function kafka(config: Omit<KafkaConfig, 'connectionId'> & { connectionId?: string }): BrokerTarget<KafkaConfig> {
  const full: KafkaConfig = { ...config, connectionId: config.connectionId ?? 'env-kafka' };
  return { kind: 'kafka', config: full, driver: () => new KafkaDriver() };
}

const kafkaModule: DriverModule<KafkaConfig> = {
  kind: 'kafka',
  label: 'Kafka',
  capabilities: KAFKA_CAPABILITIES,
  exampleUrl: 'kafka://broker-1:9092,broker-2:9092',
  fields: [{ name: 'saslMechanism', label: 'SASL mechanism', type: 'string', placeholder: 'plain', hint: 'With a username: plain, scram-sha-256 or scram-sha-512' }],
  create: () => new KafkaDriver(),
  configFrom: kafkaConfigFrom,
};

export default kafkaModule;
