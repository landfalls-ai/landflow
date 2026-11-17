# hello-node (TypeScript)

The smallest useful Landflow plugin in TypeScript: `greet` (a credential, two outputs) and `newRequest` (a poll
trigger). Walk-through: [docs/platform/sdk/typescript.md](../../../../docs/platform/sdk/typescript.md).

| File | What |
|---|---|
| `src/plugin.ts` | the credential type, the two nodes, `definePlugin` |
| `src/main.ts` | `serve(plugin, { http: 7191, grpc: 7291 })` |
| `test/hello.test.ts` | the tests: build the request the host sends, call `runNode`, read the response |
| `tsconfig.json`, `vitest.config.ts` | map `@landflow/sdk` and `@landflow/protocol` to the workspace sources, because this folder is **not** a workspace package |
| `package.json` | what to keep when you copy the folder to `plugins/<name>` (then `pnpm install` links the workspace packages and the config files are not needed) |

Run everything from the repository root after `pnpm install`:

```bash
# tests (vitest comes from packages/sdk)
pnpm --filter @landflow/sdk exec vitest run --root ../../examples/sdk/typescript/hello-node

# type check
node_modules/.bin/tsc -p examples/sdk/typescript/hello-node/tsconfig.json

# serve, stand-alone (tsx comes from plugins/text-toolkit)
LANDFLOW_REGISTRY_URL=off pnpm --filter @landflow/plugin-text-toolkit exec tsx \
  --tsconfig ../../examples/sdk/typescript/hello-node/tsconfig.json ../../examples/sdk/typescript/hello-node/src/main.ts

curl -s localhost:7191/.well-known/landflow
curl -s localhost:7191/landflow/v1/manifest
```

To show up in a dev host, leave out `LANDFLOW_REGISTRY_URL=off` (it announces to `http://127.0.0.1:3000`).
