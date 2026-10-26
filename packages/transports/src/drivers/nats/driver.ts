/**
 * The NATS driver shared by the two NATS kinds (docs/protocol.md §14.9 "NATS core" and "NATS JetStream"):
 *
 * - **`nats` (core)**: a channel is a subject; replicas share it through a queue group; requests use NATS inboxes
 *   (`nc.request()`, no responders → `unroutable`); nothing is buffered or persisted. Prefetch is honoured by holding
 *   deliveries in the driver (the server does not know about it). `nack({ requeue: true })` and a closed consumer's
 *   unacknowledged deliveries are **republished** on the subject with a `Landflow-Attempt` header, so another queue
 *   member (or the same one) takes them; a process that is killed loses them (core NATS is at most once).
 * - **`jetstream`**: a durable shared channel (the request channel) is a work-queue stream plus one durable pull consumer
 *   per group; the driver pulls at most `prefetch` messages per instance, acks and naks (`numDelivered` = `attempt`),
 *   and carries the requester's inbox in a `Landflow-Reply` header so `Delivery.reply()` still answers natively. Every
 *   other channel (instance, reply, registry, control) is core NATS.
 *
 * CloudEvents go in binary mode with the NATS binding's `ce-` header prefix. Driver headers (`Landflow-*`) never reach the
 * core: `unprefixHeaders()` drops them. The client library (`@nats-io/transport-node`, plus `@nats-io/jetstream` for the
 * JetStream kind) is imported lazily in `connect()`.
 */
import type { JetStreamClient, JetStreamManager, ConsumerMessages } from '@nats-io/jetstream';
import type { Msg, MsgHdrs, NatsConnection, Subscription as NatsSubscription } from '@nats-io/transport-node';
import {
  NotConnectedError,
  prefixHeaders,
  unprefixHeaders,
  type BrokerCapabilities,
  type BrokerConfig,
  type BrokerDriver,
  type BrokerKind,
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
import type { ConnectionOptions } from '../index';

type NatsLib = typeof import('@nats-io/transport-node');
type JetStreamLib = typeof import('@nats-io/jetstream');

/** The CloudEvents NATS protocol binding's header prefix. */
export const NATS_HEADER_PREFIX = 'ce-';
/** Driver headers; `unprefixHeaders()` drops them before the core sees an event. */
const REPLY_HEADER = 'Landflow-Reply';
const ATTEMPT_HEADER = 'Landflow-Attempt';
/** NATS per-message TTL header (server 2.11+, streams with `allow_msg_ttl`). */
const TTL_HEADER = 'Nats-TTL';
/** A requeued event is republished (core) or redelivered (JetStream) after this long, so a draining replica does not spin on it. */
const REQUEUE_DELAY_MS = 25;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_ACK_WAIT_MS = 30_000;
export const DEFAULT_MAX_AGE_MS = 60 * 60_000;
/** How long one pull request waits for messages before the driver issues the next one. */
const PULL_EXPIRES_MS = 30_000;

export interface NatsConfig extends BrokerConfig {
  /** `nats://host:4222`, or several (`['nats://a:4222', 'nats://b:4222']`). */
  servers: string | string[];
  user?: string;
  pass?: string;
  /** Token authentication (mutually exclusive with `user`/`pass`). */
  token?: string;
  /** `true` for TLS with the system CAs, or the PEM material. */
  tls?: boolean | { ca?: string; cert?: string; key?: string };
  /** The client name the server shows (default `landflow-<connectionId>`). */
  name?: string;
  connectTimeoutMs?: number;
  /** Largest event accepted (default 1 MiB), lowered to the server's `max_payload` on connect. */
  maxMessageBytes?: number;
}

export interface JetStreamConfig extends NatsConfig {
  /** Prefix of the stream and consumer names (default none); tests use one per run so they can delete their streams. */
  streamPrefix?: string;
  /** How long a delivery may stay unacknowledged before the server redelivers it (default 30 s); in-flight deliveries send progress acks. */
  ackWaitMs?: number;
  /** `max_age` of request streams whose channel has no TTL (default 1 h): an older request is past any deadline. */
  maxAgeMs?: number;
  storage?: 'file' | 'memory';
  replicas?: number;
}

export const NATS_CORE_CAPABILITIES: BrokerCapabilities = {
  replies: 'native',
  workSharing: true,
  buffering: false,
  ttl: false,
  undeliverable: 'reported',
  persistence: 'memory',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'low',
  headers: true,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

export const JETSTREAM_CAPABILITIES: BrokerCapabilities = {
  replies: 'native',
  workSharing: true,
  buffering: true,
  // Per-message TTL (`Nats-TTL`) has a one-second granularity, so it is set as a first filter but not claimed.
  ttl: false,
  undeliverable: 'inferred',
  persistence: 'disk',
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  latency: 'low',
  headers: true,
  orderingKeys: false,
  nack: true,
  attempts: true,
};

/** Stream and consumer names may not contain `.`, `*` or `>`; channel names only use `.` of those. */
export const streamNameOf = (channel: string, prefix = ''): string => prefix + channel.replaceAll('.', '_');

/**
 * The config for a connection URL: `nats://host:4222`, a comma-separated list of hosts, `tls://host:4222` (TLS),
 * `nats://user:pass@host` or `nats://token@host`; `options.username`/`password`/`tls` win over the URL.
 */
export function natsConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): NatsConfig {
  const trimmed = url.trim();
  const match = /^(nats|tls|ws|wss):\/\/(?:([^@/]*)@)?([^/?#]+)\/?(?:\?(.*))?$/.exec(trimmed);
  if (!match) throw new Error(`NATS URL "${url}" must look like nats://host:4222[,host2:4222] (or tls://host:4222)`);
  const [, scheme, userinfo, hosts, query] = match;
  const servers = hosts.split(',').map((h) => h.trim()).filter(Boolean);
  if (servers.length === 0 || servers.some((h) => !/^[A-Za-z0-9.:_[\]-]+$/.test(h))) throw new Error(`NATS URL "${url}" has an invalid host list`);
  const params = new URLSearchParams(query ?? '');
  let user: string | undefined;
  let pass: string | undefined;
  let token: string | undefined;
  if (userinfo) {
    const colon = userinfo.indexOf(':');
    if (colon === -1) token = decodeURIComponent(userinfo);
    else {
      user = decodeURIComponent(userinfo.slice(0, colon));
      pass = decodeURIComponent(userinfo.slice(colon + 1));
    }
  }
  if (typeof options.username === 'string' && options.username) user = options.username;
  if (typeof options.password === 'string' && options.password) pass = options.password;
  if (typeof options.token === 'string' && options.token) token = options.token;
  if (params.get('token')) token = params.get('token')!;
  if (user && token) throw new Error('NATS connection: use either a username and password or a token, not both');
  const tls = options.tls ?? (scheme === 'tls' || scheme === 'wss');
  const config: NatsConfig = {
    connectionId,
    servers: servers.map((h) => (scheme === 'ws' || scheme === 'wss' ? `${scheme}://${h}` : h)),
    ...(options.prefix && { prefix: options.prefix }),
    ...(user && { user, pass: pass ?? '' }),
    ...(token && { token }),
    ...(tls && { tls: true }),
  };
  const max = Number(options.maxMessageBytes);
  if (Number.isFinite(max) && max > 0) config.maxMessageBytes = max;
  return config;
}

export function jetstreamConfigFrom(connectionId: string, url: string, options: ConnectionOptions = {}): JetStreamConfig {
  const config: JetStreamConfig = natsConfigFrom(connectionId, url, options);
  if (typeof options.streamPrefix === 'string' && options.streamPrefix) config.streamPrefix = options.streamPrefix;
  for (const key of ['ackWaitMs', 'maxAgeMs', 'replicas'] as const) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) config[key] = value;
  }
  if (options.storage === 'memory' || options.storage === 'file') config.storage = options.storage;
  return config;
}

const isNoResponders = (error: unknown): boolean => {
  const e = error as { name?: string; isNoResponders?: () => boolean; cause?: { name?: string } };
  return e?.name === 'NoRespondersError' || e?.cause?.name === 'NoRespondersError' || (e?.name === 'RequestError' && typeof e.isNoResponders === 'function' && e.isNoResponders());
};
const isTimeout = (error: unknown): boolean => {
  const e = error as { name?: string; cause?: { name?: string }; message?: string };
  return e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError' || /timeout/i.test(e?.message ?? '');
};
const apiCode = (error: unknown): number | undefined => (error as { code?: number })?.code;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Waiter {
  resolve: (event: WireEvent) => void;
}

/** One driver instance for either kind; the module decides the kind and the capabilities. */
export class NatsDriver<C extends NatsConfig = NatsConfig> implements BrokerDriver<C> {
  readonly capabilities: BrokerCapabilities;
  private lib?: NatsLib;
  private jsl?: JetStreamLib;
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private config?: C;
  private online = false;
  private closing = false;
  private readonly specs = new Map<string, ChannelSpec>();
  /** Channels the server told us are streams (declared by another process). */
  private readonly streams = new Set<string>();
  private readonly subscriptions = new Set<Subscription>();
  private inbox = '';
  private inboxSub?: NatsSubscription;
  private inboxSeq = 0;
  private readonly noResponders = new Set<string>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    readonly kind: BrokerKind,
    private readonly mode: 'core' | 'jetstream',
    capabilities: BrokerCapabilities,
  ) {
    // Each instance owns its copy: connect() lowers maxMessageBytes to the server's max_payload.
    this.capabilities = { ...capabilities };
  }

  /** The live connection, for tests and for drivers built on this one. */
  get connection(): NatsConnection | undefined {
    return this.nc;
  }

  async connect(config: C): Promise<void> {
    if (this.nc) throw new Error('NATS driver is already connected');
    const lib = await import('@nats-io/transport-node');
    const servers = Array.isArray(config.servers) ? config.servers : [config.servers];
    const tls = config.tls === true ? {} : config.tls && typeof config.tls === 'object' ? config.tls : undefined;
    const nc = await lib.connect({
      servers,
      ...(config.user !== undefined && { user: config.user, pass: config.pass ?? '' }),
      ...(config.token && { token: config.token }),
      ...(tls && { tls }),
      name: config.name ?? `landflow-${config.connectionId}`,
      timeout: config.connectTimeoutMs ?? 10_000,
      reconnect: true,
      maxReconnectAttempts: -1,
      waitOnFirstConnect: false,
    });
    try {
      if (this.mode === 'jetstream') {
        this.jsl = await import('@nats-io/jetstream');
        this.jsm = await this.jsl.jetstreamManager(nc, { timeout: config.connectTimeoutMs ?? 10_000 });
        this.js = this.jsm.jetstream();
      }
    } catch (error) {
      await nc.close().catch(() => {});
      throw error;
    }
    this.lib = lib;
    this.nc = nc;
    this.config = config;
    this.online = true;
    const wanted = config.maxMessageBytes ?? this.capabilities.maxMessageBytes;
    const serverMax = nc.info?.max_payload;
    this.capabilities.maxMessageBytes = serverMax && serverMax > 0 ? Math.min(wanted, serverMax) : wanted;
    this.inbox = lib.createInbox();
    this.inboxSub = nc.subscribe(`${this.inbox}.*`, { callback: (_err, msg) => this.onInbox(msg) });
    void this.watch(nc);
  }

  private async watch(nc: NatsConnection): Promise<void> {
    void nc.closed().then(() => {
      if (this.nc === nc) this.online = false;
    });
    try {
      for await (const status of nc.status()) {
        if (this.nc !== nc) return;
        if (status.type === 'disconnect' || status.type === 'reconnecting' || status.type === 'close') this.online = false;
        else if (status.type === 'reconnect') this.online = true;
      }
    } catch {
      /* the iterator ends with the connection */
    }
  }

  async declare(channels: ChannelSpec[]): Promise<void> {
    this.ensureOnline();
    for (const spec of channels) {
      this.specs.set(spec.name, spec);
      if (this.mode === 'jetstream' && spec.delivery === 'shared' && spec.durable) await this.ensureStream(spec);
    }
  }

  async publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome> {
    this.ensureOnline();
    const headers = this.toHeaders(event.headers);
    if (await this.isStream(channel)) {
      if (options?.ttlMs) headers.set(TTL_HEADER, ttlHeaderValue(options.ttlMs));
      await this.js!.publish(channel, event.body, { headers, timeout: 10_000 });
      return 'accepted';
    }
    // Core: publish with a reply inbox of ours and flush. The server answers a publish nobody subscribes to with a 503
    // on that inbox before it answers the flush's PING, so one round trip tells whether anyone took it.
    const token = String(++this.inboxSeq);
    this.nc!.publish(channel, event.body, { headers, reply: `${this.inbox}.${token}` });
    await this.nc!.flush();
    return this.noResponders.delete(token) ? 'unroutable' : 'accepted';
  }

  async request(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome> {
    this.ensureOnline();
    const headers = this.toHeaders(event.headers);
    if (await this.isStream(channel)) {
      const token = String(++this.inboxSeq);
      headers.set(REPLY_HEADER, `${this.inbox}.${token}`);
      headers.set(TTL_HEADER, ttlHeaderValue(options.timeoutMs));
      return new Promise<RequestOutcome>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(token);
          resolve({ outcome: 'timeout' });
        }, options.timeoutMs);
        timer.unref?.();
        this.waiters.set(token, {
          resolve: (reply) => {
            clearTimeout(timer);
            this.waiters.delete(token);
            resolve({ outcome: 'replied', event: reply });
          },
        });
        this.js!.publish(channel, event.body, { headers, timeout: Math.min(options.timeoutMs, 10_000) }).catch((error: unknown) => {
          clearTimeout(timer);
          this.waiters.delete(token);
          reject(error);
        });
      });
    }
    try {
      const msg = await this.nc!.request(channel, event.body, { timeout: options.timeoutMs, headers });
      return { outcome: 'replied', event: this.fromMsg(msg) };
    } catch (error) {
      if (isNoResponders(error)) return { outcome: 'unroutable' };
      if (isTimeout(error)) return { outcome: 'timeout' };
      throw error;
    }
  }

  async consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    this.ensureOnline();
    let subscription: Subscription;
    if (await this.isStream(channel)) subscription = await this.consumeStream(channel, options, onEvent);
    else {
      subscription = this.consumeCore(channel, options, onEvent);
      await this.nc!.flush(); // the server has the subscription before this resolves: a publish right after reaches it
    }
    this.subscriptions.add(subscription);
    return subscription;
  }

  async stats(channel: string): Promise<ChannelStats> {
    this.ensureOnline();
    if (!(await this.isStream(channel))) return {};
    const stream = this.streamName(channel);
    const consumer = streamNameOf(channel);
    const sample = async (): Promise<ChannelStats> => {
      try {
        const info = await this.jsm!.consumers.info(stream, consumer);
        // num_waiting counts the open pull requests (one per idle replica); a replica with every slot busy has none,
        // but then its deliveries are ack-pending.
        return { depth: info.num_pending, consumers: info.num_waiting + (info.num_ack_pending > 0 ? 1 : 0) };
      } catch (error) {
        if (apiCode(error) !== 10014) throw error;
      }
      try {
        const info = await this.jsm!.streams.info(stream);
        return { depth: info.state.messages, consumers: 0 };
      } catch (error) {
        if (apiCode(error) === 10059) return { depth: 0, consumers: 0 };
        throw error;
      }
    };
    const first = await sample();
    // A pull request is re-issued the moment the previous one expires; look twice before reporting nobody.
    if (first.consumers !== 0) return first;
    await sleep(50);
    return sample();
  }

  async close(): Promise<void> {
    const nc = this.nc;
    if (!nc || this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.subscriptions].map((s) => s.close()));
    this.subscriptions.clear();
    this.inboxSub?.unsubscribe();
    this.waiters.clear();
    if (this.online) await Promise.race([nc.flush().catch(() => {}), sleep(1_000)]);
    this.online = false;
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    await nc.close().catch(() => {});
  }

  // --- channels -------------------------------------------------------------------------------------------------------

  /**
   * Whether a channel is a stream: by its spec when this instance declared it, else by asking the server (another process
   * may have declared it; the result is cached when a stream exists).
   */
  private async isStream(channel: string): Promise<boolean> {
    if (this.mode !== 'jetstream') return false;
    const spec = this.specs.get(channel);
    if (spec) return spec.delivery === 'shared' && spec.durable;
    if (this.streams.has(channel)) return true;
    try {
      await this.jsm!.streams.find(channel);
      this.streams.add(channel);
      return true;
    } catch (error) {
      if (apiCode(error) === 10059 || /not found/i.test((error as Error).message ?? '')) return false;
      throw error;
    }
  }

  private streamName(channel: string): string {
    return streamNameOf(channel, (this.config as JetStreamConfig | undefined)?.streamPrefix);
  }

  private async ensureStream(spec: ChannelSpec): Promise<void> {
    const config = this.config as JetStreamConfig;
    const name = this.streamName(spec.name);
    const { nanos } = this.lib!;
    const { RetentionPolicy, StorageType, DiscardPolicy } = this.jsl!;
    try {
      await this.jsm!.streams.add({
        name,
        subjects: [spec.name],
        retention: RetentionPolicy.Workqueue,
        storage: config.storage === 'memory' ? StorageType.Memory : StorageType.File,
        discard: DiscardPolicy.Old,
        max_age: nanos(spec.ttlMs ?? config.maxAgeMs ?? DEFAULT_MAX_AGE_MS),
        max_msg_size: this.capabilities.maxMessageBytes,
        num_replicas: config.replicas ?? 1,
        allow_msg_ttl: true,
      });
    } catch (error) {
      // 10058: a stream with this name exists with another configuration (another connection's limits): use it as is.
      if (apiCode(error) !== 10058) throw error;
      await this.jsm!.streams.info(name);
    }
  }

  // --- headers --------------------------------------------------------------------------------------------------------

  private toHeaders(headers: Record<string, string>): MsgHdrs {
    const out = this.lib!.headers();
    for (const [name, value] of Object.entries(prefixHeaders(headers, NATS_HEADER_PREFIX))) out.set(name, value);
    return out;
  }

  private fromMsg(msg: { headers?: MsgHdrs; data: Uint8Array }): WireEvent {
    return { headers: unprefixHeaders(recordOf(msg.headers), NATS_HEADER_PREFIX), body: msg.data };
  }

  private onInbox(msg: Msg): void {
    const token = msg.subject.slice(this.inbox.length + 1);
    if (msg.headers?.code === 503) {
      this.noResponders.add(token);
      return;
    }
    this.waiters.get(token)?.resolve(this.fromMsg(msg));
  }

  // --- core NATS subscriptions -------------------------------------------------------------------------------------------

  private consumeCore(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Subscription {
    const nc = this.nc!;
    const manual = options.ackMode === 'manual';
    const inFlight = new Set<Msg>();
    const queue: Msg[] = [];
    let closed = false;
    const deliver = (msg: Msg) => {
      if (manual) inFlight.add(msg);
      let settled = !manual;
      const settle = () => {
        if (settled) return false;
        settled = true;
        inFlight.delete(msg);
        pump();
        return true;
      };
      const attempt = attemptOf(msg.headers);
      const delivery: Delivery = {
        attempt,
        ack: async () => void settle(),
        nack: async ({ requeue = false } = {}) => {
          if (!settle() || !requeue || closed) return;
          setTimeout(() => void this.republish(msg, attempt + 1), REQUEUE_DELAY_MS).unref?.();
        },
        reply: async (event) => {
          const to = replyOf(msg);
          if (!to) return;
          this.ensureOnline();
          nc.publish(to, event.body, { headers: this.toHeaders(event.headers) });
        },
      };
      onEvent(this.fromMsg(msg), delivery).catch(() => delivery.nack({ requeue: false }));
    };
    const pump = () => {
      while (!closed && queue.length > 0 && inFlight.size < options.prefetch) deliver(queue.shift()!);
    };
    const sub = nc.subscribe(channel, {
      ...(options.group && { queue: options.group }),
      callback: (error, msg) => {
        if (error || closed) return;
        if (manual && inFlight.size >= options.prefetch) queue.push(msg);
        else deliver(msg);
      },
    });
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        sub.unsubscribe();
        this.subscriptions.delete(subscription);
        // As if this consumer had died: what it held goes back on the subject for another queue member.
        const orphans = [...inFlight, ...queue.splice(0)];
        inFlight.clear();
        for (const msg of orphans) await this.republish(msg, attemptOf(msg.headers) + 1);
      },
    };
    return subscription;
  }

  /** Put a core delivery back on its subject with the next attempt number and the requester's inbox, if any. */
  private async republish(msg: Msg, attempt: number): Promise<void> {
    if (!this.online || !this.nc) return;
    const headers = this.lib!.headers();
    if (msg.headers) for (const key of msg.headers.keys()) headers.set(key, msg.headers.get(key));
    headers.set(ATTEMPT_HEADER, String(attempt));
    const reply = replyOf(msg);
    if (reply) headers.set(REPLY_HEADER, reply);
    else headers.delete(REPLY_HEADER);
    try {
      this.nc.publish(msg.subject, msg.data, { headers });
      await this.nc.flush();
    } catch {
      /* the connection went away; core NATS loses the event, as it would have anyway */
    }
  }

  // --- JetStream pull consumers --------------------------------------------------------------------------------------------

  private async consumeStream(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription> {
    const config = this.config as JetStreamConfig;
    const stream = this.streamName(channel);
    const name = streamNameOf(options.group ?? channel);
    const ackWaitMs = config.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
    const { nanos } = this.lib!;
    const { AckPolicy, DeliverPolicy, ReplayPolicy } = this.jsl!;
    try {
      await this.jsm!.consumers.add(stream, {
        durable_name: name,
        filter_subject: channel,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: nanos(ackWaitMs),
        max_ack_pending: -1,
        max_deliver: -1,
      });
    } catch (error) {
      // Another replica created it with other settings: share it.
      await this.jsm!.consumers.info(stream, name).catch(() => {
        throw error;
      });
    }
    const consumer = await this.js!.consumers.get(stream, name);
    const manual = options.ackMode === 'manual';
    const inFlight = new Set<{ nak(): void; stop(): void }>();
    let closed = false;
    let current: ConsumerMessages | undefined;
    let wake: (() => void) | undefined;
    const slotFreed = () => {
      wake?.();
      wake = undefined;
    };
    const deliver = (m: import('@nats-io/jetstream').JsMsg) => {
      const progress = setInterval(() => m.working(), Math.max(1_000, Math.floor(ackWaitMs / 3)));
      progress.unref?.();
      const held = { nak: () => m.nak(), stop: () => clearInterval(progress) };
      if (manual) inFlight.add(held);
      let settled = !manual;
      const settle = () => {
        if (settled) return false;
        settled = true;
        held.stop();
        inFlight.delete(held);
        slotFreed();
        return true;
      };
      const delivery: Delivery = {
        attempt: m.info.deliveryCount,
        ack: async () => {
          if (!settle()) return;
          await m.ackAck({ timeout: 5_000 }).catch(() => m.ack());
        },
        nack: async ({ requeue = false } = {}) => {
          if (!settle()) return;
          if (requeue) m.nak(REQUEUE_DELAY_MS);
          else m.term();
        },
        reply: async (event) => {
          const to = m.headers?.get(REPLY_HEADER);
          if (!to) return;
          this.ensureOnline();
          this.nc!.publish(to, event.body, { headers: this.toHeaders(event.headers) });
        },
      };
      if (!manual) m.ack();
      onEvent(this.fromMsg(m), delivery).catch(() => delivery.nack({ requeue: false }));
    };
    const loop = async () => {
      while (!closed) {
        const free = options.prefetch - inFlight.size;
        if (free <= 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        try {
          current = await consumer.fetch({ max_messages: free, expires: PULL_EXPIRES_MS });
          for await (const m of current) {
            if (closed) m.nak();
            else deliver(m);
          }
        } catch {
          if (!closed) await sleep(this.online ? 250 : 1_000);
        } finally {
          current = undefined;
        }
      }
    };
    void loop();
    const subscription: Subscription = {
      channel,
      close: async () => {
        if (closed) return;
        closed = true;
        this.subscriptions.delete(subscription);
        slotFreed();
        await current?.close().catch(() => {});
        // As if this consumer had died, only sooner: unacknowledged deliveries go back for another replica now.
        for (const held of inFlight) {
          held.stop();
          try {
            held.nak();
          } catch {
            /* connection gone: ack_wait redelivers */
          }
        }
        inFlight.clear();
        if (this.online) await Promise.race([this.nc!.flush().catch(() => {}), sleep(1_000)]);
      },
    };
    return subscription;
  }

  private ensureOnline(): void {
    if (!this.nc || !this.online || this.closing) throw new NotConnectedError(`${this.kind} driver is not connected`);
  }
}

const recordOf = (headers?: MsgHdrs): Record<string, string> => {
  const out: Record<string, string> = {};
  if (headers) for (const key of headers.keys()) out[key] = headers.get(key);
  return out;
};
const attemptOf = (headers?: MsgHdrs): number => {
  const raw = headers?.get(ATTEMPT_HEADER);
  const n = raw ? Number(raw) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
};
/** The requester's inbox: the driver header (set on republished and JetStream events) wins over the NATS reply subject. */
const replyOf = (msg: Msg): string | undefined => msg.headers?.get(REPLY_HEADER) || msg.reply || undefined;
/** `Nats-TTL` takes whole seconds (minimum 1). */
const ttlHeaderValue = (ms: number): string => `${Math.max(1, Math.ceil(ms / 1000))}s`;
