/**
 * `@landflow/transports/amqp1`: the AMQP 1.0 driver (ActiveMQ Artemis; other AMQP 1.0 brokers that auto-create
 * addresses, such as Qpid Broker-J with suitable settings) on `rhea` (an optional peer dependency imported lazily in
 * `connect()`). `rhea` rather than `rhea-promise`: the driver needs the link-level controls the base library exposes
 * directly (manual credit as prefetch, per-delivery dispositions, dynamic reply nodes) and `rhea` ships its own typings
 * without further dependencies; the promise wrapper adds a dependency and hides exactly those controls.
 *
 * Mapping (docs/protocol.md §14.9):
 * - **Shared channels** (request, instance) are **anycast addresses with a queue of the same name**: senders and receivers
 *   attach with the `queue` terminus capability, so Artemis auto-creates the address and its queue on first use (and the
 *   queue buffers while no replica is attached). Competing receivers share it; **prefetch is link credit** (`credit_window`
 *   0 plus manual credit, one unit back per settled delivery).
 * - **Broadcast channels** (registry, control; the reply channel is unused since replies are native) are **multicast
 *   addresses**: senders and receivers attach with the `topic` capability and the broker gives each receiver a volatile
 *   subscription queue, so every consumer gets every event and a publish nobody subscribes to is dropped.
 * - **CloudEvents AMQP binding**, binary mode: attributes are **application properties** under `cloudEvents_<name>`, the
 *   body is a `data` section and `content-type` is the message's `content-type` property.
 * - **Replies are native**: each driver instance opens a **dynamic receiver** (a broker-named temporary queue, deleted
 *   with the connection); `request()` sets `reply-to` to it with a random `correlation-id`, `Delivery.reply()` sends to the
 *   request's `reply-to` with its `correlation-id`. A connection loss rejects the requests in flight (`connection_lost`).
 * - **Settlement**: `ack()` is `accepted`; `nack({ requeue: true })` is `modified { delivery-failed }`, which puts the
 *   message back with its **`delivery-count`** incremented (`attempt` = `delivery-count` + 1); `nack({ requeue: false })`
 *   is `accepted` too (dropping; `rejected` would send the message to the dead-letter path or redeliver it, depending on
 *   the broker's settings); a closed subscription settles what it holds as `modified { delivery-failed }` and detaches,
 *   as a dead consumer's deliveries would come back. **TTL** is the header's `ttl` (Artemis checks expiry on delivery).
 * - **"Nobody took it" is inferred**: `stats()` asks the broker's management address (`activemq.management`, the
 *   `ConsumerCount` and `MessageCount` attributes of `queue.<channel>`) over the same connection; the core infers from it.
 * - **Ordering keys** are the message `group-id`: Artemis **message groups** pin a group to one consumer, in order.
 * - **Size**: 1 MiB by default (`maxMessageBytes`); the broker has no fixed limit of its own.
 *
 * Reconnect: on a connection loss the driver fails the requests in flight, reconnects with backoff, reopens its reply
 * receiver and re-attaches every subscription; `publish()` and `request()` throw `NotConnectedError` while it is down
 * (nothing was sent). `close()` is idempotent.
 */
import { randomBytes } from 'node:crypto';
import type { Connection, Delivery as RheaDelivery, EventContext, Message as RheaMessage, Receiver, Sender } from 'rhea';
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

/** The CloudEvents AMQP protocol binding's application-property prefix. */
export const AMQP1_HEADER_PREFIX = 'cloudEvents_';
/** Artemis's management address (JMX over AMQP). */
export const MANAGEMENT_ADDRESS = 'activemq.management';
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LINK_OPEN_TIMEOUT_MS = 10_000;
const MANAGEMENT_TIMEOUT_MS = 3_000;

export const AMQP1_CAPABILITIES: BrokerCapabilities = {
  replies: 'native',
  workSharing: true,
  buffering: true,
  ttl: true,
  undeliverable: 'inferred',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'medium',
  headers: true,
  orderingKeys: true,
  nack: true,
  attempts: true,
};

export interface Amqp1Config extends BrokerConfig {
  /** `amqp://user:pass@host:5672` or `amqps://host:5671`. */
  url: string;
  /** Credentials, when not in the URL (they replace the URL's). SASL PLAIN; ANONYMOUS without them. */
  username?: string;
  password?: string;
  /** Force TLS (`amqps`). */
  tls?: boolean;
  /** AMQP idle timeout (heartbeat) in ms (default 60 s). */
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Largest event the driver accepts (headers + body); default 1 MiB. */
  maxMessageBytes?: number;
  /** Reconnect backoff bounds (default 1 s … 30 s). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** TLS: refuse unverifiable certificates (default true). */
  rejectUnauthorized?: boolean;
}

type RheaLib = typeof import('rhea');
type Role = 'queue' | 'topic';

interface PendingRequest {
  resolve: (outcome: RequestOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LiveSubscription {
  channel: string;
  options: ConsumeOptions;
  onEvent: ConsumeHandler;
  receiver?: Receiver;
  held: Set<RheaDelivery>;
  closed: boolean;
}

/** Application properties + the `content-type` property → the bare CloudEvents headers. */
export function amqp1PropertiesToHeaders(properties: Record<string, unknown> | undefined, contentType: string | undefined): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties ?? {})) {
    if (value === undefined || value === null) continue;
    raw[name] = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  if (contentType) raw['content-type'] = contentType;
  return unprefixHeaders(raw, AMQP1_HEADER_PREFIX);
}

/** The bare CloudEvents headers → `{ properties, contentType }` for a send. */
export function headersToAmqp1Properties(headers: Record<string, string>): { properties: Record<string, string>; contentType?: string } {
  const { 'content-type': contentType, ...properties } = prefixHeaders(headers, AMQP1_HEADER_PREFIX);
  return { properties, ...(contentType && { contentType }) };
}

/** `delivery-count` counts prior failed deliveries: 0 on the first delivery. */
export function attemptOf(message: Pick<RheaMessage, 'delivery_count'>): number {
  const count = message.delivery_count;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count + 1 : 1;
}

/** The role of a channel name the driver has not declared itself: `<prefix>.v1.<role>…` (§14.2), queues otherwise. */
export function inferRole(name: string): Role {
  const role = name.split('.')[2];
  return role === 'reply' || role === 'registry' || role === 'control' ? 'topic' : 'queue';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Amqp1Driver implements BrokerDriver<Amqp1Config> {
  readonly kind = 'amqp1';
  /** Per instance: `connect()` applies `config.maxMessageBytes`. */
  readonly capabilities: BrokerCapabilities = { ...AMQP1_CAPABILITIES };
  private config?: Amqp1Config;
  private lib?: RheaLib;
  private container?: ReturnType<RheaLib['create_container']>;
  private connection?: Connection;
  private state: 'new' | 'connected' | 'reconnecting' | 'closed' = 'new';
  private readonly declared = new Map<string, ChannelSpec>();
  private readonly roles = new Map<string, Role>();
  private readonly senders = new Map<string, Promise<Sender>>();
  private readonly subscriptions = new Set<LiveSubscription>();
  private readonly pending = new Map<string, PendingRequest>();
  private replyReceiver?: Receiver;
  private replyAddress = '';
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;

  async connect(config: Amqp1Config): Promise<void> {
    if (this.state !== 'new') throw new Error(`amqp1 driver already ${this.state}`);
    if (!config.url) throw new Error('amqp1: no url configured');
    try {
      const imported = await import('rhea');
      this.lib = ((imported as unknown as { default?: RheaLib }).default ?? imported) as RheaLib;
    } catch (error) {
      throw new Error(`amqp1: the client library is not installed (pnpm add rhea): ${(error as Error).message}`);
    }
    this.config = config;
    this.capabilities.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.container = this.lib.create_container({ id: `landflow-${config.connectionId}-${randomBytes(4).toString('hex')}` });
    try {
      await this.open();
    } catch (error) {
      this.state = 'new';
      throw new Error(`amqp1: cannot connect to ${redact(config.url)}: ${(error as Error).message}`);
    }
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureConnected();
    // Artemis creates addresses and queues when the first link attaches (the terminus capability picks anycast or
    // multicast), so declaring only records what each channel is.
    for (const spec of channels) {
      this.declared.set(spec.name, spec);
      this.roles.set(spec.name, spec.delivery === 'shared' ? 'queue' : 'topic');
    }
  }

  async publish(channel: string, event: WireEvent, options: PublishOptions = {}): Promise<PublishOutcome> {
    this.ensureConnected();
    const spec = this.declared.get(channel);
    await this.send(channel, this.roleOf(channel), this.message(event, { durable: spec?.durable ?? this.roleOf(channel) === 'queue', ttl: options.ttlMs, groupId: options.orderingKey }));
    return 'accepted';
  }

  async request(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome> {
    this.ensureConnected();
    const correlationId = randomBytes(12).toString('hex');
    const spec = this.declared.get(channel);
    const message = this.message(event, { durable: spec?.durable ?? this.roleOf(channel) === 'queue', ttl: options.timeoutMs, groupId: options.orderingKey });
    message.reply_to = this.replyAddress;
    message.correlation_id = correlationId;
    return new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ outcome: 'timeout' });
      }, options.timeoutMs);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
      this.send(channel, this.roleOf(channel), message).catch((error: unknown) => {
        if (this.pending.delete(correlationId)) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureConnected();
    const live: LiveSubscription = { channel, options, onEvent, held: new Set(), closed: false };
    await this.attach(live);
    this.subscriptions.add(live);
    return {
      channel,
      close: async () => {
        if (live.closed) return;
        live.closed = true;
        this.subscriptions.delete(live);
        // As a dead consumer's would be: what it holds goes back with its delivery count incremented.
        for (const delivery of live.held) if (!delivery.settled) delivery.modified({ delivery_failed: true });
        live.held.clear();
        live.receiver?.close();
        live.receiver = undefined;
      },
    };
  }

  async stats(channel: string): Promise<ChannelStats> {
    this.ensureConnected();
    if (this.roleOf(channel) === 'topic') return {};
    const [consumers, depth] = await Promise.all([this.attribute(channel, 'ConsumerCount'), this.attribute(channel, 'MessageCount')]);
    return { depth: depth ?? 0, consumers: consumers ?? 0 };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const wasOpen = this.state !== 'new';
    this.state = 'closed';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failPending(new Error('amqp1 driver closed'));
    for (const live of [...this.subscriptions]) {
      live.closed = true;
      for (const delivery of live.held) if (!delivery.settled && this.connection?.is_open()) delivery.modified({ delivery_failed: true });
      live.held.clear();
    }
    this.subscriptions.clear();
    this.senders.clear();
    if (wasOpen && this.connection) {
      const connection = this.connection;
      this.connection = undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        connection.once('connection_close', () => {
          clearTimeout(timer);
          resolve();
        });
        connection.once('disconnected', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          connection.close();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.declared.clear();
  }

  // --- connection lifecycle -------------------------------------------------------------------------------------------

  private async open(): Promise<void> {
    const config = this.config!;
    const target = new URL(config.url);
    const tls = config.tls || target.protocol === 'amqps:';
    const username = config.username ?? (target.username ? decodeURIComponent(target.username) : undefined);
    const password = config.password ?? (target.password ? decodeURIComponent(target.password) : undefined);
    const connection = this.container!.connect({
      host: target.hostname,
      port: Number(target.port) || (tls ? 5671 : 5672),
      transport: tls ? 'tls' : 'tcp',
      ...(username !== undefined && { username, password: password ?? '' }),
      reconnect: false,
      idle_time_out: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
    } as Parameters<ReturnType<RheaLib['create_container']>['connect']>[0]);
    connection.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timed out')), config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        connection.removeListener('connection_open', onOpen);
        connection.removeListener('connection_error', onError);
        connection.removeListener('disconnected', onDisconnected);
        fn();
      };
      const onOpen = () => done(resolve);
      const onError = (context: EventContext) => done(() => reject(new Error(describe(context.connection.error))));
      const onDisconnected = (context: EventContext) => done(() => reject(new Error(describe(context.error) || 'disconnected')));
      connection.once('connection_open', onOpen);
      connection.once('connection_error', onError);
      connection.once('disconnected', onDisconnected);
    });
    connection.on('disconnected', () => this.onLost(connection));
    connection.on('connection_error', () => undefined);
    connection.on('connection_close', () => this.onLost(connection));
    this.connection = connection;
    try {
      const receiver = await this.openReceiver(connection, { source: { dynamic: true, expiry_policy: 'link-detach' }, credit_window: 1024, autoaccept: true });
      this.replyReceiver = receiver;
      this.replyAddress = receiver.source.address!;
      receiver.on('message', (context: EventContext) => this.onReply(context.message!));
    } catch (error) {
      this.connection = undefined;
      connection.close();
      throw error;
    }
  }

  private onLost(connection: Connection): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.replyReceiver = undefined;
    this.senders.clear();
    for (const live of this.subscriptions) {
      live.receiver = undefined;
      live.held.clear();
    }
    if (this.state === 'closed') return;
    this.state = 'reconnecting';
    this.failPending(new Error('amqp1 connection lost; the call may have run'));
    this.scheduleReconnect();
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
      for (const live of this.subscriptions) if (!live.closed) await this.attach(live).catch(() => undefined);
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

  private onReply(message: RheaMessage): void {
    const id = message.correlation_id === undefined ? undefined : String(message.correlation_id);
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id!);
    clearTimeout(pending.timer);
    pending.resolve({ outcome: 'replied', event: toWire(message) });
  }

  // --- links ----------------------------------------------------------------------------------------------------------

  private roleOf(channel: string): Role {
    const known = this.roles.get(channel);
    if (known) return known;
    const role = inferRole(channel);
    this.roles.set(channel, role);
    return role;
  }

  private openReceiver(connection: Connection, options: Record<string, unknown>): Promise<Receiver> {
    return new Promise<Receiver>((resolve, reject) => {
      const receiver = connection.open_receiver(options);
      const timer = setTimeout(() => reject(new Error('receiver did not open in time')), LINK_OPEN_TIMEOUT_MS);
      receiver.once('receiver_open', () => {
        clearTimeout(timer);
        resolve(receiver);
      });
      receiver.once('receiver_error', (context: EventContext) => {
        clearTimeout(timer);
        reject(new Error(describe(context.receiver?.error)));
      });
      receiver.on('receiver_error', () => undefined);
    });
  }

  /** The cached sender for an address (one per address and role; replaced after a reconnect). */
  private sender(address: string, role: Role | undefined): Promise<Sender> {
    const key = `${role ?? ''}:${address}`;
    let pending = this.senders.get(key);
    if (pending) return pending;
    const connection = this.connection;
    if (!connection) return Promise.reject(new NotConnectedError('amqp1 connection is down'));
    pending = new Promise<Sender>((resolve, reject) => {
      const sender = connection.open_sender({ target: { address, ...(role && { capabilities: [role] }) }, autosettle: true });
      const timer = setTimeout(() => reject(new Error(`sender to ${address} did not open in time`)), LINK_OPEN_TIMEOUT_MS);
      sender.once('sender_open', () => {
        clearTimeout(timer);
        resolve(sender);
      });
      sender.once('sender_error', (context: EventContext) => {
        clearTimeout(timer);
        this.senders.delete(key);
        reject(new Error(describe(context.sender?.error)));
      });
      sender.on('sender_error', () => undefined);
      sender.on('sender_close', () => {
        if (this.senders.get(key) === pending) this.senders.delete(key);
      });
    });
    this.senders.set(key, pending);
    pending.catch(() => this.senders.delete(key));
    return pending;
  }

  /** Send one message and wait for the broker's disposition; `accepted` resolves, anything else rejects. */
  private async send(address: string, role: Role | undefined, message: RheaMessage): Promise<void> {
    const sender = await this.sender(address, role);
    if (!sender.sendable()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no credit to send to ${address}`)), LINK_OPEN_TIMEOUT_MS);
        sender.once('sendable', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await new Promise<void>((resolve, reject) => {
      let delivery: RheaDelivery;
      const cleanup = () => {
        sender.removeListener('accepted', onAccepted);
        sender.removeListener('rejected', onOther);
        sender.removeListener('released', onOther);
        sender.removeListener('modified', onOther);
        sender.removeListener('sender_close', onClose);
        sender.removeListener('sender_error', onClose);
      };
      const onAccepted = (context: EventContext) => {
        if (context.delivery !== delivery) return;
        cleanup();
        resolve();
      };
      const onOther = (context: EventContext) => {
        if (context.delivery !== delivery) return;
        cleanup();
        reject(new Error(`the broker did not accept the message for ${address}: ${describe((context.delivery?.remote_state as { error?: unknown } | undefined)?.error) || 'released'}`));
      };
      const onClose = (context: EventContext) => {
        cleanup();
        reject(new Error(`the link to ${address} closed before the broker settled the message: ${describe(context.sender?.error)}`));
      };
      sender.on('accepted', onAccepted);
      sender.on('rejected', onOther);
      sender.on('released', onOther);
      sender.on('modified', onOther);
      sender.on('sender_close', onClose);
      sender.on('sender_error', onClose);
      try {
        delivery = sender.send(message);
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  private message(event: WireEvent, options: { durable: boolean; ttl?: number; groupId?: string }): RheaMessage {
    const { properties, contentType } = headersToAmqp1Properties(event.headers);
    return {
      durable: options.durable,
      ...(options.ttl !== undefined && options.ttl > 0 && { ttl: Math.max(1, Math.floor(options.ttl)) }),
      ...(options.groupId && { group_id: options.groupId }),
      ...(contentType && { content_type: contentType }),
      application_properties: properties,
      body: Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength),
    };
  }

  // --- consuming ------------------------------------------------------------------------------------------------------

  private async attach(live: LiveSubscription): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new NotConnectedError('amqp1 connection is down');
    const { channel, options, onEvent } = live;
    const role = this.roleOf(channel);
    const shared = role === 'queue' && Boolean(options.group);
    const manual = shared && options.ackMode === 'manual';
    const prefetch = Math.max(1, options.prefetch);
    const receiver = await this.openReceiver(connection, {
      source: { address: channel, capabilities: [role], durable: 0, expiry_policy: 'link-detach' },
      credit_window: manual ? 0 : prefetch,
      autoaccept: !manual,
      autosettle: true,
    });
    live.receiver = receiver;
    receiver.on('message', (context: EventContext) => {
      const message = context.message!;
      const rheaDelivery = context.delivery!;
      if (live.closed || live.receiver !== receiver) {
        if (manual && !rheaDelivery.settled) rheaDelivery.modified({ delivery_failed: true });
        return;
      }
      if (manual) live.held.add(rheaDelivery);
      let settled = !manual;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        live.held.delete(rheaDelivery);
        return true;
      };
      const credit = () => {
        if (manual && live.receiver === receiver && !live.closed) receiver.add_credit(1);
      };
      const delivery: Delivery = {
        attempt: attemptOf(message),
        ack: async () => {
          if (!settle()) return;
          if (!rheaDelivery.settled) rheaDelivery.accept();
          credit();
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (!rheaDelivery.settled) {
            if (requeue) rheaDelivery.modified({ delivery_failed: true });
            else rheaDelivery.accept();
          }
          credit();
        },
        reply: async (reply: WireEvent) => {
          const replyTo = message.reply_to;
          if (!replyTo) throw new Error('the request carries no reply-to address');
          this.ensureConnected();
          const out = this.message(reply, { durable: false });
          if (message.correlation_id !== undefined) out.correlation_id = message.correlation_id;
          await this.send(replyTo, undefined, out);
        },
      };
      void onEvent(toWire(message), delivery).catch(() => delivery.nack({ requeue: false }));
    });
    if (manual) receiver.add_credit(prefetch);
  }

  // --- management -----------------------------------------------------------------------------------------------------

  /** One attribute of `queue.<channel>` through the management address; undefined when the queue does not exist. */
  private async attribute(channel: string, attribute: 'ConsumerCount' | 'MessageCount'): Promise<number | undefined> {
    const correlationId = randomBytes(8).toString('hex');
    const message: RheaMessage = {
      reply_to: this.replyAddress,
      correlation_id: correlationId,
      application_properties: { _AMQ_ResourceName: `queue.${channel}`, _AMQ_Attribute: attribute },
      body: '[]',
    };
    const reply = await new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ outcome: 'timeout' });
      }, MANAGEMENT_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
      this.send(MANAGEMENT_ADDRESS, undefined, message).catch((error: unknown) => {
        if (this.pending.delete(correlationId)) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    if (reply.outcome !== 'replied') throw new Error(`amqp1: the management request for ${channel} ${reply.outcome === 'timeout' ? 'timed out' : 'failed'}`);
    if (reply.event.headers['x-amqp1-succeeded'] !== 'true') return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(reply.event.body).toString('utf8')) as unknown;
      const value = Array.isArray(parsed) ? parsed[0] : parsed;
      return typeof value === 'number' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private ensureConnected(): void {
    if (this.state !== 'connected' || !this.connection) throw new NotConnectedError(`amqp1 driver is ${this.state === 'new' ? 'not connected' : this.state}`);
  }
}

/** A received message as a wire event (management replies also carry `_AMQ_OperationSucceeded` as `x-amqp1-succeeded`). */
const toWire = (message: RheaMessage): WireEvent => {
  const headers = amqp1PropertiesToHeaders(message.application_properties, message.content_type as string | undefined);
  const succeeded = message.application_properties?._AMQ_OperationSucceeded;
  if (succeeded !== undefined) headers['x-amqp1-succeeded'] = String(succeeded);
  return { headers, body: bodyBytes(message.body) };
};

/** The body as bytes: a `data` section arrives as a Buffer; an `amqp-value` string (management replies) is encoded as UTF-8. */
function bodyBytes(body: unknown): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (Buffer.isBuffer(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  const typed = body as { typecode?: number; content?: unknown; value?: unknown };
  if (Buffer.isBuffer(typed.content)) return new Uint8Array(typed.content.buffer, typed.content.byteOffset, typed.content.byteLength);
  if (typeof typed.value === 'string') return new TextEncoder().encode(typed.value);
  if (Buffer.isBuffer(typed.value)) return new Uint8Array(typed.value.buffer, typed.value.byteOffset, typed.value.byteLength);
  return new TextEncoder().encode(JSON.stringify(body));
}

const describe = (error: unknown): string => {
  if (!error) return '';
  const e = error as { description?: string; condition?: string; message?: string };
  return e.description ?? e.message ?? e.condition ?? String(error);
};

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
 * Connection config from `amqp://[user:pass@]host[:5672]` or `amqps://…` (`amqp+ssl://` works too). The username and
 * password fields win over the URL's; `tls` forces `amqps`. Readable errors for anything else.
 */
export function amqp1ConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): Amqp1Config {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('AMQP 1.0 needs a URL, e.g. amqp://user:password@127.0.0.1:5672');
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/^amqp\+(ssl|tls):\/\//i, 'amqps://'));
  } catch {
    throw new Error(`"${url}" is not a URL; use amqp://user:password@host:5672`);
  }
  if (parsed.protocol !== 'amqp:' && parsed.protocol !== 'amqps:') throw new Error(`"${url}" must start with amqp:// or amqps://`);
  if (!parsed.hostname) throw new Error(`"${url}" has no host`);
  const tls = Boolean(options.tls) || parsed.protocol === 'amqps:';
  let username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  let password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  if (typeof options.username === 'string' && options.username) {
    username = options.username;
    password = options.password ?? '';
  }
  parsed.username = '';
  parsed.password = '';
  if (tls) parsed.protocol = 'amqps:';
  const max = Number(options.maxMessageBytes);
  return {
    connectionId,
    url: parsed.toString(),
    ...(username !== undefined && { username, password: password ?? '' }),
    ...(tls && { tls: true }),
    ...(options.prefix && { prefix: options.prefix }),
    ...(Number.isFinite(max) && max > 0 && { maxMessageBytes: max }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [amqp1({ url: 'amqp://user:pass@127.0.0.1:55674' })] })`. `connectionId` defaults to `env-amqp1`. */
export function amqp1(config: Omit<Amqp1Config, 'connectionId'> & { connectionId?: string }): BrokerTarget<Amqp1Config> {
  if (!config.url) throw new Error('amqp1(): "url" is required');
  const full: Amqp1Config = { ...config, connectionId: config.connectionId ?? 'env-amqp1' };
  return { kind: 'amqp1', config: full, driver: () => new Amqp1Driver() };
}

const amqp1Module: DriverModule<Amqp1Config> = {
  kind: 'amqp1',
  label: 'AMQP 1.0 (ActiveMQ Artemis)',
  capabilities: AMQP1_CAPABILITIES,
  exampleUrl: 'amqp://user:password@artemis:5672',
  create: () => new Amqp1Driver(),
  configFrom: amqp1ConfigFrom,
};

export default amqp1Module;
