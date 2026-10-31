/**
 * Grafana Alertmanager plugin for Landflow.
 *
 * Serves HTTP on :7120 (with the MCP face at /mcp) and gRPC on :7220, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md):
 * `LANDFLOW_TRANSPORTS=http,grpc,nats` with `LANDFLOW_NATS_URL=…` adds a NATS face, and so on for every kind in
 * @landflow/transports. `LANDFLOW_MAX_CONCURRENCY` overrides the concurrency limit.
 *
 * MCP: on by default. In dev everything binds to loopback (`LANDFLOW_HOST`, default 127.0.0.1, or 0.0.0.0 when
 * `LANDFLOW_ADVERTISE_HOST` is set as in a container), where the face needs no token; on any other host set
 * `LANDFLOW_MCP_TOKEN` (or `LANDFLOW_MCP=off`).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { GetAlerts } from './nodes/get-alerts';
import { GetAlertDetails } from './nodes/get-alert-details';
import { AcknowledgeAlert } from './nodes/acknowledge-alert';

export const plugin = definePlugin({
  info: {
    id: 'grafana',
    name: 'Grafana Alertmanager',
    version: '0.1.0',
    description: 'Interact with Grafana Alertmanager API',
    icon: 'file:grafana.svg',
    color: '#f43f5e',
    author: 'Landflow Developer',
  },
  nodes: [new GetAlerts(), new GetAlertDetails(), new AcknowledgeAlert()],
  // `file:` icons (plugin and nodes) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY overrides): the nodes are HTTP-bound requests, so about one core's worth. */
export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7120,
    grpc: 7220,
    // Loopback in dev, so the MCP face runs without a token; in a container (LANDFLOW_ADVERTISE_HOST set) every face
    // listens on 0.0.0.0 and the MCP face needs LANDFLOW_MCP_TOKEN. LANDFLOW_HOST overrides either way.
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}