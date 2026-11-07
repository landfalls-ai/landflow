# Developing Landflow

How to work on Landflow: set it up, find your way around the code, follow its conventions and check a change. Part of
the [Landflow docs](README.md).

## Setup

You need Node 22 or later with pnpm 10, Go 1.26, Python 3.11 or later, and Docker (OrbStack on this machine) for the
infra stack and the images.

```bash
pnpm install
(cd plugins/py-insights && ./setup.sh)        # .venv with the Python SDK, gRPC, MCP and broker extras
(cd plugins/productivity && ./setup.sh)       # the same for the Python integrations
pnpm dev:all                                  # host on :3000 + the seven plugins (7101–7107 HTTP, 7201–7207 gRPC)
docker compose -f deploy/compose.infra.yml up -d --wait   # Postgres, Valkey, Mailpit, MinIO, OpenBao (optional)
```

`pnpm dev` runs only the host; `pnpm plugin:ts|py|go|messaging|productivity|google|databases|github|browser` runs one plugin, and
`pnpm worker` runs a queue-mode worker. The host keeps its data in `apps/web/.data` (SQLite, `credentials.json`,
`encryption.key`). Don't edit those files by hand: use the UI, the API or the [CLI](features/cli.md).
[deployment.md, "Using the infra from the dev server on the host"](deployment.md#using-the-infra-from-the-dev-server-on-the-host)
shows how to point the dev server at the infra stack.

`next dev` keeps no persistent Turbopack cache (`experimental.turbopackFileSystemCacheForDev: false` in
`apps/web/next.config.ts`), so each start compiles from scratch. Next.js turns that cache on by default, and a stale one in
`apps/web/.next/dev/cache` made the browser reload in a loop: the console repeated "[Fast Refresh] rebuilding", the server
log "✓ Compiled", and the hot-reload socket (`/_next/hmr`) sent a `restart` for the entry chunk list on every request. If
that loop comes back, stop the dev server, delete `apps/web/.next/dev` (build output only, never `.data`) and start it again.

Server code that reads files from a path known only at run time takes a `/*turbopackIgnore: true*/` comment on that
argument, as in `join(/*turbopackIgnore: true*/ process.cwd(), '.data')` (`lib/server/db/index.ts`). Without it,
Turbopack traces the whole project into the server bundle, including the live database, and `next build` warns "Dynamic
filesystem access causes tracing of the whole project".

## Where to start reading

1. [architecture.md](architecture.md): the processes, a run from trigger to result, every subsystem and a code map.
2. The feature page for the area you are changing ([index](README.md#feature-map)).
3. The contract docs for what crosses a process boundary: [protocol.md](protocol.md) (plugins),
   [transports.md](transports.md) (brokers and MCP), [observability.md](observability.md) (spans, metrics, logs).
4. The code, from the entry points:

| Area | Start at |
|---|---|
| API routes | `apps/web/src/app/api/**/route.ts` (one file per route; the comment at the top says what it does and who may call it) |
| Running a workflow | `apps/web/src/lib/server/runner.ts`, then `packages/engine/src/executor.ts` |
| Storage | `apps/web/src/lib/server/store.ts`, `db/schema.ts` (migrations), `config-store.ts` (credentials and settings documents) |
| Plugins | `apps/web/src/lib/server/plugins/` (registry, clients, Kubernetes discovery), `transports/` (choosing a transport, broker connections), `packages/protocol` (wire contract) |
| Queue mode | `apps/web/src/lib/server/cluster/` (coordinator, leader, dispatch, workers, Valkey) |
| Auth and governance | `apps/web/src/lib/server/auth/` (sessions, API keys, `policy.ts`, OIDC, SAML), `audit/`, `governance/`, `projects/` |
| AI | `apps/web/src/lib/server/nodes/` (AI Agent and sub-nodes), `agents/`, `rag/`, `evaluations/`, `mcp/` |
| UI | `apps/web/src/app/**/page.tsx`, `apps/web/src/components/` |
| SDKs | `packages/sdk` (TypeScript), `sdks/go`, `sdks/python`; each has a README |

## Conventions

- **Migrations** live in `apps/web/src/lib/server/db/schema.ts`, in order; the highest so far is 1882. One SQL text runs
  on SQLite and Postgres (TEXT, BIGINT, DOUBLE PRECISION, JSON in TEXT, `ON CONFLICT` upserts); set `postgres` only when
  the dialects must differ. Never edit a shipped migration: add one. A column that a shipped `CREATE TABLE` gained
  later goes in `addColumns`. A new table also goes in `TABLES` (its primary key) in the same file.
- **Routes** wrap their body in `handler()` and answer with `json()` or `error()` from `lib/server/http.ts`, and
  validate bodies with `parseBody()` and a zod schema (shared ones are in `lib/server/schemas.ts`). Who may call a route
  is decided once in `lib/server/auth/policy.ts`, before the handler runs: add a line there for anything that isn't a
  plain read. Public API routes get an entry in `lib/server/openapi.ts`; `test/openapi.test.ts` checks that every
  listed path exists.
- **Tests** live next to their package (`apps/web/test`, `packages/*/test`, `*_test.go`, `sdks/python/tests`). Route
  tests import the handler and call it with a `Request`; `test/setup.ts` signs those calls in as a synthetic owner, and
  the auth tests turn that off with `disableTestAuth()`. Tests that need a real service skip themselves unless
  `LANDFLOW_INTEGRATION` names it (below), so the default run stays offline.
- **Comments** say why, at the top of each file and above anything surprising. Match the density of the surrounding
  code.
- **Docs move with the code.** A change to a feature updates its page under [features/](README.md#feature-map) (or
  [reference/](reference/api.md) for routes and environment variables), [limitations.md](limitations.md) when it adds
  or removes a limit, and [roadmap.md](roadmap.md) when it closes or opens an item. Each commit gets a row in
  [history.md](history.md).
- **Local only.** Everything runs on this machine: the OrbStack Docker engine and its Kubernetes cluster (context
  `orbstack`, namespace `landflow-dev`). Never deploy to or push images to a cloud account. Build with
  `COMPOSE_BAKE=false` (the default buildx builder belongs to another project) and build cluster images with
  `docker --context orbstack buildx build --builder orbstack --load`. AWS calls go to LocalStack at
  `http://127.0.0.1:54566` with dummy keys and `AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null`, so
  `~/.aws` is never read. Use only the development credentials in `deploy/.env.example`.

## Verification

Every suite, from the repository root. All of them run offline.

```bash
(cd apps/web && npx vitest run)                    # the host: routes, store, runner, auth, AI, queue mode on fakes…
pnpm typecheck                                     # every TypeScript package
for p in protocol transports engine sdk cli; do (cd packages/$p && npx vitest run); done
(cd services/code-runner && npx vitest run)
for p in messaging text-toolkit github landfall triage browser; do (cd plugins/$p && npx vitest run); done
(cd sdks/go && go test ./...)
(cd sdks/go/transport && go test -race -count=1 -run Claim .)
for k in kafka amqp nats valkey mqtt amqp1 sqs pubsub pulsar servicebus; do (cd sdks/go/transport/$k && go test ./...); done
(cd services/landflow-bridge && go test ./...)
for p in go-crypto google-workspace databases threat-intel; do (cd plugins/$p && go test ./...); done
plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests
(cd plugins/py-insights && .venv/bin/python -m unittest discover -s tests)
(cd plugins/productivity && .venv/bin/python -m unittest discover -s tests)
deploy/scripts/smoke.sh code                       # the dockerised code runner: health + network/file-system isolation
```

The host's suite runs its files in parallel, so `apps/web/vitest.config.ts` gives each test 20 s and each hook 30 s:
the marketplace, cluster runtime and MCP file-approval tests timed out at the defaults under that load.

`pnpm test` runs the TypeScript packages' suites in one go. After editing `packages/protocol/proto/landflow/plugin/v1/plugin.proto`, run
`pnpm gen:proto` (re-embeds the proto and regenerates the JSON Schema).

### Recorded plugin manifests

Some tests read the bundled plugins' manifests from fixtures. When a plugin's nodes change, re-record them with the
plugins running (`pnpm dev:all`, or the `pnpm plugin:*` scripts):

```bash
node packages/protocol/scripts/record-manifests.mjs    # writes packages/protocol/test/fixtures/manifests and apps/web/test/fixtures/plugin-manifests
(cd packages/protocol && npx vitest run -u test/mcp-tools.test.ts)   # then refresh the MCP tool-list snapshot they feed
```

The script drops `transports` and `maxConcurrency`, which depend on how the plugin was started, not on its code.

The triage, Landfall and threat-intel plugins aren't in `dev:all`; start them with `pnpm plugin:triage`,
`plugin:landfall` and `plugin:threat-intel` before recording. `apps/web/test/plugin-flows.test.ts` checks every
`plugins/*/flows/*.json` against these manifests and the repository's `.claude-plugin/marketplace.json`, so a node change
that breaks a shipped flow fails there.

### Live broker suites

The transport drivers' conformance and cross-language suites run against the infra stack's brokers when their
variables are set (start the brokers with the profiles in
[deployment.md, "Message brokers and the MCP gateway"](deployment.md#message-brokers-and-the-mcp-gateway)):

| Variable | Value on the infra stack |
|---|---|
| `LANDFLOW_TEST_KAFKA` | `127.0.0.1:59092` |
| `LANDFLOW_TEST_AMQP` | `amqp://landflow:<password>@127.0.0.1:55672` (RabbitMQ) |
| `LANDFLOW_TEST_NATS` | `nats://127.0.0.1:54222` |
| `LANDFLOW_TEST_VALKEY` | `redis://127.0.0.1:56379` |
| `LANDFLOW_TEST_MQTT` | `mqtt://127.0.0.1:51883` |
| `LANDFLOW_TEST_AMQP1` | `amqp://landflow:<password>@127.0.0.1:55674` (Artemis) |
| `LANDFLOW_TEST_SQS` | `http://127.0.0.1:54566` (LocalStack; set the two AWS file variables to `/dev/null`) |
| `LANDFLOW_TEST_PUBSUB` | `127.0.0.1:58085` (emulator; unset `GOOGLE_APPLICATION_CREDENTIALS`) |
| `LANDFLOW_TEST_PULSAR`, `LANDFLOW_TEST_PULSAR_ADMIN` | `pulsar://127.0.0.1:56650`, `http://127.0.0.1:58180` |
| `LANDFLOW_TEST_SERVICEBUS` | `sb://127.0.0.1:55675` (emulator) |
| `LANDFLOW_TEST_CLAIM_S3` | `http://127.0.0.1:59000` (MinIO, for the claim check; keys in `LANDFLOW_CLAIM_ACCESS_KEY_ID` and `LANDFLOW_CLAIM_SECRET_ACCESS_KEY`) |

Passwords and keys are the development values in `deploy/.env.example`. With those set:

```bash
(cd packages/transports && npx vitest run src/drivers test/claim.test.ts test/claim-live.test.ts)
for k in kafka amqp nats valkey mqtt amqp1 sqs pubsub pulsar servicebus; do (cd sdks/go/transport/$k && go test -count=1 ./...); done
(cd packages/sdk && npx vitest run test/live-brokers.test.ts)
(cd sdks/go/transport/testdata/live-brokers && go test -count=1 -run TestCrossLanguage ./...)
(cd services/landflow-bridge && go test -count=1 . -run TestLiveBrokers)
plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests -p 'test_transport_*live.py'
python3 deploy/scripts/servicebus-config.py --check   # the Service Bus emulator has the entities the tests use
```

### Integration tests (`LANDFLOW_INTEGRATION`)

The host's tests against real services are skipped unless `LANDFLOW_INTEGRATION` (a comma-separated list) names them.
Start the matching infra services first ([deployment.md](deployment.md)), then run the files from `apps/web`, e.g.
`LANDFLOW_INTEGRATION=postgres,ollama npx vitest run test/pgvector.test.ts test/rag-live.test.ts`.

| Flag | Needs | Test files |
|---|---|---|
| `postgres` | the infra Postgres, database `landflow_test` (or `LANDFLOW_PG_URL`, `LANDFLOW_TEST_DATABASE_URL`) | `pgvector.test.ts`, `postgres.test.ts` (the store, schema `landflow_runtime_test`), `projects-migration.test.ts`, `project-folders-variables.test.ts` |
| `queue` | the infra Valkey (`LANDFLOW_TEST_VALKEY_URL`, under a throwaway key prefix) and Postgres | `cluster-coordinator.test.ts` (coordinator, leader election, stalled-job takeover, relay), `cluster-postgres.test.ts` (processes following each other's writes, schema `landflow_queue_test`), `config-store-postgres.test.ts` (credentials and settings shared by two processes, in a database it creates and drops), `audit-chain.postgres.test.ts` (the hash chain sealed by two processes at once, SAML state shared by mains), `transports.postgres.test.ts` |
| `sentinel` | `deploy/compose.sentinel.yml` | `valkey-sentinel.integration.test.ts` (the primary is killed; a run in flight and new runs finish on the promoted replica) |
| `valkey-cluster` | the infra `valkey-cluster` profile | `valkey-cluster.integration.test.ts` |
| `oidc` | Keycloak (`auth` profile) | `oidc.integration.test.ts` (fills in its login form as alice and bob) |
| `saml` | Keycloak (`auth` profile) | `saml.integration.test.ts` (role and project mapping, replay, single logout, encrypted assertions) |
| `oauth2` | Keycloak (`auth` profile) | `oauth2-keycloak.test.ts` (Connect, refresh, revocation, client credentials), `mcp-oauth-keycloak.test.ts` (OAuth for MCP servers) |
| `smtp` | Mailpit | `smtp.integration.test.ts` (invites, password resets), `alerts-smtp.test.ts` (failure alert emails) |
| `imap` | GreenMail (`mail` profile) | `email-imap.test.ts`, `email-imap-host.test.ts` (the Email Trigger) |
| `s3` | MinIO | `binary-store.test.ts` (the S3 binary store) |
| `git-ssh` | the `git` profile, after `deploy/infra/git/gen-keys.sh` | `source-control-git.test.ts` (push and pull over SSH with host-key pinning) |
| `secrets` | OpenBao at `http://127.0.0.1:58200` | `secrets-openbao.integration.test.ts` (token and AppRole auth, set up idempotently through the API; lease renewal; a run whose credential reads a secret). The other providers are tested against local fakes |
| `aws` | LocalStack (`aws` profile) at `http://127.0.0.1:54566` (`LANDFLOW_LOCALSTACK_PORT`, `LANDFLOW_LOCALSTACK_URL`) | `secrets-aws.integration.test.ts` (access keys and environment auth, a `{environment}` prefix, JSON and plain secrets, redaction; the endpoint must be loopback, the keys are dummies and `~/.aws` is never read) |
| `audit-anchor` | MinIO; must be the only flag | `audit-integrity.test.ts` (signed heads in a real bucket) |
| `k8s` | the OrbStack cluster, namespace `landflow-dev`, the plugin image built locally | `kubernetes.integration.test.ts` (discovery, scale to 0 and back, calls spread over two pods) |
| `ollama` | Ollama at `OLLAMA_URL` with nomic-embed-text and qwen3-coder:30b | `rag-live.test.ts`, `evaluations-live.test.ts` (qwen3-coder as the judge), `ollama-streaming-live.test.ts` |

`cluster-runtime.test.ts` always runs: a main and workers through the runner on the in-process coordinator.

Run the Postgres-backed files one at a time: they take an advisory lock per database, so two of them in parallel can
fail (`postgres.test.ts` passes alone). Two more live tests use no flag: `approval-email-mailpit.test.ts` runs whenever
Mailpit answers, and `mcp-gateway-two-issuers.test.ts` runs its gateway checks when
`LANDFLOW_TEST_AGENTGATEWAY_IMAGE` is set (and its Keycloak part when Keycloak is up).

The databases plugin has its own: `cd plugins/databases && LANDFLOW_INTEGRATION=postgres,redis go test -count=1 -run
Integration -v .` (`all` adds MySQL); see
[deployment.md, "Integration tests (databases plugin)"](deployment.md#integration-tests-databases-plugin).

### Checking a change live

Each feature in [roadmap.md](roadmap.md) was also checked in the running app, on a scratch host that leaves
`apps/web/.data` alone:

```bash
LANDFLOW_DATA_DIR=<an empty directory outside the repository> PORT=3100 LANDFLOW_PUBLIC_URL=http://127.0.0.1:3100 \
LANDFLOW_REGISTRY_GRPC_PORT=off LANDFLOW_SCAN_ON_START=false LANDFLOW_MCP_GATEWAY=off LANDFLOW_PLUGINS= \
LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1 \
LANDFLOW_OWNER_EMAIL=<from deploy/.env.example> LANDFLOW_OWNER_PASSWORD=<from deploy/.env.example> \
  npx next dev --port 3100                      # from apps/web
```

- **Its own data and ports.** The data directory holds the scratch host's database, credentials and installed plugins,
  and port 3100 keeps it apart from `pnpm dev` on 3000. The gRPC registry, the startup scan and the bundled gateway are
  off so it doesn't take the dev host's ports. The owner comes from the development credentials on first start.
- **Plugins and fakes.** Start the plugins the check needs with the `pnpm plugin:*` scripts. With
  `LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1`, adding this checkout's absolute path as a marketplace lists the repository's own
  `landflow-soc` marketplace, so a plugin and its flows install the way a user installs them
  ([triage.md](triage.md#install)). Outside services are fakes: `pnpm fake-landfall` ([triage.md](triage.md#trying-it-locally)),
  and the messaging plugin's fakes ([plugins/messaging](../plugins/messaging/README.md)). Nothing reaches a real
  service.
- **In the browser**, open `http://localhost:3100`, not `127.0.0.1`. `next dev` blocks its dev resources (`/_next/hmr`)
  for any origin other than `localhost` unless `allowedDevOrigins` lists it, so hot reload doesn't connect. Use a tab of
  your own and keep the console open: a check passes with no errors there.
- **Restart after changing a singleton.** Server objects made with `singleton()` (`lib/server/singleton.ts`: the
  registry, broker connections and others) live on `globalThis` so that hot reload doesn't duplicate them. A reload
  therefore keeps the old instance, and a method you add to its class isn't on it ("registry.compositeTypes is not a
  function"). Stop the dev server and start it again; installed node plugins start again with it.
- **Through the API**, a script that signs in with the development owner (`POST /api/auth/login`, then the session
  cookie) can add the marketplace and install plugins. A node plugin's install answers `409` with what it will run until
  it is sent again with `{ "confirm": true }`. The script can then post alerts to a workflow's webhook and read
  `GET /api/executions/:id`.
- **Clean up** what the check created (workflows, templates, installed plugins) through the UI or the API, and stop the
  processes you started.

### On the cluster

After deploying an overlay ([deployment.md, "Kubernetes"](deployment.md#kubernetes)), check it through a
port-forward: `kubectl --context orbstack -n landflow-dev port-forward svc/landflow-host 53000:3000`, sign in as the
development owner, and read `GET /api/plugins` (every plugin `online`, with its transports), `GET /api/mcp/gateway`
(the gateway sync in step, no drift) and `GET /api/transports`. Queue mode on the cluster has its own end-to-end check
in [deployment.md, "Queue mode on Kubernetes"](deployment.md#queue-mode-on-kubernetes).
