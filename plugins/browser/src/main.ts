/**
 * Browser: a Landflow plugin that drives Vercel's agent-browser CLI (https://github.com/vercel-labs/agent-browser).
 *
 *   pnpm --filter @landflow/plugin-browser start
 *
 * Serves HTTP on :7112 (MCP face at /mcp) and gRPC on :7212, then announces both to the host. Needs the CLI on PATH
 * (`npm i -g agent-browser && agent-browser install`).
 *
 * Environment: `LANDFLOW_BROWSER_ALLOWED_DOMAINS` is the operator's ceiling on sites (a node's own list must sit inside it,
 * and it is the list when the node names none); `LANDFLOW_BROWSER_HEADED=1` shows the window for every call;
 * `LANDFLOW_AGENT_BROWSER_BIN` names the CLI. Brokers and MCP settings are as in the other plugins (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Browser } from './nodes/browser';

export const plugin = definePlugin({
  info: {
    id: 'browser',
    name: 'Browser',
    version: '0.1.0',
    description: 'Read, act on and screenshot web pages in a real browser, on an allow-list of sites',
    icon: 'file:browser.svg',
    color: '#0f766e',
    author: 'Landflow',
  },
  nodes: [new Browser()],
  iconDir: new URL('../icons/', import.meta.url),
});

/** A browser is heavy (a Chrome per call), so only a few calls at once. */
export const DEFAULT_MAX_CONCURRENCY = 2;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7112,
    grpc: 7212,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
