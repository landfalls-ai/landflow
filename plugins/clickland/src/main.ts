/**
 * Clickland — observability for Landflow flows and agents: search logs and traces, services, metrics, log patterns,
 * alerts, notes, knowledge search and views over Clickland's API, a signed alert webhook trigger and a polling trigger.
 *
 *   pnpm --filter @landflow/plugin-clickland start
 *
 * Serves HTTP on :7119 (with the MCP face at /mcp) and gRPC on :7219, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { clicklandApi, ClicklandNode, COLOR } from './nodes/clickland';
import { ClicklandAlertTrigger } from './nodes/clickland-alert-trigger';
import { ClicklandTrigger } from './nodes/clickland-trigger';

export const plugin = definePlugin({
  info: {
    id: 'clickland',
    name: 'Clickland',
    version: '0.1.0',
    description: 'Clickland observability: search logs and traces, services, metrics, log patterns, alerts, notes, knowledge search and views, an alert webhook trigger and a polling trigger; reachable over HTTP, gRPC, any installed broker and MCP',
    icon: 'file:clickland.svg',
    color: COLOR,
    author: 'Landflow',
  },
  nodes: [ClicklandNode, ClicklandAlertTrigger, ClicklandTrigger],
  credentialTypes: [clicklandApi],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

/** Clickland's queries run on ClickHouse: a handful at a time per plugin process. */
export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7119,
    grpc: 7219,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
