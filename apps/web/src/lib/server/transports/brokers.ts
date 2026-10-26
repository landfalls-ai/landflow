/**
 * The host side of generic messaging (docs/transports.md "Host side", docs/protocol.md §14.8): one `MessagingClient`
 * per enabled broker connection, opened at host start (mains and workers alike: each process has its own
 * `hostInstanceId` and reply channel), restarted when the connection is edited, closed when it is disabled or deleted,
 * all closed on shutdown. Discovery runs through the clients' registry channels: an announce adds the brokered endpoint
 * `<kind>://<connectionId>/<pluginId>` to the registry with source `broker` (the connection id is this host's, whatever
 * the plugin calls its connection), a withdraw or an expiry takes it offline when no instance is left.
 *
 * Keys come from `Keyring.fromEnv()` (`LANDFLOW_TRANSPORT_SECRET`, falling back to `LANDFLOW_REGISTRY_SECRET`). Without
 * a secret nothing opens: every broker provider and connection reports unhealthy with the message, and nothing crashes.
 * Announces must carry a proof of `LANDFLOW_REGISTRY_SECRET` when the host has one (as HTTP announces do).
 *
 * The manager lives in a `globalThis` singleton like the registry, so Next's dev hot reload keeps the connections.
 * `driverModules` is where tests (and other packages) register a driver module the package's `LOADERS` does not know,
 * such as the in-memory driver.
 */
import { randomBytes } from 'node:crypto';
import { channelNames, channelSpecs, Keyring, MessagingClient, type AnnouncedPlugin, type BrokerDriver, type Logger as MessagingLogger, type PluginEvent } from '@landflow/transports';
import { availableDriverKinds, loadDriverModule, type DriverModule } from '@landflow/transports/drivers';
import type { BrokerQueueStats, TransportConnectionHealth, TransportKind } from '../../shared/transports';
import type { DiscoverySource } from '../../shared/types';
import { onTablesChanged } from '../db/replication';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { transportConnections, type StoredConnection, type TransportConnections } from './connections';
import { brokeredEndpoint, type ProviderHealth } from './provider';

/** How often an open connection is checked with a round trip, and how long one may take. */
export const CONNECTION_PROBE_INTERVAL_MS = 30_000;
export const ROUND_TRIP_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** The registry as the manager needs it (lib/server/plugins/registry.ts), injectable for tests. */
export interface BrokerDiscovery {
  addEndpoint(endpoint: string, source: DiscoverySource): Promise<unknown>;
  withdraw(endpoint: string, reason?: string): boolean;
  removeEndpoint(endpoint: string): boolean;
}

/**
 * The driver modules this host can use: the package's (`availableDriverKinds()`, loaded on first use) plus any
 * registered here (tests register the in-memory driver as kind `memory`).
 */
export class DriverModules {
  private readonly extra = new Map<string, DriverModule>();

  register(module: DriverModule): () => void {
    this.extra.set(module.kind, module);
    return () => {
      if (this.extra.get(module.kind) === module) this.extra.delete(module.kind);
    };
  }

  kinds(): TransportKind[] {
    return [...new Set<string>([...this.extra.keys(), ...availableDriverKinds()])];
  }

  async load(kind: TransportKind): Promise<DriverModule | undefined> {
    return this.extra.get(kind) ?? loadDriverModule(kind);
  }
}

export const driverModules = singleton('transport-driver-modules', () => new DriverModules());

export interface RoundTripResult {
  latencyMs: number;
  version?: string;
}

/**
 * One publish/consume round trip through a connected driver: a temporary broadcast channel, one event with a random
 * body, received back. The subscription is closed afterwards (the driver contract has no delete, so a broker that keeps
 * declared channels keeps the temporary one until its TTL). The broker version comes from `driver.serverVersion`
 * (a string or a function returning one) when the driver offers it.
 */
export async function roundTrip(driver: BrokerDriver, prefix?: string, timeoutMs = ROUND_TRIP_TIMEOUT_MS): Promise<RoundTripResult> {
  const channel = channelNames(prefix).reply(`probe-${randomBytes(6).toString('hex')}`);
  const token = randomBytes(16);
  await driver.declare([channelSpecs.reply(channel)]);
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  let received!: () => void;
  const arrived = new Promise<void>((resolve, reject) => {
    received = resolve;
    timer = setTimeout(() => reject(new Error(`no round trip through ${channel} within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  });
  const subscription = await driver.consume(channel, { prefetch: 1, ackMode: 'auto' }, async (event) => {
    if (Buffer.from(event.body).equals(token)) received();
  });
  try {
    const outcome = await driver.publish(channel, { headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(token) }, { ttlMs: timeoutMs });
    if (outcome === 'unroutable') throw new Error(`the broker reported ${channel} unroutable right after it was declared and consumed`);
    await arrived;
  } finally {
    if (timer) clearTimeout(timer);
    await subscription.close().catch(() => {});
  }
  const latencyMs = Math.round(performance.now() - started);
  const version = await serverVersionOf(driver);
  return { latencyMs, ...(version && { version }) };
}

async function serverVersionOf(driver: BrokerDriver): Promise<string | undefined> {
  const candidate = (driver as { serverVersion?: string | (() => string | Promise<string | undefined> | undefined) }).serverVersion;
  try {
    const value = typeof candidate === 'function' ? await candidate.call(driver) : candidate;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Everything that, when changed, means the connection must be reopened. */
const fingerprintOf = (connection: StoredConnection) => JSON.stringify([connection.kind, connection.config, connection.secrets]);

const messagingLog =
  (connectionId: string): MessagingLogger =>
  (level, message, fields) =>
    logger[level](`messaging: ${message}`, { 'landflow.transport.connection': connectionId, ...fields });

interface Managed {
  connection: StoredConnection;
  fingerprint: string;
  /** Bumped on every (re)connect; a stale attempt's result is dropped. */
  generation: number;
  client?: MessagingClient;
  /** The channel prefix the connection's config names (for the probe's temporary channel). */
  prefix?: string;
  health: TransportConnectionHealth;
  attempts: number;
  retryTimer?: NodeJS.Timeout;
  probeTimer?: NodeJS.Timeout;
  unsubscribe?: () => void;
  /** Brokered endpoints this connection added to the registry. */
  endpoints: Set<string>;
}

export interface BrokerConnectionManagerOptions {
  connections?: TransportConnections;
  modules?: DriverModules;
  discovery?: BrokerDiscovery;
  env?: NodeJS.ProcessEnv;
  hostInstanceId?: string;
  /** `0` turns the periodic round trip off. */
  probeIntervalMs?: number;
  statsIntervalMs?: number;
}

export class BrokerConnectionManager {
  readonly hostInstanceId: string;
  private readonly managed = new Map<string, Managed>();
  private readonly connections: TransportConnections;
  private readonly modules: DriverModules;
  private readonly env: NodeJS.ProcessEnv;
  private discovery?: BrokerDiscovery;
  private keyring?: Keyring;
  private secretError?: string;
  private stopListening: Array<() => void> = [];
  private state: 'new' | 'started' | 'stopped' = 'new';
  private syncing?: Promise<void>;

  constructor(private readonly options: BrokerConnectionManagerOptions = {}) {
    this.connections = options.connections ?? transportConnections;
    this.modules = options.modules ?? driverModules;
    this.env = options.env ?? process.env;
    this.hostInstanceId = options.hostInstanceId ?? randomBytes(8).toString('hex');
  }

  /** Open every enabled connection that has a driver and follow the table from now on. Idempotent. */
  async start(discovery?: BrokerDiscovery): Promise<void> {
    if (this.state === 'started') return;
    this.state = 'started';
    this.discovery = discovery ?? this.options.discovery ?? (await import('../plugins/registry')).registry;
    this.loadKeyring();
    this.stopListening.push(
      this.connections.subscribe(() => void this.sync()),
      onTablesChanged((change) => {
        if (change.tables.has('transport_connections')) void this.sync();
      }),
    );
    await this.sync();
  }

  /** Close every connection (the plugins' brokered endpoints stay in the registry, offline). */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    for (const stop of this.stopListening) stop();
    this.stopListening = [];
    await Promise.all([...this.managed.keys()].map((id) => this.close(id, 'host stopping', false)));
  }

  /** Read the secret again (tests set the environment after construction). */
  loadKeyring(): void {
    try {
      this.keyring = Keyring.fromEnv(this.env);
      this.secretError = undefined;
    } catch (error) {
      this.keyring = undefined;
      this.secretError = (error as Error).message;
    }
  }

  get hasSecret(): boolean {
    return Boolean(this.keyring);
  }

  /** Bring the open connections in line with the table: open new or changed ones, close disabled or deleted ones. */
  sync(): Promise<void> {
    if (this.state !== 'started') return Promise.resolve();
    // One sync at a time; a request during a sync runs another one after it.
    if (this.syncing) return this.syncing.then(() => this.sync());
    this.syncing = this.doSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const kinds = new Set(this.modules.kinds());
    const wanted = new Map(
      this.connections
        .list()
        .filter((c) => c.enabled && kinds.has(c.kind))
        .map((c) => [c.id, c] as const),
    );
    for (const id of [...this.managed.keys()]) if (!wanted.has(id)) await this.close(id, 'connection disabled or removed', true);
    for (const connection of wanted.values()) {
      const fingerprint = fingerprintOf(connection);
      const existing = this.managed.get(connection.id);
      if (existing?.fingerprint === fingerprint) continue;
      if (existing) await this.close(connection.id, 'connection changed; reconnecting', false);
      const managed: Managed = { connection, fingerprint, generation: 0, health: { state: 'connecting', since: new Date().toISOString() }, attempts: 0, endpoints: new Set() };
      this.managed.set(connection.id, managed);
      await this.connect(managed);
    }
  }

  private async connect(managed: Managed): Promise<void> {
    const generation = ++managed.generation;
    const { connection } = managed;
    const fail = (message: string) => {
      if (managed.generation !== generation) return;
      const reconnecting = managed.health.state === 'connected' || managed.health.state === 'reconnecting';
      managed.health = { ...managed.health, state: reconnecting ? 'reconnecting' : 'error', message, since: new Date().toISOString() };
      managed.attempts++;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(managed.attempts - 1, 6));
      managed.retryTimer = setTimeout(() => void this.connect(managed), delay);
      managed.retryTimer.unref?.();
      logger.warn('broker connection failed', { 'landflow.transport.kind': connection.kind, 'landflow.transport.connection': connection.id, error: message, 'landflow.retry.ms': delay });
    };
    if (!this.keyring) return fail(this.secretError ?? 'no shared secret');
    const module = await this.modules.load(connection.kind);
    if (!module) return fail(`No driver for ${connection.kind} in this host`);
    let client: MessagingClient;
    try {
      const config = module.configFrom(connection.id, String(connection.config.url ?? ''), { ...connection.config, ...connection.secrets });
      managed.prefix = config.prefix;
      client = await MessagingClient.start({
        driver: module.create(),
        config,
        keyring: this.keyring,
        hostInstanceId: this.hostInstanceId,
        registrySecret: this.env.LANDFLOW_REGISTRY_SECRET || null,
        statsIntervalMs: this.options.statsIntervalMs,
        log: messagingLog(connection.id),
      });
    } catch (error) {
      return fail((error as Error).message);
    }
    if (managed.generation !== generation || this.state !== 'started') return void client.close().catch(() => {});
    managed.client = client;
    managed.unsubscribe = client.on('plugin', (event) => this.onPlugin(managed, client, event));
    let probe: RoundTripResult | undefined;
    try {
      probe = await roundTrip(client.driver, managed.prefix);
    } catch (error) {
      logger.warn('broker connection opened but the round trip failed', { 'landflow.transport.connection': connection.id, error: (error as Error).message });
    }
    if (managed.generation !== generation) return;
    managed.attempts = 0;
    const now = new Date().toISOString();
    managed.health = {
      state: 'connected',
      since: now,
      hostInstanceId: this.hostInstanceId,
      ...(probe && { roundTripMs: probe.latencyMs, checkedAt: now, ...(probe.version && { version: probe.version }) }),
    };
    logger.info('broker connection open', { 'landflow.transport.kind': connection.kind, 'landflow.transport.connection': connection.id, 'landflow.transport.round_trip_ms': probe?.latencyMs });
    const interval = this.options.probeIntervalMs ?? CONNECTION_PROBE_INTERVAL_MS;
    if (interval > 0) {
      managed.probeTimer = setInterval(() => void this.probe(managed, generation), interval);
      managed.probeTimer.unref?.();
    }
  }

  /** The periodic round trip: a failure closes the client and reconnects (the plugins' endpoints go offline meanwhile). */
  private async probe(managed: Managed, generation: number): Promise<void> {
    const client = managed.client;
    if (!client || managed.generation !== generation) return;
    try {
      const result = await roundTrip(client.driver, managed.prefix);
      if (managed.generation !== generation) return;
      const now = new Date().toISOString();
      managed.health = { ...managed.health, roundTripMs: result.latencyMs, checkedAt: now, announced: client.plugins().filter((p) => p.instances.length).length, ...(result.version && { version: result.version }) };
    } catch (error) {
      if (managed.generation !== generation) return;
      logger.warn('broker connection lost', { 'landflow.transport.connection': managed.connection.id, error: (error as Error).message });
      await this.disconnect(managed, 'connection lost; reconnecting');
      managed.health = { state: 'reconnecting', message: (error as Error).message, since: new Date().toISOString() };
      await this.connect(managed);
    }
  }

  /** Close the client (endpoints go offline), keep the entry. */
  private async disconnect(managed: Managed, reason: string): Promise<void> {
    managed.generation++;
    if (managed.retryTimer) clearTimeout(managed.retryTimer);
    if (managed.probeTimer) clearInterval(managed.probeTimer);
    managed.retryTimer = managed.probeTimer = undefined;
    managed.unsubscribe?.();
    managed.unsubscribe = undefined;
    const client = managed.client;
    managed.client = undefined;
    for (const endpoint of managed.endpoints) this.discovery?.withdraw(endpoint, reason);
    if (client) await client.close().catch((error: Error) => logger.warn('closing a broker connection failed', { 'landflow.transport.connection': managed.connection.id, error: error.message }));
  }

  private async close(id: string, reason: string, forget: boolean): Promise<void> {
    const managed = this.managed.get(id);
    if (!managed) return;
    this.managed.delete(id);
    await this.disconnect(managed, reason);
    if (forget) for (const endpoint of managed.endpoints) this.discovery?.removeEndpoint(endpoint);
    managed.endpoints.clear();
  }

  private onPlugin(managed: Managed, client: MessagingClient, event: PluginEvent): void {
    const endpoint = client.endpointOf(event.plugin.pluginId);
    const fields = { 'landflow.transport.connection': managed.connection.id, 'landflow.plugin.id': event.plugin.pluginId, 'landflow.plugin.endpoint': endpoint };
    if (event.type === 'announced' || event.type === 'updated') {
      managed.endpoints.add(endpoint);
      this.discovery?.addEndpoint(endpoint, 'broker').catch((error: Error) => logger.warn('brokered plugin could not be registered', { ...fields, error: error.message }));
    } else if (!event.plugin.instances.length) {
      this.discovery?.withdraw(endpoint, event.type === 'expired' ? 'every instance stopped heartbeating' : undefined);
    }
  }

  // -------------------------------------------------------------------------
  // What providers, the selector and the API read
  // -------------------------------------------------------------------------

  /** The open client of a connection, or undefined while it is not connected. */
  clientFor(connectionId: string): MessagingClient | undefined {
    return this.managed.get(connectionId)?.client;
  }

  /** Why a connection has no open client, for error messages. */
  describe(connectionId: string): string {
    const managed = this.managed.get(connectionId);
    if (!managed) return this.secretError ?? `broker connection "${connectionId}" is not open (disabled, deleted or without a driver)`;
    return `broker connection "${connectionId}" is ${managed.health.state}${managed.health.message ? `: ${managed.health.message}` : ''}`;
  }

  health(connectionId: string): TransportConnectionHealth | undefined {
    const managed = this.managed.get(connectionId);
    if (!managed) return undefined;
    const announced = managed.client?.plugins().filter((p) => p.instances.length).length;
    return { ...managed.health, ...(announced !== undefined && { announced }) };
  }

  /** A kind's provider health: the secret, then whether any connection of the kind is open. */
  providerHealth(kind: TransportKind): ProviderHealth {
    if (this.secretError) return { ok: false, message: this.secretError };
    const ofKind = [...this.managed.values()].filter((m) => m.connection.kind === kind);
    if (!ofKind.length) return { ok: true, message: 'No enabled connection yet' };
    const open = ofKind.filter((m) => m.client);
    if (open.length) return { ok: true, message: `${open.length} of ${ofKind.length} connection${ofKind.length === 1 ? '' : 's'} open` };
    const first = ofKind[0]!;
    return { ok: false, message: `${first.connection.name} is ${first.health.state}${first.health.message ? `: ${first.health.message}` : ''}` };
  }

  /** The plugin as announced on a connection, if the connection is open and has seen it. */
  announced(endpoint: string): AnnouncedPlugin | undefined {
    const parsed = safeBrokered(endpoint);
    return parsed && this.clientFor(parsed.connectionId)?.plugin(parsed.pluginId);
  }

  /** The selector's queue inputs for a brokered endpoint. */
  queueStats(endpoint: string): BrokerQueueStats | undefined {
    const parsed = safeBrokered(endpoint);
    const client = parsed && this.clientFor(parsed.connectionId);
    if (!parsed || !client) return undefined;
    const plugin = client.plugin(parsed.pluginId);
    const stats = client.stats(parsed.pluginId);
    if (!plugin && !stats) return undefined;
    const maxConcurrency = plugin?.instances.reduce((sum, i) => sum + (i.maxConcurrency ?? 0), 0);
    return {
      ...(stats?.depth !== undefined && { depth: stats.depth }),
      ...(stats?.consumers !== undefined && { consumers: stats.consumers }),
      ...(stats?.lag !== undefined && { lag: stats.lag }),
      ...(plugin && { instances: plugin.instances.length }),
      ...(maxConcurrency && { maxConcurrency }),
      ...(stats && { sampledAt: new Date(stats.sampledAt).toISOString() }),
    };
  }

  /**
   * How many calls the plugin's announced instances take at once, over every open connection. An instance announces on
   * one registry channel, so two connections to the same broker see the same instance: counted once, by its id.
   */
  maxConcurrencyOf(pluginId: string): number | undefined {
    const seen = new Map<string, number>();
    for (const managed of this.managed.values()) for (const instance of managed.client?.plugin(pluginId)?.instances ?? []) seen.set(instance.instanceId, instance.maxConcurrency ?? 0);
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    return total || undefined;
  }

  /** The request channel a plugin's calls go to on a connection (the span's `messaging.destination.name`). */
  destinationOf(connectionId: string, pluginId: string): string {
    return (this.clientFor(connectionId)?.names ?? channelNames()).request(pluginId);
  }

  /** Connection ids with an open client, for tests. */
  openConnections(): string[] {
    return [...this.managed.values()].filter((m) => m.client).map((m) => m.connection.id);
  }
}

function safeBrokered(endpoint: string) {
  try {
    return brokeredEndpoint(endpoint);
  } catch {
    return undefined;
  }
}

export const brokerConnections = singleton('broker-connections', () => new BrokerConnectionManager());
