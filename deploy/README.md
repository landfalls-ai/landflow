# Landflow on Docker

Two independent Compose projects:

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](compose.infra.yml) | Development and test services: Postgres 16 + pgvector, Valkey, Mailpit, MinIO, OpenBao; Keycloak (profile `auth`), Jaeger (profile `observability`), MySQL 8.4 (profile `mysql`) |
| `landflow` | [`compose.yml`](compose.yml) | Landflow itself as images: the host (Next.js standalone) and the seven plugins, which announce themselves to the host |

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

# App: build the images and start the host + 7 plugins on http://localhost:53000
COMPOSE_BAKE=false docker compose -f deploy/compose.yml up -d --build --wait

# Both, with the app joined to the infra network and sending traces to Jaeger
docker compose -f deploy/compose.infra.yml --profile observability up -d --wait
LANDFLOW_OTLP_ENDPOINT=http://jaeger:4318 COMPOSE_BAKE=false \
  docker compose -f deploy/compose.yml -f deploy/compose.infra-link.yml up -d --build --wait

# Check everything that is running
deploy/scripts/smoke.sh          # or: smoke.sh infra | smoke.sh app
```

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
| — test users | | | `alice` / `alice-test-only` (role `landflow-admin`), `bob` / `bob-test-only` (role `landflow-editor`) |
| Jaeger 2 UI (`observability`) | http://localhost:56686 | `jaeger:16686` | none |
| Jaeger OTLP | HTTP `localhost:54318`, gRPC `localhost:54317` | `jaeger:4318`, `jaeger:4317` | none |
| MySQL 8.4 (`mysql`) | `localhost:53306` | `mysql:3306` | `landflow` / `landflow-dev-only` (database `landflow_test`), root / `landflow-root-dev-only` |
| **Landflow host** (app) | http://localhost:53000 | `web:3000`, gRPC registry `web:7070` | none (no auth yet) |
| Plugins (app) | not published | `text-toolkit:7101/7201`, `py-insights:7102/7202`, `go-crypto:7103/7203`, `messaging:7104/7204`, `productivity:7105/7205`, `google-workspace:7106/7206`, `databases:7107/7207` (HTTP/gRPC) | |

"In-network" addresses work from containers on the `landflow-infra` network (the app stack with `compose.infra-link.yml`). Containers without it reach the infra through the Mac: `host.docker.internal:<Mac port>`.

Keycloak details: redirect URIs `http://localhost:3000/api/auth/oidc/callback` and `http://localhost:53000/api/auth/oidc/callback` (and their `127.0.0.1` forms); the ID and access tokens carry the realm roles in a `roles` claim. The issuer is always `http://localhost:58080/realms/landflow` (`KC_HOSTNAME`), while the backchannel endpoints follow the request host, so a container can fetch tokens and JWKS from `http://keycloak:8080`. Direct access grants are on so scripts can log in a test user:

```bash
curl -s -d grant_type=password -d client_id=landflow -d client_secret=landflow-dev-client-secret \
  -d username=alice -d password=alice-test-only -d scope=openid \
  http://localhost:58080/realms/landflow/protocol/openid-connect/token
```

## Using the infra from the dev server on the host

Landflow reads only the observability variables today; set them before `pnpm dev` / `pnpm dev:all`:

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

From the dockerised host use `postgres` / `5432`, `valkey` / `6379`, `mysql` / `3306`, `mailpit` / `1025` with `compose.infra-link.yml`, or `host.docker.internal` with the Mac ports without it.

For the upcoming Postgres store, queue mode, object storage, secrets and SSO work (Landflow does not read these yet), the conventional settings are:

```bash
DATABASE_URL=postgres://landflow:landflow-dev-only@localhost:55432/landflow
REDIS_URL=redis://localhost:56379/0
S3_ENDPOINT=http://localhost:59000 S3_BUCKET=landflow AWS_ACCESS_KEY_ID=landflow AWS_SECRET_ACCESS_KEY=landflow-dev-only AWS_REGION=us-east-1
BAO_ADDR=http://localhost:58200 BAO_TOKEN=landflow-dev-root-token   # also VAULT_ADDR / VAULT_TOKEN
OIDC_ISSUER=http://localhost:58080/realms/landflow OIDC_CLIENT_ID=landflow OIDC_CLIENT_SECRET=landflow-dev-client-secret
```

## The app stack

| Image | Built from | Runs |
|---|---|---|
| `landflow/host:dev` | [`docker/host.Dockerfile`](docker/host.Dockerfile) | `node apps/web/server.js` (Next standalone output) as `node` (uid 1000), data in `/data` |
| `landflow/plugin-text-toolkit:dev`, `landflow/plugin-messaging:dev` | [`docker/node-plugin.Dockerfile`](docker/node-plugin.Dockerfile) | `tsx src/main.ts` as `node` |
| `landflow/plugin-py-insights:dev`, `landflow/plugin-productivity:dev` | [`docker/python-plugin.Dockerfile`](docker/python-plugin.Dockerfile) | `python main.py` (SDK with `grpc` and `otel` extras) as uid 10001 |
| `landflow/plugin-go-crypto:dev`, `landflow/plugin-google-workspace:dev`, `landflow/plugin-databases:dev` | [`docker/go-plugin.Dockerfile`](docker/go-plugin.Dockerfile) | static binary on Alpine as uid 10001 |

All builds use the repository root as context; [`/.dockerignore`](../.dockerignore) keeps out `node_modules`, `.next`, `.data`, venvs and Go binaries. Every image has a healthcheck: the host's `GET /api/health`, each plugin's `GET /landflow/v1/health`. Build one image on its own with, for example:

```bash
docker build -f deploy/docker/go-plugin.Dockerfile --build-arg PLUGIN=databases \
  --build-arg HTTP_PORT=7107 --build-arg GRPC_PORT=7207 -t landflow/plugin-databases:dev .
```

**Host.** `apps/web/next.config.ts` switches to `output: 'standalone'` when `LANDFLOW_NEXT_OUTPUT=standalone`, which only the image build sets. Workflows, executions, agents and the credentials vault live in the `landflow_landflow-data` volume (`LANDFLOW_DATA_DIR=/data`). `LANDFLOW_ENCRYPTION_KEY` (64 hex characters or a passphrase) comes from the environment; left empty, the vault generates `/data/encryption.key` on first use. Changing the key later makes saved credentials unreadable. `LANDFLOW_PUBLIC_URL` is `http://localhost:53000` so links the host hands out point at the published port. `OLLAMA_URL` points at Ollama on the Mac (`host.docker.internal:11434`).

**Plugins.** Each container sets `LANDFLOW_REGISTRY_URL=http://web:3000` and `LANDFLOW_ADVERTISE_HOST=<service name>`, so it announces `http://<service>:<port>` and `grpc://<service>:<port>` and heartbeats every 10 s. Stopping a container withdraws it at once; restarting the host is picked up on the next heartbeat. The host's scan (`LANDFLOW_SCAN_HOSTS`, `LANDFLOW_SCAN_PORTS`) probes the plugin services too, so the Plugins page's "Scan network" works in Docker.

**Mixing Docker and the Mac.** A plugin running on the Mac can join the dockerised host if it advertises an address the container can reach:

```bash
LANDFLOW_REGISTRY_URL=http://localhost:53000 LANDFLOW_ADVERTISE_HOST=host.docker.internal \
  LANDFLOW_HTTP_PORT=7151 LANDFLOW_GRPC_PORT=7251 pnpm plugin:ts
```

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

## Stop and reset

These commands only touch the `landflow` and `landflow-infra` projects. Don't use `docker system prune` or the other prune commands on this machine: other projects' containers and volumes live here too.

```bash
# App: stop and remove the containers, keep the data volume
docker compose -f deploy/compose.yml down
# App: also delete its data (workflows, executions, credentials)
docker compose -f deploy/compose.yml down -v

# Infra: stop everything, including profiled services, keep the volumes
docker compose -f deploy/compose.infra.yml --profile '*' down
# Infra: also delete Postgres, Valkey, Mailpit, MinIO, Keycloak and MySQL data
docker compose -f deploy/compose.infra.yml --profile '*' down -v

# Images built here
docker image rm $(docker image ls 'landflow/*' -q)
```

If you joined the networks with `compose.infra-link.yml`, pass it to `down` as well, and stop the app stack before the infra stack (the app containers hold the `landflow-infra` network).

## Notes

- **MinIO**: the upstream `minio/minio` images are no longer published, so the stack uses `pgsty/minio`, a maintained community build of the same server with the full console. The bucket is created by the server container itself (`infra/minio/start.sh`) on every start.
- **OpenBao** runs in dev mode: in memory and unsealed. Secrets are gone after a restart; `infra/openbao/dev.sh` re-creates the `landflow/` mount and the sample secret each time.
- **Jaeger** stores traces in memory.
- **Mailpit** stands in for MailHog: same SMTP and web UI roles, native arm64, and its store survives restarts.
- Keycloak's realm is imported only when the realm doesn't exist yet. After editing `infra/keycloak/landflow-realm.json`, run `down -v` on the infra stack (or delete the realm in the admin console) and start it again.
