/**
 * The host side of generic messaging: `MessagingClient` calls plugins over one broker connection
 * (docs/transports.md "Generic messaging"; the host's broker provider wraps one per connection).
 *
 * - `call()` publishes a signed, encrypted request on the plugin's request channel and correlates the reply, over the
 *   broker's native request/reply or over this host's reply channel; the deadline fails the call with `TimeoutError`
 *   and an abort sends a cancel event to the plugin's control channel.
 * - Errors say what is known: `UndeliverableError` (provably not delivered; the selector may use another transport),
 *   `TimeoutError` / `CancelledError` / `ConnectionLostError` (maybe delivered), `RemoteError` (the plugin answered).
 * - Discovery: it consumes the registry channel and keeps the announced plugins (`plugins()`, `on('plugin', …)`), with
 *   their brokered endpoint `<kind>://<connectionId>/<pluginId>`; instances expire without heartbeats.
 * - Stats: `driver.stats()` on every known plugin's request channel every 5 s (`stats(pluginId)`), for the selector.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_ANNOUNCE_TTL_SECONDS, type JsonValue } from '@landflow/protocol';
import { brokerEndpoint, channelNames, channelSpecs, type ChannelNames } from './channels';
import { Codec, consoleLogger, isDropReason, type Logger } from './codec';
import { NotConnectedError, type BrokerConfig, type BrokerDriver, type ChannelStats, type Subscription, type WireEvent } from './driver';
import { EnvelopeError, hostSource, parsePluginSource, parseType, requestType, CANCEL_TYPE, subjectOf, type Attributes, type DeliveryMode, type Method, type RequestBody, type ResponseBody } from './envelope';
import { CancelledError, ConnectionLostError, ManifestMismatchError, RemoteError, TimeoutError, UndeliverableError, UsageError } from './errors';
import { verifyRegistryProof, type Keyring } from './security';
import type { AnnounceBody, WithdrawBody } from './server';

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_STATS_INTERVAL_MS = 5_000;
const EXPIRY_SWEEP_MS = 1_000;

export interface MessagingClientOptions<C extends BrokerConfig = BrokerConfig> {
  /** A fresh, unconnected driver; the client connects it in `start()` and closes it in `close()`. */
  driver: BrokerDriver<C>;
  config: C;
  keyring: Keyring;
  /** This host process's id (the reply channel is named after it). Default: random. */
  hostInstanceId?: string;
  /** `0` disables stats sampling. */
  statsIntervalMs?: number;
  clockSkewMs?: number;
  /**
   * The registry secret announces must prove (`registryProof` in the announce body). Default: `LANDFLOW_REGISTRY_SECRET`
   * from the environment; `null` accepts announces without a proof (their signature still has to verify).
   */
  registrySecret?: string | null;
  /** Consume the registry channel (default `true`). */
  discovery?: boolean;
  log?: Logger;
  now?: () => number;
}

export interface CallOptions {
  /** Epoch ms after which the call must not run; default `now + timeoutMs`. */
  deadline?: number;
  /** Alternative to `deadline` (default 30 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** Default: `at-most-once` for Execute, `at-least-once` for every other method. The plugin only honours at-least-once for idempotent work. */
  delivery?: DeliveryMode;
  /** Keeps the plugin's deliveries for one key in order (the execution id), when the broker can. */
  orderingKey?: string;
  /** The manifest hash the host knows for the plugin; default: the announced one. A plugin running another answers `manifest_mismatch`. */
  manifestHash?: string;
  /** Send to one instance's channel instead of the shared request channel. */
  instanceId?: string;
  traceparent?: string;
  tracestate?: string;
  /** The host's attempt number for this call (1 on the first try). */
  attempt?: number;
}

export interface CallReply<M extends Method> {
  body: ResponseBody<M>;
  attributes: Attributes;
  /** The plugin instance that answered. */
  instanceId: string;
  elapsedMs: number;
}

export interface AnnouncedInstance {
  instanceId: string;
  version: string;
  manifestHash: string;
  maxConcurrency?: number;
  lastSeen: number;
  /** When this instance is forgotten without a new heartbeat. */
  expiresAt: number;
}

export interface AnnouncedPlugin {
  pluginId: string;
  /** From the most recent heartbeat. */
  version: string;
  manifestHash: string;
  /** `<kind>://<connectionId>/<pluginId>`. */
  endpoint: string;
  instances: AnnouncedInstance[];
  lastSeen: number;
}

export type PluginEvent = { type: 'announced' | 'updated' | 'withdrawn' | 'expired'; plugin: AnnouncedPlugin; instanceId: string };

export interface SampledStats extends ChannelStats {
  sampledAt: number;
}

interface Pending {
  pluginId: string;
  method: Method;
  startedAt: number;
  resolve(reply: { attributes: Attributes; data: JsonValue }): void;
  reject(error: Error): void;
}

export class MessagingClient<C extends BrokerConfig = BrokerConfig> {
  readonly hostInstanceId: string;
  readonly names: ChannelNames;
  readonly driver: BrokerDriver<C>;
  private readonly config: C;
  private readonly codec: Codec;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly registrySecret: string | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly known = new Map<string, { plugin: AnnouncedPlugin; instances: Map<string, AnnouncedInstance> }>();
  private readonly sampled = new Map<string, SampledStats>();
  private readonly listeners = new Set<(event: PluginEvent) => void>();
  private readonly declared = new Set<string>();
  private subscriptions: Subscription[] = [];
  private timers: NodeJS.Timeout[] = [];
  private state: 'new' | 'started' | 'closed' = 'new';

  constructor(private readonly options: MessagingClientOptions<C>) {
    this.driver = options.driver;
    this.config = options.config;
    this.hostInstanceId = options.hostInstanceId ?? randomBytes(8).toString('hex');
    this.names = channelNames(options.config.prefix);
    this.log = options.log ?? consoleLogger;
    this.now = options.now ?? Date.now;
    this.codec = new Codec(options.keyring, options.driver.capabilities, { clockSkewMs: options.clockSkewMs, now: this.now });
    this.registrySecret = options.registrySecret === null ? undefined : (options.registrySecret ?? process.env.LANDFLOW_REGISTRY_SECRET) || undefined;
  }

  static async start<C extends BrokerConfig>(options: MessagingClientOptions<C>): Promise<MessagingClient<C>> {
    const client = new MessagingClient(options);
    await client.start();
    return client;
  }

  get kind(): string {
    return this.driver.kind;
  }

  get connectionId(): string {
    return this.config.connectionId;
  }

  /** The brokered endpoint of a plugin on this connection. */
  endpointOf(pluginId: string): string {
    return brokerEndpoint(this.driver.kind, this.config.connectionId, pluginId);
  }

  async start(): Promise<void> {
    if (this.state !== 'new') throw new UsageError(`client already ${this.state}`);
    try {
      await this.driver.connect(this.config);
    } catch (error) {
      throw new UndeliverableError(`cannot connect to ${this.driver.kind} "${this.config.connectionId}": ${(error as Error).message}`, 'not_connected');
    }
    const specs = [];
    if (this.driver.capabilities.replies !== 'native') specs.push(channelSpecs.reply(this.names.reply(this.hostInstanceId)));
    if (this.options.discovery !== false) specs.push(channelSpecs.registry(this.names.registry()));
    await this.driver.declare(specs);
    for (const spec of specs) this.declared.add(spec.name);
    if (this.driver.capabilities.replies !== 'native') {
      this.subscriptions.push(await this.driver.consume(this.names.reply(this.hostInstanceId), { prefetch: 1024, ackMode: 'auto' }, async (wire) => this.onReply(wire)));
    }
    if (this.options.discovery !== false) {
      this.subscriptions.push(await this.driver.consume(this.names.registry(), { prefetch: 1024, ackMode: 'auto' }, async (wire) => this.onRegistry(wire)));
      this.timers.push(setInterval(() => this.expireInstances(), EXPIRY_SWEEP_MS));
    }
    const statsInterval = this.options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    if (statsInterval > 0 && this.driver.stats) this.timers.push(setInterval(() => void this.sampleStats(), statsInterval));
    for (const timer of this.timers) timer.unref?.();
    this.state = 'started';
  }

  /** Call `method` on `pluginId` and return the reply body. */
  async call<M extends Method>(pluginId: string, method: M, body: RequestBody<M>, options: CallOptions = {}): Promise<ResponseBody<M>> {
    return (await this.invoke(pluginId, method, body, options)).body;
  }

  /** Like `call()`, with the reply's attributes, the answering instance and the elapsed time. */
  async invoke<M extends Method>(pluginId: string, method: M, body: RequestBody<M>, options: CallOptions = {}): Promise<CallReply<M>> {
    if (this.state !== 'started') throw new UndeliverableError(`client is ${this.state}`, 'not_connected');
    if (options.signal?.aborted) throw new UndeliverableError('aborted before publishing', 'aborted');
    const startedAt = this.now();
    const deadline = options.deadline ?? startedAt + (options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    if (deadline <= startedAt) throw new TimeoutError('the deadline had already passed', deadline);
    const known = this.known.get(pluginId);
    const manifestHash = options.manifestHash ?? known?.plugin.manifestHash;
    const channel = options.instanceId ? this.names.instance(pluginId, options.instanceId) : this.names.request(pluginId);
    const native = this.driver.capabilities.replies === 'native';
    const attributes = this.codec.base(hostSource(this.hostInstanceId), requestType(method), {
      lfdeadline: String(deadline),
      lfattempt: String(options.attempt ?? 1),
      lfdelivery: options.delivery ?? (method === 'Execute' ? 'at-most-once' : 'at-least-once'),
      ...(native ? {} : { lfreplyto: this.names.reply(this.hostInstanceId) }),
      ...(manifestHash && { lfmanifest: manifestHash }),
      ...(options.idempotencyKey && { lfidempotency: options.idempotencyKey }),
      ...(options.traceparent && { traceparent: options.traceparent }),
      ...(options.tracestate && { tracestate: options.tracestate }),
    });
    const subject = subjectOf(method, body);
    if (subject) attributes.subject = subject;
    let packed;
    try {
      packed = this.codec.pack(pluginId, attributes, body as unknown as JsonValue, true);
    } catch (error) {
      if (error instanceof EnvelopeError && error.reason === 'too_large') throw new UndeliverableError(error.message, 'too_large');
      throw error;
    }
    // Provably undeliverable before publishing: every announced instance has stopped heartbeating, or the channel has no consumers.
    if (known && known.instances.size === 0) throw new UndeliverableError(`no instance of "${pluginId}" has announced itself in the last ${DEFAULT_ANNOUNCE_TTL_SECONDS} s`, 'no_consumers');
    const stats = this.sampled.get(pluginId);
    if (this.driver.capabilities.undeliverable === 'inferred' && stats?.consumers === 0 && stats.sampledAt > startedAt - 2 * DEFAULT_STATS_INTERVAL_MS) {
      throw new UndeliverableError(`"${pluginId}" has no consumers on ${channel}`, 'no_consumers');
    }
    await this.declareOnce(options.instanceId ? channelSpecs.instance(channel) : channelSpecs.request(channel));
    const callId = packed.attributes.id;
    const publishOptions = { orderingKey: options.orderingKey, ttlMs: deadline - startedAt };

    const reply = await new Promise<{ attributes: Attributes; data: JsonValue }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(() => reject(new TimeoutError(`no reply from "${pluginId}" within ${deadline - startedAt} ms; the call may have run`, deadline))), deadline - startedAt);
      timer.unref?.();
      const onAbort = () => {
        finish(() => reject(new CancelledError()));
        void this.sendCancel(pluginId, callId, options.signal?.reason);
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(callId);
        settle();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(callId, { pluginId, method, startedAt, resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)) });

      const publish = native
        ? this.driver.request!(channel, packed.wire, { timeoutMs: deadline - startedAt, orderingKey: options.orderingKey }).then((outcome) => {
            if (outcome.outcome === 'unroutable') throw new UndeliverableError(`nobody is consuming ${channel}`, 'unroutable');
            if (outcome.outcome === 'timeout') throw new TimeoutError(`no reply from "${pluginId}" within ${deadline - startedAt} ms; the call may have run`, deadline);
            this.onReply(outcome.event, callId);
          })
        : this.driver.publish(channel, packed.wire, publishOptions).then((outcome) => {
            if (outcome === 'unroutable') throw new UndeliverableError(`nobody is consuming ${channel}`, 'unroutable');
          });
      publish.catch((error: unknown) => {
        if (error instanceof UndeliverableError || error instanceof TimeoutError) return finish(() => reject(error));
        if (error instanceof NotConnectedError) return finish(() => reject(new UndeliverableError(`not connected to ${this.driver.kind} "${this.config.connectionId}": ${error.message}`, 'not_connected')));
        finish(() => reject(new ConnectionLostError(`publishing to ${channel} failed: ${(error as Error).message}; the call may have run`)));
      });
    });

    const source = parsePluginSource(reply.attributes.source)!;
    if (reply.attributes.lferror) {
      const details = (reply.data ?? {}) as Record<string, JsonValue>;
      const message = typeof details.error === 'string' ? details.error : `plugin answered ${reply.attributes.lferror}`;
      if (reply.attributes.lferror === 'manifest_mismatch') throw new ManifestMismatchError(manifestHash, reply.attributes.lfmanifest ?? (details.manifestHash as string | undefined));
      throw new RemoteError(message, reply.attributes.lferror, details);
    }
    return { body: reply.data as ResponseBody<M>, attributes: reply.attributes, instanceId: source.instanceId, elapsedMs: this.now() - startedAt };
  }

  /** Plugins seen on the registry channel with at least one live instance, plus those whose instances all expired (empty `instances`). */
  plugins(): AnnouncedPlugin[] {
    this.expireInstances();
    return [...this.known.values()].map(({ plugin }) => plugin);
  }

  plugin(pluginId: string): AnnouncedPlugin | undefined {
    this.expireInstances();
    return this.known.get(pluginId)?.plugin;
  }

  /** The last `driver.stats()` sample for the plugin's request channel. */
  stats(pluginId: string): SampledStats | undefined {
    return this.sampled.get(pluginId);
  }

  /** Sample now (the timer does it every `statsIntervalMs`). */
  async sampleStats(): Promise<void> {
    if (!this.driver.stats || this.state !== 'started') return;
    await Promise.all(
      [...this.known.keys()].map(async (pluginId) => {
        try {
          const stats = await this.driver.stats!(this.names.request(pluginId));
          this.sampled.set(pluginId, { ...stats, sampledAt: this.now() });
        } catch (error) {
          this.log('debug', `stats for ${pluginId} failed`, { error: (error as Error).message });
        }
      }),
    );
  }

  on(event: 'plugin', listener: (event: PluginEvent) => void): () => void {
    void event;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fail the calls in flight, withdraw the subscriptions and close the connection. */
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const pending of this.pending.values()) pending.reject(new ConnectionLostError('client closed; the call may have run'));
    this.pending.clear();
    await Promise.allSettled(this.subscriptions.map((s) => s.close()));
    this.subscriptions = [];
    await this.driver.close();
  }

  private async declareOnce(spec: { name: string } & Parameters<BrokerDriver['declare']>[0][number]): Promise<void> {
    if (this.declared.has(spec.name)) return;
    await this.driver.declare([spec]);
    this.declared.add(spec.name);
  }

  private async sendCancel(pluginId: string, callId: string, reason: unknown): Promise<void> {
    try {
      const channel = this.names.control(pluginId);
      await this.declareOnce(channelSpecs.control(channel));
      const attributes = this.codec.base(hostSource(this.hostInstanceId), CANCEL_TYPE, { lfcorrelation: callId });
      const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'aborted by the host';
      const packed = this.codec.pack(pluginId, attributes, { callId, reason: message }, false);
      await this.driver.publish(channel, packed.wire, { ttlMs: 60_000 });
    } catch (error) {
      this.log('warn', `cancel of ${callId} on ${pluginId} could not be sent`, { error: (error as Error).message });
    }
  }

  private onReply(wire: WireEvent, expectedCallId?: string): void {
    let raw;
    try {
      raw = this.codec.peek(wire);
    } catch (error) {
      return this.log('warn', 'dropped a malformed reply', { error: (error as Error).message });
    }
    const parsed = parseType(raw.attributes.type);
    const correlation = raw.attributes.lfcorrelation;
    if (parsed?.kind !== 'response' || !correlation) return this.log('warn', 'dropped a reply that is not a response', { type: raw.attributes.type, id: raw.attributes.id });
    if (expectedCallId !== undefined && correlation !== expectedCallId) return this.log('warn', 'dropped a native reply with another correlation', { expected: expectedCallId, correlation });
    const pending = this.pending.get(correlation);
    if (!pending) return this.log('debug', 'dropped a reply to a call that is no longer pending', { correlation });
    const source = parsePluginSource(raw.attributes.source);
    if (!source || source.pluginId !== pending.pluginId) return this.log('warn', 'dropped a reply from another plugin', { correlation, source: raw.attributes.source });
    try {
      const { attributes, data } = this.codec.unpack(raw, pending.pluginId);
      if (parsed.method !== pending.method) return this.log('warn', 'dropped a reply for another method', { correlation, type: attributes.type });
      pending.resolve({ attributes, data });
    } catch (error) {
      if (isDropReason(error)) return this.log('warn', 'dropped a reply that failed verification', { correlation, error: error.message });
      pending.reject(error as Error);
    }
  }

  private onRegistry(wire: WireEvent): void {
    let raw;
    try {
      raw = this.codec.peek(wire);
    } catch (error) {
      return this.log('warn', 'dropped a malformed registry event', { error: (error as Error).message });
    }
    const parsed = parseType(raw.attributes.type);
    const source = parsePluginSource(raw.attributes.source);
    if (!source || (parsed?.kind !== 'announce' && parsed?.kind !== 'withdraw')) return;
    let data: JsonValue;
    try {
      data = this.codec.unpack(raw, source.pluginId).data;
    } catch (error) {
      return this.log('warn', `ignored a ${parsed.kind} from ${source.pluginId} that failed verification`, { error: (error as Error).message });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const body = data as unknown as AnnounceBody & WithdrawBody;
    if (body.pluginId !== source.pluginId || body.instanceId !== source.instanceId) return this.log('warn', 'ignored an announce whose body contradicts its source', { source: raw.attributes.source });
    if (parsed.kind === 'withdraw') return this.forgetInstance(source.pluginId, source.instanceId, 'withdrawn');
    if (this.registrySecret && !verifyRegistryProof(this.registrySecret, source.pluginId, raw.attributes.id, body.registryProof)) {
      return this.log('warn', `ignored an announce from ${source.pluginId}/${source.instanceId} without a valid registry proof`);
    }
    if (typeof body.manifestHash !== 'string' || typeof body.version !== 'string') return;
    const now = this.now();
    const ttlMs = (typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0 ? body.ttlSeconds : DEFAULT_ANNOUNCE_TTL_SECONDS) * 1000;
    let entry = this.known.get(source.pluginId);
    if (!entry) {
      entry = { plugin: { pluginId: source.pluginId, version: body.version, manifestHash: body.manifestHash, endpoint: this.endpointOf(source.pluginId), instances: [], lastSeen: now }, instances: new Map() };
      this.known.set(source.pluginId, entry);
    }
    const fresh = !entry.instances.has(source.instanceId);
    const changed = entry.plugin.manifestHash !== body.manifestHash || entry.plugin.version !== body.version;
    entry.instances.set(source.instanceId, { instanceId: source.instanceId, version: body.version, manifestHash: body.manifestHash, maxConcurrency: body.maxConcurrency, lastSeen: now, expiresAt: now + ttlMs });
    entry.plugin.version = body.version;
    entry.plugin.manifestHash = body.manifestHash;
    entry.plugin.lastSeen = now;
    entry.plugin.instances = [...entry.instances.values()];
    if (fresh || changed) this.emit({ type: fresh ? 'announced' : 'updated', plugin: entry.plugin, instanceId: source.instanceId });
  }

  private forgetInstance(pluginId: string, instanceId: string, type: 'withdrawn' | 'expired'): void {
    const entry = this.known.get(pluginId);
    if (!entry || !entry.instances.delete(instanceId)) return;
    entry.plugin.instances = [...entry.instances.values()];
    this.emit({ type, plugin: entry.plugin, instanceId });
  }

  private expireInstances(): void {
    const now = this.now();
    for (const [pluginId, entry] of this.known) for (const instance of entry.instances.values()) if (instance.expiresAt <= now) this.forgetInstance(pluginId, instance.instanceId, 'expired');
  }

  private emit(event: PluginEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log('error', 'plugin listener threw', { error: (error as Error).message });
      }
    }
  }
}
