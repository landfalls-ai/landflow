# landflow-sdk (Python)

Write [Landflow](../../docs/protocol.md) nodes in Python. A plugin is a process that serves one or
more nodes over **HTTP+JSON** (stdlib only, zero dependencies) and optionally **gRPC**, and
announces itself to the Landflow host so its nodes show up in the editor. Every call is traced and
counted ([observability](../../docs/observability.md)) with or without OpenTelemetry installed.

```bash
pip install -e 'sdks/python[grpc]'        # or without [grpc] for HTTP only
pip install -e 'sdks/python[grpc,otel]'   # + OpenTelemetry SDK and OTLP export
```

## Quickstart

```python
from landflow_sdk import Node, NodeOperationError, Plugin, serve

class Upper(Node):
    description = {
        "name": "upper", "displayName": "Uppercase", "description": "Uppercase a text field",
        "version": 1, "kind": "action", "categories": ["Text"], "icon": "lucide:case-upper",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
        "properties": [{"name": "field", "displayName": "Field", "type": "string", "default": "text"}],
    }

    def execute(self, ctx):
        out = []
        for i, item in enumerate(ctx.get_input_data()):
            field = ctx.get_node_parameter("field", i)
            if field not in item["json"]:
                raise NodeOperationError(f"missing field {field!r}", item_index=i)
            out.append({"json": {**item["json"], field: str(item["json"][field]).upper()}})
        return out  # flat list = one output; pairedItem is filled in for you

serve(Plugin("my-plugin", "My Plugin", "0.1.0", nodes=[Upper()]), http_port=7150, grpc_port=7250)
```

## The interface

| | |
|---|---|
| `Node.description` | dict following `NodeDescriptor` (class attribute or property). `name` is local; the host sees `<pluginId>.<name>`. Validated at startup. |
| `Node.execute(ctx)` | returns `list[list[item]]` (one list per main output) or a flat `list[item]`. Item = `{"json": {...}}` (a bare dict is wrapped). Async `execute` works too. |
| `Node.load_options(method, parameters[, ctx])` | optional; backs `typeOptions.loadOptionsMethod`. Return `[{name, value, description?}]`; call `super()` for unknown methods (404). Declare a third parameter to receive a `LoadOptionsContext` (credentials, logger, span, http, metrics). |
| `ctx.get_input_data(i=0)` | items on main input `i` |
| `ctx.get_node_parameter(name, i=0, default=None)` | `itemParameters[i]` -> `parameters` -> property `default` -> `default` |
| `ctx.node`, `ctx.node_type`, `ctx.mode`, `ctx.execution_id`, `ctx.workflow_id` | request metadata (`node_type` is qualified, `mode` is `manual`, `poll`, `tool`, ...) |
| `ctx.get_credentials(name=None)` / `ctx.credentials` | decrypted credential values ([Credentials](#credentials)) |
| `ctx.get_poll_state()`, `ctx.set_poll_state(state)`, `ctx.is_first_poll()` | polling triggers ([Polling triggers](#polling-triggers)) |
| `ctx.continue_on_fail()` | the node is set to continue on error: catch a failing item, append `{"json": {"error": msg}, "pairedItem": {"item": i}}`, go on |
| `ctx.logger.debug/info/warn/error(msg, *args, **attrs)` | collected into the response `logs` and written to the process log with trace ids |
| `ctx.span(name, attrs)`, `ctx.metrics`, `ctx.http`, `ctx.trace_id` | [observability](#observability) |
| `NodeOperationError(message, description=None, item_index=None)` | becomes the response `error`; any other exception becomes `{message: str(e)}` |

Nodes are shared across request threads: keep per-run state in locals.

## Credentials

A plugin declares the kinds of secrets its nodes use; the host renders the form, stores the values
encrypted and sends the decrypted values with each `Execute` / `LoadOptions` call
([protocol §7](../../docs/protocol.md#7-credentials)).

```python
from landflow_sdk import CredentialType, Node, Plugin

def test_github(data, ctx):                      # "Test connection" in the UI
    resp = ctx.http.get(f"{data['baseUrl']}/user", headers={"Authorization": f"Bearer {data['accessToken']}"})
    if resp.status == 401:
        return False, "GitHub rejected the token"
    resp.raise_for_status()                      # other failures -> ok: false with the HTTP error
    return True, f"authenticated as {resp.json['login']}"

GITHUB_API = CredentialType(
    name="githubApi", display_name="GitHub API", test=test_github,
    documentation_url="https://docs.github.com/en/authentication",
    properties=[
        {"name": "accessToken", "displayName": "Access token", "type": "string", "required": True,
         "typeOptions": {"password": True}},
        {"name": "baseUrl", "displayName": "API base URL", "type": "string", "default": "https://api.github.com"},
    ],
)

class ListRepos(Node):
    description = {
        "name": "listRepos", "displayName": "List Repositories", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
        "credentials": [{"name": "githubApi", "required": True}],
    }

    def execute(self, ctx):
        creds = ctx.get_credentials("githubApi")  # defaults filled in: creds["baseUrl"]
        resp = ctx.http.get(f"{creds['baseUrl']}/user/repos", headers={"Authorization": f"Bearer {creds['accessToken']}"})
        resp.raise_for_status()
        return [{"json": repo} for repo in resp.json]

plugin = Plugin("github", "GitHub", "0.1.0", nodes=[ListRepos()], credential_types=[GITHUB_API])
```

- `CredentialType(name, display_name, properties=[...], documentation_url=None, description=None, icon=None, test=None)`
  becomes a `credentialTypes` entry in the manifest (`testable: true` when `test` is set). Plain
  descriptor dicts are accepted too. Nodes may only reference declared types.
- `test(data, ctx)` (or `test(data)`) returns `(ok, message)`, `{"ok": ..., "message": ...}`, a bool
  or `None` (= ok). A raised `NodeOperationError` (e.g. `HttpError` from `raise_for_status()`) or any
  other exception becomes `{ok: false, message}`. `ctx` is a `CredentialTestContext` (logger, span,
  http, metrics). Served as `POST /landflow/v1/test-credentials` and gRPC `TestCredentials`;
  undeclared or untestable types answer 404 / `NOT_FOUND`.
- `ctx.get_credentials(name=None)` returns the values with the type's property defaults filled in.
  `name` may be omitted when the node declares one credential. A missing credential raises
  `NodeOperationError`, unless the node declares it with `required: False` (then `None`).
  `ctx.credentials` (the raw map) still works.
- Expose an overridable base URL (as above) so the integration can target a self-hosted instance,
  a proxy or a local test double.
- Credential values are **redacted** from log lines, span attributes, node logs and error messages
  (password fields, keys that look like secrets, and fields the type does not declare).

## Polling triggers

A trigger with `triggerSource: "poll"` is called by the host every `pollInterval` seconds while the
workflow is active ([protocol §8](../../docs/protocol.md#8-polling-triggers)).

```python
from landflow_sdk import Node, poll_interval_property

class NewIssues(Node):
    description = {
        "name": "newIssues", "displayName": "GitHub New Issues", "version": 1,
        "kind": "trigger", "triggerSource": "poll", "inputs": [], "outputs": [{"type": "main"}],
        "credentials": [{"name": "githubApi", "required": True}],
        "properties": [poll_interval_property(default_seconds=60),
                       {"name": "repo", "displayName": "Repository", "type": "string", "default": ""}],
    }

    def execute(self, ctx):
        creds = ctx.get_credentials()
        resp = ctx.http.get(f"{creds['baseUrl']}/repos/{ctx.get_node_parameter('repo')}/issues",
                            headers={"Authorization": f"Bearer {creds['accessToken']}"},
                            params={"sort": "created", "direction": "desc", "per_page": 50})
        resp.raise_for_status()
        issues = resp.json
        if ctx.mode != "poll":                    # "Execute" in the editor: a few recent events, no state
            return [{"json": i} for i in issues[:3]]
        newest = max((i["id"] for i in issues), default=0)
        if ctx.is_first_poll():                   # baseline: remember where we are, emit nothing
            ctx.set_poll_state({"lastId": newest})
            return []
        last = ctx.get_poll_state()["lastId"]
        ctx.set_poll_state({"lastId": max(last, newest)})
        return [{"json": i} for i in reversed(issues) if i["id"] > last]
```

- `ctx.mode` is `"poll"` for scheduled polls and `"manual"` when the user runs the node in the editor.
- `ctx.get_poll_state()` returns a copy of the state the previous poll returned, `None` on the first
  poll; `ctx.is_first_poll()` is `mode == "poll"` without state.
- `ctx.set_poll_state(dict)` sets the `pollState` of the response. It is only sent in poll mode
  (never in manual mode, as the protocol requires). If a poll does not call it, the incoming state
  is passed back unchanged; a failed poll returns no state, so the host retries from the same point.
- `poll_interval_property(default_seconds=60)` is the `pollInterval` number property (minimum 10 s).

## Observability

Spans, metrics and logs follow [docs/observability.md](../../docs/observability.md); the same names
are used by the host and the other SDKs.

```python
def execute(self, ctx):
    sent = ctx.metrics.counter("telegram.messages.sent", description="Messages sent")
    latency = ctx.metrics.histogram("telegram.api.duration", unit="ms")
    with ctx.span("telegram.send", {"telegram.chat_type": "group"}) as span:
        resp = ctx.http.request("POST", f"{base}/bot{token}/sendMessage", json={"chat_id": chat, "text": text}, timeout=10)
        span.set_attribute("telegram.ok", resp.ok)
    latency.record(resp.elapsed_ms, {"telegram.method": "sendMessage"})
    sent.add(1, {"telegram.chat_type": "group"})
    ctx.logger.info("message sent", chat_type="group")
```

| | |
|---|---|
| automatic | a server span per call: `plugin.execute {node type}`, `plugin.load_options {method}`, `plugin.test_credentials {credential type}` (error status + `exception` event on failure), continuing the host's W3C `traceparent` from HTTP headers or gRPC metadata. Metrics `landflow.plugin.executions`, `landflow.plugin.execute.duration`, `landflow.plugin.items`, `landflow.plugin.load_options`, `http.client.request.duration`. No spans for health, manifest or `/metrics`. |
| `with ctx.span(name, attrs=None) as span:` | a child span; `span.set_attribute(k, v)`, `set_attributes(d)`, `add_event(name, attrs)`, `record_exception(e)`, `set_status("error", msg)`. An exception leaving the block marks it failed. Use a low-cardinality name. |
| `ctx.metrics.counter(name, unit="", description="").add(v=1, attrs=None)` | also `histogram(...).record(v, attrs)` (ms buckets by default, `buckets=` to override) and `gauge(...).set(v, attrs)`. Names match `^[a-z][a-z0-9_.]{0,100}$` (else `ValueError`); `landflow.plugin.id`, `landflow.node.type`, `landflow.workflow.id` are added; values are truncated to 100 chars and at most 1000 attribute sets are kept per metric (the rest fold into `otel.metric.overflow=true`). |
| `ctx.http.request(method, url, headers=, json=, data=, params=, timeout=30, verify=True)` | stdlib urllib client (`get/post/put/patch/delete/head` shortcuts). `verify=False` accepts any TLS certificate (n8n's "Ignore SSL Issues"). Opens an `HTTP {METHOD}` client span, injects `traceparent`/`tracestate`/`baggage`, returns an `HttpResponse` (`status`, `ok`, `headers`, `content`, `text`, `json` or `None`, `elapsed_ms`, `raise_for_status()`). 4xx/5xx are returned; network errors and `raise_for_status()` raise `HttpError` (a `NodeOperationError` with `.status`). |
| `ctx.logger.info(msg, **attrs)` | also `debug`, `warn`, `error`. Returned to the host in `logs` and written to the process log with `trace_id`/`span_id`, the node's attributes and `attrs`. |

**Logs.** `serve()` sends all `logging` output to stdout as one JSON object per line
(`ts`, `level`, `service`, `msg`, `trace_id`, `span_id`, attributes) and writes a `span.end` line per
finished span. It leaves logging alone if the application configured it; use
`configure_logging(plugin)` or `LogFormatter` to opt in. Attribute keys matching
`token|secret|password|authorization|api key|cookie` have their string values redacted.

**Without OpenTelemetry** (the default install) the SDK parses `traceparent` itself, generates span
ids, samples per `OTEL_TRACES_SAMPLER`, writes span and log lines and serves `GET /metrics` from
in-memory instruments. **With `landflow-sdk[otel]`** spans are real OpenTelemetry spans (libraries
instrumented with OpenTelemetry join the same trace) and, when an OTLP endpoint is set, traces and
metrics are exported (`http/protobuf`; `grpc` if `opentelemetry-exporter-otlp-proto-grpc` is
installed). `/metrics` and the log lines are the same in both modes.

| Variable | Default | |
|---|---|---|
| `OTEL_SERVICE_NAME` | `landflow-plugin-<pluginId>` | service name in logs, spans and `target_info` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT` / `…_METRICS_ENDPOINT`) | unset | e.g. `http://localhost:4318`; needs the `otel` extra |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS` | `http/protobuf` | standard |
| `OTEL_RESOURCE_ATTRIBUTES` | – | e.g. `deployment.environment=dev` |
| `OTEL_TRACES_SAMPLER` / `_ARG` | `parentbased_always_on` | `always_on`, `always_off`, `traceidratio`, `parentbased_*` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | ms between OTLP metric exports |
| `OTEL_SDK_DISABLED` | `false` | `true`: spans and metrics become no-ops (trace context is still passed through) |
| `LANDFLOW_LOG_FORMAT` | `json` | or `pretty`: `HH:MM:SS level service msg (trace=…/span=…) k=v` |
| `LANDFLOW_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LANDFLOW_LOG_SPANS` | `true` | write a `span.end` line per finished span |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve Prometheus text at `GET /metrics` on the HTTP port |

Prometheus names replace `.` with `_`, add the unit (`_milliseconds`, `_seconds`, `_bytes`) and
`_total` for counters: `landflow_plugin_executions_total`, `landflow_plugin_execute_duration_milliseconds_bucket`.

## serve()

`serve(plugin, http_port=None, grpc_port=None, announce=True)` starts the servers, announces every
endpoint, heartbeats, and on SIGINT/SIGTERM withdraws, flushes telemetry and exits cleanly.

| Variable | Default | |
|---|---|---|
| `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` | the `serve()` arguments | override the ports; `off` disables a transport, `0` picks a free port |
| `LANDFLOW_REGISTRY_URL` | `http://127.0.0.1:3000` | `http(s)://` -> `POST/DELETE /api/plugins/announce`; `grpc://host:port` -> `RegistryService`; `off` |
| `LANDFLOW_ADVERTISE_HOST` | `127.0.0.1` | host written into announced endpoints |
| `LANDFLOW_BIND_HOST` | `127.0.0.1` (or `0.0.0.0` if the advertised host is not loopback) | listen address |

If grpcio is not installed, `serve()` logs a warning and serves HTTP only. If the host is down, the
plugin logs once and keeps retrying quietly in the background.

HTTP status codes: node failures are `200` with `error`; malformed requests `400`; unknown node
type, load-options method or credential type `404`. gRPC uses `INVALID_ARGUMENT` / `NOT_FOUND`.

## gRPC stubs

`landflow_sdk/_pb/` is generated from `packages/protocol/proto/landflow/plugin/v1/plugin.proto` and
committed. Regenerate with `PYTHON=/path/to/python-with-grpcio-tools scripts/gen_proto.sh`, then bump
the `grpc` extra's lower bounds to match.

## Tests

```bash
python3 -m unittest discover -s sdks/python/tests     # gRPC / OpenTelemetry tests skip when not installed
```

Run them once with a venv that has the `grpc` extra and once with `grpc,otel` to cover every mode.
