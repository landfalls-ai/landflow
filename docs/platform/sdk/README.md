# Writing node plugins with the SDKs

Every node in Landflow comes from a **plugin**: a process that describes its nodes in JSON, runs them when asked, and
tells the host where it is. You can write one in TypeScript, Python or Go with the SDK for that language. The host
needs no frontend code from you: it draws the editor form from your descriptor.

This section is for someone who will write a plugin. Start here, then read the capabilities page, then the page for
your language. The same `hello-node` plugin is built in all three, and the code on these pages is copied from it.

| Page | What it answers |
|---|---|
| this page | what a plugin is, the contract, how the host finds it, which transports, which language |
| [capabilities.md](capabilities.md) | everything a plugin can do, with a sample and the support per language |
| [typescript.md](typescript.md) | build, run, register, test, package and publish a plugin with `@landflow/sdk` |
| [python.md](python.md) | the same with `landflow-sdk` |
| [go.md](go.md) | the same with the Go SDK |
| [`examples/sdk/`](../../../examples/sdk/README.md) | the runnable samples, with tests |

Claude Code users: the plugin `claude-plugins/landflow-dev` carries one skill per language
(`landflow-plugin-typescript`, `landflow-plugin-python`, `landflow-plugin-go`) that does the steps on these pages for you.

## What a node plugin is

```
 your plugin process                                  Landflow host
 -------------------                                  -------------
 NodeDescriptor + execute()   <-- landflow.plugin/v1 -->   registry, editor, engine
 (HTTP, gRPC, a broker, MCP)                                 builds the form, runs the workflow
```

- A **node** is a descriptor (name, kind, ports, parameters, credentials, icon) plus an `execute` function that turns
  input items into output items. An item is `{ json, binary? }`.
- A **plugin** is one process holding one or more nodes, the **credential types** they use, and optionally
  **composite types**. Its id is lowercase with dashes (`hello-node`); the host sees a node as `<pluginId>.<name>`
  (`hello-node.greet`).
- A node is one of three kinds: an `action` (items in, items out), a `trigger` (starts a run) or a `subnode` (supplies
  a model, tool or memory to an AI node). A remote plugin writes actions and triggers: see
  [what a plugin cannot do](capabilities.md#what-a-plugin-cannot-do).

## The contract in a paragraph

The wire contract is `landflow.plugin/v1` ([docs/protocol.md](../../protocol.md)). A plugin answers
`GET /landflow/v1/manifest` (or gRPC `GetManifest`) with a `PluginManifest`: its info, its nodes, its credential
types. The host validates it against a zod schema (`parseManifest`, `packages/protocol/src/schema.ts:428`) and only
then shows the nodes. To run a node the host sends an `ExecuteRequest` (node type, parameters, input items, decrypted
credentials, the mode, the poll state) and reads back an `ExecuteResponse` (output items per output, logs, an error, the
next poll state, records). A node that fails is still HTTP 200 with `error` set; 400 is a malformed request and 404 an
unknown node. The other calls are `load-options` (dynamic dropdowns), `test-credentials` ("Test connection"),
`health`, and `webhook-method` and `webhook` for app webhook triggers. The same shapes travel over gRPC
(`packages/protocol/proto/landflow/plugin/v1/plugin.proto`) and, wrapped in an envelope, over brokers.

The TypeScript types are the source of truth (`packages/protocol/src/types.ts`: `NodeDescriptor` at line 199,
`ExecuteRequest` at 542, `ExecuteResponse` at 639); the JSON Schemas in `packages/protocol/schema/` are generated from
them. The SDKs of the other two languages mirror them by hand, and the shared fixtures in
`packages/protocol/conformance/` keep the three honest.

## Discovery and registration

The host learns about a plugin from any of five sources, all feeding one registry
([protocol §1](../../protocol.md#1-lifecycle), [plugins.md](../../plugins.md#autodiscovery)):

| Source | How | Use it for |
|---|---|---|
| **Announce** (push) | the SDK's `serve()` calls `POST {LANDFLOW_REGISTRY_URL}/api/plugins/announce` (or gRPC `RegistryService.Announce` on `:7070`) with a 30 s lease, and repeats every 10 s; a stop withdraws it | the default, in dev, compose and containers |
| **Static** | `LANDFLOW_PLUGINS=http://host:7101,grpc://host:7203` on the host | fixed endpoints |
| **Scan** (pull) | the host probes `LANDFLOW_SCAN_HOSTS` x `LANDFLOW_SCAN_PORTS` (default `127.0.0.1` x `7100-7299`) | a plugin started by hand on a free port |
| **Kubernetes** (pull) | `LANDFLOW_PLUGIN_DISCOVERY=kubernetes`: Services labelled `landflow.dev/plugin=true` with a ready pod | the cluster, see [protocol §13](../../protocol.md#13-kubernetes-discovery-and-registry-proofs) |
| **Marketplace** | installing a plugin that has a `landflow.plugin.json`: the host downloads, runs and supervises it | people who do not run the process themselves, see [marketplace.md](../../marketplace.md#landflow-node-plugins) |

What a developer needs to know:

- The registry is `apps/web/src/lib/server/plugins/registry.ts` (`announce` at line 299). An announce from an endpoint
  that is already online with the same `version` is a heartbeat. A **new `instanceId`** (the SDKs send a random one per
  process) makes the host pull the manifest again, so while you develop you see new parameters after a restart with no
  version bump.
- A lease that is not renewed in `ttlSeconds` marks the plugin **offline**. Its nodes stay on screen, greyed, so saved
  workflows still open.
- Who may register is a policy ([plugins.md](../../plugins.md#registration-rules)): open in the development profile,
  `LANDFLOW_REGISTRY_SECRET` and a challenge proof in production.
- Several endpoints may serve one plugin id (replicas, or the same plugin over HTTP and gRPC). The host spreads calls
  and picks the transport per call.

The environment variables every SDK reads:

| Variable | Default | Meaning |
|---|---|---|
| `LANDFLOW_REGISTRY_URL` | `http://127.0.0.1:3000` | where to announce; `off` for stand-alone |
| `LANDFLOW_ADVERTISE_HOST` | `127.0.0.1` | host written into the announced endpoints (set it in a container) |
| `LANDFLOW_HTTP_PORT`, `LANDFLOW_GRPC_PORT` | the ports in code | override the ports (`off` disables one in Python and Go) |
| `LANDFLOW_TRANSPORTS` | every face given | which faces start, such as `http,grpc,nats` |
| `LANDFLOW_MAX_CONCURRENCY` | the code's value | calls run at once; the rest wait, then are refused with 429 |
| `LANDFLOW_MCP`, `LANDFLOW_MCP_TOKEN` | `on` | the plugin's own MCP face; a token is needed off loopback |
| `LANDFLOW_REGISTRY_SECRET` | unset | shared secret for announce and registry proofs (production) |

## Transports

One plugin has one core and several **faces** ([docs/transports.md](../../transports.md)). The core is the
dispatcher, which applies the deadline, cancellation, the concurrency limit, telemetry and credential redaction. A face
only converts a wire into dispatcher calls.

| Face | In the SDKs | Needs |
|---|---|---|
| **HTTP + JSON** | all three, always | nothing: the default and the easiest to debug with `curl` |
| **gRPC** | all three | Python needs the `[grpc]` extra; without grpcio the plugin serves HTTP only and logs it |
| **Brokers** | Kafka, RabbitMQ (AMQP 0.9), NATS, JetStream, Valkey in all three; MQTT, AMQP 1.0, SQS, Pub/Sub, Pulsar, Service Bus in TypeScript, and for any language through the `landflow-bridge` sidecar | `LANDFLOW_TRANSPORTS=http,nats` + `LANDFLOW_NATS_URL=...` + `LANDFLOW_TRANSPORT_SECRET`; no inbound port |
| **MCP** | all three: Streamable HTTP at `/mcp` on the HTTP port, and stdio with `--mcp-stdio` | Python needs `[mcp]`; a token off loopback |

The host's selector picks a face per call: **Auto** by default (gRPC, then HTTP, then brokers), or a policy that pins one
or allows a list. Over a broker the call is encrypted and signed, at most once by default and at least once for nodes
marked `idempotent`. See [transports.md](../../transports.md) for delivery rules, and
[limitations.md](../../limitations.md) for what is not built.

## Picking a language

| | TypeScript | Python | Go |
|---|---|---|---|
| Good for | glue code, JSON-heavy work, anything that wants the richest SDK | data work, existing Python libraries, scripts | CPU-bound work, one static binary, small images |
| Package | `@landflow/sdk` (workspace package, not on npm) | `landflow-sdk` (not on PyPI; installs from the repository) | `github.com/landflow/landflow/sdks/go` (not fetchable; use a `replace`) |
| Dependencies | Node 22+, `tsx` | Python 3.11+, stdlib only for HTTP; extras for gRPC, MCP, OTel, brokers | Go 1.26+, one module |
| Image | `deploy/docker/node-plugin.Dockerfile` (Alpine, runs from source with `tsx`) | `deploy/docker/python-plugin.Dockerfile` (venv, slim) | `deploy/docker/go-plugin.Dockerfile` (static binary, Alpine) |
| Tests | vitest, `runNode` | `unittest`, `plugin.execute` | `go test`, `Plugin.Execute` |
| Sample | [typescript.md](typescript.md) | [python.md](python.md) | [go.md](go.md) |

A rule of thumb: choose the language your integration's client library is best in. The three SDKs implement the same
protocol and the same set of features (the matrix in [capabilities.md](capabilities.md) lists the few differences), so
you can change your mind later without changing how the host sees the plugin.

Nothing is published: none of the three SDKs is on npm, PyPI or a Go proxy. Inside this repository you use them from
the checkout. Outside it, [each language page](#where-to-go-next) says how to vendor the SDK from GitHub.

## Where the shipped plugins are

`plugins/text-toolkit` (TypeScript), `plugins/py-insights` (Python) and `plugins/go-crypto` (Go) are the small
reference plugins, one per SDK, ports 7101-7103 / 7201-7203. The integration plugins (`github`, `messaging`,
`productivity`, `google-workspace`, `databases`, `linear`, `attio`, `fathom`, `triage`, `landfall`, `clickland`,
`landledger`, ...) are bigger examples of the same patterns. The list with their ports is in
[development.md](../../development.md) and the marketplace entries in `.claude-plugin/marketplace.json`.

## Where to go next

1. [capabilities.md](capabilities.md): pick the features your plugin needs.
2. Your language: [TypeScript](typescript.md), [Python](python.md) or [Go](go.md).
3. [docs/plugins.md](../../plugins.md) and [docs/protocol.md](../../protocol.md) for the full contract.
4. [docs/marketplace.md](../../marketplace.md) to ship it to other people.
