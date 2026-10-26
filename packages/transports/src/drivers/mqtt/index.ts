/**
 * `@landflow/transports/mqtt`: the MQTT 5 driver (Mosquitto, EMQX, HiveMQ, …) on MQTT.js (`mqtt`, an optional peer
 * dependency imported lazily in `connect()`).
 *
 * Mapping (docs/protocol.md §14.9):
 * - **Topics**: a channel name becomes a topic with `/` for `.` (`landflow.v1.plugin.twilio` → `landflow/v1/plugin/twilio`),
 *   consistently in both directions; channel names never contain `/`, `+` or `#`.
 * - **Shared channels** (request, instance) are consumed through a **shared subscription**, `$share/<group>/<topic>`, so
 *   replicas with the same group compete; published and subscribed at **QoS 1**. **Broadcast channels** (registry, control)
 *   are plain subscriptions at **QoS 0**: every consumer gets every event, nothing is acknowledged.
 * - **CloudEvents MQTT binding**, binary mode: every attribute is a **user property** under its bare name (no prefix), the
 *   body is the payload and `content-type` is the MQTT **Content Type** property.
 * - **Replies are native**: `request()` publishes with a **Response Topic** of its own (`<prefix>/v1/reply/<random>`, one
 *   per driver instance, subscribed at connect) and random **Correlation Data**; `Delivery.reply()` publishes to the
 *   request's response topic with its correlation data. The response topic lives with the connection, so a connection
 *   loss rejects the requests in flight (the core reports `connection_lost`, "the call may have run").
 * - **"Nobody took it"**: an MQTT 5 broker answers a QoS 1 publish that matched no subscription with PUBACK reason
 *   `0x10` "No matching subscribers" (Mosquitto, EMQX, HiveMQ do; the protocol says MAY), so a publish or request to a
 *   shared channel nobody consumes is `unroutable` at once; QoS 0 publishes tell nothing. A broker that never sends
 *   `0x10` only makes such calls wait for the deadline. MQTT has no consumer counts, so there is no `stats()`.
 * - **Acknowledgement, nack and attempts**: MQTT acknowledges a QoS 1 delivery per connection, in order, and MQTT.js sends
 *   the PUBACK as it hands the message over; a deferred PUBACK would stall the connection's inbound packets (our own
 *   PUBACKs and replies with them). So the broker's delivery is acknowledged at once and the driver does what core NATS
 *   does: `nack({ requeue: true })` and a closed subscription **republish** the message on its topic with a
 *   `landflow-attempt` user property (stripped before the core sees it), so another member of the shared subscription (or
 *   the same one) takes it with `attempt` + 1. A process that is killed loses the calls it held (the broker may or may not
 *   redistribute them, MQTT 5 §4.8.2 says SHOULD when the session ends; sessions here are clean, expiry 0). Prefetch is
 *   honoured by holding deliveries in the driver.
 * - **Buffering**: none claimed. With clean sessions a message published while no replica is subscribed is dropped (MQTT
 *   only queues for an offline *persistent* session, which would pin the calls to one dead replica). **TTL**: the
 *   Message Expiry Interval (whole seconds, rounded up; a first filter, the core checks the deadline).
 * - **Size**: 1 MiB by default (`maxMessageBytes`), lowered to the broker's CONNACK Maximum Packet Size when it sends one
 *   (the protocol's own limit is 256 MiB). No ordering keys: a shared subscription round-robins.
 *
 * Reconnect: MQTT.js reconnects with `reconnectPeriodMs` and re-subscribes; `publish()` and `request()` throw
 * `NotConnectedError` while the connection is down (nothing was sent). `close()` is idempotent.
 */
import { randomBytes } from 'node:crypto';
import type { IClientOptions, IConnackPacket, IPublishPacket, MqttClient } from 'mqtt';
import {
  NotConnectedError,
  type BrokerCapabilities,
  type BrokerConfig,
  type BrokerDriver,
  type ChannelSpec,
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

/** Driver user property carrying the attempt of a republished message; never reaches the core. */
export const ATTEMPT_PROPERTY = 'landflow-attempt';
/** PUBACK reason code "No matching subscribers" (MQTT 5 §3.4.2.1). */
export const NO_MATCHING_SUBSCRIBERS = 0x10;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_KEEPALIVE_SECONDS = 30;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_PERIOD_MS = 1_000;
/** A requeued event is republished after this long, so a draining replica does not take it straight back. */
const REQUEUE_DELAY_MS = 25;

export const MQTT_CAPABILITIES: BrokerCapabilities = {
  replies: 'native',
  workSharing: true,
  buffering: false,
  ttl: true,
  undeliverable: 'reported',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'low',
  headers: true,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

export interface MqttConfig extends BrokerConfig {
  /** `mqtt://host:1883`, `mqtts://host:8883`, `ws://host/mqtt` or `wss://…`. */
  url: string;
  username?: string;
  password?: string;
  /** Force TLS (`mqtts`, or `wss` for a WebSocket URL). */
  tls?: boolean;
  /** Client id (default `landflow-<connectionId>-<random>`; the broker sees it). */
  clientId?: string;
  keepaliveSeconds?: number;
  connectTimeoutMs?: number;
  /** Reconnect delay (default 1 s). */
  reconnectPeriodMs?: number;
  /** Largest event accepted (default 1 MiB), lowered to the broker's CONNACK Maximum Packet Size. */
  maxMessageBytes?: number;
  /** TLS: refuse unverifiable certificates (default true). */
  rejectUnauthorized?: boolean;
}

type MqttLib = typeof import('mqtt');

interface PendingRequest {
  resolve: (outcome: RequestOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Held {
  packet: IPublishPacket;
  attempt: number;
}

interface LiveSubscription {
  channel: string;
  topic: string;
  filter: string;
  options: ConsumeOptions;
  onEvent: ConsumeHandler;
  manual: boolean;
  inFlight: Set<Held>;
  queue: Held[];
  closed: boolean;
}

/** A channel name as an MQTT topic (`.` → `/`). */
export const topicOf = (channel: string): string => channel.replaceAll('.', '/');
/** The inverse of `topicOf`. */
export const channelOf = (topic: string): string => topic.replaceAll('/', '.');

/** Whether an undeclared channel is shared (QoS 1, shared subscription) by the core naming `<prefix>.v1.<role>…`; unknown roles are shared. */
export function inferShared(channel: string): boolean {
  const role = channel.split('.')[2];
  return role !== 'reply' && role !== 'registry' && role !== 'control';
}

/** MQTT 5 user properties + Content Type → the bare CloudEvents headers; the driver's own property is dropped. */
export function propertiesToHeaders(userProperties: Record<string, string | string[]> | undefined, contentType: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(userProperties ?? {})) {
    const lower = name.toLowerCase();
    if (lower === ATTEMPT_PROPERTY) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[lower] = first;
  }
  if (contentType) out['content-type'] = contentType;
  return out;
}

/** The bare CloudEvents headers → `{ userProperties, contentType }` for a publish. */
export function headersToProperties(headers: Record<string, string>): { userProperties: Record<string, string>; contentType?: string } {
  const { 'content-type': contentType, ...userProperties } = headers;
  return { userProperties, ...(contentType && { contentType }) };
}

/** The attempt a received packet carries (1 unless republished). */
export function attemptOf(packet: Pick<IPublishPacket, 'properties'>): number {
  const raw = packet.properties?.userProperties?.[ATTEMPT_PROPERTY];
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** Message Expiry Interval takes whole seconds (minimum 1). */
export const expirySeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export class MqttDriver implements BrokerDriver<MqttConfig> {
  readonly kind = 'mqtt';
  /** Per instance: `connect()` lowers `maxMessageBytes` to the broker's Maximum Packet Size. */
  readonly capabilities: BrokerCapabilities = { ...MQTT_CAPABILITIES };
  private config?: MqttConfig;
  private client?: MqttClient;
  private state: 'new' | 'connected' | 'reconnecting' | 'closed' = 'new';
  private readonly specs = new Map<string, ChannelSpec>();
  private readonly subscriptions = new Set<LiveSubscription>();
  /** Broker subscriptions by filter, reference-counted: several local consumers may share one filter. */
  private readonly filters = new Map<string, number>();
  private readonly pending = new Map<string, PendingRequest>();
  /** Message ids whose PUBACK said "No matching subscribers"; consumed by the publish that sent them. */
  private readonly noSubscribers = new Set<number>();
  private replyTopic = '';

  async connect(config: MqttConfig): Promise<void> {
    if (this.state !== 'new') throw new Error(`mqtt driver already ${this.state}`);
    if (!config.url) throw new Error('mqtt: no url configured');
    let lib: MqttLib;
    try {
      lib = await import('mqtt');
    } catch (error) {
      throw new Error(`mqtt: the client library is not installed (pnpm add mqtt): ${(error as Error).message}`);
    }
    this.config = config;
    this.capabilities.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.replyTopic = `${topicOf(config.prefix ?? 'landflow')}/v1/reply/${randomBytes(8).toString('hex')}`;
    const options: IClientOptions = {
      protocolVersion: 5,
      clean: true,
      clientId: config.clientId ?? `landflow-${config.connectionId}-${randomBytes(4).toString('hex')}`,
      ...(config.username !== undefined && { username: config.username, password: config.password ?? '' }),
      keepalive: config.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS,
      connectTimeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      reconnectPeriod: config.reconnectPeriodMs ?? DEFAULT_RECONNECT_PERIOD_MS,
      resubscribe: true,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      properties: { sessionExpiryInterval: 0 },
    };
    let client: MqttClient;
    try {
      client = await lib.connectAsync(connectionUrl(config), options, false);
    } catch (error) {
      this.state = 'new';
      throw new Error(`mqtt: cannot connect to ${redact(config.url)}: ${(error as Error).message}`);
    }
    this.client = client;
    this.applyConnack((client as unknown as { connackPacket?: IConnackPacket }).connackPacket);
    client.on('connect', (connack) => {
      this.applyConnack(connack);
      if (this.state === 'reconnecting') this.state = 'connected';
    });
    // The publish callback gets the stored PUBLISH back, not the PUBACK, so reason 0x10 is noted as the PUBACK arrives.
    client.on('packetreceive', (packet) => {
      if (packet.cmd === 'puback' && (packet as { reasonCode?: number }).reasonCode === NO_MATCHING_SUBSCRIBERS && packet.messageId !== undefined) this.noSubscribers.add(packet.messageId);
    });
    client.on('error', () => undefined);
    client.on('message', (topic, payload, packet) => this.onMessage(topic, payload, packet));
    const offline = () => {
      if (this.state !== 'connected') return;
      this.state = 'reconnecting';
      this.failPending(new Error('mqtt connection lost; the call may have run'));
    };
    client.on('offline', offline);
    client.on('close', offline);
    client.on('disconnect', offline);
    try {
      await client.subscribeAsync(this.replyTopic, { qos: 1 });
    } catch (error) {
      await client.endAsync(true).catch(() => undefined);
      this.client = undefined;
      this.state = 'new';
      throw new Error(`mqtt: cannot subscribe to the reply topic: ${(error as Error).message}`);
    }
    this.state = 'connected';
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureConnected();
    for (const spec of channels) this.specs.set(spec.name, spec);
  }

  async publish(channel: string, event: WireEvent, options: PublishOptions = {}): Promise<PublishOutcome> {
    const client = this.ensureConnected();
    const qos = this.isShared(channel) ? 1 : 0;
    const { userProperties, contentType } = headersToProperties(event.headers);
    const packet = await client.publishAsync(topicOf(channel), toBuffer(event.body), {
      qos,
      properties: { userProperties, ...(contentType && { contentType }), ...(options.ttlMs !== undefined && { messageExpiryInterval: expirySeconds(options.ttlMs) }) },
    });
    return qos === 1 && this.unroutable(packet) ? 'unroutable' : 'accepted';
  }

  async request(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome> {
    const client = this.ensureConnected();
    const correlation = randomBytes(12);
    const key = correlation.toString('hex');
    const { userProperties, contentType } = headersToProperties(event.headers);
    return new Promise<RequestOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({ outcome: 'timeout' });
      }, options.timeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, reject, timer });
      client
        .publishAsync(topicOf(channel), toBuffer(event.body), {
          qos: 1,
          properties: { userProperties, ...(contentType && { contentType }), responseTopic: this.replyTopic, correlationData: correlation, messageExpiryInterval: expirySeconds(options.timeoutMs) },
        })
        .then((packet) => {
          if (this.unroutable(packet) && this.pending.delete(key)) {
            clearTimeout(timer);
            resolve({ outcome: 'unroutable' });
          }
        })
        .catch((error: unknown) => {
          if (this.pending.delete(key)) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    });
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const client = this.ensureConnected();
    const topic = topicOf(channel);
    const shared = Boolean(options.group);
    const filter = shared ? `$share/${options.group}/${topic}` : topic;
    const live: LiveSubscription = { channel, topic, filter, options, onEvent, manual: options.ackMode === 'manual' && shared, inFlight: new Set(), queue: [], closed: false };
    const refs = this.filters.get(filter) ?? 0;
    if (refs === 0) await client.subscribeAsync(filter, { qos: shared ? 1 : 0 });
    this.filters.set(filter, refs + 1);
    this.subscriptions.add(live);
    return {
      channel,
      close: async () => {
        if (live.closed) return;
        live.closed = true;
        this.subscriptions.delete(live);
        const left = (this.filters.get(filter) ?? 1) - 1;
        if (left <= 0) {
          this.filters.delete(filter);
          if (this.client && this.state === 'connected') await this.client.unsubscribeAsync(filter).catch(() => undefined);
        } else this.filters.set(filter, left);
        // As if this consumer had died: what it held goes back on the topic for another member of the group.
        const orphans = [...live.inFlight, ...live.queue.splice(0)];
        live.inFlight.clear();
        for (const held of orphans) await this.republish(held.packet, held.attempt + 1);
      },
    };
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const client = this.client;
    const wasConnected = this.state === 'connected';
    this.state = 'closed';
    this.failPending(new Error('mqtt driver closed'));
    // Leave the shared subscriptions first, so what this driver held cannot come straight back to it.
    if (client && wasConnected && this.filters.size > 0) await client.unsubscribeAsync([...this.filters.keys()]).catch(() => undefined);
    this.filters.clear();
    for (const live of [...this.subscriptions]) {
      live.closed = true;
      this.subscriptions.delete(live);
      const orphans = [...live.inFlight, ...live.queue.splice(0)];
      live.inFlight.clear();
      if (client && wasConnected) for (const held of orphans) await this.republishWith(client, held.packet, held.attempt + 1);
    }
    this.specs.clear();
    this.client = undefined;
    if (client) await client.endAsync(!wasConnected).catch(() => undefined);
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  private applyConnack(connack: IConnackPacket | undefined): void {
    const max = connack?.properties?.maximumPacketSize;
    const wanted = this.config?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    // The packet size covers the fixed header, the topic and the properties too: leave a little room for them.
    this.capabilities.maxMessageBytes = typeof max === 'number' && max > 1024 ? Math.min(wanted, max - 1024) : wanted;
  }

  /** Whether the PUBACK of a QoS 1 publish (MQTT.js hands back the stored PUBLISH, by message id) said "No matching subscribers". */
  private unroutable(packet: { messageId?: number } | undefined): boolean {
    const id = packet?.messageId;
    return id !== undefined && this.noSubscribers.delete(id);
  }

  private isShared(channel: string): boolean {
    const spec = this.specs.get(channel);
    return spec ? spec.delivery === 'shared' : inferShared(channel);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onMessage(topic: string, payload: Buffer, packet: IPublishPacket): void {
    if (topic === this.replyTopic) {
      const correlation = packet.properties?.correlationData;
      const key = correlation ? Buffer.from(correlation).toString('hex') : '';
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'replied', event: toWire(payload, packet) });
      return;
    }
    for (const live of this.subscriptions) {
      if (live.closed || live.topic !== topic) continue;
      const held: Held = { packet, attempt: attemptOf(packet) };
      if (live.manual && live.inFlight.size >= Math.max(1, live.options.prefetch)) live.queue.push(held);
      else this.deliver(live, held);
    }
  }

  private deliver(live: LiveSubscription, held: Held): void {
    const { packet } = held;
    if (live.manual) live.inFlight.add(held);
    let settled = !live.manual;
    const settle = () => {
      if (settled) return false;
      settled = true;
      live.inFlight.delete(held);
      this.pump(live);
      return true;
    };
    const delivery: Delivery = {
      attempt: held.attempt,
      ack: async () => void settle(),
      nack: async ({ requeue = false } = {}) => {
        if (!settle() || !requeue || live.closed) return;
        setTimeout(() => void this.republish(packet, held.attempt + 1), REQUEUE_DELAY_MS).unref?.();
      },
      reply: async (event) => {
        const responseTopic = packet.properties?.responseTopic;
        if (!responseTopic) throw new Error('the request carries no response topic');
        const client = this.ensureConnected();
        const { userProperties, contentType } = headersToProperties(event.headers);
        // Reason 0x10 (the requester is gone) is the normal outcome of a late reply, not an error.
        await client.publishAsync(responseTopic, toBuffer(event.body), { qos: 1, properties: { userProperties, ...(contentType && { contentType }), ...(packet.properties?.correlationData && { correlationData: packet.properties.correlationData }) } });
      },
    };
    void live.onEvent(toWire(packet.payload as Buffer, packet), delivery).catch(() => delivery.nack({ requeue: false }));
  }

  private pump(live: LiveSubscription): void {
    while (!live.closed && live.queue.length > 0 && live.inFlight.size < Math.max(1, live.options.prefetch)) this.deliver(live, live.queue.shift()!);
  }

  /** Put a delivery back on its topic with the next attempt number, keeping its response topic and correlation data. */
  private async republish(packet: IPublishPacket, attempt: number): Promise<void> {
    if (this.state !== 'connected' || !this.client) return;
    await this.republishWith(this.client, packet, attempt);
  }

  private async republishWith(client: MqttClient, packet: IPublishPacket, attempt: number): Promise<void> {
    const properties = { ...packet.properties, userProperties: { ...packet.properties?.userProperties, [ATTEMPT_PROPERTY]: String(attempt) } };
    delete (properties as { subscriptionIdentifier?: unknown }).subscriptionIdentifier;
    delete (properties as { topicAlias?: unknown }).topicAlias;
    try {
      await client.publishAsync(packet.topic, packet.payload as Buffer, { qos: 1, properties });
    } catch {
      /* the connection went away; the event is lost, as it would have been */
    }
  }

  private ensureConnected(): MqttClient {
    if (this.state !== 'connected' || !this.client || !this.client.connected) throw new NotConnectedError(`mqtt driver is ${this.state === 'new' ? 'not connected' : this.state === 'connected' ? 'offline' : this.state}`);
    return this.client;
  }
}

const toBuffer = (body: Uint8Array): Buffer => Buffer.from(body.buffer, body.byteOffset, body.byteLength);
const toWire = (payload: Buffer, packet: IPublishPacket): WireEvent => ({
  headers: propertiesToHeaders(packet.properties?.userProperties as Record<string, string | string[]> | undefined, packet.properties?.contentType),
  body: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
});

/** The URL to dial: `config.url` with `tls` applied (`mqtts`, or `wss` for WebSockets). Credentials go in the options, never the URL. */
export function connectionUrl(config: MqttConfig): string {
  const url = new URL(config.url);
  if (config.tls) url.protocol = url.protocol === 'ws:' || url.protocol === 'wss:' ? 'wss:' : 'mqtts:';
  url.username = '';
  url.password = '';
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
 * Connection config from `mqtt://[user:pass@]host[:1883]`, `mqtts://…`, `tcp://`/`ssl://` (MQTT.js spellings), `ws://host/path`
 * or `wss://…`. The username and password fields win over the URL's; `tls` forces `mqtts` (or `wss`). Readable errors otherwise.
 */
export function mqttConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): MqttConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('MQTT needs a URL, e.g. mqtt://127.0.0.1:1883');
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/^tcp:\/\//i, 'mqtt://').replace(/^(ssl|tls|mqtt\+ssl|mqtt\+tls):\/\//i, 'mqtts://'));
  } catch {
    throw new Error(`"${url}" is not a URL; use mqtt://host:1883 or mqtts://host:8883`);
  }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error(`"${url}" must start with mqtt://, mqtts://, ws:// or wss://`);
  if (!parsed.hostname) throw new Error(`"${url}" has no host`);
  const tls = Boolean(options.tls) || parsed.protocol === 'mqtts:' || parsed.protocol === 'wss:';
  let username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  let password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  if (typeof options.username === 'string' && options.username) {
    username = options.username;
    password = options.password ?? '';
  }
  parsed.username = '';
  parsed.password = '';
  if (tls) parsed.protocol = parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? 'wss:' : 'mqtts:';
  const max = Number(options.maxMessageBytes);
  return {
    connectionId,
    url: parsed.toString(),
    ...(username !== undefined && { username, password: password ?? '' }),
    ...(tls && { tls: true }),
    ...(options.prefix && { prefix: options.prefix }),
    ...(typeof options.clientId === 'string' && options.clientId && { clientId: options.clientId }),
    ...(Number.isFinite(max) && max > 0 && { maxMessageBytes: max }),
  };
}

/** SDK helper: `serve(plugin, { brokers: [mqtt({ url: 'mqtt://127.0.0.1:51883' })] })`. `connectionId` defaults to `env-mqtt`. */
export function mqtt(config: Omit<MqttConfig, 'connectionId'> & { connectionId?: string }): BrokerTarget<MqttConfig> {
  if (!config.url) throw new Error('mqtt(): "url" is required');
  const full: MqttConfig = { ...config, connectionId: config.connectionId ?? 'env-mqtt' };
  return { kind: 'mqtt', config: full, driver: () => new MqttDriver() };
}

const mqttModule: DriverModule<MqttConfig> = {
  kind: 'mqtt',
  label: 'MQTT 5',
  capabilities: MQTT_CAPABILITIES,
  exampleUrl: 'mqtt://mosquitto:1883',
  create: () => new MqttDriver(),
  configFrom: mqttConfigFrom,
};

export default mqttModule;
