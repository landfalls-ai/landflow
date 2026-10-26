/**
 * `@landflow/transports/servicebus`: the Azure Service Bus driver on `@azure/service-bus` (an optional peer dependency
 * imported lazily in `connect()`); works against the Service Bus emulator (`UseDevelopmentEmulator=true`) and a real
 * namespace.
 *
 * Mapping (docs/protocol.md §14.9). Service Bus has no exclusive consumers, no broadcast queues and, on the emulator, no
 * entity creation at runtime, so the five channel roles land on four kinds of pre-declared entity:
 * - **Request channels** (shared, durable): a **queue named after the channel** (`landflow.v1.plugin.<pluginId>`), peek-lock,
 *   competing receivers with `maxConcurrentCalls = prefetch`. `ack()` completes, `nack({ requeue: true })` abandons
 *   (redelivered at once, `deliveryCount` counts it), `nack({ requeue: false })` completes (drops). A closing subscription
 *   abandons what it still holds, so a survivor takes it; message locks are renewed while a call runs.
 * - **Instance channels** (shared, one consumer) and **reply channels** (one host): one **session-enabled queue** each
 *   (`<prefix>.v1.instance`, `<prefix>.v1.reply`) with the **session id = channel name**; the consumer accepts its session
 *   (one receiver per session, which is exactly the channel's contract) and the lock is renewed for as long as it lives.
 * - **Broadcast channels** (registry, control): one **topic** (`<prefix>.v1.broadcast`) with a pool of session-enabled
 *   subscriptions (`bc-00` … `bc-15`). Every broadcast message carries the constant session id `broadcast` and the
 *   channel in the `lfchannel` application property; a consumer **claims** a subscription by locking that session on it
 *   (a locked one answers `SessionCannotBeLocked`, so it tries the next), drains what the subscription accumulated while
 *   unclaimed, then receives (receive-and-delete) and keeps the events of its channel. Unclaimed subscriptions shed their
 *   messages by TTL.
 * - **CloudEvents binary mode**: attributes as application properties under `ce_<name>`, `content-type` as the message's
 *   `contentType`; the header budget is 64 KiB. **TTL** is the per-message `timeToLive`. **Replies** are `reply-channel`
 *   (the core correlates). **Undeliverable** is `unknown`: Service Bus exposes message counts but no receiver counts, so
 *   `stats()` reports an approximate depth (a peek) and the core relies on announce heartbeats and the deadline.
 * - `maxMessageBytes` defaults to 240 KiB (the Standard tier's and the emulator's AMQP link limit is 256 KiB including
 *   framing; set it higher on Premium). `connect()` lowers it to the link's advertised maximum when that is smaller.
 *
 * Entity names: a real namespace gets them created by `declare()` through the administration client
 * (`createEntities`, on by default outside the emulator); the emulator's entities are fixed in
 * `deploy/infra/servicebus/Config.json`, and `declare()` only verifies they exist. `queueFor` maps a request channel onto
 * another queue name (the conformance suite maps its random channel names onto a fixed set). The client reconnects links
 * itself; `NotConnectedError` is thrown only before `connect()` and after `close()`.
 */
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

/** The CloudEvents header prefix on application properties. */
export const SERVICEBUS_HEADER_PREFIX = 'ce_';
/** Driver-private application property naming the channel (broadcast routing and a guard on pooled queues). */
export const CHANNEL_PROPERTY = 'lfchannel';
/** The session id every broadcast message carries; consumers claim a subscription by locking it. */
export const BROADCAST_SESSION = 'broadcast';
/** The Standard tier (and the emulator) allow 256 KiB per AMQP message including framing: 240 KiB for the event. */
export const DEFAULT_MAX_MESSAGE_BYTES = 240 * 1024;
/** Service Bus caps the application properties of a message at 64 KiB. */
export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
export const DEFAULT_BROADCAST_SUBSCRIPTIONS = 16;
const DEFAULT_PREFIX = 'landflow';
const LOCK_RENEWAL_MS = 60 * 60_000;
const SESSION_RENEWAL_MS = 24 * 60 * 60_000;
const DRAIN_WAIT_MS = 150;
const PEEK_DEPTH = 100;

export const SERVICEBUS_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: true,
  undeliverable: 'unknown',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'medium',
  headers: true,
  maxHeaderBytes: DEFAULT_MAX_HEADER_BYTES,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

export interface ServiceBusEntities {
  /** Session-enabled queue carrying every instance channel (default `<prefix>.v1.instance`). */
  instanceQueue?: string;
  /** Session-enabled queue carrying every reply channel (default `<prefix>.v1.reply`). */
  replyQueue?: string;
  /** Topic carrying every broadcast channel (default `<prefix>.v1.broadcast`). */
  broadcastTopic?: string;
  /** Its session-enabled subscriptions: a count (`bc-00`…) or explicit names (default 16). */
  broadcastSubscriptions?: number | string[];
}

export interface ServiceBusConfig extends BrokerConfig {
  /** `Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…[;UseDevelopmentEmulator=true]`. */
  connectionString: string;
  /** The development emulator (fixed entities, 256 KiB messages); default: `UseDevelopmentEmulator=true` in the connection string. */
  emulator?: boolean;
  /** Create missing queues, topics and subscriptions through the administration client (default: not on the emulator). */
  createEntities?: boolean;
  entities?: ServiceBusEntities;
  /** The queue of a request channel (default: the channel name). */
  queueFor?: (channel: string) => string;
  /** Largest event the driver accepts (headers + body); default 240 KiB. */
  maxMessageBytes?: number;
  /** How long the client may keep renewing a message lock while a call runs (default 1 h). */
  lockRenewalMs?: number;
}

/** The subset of the client the driver uses (typed loosely: the library is loaded lazily and may be absent). */
interface SbModule {
  ServiceBusClient: new (connectionString: string, options?: Record<string, unknown>) => SbClient;
  ServiceBusAdministrationClient: new (connectionString: string) => SbAdmin;
}
interface SbClient {
  createSender(entity: string): SbSender;
  createReceiver(queue: string, options?: Record<string, unknown>): SbReceiver;
  createReceiver(topic: string, subscription: string, options?: Record<string, unknown>): SbReceiver;
  acceptSession(queue: string, sessionId: string, options?: Record<string, unknown>): Promise<SbReceiver>;
  acceptSession(topic: string, subscription: string, sessionId: string, options?: Record<string, unknown>): Promise<SbReceiver>;
  close(): Promise<void>;
}
interface SbSender {
  sendMessages(message: SbMessage): Promise<void>;
  createMessageBatch(): Promise<{ maxSizeInBytes: number }>;
  close(): Promise<void>;
}
interface SbMessage {
  body: Buffer;
  contentType?: string;
  applicationProperties?: Record<string, string>;
  sessionId?: string;
  timeToLive?: number;
}
interface SbReceived {
  body: unknown;
  contentType?: string;
  applicationProperties?: Record<string, unknown>;
  deliveryCount?: number;
  sessionId?: string;
}
interface SbReceiver {
  subscribe(handlers: { processMessage: (message: SbReceived) => Promise<void>; processError: (args: { error: Error }) => Promise<void> }, options?: Record<string, unknown>): { close(): Promise<void> };
  receiveMessages(max: number, options?: { maxWaitTimeInMs?: number }): Promise<SbReceived[]>;
  peekMessages(max: number): Promise<SbReceived[]>;
  completeMessage(message: SbReceived): Promise<void>;
  abandonMessage(message: SbReceived): Promise<void>;
  deadLetterMessage(message: SbReceived, options?: { deadLetterReason?: string; deadLetterErrorDescription?: string }): Promise<void>;
  renewSessionLock?(): Promise<Date>;
  close(): Promise<void>;
}
interface SbAdmin {
  queueExists(name: string): Promise<boolean>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<unknown>;
  topicExists(name: string): Promise<boolean>;
  createTopic(name: string, options?: Record<string, unknown>): Promise<unknown>;
  subscriptionExists(topic: string, name: string): Promise<boolean>;
  createSubscription(topic: string, name: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** Where a channel lives: a plain queue, a session of a session-enabled queue, or the broadcast topic. */
export type Entity = { kind: 'queue'; name: string } | { kind: 'session'; name: string; session: string } | { kind: 'topic'; name: string };

type Role = 'request' | 'instance' | 'reply' | 'broadcast';

/** The role of a channel the driver has not declared itself: `<prefix>.v1.<role>…` (§14.2), a request channel otherwise. */
export function inferRole(name: string): Role {
  const role = name.split('.')[2];
  if (role === 'instance') return 'instance';
  if (role === 'reply') return 'reply';
  if (role === 'registry' || role === 'control') return 'broadcast';
  return 'request';
}

/** The entity role of a declared channel: the spec's role first (a reply channel is broadcast-delivery but one host's session), then its delivery. */
const roleOf = (spec: ChannelSpec): Role => {
  if (spec.role === 'reply') return 'reply';
  if (spec.role === 'instance') return 'instance';
  if (spec.role === 'registry' || spec.role === 'control' || spec.delivery === 'broadcast') return 'broadcast';
  return spec.durable ? 'request' : 'instance';
};

/** The entity names for a config (defaults derive from the channel prefix). */
export function entityNames(config: Pick<ServiceBusConfig, 'prefix' | 'entities'>): { instanceQueue: string; replyQueue: string; broadcastTopic: string; broadcastSubscriptions: string[] } {
  const base = `${config.prefix ?? DEFAULT_PREFIX}.v1`;
  const subs = config.entities?.broadcastSubscriptions ?? DEFAULT_BROADCAST_SUBSCRIPTIONS;
  return {
    instanceQueue: config.entities?.instanceQueue ?? `${base}.instance`,
    replyQueue: config.entities?.replyQueue ?? `${base}.reply`,
    broadcastTopic: config.entities?.broadcastTopic ?? `${base}.broadcast`,
    broadcastSubscriptions: Array.isArray(subs) ? subs : Array.from({ length: subs }, (_, i) => `bc-${String(i).padStart(2, '0')}`),
  };
}

/** The entity a channel maps onto. */
export function entityOf(config: Pick<ServiceBusConfig, 'prefix' | 'entities' | 'queueFor'>, channel: string, role: Role): Entity {
  const names = entityNames(config);
  switch (role) {
    case 'request':
      return { kind: 'queue', name: config.queueFor?.(channel) ?? channel };
    case 'instance':
      return { kind: 'session', name: names.instanceQueue, session: channel };
    case 'reply':
      return { kind: 'session', name: names.replyQueue, session: channel };
    case 'broadcast':
      return { kind: 'topic', name: names.broadcastTopic };
  }
}

/** Application properties → the bare CloudEvents headers (`content-type` from the message's `contentType`). */
export function propertiesToWire(properties: Record<string, unknown> | undefined, contentType: string | undefined): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties ?? {})) if (value !== undefined && value !== null) raw[name] = String(value);
  if (contentType) raw['content-type'] = contentType;
  return unprefixHeaders(raw, SERVICEBUS_HEADER_PREFIX);
}

/** The bare CloudEvents headers → application properties plus the message `contentType`. */
export function wireToProperties(headers: Record<string, string>, channel: string): { applicationProperties: Record<string, string>; contentType?: string } {
  const { 'content-type': contentType, ...prefixed } = prefixHeaders(headers, SERVICEBUS_HEADER_PREFIX);
  return { applicationProperties: { ...prefixed, [CHANNEL_PROPERTY]: channel }, ...(contentType && { contentType }) };
}

/** `UseDevelopmentEmulator=true` in a connection string. */
export const isEmulatorConnectionString = (connectionString: string) => /(^|;)\s*UseDevelopmentEmulator\s*=\s*true\s*(;|$)/i.test(connectionString);

const codeOf = (error: unknown) => (error as { code?: string })?.code ?? '';
const sessionLocked = (error: unknown) => codeOf(error) === 'SessionCannotBeLocked';
const entityMissing = (error: unknown) => codeOf(error) === 'MessagingEntityNotFound';
const bodyBytes = (body: unknown): Uint8Array => {
  if (Buffer.isBuffer(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new TextEncoder().encode(JSON.stringify(body));
};

export class ServiceBusDriver implements BrokerDriver<ServiceBusConfig> {
  readonly kind = 'servicebus';
  /** Per instance (the Codec keeps a reference): `connect()` applies `config.maxMessageBytes` and the link limit to it. */
  readonly capabilities: BrokerCapabilities = { ...SERVICEBUS_CAPABILITIES };
  private config?: ServiceBusConfig;
  private lib?: SbModule;
  private client?: SbClient;
  private admin?: SbAdmin;
  private state: 'new' | 'connected' | 'closed' = 'new';
  private readonly declared = new Map<string, ChannelSpec>();
  private readonly senders = new Map<string, SbSender>();
  private readonly peekers = new Map<string, SbReceiver>();
  private readonly subscriptions = new Set<{ close(): Promise<void> }>();

  async connect(config: ServiceBusConfig): Promise<void> {
    if (this.state !== 'new') throw new Error(`servicebus driver already ${this.state}`);
    if (!config.connectionString) throw new Error('servicebus: no connection string configured');
    try {
      this.lib = (await import('@azure/service-bus')) as unknown as SbModule;
    } catch (error) {
      throw new Error(`servicebus: the client library is not installed (pnpm add @azure/service-bus): ${(error as Error).message}`);
    }
    const emulator = config.emulator ?? isEmulatorConnectionString(config.connectionString);
    this.config = { ...config, emulator, createEntities: config.createEntities ?? !emulator };
    this.capabilities.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const client = new this.lib.ServiceBusClient(config.connectionString, { retryOptions: { maxRetries: 2, retryDelayInMs: 200, timeoutInMs: 15_000 } });
    try {
      // Senders open lazily: open one on the broadcast topic (every connection uses it) so an unreachable namespace
      // rejects here, and learn the link's maximum message size.
      const sender = client.createSender(entityNames(this.config).broadcastTopic);
      const batch = await sender.createMessageBatch();
      if (batch.maxSizeInBytes > 0 && batch.maxSizeInBytes - 16 * 1024 < this.capabilities.maxMessageBytes) this.capabilities.maxMessageBytes = Math.max(64 * 1024, batch.maxSizeInBytes - 16 * 1024);
      this.senders.set(entityNames(this.config).broadcastTopic, sender);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`servicebus: cannot connect to ${redact(config.connectionString)}: ${(error as Error).message}`);
    }
    this.client = client;
    if (this.config.createEntities) this.admin = new this.lib.ServiceBusAdministrationClient(config.connectionString);
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    const { config } = this.ensureConnected();
    for (const spec of channels) {
      if (this.declared.has(spec.name)) continue;
      const entity = entityOf(config, spec.name, roleOf(spec));
      if (this.admin) await this.createEntity(entity, spec);
      await this.verify(entity);
      this.declared.set(spec.name, spec);
    }
  }

  async publish(channel: string, event: WireEvent, options: PublishOptions = {}): Promise<PublishOutcome> {
    const { config } = this.ensureConnected();
    const spec = this.declared.get(channel);
    const entity = entityOf(config, channel, spec ? roleOf(spec) : inferRole(channel));
    const ttlMs = options.ttlMs ?? spec?.ttlMs;
    const message: SbMessage = {
      body: Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength),
      ...wireToProperties(event.headers, channel),
      ...(entity.kind === 'session' && { sessionId: entity.session }),
      ...(entity.kind === 'topic' && { sessionId: BROADCAST_SESSION }),
      ...(ttlMs !== undefined && { timeToLive: Math.max(1, Math.floor(ttlMs)) }),
    };
    await this.senderFor(entity.name).sendMessages(message);
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const { client, config } = this.ensureConnected();
    const spec = this.declared.get(channel);
    const entity = entityOf(config, channel, spec ? roleOf(spec) : inferRole(channel));
    const manual = options.ackMode === 'manual' && entity.kind !== 'topic';
    // Session receivers always peek-lock (the emulator delivers nothing to a receive-and-delete session receiver); auto
    // mode then completes on receipt.
    const receiveMode = manual || entity.kind === 'session' ? 'peekLock' : 'receiveAndDelete';
    let closed = false;
    let receiver: SbReceiver;
    if (entity.kind === 'queue') receiver = client.createReceiver(entity.name, { receiveMode });
    else if (entity.kind === 'session') {
      try {
        receiver = await client.acceptSession(entity.name, entity.session, { receiveMode, maxAutoLockRenewalDurationInMs: SESSION_RENEWAL_MS });
      } catch (error) {
        if (sessionLocked(error)) throw new Error(`servicebus: channel ${channel} is already consumed by another process (session ${entity.session} of ${entity.name} is locked)`);
        throw error;
      }
    } else receiver = await this.claimBroadcast(entity.name);
    const held = new Set<{ message: SbReceived; settle: () => boolean }>();
    const sub = receiver.subscribe(
      {
        processMessage: async (message) => {
          if (closed) return;
          const mine = message.applicationProperties?.[CHANNEL_PROPERTY];
          if (mine !== undefined && mine !== channel) {
            // Another channel's event on a shared entity: our own subscription on the topic (drop) or a mapped queue (keep it visible).
            if (manual) await receiver.deadLetterMessage(message, { deadLetterReason: 'wrong-channel', deadLetterErrorDescription: `${channel} received an event for ${mine}` }).catch(() => undefined);
            return;
          }
          const event: WireEvent = { headers: propertiesToWire(message.applicationProperties, message.contentType), body: bodyBytes(message.body) };
          const attempt = (message.deliveryCount ?? 0) + 1;
          if (!manual) {
            if (receiveMode === 'peekLock') await receiver.completeMessage(message).catch(() => undefined);
            await onEvent(event, { attempt, ack: async () => undefined, nack: async () => undefined }).catch(() => undefined);
            return;
          }
          let settled = false;
          let release!: () => void;
          const done = new Promise<void>((resolve) => (release = resolve));
          const record = {
            message,
            settle: () => {
              if (settled) return false;
              settled = true;
              held.delete(record);
              release();
              return true;
            },
          };
          held.add(record);
          const delivery: Delivery = {
            attempt,
            ack: async () => {
              if (record.settle()) await receiver.completeMessage(message).catch(() => undefined);
            },
            nack: async ({ requeue = false } = {}) => {
              if (!record.settle()) return;
              if (requeue) await receiver.abandonMessage(message).catch(() => undefined);
              else await receiver.completeMessage(message).catch(() => undefined);
            },
          };
          void onEvent(event, delivery).catch(() => delivery.nack({ requeue: false }));
          await done; // the SDK's concurrency slot (prefetch) stays taken until the core settles the delivery
        },
        processError: async () => undefined,
      },
      { autoCompleteMessages: false, maxConcurrentCalls: Math.max(1, options.prefetch), maxAutoLockRenewalDurationInMs: config.lockRenewalMs ?? LOCK_RENEWAL_MS },
    );
    const subscription: Subscription & { close(): Promise<void> } = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        await sub.close().catch(() => undefined);
        // Hand the deliveries still held back to the queue, as a dead consumer's locks would lapse.
        const orphans = [...held];
        held.clear();
        for (const record of orphans) {
          record.settle();
          await receiver.abandonMessage(record.message).catch(() => undefined);
        }
        await receiver.close().catch(() => undefined);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  /** An approximate depth (a peek of up to 100 messages) for request channels; Service Bus exposes no receiver counts. */
  async stats(channel: string): Promise<ChannelStats> {
    const { client, config } = this.ensureConnected();
    const spec = this.declared.get(channel);
    const entity = entityOf(config, channel, spec ? roleOf(spec) : inferRole(channel));
    if (entity.kind !== 'queue') return {};
    let peeker = this.peekers.get(entity.name);
    if (!peeker) {
      peeker = client.createReceiver(entity.name, { receiveMode: 'peekLock' });
      this.peekers.set(entity.name, peeker);
    }
    const peeked = await peeker.peekMessages(PEEK_DEPTH);
    return { depth: peeked.filter((m) => m.applicationProperties?.[CHANNEL_PROPERTY] === undefined || m.applicationProperties[CHANNEL_PROPERTY] === channel).length };
  }

  async close(): Promise<void> {
    if (this.state !== 'connected') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    for (const subscription of [...this.subscriptions]) await subscription.close().catch(() => undefined);
    for (const sender of this.senders.values()) await sender.close().catch(() => undefined);
    for (const peeker of this.peekers.values()) await peeker.close().catch(() => undefined);
    this.senders.clear();
    this.peekers.clear();
    this.declared.clear();
    await this.client!.close().catch(() => undefined);
    this.client = undefined;
    this.admin = undefined;
  }

  // --- entities -------------------------------------------------------------------------------------------------------

  private async createEntity(entity: Entity, spec: ChannelSpec): Promise<void> {
    const admin = this.admin!;
    const ttl = (ms: number | undefined) => (ms !== undefined ? isoDuration(ms) : undefined);
    if (entity.kind === 'queue') {
      if (!(await admin.queueExists(entity.name))) await admin.createQueue(entity.name, { lockDuration: 'PT1M', maxDeliveryCount: 10, defaultMessageTimeToLive: ttl(spec.ttlMs) ?? 'P1D' });
    } else if (entity.kind === 'session') {
      if (!(await admin.queueExists(entity.name))) await admin.createQueue(entity.name, { requiresSession: true, lockDuration: 'PT1M', maxDeliveryCount: 10, defaultMessageTimeToLive: 'PT5M' });
    } else {
      const names = entityNames(this.config!);
      if (!(await admin.topicExists(entity.name))) await admin.createTopic(entity.name, { defaultMessageTimeToLive: 'PT5M' });
      for (const name of names.broadcastSubscriptions) {
        if (!(await admin.subscriptionExists(entity.name, name))) await admin.createSubscription(entity.name, name, { requiresSession: true, lockDuration: 'PT1M', maxDeliveryCount: 10, defaultMessageTimeToLive: 'PT1M' });
      }
    }
  }

  /** Open a sender link on the entity: a missing one fails here with a readable message instead of at the first publish. */
  private async verify(entity: Entity): Promise<void> {
    if (this.senders.has(entity.name)) return;
    try {
      await this.senderFor(entity.name).createMessageBatch();
    } catch (error) {
      if (entityMissing(error)) {
        const sender = this.senders.get(entity.name);
        this.senders.delete(entity.name);
        await sender?.close().catch(() => undefined);
        const where = this.config!.emulator ? 'add it to deploy/infra/servicebus/Config.json and recreate the emulator' : 'create it or turn on createEntities';
        throw new Error(`servicebus: ${entity.kind === 'topic' ? 'topic' : 'queue'} "${entity.name}" does not exist (${where})`);
      }
      throw error;
    }
  }

  private senderFor(name: string): SbSender {
    const { client } = this.ensureConnected();
    let sender = this.senders.get(name);
    if (!sender) {
      sender = client.createSender(name);
      this.senders.set(name, sender);
    }
    return sender;
  }

  /** Lock the broadcast session on the first free subscription of the pool and drain what it accumulated while unclaimed. */
  private async claimBroadcast(topic: string): Promise<SbReceiver> {
    const { client, config } = this.ensureConnected();
    const names = entityNames(config);
    let lastError: unknown;
    for (const name of names.broadcastSubscriptions) {
      let receiver: SbReceiver;
      try {
        receiver = await client.acceptSession(topic, name, BROADCAST_SESSION, { receiveMode: 'receiveAndDelete', maxAutoLockRenewalDurationInMs: SESSION_RENEWAL_MS });
      } catch (error) {
        lastError = error;
        if (sessionLocked(error)) continue;
        if (entityMissing(error)) throw new Error(`servicebus: subscription "${name}" of topic "${topic}" does not exist (${config.emulator ? 'add it to deploy/infra/servicebus/Config.json and recreate the emulator' : 'create it or turn on createEntities'})`);
        throw error;
      }
      // The emulator sometimes hands out a lock that is already stale: renewing validates (and extends) it.
      try {
        await receiver.renewSessionLock!();
      } catch (error) {
        lastError = error;
        await receiver.close().catch(() => undefined);
        continue;
      }
      for (;;) {
        const stale = await receiver.receiveMessages(PEEK_DEPTH, { maxWaitTimeInMs: DRAIN_WAIT_MS });
        if (stale.length === 0) break;
      }
      return receiver;
    }
    throw new Error(`servicebus: every broadcast subscription of ${topic} is claimed (${names.broadcastSubscriptions.length}); add more${lastError ? `: ${(lastError as Error).message}` : ''}`);
  }

  private ensureConnected(): { client: SbClient; config: ServiceBusConfig } {
    if (this.state !== 'connected' || !this.client || !this.config) throw new NotConnectedError(`servicebus driver is ${this.state === 'new' ? 'not connected' : this.state}`);
    return { client: this.client, config: this.config };
  }
}

/** `PT5M`-style duration for entity properties (whole seconds). */
export const isoDuration = (ms: number) => `PT${Math.max(1, Math.ceil(ms / 1000))}S`;

const redact = (connectionString: string) => connectionString.replace(/SharedAccessKey=[^;]*/i, 'SharedAccessKey=***');

/**
 * Connection config from a connection string (`Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…`) or an endpoint
 * URL (`sb://namespace.servicebus.windows.net`, `sb://127.0.0.1:55675` for the emulator) with the key name as the
 * username and the key as the password; the `emulator` field (or `UseDevelopmentEmulator=true`) marks the emulator,
 * which needs no key. `maxMessageBytes` raises the 240 KiB default on Premium.
 */
export function servicebusConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): ServiceBusConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Service Bus needs a connection string (Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…) or an sb:// endpoint');
  const emulatorField = options.emulator === true || options.emulator === 'true';
  let connectionString: string;
  if (/^Endpoint=/i.test(trimmed)) {
    if (!/(^|;)\s*Endpoint=sb:\/\/[^;]+/i.test(trimmed)) throw new Error('the connection string\'s Endpoint must be an sb:// URL');
    const parts = trimmed.split(';').filter((p) => p.trim());
    if (options.username) parts.push(`SharedAccessKeyName=${options.username}`);
    if (options.password) parts.push(`SharedAccessKey=${options.password}`);
    if (emulatorField && !isEmulatorConnectionString(trimmed)) parts.push('UseDevelopmentEmulator=true');
    connectionString = parts.map((p) => p.trim()).join(';') + ';';
  } else {
    const match = /^(?:sb|servicebus):\/\/([^/?#@]+)\/?$/i.exec(trimmed);
    if (!match) throw new Error(`"${url}" is not a Service Bus connection string or sb://host endpoint`);
    const emulator = emulatorField || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(match[1]);
    if (!emulator && !(options.username && options.password)) throw new Error('Service Bus needs the shared access key name (username) and key (password), or a full connection string');
    connectionString = `Endpoint=sb://${match[1]};SharedAccessKeyName=${options.username || 'RootManageSharedAccessKey'};SharedAccessKey=${options.password || 'SAS_KEY_VALUE'};${emulator ? 'UseDevelopmentEmulator=true;' : ''}`;
  }
  const emulator = emulatorField || isEmulatorConnectionString(connectionString);
  if (!emulator && !/SharedAccessKey=[^;]+/i.test(connectionString) && !/SharedAccessSignature=/i.test(connectionString)) throw new Error('the connection string has no SharedAccessKey (put it in the password field)');
  return {
    connectionId,
    connectionString,
    ...(options.prefix && { prefix: options.prefix }),
    ...(emulator && { emulator: true }),
    ...(typeof options.maxMessageBytes === 'number' && { maxMessageBytes: options.maxMessageBytes }),
    ...(typeof options.maxMessageBytes === 'string' && /^\d+$/.test(options.maxMessageBytes) && { maxMessageBytes: Number(options.maxMessageBytes) }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [servicebus({ connectionString })] })`. `connectionId` defaults to `env-servicebus`. */
export function servicebus(config: Omit<ServiceBusConfig, 'connectionId'> & { connectionId?: string }): BrokerTarget<ServiceBusConfig> {
  const full: ServiceBusConfig = { ...config, connectionId: config.connectionId ?? 'env-servicebus' };
  return { kind: 'servicebus', config: full, driver: () => new ServiceBusDriver() };
}

const servicebusModule: DriverModule<ServiceBusConfig> = {
  kind: 'servicebus',
  label: 'Azure Service Bus',
  capabilities: SERVICEBUS_CAPABILITIES,
  exampleUrl: 'Endpoint=sb://namespace.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=…',
  fields: [
    { name: 'emulator', label: 'Development emulator', type: 'boolean', hint: 'UseDevelopmentEmulator=true: fixed entities from Config.json, 256 KiB messages' },
    { name: 'maxMessageBytes', label: 'Max message bytes', type: 'number', placeholder: '245760', hint: '240 KiB on Standard and the emulator; up to 1 MiB on Premium' },
  ],
  create: () => new ServiceBusDriver(),
  configFrom: servicebusConfigFrom,
};

export default servicebusModule;
