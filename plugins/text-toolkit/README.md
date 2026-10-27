# Text Toolkit

Example TypeScript plugin: Slugify, Change Case, Render Template and Regex Extract. All four are pure transforms, so every node is
`idempotent: true` (a broker may deliver a call twice without harm; the MCP tools carry `idempotentHint: true`).

```sh
pnpm --filter @landflow/plugin-text-toolkit start   # HTTP :7101 (MCP at /mcp), gRPC :7201
pnpm --filter @landflow/plugin-text-toolkit test
```

## Files (binary data)

Two nodes work with `item.binary` (docs/protocol.md §11):

| Node | Option | What it does |
|---|---|---|
| **Render Template** (`template`) | Also Output as File: Binary Field (`data`), File Name (`rendered.txt`), MIME Type (`text/plain`) | Stores the rendered text as a UTF-8 file next to the JSON output field; the item's other files stay. Attach it to an email or upload it |
| **Regex Extract** (`regexExtract`) | Text From: **Binary File**, Input Binary Field (`data`) | Matches against a text file of the item (UTF-8, byte order mark dropped) instead of a JSON field; "One Item per Match" works as before |

## Transports

By default the plugin serves HTTP and gRPC and announces both to the host. To add a broker, name its kind in `LANDFLOW_TRANSPORTS`
and give the connection URL (the host needs a matching connection under Settings → Transports):

```sh
LANDFLOW_TRANSPORTS=http,grpc,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=… pnpm --filter @landflow/plugin-text-toolkit start
```

Kinds are those of `@landflow/transports` (`kafka`, `amqp`, `nats`, `jetstream`, `valkey`, `mqtt`, `amqp1`, `pulsar`, `sqs`, `pubsub`,
`servicebus`); each reads `LANDFLOW_<KIND>_URL`. Calls over a broker are encrypted and signed with `LANDFLOW_TRANSPORT_SECRET` (the
host's value).

**`maxConcurrency`** defaults to **8** (`DEFAULT_MAX_CONCURRENCY` in `src/main.ts`): the nodes are CPU-bound string work, so about one
core's worth of parallel calls; `LANDFLOW_MAX_CONCURRENCY` overrides it.

## MCP

Nodes marked `usableAsTool` are MCP tools on `http://127.0.0.1:7101/mcp` (`slugify`, `changeCase`; the gateway prefixes the
plugin id). The face listens on loopback with no token; with `LANDFLOW_ADVERTISE_HOST` set (containers) it listens on 0.0.0.0 and needs
`LANDFLOW_MCP_TOKEN`, or `LANDFLOW_MCP=off`. `LANDFLOW_HOST` overrides the bind address. `--mcp-stdio` serves the tools to a local agent
without Landflow.
