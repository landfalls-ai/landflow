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
| Transport kinds, endpoints, MCP tool mapping | `packages/protocol/src/transport.ts`, `packages/protocol/src/mcp-tools.ts` (§14, §15) |
| Conformance kit (fixtures every face and driver must pass) | `packages/protocol/conformance/` (`@landflow/protocol/conformance`) |

## 1. Lifecycle

```
 plugin process                                      Landflow host (Next.js)
 ──────────────                                      ───────────────────────
 start HTTP and/or gRPC server
 POST /api/plugins/announce  ──────────────────────▶  registry: lease(endpoint, ttl=30s)
   (or RegistryService.Announce on :7070)             GET manifest via the endpoint's transport
                             ◀──────────────────────  validate → node types appear in the editor
 every 10s: re-announce (heartbeat) ───────────────▶  lease renewed; manifest re-pulled if version or instanceId changed
                             ◀──────────────────────  Execute(node, items) when a workflow runs
 SIGTERM: DELETE /api/plugins/announce ────────────▶  plugin marked offline
```

Discovery sources (all feed the same registry):

1. **Announce** (push) — the plugin registers itself and heartbeats. Default for the SDKs.
2. **Static seeds** — `LANDFLOW_PLUGINS=http://127.0.0.1:7101,grpc://127.0.0.1:7203` on the host.
3. **Scan** (pull) — the host probes `LANDFLOW_SCAN_HOSTS` × `LANDFLOW_SCAN_PORTS`
   (default `127.0.0.1` × `7100-7299`): HTTP `GET /.well-known/landflow`, then gRPC `Health`.
4. **Built-in** — the host's own `core` plugin, registered in-process through the same interface.
5. **Kubernetes** (pull, opt-in) — with `LANDFLOW_PLUGIN_DISCOVERY=kubernetes` the host watches Services labelled
   `landflow.dev/plugin=true` and their EndpointSlices, and registers a plugin while it has a ready pod (§13).

A lease that is not renewed within `ttlSeconds` marks the plugin **offline**; its nodes stay
visible (greyed out) so saved workflows still open.

## 2. Endpoints

An endpoint is a URL: `http://host:port` (or `https://`) or `grpc://host:port`. A plugin reached through a message
broker has a logical endpoint instead, `<kind>://<connectionId>/<pluginId>` (`kafka://kafka-main/twilio`), announced
over the broker itself: see §14.

### HTTP binding

| Method & path | Request | Response |
|---|---|---|
| `GET /.well-known/landflow` | – | `WellKnownDocument` (cheap probe) |
| `GET /landflow/v1/manifest` | – | `PluginManifest` |
| `POST /landflow/v1/execute` | `ExecuteRequest` | `ExecuteResponse` |
| `POST /landflow/v1/load-options` | `LoadOptionsRequest` | `LoadOptionsResponse` |
| `POST /landflow/v1/test-credentials` | `TestCredentialsRequest` | `TestCredentialsResponse` |
| `GET /landflow/v1/health` | – | `HealthResponse` |
| `POST /landflow/v1/webhook-method` | `WebhookMethodRequest` | `WebhookMethodResponse` (app webhook triggers, §12) |
| `POST /landflow/v1/webhook` | `WebhookRequest` | `WebhookResponse` (app webhook triggers, §12) |
| `GET /metrics` | – | Prometheus text exposition (optional, see [observability.md](observability.md)) |

All bodies are `application/json; charset=utf-8`. A node failure is **not** an HTTP error: return
`200` with `error` set in the `ExecuteResponse`. Use `400` for malformed requests, `404` for an
unknown node type, `500` only for bugs in the plugin server itself.

### gRPC binding

`landflow.plugin.v1.PluginService` with `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health`,
and `WebhookMethod` / `ReceiveWebhook` for app webhook triggers (§12).
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

`AnnounceRequest` is `{ protocol, endpoint, pluginId, version, ttlSeconds?, instanceId? }`. An announce for an endpoint
that is online with the same `version` is a heartbeat: the lease is renewed and the manifest is not pulled.

**`instanceId`** (optional; gRPC `instance_id = 6`, empty when absent) is a random id the plugin picks once per process
and sends with every announce: opaque, 1–128 characters; the SDKs send 32 hex characters (`INSTANCE_ID` in TypeScript
and Python, `InstanceID()` in Go). The host keeps it per endpoint. An announce with another id than the stored one is a
restarted process, usually within its lease and with the same version but new nodes or parameters (development): the
host pulls the manifest again, with the registry proof when the endpoint needs one (§13), and emits the usual
`plugin.updated` event, so the editor shows the new descriptors without **Refresh** on the Plugins page. An endpoint
known without an id (found by a scan, or announced by an older SDK) is pulled once more on its first announce with one;
a Refresh keeps the stored id. Announces without `instanceId` (older plugins) work as before: only a new version, or
coming back after a withdraw or an expired lease, re-pulls the manifest. Older hosts ignore the field.

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
  "idempotencyKey": "ex_…:n3:0",          // "<executionId>:<nodeId>:<runIndex>", see below
  "mode": "manual",                       // "manual" | "trigger" | "webhook" | "tool" | "chat"
  "node": { "id": "n3", "name": "Hash", "type": "go-crypto.hash", "typeVersion": 1 },
  "parameters":     { "algorithm": "sha256", "field": "email" },     // resolved vs item 0
  "itemParameters": [ { "algorithm": "sha256", "field": "email" } ], // resolved per item of input 0
  "inputs": [ [ { "json": { "email": "a@b.c" } } ] ],                 // inputs[i] = main input i
  // Optional, only when files are involved (§11): items may carry "binary": { "<name>": BinaryRef },
  // and the host adds where to read and write those files:
  "binaryAccess": { "url": "http://127.0.0.1:3000/api/binary", "token": "lfb1.…" }
}

// ExecuteResponse
{
  "outputs": [ [ { "json": { "email": "a@b.c", "hash": "…" }, "pairedItem": { "item": 0 } } ] ],
  "logs": [ { "level": "info", "message": "hashed 1 item" } ],
  "error": null                            // or { "message", "description"?, "itemIndex"? }
}
```

**Files** ride next to an item's JSON as `"binary": { "data": { "id": "ex_….k3J…", "mimeType":
"application/pdf", "fileName": "report.pdf", "fileSize": 48213, … } }`: references to the host's
binary store, read and written over HTTP with `binaryAccess`. See §11.

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

**Idempotency key.** The host sends `idempotencyKey` (gRPC `idempotency_key`) with every node call:
`"<executionId>:<nodeId>:<runIndex>"`, where `runIndex` is the 0-based index of this node's run in
the execution. It is the same for every retry of that step (a retry-on-fail attempt, or the re-run of
the interrupted node when an execution resumes after a host crash) and new for a new execution. A
node with side effects should forward it to downstream APIs that accept an idempotency key (Stripe's
`Idempotency-Key` header, …), so a repeated step does not repeat them; a node that makes one call
per item can append the item index (`<key>:<i>`). Older hosts leave it out. The SDKs expose it as
`ctx.getIdempotencyKey()` (`undefined` when absent), `ctx.idempotency_key` (`None`) and
`ctx.IdempotencyKey()` (`""`).

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

### OAuth2 credentials (`extends`)

The host ships a generic OAuth2 type, `core.oAuth2Api` (fields `grantType` — `pkce`, `authorizationCode` or
`clientCredentials` —, `authUrl`, `accessTokenUrl`, `clientId`, `clientSecret`, `scope`, `authQueryParameters`,
`authentication` — `header` (HTTP Basic) or `body` —, `userInfoUrl`). A plugin type that lists it in `extends`
(n8n's `extends: ['oAuth2Api']`) becomes an OAuth2 type: the host merges the parent's properties first, a child
property with the same name replaces the parent's in place (pin a provider's URLs with `hidden` properties and
defaults), and the credential dialog shows **Connect**:

```jsonc
{ "name": "googleOAuth2Api", "displayName": "Google OAuth2", "extends": ["oAuth2Api"], "properties": [
  { "name": "authUrl", "displayName": "Authorization URL", "type": "hidden", "default": "https://accounts.google.com/o/oauth2/v2/auth" },
  { "name": "accessTokenUrl", "displayName": "Access Token URL", "type": "hidden", "default": "https://oauth2.googleapis.com/token" },
  { "name": "scope", "displayName": "Scope", "type": "string", "default": "openid email https://www.googleapis.com/auth/drive" }
]}
```

- A local name in `extends` means a type of the same plugin when it has one, else the core plugin's; `plugin.name`
  is used as is. Unknown parents and cycles are ignored (the type keeps its own properties).
- **Connect** runs the authorization code flow (with PKCE for `pkce`) in a popup: `GET
  /api/credentials/{id}/oauth2/authorize` redirects to the provider with a signed, expiring `state` and a
  per-flow cookie; the provider calls back `GET /api/oauth2/callback` (the redirect URL to register:
  `LANDFLOW_OAUTH2_REDIRECT_URL`, else `LANDFLOW_PUBLIC_URL` + `/api/oauth2/callback`, else the request's origin).
  The client credentials grant needs no popup: the host fetches a token at first use or with **Get token**.
- The host keeps the token (and refresh token) encrypted with the credential; the API never returns it. On
  `Execute`, `LoadOptions` and `TestCredentials` the plugin gets the saved fields plus `accessToken`,
  `tokenType`, `expiresAt` (ISO, when known) and `oauthTokenData: { access_token }` — never the refresh token.
- **Refresh:** before each call the host renews a token that expires within a minute (refresh token, or the
  client credentials grant) and saves it. When a node fails with an error that reads like a 401 (`401`,
  `Unauthorized`, `invalid_token`, `token expired`), the host renews the token once more and runs the node again,
  **once**; the whole call is repeated. So a plugin should use `accessToken` as is and, when the API answers 401,
  fail with a message that says so (e.g. `Gmail API error 401: …`) rather than retrying with the same token.
  When renewing fails, the node fails with "… could not be renewed — reconnect it in Credentials".

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

## 10. In-process nodes: waits, node state and cancellation

These SDK context members exist only for nodes that run inside the host (the built-in `core`
plugin and `inProcessNodeType`); remote plugins never see them, and nothing about them goes
over the wire. Check for them before use (`ctx.putExecutionToWait?.(…)`).

- **`ctx.signal`** (`AbortSignal`): aborted when the execution is canceled or hits the workflow's
  `timeoutSeconds`. Long-running nodes should pass it on (`fetch`, timers). The engine also
  stops waiting for a node that ignores it.
- **`ctx.putExecutionToWait(request: WaitRequest)`**: suspend the execution once `execute`
  returns. The engine finishes with status `waiting` and a JSON `ResumeState`; the host saves the
  run under the same id and later continues it on the same workflow version.

  ```ts
  interface WaitRequest {
    resume: 'time' | 'webhook' | 'form' | 'subworkflow';
    until?: string;   // ISO: when a time wait resumes, or when a webhook/form wait gives up
    method?: string;  // webhook: the method /api/waiting/<executionId> accepts (default any)
    data?: JsonObject; // kept with the wait, e.g. a form page or a webhook's response mode
  }
  ```

  On resume, the node does not run again: its output is the resume payload (the webhook request
  `{ method, path, headers, query, body }`, the form submission, a sub-execution's last items), or
  what `execute` returned for a `time` wait and a wait that ran out of time. A resume can also
  fail the node (a failed sub-execution), which follows its `onError` setting.
- **`ctx.getNodeState<T>()` / `ctx.setNodeState(state | undefined)`**: JSON state a node keeps
  for the length of one execution, also across waits (Loop Over Items keeps its remaining items
  here). `undefined` clears it.

## 11. Binary data

Items carry files next to their JSON, under `binary`, keyed by a property name (`data` for a single
file, as in n8n). A file is a **reference** to bytes in the host's binary store, never the bytes:

```jsonc
{
  "json": { "invoice": 42 },
  "binary": {
    "data": {
      "id": "ex_V1StGXR8Z5jd.k3J9vQ2mT0pX7aLc1RwYz",   // <scope>.<random>; the scope is the owning execution
      "mimeType": "application/pdf",
      "fileName": "invoice-42.pdf",
      "fileExtension": "pdf",
      "fileSize": 48213,                              // bytes
      "fileType": "pdf"                               // image | text | json | html | pdf | audio | video | other
    }
  }
}
```

- The engine passes `binary` through like `json`; a node that builds new items decides whether to
  keep it (Edit Fields, Filter, If, Switch and the other pass-through nodes keep it).
- **Every ref the host sends has an `id`.** Read the bytes over the host's binary API (below).
- **A node may return a small file inline**: `{ "data": "<base64>", "mimeType": "text/csv", "fileName": "a.csv" }`
  without `id` (and `fileSize` may be left out). The host stores it and replaces it with a stored ref
  before the next node sees it. The SDKs inline files up to `MAX_INLINE_BINARY_BYTES` (64 KiB) and
  upload bigger ones; the host accepts inline files up to `LANDFLOW_BINARY_MAX_INLINE_BYTES`
  (default 16 MiB, decoded).
- Bytes are deleted with their execution: by the executions API, by retention, and when a
  workflow's settings don't keep that kind of run. A sub-workflow run with "wait for completion"
  writes into its parent's scope, so the files it returns live as long as the parent run.

### Reading and writing bytes

`ExecuteRequest.binaryAccess` (gRPC: `ExecuteRequest.binary_access`, a `BinaryAccess` message) tells a
plugin where the host's binary API is for this call:

```jsonc
"binaryAccess": { "url": "http://127.0.0.1:3000/api/binary", "token": "lfb1.eyJ3Ijoi….Q2xh…" }
```

| Method & path | Request | Response |
|---|---|---|
| `GET {url}/{id}` | `Authorization: Bearer {token}` | `200` with the bytes; `Content-Type`, `Content-Length`, `Content-Disposition` (`?download=1` makes it `attachment`) |
| `POST {url}` | `Authorization: Bearer {token}`; body: the raw bytes (stream them); `Content-Type`: the file's MIME type; file name in `X-Landflow-File-Name` (percent-encoded) or `?fileName=` | `201` with the stored `BinaryRef` |

- The **token** is scoped to the execution: it stores files there, and reads those plus the files
  of the call's input items (which can belong to an earlier execution in a re-run, or to a parent
  run). It expires after an hour. Missing or bad token → `401`; a file outside its scope → `403`;
  unknown id → `404`; an upload over `LANDFLOW_BINARY_MAX_BYTES` (default 256 MiB) → `413`.
- The host builds `url` from `LANDFLOW_INTERNAL_URL` (default `http://127.0.0.1:$PORT`). Set it when
  plugins reach the host under another name (`http://web:3000` in `deploy/compose.yml`).
- Without a token, `GET`/`HEAD {url}/{id}` serves the host's own UI (the run view's Binary tab), like the
  rest of the API while Landflow has no sign-in; ids carry 128 random bits. HTML, SVG and other
  active types are served with a sandboxing `Content-Security-Policy` and `nosniff`.
- A plugin that gets no `binaryAccess` (an older host) can still return inline files.
- **Backward compatible**: plugins built on an SDK without binary support ignore `binary` (their
  output items simply don't carry files), and hosts without it never send `binaryAccess`.

### SDK helpers

| | TypeScript (`ctx.helpers`) | Go (`*ExecuteContext`) | Python (`ctx`) |
|---|---|---|---|
| the ref of input item `i` (error if missing) | `assertBinaryData(i, 'data')` | `BinaryRef(i, "data")` | `assert_binary_data(i, "data")` |
| its bytes | `await getBinaryDataBuffer(i, 'data')` | `BinaryBytes(i, "data")` | `get_binary_bytes(i, "data")` |
| a stream | `await getBinaryStream(i, 'data')` | `BinaryReader(i, "data")` (`io.ReadCloser`) | `open_binary_stream(i, "data")` (file-like) |
| bytes of any ref | `await binaryToBuffer(ref)` | `ReadBinary(ref)` (`OpenBinary(ref)` streams) | `read_binary(ref)` |
| store bytes, get a ref | `await prepareBinaryData(bytes, 'a.pdf', mime?)` | `PrepareBinary(bytes, "a.pdf", mime)` / `PrepareBinaryStream(r, "a.pdf", mime)` | `prepare_binary_data(bytes_or_file, "a.pdf", mime_type=None)` |
| attach it | `{ json, binary: { data: ref } }` | `Item{JSON: …, Binary: map[string]BinaryRef{"data": ref}}` | `{"json": …, "binary": {"data": ref}}` |

`prepare…` returns an inline ref for small files and uploads the rest; the MIME type defaults to
one guessed from the file name.

## 12. App webhook triggers

A trigger with `triggerSource: "appWebhook"` registers **its own** webhook with an external service (a GitHub
repository hook, a Stripe endpoint, a Slack event subscription) when the workflow is **published**, and removes it
when the workflow is unpublished, the trigger changes or the workflow is deleted: n8n's `webhookMethods`. The service
then calls the host, the host hands each call to the node, and the node decides whether it starts a run.

```
 publish ──▶ host: WebhookMethod checkExists ──▶ exists? done : WebhookMethod create (node registers webhookUrl)
 service ──▶ POST {publicUrl}/api/webhook/app/<workflowId>/<nodeId> ──▶ host: ReceiveWebhook ──▶ items? run : reply only
 unpublish / node changed / workflow deleted ──▶ host: WebhookMethod delete
```

- **Endpoints.** HTTP `POST /landflow/v1/webhook-method` and `POST /landflow/v1/webhook`; gRPC `WebhookMethod` and
  `ReceiveWebhook`. `GET /.well-known/landflow` lists `endpoints.webhookMethod` and `endpoints.webhook` when a node is
  an app webhook trigger. Node failures are `200` with `error`, as for `Execute`.
- **`WebhookMethodRequest`** `{protocol, method: "checkExists" | "create" | "delete", workflowId, node, parameters,
  credentials?, webhookUrl, staticData}`. Parameters are resolved without items. `webhookUrl` is
  `{LANDFLOW_PUBLIC_URL}/api/webhook/app/<workflowId>/<nodeId>`: that path is reserved for app webhooks and is public
  (no sign-in; the node verifies the caller).
- **Static data.** A JSON object the host keeps per workflow and node (the hook id, a signing secret). It arrives as
  `staticData` (`{}` at first); a response carries `staticData` only when the node changed it (absent = unchanged).
  `create` stores what `delete` and `webhook` need; `delete` usually clears it.
- **`WebhookMethodResponse`** `{exists?, staticData?, logs?, error?}`. `checkExists` answers whether the hook in the
  static data is still registered (with the current URL); a node without `checkExists` always gets `create`. Over
  gRPC proto3 cannot tell `exists: false` from absent: hosts treat anything but `true` as *not registered*. `create`
  and `delete` report failures in `error` (a hook that is already gone is not an error for `delete`).
- **`WebhookRequest`** `{protocol, workflowId, node, parameters, credentials?, webhookUrl, staticData, request}` where
  `request` = `{method, path, headers (lower-case names), query, body}`. `body` is the raw body **base64** over HTTP and
  `bytes` over gRPC, exactly as sent, because signatures are computed over these bytes.
- **`WebhookResponse`** `{items?, response?, staticData?, idempotencyKey?, logs?, error?}`. `items` start a run of the
  **published** version with them as the trigger's output; no items start nothing (a ping, a rejected signature, an
  event the node ignores). `response` `{status?, headers?, body?}` is what the service gets back (default `200`
  `{"status": "started", "executionId": …}`, or `{"status": "ignored"}` without items). `idempotencyKey` identifies the
  event (GitHub's `X-GitHub-Delivery`): a redelivery within the retention window starts no second run (`{"status":
  "duplicate"}`).
- **Host behaviour.** Registration is reconciled per workflow on publish, unpublish, rollback and delete, and at boot
  (after plugins had a moment to announce). A changed trigger (parameters, credentials, URL) is deleted and created
  again. A failed `create` is shown in the editor's Publish menu and retried with backoff (1 minute doubling to an hour,
  `LANDFLOW_APP_WEBHOOK_RETRY_MS`); a trigger whose plugin is offline is retried when it comes back. Calls for a workflow
  that is not published (or whose published version has no such trigger) get `404`, a trigger whose plugin is offline
  `503`, bodies over the limit `413`, and a run the workflow's concurrency limit skips `429`.
- **Manual runs.** An app webhook trigger has no event in an editor run: `Execute` may return no items (pin data from a
  past execution to build the rest of the flow).

### Signature helpers

All three SDKs verify the common HMAC-SHA256 schemes over the raw body, with constant-time comparison and, for the
timestamped schemes, a tolerance (default 300 s) against replays:

| Scheme | TypeScript (`@landflow/sdk`) | Go | Python (`landflow_sdk.signatures`) |
|---|---|---|---|
| GitHub `X-Hub-Signature-256: sha256=<hex>` | `verifyGitHubSignature(secret, rawBody, header)`, `githubSignature` | `VerifyGitHubSignature`, `GitHubSignature` | `verify_github_signature`, `github_signature` |
| Stripe `Stripe-Signature: t=<ts>,v1=<hex>` | `verifyStripeSignature(secret, rawBody, header, { toleranceSeconds, now })`, `stripeSignature` | `VerifyStripeSignature(…, SignatureOptions{})`, `StripeSignature` | `verify_stripe_signature(…, tolerance_seconds=, now=)`, `stripe_signature` |
| Slack `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp` | `verifySlackSignature(secret, rawBody, timestamp, signature)`, `slackSignature` | `VerifySlackSignature`, `SlackSignature` | `verify_slack_signature`, `slack_signature` |
| plain HMAC (hex or base64) | `hmacSha256`, `verifyHmacSha256({ secret, payload, signature, encoding, prefix })`, `safeEqual` | `HMACSHA256Hex` / `HMACSHA256Base64`, `VerifyHMACSHA256`, `VerifyHMACSHA256Base64`, `SafeEqual` | `hmac_sha256`, `verify_hmac_sha256`, `safe_equal` |

### SDK shapes

| | TypeScript | Go | Python |
|---|---|---|---|
| lifecycle | `webhookMethods: { checkExists?, create, delete }` | `WebhookNode` (`WebhookCreate`, `WebhookDelete`, `Webhook`) + optional `WebhookChecker` | `webhook_check_exists`, `webhook_create`, `webhook_delete` on `Node` |
| incoming call | `webhook(ctx)` → `{ items, response, idempotencyKey }` or items | `Webhook(ctx) (*WebhookResult, error)` | `webhook(ctx)` → `{"items", "response", "idempotencyKey"}` or a list |
| context | `getWebhookUrl()`, `getStaticData()` / `setStaticData()`, `getNodeParameter`, `getCredentials`, `getHeader`, `getRawBody()`, `getBody()` | `WebhookURL()`, `StaticData()` / `SetStaticData`, `Param`, `Credentials`, `Header`, `RawBody()`, `Body()` / `BodyObject()` | `get_webhook_url()`, `get_static_data()` / `set_static_data()`, `get_node_parameter`, `get_credentials`, `get_header`, `get_raw_body()`, `get_body()` |

A JSON `response` is written as `{ status, json }` in TypeScript and Python (`JSONReply(status, v)` in Go): the SDK
serializes it and sets `content-type`. The GitHub Webhook Trigger in `plugins/productivity` (Python) is a complete
example: it registers a repository hook with a random secret, verifies `X-Hub-Signature-256`, answers GitHub's
`ping`, and deduplicates redeliveries by `X-GitHub-Delivery`.

## 13. Kubernetes discovery and registry proofs

With `LANDFLOW_PLUGIN_DISCOVERY=kubernetes` the host finds plugins itself: no announce, no heartbeat. It watches the
Services labelled **`landflow.dev/plugin=true`** in `LANDFLOW_K8S_NAMESPACES` (default: its own namespace; `*`: every
namespace, through one cluster-wide watch), and their EndpointSlices (which inherit the label). Announce, static seeds and scan keep working next to it; all feed the same
registry, and a discovered endpoint shows source `kubernetes` with its namespace and Service on the Plugins page.

| Service field | Meaning |
|---|---|
| label `landflow.dev/plugin: "true"` | this Service is a plugin |
| annotation `landflow.dev/grpc-port` | the gRPC port: a Service port number (`"7203"`) or name (`"grpc"`). Without it: the port named `grpc` (or `landflow-grpc`), else one with `appProtocol: grpc` / `kubernetes.io/h2c` |
| annotation `landflow.dev/http-port` | optional: also register the HTTP binding on this port (number or name) |

The endpoint is `grpc://<service>.<namespace>.svc.<LANDFLOW_K8S_CLUSTER_DOMAIN, default cluster.local>:<port>`, or the
ClusterIP with `LANDFLOW_K8S_ADDRESS=cluster-ip`. The host follows the Service's ready pods:

- **a pod becomes ready** → the host pulls the manifest (GetManifest, with a challenge when the registry secret is set,
  below); a failure is retried with backoff (1 s doubling to 30 s) while a pod stays ready;
- **the set of ready pods changes** (a rollout, a scale-up) → the manifest is pulled again, so a new version shows;
- **no pod is ready** (scaled to 0, failing readiness) → the endpoint is marked **offline**, not dropped: nodes stay
  visible and saved workflows open; the registry's health probes (every 15 s) treat it like any pulled endpoint;
- **the Service is deleted** or loses the label → the endpoint is removed, and the plugin with its last endpoint.

The manifest, health and registry proofs go through the Service, but calls (Execute, LoadOptions, TestCredentials,
webhooks) are spread over the ready pods: the host keeps a client per pod address from the EndpointSlices (the pod IP
and the Service's target port) and sends each call to the one with the fewest calls in flight. A pod that leaves is
closed once its calls finish. `LANDFLOW_K8S_SPREAD=service` keeps a single connection through the Service.

Plugins should base their readiness probe on `GET /landflow/v1/health` and set `LANDFLOW_REGISTRY_URL=off` (they are
discovered, so announcing is not needed). The watch is a list followed by a watch from its `resourceVersion`; a watch
the server closes is resumed, a failed one is retried with exponential backoff (1 s to 30 s) from a fresh list, a
`410 Gone` re-lists at once, and everything is re-listed every `LANDFLOW_K8S_RESYNC_SECONDS` (300). The host needs
`get`, `list` and `watch` on `services` and `discovery.k8s.io/endpointslices` in each namespace it watches
(`deploy/k8s/base/host/rbac.yaml`), or cluster-wide for `*` (`deploy/k8s/components/cluster-discovery`). Credentials: the pod's service account in a cluster, else the kubeconfig
(`KUBECONFIG` or `~/.kube/config`) with `LANDFLOW_K8S_CONTEXT`, or its current context when that is unset.

### Registry proofs

`LANDFLOW_REGISTRY_SECRET` on the host makes announcing plugins send the secret (`X-Landflow-Registry-Secret` or gRPC
metadata). A discovered plugin announces nothing, so the host checks it differently: on every GetManifest it sends a
random challenge and accepts the manifest only with a valid proof. The secret itself never travels.

| | Host → plugin (GetManifest request) | Plugin → host (response) |
|---|---|---|
| HTTP | header `X-Landflow-Registry-Challenge: <challenge>` | header `X-Landflow-Registry-Proof: <proof>` |
| gRPC | metadata `x-landflow-registry-challenge` | initial (header) metadata `x-landflow-registry-proof` |

`proof = hex(HMAC-SHA256(key = secret, message = "landflow-registry-proof/v1\n" + pluginId + "\n" + challenge))`,
where `pluginId` is the manifest's `plugin.id` and the challenge is 32 random bytes, base64url (43 characters; plugins
ignore challenges over 256). Test vector: secret `registry-s3cret`, plugin `test-plugin`, challenge `challenge-123` →
`d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e`.

- The three SDKs answer by themselves when `LANDFLOW_REGISTRY_SECRET` is set in the plugin's environment
  (`registryProof` / `answerRegistryChallenge` in TypeScript, `RegistryProof` in Go, `registry_proof` in Python, with
  `verify…` counterparts). Without the variable, or without a challenge, they send no proof.
- With the secret set, a discovered plugin that sends no proof ("did not prove the registry secret"), a wrong one, or
  a proof for another plugin id is not registered; the reason shows in the Plugins page's feed, and it is retried.
- The re-pull after an announce with a new `instanceId` (§2) is a GetManifest like any other: a discovered endpoint is
  challenged again and keeps its old manifest if the proof is missing or wrong (its next announce tries again); an
  endpoint registered by announcing is not challenged.
- Only Kubernetes-discovered endpoints are challenged. Announce keeps its header check; static seeds, scan and manual
  endpoints are configured on the host and are not challenged. Without the secret nothing changes.
- **Additive.** Older plugins ignore the challenge (and are then refused only if the host has a secret); older hosts
  never send one. A proof shows that whoever answered holds the secret; it does not stop a process in the Service's
  path from relaying a real plugin's answer, so who may create Services and pods in the watched namespaces matters as
  much as the secret.

## 14. Messaging (brokers)

A plugin can also be reached through a message broker: Kafka, RabbitMQ, NATS, Valkey/Redis Streams and, later, MQTT 5,
Amazon SQS, Google Pub/Sub, Azure Service Bus, AMQP 1.0 brokers and Pulsar. Both sides connect *out* to the broker, so a
brokered plugin needs no inbound port and no address the host can reach. The logical RPC is unchanged: the same seven
methods with the same JSON bodies as the HTTP binding, carried as **CloudEvents 1.0** events. The messaging core is
written once per language (`@landflow/transports` for the host and the TypeScript SDK, `sdks/go/transport` for the Go
SDK and `landflow-bridge`; Python goes through the bridge) and a small **driver** per broker only moves opaque events
between named channels. Everything in this section is what the core does; a driver never reads an event.

### 14.1 Transport kinds, endpoints and hints

| Kind | Family | | Kind | Family |
|---|---|---|---|---|
| `http` | direct (the host connects to the plugin) | | `mqtt` | broker (MQTT 5) |
| `grpc` | direct | | `sqs` | broker (Amazon SQS) |
| `kafka` | broker (Kafka, Redpanda) | | `pubsub` | broker (Google Pub/Sub) |
| `amqp` | broker (RabbitMQ, AMQP 0-9-1) | | `servicebus` | broker (Azure Service Bus) |
| `nats` | broker (NATS core and JetStream) | | `amqp1` | broker (AMQP 1.0: ActiveMQ Artemis, Qpid) |
| `valkey` | broker (Valkey / Redis Streams) | | `pulsar` | broker (Apache Pulsar) |

The kind is an **open string**: these are the kinds this version knows (`TRANSPORT_KINDS`, `TransportKind` in
`@landflow/protocol`), but a host and a plugin that agree on another kind use it as is, and spans and metrics carry
whatever kind a call took (`landflow.transport`). `in-process` (the host's core plugin) and `mcp` (§15) are not
transports the host routes node calls over.

**Endpoints.** Direct endpoints stay URLs (§2). A brokered endpoint is `<kind>://<connectionId>/<pluginId>`:

- `kind` is the transport kind, `connectionId` names a **broker connection** configured on the host (Settings →
  Transports or `LANDFLOW_TRANSPORT_<KIND>_URL`; e.g. `kafka-main`), `pluginId` the plugin. Each segment is
  `[a-z0-9][a-z0-9._-]*`, nothing follows the plugin id, and an endpoint never carries hosts, ports or passwords.
- `parseEndpoint()` / `tryParseEndpoint()` / `formatEndpoint()` / `transportKindOf()` in `@landflow/protocol` read and
  write both families. The host registers a brokered endpoint with discovery source `broker` when it sees the plugin's
  announce on the broker (§14.8); the plugin's own `POST /api/plugins/announce` may name one too, but normally does not.

**Manifest hints** (additive; gRPC `GetManifestResponse.transports = 5`, `max_concurrency = 6`):

- `transports?: string[]`: the faces this plugin process was built with (`["http", "grpc", "kafka", "mcp"]`). A hint for
  the Plugins page and the selector; an endpoint is used only when it is live, whatever this says.
- `maxConcurrency?: number`: how many calls one instance takes at once (default assumed: 16, `DEFAULT_MAX_CONCURRENCY`).
  Over brokers it is the consumer's prefetch; the selector fills a direct transport up to it and spills the rest over to
  a buffering broker.

**Node descriptor** (additive): `idempotent?: boolean` on a node, and `idempotent?: boolean` on an option of its
`operation` property (the option wins). An idempotent node may be delivered **at least once** (§14.6) and its MCP tools
carry `idempotentHint` (§15.1). `mcp`, `outputSchema` and `toolAnnotations` are MCP-only and described in §15.1.

### 14.2 Channels

Channel names are `<prefix>.v1.<role>…`; the prefix (default `landflow`, set per broker connection as
`BrokerConfig.prefix`) lets two Landflow instances share a broker and `v1` keeps a future protocol version apart. Names are `[A-Za-z0-9._-]{1,128}`; a driver
may translate characters its broker forbids, consistently in both directions.

| Role | Name | Delivery | Durable | TTL | Who consumes |
|---|---|---|---|---|---|
| request | `landflow.v1.plugin.<pluginId>` | shared (work queue) | yes | per event (the deadline) | every replica of the plugin |
| instance | `landflow.v1.instance.<pluginId>.<instanceId>` | shared | no | – | one plugin process (calls that must reach it) |
| reply | `landflow.v1.reply.<hostInstanceId>` | broadcast | no | 5 min | one host process (only when the broker has no native replies) |
| registry | `landflow.v1.registry` | broadcast | no | 60 s | every host (announce, withdraw) |
| control | `landflow.v1.control.<pluginId>` | broadcast | no | 60 s | every replica of the plugin (cancel) |

"Shared" means consumers with the same group compete for events (queue, consumer group, queue group, shared
subscription); "broadcast" means every consumer gets every event. A plugin declares its request, instance and control
channels and the registry channel when it starts; a host declares its reply channel and the registry channel, and a
plugin's request channel before the first call to it.

### 14.3 The envelope

Every brokered request, response, cancel, announce and withdraw is one CloudEvents 1.0 event. The attributes:

| Attribute | Value |
|---|---|
| `specversion` | `1.0` |
| `id` | the call id, 1–128 printable ASCII characters, unique per source; the core uses 32 hex characters. A response has its own id |
| `source` | `landflow://host/<instanceId>` or `landflow://plugin/<pluginId>/<instanceId>` (`[A-Za-z0-9._-]{1,128}` each) |
| `type` | `dev.landflow.plugin.v1.<method>.request` and `….<method>.response` with `<method>` one of `getmanifest`, `execute`, `loadoptions`, `testcredentials`, `health`, `webhookmethod`, `receivewebhook`; `dev.landflow.plugin.v1.cancel`, `….announce`, `….withdraw` |
| `subject` | the node type (`twilio.message`) when the body names one (`node.type` of Execute and the webhook methods, `nodeType` of LoadOptions); copied onto the response |
| `time` | RFC 3339, the sender's clock; a receiver refuses events more than 5 min (`clockSkewMs`) from its own |
| `datacontenttype` | `application/json` for a plain body, `application/octet-stream` for an encrypted one |
| `traceparent`, `tracestate` | the CloudEvents distributed tracing extension; copied onto the response |
| `lfreplyto` | requests only: the channel the response goes to, when the broker has no native request/reply |
| `lfcorrelation` | responses and cancels: the request's `id` |
| `lfdeadline` | requests: epoch milliseconds after which the call must not run (decimal digits) |
| `lfattempt` | requests: the sender's delivery attempt, `1` on the first send |
| `lfidempotency` | requests: `ExecuteRequest.idempotencyKey` (1–256 printable characters) |
| `lfdelivery` | requests: the mode the sender asks for, `at-most-once` or `at-least-once` (§14.6) |
| `lfmanifest` | requests: the manifest hash the sender knows for the plugin; responses and announces: the plugin's own (hex, 8–64 chars) |
| `lferror` | responses: an error code (§14.6); the body is then `{ "error": "<message>", … }` |
| `lfenc` | `aes-256-gcm` when the body is encrypted (§14.7) |
| `lfkeyid` | the id of the key that signed (and encrypted) the event, hex 8–32 chars |
| `lfsig` | hex HMAC-SHA256 over every other attribute and the body digest (§14.7) |

All values are strings of printable ASCII (`0x20`–`0x7e`), so they survive every broker's header encoding. A receiver
validates every attribute against these rules and **drops** anything that fails (counted, logged, never processed).
Attributes it does not know are dropped before verification, so they are never signed and never trusted.

**Body.** The HTTP binding's JSON for the method: `ExecuteRequest` → `ExecuteResponse`, `LoadOptionsRequest` →
`LoadOptionsResponse`, and so on; `GetManifest` and `Health` requests carry `{}` and answer with the `PluginManifest`
and `HealthResponse`. The announce, withdraw and cancel bodies are in §14.5 and §14.8. A node failure is a normal
response with `error` set, as over HTTP.

**Two modes.** When the broker carries string headers with each message (`capabilities.headers`), the event is in
CloudEvents **binary mode**: every attribute is a header under its bare name (`specversion`, `id`, `lfsig`, …), plus
`content-type` = `datacontenttype`, and the body is the message payload. The driver applies its protocol binding's
prefix: `ce_` for Kafka, `cloudEvents_` for AMQP 0-9-1, `ce-` for NATS, none for MQTT 5 user properties, and the
`ce_`-prefixed message attributes of SQS and Pub/Sub. Without headers (or with a header budget too small: SQS allows 10
attributes), the event is in **structured mode**: one JSON document `{ "specversion": "1.0", "id": …, "data": <body> }`
(or `"data_base64"` when the body is encrypted) with `content-type: application/cloudevents+json`. A receiver tells
them apart by the presence of a `specversion` header.

### 14.4 Request and response

1. The host builds the request event (`id`, `source` = its host source, `type` = the method's `.request` type,
   `subject`, `time`, `lfdeadline`, `lfattempt`, `lfdelivery`, `lfidempotency`, `lfmanifest`; `lfreplyto` = its reply
   channel unless the broker replies natively), encrypts and signs it (§14.7) and publishes it on the plugin's
   **request channel**, or on an **instance channel** for a call that must reach one process. The ordering key, where the
   broker has one, is the execution id, so one run's calls stay in order and on one partition.
2. A replica consumes it, verifies it, checks the deadline, cancellation and manifest hash (§14.5, §14.6), and runs the
   dispatcher with an `AbortSignal`.
3. It publishes the response (`type` = `.response`, `lfcorrelation` = the request's `id`, `lfmanifest` = its own hash,
   the request's `subject`, `traceparent` and `tracestate`) through the broker's native reply (NATS inbox, RabbitMQ
   direct reply-to, MQTT response topic) or on `lfreplyto`. An error that is not a node failure sets `lferror`.
4. The host correlates the response by `lfcorrelation` and resolves the call; a response for a call it no longer waits
   for is ignored.

Native replies live with the connection: when a RabbitMQ or NATS connection drops, every call in flight on it fails
with `connection_lost` ("the call may have run"), never a silent wait. A plugin that cannot send its response (the
broker refused it) requeues an at-least-once delivery and otherwise lets the host's deadline fail the call.

**Manifest hash.** `lfmanifest` is `hex(SHA-256(JSON.stringify(manifest)))[0..16]` over the manifest exactly as the
plugin serves it; the host keeps the hash it learned from the announce or the last `GetManifest`.

### 14.5 Deadlines and cancellation

- Every request carries an absolute deadline (`lfdeadline`; default 30 s after sending, the host's per-call timeout
  otherwise). The host fails the call at the deadline with "no reply … the call may have run" (code `expired` in the
  conformance kit; the typed `TimeoutError` of `@landflow/transports`) and ignores any later response. The deadline is
  also the publish TTL where the broker has one: a first filter only.
- A consumer checks `lfdeadline` before dispatch: an expired request is acknowledged and dropped without running (the
  host has failed it already). While a call runs, its `AbortSignal` fires at the deadline and the response then carries
  `lferror: expired` (if it gets out at all).
- **Cancel.** When the caller aborts, the host publishes `dev.landflow.plugin.v1.cancel` on the plugin's **control
  channel** with `lfcorrelation` = the call id and the plain body `{ "callId": "<id>", "reason": "<message>" }` (signed,
  not encrypted). Every replica sees it:
  the one running the call aborts its signal and answers `lferror: cancelled` with `{ "error": "<reason>" }`; a cancel
  that arrives before its request makes the request be acknowledged and dropped when it comes (cancels are remembered
  for 60 s). The caller's own outcome is `cancelled` as soon as it aborts; a response that still arrives is ignored.
- A cancelled or expired call is a **transport error on the caller's side**, never a node error: retries and "continue
  on fail" do not treat it as the node failing.

### 14.6 Delivery rules

- **At most once by default.** The consumer acknowledges an `Execute` *before* running it, so a crash mid-call never
  runs a node twice. If the plugin dies, the host's deadline fails the node ("the plugin went away; the call may have
  run") and the node's own retry settings decide what happens next.
- **At least once** when the host asks for it (`lfdelivery: at-least-once`) *and* the work is safe to repeat: every
  method but `Execute`, and an `Execute` of a node (or operation) the manifest marks `idempotent`. The consumer then
  holds the delivery (and its prefetch slot) and acknowledges after the response is out; if the process dies first, the
  broker redelivers to another replica. The host asks for `at-least-once` for `LoadOptions`, `TestCredentials`,
  `Health`, `GetManifest` and the webhook methods, and for `Execute` of idempotent nodes; a plugin never upgrades an
  `Execute` to at-least-once on its own. `lfattempt` (and `Delivery.attempt` from the driver) tells the node which
  delivery this is.
- **Concurrency.** Each instance consumes with prefetch = its `maxConcurrency`: at most that many calls at once.
- **Version skew.** A consumer whose manifest hash differs from `lfmanifest` puts the request back once (nack with
  requeue) so a replica on the right version can take it; on the next delivery it acknowledges and answers
  `lferror: manifest_mismatch` with `{ "error", "manifestHash" }`. The host pulls the manifest again and retries. The
  node never runs on a mismatch.
- **Size.** The encoded event (headers plus body) must fit the driver's `maxMessageBytes` (and `maxHeaderBytes` where
  the broker has a header budget). The host refuses a request that does not fit *before* publishing (`too_large`, a
  provably undelivered error, so the selector may use another transport). A plugin whose response does not fit answers
  `lferror: too_large` with `{ "error" }` instead. Carrying oversized bodies by reference through the shared binary
  store (a claim check) is planned and not part of this version; files already travel as references (§11).
- **Error codes** (`lferror`): `expired`, `cancelled`, `too_large`, `not_found` (no such node type, load-options method
  or credential type), `bad_request` (the body does not validate), `internal` (the dispatcher threw), `unavailable` (the
  plugin is draining) and `manifest_mismatch`. The body is `{ "error": "<message>", …details }`. On the caller's side
  these are *delivered* errors and are never retried blindly. Failures the caller detects itself are `unroutable` (the
  broker said at once that nobody can take the event), `no_consumers` (every announced instance stopped heartbeating,
  or the channel shows zero consumers), `not_connected` (nothing was published), `expired` and `connection_lost` (the
  call may have run). Only `unroutable`, `no_consumers`, `not_connected` and `too_large` are **provably undelivered**:
  those alone let the host send the same call over another transport.

### 14.7 Security over brokers

Most brokers keep messages on disk and an `ExecuteRequest` carries decrypted credentials, so every event is encrypted
end to end and signed. Nothing here depends on the broker's own security (TLS and per-plugin broker users are still
recommended; `deploy/README.md` has an example per broker).

- **Secret.** One shared secret, `LANDFLOW_TRANSPORT_SECRET` (falling back to `LANDFLOW_REGISTRY_SECRET`), known to the
  host and to every plugin; a plugin without it cannot start a messaging binding, a host without it never uses a
  brokered endpoint. Rotation: `LANDFLOW_TRANSPORT_SECRET_PREVIOUS` (comma-separated) lists secrets that still verify
  and decrypt but no longer sign.
- **Keys.** Per plugin, two 32-byte keys by HKDF-SHA256 over the secret (no salt):
  `encKey = HKDF(secret, info = "landflow transport v1\n" + pluginId + "\nenc")` and
  `sigKey = HKDF(secret, info = "landflow transport v1\n" + pluginId + "\nsig")`. Every replica of a plugin derives the
  same keys, so work sharing works; whoever reads the broker learns nothing. The key id travelling as `lfkeyid` is
  `hex(SHA-256("landflow transport keyid v1\n" + secret))[0..16]`.
- **Encryption.** The **whole body** of every request and response is encrypted (not only the credentials: they sit in
  different fields per method and the items themselves hold personal data), AES-256-GCM with a random 96-bit nonce,
  `body = nonce ‖ ciphertext ‖ tag` (16-byte tag), additional authenticated data `id + "\n" + type`. The attributes stay
  in clear so routing, tracing and archiving by metadata keep working. Announce, withdraw and cancel bodies hold no
  secrets and stay plain (`datacontenttype: application/json`, no `lfenc`) so broker-side tooling can read the registry
  channel.
- **Signing** (encrypt-then-MAC). `lfsig = hex(HMAC-SHA256(sigKey, canonical))` where the canonical form is one line
  per attribute present, in the order `specversion, id, source, type, subject, time, datacontenttype, traceparent,
  tracestate, lfreplyto, lfcorrelation, lfdeadline, lfattempt, lfidempotency, lfdelivery, lfmanifest, lferror, lfenc,
  lfkeyid` (never `lfsig`), as `name=value\n`, followed by `hex(SHA-256(body))\n` over the on-wire body bytes (the
  ciphertext when encrypted).
- **Verification.** A receiver refuses unsigned events, unknown key ids, bad signatures (constant-time compare), a
  `time` outside the clock-skew window, ids it has already accepted within the replay window (10 min), and a body that
  does not decrypt. Refused events are dropped without a response (nack without requeue; the caller sees its deadline)
  and counted.
- **Registry proof.** An announce also carries `registryProof` (§13's format with the event `id` as the challenge:
  `hex(HMAC-SHA256(LANDFLOW_REGISTRY_SECRET, "landflow-registry-proof/v1\n" + pluginId + "\n" + id))`); a host that has
  the registry secret ignores announces without a valid one.

### 14.8 Announce and discovery

A brokered plugin announces itself on the **registry channel** when it starts and every 10 s after (the heartbeat), and
withdraws when it stops. The host consumes the channel, verifies each event, and keeps the plugin with its brokered
endpoint and its instances; an instance that misses its heartbeats for `ttlSeconds` (30 s by default) expires.

```jsonc
// type dev.landflow.plugin.v1.announce, source landflow://plugin/<pluginId>/<instanceId>, lfmanifest = manifestHash
{ "protocol": "landflow.plugin/v1", "pluginId": "twilio", "version": "0.1.0", "instanceId": "3f9c…",
  "manifestHash": "9b2e4c7d1a0f3e5b", "endpoint": "kafka://kafka-main/twilio", "maxConcurrency": 16, "ttlSeconds": 30,
  "registryProof": "d6d4…" }
// type dev.landflow.plugin.v1.withdraw
{ "pluginId": "twilio", "instanceId": "3f9c…", "endpoint": "kafka://kafka-main/twilio" }
```

The body's `pluginId` and `instanceId` must match the event's `source`, or the event is ignored. On the first announce
of a plugin (or when `manifestHash` or `version` changes) the host pulls the manifest *over the broker* (`GetManifest`,
at least once) and registers the endpoint `<kind>://<connectionId>/<pluginId>` with discovery source `broker`; the
`connectionId` is the host's own name for the broker connection the announce arrived on. A plugin's `instanceId` is
the same one it sends in HTTP announces (§2), so a plugin reachable over several transports is one plugin with several
endpoints. A withdraw, or an expired lease, marks the instance gone; the endpoint goes offline when no instance is
left and stays known, as for direct endpoints.

### 14.9 Broker bindings

How the core's needs map onto each broker. `maxMessageBytes` are the drivers' defaults (a connection can set the real
limit); "mode" is the CloudEvents mode (§14.3).

| Broker | Request channel; replicas share it by | Replies | Mode, header prefix | Buffering | TTL | "Nobody took it" | Persistence | Default max | Attempts |
|---|---|---|---|---|---|---|---|---|---|
| **Kafka** (Redpanda) | a topic per plugin; a share group on Kafka 4.x, else a consumer group (parallelism up to the partition count); record key = ordering key | reply topic per host | binary, `ce_` | yes (the log) | no: the consumer checks the deadline | inferred (consumer group members) | disk | 1 MiB | no (commit offsets; at-most-once commits before running) |
| **RabbitMQ** (AMQP 0-9-1) | a queue per plugin; competing consumers, prefetch = `maxConcurrency` | direct reply-to (`amq.rabbitmq.reply-to`) | binary, `cloudEvents_` | yes | per-message `expiration` | reported (`mandatory` returns) | disk (durable queues) | 128 MiB (server default) | yes (`redelivered`) |
| **NATS** core | a subject per plugin; a queue group | inboxes | binary, `ce-` | no | no | reported ("no responders") | memory | 1 MiB | no |
| **NATS JetStream** | a work-queue stream and a durable consumer per plugin | inboxes | binary, `ce-` | yes | `max_age` + the deadline | inferred (consumer info) | disk | 1 MiB | yes (`num_delivered`) |
| **Valkey / Redis Streams** | a stream per plugin; a consumer group (`XREADGROUP`), pending entries claimed after a crash (`XAUTOCLAIM`) | a reply stream per host | structured (no headers) | yes | no (`MAXLEN` trimming + the deadline) | inferred (`XINFO GROUPS`) | disk | 512 MiB (string limit; the driver caps at 1 MiB) | yes (delivery count) |
| MQTT 5 | a topic per plugin; a shared subscription (`$share/<group>/…`) | response topic + correlation data | binary, user properties (no prefix) | broker-dependent (QoS 1 with persistent sessions) | message expiry interval | unknown | memory/disk | 256 MiB (protocol); driver default 1 MiB | no |
| Amazon SQS | a queue per plugin (long polling) | a reply queue per host | structured (10 attributes max) | yes | none per message; the deadline | inferred (approximate counts) | disk | 1 MiB | yes (`ApproximateReceiveCount`); visibility timeout redelivers |
| Google Pub/Sub | a topic and a subscription per plugin | a reply subscription per host | binary, attributes `ce_` (100 max) | yes | ack deadline + the deadline | inferred | disk | 10 MB | yes (`delivery_attempt`) |
| Azure Service Bus | a queue per plugin | a session-enabled reply queue (`ReplyToSessionId`) | binary, application properties (64 KB budget) | yes | `TimeToLive` | inferred (message counts) | disk | 256 KB Standard, 1 MB Premium | yes (`DeliveryCount`); locks redeliver |
| AMQP 1.0 (Artemis, Qpid) | an address per plugin; competing receivers | reply-to address | binary, application properties `cloudEvents_` | yes | `ttl` | inferred | disk | 1 MiB | yes (`delivery-count`) |
| Apache Pulsar | a topic per plugin; a shared subscription | a reply topic per host | binary, properties `ce_` | yes | message TTL | inferred (subscription stats) | disk | 5 MB | yes (`redeliveryCount`) |

Differences the core absorbs, so drivers stay small: correlation goes in the envelope (`lfreplyto`, `lfcorrelation`)
wherever the broker has no reply semantics; native replies end with the connection (§14.4); only NATS and RabbitMQ say
"nobody took it" at once, elsewhere the host infers it from registry heartbeats and consumer counts, and otherwise waits
for the deadline; tight header budgets force structured mode; every redelivery mechanism (visibility timeouts, locks,
ack waits, pending entries) becomes `lfattempt` and the rules of §14.6. Each driver passes the driver conformance suite
(`@landflow/transports/conformance`, `runConformance()`) against a local container before it ships; the SDK × face
fixtures stay in `packages/protocol/conformance/`.

## 15. MCP

Every plugin is also an MCP server, with no code in the plugin: the SDK derives the tools from the node descriptors
(§15.1) and serves them itself (§15.3), and the host serves one MCP endpoint per plugin behind the bundled gateway
(§15.4, §15.5). The MCP face targets the current MCP revision (2026-07-28): stateless requests, Streamable HTTP and
stdio, OAuth 2.1 with protected resource metadata at the gateway. The mapping is a pure, shared function in
`@landflow/protocol` (`mcpToolsFromManifest()`), so a plugin lists the same tools wherever it is reached.

### 15.1 From node to tool

**Which nodes.** Action nodes flagged `usableAsTool` (every action node, by the plugin design rules), minus nodes with
`mcp: false` and operations whose `operation` option has `mcp: false` (a `resource` option with `mcp: false` removes
every operation of that resource). Triggers and sub-nodes are never tools.

**One tool per operation.** n8n-style nodes carry a `resource` dropdown and one or more `operation` dropdowns shown per
resource (`displayOptions.show.resource`). Each (resource, operation) pair is one tool; `operation` properties split by
another condition (one per authentication method) are merged per resource, so a tool exists whatever the auth method.
Only static `options` properties named `resource` and `operation` at the top level count.

**Names** (`[A-Za-z0-9_-]{1,64}`: the MCP spec allows 128 characters and `.`, the strictest common client 64):

| Node | On the plugin's endpoint | On the gateway (`<pluginId>_<tool>`) |
|---|---|---|
| `resource` × `operation`, node named after its plugin (`twilio.twilio`) | `message_send` | `twilio_message_send` |
| `resource` × `operation`, a plugin with several apps (`messaging.telegram`, `messaging.slack` both have `message`) | `telegram_message_sendMessage`, `slack_message_post` | `messaging_telegram_message_sendMessage` |
| `operation` only (`databases.postgres`) | `postgres_select` | `databases_postgres_select` |
| neither (`go-crypto.hash`) | `hash` | `go-crypto_hash` |

Characters outside the set become `_`, runs collapse, names are cut to 64; a name that is still taken gets `_2`, `_3`…
(`sanitizeToolName()`, `gatewayToolName()`). Names are unique per plugin, and tests check this for every bundled plugin.

**`title`** is `<node displayName> · <resource name> · <operation name>` (what exists of it); **`description`** is the
operation's `action` (else its `description`, else its name) followed by the node's `toolDescription` (else
`description`).

**`inputSchema`** is JSON Schema 2020-12, `type: object`, with one property per node property *shown for that resource
and operation*: a property's `displayOptions` conditions on `resource` and `operation` must hold; conditions on other
parameters (ones the agent may set) are ignored and noted in the description ("Only used when `channel` is `sms`.").
Excluded: `resource` and `operation` themselves, `notice` and `hidden` properties, and **credential selectors**: an
`options` property the node's `credentials[].displayOptions` switch on (`authentication`), which the host sets from the
credential it binds (`_meta` carries `credentialSelectors: [{ parameter, byCredential: { <type>: <value> } }]`).
Credentials are never arguments. Per property type:

| Property | JSON Schema |
|---|---|
| `string`, `color` | `{ type: "string" }`; `code` adds "`<language>` code." to the description |
| `dateTime` | `{ type: "string", format: "date-time" }` |
| `number` | `{ type: "number" }`, or `integer` when `typeOptions.numberPrecision` is 0; `minimum`/`maximum` from `minValue`/`maxValue` |
| `boolean` | `{ type: "boolean" }` |
| `json` | `{ type: ["object", "array", "string"] }` (an object or array, or JSON text) |
| `options`, static | `{ type: <the values' type>, enum: [values] }` (`type` omitted when the values mix types); the option names go into the description: "One of: `sms` (SMS), `whatsapp` (WhatsApp: …)" |
| `options`, dynamic (`typeOptions.loadOptionsMethod`) | `{ type: "string" }` plus "Values come from the connected account (a dynamic list); pass the id or value, not the label."; `_meta` lists it under `dynamicOptions: [{ parameter, method, dependsOn? }]` so a host that holds a credential can offer the values (a `list_options` tool, or `enum` when cached) |
| `multiOptions` | `{ type: "array", items: <as options> }` ("Any of: …") |
| `collection` | `{ type: "object", properties: <its values, recursively> }` |
| `fixedCollection` | `{ type: "object", properties: { <group>: <group object> } }`, each group an array of that object when `typeOptions.multipleValues` |

Every property carries `title` (its `displayName`), `description` (from `description`, else `hint`, plus the notes
above) and `default` when the descriptor has one (not for collections); `required: true` puts it in `required`.

*Why `enum` with names in the description, not `oneOf: [{ const, title }]` or `enumNames`:* `oneOf` at property level
is flattened or rejected by several MCP clients and model providers when they turn tool schemas into function
definitions, so the titles would be lost or the tool refused; `enumNames` is a draft-04-era extension, not 2020-12,
and fails strict validators. A plain `enum` is understood everywhere, and the description keeps the labels. The same
reasoning gives `json` a type array rather than `anyOf`.

**Annotations** (MCP `ToolAnnotations`; hints, not a security boundary), always all four:

| Hint | Derived from |
|---|---|
| `readOnlyHint` | the operation value (or the node name when there is none) starts with `get`, `getAll`, `getMany`, `list`, `search`, `read`, `find`, `fetch`, `describe`, `count`, `exists`, `check`, `download`, `select`, `info`, `keys`, `llen`, `lookup`, `retrieve`, `view`, `show`, `preview` or `head` as a camel-case word |
| `destructiveHint` | not read-only, and it starts with `delete`, `remove`, `destroy`, `drop`, `purge`, `archive`, `trash`, `clear`, `truncate`, `revoke` or `unpublish` |
| `idempotentHint` | read-only, or the operation option's `idempotent` (else the node's `idempotent`) |
| `openWorldHint` | `true` |

The node's `toolAnnotations` override the derived values, and the operation option's `toolAnnotations` override those;
`title` is the tool's title. **`outputSchema`**: when the node (or the operation option, which wins) declares
`outputSchema` (the schema of one output item's `json`), the tool declares
`{ type: "object", properties: { items: { type: "array", items: <it> } }, required: ["items"] }`, the shape of its
`structuredContent`.

**Binding.** Each tool definition carries its node under `_meta["dev.landflow/node"]`: `pluginId`, `nodeType`,
`nodeName`, `typeVersion` (the node's default version), `resource`, `operation`, `fixedParameters` (`{ resource,
operation }`), `arguments` (the top-level argument names), `credentials` (the credential types the node can use),
`credentialSelectors` and `dynamicOptions`. Servers may strip `_meta` from what they list (`withoutBinding()`).

**Back from a call** (`toolCallToParameters()`): the node's parameters are `fixedParameters` with the arguments the
tool declares merged over them; arguments the schema does not know are dropped and reported. Defaults of unset
properties come from the descriptor as for any node (§3). The call becomes an `ExecuteRequest` with `mode: "mcp"`, the
parameters resolved (no expressions: arguments are literal values), `itemParameters: [parameters]`, one input item
`{ json: <arguments> }`, the bound credentials, and a deadline from the client's request. The result is the node's first
output: `structuredContent: { items: [<item.json>…] }`, a short text summary (the item count, or the first item for a
single one), `isError: true` with the node error's message and description for a failed node; files in the output
become `resource_link` content (the host signs a URL to its binary store; small images and audio go inline). Closing
the request's stream (HTTP) or `notifications/cancelled` (stdio) aborts the call's signal (§14.5).

### 15.2 The plugin's own MCP endpoint

The SDKs add an MCP face to every plugin unless `LANDFLOW_MCP=off`:

- **Streamable HTTP at `/mcp`** on the plugin's HTTP port (`serve(plugin, { http })` in TypeScript; the Go and Python
  SDKs alike), stateless (no session id). `GET /.well-known/landflow` lists it as `endpoints.mcp` when it is on.
- **stdio** with `--mcp-stdio` (or `LANDFLOW_MCP=stdio`): the plugin speaks MCP on stdin/stdout and nothing else (no
  announce, no HTTP), so a desktop agent can start it directly.
- **Token.** `/mcp` needs `Authorization: Bearer $LANDFLOW_MCP_TOKEN` unless the server listens on loopback only; a
  missing or wrong token is `401` with `WWW-Authenticate: Bearer`. stdio needs none.
- **Credentials** come from `LANDFLOW_MCP_CREDENTIALS`: a path to a JSON file, or inline JSON, `{ "<credentialType>":
  { …fields } }` by local type name. A tool whose node needs a credential that is not configured answers
  `isError: true` naming the missing type and fields; it never asks the agent for them.
- `tools/list` is the mapping of §15.1 over the plugin's own manifest (nothing is filtered; there are no grants here);
  `tools/call` runs the dispatcher in process, with the call's `AbortSignal`. A `list_options` tool
  (`{ tool, parameter, arguments? }` → the `LoadOptions` result) exists when at least one tool has dynamic options and
  a credential is configured.
- Spans: `plugin.execute …` as for every face, plus `mcp.tool.name`; `landflow.transport` is `mcp`.

### 15.3 The host's per-plugin MCP endpoints

The host serves one MCP server per online plugin at **`/api/mcp/plugins/<pluginId>`**, and the in-process core nodes
(HTTP Request, Data Table, Code…) at **`/api/mcp/plugins/core`**. Streamable HTTP, stateless, JSON responses.

- **Who may call.** A request carries either the gateway secret (`x-landflow-gateway: $LANDFLOW_MCP_GATEWAY_SECRET`)
  with the caller's identity (`x-landflow-caller-iss`, `x-landflow-caller-sub`, set by the gateway from the validated
  token; the host trusts them only together with the secret), or a signed-in session (for the tool browser in Settings).
  Anything else is `401`. The issuer and subject map to a Landflow user through the SSO link, or to the user a
  Landflow-issued MCP token belongs to (`iss` = the instance's `LANDFLOW_PUBLIC_URL`, `sub` = the user id, `jti` checked
  against revocation); an unknown caller gets an empty tool list and `-32602` on every call.
- **`tools/list`** is §15.1 over the plugin's current manifest, **filtered by the caller's grants** (§15.5) and the
  governance allow-lists, served with `cacheScope: private`. Tools opt out with `mcp: false` as everywhere. When the
  plugin's manifest changes, clients subscribed on `subscriptions/listen` get `notifications/tools/list_changed`.
- **`tools/call`** checks the grant, binds the granted credential (and sets the credential selector), records an
  **execution with mode `mcp`** (workflow-less, one node, visible in Executions with the caller), audits
  `mcp.tool.call` (tool, outcome, ids, caller; never the arguments), and runs the node **through the transport
  selector** like any workflow node, so agents get the same transports, breaker and spill-over. Destructive tools whose
  grant requires approval return `input_required` elicitation (where the client supports it) or park the call in
  Landflow's approvals; the host keeps the pending call until the client retries with the approval id.
- The result shape is §15.1's; `resource_link`s point at `/api/binary/<id>` URLs signed for the caller.
- Spans: `mcp.tool.call {tool}` (`mcp.tool.name`, `landflow.plugin.id`, `landflow.mcp.caller`) around the normal
  `plugin.rpc` span; metrics `landflow.mcp.tool.calls` (`landflow.plugin.id`, `mcp.tool.name`, outcome).

### 15.4 Gateway registration and identity

The bundled gateway is [agentgateway](https://github.com/agentgateway/agentgateway), one sidecar per main
(`docs/transports.md`, "The bundled MCP gateway"). The host's `McpGatewaySync` keeps the gateway's targets equal to the
plugins that are online, exposed to agents ("Expose to agents", on by default) and have at least one tool; it reacts to
registry events and reconciles every 30 s, and touches only the targets it created.

- **Target** per plugin, written through the config API (`PUT /api/config/resources/mcp.target`, `DELETE …/{name}` on
  the admin port, loopback only) or, with `LANDFLOW_MCP_GATEWAY=file`, into a YAML file the gateway reloads:

  ```json
  { "name": "twilio", "mcp": { "host": "http://127.0.0.1:3000/api/mcp/plugins/twilio" },
    "policies": { "backendAuth": { "key": { "value": "<LANDFLOW_MCP_GATEWAY_SECRET>", "location": { "header": { "name": "x-landflow-gateway" } } } },
                  "transformations": { "request": { "set": { "x-landflow-caller-iss": "jwt.iss", "x-landflow-caller-sub": "jwt.sub" },
                                                    "remove": ["authorization"] } } } }
  ```

  The target's id is its `name`. The transformation **overwrites** any such headers a client sent, and the gateway
  never forwards the caller's token (`remove` drops the client's `Authorization` header as well; the shape was verified
  against agentgateway 1.6.0, `docs/mcp-gateway.md`).
- **URLs.** `/mcp` on the gateway lists every plugin's tools with the plugin prefix (`prefixMode: always`:
  `twilio_message_send`, exactly `gatewayToolName()`), `failureMode: failOpen`; `/mcp/plugins/<pluginId>` serves one
  plugin, unprefixed. In dev the gateway is `http://127.0.0.1:54000`.
- **Sign-in.** Agents authenticate at the gateway with OAuth 2.1 per the MCP authorization spec: protected resource
  metadata at `/.well-known/oauth-protected-resource/mcp`, `401` with `WWW-Authenticate`, JWT validation against the
  instance's identity provider (Keycloak in dev; Okta, Entra, Auth0… through presets) or against Landflow's own JWKS at
  `/api/mcp/jwks` for Landflow-issued MCP tokens (Settings → MCP, shown once, with an expiry; `jti` revocable).
- **Descriptions.** Per plugin a `server.json` (MCP Registry schema `2025-12-11`: `name` `<LANDFLOW_MCP_NAMESPACE,
  default local.landflow>/<pluginId>`, `version`, `remotes[]` = the gateway URL, Landflow hints under
  `_meta["dev.landflow/plugin"]`: plugin id, transports, health), a read-only registry API at
  `/api/mcp/registry/v0.1/servers` (`/{name}/versions`, `/{name}/versions/latest`, cursor pagination, status `active` /
  `deprecated` / `deleted`), and a Server Card (SEP-2127) at the gateway URL plus `/server-card`.

### 15.5 Grants

A **tool grant** says which tools a caller may use and which credential each tool uses. The host stores them (Settings →
MCP, `/api/mcp/grants`); every `tools/list` is filtered by them and every `tools/call` checks them.

```ts
interface McpToolGrant {
  id: string;
  /** Who: a user, a group, or everyone in a project. */
  subject: { kind: 'user' | 'group' | 'project'; id: string };
  pluginId: string;                       // or 'core'
  /** Tool names on the plugin's endpoint (§15.1), or '*' for every tool of the plugin; `!name` excludes one. */
  tools: string[] | '*';
  /** The credential to bind per credential type the plugin's nodes use, from the project's credentials. */
  credentials: Record<string, string>;    // credentialType → credential id
  /** Destructive tools need an approval before they run (default: instance setting). */
  requireApproval?: boolean;
  createdBy: string;
  createdAt: string;
}
```

A caller's effective tool set is the union of the grants that apply to them (their user, their groups, their
projects), minus the governance allow-lists of the instance, project and workflow. A tool with no applicable grant is
not listed and cannot be called; a tool whose node needs a credential type the grant does not bind is listed but
answers `isError: true` naming the missing type. The agent never sees a credential: the host binds it on the way to the
plugin, over whatever transport the selector picks.
