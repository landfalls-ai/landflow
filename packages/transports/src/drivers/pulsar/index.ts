/**
 * `@landflow/transports/pulsar`: the Apache Pulsar driver on `pulsar-client` (the Apache Node.js client, a Node-API addon
 * over the C++ client with prebuilt binaries for macOS, Linux glibc and musl on x64 and arm64; an optional peer dependency
 * imported lazily in `connect()`).
 *
 * Mapping (docs/protocol.md §14.9):
 * - A **persistent topic per channel**, `persistent://<tenant>/<namespace>/<channel>` (default `public/default`; channel
 *   names need no translation). CloudEvents binary mode: attributes as message **properties** under `ce_<name>`,
 *   `content-type` bare; `PublishOptions.orderingKey` becomes the partition key (used on partitioned topics only, so
 *   ordering is not claimed: a Shared subscription spreads a key over its consumers).
 * - **Shared channels** (request, instance): a durable **Shared subscription** named after the group (the core uses the
 *   channel name), created in `declare()` so the topic buffers events published before the first consumer. Each consumer
 *   pulls with `receiverQueueSize = prefetch` and hands the core at most `prefetch` unacknowledged deliveries at once.
 *   `ack()` acknowledges; `nack({ requeue: true })` negative-acknowledges (redelivered to any consumer of the subscription
 *   after `nackRedeliveryDelayMs`, 100 ms by default, with `redeliveryCount + 1` as the attempt); `nack({ requeue: false })`
 *   acknowledges (drops). A closing subscription negative-acknowledges what it still holds before closing its consumer,
 *   so a survivor gets those deliveries with a truthful attempt; what a hard-killed process held is redelivered by the
 *   broker as attempt 1 (Pulsar does not count that redelivery).
 * - **Broadcast channels** (reply, registry, control): a non-durable **reader** per consumer positioned at the latest
 *   message, so nothing older is replayed and no subscription is left behind.
 * - **Replies** go through a reply topic per host (`reply-channel`); the core correlates.
 * - **TTL** is a namespace or topic policy in Pulsar (seconds), not a message attribute: not claimed; the core's deadline
 *   governs. **"Nobody took it"** is inferred from the admin API when `adminUrl` is set (`stats()`: the subscription's
 *   consumers and backlog); without it `stats()` returns `{}` and the core waits for the deadline.
 * - `maxMessageBytes` defaults to Pulsar's `maxMessageSize` (5 MB). `close()` deletes the per-process reply and instance
 *   topics it declared when `adminUrl` is set.
 *
 * The C++ client reconnects on its own; `NotConnectedError` is thrown only before `connect()` and after `close()`.
 * `connect()` opens (and closes) a producer on a non-persistent probe topic so an unreachable broker rejects within
 * `connectTimeoutMs` before anything is sent.
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

/** The CloudEvents header prefix on Pulsar message properties (as Kafka's binding). */
export const PULSAR_HEADER_PREFIX = 'ce_';
/** Pulsar's default broker `maxMessageSize` (5 MB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TENANT = 'public';
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_NACK_DELAY_MS = 100;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const RECEIVE_POLL_MS = 500;
const ADMIN_TIMEOUT_MS = 10_000;

export const PULSAR_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: false,
  undeliverable: 'inferred',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'medium',
  headers: true,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

export interface PulsarConfig extends BrokerConfig {
  /** `pulsar://host:6650` or `pulsar+ssl://host:6651`. */
  serviceUrl: string;
  /** The admin REST API (`http://host:8080`); enables `stats()` (consumers, backlog) and topic deletion on `close()`. */
  adminUrl?: string;
  /** Topic tenant and namespace (default `public` / `default`); the namespace must exist. */
  tenant?: string;
  namespace?: string;
  /** A JWT for token authentication (sent to the admin API as a bearer token too). */
  token?: string;
  /** TLS trust store and hostname checks for `pulsar+ssl://`. */
  tlsTrustCertsFilePath?: string;
  tlsAllowInsecureConnection?: boolean;
  tlsValidateHostname?: boolean;
  /** Largest event the driver accepts (headers + body); default 5 MB (the broker's `maxMessageSize`). */
  maxMessageBytes?: number;
  /** How long a negatively acknowledged event waits before the broker redelivers it (default 100 ms). */
  nackRedeliveryDelayMs?: number;
  /** Redeliver what a consumer holds unacknowledged for this long (0, the default, disables it; the minimum is 10 s). */
  ackTimeoutMs?: number;
  /** How long `connect()` waits for the broker before giving up (default 10 s). */
  connectTimeoutMs?: number;
  /** The client's operation timeout for producer and consumer creation and sends (default 30 s). */
  operationTimeoutMs?: number;
}

/** The subset of `pulsar-client` the driver uses (typed loosely: the library is loaded lazily and may be absent). */
interface PulsarModule {
  Client: (new (config: Record<string, unknown>) => PulsarClient) & { setLogHandler(handler: (...args: unknown[]) => void): void };
  MessageId: { latest(): unknown };
  AuthenticationToken: new (params: { token: string }) => unknown;
}
interface PulsarClient {
  createProducer(config: Record<string, unknown>): Promise<PulsarProducer>;
  subscribe(config: Record<string, unknown>): Promise<PulsarConsumer>;
  createReader(config: Record<string, unknown>): Promise<PulsarReader>;
  close(): Promise<unknown>;
}
interface PulsarProducer {
  send(message: { data: Buffer; properties?: Record<string, string>; partitionKey?: string }): Promise<unknown>;
  close(): Promise<unknown>;
}
interface PulsarMessage {
  getProperties(): Record<string, string>;
  getData(): Buffer;
  getRedeliveryCount(): number;
}
interface PulsarConsumer {
  receive(timeoutMs?: number): Promise<PulsarMessage>;
  acknowledge(message: PulsarMessage): Promise<unknown>;
  negativeAcknowledge(message: PulsarMessage): void;
  close(): Promise<unknown>;
}
interface PulsarReader {
  close(): Promise<unknown>;
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
  drain(): void {
    for (const w of this.waiters.splice(0)) w(false);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isTimeout = (error: unknown) => /TimeOut|Timeout|timed out/i.test(String((error as Error)?.message ?? error));

/** The full topic name of a channel. */
export function topicName(config: Pick<PulsarConfig, 'tenant' | 'namespace'>, channel: string, persistent = true): string {
  return `${persistent ? 'persistent' : 'non-persistent'}://${config.tenant ?? DEFAULT_TENANT}/${config.namespace ?? DEFAULT_NAMESPACE}/${channel}`;
}

/** The admin REST path of a channel's topic (`persistent/public/default/<channel>`). */
export function adminTopicPath(config: Pick<PulsarConfig, 'tenant' | 'namespace'>, channel: string): string {
  return `persistent/${encodeURIComponent(config.tenant ?? DEFAULT_TENANT)}/${encodeURIComponent(config.namespace ?? DEFAULT_NAMESPACE)}/${encodeURIComponent(channel)}`;
}

export class PulsarDriver implements BrokerDriver<PulsarConfig> {
  readonly kind = 'pulsar';
  /** Per instance (the Codec keeps a reference): `connect()` applies `config.maxMessageBytes` to it. */
  readonly capabilities: BrokerCapabilities = { ...PULSAR_CAPABILITIES };
  private config?: PulsarConfig;
  private lib?: PulsarModule;
  private client?: PulsarClient;
  private state: 'new' | 'connected' | 'closed' = 'new';
  private readonly declared = new Map<string, ChannelSpec>();
  private readonly producers = new Map<string, Promise<PulsarProducer>>();
  private readonly subscriptions = new Set<{ close(): Promise<void> }>();

  async connect(config: PulsarConfig): Promise<void> {
    if (this.state !== 'new') throw new Error(`pulsar driver already ${this.state}`);
    if (!config.serviceUrl) throw new Error('pulsar: no serviceUrl configured');
    let lib: PulsarModule;
    try {
      const mod = (await import('pulsar-client')) as unknown as PulsarModule & { default?: PulsarModule };
      lib = mod.default?.Client ? mod.default : mod;
    } catch (error) {
      throw new Error(`pulsar: the client library is not installed (pnpm add pulsar-client): ${(error as Error).message}`);
    }
    this.capabilities.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const client = new lib.Client({
      serviceUrl: config.serviceUrl,
      operationTimeoutSeconds: Math.max(1, Math.ceil((config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS) / 1000)),
      connectionTimeoutMs: connectTimeoutMs,
      log: () => undefined,
      ...(config.token && { authentication: new lib.AuthenticationToken({ token: config.token }) }),
      ...(config.tlsTrustCertsFilePath && { tlsTrustCertsFilePath: config.tlsTrustCertsFilePath }),
      ...(config.tlsAllowInsecureConnection !== undefined && { tlsAllowInsecureConnection: config.tlsAllowInsecureConnection }),
      ...(config.tlsValidateHostname !== undefined && { tlsValidateHostname: config.tlsValidateHostname }),
    });
    // The client connects lazily: open a producer on a non-persistent probe topic (auto-deleted when idle) so an
    // unreachable broker rejects here, before anything is sent.
    try {
      const probe = await withTimeout(client.createProducer({ topic: topicName(config, `${config.prefix ?? 'landflow'}-probe-${randomBytes(4).toString('hex')}`, false), sendTimeoutMs: connectTimeoutMs }), connectTimeoutMs, 'connect');
      await probe.close().catch(() => undefined);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`pulsar: cannot connect to ${config.serviceUrl}: ${(error as Error).message}`);
    }
    this.config = config;
    this.lib = lib;
    this.client = client;
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    const { client, config } = this.ensureConnected();
    for (const spec of channels) {
      if (this.declared.has(spec.name)) continue;
      const topic = topicName(config, spec.name);
      if (spec.delivery === 'shared') {
        // A durable subscription named after the channel (the core's group) so the topic retains events for it.
        const consumer = await client.subscribe({ topic, subscription: spec.name, subscriptionType: 'Shared', subscriptionInitialPosition: 'Earliest', receiverQueueSize: 0 });
        await consumer.close();
      } else {
        await this.producerFor(spec.name);
      }
      this.declared.set(spec.name, spec);
    }
  }

  async publish(channel: string, event: WireEvent, options: PublishOptions = {}): Promise<PublishOutcome> {
    this.ensureConnected();
    const producer = await this.producerFor(channel);
    await producer.send({
      data: Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength),
      properties: prefixHeaders(event.headers, PULSAR_HEADER_PREFIX),
      ...(options.orderingKey && { partitionKey: options.orderingKey }),
    });
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const { client, lib, config } = this.ensureConnected();
    const topic = topicName(config, channel);
    let closed = false;
    let stop: () => Promise<void>;
    if (!options.group) {
      // Broadcast: a reader from the latest message; nothing older is replayed, nothing is left behind on close.
      const reader = await client.createReader({
        topic,
        startMessageId: lib.MessageId.latest(),
        receiverQueueSize: Math.max(1, options.prefetch),
        listener: (message: PulsarMessage) => {
          if (closed) return;
          void onEvent(toWire(message), { attempt: 1, ack: async () => undefined, nack: async () => undefined }).catch(() => undefined);
        },
      });
      stop = () => reader.close().then(() => undefined);
    } else {
      const manual = options.ackMode === 'manual';
      const prefetch = Math.max(1, options.prefetch);
      const nackDelay = config.nackRedeliveryDelayMs ?? DEFAULT_NACK_DELAY_MS;
      const consumer = await client.subscribe({
        topic,
        subscription: options.group,
        subscriptionType: 'Shared',
        subscriptionInitialPosition: 'Earliest',
        receiverQueueSize: prefetch,
        nAckRedeliverTimeoutMs: nackDelay,
        ...(config.ackTimeoutMs && { ackTimeoutMs: Math.max(10_000, config.ackTimeoutMs) }),
      });
      const semaphore = new Semaphore(prefetch);
      const held = new Set<{ message: PulsarMessage; settle: () => boolean }>();
      const loop = (async () => {
        while (!closed) {
          if (manual && !(await semaphore.acquire())) return;
          if (closed) {
            if (manual) semaphore.release();
            return;
          }
          let message: PulsarMessage;
          try {
            message = await consumer.receive(RECEIVE_POLL_MS);
          } catch (error) {
            if (manual) semaphore.release();
            if (closed) return;
            if (!isTimeout(error)) await sleep(50);
            continue;
          }
          if (!manual) {
            await consumer.acknowledge(message).catch(() => undefined);
            await onEvent(toWire(message), { attempt: message.getRedeliveryCount() + 1, ack: async () => undefined, nack: async () => undefined }).catch(() => undefined);
            continue;
          }
          let settled = false;
          const record = {
            message,
            settle: () => {
              if (settled) return false;
              settled = true;
              held.delete(record);
              semaphore.release();
              return true;
            },
          };
          held.add(record);
          const delivery: Delivery = {
            attempt: message.getRedeliveryCount() + 1,
            ack: async () => {
              if (record.settle()) await consumer.acknowledge(message).catch(() => undefined);
            },
            nack: async ({ requeue = false } = {}) => {
              if (!record.settle()) return;
              if (requeue) consumer.negativeAcknowledge(message);
              else await consumer.acknowledge(message).catch(() => undefined);
            },
          };
          void onEvent(toWire(message), delivery).catch(() => delivery.nack({ requeue: false }));
        }
      })();
      stop = async () => {
        semaphore.drain();
        // Hand the deliveries still held to a survivor with a truthful attempt: negative-acknowledge them and let the
        // client send the redelivery request before the consumer goes away.
        const orphans = [...held];
        held.clear();
        for (const record of orphans) {
          record.settle();
          consumer.negativeAcknowledge(record.message);
        }
        if (orphans.length > 0) await sleep(nackDelay + 50);
        await loop.catch(() => undefined);
        await consumer.close();
      };
    }
    const subscription: Subscription & { close(): Promise<void> } = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        await stop().catch(() => undefined);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  /** The channel's subscription through the admin API: its consumers and backlog. `{}` without `adminUrl`. */
  async stats(channel: string): Promise<ChannelStats> {
    const { config } = this.ensureConnected();
    if (!config.adminUrl) return {};
    const response = await adminFetch(config, `${adminTopicPath(config, channel)}/stats`);
    if (response.status === 404) return { consumers: 0, depth: 0 };
    if (!response.ok) throw new Error(`pulsar: admin API answered ${response.status} for ${channel}`);
    const body = (await response.json()) as { subscriptions?: Record<string, { consumers?: unknown[]; msgBacklog?: number }> };
    const subscription = body.subscriptions?.[channel];
    return { consumers: subscription?.consumers?.length ?? 0, depth: subscription?.msgBacklog ?? 0 };
  }

  async close(): Promise<void> {
    if (this.state !== 'connected') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    for (const subscription of [...this.subscriptions]) await subscription.close().catch(() => undefined);
    for (const producer of this.producers.values()) await producer.then((p) => p.close()).catch(() => undefined);
    this.producers.clear();
    const config = this.config!;
    if (config.adminUrl) {
      const ephemeral = [...this.declared.values()].filter((spec) => spec.role === 'reply' || spec.role === 'instance');
      for (const spec of ephemeral) await adminFetch(config, `${adminTopicPath(config, spec.name)}?force=true`, 'DELETE').catch(() => undefined);
    }
    this.declared.clear();
    await this.client!.close().catch(() => undefined);
    this.client = undefined;
  }

  private producerFor(channel: string): Promise<PulsarProducer> {
    const { client, config } = this.ensureConnected();
    let pending = this.producers.get(channel);
    if (!pending) {
      pending = client.createProducer({ topic: topicName(config, channel), sendTimeoutMs: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, batchingEnabled: false, blockIfQueueFull: true });
      this.producers.set(channel, pending);
      pending.catch(() => this.producers.delete(channel));
    }
    return pending;
  }

  private ensureConnected(): { client: PulsarClient; lib: PulsarModule; config: PulsarConfig } {
    if (this.state !== 'connected' || !this.client || !this.lib || !this.config) throw new NotConnectedError(`pulsar driver is ${this.state === 'new' ? 'not connected' : this.state}`);
    return { client: this.client, lib: this.lib, config: this.config };
  }
}

const toWire = (message: PulsarMessage): WireEvent => {
  const data = message.getData();
  return { headers: unprefixHeaders(message.getProperties(), PULSAR_HEADER_PREFIX), body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then((v) => resolve(v), reject).finally(() => clearTimeout(timer));
  });
}

function adminFetch(config: PulsarConfig, path: string, method = 'GET'): Promise<Response> {
  return fetch(`${config.adminUrl!.replace(/\/+$/, '')}/admin/v2/${path}`, { method, signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS), headers: config.token ? { authorization: `Bearer ${config.token}` } : {} });
}

const NAME_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Connection config from `pulsar://host:6650` or `pulsar+ssl://host:6651` (`pulsars://` works too; `tls` forces TLS).
 * The password field is a JWT for token authentication; the `adminUrl`, `tenant` and `namespace` fields are the
 * driver's own.
 */
export function pulsarConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): PulsarConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Pulsar needs a service URL, e.g. pulsar://127.0.0.1:6650');
  const match = /^(pulsar|pulsar\+ssl|pulsars):\/\/([^/?#@]+)\/?$/i.exec(trimmed);
  if (!match) throw new Error(`"${url}" is not a Pulsar service URL; use pulsar://host:6650 or pulsar+ssl://host:6651 (the token goes in the password field)`);
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(match[2]);
  if (!hostPort) throw new Error(`"${match[2]}" is not a host:port`);
  const tls = Boolean(options.tls) || match[1].toLowerCase() !== 'pulsar';
  const port = hostPort[2] ? Number(hostPort[2]) : tls ? 6651 : 6650;
  if (port < 1 || port > 65535) throw new Error(`"${match[2]}" has an invalid port`);
  const tenant = typeof options.tenant === 'string' && options.tenant.trim() ? options.tenant.trim() : undefined;
  const namespace = typeof options.namespace === 'string' && options.namespace.trim() ? options.namespace.trim() : undefined;
  for (const [what, value] of [['tenant', tenant], ['namespace', namespace]] as const) if (value && !NAME_SEGMENT.test(value)) throw new Error(`Pulsar ${what} "${value}" must be 1–64 characters of letters, digits, ".", "_" or "-"`);
  let adminUrl: string | undefined;
  if (typeof options.adminUrl === 'string' && options.adminUrl.trim()) {
    adminUrl = options.adminUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/?#]+$/i.test(adminUrl)) throw new Error(`Pulsar admin URL "${options.adminUrl}" must be http(s)://host:port`);
  }
  return {
    connectionId,
    serviceUrl: `${tls ? 'pulsar+ssl' : 'pulsar'}://${hostPort[1]}:${port}`,
    ...(options.prefix && { prefix: options.prefix }),
    ...(adminUrl && { adminUrl }),
    ...(tenant && { tenant }),
    ...(namespace && { namespace }),
    ...(options.password && { token: options.password }),
    ...(typeof options.maxMessageBytes === 'number' && { maxMessageBytes: options.maxMessageBytes }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [pulsar({ serviceUrl: 'pulsar://127.0.0.1:56650' })] })`. `connectionId` defaults to `env-pulsar`. */
export function pulsar(config: Omit<PulsarConfig, 'connectionId'> & { connectionId?: string }): BrokerTarget<PulsarConfig> {
  const full: PulsarConfig = { ...config, connectionId: config.connectionId ?? 'env-pulsar' };
  return { kind: 'pulsar', config: full, driver: () => new PulsarDriver() };
}

const pulsarModule: DriverModule<PulsarConfig> = {
  kind: 'pulsar',
  label: 'Apache Pulsar',
  capabilities: PULSAR_CAPABILITIES,
  exampleUrl: 'pulsar://pulsar:6650',
  fields: [
    { name: 'adminUrl', label: 'Admin URL', type: 'string', placeholder: 'http://pulsar:8080', hint: 'The admin REST API: consumer counts for "nobody took it" and cleanup of per-process topics' },
    { name: 'tenant', label: 'Tenant', type: 'string', placeholder: 'public' },
    { name: 'namespace', label: 'Namespace', type: 'string', placeholder: 'default' },
  ],
  create: () => new PulsarDriver(),
  configFrom: pulsarConfigFrom,
};

export default pulsarModule;
