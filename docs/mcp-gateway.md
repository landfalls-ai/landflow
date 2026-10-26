# agentgateway in Landflow: what we verified

The phase 0 spike of [transports.md](transports.md) ("The bundled MCP gateway"): agentgateway running in the dev
infra stack, targets registered through its config API, the identity headers, sign-in through Keycloak, the file
fallback. Everything below was run on 2026-10-26 with `deploy/scripts/mcp-gateway-spike.mjs` (Node 22, no
dependencies) against the containers of `deploy/compose.infra.yml`; rerun it any time:

```bash
docker compose -f deploy/compose.infra.yml --profile mcp-gateway --profile auth up -d --wait
node deploy/scripts/mcp-gateway-spike.mjs --all        # core + stateful + auth + file: 46 checks, about 2 minutes
node deploy/scripts/mcp-gateway-spike.mjs              # core only, against the running gateway, 10 s
```

The script starts two fake MCP upstreams on `127.0.0.1:7600` (stateless) and `:7601` (stateful), speaking both the
classic `initialize` flow and 2026-07-28; the gateway reaches them as `host.docker.internal:760x`. The `--auth`,
`--file` and `--stateful` phases recreate the `mcp-gateway` container with an override file and put it back on the
default config at the end; `--auth` creates a Keycloak realm `landflow-mcp-test` (client, two groups, three users) and
deletes it.

## Versions

| | Version | Notes |
|---|---|---|
| agentgateway | **1.6.0** (`cr.agentgateway.dev/agentgateway:v1.6.0`, index digest `sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c`, linux/arm64 and amd64) | Released 2026-10-02; 1.7.0-alpha.1 exists. Distroless image (no shell: no Docker healthcheck, no `docker exec`); runs as uid 65532 |
| MCP in agentgateway | rmcp 3.4.0: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, **`2026-07-28`** | `server/discover`, per-request `_meta`, `subscriptions/listen` are implemented; see "Protocol versions" |
| `@modelcontextprotocol/sdk` in `apps/web` | 1.32.1, latest `2025-11-25` | Does **not** speak 2026-07-28 (no `server/discover`, rejects the `MCP-Protocol-Version: 2026-07-28` header with 400). The host's MCP endpoints (phase 3) need a newer SDK or a raw implementation of the 2026-07-28 methods |
| Keycloak | 26.0 (profile `auth`) | preset `provider: keycloak` works; JWKS fetched on the infra network |

## Running it

`deploy/compose.infra.yml`, profile `mcp-gateway`: MCP on `http://127.0.0.1:54000/mcp`, admin API and UI on
`http://127.0.0.1:55000` (`/ui`, `/api/config/resources/<kind>`; no authentication, so published on loopback only;
inside the container it listens on `0.0.0.0:15000` because Docker can't publish a loopback listener). The base config
is `deploy/mcp-gateway/config.yaml`:

```yaml
config:
  adminAddr: "0.0.0.0:15000"
  storage: { mode: hybrid }                       # this file is the read-only baseline, SQLite holds the API-written resources
  database: { url: sqlite:///data/agentgateway.db }
  logging: { level: info }
frontendPolicies:
  tracing:                                        # config.tracing is deprecated in 1.6; this is the current place
    host: jaeger:4318
    protocol: http
    randomSampling: true
    resources: { service.name: '"landflow-mcp-gateway"' }
gateways:
  default: { port: 4000 }
mcp:
  gateways: default
  prefixMode: always                              # tools are <target>_<tool>
  failureMode: failOpen                           # one dead upstream doesn't hide the others
  statefulMode: stateless                         # no Mcp-Session-Id; every request stands alone
  server: { name: landflow-mcp-gateway, version: dev, title: Landflow, instructions: ... }
  targets: []                                     # the host writes these through the API
```

Notes from running it:

- The SQLite volume must belong to uid 65532: the image can't `chown`, so a one-shot `mcp-gateway-init` (alpine)
  service does it (`depends_on: service_completed_successfully`). In Kubernetes this is `fsGroup`.
- `--validate-only -f config.yaml` validates the file; with `mcpAuthentication` it also fetches the JWKS, so the
  auth config only validates (and the gateway only starts) when Keycloak and the realm exist. Startup with an
  unreachable JWKS is a hard error, not a retry.
- With Jaeger down the tracing exporter logs errors and otherwise does nothing; `host: jaeger:4318` resolves only on
  the `landflow-infra` network (profile `observability`).
- Readiness: `GET http://mcp-gateway:15021/healthz/ready` → `ready` (not published). Metrics: `GET
  http://mcp-gateway:15020/metrics` (not published; from the Mac `docker run --rm --network landflow-infra alpine:3.22
  wget -qO- http://mcp-gateway:15020/metrics`).
- `GET /api/version` on the admin port returns an empty body in 1.6.0; `agentgateway -V` prints `1.6.0`.
- A POST to `/mcp` whose `Accept` lacks `text/event-stream` gets **406**; send `Accept: application/json,
  text/event-stream`.

## The config API (`mcp.target`): exact working payloads

Kinds are dotted names: `mcp.target`, `mcp.policy`, `mcp.settings` (plus `llm.*`, `traffic.*`, `ui.policy`,
`modelCatalog`). All on the admin port, no authentication.

**Create or upsert several** — `PUT /api/config/resources/mcp.target`:

```json
{ "resources": [ { "value": {
  "name": "twilio",
  "mcp": { "host": "http://host.docker.internal:3000/api/mcp/plugins/twilio" },
  "policies": {
    "backendAuth": { "key": { "value": "<the gateway secret>", "location": { "header": { "name": "x-landflow-gateway" } } } },
    "transformations": { "request": {
      "set": {
        "x-landflow-caller-iss": "jwt.iss",
        "x-landflow-caller-sub": "jwt.sub"
      },
      "remove": ["authorization"]
    } }
  }
} } ] }
```

Differences from the shape in transports.md: `backendAuth` is `{ "key": { "value", "location" } }`, not
`{ "key": "...", "location": {...} }` (that older form is accepted as a plain `{ "key": "<value>" }` without a
location, which sends `Authorization: Bearer <value>`). `location.header.prefix` is optional ("" is not needed). The
**id of an `mcp.target` is its `name`** (the gateway doesn't generate one), so a second PUT with the same name is an
update, and `DELETE /api/config/resources/mcp.target/twilio` removes it. The response echoes the stored resources:

```json
{ "resources": [ { "kind": "mcp.target", "id": "twilio", "value": { ...as sent... },
  "revision": 1, "createdAt": "2026-10-26T06:01:06.446002391Z", "updatedAt": "2026-10-26T06:01:06.446002391Z" } ] }
```

**List** — `GET /api/config/resources/mcp.target` → `{ "resources": [ ...the same records... ] }` (hybrid mode;
in `file` mode it always returns `[]`). Landflow keeps its own target names and only touches those.

**Update one** — `PUT /api/config/resources/mcp.target/{id}` with `{ "value": { ... } }` (the whole value; replaces
the record, bumps `revision`, 404 for an unknown id). **Delete** — `DELETE .../mcp.target/{id}` → 200, a repeat →
404.

Note that a `_meta`-less, condition-less target is all the sync needs; `condition` (a CEL expression choosing which
targets take part per request) exists if we ever want per-caller target sets without `mcpAuthorization`.

### CEL in the transformations

`set` values are CEL expressions. Verified:

| Expression | Result |
|---|---|
| `'"cel-ok"'` | the constant |
| `'jwt.sub'`, `'jwt.iss'` | the validated token's claims (with `mcpAuthentication`); without a token the header is **dropped**, not set to an error |
| `'has(jwt.sub) ? jwt.sub : "anonymous"'` | works with and without a token |
| `'jwt.groups.join(",")'` | `landflow-agents` |
| `remove: ["authorization"]` | the client's `Authorization` header never reaches the upstream |

`set` **overwrites** a header the client sent (a forged `x-landflow-caller-sub: forged` arrives as the token's
`sub`), which is what the host relies on. Other client headers pass through (`x-client-extra` did). The gateway also
adds `traceparent`, `mcp-method`, `mcp-name` and, for a stateful upstream, its own `mcp-session-id`.

## What the gateway does with the targets (timings)

All measured on OrbStack, Apple Silicon, with the upstreams on the Mac:

| Change | Visible in `tools/list` / on the traffic path after |
|---|---|
| `PUT` a new target | **6 ms** (the log says `config resource changed, reloading` at once) |
| `PUT .../{id}` changing a header expression | **3 ms** |
| `DELETE` a target | **5 ms** |
| File mode: write the file (two targets added) | **221 ms** |
| File mode: remove a target from the file | **110 ms** |
| File mode: `PUT` through the API (it rewrites the file) | 327 ms |

`tools/list` on `/mcp` fans out to every target on each call (no caching, as the spec wants); with two upstreams on
the Mac a list took 2–15 ms, a call 1–3 ms.

## Protocol versions

Client side, against the stateless gateway with 2026-07-28-capable upstreams:

| Client does | Gateway answers |
|---|---|
| `server/discover` with `_meta` | `supportedVersions: ["2024-11-05","2025-03-26","2025-06-18","2025-11-25","2026-07-28"]`, `resultType: complete`, merged `instructions` (`[one] ... [two] ...`), `ttlMs: 0`, `cacheScope: private` |
| `tools/list` with `_meta.io.modelcontextprotocol/protocolVersion: 2026-07-28` and `MCP-Protocol-Version: 2026-07-28`, no `initialize` | 200, `{ resultType, ttlMs, cacheScope, tools }` |
| `tools/list` with no version at all, no `initialize` | 200 (stateless mode doesn't require `initialize`) |
| classic `initialize` with `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` | the same version back, no `Mcp-Session-Id` (`statefulMode: stateless`) |
| classic `initialize` with `MCP-Protocol-Version: 2026-07-28` | 400 `invalid MCP protocol version header` (correct: `initialize` is removed in that revision) |
| `subscriptions/listen` params | `{ "_meta": {...}, "notifications": { "toolsListChanged": true, "promptsListChanged": true, "resourcesListChanged": true, "resourceSubscriptions": [...] } }`; the ACK is a `notifications/subscriptions/acknowledged` frame with `params._meta["io.modelcontextprotocol/subscriptionId"]` = the request id |

Upstream side (what the fake servers saw):

- **The gateway does no version translation.** `server/discover` is forwarded to every target; if one answers with an
  error (an older server), the client gets `-32601 server/discover` and must fall back to `initialize`. A 2026-07-28
  `tools/list` is forwarded with the client's `MCP-Protocol-Version: 2026-07-28` header and `_meta` as is; an
  upstream built on SDK 1.32 answers 400 (`Server not initialized`) and the whole list fails (`failOpen` skips the
  target, but with all targets failing the client gets 400). **So every host endpoint must speak 2026-07-28**, as
  transports.md already requires ("Landflow's endpoints all speak 2026-07-28"), and older external servers need
  routes of their own.
- A classic client's `initialize` is forwarded per target with the client's version (`2025-06-18` in → `2025-06-18`
  out); a stateful upstream's session is kept by the gateway across the client's stateless calls.
- For the admin-API baseline `tools/list` without any version, the gateway sends the upstream `initialize` +
  `notifications/initialized` + `tools/list` each time (stateless wrapping), with `MCP-Protocol-Version: 2025-11-25`.

## Notifications: `tools/list_changed`

The spec expects agents that subscribe to get "tool list changed" when a plugin's target is added or removed. What
happens in 1.6.0, per event, on each kind of stream (both measured with the same three events in sequence):

| Stream | target added (PUT) | upstream emits `tools/list_changed` | target removed (DELETE) |
|---|---|---|---|
| `subscriptions/listen` (2026-07-28), stateless gateway | **0** | **1** (relayed, tagged with the subscription id) | **0** |
| `GET /mcp` without a session, stateless gateway | 405 `method not allowed` (there is no stream) | | |
| `GET /mcp` with a session, `statefulMode: stateful` | **0** | **1** | **0** |
| `subscriptions/listen`, `statefulMode: stateful` | **0** | **1** | **0** |

So: notifications **from upstreams are relayed** on both the new and the old stream, but **the gateway itself emits
nothing when its target set changes** — a listen stream is bound to the targets that existed when it was opened. Gap
vs transports.md ("Its target is added; agents that subscribe get tool list changed"). Two ways to close it, both on
the host side:

1. The host's per-plugin endpoints emit `notifications/tools/list_changed` on their own streams when a plugin's tools
   change (new version), which the gateway relays — that part works.
2. For add/remove, keep one always-on Landflow endpoint in the gateway (the `core` target, which exists anyway) and
   have `McpGatewaySync` make it emit `tools/list_changed` after every target change; agents listening through the
   gateway then re-list and see the new prefix. Until then, agents see new plugins on their next `tools/list` (6 ms
   after the PUT).

Other observations: `statefulMode: stateful` gives out a long base64 `Mcp-Session-Id` (it encodes the per-target
upstream sessions), refuses requests without one (400) and `DELETE /mcp` with it answers 202; the stateless mode is
the right default for Landflow. In stateless mode the GET stream doesn't exist at all, so pre-2026 clients that want
notifications would need the stateful mode.

## Sign-in through Keycloak (`mcpAuthentication`)

`deploy/mcp-gateway/config.auth.yaml` (used by `compose.auth.yml`), the relevant part:

```yaml
mcp:
  policies:
    mcpAuthentication:
      mode: strict
      issuer: http://localhost:58080/realms/landflow-mcp-test        # = the token's iss (KC_HOSTNAME)
      audiences: [http://localhost:54000/mcp]                        # = the token's aud (an audience mapper on the client)
      provider: { keycloak: {} }
      jwks: { url: http://keycloak:8080/realms/landflow-mcp-test/protocol/openid-connect/certs }   # reachable from the container
      resourceMetadata:
        resource: http://localhost:54000/mcp
        authorization_servers: [http://localhost:58080/realms/landflow-mcp-test]
        scopes_supported: [openid, profile]
        bearer_methods_supported: [header]
    mcpAuthorization:
      rules:
        - '"landflow-agents" in jwt.groups && (mcp.tool.name != "hidden" || "support" in jwt.groups)'
```

Verified:

| Check | Result |
|---|---|
| No token | **401**, `WWW-Authenticate: Bearer resource_metadata="http://localhost:54000/.well-known/oauth-protected-resource/mcp"` |
| `GET /.well-known/oauth-protected-resource/mcp` | 200 `{"resource":"http://localhost:54000/mcp","authorization_servers":["http://localhost:58080/realms/landflow-mcp-test"],"mcp_protocol_version":"2025-06-18","resource_type":"mcp-server","bearer_methods_supported":["header"],"scopes_supported":["openid","profile"]}` |
| `GET /.well-known/oauth-authorization-server` on the gateway | 500 (the gateway doesn't proxy the AS metadata; clients read it from the issuer, which is right) |
| A garbage token | 401 |
| A valid Keycloak token (password grant, public client `landflow-mcp-test`) | `tools/list` works; the upstream sees `x-landflow-caller-sub` = `sub`, `x-landflow-caller-iss` = `iss`, no `Authorization`; a forged `x-landflow-caller-sub` is overwritten |
| `mcpAuthorization` rule | a denied tool is left out of `tools/list` and a call to it answers `-32602 Unknown tool: two_hidden`; a user outside `landflow-agents` is signed in but sees **no tools** (200, empty list); the `support` group sees and calls it |
| `server/discover` and `initialize` with a token | work as without auth |

The rule's variables: `jwt.<claim>` (`groups` needs a group-membership mapper with `full.path: false`),
`mcp.tool.name` (the **unprefixed** upstream tool name), `mcp.tool.target` (the target name). The audience check is
real: without the audience mapper (Keycloak's default `aud` is `account`) every token is refused.

Note `mcp_protocol_version: 2025-06-18` in the protected resource metadata: the authorization metadata is still
described at that revision, while the MCP traffic negotiates up to 2026-07-28.

## The file fallback

`deploy/mcp-gateway/config.file.yaml` (`storage.mode: file`, `compose.file.yml` mounts a writable directory at
`/config-file`). The gateway watches the file (`Watching config file`) and reloads on change: a write adding two
targets showed up in `tools/list` after **221 ms**, a removal after **110 ms**. An invalid file is logged (`Failed to
reload config: unknown field ...`) and the **last good config keeps serving**. The admin API's `PUT mcp.target` also
works in file mode: it rewrites the file (keeping the schema comment) and the gateway reloads it (327 ms); `GET` lists
nothing in file mode, so the sync can't read back what's there and must own the file. A target in the file:

```yaml
mcp:
  targets:
  - name: twilio
    mcp:
      host: http://127.0.0.1:3000/api/mcp/plugins/twilio
    policies:
      backendAuth:
        key:
          value: "<the gateway secret>"
          location:
            header:
              name: x-landflow-gateway
      transformations:
        request:
          set:
            x-landflow-caller-iss: "jwt.iss"
            x-landflow-caller-sub: "jwt.sub"
          remove: [authorization]
```

## Gaps vs transports.md, and the recommendation

1. **`tools/list_changed` on target add/remove is not emitted by the gateway** (only relayed from upstreams). Close it
   from the host (above); document that agents otherwise see new plugins on their next list.
2. **No version translation**: one older target breaks 2026-07-28 clients for the whole shared endpoint (the spec
   already says external servers get their own routes; this confirms it must be so).
3. **Metrics are named `agentgateway_requests_total{protocol="mcp", ...}`** (plus `agentgateway_request_duration_seconds`,
   `agentgateway_response_bytes_total`...), not `mcp_requests_total`; labels carry route/listener, and the access log
   has `mcp.method.name`, `mcp.target`, `gen_ai.tool.name`. The metrics port (15020) isn't published in dev.
4. `backendAuth` payload shape differs slightly from the spec's example (see above); the target **id is the name**.
5. `config.tracing` is deprecated in 1.6 in favour of `frontendPolicies.tracing` (host + protocol).
6. The protected resource metadata still says `mcp_protocol_version: 2025-06-18`.
7. The Node MCP SDK in the repo (1.32.1) doesn't do 2026-07-28; the host endpoints and the gateway sync's health
   probe need either the next SDK major or raw JSON-RPC for `server/discover`/`_meta`.

**Recommendation for the gateway stream: the config API (hybrid mode) as the primary adapter, the file as the
documented fallback.** The API is complete for our needs (collection upsert, single update, delete, list with
revisions), changes apply in milliseconds, the payload is small and stable (id = name), and hybrid mode keeps the base
config (listener, auth, rules) in a file we ship while the targets live in SQLite that is rebuilt from the registry on
every start. The file mode works and reloads fast (~0.2 s) but gives nothing back on `GET`, so a sync on it must
treat the file as write-only and re-render all targets on every change; keep it for gateways Landflow doesn't run.
The sidecar design (admin port on loopback only, one gateway per main) stands.

Proposed wording changes for transports.md: the `backendAuth` example and "id = name" in "Automatic registration";
in the event table, "agents that subscribe get tool list changed" → "agents see it on their next `tools/list`; the
`core` endpoint emits `tools/list_changed` for subscribers"; in "Telemetry", `mcp_requests_total` →
`agentgateway_requests_total{protocol="mcp"}`; in "Deployment", the base config's tracing lives under
`frontendPolicies.tracing`.
