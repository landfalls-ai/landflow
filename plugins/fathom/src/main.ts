/**
 * Fathom — meeting notes for flows (new-meeting webhook trigger, meetings as activity items, summaries, transcripts
 * on request, teams and users) over Fathom's REST API, written with the TypeScript SDK.
 *
 *   pnpm --filter @landflow/plugin-fathom start
 *
 * Serves HTTP on :7118 and gRPC on :7218, then announces both endpoints to the Landflow host (LANDFLOW_REGISTRY_URL,
 * default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Fathom, fathomApi } from './nodes/fathom';
import { FathomTrigger } from './nodes/fathom-trigger';

export const plugin = definePlugin({
  info: {
    id: 'fathom',
    name: 'Fathom',
    version: '0.1.0',
    description: 'Fathom meetings as activity items: a new-meeting webhook trigger, meetings since a time, summaries, action items and opt-in transcripts, teams and users',
    icon: 'file:fathom.svg',
    color: '#00b386',
    author: 'Landflow',
  },
  nodes: [Fathom, FathomTrigger],
  credentialTypes: [fathomApi],
  iconDir: new URL('../icons/', import.meta.url),
});

/** Fathom allows 60 calls a minute (30 for summaries and transcripts), so a few at a time. */
export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7118,
    grpc: 7218,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
