/**
 * `@landflow/transports/amqp`: the RabbitMQ driver (AMQP 0-9-1) on `amqplib` (an optional peer dependency imported lazily
 * in `connect()`).
 *
 * Mapping (docs/protocol.md §14.9):
 * - **Shared channels** (request, instance) are **queues** published to through the default exchange. Request queues are
 *   durable **quorum queues** (`x-queue-type: quorum`, so `x-delivery-count` gives true attempts; `queueType: 'classic'`
 *   for brokers without them), with `x-message-ttl` from the spec's `ttlMs` and `x-expires` so an abandoned plugin's
 *   queue goes away after `queueExpiresMs` (default 24 h). Instance queues are durable classic queues that auto-delete
 *   when their one consumer leaves (RabbitMQ 4 refuses transient non-exclusive queues). Consumers compete with
 *   `prefetch = ConsumeOptions.prefetch` on a channel of their own; `nack({ requeue: true })` is `basic.nack` with
 *   requeue; a closed subscription closes its channel, which hands its unacknowledged deliveries back.
 * - **Broadcast channels** (registry, control; the reply channel is unused since replies are native) are durable
 *   **fanout exchanges**; each consumer binds an exclusive, auto-delete, server-named queue (exclusive queues may be
 *   transient) with `x-message-ttl` from the spec.
 * - **Replies are native**: `request()` publishes with `replyTo: amq.rabbitmq.reply-to` (direct reply-to, consumed
 *   `noAck` on the publishing channel) and a driver-private `correlationId`; `Delivery.reply()` publishes to the
 *   request's `replyTo`. Pseudo-queues die with the connection, so a connection loss rejects the requests in flight
 *   (the core reports `connection_lost`, "the call may have run").
 * - **Undeliverable is reported**: every publish is `mandatory` on a confirm channel (a `basic.return` → `unroutable`),
 *   and a publish to a queue first asks the broker for its consumer count (`queue.declare` passive): no consumer, or no
 *   queue, is `unroutable` before anything is sent. The spec's "holds bursts" still holds: a queue with busy consumers
 *   buffers. The core's deadline is the per-message `expiration` (TTL) too.
 * - **CloudEvents AMQP binding**, binary mode: headers under `cloudEvents_<name>`, `content-type` as the `contentType`
 *   property. The content header frame must fit one AMQP frame (`frame_max`, 128 KiB by default), hence `maxHeaderBytes`;
 *   RabbitMQ 4's default `max_message_size` is 16 MiB.
 *
 * Reconnect: on a connection loss the driver reconnects with backoff, recreates its channels and re-establishes every
 * subscription (broadcast consumers get a fresh exclusive queue); `publish()` and `request()` throw `NotConnectedError`
 * while it is down (nothing was sent). `close()` is idempotent. `stats()` is one passive declare (depth and consumers).
 */
import { randomBytes } from 'node:crypto';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Message, Options } from 'amqplib';
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
  type RequestOptions,
  type RequestOutcome,
  type Subscription,
  type WireEvent,
} from '../../driver';
import type { BrokerTarget, ConnectionOptions, DriverModule } from '../index';

/** The CloudEvents AMQP protocol binding's header prefix. */
export const AMQP_HEADER_PREFIX = 'cloudEvents_';
/** RabbitMQ's direct reply-to pseudo-queue. */
export const DIRECT_REPLY_TO = 'amq.rabbitmq.reply-to';
/** RabbitMQ 4's default `max_message_size` (16 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** The content header frame (properties and headers) must fit `frame_max` (128 KiB by default); leave room for the properties. */
export const DEFAULT_MAX_HEADER_BYTES = 120 * 1024;
const DEFAULT_QUEUE_EXPIRES_MS = 24 * 60 * 60_000;
const DEFAULT_HEARTBEAT_SECONDS = 30;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export const AMQP_CAPABILITIES: BrokerCapabilities = {
  replies: 'native',
  workSharing: true,
  buffering: true,
  ttl: true,
  undeliverable: 'reported',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'medium',
  headers: true,
  maxHeaderBytes: DEFAULT_MAX_HEADER_BYTES,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

export interface AmqpConfig extends BrokerConfig {
  /** `amqp://user:pass@host:5672/vhost` or `amqps://…`. */
  url: string;
  /** Credentials, when not in the URL (they replace the URL's). */
  username?: string;
  password?: string;
  /** Force TLS (`amqps`). */
  tls?: boolean;
  /** AMQP heartbeat in seconds (default 30; 0 disables). */
  heartbeatSeconds?: number;
  /** Request queues: `quorum` (default; RabbitMQ ≥ 3.8) or `classic`. */
  queueType?: 'quorum' | 'classic';
  /** Delete a request queue nobody used for this long (`x-expires`; default 24 h; 0 keeps it forever). */
  queueExpiresMs?: number;
  /** Largest event the driver accepts (headers + body); default 16 MiB (RabbitMQ 4's `max_message_size`). */
  maxMessageBytes?: number;
  /** Reconnect backoff bounds (default 1 s … 30 s). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

interface AmqplibModule {
  connect(url: string, socketOptions?: Record<string, unknown>): Promise<ChannelModel>;
}

type Role = 'queue' | 'exchange';

interface LiveSubscription {
  channel: string;
  options: ConsumeOptions;
  onEvent: ConsumeHandler;
  amqp?: Channel;
  consumerTag?: string;
  closed: boolean;
}

interface PendingRequest {
  resolve: (outcome: RequestOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Header table → the bare CloudEvents headers (`content-type` from the `contentType` property). */
export function amqpHeadersToWire(headers: Record<string, unknown> | undefined, contentType: string | undefined): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    raw[name] = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  if (contentType) raw['content-type'] = contentType;
  return unprefixHeaders(raw, AMQP_HEADER_PREFIX);
}

/** The bare CloudEvents headers → `{ headers, contentType }` for `publish()`. */
export function wireToAmqpHeaders(headers: Record<string, string>): { headers: Record<string, string>; contentType?: string } {
  const { 'content-type': contentType, ...prefixed } = prefixHeaders(headers, AMQP_HEADER_PREFIX);
  return { headers: prefixed, ...(contentType && { contentType }) };
}

/** Delivery attempt from a quorum queue's `x-delivery-count` (redeliveries so far) or the `redelivered` flag. */
export function attemptOf(message: Pick<Message, 'fields' | 'properties'>): number {
  const count = message.properties.headers?.['x-delivery-count'];
  if (typeof count === 'number' && Number.isFinite(count)) return count + 1;
  return message.fields.redelivered ? 2 : 1;
}

/** The role of a channel name the driver has not declared itself: `<prefix>.v1.<role>…` (§14.2), queues otherwise. */
export function inferRole(name: string): Role {
  const segments = name.split('.');
  const role = segments[2];
  return role === 'reply' || role === 'registry' || role === 'control' ? 'exchange' : 'queue';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isNotFound = (error: unknown) => (error as { code?: number })?.code === 404 || /NOT_FOUND|404/.test(String((error as Error)?.message));

export class AmqpDriver implements BrokerDriver<AmqpConfig> {
  readonly kind = 'amqp';
  /** Per instance (the Codec keeps a reference): `connect()` applies `config.maxMessageBytes` to it. */
  readonly capabilities: BrokerCapabilities = { ...AMQP_CAPABILITIES };
  private config?: AmqpConfig;
  private lib?: AmqplibModule;
  private connection?: ChannelModel;
  /** Confirm channel for every publish and request; also consumes the direct reply-to pseudo-queue. */
  private pub?: ConfirmChannel;
  /** Declares and passive checks; recreated when a 404 closes it. */
  private ctl?: Channel;
  private state: 'new' | 'connected' | 'reconnecting' | 'closed' = 'new';
  private readonly declared = new Map<string, ChannelSpec>();
  private readonly roles = new Map<string, Role>();
  private readonly subscriptions = new Set<LiveSubscription>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly returned = new Set<string>();
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;

  async connect(config: AmqpConfig): Promise<void> {
    if (this.state !== 'new') throw new Error(`amqp driver already ${this.state}`);
    if (!config.url) throw new Error('amqp: no url configured');
    try {
      this.lib = (await import('amqplib')) as unknown as AmqplibModule;
    } catch (error) {
      throw new Error(`amqp: the client library is not installed (pnpm add amqplib): ${(error as Error).message}`);
    }
    this.config = config;
    this.capabilities.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    try {
      await this.open();
    } catch (error) {
      this.state = 'new';
      throw new Error(`amqp: cannot connect to ${redact(config.url)}: ${(error as Error).message}`);
    }
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureConnected();
    for (const spec of channels) {
      if (this.declared.has(spec.name)) continue;
      await this.declareOne(spec);
      this.declared.set(spec.name, spec);
      this.roles.set(spec.name, spec.delivery === 'shared' ? 'queue' : 'exchange');
    }
  }

  async publish(channel: string, event: WireEvent, options: PublishOptions = {}): Promise<PublishOutcome> {
    const { pub } = this.ensureConnected();
    const role = await this.roleOf(channel);
    if (role === 'queue' && !(await this.hasConsumers(channel))) return 'unroutable';
    const spec = this.declared.get(channel);
    return this.send(pub, role, channel, event, { persistent: spec?.durable ?? role === 'queue', ...(options.ttlMs !== undefined && { expiration: String(Math.max(1, Math.floor(options.ttlMs))) }) });
  }

  async request(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome> {
    const { pub } = this.ensureConnected();
    const role = await this.roleOf(channel);
    if (role === 'queue' && !(await this.hasConsumers(channel))) return { outcome: 'unroutable' };
    const correlationId = randomBytes(12).toString('hex');
    const spec = this.declared.get(channel);
    return new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ outcome: 'timeout' });
      }, options.timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
      this.send(pub, role, channel, event, { persistent: spec?.durable ?? role === 'queue', replyTo: DIRECT_REPLY_TO, correlationId, expiration: String(Math.max(1, Math.floor(options.timeoutMs))) })
        .then((outcome) => {
          if (outcome === 'unroutable' && this.pending.delete(correlationId)) {
            clearTimeout(timer);
            resolve({ outcome: 'unroutable' });
          }
        })
        .catch((error) => {
          if (this.pending.delete(correlationId)) {
            clearTimeout(timer);
            reject(error);
          }
        });
    });
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureConnected();
    const live: LiveSubscription = { channel, options, onEvent, closed: false };
    await this.startConsumer(live);
    this.subscriptions.add(live);
    return {
      channel,
      close: async () => {
        if (live.closed) return;
        live.closed = true;
        this.subscriptions.delete(live);
        // Closing the channel returns its unacknowledged deliveries to the queue, as a dead consumer's would be.
        await live.amqp?.close().catch(() => undefined);
        live.amqp = undefined;
      },
    };
  }

  async stats(channel: string): Promise<ChannelStats> {
    this.ensureConnected();
    if ((await this.roleOf(channel)) === 'exchange') return {};
    const reply = await this.checkQueue(channel);
    return reply ? { depth: reply.messageCount, consumers: reply.consumerCount } : { depth: 0, consumers: 0 };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const wasOpen = this.state !== 'new';
    this.state = 'closed';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failPending(new Error('amqp driver closed'));
    for (const live of [...this.subscriptions]) {
      live.closed = true;
      await live.amqp?.close().catch(() => undefined);
    }
    this.subscriptions.clear();
    if (wasOpen && this.connection) {
      const connection = this.connection;
      this.connection = undefined;
      this.pub = undefined;
      this.ctl = undefined;
      await connection.close().catch(() => undefined);
    }
    this.declared.clear();
  }

  // --- connection lifecycle -------------------------------------------------------------------------------------------

  private async open(): Promise<void> {
    const config = this.config!;
    const connection = await this.lib!.connect(connectionUrl(config), { heartbeat: config.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS });
    connection.on('error', () => undefined);
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.pub = undefined;
      this.ctl = undefined;
      if (this.state === 'closed') return;
      this.state = 'reconnecting';
      this.failPending(new Error('amqp connection lost; the call may have run'));
      for (const live of this.subscriptions) live.amqp = undefined;
      this.scheduleReconnect();
    });
    const pub = await connection.createConfirmChannel();
    pub.on('error', () => undefined);
    pub.on('return', (message: Message) => {
      if (message.properties.messageId) this.returned.add(message.properties.messageId);
    });
    await pub.consume(DIRECT_REPLY_TO, (message) => message && this.onReply(message), { noAck: true });
    const ctl = await connection.createChannel();
    ctl.on('error', () => undefined);
    this.connection = connection;
    this.pub = pub;
    this.ctl = ctl;
  }

  private scheduleReconnect(): void {
    const config = this.config!;
    const min = config.reconnectMinMs ?? RECONNECT_MIN_MS;
    const max = config.reconnectMaxMs ?? RECONNECT_MAX_MS;
    const delay = Math.min(max, min * 2 ** Math.min(this.reconnectAttempt++, 10));
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.state !== 'reconnecting') return;
    try {
      await this.open();
      // Re-declare what this driver declared (exchanges and queues may have been lost with a broker restart), then resume.
      for (const spec of this.declared.values()) await this.declareOne(spec).catch(() => undefined);
      for (const live of this.subscriptions) if (!live.closed) await this.startConsumer(live).catch(() => undefined);
      this.reconnectAttempt = 0;
      this.state = 'connected';
    } catch {
      if (this.state === 'reconnecting') this.scheduleReconnect();
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onReply(message: ConsumeMessage): void {
    const id = message.properties.correlationId;
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve({ outcome: 'replied', event: toWire(message) });
  }

  // --- declaring ------------------------------------------------------------------------------------------------------

  private async declareOne(spec: ChannelSpec): Promise<void> {
    const config = this.config!;
    let ctl = await this.control();
    if (spec.delivery === 'broadcast') {
      await ctl.assertExchange(spec.name, 'fanout', { durable: true, autoDelete: false });
      return;
    }
    // "Create or verify": a queue the other side already declared (possibly with another queue type, or the core
    // declaring an instance queue with a request spec) is left as it is; asserting it with other arguments would be 406.
    if (await this.checkQueue(spec.name)) return;
    ctl = await this.control();
    if (spec.durable) {
      const quorum = (config.queueType ?? 'quorum') === 'quorum';
      const expires = config.queueExpiresMs ?? DEFAULT_QUEUE_EXPIRES_MS;
      await ctl.assertQueue(spec.name, {
        durable: true,
        arguments: {
          ...(quorum && { 'x-queue-type': 'quorum' }),
          ...(spec.ttlMs !== undefined && { 'x-message-ttl': spec.ttlMs }),
          ...(expires > 0 && { 'x-expires': expires }),
        },
      });
    } else {
      await ctl.assertQueue(spec.name, { durable: true, autoDelete: true, arguments: { ...(spec.ttlMs !== undefined && { 'x-message-ttl': spec.ttlMs }) } });
    }
  }

  private async roleOf(channel: string): Promise<Role> {
    const known = this.roles.get(channel);
    if (known) return known;
    const role = inferRole(channel);
    // A broadcast exchange the publisher never declared (a cancel to a plugin that is gone): assert it so the publish
    // does not close the channel with 404; a queue is checked passively at publish time instead.
    if (role === 'exchange') await (await this.control()).assertExchange(channel, 'fanout', { durable: true, autoDelete: false });
    this.roles.set(channel, role);
    return role;
  }

  private async control(): Promise<Channel> {
    if (this.ctl) return this.ctl;
    if (!this.connection) throw new NotConnectedError('amqp connection is down');
    const ctl = await this.connection.createChannel();
    ctl.on('error', () => undefined);
    ctl.on('close', () => {
      if (this.ctl === ctl) this.ctl = undefined;
    });
    this.ctl = ctl;
    return ctl;
  }

  /** `queue.declare` passive; undefined when the queue does not exist (which closes the channel: it is recreated lazily). */
  private async checkQueue(name: string): Promise<{ messageCount: number; consumerCount: number } | undefined> {
    const ctl = await this.control();
    try {
      return await ctl.checkQueue(name);
    } catch (error) {
      if (this.ctl === ctl) this.ctl = undefined;
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async hasConsumers(queue: string): Promise<boolean> {
    const reply = await this.checkQueue(queue);
    return (reply?.consumerCount ?? 0) > 0;
  }

  // --- publishing -----------------------------------------------------------------------------------------------------

  /** Publish `mandatory` on the confirm channel; `unroutable` when the broker returned it before confirming. */
  private send(pub: ConfirmChannel, role: Role, channel: string, event: WireEvent, options: Options.Publish): Promise<PublishOutcome> {
    const messageId = randomBytes(8).toString('hex');
    const { headers, contentType } = wireToAmqpHeaders(event.headers);
    const publishOptions: Options.Publish = { ...options, mandatory: true, messageId, headers, ...(contentType && { contentType }) };
    const [exchange, routingKey] = role === 'queue' ? ['', channel] : [channel, ''];
    return new Promise<PublishOutcome>((resolve, reject) => {
      try {
        pub.publish(exchange, routingKey, Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength), publishOptions, (error) => {
          const returned = this.returned.delete(messageId);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve(returned ? 'unroutable' : 'accepted');
        });
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  // --- consuming ------------------------------------------------------------------------------------------------------

  private async startConsumer(live: LiveSubscription): Promise<void> {
    if (!this.connection) throw new NotConnectedError('amqp connection is down');
    const { channel, options, onEvent } = live;
    const spec = this.declared.get(channel);
    const role = spec ? (spec.delivery === 'shared' ? 'queue' : 'exchange') : inferRole(channel);
    const shared = role === 'queue' && Boolean(options.group);
    const amqp = await this.connection.createChannel();
    amqp.on('error', () => undefined);
    amqp.on('close', () => {
      if (live.amqp === amqp) live.amqp = undefined;
    });
    live.amqp = amqp;
    let queue = channel;
    if (shared) {
      await amqp.prefetch(Math.max(1, options.prefetch));
    } else {
      // Every consumer gets every event: a private queue bound to the fanout exchange.
      await amqp.assertExchange(channel, 'fanout', { durable: true, autoDelete: false });
      const { queue: name } = await amqp.assertQueue('', { exclusive: true, autoDelete: true, durable: false, arguments: { ...(spec?.ttlMs !== undefined && { 'x-message-ttl': spec.ttlMs }) } });
      await amqp.bindQueue(name, channel, '');
      queue = name;
    }
    const noAck = options.ackMode === 'auto';
    const { consumerTag } = await amqp.consume(
      queue,
      (message) => {
        if (!message || live.closed) return;
        const event = toWire(message);
        let settled = noAck;
        const settle = () => {
          if (settled) return false;
          settled = true;
          return true;
        };
        const delivery: Delivery = {
          attempt: attemptOf(message),
          ack: async () => {
            if (settle() && live.amqp === amqp) amqp.ack(message);
          },
          nack: async ({ requeue = false } = {}) => {
            if (settle() && live.amqp === amqp) amqp.nack(message, false, requeue);
          },
          reply: async (reply: WireEvent) => {
            const { replyTo, correlationId } = message.properties;
            if (!replyTo) throw new Error('the request carries no replyTo');
            const { pub } = this.ensureConnected();
            const { headers, contentType } = wireToAmqpHeaders(reply.headers);
            await new Promise<void>((resolve, reject) => {
              // Never `mandatory`: a direct reply-to name is not a queue, so a return would be the normal outcome.
              pub.publish('', replyTo, Buffer.from(reply.body.buffer, reply.body.byteOffset, reply.body.byteLength), { correlationId, headers, ...(contentType && { contentType }) }, (error) => (error ? reject(error) : resolve()));
            });
          },
        };
        void onEvent(event, delivery).catch(() => delivery.nack({ requeue: false }));
      },
      { noAck },
    );
    live.consumerTag = consumerTag;
  }

  private ensureConnected(): { pub: ConfirmChannel } {
    if (this.state !== 'connected' || !this.pub) throw new NotConnectedError(`amqp driver is ${this.state === 'new' ? 'not connected' : this.state}`);
    return { pub: this.pub };
  }
}

const toWire = (message: Message): WireEvent => ({ headers: amqpHeadersToWire(message.properties.headers, message.properties.contentType), body: new Uint8Array(message.content.buffer, message.content.byteOffset, message.content.byteLength) });

/** The URL to dial: `config.url` with `username`/`password`/`tls` applied. */
export function connectionUrl(config: AmqpConfig): string {
  const url = new URL(config.url);
  if (config.tls) url.protocol = 'amqps:';
  if (config.username !== undefined) url.username = encodeURIComponent(config.username);
  if (config.password !== undefined) url.password = encodeURIComponent(config.password);
  return url.toString();
}

const redact = (url: string) => {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
};

/**
 * Connection config from `amqp://[user:pass@]host[:5672][/vhost]` or `amqps://…` (`amqp+ssl://` works too). The
 * username and password fields win over the URL's; `tls` forces `amqps`. Readable errors for anything else.
 */
export function amqpConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): AmqpConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('RabbitMQ needs a URL, e.g. amqp://user:password@127.0.0.1:5672/');
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/^amqp\+(ssl|tls):\/\//i, 'amqps://'));
  } catch {
    throw new Error(`"${url}" is not a URL; use amqp://user:password@host:5672/vhost`);
  }
  if (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') throw new Error(`"${url}" must start with amqp:// or amqps://`);
  if (!parsed.hostname) throw new Error(`"${url}" has no host`);
  const tls = Boolean(options.tls) || parsed.protocol === 'amqps:';
  if (tls) parsed.protocol = 'amqps:';
  const queueType = options.queueType === 'classic' ? 'classic' : undefined;
  return {
    connectionId,
    url: parsed.toString(),
    ...(options.username !== undefined && options.username !== '' && { username: options.username, password: options.password ?? '' }),
    ...(tls && { tls: true }),
    ...(options.prefix && { prefix: options.prefix }),
    ...(queueType && { queueType }),
    ...(typeof options.maxMessageBytes === 'number' && { maxMessageBytes: options.maxMessageBytes }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [amqp({ url: 'amqp://user:pass@127.0.0.1:55672/' })] })`. `connectionId` defaults to `env-amqp`. */
export function amqp(config: Omit<AmqpConfig, 'connectionId'> & { connectionId?: string }): BrokerTarget<AmqpConfig> {
  const full: AmqpConfig = { ...config, connectionId: config.connectionId ?? 'env-amqp' };
  return { kind: 'amqp', config: full, driver: () => new AmqpDriver() };
}

const amqpModule: DriverModule<AmqpConfig> = {
  kind: 'amqp',
  label: 'RabbitMQ (AMQP 0-9-1)',
  capabilities: AMQP_CAPABILITIES,
  exampleUrl: 'amqp://user:password@rabbitmq:5672/',
  create: () => new AmqpDriver(),
  configFrom: amqpConfigFrom,
};

export default amqpModule;
