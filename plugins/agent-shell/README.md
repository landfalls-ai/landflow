# Agent Shell plugin

One node, **Agent Shell**: runs a bash command in [just-bash](https://github.com/vercel-labs/just-bash) (a simulated bash) over an in-memory filesystem.
Usable as an agent tool with `command` and an optional `files` map. No host files, no network, no Python or JavaScript.

```bash
pnpm plugin:agent-shell     # HTTP 7114, gRPC 7214
pnpm --filter @landflow/plugin-agent-shell test
```

The limits and the verdict are in `docs/research/just-bash-verdict.md`; the engine is `src/shell.ts`.
