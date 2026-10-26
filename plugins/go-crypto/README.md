# Crypto Toolkit (go-crypto)

The example plugin for the Landflow Go SDK: **Hash** (SHA-256, SHA-1, SHA-512, MD5), **UUID** (v4), **Base64** (encode, decode, URL-safe)
and **JWT Decode** (claims only, the signature is not verified). HTTP on `:7103`, gRPC on `:7203`.

```sh
go run .                              # announce to http://127.0.0.1:3000
LANDFLOW_REGISTRY_URL=off go run .    # standalone
go test ./...
```

## Transports

By default the plugin serves HTTP and gRPC and announces both to the host. It also links in the Go SDK's tier 1 broker drivers (Kafka,
RabbitMQ `amqp`, NATS with JetStream, Valkey/Redis Streams); a broker face runs only when named in `LANDFLOW_TRANSPORTS` with its URL (the
host needs a matching connection under Settings → Transports):

```sh
LANDFLOW_TRANSPORTS=http,grpc,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=… go run .
```

Calls over a broker are encrypted and signed with the transport secret (`LANDFLOW_TRANSPORT_SECRET`, the host's value). The tier 2 kinds
(MQTT, AMQP 1.0, SQS, Pub/Sub, Pulsar, Service Bus) are not linked in, because their client libraries would nearly triple the binary (about
37 MB with tier 1, 54 MB with all ten, against 20 MB without brokers); `landflow-bridge` reaches them through the plugin's HTTP face.

**`maxConcurrency`** (calls running node code at once, shared by every face) defaults to the core count (`runtime.NumCPU()`): hashing and
encoding are CPU-bound, so about one call per core keeps every core busy without queueing work behind it. `LANDFLOW_MAX_CONCURRENCY`
overrides it. Past that, as many calls again wait for a slot; beyond that HTTP answers 429 and gRPC `RESOURCE_EXHAUSTED` (`capacity`).

**`idempotent`**: every node is a pure transform with no side effects, so all four are `idempotent: true`: a broker may deliver a call twice,
and MCP lists the tools with `idempotentHint`.

## MCP

`hash`, `uuid` and `jwtDecode` are MCP tools on `http://127.0.0.1:7103/mcp` (Base64 is not marked as a tool). The face listens on loopback with
no token. In a container (`LANDFLOW_LISTEN_HOST=0.0.0.0`, as the image sets) it needs `LANDFLOW_MCP_TOKEN` or stays off with a log line; the
Kubernetes manifest and compose set `LANDFLOW_MCP=off`, since agents reach plugins through the host's per-plugin endpoints and the gateway.
Without Landflow, as a local MCP server over stdio:

```sh
go run . --mcp-stdio
```
