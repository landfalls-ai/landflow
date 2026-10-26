/**
 * What the API shows of the transport layer (GET /api/transports, Settings → Transports): the kinds and the
 * connections, each connection with the plugins whose endpoints name it (`<kind>://<connectionId>/<pluginId>`, which
 * the registry learns from broker discovery).
 */
import type { TransportConnectionView, TransportsResponse } from '../../shared/transports';
import { registry } from '../plugins/registry';
import { brokerConnections } from './brokers';
import { transportConnections, viewOf, type StoredConnection } from './connections';
import { brokeredEndpoint, transportProviders } from './provider';

/** Plugin ids by connection id, from the registry's brokered endpoints. */
export function pluginsByConnection(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const plugin of registry.list()) {
    for (const endpoint of plugin.endpoints) {
      const brokered = safeBrokered(endpoint.endpoint);
      if (!brokered) continue;
      const list = out.get(brokered.connectionId) ?? [];
      if (!list.includes(plugin.id)) list.push(plugin.id);
      out.set(brokered.connectionId, list);
    }
  }
  return out;
}

function safeBrokered(endpoint: string) {
  try {
    return brokeredEndpoint(endpoint);
  } catch {
    return undefined;
  }
}

/** The connection with the plugins on it and the live state of this host's client for it (brokers.ts). */
export function connectionView(connection: StoredConnection, plugins = pluginsByConnection()): TransportConnectionView {
  const health = brokerConnections.health(connection.id);
  return { ...viewOf(connection, plugins.get(connection.id) ?? []), ...(health && { health }) };
}

export function transportsView(): TransportsResponse {
  const plugins = pluginsByConnection();
  return { kinds: transportProviders.kinds(), connections: transportConnections.list().map((connection) => connectionView(connection, plugins)), claimStore: brokerConnections.claimStoreInfo() };
}
