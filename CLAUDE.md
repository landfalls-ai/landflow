# Landflow

A low-code workflow platform modelled on n8n, where every node is a plugin written in any language (TypeScript, Python,
Go) and autodiscovered over HTTP, gRPC or a message broker. A pnpm monorepo: the host is `apps/web` (Next.js), the
engine, protocol, SDK, transports and CLI are in `packages/`, the Go and Python SDKs in `sdks/`, the bundled plugins in
`plugins/`, the code runner and broker bridge in `services/`, and compose, Dockerfiles and Kubernetes in `deploy/`.

## Read first

- `docs/constitution.md`: the rules every research and implementation starts from (non-negotiables, architecture,
  security, observability, UI, tests, docs, definition of done, the feature workflow). Loaded into every session:
  @docs/constitution.md
- `docs/README.md`: the docs index, with a feature map that names the page for each feature.
- `docs/architecture.md`: the processes, a run end to end, every subsystem and a code map.
- `docs/development.md`: setup, where each area's code starts, conventions, every test command and the
  `LANDFLOW_INTEGRATION` flags.
- `docs/limitations.md` and `docs/roadmap.md`: what is missing and what each wave built; `docs/history.md`: every
  change in order and the decisions along the way.
- `apps/web/AGENTS.md`: this Next.js version differs from older ones; read its guide in `node_modules/next/dist/docs/`
  before writing Next.js code.

## Conventions

- Migrations: append to `MIGRATIONS` in `apps/web/src/lib/server/db/schema.ts` (one SQL for SQLite and Postgres;
  never edit a shipped one; new tables also go in `TABLES`).
- Routes: `handler()`, `json()`, `error()` and `parseBody()` from `apps/web/src/lib/server/http.ts`; access rules in
  `apps/web/src/lib/server/auth/policy.ts`; public routes in `apps/web/src/lib/server/openapi.ts`.
- Tests sit next to their package; route tests call handlers directly as a synthetic owner (`apps/web/test/setup.ts`).
  Tests against real services skip unless `LANDFLOW_INTEGRATION` names them.
- Every change updates its docs: the feature page, `docs/reference/` for routes and variables, `docs/limitations.md`
  and `docs/roadmap.md` when it adds, closes or lifts something, and each commit gets a row in `docs/history.md`. New
  pages go in `docs/README.md`.

## Agents and the feature skill

- `.claude/agents/`: Claude Code subagents specialised for this repository: `landflow-researcher`, `landflow-planner`,
  `landflow-implementer`, the reviewers (`landflow-security-reviewer`, `landflow-code-reviewer`), `landflow-integrator`,
  and specialists for data, UI, AI, plugins, observability, tests, docs and local operations.
- `.claude/skills/landflow-feature/`: the pipeline a new feature follows (research → plan → implement in worktrees →
  review → integrate and gate → live check → secret scan → PR when asked). Use it for any feature or multi-step change.
- `docs/development.md` ("Working with Claude Code") explains how they fit together.

## Checking a change

```bash
(cd apps/web && npx vitest run) && pnpm typecheck
pnpm test                                     # the TypeScript packages
```

Run the suites for whatever else you touched: Go modules with `go test ./...`, the Python SDK and plugins with their
`.venv` and `unittest`. `docs/development.md` lists every command.

## Local only

- Run and deploy only on this machine: the OrbStack Docker engine and its Kubernetes cluster (`--context orbstack`,
  namespace `landflow-dev`). Never deploy to a cloud, and never push images.
- Build with `COMPOSE_BAKE=false`, and build cluster images with
  `docker --context orbstack buildx build --builder orbstack --load`.
- AWS calls go only to LocalStack at `http://127.0.0.1:54566`, with dummy keys and
  `AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null`.
- Use only the development credentials in `deploy/.env.example`.
- Don't hand-edit `apps/web/.data` (the live database, `credentials.json`, `encryption.key`).
- Other projects' containers share this Docker engine: touch only the `landflow-*` compose projects and the
  `landflow-dev` namespace, and don't prune.
