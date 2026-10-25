# Landflow on Docker

Two independent Compose projects:

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](compose.infra.yml) | Development and test services: Postgres 16 + pgvector, Valkey, Mailpit, MinIO, OpenBao; Keycloak (profile `auth`), Jaeger (profile `observability`), MySQL 8.4 (profile `mysql`), GreenMail (profile `mail`) |
| `landflow` | [`compose.yml`](compose.yml) | Landflow itself as images: the host (Next.js standalone), the seven plugins, which announce themselves to the host, and the sandboxed [code runner](#code-runner) for the Code node |

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
| GreenMail 2.1 IMAP (`mail`) | `localhost:53143` | `greenmail:3143` | any user and password (the mailbox is created at first login), no TLS |
| GreenMail 2.1 SMTP (`mail`) | `localhost:53025` | `greenmail:3025` | none; delivers to GreenMail's own mailboxes |
| **Landflow host** (app) | http://localhost:53000 | `web:3000`, gRPC registry `web:7070` | owner `owner@landflow.test` / `landflow-dev-only` (`LANDFLOW_OWNER_EMAIL` / `LANDFLOW_OWNER_PASSWORD`) |
| Plugins (app) | not published | `text-toolkit:7101/7201`, `py-insights:7102/7202`, `go-crypto:7103/7203`, `messaging:7104/7204`, `productivity:7105/7205`, `google-workspace:7106/7206`, `databases:7107/7207` (HTTP/gRPC) | |
| Code runner (app) | http://127.0.0.1:53300 (through `code-runner-port`) | `code-runner:7300`, on the internal `landflow-code` network only | header `x-landflow-runner-secret: landflow-code-runner-dev-only` |

"In-network" addresses work from containers on the `landflow-infra` network (the app stack with `compose.infra-link.yml`). Containers without it reach the infra through the Mac: `host.docker.internal:<Mac port>`.

Keycloak details: redirect URIs `http://localhost:3000/api/auth/oidc/callback` and `http://localhost:53000/api/auth/oidc/callback` (and their `127.0.0.1` forms), plus the same hosts' `/api/oauth2/callback` for OAuth2 Connect (the client also has service accounts on, for the client credentials grant: `service-account-landflow`); the ID and access tokens carry the realm roles in a `roles` claim. The issuer is always `http://localhost:58080/realms/landflow` (`KC_HOSTNAME`), while the backchannel endpoints follow the request host, so a container can fetch tokens and JWKS from `http://keycloak:8080`. Direct access grants are on so scripts can log in a test user:

```bash
curl -s -d grant_type=password -d client_id=landflow -d client_secret=landflow-dev-client-secret \
  -d username=alice -d password=alice-test-only -d scope=openid \
  http://localhost:58080/realms/landflow/protocol/openid-connect/token
```

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

The dockerised host can't reach `localhost:58080`, so `compose.yml` (commented) adds `LANDFLOW_OIDC_DISCOVERY_URL` pointing at `host.docker.internal:58080` (or `keycloak:8080` with `compose.infra-link.yml`); Keycloak then hands out backchannel endpoints the container can reach, while browsers still go to `localhost:58080`. The realm already allows the `:3000` and `:53000` callback URLs.

Tests: `(cd apps/web && LANDFLOW_INTEGRATION=oidc,smtp npx vitest run test/oidc.integration.test.ts test/smtp.integration.test.ts)` signs in as alice and bob through Keycloak's own login form and sends invites and resets through Mailpit. Mailpit can take about 8 s to greet each new SMTP connection under Docker Desktop, so an invite takes that long to send here.

## The app stack

| Image | Built from | Runs |
|---|---|---|
| `landflow/host:dev` | [`docker/host.Dockerfile`](docker/host.Dockerfile) | `node apps/web/server.js` (Next standalone output) as `node` (uid 1000), data in `/data` |
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
- **GreenMail** is there because Mailpit has no IMAP: it is the mailbox the Email Trigger (IMAP) reads. Mail sent to its SMTP port lands in its own mailboxes, not in Mailpit.
- Keycloak's realm is imported only when the realm doesn't exist yet. After editing `infra/keycloak/landflow-realm.json`, run `down -v` on the infra stack (or delete the realm in the admin console) and start it again.
