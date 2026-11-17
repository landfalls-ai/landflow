# Build a plugin in Go

You will build `hello-node`: an action with a credential and two outputs, and a poll trigger. Every code block on this
page is copied from [`examples/sdk/go/hello-node`](../../../examples/sdk/go/hello-node), whose tests pass. Read
[the overview](README.md) and [capabilities.md](capabilities.md) first for what the parts mean. The SDK's own reference is
[`sdks/go/README.md`](../../../sdks/go/README.md); the full example plugin is [`plugins/go-crypto`](../../../plugins/go-crypto),
and the bigger ones are `plugins/google-workspace`, `plugins/databases` and `plugins/threat-intel`.

You need Go 1.26 or later. The SDK is the module `github.com/landflow/landflow/sdks/go`, package `landflow`. It serves HTTP
with `net/http`, gRPC with `google.golang.org/grpc` and traces with OpenTelemetry. Broker drivers are separate nested modules
(`sdks/go/transport/<kind>`), so the SDK itself pulls in no broker client.

## Layout

```
hello-node/
  go.mod        requires the SDK and replaces it with a path (the SDK is not published)
  main.go       landflow.Serve(ctx, newPlugin(), ServeOptions{...})
  plugin.go     the credential type, the nodes, newPlugin()
  plugin_test.go  go test
```

`plugins/go-crypto` has the same shape, with one file per node, `//go:embed icons`, and a `cmd/` folder for a helper.

## The credential

`landflow.CredentialType` declares the form and, with `Test`, the "Test connection" check. `Test` receives a context that
carries the span, so `landflow.HTTPClient(ctx)` traces a real call.

```go
var helloAPI = landflow.CredentialType{
	Name: "helloApi", DisplayName: "Hello API", DocumentationURL: "https://example.com/hello-api",
	Properties: []landflow.PropertyDescriptor{
		// A password field: masked in the UI and redacted from logs and spans.
		{Name: "apiKey", DisplayName: "API key", Type: landflow.PropString, Required: true,
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "salutation", DisplayName: "Salutation", Type: landflow.PropString, Default: "Hello"},
	},
	// A real plugin makes one cheap authenticated call here with landflow.HTTPClient(ctx) (Slack auth.test, Telegram getMe).
	// The sample checks the key's shape so it needs no network.
	Test: func(_ context.Context, data landflow.CredentialData) (bool, string) {
		if strings.HasPrefix(data.String("apiKey"), "hello-") {
			return true, "Key accepted"
		}
		return false, `The key must start with "hello-"`
	},
}
```

<sub>From `examples/sdk/go/hello-node/plugin.go`.</sub>

## The action

One action, two outputs, a credential, a `ContinueOnFail` path and a logged line. A node implements `Description()` and
`Execute()`; descriptors are plain structs that marshal to the wire JSON.

```go
// Greet is one action with two outputs: output 0 gets the greetings, output 1 the items that had nobody to greet.
type Greet struct{}

func (Greet) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "greet", DisplayName: "Hello: Greet", Description: "Greet the name in each item",
		Version: landflow.V(1), Kind: landflow.KindAction,
		Categories: []string{"Examples"}, Icon: "lucide:hand", Subtitle: "{{name}}",
		Idempotent:   true, // the same input gives the same output, so a broker may deliver a call twice
		UsableAsTool: true, // an agent may call it, and it becomes an MCP tool
		Inputs:       []landflow.PortDescriptor{landflow.MainPort()},
		Outputs: []landflow.PortDescriptor{
			{Type: landflow.ConnectionMain, DisplayName: "Greeted"},
			{Type: landflow.ConnectionMain, DisplayName: "Skipped"},
		},
		Credentials: []landflow.NodeCredentialRequirement{{Name: "helloApi", Required: true}},
		Properties: []landflow.PropertyDescriptor{
			{Name: "name", DisplayName: "Name", Type: landflow.PropString, Default: "", Description: "Who to greet. An empty name goes to Skipped."},
			{Name: "shout", DisplayName: "Shout", Type: landflow.PropBoolean, Default: false},
		},
	}
}

func (Greet) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials("helloApi") // a NodeError that names the type when the host sent none
	if err != nil {
		return nil, err
	}
	salutation := creds.StringOr("salutation", "Hello")
	greeted, skipped := []landflow.Item{}, []landflow.Item{}
	for i, item := range ctx.InputData(0) {
		name := strings.TrimSpace(ctx.ParamString("name", i, ""))
		if len(name) > maxNameLength {
			err := landflow.ItemError(i, "The name is longer than %d characters", maxNameLength)
			if !ctx.ContinueOnFail() { // the node is not set to continue: the step fails
				return nil, err
			}
			skipped = append(skipped, ctx.ErrorItem(i, err))
			continue
		}
		if name == "" {
			skipped = append(skipped, landflow.Item{JSON: with(item.JSON, "reason", "empty name")})
			continue
		}
		text := salutation + ", " + name + "!"
		if ctx.ParamBool("shout", i, false) {
			text = strings.ToUpper(text)
		}
		greeted = append(greeted, landflow.Item{JSON: with(item.JSON, "greeting", text)})
	}
	ctx.Logger.Info("greeted %d, skipped %d", len(greeted), len(skipped))
	return [][]landflow.Item{greeted, skipped}, nil
}

// with copies m and sets one key: never change the input item in place.
```

<sub>From `examples/sdk/go/hello-node/plugin.go`.</sub>

Points to copy:

- `ctx.InputData(0)` is the items on main input 0, `ctx.ParamString(name, i, default)` (also `ParamInt`, `ParamFloat`,
  `ParamBool`, `Param`) the parameter for item `i`.
- `ctx.RequireCredentials("helloApi")` returns the `CredentialData` or a `NodeError` that names the type; its `String`,
  `StringOr`, `Int`, `Float`, `Bool` and `Has` read fields. `HasCredentials` is the optional form.
- `landflow.ItemError(i, "format", args...)` is a `NodeError` for item `i`; add `.WithDescription("hint")`. Any other `error`
  becomes the message; a panic is recovered and logged with its stack.
- Outputs are `[][]landflow.Item`, one slice per output. Returning `nil` gives one empty slice per `main` output. Where an
  output has as many items as input 0, items without `pairedItem` get `{item: i}`.
- Defaults: `NewPlugin` fills `Version` to 1, a `main` port on actions' inputs and every output, and `Kind` (action, or
  trigger when `TriggerSource` is set). It panics with every problem it finds; `BuildPlugin` returns an `error` instead.
- `Execute` runs concurrently for different requests: no per-run state on the receiver.
- `*ExecuteContext` is a `context.Context`; pass it to database drivers and `http.NewRequestWithContext`.

## The trigger

```go
// feed is the stand-in for the service a real trigger polls. Tests push to it.
var feed struct {
	sync.Mutex
	requests []map[string]any // each has an "id"
}

func pushRequest(id int, name string) {
	feed.Lock()
	defer feed.Unlock()
	feed.requests = append(feed.requests, map[string]any{"id": id, "name": name})
}

// NewRequest is a poll trigger: the host calls it every pollInterval seconds with the state the last call returned.
type NewRequest struct{}

func (NewRequest) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "newRequest", DisplayName: "Hello: New Request", Description: "Starts the workflow for each new greeting request",
		Version: landflow.V(1), TriggerSource: landflow.TriggerPoll, // the kind defaults to trigger
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Credentials: []landflow.NodeCredentialRequirement{{Name: "helloApi", Required: true}},
		Properties:  []landflow.PropertyDescriptor{landflow.PollIntervalProperty(30)},
	}
}

func (NewRequest) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	if _, err := ctx.RequireCredentials("helloApi"); err != nil {
		return nil, err
	}
	feed.Lock()
	requests := append([]map[string]any(nil), feed.requests...)
	feed.Unlock()
	newest := 0
	for _, r := range requests {
		newest = max(newest, r["id"].(int))
	}
	if ctx.Mode() != landflow.ModePoll { // "Execute" in the editor: a few recent items, no state
		recent := requests[max(0, len(requests)-3):]
		return [][]landflow.Item{toItems(recent)}, nil
	}
	if ctx.IsFirstPoll() { // baseline: remember where we are and emit nothing
		ctx.SetPollState(map[string]any{"lastId": newest})
		return nil, nil
	}
	last := landflow.CredentialData(ctx.PollState()).Int("lastId", 0) // typed access to any map
	ctx.SetPollState(map[string]any{"lastId": max(last, newest)})
	var fresh []map[string]any
	for _, r := range requests {
		if r["id"].(int) > last {
			fresh = append(fresh, r)
		}
	}
	return [][]landflow.Item{toItems(fresh)}, nil
}

func toItems(rows []map[string]any) []landflow.Item {
```

<sub>From `examples/sdk/go/hello-node/plugin.go`.</sub>

`feed` stands in for the service a real trigger would call with `landflow.HTTPClient(ctx)`. `PollIntervalProperty(30)` is the
`pollInterval` property (a poll trigger without one gets `PollIntervalProperty(60)` for you). The poll state is a
`map[string]any`; `landflow.CredentialData(ctx.PollState())` reads typed values from any map. `NewRequest` has no `Inputs`,
which is right for a trigger.

## The plugin and `main.go`

```go
func newPlugin() *landflow.Plugin {
	return landflow.NewPlugin(landflow.PluginInfo{
		ID: "hello-node", Name: "Hello Node", Version: "0.1.0", Description: "A small example plugin",
		Icon: "lucide:hand", Color: "#16a34a", Author: "Landflow examples",
		CredentialTypes: []landflow.CredentialType{helloAPI},
	}, Greet{}, NewRequest{})
}
```

<sub>From `examples/sdk/go/hello-node/plugin.go`.</sub>

```go
func main() {
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7193, GRPCPort: 7293, MaxConcurrency: 8,
	})
	if err != nil {
		log.Fatal(err)
	}
}
```

<sub>From `examples/sdk/go/hello-node/main.go`.</sub>

`Serve` starts HTTP and gRPC and the MCP face, announces every endpoint with a heartbeat, and on `SIGINT` or `SIGTERM`
withdraws and shuts down within `ShutdownTimeout`. `MaxConcurrency` bounds the calls run at once. The ports can be
overridden with `LANDFLOW_HTTP_PORT` and `LANDFLOW_GRPC_PORT` (`off` disables one). Keep `newPlugin()` a function so the tests
build a fresh plugin.

## `go.mod`

```
module github.com/landflow/examples/hello-node

go 1.26.0

require github.com/landflow/landflow/sdks/go v0.0.0

require (
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/felixge/httpsnoop v1.1.0 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.30.0 // indirect
	github.com/modelcontextprotocol/go-sdk v1.8.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/prometheus/client_golang v1.25.0 // indirect
	github.com/prometheus/client_model v0.6.3 // indirect
	github.com/prometheus/common v0.72.0 // indirect
	github.com/prometheus/otlptranslator v1.0.0 // indirect
	github.com/prometheus/procfs v0.22.0 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.72.0 // indirect
	go.opentelemetry.io/otel v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.47.0 // indirect
	go.opentelemetry.io/otel/exporters/prometheus v0.69.0 // indirect
	go.opentelemetry.io/otel/log v1.47.0 // indirect
	go.opentelemetry.io/otel/metric v1.47.0 // indirect
	go.opentelemetry.io/otel/sdk v1.47.0 // indirect
	go.opentelemetry.io/otel/sdk/metric v1.47.0 // indirect
	go.opentelemetry.io/otel/trace v1.47.0 // indirect
	go.opentelemetry.io/proto/otlp v1.11.0 // indirect
	golang.org/x/net v0.59.0 // indirect
	golang.org/x/oauth2 v0.37.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260928230214-8a89bd6388cc // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260928230214-8a89bd6388cc // indirect
	google.golang.org/grpc v1.84.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

// Until the SDK is published, point at the checkout. Four levels up from here is the repository root.
replace github.com/landflow/landflow/sdks/go => ../../../../sdks/go
```

<sub>From `examples/sdk/go/hello-node/go.mod`.</sub>

The SDK is not published and its module path (`github.com/landflow/landflow/sdks/go`) is not the repository's, so `go get`
cannot fetch it: you `require` it at `v0.0.0` and `replace` it with a path. In the sample the path is four levels up; in
`plugins/<name>` it is `../../sdks/go`. Run `go mod tidy` once (offline works when the module cache has the dependencies:
`GOPROXY=off GOFLAGS=-mod=mod go mod tidy`), which writes the indirect requirements and `go.sum`; commit both.

## Run it

```bash
cd examples/sdk/go/hello-node
LANDFLOW_REGISTRY_URL=off go run .                      # stand-alone, no host

# in a second shell
curl -s localhost:7193/.well-known/landflow
curl -s localhost:7193/landflow/v1/manifest
curl -s -XPOST localhost:7193/landflow/v1/test-credentials -H 'content-type: application/json' \
  -d '{"credentialType":"helloApi","data":{"apiKey":"hello-1"}}'
curl -s -XPOST localhost:7193/landflow/v1/execute -H 'content-type: application/json' -d '{
  "protocol":"landflow.plugin/v1","executionId":"e","mode":"manual",
  "node":{"id":"n","name":"n","type":"hello-node.greet","typeVersion":1},
  "parameters":{"name":"Ada"},"itemParameters":[{"name":"Ada"}],"inputs":[[{"json":{}}]],
  "credentials":{"helloApi":{"apiKey":"hello-1"}}}'
```

The last call answers `{"outputs":[[{"json":{"greeting":"Hello, Ada!"},...}],[]],...}`. In `plugins/<name>` the shortcut is
`go run .` from the plugin folder, and a root script `plugin:<name>` in `package.json` like `plugin:go`.

## Register it with a dev host

Start the host (`pnpm dev`, port 3000) and the plugin **without** `LANDFLOW_REGISTRY_URL=off`. It announces to
`http://127.0.0.1:3000`, the host pulls and validates the manifest, and the nodes show in the editor. A plugin on ports
7100-7299 is found by the scan too. After a code change restart the plugin: the new `instanceId` makes the host read the
manifest again. To try it without touching `apps/web/.data`, run a scratch host with its own data directory
([development.md, "Checking a change live"](../../development.md#checking-a-change-live)) and set
`LANDFLOW_REGISTRY_URL=http://localhost:3100`. That is how the samples were checked: they announced as `hello-node`, the
registry listed `greet` and `newRequest`, and every endpoint showed `online`. Add a credential of type
`hello-node.helloApi` with a key that starts with `hello-` and press **Test connection**.

## Test it

There is no harness to import: `Plugin.Execute(ctx, *ExecuteRequest)` is the same function the HTTP and gRPC faces call,
so a test builds the request the host would send and reads the `*ExecuteResponse`. No server, no network.

| Call | Returns |
|---|---|
| `plugin.Execute(ctx, &req)` | `*ExecuteResponse` (`Outputs`, `Error`, `PollState`, `Logs`) |
| `plugin.TestCredentials(ctx, &req)` | `*TestCredentialsResponse` (`OK`, `Message`) |
| `plugin.LoadOptions(ctx, &req)` | `*LoadOptionsResponse`: the options for a `loadOptionsMethod` |
| `plugin.Manifest()` | `PluginManifest`: assert on nodes, outputs, `Testable` |
| `mcpface.New(plugin.Manifest(), ...)` | the plugin's MCP tools, as `plugins/go-crypto/transports_test.go` lists them |

```go
var credentials = map[string]any{"helloApi": map[string]any{"apiKey": "hello-123", "salutation": "Hello"}}

// run sends the request the host would send. No server and no network.
func run(t *testing.T, node string, req landflow.ExecuteRequest, items ...map[string]any) *landflow.ExecuteResponse {
	t.Helper()
	req.Protocol, req.ExecutionID = landflow.ProtocolVersion, "ex_test"
	if req.Mode == "" {
		req.Mode = landflow.ModeManual
	}
	req.Node = landflow.NodeRef{ID: "n1", Name: "N", Type: "hello-node." + node, TypeVersion: 1}
	if req.Credentials == nil {
		req.Credentials = credentials
	}
	req.Inputs = [][]landflow.Item{{}}
	for _, it := range items {
		req.Inputs[0] = append(req.Inputs[0], landflow.Item{JSON: it})
		req.ItemParameters = append(req.ItemParameters, req.Parameters)
	}
	resp, err := newPlugin().Execute(context.Background(), &req)
	if err != nil {
		t.Fatalf("%s: %v", node, err)
	}
	return resp
}

func TestGreetSendsGreetingsToOutput0AndEmptyNamesToOutput1(t *testing.T) {
```

<sub>From `examples/sdk/go/hello-node/plugin_test.go`.</sub>

```go
func TestNewRequestRecordsABaselineThenReturnsOnlyWhatIsNew(t *testing.T) {
	feed.requests = nil
	pushRequest(1, "old")
	first := run(t, "newRequest", landflow.ExecuteRequest{Mode: landflow.ModePoll})
	if len(first.Outputs) != 0 && len(first.Outputs[0]) != 0 {
		t.Errorf("the baseline poll emitted %v", first.Outputs)
	}
	if first.PollState["lastId"] != 1 {
		t.Fatalf("pollState = %v", first.PollState)
	}

	pushRequest(2, "new")
	second := run(t, "newRequest", landflow.ExecuteRequest{Mode: landflow.ModePoll, PollState: first.PollState})
	if len(second.Outputs[0]) != 1 || second.Outputs[0][0].JSON["name"] != "new" || second.PollState["lastId"] != 2 {
		t.Errorf("second = %+v", second)
	}
}

func TestNewRequestShowsRecentItemsInManualModeWithoutState(t *testing.T) {
```

<sub>From `examples/sdk/go/hello-node/plugin_test.go`.</sub>

```bash
cd examples/sdk/go/hello-node
go vet ./... && go test ./...
```

Run a bundled plugin's tests with `cd plugins/go-crypto && go test ./...`. Tests that need a real service skip unless
`LANDFLOW_INTEGRATION` names them ([development.md](../../development.md)).

## Package it

1. **Move it into `plugins/<name>`**, change the `replace` to `../../sdks/go`, and run `go mod tidy`. `main.go` must be a
   `package main` at the folder's root: the image builds `go build -o /out/plugin .` there. A built binary in the folder is
   ignored by `.gitignore` for the bundled plugins; add yours.
2. **Image.** `deploy/docker/go-plugin.Dockerfile` copies the module files first (for the download layer), then
   `sdks/go` and `plugins/${PLUGIN}`, builds a static binary (`CGO_ENABLED=0`) and runs it as an unprivileged user on
   Alpine with a health check:

   ```bash
   docker build -f deploy/docker/go-plugin.Dockerfile \
     --build-arg PLUGIN=<name> --build-arg HTTP_PORT=<7xxx> --build-arg GRPC_PORT=<7yyy> \
     -t landflow/plugin-<name>:dev .
   ```

   Brokers: blank-import `sdks/go/transport/kafka`, `amqp`, `nats` or `valkey` in `main.go` (as `plugins/go-crypto/main.go`
   does) and add them to the `require` and `replace` lines; a face then starts when `LANDFLOW_TRANSPORTS` names it and
   `LANDFLOW_<KIND>_URL` is set. Build locally only and never push; compose builds with `COMPOSE_BAKE=false`, and an image
   for the OrbStack cluster with `docker --context orbstack buildx build --builder orbstack --load`
   ([CLAUDE.md](../../../CLAUDE.md)).
3. **Compose and Kubernetes.** Copy the `go-crypto` block in `deploy/compose.yml` (names, ports, `LANDFLOW_ADVERTISE_HOST`,
   and the service name in `LANDFLOW_SCAN_HOSTS`), and, for Kubernetes, a component modelled on `deploy/k8s/base/plugins/go-crypto.yaml` (a component plus an overlay
   `images:` entry with `newTag: k8s-dev`, see [kubernetes.md](../kubernetes.md)). The image listens on `0.0.0.0` (`LANDFLOW_LISTEN_HOST`), so the MCP face needs
   `LANDFLOW_MCP_TOKEN` or `LANDFLOW_MCP=off`.
4. Docs: a row in `docs/history.md`, the plugin's README, `docs/limitations.md` if it is not finished.

## Add it to the marketplace

Add `plugins/<name>/landflow.plugin.json` and an entry in `.claude-plugin/marketplace.json`
([the format](capabilities.md#marketplace-format-and-bundled-flows)); `plugins/threat-intel/landflow.plugin.json` is the Go
one:

```json
{
  "id": "threat-intel",
  "runtime": "go",
  "install": ["go", "build", "-o", "threat-intel", "."],
  "start": ["./threat-intel"]
}
```

<sub>From `plugins/threat-intel/landflow.plugin.json`.</sub>

For `"runtime": "go"` the host runs `install` (a `go build`) in the downloaded folder, after pointing `replace` directives
that name `sdks/go` and its transport modules at its own copy, so a plugin from this repository builds in place
([marketplace.md](../../marketplace.md#landflow-node-plugins)). The machine needs Go.

## Outside this repository

The SDK is not published and `go get` cannot fetch it. Clone the repository next to your module and replace:

```bash
git clone https://github.com/landfalls-ai/landflow.git ../landflow
go mod edit -require github.com/landflow/landflow/sdks/go@v0.0.0 \
            -replace github.com/landflow/landflow/sdks/go=../landflow/sdks/go
go mod tidy
```

That is what the sample's `go.mod` does, and it builds and tests as shown above. Pin the clone to a commit you have
tested. Your module's path can be anything; the SDK's package name is `landflow`.

## Traps

- **Return one slice per output**, even an empty one: `[][]landflow.Item{greeted, skipped}`; `nil` alone is one empty output
  per `main` output.
- **A `nil` slice marshals as `null`.** Start slices with `[]landflow.Item{}` when the host should see `[]`.
- **Do not change the input item's map**; copy it (`with()` in the sample).
- **A poll trigger must set a baseline** on the first poll (`ctx.IsFirstPoll()`) and return nothing.
- **JSON numbers decode as `float64`** in maps the SDK builds from a request; use `ParamInt`, `CredentialData.Int` and
  `PollState` through `CredentialData(...)`. The sample's own feed uses `int` because it builds the maps itself.
- **Pointers for numbers that may be 0** in `TypeOptions` (`landflow.Ptr(0.0)`), or the field is omitted.
- **`newPlugin()` panics at startup** on a bad descriptor and lists every problem; run `go test` to see it before a deploy.
