# Marketplace

The Marketplace page installs plugins from Claude Code
[plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), such as
Anthropic's official one. Landflow turns each plugin's Claude Code **agents** into Landflow
[agents](agents.md) and its **skills** into a skill library. A plugin can also be a
**Landflow node plugin**: the host downloads it, runs it and supervises the process, and it
announces itself to the registry like any other plugin. And it can ship **flows**: workflow
templates that installing adds to Templates, each with a read-only [share page](#share-pages).

| A plugin contains | In Landflow |
|---|---|
| `agents/*.md` (frontmatter `name`, `description`, `model`, `tools`, `color`; the body is the system prompt) | one agent per file (draft, unpublished), with all of the plugin's skills attached |
| `skills/<name>/SKILL.md` (+ `references/`) | a library skill (`GET /api/skills`), and a skill on each agent from the same plugin |
| `landflow.plugin.json`, or a `landflow` field in the marketplace entry | a node plugin the host runs (see below) |
| `flows/*.json`, plus the files or folders a `flows` list names | a template per flow, for the whole instance ([Flows](#flows)) |
| `commands/`, `hooks/`, `.mcp.json`, `.lsp.json`, `output-styles/`, `bin/`, `monitors/`, `workflows/` | listed as **not supported yet** in the detail drawer and the install result; never installed silently |

## Using it

**Marketplace** in the sidebar has three tabs.

- **Explore.** Everything in one place: the plugins of every added marketplace, the flows of its Landflow plugins,
  the registry's own plugins and the Templates library. One search covers names, descriptions, authors, keywords and
  node types. The kind switch has five views:
  - **All**: a section per kind, each with its first 8 and **Show all**.
  - **Node plugins**: entries with a `landflow` field or a `landflow.plugin.json`. Once installed, a tile shows the
    registry's icon, status and node count. The registry's own plugins that no marketplace installed show as
    **This instance**, and open their card on the Plugins page.
  - **Workflows**: marketplace flows (opening the share page) and built-in and saved templates. A flow already
    installed is shown once, as its flow.
  - **Composites**: the [composite types](composites.md) this instance knows: the plugins' (they come with the plugin)
    and the ones saved here, which whoever saved them, or an owner or admin, can delete from their tile.
  - **Agents & skills**: the other Claude Code plugins, with their agent and skill counts once read.

  The source chips narrow it to one marketplace, which shows its card with **Refresh** and **Remove**, or to
  **This instance**. Category chips use readable names (`incident-response` reads *Incident response*). Explore
  reads every plugin of a marketplace with at most 25 entries (`EXPLORE_READ_ALL`). In a larger one it reads only the
  Landflow plugins and the entries that list flows. A marketplace or plugin that can't be read is named in a notice,
  and the rest still shows. **Anthropic official** (`anthropics/claude-plugins-official`) is built in and is fetched
  the first time Explore opens, never at startup.

  **Add marketplace** takes:
  - `owner/repo`, `owner/repo@ref` or `owner/repo#ref`;
  - a `github.com` URL, including `/tree/<ref>`;
  - a direct `marketplace.json` URL.

  It also has preset chips: Anthropic official, and Anthropic Agent Skills (`anthropics/skills`).
  A marketplace is fetched before it is saved, so one that can't be read isn't added.
  Clicking a marketplace plugin opens the detail drawer:
  - badges: Agents N, Skills N, Node plugin, Unsupported: …;
  - the agents with their model and the Claude Code tools that don't map;
  - the skills with their reference counts;
  - the flows, each with its node icons, **View** (its share page) and a copy-link button;
  - unsupported components, notes, the README;
  - **Install**.
- **Installed.** What each install created: links to its agents, its skills, its flows' templates,
  and for node plugins the process state, port, restarts, **Logs** and **Restart**. **Uninstall** asks first,
  then deletes exactly what the install created. That includes agents you edited since; other
  agents are never touched.
- **Skill library.** Every installed skill with its *when to use* line, references and full
  instructions.

## How a plugin maps to an agent

| Claude Code | Landflow agent |
|---|---|
| `name: code-explorer` | name *Code Explorer* |
| `description` | description; `<example>` blocks are stripped, and the text is capped at 600 characters. Notes are added: where the agent came from, and which Claude Code tools didn't map |
| body | instructions |
| `model: sonnet` / `opus` / `haiku` / `inherit` | Anthropic `claude-sonnet-5-5` / `claude-opus-5-5` / `claude-haiku-5-5` / `claude-sonnet-5-5`. A full `claude-…` id is kept. Anything else leaves the model unset |
| `color: yellow` | the agent colour (hex); the icon is picked from the name, then from the description |
| `tools: Glob, Grep, Read…` | not mapped, because Claude Code's built-in tools have no Landflow equivalent. They are listed in the description so you can add node, workflow or sub-agent tools under **Capabilities** |
| skills of the same plugin | `AgentSkill`s: `whenToUse` = description, `instructions` = body, `references` = text files under `references/` (at most 30 files, 128 KB each, 1 MB in total) |

Other files in a skill folder (scripts, assets, examples) aren't used. The drawer says how many
there are.

## Flows

A flow is a Landflow template file: the JSON a template's **Export** downloads and
`POST /api/templates` `{ data }` imports (see the templates library in [the editor](features/editor.md)). A plugin ships
them in `flows/*.json`; a `flows` array in `plugin.json` or in the marketplace entry adds other
files or folders. A plugin at the marketplace root (`"source": "./"`) reads only the listed ones.
At most 50 files are read, 1 MB each; a file that isn't a valid template is a warning in the
drawer, not an error.

- **Detail.** Each flow lists its name, description, categories, node types and credential
  types, and `needs`: the node types its own plugin doesn't provide and this instance doesn't
  have, so you know which other plugins to install first.
- **Install** imports each flow as a template with an `origin` (the installed plugin, the
  marketplace and the file). Templates from a marketplace show the plugin on their card and link
  back to the share page. They belong to the whole instance, not a project.
- **Uninstall** deletes those templates. Workflows already made from them stay; they are yours.

## Share pages

`/marketplace/flows/<marketplace>/<plugin>/<path>` shows one flow without installing it:

- the canvas, read only: click a node for its notes and parameters, nothing runs or tests;
- the description, setup steps, credentials and data tables, as the template page shows them;
- what else it needs ("Also needs nodes from …") and anything this instance blocks;
- the plugin's other flows.

**Install plugin** opens the plugin's drawer, with the usual confirmation for a node plugin.
Once installed, **Open template** goes to the template, where **Use template** creates the
workflow. **Copy share link** copies the page's URL.

The link carries `?source=` (`owner/repo[@ref]` or the marketplace URL; nothing for a local one).
On an instance that hasn't added that marketplace, the page says so, and owners and admins get
**Add <source>**, which only adds it: nothing is installed until they choose. `<marketplace>`
may be the marketplace's id or its name, so a link works on any instance that added the same
marketplace. The page needs a signed-in member (`workflows:read`); it isn't public.

## Marketplace format support

What Landflow reads, checked against the official repos (`anthropics/claude-plugins-official`
with 315 plugins, and `anthropics/skills`) and the Claude Code plugin and marketplace references:

- `.claude-plugin/marketplace.json`: `name`, `description` or `metadata.description`,
  `owner.name`, `metadata.pluginRoot`, and `plugins[]`. Each entry has `name`, `source`,
  `description`, `version`, `category`, `author`, `homepage`, `keywords`/`tags`, `displayName`,
  and the component keys.
- Plugin sources:

  | Source | Supported |
  |---|---|
  | `"./path"` (relative to the marketplace root; `..` refused), or a bare name under `metadata.pluginRoot` | ✓ (GitHub or local marketplaces; not URL marketplaces, which have no files) |
  | `{ "source": "github", "repo": "owner/repo", "ref"?, "sha"? }` | ✓ |
  | `{ "source": "url", "url": "https://github.com/o/r.git", "sha"? }` | ✓ for GitHub; other hosts are unsupported |
  | `{ "source": "git-subdir", "url", "path", "ref"?, "sha"? }` | ✓ for GitHub (`url` may be `owner/repo`) |
  | `npm`, `archive`, `command`, others | shown as *Unsupported source* |

  A `sha` pins the install to that commit. Otherwise `ref`, or the default branch (`HEAD`), is used.
- Manifest rules:
  - `.claude-plugin/plugin.json` is optional. Without it, the entry is the manifest.
  - A manifest `agents` list replaces the default `agents/` scan.
  - `skills` adds to `skills/`, except for an entry whose source is the marketplace root and
    lists `skills`: then only the listed folders load. This is how `anthropics/skills` packages
    its skills.
  - A lone `SKILL.md` at the plugin root is a single skill.
- The YAML frontmatter parser is built in. It handles the subset these files use: scalars, quoted
  strings, `|` and `>` blocks, flow and block lists, and one level of nested maps. Tool lists
  like `Bash(git add:*), Read` keep their parentheses.

## Landflow node plugins

A plugin directory with a `landflow.plugin.json`, or a marketplace entry with a `landflow` field
of the same shape, is a node plugin:

```json
{
  "id": "acme-nodes",
  "runtime": "node",
  "install": ["npm", "install", "--omit=dev"],
  "start": ["tsx", "src/main.ts"],
  "transports": ["http"],
  "env": { "ACME_REGION": "eu" }
}
```

| Field | |
|---|---|
| `id` | the plugin id it announces (`definePlugin({ info: { id } })`), lowercase with dashes |
| `runtime` | `node` (default), `python`, `go` or `binary` |
| `install` | optional argv run once in the plugin directory after download |
| `start` | argv that serves the plugin. `node` runs the host's Node; `tsx` uses the plugin's own or the host's |
| `transports` | `http` (default) and/or `grpc`; the host picks the ports |
| `env` | extra, non-secret environment variables (`UPPER_CASE` names only) |

What installing does:

1. **Asks.** Without `confirm: true` the API answers `409` with the repository, the install
   command and the start command. The drawer shows them in a warning ("This runs code on this
   machine") with an **I trust it — install and run** button.
2. **Downloads** the plugin's files to `<data dir>/marketplace/plugins/<name>`:
   - at most 500 files, 25 MB in total, 10 MB per file;
   - `node_modules`, `.git` and `.venv` are skipped;
   - every path is checked to stay inside the directory.
3. **Links the SDK** (`runtime: "node"`). `@landflow/sdk` and `@landflow/protocol` aren't on
   npm, so their dependencies are rewritten to `file:` links to the host's `packages/`, and
   symlinked into `node_modules`. If the plugin has other dependencies and no `install`, the
   host runs `npm install --omit=dev --no-audit --no-fund --ignore-scripts`. The timeout is
   5 minutes. For `runtime: "go"`, `replace` directives in `go.mod` that point
   `github.com/landflow/landflow/sdks/go` (and its transport modules) at a relative path are
   pointed at the host's `sdks/go`, so a plugin from this repository builds with its `install`
   (`go build`).
4. **Runs** `start` as a child process of the host:
   - `cwd` is the plugin directory;
   - `LANDFLOW_HTTP_PORT` gets a free port in 7250–7299, inside the default scan range
     (`LANDFLOW_MARKETPLACE_PORTS=7300-7349` for another range, e.g. several processes on one host);
   - `LANDFLOW_GRPC_PORT` gets a second port or `off`;
   - `LANDFLOW_REGISTRY_URL` is the host. Set `LANDFLOW_PUBLIC_URL` (or
     `LANDFLOW_MARKETPLACE_REGISTRY_URL`) if the host isn't on `http://127.0.0.1:$PORT`.

   The plugin then announces itself and appears under **Plugins**. All three SDKs (TypeScript,
   Python, Go) honour these variables.
5. **Supervises** the process:
   - a crash restarts it after 1 s, 2 s, 4 s … up to 60 s;
   - after 8 fast failures in a row it is marked *crashed*;
   - a run longer than a minute resets the backoff;
   - output goes to `<data dir>/marketplace/logs/<name>.log`, and the last 400 lines are kept
     in memory (**Logs**).

   Installed node plugins start again with the host (bootstrap). Uninstall sends `SIGTERM`, so
   the SDK withdraws from the registry. It sends `SIGKILL` after 5 s, then deletes the directory.

   In queue mode every main and worker runs its own copy, started with `LANDFLOW_REGISTRY_URL=off`
   and registered in that process only. The install records a revision and a hash of the files;
   a process that can't see the plugin directory downloads the same source into
   `<data dir>/marketplace/instances/<instance id>/` and runs it only when the hash matches.
   Install, update and uninstall reach the other processes within moments (and a check every
   minute catches anything missed).

The process gets a minimal environment. It contains `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`,
`TZ`, the OTLP endpoint and the Go cache variables, plus its own `env` and the `LANDFLOW_*`
variables above. It does **not** get the host's API keys, `LANDFLOW_ENCRYPTION_KEY`,
`GITHUB_TOKEN` or anything else from the host's environment.

## Fetching

- GitHub, the only remote host:
  - The marketplace file and plugin files come from `raw.githubusercontent.com`, which doesn't
    count against the API rate limit.
  - Reading a plugin lists its repository once through the trees API. The listing is cached per
    repo and ref for 10 minutes, so all the relative-path plugins of a marketplace share one call.
  - Unauthenticated access gives 60 API requests an hour. Set `GITHUB_TOKEN` on the host for
    more; it is sent only to `api.github.com` and `raw.githubusercontent.com`.
- Limits:
  - every request times out after 20 s;
  - text files are capped at 512 KB, and READMEs at 64 KB;
  - only `http(s)` URLs are followed.
- Plugin details are cached for 10 minutes. **Refresh** re-reads the marketplace and drops the
  caches.
- Local directories (`/abs/path` as a marketplace, or `{ "source": "local", "path" }`) work only
  with `LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1`. The tests use this. It is off by default, so the API
  can't read arbitrary host directories.

## API

| | |
|---|---|
| `GET /api/marketplaces` | `{ marketplaces: MarketplaceSummary[], presets, installed: InstalledPlugin[] }` |
| `POST /api/marketplaces` `{ input }` | `201 { marketplace }`; `409` if already added; `502` if it can't be fetched |
| `GET /api/marketplaces/explore` | `ExploreResult` `{ plugins: ExplorePlugin[], flows: ExploreFlow[], categories, errors }`: every added marketplace at once. A plugin carries its marketplace, what was read of it (`read`: node plugin id and runtime, agent and skill counts) and, once its node plugin is registered, `registered` (icon, colour, status, node count). A flow carries its plugin, `pluginInstalled` and the `templateId` it became. A marketplace or plugin that fails to load lands in `errors`, and the rest is still returned |
| `GET /api/marketplaces/:id` | the catalog `{ marketplace, plugins: CatalogPlugin[], categories }` (fetches on first open) |
| `POST /api/marketplaces/:id/refresh` | `{ marketplace }` |
| `DELETE /api/marketplaces/:id` | `{ ok }`. `409` while plugins from it are installed; `400` for the built-in one |
| `GET /api/marketplaces/:id/plugins/:name[?fresh=1]` | `{ plugin: PluginDetail }`: manifest, agents, skills, unsupported, nodePlugin, flows (`MarketplaceFlow[]`, each with `needs` and `link`), readme, warnings |
| `GET /api/marketplaces/:id/plugins/:name/flow?path=` | `{ flow: MarketplaceFlowView }` for the share page: the flow as a template preview (nothing saved), the plugin's other flows, `templateId` once installed, and `link`. `:id` may be the marketplace's name. `400` without `path`; `404` for an unknown flow, and `404 { missing: "marketplace" }` when the marketplace isn't added |
| `POST /api/marketplaces/:id/plugins/:name/install` `{ confirm? }` | `201 InstallResult` `{ installed, notSupported, warnings }`. `409 InstallConfirmation` for a node plugin without `confirm`. `422` when nothing in it runs in Landflow, or for an unsupported source |
| `GET /api/marketplaces/installed` | `{ installed }`, with node-plugin process status |
| `DELETE /api/marketplaces/installed/:pluginId` | `{ removed: { agents, skills, nodePlugin, flows? } }` (`pluginId` = `name@marketplace`, URL-encoded; `flows` counts the templates removed) |
| `GET /api/marketplaces/installed/:pluginId/logs` | `{ lines }` |
| `POST /api/marketplaces/installed/:pluginId/restart` | `{ installed }` |
| `GET /api/skills` | `{ skills: LibrarySkill[] }` (an `AgentSkill` plus `source` and `installedAt`) |

The types are in `apps/web/src/lib/shared/marketplace.ts`.

## Storage

All of it lives under `LANDFLOW_DATA_DIR` (default `apps/web/.data`):

- `marketplaces.json`: the added marketplaces with their cached entries, and the installed
  plugins with the ids of what each install created;
- `skill-library.json`;
- the flows' templates, in the database with the other imported templates;
- `marketplace/plugins/<name>/` and `marketplace/logs/<name>.log` for node plugins.

## Telemetry

| Signal | |
|---|---|
| spans `marketplace.fetch`, `marketplace.detail`, `marketplace.install`, `marketplace.uninstall`, `marketplace.deps` | attributes `landflow.marketplace.id`, `.plugin`, `.source`, `.node_plugin`. The outbound GitHub requests nest inside as HTTP client spans |
| `landflow.marketplace.operations` (counter) | by `landflow.marketplace.operation` and `landflow.outcome` |
| `landflow.marketplace.duration` (histogram, ms) | by operation |
| `landflow.marketplace.plugin.restarts` (counter) | by `landflow.plugin.id` and the exit reason |
| logs | `marketplace added`, `marketplace plugin installed` / `uninstalled`, restarts and crashes |

## Security notes

- **Agents and skills are text.** Installing them runs nothing, but their instructions come from
  a third party and the model follows them. Agents are installed as unpublished drafts with no
  tools, so they can't act until you add capabilities and publish.
- **Node plugins run third-party code** as the host's user. The confirmation step, the minimal
  environment and the file limits reduce the risk, but they are not a sandbox. Only install
  plugins from repositories you trust, and prefer marketplace entries pinned with a `sha`.
- `npm install` runs with `--ignore-scripts` by default. A plugin's own `install` command can
  still do anything; the confirmation shows it.
- URL marketplaces fetch whatever http(s) URL you enter, from the host.
- **Flows are data until used.** Installing one only adds a template. Its nodes run when someone
  creates a workflow from it and activates or runs it, with the credentials they pick.
