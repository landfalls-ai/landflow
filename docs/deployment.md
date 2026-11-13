# Deploying Landflow

Running Landflow on this machine: the Compose stacks (the infra the tests use, the app as images, queue mode), the
code runner, and Kubernetes on OrbStack's local cluster. Everything here is local; nothing deploys to a cloud. Part of
the [Landflow docs](README.md).

Three independent Compose projects:

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](../deploy/compose.infra.yml) | Development and test services: Postgres 16 + pgvector, Valkey, Mailpit, MinIO, OpenBao; Keycloak (profile `auth`), Jaeger (profile `observability`), MySQL 8.4 (profile `mysql`), GreenMail (profile `mail`), Vector as a SIEM receiver (profile `siem`), LocalStack for AWS Secrets Manager (profile `aws`), a throwaway SSH Git server for Source control (profile `git`); the transport layer's brokers, one profile each (`kafka`, `rabbitmq`, `nats`, `mqtt`, `artemis`, `pulsar`, `pubsub`, `servicebus`) agentgateway as the MCP gateway (`mcp-gateway`) and in front of the models (`llm-gateway`, see [agents.md](agents.md#model-router)): see [Message brokers and the MCP gateway](#message-brokers-and-the-mcp-gateway) |
| `landflow` | [`compose.yml`](../deploy/compose.yml) | Landflow itself as images: the host (Next.js standalone), the seven plugins, which announce themselves to the host, and the sandboxed [code runner](#code-runner) for the Code node |
| `landflow-queue` | [`compose.queue.yml`](../deploy/compose.queue.yml) | Landflow in [queue mode with high availability](#queue-mode-two-mains-two-workers): two mains behind a load balancer and two workers, on the infra stack's Postgres, Valkey and MinIO |

Kubernetes manifests are in [`k8s/`](../deploy/k8s): see [Kubernetes](#kubernetes) (tested on OrbStack's local cluster).

Both use their own networks (`landflow-infra`, `landflow-app`), named volumes (`landflow-infra_*`, `landflow_landflow-data`) and host ports in the 5xxxx range, bound to `127.0.0.1`. The dev server on `:3000` keeps running next to them.

Every value has a default in the compose files. To change one, `cp deploy/.env.example deploy/.env` and edit it (`deploy/.env` is git-ignored).

> **Builds on this machine.** The selected buildx builder (`docker buildx ls`, marked `*`) belongs to another project. Build through the Docker engine with `COMPOSE_BAKE=false`, as in every command below, so Compose doesn't use that builder.

## Start

```bash
# Infra: core services (Postgres, Valkey, Mailpit, MinIO, OpenBao)
docker compose -f deploy/compose.infra.yml up -d --wait

# ... plus Keycloak and Jaeger (and MySQL)
docker compose -f deploy/compose.infra.yml --profile auth --profile observability up -d --wait
docker compose -f deploy/compose.infra.yml --profile mysql up -d --wait mysql

# ... GreenMail, an IMAP + SMTP test server for the Email Trigger (IMAP)
docker compose -f deploy/compose.infra.yml --profile mail up -d --wait greenmail

# ... Vector, a SIEM stand-in for audit log streaming (syslog + HTTP JSON lines)
docker compose -f deploy/compose.infra.yml --profile siem up -d --wait siem

# ... LocalStack, AWS Secrets Manager for the external secrets tests (dummy credentials only)
COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile aws up -d --wait localstack

# ... the transport layer's brokers (one profile each; "Message brokers and the MCP gateway" below) and agentgateway
COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile kafka --profile rabbitmq --profile nats up -d --wait
COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile mqtt --profile artemis --profile pulsar --profile pubsub --profile servicebus up -d
COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile mcp-gateway up -d
deploy/scripts/brokers-smoke.sh                  # one produce/consume (or ping) per running broker, from the Mac

# App: build the images and start the host + 7 plugins + code runner on http://localhost:53000
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait

# Only the code runner, for the dev server on :3000 (http://127.0.0.1:53300, see "Code runner")
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait code-runner code-runner-port

# Both, with the app joined to the infra network and sending traces to Jaeger
docker compose -f deploy/compose.infra.yml --profile observability up -d --wait
LANDFLOW_OTLP_ENDPOINT=http://jaeger:4318 COMPOSE_BAKE=false \
  docker compose -f deploy/compose.yml -f deploy/compose.infra-link.yml up -d --build --wait

# Check everything that is running
deploy/scripts/smoke.sh          # or: smoke.sh infra | smoke.sh app | smoke.sh code

# Queue mode: two mains (behind http://localhost:53080) and two workers on the infra stack ("Queue mode" below)
docker compose -f deploy/compose.infra.yml exec postgres createdb -U landflow landflow_queue   # once
COMPOSE_BAKE=false docker compose -f deploy/compose.queue.yml up -d --build --wait
python3 deploy/scripts/queue-e2e.py
```

## Probes

| Route | Checks | Used by |
|---|---|---|
| `GET /api/health/live` | nothing: the process answers `{ status: 'ok', uptimeSeconds }` even while a dependency is down. Next holds every request until instrumentation (which awaits boot) finishes, so it does not answer before boot ends | Kubernetes `startupProbe` (up to 5 min for boot) and `livenessProbe` |
| `GET /api/health/ready` | boot finished and not draining (before boot ends Next holds the request, so a `503` with `boot` not ok is seen only while draining); database answers `SELECT 1` (in Postgres mode on the in-process copy, so it does not see Postgres go away); Postgres write queue not blocked and its oldest batch younger than `LANDFLOW_READY_MAX_WRITE_LAG_SECONDS` (30); schema at the latest migration; in queue mode Valkey answers. Each check has a 1 s limit. 200 `ready` or 503 `not_ready` with `{ ok, ms }` per check | Kubernetes `readinessProbe`, the Docker `HEALTHCHECK` (so compose `service_healthy` means ready), the smoke script |
| `GET /api/health` | `{ status: 'ok' }`; the plugin and run counts only with a session or API key | the CLI and scripts |

In Postgres mode, losing Postgres shows as `writeQueue` lag, only after a write has been queued for `LANDFLOW_READY_MAX_WRITE_LAG_SECONDS`; a host with no pending write stays ready, and the LISTEN connection is not checked ([limitations](limitations.md)). A long Postgres backlog keeps a pod unready until the queue drains; that is deliberate, the host should not take traffic
while it cannot persist it. The leader state is not a check: a non-leader main is ready.

## Stopping the host

On SIGTERM or SIGINT a main stops in phases, logging `shutdown: <phase>/<step>` for each and `shutdown complete` with
the duration. New requests get `503` with `Retry-After: 5` (`/api/health/live` and `/ready` still answer; `/ready`
says 503 from the first moment, so the load balancer stops sending traffic) and requests in flight are awaited; then
the leader services (scheduler, timers, alerts) and the MCP gateway sync stop; then local runs get time to finish (what
is still running continues from its last checkpoint at the next boot); then the broker connections, the cluster runtime
(queue mode: the leader lease is released and the instance forgotten), the database (Postgres flushes its write queue)
and telemetry.

The whole stop is bounded by `LANDFLOW_SHUTDOWN_SECONDS` (default 25, inside Kubernetes' 30 s grace period; the compose
stacks give the mains `stop_grace_period: 30s`). The last 5 s (a fifth of a budget under 25 s) are reserved for the
cluster, database and telemetry steps, so a long run never stops the flush; requests in flight may wait at most 60% of
the rest, so a request that lasts as long as its run still leaves time to stop the scheduler and the runs. A step that
fails or times out is logged and the next one runs. A second signal exits at once with code 1; a clean stop exits 0.
The shutdown steps are registered as soon as the database is open, so a signal during the rest of the boot (plugin
seeds that don't answer) still flushes and releases the lease.

This needs `NEXT_MANUAL_SIG_HANDLE` set to any non-empty value (`true`), which `pnpm start` (the `start` script) and
the Docker image set. Without it Next.js's own handler closes its server and exits 143 first, and only the error
handlers (below) are ours. `next dev` keeps Next.js's own handling: manual handling is not available there.

A required boot step (the configuration check in the production profile, the database, the queue-mode cluster runtime)
that fails logs `boot failed`; under `next start` and the image (`NODE_ENV=production`) the process then exits with
code 1, so the orchestrator restarts the container. Elsewhere `register()` in `instrumentation.ts` catches the failed
boot (a rejected instrumentation hook would stop `next dev`), so `pnpm dev` keeps running: routes answer 500 and
`/api/health/ready` 503 with `boot` not ok until a later request boots it again. Every other service that fails to start is logged as `service failed to start`, counted
(`landflow.process.errors{kind="service_start"}`) and the host keeps serving.

An unhandled rejection is logged and counted. An uncaught exception is logged and counted; where `NODE_ENV=production`
(`next start` and the image, including the in-repo stacks that run the development profile) the host also shuts down
(5 s budget) and exits 1, since its state may be broken and a supervisor restarts it; `pnpm dev` only logs and counts,
as Next.js does. The worker always exits. This follows `NODE_ENV` (whether a supervisor runs the process), not
`LANDFLOW_PROFILE`.

## Production profile

`LANDFLOW_PROFILE` is `development` or `production`; unset, it is `production` when `NODE_ENV=production` (the host image sets
it) and `development` otherwise. In the production profile `checkConfig()` (`apps/web/src/lib/server/config/check.ts`)
reports an error for an unset `LANDFLOW_PUBLIC_URL`, for any secret variable (`LANDFLOW_ENCRYPTION_KEY`,
`LANDFLOW_BINARY_SECRET`, `LANDFLOW_TRANSPORT_SECRET`, `LANDFLOW_REGISTRY_SECRET`, `LANDFLOW_CODE_RUNNER_SECRET`,
`LANDFLOW_MCP_GATEWAY_SECRET`, `LANDFLOW_OWNER_PASSWORD`, the S3 keys, …) holding a development value (anything with
`dev-only`, or a known default), and for an unset `LANDFLOW_REGISTRY_SECRET` unless `LANDFLOW_REGISTRY_OPEN=true`; an unset
`LANDFLOW_ENCRYPTION_KEY` or `LANDFLOW_BINARY_SECRET` is a warning. Messages name the variable, never the value. The check is
a pure function; the host calls it at boot (`lib/server/runtime.ts`, the first required step, for the main and the worker).
In the production profile any error stops the boot with a `ConfigError` that lists every problem (the process exits non-zero
and the pod restarts); in development the problems are logged as warnings. `next build` (`NEXT_PHASE=phase-production-build`)
does not boot the host and only warns, since the image build has none of the deployment's variables. Either way the host logs one `effective configuration`
line at info with every `LANDFLOW_*`, `OTEL_*` and `DATABASE_URL` variable that is set (secrets shown as `[set]` by the check or `[redacted]` by the logger, URL passwords redacted).

The compose stacks and the Kubernetes base set `LANDFLOW_PROFILE=development` because they run the development secrets in
`deploy/.env.example` while their image says `NODE_ENV=production`. A real deployment leaves it unset (or `production`) and
sets its own secrets and public URL.

## Ports, credentials and URLs

All credentials are **for local development and tests only**.

| Service | URL / address on the Mac | In-network address | Credentials |
|---|---|---|---|
| Postgres 16 + pgvector | `localhost:55432` | `postgres:5432` | `landflow` / `landflow-dev-only`, databases `landflow` and `landflow_test` (both with `vector`) |
| Valkey 8 | `localhost:56379` | `valkey:6379` | none |
| Mailpit SMTP | `localhost:51025` | `mailpit:1025` | any user and password (or none), no TLS |
| Mailpit UI | http://localhost:58025 | `mailpit:8025` | none |
| MinIO S3 API | http://localhost:59000 | `minio:9000` | `landflow` / `landflow-dev-only`, bucket `landflow` |
| MinIO console | http://localhost:59001 | `minio:9001` | same |
| OpenBao (dev mode) | http://localhost:58200 | `openbao:8200` | root token `landflow-dev-root-token`; KV v2 at `landflow/` (sample `landflow/dev/hello`) |
| Keycloak 26.0 (`auth`) | http://localhost:58080 (admin console `/admin`) | `keycloak:8080` | admin `admin` / `admin-dev-only` |
| — realm `landflow` | http://localhost:58080/realms/landflow/.well-known/openid-configuration | | client `landflow` (confidential), secret `landflow-dev-client-secret` |
| — SAML client | http://localhost:58080/realms/landflow/protocol/saml/descriptor (IdP metadata) | | client `http://localhost:3000/api/auth/saml/metadata` (Landflow's SP entity id) |
| — test users | | | `alice` / `alice-test-only` (role `landflow-admin`), `bob` / `bob-test-only` (role `landflow-editor`, group `data-team`) |
| Jaeger 2 UI (`observability`) | http://localhost:56686 | `jaeger:16686` | none |
| Jaeger OTLP | HTTP `localhost:54318`, gRPC `localhost:54317` | `jaeger:4318`, `jaeger:4317` | none |
| MySQL 8.4 (`mysql`) | `localhost:53306` | `mysql:3306` | `landflow` / `landflow-dev-only` (database `landflow_test`), root / `landflow-root-dev-only` |
| GreenMail 2.1 IMAP (`mail`) | `localhost:53143` | `greenmail:3143` | any user and password (the mailbox is created at first login), no TLS |
| GreenMail 2.1 SMTP (`mail`) | `localhost:53025` | `greenmail:3025` | none; delivers to GreenMail's own mailboxes |
| Vector syslog (`siem`) | `localhost:55514` (TCP and UDP) | `siem:5514` | none; RFC 5424, octet counting or newline framing |
| Vector HTTP (`siem`) | http://localhost:55080/ | `siem:8080` | none; JSON lines (signature headers kept as fields, not checked) |
| OpenSSH + git (`git`) | `ssh://git@127.0.0.1:52222/srv/git/<repo>.git` (`LANDFLOW_GIT_SSH_PORT`) | `git-ssh:22` | key login only (no passwords): the keys `infra/git/gen-keys.sh` writes to `infra/git/keys/` (git-ignored); repositories live in the `git-ssh-repos` volume, host keys in `git-ssh-host` |
| LocalStack 4.9 (`aws`) | http://localhost:54566 | `localstack:4566` | any access key (use dummy ones, e.g. `test` / `test`), region `us-east-1`; Secrets Manager and SQS only, in memory |
| Kafka 4.3 KRaft (`kafka`) | `localhost:59092` | `kafka:9092` | none (PLAINTEXT); share groups on (`share.version=1`), topics auto-created with 3 partitions |
| RabbitMQ 4.4 (`rabbitmq`) | AMQP `localhost:55672`, management http://localhost:55673 | `rabbitmq:5672`, `rabbitmq:15672` | `landflow` / `landflow-dev-only`, vhost `/` |
| NATS 2.15 (`nats`) | `nats://localhost:54222`, monitoring http://localhost:58222 | `nats:4222`, `nats:8222` | none; JetStream on (file store) |
| Mosquitto 2.1, MQTT 5 (`mqtt`) | `mqtt://localhost:51883` | `mosquitto:1883` | anonymous (dev only; published on 127.0.0.1) |
| ActiveMQ Artemis 2.44 (`artemis`) | AMQP 1.0 `localhost:55674`, console http://localhost:58161/console | `artemis:5672`, `artemis:8161` | `landflow` / `landflow-dev-only`; the acceptor also speaks CORE, OpenWire, STOMP and MQTT |
| Pulsar 4.2 standalone (`pulsar`) | `pulsar://localhost:56650`, admin http://localhost:58180 | `pulsar:6650`, `pulsar:8080` | none; tenant `public`, namespace `default` |
| Pub/Sub emulator (`pubsub`) | http://localhost:58085 (`PUBSUB_EMULATOR_HOST=127.0.0.1:58085`) | `pubsub:8085` | none; project `landflow-dev`, data kept in the volume |
| Azure Service Bus emulator 2.0 (`servicebus`) | AMQP `localhost:55675`, management + `/health` http://localhost:55300 | `servicebus:5672`, `servicebus:5300` | `Endpoint=sb://localhost:55675;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;`; static entities from [`infra/servicebus/Config.json`](../deploy/infra/servicebus/Config.json); SQL backend `servicebus-sql` (Azure SQL Edge, `sa` / `Landflow-dev-only1`, not published) |
| agentgateway 1.6 (`mcp-gateway`) | MCP http://localhost:54000/mcp, admin API + UI http://localhost:55000 (`/ui`) | `mcp-gateway:4000`, `mcp-gateway:15000` | none (the admin API has no authentication: loopback only); targets in SQLite in `mcp-gateway-data` |
| **Landflow host** (app) | http://localhost:53000 | `web:3000`, gRPC registry `web:7070` | owner `owner@landflow.test` / `landflow-dev-only` (`LANDFLOW_OWNER_EMAIL` / `LANDFLOW_OWNER_PASSWORD`) |
| Plugins (app) | not published | `text-toolkit:7101/7201`, `py-insights:7102/7202`, `go-crypto:7103/7203`, `messaging:7104/7204`, `productivity:7105/7205`, `google-workspace:7106/7206`, `databases:7107/7207`, `github:7111/7211`, `browser:7112/7212` (profile `browser`), `web-search:7113/7213` (profile `web-search`), `agent-shell:7114/7214` (profile `agent-shell`), `linear:7116/7216`, `attio:7117/7217`, `fathom:7118/7218` (HTTP/gRPC) | |
| Code runner (app) | http://127.0.0.1:53300 (through `code-runner-port`) | `code-runner:7300`, on the internal `landflow-code` network only | header `x-landflow-runner-secret: landflow-code-runner-dev-only` |
| **Queue mode** load balancer | http://localhost:53080 | `lb:3000` | owner `owner@landflow.test` / `landflow-dev-only` |
| Queue mode mains | http://localhost:53081, http://localhost:53082 | `main-1:3000`, `main-2:3000` | same |
| Queue mode workers | http://localhost:55691/healthz, http://localhost:55692/healthz (and `/metrics`) | `worker-1:5690`, `worker-2:5690` | none |

"In-network" addresses work from containers on the `landflow-infra` network (the app stack with `compose.infra-link.yml`). Containers without it reach the infra through the Mac: `host.docker.internal:<Mac port>`.

Keycloak details: redirect URIs `http://localhost:3000/api/auth/oidc/callback` and `http://localhost:53000/api/auth/oidc/callback` (and their `127.0.0.1` forms), plus the same hosts' `/api/oauth2/callback` for OAuth2 Connect (the client also has service accounts on, for the client credentials grant: `service-account-landflow`); the ID and access tokens carry the realm roles in a `roles` claim. The issuer is always `http://localhost:58080/realms/landflow` (`KC_HOSTNAME`), while the backchannel endpoints follow the request host, so a container can fetch tokens and JWKS from `http://keycloak:8080`. Direct access grants are on so scripts can log in a test user:

```bash
curl -s -d grant_type=password -d client_id=landflow -d client_secret=landflow-dev-client-secret \
  -d username=alice -d password=alice-test-only -d scope=openid \
  http://localhost:58080/realms/landflow/protocol/openid-connect/token
```

The SAML client (`http://localhost:3000/api/auth/saml/metadata`, the dev server's SP entity id) accepts AuthnRequests for `/api/auth/saml/*` on `:3000` and `:53000` (and `127.0.0.1`), signs both the response and the assertion (RSA-SHA256), forces the persistent NameID format and posts back (HTTP-POST binding). Its mappers send `email`, `firstName`, `lastName`, the realm roles in one `roles` attribute and the groups in `groups` (`data-team`, which bob is in). Single logout goes to `/api/auth/saml/logout`. Unsigned AuthnRequests are fine (client signature off). The dockerised host on `:53000` uses the same client with `LANDFLOW_SAML_ISSUER=http://localhost:3000/api/auth/saml/metadata`.

## Message brokers and the MCP gateway

The transport layer ([docs/transports.md](transports.md)) runs plugins over message brokers and exposes them
through an MCP gateway. `compose.infra.yml` has every broker the spec names as its own profile, bound to `127.0.0.1`,
with a named volume (`landflow-infra_<service>-data`) and, where the image has a shell, a healthcheck. All images are
native arm64 except where noted. `deploy/scripts/brokers-smoke.sh [name...]` checks each running one from the Mac
(a produce and consume, or a ping, through the published port; brokers whose container is down are skipped).

| Profile | Service, image | What to know | Test it |
|---|---|---|---|
| `kafka` | `apache/kafka:4.3.2` (KRaft, one node that is broker and controller) | Two listeners: `kafka:9092` in the network, `localhost:59092` from the Mac (same port inside and out, so the advertised address works from both sides). **Share groups** (KIP-932, "Queues for Kafka", production-ready since 4.2) are on: the `share.version` feature is finalised to 1 by the healthcheck once the broker is up (`kafka-features.sh upgrade --feature share.version=1`, idempotent; the `group.coordinator.rebalance.protocols=share` setting is deprecated since 4.3 and not used). Share groups deliver from "latest", so start the consumer before producing. Kafka 4.4.0 has an image but no release on kafka.apache.org/downloads yet, hence 4.3.2 | `docker compose -f deploy/compose.infra.yml exec kafka /opt/kafka/bin/kafka-console-share-consumer.sh --bootstrap-server localhost:9092 --topic t --group g --max-messages 1` in one terminal, `... kafka-console-producer.sh --bootstrap-server localhost:9092 --topic t` in another; `kafka-features.sh --bootstrap-server localhost:9092 describe` shows `share.version` |
| `rabbitmq` | `rabbitmq:4.4.0-management-alpine` | Direct reply-to, per-message TTL and `mandatory` need no setup. RabbitMQ 4 refuses transient non-exclusive queues (`transient_nonexcl_queues` is deprecated): declare queues `durable` | the management API: `curl -u landflow:landflow-dev-only http://localhost:55673/api/overview`; UI at the same URL |
| `nats` | `nats:2.15.1-alpine` with `--jetstream --store_dir /data` | Core NATS (inboxes, queue groups, "no responders") and JetStream; no auth | `curl http://localhost:58222/varz`, `/jsz`; the NATS CLI isn't in the image, use `nats` on the Mac or a client library |
| `mqtt` | `eclipse-mosquitto:2.1.2-alpine`, config [`infra/mosquitto/mosquitto.conf`](../deploy/infra/mosquitto/mosquitto.conf) | MQTT 5 (shared subscriptions `$share/<group>/<topic>`, message expiry, response topic and correlation data), anonymous, persistence in the volume | `docker compose -f deploy/compose.infra.yml exec mosquitto mosquitto_sub -V 5 -t 'landflow/#' -v` and `mosquitto_pub -V 5 -t landflow/x -m hi` |
| `artemis` | `apache/activemq-artemis:2.44.0-alpine` | The `5672` acceptor takes AMQP 1.0 (and the other protocols); addresses and queues auto-create on first use; console with the same credentials | `docker compose -f deploy/compose.infra.yml exec artemis ./bin/artemis producer --url amqp://localhost:5672 --protocol amqp --user landflow --password landflow-dev-only --destination q --message-count 1` (and `consumer`) |
| `pulsar` | `apachepulsar/pulsar:4.2.5`, `bin/pulsar standalone --no-functions-worker --no-stream-storage`, 512 MB heap | Shared subscriptions, message TTL, the admin REST API | `docker compose -f deploy/compose.infra.yml exec pulsar bin/pulsar-client produce persistent://public/default/t -m hi`; `curl http://localhost:58180/admin/v2/persistent/public/default` |
| `pubsub` | `gcr.io/google.com/cloudsdktool/google-cloud-cli:590.0.1-emulators`, `gcloud beta emulators pubsub start` | No credentials; topics and subscriptions in the volume (`--data-dir`); the emulator never expires messages. Clients: `PUBSUB_EMULATOR_HOST=127.0.0.1:58085` | REST works too: `curl -X PUT http://localhost:58085/v1/projects/landflow-dev/topics/t`, `.../topics/t:publish`, `.../subscriptions/s:pull` |
| `servicebus` | `mcr.microsoft.com/azure-messaging/servicebus-emulator:2.0.1` + `servicebus-sql` (`mcr.microsoft.com/azure-sql-edge:1.0.7`) | Static entities only, from [`infra/servicebus/Config.json`](../deploy/infra/servicebus/Config.json), which [`scripts/servicebus-config.py`](../deploy/scripts/servicebus-config.py) writes: see [Service Bus entities](#service-bus-entities). Starting the profile sets `ACCEPT_EULA=Y` for Microsoft's emulator and SQL EULAs (`LANDFLOW_SERVICEBUS_ACCEPT_EULA`). The emulator image is distroless (no healthcheck possible): poll `curl http://localhost:55300/health`. SQL: Azure SQL Edge 1.0.7 is the last tag with an arm64 build (2.0.0 and `mssql/server` are amd64 only and would run under Rosetta); Microsoft's own installer uses SQL Edge on Apple Silicon. Management operations (the Administration client) need the port in the connection string (`sb://localhost:55300`) and are .NET-only | `curl http://localhost:55300/health` → `{"status":"healthy",...}`; messaging through an AMQP 1.0 client with the connection string above |
| `mcp-gateway` | `cr.agentgateway.dev/agentgateway:v1.6.0` (pinned by digest) + a one-shot `mcp-gateway-init` (alpine) that gives the data volume to uid 65532 | The bundled MCP gateway for the dev server: `/mcp` on 54000, the admin API and UI on 55000 (no auth, loopback only; inside the container it must listen on `0.0.0.0:15000` for Docker to publish it). Base config [`mcp-gateway/config.yaml`](../deploy/mcp-gateway/config.yaml) (`prefixMode: always`, `failureMode: failOpen`, `statefulMode: stateless`, tracing to `jaeger:4318`); storage mode `hybrid`, so the host writes targets with `PUT http://127.0.0.1:55000/api/config/resources/mcp.target` and they live in SQLite in `mcp-gateway-data`; targets point at `host.docker.internal:3000`. Distroless: no healthcheck, readiness on `mcp-gateway:15021/healthz/ready` and metrics on `mcp-gateway:15020/metrics` in the network only. What was verified, the exact payloads and the gaps: [docs/mcp-gateway.md](mcp-gateway.md). Override files: `mcp-gateway/compose.tokens.yml` (sign-in with Landflow-issued MCP tokens, so an agent that connects with a token from Settings → MCP is that user instead of anonymous; start the dev server first, since the gateway fetches its JWKS at startup, and set `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` as in `.env.example` for the per-plugin routes), and for the spike's other modes `compose.auth.yml` (sign-in through Keycloak), `compose.stateful.yml`, `compose.file.yml` (file fallback) | `node deploy/scripts/mcp-gateway-spike.mjs` (core checks, 10 s) or `--all` (also Keycloak sign-in, the stateful mode and the file fallback; restarts the container and puts it back); `curl http://localhost:55000/api/config/resources/mcp.target`; the UI at http://localhost:55000/ui |


### The MCP gateway sync

The host keeps the gateway's targets equal to the plugins that are online, exposed to agents and have at least one tool
(plus `core`): `apps/web/src/lib/server/mcp/gateway-sync.ts`, started with the host in every main (workers don't sync).
It reacts to registry events, reconciles every 30 s, drops a plugin offline for 60 s, repairs drift (a gateway restart,
a hand edit), and only ever touches the resources it created (`mcp_gateway_resources`, migration 1730). After every
change of the target set the `core` endpoint emits `notifications/tools/list_changed` on its `subscriptions/listen`
streams, which the gateway relays. Settings → MCP shows the status (targets in step vs drift, last sync, last error)
with a resync button; `GET /api/mcp/gateway`, `POST /api/mcp/gateway/sync` (owners and admins).

| Setting | Meaning |
|---|---|
| `LANDFLOW_MCP_GATEWAY` | `bundled` (default): the config API on `LANDFLOW_MCP_GATEWAY_ADMIN_URL` (default `http://127.0.0.1:55000`; the sidecars use `http://127.0.0.1:15000`). `file`: a gateway of its own reads `LANDFLOW_MCP_GATEWAY_FILE` (default `<data dir>/mcp-gateway.yaml`), which the sync rewrites on every change (Landflow's `mcp.targets` and `landflow-*` routes; everything else in the file is kept). `off`: nothing runs |
| `LANDFLOW_MCP_GATEWAY_HOST_URL` | How the gateway reaches this host. Dev (gateway in Docker, host on the Mac): default `http://host.docker.internal:3000`. A compose or Kubernetes sidecar shares the host's network namespace: `http://127.0.0.1:3000` (set in `compose.yml`, `compose.queue.yml`, `k8s/base/host`) |
| `LANDFLOW_MCP_GATEWAY_SECRET` | Sent by every target as `x-landflow-gateway` (`backendAuth`); without it the sync writes nothing (the host would refuse every call) |
| `LANDFLOW_MCP_GATEWAY_ROUTES` | `on` (default): besides the shared `/mcp`, one route per plugin at `/mcp/plugins/<name>` (that plugin alone, tools unprefixed) and `/mcp/plugins/<name>/server-card` (proxied to the host's Server Card with the client's own bearer). `off`: targets only |
| `LANDFLOW_MCP_GATEWAY_ACCEPT_IDP` | Default: when `LANDFLOW_OIDC_ISSUER` is set and the route policies check Landflow's tokens, each route also accepts the identity provider's access tokens (agentgateway `jwtAuth` with two providers, the provider's keys inline; docs/mcp-gateway.md "Two issuers on one route"). `off`: Landflow's issuer only. Static versions: `mcp-gateway/config.tokens-idp.yaml` with `compose.tokens-idp.yml`, and `k8s/components/gateway-landflow-tokens-idp` |
| `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` | A JSON object merged into each per-plugin route's `policies`. **agentgateway applies `mcp.policies.mcpAuthentication` of the base config to `/mcp` only, not to extra routes**, so with sign-in on, put the same `mcpAuthentication` here (`{"mcpAuthentication":{...}}`), or a per-plugin route sees no caller identity and lists no tools |

**Target names** are the plugin ids when they already fit agentgateway's rule (lowercase letters, digits, `-`, `.`; every
bundled plugin does), so tools on `/mcp` are `<pluginId>_<tool>` (`text-toolkit_slugify`). Any other id is lowercased,
runs of other characters become `-`, and a 6-hex-digit hash of the original id is appended (`My_Plugin` →
`my-plugin-3f9a1c`); the mapping is deterministic (`gatewayTargetName()`), so the prefix is predictable.

**Sidecars.** `compose.yml` runs `mcp-gateway` with `network_mode: service:web` (config `mcp-gateway/config.sidecar.yaml`:
admin API on the shared `127.0.0.1:15000`, SQLite on `landflow-mcp-gateway-data`, chowned to uid 65532 by `mcp-gateway-init`),
and `/mcp` is published through `web` on `LANDFLOW_MCP_GATEWAY_PORT` (54000). `compose.queue.yml` runs one sidecar per main
(`mcp-gateway-1`, `-2`) and the load balancer sends `/mcp` and `/.well-known/oauth-protected-resource` to port 4000 of the
main it picks (`LB_MCP_PORT`, `LB_MCP_PATHS` in `queue/lb.mjs`). Kubernetes: a second container in the `landflow-host`
Deployment, the config from the `landflow-mcp-gateway` ConfigMap (`k8s/base/host/mcp-gateway-config.yaml`, a copy of the
sidecar config), an `mcp` port (4000) on the Service; reach it from outside the cluster with the `gateway-ingress` or `gateway-httproute` component
([Reaching the host from outside](#reaching-the-host-from-outside)), or `kubectl port-forward svc/landflow-host 54000:4000`. The sidecar configs carry no
sign-in: add `mcp.policies.mcpAuthentication` (and `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES`) for the instance's identity provider.

Credentials are development values (`deploy/.env.example` has every port and password as `LANDFLOW_*`). One
broker user per plugin, as the spec wants for real deployments, isn't set up here: every dev broker has one user or
none.

### The claim check (oversized broker bodies)

A request or response bigger than the broker allows (NATS, Kafka and SQS about 1 MiB, Service Bus 240 KiB) fails
`too_large` unless a claim store is configured; with one, the encrypted body goes by reference through an S3-compatible
bucket ([protocol §14.6](protocol.md)). Set the same three values on the host (every main and worker), every plugin
that serves on a broker, and `landflow-bridge`:

| Setting | Meaning |
|---|---|
| `LANDFLOW_CLAIM_STORE` | `s3://<bucket>/<prefix>?endpoint=<url>&region=<region>&forcePathStyle=true` (`&ttl=<seconds>`, default 3600, for the orphan sweep). An S3 store without `endpoint` is refused unless the URL says `aws=true`. `memory://` is for tests. Empty: no claim check |
| `LANDFLOW_CLAIM_ACCESS_KEY_ID`, `LANDFLOW_CLAIM_SECRET_ACCESS_KEY` | The bucket's keys (else `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`). Without static keys, see the credential chain below |

Credentials, in order (the TypeScript store uses the AWS SDK's default chain; the Go and Python stores implement the in-cluster part of it in
the standard library, with the same order): (1) the static keys above; (2) **web identity** (EKS IRSA): `AWS_WEB_IDENTITY_TOKEN_FILE` +
`AWS_ROLE_ARN` (+ `AWS_ROLE_SESSION_NAME`), exchanged at STS `AssumeRoleWithWebIdentity` (`AWS_ENDPOINT_URL_STS`, else `AWS_ENDPOINT_URL`, else
the regional `sts.<region>.amazonaws.com`, which the Go and Python stores use only when the store URL says `aws=true`); the token file is
re-read on every refresh; (3) **container credentials** (EKS Pod Identity, ECS): `AWS_CONTAINER_CREDENTIALS_FULL_URI` or
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, with the `Authorization` value from `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` or
`AWS_CONTAINER_AUTHORIZATION_TOKEN` (a plain-http FULL_URI must name loopback, `169.254.170.2`, `169.254.170.23` or `fd00:ec2::23`).
Temporary credentials are cached and renewed 5 minutes before they expire. The Go and Python stores read no shared credentials/config
file (`~/.aws`) and do no EC2 IMDS lookup: a developer laptop's real credentials must never be picked up, and IMDS probes time out off
EC2. Operators who need either export the keys. On EKS, annotate the service account (IRSA) or add a Pod Identity association; the pod
then needs only `LANDFLOW_CLAIM_STORE=s3://<bucket>/<prefix>?aws=true&region=<region>`.

Objects are deleted once the event is acknowledged; every client and server also sweeps `claims/` for objects older
than the TTL every 10 minutes (a bucket lifecycle rule on `claims/` is an optional extra). `compose.queue.yml` turns it
on with its own MinIO (`LANDFLOW_QUEUE_CLAIM_STORE` overrides the URL); `compose.yml` passes the variables through, empty by
default (for the infra MinIO from containers: `endpoint=http://host.docker.internal:59000`); Kubernetes: see the comment in
`k8s/components/broker-transports`. `GET /api/transports` (`claimStore`) and Settings → Transports say whether one is set.

### Transport benchmark

`deploy/scripts/transport-bench.py` compares every installed transport on the same call, against the dev server and the brokers
above (it starts and stops nothing in Docker):

```bash
export LANDFLOW_TRANSPORT_SECRET=...   # the dev server's value (or --secret-file <file holding it>)
python3 deploy/scripts/transport-bench.py --out bench.json                       # a few minutes
python3 deploy/scripts/transport-bench.py --kinds http,grpc,nats,kafka --calls 100 --sizes 100B,64KiB --concurrency 8 --duration 10
```

It starts `plugins/transport-bench` (one node, Echo, returning its input) with tsx on `--port` (7620; gRPC on the next port)
with a face for each kind, creates one connection per broker (`TMP T4-D <kind>`), publishes a baseline workflow (webhook -> Set) and an echo
workflow (webhook -> `transport-bench.echo`), then for each kind pins the plugin to it (`PATCH /api/plugins/transport-bench`),
warms up and times `--calls` sequential webhook calls per size (p50, p95, p99, mean, errors) and `--concurrency` callers for
`--duration` seconds (calls/s). The table subtracts the baseline p50 (engine and HTTP overhead) and shows the host's own p50 for
the kind. Kinds with no answering local broker, a message cap below the payload, or no discovery by the host are skipped and
listed. Everything it created is deleted at the end, also on Ctrl-C.

Caveats: every broker is a single local container or emulator (LocalStack for SQS, the Pub/Sub and Service Bus emulators), so
they differ from the real services and from a clustered broker; the host, the plugin, the brokers and the load generator share
one machine; Python's callers are threads on one core. Read the numbers as relative (which transport costs more, and how
size changes it), not as capacity. The Service Bus emulator's entities are fixed in `infra/servicebus/Config.json`: the bench
plugin's queue (`landflow.v1.plugin.transport-bench`) is not there, so that kind is skipped until it is added and the emulator recreated.

## Using the infra from the dev server on the host

Set these before `pnpm dev` / `pnpm dev:all` for traces (sign-in, email and SSO are in the next section):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:54318            # Jaeger (profile observability)
export LANDFLOW_TRACE_URL='http://localhost:56686/trace/{traceId}'   # trace links in the execution view
```

Databases, Redis and email are used through **credentials** in the UI (Credentials page or a node's credential picker):

| Credential | Fields |
|---|---|
| Postgres | host `localhost`, port `55432`, database `landflow` (or `landflow_test`), user `landflow`, password `landflow-dev-only`, SSL Disable |
| Redis | host `localhost`, port `56379` |
| MySQL | host `localhost`, port `53306`, database `landflow_test`, user `landflow`, password `landflow-dev-only`, SSL Off |
| SMTP | host `localhost`, port `51025`, SSL/TLS off, Disable STARTTLS on, any user/password; mail shows up at http://localhost:58025 |
| IMAP (profile `mail`) | host `localhost`, port `53143`, SSL/TLS off, user e.g. `inbox@landflow.test`, any password; send it mail over SMTP at `localhost:53025` |

From the dockerised host use `postgres` / `5432`, `valkey` / `6379`, `mysql` / `3306`, `mailpit` / `1025` with `compose.infra-link.yml`, or `host.docker.internal` with the Mac ports without it.

The host's store uses Postgres with `LANDFLOW_DB=postgres` and `DATABASE_URL` (one host per database; see [Durable runtime](features/engine.md#durable-runtime)). For queue mode and secrets (Landflow does not read these yet), the conventional settings are:

```bash
LANDFLOW_DB=postgres DATABASE_URL=postgres://landflow:landflow-dev-only@localhost:55432/landflow
REDIS_URL=redis://localhost:56379/0
S3_ENDPOINT=http://localhost:59000 S3_BUCKET=landflow AWS_ACCESS_KEY_ID=landflow AWS_SECRET_ACCESS_KEY=landflow-dev-only AWS_REGION=us-east-1
BAO_ADDR=http://localhost:58200 BAO_TOKEN=landflow-dev-root-token   # also VAULT_ADDR / VAULT_TOKEN
```

## Sign-in, email and SSO

Landflow needs a signed-in user ([Authentication](features/authentication.md)). A fresh data directory opens on `/setup`; to skip it, start the host with an owner:

```bash
LANDFLOW_OWNER_EMAIL=owner@landflow.test LANDFLOW_OWNER_PASSWORD=landflow-dev-only pnpm dev:all
```

The app stack does this by default (`compose.yml`, values in `.env.example`); blank both variables to use the setup page. They only matter while there is no user.

**Email** for invites and password resets, through Mailpit (messages at http://localhost:58025):

```bash
LANDFLOW_SMTP_HOST=127.0.0.1 LANDFLOW_SMTP_PORT=51025 LANDFLOW_SMTP_FROM='Landflow <landflow@landflow.test>'
```

**Single sign-on** through Keycloak (profile `auth`): users `alice` / `alice-test-only` (realm role `landflow-admin`, becomes an admin) and `bob` / `bob-test-only` (`landflow-editor`, a member):

```bash
LANDFLOW_OIDC_ISSUER=http://localhost:58080/realms/landflow LANDFLOW_OIDC_CLIENT_ID=landflow \
  LANDFLOW_OIDC_CLIENT_SECRET=landflow-dev-client-secret LANDFLOW_OIDC_ROLE_MAP=landflow-admin=admin,landflow-editor=member
```

**SAML sign-in** through the same Keycloak realm (the IdP comes from its metadata; alice becomes an admin, bob a member and, once a team project named `Data` exists, its editor):

```bash
LANDFLOW_SAML_IDP_METADATA_URL=http://localhost:58080/realms/landflow/protocol/saml/descriptor \
  LANDFLOW_SAML_ROLE_MAP=landflow-admin=admin,landflow-editor=member LANDFLOW_SAML_PROJECT_MAP=data-team=Data:editor
```

The dockerised host can't reach `localhost:58080`, so `compose.yml` (commented) adds `LANDFLOW_OIDC_DISCOVERY_URL` pointing at `host.docker.internal:58080` (or `keycloak:8080` with `compose.infra-link.yml`); Keycloak then hands out backchannel endpoints the container can reach, while browsers still go to `localhost:58080`. The realm already allows the `:3000` and `:53000` callback URLs.

Tests: `(cd apps/web && LANDFLOW_INTEGRATION=oidc,smtp npx vitest run test/oidc.integration.test.ts test/smtp.integration.test.ts)` signs in as alice and bob through Keycloak's own login form and sends invites and resets through Mailpit. `LANDFLOW_INTEGRATION=saml npx vitest run test/saml.integration.test.ts` does the SAML round trip (AuthnRequest, Keycloak's login form, its auto-posted SAMLResponse to the ACS, a replay, a deactivated user, single logout). Mailpit can take about 8 s to greet each new SMTP connection under Docker Desktop, so an invite takes that long to send here.

## The app stack

| Image | Built from | Runs |
|---|---|---|
| `landflow/host:dev` | [`docker/host.Dockerfile`](../deploy/docker/host.Dockerfile) | `node apps/web/server.js` (Next standalone output) as `node` (uid 1000), data in `/data`; queue-mode workers run `node worker.mjs` (an esbuild bundle of `pnpm worker`) from the same image; `apps/web/claude-plugins` (the landflow-harness mod packed for kagent's Claude Code agents, [a2a.md](a2a.md#the-landflow-harness-mod)) is copied next to `server.js` |
| `landflow/plugin-text-toolkit:dev`, `landflow/plugin-messaging:dev`, `landflow/plugin-github:dev` | [`docker/node-plugin.Dockerfile`](../deploy/docker/node-plugin.Dockerfile) | `tsx src/main.ts` as `node` |
| `landflow/plugin-py-insights:dev`, `landflow/plugin-productivity:dev` | [`docker/python-plugin.Dockerfile`](../deploy/docker/python-plugin.Dockerfile) | `python main.py` (SDK with `grpc` and `otel` extras) as uid 10001 |
| `landflow/plugin-go-crypto:dev`, `landflow/plugin-google-workspace:dev`, `landflow/plugin-databases:dev` | [`docker/go-plugin.Dockerfile`](../deploy/docker/go-plugin.Dockerfile) | static binary on Alpine as uid 10001 |
| `landflow/plugin-browser:dev` (profile `browser`) | [`plugins/browser/Dockerfile`](../plugins/browser/Dockerfile) | `tsx src/main.ts` as `node` on Debian with Chrome and agent-browser, headless: see [Browser plugin](#browser-plugin) |
| `landflow/code-runner:dev` | [`docker/code-runner.Dockerfile`](../deploy/docker/code-runner.Dockerfile) | `node dist/main.mjs` (esbuild bundle) on Node 26 + CPython 3 (standard library) as uid 10001; `code-runner-port` runs `node dist/forward.mjs` from the same image |

All builds use the repository root as context; [`/.dockerignore`](../.dockerignore) keeps out `node_modules`, `.next`, `.data`, venvs and Go binaries. Every image has a healthcheck: the host's `GET /api/health/ready`, each plugin's `GET /landflow/v1/health`. Build one image on its own with, for example:

```bash
docker build -f deploy/docker/go-plugin.Dockerfile --build-arg PLUGIN=databases \
  --build-arg HTTP_PORT=7107 --build-arg GRPC_PORT=7207 -t landflow/plugin-databases:dev .
```

**Host.** `apps/web/next.config.ts` switches to `output: 'standalone'` when `LANDFLOW_NEXT_OUTPUT=standalone`, which only the image build sets. Workflows, executions, agents and the credentials vault live in the `landflow_landflow-data` volume (`LANDFLOW_DATA_DIR=/data`). `LANDFLOW_ENCRYPTION_KEY` (64 hex characters or a passphrase) comes from the environment; left empty, the vault generates `/data/encryption.key` on first use. Changing the key later makes saved credentials unreadable. `LANDFLOW_PUBLIC_URL` is `http://localhost:53000` so links the host hands out point at the published port. `OLLAMA_URL` points at Ollama on the Mac (`host.docker.internal:11434`).

**Plugins.** Each container sets `LANDFLOW_REGISTRY_URL=http://web:3000` and `LANDFLOW_ADVERTISE_HOST=<service name>`, so it announces `http://<service>:<port>` and `grpc://<service>:<port>` and heartbeats every 10 s. With `LANDFLOW_REGISTRY_SECRET` set on the host, add the same value to `x-plugin-env` so they may register. Stopping a container withdraws it at once; restarting the host is picked up on the next heartbeat. The host's scan (`LANDFLOW_SCAN_HOSTS`, `LANDFLOW_SCAN_PORTS`) probes the plugin services too, so the Plugins page's "Scan network" works in Docker.

**Plugins and transports.** Every plugin image carries its SDK's broker drivers. TypeScript images have `@landflow/transports` and all eleven client libraries, native Kafka and Pulsar clients included. Go images link the tier 1 drivers (Kafka, RabbitMQ, NATS/JetStream, Valkey), and tier 2 kinds reach a Go plugin through `landflow-bridge`. Python images install the SDK with its `grpc`, `mcp` and `brokers` extras (native Kafka, RabbitMQ, NATS/JetStream and Valkey drivers) and carry `landflow-bridge` for the other kinds (about 50 MB). A broker face runs only when `LANDFLOW_TRANSPORTS` names it, plus `LANDFLOW_<KIND>_URL` for each kind; the default stays `http,grpc`. `LANDFLOW_TRANSPORTS` selects every face, the MCP face included, so a list that leaves out `mcp` turns it off in all three SDKs. Over a broker, calls are encrypted and signed with `LANDFLOW_TRANSPORT_SECRET`, which must equal the host's.

| Where | Broker faces | The plugin's own MCP face |
|---|---|---|
| Dev (a plugin on the Mac) | `LANDFLOW_TRANSPORTS=http,grpc,mcp,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_TRANSPORT_SECRET=…` | On, on loopback, no token (`http://127.0.0.1:7101/mcp`); `LANDFLOW_MCP=off` disables it |
| Compose (`compose.yml`, `compose.queue.yml`) | `LANDFLOW_PLUGIN_TRANSPORTS=http,grpc,nats` plus the `LANDFLOW_<KIND>_URL` lines in `x-plugin-env`; `LANDFLOW_TRANSPORT_SECRET` is passed through (queue mode: `LANDFLOW_QUEUE_TRANSPORT_SECRET`) | Off (`LANDFLOW_PLUGIN_MCP`, default `off`); `LANDFLOW_PLUGIN_MCP=on` needs `LANDFLOW_PLUGIN_MCP_TOKEN` because containers listen on 0.0.0.0, and `mcp` in `LANDFLOW_PLUGIN_TRANSPORTS` |
| Kubernetes | The `broker-transports` component writes `LANDFLOW_TRANSPORTS`, the URLs and the secret ("Brokers on Kubernetes") | Off (`LANDFLOW_MCP=off` in each plugin manifest, which shows how to turn it on with a token Secret) |

Agents reach plugins through the host's per-plugin MCP endpoints and the bundled gateway, so a container doesn't need its own `/mcp`.

**Mixing Docker and the Mac.** A plugin running on the Mac can join the dockerised host if it advertises an address the container can reach:

```bash
LANDFLOW_REGISTRY_URL=http://localhost:53000 LANDFLOW_ADVERTISE_HOST=host.docker.internal \
  LANDFLOW_HTTP_PORT=7151 LANDFLOW_GRPC_PORT=7251 pnpm plugin:ts
```

## Queue mode (two mains, two workers)

[`compose.queue.yml`](../deploy/compose.queue.yml) (project `landflow-queue`) runs Landflow in queue mode with high availability ([Queue mode, workers and high availability](features/engine.md#queue-mode-workers-and-high-availability)) on the infra stack's Postgres, Valkey and MinIO. One image runs everything: the mains run `node server.js`, the workers `node worker.mjs`. Workers run the same production check as the mains, so in the production profile they need the same variables (including `LANDFLOW_PUBLIC_URL` and `LANDFLOW_REGISTRY_SECRET`, or `LANDFLOW_REGISTRY_OPEN=true`) even though they serve no registry; the bundled manifests use the development profile.

```bash
docker compose -f deploy/compose.infra.yml up -d --wait
docker compose -f deploy/compose.infra.yml exec postgres createdb -U landflow landflow_queue   # once
COMPOSE_BAKE=false docker compose -f deploy/compose.queue.yml up -d --build --wait              # http://localhost:53080
python3 deploy/scripts/queue-e2e.py      # load spread, a killed worker, a killed leader: about 3 minutes
```

| Service | On the Mac | |
|---|---|---|
| `lb` | http://localhost:53080 | round robin over the mains, skipping for 5 s one that is unreachable or whose `/api/health/ready` (asked every 2 s) is not 200, such as a main draining for shutdown; a browser sticks to one main (cookie `landflow_main`; the `x-landflow-main` header says which one answered). A stand-in for your load balancer: [`queue/lb.mjs`](../deploy/queue/lb.mjs) |
| `main-1`, `main-2` | http://localhost:53081, http://localhost:53082 | UI, API, webhooks. `main-1` creates the owner (`owner@landflow.test` / `landflow-dev-only`); `main-2` and the workers start once it is healthy |
| `worker-1`, `worker-2` | http://localhost:55691/healthz, http://localhost:55692/healthz (`/metrics` too) | 10 runs at once each (`LANDFLOW_WORKER_CONCURRENCY`); jobs are taken high, normal, low from three streams (`jobs:high`, `jobs`, `jobs:low`) by the workflow's Priority, with one low job after every eight others |
| `text-toolkit` | not published | registers through the load balancer; the mains keep its address in Postgres and the workers call it directly |

Every process shares the database `landflow_queue` (`LANDFLOW_QUEUE_DATABASE`), the Valkey key prefix `landflow-queue`, the `landflow-queue_landflow-queue-data` volume at `/data` (agent files, one insights rollup per process; credentials and settings files are in the database, imported once from `/data` on the first start: `LANDFLOW_CONFIG_STORE`), the encryption key and file-link secret (development values; `LANDFLOW_QUEUE_ENCRYPTION_KEY`, `LANDFLOW_QUEUE_BINARY_SECRET`) and the binary store: MinIO's `landflow` bucket under `queue/`, with the endpoint (`http://minio:9000`) and keys set explicitly, so the AWS default credential chain is never used. Traces: `LANDFLOW_QUEUE_OTLP_ENDPOINT=http://jaeger:4318` (with the `observability` profile); a run's trace goes from the main that took the webhook to the worker that ran it.

**Brokers in queue mode.** Mains **and workers** open the instance's enabled broker connections (`LANDFLOW_TRANSPORT_SECRET`, set for every process in `compose.queue.yml`; `LANDFLOW_QUEUE_TRANSPORT_SECRET` changes it). Connections live in the shared database: add one through any main (Settings → Transports, or `POST /api/transports/connections`) and every main and worker opens it within a second; edit it and they reopen it; disable or delete it and they close it (NATS's `/connz` on 58222 shows the client count go from 5 to 1 and back). A worker discovers plugins over the brokers itself and chooses a transport per call with Auto, so a plugin that is announced only on a broker (no HTTP or gRPC address) runs in the workers. Both networks are attached, so the brokers are `nats:4222`, `kafka:9092`, `rabbitmq:5672`, `valkey:6379` and so on in the connection's URL. The workers do not sync the MCP gateway (each main's sidecar does: `/mcp` through the load balancer goes to port 4000 of a main). The image links the broker clients the worker bundle leaves external (`@confluentinc/kafka-javascript`, `pulsar-client`, `@aws-sdk/client-sqs`, `@google-cloud/pubsub`) into `/app/node_modules` and ships the Kafka and Pulsar native addons, which Next's standalone trace skips.

Try it: add a NATS connection (`{"name":"TMP nats","kind":"nats","config":{"url":"nats://nats:4222"}}`), stop the `text-toolkit` container and run the plugin on the Mac with only the broker face: `LANDFLOW_TRANSPORTS=nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 LANDFLOW_REGISTRY_URL=off LANDFLOW_MCP=off LANDFLOW_TRANSPORT_SECRET=landflow-queue-dev-only-transport-secret LANDFLOW_HTTP_PORT=7581 LANDFLOW_GRPC_PORT=7582 pnpm --filter @landflow/plugin-text-toolkit start`. A webhook workflow with a `text-toolkit.slugify` node then runs in the workers over NATS (`plugin.rpc Execute` spans in their logs carry `landflow.transport: nats`).

What `queue-e2e.py` checks, and what it measured on OrbStack:

- **load**: 40 concurrent webhook calls through the load balancer, each through the text-toolkit plugin: all answered in 0.3 to 0.4 s, split 17 / 23 and 18 / 22 between the workers.
- **worker**: a run waits 20 s in a Wait node and its worker is killed (SIGKILL). The other worker claims the job once it has been idle for 30 s and continues the run from the checkpoint before the Wait: finished about 55 s after the kill, tagged **Resumed after restart**.
- **leader**: a schedule fires every 5 s and the leader main is killed. The other main leads 8.5 to 11 s later (fencing token + 1) and the schedule goes on (a 10 s gap: the slot due during the failover runs once, late); the killed main comes back as a follower.

**Valkey Sentinel**: [`compose.sentinel.yml`](../deploy/compose.sentinel.yml) (project `landflow-sentinel`, on the infra network) runs a primary (56381), a replica (56382) and three sentinels (56391–56393, master name `mymaster`), on tmpfs. Point the queue stack at it, and kill the primary to watch a failover (the sentinels promote the replica within about 5 s; the old primary rejoins as a replica when it comes back):

```bash
docker compose -f deploy/compose.sentinel.yml up -d --wait
LANDFLOW_QUEUE_VALKEY_SENTINELS=valkey-sentinel-1:26379,valkey-sentinel-2:26379,valkey-sentinel-3:26379 \
  COMPOSE_BAKE=false docker compose -f deploy/compose.queue.yml up -d --wait
docker compose -f deploy/compose.sentinel.yml kill valkey-primary      # then: start valkey-primary
(cd apps/web && LANDFLOW_INTEGRATION=sentinel npx vitest run test/valkey-sentinel.integration.test.ts)
```

**Valkey Cluster**: `LANDFLOW_VALKEY_CLUSTER=host:port,…` ([Queue mode](features/engine.md#queue-mode-workers-and-high-availability)). Every key carries one hash tag, so the queue lives on one slot: failover, not scale-out. The infra stack's `valkey-cluster` profile starts six nodes (three primaries, three replicas; ports 56411–56416 on 127.0.0.1, announcing `valkey-cluster-N`) and a one-shot `valkey-cluster-init`. From the Mac the announced names don't resolve, so map them:

```bash
COMPOSE_BAKE=false docker compose -f deploy/compose.infra.yml --profile valkey-cluster up -d --wait
(cd apps/web && LANDFLOW_INTEGRATION=valkey-cluster npx vitest run test/valkey-cluster.integration.test.ts)   # stops the slot's owner under a main and a worker
# the queue stack, on the infra network, reaches the nodes by their announced names:
LANDFLOW_QUEUE_VALKEY_CLUSTER=valkey-cluster-1:6379,valkey-cluster-2:6379 docker compose -f deploy/compose.queue.yml up -d --wait
# remove: docker compose -f deploy/compose.infra.yml --profile valkey-cluster rm -sfv valkey-cluster-1 valkey-cluster-2 valkey-cluster-3 valkey-cluster-4 valkey-cluster-5 valkey-cluster-6 valkey-cluster-init   (not `down -v`)
```

`LANDFLOW_VALKEY_CLUSTER_NAT=valkey-cluster-1:6379=127.0.0.1:56411,…` maps the announced addresses to the ones you can reach. Sentinel and Cluster together are refused at start.

**Marketplace node plugins** install on either main and run in every main and worker (each its own child process). The containers have no `/app/packages`, so a plugin needing `@landflow/sdk` links can't be prepared there; plain JavaScript, Python and Go plugins can. A local marketplace path needs `LANDFLOW_QUEUE_MARKETPLACE_ALLOW_LOCAL=1` at `up` time.

Day to day: **Settings → Workers** on either main shows the leader, the queue and every process; `docker compose -f deploy/compose.queue.yml stop worker-1` sends SIGTERM (runs get 30 s, the worker gives itself 40 s in all, `stop_grace_period` is 45 s, and what doesn't finish continues on the other worker); `stop main-1` on the leader hands the leadership over within about 3 s. To add a worker, copy `worker-2` with its own `LANDFLOW_INSTANCE_ID` and port. Valkey keys: `docker compose -f deploy/compose.infra.yml exec valkey valkey-cli --scan --pattern 'landflow-queue:*'`.

## Code runner

The Code node runs JavaScript in-process (`node:vm` inside the host: quick, but not isolated) or in the **code runner** ([`services/code-runner`](../services/code-runner)), which also runs Python. Every snippet gets a fresh child process (Node for JavaScript, CPython with the standard library only for Python) with an empty environment and its own temporary work directory, deleted afterwards. The host posts the items, the outputs of the nodes the snippet names (`$('Node')`, `_('Node')`), `$vars` and the execution and workflow data to `POST /v1/run` with the shared secret in `x-landflow-runner-secret`; it gets back the items, the `console.log`/`print` output and errors with line numbers (`TypeError: … [line 3, for item 0]`). Files cross the same protocol, because the sandbox has no network: the request's `binary` carries the bytes of the input files (base64, by `"<item>:<property>"`; only when the code reads them, up to the cap, with `binarySkipped` giving the reason for any left out), and a file the snippet creates comes back as `binary.<name>.data` (base64) for the host to store in its binary store (filesystem or S3). The runner caps the files a snippet creates at `CODE_RUNNER_MAX_BINARY_BYTES` (6 MiB, `LANDFLOW_CODE_RUNNER_MAX_BINARY_BYTES` in compose; a request can only lower it), and the request size (`CODE_RUNNER_MAX_REQUEST_BYTES`, 32 MB) and output cap (10 MB) still apply: raise them together when you raise this one. `GET /health` needs no secret; `GET /v1/info` shows versions, limits and the isolation the runner found.

| Host setting | |
|---|---|
| `LANDFLOW_CODE_RUNNER_URL` | `http://code-runner:7300` in compose (set already), `http://127.0.0.1:53300` for the Docker runner from the dev server, `http://127.0.0.1:7300` for one started with pnpm |
| `LANDFLOW_CODE_RUNNER_SECRET` | the runner's `CODE_RUNNER_SECRET` (compose: `LANDFLOW_CODE_RUNNER_SECRET`, default `landflow-code-runner-dev-only`) |
| `LANDFLOW_CODE_IN_PROCESS` | `false`: no in-process JavaScript on this host, so every Code node needs the runner (the dockerised host sets it). Unset: allowed in the development profile, off in the production profile, where Code nodes run in the code runner or fail with a message that names this variable; `true` there is a knowing choice to run trusted code in the host |
| `LANDFLOW_CODE_BINARY_MAX_BYTES` | files a Code node reads and creates (`this.helpers.getBinaryDataBuffer` / `prepareBinaryData`), each way, 6 MiB by default |

With a runner configured, Code nodes on **Run In: Default** use it; **Sandbox** and **In-process** (JavaScript only) pin one. Python always runs in the runner and fails with "Python code needs the code runner, and this host has none" without one. The host reads these on every run, but environment variables only change on a restart.

**The container is the security boundary.** `compose.yml` runs `code-runner` with:

- **No network**: only the `landflow-code` network, which is `internal` (no route out, no DNS for outside names) and uses the isolated gateway mode (`com.docker.network.bridge.gateway_mode_ipv4: isolated`, Docker Engine 28.2+). An ordinary internal network still gives the bridge an address on the Docker host, and from there a snippet reached every port published on `0.0.0.0` on this machine (other projects' Postgres, Redis, n8n, …); in isolated mode those connections are refused. On an older engine, delete the `driver_opts` lines: the snippet guards below still block sockets, but that gap stays. Only the host (to call the runner) and the port forwarder below join `landflow-code`.
- **Read-only root filesystem**; `/tmp` is a 256 MB tmpfs with `noexec,nosuid,nodev`, where the work directories live.
- **Non-root** (uid 10001), `cap_drop: [ALL]`, `no-new-privileges`.
- **Limits**: `pids_limit: 128`, `mem_limit: 1g`, `cpus: 2` (`LANDFLOW_CODE_RUNNER_MEM_LIMIT`, `LANDFLOW_CODE_RUNNER_CPUS`), at most 2 snippets at a time (`LANDFLOW_CODE_RUNNER_CONCURRENCY`) and 32 queued; past that the runner answers 503 and the node reports that it is busy.
- **Not published.** Docker publishes no ports for a container that is only on an internal network, so `code-runner-port` (a TCP forwarder from the same image, equally locked down, on `landflow-code` and `landflow-code-port`) publishes `127.0.0.1:53300` and forwards it to `code-runner:7300` only.

Inside the container every snippet also gets, as a second layer:

- a **wall timeout** (`LANDFLOW_CODE_RUNNER_TIMEOUT_MS`, 60 s) that kills its process group, and a **CPU-seconds** rlimit;
- a **memory limit** (`LANDFLOW_CODE_RUNNER_MEMORY_MB`, 256): the RSS is watched every 100 ms, plus V8's heap limit for JavaScript and an address-space rlimit for Python;
- a **file size** rlimit (16 MB), no core dumps, and an **output cap** on items plus logs (10 MB);
- **JavaScript**: Node's permission model (reads only the runner's own files and the work directory, writes only the work directory, no child processes, workers, addons or, on Node 25+, network; the image uses Node 26 for that), no `eval`/`new Function`, and `require` limited to `assert`, `buffer`, `crypto`, `events`, `path`, `querystring`, `string_decoder`, `url`, `util`, `zlib` and Luxon. The snippet runs in a `vm` context with `fetch`, `net`, `dgram`, `dns` and `process.kill` replaced by errors;
- **Python**: `python -I -S -B` with an audit hook that blocks sockets, subprocesses, `os.system`/`exec*`, signals, `ctypes` and writes outside the work directory.

These guards make mistakes fail with a clear message ("… is disabled in the code sandbox"), but determined code can get past an in-process guard such as a Python audit hook. What holds then is the container.

**Check the isolation.** `deploy/scripts/smoke.sh code` checks the runner's health and runs [`scripts/code-runner-isolation.mjs`](../deploy/scripts/code-runner-isolation.mjs), which sends snippets through the published port that try to reach the internet (TCP, DNS, HTTPS), the Mac (`host.docker.internal`) and the Docker host's side of the bridge, and to write to `/app`, `/etc`, `/` and outside the work directory. Every line shows the error that stopped the attempt; the script exits 1 if one gets through. To see what the container stops on its own, start the runner with its guards off (diagnostics only, never for real use) through an override file and run the script again; expect `ENETUNREACH`, DNS `EAI_AGAIN` and `EROFS`:

```bash
cat > /tmp/code-runner-diag.yml <<'EOF'
services:
  code-runner:
    environment: { CODE_RUNNER_GUARDS: "off", CODE_RUNNER_JS_ALLOW_BUILTIN: "*" }
EOF
COMPOSE_BAKE=false docker compose -f deploy/compose.yml -f /tmp/code-runner-diag.yml up -d --wait code-runner code-runner-port
node deploy/scripts/code-runner-isolation.mjs
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --wait code-runner   # guards back on
```

**Without Docker** (development):

```bash
CODE_RUNNER_SECRET=dev pnpm --filter code-runner dev        # http://127.0.0.1:7300, restarts on changes
# or plain Node: the esbuild bundle
pnpm --filter code-runner build && CODE_RUNNER_SECRET=dev node services/code-runner/dist/main.mjs

# the dev server, in its own terminal
LANDFLOW_CODE_RUNNER_URL=http://127.0.0.1:7300 LANDFLOW_CODE_RUNNER_SECRET=dev pnpm dev
```

The runner uses what the OS offers and logs it at startup (`isolation: osSandbox=sandbox-exec cpuLimit=true …`). On macOS each snippet runs under `sandbox-exec` (no network, writes only to its work directory and `/dev/null`); on Linux in an empty network namespace (`unshare -rn`) where unprivileged user namespaces are allowed. Rlimits, the memory watch, the timeout, the output cap and the guards apply everywhere. It warns when it finds no OS sandbox. This is fine for your own code on your own machine. For code you don't trust, use the container.

Runner settings (environment of `services/code-runner`; the compose file maps the `LANDFLOW_CODE_RUNNER_*` ones):

| Variable | Default | |
|---|---|---|
| `CODE_RUNNER_SECRET` | required (falls back to `LANDFLOW_CODE_RUNNER_SECRET`) | shared with the host |
| `CODE_RUNNER_HOST` / `CODE_RUNNER_PORT` | `127.0.0.1` (image: `0.0.0.0`) / `7300` | listen address |
| `CODE_RUNNER_TIMEOUT_MS` | `60000` | wall time per snippet |
| `CODE_RUNNER_CPU_SECONDS` | the timeout in seconds | CPU rlimit |
| `CODE_RUNNER_MEMORY_MB` | `256` | memory per snippet |
| `CODE_RUNNER_MAX_OUTPUT_BYTES` | `10485760` | items plus logs |
| `CODE_RUNNER_FILE_SIZE_MB` | `16` | largest file a snippet can write |
| `CODE_RUNNER_CONCURRENCY` / `CODE_RUNNER_QUEUE` | 4 or the CPU count if lower / `32` | snippets at a time / waiting |
| `CODE_RUNNER_MAX_REQUEST_BYTES` | `33554432` | request body |
| `CODE_RUNNER_PYTHON` / `CODE_RUNNER_NODE` | `python3` / the runner's own Node | interpreters |
| `CODE_RUNNER_TMPDIR` | the OS temp directory | where work directories go |
| `CODE_RUNNER_JS_ALLOW_BUILTIN` | the list above | Node built-ins `require` may load, comma-separated, or `*` |
| `CODE_RUNNER_GUARDS` / `CODE_RUNNER_OS_SANDBOX` | on / on | `off` for diagnostics only |

## Browser plugin

The [Browser plugin](../plugins/browser/README.md) drives Chrome through Vercel's agent-browser CLI, so it needs both. It is **optional everywhere** and is a **separate image on the code-runner pattern**: [`plugins/browser/Dockerfile`](../plugins/browser/Dockerfile) (Debian, because Chrome for Testing needs glibc; not the Alpine [`node-plugin.Dockerfile`](../deploy/docker/node-plugin.Dockerfile), which has no browser). The image is large. It was built and run on arm64 (2026-11-07), and the amd64 install step was run in a Debian container: on amd64 `agent-browser install --with-deps` installs the Debian libraries and Chrome for Testing; on arm64 (Apple Silicon, the OrbStack engine here) Chrome for Testing has no Linux build, so the image installs Debian's `chromium` instead. Either way `/opt/agent-browser/chrome` is a symlink to the browser and `AGENT_BROWSER_EXECUTABLE_PATH` names it (the CLI does not honour `AGENT_BROWSER_HOME`; `AGENT_BROWSER_ARGS=--no-sandbox` is honoured). `AGENT_BROWSER_VERSION` is pinned to 0.41.2.

| Where | How |
|---|---|
| Dev server | `pnpm dev:all` leaves it out, since it needs the CLI and Chrome on the Mac (`npm i -g agent-browser && agent-browser install`). `pnpm dev:all:browser` is `dev:all` plus `pnpm plugin:browser` (HTTP `:7112`, gRPC `:7212`). |
| Compose | The `browser` service is in the `browser` profile: `COMPOSE_BAKE=false docker compose -f deploy/compose.yml --profile browser up -d --build --wait`. A plain `up` neither builds nor starts it. The host's scan already lists `browser` and ports `7112`/`7212`, so it is found once it runs. |
| Kubernetes | A component, off by default: build `landflow/plugin-browser:k8s-dev` with the command in [`components/browser/kustomization.yaml`](../deploy/k8s/components/browser/kustomization.yaml), then uncomment `- ../../components/browser` in the OrbStack overlay. The Service is labelled for discovery like the other plugins. |

- **Headless only in a container.** There is no display, so the image always runs Chrome headless. `LANDFLOW_BROWSER_HEADED=1` and a node's **Show the Browser Window** are for a desktop (the dev server on the Mac); in a container they have nothing to draw on.
- **Set `LANDFLOW_BROWSER_ALLOWED_DOMAINS`.** It is the operator's ceiling (comma separated, `*.example.com` includes subdomains): every node's list must sit inside it. Left empty, each node is limited only by its own **Allowed Domains**, which default to the URL's site, so a flow can send the browser to any site you let it name. Compose reads it from the environment (`LANDFLOW_BROWSER_ALLOWED_DOMAINS` in `deploy/.env`); on Kubernetes edit the env var in `components/browser/browser.yaml`. Page text a node returns is untrusted data.
- **Container limits.** Read-only root filesystem with a tmpfs `/tmp` (and `HOME`) and a 512 MiB `/dev/shm`, no capabilities, no privilege escalation, 2 GiB of memory (`LANDFLOW_BROWSER_MEM_LIMIT`). Chrome's own sandbox needs privileges the container drops, so the image starts Chrome with `--no-sandbox` (`AGENT_BROWSER_ARGS`): the container is the boundary. Each call starts its own Chrome and the plugin runs two at once.
- Unlike the code runner, the container needs a route out: it fetches the pages. Its network is the app network, so the allow-list is the only fence on where it goes.

## Agent Shell and Web Search plugins

Two ordinary Node plugins on [`deploy/docker/node-plugin.Dockerfile`](../deploy/docker/node-plugin.Dockerfile) (Alpine, `tsx src/main.ts` as `node`), both **optional**.

| | Agent Shell ([README](../plugins/agent-shell/README.md)) | Web Search ([README](../plugins/web-search/README.md)) |
|---|---|---|
| Ports | HTTP `7114`, gRPC `7214` | HTTP `7113` (MCP at `/mcp`), gRPC `7213` |
| Dev server | `pnpm plugin:agent-shell`; `pnpm dev:all:agent-shell` is `dev:all` plus it | `pnpm plugin:web-search`; `pnpm dev:all:web-search` is `dev:all` plus it |
| Compose | profile `agent-shell`: `COMPOSE_BAKE=false docker compose -f deploy/compose.yml --profile agent-shell up -d --build --wait` | profile `web-search`: the same with `--profile web-search` |
| Kubernetes | component `components/agent-shell`, image `landflow/plugin-agent-shell:k8s-dev` | component `components/web-search`, image `landflow/plugin-web-search:k8s-dev` |
| Settings | none: just-bash has no host files and no network | `LANDFLOW_SEARCH_SEARXNG_URL` (the SearXNG instance, when no SearXNG credential names one) and `LANDFLOW_SEARCH_DENY_DOMAINS` (operator deny-list); keys for Brave and Tavily are saved credentials |

Both services run with a read-only root filesystem, a small tmpfs `/tmp`, no capabilities and no privilege escalation. The host's scan (`LANDFLOW_SCAN_HOSTS`, `LANDFLOW_SCAN_PORTS`) lists both services and the ports `7113`/`7114` and `7213`/`7214`. Build the Kubernetes images with the command at the top of each component's `kustomization.yaml`, then uncomment the component in the OrbStack overlay. Web Search needs a route out to its provider; the Agent Shell does not.

## Integration tests (databases plugin)

`plugins/databases/integration_test.go` runs the Postgres, Postgres Trigger, Redis and MySQL nodes against the real servers above. It is skipped unless `LANDFLOW_INTEGRATION` names the services, so `go test ./...` stays offline.

```bash
docker compose -f deploy/compose.infra.yml up -d --wait                       # Postgres, Valkey
docker compose -f deploy/compose.infra.yml --profile mysql up -d --wait mysql # MySQL 8.4
cd plugins/databases
LANDFLOW_INTEGRATION=postgres,redis go test -count=1 -run Integration -v .
LANDFLOW_INTEGRATION=all go test -count=1 -run Integration -v .               # + MySQL
```

Connections default to the ports and credentials above (database `landflow_test`); override them with `LANDFLOW_IT_PG_HOST`, `LANDFLOW_IT_PG_PORT`, `..._USER`, `..._PASSWORD`, `..._DATABASE`, and the same for `REDIS` and `MYSQL`. Each test works in its own schema, table or key prefix and drops it afterwards.

## Integration tests (Email Trigger, IMAP)

`apps/web/test/email-imap.test.ts` (the node: baseline, mark read, move, manual runs, Search Criteria, raw `.eml` output, IDLE) and `test/email-imap-host.test.ts` (a published workflow polled by the host, attachments in the run's binary scope, IDLE starting a run) run against GreenMail. They are skipped unless `LANDFLOW_INTEGRATION` includes `imap`.

```bash
docker compose -f deploy/compose.infra.yml --profile mail up -d --wait greenmail
(cd apps/web && LANDFLOW_INTEGRATION=imap npx vitest run test/email-imap.test.ts test/email-imap-host.test.ts)
```

The Search Criteria parser has its own offline tests (`test/imap-search.test.ts`). GreenMail's FROM/TO search matches a whole address rather than a fragment, so the live criteria use full addresses.

Each test file uses a fresh mailbox (`<name>-<time>@landflow.test`), delivered over GreenMail's SMTP port. `LANDFLOW_GREENMAIL_HOST`, `LANDFLOW_GREENMAIL_IMAP_PORT` and `LANDFLOW_GREENMAIL_SMTP_PORT` point the tests (and the compose ports) elsewhere. GreenMail keeps mail in memory, so a restart empties it.

## Kubernetes

[`k8s/`](../deploy/k8s) runs the host and the seven plugins on Kubernetes, with the host finding the plugins through
**Kubernetes discovery** instead of announcements ([protocol §13](protocol.md#13-kubernetes-discovery-and-registry-proofs)).
It is plain [kustomize](https://kustomize.io), built into `kubectl` (`apply -k`): no extra tool, plain YAML to read and
diff, and overlays for the differences between clusters. A Helm chart would add templating Landflow does not need yet.

| Path | What |
|---|---|
| `k8s/base/host/` | `landflow-host` Deployment (one replica, `Recreate`: SQLite in `/data`), its Service (`3000`, gRPC registry `7070`), a 5 Gi PVC, and RBAC: a ServiceAccount with a **Role** (not a ClusterRole) allowing `get`/`list`/`watch` on `services` and `endpointslices` in its own namespace |
| `k8s/base/plugins/` | a Deployment and a Service per plugin: Service label `landflow.dev/plugin: "true"`, annotation `landflow.dev/grpc-port: grpc`, readiness on `GET /landflow/v1/health`, `LANDFLOW_REGISTRY_URL=off`, non-root with a read-only root filesystem |
| `k8s/components/postgres` | optional: Postgres 16 + pgvector (StatefulSet), and the host on it (`LANDFLOW_DB=postgres`, `DATABASE_URL`) |
| `k8s/components/package-cache` | the package cache for kagent's sandboxes (in the `orbstack` overlay): Service `landflow-cache:8080`, nginx in front of Verdaccio, Athens, proxpi and an Alpine `proxy_cache`, each on a PVC ([a2a.md](a2a.md#network-for-claude-code)) |
| `k8s/components/valkey` | optional: Valkey 8 and `LANDFLOW_VALKEY_URL` for queue mode |
| `k8s/components/external-services` | optional: Postgres and Valkey elsewhere, from a Secret `landflow-external` you create (`database-url`, `valkey-url`) |
| `k8s/components/cluster-discovery` | optional: discovery in every namespace: a **ClusterRole** (`get`/`list`/`watch` on `services` and `endpointslices`, nothing else) bound to `landflow-host`, and `LANDFLOW_K8S_NAMESPACES=*` |
| `k8s/overlays/orbstack` | OrbStack: namespace `landflow-dev`, the local `:k8s-dev` images with `imagePullPolicy: Never`, the host's data on the `landflow-data` PVC (OrbStack's `local-path`, so credentials, agents and the images Landflow serves kagent survive a rollout; delete the PVC with the host scaled to 0 to start over), dev-only Secrets (`landflow-registry`, `landflow-host` with the owner), and `OLLAMA_URL` at the Mac's Ollama (`host.docker.internal:11434`) for Spotlight and the [second brain](second-brain.md) |
| `k8s/overlays/orbstack-cluster-wide` | the OrbStack overlay plus `cluster-discovery` |
| `k8s/components/{kafka,rabbitmq,nats}`, `k8s/components/valkey` | optional: one message broker each, one small pod and a Service (`kafka:9092` KRaft, `rabbitmq:5672`, `nats:4222` with JetStream, `valkey:6379`), the images and versions of `compose.infra.yml`, data in an `emptyDir`. `k8s/components/brokers` takes all four |
| `k8s/components/broker-transports` | optional: points the host and the TypeScript plugins at the brokers: ConfigMap `landflow-transport` (`LANDFLOW_<KIND>_URL`, `LANDFLOW_TRANSPORT_<KIND>_URL`, `LANDFLOW_MAX_CONCURRENCY`), a ConfigMap `landflow-transport-<plugin>` with `LANDFLOW_TRANSPORTS`, and a Secret `landflow-transport` (`LANDFLOW_TRANSPORT_SECRET`, the AMQP URLs) |
| `k8s/overlays/orbstack-brokers` | the OrbStack overlay plus `brokers` and `broker-transports` |
| `k8s/components/gateway-ingress` | optional: a `networking.k8s.io/v1` Ingress pair for the web app (`/`) and the MCP gateway (`/mcp`, `/.well-known/oauth-protected-resource`, port 4000), with the streaming annotations: "Reaching the host from outside" below |
| `k8s/components/gateway-httproute` | optional: the same routes as a Gateway API `HTTPRoute` (use it or `gateway-ingress`, not both) |
| `k8s/components/gateway-landflow-tokens` | optional: sign-in at the gateway sidecar with Landflow-issued MCP tokens (no identity provider): replaces the sidecar's ConfigMap, a template to edit for your URLs |
| `k8s/overlays/orbstack-ingress`, `orbstack-gateway-api` | the OrbStack overlay plus `gateway-ingress` or `gateway-httproute`, and `gateway-landflow-tokens`, for a Traefik in `landflow-ingress` |
| `k8s/components/queue-mode` | optional, on top of `postgres`, `valkey` and `minio`: the host as two mains (`RollingUpdate`, the pod name as `LANDFLOW_INSTANCE_ID`, data in an `emptyDir`), a `landflow-worker` Deployment (`node worker.mjs`, `/healthz` probes, SIGTERM drain), PodDisruptionBudgets for both, and a Secret `landflow-queue` with dev-only values |
| `k8s/components/minio` | optional: MinIO and a bucket-creating start script, for the binary store in queue mode |
| `k8s/overlays/orbstack-queue` | the OrbStack overlay plus `postgres`, `valkey`, `minio` and `queue-mode`: "Queue mode on Kubernetes" below |
| `k8s/examples/keda/` | KEDA `ScaledObject`s per broker, and `queue-workers.yaml` for the queue workers (not in any overlay): "Autoscaling with KEDA" below |
| `k8s/examples/envoy-gateway/` | a `BackendTrafficPolicy` with long timeouts for the HTTPRoute, for Envoy Gateway |
| `k8s/components/observability` | optional: a local telemetry backend (`grafana/otel-lgtm`: Collector, Tempo, Prometheus, Loki, Grafana) as `landflow-lgtm`, OTLP export from every Landflow Deployment to it, and the "Landflow · agent runs" dashboard: "Telemetry on Kubernetes" below |
| `k8s/overlays/orbstack-observability` | the OrbStack overlay plus `observability` |

For another cluster, copy the overlay: set the namespace, the image registry and tags (`images:`), real Secrets
(`landflow-registry` key `secret`; `landflow-host` keys `encryption-key`, `owner-email`, `owner-password`; all optional),
`LANDFLOW_PUBLIC_URL`, and an Ingress for the host (the `gateway-ingress` component). Add `components:` for Postgres and Valkey, or point at external ones.

### Build the images (OrbStack)

OrbStack's cluster runs on the same Docker engine, so images built locally are used as they are: nothing is pushed or
pulled. Build with OrbStack's builder, never the shared `lab-builder` (`docker buildx ls`):

```bash
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/host.Dockerfile -t landflow/host:k8s-dev .
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/go-plugin.Dockerfile \
  --build-arg PLUGIN=go-crypto --build-arg HTTP_PORT=7103 --build-arg GRPC_PORT=7203 -t landflow/plugin-go-crypto:k8s-dev .
# … the same for text-toolkit (node, 7101/7201), py-insights (python, 7102/7202), messaging (node, 7104/7204),
#   productivity (python, 7105/7205), google-workspace (go, 7106/7206), databases (go, 7107/7207)
```

The `:k8s-dev` tag keeps these apart from the Compose stack's `:dev` images.

### Deploy, use, scale

Always name the context: `--context orbstack`.

```bash
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack                    # host + plugins in landflow-dev
kubectl --context orbstack -n landflow-dev rollout status deploy --timeout=180s
kubectl --context orbstack -n landflow-dev get deploy,svc,endpointslices

# plugins only (for a host outside the cluster, below)
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack -l 'app.kubernetes.io/component in (plugin,config)'
```

OrbStack makes Service names and cluster IPs reachable from the Mac, so the host is at
http://landflow-host.landflow-dev.svc.cluster.local:3000 (owner `owner@landflow.test` / `landflow-dev-only`), and
`curl http://plugin-go-crypto.landflow-dev.svc.cluster.local:7103/landflow/v1/health` answers. On other clusters use
`kubectl port-forward svc/landflow-host 3000` or an Ingress. The Plugins page shows each plugin with source
`kubernetes`, `ns/landflow-dev`, and the Service behind each endpoint.

```bash
kubectl --context orbstack -n landflow-dev scale deploy/plugin-go-crypto --replicas=0   # Plugins page: offline, nodes kept
kubectl --context orbstack -n landflow-dev scale deploy/plugin-go-crypto --replicas=3   # online again; the manifest is re-pulled
kubectl --context orbstack -n landflow-dev rollout restart deploy/plugin-go-crypto      # new pods: re-pulled (a new version shows)
```

Several replicas sit behind one Service endpoint (`grpc://plugin-go-crypto.landflow-dev.svc.cluster.local:7203`), but
one HTTP/2 connection would keep every call on one pod. So the host keeps a client per ready pod (from the
EndpointSlices, on the pod IP and the same port) and sends each call (execute, load options, credential tests,
webhooks) to the one with the fewest in flight; the manifest, health and registry proof go through the Service. Pods
that go away are dropped once their calls finish, new ones join at the next EndpointSlice event.
`LANDFLOW_K8S_SPREAD=service` goes back to one connection through the Service (for a mesh that balances gRPC itself, or
when the host can't reach pod IPs). Keep the host at one replica on SQLite.

**Your own plugin**: label its Service `landflow.dev/plugin: "true"`, name the gRPC port `grpc` (or annotate
`landflow.dev/grpc-port`), give the pods a readiness probe on `/landflow/v1/health`, set `LANDFLOW_REGISTRY_URL=off`, and
`LANDFLOW_REGISTRY_SECRET` when the host has one (the SDKs then answer the host's challenge).

### Host settings

| Variable | Default | |
|---|---|---|
| `LANDFLOW_PLUGIN_DISCOVERY` | – | `kubernetes` turns discovery on (the base Deployment sets it) |
| `LANDFLOW_K8S_NAMESPACES` | the host's own namespace | comma-separated; each needs the Role and a RoleBinding to `landflow-host` (copy `rbac.yaml`'s Role and RoleBinding into it, the subject with `namespace:` set). `*`: every namespace, one watch across the cluster; needs the ClusterRole in `k8s/components/cluster-discovery` |
| `LANDFLOW_K8S_SPREAD` | `pods` | `pods`: calls spread over the ready pods; `service`: one connection through the Service |
| `LANDFLOW_K8S_CONTEXT` | – | kubeconfig context for a host outside the cluster; inside a pod the service account is used unless this is set |
| `LANDFLOW_K8S_ADDRESS` | `dns` | `dns`: `<service>.<namespace>.svc.<domain>`; `cluster-ip`: the Service's ClusterIP |
| `LANDFLOW_K8S_CLUSTER_DOMAIN` | `cluster.local` | |
| `LANDFLOW_K8S_LABEL_SELECTOR` | `landflow.dev/plugin=true` | which Services count as plugins |
| `LANDFLOW_K8S_RESYNC_SECONDS` | `300` | full re-list interval (`0`: off) |
| `LANDFLOW_REGISTRY_SECRET` | – | discovered plugins must prove it (protocol §13); set the same value on the plugins |

### The MCP gateway sidecar

The `landflow-host` pod has two containers: `host` and `mcp-gateway` (agentgateway 1.6, the config from the ConfigMap
`landflow-mcp-gateway`). Checked on OrbStack (host image built from the tree, the orbstack overlay applied): the pod is
`2/2` ready; the host's log says `mcp gateway sync started` (`mode: bundled`, admin API `http://127.0.0.1:15000`) and
`mcp gateway targets changed` with the plugins; `GET /api/mcp/gateway` lists every target `in-step`; and
`POST /mcp` through `kubectl port-forward svc/landflow-host 54000:4000` answers `initialize`. The admin API is on the pod's
loopback only: reach it with `kubectl port-forward pod/<host pod> 55000:15000`.

```bash
kubectl --context orbstack -n landflow-dev port-forward svc/landflow-host 54000:4000 53000:3000 &
kubectl --context orbstack -n landflow-dev port-forward pod/$(kubectl --context orbstack -n landflow-dev get pod -l app.kubernetes.io/name=landflow-host -o name | cut -d/ -f2) 55000:15000 &
curl -s -X POST localhost:54000/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
```

### Reaching the host from outside

The `landflow-host` Service has `http` (3000: UI and API) and `mcp` (4000: the gateway sidecar). `components/gateway-ingress` adds two
standard Ingresses on one host: `landflow-web` (`/` → `http`) and `landflow-mcp` (`/mcp` and `/.well-known/oauth-protected-resource`
→ `mcp`). Patch the placeholders in your overlay: `ingressClassName` (`CHANGE-ME-class`), the host (`landflow.example.com`, in
`rules` and `tls`) and the TLS Secret (`landflow-tls`), and set `LANDFLOW_PUBLIC_URL` and `LANDFLOW_MCP_GATEWAY_PUBLIC_URL` on the
host to the public URLs (they appear in OAuth metadata and links). `components/gateway-httproute` is the Gateway API form (Gateway
API v1.2+ CRDs; patch `parentRefs` and `hostnames`; TLS is on the Gateway's listener).

MCP's Streamable HTTP answers a POST with a `text/event-stream` and may hold a stream open for a long time, so whatever fronts the
gateway must not buffer responses, must not cut idle reads quickly, and must pass `Mcp-Session-Id` and `MCP-Protocol-Version`
through (no controller below strips them). The Ingress carries the annotations for ingress-nginx, F5 NGINX and HAProxy Ingress
(`proxy-buffering: off`, read/send timeouts of an hour); Traefik needs none (it flushes `text/event-stream` as it arrives; only a `writeTimeout` set on the entrypoint's
`respondingTimeouts`, unset by default, would cut a long response; the sidecar runs `statefulMode: stateless`, so there is no
standing GET stream to test with, and only the short SSE-framed POST answers were checked); the HTTPRoute sets `timeouts.request: 0s`, and for Envoy Gateway
`examples/envoy-gateway/backendtrafficpolicy.yaml` raises the idle and stream timeouts.

**Which controller.** ingress-nginx was retired by the Kubernetes project in March 2026 (announced November 2025; no more releases,
bug fixes or security patches; existing installs keep running, per the
[January 2026 steering statement](https://www.kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)), so don't start a new cluster on
it. The recommendation: **Traefik** (v3.7, Helm chart 42.x) when you want the least change, because one controller serves both the
`Ingress` and the Gateway API and streaming works without tuning; **Envoy Gateway** when you want to standardise on the Gateway API
(HTTPRoute plus the policy CRDs). Both are checked below (Traefik on OrbStack); no other controller was run.

Checked on OrbStack: Traefik chart 42.0.0 (v3.7.14) in namespace `landflow-ingress` (OrbStack publishes its LoadBalancer Service on the
Mac's localhost: `landflow.localhost` → 127.0.0.1), and `kubectl apply -k deploy/k8s/overlays/orbstack-ingress` into `landflow-dev`:

```bash
helm repo add traefik https://traefik.github.io/charts
helm --kube-context orbstack upgrade --install traefik traefik/traefik --version 42.0.0 -n landflow-ingress --create-namespace \
  --set ingressClass.name=landflow-traefik --set ingressClass.isDefaultClass=false
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-ingress        # namespace landflow-dev; restarts the host pod (new public URLs)
curl -s http://landflow.localhost/api/health/ready
# MCP: a call with no token is anonymous (initialize works, tools/list is empty), same as through a port-forward
curl -s -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' http://landflow.localhost/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The Gateway API form: install the standard CRDs (v1.5.1, which includes `TLSRoute`, which Traefik's provider watches), the chart with
`--set providers.kubernetesGateway.enabled=true --set gateway.listeners.web.namespacePolicy.from=All`, then
`kubectl apply -k deploy/k8s/overlays/orbstack-gateway-api`. Both forms returned the same answers.

**Signing in with a Landflow token.** The sidecar's base config has no sign-in, so a bearer token is ignored and every caller is
anonymous. `components/gateway-landflow-tokens` (in both OrbStack overlays) replaces the ConfigMap with one whose
`mcpAuthentication` (`mode: optional`) checks Landflow-issued tokens against the host's keys on the pod's loopback
(`http://127.0.0.1:3000/api/mcp/jwks`), issuer = the instance URL, audience = `<gateway URL>/mcp`, and sets the same policy on the
per-plugin routes (`LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES`); edit the three URLs in `gateway-config.yaml` for your host. With it: no
token → empty tool list; a bad token → 401 with `WWW-Authenticate: Bearer resource_metadata=…`; a token with a grant → the granted tools
(`POST /api/mcp/tokens`, `POST /api/mcp/grants` with `{"subject":{"kind":"token","id":…},"pluginId":…,"tools":"*"}`) and `tools/call` runs.
The host pod's data is on the `landflow-data` PVC in this overlay, so tokens and grants survive a restart.

### Service Bus entities

The Azure Service Bus emulator has no management API, so every entity must be in `infra/servicebus/Config.json` before it starts.
The drivers need exactly: one request queue per plugin, `landflow.v1.plugin.<pluginId>`; the session-enabled queues
`landflow.v1.instance` and `landflow.v1.reply` (the session id is the channel, so a reply queue per host process is a session, not
an entity); the topic `landflow.v1.broadcast` with 16 session-enabled subscriptions `bc-00`…`bc-15` (registry and control
channels). Only the plugin queues depend on what you run, and nothing is dynamic per client.

```bash
python3 deploy/scripts/servicebus-config.py                              # bundled plugins (+ the conformance suites' queues)
python3 deploy/scripts/servicebus-config.py --plugin my-plugin --plugin transport-bench
python3 deploy/scripts/servicebus-config.py --from-host http://localhost:3000 --cookie-file cookies.txt   # every plugin the host lists
python3 deploy/scripts/servicebus-config.py --check                      # is Config.json what this would write?
COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile servicebus up -d --force-recreate --no-deps servicebus
```

A missing entity fails `declare()` with its name and the fix, e.g. `servicebus: queue "landflow.v1.plugin.my-plugin" does not exist
(the emulator has no management API: run deploy/scripts/servicebus-config.py --plugin my-plugin, then recreate the emulator …)`.
For a real namespace the drivers create the entities themselves through the administration API (TS `ServiceBusAdministrationClient`,
Go `azservicebus/admin`): `createEntities` is on by default when the connection string has no `UseDevelopmentEmulator=true`, can be
set either way in the connection's fields (Settings → Transports "Create missing entities", Go `createentities`), and needs a key
with Manage rights (without it the error names the entity and says so). That path is covered by unit tests with a fake client
library; it has not run against a real namespace (local only).

#### Throttling

The emulator throttles the whole namespace when it is asked for too many operations too fast: the client sees `ServiceBusy` ("The
request was terminated because the namespace sbemulatorns is being throttled. Error code : 50002. Please wait 10 seconds and try
again"), the emulator's own log has the same line, and both client libraries' default retries then sleep 4 to 10 s per attempt. That
is what made eight concurrent callers stall for 7 to 12 s with an empty "reply could not be published" in the first benchmark (T6-C);
it is the emulator, not the drivers' links, senders or sessions (a script with only `@azure/service-bus` and no Landflow code shows
the same: `sendMessages` in a tight loop stalls 31 s about every 1000 messages, 24 parallel sends stalled in 2 of 3 runs). What we
measured against `servicebus-emulator:2.0.1` (SQL Edge 1.0.7), one sender, one session-enabled queue:

| Load | Result |
| --- | --- |
| 25 or 50 messages/s, each sent and completed (50 to 100 operations/s) | clean over 600 to 900 messages |
| 100 messages/s, each sent and completed | throttled every few seconds |
| back-to-back sends (about 400/s) | throttled after about 1000 messages, a 3 to 7 s episode (31 s with the library's retry) |
| a burst of 24 to 64 parallel sends | one stalled send in roughly 1 run of 3 |

Microsoft's documentation lists the emulator's quotas (50 entities, 50 subscriptions per topic, 10 concurrent connections to the
namespace, 200 concurrent receive requests per entity, 256 KB messages, 1 h TTL) and says it is "intended for development and test
scenarios, specifically for sequential testing use cases" ([overview](https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator));
the throttle rate is not documented. The drivers therefore (both TS and Go, same schedule):

- pace their publishes and settlements to **40 operations a second on the emulator** (`maxOpsPerSecond`, Settings → Transports "Max
  operations per second", Go `maxopspersecond`; unlimited on a real namespace; `0` turns it off), so a burst of callers queues for a
  few milliseconds each instead of tripping the throttle;
- retry a throttled, timed-out or dropped publish, session accept and settlement 8 times (200 ms doubling to 2 s, about 11 s) instead
  of the library's 4 to 10 s sleeps, and fail with the entity, the error code and the nested causes (`servicebus: publish to
  landflow.v1.reply.… (session landflow.v1.reply) failed: [ServiceBusy] …`) rather than an empty message.

A call over the emulator is about 40 ms (two peek-locked hops with a SQL write each: 16 ms for a queue message, 21 ms for a session
message in a raw `@azure/service-bus` round trip), and the 40-operation pace caps it near 10 to 20 calls/s. Expect that, not
production numbers; a real namespace has neither.

### Queue mode on Kubernetes

`k8s/overlays/orbstack-queue` runs Landflow in queue mode ([Queue mode, workers and high availability](features/engine.md#queue-mode-workers-and-high-availability)): two mains (`landflow-host`), two workers (`landflow-worker`), Postgres, Valkey and MinIO. Build the images as above (the worker runs the host image), then:

```bash
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-queue
kubectl --context orbstack -n landflow-dev get pods        # 2 host pods (2/2), 2 workers, postgres, valkey, minio
kubectl --context orbstack -n landflow-dev port-forward svc/landflow-host 3000:3000     # Settings → Workers shows the leader and both workers
```

Workers restart two or three times while Postgres starts (they exit when the database isn't reachable yet) and then settle. Deleting a worker pod drains it (SIGTERM, up to `LANDFLOW_WORKER_SHUTDOWN_SECONDS`, 30, inside the 60 s grace period); what doesn't finish continues on the other worker. The PodDisruptionBudgets keep one main and one worker up during node drains. With `external-services` instead of `postgres` and `valkey`, patch `DATABASE_URL` and `LANDFLOW_VALKEY_URL` on `landflow-worker` as well as on the host (the component patches only the host). Checked on OrbStack: both mains and both workers came up, a leader was elected, 24 webhook runs through the Service all succeeded (13 on one worker), and a deleted worker pod exited cleanly on SIGTERM.

To go back to the plain overlay: `kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack`, then delete what only the queue overlay made (`deploy/landflow-worker`, `deploy/minio`, `deploy/valkey`, `statefulset/postgres`, their Services, the `minio-start` ConfigMap, the Secrets `landflow-queue`, `landflow-minio`, `landflow-postgres`, both PodDisruptionBudgets and the `data-postgres-0` PVC).

### Brokers on Kubernetes

`k8s/overlays/orbstack-brokers` is the OrbStack overlay plus Kafka (KRaft), RabbitMQ, NATS with JetStream and Valkey in
`landflow-dev`, and the host and the TypeScript plugins (text-toolkit, messaging) connected to all four. Without it nothing
changes: the base plugin Deployments read their broker settings through `envFrom` on optional ConfigMaps and a Secret, which
only `broker-transports` creates. The environment a plugin gets:

| Variable | From | Meaning |
|---|---|---|
| `LANDFLOW_TRANSPORTS` | ConfigMap `landflow-transport-<plugin>` | faces to start: `http,grpc,kafka,amqp,jetstream,valkey`. Keep `http,grpc` while the plugin is found through its Service; a broker-only plugin lists none of them and needs no Service |
| `LANDFLOW_KAFKA_URL`, `LANDFLOW_AMQP_URL`, `LANDFLOW_JETSTREAM_URL`, `LANDFLOW_VALKEY_URL` | ConfigMap / Secret `landflow-transport` | what a plugin connects to (`LANDFLOW_<KIND>_USERNAME`, `_PASSWORD`, `_TLS`, `_PREFIX` also work) |
| `LANDFLOW_TRANSPORT_SECRET` | Secret `landflow-transport` | the key for end-to-end encryption and signing; the same value on the host and every brokered plugin (development value: replace it) |
| `LANDFLOW_MAX_CONCURRENCY` | ConfigMap `landflow-transport` | calls one replica runs at once (8 here) |

The host gets `LANDFLOW_TRANSPORT_<KIND>_URL` for each broker, one read-only connection `env-<kind>` per URL (Settings →
Transports), and the same secret. Both are patched into the host Deployment by the component.

A container reads `envFrom` only when it starts, so the component also puts an annotation (`landflow.dev/transports`) on
each plugin's pod template: applying the overlay, and going back to `../orbstack`, rolls the plugins and they come up with
(or without) their broker faces. After editing the ConfigMaps or the Secret in place, restart them yourself:
`kubectl --context orbstack -n landflow-dev rollout restart deploy -l app.kubernetes.io/component=plugin`.

```bash
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-brokers
kubectl --context orbstack -n landflow-dev get pods                      # kafka takes about 40 s to become ready
kubectl --context orbstack -n landflow-dev port-forward svc/landflow-host 53000:3000 &
# sign in as the dev owner (owner@landflow.test / landflow-dev-only), then:  GET /api/transports/connections, GET /api/plugins
# (each plugin lists amqp, grpc, jetstream, kafka, valkey); pin a plugin to a kind in a workflow's settings.transports and run it
# Back to no brokers:
kubectl --context orbstack -n landflow-dev delete deploy/kafka deploy/rabbitmq deploy/nats deploy/valkey svc/kafka svc/rabbitmq svc/nats svc/valkey \
  cm/landflow-transport secret/landflow-rabbitmq secret/landflow-transport \
  $(for p in text-toolkit messaging go-crypto google-workspace databases py-insights productivity; do echo cm/landflow-transport-$p; done)
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack
```

**Plugin images for brokers.** Every plugin image carries its SDK's broker drivers ("Plugins and transports" above), so
the stock `:k8s-dev` images run the faces that `broker-transports` names. Each plugin manifest sets `LANDFLOW_MCP=off`: agents
reach the plugin through the host's per-plugin MCP endpoint and the gateway. To give a pod its own `/mcp`, set
`LANDFLOW_MCP=on`, add `mcp` to `LANDFLOW_TRANSPORTS`, and set `LANDFLOW_MCP_TOKEN` from a Secret.

### Autoscaling with KEDA

[KEDA](https://keda.sh) scales a plugin Deployment on the backlog of its request channel, which is the number that
matters for a brokered plugin: CPU says nothing while calls wait in a queue. `k8s/examples/keda/` has one `ScaledObject`
per broker for `plugin-text-toolkit`. They are not in any overlay (KEDA is a cluster add-on; the manifests do not install
it), and one Deployment can have only one `ScaledObject`. Names follow protocol §14.2: the request channel of a plugin is
`landflow.v1.plugin.<pluginId>` (with the connection's prefix, default `landflow`), and its group has the same name.

| Broker | Trigger (`k8s/examples/keda/`) | Names | Metric and target |
|---|---|---|---|
| Kafka | `kafka` (`kafka.yaml`) | `topic` and `consumerGroup`: `landflow.v1.plugin.<id>` | consumer group lag; `lagThreshold` per replica. Replicas past the partition count (6 by default, 3 on the dev broker) sit idle: keep `maxReplicaCount` under it. A share group (`LANDFLOW_KAFKA_MODE=share`) is not visible to this scaler: keep the default group mode there |
| RabbitMQ | `rabbitmq` (`rabbitmq.yaml`), `protocol: amqp`, `mode: QueueLength` | `queueName`: `landflow.v1.plugin.<id>` | messages ready in the quorum queue; `value` per replica. Unacknowledged calls held by replicas (prefetch = `maxConcurrency`) are not counted |
| NATS JetStream | `nats-jetstream` (`jetstream.yaml`), against the monitoring port 8222 | `stream` and `consumer`: the channel with `.` as `_`, `landflow_v1_plugin_<id>`; `account: "$G"` | the consumer's pending messages (`num_pending`); `lagThreshold` per replica. Core `nats` has no backlog to read |
| Valkey / Redis Streams | `redis-streams` (`valkey.yaml`) | `stream` and `consumerGroup`: `landflow.v1.plugin.<id>` (after the connection's key prefix) | pending entries of the group (`pendingEntriesCount`) and its lag (`lagCount`). Pending entries are calls being run, at most `maxConcurrency` per replica; the lag is the backlog behind them |

KEDA runs in its own namespace, so every address in a trigger is the Service's full DNS name
(`nats.landflow-dev.svc.cluster.local:8222`), and the Kafka broker advertises its full name for the same reason. RabbitMQ's
credentials come from a Secret through a `TriggerAuthentication`.

**Numbers.** Set the target per replica to `LANDFLOW_MAX_CONCURRENCY` (8 above): the backlog one replica would still be
working through. A replica runs `maxConcurrency` calls and queues `maxQueue` (default the same) more, refusing the rest with
`capacity`. Auto's spill-over starts when the direct transports have `floor(maxConcurrency x share)` calls in flight per
replica (share 0.8 `balanced`, 1.0 `latency`, 0.6 `throughput`) and sends the rest to a buffering broker, so a backlog
appears when the replicas are at their threshold; more replicas raise that threshold in step, and the replicas the scaler
adds are what drains the backlog. A lower target scales sooner and larger; one far above `maxConcurrency` lets calls wait
for a replica that is already full. `maxReplicaCount` is the limit the broker allows (Kafka: partitions) and the cluster
can carry. Scale-up is limited by the HPA (the examples allow four pods per 15 s) and by how long a pod needs to become
ready; scale-down waits for the stabilization window (30 s in the examples).

**Scaling to zero** (`minReplicaCount: 0`, with `pollingInterval` and `cooldownPeriod`) is only for a **broker-only** plugin:
`LANDFLOW_TRANSPORTS` without `http` and `grpc`, no Service. A plugin that is also served over HTTP or gRPC is found through
its Service, and the host would call an endpoint with no pod behind it. A broker-only plugin at zero is not announced, so
the host sees it offline until the first message wakes a replica: the first call after idle pays the pod start, and the
plugin's manifest hash is unknown until then. Do not use it for interactive plugins.

```bash
kubectl --context orbstack apply -f deploy/k8s/examples/keda/jetstream.yaml     # KEDA must be installed
kubectl --context orbstack -n landflow-dev get scaledobject,hpa
```

Tested on OrbStack with KEDA 2.21.0 (`kubectl apply --server-side -f` the release's `keda-2.21.0.yaml`, installed only for
the test and removed with `kubectl delete -f` of the same file): the JetStream example scaled `plugin-text-toolkit` from 1 to
5 replicas about 15 s after a backlog of roughly 230 pending messages built up, to 6 about 15 s later, and back to 1 after the backlog
drained and the 30 s window passed;
the Kafka, RabbitMQ and Valkey examples were applied one at a time and reported `Ready`.

### A host on the Mac against the cluster

Discovery also runs outside the cluster, from the kubeconfig. With the plugins deployed (above), on a free port and a
throwaway data directory, never the dev server's `:3000`:

```bash
cd apps/web && LANDFLOW_DATA_DIR=$(mktemp -d) LANDFLOW_PLUGIN_DISCOVERY=kubernetes LANDFLOW_K8S_CONTEXT=orbstack \
  LANDFLOW_K8S_NAMESPACES=landflow-dev LANDFLOW_REGISTRY_SECRET=landflow-registry-dev-only LANDFLOW_REGISTRY_GRPC_PORT=off \
  LANDFLOW_SCAN_ON_START=false LANDFLOW_OWNER_EMAIL=owner@landflow.test LANDFLOW_OWNER_PASSWORD=landflow-dev-only \
  npx next dev --port 53100
```

It reaches the plugins by their Service names, which OrbStack resolves on the Mac. Where that does not work (most
clusters), use `LANDFLOW_K8S_ADDRESS=cluster-ip` with a route to the service network, or run the host in the cluster.

### Integration test

`apps/web/test/kubernetes.integration.test.ts` deploys the Go crypto plugin into `landflow-dev` (context `orbstack`;
`LANDFLOW_K8S_IT_CONTEXT`, `LANDFLOW_K8S_IT_NAMESPACE`, `LANDFLOW_K8S_IT_IMAGE` change them) and runs discovery from the
test process: a pod with the wrong registry secret is ready but refused, the right secret (a rollout) gets it discovered
and its node runs over gRPC, scaled to 0 it goes offline, scaled to 1 it runs again, scaled to 2 its calls reach both
pods (the plugin's logs say which pod ran each), and deleting its Service removes it. It labels everything with a run id, watches only that, and deletes it afterwards. It needs the
`landflow/plugin-go-crypto:k8s-dev` image and the namespace.

```bash
kubectl --context orbstack create namespace landflow-dev    # once (or apply the overlay)
(cd apps/web && LANDFLOW_INTEGRATION=k8s npx vitest run test/kubernetes.integration.test.ts)
```

### Telemetry on Kubernetes

```bash
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-observability
kubectl --context orbstack -n landflow-dev rollout status deploy/landflow-lgtm
```

`landflow-lgtm` runs [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm) 0.39.0 (Collector contrib 0.164,
Tempo, Prometheus 3.15, Loki, Grafana 13.3) with OTLP on 4317 (gRPC) and 4318 (HTTP). Every Landflow Deployment gets
`OTEL_EXPORTER_OTLP_ENDPOINT=http://landflow-lgtm:4318` and `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=landflow-dev`,
and the host's `LANDFLOW_TRACE_URL` opens a run's trace in Grafana's Explore. Grafana is at
http://landflow-lgtm.landflow-dev.svc.cluster.local:3000 (OrbStack resolves cluster names on the Mac; a browser that
doesn't, such as Chrome with its own DNS, needs
`kubectl --context orbstack -n landflow-dev port-forward svc/landflow-lgtm 53011:3000` and http://localhost:53011),
signed in as an anonymous Editor, with the data sources `prometheus`, `tempo` and `loki`.

The Collector's config (`otelcol-config.yaml`) is the image's own plus what kagent's runtime needs: `signal_to_metrics`
derives `gen_ai.invoke_agent.duration` from kagent's `invoke_agent` spans and `delta_to_cumulative` turns its delta
histograms into cumulative ones, and `transform/harness_native_genai` drops the duplicate usage attributes of kagent's
native harnesses. The **Landflow · agent runs** dashboard (`agent-runs.json`, the home dashboard) shows runs, tool calls,
remote agent calls, remote tool calls, approvals and tokens; runs by end reason and A2A calls by task state; both sides'
tool calls; latency p95 (runs, tools, A2A calls, kagent's `invoke_agent`); tokens by side; Agent Substrate's restore,
checkpoint and scheduling p95 and its workers; recent agent-run and remote-call traces; and the logs of the host and
kagent's agents. Editing the dashboard's ConfigMap reloads it without a restart.

For development only: storage is an `emptyDir`, so restarting the pod loses every trace, metric and log. Back to the
plain overlay: apply `overlays/orbstack`, then delete Deployment and Service `landflow-lgtm` and the ConfigMaps
`landflow-otelcol-config`, `landflow-grafana-dashboards` and `landflow-grafana-dashboard-provider`.

### kagent next to Landflow

kagent 1.0 and Agent Substrate need Kubernetes 1.37, so they run in a kind cluster (`landflow-kagent`) on the same
OrbStack Docker engine, not in the OrbStack cluster. `deploy/scripts/kagent-up.sh` creates it, installs kagent, bridges
the two clusters both ways, gives Landflow a ServiceAccount that may write agents in kagent's namespace (saved as a
**kagent cluster** credential), and creates the example agent in Landflow and deploys it to kagent from there, so its
persona, model and tools are Landflow's ([a2a.md](a2a.md#landflow-agents-on-kagent)). It also applies a Claude Code
Harness (`landflow-claude`), the package registries agents' sandboxes may reach (`egress-dev.yaml`, named in the
credential's Egress Policies), and sets the credential's plugin registry to the Landflow Service's ClusterIP, where
kagent's nodes pull agents' Claude Code plugins ([a2a.md](a2a.md#on-claude-code)). `deploy/scripts/claude-harness-dev.sh`
then adds `landflow-claude-dev`, Claude Code on an image with the common toolchains, served from Landflow's registry
([a2a.md](a2a.md#a-toolchain-image-for-claude-code)). With the observability overlay
running, kagent and Substrate send their telemetry to `landflow-lgtm`. What it does, the files in `deploy/kind/` and the
endpoints are in [a2a.md](a2a.md#kagent-next-to-landflow). Run it again after the host's data was reset (a new PVC):
the credential and the agent are gone with it.

### Troubleshooting

- **A plugin does not appear.** `kubectl --context orbstack -n landflow-dev get svc -l landflow.dev/plugin=true` lists
  what discovery sees; `get endpointslices -l kubernetes.io/service-name=<service>` must show a ready address. The
  Plugins page's Discovery feed and the host log (`landflow.discovery.source=kubernetes`) say why a Service is skipped
  ("has no gRPC port", "is not a port of Service") or a registration failed.
- **"did not prove the registry secret" / "wrong registry proof".** The plugin lacks `LANDFLOW_REGISTRY_SECRET`, has
  another value, or uses an SDK without registry proofs. Check the `landflow-registry` Secret and both Deployments' env.
- **`forbidden` in the feed** (`services is forbidden: User "system:serviceaccount:…"`): the Role or RoleBinding is
  missing in that namespace, or the pod runs under another ServiceAccount. Discovery retries with backoff.
- **`ErrImageNeverPull`.** The image is not in OrbStack's engine under that tag: build it as above (`docker images 'landflow/*'`).
- **Offline although pods are ready.** The host could not connect: from the host's side, `curl
  http://<service>.<namespace>.svc.cluster.local:<http port>/landflow/v1/health`. From the Mac this needs OrbStack (or
  `kubectl port-forward`); in the cluster, check NetworkPolicies between the host and the plugins.
- **`runAsNonRoot` errors.** The images' users are named, so the manifests set `runAsUser` (1000 for Node images, 10001
  for Python and Go). Keep that when you change images.

Remove everything (the namespace is the overlay's own): `kubectl --context orbstack delete -k deploy/k8s/overlays/orbstack`.

## Stop and reset

These commands only touch the `landflow`, `landflow-queue` and `landflow-infra` projects. Don't use `docker system prune` or the other prune commands on this machine: other projects' containers and volumes live here too.

```bash
# App: stop and remove the containers, keep the data volume
docker compose -f deploy/compose.yml down
# App: also delete its data (workflows, executions, credentials)
docker compose -f deploy/compose.yml down -v

# Queue mode: stop and remove the containers (keep the volume), or also delete the data and the database
docker compose -f deploy/compose.queue.yml down
docker compose -f deploy/compose.queue.yml down -v && docker compose -f deploy/compose.infra.yml exec postgres dropdb -U landflow landflow_queue

# Infra: stop everything, including profiled services, keep the volumes
docker compose -f deploy/compose.infra.yml --profile '*' down
# Infra: also delete Postgres, Valkey, Mailpit, MinIO, Keycloak and MySQL data
docker compose -f deploy/compose.infra.yml --profile '*' down -v

# Images built here
docker image rm $(docker image ls 'landflow/*' -q)
```

If you joined the networks with `compose.infra-link.yml`, pass it to `down` as well, and stop the app and queue stacks before the infra stack (their containers hold the `landflow-infra` network).

## Notes

- **MinIO**: the upstream `minio/minio` images are no longer published, so the stack uses `pgsty/minio`, a maintained community build of the same server with the full console. The bucket is created by the server container itself (`infra/minio/start.sh`) on every start.
- **OpenBao** runs in dev mode: in memory and unsealed. Secrets are gone after a restart; `infra/openbao/dev.sh` re-creates the `landflow/` mount and the sample secret each time.
- **Jaeger** stores traces in memory.
- **Mailpit** stands in for MailHog: same SMTP and web UI roles, native arm64, and its store survives restarts.
- **Vector** (profile `siem`) receives Landflow's audit log streaming (Settings → Audit log → SIEM streaming: Syslog to `siem:5514` or `localhost:55514`, or HTTP JSON lines to `http://siem:8080/`) and prints each event as JSON: `docker compose -f deploy/compose.infra.yml logs -f siem`. It also appends them to `/var/lib/vector/audit-<date>.log` in the `siem-data` volume. Config: `infra/vector/vector.yaml`.
- **OpenSSH + git** (profile `git`, `git-ssh` service) is a Git server for trying Settings → Source control over SSH with a *SSH private key* credential, and for the live SSH test. Run `deploy/infra/git/gen-keys.sh` once (it writes dev-only keys to `infra/git/keys/`, none of them used anywhere else), then `docker compose -f deploy/compose.infra.yml --profile git up -d --wait git-ssh`. Create a bare repository in it with `docker exec landflow-infra-git-ssh-1 sh -c 'git init --bare /srv/git/demo.git && chown -R git /srv/git'`, make a *SSH private key* credential from `infra/git/keys/id_ed25519` (or the passphrase key), set the repository to `ssh://git@127.0.0.1:52222/srv/git/demo.git`, press **Fetch host key** and **Pin these keys** (the server's host key is generated at first start and kept in the `git-ssh-host` volume), then Push. `LANDFLOW_INTEGRATION=git-ssh npx vitest run test/source-control-git.test.ts` (in `apps/web`) runs a push with the credential's key, the refusal of a changed host key and a passphrase key against it. The server only listens on `127.0.0.1`.
- **LocalStack** (profile `aws`) stands in for AWS Secrets Manager: Settings → External secrets → AWS Secrets Manager with the endpoint `http://localhost:54566` (or `http://localstack:4566` from the app stack) and dummy access keys. `LANDFLOW_INTEGRATION=aws npx vitest run test/secrets-aws.integration.test.ts` (in `apps/web`) runs the provider against it with the shared AWS config and credentials files turned off. Secrets are gone after a restart.
- **GreenMail** is there because Mailpit has no IMAP: it is the mailbox the Email Trigger (IMAP) reads. Mail sent to its SMTP port lands in its own mailboxes, not in Mailpit.
- Keycloak's realm is imported only when the realm doesn't exist yet. After editing `infra/keycloak/landflow-realm.json`, run `down -v` on the infra stack (or delete the realm in the admin console) and start it again.

## Behind a reverse proxy or ingress

Set `LANDFLOW_TRUSTED_PROXIES` to the number of proxies between the client and the host (an ingress controller behind a
cloud load balancer is 2). The host then takes the client address from `X-Forwarded-For` that many entries from the end
and builds its own origin from `X-Forwarded-Host`/`-Proto`; with the default 0 it sees every request as coming from the
proxy's address (one shared sign-in limit) and ignores those headers. Also set `LANDFLOW_PUBLIC_URL`: invite and reset
emails refuse to go out in the production profile without it. Resume URLs are signed in production
(`LANDFLOW_RESUME_SIGNATURES`, see [engine](features/engine.md)).

## Security headers and Content Security Policy

`apps/web/src/proxy.ts` sets these on every response it produces (pages, API routes, 401s and redirects;
`X-Frame-Options` except on the embeddable paths below): `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), geolocation=(), microphone=(self)` (Spotlight
dictation uses the microphone) and `X-Frame-Options: DENY`. `Strict-Transport-Security: max-age=31536000;
includeSubDomains` is added when the request is https (the URL, or `X-Forwarded-Proto`) unless `LANDFLOW_HSTS=off`.
`x-powered-by` is not sent.

Pages (not API routes) also get a Content Security Policy with a fresh nonce per request: `script-src 'self' 'nonce-…'
'strict-dynamic'` (plus `'unsafe-eval'` under `next dev`), inline styles, `img-src 'self' data: blob: https:` (notes,
chat and plugin icons show remote images), `connect-src 'self'`, `frame-src 'self' blob: data: https:`, `worker-src
'self' blob:`, `object-src 'self' data: https:` (the Run Trace shows a PDF artifact in an `<object>`, which Chrome also
checks against `frame-src`), `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'`. `LANDFLOW_CSP` picks
the mode: `enforce` (default in the production profile), `report` (`Content-Security-Policy-Report-Only`, default in
development) or `off`. If a page breaks in production, set `LANDFLOW_CSP=report` and read the console for the blocked
source.

The embeddable or self-policed paths (`/chat`, `/form`, `/form-test`, `/api/binary`, `/api/mcp/files`, `/mcp`,
`/mcp-test`, `/api/webhook`, `/api/webhook-test`) keep their own policy and get no frame headers or CSP from the
proxy, only the three fixed headers above. A reverse proxy that serves the host over https should forward
`X-Forwarded-Proto`.

Any inline `<script>` in a page must carry the nonce: the root layout reads it from the `x-nonce` request header the
proxy sets and passes `nonce={nonce}` to its theme and look scripts. Without it the browser blocks the script.
