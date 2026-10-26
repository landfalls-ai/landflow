# Live cross-language check (Go plugin ↔ TypeScript host over NATS)

Needs the dev NATS from `deploy/compose.infra.yml` (127.0.0.1:54222) and `pnpm install` done (for `tsx`). Two terminals, same prefix:

```sh
# 1. TypeScript side: a MessagingServer "ts-echo" plus a MessagingClient that calls the Go plugin
cd sdks/go/transport/testdata/live
LIVE_PREFIX=lflive$RANDOM ../../../../../packages/transports/node_modules/.bin/tsx live-nats.mts

# 2. Go side (same LIVE_PREFIX): a plugin "live-go" served with landflow.WithBroker(nats.New(…)) plus a transport.Client that calls ts-echo
cd sdks/go/transport/testdata/live
LIVE_PREFIX=<same> go run .
```

Both default to `LANDFLOW_TRANSPORT_SECRET=live-cross-transport-secret` and `LANDFLOW_REGISTRY_SECRET=live-cross-registry-secret`;
set `LIVE_NATS_URL` for another server. Expected: each side discovers the other on the registry channel, Health / GetManifest /
Execute / LoadOptions succeed in both directions, the manifest hash the Go plugin announces equals `sha256(JSON.stringify(body))`
of its GetManifest reply (the hash the TS host keeps), an unknown node is a `RemoteError not_found`, a stale manifest hash is a
`ManifestMismatchError`, and an aborted call is a `CancelledError` (the Go plugin logs the cancel).
