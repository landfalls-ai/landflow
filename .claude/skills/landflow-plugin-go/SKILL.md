---
name: landflow-plugin-go
description: Build a Landflow node plugin in Go with the Landflow Go SDK. Use when asked to "write a Landflow node in Go", "add an integration/plugin for X using Go", "a node that ...", "add a trigger/credential/webhook to a Go plugin", or to scaffold, run, test, register, containerize or add a Go plugin to the Landflow marketplace.
---

# Build a Landflow plugin in Go

You turn a request ("a node that ...") into a working plugin: descriptor, `Execute`, credential, optional trigger, tests,
a local run that a host can discover, a Dockerfile route and a marketplace entry. Work in small steps and run each check.

## 0. Where am I?

Run `ls docs/platform/sdk examples/sdk/go/hello-node sdks/go/plugin.go 2>&1 | head`.

- **Those exist (inside the Landflow repository).** Read the local files named below. Build in `plugins/<name>/`.
- **They do not (your own repository).** Use GitHub. Fetch with `WebFetch` or `gh api`:
  `https://raw.githubusercontent.com/landfalls-ai/landflow/main/<path>` for raw files, or
  `https://github.com/landfalls-ai/landflow/blob/main/<path>`. The SDK module is **not fetchable with `go get`**: see step 9.

Read first (local path, same path on GitHub):

1. `docs/platform/sdk/go.md`: the walk-through of the whole job, with code copied from the sample.
2. `docs/platform/sdk/capabilities.md`: pick the features the request needs (outputs, trigger kind, binary data, OAuth, MCP).
3. `examples/sdk/go/hello-node/plugin.go`, `main.go`, `plugin_test.go`, `go.mod`: the template to copy.
4. `sdks/go/README.md`: the context API; `docs/protocol.md` only when a field is unclear.
5. The closest shipped plugin: `plugins/go-crypto` (pure transforms, load-options), `plugins/databases` (binary data, triggers),
   `plugins/google-workspace` (OAuth2, activity items), `plugins/threat-intel` (HTTP integrations with a cache).

## 1. Decide the shape (write it down before coding)

Answer these from the request, then tell the user in two lines:

- Plugin id (lowercase, dashes) and folder `plugins/<id>`; node names (lowerCamelCase, local).
- Per node: action or trigger (`TriggerPoll` or `TriggerAppWebhook`; `TriggerWebhook` and `TriggerSchedule` are never started for a plugin, `manual` and `chat` only start a run by hand), outputs, the
  parameters (type, default, `DisplayOptions`), `Idempotent` (true for a read), `UsableAsTool`.
- Credential type: fields, which are `Password`, an overridable `baseUrl`, a cheap `Test`. OAuth2: `Extends: []string{"oAuth2Api"}`.
- What a plugin **cannot** do from a separate process: wait/resume, sub-nodes (model, memory), streaming. If the request needs it,
  say so and propose the host's own nodes around the plugin (`docs/limitations.md`).

## 2. Scaffold

```bash
mkdir -p plugins/<id> && cp examples/sdk/go/hello-node/{go.mod,go.sum,main.go,plugin.go,plugin_test.go} plugins/<id>/
```

Then in `plugins/<id>`: change the module path (`github.com/landflow/landflow/plugins/<id>`, as `plugins/go-crypto/go.mod`), the
`replace` to `../../sdks/go`, the plugin id and ports (`grep -rnE "HTTPPort: [0-9]+" plugins/*/main.go`; 7101-7121 (gRPC 7201-7221) and the samples'
7191-7193 are taken: start at HTTP 7122, gRPC 7222), rename `hello-node`, and run `GOPROXY=off GOFLAGS=-mod=mod go mod tidy` (drop `GOPROXY=off` if a dependency is
missing from the cache). The package must stay `package main` at the folder root.

## 3. Write the node

- A type with `Description() landflow.NodeDescriptor` and `Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error)`.
  Descriptor: `Name`, `DisplayName`, `Description`, `Version: landflow.V(1)`, `Kind`, `Inputs`/`Outputs` (`landflow.MainPort()`, or a
  `PortDescriptor` with `DisplayName`), `Credentials`, `Properties`, `Idempotent`.
- Loop `for i, item := range ctx.InputData(0)`, read `ctx.ParamString/Int/Float/Bool(name, i, default)`, call APIs with
  `landflow.HTTPClient(ctx)` (traced), return `[][]landflow.Item{out0, out1}`. Copy item maps; set `PairedItem` when you add items.
- Errors: `landflow.ItemError(i, "msg %s", x).WithDescription("what to do")`. For `ctx.ContinueOnFail()` append `ctx.ErrorItem(i, err)` and go on.
- Dynamic lists: `TypeOptions{LoadOptionsMethod: "getX"}` plus `LoadOptions(method string, params map[string]any)` (or
  `LoadOptionsWithContext`) on the node.
- Binary: `ctx.BinaryBytes`, `ctx.BinaryReader`, `ctx.PrepareBinary` (capabilities.md, "Binary data").
- No per-run state on the receiver (`Execute` runs concurrently). Numbers that may be 0 in `TypeOptions` are pointers (`landflow.Ptr`).
  Start output slices as `[]landflow.Item{}` so the host sees `[]`, not `null`. Never log secrets.

## 4. Credential

`landflow.CredentialType{Name, DisplayName, DocumentationURL, Properties, Test}` with `TypeOptions: &landflow.TypeOptions{Password: true}`
on the secret, a `baseUrl`, and `Test` making one cheap authenticated call and returning `(ok, message)`. Pass it in
`PluginInfo.CredentialTypes` and list it in each node's `Credentials`. Read with `ctx.RequireCredentials("name")` (a `CredentialData`
with `String`, `StringOr`, `Int`, `Bool`). Never put a real token in code, tests or docs: tests use fake values.

## 5. Trigger (only if asked)

Poll: `TriggerSource: landflow.TriggerPoll`, `Properties: []landflow.PropertyDescriptor{landflow.PollIntervalProperty(60)}`; on the first
poll (`ctx.IsFirstPoll()`) `ctx.SetPollState(...)` and return `nil, nil`; later return only new items and set the state (read it with
`landflow.CredentialData(ctx.PollState()).Int("lastId", 0)`); in `landflow.ModeManual` return the latest few and no state. App webhook:
`TriggerAppWebhook` and implement `landflow.WebhookNode` (`WebhookCreate`, `WebhookDelete`, `Webhook`) and optionally
`WebhookChecker`; verify with `VerifyGitHubSignature`, `VerifyHMACSHA256`, ...; return `&landflow.WebhookResult{Items, IdempotencyKey}`;
keep the hook id and secret in `ctx.StaticData()`. Doc comment with the pattern: `sdks/go/webhooks.go`.

## 6. Test (write them with the node, not after)

Copy `plugin_test.go`: `run(...)` builds the `ExecuteRequest` and calls `newPlugin().Execute(ctx, &req)`. Cover each output, an error with
`ItemIndex`, `ContinueOnFail`, a missing credential, `TestCredentials`, the poll baseline and the next poll (`PollState` passed back in), and
`Manifest()`. Stub network calls with `httptest.NewServer` and a base URL from the credential, never the real service.

```bash
cd plugins/<id> && gofmt -l . && go vet ./... && go test ./...
```

## 7. Run, discover, register

```bash
cd plugins/<id> && LANDFLOW_REGISTRY_URL=off go run .       # in the background
curl -s localhost:<http>/.well-known/landflow; curl -s localhost:<http>/landflow/v1/manifest
curl -s -XPOST localhost:<http>/landflow/v1/execute -H 'content-type: application/json' -d '<an ExecuteRequest>'
```

Check the manifest lists your nodes and credential types and an execute answers. Then register with a host: start it (`pnpm dev`, or a
scratch host with its own `LANDFLOW_DATA_DIR` per `docs/development.md` "Checking a change live") and start the plugin without
`LANDFLOW_REGISTRY_URL=off`. Stop only the processes you started, by pid; delete any binary you built. Never touch `apps/web/.data` or other
people's containers.

## 8. Package (only when asked)

- Image: `deploy/docker/go-plugin.Dockerfile --build-arg PLUGIN=<id> HTTP_PORT=... GRPC_PORT=...`; it builds `.` in `plugins/<id>` as a static
  binary. The `replace` lines must be the relative ones (`../../sdks/go`). For brokers, blank-import `sdks/go/transport/kafka|amqp|nats|valkey`
  as `plugins/go-crypto/main.go` does. Local only: `COMPOSE_BAKE=false`; OrbStack cluster images
  `docker --context orbstack buildx build --builder orbstack --load`; never push.
- Compose: copy the `go-crypto` block in `deploy/compose.yml` and add the service to `LANDFLOW_SCAN_HOSTS`. Kubernetes: follow `landflow-kubernetes` step 6 (a component under `deploy/k8s/components/<id>/` plus an overlay `images:` entry with `newTag: k8s-dev`); do not add it to the base. Add your built binary name to `.gitignore`.
- Marketplace: `plugins/<id>/landflow.plugin.json` (`{"id":"<id>","runtime":"go","install":["go","build","-o","<id>","."],"start":["./<id>"]}`),
  an entry in `.claude-plugin/marketplace.json`, flows in `flows/`. The host rewrites the SDK `replace` to its own copy. Run
  `cd apps/web && npx vitest run test/plugin-flows.test.ts`.
- A node in a **bundled** plugin also needs its recorded manifest refreshed (`docs/development.md`, "Recorded plugin manifests").

## 9. Outside the Landflow repository

The module `github.com/landflow/landflow/sdks/go` is not fetchable (its path is not the repository's). Clone and replace:

```bash
git clone https://github.com/landfalls-ai/landflow.git ../landflow
go mod edit -require github.com/landflow/landflow/sdks/go@v0.0.0 -replace github.com/landflow/landflow/sdks/go=../landflow/sdks/go
go mod tidy
```

Pin the clone to a commit you tested. Go 1.26+. Copy the sample's `plugin.go`, `main.go`, `plugin_test.go`; only the `go.mod` `replace`
path differs.

## 10. Checks before you say done

- [ ] `gofmt -l .` prints nothing, `go vet ./...` and `go test ./...` pass; if you touched `sdks/go`, run `go test ./...` there too.
- [ ] The plugin starts, the manifest validates, one `execute` call returns the expected outputs (shown to the user).
- [ ] No secret, personal data or real token in any file; credential fields are `Password`, a `baseUrl` is overridable.
- [ ] Docs: the plugin's `README.md`, a row in `docs/history.md`, `docs/limitations.md` for what is not done, the feature map in
  `docs/README.md` if it is a new page (`CLAUDE.md`, "Every change updates its docs").
- [ ] You stopped every process you started and removed built binaries. Nothing was pushed or deployed.

## Traps

Do not use `TriggerWebhook` or `TriggerSchedule` for a plugin node (the host never starts them; manual and chat triggers only run by hand). Do not rename a node or parameter after release. A poll
trigger with no baseline replays history. Returning `[][]landflow.Item{all}` for a node with two outputs sends everything to output 0.
`NewPlugin` panics at startup and lists every problem: run the tests to see it. JSON numbers arrive as `float64` in maps: use `ParamInt`
and `CredentialData.Int`.
