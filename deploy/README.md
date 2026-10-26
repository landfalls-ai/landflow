# Landflow on Docker

Two independent Compose projects:

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](compose.infra.yml) | Development and test services: Postgres 16 + pgvector, Valkey, Mailpit, MinIO, OpenBao; Keycloak (profile `auth`), Jaeger (profile `observability`), MySQL 8.4 (profile `mysql`), GreenMail (profile `mail`), Vector as a SIEM receiver (profile `siem`), LocalStack for AWS Secrets Manager (profile `aws`) |
| `landflow` | [`compose.yml`](compose.yml) | Landflow itself as images: the host (Next.js standalone), the seven plugins, which announce themselves to the host, and the sandboxed [code runner](#code-runner) for the Code node |
| `landflow-queue` | [`compose.queue.yml`](compose.queue.yml) | Landflow in [queue mode with high availability](#queue-mode-two-mains-two-workers): two mains behind a load balancer and two workers, on the infra stack's Postgres, Valkey and MinIO |

Kubernetes manifests are in [`k8s/`](k8s): see [Kubernetes](#kubernetes) (tested on OrbStack's local cluster).

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
| LocalStack 4.9 (`aws`) | http://localhost:54566 | `localstack:4566` | any access key (use dummy ones, e.g. `test` / `test`), region `us-east-1`; Secrets Manager only, in memory |
| **Landflow host** (app) | http://localhost:53000 | `web:3000`, gRPC registry `web:7070` | owner `owner@landflow.test` / `landflow-dev-only` (`LANDFLOW_OWNER_EMAIL` / `LANDFLOW_OWNER_PASSWORD`) |
| Plugins (app) | not published | `text-toolkit:7101/7201`, `py-insights:7102/7202`, `go-crypto:7103/7203`, `messaging:7104/7204`, `productivity:7105/7205`, `google-workspace:7106/7206`, `databases:7107/7207` (HTTP/gRPC) | |
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

The host's store uses Postgres with `LANDFLOW_DB=postgres` and `DATABASE_URL` (one host per database; see the README's Durable runtime section). For queue mode and secrets (Landflow does not read these yet), the conventional settings are:

```bash
LANDFLOW_DB=postgres DATABASE_URL=postgres://landflow:landflow-dev-only@localhost:55432/landflow
REDIS_URL=redis://localhost:56379/0
S3_ENDPOINT=http://localhost:59000 S3_BUCKET=landflow AWS_ACCESS_KEY_ID=landflow AWS_SECRET_ACCESS_KEY=landflow-dev-only AWS_REGION=us-east-1
BAO_ADDR=http://localhost:58200 BAO_TOKEN=landflow-dev-root-token   # also VAULT_ADDR / VAULT_TOKEN
```

## Sign-in, email and SSO

Landflow needs a signed-in user (README "Authentication"). A fresh data directory opens on `/setup`; to skip it, start the host with an owner:

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
| `landflow/host:dev` | [`docker/host.Dockerfile`](docker/host.Dockerfile) | `node apps/web/server.js` (Next standalone output) as `node` (uid 1000), data in `/data`; queue-mode workers run `node worker.mjs` (an esbuild bundle of `pnpm worker`) from the same image |
| `landflow/plugin-text-toolkit:dev`, `landflow/plugin-messaging:dev` | [`docker/node-plugin.Dockerfile`](docker/node-plugin.Dockerfile) | `tsx src/main.ts` as `node` |
| `landflow/plugin-py-insights:dev`, `landflow/plugin-productivity:dev` | [`docker/python-plugin.Dockerfile`](docker/python-plugin.Dockerfile) | `python main.py` (SDK with `grpc` and `otel` extras) as uid 10001 |
| `landflow/plugin-go-crypto:dev`, `landflow/plugin-google-workspace:dev`, `landflow/plugin-databases:dev` | [`docker/go-plugin.Dockerfile`](docker/go-plugin.Dockerfile) | static binary on Alpine as uid 10001 |
| `landflow/code-runner:dev` | [`docker/code-runner.Dockerfile`](docker/code-runner.Dockerfile) | `node dist/main.mjs` (esbuild bundle) on Node 26 + CPython 3 (standard library) as uid 10001; `code-runner-port` runs `node dist/forward.mjs` from the same image |

All builds use the repository root as context; [`/.dockerignore`](../.dockerignore) keeps out `node_modules`, `.next`, `.data`, venvs and Go binaries. Every image has a healthcheck: the host's `GET /api/health`, each plugin's `GET /landflow/v1/health`. Build one image on its own with, for example:

```bash
docker build -f deploy/docker/go-plugin.Dockerfile --build-arg PLUGIN=databases \
  --build-arg HTTP_PORT=7107 --build-arg GRPC_PORT=7207 -t landflow/plugin-databases:dev .
```

**Host.** `apps/web/next.config.ts` switches to `output: 'standalone'` when `LANDFLOW_NEXT_OUTPUT=standalone`, which only the image build sets. Workflows, executions, agents and the credentials vault live in the `landflow_landflow-data` volume (`LANDFLOW_DATA_DIR=/data`). `LANDFLOW_ENCRYPTION_KEY` (64 hex characters or a passphrase) comes from the environment; left empty, the vault generates `/data/encryption.key` on first use. Changing the key later makes saved credentials unreadable. `LANDFLOW_PUBLIC_URL` is `http://localhost:53000` so links the host hands out point at the published port. `OLLAMA_URL` points at Ollama on the Mac (`host.docker.internal:11434`).

**Plugins.** Each container sets `LANDFLOW_REGISTRY_URL=http://web:3000` and `LANDFLOW_ADVERTISE_HOST=<service name>`, so it announces `http://<service>:<port>` and `grpc://<service>:<port>` and heartbeats every 10 s. With `LANDFLOW_REGISTRY_SECRET` set on the host, add the same value to `x-plugin-env` so they may register. Stopping a container withdraws it at once; restarting the host is picked up on the next heartbeat. The host's scan (`LANDFLOW_SCAN_HOSTS`, `LANDFLOW_SCAN_PORTS`) probes the plugin services too, so the Plugins page's "Scan network" works in Docker.

**Mixing Docker and the Mac.** A plugin running on the Mac can join the dockerised host if it advertises an address the container can reach:

```bash
LANDFLOW_REGISTRY_URL=http://localhost:53000 LANDFLOW_ADVERTISE_HOST=host.docker.internal \
  LANDFLOW_HTTP_PORT=7151 LANDFLOW_GRPC_PORT=7251 pnpm plugin:ts
```

## Queue mode (two mains, two workers)

[`compose.queue.yml`](compose.queue.yml) (project `landflow-queue`) runs Landflow in queue mode with high availability (README, "Queue mode, workers and high availability") on the infra stack's Postgres, Valkey and MinIO. One image runs everything: the mains run `node server.js`, the workers `node worker.mjs`.

```bash
docker compose -f deploy/compose.infra.yml up -d --wait
docker compose -f deploy/compose.infra.yml exec postgres createdb -U landflow landflow_queue   # once
COMPOSE_BAKE=false docker compose -f deploy/compose.queue.yml up -d --build --wait              # http://localhost:53080
python3 deploy/scripts/queue-e2e.py      # load spread, a killed worker, a killed leader: about 3 minutes
```

| Service | On the Mac | |
|---|---|---|
| `lb` | http://localhost:53080 | round robin over the mains, skipping one that is down for 5 s; a browser sticks to one main (cookie `landflow_main`; the `x-landflow-main` header says which one answered). A stand-in for your load balancer: [`queue/lb.mjs`](queue/lb.mjs) |
| `main-1`, `main-2` | http://localhost:53081, http://localhost:53082 | UI, API, webhooks. `main-1` creates the owner (`owner@landflow.test` / `landflow-dev-only`); `main-2` and the workers start once it is healthy |
| `worker-1`, `worker-2` | http://localhost:55691/healthz, http://localhost:55692/healthz (`/metrics` too) | 10 runs at once each (`LANDFLOW_WORKER_CONCURRENCY`) |
| `text-toolkit` | not published | registers through the load balancer; the mains keep its address in Postgres and the workers call it directly |

Every process shares the database `landflow_queue` (`LANDFLOW_QUEUE_DATABASE`), the Valkey key prefix `landflow-queue`, the `landflow-queue_landflow-queue-data` volume at `/data` (agent files, one insights rollup per process; credentials and settings files are in the database, imported once from `/data` on the first start: `LANDFLOW_CONFIG_STORE`), the encryption key and file-link secret (development values; `LANDFLOW_QUEUE_ENCRYPTION_KEY`, `LANDFLOW_QUEUE_BINARY_SECRET`) and the binary store: MinIO's `landflow` bucket under `queue/`, with the endpoint (`http://minio:9000`) and keys set explicitly, so the AWS default credential chain is never used. Traces: `LANDFLOW_QUEUE_OTLP_ENDPOINT=http://jaeger:4318` (with the `observability` profile); a run's trace goes from the main that took the webhook to the worker that ran it.

What `queue-e2e.py` checks, and what it measured on OrbStack:

- **load**: 40 concurrent webhook calls through the load balancer, each through the text-toolkit plugin: all answered in 0.3 to 0.4 s, split 17 / 23 and 18 / 22 between the workers.
- **worker**: a run waits 20 s in a Wait node and its worker is killed (SIGKILL). The other worker claims the job once it has been idle for 30 s and continues the run from the checkpoint before the Wait: finished about 55 s after the kill, tagged **Resumed after restart**.
- **leader**: a schedule fires every 5 s and the leader main is killed. The other main leads 8.5 to 11 s later (fencing token + 1) and the schedule goes on (a 10 s gap: the slot due during the failover runs once, late); the killed main comes back as a follower.

**Valkey Sentinel**: [`compose.sentinel.yml`](compose.sentinel.yml) (project `landflow-sentinel`, on the infra network) runs a primary (56381), a replica (56382) and three sentinels (56391–56393, master name `mymaster`), on tmpfs. Point the queue stack at it, and kill the primary to watch a failover (the sentinels promote the replica within about 5 s; the old primary rejoins as a replica when it comes back):

```bash
docker compose -f deploy/compose.sentinel.yml up -d --wait
LANDFLOW_QUEUE_VALKEY_SENTINELS=valkey-sentinel-1:26379,valkey-sentinel-2:26379,valkey-sentinel-3:26379 \
  COMPOSE_BAKE=false docker compose -f deploy/compose.queue.yml up -d --wait
docker compose -f deploy/compose.sentinel.yml kill valkey-primary      # then: start valkey-primary
(cd apps/web && LANDFLOW_INTEGRATION=sentinel npx vitest run test/valkey-sentinel.integration.test.ts)
```

Valkey Cluster is not supported: the queue's stream and the multi-key Lua scripts would need one hash tag, so one node anyway (README, "Why not Valkey Cluster").

**Marketplace node plugins** install on either main and run in every main and worker (each its own child process). The containers have no `/app/packages`, so a plugin needing `@landflow/sdk` links can't be prepared there; plain JavaScript, Python and Go plugins can. A local marketplace path needs `LANDFLOW_QUEUE_MARKETPLACE_ALLOW_LOCAL=1` at `up` time.

Day to day: **Settings → Workers** on either main shows the leader, the queue and every process; `docker compose -f deploy/compose.queue.yml stop worker-1` sends SIGTERM (runs get 30 s, `stop_grace_period` is 40 s, and what doesn't finish continues on the other worker); `stop main-1` on the leader hands the leadership over within about 3 s. To add a worker, copy `worker-2` with its own `LANDFLOW_INSTANCE_ID` and port. Valkey keys: `docker compose -f deploy/compose.infra.yml exec valkey valkey-cli --scan --pattern 'landflow-queue:*'`.

## Code runner

The Code node runs JavaScript in-process (`node:vm` inside the host: quick, but not isolated) or in the **code runner** ([`services/code-runner`](../services/code-runner)), which also runs Python. Every snippet gets a fresh child process (Node for JavaScript, CPython with the standard library only for Python) with an empty environment and its own temporary work directory, deleted afterwards. The host posts the items, the outputs of the nodes the snippet names (`$('Node')`, `_('Node')`), `$vars` and the execution and workflow data to `POST /v1/run` with the shared secret in `x-landflow-runner-secret`; it gets back the items, the `console.log`/`print` output and errors with line numbers (`TypeError: … [line 3, for item 0]`). `GET /health` needs no secret; `GET /v1/info` shows versions, limits and the isolation the runner found.

| Host setting | |
|---|---|
| `LANDFLOW_CODE_RUNNER_URL` | `http://code-runner:7300` in compose (set already), `http://127.0.0.1:53300` for the Docker runner from the dev server, `http://127.0.0.1:7300` for one started with pnpm |
| `LANDFLOW_CODE_RUNNER_SECRET` | the runner's `CODE_RUNNER_SECRET` (compose: `LANDFLOW_CODE_RUNNER_SECRET`, default `landflow-code-runner-dev-only`) |
| `LANDFLOW_CODE_IN_PROCESS` | `false`: no in-process JavaScript on this host, so every Code node needs the runner. The dockerised host sets it |

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

**Check the isolation.** `deploy/scripts/smoke.sh code` checks the runner's health and runs [`scripts/code-runner-isolation.mjs`](scripts/code-runner-isolation.mjs), which sends snippets through the published port that try to reach the internet (TCP, DNS, HTTPS), the Mac (`host.docker.internal`) and the Docker host's side of the bridge, and to write to `/app`, `/etc`, `/` and outside the work directory. Every line shows the error that stopped the attempt; the script exits 1 if one gets through. To see what the container stops on its own, start the runner with its guards off (diagnostics only, never for real use) through an override file and run the script again; expect `ENETUNREACH`, DNS `EAI_AGAIN` and `EROFS`:

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

`apps/web/test/email-imap.test.ts` (the node: baseline, mark read, move, manual runs, IDLE) and `test/email-imap-host.test.ts` (a published workflow polled by the host, attachments in the run's binary scope, IDLE starting a run) run against GreenMail. They are skipped unless `LANDFLOW_INTEGRATION` includes `imap`.

```bash
docker compose -f deploy/compose.infra.yml --profile mail up -d --wait greenmail
(cd apps/web && LANDFLOW_INTEGRATION=imap npx vitest run test/email-imap.test.ts test/email-imap-host.test.ts)
```

Each test file uses a fresh mailbox (`<name>-<time>@landflow.test`), delivered over GreenMail's SMTP port. `LANDFLOW_GREENMAIL_HOST`, `LANDFLOW_GREENMAIL_IMAP_PORT` and `LANDFLOW_GREENMAIL_SMTP_PORT` point the tests (and the compose ports) elsewhere. GreenMail keeps mail in memory, so a restart empties it.

## Kubernetes

[`k8s/`](k8s) runs the host and the seven plugins on Kubernetes, with the host finding the plugins through
**Kubernetes discovery** instead of announcements ([protocol §13](../docs/protocol.md#13-kubernetes-discovery-and-registry-proofs)).
It is plain [kustomize](https://kustomize.io), built into `kubectl` (`apply -k`): no extra tool, plain YAML to read and
diff, and overlays for the differences between clusters. A Helm chart would add templating Landflow does not need yet.

| Path | What |
|---|---|
| `k8s/base/host/` | `landflow-host` Deployment (one replica, `Recreate`: SQLite in `/data`), its Service (`3000`, gRPC registry `7070`), a 5 Gi PVC, and RBAC: a ServiceAccount with a **Role** (not a ClusterRole) allowing `get`/`list`/`watch` on `services` and `endpointslices` in its own namespace |
| `k8s/base/plugins/` | a Deployment and a Service per plugin: Service label `landflow.dev/plugin: "true"`, annotation `landflow.dev/grpc-port: grpc`, readiness on `GET /landflow/v1/health`, `LANDFLOW_REGISTRY_URL=off`, non-root with a read-only root filesystem |
| `k8s/components/postgres` | optional: Postgres 16 + pgvector (StatefulSet), and the host on it (`LANDFLOW_DB=postgres`, `DATABASE_URL`) |
| `k8s/components/valkey` | optional: Valkey 8 and `LANDFLOW_VALKEY_URL` for queue mode |
| `k8s/components/external-services` | optional: Postgres and Valkey elsewhere, from a Secret `landflow-external` you create (`database-url`, `valkey-url`) |
| `k8s/components/cluster-discovery` | optional: discovery in every namespace: a **ClusterRole** (`get`/`list`/`watch` on `services` and `endpointslices`, nothing else) bound to `landflow-host`, and `LANDFLOW_K8S_NAMESPACES=*` |
| `k8s/overlays/orbstack` | OrbStack: namespace `landflow-dev`, the local `:k8s-dev` images with `imagePullPolicy: Never`, an `emptyDir` instead of the PVC, dev-only Secrets (`landflow-registry`, `landflow-host` with the owner) |
| `k8s/overlays/orbstack-cluster-wide` | the OrbStack overlay plus `cluster-discovery` |

For another cluster, copy the overlay: set the namespace, the image registry and tags (`images:`), real Secrets
(`landflow-registry` key `secret`; `landflow-host` keys `encryption-key`, `owner-email`, `owner-password`; all optional),
`LANDFLOW_PUBLIC_URL`, and an Ingress for the host. Add `components:` for Postgres and Valkey, or point at external ones.

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
- **LocalStack** (profile `aws`) stands in for AWS Secrets Manager: Settings → External secrets → AWS Secrets Manager with the endpoint `http://localhost:54566` (or `http://localstack:4566` from the app stack) and dummy access keys. `LANDFLOW_INTEGRATION=aws npx vitest run test/secrets-aws.integration.test.ts` (in `apps/web`) runs the provider against it with the shared AWS config and credentials files turned off. Secrets are gone after a restart.
- **GreenMail** is there because Mailpit has no IMAP: it is the mailbox the Email Trigger (IMAP) reads. Mail sent to its SMTP port lands in its own mailboxes, not in Mailpit.
- Keycloak's realm is imported only when the realm doesn't exist yet. After editing `infra/keycloak/landflow-realm.json`, run `down -v` on the infra stack (or delete the realm in the admin console) and start it again.
