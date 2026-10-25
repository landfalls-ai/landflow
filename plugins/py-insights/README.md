# py-insights: example Landflow plugin (Python)

Three nodes built with [`landflow-sdk`](../../sdks/python), served over HTTP (`:7102`) and gRPC (`:7202`):

| Node | Type | What it does |
|---|---|---|
| Field Statistics | `py-insights.stats` | count / sum / mean / median / min / max / stdev of a numeric field across **all** items (optionally `groupBy`) |
| Sentiment | `py-insights.sentiment` | lexicon sentiment of a text field, adds `{score, label, matched}`; usable as an AI tool |
| Keyword Extract | `py-insights.keywords` | top-N keywords per item (frequency or TF-IDF lite), stopwords from a `loadOptions` language list; usable as an AI tool |

## Run

```bash
./setup.sh                    # creates .venv and installs the SDK editable with the grpc extra
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
