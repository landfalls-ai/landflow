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
| `ctx.idempotency_key` | `<executionId>:<nodeId>:<runIndex>`, the same across retries of this step; pass it to APIs that take an idempotency key (`None` from older hosts) |
| `ctx.get_binary_bytes(i, name="data")`, `ctx.prepare_binary_data(data, file_name)`, ... | files on items ([Binary data](#binary-data)) |
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

## Binary data

Items carry files under `item["binary"]`, keyed by a property name (`"data"` for a single file). A
file is a ref dict, `{"id", "mimeType", "fileName", "fileExtension", "fileSize", "fileType"}`; the
bytes stay in the host's binary store ([protocol §11](../../docs/protocol.md#11-binary-data)).

```python
class Gzip(Node):
    def execute(self, ctx):
        out = []
        for i, item in enumerate(ctx.get_input_data()):
            source = ctx.assert_binary_data(i, "data")           # the ref; NodeOperationError if missing
            packed = gzip.compress(ctx.get_binary_bytes(i, "data"))
            ref = ctx.prepare_binary_data(packed, f"{source.get('fileName', 'file')}.gz")
            out.append({"json": {**item["json"], "packedSize": len(packed)}, "binary": {"data": ref}})
        return out
```

| | |
|---|---|
| `ctx.assert_binary_data(i, name="data", input_index=0)` | the ref of input item `i`'s file `name`; raises `NodeOperationError('item 0 has no binary file "data"')` |
| `ctx.get_binary_bytes(i, name="data", input_index=0)` | its bytes |
| `ctx.open_binary_stream(i, name="data", input_index=0)` | a binary file-like object over it, for big files (`with ... as f:`) |
| `ctx.read_binary(ref)` | the bytes of any ref |
| `ctx.prepare_binary_data(data, file_name=None, mime_type=None)` | store `data` (bytes, `str` as UTF-8, or a binary file object) and return its ref; the MIME type defaults to a guess from `file_name` |
| `ctx.binary_access` | the request's `binaryAccess` (`{"url", "token"}`), `None` from older hosts |

- A ref with inline base64 `data` is decoded locally; one with an `id` is fetched with
  `GET {binaryAccess.url}/{id}` and the per-execution bearer token, traced like `ctx.http`.
- `prepare_binary_data` returns files up to `MAX_INLINE_BINARY_BYTES` (64 KiB) inline and uploads
  bigger ones and file objects with `POST {binaryAccess.url}` (file objects are streamed: with a
  `Content-Length` when seekable, chunked otherwise). Without `binaryAccess` only inline files work,
  and a bigger file raises `NodeOperationError`.
- Returned items keep their `binary`; a ref needs an `id` or `data` (bytes are base64-encoded for
  you), and a missing `mimeType` is guessed from `fileName`. A node that builds new items without
  `binary` drops the files, as in n8n.
- `mime_type_from_file_name(name)` and `file_type_of(mime)` use the same table as the other SDKs.

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

## App webhook triggers

A node with `"triggerSource": "appWebhook"` registers a webhook at the service when its workflow is published and
removes it when it is unpublished ([protocol §12](../../docs/protocol.md#12-app-webhook-triggers)). It implements
`webhook_create`, `webhook_delete` and `webhook`, and optionally `webhook_check_exists` (without it the host always
calls `webhook_create`). The productivity plugin's GitHub Webhook Trigger is a complete example.

```python
from landflow_sdk import Node, verify_github_signature

class RepoEvents(Node):
    description = {"name": "repoEvents", "displayName": "Repo Events", "version": 1, "kind": "trigger",
                   "triggerSource": "appWebhook", "inputs": [], "outputs": [{"type": "main"}], "properties": []}

    def webhook_create(self, ctx):
        secret = secrets.token_hex(32)
        hook = create_hook(ctx, ctx.get_webhook_url(), secret)
        ctx.set_static_data({"webhookId": hook["id"], "webhookSecret": secret})

    def webhook_delete(self, ctx):
        delete_hook(ctx, ctx.get_static_data().get("webhookId"))  # a hook that is already gone is fine
        ctx.set_static_data({})

    def webhook(self, ctx):
        secret = ctx.get_static_data().get("webhookSecret", "")
        if not verify_github_signature(secret, ctx.get_raw_body(), ctx.get_header("x-hub-signature-256")):
            return {"response": {"status": 401}}
        return {"items": [{"json": ctx.get_body()}], "idempotencyKey": ctx.get_header("x-github-delivery")}

    def execute(self, ctx):
        return [[]]  # a manual run has no event to show
```

`ctx.get_static_data()` is what the host keeps for this workflow and node (change it in place or call
`set_static_data`); it is sent back only when it changed. A result without `items` starts no run. Signature helpers,
all constant-time: `verify_github_signature`, `verify_stripe_signature(secret, body, header, tolerance_seconds=300)`,
`verify_slack_signature(secret, body, timestamp, signature)`, `verify_hmac_sha256(secret, payload, signature,
prefix=..., encoding=...)`, `safe_equal`, and `github_signature` / `stripe_signature` / `slack_signature` for tests.

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

## serve(), bindings and the dispatcher

`serve(plugin, http_port=None, grpc_port=None, announce=True)` -- or, with keywords,
`serve(plugin, http=7105, grpc=7205, bindings=[...], max_concurrency=16)` -- starts the plugin's
**bindings**, announces every endpoint, heartbeats, and on SIGINT/SIGTERM withdraws, flushes telemetry and
exits cleanly. Every announce carries `landflow_sdk.announce.INSTANCE_ID`, random per process, so the host
pulls the manifest again after a restart even when the version is unchanged. The manifest and every
announce also carry `transports` (the binding kinds that run) and `maxConcurrency`.

HTTP and gRPC are two bindings ("faces", [`docs/transports.md`](../../docs/transports.md)) over one
transport-neutral `Dispatcher` (`plugin.dispatcher`): a binding converts its wire format to the protocol
dicts and calls `dispatcher.execute / load_options_request / test_credentials_request / webhook_method /
receive_webhook(request, headers, cancel=, deadline=, transport=)`, which applies the call's deadline and
cancellation, the plugin's `max_concurrency` and then the plugin's handler logic. Broker bindings (through
`landflow-bridge` first) and the MCP face plug in the same way:

```python
class Binding(ABC):
    kind: str                                              # "http" | "grpc" | "mcp" | a broker kind
    def start(self, context: BindingContext) -> BindingInfo: ...   # listen/connect; endpoints to announce
    def stop(self) -> None: ...                            # drain, then close
```

`BindingContext` carries `plugin`, the shared `dispatcher`, the `manifest` (with the hints), `logger`,
`telemetry`, `bind_host` / `advertise_host`, an `announce(endpoints)` hook for endpoints learned late and a
`fail(exc)` hook that shuts the plugin down. Node code sees the call's `CancelToken` as `ctx.cancel`
(`ctx.cancel.is_set()`, `ctx.cancel.check()` raising `CallCancelledError`, `ctx.cancel.remaining()`,
`ctx.cancel.wait(t)`; also `ctx.deadline`, `ctx.is_cancelled()`, `ctx.check_cancelled()`): over gRPC it is the
call's deadline and the client's cancellation; over HTTP it is never set. `dispatcher.in_flight` /
`waiting` / `max_concurrency` are the live counts (also the `landflow.plugin.inflight` gauge); at the limit a
call waits for a slot until its token ends, then fails with `OverloadedError` (HTTP 503, gRPC
`RESOURCE_EXHAUSTED`; an expired deadline is 504 / `DEADLINE_EXCEEDED`).

| Variable | Default | |
|---|---|---|
| `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` | the `serve()` arguments | override the ports; `off` disables a transport, `0` picks a free port |
| `LANDFLOW_TRANSPORTS` | every configured binding | comma-separated kinds to run (`http,grpc,kafka`); a kind with no binding is ignored with a warning |
| `LANDFLOW_MAX_CONCURRENCY` | `max_concurrency=` (unlimited) | calls one instance runs at once; announced as `maxConcurrency` |
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
