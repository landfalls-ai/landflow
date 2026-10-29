/**
 * Landfall — incident response for Landflow: open, attach and recover Landfall incidents from alerts, read rooms,
 * add timeline events and notes, record fixes applied outside Landfall, heartbeats, and a polling Landfall Trigger.
 *
 *   pnpm --filter @landflow/plugin-landfall start
 *
 * Serves HTTP on :7108 (with the MCP face at /mcp) and gRPC on :7208, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md).
 *
 * Source face: with `LANDFALL_SOURCE_PORT` set the process also answers Landfall's Source Protocol probes
 * (GET /v1/health and /v1/capabilities) on that port, which a Landfall remote-source connection needs to pass its health
 * check before it accepts triggers. `LANDFALL_SOURCE_TOKEN` (off by default) makes it require that bearer token and
 * `LANDFALL_SOURCE_HOST` picks the interface (loopback, or 0.0.0.0 when `LANDFLOW_ADVERTISE_HOST` is set).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Landfall, landfallApi, landfallHeartbeatApi } from './nodes/landfall';
import { LandfallTrigger } from './nodes/landfall-trigger';
import { startSourceFaceFromEnv } from './source';

export const plugin = definePlugin({
  info: {
    id: 'landfall',
    name: 'Landfall',
    version: '0.1.0',
    description: 'Landfall incident response: open, attach and recover incidents from alerts, read rooms, add events and notes, record fixes applied outside Landfall, heartbeats and a trigger; reachable over HTTP, gRPC, any installed broker and MCP',
    icon: 'file:landfall.svg',
    color: '#3B5B7A',
    author: 'Landflow',
  },
  nodes: [Landfall, LandfallTrigger],
  credentialTypes: [landfallApi, landfallHeartbeatApi],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

export const DEFAULT_MAX_CONCURRENCY = 16;

if (import.meta.url === `file://${process.argv[1]}`) {
  const face = await startSourceFaceFromEnv();
  if (face) console.info(`landfall source face on :${face.port} (GET /v1/health, /v1/capabilities)`);
  await serve(plugin, {
    http: 7108,
    grpc: 7208,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
