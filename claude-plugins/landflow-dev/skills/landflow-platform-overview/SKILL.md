---
name: landflow-platform-overview
description: "Orients Claude in Landflow, the plugin-based workflow platform (host, engine, plugins, SDKs, transports, agents, brain, gateways, Kubernetes), or in a repository that builds on it. Use when asked what Landflow is, where something lives, how a run works, which doc or skill covers a question, how to run Landflow locally, or before starting any Landflow task you have not mapped yet."
---

# Landflow: find your way

Use this first when a task touches Landflow and you do not yet know where the code or the doc is. It points; it does not
repeat. The deep pages are in `docs/platform/`.

## 0. Where am I?

1. Is there a `docs/platform/overview.md` in the working tree? Then this is the Landflow repository: read local files.
2. If not, you are in a repository that builds on Landflow (a plugin, a flow, a client). Read the same pages from GitHub:
   `https://github.com/landfalls-ai/landflow/blob/main/<path>`, for example
   `https://github.com/landfalls-ai/landflow/blob/main/docs/platform/overview.md`. Fetch a page when you need it; do not
   guess at paths, names or routes from memory. The repository is public.

In the Landflow repository also read `CLAUDE.md` (it imports `docs/constitution.md`: the rules) and `docs/development.md`.

## 1. What it is, in one paragraph

Landflow is a low-code workflow platform modelled on n8n. Every node is a plugin written in any language (TypeScript,
Python, Go) and autodiscovered over HTTP, gRPC or a message broker. The host (`apps/web`, Next.js) runs workflows with
an engine (`packages/engine`), calls plugins through a transport it picks per call, and adds agents, agent teams, a
second brain, an LLM gateway (LiteLLM) and an MCP gateway (agentgateway). It runs locally on Docker and Kubernetes
(OrbStack). Read `docs/platform/overview.md` for the whole picture.

## 2. Which page answers the question

| The question | Read | Skill |
|---|---|---|
| What are the processes, how does a run go, where is the data, who may do what | `docs/platform/overview.md` | this one |
| Add or change a route, a table, a service, a background job | `docs/platform/server-layers.md` | `landflow-server-change` |
| Make, publish, test or call an agent or a team | `docs/platform/agents.md` | `landflow-agents` |
| Run, change or check Landflow in Kubernetes | `docs/platform/kubernetes.md` | `landflow-kubernetes` |
| Write a plugin (any language) | `docs/platform/sdk/README.md` and the language page | `landflow-plugin-typescript`, `landflow-plugin-python`, `landflow-plugin-go` |
| A feature's behaviour in full | the feature map in `docs/README.md` | |
| The plugin wire contract | `docs/protocol.md` | |
| Brokers, Auto, MCP faces | `docs/transports.md` | |
| What is missing, and what each wave built | `docs/limitations.md`, `docs/roadmap.md`, `docs/history.md` | |
| Every route / every environment variable | `docs/reference/api.md`, `docs/reference/configuration.md` | |
| A new feature, end to end (research, plan, build, review) | `.claude/skills/landflow-feature` (this repository only) | `landflow-feature` |

## 3. Where the code is

```
apps/web/                 the host: src/app (pages and API routes), src/components, src/lib/server, src/lib/shared, test/
packages/engine/          the executor          packages/protocol/   the wire contract
packages/sdk/             TypeScript plugin SDK packages/transports/ messaging core and broker drivers
packages/cli/             the landflow CLI      sdks/go, sdks/python the Go and Python SDKs
plugins/                  bundled plugins       services/code-runner, services/landflow-bridge
deploy/                   compose, Dockerfiles, Kubernetes, gateway configs, scripts
docs/                     every document
```

Server code is under `apps/web/src/lib/server/<domain>/`; the first file to open for a route is
`apps/web/src/app/api/<path>/route.ts`. For a run: `lib/server/runner/run.ts`, then `packages/engine/src/executor.ts`.

## 4. Run it locally (this repository)

Needs Node 22 or later with pnpm 10, plus Go and Python for the plugins in those languages, and Docker for the infra.

```bash
pnpm install
(cd plugins/py-insights && ./setup.sh)        # the Python plugin's .venv, only if you run that plugin
pnpm dev                                      # the host on http://localhost:3000
pnpm dev:all                                  # the host plus the bundled plugins
```

Open `http://localhost:3000` (use `localhost`, not `127.0.0.1`: Next's dev scripts are blocked on the IP). A fresh
instance opens on `/setup`, which creates the owner. The host keeps its data in `apps/web/.data` (SQLite,
`credentials.json`, `encryption.key`): never edit it by hand; use the UI, the API or the CLI, and a scratch
`LANDFLOW_DATA_DIR` for experiments. `docs/development.md` has every other command (the infra stack, the queue stack,
every test suite).

Check a change: `(cd apps/web && npx vitest run) && pnpm typecheck`, then `pnpm test`, and `pnpm check:deps` for the
import rules. Run the Go (`go test ./...`) and Python (`.venv/bin/python -m unittest`) suites for what you touched.

## 5. Rules that are easy to break

- **Local only.** Run and deploy only on this machine: OrbStack Docker and its Kubernetes (`--context orbstack`,
  namespace `landflow-dev`). Never deploy to a cloud and never push images. AWS calls go only to LocalStack at
  `http://127.0.0.1:54566` with dummy keys. Use only the development credentials in `deploy/.env.example`.
- **Shared engine.** Other projects' containers share the Docker engine: touch only `landflow-*` compose projects and
  the `landflow-dev` namespace, and never prune. Build with `COMPOSE_BAKE=false`.
- **A person in the loop.** AI changes are proposals a person applies; nothing merges, deletes or sends for them.
- **Docs move with code.** Every change updates its feature page, `docs/reference/` for routes and variables,
  `docs/limitations.md` and `docs/roadmap.md` when it adds or closes something, and adds its history rows as a fragment in `docs/history.d/` (never edits `docs/history.md` on a package branch; the integrator runs `pnpm history:assemble`).
- **Commit, push and merge only when the person asks.** Work on a branch.

## 6. Out of scope

Cloud deployment, pushing images, real vendor tokens, editing `apps/web/.data`, and a hosted CI (none exists by
decision). If a task needs one of them, say so and stop.

## 7. Traps

- The docs and the code can disagree. The code wins; say so in your report.
- `docs/specs/` holds proposals for features not built yet. Do not describe a spec as if it were built.
- Spotlight (the builder chat) is changing; read `docs/assistant.md` and `docs/spotlight.md` for what is current before
  describing it.
