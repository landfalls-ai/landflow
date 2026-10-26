/**
 * Queue mode: one plugin list for the whole cluster. Plugins announce to (or are found by) a main; the mains write
 * what their registries know to `plugin_registrations` (migration 700: the endpoint, transport, status and the
 * plugin's descriptor in short), and every process (workers too) connects to the endpoints listed there itself, so a
 * worker runs a plugin's nodes over its own connection. Endpoints must be reachable from the workers (service names,
 * not 127.0.0.1); the health probes of each process's registry decide what is online there.
 *
 * Restarts: the descriptor carries the announcing plugin process (`instance`, AnnounceRequest.instanceId) and a hash of
 * the manifest the main pulled (`hash`). A plugin restarted with the same version announces a new instance id, the main
 * re-pulls its manifest and writes both; every other process sees the row change (LISTEN/NOTIFY, or its 30 s sync) and
 * pulls the manifest again too, so new icons, descriptors or nodes reach the workers without a version bump.
 *
 * Endpoints marked `local` (marketplace node plugins: each process runs its own copy on 127.0.0.1) are never written.
 */
import type { PluginSummary } from '../../shared/types';
import { bus, isRelayed } from '../bus';
import { database, type Database } from '../db';
import { registry as processRegistry, type PluginRegistry } from '../plugins/registry';
import { logger } from '../telemetry/logger';

interface RegistrationRow {
  endpoint: string;
  plugin_id: string;
  transport: string;
  source: string;
  status: string;
  version: string | null;
  registered_by: string | null;
  updated_at: string;
  manifest: string;
}

/** The descriptor in the `manifest` column. */
interface Descriptor {
  name?: string;
  version?: string;
  language?: string;
  nodes?: string[];
  /** The announcing plugin process, when it sent one. */
  instance?: string;
  /** manifestHash() of what the writing main pulled. */
  hash?: string;
}

interface SyncState {
  /** Endpoints this process added from the table (so it forgets them when they leave it). */
  synced: Set<string>;
  /** The instance and manifest hash of each row this process last acted on (a change re-pulls the manifest). */
  seen: Map<string, string>;
  /** Set while this process forgets endpoints that left the table (their removal is not news for the table). */
  forgetting: boolean;
}

const states = new WeakMap<PluginRegistry, SyncState>();
function stateOf(registry: PluginRegistry): SyncState {
  let state = states.get(registry);
  if (!state) {
    state = { synced: new Set(), seen: new Map(), forgetting: false };
    states.set(registry, state);
  }
  return state;
}

/** Endpoints this registry added from the table (tests and troubleshooting). */
export const syncedEndpoints = (registry: PluginRegistry = processRegistry) => [...stateOf(registry).synced];

function parseDescriptor(text: string): Descriptor {
  try {
    return (JSON.parse(text) as Descriptor) ?? {};
  } catch {
    return {};
  }
}

const markerOf = (descriptor: Descriptor) => `${descriptor.instance ?? ''}|${descriptor.hash ?? ''}`;

function descriptor(plugin: PluginSummary, info: { instanceId?: string; manifestHash?: string } | undefined): string {
  return JSON.stringify({
    name: plugin.info.name,
    version: plugin.info.version,
    language: plugin.info.language,
    nodes: plugin.nodes.map((node) => node.name),
    ...(info?.instanceId && { instance: info.instanceId }),
    ...(info?.manifestHash && { hash: info.manifestHash }),
  } satisfies Descriptor);
}

export interface RegistrySyncOptions {
  registry?: PluginRegistry;
  db?: () => Database;
}

/** Mains: write the endpoints this registry knows (changed rows only); a plugin removed here leaves the table. */
export function persistRegistrations(instanceId: string, removedPluginId?: string, options: RegistrySyncOptions = {}) {
  const registry = options.registry ?? processRegistry;
  const db = (options.db ?? database)();
  const { synced, seen } = stateOf(registry);
  const rows = new Map(db.all<RegistrationRow>('SELECT * FROM plugin_registrations').map((row) => [row.endpoint, row]));
  const now = new Date().toISOString();
  db.transaction(() => {
    if (removedPluginId) {
      for (const row of rows.values()) if (row.plugin_id === removedPluginId) db.delete('plugin_registrations', { endpoint: row.endpoint });
    }
    for (const plugin of registry.list()) {
      if (plugin.source === 'builtin') continue;
      for (const endpoint of plugin.endpoints) {
        const info = registry.endpointInfo(endpoint.endpoint);
        if (info?.local) continue;
        const row = rows.get(endpoint.endpoint);
        const fromTable = synced.has(endpoint.endpoint);
        if (row && row.plugin_id === plugin.id && row.version === plugin.info.version) {
          // Another process's view of an endpoint added from the table isn't news; neither is an unchanged one of ours.
          if (fromTable) continue;
          const saved = parseDescriptor(row.manifest);
          if (row.status === endpoint.status && saved.instance === info?.instanceId && saved.hash === info?.manifestHash) continue;
        }
        const manifest = descriptor(plugin, info);
        db.upsert('plugin_registrations', {
          endpoint: endpoint.endpoint,
          plugin_id: plugin.id,
          transport: endpoint.transport,
          source: endpoint.source,
          status: endpoint.status,
          version: plugin.info.version,
          registered_by: instanceId,
          updated_at: now,
          manifest,
        });
        // What this process wrote is what it has: its own sync doesn't re-pull it.
        seen.set(endpoint.endpoint, markerOf(parseDescriptor(manifest)));
      }
    }
  });
}

/**
 * Every process: connect to the endpoints in the table this registry doesn't know, pull the manifest again of those
 * whose plugin restarted or changed (a new `instance` or `hash`), and forget those that left the table.
 */
export async function syncRegistrations(options: RegistrySyncOptions = {}): Promise<number> {
  const registry = options.registry ?? processRegistry;
  const state = stateOf(registry);
  const rows = (options.db ?? database)().all<RegistrationRow>('SELECT * FROM plugin_registrations');
  const known = new Set(registry.list().flatMap((plugin) => plugin.endpoints.map((endpoint) => endpoint.endpoint)));
  const listed = new Set(rows.map((row) => row.endpoint));
  let added = 0;
  await Promise.allSettled(
    rows.map(async (row) => {
      const saved = parseDescriptor(row.manifest);
      const marker = markerOf(saved);
      if (!known.has(row.endpoint)) {
        try {
          await registry.addEndpoint(row.endpoint, 'static');
          state.synced.add(row.endpoint);
          state.seen.set(row.endpoint, marker);
          added++;
        } catch (error) {
          logger.debug('cluster: plugin endpoint from the registry table not reachable', { 'landflow.plugin.endpoint': row.endpoint, error: (error as Error).message });
        }
        return;
      }
      const info = registry.endpointInfo(row.endpoint);
      // Announced to this process itself, or found by its own discovery: its registry follows the plugin directly.
      if (!info || (!state.synced.has(row.endpoint) && info.source !== 'static')) return;
      const last = state.seen.get(row.endpoint);
      state.seen.set(row.endpoint, marker);
      if (last === undefined || last === marker || (saved.hash && saved.hash === info.manifestHash && (saved.instance ?? '') === (info.instanceId ?? ''))) return;
      try {
        await registry.repull(row.endpoint, saved.instance);
        logger.info('cluster: plugin restarted or changed elsewhere; manifest pulled again', { 'landflow.plugin.id': row.plugin_id, 'landflow.plugin.endpoint': row.endpoint });
      } catch (error) {
        // Tried again at the next change or sync.
        state.seen.set(row.endpoint, last);
        logger.debug('cluster: could not pull a restarted plugin’s manifest', { 'landflow.plugin.endpoint': row.endpoint, error: (error as Error).message });
      }
    }),
  );
  state.forgetting = true;
  try {
    for (const endpoint of [...state.synced]) {
      if (listed.has(endpoint)) continue;
      state.synced.delete(endpoint);
      state.seen.delete(endpoint);
      registry.removeEndpoint(endpoint);
    }
  } finally {
    state.forgetting = false;
  }
  return added;
}

/** Mains: keep the table in step with this registry's events (debounced; heartbeats and scans don't count). */
export function persistOnRegistryEvents(instanceId: string, options: RegistrySyncOptions = {}): () => void {
  const state = stateOf(options.registry ?? processRegistry);
  let timer: NodeJS.Timeout | undefined;
  let removed: string | undefined;
  const flush = () => {
    timer = undefined;
    try {
      persistRegistrations(instanceId, removed, options);
    } catch (error) {
      logger.warn('cluster: could not save the plugin registrations', { error: (error as Error).message });
    }
    removed = undefined;
  };
  const stop = bus.subscribe((message) => {
    if (message.channel !== 'registry' || isRelayed(message) || state.forgetting) return;
    const { event } = message;
    if (event.type !== 'plugin.registered' && event.type !== 'plugin.updated' && event.type !== 'plugin.offline' && event.type !== 'plugin.removed') return;
    if (event.type === 'plugin.removed') {
      // Removed on purpose (not just offline): it leaves the table, and so the other processes' registries.
      if (removed && removed !== event.pluginId) flush();
      removed = event.pluginId;
    }
    timer ??= setTimeout(flush, 1_000);
    timer.unref?.();
  });
  flush();
  return () => {
    stop();
    if (timer) clearTimeout(timer);
  };
}
