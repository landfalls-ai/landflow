/**
 * Attio — the CRM for Landflow flows, written with the TypeScript SDK: an app-webhook trigger and "changed since"
 * operations that output activity items (docs/protocol.md §16), record lookup with notes, workspace members, and note,
 * task and list-entry creation over the REST API (v2). There is no delete and no merge.
 *
 *   pnpm --filter @landflow/plugin-attio start
 *
 * Serves HTTP on :7117 (with the MCP face at /mcp) and gRPC on :7217, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md):
 * `LANDFLOW_TRANSPORTS=http,grpc,nats` with `LANDFLOW_NATS_URL=…` adds a NATS face, and so on.
 * `LANDFLOW_MAX_CONCURRENCY` overrides the concurrency limit. MCP follows the GitHub plugin: loopback needs no token,
 * any other host needs `LANDFLOW_MCP_TOKEN` (or `LANDFLOW_MCP=off`).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { attioApi, attioOAuth2Api } from './api';
import { Attio } from './nodes/attio';
import { AttioTrigger } from './nodes/attio-trigger';

export const plugin = definePlugin({
  info: {
    id: 'attio',
    name: 'Attio',
    version: '0.1.0',
    description: 'Attio CRM: a webhook trigger and changed-since operations that output activity items, records with notes, workspace members, and note, task and list-entry creation over the REST API',
    icon: 'file:attio.svg',
    color: '#4f5bd5',
    author: 'Landflow',
  },
  nodes: [AttioTrigger, Attio],
  credentialTypes: [attioApi, attioOAuth2Api],
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY overrides): Attio allows 100 reads and 25 writes per second. */
export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7117,
    grpc: 7217,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
