# Web Search

One node, **Web Search**, searches the web through SearXNG (self-hosted, the local default), the Brave Search API or Tavily
and returns one item per result with only `title`, `url`, `snippet` and `source` (the site). It is usable as an agent tool
(`query`, `maxResults`, `site`, `recency`) and never opens a result page: the Browser node does that. Part of the
[Landflow docs](README.md). The node reference and the SearXNG-on-OrbStack recipe are in the
[plugin's README](../plugins/web-search/README.md).

```sh
pnpm plugin:web-search     # HTTP :7113, gRPC :7213 (next to Browser on 7112 / 7212)
```

## Keys and safeguards

Keys live in saved credentials (`searxngApi`, `braveSearchApi`, `tavilyApi`), never in parameters. Safeguards:

- at most 20 results and a query of at most 400 characters;
- a per-run search limit (Options, default 20) and a timeout (default 15 s);
- provider errors and rate limits come back as readable node errors;
- snippets are cut to 300 characters, with markup and control characters removed;
- an operator deny-list.

Result text is untrusted: tell models to use it as information and never as instructions.

## Variables

| Variable | Meaning |
|---|---|
| `LANDFLOW_SEARCH_SEARXNG_URL` | SearXNG base URL for the Web Search plugin, used when the SearXNG credential names none |
| `LANDFLOW_SEARCH_DENY_DOMAINS` | comma-separated domains (subdomains included) the node refuses as `site` and drops from results |

## With agents

Add the node to an agent as a tool ([agents.md](agents.md)). It returns titles, links and snippets only, so pair it with the
[Browser](../plugins/browser/README.md) node to read a page. What it does not do is in
[limitations.md](limitations.md#debugging-chat-with-agents-browser-and-web-search-built-2026-11-07).
