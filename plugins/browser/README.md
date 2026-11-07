# Browser

Read a web page, act on it and take a screenshot, in a real browser, through Vercel's
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI (Apache-2.0). One node, **Browser**, usable as an agent tool.

```sh
npm i -g agent-browser && agent-browser install     # the CLI and its Chrome
pnpm plugin:browser                                 # HTTP :7112 (MCP at /mcp), gRPC :7212
pnpm --filter @landflow/plugin-browser test         # a fake CLI; no browser needed
```

## The node

| Operation | What it does | Output |
|---|---|---|
| **Read Page** | Opens the URL and takes an outline of the page | `url`, `title`, `snapshot` (text with refs such as `@e3`) |
| **Act on Page** | Opens the URL, runs **Steps** in order, then reads the page again | the same, and `stepsRun` |
| **Screenshot** | Opens the URL and saves a PNG (optionally the full page) | `url`, `title`, and the PNG in `item.binary` (field `data`) |

**Steps** is a JSON array, at most 50: `[{"action":"fill","target":"input[name=q]","text":"landflow"},{"action":"press","key":"Enter"},{"action":"wait","ms":1500}]`.
The actions are `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `scroll`, `wait`, `back` and `reload`.
`target` is a selector or a ref from a snapshot. A model's usual words are accepted (`selector` for `target`, `value` for `text`, `milliseconds` or `seconds` for `ms`); any other field is an error, so a typo is not silently dropped. Expressions such as `{{ $json.name }}` work inside the steps. Turn on **Interactive Elements Only** to get a short outline of what can be clicked
or filled, with refs. There is no `eval`, upload, download, cookie or network control.

The node declares its output (`outputSchema`), and Spotlight lists those fields when it builds a flow after this node: read `$json.snapshot`, `$json.title`, `$json.url`.

## Safety

Pages are untrusted, and a page can carry instructions meant for the model that reads it. So:

- **Allowed Domains is required.** The browser can reach only those sites, including everything a page loads; a call with no list is
  refused. `*.example.com` includes subdomains. The CLI refuses saved profiles and replayed login state with an allow-list, so the node
  never uses a signed-in browser.
- **The operator's ceiling.** `LANDFLOW_BROWSER_ALLOWED_DOMAINS` (comma separated) limits every node: a node's list must sit inside it
  (a wildcard needs a wildcard ceiling), and it is the list when the node names none.
- **Page text is fenced** in boundary markers (`--content-boundaries`) and cut at **Max Page Text** (20,000 characters by default), so
  an agent can tell the page from its own instructions. That helps but does not make a page safe: don't hand an agent that reads
  untrusted pages a tool that can do harm without approval.
- **No shell.** The CLI starts with one argument per word; nothing from a flow or a page becomes a command.
- Each call runs in its own isolated session, closed when the call ends, even after an error.

## Settings

| Variable | Effect |
|---|---|
| `LANDFLOW_BROWSER_ALLOWED_DOMAINS` | the ceiling above |
| `LANDFLOW_BROWSER_HEADED=1` | show the browser window for every call (a node's **Show the Browser Window** does it for one) |
| `LANDFLOW_AGENT_BROWSER_BIN` | the CLI's name or path, when it is not `agent-browser` on `PATH` |

Broker transports and the MCP face are set as in the other plugins ([transports.md](../../docs/transports.md)). Concurrency defaults
to 2 calls at once, since each call starts a Chrome.
