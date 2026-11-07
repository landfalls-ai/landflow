/**
 * Web Search: a Landflow plugin that searches the web through SearXNG (self-hosted, the local default), the Brave
 * Search API or Tavily, and returns only title, url, snippet and source. It never opens a result page (the Browser
 * node does that). Result text is untrusted: a model must never take it as instructions.
 *
 *   pnpm --filter @landflow/plugin-web-search start
 *
 * Serves HTTP on :7113 (MCP face at /mcp) and gRPC on :7213, then announces both to the host.
 *
 * Environment: `LANDFLOW_SEARCH_SEARXNG_URL` is the SearXNG base URL (the SearXNG credential can override it);
 * `LANDFLOW_SEARCH_DENY_DOMAINS` is the operator's deny-list (comma separated, subdomains included), applied to the
 * site filter and to every result. Brokers and MCP settings are as in the other plugins (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { WebSearch, braveSearchApi, searxngApi, tavilyApi } from './nodes/web-search';

export const plugin = definePlugin({
  info: {
    id: 'web-search',
    name: 'Web Search',
    version: '0.1.0',
    description: 'Search the web (SearXNG, Brave Search, Tavily) and get titles, links and snippets back',
    icon: 'file:web-search.svg',
    color: '#2563eb',
    author: 'Landflow',
  },
  nodes: [new WebSearch()],
  credentialTypes: [searxngApi, braveSearchApi, tavilyApi],
  iconDir: new URL('../icons/', import.meta.url),
});

export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7113,
    grpc: 7213,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
