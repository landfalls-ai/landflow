# Cross-language check over every tier 1 broker (Go plugin ↔ TypeScript host)

`live_test.go` runs, per broker kind, a Go plugin served with `landflow.WithBroker(<driver>.New(…))` plus a Go
`transport.Client`, against `live.mts`: a TypeScript `MessagingServer` ("ts-echo") plus a `MessagingClient` built on the
`@landflow/transports` driver of the same kind. Each side discovers the other on the registry channel and calls it, so the
wire (channel names, header prefixes, entry layouts, reply headers, signing and encryption) is proven compatible per broker.

It is a nested module (`go.mod` here) so the four driver modules can be imported together. Gated on the same variables as
the driver tests; a kind whose variable is unset is skipped, as is everything when `node` or
`packages/transports/node_modules/.bin/tsx` is missing:

```sh
cd sdks/go/transport/testdata/live-brokers
LANDFLOW_TEST_KAFKA=127.0.0.1:59092 LANDFLOW_TEST_AMQP=amqp://<user>:<pass>@127.0.0.1:55672/ \
LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 \
go test -count=1 -v -run TestCrossLanguage ./...
```

Kinds: `kafka`, `amqp`, `nats`, `jetstream` (from `LANDFLOW_TEST_NATS`), `valkey`. Every run uses a unique channel prefix
(`lflive<hex>`) and deletes the topics, queues, exchanges, streams and keys it created. The secrets are fixed test values
(`live-cross-transport-secret`, `live-cross-registry-secret`), set with `t.Setenv` for both sides.

What is asserted, per kind: TS discovers `live-go` with a `<kind>://` endpoint; Health, GetManifest (and the announced
manifest hash equals `sha256(JSON.stringify(body))[0..16]` of the reply), Execute at most once and at least once (the Go
node reports the delivery mode it saw), LoadOptions, an unknown node → `RemoteError not_found`, a stale manifest hash →
`ManifestMismatchError`, an aborted call → `CancelledError`; and Go → TS Health, Execute (at least once) and an unknown node
→ `RemoteError not_found`.
