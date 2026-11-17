# Writing plugins

Every node in Landflow, built in or not, is a plugin node: a JSON descriptor plus an `execute` behaviour, served by a
process the host finds on its own. This page shows the interface in each SDK and how the host discovers plugins. The
wire contract is [protocol.md](protocol.md); the SDKs' own guides are [packages/sdk](../packages/sdk/README.md)
(TypeScript), [sdks/go](../sdks/go/README.md) and [sdks/python](../sdks/python/README.md); the example and integration
plugins are under [`plugins/`](../plugins). Brokers and MCP faces are in [transports.md](transports.md), and installing
plugins from a marketplace is in [marketplace.md](marketplace.md). Part of the [Landflow docs](README.md).

## The node interface

The **methodology**: every node implements one interface. The descriptor is plain JSON, so any language can produce it.

```ts
interface INodeType {
  description: NodeDescriptor;                     // name, kind, ports, properties, icon, usableAsTool…
  execute?(ctx: IExecuteContext): ExecuteResult;   // items in → items out (one array per output)
  supplyData?(ctx): unknown;                       // sub-nodes: supply a model / tool / memory (in-process)
  methods?: { loadOptions?: Record<string, (ctx) => PropertyOption[]> };
}
```

| | TypeScript | Python | Go |
|---|---|---|---|
| Interface | `class X implements INodeType` / `defineNode({...})` | `class X(Node)` (ABC) | `Description()` + `Execute()` |
| Serve | `serve(plugin, { http, grpc })` | `serve(plugin, http_port=, grpc_port=)` | `landflow.Serve(ctx, p, ServeOptions{...})` |
| Params | `ctx.getNodeParameter(name, i)` | `ctx.get_node_parameter(name, i)` | `ctx.ParamString(name, i, def)` |
| Errors | `NodeOperationError` | `NodeOperationError` | `landflow.ItemError(...)` |

A plugin can also ship **composite types**, contracts for canvas frames built from its nodes and others' (the triage plugin's `triage.aiTriage`), and tag its nodes with `capabilities` (`ioc.enrich`) for their slots to match: `defineComposite` in TypeScript, `PluginInfo.Composites` in Go, `Plugin(composites=[...])` in Python. See [composites.md](composites.md).

Descriptor fields mirror n8n's `INodeTypeDescription` / `INodeProperties`: 13 property types, `displayOptions`, `typeOptions.loadOptionsMethod`, typed ports with `required`/`maxConnections`. The editor renders every plugin's UI from its descriptor, so plugins need no frontend code. Full spec: **[docs/protocol.md](protocol.md)**.

## Branding and real marks

`icon: 'file:icons/x.svg'` in the plugin or node descriptor is read by the SDK and sent as a `data:` URL (SVG or PNG, up to 64 KB). A plugin reads its icon files when it builds its manifest, so a changed icon shows after the plugin restarts. The host serves them inside `GET /api/node-types`, there is no separate icon route and nothing to expire. A hex `color` tints the plugin's segment in the node creator and its nodes on the canvas.

An app's node wears **the app's real mark**, never a drawn stand-in: the node creator, the canvas, the node panel, the Marketplace, the Run Trace, Spotlight's plan and an agent's tool list all show the descriptor's icon, so one file does it everywhere. Built-in nodes and credential types name a mark instead of a file, `icon: 'brand:<slug>'` (`apps/web/src/lib/shared/brand-icons.ts`), drawn in the brand's colour or, for a black mark, the text colour. A Marketplace entry or an agent tool that publishes no icon of its own gets the mark of the app its name says (`brandOfApp`). Landflow's own products (Landfall, Landledger, Clickland, Landflow) and generic tools (HTTP, Code, If, text and crypto utilities) keep their own icons.

| Marks | Source | Licence |
|---|---|---|
| Linear, Discord, Telegram, WhatsApp, Gmail, Google, Google Calendar, Docs, Drive and Sheets, Grafana, Fathom, Notion, Jira, Airtable, HubSpot, Stripe, RSS, MySQL, Redis (and Ollama, Anthropic, Claude, Gemini, Mistral, Hugging Face, GitHub, Kubernetes, Docker, MCP, PostgreSQL, SQLite) | [Simple Icons](https://simpleicons.org) 16.36.0 | CC0 |
| Slack, Twilio | Simple Icons 15.0.0, the last version that carries them | CC0 |
| Attio | its own press kit, [attio.com/brand](https://attio.com/brand) (`/brand/v1/attio-logomark.svg`), offered for third-party materials | the brand's terms |
| OpenAI | [Lobe Icons](https://github.com/lobehub/lobe-icons) 1.101.0 | MIT |
| kagent | its own repository | Apache-2.0 |
| the older plugin tiles (Slack, GitHub, Postgres, Gmail, Notion, Jira and others, full colour on a white tile) | [SVG Logos](https://github.com/gilbarbara/logos) through Iconify | CC0 |

Logos identify the integrations they stand for (nominative use); each belongs to its owner, and the notice sits in the header of `brand-icons.ts`. Microsoft Teams (the Microsoft bot credential) has no clean source and keeps a Landflow glyph.

**Adding one.** Unpack the Simple Icons package into an empty directory (`npm pack simple-icons@16.36.0`), print the mark with `node scripts/brand-icon.mjs entry <dir> <slug>` and paste the line into `BRANDS` with a comment naming its source. A brand Simple Icons lacks comes from Lobe Icons or the brand's own press page, only where that page is clearly the brand's. Then write the plugin's file with `node scripts/brand-icon.mjs tile <key> plugins/<name>/icons/<name>.svg` (`--trigger` adds the bolt a trigger wears): the mark in its colour on a white rounded tile, 48 by 48. A plugin that bundles several apps (Messaging, Databases, Productivity) uses `bundle` for a 2 by 2 grid of its apps' icons. `apps/web/test/brand-icons.test.ts` fails on a listed app whose icon is still a glyph or whose file is missing.

**Under the name.** A node says what it will do: the line below its name on the canvas and in the node panel is the descriptor's `subtitle` (`{{operation}}`, n8n's `{{ $parameter.operation }}`, read as the option's display name), else the operation's `action` label ("Create an issue"), else "Issue · Get many". In the node creator an app's resources and operations are listed as actions, and a search such as "send message" lists the matching actions first; picking one adds the node set to do exactly that. See `apps/web/src/lib/shared/node-subtitle.ts`.

## Registration rules

Who may register a plugin or add an endpoint to one depends on the profile ([configuration](reference/configuration.md)):

| | `LANDFLOW_REGISTRY_SECRET` set | not set, development profile | not set, production profile |
|---|---|---|---|
| Announce (HTTP and gRPC) | needs the secret, **and** the announced endpoint must prove it (`GetManifest` challenge, [protocol §13](protocol.md#registry-proofs)) | open (as before) | refused with 401, unless `LANDFLOW_REGISTRY_OPEN=true` |
| Another endpoint joins a plugin that exists | allowed once proven | refused with 409 from a host the plugin does not already use, unless `LANDFLOW_REGISTRY_ALLOW_JOIN=true` (loopback counts as one host; brokered endpoints have no host, so a plugin that has only those, or a brokered announce, joins freely) | same as development, when opened |

A production host and every plugin therefore need the same secret. The route answers a failed announce with one generic
422 (`Could not register the plugin: its endpoint did not answer with a valid manifest`); the URL tried and the
connection error go to the host's log. In the production profile endpoints on link-local or metadata addresses
(`169.254.0.0/16`, `fd00:ec2::254`, also written as a number or in hex in a `grpc://` URL) are refused before the host
connects; a DNS name that resolves to one is not caught here (plugins are outside `safeFetch`, see
[limitations](limitations.md)). A main logs `plugin registration is open` at boot when announces need no secret. An offline endpoint still counts as the plugin's host, so in development a plugin that returns on another advertise host (a changed LAN address) gets 409 until the host restarts or `LANDFLOW_REGISTRY_ALLOW_JOIN=true`. Joins (`plugin.endpoint_added`) and version
changes (`plugin.updated`) are in the [audit log](features/audit-and-governance.md).

## Autodiscovery

| Source | How |
|---|---|
| **Announce** (push) | Plugin `POST /api/plugins/announce` (or gRPC `RegistryService.Announce` on `:7070`) with a 30 s lease, then heartbeats every 10 s; `SIGTERM` withdraws. Each announce carries the process's random `instanceId`, so a plugin restarted with the same version (new nodes in development) has its manifest pulled again without **Refresh** |
| **Static** | `LANDFLOW_PLUGINS=http://host:7101,grpc://host:7203` |
| **Scan** (pull) | Probes `LANDFLOW_SCAN_HOSTS × LANDFLOW_SCAN_PORTS` (default `127.0.0.1:7100-7299`) with TCP, then `/.well-known/landflow`, then gRPC `Health`; runs at startup and from the UI |
| **Built-in** | the host's `core` plugin, registered in-process through the same interface |
| **Kubernetes** (pull) | `LANDFLOW_PLUGIN_DISCOVERY=kubernetes`: Services labelled `landflow.dev/plugin=true` in `LANDFLOW_K8S_NAMESPACES` (`*` for every namespace, with a ClusterRole), gRPC port from the `landflow.dev/grpc-port` annotation or a port named `grpc`; registered while a pod is ready, offline at zero ready pods, removed with the Service; calls are spread over the ready pods, the manifest pulled once through the Service ([protocol §13](protocol.md#13-kubernetes-discovery-and-registry-proofs)) |

Every manifest is validated against the zod/JSON Schema before its nodes become available. A plugin can expose HTTP and gRPC at once (brokers follow: `docs/transports.md`). The host chooses the transport per call through a selector (`lib/server/transports`): the plugin's **transport policy** (Settings → Plugins) is **Auto** by default (gRPC first, then HTTP, then brokers), can be **pinned** to one transport or limited to an **allow-list**, with an objective (`balanced`, `latency`, `throughput`); it lives in the database (`plugin_transport_policies`), so every main and worker in queue mode makes the same choice. The Plugins page is one column. It shows each plugin as a small card (icon, status, node count and the first 12 node icons, then "+N") with search and an All / Online / Offline filter and the list count in the header; **Show feed** unfolds the discovery feed, and the arrow on **Scan network** opens **Add endpoint** for a plugin the scan can't reach; clicking a card unfolds it to the endpoints, the transports with their live state, the current choice and why (`pinned`, `only`, `auto.latency`…), MCP exposure and the nodes (12 chips, then **+N more**). `/plugins?plugin=<id>` opens one unfolded (the dashboard and the marketplace drawer link there). Every `plugin.rpc` span carries `landflow.transport` and `landflow.transport.reason`. **Settings → Transports** lists the installed transport kinds and the broker connections (`/api/transports`, `/api/transports/connections`; secrets encrypted like credentials; `LANDFLOW_TRANSPORT_<KIND>_URL` adds a read-only one). Expired leases turn a plugin offline: its nodes grey out and saved workflows still open.
