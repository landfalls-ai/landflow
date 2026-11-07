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
| **Act on Page** | Opens the URL, runs **Steps** in order, then reads the page again | the same, plus `stepsRun`, `steps` (one `{ action, target, ok, ms }` per step) and `results` (what Extract steps read); with **Screenshot After Steps**, a PNG in `item.binary` |
| **Screenshot** | Opens the URL and saves a PNG (optionally the full page) | `url`, `title`, and the PNG in `item.binary` (field `data`) |

**Steps** are built in the editor as a list (**Add Step**: an action, a target and some text), with a **Steps (JSON)** box beside it
for models and copy-paste. The list runs first, then the JSON; together at most 50. Both can be used, and an old node with only JSON works unchanged.
What **Text** means depends on the action: what to type (`fill`, `type`), the option (`select`), the key (`press`), the milliseconds (`wait`),
the direction (`scroll`), and for Extract the name the value is stored under.

JSON form: `[{"action":"fill","target":"input[name=q]","text":"landflow"},{"action":"press","key":"Enter"},{"action":"wait","ms":1500}]`.
The actions are `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `scroll`, `wait`, `back`, `reload`, and the Extract actions below.
`target` is a selector or a ref from a snapshot. A model's usual words are accepted (`selector` for `target`, `value` for `text`, `milliseconds` or `seconds` for `ms`); any other field is an error, so a typo is not silently dropped. Expressions such as `{{ $json.name }}` work inside the steps. Turn on **Interactive Elements Only** to get a short outline of what can be clicked
or filled, with refs. There is no `eval`, upload, download, cookie or network control.

### Extract: read a field, not the snapshot

`getText`, `getValue` and `getAttr` read one element and store the value under a name, so the next node reads `{{ $json.results.confirmation }}`
instead of parsing the outline. In the list, **Extract Text** and **Extract Value** take the name in Text; **Extract Attribute** takes `name:attribute`
(`link:href`). In JSON: `{"action":"getText","target":"#confirmation","name":"confirmation"}`, and `getAttr` also takes `"attr":"href"`.
A step with no name is stored as `result<n>` (its position); two steps with one name are an error. Names are letters, digits, `_` and `-`.

**Extracted text is untrusted.** It is what the page says, and the page may carry instructions for the model that reads it. The browser
still runs with content boundaries and the allow-list, and the snapshot stays fenced. For `results` the fence is removed from `getText` values
(it carries a random nonce the page cannot know), because a flow needs the bare value: if you pass `results` to an agent, treat it as page
content, don't let it choose what to do, and don't give that agent a tool that can do harm without approval.

### Which step failed

Each step reports `{ action, target, ok, ms }` in `steps`. A failure stops the node with the step named, for example
`Step 4 of 4 (click #send) failed`, the browser's reason, and how many steps before it ran. Malformed steps (an unknown action, a missing target) are refused before the browser moves.

### Screenshot after the steps

Turn on **Screenshot After Steps** (Act on Page) for a PNG of the page once the steps have run, in `item.binary` under **Binary Field**
(`data`). The editor's output panel previews it in its Binary tab.

The node declares its output (`outputSchema`), and Spotlight lists those fields when it builds a flow after this node: read `$json.snapshot`, `$json.title`, `$json.url`, `$json.results.<name>` and `$json.steps`.

## Safety

Pages are untrusted, and a page can carry instructions meant for the model that reads it. So:

- **Allowed Domains defaults to the URL's own site.** The browser can reach only the listed sites, including everything a page loads, so
  with the list empty a page's images and scripts from other sites, and links to them, are blocked (the node shows a notice saying so). List more sites
  to allow them. `*.example.com` includes subdomains. With no list and no URL host, the call is refused. The CLI refuses saved profiles and replayed login state with an allow-list, so the node
  never uses a signed-in browser.
- **The operator's ceiling.** `LANDFLOW_BROWSER_ALLOWED_DOMAINS` (comma separated) limits every node: a node's list must sit inside it
  (a wildcard needs a wildcard ceiling), and it is the list when the node names none and the URL's host is outside it.
- **Page text is fenced** in boundary markers (`--content-boundaries`) and cut at **Max Page Text** (20,000 characters by default), so
  an agent can tell the page from its own instructions. That helps but does not make a page safe: don't hand an agent that reads
  untrusted pages a tool that can do harm without approval.
- **No shell.** The CLI starts with one argument per word; nothing from a flow or a page becomes a command.
- Each call runs in its own isolated session, closed when the call ends, even after an error.

## Settings

| Variable | Effect |
|---|---|
| `LANDFLOW_BROWSER_ALLOWED_DOMAINS` | the ceiling above |
| `LANDFLOW_BROWSER_HEADED=1` | show the browser window for every call (a node's **Show the Browser Window**, beside Allowed Domains, does it for one) |
| `LANDFLOW_AGENT_BROWSER_BIN` | the CLI's name or path, when it is not `agent-browser` on `PATH` |

Broker transports and the MCP face are set as in the other plugins ([transports.md](../../docs/transports.md)). Concurrency defaults
to 2 calls at once, since each call starts a Chrome.

As an agent tool, the screenshot reaches a vision model as an image (the AI Agent node passes `item.binary` images to the model; see docs/features/ai.md).
