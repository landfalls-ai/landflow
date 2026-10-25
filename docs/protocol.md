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
Services labelled **`landflow.dev/plugin=true`** in `LANDFLOW_K8S_NAMESPACES` (default: its own namespace), and their
EndpointSlices (which inherit the label). Announce, static seeds and scan keep working next to it; all feed the same
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

Plugins should base their readiness probe on `GET /landflow/v1/health` and set `LANDFLOW_REGISTRY_URL=off` (they are
discovered, so announcing is not needed). The watch is a list followed by a watch from its `resourceVersion`; a watch
the server closes is resumed, a failed one is retried with exponential backoff (1 s to 30 s) from a fresh list, a
`410 Gone` re-lists at once, and everything is re-listed every `LANDFLOW_K8S_RESYNC_SECONDS` (300). The host needs
`get`, `list` and `watch` on `services` and `discovery.k8s.io/endpointslices` in each namespace it watches
(`deploy/k8s/base/host/rbac.yaml`). Credentials: the pod's service account in a cluster, else the kubeconfig
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
