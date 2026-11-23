/**
 * Linear — a webhook trigger that registers its own Linear webhook, changed-since reads as activity items (issues,
 * comments, project updates), an issue read with its comments, a user list with email, and create issue / comment /
 * add link actions, over Linear's GraphQL API, written with the TypeScript SDK. Nothing deletes, archives or closes.
 *
 *   pnpm --filter @landflow/plugin-linear start
 *
 * Serves HTTP on :7116 and gRPC on :7216, then announces both endpoints to the Landflow host (LANDFLOW_REGISTRY_URL,
 * default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md). `LANDFLOW_MAX_CONCURRENCY`
 * overrides the concurrency limit.
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Linear, linearApi, linearOAuth2Api } from './nodes/linear';
import { LinearTrigger } from './nodes/linear-trigger';

export const plugin = definePlugin({
  info: {
    id: 'linear',
    name: 'Linear',
    version: '0.1.0',
    description: 'Linear issues, comments and project updates as activity items (webhook trigger and changed-since reads), users with email, and create-issue, comment and add-link actions over the GraphQL API',
    icon: 'file:linear.svg',
    color: '#5E6AD2',
    author: 'Landflow',
  },
  nodes: [Linear, LinearTrigger],
  credentialTypes: [linearApi, linearOAuth2Api],
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once: they wait on Linear, whose limits are per hour, so a few at a time. */
export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7116,
    grpc: 7216,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
