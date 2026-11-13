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

Plugins publish their own branding: `icon: 'file:icons/x.svg'` in the plugin or node descriptor is read by the SDK and sent as a `data:` URL (SVG or PNG, up to 64 KB). The bundled plugins' tiles carry the services' real logos: full-colour marks from the [SVG Logos](https://github.com/gilbarbara/logos) set on a white tile, or a [Simple Icons](https://simpleicons.org) mark in white on the brand's colour (Google Docs and Sheets, Stripe, RSS, MySQL, SQLite, HubSpot), both CC0; a trigger adds an amber bolt. Built-in nodes and credential types can name a brand mark instead of a file, `icon: 'brand:<slug>'` (`apps/web/src/lib/shared/brand-icons.ts`: Ollama, Anthropic, Claude, OpenAI, Gemini, Mistral, Hugging Face, GitHub, Kubernetes, Docker, MCP, kagent, PostgreSQL, SQLite), drawn in the brand's colour or, for a black mark, the text colour. A hex `color` tints the plugin's segment in the node creator and its nodes on the canvas.

A plugin can also ship **composite types**, contracts for canvas frames built from its nodes and others' (the triage plugin's `triage.aiTriage`), and tag its nodes with `capabilities` (`ioc.enrich`) for their slots to match: `defineComposite` in TypeScript, `PluginInfo.Composites` in Go, `Plugin(composites=[...])` in Python. See [composites.md](composites.md).

Descriptor fields mirror n8n's `INodeTypeDescription` / `INodeProperties`: 13 property types, `displayOptions`, `typeOptions.loadOptionsMethod`, typed ports with `required`/`maxConnections`. The editor renders every plugin's UI from its descriptor, so plugins need no frontend code. Full spec: **[docs/protocol.md](protocol.md)**.

## Registration rules

Who may register a plugin or add an endpoint to one depends on the profile ([configuration](reference/configuration.md)):

| | `LANDFLOW_REGISTRY_SECRET` set | not set, development profile | not set, production profile |
|---|---|---|---|
| Announce (HTTP and gRPC) | needs the secret, **and** the announced endpoint must prove it (`GetManifest` challenge, [protocol §13](protocol.md#registry-proofs)) | open (as before) | refused with 401, unless `LANDFLOW_REGISTRY_OPEN=true` |
| Another endpoint joins a plugin that exists | allowed once proven | refused with 409 from a host the plugin does not already use, unless `LANDFLOW_REGISTRY_ALLOW_JOIN=true` (loopback counts as one host) | same as development, when opened |

A production host and every plugin therefore need the same secret. The route answers a failed announce with one generic
422 (`Could not register the plugin: its endpoint did not answer with a valid manifest`); the URL tried and the
connection error go to the host's log. In the production profile endpoints on link-local or metadata addresses
(`169.254.0.0/16`, `fd00:ec2::254`) are refused before the host connects. Joins (`plugin.endpoint_added`) and version
changes (`plugin.updated`) are in the [audit log](features/audit-and-governance.md).

## Autodiscovery

| Source | How |
|---|---|
| **Announce** (push) | Plugin `POST /api/plugins/announce` (or gRPC `RegistryService.Announce` on `:7070`) with a 30 s lease, then heartbeats every 10 s; `SIGTERM` withdraws. Each announce carries the process's random `instanceId`, so a plugin restarted with the same version (new nodes in development) has its manifest pulled again without **Refresh** |
| **Static** | `LANDFLOW_PLUGINS=http://host:7101,grpc://host:7203` |
| **Scan** (pull) | Probes `LANDFLOW_SCAN_HOSTS × LANDFLOW_SCAN_PORTS` (default `127.0.0.1:7100-7299`) with TCP, then `/.well-known/landflow`, then gRPC `Health`; runs at startup and from the UI |
| **Built-in** | the host's `core` plugin, registered in-process through the same interface |
| **Kubernetes** (pull) | `LANDFLOW_PLUGIN_DISCOVERY=kubernetes`: Services labelled `landflow.dev/plugin=true` in `LANDFLOW_K8S_NAMESPACES` (`*` for every namespace, with a ClusterRole), gRPC port from the `landflow.dev/grpc-port` annotation or a port named `grpc`; registered while a pod is ready, offline at zero ready pods, removed with the Service; calls are spread over the ready pods, the manifest pulled once through the Service ([protocol §13](protocol.md#13-kubernetes-discovery-and-registry-proofs)) |

Every manifest is validated against the zod/JSON Schema before its nodes become available. A plugin can expose HTTP and gRPC at once (brokers follow: `docs/transports.md`). The host chooses the transport per call through a selector (`lib/server/transports`): the plugin's **transport policy** (Settings → Plugins) is **Auto** by default (gRPC first, then HTTP, then brokers), can be **pinned** to one transport or limited to an **allow-list**, with an objective (`balanced`, `latency`, `throughput`); it lives in the database (`plugin_transport_policies`), so every main and worker in queue mode makes the same choice. The Plugins page shows each plugin as a small card (icon, status, node count and node icons) with search and an All / Online / Offline filter; clicking a card unfolds it to the endpoints, the transports with their live state, the current choice and why (`pinned`, `only`, `auto.latency`…), MCP exposure and every node. `/plugins?plugin=<id>` opens one unfolded (the dashboard and the marketplace drawer link there). Every `plugin.rpc` span carries `landflow.transport` and `landflow.transport.reason`. **Settings → Transports** lists the installed transport kinds and the broker connections (`/api/transports`, `/api/transports/connections`; secrets encrypted like credentials; `LANDFLOW_TRANSPORT_<KIND>_URL` adds a read-only one). Expired leases turn a plugin offline: its nodes grey out and saved workflows still open.
