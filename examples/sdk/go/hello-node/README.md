# hello-node (Go)

The smallest useful Landflow plugin in Go: `greet` (a credential, two outputs) and `newRequest` (a poll trigger).
Walk-through: [docs/platform/sdk/go.md](../../../../docs/platform/sdk/go.md).

| File | What |
|---|---|
| `plugin.go` | the credential type, the two nodes, `newPlugin()` |
| `main.go` | `landflow.Serve(ctx, newPlugin(), ServeOptions{HTTPPort: 7193, GRPCPort: 7293})` |
| `plugin_test.go` | `go test`: build the request the host sends, call `Plugin.Execute`, read the response |
| `go.mod` | requires the SDK and `replace`s it with `../../../../sdks/go` (the SDK is not published) |

```bash
cd examples/sdk/go/hello-node
go test ./...
LANDFLOW_REGISTRY_URL=off go run .                      # then, in another shell:
curl -s localhost:7193/.well-known/landflow
curl -s localhost:7193/landflow/v1/manifest
```

To show up in a dev host, leave out `LANDFLOW_REGISTRY_URL=off` (it announces to `http://127.0.0.1:3000`).
