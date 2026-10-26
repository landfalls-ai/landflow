/**
 * `@landflow/transports/memory`: an in-process broker and its driver, for tests and for running the core without a
 * broker. One `MemoryBroker` is shared by any number of driver instances (a "host" and several "plugin replicas" in one
 * process); its capabilities are configurable so tests can simulate a broker without headers, without native replies,
 * with a small message limit, that cannot report undeliverable events, or with latency.
 *
 * Semantics (the reference every real driver is compared with by the conformance suite):
 * - **Work sharing**: consumers with the same `group` compete; each event goes to one of them (round robin among those
 *   under their prefetch), FIFO per channel. Consumers without a group each get every event.
 * - **Buffering**: events published while a channel has no consumer wait (when `buffering`) and go to the first consumer
 *   that arrives; else they are dropped. With `undeliverable: 'reported'`, publishing to a channel with no consumer returns
 *   `unroutable` instead.
 * - **Ack/nack/redelivery**: `nack({ requeue: true })` puts the event at the head of its group's queue with `attempt + 1`;
 *   closing a subscription (or the driver) requeues its unacknowledged deliveries, like a broker does when a consumer dies.
 * - **Native replies** (`replies: 'native'`): `request()` waits for `Delivery.reply()`; `unroutable` with no consumer.
 * - **TTL**: expired events are dropped when dequeued (when `ttl`).
 * - Test hooks: `tap()` sees (and may alter or drop) every event in flight (native replies under `<channel>:reply`); `stats()`.
 */
import {
  NotConnectedError,
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
} from '../driver';

export const MEMORY_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: true,
  undeliverable: 'reported',
  persistence: 'memory',
  maxMessageBytes: 1024 * 1024,
  latency: 'low',
  headers: true,
  orderingKeys: true,
  nack: true,
  attempts: true,
};

export interface MemoryBrokerOptions {
  capabilities?: Partial<BrokerCapabilities>;
  /** Delay every delivery by this many ms (0: next microtask). */
  latencyMs?: number;
}

export interface MemoryConfig extends BrokerConfig {}

/** Alter or drop (return `null`) an event in flight; for tamper and loss tests. */
export type Tap = (channel: string, event: WireEvent) => WireEvent | null;

interface Message {
  event: WireEvent;
  attempt: number;
  expiresAt?: number;
  orderingKey?: string;
  /** Native request: resolves the requester's promise. */
  replyTo?: (event: WireEvent) => void;
}

interface Consumer {
  id: number;
  driver: MemoryDriver;
  group?: string;
  options: ConsumeOptions;
  handler: ConsumeHandler;
  inFlight: Set<Message>;
  closed: boolean;
}

interface Group {
  name: string;
  queue: Message[];
  consumers: Consumer[];
  next: number;
}

interface Channel {
  spec?: ChannelSpec;
  groups: Map<string, Group>;
  broadcast: Consumer[];
  /** Waiting for the first consumer. */
  pending: Message[];
}

const clone = (event: WireEvent): WireEvent => ({ headers: { ...event.headers }, body: new Uint8Array(event.body) });

export class MemoryBroker {
  readonly capabilities: BrokerCapabilities;
  private readonly channels = new Map<string, Channel>();
  private readonly taps = new Set<Tap>();
  private consumerIds = 0;
  /** Events accepted by `publish()`/`request()` so far. */
  published = 0;

  constructor(private readonly options: MemoryBrokerOptions = {}) {
    this.capabilities = { ...MEMORY_CAPABILITIES, ...options.capabilities };
  }

  /** A new, unconnected driver on this broker. */
  driver(): BrokerDriver<MemoryConfig> {
    return new MemoryDriver(this);
  }

  tap(tap: Tap): () => void {
    this.taps.add(tap);
    return () => this.taps.delete(tap);
  }

  channel(name: string): Channel {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { groups: new Map(), broadcast: [], pending: [] };
      this.channels.set(name, channel);
    }
    return channel;
  }

  declare(specs: ChannelSpec[]): void {
    for (const spec of specs) this.channel(spec.name).spec = spec;
  }

  stats(name: string): ChannelStats {
    const channel = this.channels.get(name);
    if (!channel) return { depth: 0, consumers: 0 };
    let depth = channel.pending.length;
    let consumers = channel.broadcast.length;
    for (const group of channel.groups.values()) {
      depth = Math.max(depth, group.queue.length);
      consumers += group.consumers.length;
    }
    return { depth, consumers };
  }

  hasConsumers(name: string): boolean {
    return this.stats(name).consumers! > 0;
  }

  publish(name: string, event: WireEvent, options: PublishOptions = {}, replyTo?: (event: WireEvent) => void): PublishOutcome {
    const size = Object.entries(event.headers).reduce((sum, [k, v]) => sum + Buffer.byteLength(k) + Buffer.byteLength(v), event.body.byteLength);
    if (size > this.capabilities.maxMessageBytes) throw new Error(`message of ${size} bytes exceeds the broker limit of ${this.capabilities.maxMessageBytes}`);
    let carried: WireEvent | null = clone(event);
    for (const tap of this.taps) {
      carried = tap(name, carried);
      if (!carried) return 'accepted';
    }
    if (!this.capabilities.headers) {
      // A broker without headers carries only the body; keep content-type so decoding is unambiguous, drop the rest.
      const contentType = carried.headers['content-type'];
      carried = { headers: contentType ? { 'content-type': contentType } : {}, body: carried.body };
    }
    const channel = this.channel(name);
    const message: Message = {
      event: carried,
      attempt: 1,
      orderingKey: options.orderingKey,
      replyTo,
      ...(this.capabilities.ttl && options.ttlMs !== undefined && { expiresAt: Date.now() + options.ttlMs }),
    };
    if (!this.hasConsumers(name)) {
      if (this.capabilities.undeliverable === 'reported') return 'unroutable';
      if (this.capabilities.buffering) channel.pending.push(message);
      this.published++;
      return 'accepted';
    }
    this.published++;
    for (const consumer of channel.broadcast) this.deliver(consumer, { ...message, event: clone(message.event) }, undefined);
    for (const group of channel.groups.values()) {
      group.queue.push(group.consumers.length === 0 || channel.groups.size === 1 ? message : { ...message, event: clone(message.event) });
      this.pump(name, group);
    }
    return 'accepted';
  }

  consume(driver: MemoryDriver, name: string, options: ConsumeOptions, handler: ConsumeHandler): Consumer {
    const channel = this.channel(name);
    const consumer: Consumer = { id: ++this.consumerIds, driver, group: this.capabilities.workSharing ? options.group : undefined, options, handler, inFlight: new Set(), closed: false };
    if (consumer.group) {
      let group = channel.groups.get(consumer.group);
      if (!group) {
        group = { name, queue: [], consumers: [], next: 0 };
        channel.groups.set(consumer.group, group);
      }
      group.consumers.push(consumer);
      if (channel.pending.length > 0) {
        group.queue.push(...channel.pending);
        channel.pending = [];
      }
      this.pump(name, group);
    } else {
      channel.broadcast.push(consumer);
      const pending = channel.pending;
      channel.pending = [];
      for (const message of pending) this.deliver(consumer, message, undefined);
    }
    return consumer;
  }

  unsubscribe(name: string, consumer: Consumer): void {
    if (consumer.closed) return;
    consumer.closed = true;
    const channel = this.channel(name);
    if (consumer.group) {
      const group = channel.groups.get(consumer.group)!;
      group.consumers = group.consumers.filter((c) => c !== consumer);
      // The consumer died: what it held goes back for the others.
      for (const message of consumer.inFlight) group.queue.unshift({ ...message, attempt: message.attempt + 1 });
      consumer.inFlight.clear();
      if (group.consumers.length === 0) {
        channel.pending.push(...group.queue);
        channel.groups.delete(consumer.group);
      } else this.pump(name, group);
    } else {
      channel.broadcast = channel.broadcast.filter((c) => c !== consumer);
    }
  }

  private pump(name: string, group: Group): void {
    while (group.queue.length > 0) {
      const candidates = group.consumers.filter((c) => !c.closed && c.inFlight.size < c.options.prefetch);
      if (candidates.length === 0) return;
      const message = group.queue.shift()!;
      if (message.expiresAt !== undefined && message.expiresAt <= Date.now()) continue;
      const consumer = candidates[group.next++ % candidates.length];
      this.deliver(consumer, message, group);
    }
  }

  private deliver(consumer: Consumer, message: Message, group: Group | undefined): void {
    const manual = consumer.options.ackMode === 'manual' && group !== undefined;
    if (manual) consumer.inFlight.add(message);
    let settled = !manual;
    const settle = () => {
      if (settled) return false;
      settled = true;
      consumer.inFlight.delete(message);
      return true;
    };
    const delivery: Delivery = {
      attempt: message.attempt,
      ack: async () => {
        if (settle() && group) this.pump(group.name, group);
      },
      nack: async ({ requeue = false } = {}) => {
        if (!settle() || !group) return;
        if (requeue && this.capabilities.nack) group.queue.unshift({ ...message, attempt: message.attempt + 1 });
        this.pump(group.name, group);
      },
      ...(this.capabilities.replies === 'native' && {
        reply: async (event: WireEvent) => {
          let carried: WireEvent | null = clone(event);
          for (const tap of this.taps) {
            carried = tap(`${group?.name ?? ''}:reply`, carried);
            if (!carried) return;
          }
          message.replyTo?.(carried);
        },
      }),
    };
    const run = () => {
      if (consumer.closed || !consumer.driver.connected) return;
      consumer.handler(clone(message.event), delivery).catch(() => delivery.nack({ requeue: false }));
    };
    if (this.options.latencyMs) setTimeout(run, this.options.latencyMs);
    else void Promise.resolve().then(run);
  }

}

class MemoryDriver implements BrokerDriver<MemoryConfig> {
  readonly kind = 'memory';
  readonly capabilities: BrokerCapabilities;
  connected = false;
  private subscriptions = new Set<Subscription>();

  constructor(private readonly broker: MemoryBroker) {
    this.capabilities = broker.capabilities;
    if (this.capabilities.replies === 'native') this.request = this.nativeRequest;
  }

  async connect(_config: MemoryConfig): Promise<void> {
    this.connected = true;
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureConnected();
    this.broker.declare(channels);
  }

  async publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome> {
    this.ensureConnected();
    return this.broker.publish(channel, event, options);
  }

  request?: (channel: string, event: WireEvent, options: RequestOptions) => Promise<RequestOutcome>;

  private nativeRequest = (channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome> => {
    this.ensureConnected();
    return new Promise<RequestOutcome>((resolve) => {
      const timer = setTimeout(() => resolve({ outcome: 'timeout' }), options.timeoutMs);
      const outcome = this.broker.publish(channel, event, { orderingKey: options.orderingKey, ttlMs: options.timeoutMs }, (reply) => {
        clearTimeout(timer);
        resolve({ outcome: 'replied', event: reply });
      });
      if (outcome === 'unroutable') {
        clearTimeout(timer);
        resolve({ outcome: 'unroutable' });
      }
    });
  };

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureConnected();
    const consumer = this.broker.consume(this, channel, options, onEvent);
    const subscription: Subscription = {
      channel,
      close: async () => {
        this.broker.unsubscribe(channel, consumer);
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  async stats(channel: string): Promise<ChannelStats> {
    this.ensureConnected();
    return this.broker.stats(channel);
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const subscription of [...this.subscriptions]) await subscription.close();
  }

  private ensureConnected(): void {
    if (!this.connected) throw new NotConnectedError('memory driver is not connected');
  }
}

/** A driver on `broker` (the same as `broker.driver()`). */
export const memoryDriver = (broker: MemoryBroker): BrokerDriver<MemoryConfig> => broker.driver();
