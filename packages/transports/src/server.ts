/**
 * The plugin side of generic messaging: `MessagingServer` consumes a plugin's request channel over one broker connection
 * and hands each call to a dispatcher (docs/transports.md "Delivery rules (all brokers)"; the SDK's messaging binding
 * wraps one per broker).
 *
 * Delivery rules, all implemented here and never in drivers:
 * - **At most once by default**: an `Execute` is acknowledged before it runs, so a crash mid-call never runs it twice.
 * - **At least once** (acknowledge after the reply) only when the host asked for it (`lfdelivery`) **and** the work is
 *   safe to repeat: every method but Execute, an Execute of a node the plugin marks `idempotent` (per node or per
 *   operation), or one with an `idempotencyKey`.
 * - **Deadlines** (`lfdeadline`) are checked before dispatch: an expired request is acknowledged and dropped (the host has
 *   already failed it), and the dispatcher's `AbortSignal` fires at the deadline.
 * - **Concurrency**: prefetch = the plugin's `maxConcurrency`.
 * - **Version skew**: a request whose `lfmanifest` differs from this plugin's manifest hash is put back once (for a
 *   replica with the right version to take) and then answered `manifest_mismatch` with this plugin's hash.
 * - **Cancel** events on the plugin's control channel abort the call's signal; a cancel that arrives first drops the call.
 * - **Announce** every 10 s on the registry channel (with a registry proof when `LANDFLOW_REGISTRY_SECRET` is set),
 *   withdraw and drain in-flight calls on `stop()`.
 */
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DEFAULT_ANNOUNCE_TTL_SECONDS, DEFAULT_HEARTBEAT_SECONDS, DEFAULT_MAX_CONCURRENCY, PROTOCOL_VERSION, type ExecuteRequest, type JsonValue, type PluginManifest } from '@landflow/protocol';
import { brokerEndpoint, channelNames, channelSpecs, type ChannelNames } from './channels';
import { Codec, consoleLogger, type Logger } from './codec';
import type { BrokerConfig, BrokerDriver, Delivery, Subscription, WireEvent } from './driver';
import { ANNOUNCE_TYPE, EnvelopeError, parseType, pluginSource, responseType, WITHDRAW_TYPE, type Attributes, type DeliveryMode, type Method, type RemoteErrorCode } from './envelope';
import { UsageError } from './errors';
import { registryProof, ReplayGuard, type Keyring } from './security';

/** `sha256(JSON.stringify(manifest))[0..16]`, the same hash the host's registry computes. */
export const manifestHashOf = (manifest: PluginManifest): string => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);

/** The body of an announce (a heartbeat is an announce repeated every 10 s) on the registry channel. */
export interface AnnounceBody {
  protocol: typeof PROTOCOL_VERSION;
  pluginId: string;
  version: string;
  instanceId: string;
  manifestHash: string;
  /** `<kind>://<connectionId>/<pluginId>`. */
  endpoint: string;
  maxConcurrency: number;
  ttlSeconds: number;
  /** Protocol §13 proof with the event id as the challenge; absent when the plugin has no `LANDFLOW_REGISTRY_SECRET`. */
  registryProof?: string;
}

export interface WithdrawBody {
  pluginId: string;
  instanceId: string;
  endpoint: string;
}

export interface DispatchContext {
  callId: string;
  /** Epoch ms; the signal aborts when it passes. */
  deadline?: number;
  signal: AbortSignal;
  idempotencyKey?: string;
  /** The broker's delivery attempt (1 on the first). */
  attempt: number;
  delivery: DeliveryMode;
  traceparent?: string;
  tracestate?: string;
  /** The host that called, `landflow://host/<instanceId>`. */
  source: string;
}

/** Runs one logical RPC; the SDK's dispatcher (handlers.ts) behind every face. Throw `DispatchError` for a coded failure. */
export type Dispatcher = (method: Method, body: JsonValue, context: DispatchContext) => Promise<JsonValue>;

/** A failure with a code the host can act on (`not_found` for an unknown node, `bad_request` for an invalid body…). */
export class DispatchError extends Error {
  constructor(
    message: string,
    readonly code: RemoteErrorCode = 'internal',
    readonly details?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

export interface MessagingServerOptions<C extends BrokerConfig = BrokerConfig> {
  /** A fresh, unconnected driver; the server connects it in `start()` and closes it in `stop()`. */
  driver: BrokerDriver<C>;
  config: C;
  keyring: Keyring;
  pluginId: string;
  version: string;
  /** The manifest (hashed with `manifestHashOf`) or its hash. */
  manifest: PluginManifest | { hash: string };
  dispatch: Dispatcher;
  /** Is this Execute safe to run twice? Default: derived from the manifest's `idempotent` flags when a manifest was given, else never. */
  isIdempotent?: (request: ExecuteRequest) => boolean;
  /** Prefetch; default: the manifest's `maxConcurrency`, else 16. */
  maxConcurrency?: number;
  /** Random per process by default; share the SDK's `INSTANCE_ID` so announces over every transport agree. */
  instanceId?: string;
  announceIntervalMs?: number;
  ttlSeconds?: number;
  /** Default `LANDFLOW_REGISTRY_SECRET`; `null` announces without a proof. */
  registrySecret?: string | null;
  /** How long `stop()` waits for calls in flight (default 30 s). */
  drainTimeoutMs?: number;
  clockSkewMs?: number;
  log?: Logger;
  now?: () => number;
}

const CANCELLED_MEMORY_MS = 60_000;

/** Which nodes and operations a manifest marks idempotent. */
export function idempotencyFromManifest(manifest: PluginManifest): (request: ExecuteRequest) => boolean {
  const nodes = new Map(manifest.nodes.map((node) => [`${manifest.plugin.id}.${node.name}`, node]));
  return (request) => {
    const node = nodes.get(request.node.type);
    if (!node) return false;
    const operation = request.parameters?.operation;
    const option = node.properties.find((p) => p.name === 'operation')?.options?.find((o) => o.value === operation);
    return option?.idempotent ?? node.idempotent ?? false;
  };
}

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

/** Bounds dispatches to `maxConcurrency` whatever the broker's prefetch does (at most once acks before running, so prefetch alone would not). */
class Semaphore {
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(() => { this.active++; resolve(); }));
  }
  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

export class MessagingServer<C extends BrokerConfig = BrokerConfig> {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly manifestHash: string;
  readonly names: ChannelNames;
  readonly endpoint: string;
  private readonly codec: Codec;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly isIdempotent: (request: ExecuteRequest) => boolean;
  private readonly maxConcurrency: number;
  private readonly registrySecret: string | undefined;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly cancelled = new Map<string, number>();
  private readonly slots: Semaphore;
  private subscriptions: Subscription[] = [];
  private announceTimer: NodeJS.Timeout | undefined;
  private state: 'new' | 'started' | 'draining' | 'stopped' = 'new';
  /** Counters for tests and metrics. */
  readonly counters = { received: 0, dispatched: 0, replied: 0, dropped: 0, expired: 0, mismatched: 0, requeued: 0, cancelled: 0, announces: 0 };

  constructor(private readonly options: MessagingServerOptions<C>) {
    this.pluginId = options.pluginId;
    this.instanceId = options.instanceId ?? randomBytes(16).toString('hex');
    this.manifestHash = 'hash' in options.manifest ? options.manifest.hash : manifestHashOf(options.manifest);
    this.names = channelNames(options.config.prefix);
    this.endpoint = brokerEndpoint(options.driver.kind, options.config.connectionId, options.pluginId);
    this.log = options.log ?? consoleLogger;
    this.now = options.now ?? Date.now;
    this.codec = new Codec(options.keyring, options.driver.capabilities, { clockSkewMs: options.clockSkewMs, replay: new ReplayGuard(), now: this.now });
    this.isIdempotent = options.isIdempotent ?? ('hash' in options.manifest ? () => false : idempotencyFromManifest(options.manifest));
    this.maxConcurrency = options.maxConcurrency ?? ('hash' in options.manifest ? undefined : options.manifest.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY;
    this.registrySecret = options.registrySecret === null ? undefined : (options.registrySecret ?? process.env.LANDFLOW_REGISTRY_SECRET) || undefined;
    this.slots = new Semaphore(this.maxConcurrency);
  }

  static async start<C extends BrokerConfig>(options: MessagingServerOptions<C>): Promise<MessagingServer<C>> {
    const server = new MessagingServer(options);
    await server.start();
    return server;
  }

  get driver(): BrokerDriver<C> {
    return this.options.driver;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async start(): Promise<void> {
    if (this.state !== 'new') throw new UsageError(`server already ${this.state}`);
    const { driver, config } = this.options;
    await driver.connect(config);
    const request = this.names.request(this.pluginId);
    const instance = this.names.instance(this.pluginId, this.instanceId);
    const control = this.names.control(this.pluginId);
    const registry = this.names.registry();
    await driver.declare([channelSpecs.request(request), channelSpecs.instance(instance), channelSpecs.control(control), channelSpecs.registry(registry)]);
    this.subscriptions.push(
      await driver.consume(control, { prefetch: 256, ackMode: 'auto' }, async (wire) => this.onControl(wire)),
      await driver.consume(request, { group: request, prefetch: this.maxConcurrency, ackMode: 'manual' }, (wire, delivery) => this.onRequest(wire, delivery)),
      await driver.consume(instance, { group: instance, prefetch: this.maxConcurrency, ackMode: 'manual' }, (wire, delivery) => this.onRequest(wire, delivery)),
    );
    this.state = 'started';
    await this.announce();
    const interval = this.options.announceIntervalMs ?? DEFAULT_HEARTBEAT_SECONDS * 1000;
    this.announceTimer = setInterval(() => void this.announce(), interval);
    this.announceTimer.unref?.();
  }

  /** Stop taking calls, withdraw, wait for the calls in flight (up to `drainTimeoutMs`), close. */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'draining') return;
    this.state = 'draining';
    if (this.announceTimer) clearInterval(this.announceTimer);
    await this.withdraw();
    const drainTimeout = this.options.drainTimeoutMs ?? 30_000;
    const inFlight = [...this.inFlight.values()];
    if (inFlight.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(inFlight.map((f) => f.done)), new Promise<void>((resolve) => (timer = setTimeout(resolve, drainTimeout)))]);
      if (timer) clearTimeout(timer);
      for (const f of this.inFlight.values()) f.controller.abort(new Error('plugin stopping'));
    }
    await Promise.allSettled(this.subscriptions.map((s) => s.close()));
    this.subscriptions = [];
    this.state = 'stopped';
    await this.options.driver.close();
  }

  /** Publish an announce now (the timer does it every `announceIntervalMs`). */
  async announce(): Promise<void> {
    if (this.state !== 'started') return;
    try {
      const attributes = this.codec.base(pluginSource(this.pluginId, this.instanceId), ANNOUNCE_TYPE, { lfmanifest: this.manifestHash });
      const body: AnnounceBody = {
        protocol: PROTOCOL_VERSION,
        pluginId: this.pluginId,
        version: this.options.version,
        instanceId: this.instanceId,
        manifestHash: this.manifestHash,
        endpoint: this.endpoint,
        maxConcurrency: this.maxConcurrency,
        ttlSeconds: this.options.ttlSeconds ?? DEFAULT_ANNOUNCE_TTL_SECONDS,
        ...(this.registrySecret && { registryProof: registryProof(this.registrySecret, this.pluginId, attributes.id) }),
      };
      const packed = this.codec.pack(this.pluginId, attributes, body as unknown as JsonValue, false);
      await this.options.driver.publish(this.names.registry(), packed.wire, { ttlMs: 60_000 });
      this.counters.announces++;
    } catch (error) {
      this.log('warn', 'announce failed', { error: (error as Error).message });
    }
  }

  private async withdraw(): Promise<void> {
    try {
      const attributes = this.codec.base(pluginSource(this.pluginId, this.instanceId), WITHDRAW_TYPE);
      const body: WithdrawBody = { pluginId: this.pluginId, instanceId: this.instanceId, endpoint: this.endpoint };
      const packed = this.codec.pack(this.pluginId, attributes, body as unknown as JsonValue, false);
      await this.options.driver.publish(this.names.registry(), packed.wire, { ttlMs: 60_000 });
    } catch (error) {
      this.log('warn', 'withdraw failed', { error: (error as Error).message });
    }
  }

  private async onRequest(wire: WireEvent, delivery: Delivery): Promise<void> {
    this.counters.received++;
    const drop = async (why: string, fields?: Record<string, unknown>) => {
      this.counters.dropped++;
      this.log('warn', `dropped a request: ${why}`, fields);
      await delivery.nack({ requeue: false });
    };
    let raw;
    try {
      raw = this.codec.peek(wire);
    } catch (error) {
      return drop('malformed', { error: (error as Error).message });
    }
    const parsed = parseType(raw.attributes.type);
    if (parsed?.kind !== 'request') return drop('not a request', { type: raw.attributes.type });
    let attributes: Attributes;
    let data: JsonValue;
    try {
      ({ attributes, data } = this.codec.unpack(raw, this.pluginId));
    } catch (error) {
      return drop('failed verification', { id: raw.attributes.id, error: (error as Error).message });
    }
    const forgetReplay = () => this.codec.forgetReplay(attributes.id);
    if (this.state !== 'started') {
      // Draining: hand it back to another replica without running it.
      forgetReplay();
      this.counters.requeued++;
      return delivery.nack({ requeue: true });
    }
    const now = this.now();
    const deadline = attributes.lfdeadline ? Number(attributes.lfdeadline) : undefined;
    if (deadline !== undefined && deadline <= now) {
      this.counters.expired++;
      this.log('debug', 'dropped an expired request', { id: attributes.id, deadline });
      return delivery.ack();
    }
    this.sweepCancelled(now);
    if (this.cancelled.has(attributes.id)) {
      this.cancelled.delete(attributes.id);
      this.counters.cancelled++;
      return delivery.ack();
    }
    if (attributes.lfmanifest && attributes.lfmanifest !== this.manifestHash) {
      this.counters.mismatched++;
      if (delivery.attempt < 2 && this.options.driver.capabilities.nack) {
        forgetReplay();
        this.counters.requeued++;
        return delivery.nack({ requeue: true });
      }
      await delivery.ack();
      await this.reply(attributes, delivery, { error: `manifest mismatch: this plugin runs ${this.manifestHash}`, manifestHash: this.manifestHash }, 'manifest_mismatch');
      return;
    }
    const requested = attributes.lfdelivery ?? (parsed.method === 'Execute' ? 'at-most-once' : 'at-least-once');
    const repeatable = parsed.method !== 'Execute' || Boolean(attributes.lfidempotency) || this.safeToRepeat(data);
    const mode: DeliveryMode = requested === 'at-least-once' && repeatable ? 'at-least-once' : 'at-most-once';
    await this.slots.acquire();
    if (this.state !== 'started') {
      this.slots.release();
      forgetReplay();
      this.counters.requeued++;
      return delivery.nack({ requeue: true });
    }
    if (mode === 'at-most-once') await delivery.ack();

    const controller = new AbortController();
    let deadlineTimer: NodeJS.Timeout | undefined;
    if (deadline !== undefined) {
      deadlineTimer = setTimeout(() => controller.abort(new Error('deadline passed')), deadline - now);
      deadlineTimer.unref?.();
    }
    const run = async () => {
      this.counters.dispatched++;
      let body: JsonValue;
      let code: RemoteErrorCode | undefined;
      try {
        body = await this.options.dispatch(parsed.method, data, {
          callId: attributes.id,
          deadline,
          signal: controller.signal,
          idempotencyKey: attributes.lfidempotency,
          attempt: delivery.attempt,
          delivery: mode,
          traceparent: attributes.traceparent,
          tracestate: attributes.tracestate,
          source: attributes.source,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          code = 'cancelled';
          body = { error: (controller.signal.reason as Error)?.message ?? 'cancelled' };
        } else if (error instanceof DispatchError) {
          code = error.code;
          body = { error: error.message, ...error.details };
        } else {
          code = 'internal';
          body = { error: (error as Error)?.message ?? String(error) };
        }
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
      const sent = await this.reply(attributes, delivery, body, code);
      if (mode === 'at-least-once') {
        if (sent) await delivery.ack();
        else {
          forgetReplay();
          this.counters.requeued++;
          await delivery.nack({ requeue: true });
        }
      }
    };
    const done = run()
      .catch((error) => this.log('error', 'request handling failed', { id: attributes.id, error: (error as Error).message }))
      .finally(() => {
        this.inFlight.delete(attributes.id);
        this.slots.release();
      });
    this.inFlight.set(attributes.id, { controller, done });
    // Hold the handler until the reply is out: drivers that bound concurrency by outstanding handlers see the same limit
    // as the semaphore; at least once also keeps the delivery (and its prefetch slot) until the ack.
    await done;
  }

  private safeToRepeat(data: JsonValue): boolean {
    try {
      return this.isIdempotent(data as unknown as ExecuteRequest);
    } catch {
      return false;
    }
  }

  /** Send a response; `false` when it could not be sent (the host gets its deadline). */
  private async reply(request: Attributes, delivery: Delivery, body: JsonValue, code?: RemoteErrorCode): Promise<boolean> {
    const parsed = parseType(request.type);
    if (parsed?.kind !== 'request') return false;
    if (request.lfdeadline && Number(request.lfdeadline) <= this.now()) {
      // The host has already failed the call at its deadline; a late reply would only race its timer.
      this.counters.expired++;
      this.log('debug', 'not replying after the deadline', { id: request.id });
      return true;
    }
    const native = this.options.driver.capabilities.replies === 'native';
    if (!native && !request.lfreplyto) {
      this.log('warn', 'request has no lfreplyto and the broker has no native replies', { id: request.id });
      return false;
    }
    const attributes = this.codec.base(pluginSource(this.pluginId, this.instanceId), responseType(parsed.method), {
      lfcorrelation: request.id,
      lfmanifest: this.manifestHash,
      ...(request.subject && { subject: request.subject }),
      ...(request.traceparent && { traceparent: request.traceparent }),
      ...(request.tracestate && { tracestate: request.tracestate }),
      ...(code && { lferror: code }),
    });
    let packed;
    try {
      packed = this.codec.pack(this.pluginId, attributes, body, true);
    } catch (error) {
      if (!(error instanceof EnvelopeError) || error.reason !== 'too_large') throw error;
      attributes.lferror = 'too_large';
      packed = this.codec.pack(this.pluginId, attributes, { error: error.message }, true);
    }
    try {
      if (native) await delivery.reply!(packed.wire);
      else await this.options.driver.publish(request.lfreplyto!, packed.wire, { ttlMs: 5 * 60_000 });
      this.counters.replied++;
      return true;
    } catch (error) {
      this.log('warn', 'reply could not be published', { id: request.id, error: (error as Error).message });
      return false;
    }
  }

  private onControl(wire: WireEvent): void {
    let raw;
    try {
      raw = this.codec.peek(wire);
    } catch {
      return;
    }
    if (parseType(raw.attributes.type)?.kind !== 'cancel' || !raw.attributes.lfcorrelation) return;
    try {
      this.codec.unpack(raw, this.pluginId, undefined);
    } catch (error) {
      this.log('warn', 'ignored a cancel that failed verification', { error: (error as Error).message });
      return;
    }
    const callId = raw.attributes.lfcorrelation;
    const inFlight = this.inFlight.get(callId);
    if (inFlight) {
      this.counters.cancelled++;
      inFlight.controller.abort(new Error('cancelled by the host'));
    } else {
      this.sweepCancelled(this.now());
      this.cancelled.set(callId, this.now() + CANCELLED_MEMORY_MS);
    }
  }

  private sweepCancelled(now: number): void {
    if (this.cancelled.size === 0) return;
    for (const [id, expires] of this.cancelled) if (expires <= now) this.cancelled.delete(id);
  }
}
