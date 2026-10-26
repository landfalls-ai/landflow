/**
 * The plugin registry: the single place where node types come from.
 *
 * Four discovery sources feed it — built-in (in-process), announce (plugins
 * push + heartbeat), static seeds (LANDFLOW_PLUGINS) and scan (we probe a port
 * range) — plus Kubernetes discovery (kubernetes.ts) when it is turned on. A plugin may be reachable through several endpoints (e.g. HTTP and
 * gRPC); the registry tracks each one's health and executes through the
 * preferred online endpoint. It also implements the engine's NodeTypeResolver.
 */
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import {
  DEFAULT_ANNOUNCE_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  qualifyType,
  splitType,
  type AnnounceRequest,
  type AnnounceResponse,
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
import { withSpan } from '../telemetry';
import { createClient, HttpPluginClient, GrpcPluginClient, normalizeEndpoint, PooledPluginClient, transportOf, type PluginClient } from './clients';
import { provenManifest } from './registry-proof';

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
}

interface PluginEntry {
  id: string;
  manifest: PluginManifest;
  source: DiscoverySource;
  inProcess?: IPlugin;
  endpoints: Map<string, EndpointState>;
  preferredTransport?: Transport;
  registeredAt: number;
  updatedAt: number;
  lastError?: string;
}

const HEALTH_INTERVAL_MS = 15_000;

export class PluginRegistry implements NodeTypeResolver {
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
    const client = createClient(endpoint);
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
      if (state.source !== 'announce' && state.source !== 'builtin') state.source = 'announce';
      this.emit({ type: 'plugin.heartbeat', pluginId: entry.id, endpoint, message: `heartbeat from ${endpoint}` });
    } else {
      const added = (await this.addEndpoint(endpoint, 'announce', ttl)).endpoints.get(endpoint);
      if (added && request.instanceId) added.instanceId = request.instanceId;
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
    entry.endpoints.forEach((state) => state.client.close());
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

  setPreferredTransport(id: string, transport: Transport | undefined) {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Unknown plugin "${id}"`);
    entry.preferredTransport = transport;
    this.emit({ type: 'plugin.updated', pluginId: id, message: `${entry.manifest.plugin.name} now prefers ${transport ?? 'auto'} transport` });
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

  private activeEndpoint(entry: PluginEntry): EndpointState | undefined {
    const online = [...entry.endpoints.values()].filter((s) => s.status === 'online');
    if (!online.length) return undefined;
    const preferred = entry.preferredTransport && online.find((s) => s.transport === entry.preferredTransport);
    // Default: gRPC first (binary, multiplexed), then HTTP.
    return preferred ?? online.find((s) => s.transport === 'grpc') ?? online[0];
  }

  private status(entry: PluginEntry): PluginStatus {
    if (entry.inProcess) return 'online';
    return this.activeEndpoint(entry) ? 'online' : 'offline';
  }

  list(): PluginSummary[] {
    return [...this.plugins.values()]
      .sort((a, b) => (a.source === 'builtin' ? -1 : b.source === 'builtin' ? 1 : a.id.localeCompare(b.id)))
      .map((entry) => {
        const active = this.activeEndpoint(entry);
        return {
          id: entry.id,
          info: entry.manifest.plugin,
          status: this.status(entry),
          transport: entry.inProcess ? 'in-process' : (active?.transport ?? [...entry.endpoints.values()][0]?.transport ?? 'http'),
          ...(active && { activeEndpoint: active.endpoint }),
          ...(entry.preferredTransport && { preferredTransport: entry.preferredTransport }),
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
    const state = this.activeEndpoint(entry);
    if (!state) return { error: `Plugin "${entry.manifest.plugin.name}" is offline — start it or check its endpoint` };
    return {
      type,
      pluginId,
      transport: state.transport,
      descriptor,
      execute: async (request, extras) => {
        try {
          return await state.client.execute(request, extras?.signal);
        } catch (error) {
          state.lastError = (error as Error).message;
          throw new Error(`${entry.manifest.plugin.name} via ${state.transport.toUpperCase()} ${state.endpoint}: ${(error as Error).message}`);
        }
      },
      // App webhook triggers (lib/server/app-webhooks.ts).
      ...(descriptor.triggerSource === 'appWebhook' && {
        webhookMethod: (request: WebhookMethodRequest) => state.client.webhookMethod(request),
        webhook: (request: WebhookRequest) => state.client.receiveWebhook(request),
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
    const state = this.activeEndpoint(entry);
    if (!state) throw new Error(`Plugin "${pluginId}" is offline`);
    return state.client.loadOptions({ nodeType: nodeName, method, parameters, ...(credentials && { credentials }) });
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
    const state = this.activeEndpoint(entry);
    if (!state) return { ok: false, message: `${entry.manifest.plugin.name} is offline — start it to test this credential` };
    try {
      return await state.client.testCredentials({ credentialType, data });
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
