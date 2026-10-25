# Landflow Plugin Protocol — `landflow.plugin/v1`

Every node in Landflow — built-in or third-party, TypeScript or not — is described by the same
**NodeDescriptor** and executed through the same **Execute** contract. A *plugin* is a process
that hosts one or more node types and speaks this protocol over **HTTP+JSON** and/or **gRPC**.

| Artifact | Location |
|---|---|
| TypeScript types (source of truth) | `packages/protocol/src/types.ts` |
| Runtime validation (zod) | `packages/protocol/src/schema.ts` |
| JSON Schema (generated) | `packages/protocol/schema/*.json` |
| gRPC contract | `packages/protocol/proto/landflow/plugin/v1/plugin.proto` |

## 1. Lifecycle

```
 plugin process                                      Landflow host (Next.js)
 ──────────────                                      ───────────────────────
 start HTTP and/or gRPC server
 POST /api/plugins/announce  ──────────────────────▶  registry: lease(endpoint, ttl=30s)
   (or RegistryService.Announce on :7070)             GET manifest via the endpoint's transport
                             ◀──────────────────────  validate → node types appear in the editor
 every 10s: re-announce (heartbeat) ───────────────▶  lease renewed; manifest re-pulled if version changed
                             ◀──────────────────────  Execute(node, items) when a workflow runs
 SIGTERM: DELETE /api/plugins/announce ────────────▶  plugin marked offline
```

Discovery sources (all feed the same registry):

1. **Announce** (push) — the plugin registers itself and heartbeats. Default for the SDKs.
2. **Static seeds** — `LANDFLOW_PLUGINS=http://127.0.0.1:7101,grpc://127.0.0.1:7203` on the host.
3. **Scan** (pull) — the host probes `LANDFLOW_SCAN_HOSTS` × `LANDFLOW_SCAN_PORTS`
   (default `127.0.0.1` × `7100-7299`): HTTP `GET /.well-known/landflow`, then gRPC `Health`.
4. **Built-in** — the host's own `core` plugin, registered in-process through the same interface.

A lease that is not renewed within `ttlSeconds` marks the plugin **offline**; its nodes stay
visible (greyed out) so saved workflows still open.

## 2. Endpoints

An endpoint is a URL: `http://host:port` (or `https://`) or `grpc://host:port`.

### HTTP binding

| Method & path | Request | Response |
|---|---|---|
| `GET /.well-known/landflow` | – | `WellKnownDocument` (cheap probe) |
| `GET /landflow/v1/manifest` | – | `PluginManifest` |
| `POST /landflow/v1/execute` | `ExecuteRequest` | `ExecuteResponse` |
| `POST /landflow/v1/load-options` | `LoadOptionsRequest` | `LoadOptionsResponse` |
| `POST /landflow/v1/test-credentials` | `TestCredentialsRequest` | `TestCredentialsResponse` |
| `GET /landflow/v1/health` | – | `HealthResponse` |
| `GET /metrics` | – | Prometheus text exposition (optional, see [observability.md](observability.md)) |

All bodies are `application/json; charset=utf-8`. A node failure is **not** an HTTP error: return
`200` with `error` set in the `ExecuteResponse`. Use `400` for malformed requests, `404` for an
unknown node type, `500` only for bugs in the plugin server itself.

### gRPC binding

`landflow.plugin.v1.PluginService` with `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health`.
Recursive / open-ended values travel as `DynamicValue { bytes json }` — UTF-8 JSON that follows
the same JSON Schema as the HTTP binding (the Terraform `tfplugin` approach). Conventions:

- `NodeError.item_index = -1` when the error is not item-specific; an absent `error` (or an empty
  `message`) means success.
- `ExecuteRequest.node.type` is fully qualified (`go-crypto.hash`); `LoadOptionsRequest.node_type`
  is the **local** name (`hash`).

### Host registry

| Transport | Announce | Withdraw |
|---|---|---|
| HTTP | `POST {host}/api/plugins/announce` body `AnnounceRequest` → `AnnounceResponse` | `DELETE {host}/api/plugins/announce` body `WithdrawRequest` |
| gRPC | `RegistryService.Announce` on `:7070` | `RegistryService.Withdraw` |

SDK environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `LANDFLOW_REGISTRY_URL` | `http://127.0.0.1:3000` | where to announce (`http(s)://` or `grpc://`); set to `off` to disable |
| `LANDFLOW_ADVERTISE_HOST` | `127.0.0.1` | host name put into the announced endpoint |
| `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` | per plugin | listen ports |

## 3. Messages (JSON shapes)

```jsonc
// PluginManifest
{
  "protocol": "landflow.plugin/v1",
  "plugin": { "id": "go-crypto", "name": "Crypto Toolkit", "version": "0.1.0",
              "language": "go", "sdk": { "name": "landflow-sdk-go", "version": "0.1.0" },
              "icon": "data:image/svg+xml;base64,…", "color": "#0d9488", "description": "…" },
  "nodes": [ /* NodeDescriptor */ ]
}

// NodeDescriptor (subset of n8n's INodeTypeDescription)
{
  "name": "hash",                       // local; full type = "<pluginId>.hash"
  "displayName": "Hash",
  "description": "Hash a field with SHA-256, SHA-1 or MD5",
  "version": 1,                          // or [1, 2]
  "kind": "action",                      // "trigger" | "action" | "subnode"
  "categories": ["Crypto"],
  "icon": "lucide:fingerprint",          // "lucide:<name>" | "emoji:<char>" | https/data URL (see §6)
  "color": "#22d3ee",
  "subtitle": "{{algorithm}}",
  "inputs":  [{ "type": "main" }],
  "outputs": [{ "type": "main" }],       // several main outputs = branches (IF: true/false)
  "usableAsTool": true,                  // can be attached to an AI Agent's ai_tool port
  "properties": [
    { "name": "algorithm", "displayName": "Algorithm", "type": "options", "default": "sha256",
      "options": [ { "name": "SHA-256", "value": "sha256" }, { "name": "MD5", "value": "md5" } ] },
    { "name": "field", "displayName": "Field", "type": "string", "default": "value",
      "displayOptions": { "show": { "algorithm": ["sha256", "md5"] } } }
  ]
}

// ExecuteRequest
{
  "protocol": "landflow.plugin/v1",
  "executionId": "ex_…", "workflowId": "wf_…",
  "mode": "manual",                       // "manual" | "trigger" | "webhook" | "tool" | "chat"
  "node": { "id": "n3", "name": "Hash", "type": "go-crypto.hash", "typeVersion": 1 },
  "parameters":     { "algorithm": "sha256", "field": "email" },     // resolved vs item 0
  "itemParameters": [ { "algorithm": "sha256", "field": "email" } ], // resolved per item of input 0
  "inputs": [ [ { "json": { "email": "a@b.c" } } ] ]                  // inputs[i] = main input i
}

// ExecuteResponse
{
  "outputs": [ [ { "json": { "email": "a@b.c", "hash": "…" }, "pairedItem": { "item": 0 } } ] ],
  "logs": [ { "level": "info", "message": "hashed 1 item" } ],
  "error": null                            // or { "message", "description"?, "itemIndex"? }
}
```

**Expressions are resolved by the host.** `{{ $json.email }}` in a parameter is evaluated per item
before the request is sent; plugins only ever see concrete values. `getNodeParameter(name, i)`
in every SDK reads `itemParameters[i][name]`, falling back to `parameters[name]`, then to the
property's `default`. When several properties share a name (one `operation` per `resource`), the
default comes from the first one whose `displayOptions` match the item's parameters, as in n8n.

**Tool mode.** When an AI Agent calls a node as a tool, the host sends `mode: "tool"` with the
model-chosen arguments merged into `parameters`/`itemParameters` and a single input item
`{ json: <arguments> }`. The node's first output becomes the tool result. No special code is
needed in the plugin — `usableAsTool: true` is the only opt-in.

**Continue on fail.** When the node's error setting is "Continue", the host sends
`continueOnFail: true`. A node that processes items one by one should then catch a failing item,
output `{ "json": { "error": "<message>", "description"?: "…" }, "pairedItem": { "item": i } }` for
it and go on with the next item, as n8n's `continueOnFail()` does. The SDKs expose the flag as
`ctx.continueOnFail()`, `ctx.continue_on_fail()` and `ctx.ContinueOnFail()` (Go adds
`ctx.ErrorItem(i, err)`). If the call still fails, the host falls back to node-level continue:
every input item comes out with the error attached.

## 4. Property types

`string` · `number` · `boolean` · `options` · `multiOptions` · `json` · `code` · `collection` ·
`fixedCollection` · `color` · `dateTime` · `notice` · `hidden`. Conditional visibility uses
n8n's `displayOptions.show/hide`. Inside a `collection` or `fixedCollection`, a plain key refers to
a sibling field and `/key` to a top-level parameter (a plain key no sibling has falls back to the
top-level one). Changing a parameter in the editor clears parameters whose visible property changes
(the `operation` after switching `resource`) so they take the new default. Dynamic dropdowns set
`typeOptions.loadOptionsMethod` and are served by `LoadOptions`.

## 5. Connection types

`main` carries items. `ai_languageModel`, `ai_tool` and `ai_memory` connect **sub-nodes** to a
root node (n8n's cluster nodes). The edge direction is sub-node → root, and the root's port
declares `required` / `maxConnections`.

## 6. Icons and brand colour

`PluginInfo.icon` and `NodeDescriptor.icon` accept `lucide:<name>`, `emoji:<char>`, an `https:`
URL or a `data:` URL. The plugin's icon and `PluginInfo.color` (hex, e.g. `#2563eb`) brand its
segment in the node creator. Node icons usually share the plugin's hue.

Plugin authors can also write n8n-style **`file:` icons** (`icon: "file:icons/hash.svg"`). The SDK
reads the file when it builds the manifest and inlines it as `data:image/svg+xml;base64,…`
(or `image/png`). Icons are inlined rather than served because a gRPC-only plugin has no HTTP
server to fetch them from. **The host never sees `file:`.** Only `.svg` and `.png` files of at most
**64 KB** are accepted. Anything else fails at plugin startup with a message that names the node.

| SDK | Relative `file:` paths resolve against | Example |
|---|---|---|
| TypeScript | `definePlugin({ iconDir })` (path or file URL) | `iconDir: new URL('../icons/', import.meta.url)`, or one-off `icon: iconFile(new URL('./x.svg', import.meta.url))` |
| Python | the directory of the module that declares the icon (the node's module, or the module calling `Plugin(...)`); `Plugin(icon_dir=...)` overrides | `"icon": "file:icons/stats.svg"`, or `icon_file(path)` |
| Go | `PluginInfo.IconFS`, typically an `embed.FS` (Go has no reliable source path at runtime) | `//go:embed icons` + `IconFS: icons`, or `Icon: landflow.SVGIcon(embeddedBytes)` |

The host renders icons with `<img>`, so scripts and external references inside an SVG never run.
Draw the glyphs as paths: a `<text>` element depends on fonts the viewer may not have. Over gRPC,
`color` is `PluginInfo` field 11; node descriptors travel as JSON, so their `icon`/`color` need
no proto field.

## 7. Credentials

A plugin declares the kinds of secrets its nodes need in `PluginManifest.credentialTypes`
(gRPC: `GetManifestResponse.credential_types`, each a JSON `CredentialTypeDescriptor`), and each
node lists the ones it can use in `NodeDescriptor.credentials`:

```jsonc
// manifest
"credentialTypes": [{
  "name": "telegramApi", "displayName": "Telegram API", "testable": true,
  "documentationUrl": "https://core.telegram.org/bots#how-do-i-create-a-bot",
  "properties": [
    { "name": "accessToken", "displayName": "Bot token", "type": "string", "required": true, "typeOptions": { "password": true } },
    { "name": "baseUrl", "displayName": "API base URL", "type": "string", "default": "https://api.telegram.org" }
  ]
}],
// node
"credentials": [{ "name": "telegramApi", "required": true }]
```

- The **host** renders the credential form from `properties`, stores the values encrypted at rest,
  and lets users pick a saved credential per node. Workflow JSON only holds a reference:
  `node.credentials = { "telegramApi": { "id": "cred_…", "name": "My bot" } }`.
- On `Execute` and `LoadOptions` the host sends the **decrypted** values keyed by local type name:
  `credentials: { "telegramApi": { "accessToken": "…", "baseUrl": "…" } }`. Only the credentials
  the node references are sent.
- `typeOptions.password` fields are masked in the UI and never returned by the host API.
- `testable: true` means the plugin implements `TestCredentials` (`{ credentialType, data }` →
  `{ ok, message? }`), which the UI offers as **Test connection**. Make a cheap authenticated
  call (Telegram `getMe`, Slack `auth.test`, `SELECT 1`) and put the reason in `message` on failure.
  A test that throws, or a type without a test, answers `{ ok: false, message }`; an unknown
  credential type is HTTP `404` / gRPC `NOT_FOUND`.
- Every integration should expose an overridable **base URL** (or host/port) so it can be pointed
  at a self-hosted instance, a proxy or a test double.
- Never log credential values. SDKs redact them from logs and span attributes.

## 8. Polling triggers

A trigger with `triggerSource: "poll"` checks a service for new events on a schedule (n8n's
"poll" triggers: RSS Feed Trigger, Gmail Trigger, GitHub new issues, new database rows…).

- The node declares a number property **`pollInterval`** (seconds, default 60, minimum 10). While
  the workflow is active the host calls `Execute` with `mode: "poll"`, `inputs: []` and
  `pollState` = the state the previous poll returned (absent on the first poll).
- The node returns the **new** events as items on output 0 and the next state in
  `ExecuteResponse.pollState` (e.g. `{ "lastId": 123 }` or `{ "since": "2026-10-25T10:00:00Z" }`).
  An empty output starts no execution. The host persists `pollState` per workflow and node; a poll
  response without `pollState` (or with `error`) leaves the stored state unchanged.
- **First poll** (no `pollState`): establish the baseline and return **no items**, so activating a
  workflow does not replay history.
- With `mode: "manual"` (the user pressed Execute in the editor) return the **most recent** few
  events (default 1–5) regardless of state, so the flow can be built and debugged against real data.
  Do not return `pollState` in manual mode.

## 9. Trace context and metrics

The host sends W3C trace context (`traceparent`, `tracestate`, `baggage`) with every call, as
HTTP headers or gRPC metadata. Plugins continue the trace: a server span per call, child spans
for outbound API calls, and trace/span ids in every log line. Plugins expose metrics through
OTLP and optionally `GET /metrics`. Span names, attributes, metric names and the log format are
specified in **[observability.md](observability.md)**.
