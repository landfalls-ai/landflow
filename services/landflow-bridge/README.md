# landflow-bridge

One Go binary that sits next to **any** plugin speaking `landflow.plugin/v1` over HTTP or gRPC (built with any SDK, or
with none) and gives it every broker driver: Kafka, RabbitMQ, NATS and JetStream, Valkey/Redis Streams, MQTT 5, AMQP
1.0, Pulsar, SQS, Pub/Sub and Service Bus (`drivers.go`). It is how a Python plugin is reachable over a broker today
(`landflow_sdk.bridge`, started by `serve()`), and how a plugin with no messaging code at all gets a brokered endpoint
in Kubernetes (a sidecar container) or locally (one more process). Spec: [docs/transports.md](../../docs/transports.md)
"How each language gets every broker"; wire: [docs/protocol.md](../../docs/protocol.md) §14.

What it does:

- Fetches the target's manifest (gRPC `GetManifest` or `GET /landflow/v1/manifest`), adds its broker kinds to the
  `transports` hint and hashes it (`hex(SHA-256(JSON))[0..16]`, §14.4). The plugin id, version and manifest hash it
  announces are the **plugin's**, so the host sees the plugin itself; `maxConcurrency` and the per-node `idempotent`
  flags come from the manifest.
- Starts one messaging server (`sdks/go/transport`) per broker connection, announces on the broker's registry channel
  every 10 s with the registry proof (`LANDFLOW_REGISTRY_SECRET`), withdraws and drains on stop.
- Forwards every brokered call to the plugin over gRPC (preferred) or HTTP: the envelope's deadline becomes the gRPC
  deadline or `x-landflow-deadline`, a cancel on the control channel cancels the forwarded call, and the plugin's
  signals come back as `lferror` codes (404 / `NOT_FOUND` → `not_found`, 400 / `INVALID_ARGUMENT` → `bad_request`,
  413 → `too_large`, 503 / `UNAVAILABLE` or an unreachable plugin → `unavailable`, else `internal`). A 429 /
  `RESOURCE_EXHAUSTED` from the plugin is **never** relayed as `capacity`: the call never ran and the broker is the
  buffer the host spilled over to, so the bridge holds it and retries after `Retry-After` (1 s default) until its
  deadline. The bridge's own in-flight limit is the plugin's `maxConcurrency`, so prefetch never exceeds what the plugin
  can run. `GetManifest` is answered from the manifest the bridge announces, so the hash the
  host learns always matches what it is served. Bodies up to 64 MiB, as the HTTP face.
- Re-reads the manifest every `LANDFLOW_BRIDGE_MANIFEST_POLL` (30 s) and at once when a request carried another hash
  (`manifest_mismatch`): on a change it starts servers on the new hash, stops the old ones and announces again.
- `GET /healthz` on `LANDFLOW_BRIDGE_HEALTH_PORT`: `{ status: ok | degraded, pluginId, version, manifestHash,
  instanceId, target: { url, reachable }, brokers: [{ kind, endpoint, prefetch, inFlight, counters }] }` (503 when the
  plugin did not answer the last manifest check).
- Optional MCP face (`sdks/go/mcpface`): Streamable HTTP at `/mcp`, both protocol eras, the manifest's tools,
  `tools/call` forwarded to the plugin.
- Structured logs like the Go SDK (`{"ts","level","service":"landflow-bridge","msg",…}`; `LANDFLOW_LOG_FORMAT=pretty`,
  `LANDFLOW_LOG_LEVEL`).

## Running it

```sh
cd services/landflow-bridge && go build -o bin/landflow-bridge .      # bin/ is gitignored
LANDFLOW_BRIDGE_TARGET=grpc://127.0.0.1:7202 LANDFLOW_TRANSPORTS=nats \
LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=… bin/landflow-bridge
```

Configuration is by environment, with the Go SDK's names; every flag mirrors a variable and wins over it
(`bin/landflow-bridge -help`).

| Variable (flag) | Meaning |
|---|---|
| `LANDFLOW_BRIDGE_TARGET` (`-target`) | The plugin: `grpc://host:port` (preferred) or `http://host:port`. Required |
| `LANDFLOW_TRANSPORTS` (`-transports`) | Comma-separated broker kinds to serve (`http`, `grpc`, `mcp` are ignored: the plugin serves those). Empty: every kind that has a `LANDFLOW_<KIND>_URL`. A named kind needs its URL |
| `LANDFLOW_<KIND>_URL`, `_USERNAME`, `_PASSWORD`, `_TLS`, `_PREFIX` (else `LANDFLOW_TRANSPORT_PREFIX`), `_<FIELD>` | The broker connection, exactly as for the Go SDK (`LANDFLOW_KAFKA_MODE`, `LANDFLOW_AMQP_QUEUE_TYPE`, `LANDFLOW_SQS_REGION`…). The connection id is `env-<kind>` |
| `LANDFLOW_TRANSPORT_SECRET` (`_PREVIOUS`), fallback `LANDFLOW_REGISTRY_SECRET` | End-to-end encryption and signing (§14.7). Required: without it the bridge exits with a clear error |
| `LANDFLOW_REGISTRY_SECRET` | The registry proof on announces (§14.8) |
| `LANDFLOW_BRIDGE_INSTANCE_ID` (`-instance-id`) | The plugin's own instance id, so the host merges its direct and brokered endpoints into one plugin (the Python launcher passes it). Default: random |
| `LANDFLOW_MAX_CONCURRENCY` (`-max-concurrency`) | Overrides the manifest's `maxConcurrency` (prefetch and the forwarding semaphore; default the manifest's, else 16) |
| `LANDFLOW_BRIDGE_HEALTH_PORT`, `_HOST` (`-health-port`, `-health-host`) | `GET /healthz`; 0 = off (the container image sets 8080 on 0.0.0.0) |
| `LANDFLOW_BRIDGE_MANIFEST_POLL` (`-manifest-poll`) | Manifest re-read interval (default `30s`; a duration or milliseconds) |
| `LANDFLOW_BRIDGE_DRAIN_TIMEOUT` (`-drain-timeout`) | How long stop waits for calls in flight (default `30s`) |
| `LANDFLOW_BRIDGE_START_TIMEOUT` | How long start waits for the plugin's manifest (default `60s`; the plugin may still be starting) |
| `LANDFLOW_MCP` (`-mcp`), `LANDFLOW_MCP_PORT`, `LANDFLOW_MCP_HOST`, `LANDFLOW_MCP_TOKEN`, `LANDFLOW_MCP_CREDENTIALS` | The MCP face: `on` \| `off` (default off: an SDK that launches the bridge serves its own face). Loopback needs no token; a non-loopback host without a token stays off with an error line |
| `LANDFLOW_LOG_LEVEL`, `LANDFLOW_LOG_FORMAT` | `debug` \| `info` \| `warn` \| `error`; `json` \| `pretty` |

`bin/landflow-bridge -version` prints the built-in drivers.

Container: `deploy/docker/bridge.Dockerfile` (build context the repository root), a static binary on Alpine with the
health check on `:8080/healthz`; run it as a sidecar of the plugin's pod or as a second service on the plugin's network.

## Python plugins

`landflow_sdk.serve()` starts the bridge itself when `LANDFLOW_TRANSPORTS` (or `serve(transports=[…])`) names a broker
kind that has a `LANDFLOW_<KIND>_URL` and no native Python driver (`landflow_sdk.bridge.NATIVE_BROKER_BINDINGS`): the
binary from `LANDFLOW_BRIDGE_BIN`, else `landflow-bridge` on `PATH`, else this directory's `bin/landflow-bridge`;
`LANDFLOW_BRIDGE=off` disables it. The child gets the plugin's environment plus `LANDFLOW_BRIDGE_TARGET` (the plugin's
gRPC port, else HTTP), `LANDFLOW_TRANSPORTS` (the bridged kinds), `LANDFLOW_BRIDGE_INSTANCE_ID` and `LANDFLOW_MCP=off`;
it is stopped on shutdown and restarted with backoff (1 s doubling to 30 s) when it dies. A missing binary is one error
line and the plugin keeps serving HTTP/gRPC.

## Tests

```sh
cd services/landflow-bridge
go test ./...                                   # no containers: the kit over the in-memory broker, config, manifest change, health, MCP
LANDFLOW_TEST_KAFKA=127.0.0.1:59092 LANDFLOW_TEST_AMQP=amqp://landflow:landflow-dev-only@127.0.0.1:55672 \
LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 go test . -run TestLiveBrokers -v
```

`internal/kit` runs the protocol conformance kit (`packages/protocol/conformance`) over the messaging face from a Go
`transport.Client`, like the host: every messaging case against a Go plugin with no broker code (over gRPC and over
HTTP) and against the Python conformance plugin (`sdks/python/tests/conformance_plugin.py`, needs a Python with grpcio:
`LANDFLOW_TEST_PYTHON`, else `plugins/py-insights/.venv`), over the in-memory broker and, gated on
`LANDFLOW_TEST_<KIND>`, over kafka, amqp, nats, jetstream and valkey. Test ports: 7440–7459.
