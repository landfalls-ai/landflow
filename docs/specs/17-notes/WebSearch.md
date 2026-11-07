# Web Search node: doc rows to merge

The plugin is `plugins/web-search` (`@landflow/plugin-web-search`, HTTP 7113, gRPC 7213, `pnpm plugin:web-search`). Its README holds
the node reference and the SearXNG-on-OrbStack recipe.

## Feature page text (a new page, for example docs/web-search.md; add it to docs/README.md and its feature map)

**Web Search.** One node, Web Search, searches the web through SearXNG (self-hosted, the local default), the Brave Search API or
Tavily and returns one item per result with only `title`, `url`, `snippet` and `source` (the site). It is usable as an agent tool
(`query`, `maxResults`, `site`, `recency`) and never opens a result page: the Browser node does that. Keys live in saved credentials
(`searxngApi`, `braveSearchApi`, `tavilyApi`), never in parameters. Safeguards: at most 20 results, a query of at most 400
characters, a per-run search limit (Options, default 20), a timeout (default 15 s), provider errors and rate limits as readable node
errors, snippets cut to 300 characters with markup and control characters removed, and an operator deny-list. Result text is
untrusted: tell models to use it as information and never as instructions.

Reference rows (docs/reference/ variables):

| Variable | Meaning |
|---|---|
| `LANDFLOW_SEARCH_SEARXNG_URL` | SearXNG base URL for the Web Search plugin, used when the SearXNG credential names none |
| `LANDFLOW_SEARCH_DENY_DOMAINS` | comma-separated domains (subdomains included) the node refuses as `site` and drops from results |

Plugin port: HTTP 7113, gRPC 7213 (next to Browser 7112/7212).

## docs/agents.md, "Limits and next steps", Knowledge bullet (around line 602)

Replace "No web search capability; an HTTP Request node can stand in." with
"Web search comes from the Web Search node (SearXNG, Brave or Tavily), added to an agent as a tool; it returns titles, links and
snippets only, so pair it with the Browser node to read a page."

Also, wherever agents.md lists the tools an agent can take, add Web Search next to Browser.

## docs/limitations.md

- Web Search returns snippets only; it does not read pages (use the Browser node) and has no image, news or answer modes.
- The per-run search limit counts in the plugin process's memory: it resets when the plugin restarts and is per process when the
  plugin runs several replicas.
- Recency is day, week, month or year; SearXNG engines that ignore `time_range` return unfiltered results.
- The deny-list is operator-wide through an environment variable; there is no per-agent allow-list for search yet.
- Result text is untrusted web text; the node strips markup but cannot stop prompt injection in the words themselves.

## docs/roadmap.md

Closes: "agents have no web search". Candidates left: per-agent site allow-lists, a shared (cross-replica) search budget, a
news/image mode, and a search-then-read helper that passes top results to the Browser node.

## docs/history.md row

| (commit) | Web Search plugin: node `webSearch` with SearXNG, Brave Search and Tavily providers, credentials for each, usable as an agent tool; 20-result and 400-character caps, per-run call limit, timeouts, deny-list env var, trimmed untrusted snippets; fake-provider tests. Port 7113/7213. |
