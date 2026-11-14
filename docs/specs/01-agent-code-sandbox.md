# Per-run sandbox for Code nodes and agent code

Status: proposed. Closes the first bullet of [limitations.md](../limitations.md) ("Isolation") and the roadmap line
"Later, maybe: ... an agent code sandbox" ([roadmap.md](../roadmap.md), "Not planned").

## Problem

Three things run user or model-written code, and only one has a real boundary:

- **Code node, sandbox placement**: `placeCode()` in `apps/web/src/lib/server/code-runner.ts` sends the snippet to the
  code runner (`services/code-runner`, `POST /v1/run`). The runner makes a fresh child process per snippet, but all
  snippets share one long-lived container. The container is "the security boundary"
  ([deployment.md](../deployment.md#code-runner)); a snippet that escapes Node's permission model or the Python audit
  hook sits next to the runner's secret (`CODE_RUNNER_SECRET`), the next snippet's items and any binary in flight.
- **Code node, in-process placement**: `runInProcess()` in `apps/web/src/lib/server/nodes/code.ts` uses `node:vm`
  inside the host. `node:vm` is not a security boundary. It is on unless `LANDFLOW_CODE_IN_PROCESS=false` (compose sets it
  false; a pnpm dev host leaves it on).
- **Expressions and agent code**: `packages/engine/src/expression.ts` (`vm.createContext`) and `nodes/ai.ts`
  (`vm.runInNewContext`, a 100 ms calculator) also use `node:vm`. Agents have no code-execution tool today; an agent
  reaches code only through a Code node used as a tool or a workflow tool. A "run code" tool for agents is new work and
  must not ship on `node:vm`.

Started with pnpm (no container), the runner has only OS limits (`sandbox-exec`, `ulimit`), as `isolation.ts` says.

## Goals / Non-goals

Goals:
- Each snippet (or each run, see Design) executes in its own throwaway container with no network, no shared
  filesystem and no secret, so one snippet cannot see or affect another.
- A stronger kernel boundary where the host offers one: gVisor (`runsc`) as an OCI runtime, selected by config.
- One execution path for the Code node and a future agent code tool (same `RunRequest`/`RunResponse` protocol in
  `services/code-runner/src/protocol.ts`).
- Keep today's behaviour when no per-run backend is configured.

Non-goals:
- Replacing expression evaluation (`packages/engine/src/expression.ts`); expressions stay in `vm` with the existing
  guards. Moving them is a separate, larger change (latency per `{{ }}`).
- Network access from the sandbox, package installation, or long-lived interpreters (Jupyter style).
- Cloud runtimes (Firecracker fleets, Lambda). CLAUDE.md allows OrbStack Docker and its Kubernetes only.

## Design

**Backend abstraction in the runner.** Add `services/code-runner/src/backend.ts` with two implementations of "run one
`RunRequest`": `process` (today's `sandbox.ts` child process) and `container` (new). Selected by
`CODE_RUNNER_BACKEND=process|container` (new env var, default `process`). The HTTP surface, secret check, queue and
limits in `server.ts`/`config.ts` do not change.

**Container backend.** For each request the runner launches `docker run --rm` of the same image
(`landflow/code-runner:dev`) with entrypoint `child/js-runner.mjs` or `child/py_runner.py`, the request on stdin, the
response on stdout. Flags: `--network none`, `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m`,
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`, `--user 10001`, plus
`--runtime runsc` when `CODE_RUNNER_OCI_RUNTIME=runsc` (new). The runner needs to reach a Docker engine, which hands
it root-equivalent power; so the runner must not talk to the main socket. Options, in order of preference:
1. A small, separate **launcher** service (new, `services/code-launcher`) that is the only holder of the engine socket and
   exposes `POST /v1/exec` with a fixed argument set (no caller-chosen flags, image or mounts). The runner calls it with
   a second shared secret (`CODE_LAUNCHER_SECRET`, new). Compose runs it on an internal network.
2. On Kubernetes (OrbStack cluster, namespace `landflow-dev`): a `Job` per run created by a ServiceAccount allowed to
   create Jobs in that namespace only, with `runtimeClassName` from `CODE_RUNNER_RUNTIME_CLASS` (new). The cluster has
   no gVisor class today, so this is optional and off by default.
The launcher in (1) is the first slice; (2) is a follow-up.

**What counts as "per run".** Default is per snippet (one container per `POST /v1/run`). A per-execution mode
(`CODE_RUNNER_SCOPE=execution`, new) would reuse one warm container for the nodes of one execution id; it is out of the
first slice because it reintroduces cross-snippet state.

**gVisor is a probe, not a promise.** `isolation.ts` already probes the machine once at startup and `GET /v1/info`
reports layers. Add `container.runtime` (`runc` or `runsc`) there. `docker --context orbstack info` on this machine
lists only `runc`, so `runsc` can be verified only after installing it into OrbStack's engine, which is a machine-level
change the user must approve; the spec treats gVisor as optional and the container backend must work on `runc`.

**Data model.** No migration. No new table: runs are stateless. Settings are env vars only.

**Routes, policy, openapi.** None added to the web app. `GET /v1/info` on the runner gains the backend and runtime fields
(runner API, not the OpenAPI document). The host's `codeRunnerSettings()` stays as is; no new host variable is needed
unless a per-node `Run In: Isolated container` choice is added (see risks).

**Engine/UI.** `nodes/code.ts`: the `runIn` options stay (Default, Sandbox, In-process). The label of "Sandbox" gains the
backend from `/v1/info` in the node's description only. When `LANDFLOW_CODE_IN_PROCESS` is unset and a runner exists,
change nothing in this spec (compose already turns it off).

**Queue mode.** The runner is already shared by all mains and workers over HTTP and bounded by `concurrency` and
`maxQueue`. A container per snippet raises start-up cost (hundreds of ms), so keep `process` as the default and let
people opt in. The launcher enforces its own global cap so several runner replicas cannot exceed it.

**Local-only constraints.** Compose only (`deploy/compose.yml`), built with `COMPOSE_BAKE=false`, on the OrbStack engine,
touching only `landflow-*` projects. The launcher's socket mount is read from the OrbStack engine only; never push the
image. Kubernetes variant: context `orbstack`, namespace `landflow-dev`.

## Implementation plan

1. Extract the child-process path in `services/code-runner/src/sandbox.ts` behind a `Backend` interface; no behaviour
   change. Test: existing `services/code-runner/test` suite passes unchanged.
2. Add the `container` backend with an injectable "exec" function and a fake in tests. Test: unit test asserts the exact
   argument list (no network, read-only, caps dropped, memory/cpu/pids) and that stdout maps to `RunResponse`.
3. Add `services/code-launcher` (Go or Node, fixed argument set, secret check, global concurrency cap). Test: it refuses
   any extra flag, image, mount or missing secret; it kills and removes a container on timeout.
4. Compose wiring (`deploy/compose.yml`, `deploy/docker/code-runner.Dockerfile` or a new Dockerfile for the launcher),
   `deploy/scripts/code-runner-isolation.mjs` extended with: a snippet cannot reach the runner, the secret, `/proc/1`,
   another snippet's `/tmp`. Test: `LANDFLOW_INTEGRATION` flag for the stack (name it in `docs/development.md`).
5. `/v1/info` reports backend and runtime; the host test `apps/web/test/code-node.test.ts` checks the node still maps
   results and errors identically on both backends (fake runner).
6. Optional: `runsc` runtime flag and a documented manual install on OrbStack. Test: the isolation script run with
   `CODE_RUNNER_OCI_RUNTIME=runsc` when available, skipped otherwise.

## Docs to update

- [deployment.md](../deployment.md#code-runner): the backend choice, new variables, the launcher service, ports table.
- [architecture.md](../architecture.md#the-code-runner) and the services line of the code map.
- [limitations.md](../limitations.md): reword "Isolation" (container per snippet when enabled; `node:vm` still used
  in process and by expressions).
- [roadmap.md](../roadmap.md): move "an agent code sandbox" out of "Not planned" once the agent tool exists.
- [development.md](../development.md): the `LANDFLOW_INTEGRATION` flag and test commands; `docs/history.md` row per commit.

## Risks and open questions

- Giving any service the engine socket is the real risk; the launcher must be tiny, unexposed and tested for flag
  injection. Alternative: rootless Docker or a Kubernetes Job path only.
- Container start cost may break latency for loops over many items; the Code node already batches per node, not per
  item, but "run for each item" mode must stay one request.
- Binary transfer: today files travel inside `RunRequest.binary` (base64). Keep that, no volumes shared with the host.
- gVisor on OrbStack is unverified here. Python needs its standard library only, so `runsc` compatibility is likely but
  untested.
- Should an agent get a code tool at all? Decide separately; this spec only guarantees a safe path if so.

## Effort and first slice

Effort: **M** (container backend plus launcher), **L** if the Kubernetes Job path and gVisor are included.
First slice: steps 1 to 2 plus 4's isolation script on `runc`: a `container` backend that runs each snippet in
`--network none --read-only` with a fake-exec unit test, behind `CODE_RUNNER_BACKEND=container`, off by default.
