/**
 * Queue mode: one plugin list for the whole cluster. Plugins announce to (or are found by) a main; the mains write
 * what their registries know to `plugin_registrations` (migration 700: the endpoint, transport, status and the
 * plugin's descriptor in short), and every process (workers too) connects to the endpoints listed there itself, so a
 * worker runs a plugin's nodes over its own connection. Endpoints must be reachable from the workers (service names,
 * not 127.0.0.1); the health probes of each process's registry decide what is online there.
 */
import type { PluginSummary } from '../../shared/types';
import { bus, isRelayed } from '../bus';
import { database } from '../db';
import { registry } from '../plugins/registry';
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

/** Endpoints this process added from the table (so it forgets them when they leave it). */
const synced = new Set<string>();
/** Set while this process forgets endpoints that left the table (their removal is not news for the table). */
let forgetting = false;

const descriptor = (plugin: PluginSummary) =>
  JSON.stringify({ name: plugin.info.name, version: plugin.info.version, language: plugin.info.language, nodes: plugin.nodes.map((node) => node.name) });

/** Mains: write the endpoints this registry knows (changed rows only); a plugin removed here leaves the table. */
export function persistRegistrations(instanceId: string, removedPluginId?: string) {
  const db = database();
  const rows = new Map(db.all<RegistrationRow>('SELECT * FROM plugin_registrations').map((row) => [row.endpoint, row]));
  const now = new Date().toISOString();
  db.transaction(() => {
    if (removedPluginId) {
      for (const row of rows.values()) if (row.plugin_id === removedPluginId) db.delete('plugin_registrations', { endpoint: row.endpoint });
    }
    for (const plugin of registry.list()) {
      if (plugin.source === 'builtin') continue;
      for (const endpoint of plugin.endpoints) {
        const row = rows.get(endpoint.endpoint);
        // Another process's view of an endpoint added from the table isn't news.
        if (row && row.plugin_id === plugin.id && row.version === plugin.info.version && (row.status === endpoint.status || synced.has(endpoint.endpoint))) continue;
        db.upsert('plugin_registrations', {
          endpoint: endpoint.endpoint,
          plugin_id: plugin.id,
          transport: endpoint.transport,
          source: endpoint.source,
          status: endpoint.status,
          version: plugin.info.version,
          registered_by: instanceId,
          updated_at: now,
          manifest: descriptor(plugin),
        });
      }
    }
  });
}

/** Every process: connect to the endpoints in the table this registry doesn't know, forget those that left it. */
export async function syncRegistrations(): Promise<number> {
  const rows = database().all<RegistrationRow>('SELECT * FROM plugin_registrations');
  const known = new Set(registry.list().flatMap((plugin) => plugin.endpoints.map((endpoint) => endpoint.endpoint)));
  const listed = new Set(rows.map((row) => row.endpoint));
  let added = 0;
  await Promise.allSettled(
    rows
      .filter((row) => !known.has(row.endpoint))
      .map(async (row) => {
        try {
          await registry.addEndpoint(row.endpoint, 'static');
          synced.add(row.endpoint);
          added++;
        } catch (error) {
          logger.debug('cluster: plugin endpoint from the registry table not reachable', { 'landflow.plugin.endpoint': row.endpoint, error: (error as Error).message });
        }
      }),
  );
  forgetting = true;
  try {
    for (const endpoint of [...synced]) {
      if (listed.has(endpoint)) continue;
      synced.delete(endpoint);
      registry.removeEndpoint(endpoint);
    }
  } finally {
    forgetting = false;
  }
  return added;
}

/** Mains: keep the table in step with this registry's events (debounced; heartbeats and scans don't count). */
export function persistOnRegistryEvents(instanceId: string): () => void {
  let timer: NodeJS.Timeout | undefined;
  let removed: string | undefined;
  const flush = () => {
    timer = undefined;
    try {
      persistRegistrations(instanceId, removed);
    } catch (error) {
      logger.warn('cluster: could not save the plugin registrations', { error: (error as Error).message });
    }
    removed = undefined;
  };
  const stop = bus.subscribe((message) => {
    if (message.channel !== 'registry' || isRelayed(message) || forgetting) return;
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
