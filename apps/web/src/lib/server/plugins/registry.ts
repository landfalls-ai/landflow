/**
 * The plugin registry: the single place where node types come from.
 *
 * Four discovery sources feed it — built-in (in-process), announce (plugins
 * push + heartbeat), static seeds (LANDFLOW_PLUGINS) and scan (we probe a port
 * range) — plus Kubernetes discovery (kubernetes.ts) when it is turned on. A plugin may be reachable through several endpoints (e.g. HTTP and
 * gRPC, later brokers); the registry tracks each one's health and executes through the endpoint the transport selector
 * picks per call from the plugin's policy (lib/server/transports). It also implements the engine's NodeTypeResolver.
 */
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import {
  DEFAULT_ANNOUNCE_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  mcpToolsFromManifest,
  qualifyType,
  splitType,
  type AnnounceRequest,
  type AnnounceResponse,
  type CompositeTypeDescriptor,
  type JsonObject,
  type PluginManifest,
  type PropertyOption,
  type TestCredentialsResponse,
  type WebhookMethodRequest,
  type WebhookRequest,
} from '@landflow/protocol';
import { buildManifest, runLoadOptions, runTestCredentials, type IPlugin } from '@landflow/sdk';
import { inProcessNodeType, type NodeTypeResolver, type ResolvedNodeType, type Transport } from '@landflow/engine';
import type { CredentialTypeInfo, DiscoverySource, EndpointOrigin, NodeTypeInfo, PluginStatus, PluginSummary, RegistryEvent } from '../../shared/types';
import { withBinaryData } from '../binary/access';
import { withExtends } from '../credentials/extends';
import { freshCredentials, withFreshTokens } from '../credentials/oauth2-runtime';
import { withExternalSecrets } from '../secrets/runtime';
import { withGovernance } from '../governance/policy';
import { bus } from '../bus';
import { singleton } from '../singleton';
import { withSpan, withTransportChoice } from '../telemetry';
import type { BrokerQueueStats, PluginTransportSummary, TransportChoice, TransportPolicy } from '../../shared/transports';
import type { CompositeTypeInfo } from '../../shared/composites';
import { transportAuto, type AutoEndpoint, type AutoSource } from '../transports/auto';
import { brokerConnections } from '../transports/brokers';
import { policyFromPreferred, transportPolicies, withWorkflowOverride } from '../transports/policy-store';
import { transportProviders } from '../transports/provider';
import { isChoice, runModeOf, select, type CallContext, type Candidate, type Selection, type SelectorInputs } from '../transports/selector';
import { workflowTransportOverride } from '../transports/workflow-scope';
import { HttpPluginClient, GrpcPluginClient, normalizeEndpoint, PooledPluginClient, transportOf, type PluginClient } from './clients';
import { provenManifest } from './registry-proof';
import { mcpExposure } from '../mcp/exposure';

/** How many MCP tools a manifest maps to (docs/protocol.md §15.1), memoised per manifest object. */
const toolCounts = new WeakMap<PluginManifest, number>();
function mcpToolCount(manifest: PluginManifest): number {
  let count = toolCounts.get(manifest);
  if (count === undefined) {
    count = mcpToolsFromManifest(manifest).length;
    toolCounts.set(manifest, count);
  }
  return count;
}

/** Extras for endpoints found by Kubernetes discovery; a re-registration without them keeps the endpoint's own. */
export interface EndpointOptions {
  /** The namespace and Service it came from, shown on the Plugins page. */
  origin?: EndpointOrigin;
  /** Prove LANDFLOW_REGISTRY_SECRET on GetManifest (registry-proof.ts): the endpoint never announced with it. */
  requireProof?: boolean;
  /**
   * A process-local endpoint (a marketplace node plugin this process runs on 127.0.0.1): queue mode never shares it
   * through `plugin_registrations`, since every process runs its own copy (lib/server/cluster/plugins.ts).
   */
  local?: boolean;
}

/** What queue mode compares to notice a plugin's restart or a changed manifest (lib/server/cluster/plugins.ts). */
export interface EndpointInfo {
  source: DiscoverySource;
  status: PluginStatus;
  instanceId?: string;
  /** A short hash of the manifest last pulled through this endpoint. */
  manifestHash: string;
  local: boolean;
}

/** A short, stable hash of a manifest: a restart that changes icons or descriptors without a version bump changes it. */
export const manifestHash = (manifest: PluginManifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);

interface EndpointState {
  endpoint: string;
  transport: Exclude<Transport, 'in-process'>;
  source: DiscoverySource;
  client: PluginClient;
  status: PluginStatus;
  lastSeen?: number;
  leaseExpiresAt?: number;
  latencyMs?: number;
  lastError?: string;
  options?: EndpointOptions;
  /** The plugin process that announced it (AnnounceRequest.instanceId): a new one is a restart, so the manifest is pulled again. */
  instanceId?: string;
  /** manifestHash() of the manifest pulled through this endpoint. */
  manifestHash: string;
  /** The `maxConcurrency` hint the plugin sent with its announce (docs/protocol.md §14.1). */
  maxConcurrency?: number;
}

interface PluginEntry {
  id: string;
  manifest: PluginManifest;
  source: DiscoverySource;
  inProcess?: IPlugin;
  endpoints: Map<string, EndpointState>;
  registeredAt: number;
  updatedAt: number;
  lastError?: string;
}

const HEALTH_INTERVAL_MS = 15_000;

export class PluginRegistry implements NodeTypeResolver, AutoSource {
  private readonly plugins = new Map<string, PluginEntry>();
  private readonly pending = new Map<string, Promise<PluginEntry>>();
  /** Kubernetes discovery: the ready pods behind an endpoint (a Service), for calls spread over them (clients.ts). */
  private readonly backends = new Map<string, string[]>();
  private timer?: NodeJS.Timeout;
  private lastHealthSweep = 0;
  private scanning = false;

  private emit(event: RegistryEvent) {
    bus.publish({ channel: 'registry', event });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), 5_000);
    this.timer.unref?.();
    // Auto's windows, probes and gauge (lib/server/transports/auto.ts) run over this registry's endpoints.
    transportAuto.start(this, this.baseInputs);
  }

  /** The endpoints as Auto probes and ranks them (transports/auto.ts). */
  autoEndpoints(): AutoEndpoint[] {
    const list: AutoEndpoint[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.inProcess) continue;
      for (const state of entry.endpoints.values()) {
        list.push({
          pluginId: entry.id,
          pluginName: entry.manifest.plugin.name,
          endpoint: state.endpoint,
          kind: state.transport,
          status: state.status,
          ...(state.latencyMs !== undefined && { latencyMs: state.latencyMs }),
          health: (timeoutMs) => state.client.health(timeoutMs),
        });
      }
    }
    return list;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  registerBuiltin(plugin: IPlugin) {
    const manifest = buildManifest(plugin);
    this.plugins.set(plugin.info.id, {
      id: plugin.info.id,
      manifest,
      source: 'builtin',
      inProcess: plugin,
      endpoints: new Map(),
      registeredAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** Connect to an endpoint, pull + validate its manifest, upsert the plugin. */
  addEndpoint(rawEndpoint: string, source: DiscoverySource, ttlSeconds?: number, options?: EndpointOptions): Promise<PluginEntry> {
    const endpoint = normalizeEndpoint(rawEndpoint);
    options ??= this.endpointState(endpoint)?.options;
    // Coalesce concurrent registrations of the same endpoint (announce + scan race).
    const inflight = this.pending.get(endpoint);
    if (inflight) return inflight;
    const task = withSpan('registry.register', { attributes: { 'landflow.plugin.endpoint': endpoint, 'landflow.discovery.source': source } }, async (span) => {
      const entry = await this.connectEndpoint(endpoint, source, ttlSeconds, options);
      span.setAttribute('landflow.plugin.id', entry.id);
      return entry;
    }).finally(() => this.pending.delete(endpoint));
    this.pending.set(endpoint, task);
    return task;
  }

  private async connectEndpoint(endpoint: string, source: DiscoverySource, ttlSeconds?: number, options?: EndpointOptions): Promise<PluginEntry> {
    // The endpoint's kind picks the provider (lib/server/transports): direct HTTP/gRPC today, broker drivers as they land.
    const client = transportProviders.createClient(endpoint);
    const started = Date.now();
    let manifest: PluginManifest;
    try {
      manifest = options?.requireProof ? await provenManifest(client) : await client.manifest();
    } catch (error) {
      client.close();
      const message = (error as Error).message;
      this.emit({ type: 'plugin.error', endpoint, message: `Could not register ${endpoint}: ${message}` });
      throw error;
    }
    const latencyMs = Date.now() - started;
    const id = manifest.plugin.id;
    const existing = this.plugins.get(id);
    if (existing?.source === 'builtin') {
      client.close();
      throw new Error(`Plugin id "${id}" is reserved by a built-in plugin`);
    }

    // A re-pull (Refresh, a version change) keeps the announcing process until an announce names another one.
    const previous = existing?.endpoints.get(endpoint);
    const instanceId = previous?.instanceId;
    // Spread over pods: a re-pull keeps the pods' clients (their calls in flight go on) and swaps the Service's.
    const pods = this.backends.get(endpoint);
    let stateClient: PluginClient = client;
    if (previous?.client instanceof PooledPluginClient) {
      previous.client.replacePrimary(client);
      stateClient = previous.client;
    } else if (pods) stateClient = new PooledPluginClient(client, pods);
    const state: EndpointState = {
      endpoint,
      transport: client.transport,
      source,
      client: stateClient,
      status: 'online',
      lastSeen: Date.now(),
      latencyMs,
      ...(ttlSeconds && { leaseExpiresAt: Date.now() + ttlSeconds * 1000 }),
      ...(options && { options }),
      ...(instanceId && { instanceId }),
      ...(previous?.maxConcurrency && { maxConcurrency: previous.maxConcurrency }),
      manifestHash: manifestHash(manifest),
    };

    if (existing) {
      if (previous && previous.client !== stateClient) previous.client.close();
      existing.endpoints.set(endpoint, state);
      const versionChanged = existing.manifest.plugin.version !== manifest.plugin.version;
      existing.manifest = manifest;
      existing.updatedAt = Date.now();
      existing.lastError = undefined;
      this.emit({
        type: 'plugin.updated',
        pluginId: id,
        endpoint,
        message: versionChanged
          ? `${manifest.plugin.name} upgraded to ${manifest.plugin.version}`
          : `${manifest.plugin.name} reachable via ${state.transport.toUpperCase()} ${endpoint}`,
      });
      return existing;
    }

    const entry: PluginEntry = {
      id,
      manifest,
      source,
      endpoints: new Map([[endpoint, state]]),
      registeredAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.plugins.set(id, entry);
    this.emit({
      type: 'plugin.registered',
      pluginId: id,
      endpoint,
      source,
      message: `${manifest.plugin.name} (${manifest.plugin.language}) registered via ${source} — ${manifest.nodes.length} node(s) over ${state.transport.toUpperCase()}`,
    });
    return entry;
  }

  async announce(request: AnnounceRequest): Promise<AnnounceResponse> {
    const endpoint = normalizeEndpoint(request.endpoint);
    const ttl = request.ttlSeconds ?? DEFAULT_ANNOUNCE_TTL_SECONDS;
    const entry = this.plugins.get(request.pluginId);
    const state = entry?.endpoints.get(endpoint);

    // A plugin coming back after a withdraw/lease expiry is usually a restarted process whose
    // manifest (icons, descriptors) may have changed without a version bump: re-pull it below.
    // So is one that announces another instanceId while still online (restarted within its lease, as in development).
    // Older plugins send none and only heartbeat here.
    const restarted = Boolean(request.instanceId) && request.instanceId !== state?.instanceId;
    if (entry && state && state.status === 'online' && entry.manifest.plugin.version === request.version && !restarted) {
      // Heartbeat: renew the lease, no manifest round-trip.
      state.lastSeen = Date.now();
      state.leaseExpiresAt = Date.now() + ttl * 1000;
      state.lastError = undefined;
      if (request.maxConcurrency) state.maxConcurrency = request.maxConcurrency;
      if (state.source !== 'announce' && state.source !== 'builtin') state.source = 'announce';
      this.emit({ type: 'plugin.heartbeat', pluginId: entry.id, endpoint, message: `heartbeat from ${endpoint}` });
    } else {
      const added = (await this.addEndpoint(endpoint, 'announce', ttl)).endpoints.get(endpoint);
      if (added && request.instanceId) added.instanceId = request.instanceId;
      if (added && request.maxConcurrency) added.maxConcurrency = request.maxConcurrency;
    }
    return {
      accepted: true,
      heartbeatIntervalSeconds: Math.max(2, Math.min(DEFAULT_HEARTBEAT_SECONDS, Math.floor(ttl / 3))),
      message: 'ok',
    };
  }

  /** Mark an endpoint offline (a plugin's withdraw; Kubernetes discovery when no pod is ready, with its own `reason`). */
  withdraw(rawEndpoint: string, reason?: string) {
    const endpoint = normalizeEndpoint(rawEndpoint);
    for (const entry of this.plugins.values()) {
      const state = entry.endpoints.get(endpoint);
      if (!state) continue;
      state.status = 'offline';
      state.leaseExpiresAt = undefined;
      if (reason) state.lastError = reason;
      this.emit({ type: 'plugin.offline', pluginId: entry.id, endpoint, message: `${entry.manifest.plugin.name} ${reason ? `offline at ${endpoint}: ${reason}` : `withdrew ${endpoint}`}` });
      return true;
    }
    return false;
  }

  /** Forget one endpoint (a discovered Service was deleted); the plugin goes with its last endpoint. */
  removeEndpoint(rawEndpoint: string) {
    const endpoint = normalizeEndpoint(rawEndpoint);
    for (const entry of this.plugins.values()) {
      const state = entry.endpoints.get(endpoint);
      if (!state) continue;
      this.backends.delete(endpoint);
      if (entry.endpoints.size === 1) return this.remove(entry.id);
      state.client.close();
      transportAuto.forget(endpoint);
      entry.endpoints.delete(endpoint);
      entry.updatedAt = Date.now();
      this.emit({ type: 'plugin.updated', pluginId: entry.id, endpoint, message: `${entry.manifest.plugin.name} no longer listed at ${endpoint}` });
      return true;
    }
    return false;
  }

  /**
   * The ready pods behind an endpoint (Kubernetes discovery, `grpc://10.1.2.3:7201`…): its calls are spread over them,
   * its manifest and health still go through the endpoint. Kept for an endpoint still registering; [] (or none) ends it.
   */
  setEndpointBackends(rawEndpoint: string, backends: string[]) {
    const endpoint = normalizeEndpoint(rawEndpoint);
    const list = [...new Set(backends.map(normalizeEndpoint))].sort();
    if (list.length) this.backends.set(endpoint, list);
    else this.backends.delete(endpoint);
    for (const entry of this.plugins.values()) {
      const state = entry.endpoints.get(endpoint);
      if (!state) continue;
      if (state.client instanceof PooledPluginClient) state.client.setBackends(list);
      else if (list.length) state.client = new PooledPluginClient(state.client, list);
      return;
    }
  }

  /** The pods an endpoint's calls are spread over, with their calls (tests and troubleshooting). */
  endpointBackends(rawEndpoint: string): Array<{ endpoint: string; inflight: number; calls: number }> {
    const client = this.endpointState(normalizeEndpoint(rawEndpoint))?.client;
    return client instanceof PooledPluginClient ? client.stats() : [];
  }

  /** Status of one endpoint, if any plugin has it. */
  endpointStatus(rawEndpoint: string): PluginStatus | undefined {
    return this.endpointState(normalizeEndpoint(rawEndpoint))?.status;
  }

  /** Source, status, announcing process and manifest hash of one endpoint (queue mode compares them across processes). */
  endpointInfo(rawEndpoint: string): EndpointInfo | undefined {
    const state = this.endpointState(normalizeEndpoint(rawEndpoint));
    if (!state) return undefined;
    return { source: state.source, status: state.status, ...(state.instanceId && { instanceId: state.instanceId }), manifestHash: state.manifestHash, local: Boolean(state.options?.local) };
  }

  /**
   * Pull an endpoint's manifest again (queue mode: another process saw the plugin restart, or its manifest change), keeping
   * its source and options; `instanceId` records the announcing process the change came with.
   */
  async repull(rawEndpoint: string, instanceId?: string): Promise<void> {
    const endpoint = normalizeEndpoint(rawEndpoint);
    const state = this.endpointState(endpoint);
    const added = (await this.addEndpoint(endpoint, state?.source ?? 'static', undefined, state?.options)).endpoints.get(endpoint);
    if (added && instanceId) added.instanceId = instanceId;
  }

  private endpointState(endpoint: string): EndpointState | undefined {
    for (const entry of this.plugins.values()) {
      const state = entry.endpoints.get(endpoint);
      if (state) return state;
    }
    return undefined;
  }

  remove(id: string) {
    const entry = this.plugins.get(id);
    if (!entry || entry.source === 'builtin') return false;
    entry.endpoints.forEach((state) => {
      state.client.close();
      transportAuto.forget(state.endpoint);
    });
    this.plugins.delete(id);
    this.emit({ type: 'plugin.removed', pluginId: id, message: `${entry.manifest.plugin.name} removed` });
    return true;
  }

  async refresh(id: string) {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Unknown plugin "${id}"`);
    if (entry.inProcess) return entry;
    const results = await Promise.allSettled(
      [...entry.endpoints.values()].map((state) => this.addEndpoint(state.endpoint, state.source)),
    );
    if (results.every((r) => r.status === 'rejected')) {
      throw new Error(`No endpoint of "${id}" answered`);
    }
    return this.plugins.get(id)!;
  }

  /** The plugin's transport policy (lib/server/transports/policy-store.ts; Auto/balanced unless stored). */
  policy(id: string): TransportPolicy {
    return transportPolicies.get(id);
  }

  /** Store the plugin's transport policy (shared by every process in queue mode) and tell the Plugins page. */
  setPolicy(id: string, policy: Partial<TransportPolicy>, updatedBy?: string): TransportPolicy {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Unknown plugin "${id}"`);
    const stored = transportPolicies.set(id, policy, updatedBy);
    transportAuto.policyChanged(id);
    const how = stored.mode === 'pinned' ? `pinned to ${stored.pinned}` : `on Auto (${stored.objective})${stored.allowed ? `, limited to ${stored.allowed.join(', ')}` : ''}`;
    this.emit({ type: 'plugin.updated', pluginId: id, message: `${entry.manifest.plugin.name} transport ${how}` });
    return stored;
  }

  /** The older `preferredTransport` setting: a transport pins the policy to it, none puts it back on Auto. */
  setPreferredTransport(id: string, transport: Transport | undefined) {
    this.setPolicy(id, policyFromPreferred(transport, transportPolicies.get(id)));
  }

  // -------------------------------------------------------------------------
  // Health: leases + active probes
  // -------------------------------------------------------------------------

  private async sweep() {
    const now = Date.now();
    for (const entry of this.plugins.values()) {
      for (const state of entry.endpoints.values()) {
        if (state.source === 'announce' && state.status === 'online' && state.leaseExpiresAt && state.leaseExpiresAt < now) {
          state.status = 'offline';
          this.emit({ type: 'plugin.offline', pluginId: entry.id, endpoint: state.endpoint, message: `${entry.manifest.plugin.name} lease expired (${state.endpoint})` });
        }
      }
    }
    if (now - this.lastHealthSweep < HEALTH_INTERVAL_MS) return;
    this.lastHealthSweep = now;
    // Endpoints without a lease (static / scan / manual) — or whose lease lapsed — are probed.
    const probes: Promise<void>[] = [];
    for (const entry of this.plugins.values()) {
      for (const state of entry.endpoints.values()) {
        if (state.source === 'announce' && state.status === 'online') continue;
        probes.push(this.probe(entry, state));
      }
    }
    await Promise.allSettled(probes);
  }

  private async probe(entry: PluginEntry, state: EndpointState) {
    const started = Date.now();
    try {
      const health = await state.client.health(2_000);
      state.latencyMs = Date.now() - started;
      state.lastSeen = Date.now();
      state.lastError = undefined;
      if (state.status !== 'online') {
        state.status = 'online';
        if (health.version !== entry.manifest.plugin.version) void this.addEndpoint(state.endpoint, state.source);
        this.emit({ type: 'plugin.updated', pluginId: entry.id, endpoint: state.endpoint, message: `${entry.manifest.plugin.name} is back online (${state.endpoint})` });
      }
    } catch (error) {
      state.lastError = (error as Error).message;
      if (state.status === 'online') {
        state.status = 'offline';
        this.emit({ type: 'plugin.offline', pluginId: entry.id, endpoint: state.endpoint, message: `${entry.manifest.plugin.name} unreachable at ${state.endpoint}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scan (pull discovery)
  // -------------------------------------------------------------------------

  scan(options: { hosts?: string[]; ports?: number[] } = {}) {
    return withSpan('registry.scan', {}, async (span) => {
      const result = await this.runScan(options);
      span.setAttributes({ 'landflow.scan.targets': result.probed, 'landflow.scan.found': result.found });
      return result;
    });
  }

  private async runScan(options: { hosts?: string[]; ports?: number[] }) {
    if (this.scanning) return { found: 0, probed: 0, alreadyRunning: true };
    this.scanning = true;
    const started = Date.now();
    const hosts = options.hosts ?? (process.env.LANDFLOW_SCAN_HOSTS ?? '127.0.0.1').split(',').map((h) => h.trim());
    const ports = options.ports ?? parsePorts(process.env.LANDFLOW_SCAN_PORTS ?? '7100-7299');
    const targets = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
    this.emit({ type: 'scan.started', targets: targets.length, message: `Scanning ${targets.length} ports on ${hosts.join(', ')}` });

    const known = new Set([...this.plugins.values()].flatMap((e) => [...e.endpoints.keys()]));
    let found = 0;
    try {
      const open = (await mapLimit(targets, 64, async (t) => ((await isPortOpen(t.host, t.port, 250)) ? t : null))).filter(
        (t): t is { host: string; port: number } => t !== null,
      );
      await mapLimit(open, 8, async ({ host, port }) => {
        const http = `http://${host}:${port}`;
        const grpcEndpoint = `grpc://${host}:${port}`;
        let endpoint: string | undefined;
        let pluginId: string | undefined;
        try {
          pluginId = (await new HttpPluginClient(http).wellKnown(700)).plugin.id;
          endpoint = http;
        } catch {
          const client = new GrpcPluginClient(grpcEndpoint);
          try {
            pluginId = (await client.health(700)).pluginId;
            endpoint = grpcEndpoint;
          } catch {
            // Not a Landflow plugin.
          } finally {
            client.close();
          }
        }
        this.emit({
          type: 'scan.probe',
          endpoint: endpoint ?? `${host}:${port}`,
          found: Boolean(endpoint),
          ...(pluginId && { pluginId }),
          message: endpoint ? `Found ${pluginId} at ${endpoint}` : `${host}:${port} is open but not a Landflow plugin`,
        });
        if (endpoint && !known.has(endpoint)) {
          try {
            await this.addEndpoint(endpoint, 'scan');
            found++;
          } catch {}
        } else if (endpoint) {
          const entry = this.plugins.get(pluginId!);
          const state = entry?.endpoints.get(endpoint);
          if (entry && state && state.status !== 'online') await this.probe(entry, state);
        }
      });
    } finally {
      this.scanning = false;
    }
    const durationMs = Date.now() - started;
    this.emit({ type: 'scan.finished', found, durationMs, message: `Scan finished in ${durationMs} ms — ${found} new endpoint(s)` });
    return { found, probed: targets.length, durationMs };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * What the registry knows for the selector: capabilities, the brokers' queue numbers (depth, consumers, lag, sampled
   * every 5 s by the messaging clients) and the plugin's `maxConcurrency` (announced instances over brokers, else the
   * announce hint, else the manifest). Auto (transports/auto.ts) completes them with the latency windows, failures,
   * calls in flight, breakers and the main kind.
   */
  private readonly baseInputs: SelectorInputs = {
    capabilities: (kind) => transportProviders.get(kind)?.capabilities,
    queue: (endpoint) => brokerConnections.queueStats(endpoint),
    maxConcurrency: (pluginId) => {
      const entry = this.plugins.get(pluginId);
      const hinted = entry && [...entry.endpoints.values()].find((s) => s.maxConcurrency)?.maxConcurrency;
      return brokerConnections.maxConcurrencyOf(pluginId) ?? hinted ?? entry?.manifest.maxConcurrency;
    },
  };
  private readonly selectorInputs: SelectorInputs = transportAuto.inputs(this.baseInputs);

  /** Live numbers of one endpoint: a broker's request channel and announced instances (undefined for direct endpoints). */
  private queueOf(state: EndpointState): BrokerQueueStats | undefined {
    return brokerConnections.queueStats(state.endpoint);
  }

  /** The numbers of one transport kind: brokered endpoints summed; every kind with the plugin's `maxConcurrency` when known. */
  private statsOf(entry: PluginEntry, states: EndpointState[]): BrokerQueueStats | undefined {
    const queues = states.map((s) => this.queueOf(s)).filter((q): q is BrokerQueueStats => Boolean(q));
    const sum = (key: 'depth' | 'consumers' | 'lag' | 'instances' | 'maxConcurrency') => {
      const values = queues.map((q) => q[key]).filter((v): v is number => v !== undefined);
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    const stats: BrokerQueueStats = {
      ...(sum('depth') !== undefined && { depth: sum('depth') }),
      ...(sum('consumers') !== undefined && { consumers: sum('consumers') }),
      ...(sum('lag') !== undefined && { lag: sum('lag') }),
      ...(sum('instances') !== undefined && { instances: sum('instances') }),
    };
    const maxConcurrency = sum('maxConcurrency') ?? states.find((s) => s.maxConcurrency)?.maxConcurrency ?? entry.manifest.maxConcurrency;
    if (maxConcurrency) stats.maxConcurrency = maxConcurrency;
    const sampledAt = queues.map((q) => q.sampledAt).filter((s): s is string => Boolean(s)).sort().at(-1);
    if (sampledAt) stats.sampledAt = sampledAt;
    return Object.keys(stats).length ? stats : undefined;
  }

  private candidates(entry: PluginEntry): Candidate[] {
    return [...entry.endpoints.values()].map((s) => ({ endpoint: s.endpoint, kind: s.transport, status: s.status, ...(s.latencyMs !== undefined && { latencyMs: s.latencyMs }) }));
  }

  /** The plugin's policy for a call: its own, or the running workflow's override of it (settings `transports`, transports/workflow-scope.ts). */
  private policyFor(entry: PluginEntry): TransportPolicy | { error: string } {
    const policy = transportPolicies.get(entry.id);
    const scoped = workflowTransportOverride(entry.id);
    if (!scoped) return policy;
    const effective = withWorkflowOverride(policy, scoped.override);
    return 'error' in effective ? { error: `Plugin "${entry.id}": ${effective.error} (workflow settings → Transports)` } : effective;
  }

  /** The transport for one call of this plugin, or why there is none (lib/server/transports/selector.ts). */
  private choose(entry: PluginEntry, context: CallContext, candidates = this.candidates(entry)): Selection {
    const policy = this.policyFor(entry);
    return 'error' in policy ? policy : select(entry.id, candidates, policy, context, this.selectorInputs);
  }

  /** `select()` for a plugin id, as the API and tests ask it: `{ endpoint, kind, reason }` or `{ error }`. */
  select(pluginId: string, context: CallContext = { method: 'Execute' }): Selection {
    const entry = this.plugins.get(pluginId);
    if (!entry) return { error: `Unknown plugin "${pluginId}"` };
    if (entry.inProcess) return { error: `Plugin "${pluginId}" runs in-process` };
    return this.choose(entry, context);
  }

  /** The endpoint a choice names (the endpoint left the registry between choosing and calling: none). */
  private chosen(entry: PluginEntry, context: CallContext): EndpointState | undefined {
    const selection = this.choose(entry, context);
    return isChoice(selection) ? entry.endpoints.get(selection.endpoint) : undefined;
  }

  /** The endpoint the next Execute would take: what the Plugins page shows as active. */
  private activeEndpoint(entry: PluginEntry): EndpointState | undefined {
    return this.chosen(entry, { method: 'Execute' });
  }

  private status(entry: PluginEntry): PluginStatus {
    if (entry.inProcess) return 'online';
    return this.activeEndpoint(entry) ? 'online' : 'offline';
  }

  /** The plugin's transports by kind, for the Plugins page: endpoints, live state and whether the policy keeps the kind out. */
  private transportsOf(entry: PluginEntry, policy: TransportPolicy): PluginTransportSummary[] {
    const byKind = new Map<string, EndpointState[]>();
    for (const state of entry.endpoints.values()) byKind.set(state.transport, [...(byKind.get(state.transport) ?? []), state]);
    // Faces the plugin was built with (manifest `transports`) that no endpoint reaches yet: shown, offline, so an admin sees what a connection would add.
    for (const kind of entry.manifest.transports ?? []) if (kind !== 'mcp' && !byKind.has(kind)) byKind.set(kind, []);
    const excludedBy = (kind: string) => (policy.mode === 'pinned' && policy.pinned !== kind) || (policy.allowed?.length ? !policy.allowed.includes(kind) : false);
    return [...byKind.entries()].map(([kind, states]) => {
      const stats = this.statsOf(entry, states);
      return {
        kind,
        endpoints: states.map((s) => s.endpoint),
        online: states.some((s) => s.status === 'online'),
        ...(excludedBy(kind) && { excluded: true }),
        ...(!states.length && { declared: true }),
        ...(stats && { stats }),
        ...(states.length && { auto: transportAuto.summary(entry.id, kind, states.map((s) => s.endpoint)) }),
      };
    });
  }

  list(): PluginSummary[] {
    return [...this.plugins.values()]
      .sort((a, b) => (a.source === 'builtin' ? -1 : b.source === 'builtin' ? 1 : a.id.localeCompare(b.id)))
      .map((entry) => {
        const selection = entry.inProcess ? undefined : this.choose(entry, { method: 'Execute' });
        const choice: TransportChoice | undefined = selection && isChoice(selection) ? selection : undefined;
        const active = choice && entry.endpoints.get(choice.endpoint);
        const policy = transportPolicies.get(entry.id);
        return {
          id: entry.id,
          info: entry.manifest.plugin,
          status: this.status(entry),
          transport: entry.inProcess ? 'in-process' : (active?.transport ?? [...entry.endpoints.values()][0]?.transport ?? 'http'),
          ...(active && { activeEndpoint: active.endpoint }),
          ...(policy.mode === 'pinned' && policy.pinned && { preferredTransport: policy.pinned }),
          ...(!entry.inProcess && { transports: this.transportsOf(entry, policy), policy }),
          ...(choice && { choice }),
          ...(selection && !isChoice(selection) && { choiceError: selection.error }),
          endpoints: [...entry.endpoints.values()].map((s) => ({
            endpoint: s.endpoint,
            transport: s.transport,
            source: s.source,
            status: s.status,
            ...(s.lastSeen && { lastSeen: new Date(s.lastSeen).toISOString() }),
            ...(s.leaseExpiresAt && { leaseExpiresAt: new Date(s.leaseExpiresAt).toISOString() }),
            ...(s.latencyMs !== undefined && { latencyMs: s.latencyMs }),
            ...(s.lastError && { lastError: s.lastError }),
            ...(s.options?.origin && { origin: s.options.origin }),
            ...(s.source === 'broker' && { queue: this.queueOf(s) ?? {} }),
            auto: transportAuto.endpointSummary(entry.id, s.endpoint, s.transport),
          })),
          source: entry.source,
          registeredAt: new Date(entry.registeredAt).toISOString(),
          updatedAt: new Date(entry.updatedAt).toISOString(),
          ...(entry.lastError && { lastError: entry.lastError }),
          nodes: entry.manifest.nodes.map((n) => ({
            name: n.name,
            displayName: n.displayName,
            description: n.description,
            icon: n.icon,
            color: n.color,
            kind: n.kind,
            categories: n.categories,
            usableAsTool: n.usableAsTool,
          })),
          // MCP (docs/transports.md): "Expose to agents" and the tool count of the manifest (lib/server/mcp/plugin-servers.ts).
          mcp: { exposed: mcpExposure.isExposed(entry.id), tools: mcpToolCount(entry.manifest), path: `/api/mcp/plugins/${encodeURIComponent(entry.id)}` },
        };
      });
  }

  nodeTypes(): NodeTypeInfo[] {
    return [...this.plugins.values()].flatMap((entry) => {
      const available = this.status(entry) === 'online';
      const transport: Transport = entry.inProcess ? 'in-process' : (this.activeEndpoint(entry)?.transport ?? 'http');
      const { plugin } = entry.manifest;
      return entry.manifest.nodes.map((descriptor) => ({
        type: qualifyType(entry.id, descriptor.name),
        pluginId: entry.id,
        pluginName: plugin.name,
        ...(plugin.icon && { pluginIcon: plugin.icon }),
        ...(plugin.color && { pluginColor: plugin.color }),
        ...(plugin.description && { pluginDescription: plugin.description }),
        language: plugin.language,
        transport,
        available,
        descriptor,
      }));
    });
  }

  /**
   * The composite types plugins declare (docs/composites.md), fully qualified (`triage.aiTriage`): the newest version
   * as `descriptor`, every version in `all` (newest first) when there are several.
   */
  compositeTypes(): CompositeTypeInfo[] {
    return [...this.plugins.values()].flatMap((entry) => {
      const available = this.status(entry) === 'online';
      const byName = new Map<string, CompositeTypeDescriptor[]>();
      for (const descriptor of entry.manifest.composites ?? []) byName.set(descriptor.name, [...(byName.get(descriptor.name) ?? []), descriptor]);
      return [...byName.values()].map((list) => {
        const all = [...list].sort((a, b) => b.version - a.version);
        return {
          type: qualifyType(entry.id, all[0].name),
          source: { kind: 'plugin' as const, pluginId: entry.id, pluginName: entry.manifest.plugin.name },
          descriptor: all[0],
          versions: all.map((d) => d.version),
          ...(all.length > 1 && { all }),
          available,
        };
      });
    });
  }

  /** A node type to execute; binary data (lib/server/binary/access.ts) and fresh OAuth2 tokens (lib/server/credentials/oauth2-runtime.ts) are wired in. */
  resolve(type: string): ResolvedNodeType | { error: string } {
    const resolved = this.resolveType(type);
    // External secrets innermost: `$secrets` in credentials resolve after token renewal, and responses are redacted.
    // Governance outermost: a node type the policy blocks fails before anything else runs (lib/server/governance/policy.ts).
    return 'error' in resolved ? resolved : withGovernance(withBinaryData(withFreshTokens(withExternalSecrets(resolved))));
  }

  private resolveType(type: string): ResolvedNodeType | { error: string } {
    let pluginId: string;
    let nodeName: string;
    try {
      ({ pluginId, nodeName } = splitType(type));
    } catch (error) {
      return { error: (error as Error).message };
    }
    const entry = this.plugins.get(pluginId);
    if (!entry) return { error: `Unknown node type "${type}" — plugin "${pluginId}" is not registered` };

    if (entry.inProcess) {
      const node = entry.inProcess.nodes.find((n) => n.description.name === nodeName);
      return node ? inProcessNodeType(pluginId, node) : { error: `Plugin "${pluginId}" has no node "${nodeName}"` };
    }

    const descriptor = entry.manifest.nodes.find((n) => n.name === nodeName);
    if (!descriptor) return { error: `Plugin "${pluginId}" has no node "${nodeName}"` };
    // The transport is chosen per call (the request tells the run mode, the item count and whether it may repeat); what
    // the resolver reports is the choice the next Execute would make now, and the error when there is none.
    const provisional = this.choose(entry, { method: 'Execute' });
    if (!isChoice(provisional)) return { error: provisional.error.replace(`Plugin "${pluginId}"`, `Plugin "${entry.manifest.plugin.name}"`) };
    const name = entry.manifest.plugin.name;
    const call = async <T>(context: CallContext, fn: (state: EndpointState) => Promise<T>, failed?: { endpoint: string; detail: string }): Promise<T> => {
      // A fail-over (second try) leaves out the endpoint that provably did not get the call; a pinned policy then has nowhere to go.
      const candidates = this.candidates(entry).filter((c) => c.endpoint !== failed?.endpoint);
      let selection = this.choose(entry, context, candidates);
      if (!isChoice(selection)) throw new Error(selection.error.replace(`Plugin "${pluginId}"`, `Plugin "${name}"`));
      if (failed) selection = { ...selection, reason: 'auto.failover', detail: failed.detail };
      const state = entry.endpoints.get(selection.endpoint);
      if (!state) throw new Error(`Plugin "${name}": ${selection.endpoint} left the registry`);
      const choice = selection;
      try {
        // Auto records the outcome (latency windows, failures, breaker, metrics) and holds the endpoint after a `capacity` refusal.
        return await transportAuto.run({ pluginId: entry.id, pluginName: name, choice, context }, () => withTransportChoice(choice, () => fn(state)));
      } catch (error) {
        state.lastError = (error as Error).message;
        // Rule 7 (docs/transports.md): a call moves to another transport only when it provably was not delivered (connection refused,
        // DNS, gRPC UNAVAILABLE before sending, a broker that reported it unroutable), or when the plugin refused it for capacity: once.
        // A call its caller aborted before it went out is not delivered either, but nobody wants it anywhere else.
        const verdict = transportAuto.classify(error);
        if (!failed && verdict.movable && candidates.some((c) => c.endpoint !== state.endpoint && c.status === 'online')) {
          const detail = verdict.kind === 'capacity' ? `${state.transport} refused the call (capacity)` : `${state.transport} did not deliver the call: ${(error as Error).message}`;
          try {
            return await call(context, fn, { endpoint: state.endpoint, detail });
          } catch (second) {
            throw new Error(`${name} via ${state.transport.toUpperCase()} ${state.endpoint}: ${(error as Error).message}; then ${(second as Error).message}`);
          }
        }
        throw new Error(`${name} via ${state.transport.toUpperCase()} ${state.endpoint}: ${(error as Error).message}`);
      }
    };
    return {
      type,
      pluginId,
      transport: provisional.kind,
      descriptor,
      execute: (request, extras) =>
        call(
          {
            method: 'Execute',
            mode: runModeOf(request.mode),
            items: request.inputs.reduce((n, items) => n + items.length, 0),
            // The serialized size: brokers with a smaller limit are skipped, and latency is measured per size bucket.
            payloadBytes: Buffer.byteLength(JSON.stringify(request)),
            // An operation's `idempotent` overrides the node's (protocol: tool annotations); an idempotency key alone doesn't make the call repeatable.
            ...(descriptor.idempotent !== undefined && { idempotent: descriptor.idempotent }),
            executionId: request.executionId,
          },
          (state) => state.client.execute(request, extras?.signal),
        ),
      // App webhook triggers (lib/server/app-webhooks.ts).
      ...(descriptor.triggerSource === 'appWebhook' && {
        webhookMethod: (request: WebhookMethodRequest) => call({ method: 'WebhookMethod', mode: 'production' }, (state) => state.client.webhookMethod(request)),
        webhook: (request: WebhookRequest) => call({ method: 'ReceiveWebhook', mode: 'production' }, (state) => state.client.receiveWebhook(request)),
      }),
    };
  }

  async loadOptions(type: string, method: string, parameters: JsonObject, credentials?: Record<string, JsonObject>): Promise<PropertyOption[]> {
    credentials = await freshCredentials(credentials);
    const { pluginId, nodeName } = splitType(type);
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Unknown plugin "${pluginId}"`);
    if (entry.inProcess) {
      const node = entry.inProcess.nodes.find((n) => n.description.name === nodeName);
      if (!node) throw new Error(`Unknown node "${type}"`);
      return runLoadOptions(node, method, parameters, credentials);
    }
    const context: CallContext = { method: 'LoadOptions', mode: 'manual', idempotent: true };
    const selection = this.choose(entry, context);
    if (!isChoice(selection)) throw new Error(selection.error);
    const state = entry.endpoints.get(selection.endpoint);
    if (!state) throw new Error(`Plugin "${pluginId}" is offline`);
    return transportAuto.run({ pluginId: entry.id, pluginName: entry.manifest.plugin.name, choice: selection, context }, () =>
      withTransportChoice(selection, () => state.client.loadOptions({ nodeType: nodeName, method, parameters, ...(credentials && { credentials }) })),
    );
  }

  // -------------------------------------------------------------------------
  // Credential types
  // -------------------------------------------------------------------------

  /** Every plugin's credential types, with the properties of the types they extend merged in (lib/server/credentials/extends.ts). */
  credentialTypes(): CredentialTypeInfo[] {
    return withExtends(this.listCredentialTypes());
  }

  private listCredentialTypes(): CredentialTypeInfo[] {
    return [...this.plugins.values()].flatMap((entry) => {
      const { plugin } = entry.manifest;
      return (entry.manifest.credentialTypes ?? []).map((descriptor) => ({
        type: qualifyType(entry.id, descriptor.name),
        pluginId: entry.id,
        pluginName: plugin.name,
        ...(plugin.icon && { pluginIcon: plugin.icon }),
        ...(plugin.color && { pluginColor: plugin.color }),
        available: this.status(entry) === 'online',
        descriptor,
        nodeTypes: entry.manifest.nodes
          .filter((node) => node.credentials?.some((c) => c.name === descriptor.name || c.name === qualifyType(entry.id, descriptor.name)))
          .map((node) => qualifyType(entry.id, node.name)),
      }));
    });
  }

  credentialType(type: string): CredentialTypeInfo | undefined {
    return this.credentialTypes().find((info) => info.type === type);
  }

  /** "Test connection": ask the plugin that owns the type to make a cheap authenticated call. */
  async testCredentials(type: string, data: JsonObject): Promise<TestCredentialsResponse> {
    const { pluginId, nodeName: credentialType } = splitType(type);
    const entry = this.plugins.get(pluginId);
    const descriptor = entry?.manifest.credentialTypes?.find((c) => c.name === credentialType);
    if (!entry || !descriptor) return { ok: false, message: `Unknown credential type "${type}"` };
    if (!descriptor.testable) return { ok: false, message: `${descriptor.displayName} can't be tested — save it and run a node` };
    if (entry.inProcess) return runTestCredentials(entry.inProcess, { credentialType, data });
    const context: CallContext = { method: 'TestCredentials', mode: 'manual', idempotent: true };
    const selection = this.choose(entry, context);
    const state = isChoice(selection) ? entry.endpoints.get(selection.endpoint) : undefined;
    if (!state || !isChoice(selection)) return { ok: false, message: `${entry.manifest.plugin.name} is offline — start it to test this credential` };
    try {
      return await transportAuto.run({ pluginId: entry.id, pluginName: entry.manifest.plugin.name, choice: selection, context }, () =>
        withTransportChoice(selection, () => state.client.testCredentials({ credentialType, data })),
      );
    } catch (error) {
      return { ok: false, message: `${entry.manifest.plugin.name} via ${state.transport.toUpperCase()}: ${(error as Error).message}` };
    }
  }
}

function parsePorts(spec: string): number[] {
  return spec.split(',').flatMap((part) => {
    const [from, to] = part.trim().split('-').map(Number);
    if (!to) return [from];
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  });
}

function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

export { transportOf };
export const registry = singleton('registry', () => new PluginRegistry());
