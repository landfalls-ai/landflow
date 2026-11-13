# Landflow constitution

The rules every research and every implementation in this repository starts from. Part of the
[Landflow docs](README.md). [CLAUDE.md](../CLAUDE.md) imports this page, so Claude Code reads it at the start of every
session; people read it before they start a feature too.

## How to use it

- Read it before you research or build anything, then follow the [feature workflow](#the-feature-workflow).
- Each rule points at the doc or code that shows the pattern. Paths that start with `lib/`, `components/` or `app/`
  are under `apps/web/src/`. Open the pointer before you invent a new way.
- A rule marked **(target, Pxx)** is a convention the backend refactor is introducing (package Pxx; see the
  "Backend hardening" section of [roadmap.md](roadmap.md) once it lands). Until that package is on `origin/main`, the
  code wins: follow the current pattern named beside it and don't build a competing one. When the package lands,
  remove the mark here.
- Every other rule wins over the code: if the code breaks it, don't copy the break; fix it or say why not.
- When a convention changes, change this page in the same commit.

## Non-negotiables

- **A person in the loop.** Nothing merges, deletes or sends on a person's behalf without their yes: AI changes are
  proposals with **Apply** ([assistant.md](assistant.md)), tool calls wait for **Approve**, agents open draft PRs and
  never merge on their own.
- **Private by default.** Private channels, DMs and email bodies are off unless a node option turns them on
  explicitly ([protocol.md §16](protocol.md#16-activity-items), [features/integrations.md](features/integrations.md)).
- **No real tokens.** Use only the development credentials in `deploy/.env.example`. Never enter, commit or log a real
  vendor token; the person creates real credentials themselves, in the UI.
- **Local only.** Run and deploy only on this machine: OrbStack Docker and its Kubernetes (`--context orbstack`,
  namespace `landflow-dev`). Never deploy to a cloud, never push images. AWS goes only to LocalStack at
  `http://127.0.0.1:54566` with dummy keys and `AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null`.
- **Shared engine.** Touch only the `landflow-*` compose projects and the `landflow-dev` namespace. Never prune.
  Build with `COMPOSE_BAKE=false`; cluster images with `docker --context orbstack buildx build --builder orbstack --load`.
- **Live data.** Never hand-edit `apps/web/.data` (database, `credentials.json`, `encryption.key`); use the UI, API or
  CLI, and a scratch data directory for checks ([development.md](development.md#checking-a-change-live)).
- **Public repo.** Everything pushed is public at once. Scan the diff for secrets, personal names, emails, home-folder
  paths, internal links and session ids before every push (the command is in
  [.claude/skills/landflow-feature](../.claude/skills/landflow-feature/SKILL.md)). The scan covers file contents; the
  `Claude-Session:` trailer in commit messages is the accepted exception. Never commit `.data`, kubeconfigs, the
  encryption key or agent notes (`MEMORY.md`).
- **Ask first.** Commit, push, open a PR or merge only when the person asks. Work on a branch, never on `main`.

## Research before building

1. Find the feature in the [feature map](README.md#feature-map), then read its page.
2. Read [limitations.md](limitations.md), [roadmap.md](roadmap.md) and [history.md](history.md) for what exists, what
   was decided and why.
3. Find the existing pattern (grep for a sibling route, store, node or component) and reuse it. Two ways of doing one
   thing is a bug.
4. For any Next.js code, read the guide in `apps/web/node_modules/next/dist/docs/` first: this Next.js (16) differs from
   older ones ([apps/web/AGENTS.md](../apps/web/AGENTS.md)).
5. Write down what you will change, which files, and why, before you edit. A larger feature gets a spec in
   [specs/](specs/README.md).

## Architecture

**Routes and access**

- Wrap every route in `handler()`; answer with `json()` / `error()`; validate bodies with `parseBody()` and zod
  (`apps/web/src/lib/server/http.ts`, shared schemas in `lib/server/schemas.ts`). Never call `request.json()` directly.
- Validate query strings with `parseQuery()` and the shared page schema (target, P16); until then parse and clamp
  every number by hand, never `Number(param)` straight into a query.
- Decide who may call a route in `lib/server/auth/policy.ts`. A route with no entry is open to every signed-in member,
  so every route has a policy entry or an in-handler check (`requireResource`, `filterVisible` in
  `lib/server/projects/access.ts`).
- Public paths are listed in `lib/shared/auth-paths.ts` and authenticate their own way (signed token, webhook auth).
  Public API routes are described in `lib/server/openapi.ts` (`test/openapi.test.ts` checks it).
- Throw `HttpError` (status, code, details) and let `handler()` map it, with a generic 500 that carries the request id
  (target, P11, `lib/server/errors.ts`). Until then: catch domain errors and `error(message, status)`, and never send an
  unexpected error's text (SQL, paths, stacks) to the client.

**Configuration and process state**

- Read configuration only through `lib/server/config` (`envInt`, `envNumber`, `envFlag`, `envUrl`, `envString`:
  parsed at call time, never NaN, an invalid value falls back with a `config.invalid` warning; `publicUrl()`,
  `ollamaUrl()`; `checkConfig()` runs first at boot). Add no new ad-hoc `process.env` reads. The catalog of every
  variable and the generated reference are (target, P18).
- Stricter defaults (a required secret, a refused request) apply only in the production profile (`profile()`,
  `isProduction()` from `lib/server/config`), so `pnpm dev`, the scratch host and the offline tests keep working.
- Hold process-wide state only through `singleton()` (`lib/server/singleton.ts`), with one exported key per object; no
  `globalThis.__x` and no mutable module-level state (Next.js compiles routes into separate module graphs).
- Background services are entries of `SERVICES` in `lib/server/runtime.ts`, the one service table the main and the
  worker both boot from (`roles`, `required`, `leader`, `stop` with its shutdown phase). Leader-only work runs through
  `leaderService()` (`lib/server/cluster/index.ts`); shutdown goes through the lifecycle registry `onShutdown()`
  (`lib/server/lifecycle.ts`). Routes don't import the runtime: `handler()` waits on `whenReady()`.

**Layers**

- The store does not call up into features: emit an event and let the feature subscribe at boot (target, P20; the bus
  is `lib/server/bus.ts`).
- No server → UI imports, no `lib/shared` → server imports, no client component importing server values, no routes
  touching `db` or holding SQL. `packages/` never import `apps/web`; `engine` and `protocol` read no environment.
  These are checked by `pnpm check:deps` (target, P28).
- Split a file that grows past about 800 lines along its own section comments rather than adding to it.

**Data**

- Migrations: append to `MIGRATIONS` in `lib/server/db/schema.ts`, with a version above the current maximum (grep
  it; versions are not in file order). One SQL text for SQLite and Postgres; never edit a shipped migration; a new
  table also goes in `TABLES`; a column a shipped table gained goes in `addColumns`.
- Writes go through the `Database` write methods (`upsert`, `insertNew`, `delete`, `deleteBefore`) so Postgres
  mode can replay them (`lib/server/db/database.ts`, `db/postgres.ts`). A change of several rows runs in one
  `transaction()`.
- No unbounded list reads: every list takes a capped limit and pages with a keyset cursor (target, P16; the model is
  `executions/[id]/events`). Filter by visibility in SQL, not after a fetch.
- Nothing on a hot path (saving a run, a request) does work proportional to history: prune and aggregate in SQL on a
  timer or every N events (executions: `pruneExecutions` and `retentionTick` in `lib/server/settings.ts`).
- `IN (…)` lists and access checks inside loops are N+1 once reads move to Postgres: batch them.

## Security baseline

- **Least privilege.** Per route (policy.ts) and per project: every id a caller sends is checked against the caller's
  projects (`requireResource`, `canResource`, `visibleProjectIds`); a 404 rather than a 403 when the caller may not
  know the resource exists. Instance-wide actions need an admin action in the policy table.
- **Audit in the library.** Every security-relevant change (members, roles, shares, transfers, secrets, keys,
  settings, provisioning) records a domain event with `recordAudit()` (`lib/server/audit/index.ts`) in the library
  function, not the route, with actor, target, project and `from` / `to` values. Denied and failed access is recorded
  too (target, P12). The generic `api.request` event is a fallback, not coverage.
- **Secrets stay secret.** Never put a credential value, token or key in a log line, error message, span attribute,
  audit detail or run data. Logs redact by key name (`SECRET_KEY` in `lib/server/telemetry/config.ts`), `$secrets`
  values are scrubbed (`lib/server/secrets/redact.ts`); widen these when you add a new kind of secret (P17 widens
  them). The API returns a credential's status, never its value. Bearer secrets are stored hashed and shown once;
  compare them with `sameSecret()` (`lib/server/auth/passwords.ts`).
- **Outbound calls.** Every request to a URL a user, a webhook or a model can influence goes through `safeFetch`:
  loopback, private, link-local and metadata addresses refused unless allow-listed, redirects re-checked (target,
  P13, `lib/server/net/safe-fetch.ts`). Until then use the governance host allow-list (`lib/server/governance/policy.ts`)
  and don't add a new fetch to a user URL without an address check.
- **Untrusted code.** Expressions and Code nodes never see host objects. Expressions run in a sealed realm (target,
  P14; today `packages/engine/src/expression.ts` is `node:vm` and not a boundary); production Code nodes run in the
  code runner (`services/code-runner`). Never pass a host object, function or Buffer into a vm context.
- **Bounded input.** Bodies validated with zod and capped in size (cap: target, P16); rate limits per principal and
  per client address on public and costly routes (target, P16; sign-in limits in `lib/server/auth/rate-limit.ts`).
- **Client address** comes from `clientAddress()` (`lib/server/net/client-address.ts`, `LANDFLOW_TRUSTED_PROXIES`),
  never straight from `X-Forwarded-For`. Emailed links use `emailedOrigin()` (`lib/server/auth/cookies.ts`: the
  configured public URL, never a request header in production); resume URLs are signed (`lib/server/resume-signing.ts`).
- **Headers.** Pages and API responses carry the security headers and a nonce CSP from `apps/web/src/proxy.ts`
  (`LANDFLOW_CSP`, `LANDFLOW_HSTS`); a new embeddable path goes in its `EMBEDDABLE` list.
- **Plugin registration** is closed outside development: announces need `LANDFLOW_REGISTRY_SECRET` in the production
  profile unless `LANDFLOW_REGISTRY_OPEN=true` (`registryOpen()` and the address and join rules in
  `lib/server/plugins/registry-policy.ts`).

## Observability baseline

- Log with `logger` from `lib/server/telemetry` (one JSON line, trace id), never `console.*` in server code.
- Structured fields with OpenTelemetry names (`url.path`, `error`, `landflow.*`); a message is a short fixed phrase,
  values go in fields.
- Every log line and span carries the request id and actor (target, P17); until then pass `landflow.request_id`
  where you have it.
- Metrics follow [observability.md](observability.md) and `lib/server/telemetry/metrics.ts`; labels have bounded
  cardinality: no workflow, execution, user or other ids as labels (put ids on spans).
- Health: `/api/health/live` (no I/O) and `/api/health/ready` (boot and draining, database, write queue, schema
  version, Valkey in queue mode; `readiness()` in `lib/server/health.ts`, each check bounded and answering only ok and
  milliseconds); a new dependency that must be up to serve traffic joins readiness.
- Flush on shutdown: anything that buffers (telemetry, the Postgres queue, the audit outbox) registers a shutdown step
  (`onShutdown()` in its phase, or `stop` and `shutdownPhase` on its `SERVICES` entry).

## UI and UX

- Use the words, type scale, page layout, dialogs, empty states and controls in [ui-review.md](ui-review.md#words) and
  the shared components in `apps/web/src/components/ui` (`Dialog`, `EmptyState`, `Segmented`, `SearchInput`,
  `FilterChip`, `StatCard`, `Sheet`, `chat.tsx`) and `components/shell/page-header.tsx`. Never draw a second one.
- Phone layout sits behind `max-md:` or `usePhone()` (`lib/client/use-phone.ts`) and never changes the desktop
  ([mobile.md](mobile.md)). Check every UI change at 1440×900 and at 390×844 and compare desktop with shots taken
  before the change.
- While AI builds or debugs, the canvas stays visible: the conversation folds to a side card or strip, never over the
  flow (`components/editor/spotlight.tsx`).
- Change workflows through the editor's Spotlight, not scripts that PUT JSON; where Spotlight falls short, fix
  Spotlight.
- Show runs and UI checks in a visible (headed) browser at `http://localhost:<port>` (not `127.0.0.1`: Next dev blocks
  its scripts there); restart a long-running dev host after renaming files or changing a singleton.

## Agents and AI features

- Landflow agents export to the Claude Code plugin marketplace format, not only import from it: keep new agent fields
  mappable to an agent `.md` and `skills/<name>/SKILL.md` (`lib/server/marketplace/map.ts`, `export.ts`).
- Claude Code harnesses use one common toolchain image and fetch project dependencies over egress; no per-project
  images, no per-run toolchain installs ([a2a.md](a2a.md#a-toolchain-image-for-claude-code)).
- Every sub-agent, A2A call and artifact is visible in the Run Trace; don't hide agent-to-agent work inside one node
  ([run-trace.md](run-trace.md)).
- A model reply never changes state by itself: it proposes ops the server validates against the live registry
  (`lib/shared/assistant-ops.ts`).

## Testing and the regression gate

- Tests sit next to their package (`apps/web/test`, `packages/*/test`, `*_test.go`, `sdks/python/tests`).
- Route tests import the handler and call it with a `Request`; `test/setup.ts` signs in a synthetic owner;
  `disableTestAuth()` for auth tests. Set env vars (a fresh `LANDFLOW_DATA_DIR` from `mkdtempSync`) before a dynamic
  `await import(...)`.
- Tests that need a real service skip unless `LANDFLOW_INTEGRATION` names them; run Postgres-backed files one at a
  time ([development.md](development.md#integration-tests-landflow_integration)).
- Every change adds or updates tests: the bug it fixes fails without the change.
- Before a PR: `(cd apps/web && npx vitest run) && pnpm typecheck` and `pnpm test`, plus the Go and Python suites for
  what you touched ([development.md](development.md#verification)). Compare the counts with the last green run on
  `main`; never accept a new failure.
- Known flaky: `apps/web/test/marketplace.test.ts` times out under the full parallel load; rerun it alone and report
  both results.
- When several agents share the machine, run typecheck and the targeted files, and leave the full host suite to the
  integrator.

## Docs move with the code

- The feature's page; [reference/api.md](reference/api.md) for routes and
  [reference/configuration.md](reference/configuration.md) for variables (from P18: `config/catalog.ts` and
  `pnpm --filter @landflow/web gen:config-docs`).
- [limitations.md](limitations.md) when a limit is added or lifted; [roadmap.md](roadmap.md) when an item closes or
  opens; a [history.md](history.md) row per commit (`| (this change) | what changed, in plain words | [page](link) |`).
- New pages go in [README.md](README.md). Write short, plain sentences: what and why; no marketing.

## Definition of done

- [ ] The brief or spec is written: what, why, files, tests, docs, acceptance criteria.
- [ ] The existing pattern was found and reused; no second way of doing one thing.
- [ ] Access, audit, secrets, outbound and input rules above hold for every new route and library function.
- [ ] Tests added; the targeted files pass; the regression gate is green against the baseline.
- [ ] Docs updated (feature page, reference, limitations, roadmap, history row, README for new pages).
- [ ] UI: checked in a headed browser at 1440×900 and 390×844, desktop unchanged unless meant.
- [ ] The diff was scanned for secrets and personal data.
- [ ] The PR body lists what a user sees change, and what changes on a desktop.

## The feature workflow

Run it with the `landflow-feature` skill ([.claude/skills/landflow-feature](../.claude/skills/landflow-feature/SKILL.md));
the agents are in [.claude/agents](../.claude/agents) and described in
[development.md](development.md#working-with-claude-code-constitution-agents-feature-skill).

1. **Research**: `landflow-researcher` maps the area and what to reuse, with file:line.
2. **Plan**: `landflow-planner` writes the brief: packages with disjoint files, tests, docs, acceptance criteria.
3. **Implement**: `landflow-implementer` per package, each in its own worktree from `origin/main`, a few at a time;
   the specialists (`landflow-data-engineer`, `landflow-ui-engineer`, `landflow-ai-assistant-engineer`,
   `landflow-plugin-engineer`, `landflow-observability-engineer`, `landflow-test-engineer`, `landflow-docs-writer`)
   take the packages in their area.
4. **Review**: `landflow-security-reviewer` and `landflow-code-reviewer`, at most two reviewers at a time; fix and
   review again until both approve.
5. **Integrate**: `landflow-integrator` merges the packages and runs the full gate; UI changes are checked at desktop
   and phone.
6. **Ship**: secret scan, then a PR when the person asks; merge only when they say so. `landflow-local-ops` runs
   anything on Docker or the cluster.

Sub-agents never start sub-agents of their own.
