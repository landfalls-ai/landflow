# Landflow Go SDK

`github.com/landflow/landflow/sdks/go` (package `landflow`) lets you write Landflow nodes in Go.
A plugin built with it speaks `landflow.plugin/v1` over **HTTP+JSON** and **gRPC** at once, and it
announces itself to the Landflow host so its nodes show up in the editor. The wire contract is
described in [`docs/protocol.md`](../../docs/protocol.md).

- You implement one interface (`Node`) and get both transports. Node code never touches HTTP or proto.
- Descriptors are plain Go structs. They marshal to exactly the JSON shapes in
  `packages/protocol/src/types.ts` and are validated when the plugin starts.
- The server side uses the stdlib `net/http`, `google.golang.org/grpc` and OpenTelemetry. Every call
  is traced and counted, logs carry trace ids, and `GET /metrics` serves Prometheus text
  (see [Observability](#observability)).
- Nodes can declare [credentials](#credentials) and act as [polling triggers](#polling-triggers).

## Quickstart

```bash
mkdir my-plugin && cd my-plugin
go mod init example.com/my-plugin
# Inside this monorepo, point at the local SDK until it is published:
go mod edit -require github.com/landflow/landflow/sdks/go@v0.0.0 \
            -replace github.com/landflow/landflow/sdks/go=../../sdks/go
```

```go
package main

import (
	"context"
	"log"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

type Upper struct{}

func (Upper) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "upper", DisplayName: "Upper Case", Description: "Upper-case a field",
		Version: landflow.V(1), Kind: landflow.KindAction,
		Icon: "lucide:case-upper", Color: "#22d3ee", Categories: []string{"Text"},
		Inputs:  []landflow.PortDescriptor{landflow.MainPort()},
		Outputs: []landflow.PortDescriptor{landflow.MainPort()},
		UsableAsTool: true,
		Properties: []landflow.PropertyDescriptor{
			{Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: "text"},
		},
	}
}

func (Upper) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	var out []landflow.Item
	for i, item := range ctx.InputData(0) {
		field := ctx.ParamString("field", i, "text")
		s, ok := item.JSON[field].(string)
		if !ok {
			return nil, landflow.ItemError(i, "field %q is not a string", field)
		}
		next := map[string]any{}
		for k, v := range item.JSON {
			next[k] = v
		}
		next[field] = strings.ToUpper(s)
		out = append(out, landflow.Item{JSON: next}) // pairedItem is filled in for you
	}
	ctx.Logger.Info("upper-cased %d item(s)", len(out))
	return [][]landflow.Item{out}, nil
}

func main() {
	plugin := landflow.NewPlugin(landflow.PluginInfo{
		ID: "my-plugin", Name: "My Plugin", Version: "0.1.0", Icon: "lucide:sparkles",
	}, Upper{})
	if err := landflow.Serve(context.Background(), plugin, landflow.ServeOptions{
		HTTPPort: 7110, GRPCPort: 7210,
	}); err != nil {
		log.Fatal(err)
	}
}
```

```bash
go run .                              # serves :7110 (HTTP) and :7210 (gRPC), announces to http://127.0.0.1:3000
LANDFLOW_REGISTRY_URL=off go run .    # standalone, no announce
curl -s localhost:7110/landflow/v1/manifest | jq .
```

For a complete example (four nodes, LoadOptions, tool mode, a notice property and
displayOptions), see [`plugins/go-crypto`](../../plugins/go-crypto).

## Concepts

### Node and OptionsLoader

```go
type Node interface {
	Description() NodeDescriptor
	Execute(ctx *ExecuteContext) ([][]Item, error)
}

// Optional: serves properties whose typeOptions.loadOptionsMethod is set.
type OptionsLoader interface {
	LoadOptions(method string, params map[string]any) ([]PropertyOption, error)
}

// Or the context-aware form, which also sees credentials and the trace (wins when both exist).
type OptionsLoaderWithContext interface {
	LoadOptionsWithContext(ctx *LoadOptionsContext) ([]PropertyOption, error)
}
```

`NewPlugin` calls `Description()` once per node, fills in defaults, and validates the result.
The defaults are: `kind` becomes `action` (`trigger` when `triggerSource` is set), `version`
becomes `1`, action inputs and all outputs get a `main` port, and nil slices become `[]`. A poll
trigger without a `pollInterval` property gets `PollIntervalProperty(60)`. Validation covers identifier rules, property
types, options, and connection types. It also rejects a `loadOptionsMethod` on a node that does
not implement `OptionsLoader`. On failure `NewPlugin` panics and lists every problem; call
`BuildPlugin` to get an error instead. The manifest reports `language: "go"` and
`sdk: landflow-sdk-go`.

`Execute` can run concurrently for different requests, so don't keep per-run state on the receiver.

### Descriptor types

`NodeDescriptor`, `PropertyDescriptor`, `PortDescriptor`, `PropertyOption`, `DisplayOptions`,
`TypeOptions` (alias `PropertyTypeOptions`), `FixedCollectionGroup`, `PluginInfo`, `Item` and
`PairedItem` mirror `types.ts` with camelCase JSON tags and `omitempty`. A few details:

- `Version` is `[]int`. `landflow.V(1)` marshals as `1`, and `landflow.V(1, 2)` marshals as `[1,2]`.
- `PropertyDescriptor.Default` is `any`. It is omitted only when nil, so `false`, `0` and `""` are kept.
- Numeric `TypeOptions` that can legitimately be 0 are pointers: `MinValue: landflow.Ptr(1.0)`.
- Property type constants are `PropString`, `PropNumber`, `PropOptions`, `PropNotice` and so on.

### ExecuteContext

| Method | Meaning |
|---|---|
| `InputData(i)` | items on main input `i` |
| `Param(name, i)` | the raw value: `itemParameters[i][name]`, then `parameters[name]`, then the property's `default`. JSON `null` counts as unset |
| `ParamString/Int/Float/Bool(name, i, def)` | the same lookup, converted, with `def` as the last fallback |
| `HasParam(name, i)` | whether the lookup above finds a value |
| `Node()`, `Mode()`, `ExecutionID()`, `WorkflowID()`, `TraceID()` | request metadata |
| `Credentials(name)`, `CredentialString/Int/Bool(name, field, …)`, `HasCredentials`, `RequireCredentials` | see [Credentials](#credentials) |
| `PollState()`, `SetPollState(map)`, `IsFirstPoll()` | see [Polling triggers](#polling-triggers) |
| `ContinueOnFail()`, `ErrorItem(i, err)` | the node is set to continue on error: append `ctx.ErrorItem(i, err)` for a failing item and go on |
| `BinaryRef(i, name)`, `BinaryBytes(i, name)`, `BinaryReader(i, name)`, `ReadBinary(ref)`, `PrepareBinary(…)` | see [Binary data](#binary-data) |
| `IdempotencyKey()` | `<executionId>:<nodeId>:<runIndex>`, the same across retries of this step; pass it to APIs that take an idempotency key (`""` from older hosts) |
| `Span(name, attrs, fn)`, `StartSpan`, `DBSpan(info, fn)`, `Metrics()` | see [Observability](#observability) |
| `Context()` | request context carrying the server span, cancelled if the caller disconnects |
| `Logger.Debug/Info/Warn/Error(fmt, args...)`, `Logger.With(k, v, …)` | lines collected into the response `logs` and written to the process log with trace ids |

`*ExecuteContext` is itself a `context.Context` (carrying the `plugin.execute` span), so you can
pass `ctx` straight to database drivers, `http.NewRequestWithContext` or `landflow.HTTPClient`.

Expressions are resolved by the host before the request is sent, so nodes only ever see concrete
values. When several properties share a name and differ only in `displayOptions`, the default
comes from the one that is visible.

### Errors and outputs

- Return a `NodeError` (by value or pointer, wrapped or not) to set `error.message`,
  `error.description` and `error.itemIndex`. The helpers are `landflow.ItemError(i, ...)`,
  `landflow.NewNodeError(...)` and `.WithDescription(...)`.
- Any other `error` becomes `error.message`. A panic is recovered into an error response, and the
  stack trace goes to the plugin's log.
- When an output branch has as many items as input 0, each item that has no `pairedItem` gets
  `{ "item": i }`.
- Returning nil outputs produces one empty branch per `main` output.

## Credentials

Declare the kinds of secrets your nodes need in `PluginInfo.CredentialTypes`, and list the ones a
node uses in `NodeDescriptor.Credentials`. The host renders the form, stores the values encrypted
and sends the decrypted data with every Execute and LoadOptions call (protocol §7).

```go
var telegramAPI = landflow.CredentialType{
	Name: "telegramApi", DisplayName: "Telegram API",
	DocumentationURL: "https://core.telegram.org/bots#how-do-i-create-a-bot",
	Properties: []landflow.PropertyDescriptor{
		{Name: "accessToken", DisplayName: "Bot Token", Type: landflow.PropString, Required: true,
			TypeOptions: &landflow.TypeOptions{Password: true}}, // masked in the UI, redacted in logs/spans
		{Name: "baseUrl", DisplayName: "API Base URL", Type: landflow.PropString, Default: "https://api.telegram.org"},
	},
	// Optional. Setting Test makes the type "testable" (Test connection in the UI).
	Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) {
		resp, err := landflow.HTTPClient(ctx).Get(data.StringOr("baseUrl", "https://api.telegram.org") +
			"/bot" + data.String("accessToken") + "/getMe")
		if err != nil {
			return false, err.Error()
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return false, "Telegram answered " + resp.Status
		}
		return true, ""
	},
}

plugin := landflow.NewPlugin(landflow.PluginInfo{ID: "messaging", /* … */
	CredentialTypes: []landflow.CredentialType{telegramAPI}}, SendMessage{})

// In the node:
//   Credentials: []landflow.NodeCredentialRequirement{{Name: "telegramApi", Required: true}},
func (SendMessage) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials("telegramApi") // NodeError "Credentials … are required" if absent
	if err != nil {
		return nil, err
	}
	token := creds.String("accessToken")
	base := ctx.CredentialString("telegramApi", "baseUrl")
	// …
}
```

- `ctx.Credentials(name)` returns a `CredentialData` (a `map[string]any`, nil when absent) with
  `String`, `StringOr`, `Int`, `Float`, `Bool` and `Has`. `Credentials()` with no name still
  returns the whole map, as before.
- `LoadOptionsWithContext(ctx)` sees the same credentials (`ctx.Credentials`, `ctx.CredentialString`).
- `TestCredentials` is served at `POST /landflow/v1/test-credentials` and over gRPC. An unknown type
  is `404` / `NotFound`; a type without `Test` answers `{ok: false, message}`; a panic in `Test`
  becomes `ok: false`.
- Validation rejects a node credential that names an undeclared type.
- Give every integration an overridable base URL (or host/port) so it can be pointed at a proxy or a
  test double.
- **Redaction**: the values of `password` fields, and of any field whose name matches
  `token|secret|password|authorization|api[-_]?key|cookie`, are replaced with `[REDACTED]` wherever
  they appear in node logs (returned and process), span attributes, span errors and `url.full`.
  `landflow.RedactString(ctx, s)` applies the same masking to your own strings. The error message
  returned to the host is not changed.

## Binary data

Items carry files under `Item.Binary`, keyed by a property name (`"data"` for a single file), as
references to bytes in the host's binary store ([protocol §11](../../docs/protocol.md#11-binary-data)).
The helpers read and write those bytes through the host's binary API, using the URL and token the
host sends with each call (`ExecuteRequest.BinaryAccess`).

```go
func (attachInvoice) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	var out []landflow.Item
	for i, item := range ctx.InputData(0) {
		data, err := ctx.BinaryBytes(i, "data") // error `item 0 has no binary file "data"` when missing
		if err != nil {
			return nil, landflow.ItemError(i, "%v", err)
		}
		pdf, err := ctx.PrepareBinary(render(data), "invoice.pdf", "") // MIME type guessed from the name
		if err != nil {
			return nil, err
		}
		out = append(out, landflow.Item{JSON: item.JSON, Binary: map[string]landflow.BinaryRef{"data": item.Binary["data"], "invoice": pdf}})
	}
	return [][]landflow.Item{out}, nil
}
```

| Method | Meaning |
|---|---|
| `BinaryRef(i, name)` | the ref of input item `i` (`""` = `"data"`); an error when there is none |
| `BinaryBytes(i, name)`, `BinaryReader(i, name)` | its bytes, or an `io.ReadCloser` for big files (close it) |
| `ReadBinary(ref)`, `OpenBinary(ref)` | the same for any ref, e.g. one a sub-workflow returned |
| `PrepareBinary(data, fileName, mimeType)` | a ref to put under `Item.Binary[name]`: inline (base64 `Data`) up to `MaxInlineBinaryBytes` (64 KiB), uploaded above; `mimeType` `""` is guessed from the file name |
| `PrepareBinaryStream(r, fileName, mimeType)` | upload from an `io.Reader` (always uploaded) |
| `MimeTypeFromFileName`, `FileExtensionOf`, `FileTypeOf` | the MIME tables the helpers use |

Stored refs are fetched with `GET {url}/{id}` and uploads go to `POST {url}`, both with the call's
bearer token and through `landflow.HTTPClient(ctx)`, so they show up as client spans. Without
`BinaryAccess` (an older host) only small files can be returned, inline.

## Polling triggers

A node with `TriggerSource: landflow.TriggerPoll` (protocol §8) is called with mode `"poll"` every
`pollInterval` seconds while its workflow is active. `landflow.PollIntervalProperty(defaultSeconds)`
builds that property (number, minimum 10); it is added with a default of 60 if you leave it out.

```go
func (NewIssues) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "newIssues", DisplayName: "New Issues", Description: "Starts on new issues",
		TriggerSource: landflow.TriggerPoll, // kind defaults to trigger
		Credentials:   []landflow.NodeCredentialRequirement{{Name: "githubApi", Required: true}},
		Properties:    []landflow.PropertyDescriptor{landflow.PollIntervalProperty(120), /* repo, … */},
	}
}

func (NewIssues) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	issues, err := listIssues(ctx) // newest first
	if err != nil {
		return nil, err
	}
	if ctx.Mode() == landflow.ModeManual { // editor "Execute": the latest few, no state
		return [][]landflow.Item{toItems(issues[:min(3, len(issues))])}, nil
	}
	lastID := landflow.CredentialData(ctx.PollState()).Int("lastId", 0) // typed access to any map
	if len(issues) > 0 {
		ctx.SetPollState(map[string]any{"lastId": issues[0].ID})
	}
	if ctx.IsFirstPoll() { // no previous state: set the baseline, emit nothing
		return nil, nil
	}
	return [][]landflow.Item{toItems(newerThan(issues, lastID))}, nil
}
```

`PollState()` is nil on the first poll. The state you set is returned as `pollState` only in mode
`"poll"` and only when the node succeeds; in manual mode it is dropped, as the protocol requires.
An empty output starts no execution.

## Transports

| | HTTP | gRPC (`landflow.plugin.v1.PluginService`) |
|---|---|---|
| Paths / RPCs | `GET /.well-known/landflow`, `GET /landflow/v1/manifest`, `POST /landflow/v1/execute`, `POST /landflow/v1/load-options`, `POST /landflow/v1/test-credentials`, `GET /landflow/v1/health`, `GET /metrics` | `GetManifest`, `Execute`, `LoadOptions`, `TestCredentials`, `Health` |
| Trace context | `traceparent` / `tracestate` / `baggage` headers | the same keys in gRPC metadata |
| Node failure | `200` with `error` | `NodeError` in the response (`item_index = -1` when not item-specific) |
| Malformed request | `400` | `InvalidArgument` |
| Unknown node type | `404` | `NotFound` |
| Node has no LoadOptions | `404` | `Unimplemented` |
| Unknown credential type | `404` | `NotFound` |

`ExecuteRequest.node.type` is fully qualified (`my-plugin.upper`). The SDK strips the
`<pluginId>.` prefix, and a bare local name is also accepted. The gRPC server converts proto to
and from the same structs the HTTP handler uses. Payloads travel as `DynamicValue` JSON bytes.

You can also use the pieces on their own:

```go
http.ListenAndServe(":7110", plugin.Handler())       // just HTTP
srv := plugin.GRPCServer(); srv.Serve(lis)           // just gRPC
plugin.RegisterGRPC(existingServer)                  // add to your own grpc.Server
resp, err := plugin.Execute(ctx, &landflow.ExecuteRequest{...}) // in-process (tests)
```

`ExecuteRequestToProto`, `ExecuteResponseFromProto` and `PluginInfoFromProto` help Go clients
(see `plugins/go-crypto/cmd/probe`).

## Serve, discovery and announce

`landflow.Serve(ctx, plugin, landflow.ServeOptions{HTTPPort, GRPCPort, Announce})` does the
following:

1. Binds both listeners. A port clash fails fast, before anything is announced.
2. POSTs an `AnnounceRequest` to `{LANDFLOW_REGISTRY_URL}/api/plugins/announce` for each endpoint,
   `http://{advertise}:{port}` and `grpc://{advertise}:{port}`. If the URL is `grpc://`, it calls
   `RegistryService.Announce` instead.
3. Re-announces every `heartbeatIntervalSeconds` from the response (10 by default). If the host is
   down, it logs once and keeps retrying quietly. It logs again when the host comes back.
4. On SIGINT, SIGTERM or `ctx` cancellation, it withdraws every endpoint that was accepted, using
   `DELETE /api/plugins/announce` or `RegistryService.Withdraw`. It then gracefully stops both
   servers and returns `nil`.

| Variable | Default | Meaning |
|---|---|---|
| `LANDFLOW_REGISTRY_URL` | `http://127.0.0.1:3000` | `http(s)://…`, `grpc://host:port`, or `off` |
| `LANDFLOW_ADVERTISE_HOST` | `127.0.0.1` | host placed in announced endpoints |
| `LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` | `ServeOptions` value | override the code's ports; `off` disables a transport |
| `LANDFLOW_LISTEN_HOST` | loopback if the advertise host is loopback, otherwise all interfaces | bind address |

`ServeOptions` can also override all of the above (`RegistryURL`, `AdvertiseHost`, `ListenHost`)
and set `TTLSeconds` (30), `ShutdownTimeout` (10s), `Logger` and `GRPCOptions`.
`Announce: landflow.Ptr(false)` disables announcing.

## Observability

The SDK implements [`docs/observability.md`](../../docs/observability.md) with the OpenTelemetry Go
SDK. `Serve` sets it up from the environment; nothing is needed in node code for the basics.

**Automatic**

- Trace context from the host (`traceparent`, `tracestate`, `baggage`, as HTTP headers or gRPC
  metadata) is continued. Each call is a server span: `plugin.execute {node type}`,
  `plugin.load_options {method}`, `plugin.test_credentials {credential type}`, with the spec's
  attributes and error status plus an `exception` event on failure. Health, manifest and `/metrics`
  are not traced.
- Metrics: `landflow.plugin.executions`, `landflow.plugin.execute.duration` (ms),
  `landflow.plugin.items`, `landflow.plugin.load_options` and `http.client.request.duration`.
- Logs: one JSON object per line on stdout (`ts`, `level`, `service`, `msg`, `trace_id`, `span_id`,
  then attributes), or `LANDFLOW_LOG_FORMAT=pretty`. Node log lines are written there too, with
  `landflow.node.type` and `landflow.execution.id`, besides being returned to the host. With
  `LANDFLOW_LOG_SPANS=true` (default) each finished span adds a `span.end` line. Lifecycle messages
  use the same logger unless `ServeOptions.Logger` is set.
- `GET /metrics` on the HTTP port serves Prometheus text (`landflow_plugin_executions_total`, …).
- OTLP export (HTTP/protobuf, or gRPC with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`) starts only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or the per-signal variable) is set.

| Variable | Default | |
|---|---|---|
| `OTEL_SERVICE_NAME` | `landflow-plugin-<pluginId>` | also the log `service` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `…_TRACES_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_HEADERS`, `…_PROTOCOL` | unset | standard |
| `OTEL_TRACES_SAMPLER`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_METRIC_EXPORT_INTERVAL` | `parentbased_always_on`, –, `15000` | standard |
| `OTEL_SDK_DISABLED` | `false` | `true`: spans and metrics are no-ops and `/metrics` is 404; logs still carry the host's trace id |
| `LANDFLOW_LOG_LEVEL` / `LANDFLOW_LOG_FORMAT` / `LANDFLOW_LOG_SPANS` | `info` / `json` / `true` | |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve `GET /metrics` |

**Node-author API** (the same on `*ExecuteContext`, `*LoadOptionsContext` and `Span`):

```go
// Child span. fn's error (or panic) marks it failed. Span is a context.Context: hand it to
// libraries and to HTTPClient so their spans nest under it.
err := ctx.Span("telegram.send", landflow.Attrs{"telegram.chat_type": chatType}, func(span landflow.Span) error {
	resp, err := landflow.HTTPClient(span).Post(base+"/bot"+token+"/sendMessage", "application/json", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	span.SetAttribute("telegram.message_id", id) // also SetAttributes, AddEvent, RecordError, TraceID
	return nil
})

// Database client span "{operation} {collection}" (kind client) with the db.* attributes.
err = ctx.DBSpan(landflow.DBSpanInfo{
	System: "postgresql", Operation: "SELECT", Collection: "users", Namespace: "app",
	Statement: "SELECT id, email FROM users WHERE id = $1", // parameterised only, never literal values
	ServerAddress: host, ServerPort: 5432,
}, func(span landflow.Span) error {
	rows, err := pool.Query(span, sql, id) // span is the context
	// …
	span.SetAttribute("db.response.returned_rows", n)
	return err
})

// Manual form for driver hooks: span := ctx.StartSpan("name", attrs); defer span.End()

// Custom metrics: names match ^[a-z][a-z0-9_.]{0,100}$; landflow.plugin.id, landflow.node.type and
// landflow.workflow.id are added; values are truncated to 100 chars; at most 1000 attribute sets per
// metric (then otel.metric.overflow=true). Invalid names are no-ops with one warning.
ctx.Metrics().Counter("telegram.messages.sent").Add(1, landflow.Attrs{"telegram.chat_type": chatType})
ctx.Metrics().Histogram("postgres.query.duration", landflow.WithUnit("ms")).Record(ms) // ms → standard buckets
ctx.Metrics().Gauge("queue.depth").Set(float64(depth))

// Code with only a context.Context (CredentialType.Test): the same through the context.
landflow.MetricsFrom(testCtx).Counter("google.oauth.token_refreshes").Add(1)
err = landflow.DBSpanFrom(testCtx, landflow.DBSpanInfo{System: "postgresql", Operation: "SELECT", Statement: "SELECT 1"}, ping)

// Traced HTTP: an *http.Client with otelhttp. "HTTP GET" client spans, traceparent injected,
// url.full without the query string. Requests without their own span inherit ctx (and its cancellation).
resp, err := landflow.HTTPClient(ctx).Get(url)
rt := landflow.HTTPTransport(ctx, base) // for clients you build yourself (oauth2.Transport{Base: rt})

// Logs: printf-style as before, structured attributes through With.
ctx.Logger.With("telegram.chat_type", chatType, "count", n).Info("sent")
```

Spans and metrics are no-ops when telemetry is disabled or never set up (for example with
`NewExecuteContext` in unit tests). `Plugin.Telemetry()` exposes the `TracerProvider`,
`MeterProvider`, `Propagator`, `Logger` (`*slog.Logger`) and `MetricsHandler`. `Serve` also installs
them as the OTel globals, so third-party instrumentation joins the same trace.

**Testing with in-memory exporters**

```go
rec := tracetest.NewSpanRecorder()
reader := sdkmetric.NewManualReader()
tel, _ := plugin.SetupTelemetry(ctx, landflow.TelemetryOptions{
	SpanProcessors: []sdktrace.SpanProcessor{rec},
	MetricReaders:  []sdkmetric.Reader{reader},
	LogWriter:      &buf, // or io.Discard
	NoOTLP:         true,
})
defer tel.Shutdown(ctx)
resp, _ := plugin.Execute(ctx, req) // or httptest.NewServer(plugin.Handler()) / bufconn gRPC
// rec.Ended(), reader.Collect(ctx, &rm), buf.String()
```

`TelemetryOptions` fields (`LogLevel`, `LogFormat`, `LogSpans`, `Prometheus`, `Disabled`,
`ServiceName`) override the environment. Pass them to `Serve` through `ServeOptions.Telemetry`.
`plugins/go-crypto` shows a child span (`crypto.hash`) and a custom metric (`crypto.hashes` by
algorithm).

## Development

```bash
cd sdks/go
go vet ./... && go test ./...     # params, pairedItem, HTTP/gRPC, announce/serve, telemetry, credentials, polling
./gen.sh                          # regenerate landflowpb/*.pb.go from packages/protocol/proto
```

`gen.sh` needs `protoc`, `protoc-gen-go` and `protoc-gen-go-grpc` on `PATH`. It adds
`$(go env GOPATH)/bin` itself. The generated files are committed.
