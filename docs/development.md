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
pnpm dev:all                                  # host on :3000 + ten plugins (7101–7107 and 7116–7118 HTTP, 7201–7207 and 7216–7218 gRPC)
pnpm dev:all:browser                          # the same plus the Browser plugin (7112 / 7212; needs agent-browser and Chrome on the Mac)
pnpm dev:all:agent-shell                      # the same plus the Agent Shell plugin (7114 / 7214)
pnpm dev:all:web-search                       # the same plus the Web Search plugin (7113 / 7213; needs a SearXNG URL or an API key credential)
docker compose -f deploy/compose.infra.yml up -d --wait   # Postgres, Valkey, Mailpit, MinIO, OpenBao (optional)
```

`pnpm dev` runs only the host; `pnpm plugin:ts|py|go|messaging|productivity|google|databases|github|linear|attio|fathom|clickland|landledger|landfall|triage|threat-intel|browser|web-search|agent-shell|ai-sdk` runs one plugin (`web-search` on 7113 / 7213, `agent-shell` on 7114 / 7214, `ai-sdk` on 7115 / 7215; these three, `github`, `clickland`, `landledger` and the Landfall, triage and threat-intel plugins are not in `dev:all`; see ports in [platform/kubernetes.md](platform/kubernetes.md)), and
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

- **Migrations** live in `apps/web/src/lib/server/db/schema.ts`, in order. A new one goes at the end with a version
  above the current highest (the last entry of `MIGRATIONS`). A migration numbered below one a database already has
  still runs there, but after the higher ones, while a fresh database runs it before them, so the order differs
  between databases and their schemas can diverge (`apps/web/test/migrations-order.test.ts` fails on one; only 1200
  and 1300, which shipped out of order, are grandfathered). One SQL text runs on SQLite and Postgres (TEXT, BIGINT,
  DOUBLE PRECISION, JSON in TEXT, `ON CONFLICT` upserts); set `postgres` only when the dialects must differ. Never
  edit a shipped migration: add one. A column that a shipped `CREATE TABLE` gained later goes in `addColumns`. A new
  table also goes in `TABLES` (its primary key) in the same file.
- **Environment variables** go in the catalog first: add an entry to `CONFIG_CATALOG` in
  `apps/web/src/lib/server/config/catalog.ts` (default and description as the page shows them, group, `secret`,
  `profile`, `readBy`, `aliases`), read it with `envFlag` / `envNumber` / `envInt` / `envString` / `envUrl` (`envWithAliases` for a renamed one) from
  `lib/server/config`, and run `pnpm --filter @landflow/web gen:config-docs` to regenerate
  [reference/configuration.md](reference/configuration.md). `test/config-catalog.test.ts` fails on a name the source
  reads that is not catalogued, on a stale page, and when more files read `process.env` directly than
  `MAX_FILES_READING_PROCESS_ENV` allows (86; lower it when a reader moves into config, never raise it).
- **Errors**: a route (or the store below it) throws an `HttpError` (`lib/server/errors.ts`: `(message, status = 400,
  { code?, details?, cause?, expose? })`) and does not catch it to build a response: `handler()` answers it as
  `{ error, code, …details }`. Give a domain error its own class (`class OutOfStockError extends HttpError`, same
  `(message, status)` order as the older classes) instead of a `try`/`catch` per route, and name it with a literal on
  the first line of its body: `static readonly errorName: string = 'OutOfStockError';`. `code` (`out_of_stock_error`)
  and `name` come from it, because `next build` minifies class names (from `new.target.name` the image would answer
  `code: "v"`); `test/error-mapping.test.ts` fails a subclass without one. Anything that is not an
  `HttpError` or a `ZodError` becomes a generic 500 with the request id, so write user-facing failures as `HttpError`s
  with a 4xx, 502 or 503 status (`expose: true` for a 5xx whose text may reach the client). Every domain error with a
  status (`VariableError`, `PublishError`, `ProjectError`, `CredentialError`, `SourceControlError`, `TemplateError`, …)
  now extends `HttpError`, so do not `catch` one in a route only to answer `error(caught.message, caught.status)`: let it
  propagate, and carry extra response fields in `details` (`FolderNotEmptyError`, `TemplateError`, `CompositeError`,
  `RunSkippedError`). Keep a `catch` only when it does something else (an audit row, cleanup, a different status or a
  page instead of JSON). A class with no status (an internal error) stays a plain `Error`: it becomes the generic 500.
  `test/error-mapping.test.ts` checks both. `mapError` and `formatError` remain for `scimRoute`.
- **Access rules**: `test/policy-coverage.test.ts` walks every `route.ts` and fails for a mutating route that is not
  public, not named by `routePolicy()` (the table marks its default with `fallback: true`) or a resource rule, and has
  no check of its own in the handler (`requireUser`, `routeActor`, `can(`, `projectRoute`, …). Add the policy line; an
  `ALLOWED` entry in that test needs a one-line reason.
- **The database** caches prepared statements by SQL text in a bounded LRU: `LANDFLOW_DB_STATEMENT_CACHE` (default 500)
  caps it, because `IN (?, ?, …)` lists of every length are different texts. List paths read access with one query per
  kind (`allShares(kind)`, the memberships) and not one per item; keep the single-item functions for single resources.
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

## Working with Claude Code: constitution, agents, feature skill

Claude Code works on this repository with three things checked in beside the code:

- **The constitution**, [constitution.md](constitution.md): the rules every research and implementation starts from.
  `CLAUDE.md` imports it (`@docs/constitution.md`), so every session reads it. Every rule describes code that exists
  (the backend refactor's conventions have all landed); change the page when a convention changes.
- **Agents** in `.claude/agents/`: subagents that know this repository: its paths, helpers, pitfalls and the order of
  work. Claude Code picks one by its description, or you name it ("use landflow-security-reviewer on this branch").
  Reviewers and the researcher are read-only. None of them starts sub-agents of its own.
- **The feature skill**, `.claude/skills/landflow-feature/SKILL.md`: the pipeline a feature follows, with the exact
  commands (worktree, install, gate, secret scan). Ask for it by name (`/landflow-feature`) or let Claude Code load it
  for any new feature or multi-step change.

| Agent | Model | Tools | Use it for |
|---|---|---|---|
| `landflow-researcher` | sonnet | read-only | how an area works today and what to reuse, with file:line |
| `landflow-planner` | opus | read-only | a plan of packages with disjoint files, tests, docs and acceptance criteria |
| `landflow-implementer` | sonnet | all | one package in its own worktree from `origin/main` |
| `landflow-security-reviewer` | fable | read-only | access and project scoping, audit, secrets, outbound calls, sandboxing, input limits |
| `landflow-code-reviewer` | fable | read-only | correctness, regressions, conventions, tests and docs against the brief |
| `landflow-test-engineer` | sonnet | all | tests in this repository's style and the regression gate |
| `landflow-integrator` | sonnet | all | merging a wave's branches, shared-doc conflicts, the full gate |
| `landflow-data-engineer` | sonnet | all | migrations, the store, Postgres mode, paging, retention |
| `landflow-observability-engineer` | sonnet | all | logs, spans, metrics, health, alerts |
| `landflow-ui-engineer` | sonnet | all | pages and components to [ui-review.md](ui-review.md) and [mobile.md](mobile.md), checked at desktop and phone |
| `landflow-ai-assistant-engineer` | sonnet | all | Spotlight, agents, teams, A2A and kagent, the notebook, the brain, Run Trace |
| `landflow-plugin-engineer` | sonnet | all | plugins, the protocol, the three SDKs, transports |
| `landflow-docs-writer` | sonnet | all | feature pages, reference, limitations, roadmap, history rows |
| `landflow-local-ops` | sonnet | all | the infra stack, the OrbStack cluster, kagent's kind cluster, the scratch host |

**The `landflow-dev` plugin.** Seven more skills (`landflow-platform-overview`, `landflow-server-change`,
`landflow-agents`, `landflow-kubernetes`, `landflow-plugin-typescript`, `landflow-plugin-python`, `landflow-plugin-go`)
and two agents (`landflow-platform-guide`, `landflow-plugin-builder`) live in
[`claude-plugins/landflow-dev/`](../claude-plugins/landflow-dev/README.md), a Claude Code plugin that is also listed in
`.claude-plugin/marketplace.json`. The plugin is the source: the same files are copied into `.claude/skills/` and
`.claude/agents/` so this repository loads them with no install. To change one, edit the plugin copy, run
`node scripts/sync-claude-plugin.mjs --write`, and commit both. `pnpm check:claude-plugin` (part of `pnpm check`) runs
the script with `--check` and fails when a copy differs or is missing. The script touches only files the plugin has: the
contributor agents above and `landflow-feature` are not part of it. Check the plugin with
`claude plugin validate claude-plugins/landflow-dev` and the marketplace with `claude plugin validate .`.

The models follow one rule: planning on the strongest planner, implementation on a cheaper model, reviews on fable,
with at most two fable agents running at once. To change an agent, edit its file; keep its paths true to the code,
and keep the constitution and the agents in step.

## Verification

Every suite, from the repository root. All of them run offline.

```bash
(cd apps/web && npx vitest run)                    # the host: routes, store, runner, auth, AI, queue mode on fakes…
                                                   # (a test file that needs a DOM starts with `// @vitest-environment happy-dom`: node-credentials-effect.test.ts)
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
# the LLM gateway's callback, in the pinned LiteLLM image (by digest; no network)
docker --context orbstack run --rm --network none -e LITELLM_LOCAL_MODEL_COST_MAP=True -v "$PWD/deploy/llm-gateway:/w" -w /w --entrypoint python ghcr.io/berriai/litellm:v1.108.2-lts@sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d -m unittest discover -s tests
deploy/scripts/smoke.sh code                       # the dockerised code runner: health + network/file-system isolation
```

The Claude Code mods' own hook tests (`apps/web/claude-plugins/landflow-brain/hooks/*.test.ts`) import
`claude-code/testing`, an engine module that only the Claude Code CLI provides, so neither vitest nor `pnpm check` can run
them. Run them with `claude plugin validate apps/web/claude-plugins/landflow-brain && claude plugin test
apps/web/claude-plugins/landflow-brain`, and with the same pair for `landflow-harness`, whenever a hook changes. The
mods' pure rules are also tested in the host's suite (`apps/web/test/claude-brain-mod.test.ts`), which `pnpm check` runs.

The host's suite runs its files in parallel, so `apps/web/vitest.config.ts` gives each test 20 s and each hook 30 s:
the marketplace, cluster runtime and MCP file-approval tests timed out at the defaults under that load.

The engine's suite runs on the machine's Node (22). `packages/engine/test/expression-sandbox.test.ts` walks the
expression realm's globals for anything that returns a promise, so after a Node upgrade, or before relying on a newer
Node than the `engines` field's minimum, run the engine's suite on that version too, for example
`(cd packages/engine && npx -y node@26 node_modules/vitest/vitest.mjs run)`: a new global of that kind fails it there first.

Route tests boot the way the host does: `apps/web/test/setup.ts` registers the bootstrapper, and the first `handler()`
call boots through `whenReady()`, outside that request's audit and log context (what the boot records is not the
request's). Once the boot is `ready`, `handler()` no longer reaches the `bootstrap` singleton, so a
test that forgets that singleton to boot again must call `ensureBootstrapped()` itself; the next request won't reboot.

`pnpm test` runs every workspace package's `test` script in one go, the host's included (`pnpm check` adds typecheck and the boundary check). After editing `packages/protocol/proto/landflow/plugin/v1/plugin.proto`, run
`pnpm gen:proto` (re-embeds the proto and regenerates the JSON Schema).

### Checking the boundaries

`pnpm check` is the local gate before a change is done: `pnpm typecheck`, `pnpm test` (every package's suite, the host's
included) and `pnpm check:deps`. There is no CI workflow (decision: this project runs and checks everything on this
machine), so nothing else runs these for you.

`pnpm check:deps` runs dependency-cruiser with `.dependency-cruiser.cjs` over `apps/web/src` and `packages/*/src`. The rules:

| Rule | Forbids |
|---|---|
| `server-not-components` | `apps/web/src/lib/server` importing `components/` |
| `shared-not-server` | `lib/shared` importing `lib/server` (type-only imports are fine) |
| `client-not-server-values` | a file starting with `'use client'` importing a value from `lib/server` (types are fine) |
| `routes-not-db` | a route file (`app/**/route.ts`) importing `lib/server/db` |
| `packages-not-apps` | anything in `packages/` importing `apps/` |
| `no-circular` | a new value import cycle (cycles inside `lib/server/runner/`, whose modules call each other only at run time, are allowed; type-only imports are not counted, as they are erased at build time). One new edge inside an existing cycle group can re-report neighbouring known edges, because a known cycle is matched by its exact set of modules |

The violations that existed when the rules were added (the cycles, and two routes that import `lib/server/db`: `form-test`
and `proposals/[id]/applied`) are recorded in `.dependency-cruiser-known-violations.json` and ignored, so only new ones
fail. `client-not-server-values` checks direct imports only: a module without the directive that a client component imports could still pull in a server value. Fixing one makes its entry stale and does no harm; to shrink the record after fixing some, or to accept a new cycle
on purpose, run `pnpm check:deps:baseline` and commit the file with the reason.

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
| `postgres` | the infra Postgres, database `landflow_test` (or `LANDFLOW_PG_URL`, `LANDFLOW_TEST_DATABASE_URL`) | `pgvector.test.ts`, `postgres.test.ts` (the store, schema `landflow_runtime_test`), `postgres-hot-mirror.test.ts` (the hot mirror: eviction, cold reads through the async seam, promotion, schema `landflow_hot_test`; run it in its own vitest call, as the two share `landflow_test`), `projects-migration.test.ts`, `project-folders-variables.test.ts` |
| `queue` | the infra Valkey (`LANDFLOW_TEST_VALKEY_URL`, under a throwaway key prefix) and Postgres | `cluster-coordinator.test.ts` (coordinator, leader election, stalled-job takeover, relay), `cluster-postgres.test.ts` (processes following each other's writes, schema `landflow_queue_test`), `config-store-postgres.test.ts` (credentials and settings shared by two processes, in a database it creates and drops), `rotate-key-postgres.test.ts` (the `rotate-key` script re-sealing a credential and a settings row in Postgres, in a database it creates and drops), `audit-chain.postgres.test.ts` (the hash chain sealed by two processes at once, SAML state shared by mains), `transports.postgres.test.ts`, `approval-inbox-cluster-ap1.test.ts` (two processes claim one approval-inbox row in Postgres, exactly one wins; wave ap1) |
| `sentinel` | `deploy/compose.sentinel.yml` | `valkey-sentinel.integration.test.ts` (the primary is killed; a run in flight and new runs finish on the promoted replica) |
| `valkey-cluster` | the infra `valkey-cluster` profile | `valkey-cluster.integration.test.ts` |
| `oidc` | Keycloak (`auth` profile) | `oidc.integration.test.ts` (fills in its login form as alice and bob) |
| `saml` | Keycloak (`auth` profile) | `saml.integration.test.ts` (role and project mapping, replay, single logout, encrypted assertions) |
| `oauth2` | Keycloak (`auth` profile) | `oauth2-keycloak.test.ts` (Connect, refresh, revocation, client credentials), `mcp-oauth-keycloak.test.ts` (OAuth for MCP servers) |
| `smtp` | Mailpit | `smtp.integration.test.ts` (invites, password resets), `alerts-smtp.test.ts` (failure alert emails) |
| `imap` | GreenMail (`mail` profile) | `email-imap.test.ts`, `email-imap-host.test.ts` (the Email Trigger) |
| `s3` | MinIO | `binary-store.test.ts` (the S3 binary store) |
| `grafana` (no flag: a local service) | the compose `grafana` profile: `LANDFLOW_GRAFANA_PORT=<port> docker compose -p <project> -f deploy/compose.infra.yml --profile grafana up -d --wait grafana` (default port 53130, `admin` / `landflow-dev-only`) | one alert rule, **High CPU on web-01** (`host=web-01`, `severity=critical`), fires within a minute. A viewer token: `POST /api/serviceaccounts` then `/api/serviceaccounts/<id>/tokens` with basic auth; the Grafana credential's URL is `http://127.0.0.1:<port>/api/alertmanager/grafana` |
| `git-ssh` | the `git` profile, after `deploy/infra/git/gen-keys.sh` | `source-control-git.test.ts` (push and pull over SSH with host-key pinning) |
| `secrets` | OpenBao at `http://127.0.0.1:58200` | `secrets-openbao.integration.test.ts` (token and AppRole auth, set up idempotently through the API; lease renewal; a run whose credential reads a secret). The other providers are tested against local fakes |
| `aws` | LocalStack (`aws` profile) at `http://127.0.0.1:54566` (`LANDFLOW_LOCALSTACK_PORT`, `LANDFLOW_LOCALSTACK_URL`) | `secrets-aws.integration.test.ts` (access keys and environment auth, a `{environment}` prefix, JSON and plain secrets, redaction; the endpoint must be loopback, the keys are dummies and `~/.aws` is never read) |
| `audit-anchor` | MinIO; must be the only flag | `audit-integrity.test.ts` (signed heads in a real bucket) |
| `k8s` | the OrbStack cluster, namespace `landflow-dev`, the plugin image built locally | `kubernetes.integration.test.ts` (discovery, scale to 0 and back, calls spread over two pods) |
| `isolate` | the optional `isolated-vm` addon, and `NODE_OPTIONS=--no-node-snapshot` | `packages/engine/test/expression-isolate.test.ts` (the realm suite on the isolate, memory bombs each in a child process, churn, benchmark), `apps/web/test/expression-preview-isolate.test.ts` (a route uses the isolate) |
| `ollama` | Ollama at `OLLAMA_URL` with nomic-embed-text and qwen3-coder:30b | `rag-live.test.ts`, `evaluations-live.test.ts` (qwen3-coder as the judge), `ollama-streaming-live.test.ts`, `landledger-flows.test.ts` (the variance-notes flow drafting with qwen3-coder against the fake Landledger, which checks every cite) |
| `spotlight` | Ollama at `OLLAMA_URL` (default `http://localhost:11434`) with `qwen3-coder:30b` (never pulled for you: the suite stops with a message if it is missing); nothing else, the echo server is the suite's own on `127.0.0.1:3399` | `spotlight-scenarios.test.ts` (the live form of every scenario in `test/spotlight-scenarios/`, three runs each, printing the scorecard; the scripted form always runs) |
| `litellm` | the LiteLLM compose profile ([llm-gateway.md](llm-gateway.md)) and Ollama with qwen3-coder:30b; set `LANDFLOW_LLM_GATEWAY_URL=http://127.0.0.1:54100` and `LANDFLOW_LLM_GATEWAY_ADMIN_KEY` (the dev master key from `deploy/.env.example`); `litellm-live.test.ts` also reads `LANDFLOW_TEST_LITELLM_URL` and `LANDFLOW_TEST_LITELLM_MASTER_KEY` with the same defaults | `litellm-live.test.ts` (Landflow's own calls through the gateway), `litellm-ingest-live.test.ts` (the spend import), `litellm-budgets-live.test.ts` (budgets and a stop) |
| `gateway-image` | Docker on the OrbStack engine and the pinned LiteLLM image, by digest (`ghcr.io/berriai/litellm:v1.108.2-lts@sha256:d8b4ac35…`, as in `deploy/compose.infra.yml`); runs with `--network none`, pulls nothing | `spend-bpe-join.test.ts` (the gateway callback's Python BPE counter and hashes against Landflow's, on the shared fixture and 200 seeded strings; the fixture copies are compared without the flag), `spend-gateway-join.test.ts` (the callback's signed post through `POST /api/gateway-parts`, the spend import and `GET /api/ai-calls/:id`, and a Landflow split winning in every order) |

#### Spotlight scorecard

Spotlight's builds, one-step fixes and agent creation are scored by scenarios in `apps/web/test/spotlight-scenarios/`
(the evaluation of 2026-11-16, moved into the repo). Each scenario has a scripted form that always runs in the unit
suite (`spotlight-scenarios.test.ts`: the product's route handlers, registry, `applyOps` and guards are real, only the
model is scripted) and a live form on the local model that counts its checks:

```bash
cd apps/web && NODE_OPTIONS="--require $PWD/test/spotlight-scenarios/local-only.cjs" LANDFLOW_INTEGRATION=spotlight \
  LANDFLOW_SPOTLIGHT_REPORT=/tmp/scorecard.json npx vitest run test/spotlight-scenarios.test.ts
```

It prints three tables (Build, Fix one step, Agents: per scenario the runs, the time range and "k of n" per check) and
writes the same as JSON (sizes and check results only, no reply or ask text). Variables: `LANDFLOW_SPOTLIGHT_MODEL`
(default `qwen3-coder:30b`), `LANDFLOW_SPOTLIGHT_RUNS` (runs per scenario; default the scenario's, 3),
`LANDFLOW_SPOTLIGHT_ONLY` (comma-separated scenario ids or owners, e.g. `SB03,sb04-why-last-run`),
`LANDFLOW_SPOTLIGHT_REPORT` (the JSON path; default `$TMPDIR/landflow-spotlight-scorecard.json`),
`LANDFLOW_SPOTLIGHT_ECHO_PORT` (the suite's echo server, default 3399) and `LANDFLOW_SPOTLIGHT_PLUGINS` (comma-separated
local plugin endpoints, the Go and Python plugins a scenario's `start.plugins` names; the live form registers the bundled Linear and
Messaging plugins in the test process either way, so builds see the core nodes plus those two, not the whole bundled catalog; the
scripted form uses small stand-ins). **A model of another provider** (`LANDFLOW_SPOTLIGHT_MODEL=anthropic/claude-sonnet-5-5`) needs that provider's key in the environment and no Ollama (the runner stops with the variable's name when the key is missing, and never prints it); a bare or `ollama/` name needs Ollama as before. A scenario's `start.plugins` (AG02, ids `triage`, `grafana`, `text-toolkit`, `databases`, `go-crypto`, `py-insights`, `messaging`) registers the plugins it needs: the scripted form builds stand-ins from the recorded manifests (each records the item it was called with, `Outcome.toolInputs`; Grafana runs its own code in-process), the live form runs the TypeScript ones in-process and the Go and Python ones from `LANDFLOW_SPOTLIGHT_PLUGINS`; a live run whose plugin is not online is listed under "Skipped live" with the reason. Wave ag1's scenario files are `sb-agNN.ts` (the runner globs `sb*.ts`; `owner: 'AGNN'`). The guard, `test/spotlight-scenarios/local-only.cjs`, makes every connection to
anything but this machine fail with `ECONNREFUSED` (and every lookup of another name with `ENOTFOUND`), printing
`[local-only] refused <host>:<port>`. It must be on from the process's start: the runner stops with a message when the live form is asked for
and it is not loaded, so the command above sets `NODE_OPTIONS` (a live check of a running host does the same). It covers
`net` connections and `dns.lookup`; it does not cover `dns.resolve*` or `Resolver` (c-ares over UDP), `dgram` or child
processes, which no product code uses today. A build scenario's `start.staged` plans first as the editor does (the plan route, then the build with that plan; both forms do so unless it says `false` (the scripted form too since the wave sb3 integration: the script is the plan's replies, then one reply per step, a step sent back once answering again; `false` posts `staged: false`, the one-shot draft); `LANDFLOW_SPOTLIGHT_STAGED=false` never plans, the one-shot draft a live comparison measures "before" with), and its `Outcome.plan` and `Outcome.prompts` (each call's tokens, the greater of the reported and the characters over four) feed the `one-trigger` and `prompt-under` checks (`promptUnder(6000)`). A scenario can give a build its plan outright (`start.plan`, a `BuildPlan` as JSON; SB14's are in `test/spotlight-scenarios/fixtures/sb14-plans.json`), posted with the prompt to `POST /api/ai/build`, so stage 2 is scored without the plan stage. A package adds
its scenarios as `test/spotlight-scenarios/<owner>.ts` (`export default defineScenarios([...])`, ids `<owner>-<slug>`):
the runner finds it, no index to edit. A scenario's `start.autonomy` decides what the scripted form applies: asks-first
leaves every card waiting (nobody clicks Apply; a session waiting for Apply is stopped as the person would with ■), auto
applies a card unless it removes a step or leaves one without its input (`needsAClick`), and unset applies every card
(a session runs as auto). `start.approvedDestinations` is the person's yes to a session's test runs that send, by
`host:port`. In the scripted form the fake Ollama spends no script turn on a request that is not a chat (the model
list), and a script turn that throws `Ollama error 500: <body>` is answered as that status and body. A scenario's `start.outbound` (`blocked`, the default, or `allowed`) is the host's outbound policy for the
live session's test runs, set outright (`LANDFLOW_OUTBOUND_BLOCK_PRIVATE=true`, because vitest's development profile does
not block): only `allowed` sets `LANDFLOW_OUTBOUND_ALLOW=127.0.0.1,localhost` (never because an echo server runs). The
echo answers `?fail=NNN` with that status; a session's "changed nothing" ignores cards that were refused or are waiting. A build's checks read its draft: `credentials-listed` an item of kind `credential` in `draft.left`, `left-listed`
`draft.left` (n/a when empty), `sent-back-once` `draft.calls` (n/a for one call and nothing empty); `Outcome.model` is the
reply's `done` model or the draft's. Two shared checks read what a designed agent holds (`Outcome.agents[].caseInputs` and `toolParameters`, `card.needs`): `caseInputsReal` (no test case's input is a description, a `<placeholder>` or under 12 characters) and `destinationsGiven(ask)` (every destination parameter of every node tool is empty or a value the ask holds). [assistant.md](assistant.md#how-spotlight-is-measured) says what the checks mean.

Each backbone wave's packages are joined on their real sides in a joins file (`spotlight-sb1-joins.test.ts` …
`spotlight-sb3-joins.test.ts`, `agents-ag1-joins.test.ts`, `agents-ag2-joins.test.ts`, `agents-ag3-joins.test.ts`,
`agents-ag4-joins.test.ts`, `fix-path-ag5-joins.test.ts`, `approval-inbox-ap1-joins.test.ts`, `notion-brain-nb1-joins.test.ts`, `notion-push-nb04.test.ts`, `notion-copy-nb04.test.ts`); they always run with scripted models. Wave nb1's joins NB01's brain store and change feed, NB02's Notion client and NB03's links on their real sides against the [Notion fake](#the-notion-fake) only (the client is the one `runtime.ts` registers, never a stub): a linked project's store reports `notion` and writes locally with one change, the check route through the real client writes nothing and keeps the key out of every response, audit row and log line, and a fact added in a linked project reaches a listener; its last block compares `lib/shared/brain-store.ts`, `lib/server/brain/store/port.ts`, `lib/server/notion/port.ts`, `test/fake-notion.ts` and `lib/shared/notion-brain.ts` with the contracts folder's `nb/`. Their last block compares the contract copies in the
repository (wave ag4's: `lib/shared/agent-card.ts`, `lib/shared/tenant-catalog.ts`, `lib/shared/agent-bubbles.ts`,
`lib/shared/agent-versions.ts`, `components/canvas/bubble-view.tsx`, `test/spotlight-scenarios/scenario.ts` and
`test/fixtures/legacy-agent-flow.json`; wave ag3's `lib/shared/tool-target.ts` and the runbooks in
`test/spotlight-scenarios/fixtures/runbooks/`) byte for byte with the program's contracts folder, and runs only when
`LANDFLOW_BACKBONE_CONTRACTS` names that folder (it holds `ag3/`, `ag4/`, `ag5/`, whose `fix-autonomy.ts` is `lib/shared/fix-autonomy.ts`, and `ap1/`, whose `approval-inbox.ts` and `inbox-port.ts` are `lib/shared/approval-inbox.ts` and `lib/server/approval-inbox/port.ts`, checked by `approval-inbox-ap1`; the older joins' card and scenario checks
point at `ag4`, since wave ag4 replaced those two contracts). Wave ag3's package tests are `agent-gate-ag3`, `tool-proof-ag3`, `tool-proof-ui-ag3`,
`agent-knowledge-ag3` and `agent-connections-ag3` (`apps/web/test/`; `agent-node-band-ag3` went with the band), and
`packages/sdk/test/stream-target.test.ts`; wave ag4's are `agent-bubbles-ag4`, `agent-layout-ag4` and
`agent-connections-draft-ag4` (AG16), `agent-overrides-ag4` and `agent-ops-ag4` (AG17), `tenant-catalog-ag4` and
`tenant-mcp-ag4` (AG18), `agent-reuse-ag4` and `agent-reuse-card-ag4` (AG19), `run-log-ag4` and `session-fix-ag4` (AG20),
`agent-versions-ag4` and `agent-updates-ag4` (AG21). Wave ag5's are `gate-same-cases-ag5` and `agent-change-quality-ag5` (AG24), `spotlight-approvals-ag5` and
`unattended-approvals-ag5` (AG23), `flow-saved-agent-ag5` and `flow-saved-agent-ag5-editor` (AG25), `fix-autonomy-ag5`,
`session-auto-ag5` and `session-stable-ag5` (AG22); its joins (`fix-path-ag5-joins`) drive the real editor stores and the
route handlers together (each browser `api` call goes to the `route.ts` its path names) with a fake Anthropic, a scripted
agent model and judge, a strict receiver and a fake SMTP server. Wave ap1's package tests are `approval-inbox-ap1`, `approval-inbox-nudge-ap1` and `approval-inbox-postgres-order-ap1` (AP01; the last runs a Postgres-mode `Database` over a fake Postgres, no server needed; and `approval-inbox-cluster-ap1` under `LANDFLOW_INTEGRATION=queue`), `inbox-run-ap1`, `inbox-restart-ap1` and `inbox-lines-ap1` (AP02), and `approval-inbox-ui-ap1` (AP03); the integrator's joins are `approval-inbox-ap1-joins`.

`cluster-runtime.test.ts` always runs: a main and workers through the runner on the in-process coordinator.

Run the Postgres-backed files one at a time: they take an advisory lock per database, so two of them in parallel can
fail (`postgres.test.ts` passes alone). Two more live tests use no flag: `approval-email-mailpit.test.ts` runs whenever
Mailpit answers, and `mcp-gateway-two-issuers.test.ts` runs its gateway checks when
`LANDFLOW_TEST_AGENTGATEWAY_IMAGE` is set (and its Keycloak part when Keycloak is up).

The databases plugin has its own: `cd plugins/databases && LANDFLOW_INTEGRATION=postgres,redis go test -count=1 -run
Integration -v .` (`all` adds MySQL); see
[deployment.md, "Integration tests (databases plugin)"](deployment.md#integration-tests-databases-plugin).

### The Notion fake

Every test of the Notion brain talks to `apps/web/test/fake-notion.ts`, an in-memory Notion on a local port (its header lists
every endpoint and behaviour; no test calls `api.notion.com` or holds a real key). Start it with `startFakeNotion()` and register
a stand-in credential type before creating a credential that points at it:

```ts
registry.registerBuiltin(definePlugin({ info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
  credentialTypes: [defineCredentialType({ name: 'notionApi', displayName: 'Notion API', properties: [
    { name: 'apiKey', displayName: 'Key', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' }] })], nodes: [] }));
const fake = await startFakeNotion();
const { id } = credentials.create({ name: 'Notion', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } });
```

`fake.state.requests` records every request (assert on headers' effects, counts and paths), `setRateLimit` and `failNext`
script 429, 529 and 5xx. Pass `now` and `sleep` to `notionClient` to drive the limiter with a fake clock, and call
`resetLimiters()` between tests. `LANDFLOW_NOTION_WRITE_LOG=<file>` records one id-only line per write.

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
- **Under the production CSP**, build (`npx next build`, then restore `next-env.d.ts`) and start with `next start`,
  `LANDFLOW_PROFILE=production` and `LANDFLOW_CSP=enforce` on a free port. Production refuses calls to local fakes
  and runs Code nodes only in a runner: add `LANDFLOW_OUTBOUND_BLOCK_PRIVATE=false` (or list the fakes in
  `LANDFLOW_OUTBOUND_ALLOW`) and `LANDFLOW_CODE_RUNNER_URL` (or `LANDFLOW_CODE_IN_PROCESS=true`) when the check needs them. Sign in, load the pages with a
  `securitypolicyviolation` listener installed before load, and check that the page source has no script without a
  nonce. The console is not enough: Chrome reports blocked sources as violations the console tool may not capture. Use
  a separate headed Chrome (`playwright-core` with `channel: 'chrome'`), not the Claude in Chrome extension: the
  extension bypasses the page's CSP in its tabs, so a violation there never fires.
- **In the browser**, open `http://localhost:3100`, not `127.0.0.1`. `next dev` blocks its dev resources (`/_next/hmr`)
  for any origin other than `localhost` unless `allowedDevOrigins` lists it, so hot reload doesn't connect. Use a tab of
  your own and keep the console open: a check passes with no errors there.
- **Restart after changing a singleton.** Server objects made with `singleton()` (`lib/server/singleton.ts`: the
  registry, broker connections and others) live on `globalThis` so that hot reload doesn't duplicate them. A reload
  therefore keeps the old instance, and a method you add to its class isn't on it ("registry.compositeTypes is not a
  function"). Stop the dev server and start it again; installed node plugins start again with it. Tests that need a
  fresh one call `resetSingleton(key)` (the old `forgetSingleton` is the same function); keys used by more than one
  file are in `singletonKeys`, and nothing else touches `globalThis.__landflow` (`test/singletons.test.ts` checks).
  Tests that assert on insights, usage or retention after `store.saveExecution` call `ensureExecutionReactions()`
  first, because the store only emits the event. The same goes for those reactions under `pnpm dev`: the listeners
  `execution-reactions.ts` registered at boot keep the insights, usage ledger and settings code of the graph that
  booted, so an edit to `insights.ts`, `usage/ledger.ts` or `retentionTick` takes effect on the save path only after
  a restart.
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
