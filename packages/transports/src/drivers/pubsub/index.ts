/**
 * `@landflow/transports/pubsub`: the Google Cloud Pub/Sub driver (kind `pubsub`; docs/protocol.md §14.9).
 *
 * - **Emulator only by default.** The connection names the emulator (`pubsub://127.0.0.1:58085/landflow-dev`); the real
 *   service (`pubsub.googleapis.com`, Google credentials) is used only with `allowCloud: true`. In emulator mode the
 *   client gets an insecure channel and `METADATA_SERVER_DETECTION=none` is defaulted so the auth library does not probe
 *   for a GCE metadata server.
 * - A channel is a **topic** (`<topicPrefix><channel>`; channel names are valid resource ids as they are). A **shared**
 *   channel has one subscription per work-sharing group (the channel name, as the core uses it), created in `declare()`
 *   so events published before the first consumer wait for it, with message ordering on and a **dead-letter policy**
 *   (`<topic>.dlq`, `maxDeliveryAttempts` 100): Pub/Sub populates `delivery_attempt` only on subscriptions with one, and
 *   `attempt` comes from it. Consumers stream-pull with flow control = `prefetch`; the client extends ack deadlines of
 *   in-flight messages. `ack()` acks, `nack({ requeue: true })` and a closing consumer nack (ack deadline 0: immediate
 *   redelivery), `nack({ requeue: false })` acks.
 * - **Broadcast** channels (reply, registry, control) get one subscription per consumer (`<topic>.bc.<consumerId>`,
 *   retention 10 min, expires after a day without consumers, deleted on `close()`), so every consumer sees every event
 *   published after it subscribed.
 * - **Mode**: binary; every attribute travels as a message attribute with the `ce_` prefix (`content-type` bare), well
 *   under Pub/Sub's 100 attributes × 1024 bytes. Ordering keys are honoured (`orderingKeys: true`).
 * - **Limits**: 10 MB per message; no per-message TTL (the deadline is checked by the core; subscriptions keep messages
 *   for `retentionSeconds`); Pub/Sub does not expose consumer counts or backlog to clients, so there is no `stats()` and
 *   `undeliverable` is `unknown`. The emulator never expires messages or subscriptions: tests delete what they create.
 *
 * The client is `@google-cloud/pubsub`, imported lazily in `connect()`.
 */
import { randomBytes } from 'node:crypto';
import type { Message, PubSub, Subscription as PubSubSubscription, Topic } from '@google-cloud/pubsub';
import {
  NotConnectedError,
  prefixHeaders,
  unprefixHeaders,
  type BrokerCapabilities,
  type BrokerConfig,
  type BrokerDriver,
  type ChannelSpec,
  type ConsumeHandler,
  type ConsumeOptions,
  type Delivery,
  type PublishOptions,
  type PublishOutcome,
  type Subscription,
  type WireEvent,
} from '../../driver';
import type { BrokerTarget, ConnectionOptions, DriverModule } from '../index';

/** Pub/Sub's maximum message size (10 MB, decimal). */
export const PUBSUB_MAX_MESSAGE_BYTES = 10_000_000;
export const DEFAULT_ACK_DEADLINE_SECONDS = 30;
export const DEFAULT_RETENTION_SECONDS = 3600;
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 100;
export const HEADER_PREFIX = 'ce_';
const BROADCAST_INFIX = '.bc.';
const DLQ_SUFFIX = '.dlq';
const ALREADY_EXISTS = 6;
const NOT_FOUND = 5;

export interface PubSubConfig extends BrokerConfig {
  projectId: string;
  /** The emulator, `host:port` (`127.0.0.1:58085`). Absent: the real service, which needs `allowCloud`. */
  emulatorHost?: string;
  /** Opt in to the real service (Google credentials from the environment). Never set in tests. */
  allowCloud?: boolean;
  /** Prepended to every topic and subscription id (default none; channel names already start with the channel prefix). */
  topicPrefix?: string;
  /** Largest event accepted (default and maximum 10 MB). */
  maxMessageBytes?: number;
  /** Ack deadline of request subscriptions (10–600 s, default 30); in-flight messages extend it. Redelivery after a hard crash waits this long. */
  ackDeadlineSeconds?: number;
  /** Message retention of request subscriptions (600–604800 s, default 1 h). */
  retentionSeconds?: number;
  /** Attach a dead-letter topic to request subscriptions so `delivery_attempt` is populated (default true). */
  deadLetter?: boolean;
  /** `maxDeliveryAttempts` of the dead-letter policy (5–100, default 100). */
  maxDeliveryAttempts?: number;
  /** How long one call to the emulator or service may take on connect (default 10 s). */
  connectTimeoutMs?: number;
}

export const PUBSUB_CAPABILITIES: BrokerCapabilities = {
  replies: 'reply-channel',
  workSharing: true,
  buffering: true,
  ttl: false,
  undeliverable: 'unknown',
  persistence: 'disk',
  maxMessageBytes: PUBSUB_MAX_MESSAGE_BYTES,
  latency: 'medium',
  headers: true,
  orderingKeys: true,
  nack: true,
  attempts: true,
};

const truthy = (value: unknown) => value === true || value === 'true' || value === '1' || value === 1;
const falsy = (value: unknown) => value === false || value === 'false' || value === '0' || value === 0;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * The config for a connection: `url` is `pubsub://<emulatorHost:port>/<projectId>` (`pubsub://127.0.0.1:58085/landflow-dev`)
 * or `pubsub://<projectId>` for the real service (needs `allowCloud`); `pubsub://pubsub.googleapis.com/<projectId>` is the
 * real service too. Fields: `projectId` (wins over the URL), `emulatorHost` (wins over the URL), `allowCloud`, `topicPrefix`,
 * the numeric tunables and `deadLetter`.
 */
export function pubsubConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): PubSubConfig {
  const raw = url.trim();
  let parsed: URL | undefined;
  if (raw) {
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Pub/Sub URL "${url}" must look like pubsub://127.0.0.1:58085/<projectId> (emulator) or pubsub://<projectId>`);
    }
    if (parsed.protocol !== 'pubsub:') throw new Error(`Pub/Sub URL "${url}" must use pubsub://`);
    if (!parsed.hostname) throw new Error(`Pub/Sub URL "${url}" has no host or project`);
  }
  const path = parsed?.pathname.replace(/^\/+|\/+$/g, '') ?? '';
  const hostIsProject = Boolean(parsed) && !parsed!.port && !path && !parsed!.hostname.includes('.');
  const hostIsCloud = Boolean(parsed) && /\.googleapis\.com$/i.test(parsed!.hostname);
  const projectId = text(options.projectId) ?? (hostIsProject ? parsed!.hostname : path || undefined);
  if (!projectId) throw new Error('Pub/Sub needs a project id (the "projectId" field or pubsub://host:port/<projectId>)');
  if (!PROJECT_RE.test(projectId)) throw new Error(`Pub/Sub project id "${projectId}" must be 6–30 lower-case letters, digits or hyphens, starting with a letter`);
  const allowCloud = truthy(options.allowCloud);
  let emulatorHost = text(options.emulatorHost);
  if (!emulatorHost && parsed && !hostIsProject && !hostIsCloud) emulatorHost = parsed.host;
  if (emulatorHost) {
    if (!/^[A-Za-z0-9.\-_[\]:]+:\d{1,5}$/.test(emulatorHost)) throw new Error(`Pub/Sub emulator host "${emulatorHost}" must be host:port`);
  } else if (!allowCloud) {
    throw new Error('Pub/Sub needs the emulator (pubsub://127.0.0.1:58085/<projectId>): the real service is used only with allowCloud');
  }
  const config: PubSubConfig = {
    connectionId,
    projectId,
    ...(options.prefix && { prefix: options.prefix }),
    ...(emulatorHost && { emulatorHost }),
    ...(allowCloud && { allowCloud: true }),
  };
  if (text(options.topicPrefix)) config.topicPrefix = text(options.topicPrefix);
  for (const key of ['maxMessageBytes', 'ackDeadlineSeconds', 'retentionSeconds', 'maxDeliveryAttempts', 'connectTimeoutMs'] as const) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) config[key] = value;
  }
  if (falsy(options.deadLetter)) config.deadLetter = false;
  if (config.maxMessageBytes && config.maxMessageBytes > PUBSUB_MAX_MESSAGE_BYTES) throw new Error(`Pub/Sub maxMessageBytes ${config.maxMessageBytes} is above the service limit of ${PUBSUB_MAX_MESSAGE_BYTES}`);
  return config;
}

/** The topic id of a channel: a valid resource id (`[A-Za-z0-9._~%+-]{3,255}`, starting with a letter, never `goog…`). */
export function topicIdOf(channel: string, topicPrefix = ''): string {
  let id = (topicPrefix + channel).replace(/[^A-Za-z0-9._~%+-]/g, '_');
  if (!/^[A-Za-z]/.test(id) || /^goog/i.test(id)) id = `lf-${id}`;
  while (id.length < 3) id += '_';
  return id.slice(0, 255);
}

/** The subscription id a work-sharing group uses on a channel: the topic id when the group is the channel (the core's case). */
export function sharedSubscriptionIdOf(channel: string, group: string, topicPrefix = ''): string {
  const topic = topicIdOf(channel, topicPrefix);
  return group === channel ? topic : `${topic}.${group.replace(/[^A-Za-z0-9._~%+-]/g, '_')}`.slice(0, 255);
}

const code = (error: unknown) => (error as { code?: number })?.code;
const isEmulatorHost = (host: string) => !/\.googleapis\.com(:\d+)?$/i.test(host);
type PubSubModule = typeof import('@google-cloud/pubsub');

export class PubSubDriver implements BrokerDriver<PubSubConfig> {
  readonly kind = 'pubsub';
  readonly capabilities: BrokerCapabilities = { ...PUBSUB_CAPABILITIES };
  private client?: PubSub;
  private config?: PubSubConfig;
  private closing = false;
  private readonly specs = new Map<string, ChannelSpec>();
  private readonly topics = new Map<string, Topic>();
  private readonly declaredSubscriptions = new Set<string>();
  private readonly subscriptions = new Set<Subscription>();
  /** Instance and reply channels this driver declared: their topic and subscriptions die with the process (`close()` deletes them). */
  private readonly ownedInstances = new Set<string>();

  async connect(config: PubSubConfig): Promise<void> {
    if (this.client) throw new Error('Pub/Sub driver is already connected');
    if (!config.projectId) throw new Error('Pub/Sub needs a project id');
    if (!config.emulatorHost && !config.allowCloud) throw new Error('Pub/Sub needs an emulator host (127.0.0.1:58085) unless allowCloud is set');
    if (config.emulatorHost && !isEmulatorHost(config.emulatorHost)) throw new Error(`Pub/Sub emulator host "${config.emulatorHost}" is the real service; set allowCloud and no emulator host for that`);
    if (config.emulatorHost) process.env.METADATA_SERVER_DETECTION ??= 'none';
    const { PubSub } = (await import('@google-cloud/pubsub')) as PubSubModule;
    const client = new PubSub({ projectId: config.projectId, ...(config.emulatorHost && { apiEndpoint: config.emulatorHost }) });
    try {
      await client.getTopics({ pageSize: 1, autoPaginate: false, gaxOpts: { timeout: config.connectTimeoutMs ?? 10_000 } });
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(`Pub/Sub at ${config.emulatorHost ?? 'pubsub.googleapis.com'} (project ${config.projectId}) is not reachable: ${(error as Error).message}`);
    }
    this.client = client;
    this.config = config;
    this.capabilities.maxMessageBytes = Math.min(config.maxMessageBytes ?? PUBSUB_MAX_MESSAGE_BYTES, PUBSUB_MAX_MESSAGE_BYTES);
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureReady();
    for (const spec of channels) {
      this.specs.set(spec.name, spec);
      await this.ensureTopic(spec.name);
      if (spec.delivery === 'shared') await this.ensureSharedSubscription(spec.name, spec.name);
      if (spec.role === 'instance' || spec.role === 'reply') this.ownedInstances.add(spec.name);
    }
  }

  async publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome> {
    this.ensureReady();
    const topic = await this.ensureTopic(channel);
    const attributes = prefixHeaders(event.headers, HEADER_PREFIX);
    const data = Buffer.from(event.body.buffer, event.body.byteOffset, event.body.byteLength);
    try {
      await topic.publishMessage({ data, attributes, ...(options?.orderingKey && { orderingKey: options.orderingKey }) });
    } catch (error) {
      if (options?.orderingKey) topic.resumePublishing(options.orderingKey); // a failed ordered publish pauses the key
      throw error;
    }
    return 'accepted';
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureReady();
    const subscription = options.group ? await this.consumeShared(channel, options, onEvent) : await this.consumeBroadcast(channel, options, onEvent);
    this.subscriptions.add(subscription);
    return subscription;
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client || this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.subscriptions].map((s) => s.close()));
    this.subscriptions.clear();
    await Promise.allSettled([...this.topics.values()].map((t) => t.flush()));
    // Instance and reply channels belong to this process: nobody else will ever consume them.
    const owned = [...this.ownedInstances];
    this.closing = false; // deleteChannels needs the client for a moment
    await this.deleteChannels(...owned).catch(() => {});
    this.closing = true;
    this.client = undefined;
    await client.close().catch(() => {});
  }

  /** Delete the topics and subscriptions of channels (tests and operators), including dead-letter topics and per-consumer subscriptions. */
  async deleteChannels(...channels: string[]): Promise<void> {
    const client = this.ensureReady();
    const prefix = this.config!.topicPrefix;
    for (const channel of channels) {
      const topicId = topicIdOf(channel, prefix);
      for (const id of [topicId, topicId + DLQ_SUFFIX]) {
        const topic = client.topic(id);
        const [subs] = await topic.getSubscriptions().catch(() => [[] as PubSubSubscription[]]);
        for (const sub of subs) await sub.delete().catch(() => {});
        await topic.delete().catch(() => {});
      }
      this.topics.delete(channel);
    }
  }

  private ensureReady(): PubSub {
    if (!this.client || this.closing) throw new NotConnectedError('pubsub driver is not connected');
    return this.client;
  }

  private async ensureTopic(channel: string): Promise<Topic> {
    const cached = this.topics.get(channel);
    if (cached) return cached;
    const client = this.ensureReady();
    const id = topicIdOf(channel, this.config!.topicPrefix);
    await client.createTopic(id).catch((error: unknown) => {
      if (code(error) !== ALREADY_EXISTS) throw error;
    });
    const topic = client.topic(id, { messageOrdering: true, batching: { maxMilliseconds: 2 } });
    this.topics.set(channel, topic);
    return topic;
  }

  private async ensureSharedSubscription(channel: string, group: string): Promise<string> {
    const client = this.ensureReady();
    const config = this.config!;
    const id = sharedSubscriptionIdOf(channel, group, config.topicPrefix);
    if (this.declaredSubscriptions.has(id)) return id;
    const topic = await this.ensureTopic(channel);
    const spec = this.specs.get(channel);
    const deadLetter = config.deadLetter !== false;
    let deadLetterTopic: string | undefined;
    if (deadLetter) {
      const dlq = client.topic(topicIdOf(channel, config.topicPrefix) + DLQ_SUFFIX);
      await client.createTopic(dlq.name).catch((error: unknown) => {
        if (code(error) !== ALREADY_EXISTS) throw error;
      });
      deadLetterTopic = dlq.name;
    }
    const retention = Math.min(604_800, Math.max(600, config.retentionSeconds ?? DEFAULT_RETENTION_SECONDS));
    await topic
      .createSubscription(id, {
        ackDeadlineSeconds: Math.min(600, Math.max(10, config.ackDeadlineSeconds ?? DEFAULT_ACK_DEADLINE_SECONDS)),
        enableMessageOrdering: true,
        messageRetentionDuration: { seconds: retention },
        // Instance subscriptions die with their process; request subscriptions never expire on their own.
        expirationPolicy: spec?.role === 'instance' ? { ttl: { seconds: 86_400 } } : {},
        ...(deadLetterTopic && { deadLetterPolicy: { deadLetterTopic, maxDeliveryAttempts: Math.min(100, Math.max(5, config.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS)) } }),
      })
      .catch((error: unknown) => {
        if (code(error) !== ALREADY_EXISTS) throw error;
      });
    this.declaredSubscriptions.add(id);
    return id;
  }

  // --- consumers ---------------------------------------------------------------------------------------------------------------

  private async consumeShared(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const id = await this.ensureSharedSubscription(channel, options.group!);
    return this.attach(channel, id, options, onEvent, undefined);
  }

  private async consumeBroadcast(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const topic = await this.ensureTopic(channel);
    const id = `${topicIdOf(channel, this.config!.topicPrefix)}${BROADCAST_INFIX}${randomBytes(5).toString('hex')}`.slice(0, 255);
    const [created] = await topic.createSubscription(id, { ackDeadlineSeconds: 10, messageRetentionDuration: { seconds: 600 }, expirationPolicy: { ttl: { seconds: 86_400 } } });
    return this.attach(channel, id, { ...options, ackMode: 'auto' }, onEvent, async () => {
      await created.delete().catch(() => {});
    });
  }

  private attach(channel: string, id: string, options: ConsumeOptions, onEvent: ConsumeHandler, onClose: (() => Promise<void>) | undefined): Subscription {
    const client = this.ensureReady();
    const config = this.config!;
    const manual = options.ackMode === 'manual';
    const prefetch = Math.max(1, options.prefetch);
    // The ack deadline is the subscription's (set when it was created); the client extends it for messages in flight.
    const sub = client.subscription(id, { flowControl: { maxMessages: prefetch, allowExcessMessages: false }, streamingOptions: { maxStreams: 1 } });
    const inFlight = new Set<Message>();
    let closed = false;
    sub.on('message', (message: Message) => {
      if (closed) {
        message.nack();
        return;
      }
      const attempt = message.deliveryAttempt && message.deliveryAttempt > 0 ? message.deliveryAttempt : 1;
      if (manual) inFlight.add(message);
      else message.ack();
      let settled = !manual;
      const settle = () => {
        if (settled) return false;
        settled = true;
        inFlight.delete(message);
        return true;
      };
      const delivery: Delivery = {
        attempt,
        ack: async () => {
          if (settle()) message.ack();
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (requeue) message.nack();
          else message.ack();
        },
      };
      const event: WireEvent = { headers: unprefixHeaders(message.attributes ?? {}, HEADER_PREFIX), body: new Uint8Array(message.data) };
      onEvent(event, delivery).catch(() => delivery.nack({ requeue: false }));
    });
    sub.on('error', () => {
      /* stream errors are retried by the client; a deleted subscription ends deliveries */
    });
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        // As if this consumer had died, only sooner: what it holds goes back now.
        for (const message of inFlight) message.nack();
        inFlight.clear();
        await sub.close().catch(() => {});
        await onClose?.().catch(() => {});
      },
    };
    return subscription;
  }
}

/** A new, unconnected Pub/Sub driver. */
export const pubsubDriver = (): BrokerDriver<PubSubConfig> => new PubSubDriver();

const pubsubModule: DriverModule<PubSubConfig> = {
  kind: 'pubsub',
  label: 'Google Pub/Sub',
  capabilities: PUBSUB_CAPABILITIES,
  exampleUrl: 'pubsub://127.0.0.1:58085/landflow-dev',
  fields: [
    { name: 'projectId', label: 'Project', type: 'string', placeholder: 'landflow-dev', hint: 'The Google Cloud project; the URL path (/landflow-dev) sets it too.' },
    { name: 'emulatorHost', label: 'Emulator host', type: 'string', placeholder: '127.0.0.1:58085', hint: 'host:port of the Pub/Sub emulator; wins over the URL. Required unless "Allow Google Cloud" is on.' },
    { name: 'allowCloud', label: 'Allow Google Cloud', type: 'boolean', hint: 'Use the real service with Google credentials from the environment when no emulator host is set. Off by default; never on in tests.' },
    { name: 'topicPrefix', label: 'Topic prefix', type: 'string', placeholder: 'landflow-', hint: 'Prepended to every topic and subscription id; leave empty unless the project is shared.' },
  ],
  create: pubsubDriver,
  configFrom: pubsubConfigFrom,
};

export default pubsubModule;

export interface PubSubTargetOptions extends Omit<PubSubConfig, 'connectionId'> {
  /** Default `env-pubsub`: the connection the host reads from `LANDFLOW_TRANSPORT_PUBSUB_URL`. */
  connectionId?: string;
}

/** The SDK's broker target for Pub/Sub: `pubsub({ projectId: 'landflow-dev', emulatorHost: '127.0.0.1:58085' })`. */
export function pubsub(options: PubSubTargetOptions): BrokerTarget<PubSubConfig> {
  const { connectionId = 'env-pubsub', ...rest } = options;
  if (!rest.projectId) throw new Error('pubsub(): "projectId" is required');
  if (!rest.emulatorHost && !rest.allowCloud) throw new Error('pubsub(): "emulatorHost" is required (127.0.0.1:58085) unless allowCloud is set');
  return { kind: 'pubsub', config: { connectionId, ...rest }, driver: pubsubDriver };
}
