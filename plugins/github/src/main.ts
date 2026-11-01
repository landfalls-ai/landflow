/**
 * GitHub — deterministic GitHub steps for flows (read and write files, commit several files at once, branches, pull
 * requests, issues and comments) over the REST API, written with the TypeScript SDK. Agents get GitHub through
 * GitHub's own MCP server; this node is for the fixed steps a flow does itself. There is no merge and no delete.
 *
 *   pnpm --filter @landflow/plugin-github start
 *
 * Serves HTTP on :7111 (with the MCP face at /mcp) and gRPC on :7211, then announces both endpoints to the Landflow
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
import { GitHub, githubApi } from './nodes/github';

export const plugin = definePlugin({
  info: {
    id: 'github',
    name: 'GitHub',
    version: '0.1.0',
    description: 'Files, one-commit multi-file changes, branches, draft pull requests, issues and comments over the GitHub REST API; reachable over HTTP, gRPC, any installed broker and MCP',
    icon: 'file:github.svg',
    color: '#24292f',
    author: 'Landflow',
  },
  nodes: [GitHub],
  credentialTypes: [githubApi],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY overrides): the calls wait on GitHub, whose secondary rate limit dislikes bursts, so a few at a time. */
export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7111,
    grpc: 7211,
    // Loopback in dev, so the MCP face runs without a token; in a container (LANDFLOW_ADVERTISE_HOST set) every face
    // listens on 0.0.0.0 and the MCP face needs LANDFLOW_MCP_TOKEN. LANDFLOW_HOST overrides either way.
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
