# py-insights: example Landflow plugin (Python)

Three nodes built with [`landflow-sdk`](../../sdks/python), served over HTTP (`:7102`) and gRPC (`:7202`):

| Node | Type | What it does |
|---|---|---|
| Field Statistics | `py-insights.stats` | count / sum / mean / median / min / max / stdev of a numeric field across **all** items (optionally `groupBy`) |
| Sentiment | `py-insights.sentiment` | lexicon sentiment of a text field, adds `{score, label, matched}`; usable as an AI tool |
| Keyword Extract | `py-insights.keywords` | top-N keywords per item (frequency or TF-IDF lite), stopwords from a `loadOptions` language list; usable as an AI tool |

## Run

```bash
./setup.sh                    # creates .venv and installs the SDK editable with the grpc, mcp and brokers extras
.venv/bin/python main.py      # HTTP :7102 + gRPC :7202, announces to http://127.0.0.1:3000
```

`python3 main.py` also works without the venv: it picks up the SDK from `../../sdks/python` and serves
HTTP only (gRPC is skipped with a warning when grpcio is missing).

Environment: `LANDFLOW_REGISTRY_URL=off` (no announce), `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT`
(override ports, `off` disables), `LANDFLOW_ADVERTISE_HOST`, `LANDFLOW_LOG_LEVEL=debug`,
`LANDFLOW_LOG_FORMAT=pretty`.

Observability: logs are JSON lines on stdout with `trace_id`/`span_id` and a `span.end` line per span
(`plugin.execute py-insights.<node>`, continuing the host's trace). Sentiment adds a child span
`insights.sentiment.score` and a custom counter `insights.sentiment.labels` (by label), visible with
the built-in metrics at `GET :7102/metrics`. The plugin stays dependency-free; install the SDK's `otel`
extra into `.venv` and set `OTEL_EXPORTER_OTLP_ENDPOINT` to export to Jaeger or a collector.

## Try it

```bash
curl -s localhost:7102/.well-known/landflow
curl -s localhost:7102/landflow/v1/manifest
curl -s localhost:7102/landflow/v1/execute -d '{"protocol":"landflow.plugin/v1","executionId":"ex1","mode":"manual",
  "node":{"id":"n1","name":"Stats","type":"py-insights.stats","typeVersion":1},
  "parameters":{"field":"price"},"itemParameters":[],
  "inputs":[[{"json":{"price":10}},{"json":{"price":20}},{"json":{"price":45}}]]}'
curl -s localhost:7102/landflow/v1/load-options -d '{"nodeType":"keywords","method":"languages","parameters":{}}'
curl -s localhost:7102/metrics           # Prometheus text
.venv/bin/python grpc_client.py          # GetManifest, Execute, LoadOptions, Health over gRPC
```

## Transports

By default the plugin serves HTTP and gRPC and announces both to the host. To add a broker, name its kind in `LANDFLOW_TRANSPORTS` and give the
connection URL (the host needs a matching connection under Settings → Transports):

```sh
LANDFLOW_TRANSPORTS=http,grpc,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=… .venv/bin/python main.py
```

`./setup.sh` installs the SDK with the `grpc`, `mcp` and `brokers` extras: `kafka`, `amqp` (RabbitMQ), `nats` (also `jetstream`) and `valkey` run on
native Python drivers. The other kinds (`mqtt`, `amqp1`, `pulsar`, `sqs`, `pubsub`, `servicebus`) go through `landflow-bridge`, which the SDK starts
as a child process when it finds the binary (`LANDFLOW_BRIDGE_BIN`, `landflow-bridge` on PATH, or `services/landflow-bridge/bin/landflow-bridge`);
the container image carries it. Over a broker, calls are encrypted and signed with `LANDFLOW_TRANSPORT_SECRET` (the host's value).

**`max_concurrency`** is how many calls run at once across all faces: the default is the machine's core count (`DEFAULT_MAX_CONCURRENCY` in `main.py`), since the analytics are pure Python and keep a core busy. `LANDFLOW_MAX_CONCURRENCY` overrides it.

**`idempotent`.** All three nodes are pure computations over their input items, so they are marked `idempotent: true`: a broker may deliver a call twice.

**MCP.** `sentiment` and `keywords` are MCP tools (`stats` works on a whole item list and is not `usableAsTool`), both with `idempotentHint: true`. The face listens on the HTTP port at `/mcp`; the bind address follows the SDK (`LANDFLOW_BIND_HOST`, else loopback unless
`LANDFLOW_ADVERTISE_HOST` is set, as in a container, when it is `0.0.0.0` and `LANDFLOW_MCP_TOKEN` is required). In dev it is on, on loopback, with
no token. Containers and the Kubernetes manifest set `LANDFLOW_MCP=off`: agents reach the plugin through the host's per-plugin endpoint and the
gateway.
