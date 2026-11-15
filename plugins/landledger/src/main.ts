/**
 * Landledger, the land family's cost ledger, for Landflow flows and agents: check a budget, query spend and the cost of
 * a window, find a contract's seats, raise and read spend requests, release seats, reserve and release budget, read a
 * month's status and frozen snapshot, draft variance notes (with a notes:draft key), relay a person's signed Slack press
 * (flows only), and a signed webhook trigger for requests, seats, budgets, periods, the close and notes.
 *
 *   pnpm --filter @landflow/plugin-landledger start
 *
 * Serves HTTP on :7120 (with the MCP face at /mcp) and gRPC on :7220, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { COLOR, landledgerApi, LandledgerNode, landledgerNotesKey, landledgerRelayApi } from './nodes/landledger';
import { LandledgerTrigger } from './nodes/landledger-trigger';

export const plugin = definePlugin({
  info: {
    id: 'landledger',
    name: 'Landledger',
    version: '0.1.0',
    description:
      'Landledger cost ledger: budgets, spend and the cost of a window, contracts\' seats, requests, reservations, periods, the close\'s frozen snapshot and variance note drafts, a person\'s signed Slack press relayed for Landledger to verify, and a webhook trigger for requests, confirmations, decisions, seats, budgets, periods, the close, notes and reports; reachable over HTTP, gRPC, any installed broker and MCP',
    icon: 'file:landledger.svg',
    color: COLOR,
    author: 'Landflow',
  },
  nodes: [LandledgerNode, LandledgerTrigger],
  credentialTypes: [landledgerApi, landledgerRelayApi, landledgerNotesKey],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7120,
    grpc: 7220,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
