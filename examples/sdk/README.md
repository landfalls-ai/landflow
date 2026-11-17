# SDK examples

One small plugin, `hello-node`, written three times, one per SDK. Each has the same parts: a credential type with a
"Test connection" check, an action with two outputs (`greet`), a poll trigger (`newRequest`), and tests that run
without a server or network.

| Language | Folder | Test | Run | Ports (HTTP / gRPC) |
|---|---|---|---|---|
| TypeScript | [typescript/hello-node](typescript/hello-node) | `pnpm --filter @landflow/sdk exec vitest run --root ../../examples/sdk/typescript/hello-node` | `tsx src/main.ts` | 7191 / 7291 |
| Python | [python/hello-node](python/hello-node) | `.venv/bin/python -m unittest discover -s tests` | `.venv/bin/python main.py` | 7192 / 7292 |
| Go | [go/hello-node](go/hello-node) | `go test ./...` | `go run .` | 7193 / 7293 |

How to use them, and what each part does: [docs/platform/sdk/](../../docs/platform/sdk/README.md). The three are not
bundled plugins: no compose file, image or marketplace entry names them, and they are not in `pnpm-workspace.yaml`
(adding `examples/*` there would change the lockfile).
