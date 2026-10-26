/**
 * `McpGatewaySync` (docs/transports.md "Automatic registration", docs/protocol.md §15.4): keeps the bundled MCP gateway's
 * targets equal to the plugins that are online, exposed to agents and have at least one tool, plus `core`.
 *
 * - **Targets**: one `mcp.target` per plugin, `name` = {@link gatewayTargetName}(pluginId), host = this host's endpoint
 *   `/api/mcp/plugins/<id>` reached from the gateway (`LANDFLOW_MCP_GATEWAY_HOST_URL`), `backendAuth` sending
 *   `LANDFLOW_MCP_GATEWAY_SECRET` as `x-landflow-gateway`, and transformations that set `x-landflow-caller-iss/-sub/-jti`
 *   from the validated token (`jwt.*`, overwriting anything a client sent) and remove `authorization`.
 * - **Routes** (agentgateway only, `LANDFLOW_MCP_GATEWAY_ROUTES` ≠ `off`): per plugin a `traffic.route` at
 *   `/mcp/plugins/<name>` whose backend is an inline MCP server with that one target (unprefixed tools), and one at
 *   `/mcp/plugins/<name>/server-card` proxying to the host's Server Card with the client's own bearer.
 * - **When**: on every registry change (`plugin.registered/updated/offline/removed`, exposure flips publish
 *   `plugin.updated`), debounced, and a full reconcile every 30 s. A plugin offline for 60 s loses its target and gets
 *   it back when it returns. The gateway restarting or someone editing a Landflow target is repaired on the next tick.
 * - **Own resources only**: the names Landflow created are kept in `mcp_gateway_resources` (migration 1730); nothing
 *   else in the gateway is touched. A target an admin created under a plugin's name is adopted (that name is the
 *   plugin's by contract) and logged.
 * - **After a change** the `core` endpoint emits `notifications/tools/list_changed` to its `subscriptions/listen`
 *   streams (./plugin-servers.ts), since the gateway relays upstream notifications but emits none for its own target set.
 * - **Modes** (`LANDFLOW_MCP_GATEWAY`): `bundled` → the config API (./gateway-adapters.ts `AgentgatewayAdapter`),
 *   `file` → `FileGatewayAdapter` on `LANDFLOW_MCP_GATEWAY_FILE`, `off` → nothing runs.
 *
 * Runs in the main process only (bootstrap.ts; workers don't sync). State is a `singleton()` so Next's dev reload keeps
 * one loop. Tests inject the plugin source, the adapter, the clock and the store.
 */
import { gatewayTargetName } from '@landflow/protocol';
import { join } from 'node:path';
import type { RegistryEvent } from '../../shared/types';
import { bus } from '../bus';
import { dataDir } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { mcpDb } from './db';
import { mcpExposure } from './exposure';
import { AgentgatewayAdapter, FileGatewayAdapter, type GatewayHealth, type GatewayRoute, type GatewayRouteValue, type GatewayTarget, type GatewayTargetValue, type McpGatewayAdapter } from './gateway-adapters';
import { pluginTools } from './grants';
import { CALLER_ISSUER_HEADER, CALLER_SUBJECT_HEADER, CALLER_TOKEN_ID_HEADER, GATEWAY_SECRET_HEADER, gatewayMode, gatewaySecret } from './identity';
import { CORE_PLUGIN_ID, notifyPluginToolsChanged, PLUGIN_MCP_PATH } from './plugin-servers';
import { onPublicationChangedAnywhere } from '../publications';
import { gatewayPublicUrl, purgeMcpTokens } from './tokens';

export type { GatewayRoute, GatewayTarget, GatewayTargetValue, McpGatewayAdapter } from './gateway-adapters';

export const RECONCILE_INTERVAL_MS = 30_000;
/** A plugin offline this long loses its target. */
export const OFFLINE_GRACE_MS = 60_000;
const EVENT_DEBOUNCE_MS = 300;
const FIRST_RECONCILE_DELAY_MS = 2_000;
/** Revoked or expired tokens are deleted this long after (the reconcile tick purges, at most hourly). */
export const TOKEN_PURGE_AFTER_DAYS = 30;
const TOKEN_PURGE_EVERY_MS = 60 * 60_000;
/** Names of the routes the sync owns start with these (the file adapter keeps every other route). */
export const ROUTE_PREFIX = 'landflow-';
const PLUGIN_ROUTE_PREFIX = `${ROUTE_PREFIX}mcp-`;
const CARD_ROUTE_PREFIX = `${ROUTE_PREFIX}card-`;
/** The gateway path one plugin is served on (docs/transports.md "How a call flows"). */
export const GATEWAY_PLUGIN_PATH = '/mcp/plugins';

const RELEVANT: ReadonlySet<RegistryEvent['type']> = new Set(['plugin.registered', 'plugin.updated', 'plugin.offline', 'plugin.removed']);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The URL at which the gateway reaches this host (`LANDFLOW_MCP_GATEWAY_HOST_URL`): a compose or Kubernetes sidecar
 * shares the host's network namespace, so `http://127.0.0.1:3000`; the dev gateway runs in Docker while the dev server
 * runs on the Mac, so the default is `http://host.docker.internal:<PORT|3000>`.
 */
export function gatewayHostUrl(): string {
  const configured = process.env.LANDFLOW_MCP_GATEWAY_HOST_URL?.trim().replace(/\/+$/, '');
  return configured || `http://host.docker.internal:${process.env.PORT ?? 3000}`;
}

/** `LANDFLOW_MCP_GATEWAY_FILE`, the config file written in file mode (default `<data dir>/mcp-gateway.yaml`). */
export function gatewayFilePath(): string {
  return process.env.LANDFLOW_MCP_GATEWAY_FILE?.trim() || join(dataDir(), 'mcp-gateway.yaml');
}

/** `LANDFLOW_MCP_GATEWAY_ROUTES=off` keeps the sync to the shared `/mcp` endpoint (no per-plugin paths). */
export function gatewayRoutesEnabled(): boolean {
  return process.env.LANDFLOW_MCP_GATEWAY_ROUTES?.trim().toLowerCase() !== 'off';
}

/**
 * `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES`: a JSON object merged into the `policies` of every per-plugin route (for
 * example the same `mcpAuthentication` as the base config's `/mcp` route). Invalid JSON is ignored and logged once.
 */
export function gatewayRoutePolicies(): Record<string, unknown> | undefined {
  const raw = process.env.LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  singleton('mcp-gateway-route-policies-warned', () => {
    logger.warn('LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES is not a JSON object; ignored');
    return true;
  });
  return undefined;
}

/** The gateway target name of a plugin; lives in `@landflow/protocol` so `gatewayToolName()` prefixes tools the same way. */
export { gatewayTargetName };

/** A plugin's URL on the gateway, given the gateway's public URL. */
export const gatewayPluginPath = (pluginId: string) => `${GATEWAY_PLUGIN_PATH}/${gatewayTargetName(pluginId)}`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  hostUrl: string;
  secret: string;
  routePolicies?: Record<string, unknown>;
  /** LANDFLOW_MCP_GATEWAY_PUBLIC_URL: completes each route's `mcpAuthentication` with the route's own resource. */
  publicUrl?: string;
}

/**
 * A per-plugin route's policies: the configured ones, with an `mcpAuthentication` that has no `resourceMetadata` given
 * the route's own (agentgateway refuses the route without it, 422 "missing field `resourceMetadata`", and only the host
 * knows each route's public URL): the route's URL as the resource, the policy's issuer as the authorization server.
 */
export function routePoliciesFor(policies: Record<string, unknown> | undefined, path: string, publicUrl: string | undefined): Record<string, unknown> | undefined {
  const auth = policies?.mcpAuthentication as Record<string, unknown> | undefined;
  if (!policies || !auth || typeof auth !== 'object' || auth.resourceMetadata !== undefined || !publicUrl) return policies;
  const resourceMetadata = {
    resource: `${publicUrl.replace(/\/+$/, '')}${path}`,
    ...(typeof auth.issuer === 'string' && { authorization_servers: [auth.issuer] }),
    bearer_methods_supported: ['header'],
  };
  return { ...policies, mcpAuthentication: { ...auth, resourceMetadata } };
}

/** Which kind of MCP server a gateway target stands for. */
export type ServerKind = 'plugin' | 'instance' | 'workflow';

/** The owner key (`mcp_gateway_resources.plugin_id`) of the instance server's target, and the prefix of a workflow's (`@workflow:<path>`). */
export const INSTANCE_KEY = '@instance';
export const WORKFLOW_KEY_PREFIX = '@workflow:';
/** Where the instance server is served on the gateway, and the prefix of a workflow's path there. */
export const GATEWAY_INSTANCE_PATH = '/mcp/landflow';
export const GATEWAY_WORKFLOW_PATH = '/mcp/workflows';

/** What the sync keeps a target and its routes for: a plugin, the instance server, or a published workflow with an MCP Server Trigger. */
export interface SyncEntry {
  key: string;
  kind: ServerKind;
  /** The target's name (a Gateway API section name); it prefixes the tools on the shared `/mcp` endpoint. */
  name: string;
  /** Where the host serves it, from the host URL. */
  hostPath: string;
  /** Where the gateway serves it alone. */
  gatewayPath: string;
  /** A person-sized name for Settings → MCP. */
  label: string;
  /** Plugins also proxy their Server Card. */
  cardPath?: string;
}

/** An MCP server of the host that is not a plugin: the instance server (when it is on), or a workflow's MCP Server Trigger. */
export interface SyncServer {
  kind: 'instance' | 'workflow';
  /** The trigger's path (`/mcp/<path>`) for a workflow. */
  path?: string;
  label: string;
}

/** The name an instance or workflow target has: the same rules as a plugin's ({@link gatewayTargetName}), `wf-` before a trigger path. */
export const gatewayServerName = (server: SyncServer) => (server.kind === 'instance' ? gatewayTargetName('landflow-mcp') : gatewayTargetName(`wf-${server.path}`));

export function entryForPlugin(pluginId: string): SyncEntry {
  const name = gatewayTargetName(pluginId);
  return { key: pluginId, kind: 'plugin', name, hostPath: `${PLUGIN_MCP_PATH}/${encodeURIComponent(pluginId)}`, gatewayPath: `${GATEWAY_PLUGIN_PATH}/${name}`, label: pluginId, cardPath: `${PLUGIN_MCP_PATH}/${encodeURIComponent(pluginId)}/server-card` };
}

export function entryForServer(server: SyncServer): SyncEntry {
  const name = gatewayServerName(server);
  if (server.kind === 'instance') return { key: INSTANCE_KEY, kind: 'instance', name, hostPath: '/api/mcp', gatewayPath: GATEWAY_INSTANCE_PATH, label: server.label };
  const path = server.path ?? '';
  return { key: `${WORKFLOW_KEY_PREFIX}${path}`, kind: 'workflow', name, hostPath: `/mcp/${path.split('/').map(encodeURIComponent).join('/')}`, gatewayPath: `${GATEWAY_WORKFLOW_PATH}/${name}`, label: server.label };
}

/** The kind and label of an owned resource whose entry is no longer wanted, from its key. */
export function describeKey(key: string): { kind: ServerKind; label: string } {
  if (key === INSTANCE_KEY) return { kind: 'instance', label: 'Landflow instance server' };
  if (key.startsWith(WORKFLOW_KEY_PREFIX)) return { kind: 'workflow', label: `/mcp/${key.slice(WORKFLOW_KEY_PREFIX.length)}` };
  return { kind: 'plugin', label: key };
}

/** The `mcp.target` for an entry (the shape docs/mcp-gateway.md verified against agentgateway 1.6.0). */
export function renderEntryTarget(entry: SyncEntry, options: RenderOptions): GatewayTarget {
  const value: GatewayTargetValue = {
    name: entry.name,
    mcp: { host: `${options.hostUrl}${entry.hostPath}` },
    policies: {
      backendAuth: { key: { value: options.secret, location: { header: { name: GATEWAY_SECRET_HEADER } } } },
      transformations: {
        request: {
          set: { [CALLER_ISSUER_HEADER]: 'jwt.iss', [CALLER_SUBJECT_HEADER]: 'jwt.sub', [CALLER_TOKEN_ID_HEADER]: 'jwt.jti' },
          remove: ['authorization'],
        },
      },
    },
  };
  return { name: entry.name, pluginId: entry.key, value };
}

/** The routes of an entry: `<gatewayPath>` (one MCP target, unprefixed tools) and, for a plugin, its `/server-card`. */
export function renderEntryRoutes(entry: SyncEntry, options: RenderOptions): GatewayRoute[] {
  const target = renderEntryTarget(entry, options);
  const path = entry.gatewayPath;
  const host = new URL(options.hostUrl);
  const authority = host.port ? `${host.hostname}:${host.port}` : host.hostname;
  const mcpRoute: GatewayRouteValue = {
    name: `${PLUGIN_ROUTE_PREFIX}${entry.kind === 'plugin' ? '' : `${entry.kind}-`}${entry.name}`,
    gateways: 'default',
    matches: [{ path: { exact: path } }, { path: { exact: `${path}/` } }],
    ...(options.routePolicies && { policies: routePoliciesFor(options.routePolicies, path, options.publicUrl) }),
    backends: [{ mcp: { statefulMode: 'stateless', prefixMode: 'conditional', failureMode: 'failOpen', targets: [target.value] } }],
  };
  const routes: GatewayRoute[] = [{ name: mcpRoute.name, pluginId: entry.key, value: mcpRoute }];
  // The Server Card is plain HTTP: the client's own bearer goes through to the host, which validates it directly.
  if (entry.cardPath) {
    const cardRoute: GatewayRouteValue = {
      name: `${CARD_ROUTE_PREFIX}${entry.name}`,
      gateways: 'default',
      matches: [{ path: { exact: `${path}/server-card` }, method: 'GET' }],
      policies: { urlRewrite: { authority: 'auto', path: { full: entry.cardPath } } },
      backends: [{ host: authority }],
    };
    routes.push({ name: cardRoute.name, pluginId: entry.key, value: cardRoute });
  }
  return routes;
}

/** The `mcp.target` for a plugin. */
export const renderTarget = (pluginId: string, options: RenderOptions): GatewayTarget => renderEntryTarget(entryForPlugin(pluginId), options);

/** The per-plugin routes: `/mcp/plugins/<name>` (one MCP target, unprefixed tools) and its `/server-card`. */
export const renderRoutes = (pluginId: string, options: RenderOptions): GatewayRoute[] => renderEntryRoutes(entryForPlugin(pluginId), options);

// ---------------------------------------------------------------------------
// The owned-resource store
// ---------------------------------------------------------------------------

export type OwnedKind = 'mcp.target' | 'traffic.route';

export interface OwnedResource {
  kind: OwnedKind;
  name: string;
  pluginId: string;
}

/** Where the sync remembers what it created (`mcp_gateway_resources`); tests swap in a map. */
export interface OwnedStore {
  list(): OwnedResource[];
  put(resource: OwnedResource): void;
  delete(kind: OwnedKind, name: string): void;
}

interface OwnedRow {
  kind: string;
  name: string;
  plugin_id: string;
}

export const dbOwnedStore: OwnedStore = {
  list: () => mcpDb().all<OwnedRow>('SELECT kind, name, plugin_id FROM mcp_gateway_resources').map((r) => ({ kind: r.kind as OwnedKind, name: r.name, pluginId: r.plugin_id })),
  put: (resource) => {
    const now = new Date().toISOString();
    const existing = mcpDb().get<{ created_at: string }>('SELECT created_at FROM mcp_gateway_resources WHERE kind = ? AND name = ?', resource.kind, resource.name);
    mcpDb().upsert('mcp_gateway_resources', { kind: resource.kind, name: resource.name, plugin_id: resource.pluginId, created_at: existing?.created_at ?? now, updated_at: now });
  },
  delete: (kind, name) => void mcpDb().delete('mcp_gateway_resources', { kind, name }),
};

export class MemoryOwnedStore implements OwnedStore {
  readonly rows = new Map<string, OwnedResource>();
  list() {
    return [...this.rows.values()];
  }
  put(resource: OwnedResource) {
    this.rows.set(`${resource.kind}:${resource.name}`, resource);
  }
  delete(kind: OwnedKind, name: string) {
    this.rows.delete(`${kind}:${name}`);
  }
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

/** What the sync needs to know about a plugin (the default source reads the registry, the exposure flags and the tool cache). */
export interface SyncPlugin {
  id: string;
  online: boolean;
  exposed: boolean;
  tools: number;
}

export type GatewayTargetState = 'in-step' | 'drift' | 'missing' | 'stale' | 'unknown';

export interface GatewayTargetStatus {
  name: string;
  /** The owner key: a plugin id, `@instance`, or `@workflow:<path>`. */
  pluginId: string;
  kind: OwnedKind;
  state: GatewayTargetState;
  /** Whether the target stands for a plugin, the instance server or a workflow's MCP Server Trigger. */
  serverKind: ServerKind;
  label: string;
}

export interface GatewaySyncStatus {
  mode: 'bundled' | 'file' | 'off';
  adapter?: string;
  location?: string;
  hostUrl: string;
  routes: boolean;
  running: boolean;
  health?: GatewayHealth;
  targets: GatewayTargetStatus[];
  inStep: number;
  drift: number;
  lastSyncAt?: string;
  lastChangeAt?: string;
  lastError?: string;
  secretConfigured: boolean;
}

export interface SyncResult {
  changed: boolean;
  upserted: string[];
  removed: string[];
  skipped?: string;
}

export interface GatewaySyncOptions {
  mode?: 'bundled' | 'file' | 'off';
  adapter?: McpGatewayAdapter;
  plugins?: () => SyncPlugin[] | Promise<SyncPlugin[]>;
  /** The host's other MCP servers (default: the instance server when it is on, and published workflows with an MCP Server Trigger; none when `plugins` is given). */
  servers?: () => SyncServer[] | Promise<SyncServer[]>;
  now?: () => number;
  hostUrl?: () => string;
  secret?: () => string | undefined;
  store?: OwnedStore;
  routes?: boolean;
  routePolicies?: () => Record<string, unknown> | undefined;
  /** Called after a sync that changed the target set (default: the `core` endpoint's `tools/list_changed`). */
  onChanged?: () => void;
  offlineGraceMs?: number;
  reconcileIntervalMs?: number;
  /** Deletes old token rows on the tick (default `purgeMcpTokens`); `null` turns it off. */
  purge?: ((now: number) => number) | null;
}

/** The default plugin source: every registered plugin with its health, exposure and tool count. */
export async function registryPlugins(): Promise<SyncPlugin[]> {
  const { registry } = await import('../plugins/registry');
  return registry.list().map((plugin) => ({ id: plugin.id, online: plugin.status === 'online', exposed: mcpExposure.isExposed(plugin.id), tools: pluginTools(plugin.id).length }));
}

/** The default server source: the instance server (when Settings → MCP turned it on) and every published workflow whose MCP Server Trigger is enabled. */
export async function registryServers(): Promise<SyncServer[]> {
  const [{ mcpAccess }, { productionWorkflows }, { MCP_TRIGGER, mcpTriggerPath }] = await Promise.all([import('./instance'), import('../publish'), import('./trigger')]);
  const out: SyncServer[] = [];
  if (mcpAccess().enabled) out.push({ kind: 'instance', label: 'Landflow instance server' });
  const seen = new Set<string>();
  for (const workflow of productionWorkflows()) {
    for (const node of workflow.nodes) {
      const path = node.type === MCP_TRIGGER && !node.disabled ? mcpTriggerPath(node) : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ kind: 'workflow', path, label: `${workflow.name} (/mcp/${path})` });
    }
  }
  return out;
}

export function defaultAdapter(mode: 'bundled' | 'file' | 'off'): McpGatewayAdapter | undefined {
  if (mode === 'bundled') return new AgentgatewayAdapter();
  if (mode === 'file') return new FileGatewayAdapter({ path: gatewayFilePath(), ownedRoutePrefix: ROUTE_PREFIX });
  return undefined;
}

export class McpGatewaySync {
  readonly mode: 'bundled' | 'file' | 'off';
  readonly adapter?: McpGatewayAdapter;
  private readonly plugins: () => SyncPlugin[] | Promise<SyncPlugin[]>;
  private readonly servers: () => SyncServer[] | Promise<SyncServer[]>;
  private readonly now: () => number;
  private readonly hostUrl: () => string;
  private readonly secret: () => string | undefined;
  private readonly store: OwnedStore;
  private readonly routes: boolean;
  private readonly routePolicies: () => Record<string, unknown> | undefined;
  private readonly onChanged: () => void;
  private readonly offlineGraceMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly purge: ((now: number) => number) | null;

  private readonly offlineSince = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private unsubscribePublications?: () => void;
  private inFlight?: Promise<SyncResult>;
  private again = false;
  private lastPurgeAt = 0;
  private running = false;

  lastSyncAt?: number;
  lastChangeAt?: number;
  lastError?: string;

  constructor(options: GatewaySyncOptions = {}) {
    this.mode = options.mode ?? gatewayMode();
    this.adapter = options.adapter ?? defaultAdapter(this.mode);
    this.plugins = options.plugins ?? registryPlugins;
    this.servers = options.servers ?? (options.plugins ? () => [] : registryServers);
    this.now = options.now ?? Date.now;
    this.hostUrl = options.hostUrl ?? gatewayHostUrl;
    this.secret = options.secret ?? gatewaySecret;
    this.store = options.store ?? dbOwnedStore;
    this.routes = (options.routes ?? gatewayRoutesEnabled()) && Boolean(this.adapter?.upsertRoute);
    this.routePolicies = options.routePolicies ?? gatewayRoutePolicies;
    this.onChanged = options.onChanged ?? (() => void notifyPluginToolsChanged(CORE_PLUGIN_ID));
    this.offlineGraceMs = options.offlineGraceMs ?? OFFLINE_GRACE_MS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.purge = options.purge === undefined ? (now) => purgeMcpTokens({ olderThanDays: TOKEN_PURGE_AFTER_DAYS, now }) : options.purge;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Subscribe to registry events and reconcile on a timer. Idempotent; a no-op in mode `off`, and under vitest (the
   * default admin URL is a real gateway on this machine; tests drive `reconcile()` with their own adapter instead).
   */
  start(): void {
    if (this.running || !this.adapter) return;
    if (process.env.VITEST && process.env.LANDFLOW_MCP_GATEWAY_SYNC_IN_TESTS !== '1') return;
    this.running = true;
    this.unsubscribe = bus.subscribe((event) => {
      if (event.channel !== 'registry' || !RELEVANT.has(event.event.type)) return;
      this.schedule(EVENT_DEBOUNCE_MS);
    });
    // A workflow published, unpublished or deleted adds or removes its MCP Server Trigger's target.
    this.unsubscribePublications = onPublicationChangedAnywhere(() => this.schedule(EVENT_DEBOUNCE_MS));
    this.timer = setInterval(() => void this.tick(), this.reconcileIntervalMs);
    this.timer.unref?.();
    this.schedule(FIRST_RECONCILE_DELAY_MS);
    logger.info('mcp gateway sync started', { mode: this.mode, adapter: this.adapter.kind, location: this.adapter.location, hostUrl: this.hostUrl() });
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribePublications?.();
    this.unsubscribePublications = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.timer = this.debounce = this.graceTimer = undefined;
  }

  /** Something that changes the wanted targets happened (the instance server turned on or off): reconcile soon. */
  nudge(): void {
    if (this.running) this.schedule(EVENT_DEBOUNCE_MS);
  }

  private schedule(delayMs: number) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.tick();
    }, delayMs);
    this.debounce.unref?.();
  }

  /** A reconcile plus the maintenance that rides on the tick (token purge); errors are kept in `lastError`, never thrown. */
  private async tick(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      logger.warn('mcp gateway sync failed', { error: (error as Error).message });
    }
    const now = this.now();
    if (this.purge && now - this.lastPurgeAt >= TOKEN_PURGE_EVERY_MS) {
      this.lastPurgeAt = now;
      try {
        const purged = this.purge(now);
        if (purged) logger.info('mcp tokens purged', { purged });
      } catch (error) {
        logger.warn('mcp token purge failed', { error: (error as Error).message });
      }
    }
  }

  /** The servers that should have a target now (plugins first, applying the offline grace to targets that already exist; then the host's own). */
  private async desired(): Promise<SyncEntry[]> {
    const now = this.now();
    const owned = new Set(this.store.list().filter((r) => r.kind === 'mcp.target').map((r) => r.pluginId));
    const out: SyncEntry[] = [];
    let nextGrace: number | undefined;
    for (const plugin of await this.plugins()) {
      const eligible = plugin.exposed && (plugin.tools > 0 || plugin.id === CORE_PLUGIN_ID);
      if (!eligible) {
        this.offlineSince.delete(plugin.id);
        continue;
      }
      if (plugin.online) {
        this.offlineSince.delete(plugin.id);
        out.push(entryForPlugin(plugin.id));
        continue;
      }
      const since = this.offlineSince.get(plugin.id) ?? now;
      this.offlineSince.set(plugin.id, since);
      if (owned.has(plugin.id) && now - since < this.offlineGraceMs) {
        out.push(entryForPlugin(plugin.id));
        nextGrace = Math.min(nextGrace ?? Infinity, since + this.offlineGraceMs - now);
      }
    }
    // The host's own servers are in this process: wanted exactly while they exist (no offline grace).
    const taken = new Set(out.map((entry) => entry.name));
    for (const server of await this.servers()) {
      const entry = entryForServer(server);
      if (taken.has(entry.name)) {
        logger.warn('mcp gateway: a plugin already has this target name; skipped', { name: entry.name, server: entry.label });
        continue;
      }
      taken.add(entry.name);
      out.push(entry);
    }
    // Come back when the first grace runs out, so a removal doesn't wait for the 30 s tick.
    if (this.running && nextGrace !== undefined) {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => void this.tick(), nextGrace + 50);
      this.graceTimer.unref?.();
    }
    return out;
  }

  /** Bring the gateway in step with the registry. Concurrent calls coalesce into one run plus one follow-up. */
  reconcile(): Promise<SyncResult> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
      if (this.again) {
        this.again = false;
        void this.reconcile();
      }
    });
    return this.inFlight;
  }

  private async run(): Promise<SyncResult> {
    const adapter = this.adapter;
    if (!adapter) return { changed: false, upserted: [], removed: [], skipped: 'gateway mode is off' };
    const secret = this.secret();
    if (!secret) {
      this.lastError = 'LANDFLOW_MCP_GATEWAY_SECRET is not set (at least 16 characters): the host would refuse every call from the gateway, so no target is written';
      return { changed: false, upserted: [], removed: [], skipped: this.lastError };
    }
    const options: RenderOptions = { hostUrl: this.hostUrl(), secret, routePolicies: this.routePolicies(), publicUrl: gatewayPublicUrl() };
    const upserted: string[] = [];
    const removed: string[] = [];
    try {
      const entries = await this.desired();
      const targets = entries.map((entry) => renderEntryTarget(entry, options));
      const routes = this.routes ? entries.flatMap((entry) => renderEntryRoutes(entry, options)) : [];
      const owned = this.store.list();
      const current = await adapter.list();

      if (current === undefined || adapter.replaceAll) {
        // Write-only: render everything, and the owned set becomes the desired set.
        const wantedTargets = new Set(targets.map((t) => t.name));
        const wantedRoutes = new Set(routes.map((r) => r.name));
        await adapter.replaceAll!(targets, routes, owned.filter((r) => r.kind === 'mcp.target').map((r) => r.name));
        for (const t of targets) if (!owned.some((o) => o.kind === 'mcp.target' && o.name === t.name)) upserted.push(t.name);
        for (const o of owned) {
          if (o.kind === 'mcp.target' ? !wantedTargets.has(o.name) : !wantedRoutes.has(o.name)) {
            removed.push(o.name);
            this.store.delete(o.kind, o.name);
          }
        }
        for (const t of targets) this.store.put({ kind: 'mcp.target', name: t.name, pluginId: t.pluginId });
        for (const r of routes) this.store.put({ kind: 'traffic.route', name: r.name, pluginId: r.pluginId });
      } else {
        const have = new Map(current.map((v) => [v.name, v]));
        for (const target of targets) {
          const existing = have.get(target.name);
          const mine = owned.some((o) => o.kind === 'mcp.target' && o.name === target.name);
          if (existing && !mine) logger.warn('mcp gateway: adopting a target that carries a plugin’s name', { name: target.name });
          if (!existing || !sameJson(existing, target.value)) {
            await adapter.upsert(target);
            upserted.push(target.name);
          }
          if (!mine) this.store.put({ kind: 'mcp.target', name: target.name, pluginId: target.pluginId });
        }
        const wanted = new Set(targets.map((t) => t.name));
        for (const o of owned.filter((r) => r.kind === 'mcp.target' && !wanted.has(r.name))) {
          if (have.has(o.name)) {
            await adapter.remove(o.name);
            removed.push(o.name);
          }
          this.store.delete('mcp.target', o.name);
        }

        // Routes, the same way (a gateway without per-plugin paths has none).
        const haveRoutes = new Map((adapter.listRoutes ? ((await adapter.listRoutes()) ?? []) : []).map((v) => [v.name, v]));
        const wantedRoutes = new Set(routes.map((r) => r.name));
        for (const route of routes) {
          const existing = haveRoutes.get(route.name);
          const mine = owned.some((o) => o.kind === 'traffic.route' && o.name === route.name);
          if (!existing || !sameJson(existing, route.value)) {
            await adapter.upsertRoute!(route);
            upserted.push(route.name);
          }
          if (!mine) this.store.put({ kind: 'traffic.route', name: route.name, pluginId: route.pluginId });
        }
        for (const o of owned.filter((r) => r.kind === 'traffic.route' && !wantedRoutes.has(r.name))) {
          if (haveRoutes.has(o.name) && adapter.removeRoute) {
            await adapter.removeRoute(o.name);
            removed.push(o.name);
          }
          this.store.delete('traffic.route', o.name);
        }
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = (error as Error).message;
      throw error;
    } finally {
      this.lastSyncAt = this.now();
    }
    // Only a change of the target set (not a route) changes what `/mcp` lists.
    const targetChanges = [...upserted, ...removed].filter((name) => !name.startsWith(ROUTE_PREFIX));
    const changed = targetChanges.length > 0;
    if (changed) {
      this.lastChangeAt = this.now();
      logger.info('mcp gateway targets changed', { upserted: upserted.filter((n) => !n.startsWith(ROUTE_PREFIX)), removed: removed.filter((n) => !n.startsWith(ROUTE_PREFIX)) });
      try {
        this.onChanged();
      } catch (error) {
        logger.warn('mcp gateway: list_changed notification failed', { error: (error as Error).message });
      }
    }
    return { changed, upserted, removed };
  }

  /** The gateway as it is now against what the registry wants (GET /api/mcp/gateway). */
  async status(): Promise<GatewaySyncStatus> {
    const base: GatewaySyncStatus = {
      mode: this.mode,
      ...(this.adapter && { adapter: this.adapter.kind, location: this.adapter.location }),
      hostUrl: this.hostUrl(),
      routes: this.routes,
      running: this.running,
      targets: [],
      inStep: 0,
      drift: 0,
      ...(this.lastSyncAt && { lastSyncAt: new Date(this.lastSyncAt).toISOString() }),
      ...(this.lastChangeAt && { lastChangeAt: new Date(this.lastChangeAt).toISOString() }),
      ...(this.lastError && { lastError: this.lastError }),
      secretConfigured: Boolean(this.secret()),
    };
    if (!this.adapter) return base;
    base.health = await this.adapter.health();
    const secret = this.secret();
    if (!secret) return base;
    const options: RenderOptions = { hostUrl: this.hostUrl(), secret, routePolicies: this.routePolicies(), publicUrl: gatewayPublicUrl() };
    const wanted = new Map<string, { kind: OwnedKind; pluginId: string; value: unknown; entry: SyncEntry }>();
    for (const entry of await this.desired()) {
      const target = renderEntryTarget(entry, options);
      wanted.set(`mcp.target:${target.name}`, { kind: 'mcp.target', pluginId: entry.key, value: target.value, entry });
      if (this.routes) for (const route of renderEntryRoutes(entry, options)) wanted.set(`traffic.route:${route.name}`, { kind: 'traffic.route', pluginId: entry.key, value: route.value, entry });
    }
    let current: Map<string, unknown> | undefined;
    try {
      const targets = await this.adapter.list();
      if (targets) {
        current = new Map(targets.map((t) => [`mcp.target:${t.name}`, t]));
        if (this.adapter.listRoutes) for (const r of (await this.adapter.listRoutes()) ?? []) current.set(`traffic.route:${r.name}`, r);
      }
    } catch (error) {
      base.health = { ok: false, message: (error as Error).message };
    }
    const owned = this.store.list();
    const keys = new Set([...wanted.keys(), ...owned.map((o) => `${o.kind}:${o.name}`)]);
    for (const key of keys) {
      const [kind, name] = [key.slice(0, key.indexOf(':')) as OwnedKind, key.slice(key.indexOf(':') + 1)];
      const want = wanted.get(key);
      const pluginId = want?.pluginId ?? owned.find((o) => o.kind === kind && o.name === name)?.pluginId ?? '';
      let state: GatewayTargetState;
      if (!current) state = want ? 'unknown' : 'stale';
      else if (want) state = !current.has(key) ? 'missing' : sameJson(current.get(key), want.value) ? 'in-step' : 'drift';
      else state = current.has(key) ? 'stale' : 'in-step';
      if (!want && !current?.has(key)) continue;
      const described = want?.entry ? { kind: want.entry.kind, label: want.entry.label } : describeKey(pluginId);
      base.targets.push({ name, pluginId, kind, state, serverKind: described.kind, label: described.label });
    }
    base.targets.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    base.inStep = base.targets.filter((t) => t.state === 'in-step').length;
    base.drift = base.targets.filter((t) => t.state !== 'in-step' && t.state !== 'unknown').length;
    return base;
  }
}

/** Structural equality of two JSON values, ignoring key order (the gateway echoes what it stored, key order may differ). */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The process's sync (started by bootstrap.ts in the main process). */
export const mcpGatewaySync = singleton('mcp-gateway-sync', () => new McpGatewaySync());
