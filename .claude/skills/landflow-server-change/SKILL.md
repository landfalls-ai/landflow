---
name: landflow-server-change
description: "Adds or changes a Landflow host feature across its layers: an API route with handler(), a policy rule, a zod schema, a service, a database migration and table, a background job, tests, OpenAPI for a public route, docs and a history row, then runs the checks. Use when asked to add an endpoint or route, add a table or migration, change the store, add a setting or environment variable, add a background service, or fix a server bug in apps/web. For a feature that spans several areas or needs research, a plan and review, use landflow-feature instead."
---

# Change the Landflow host

How to add to `apps/web/src/lib/server` and `apps/web/src/app/api` without breaking the rules the tests enforce. The
reasons and the layer map are in `docs/platform/server-layers.md`; the rule list is `docs/constitution.md`.

## 0. Where am I?

- If `docs/platform/server-layers.md` exists locally, read it and `docs/constitution.md` first.
- If not (you build on Landflow from another repository), a server change belongs in the Landflow repository itself.
  Read `https://github.com/landfalls-ai/landflow/blob/main/docs/platform/server-layers.md` and
  `https://github.com/landfalls-ai/landflow/blob/main/docs/constitution.md`, and make the change on a branch of a clone of
  `https://github.com/landfalls-ai/landflow`. For a new node or plugin you do not need this skill: use a plugin skill.

Work on a branch, never on `main`. For this Next.js version, read the guide in `apps/web/node_modules/next/dist/docs/`
before writing Next.js code (`apps/web/AGENTS.md`).

## 1. Find the sibling

Grep for the nearest existing route and domain and copy its shape. A model route is `apps/web/src/app/api/goals/route.ts`
(thin route), with `lib/server/goals/schema.ts` (zod), `goals/views.ts` (rules and access) and `goals/store.ts` (data).
Two ways of doing one thing is a bug. Write down which files you will touch before you edit.

## 2. The layers, in order

1. **Migration** (only if you need data). Append an entry to `MIGRATIONS` in `apps/web/src/lib/server/db/schema.ts` with
   a version above the current highest (run `grep -o "version: [0-9]*" apps/web/src/lib/server/db/schema.ts | sort -t' ' -k2 -n | tail -1`;
   versions are not in file order). One SQL text for SQLite and Postgres: `TEXT`, `BIGINT`, `DOUBLE PRECISION`, JSON in
   `TEXT`, `ON CONFLICT` upserts. Never edit a shipped migration. A column a shipped `CREATE TABLE` gained later goes in
   `addColumns`. Add the table and its primary key columns to `TABLES` in the same file.
2. **Schema**: a zod schema for the body or query (`lib/server/<domain>/schema.ts`, or `lib/server/schemas.ts` for shared
   shapes). Use `z.strictObject` for a body, bound every string and array.
3. **Store**: plain data in `lib/server/<domain>/store.ts` using `database()`: `all`, `get`, `upsert`, `insertNew`,
   `delete`, `transaction`. SQL uses `?` parameters, never pasted values. Lists are capped and keyset-paged. A change
   of several rows runs in one `transaction()`.
4. **Service**: the rules and the access check (`requireResource`, `canResource`, `filterVisible` from
   `lib/server/projects/access.ts`). A 404, not a 403, when the caller may not know the thing exists. Record
   `recordAudit()` here (not in the route) for every security-relevant change. Throw `HttpError`
   (`lib/server/errors.ts`); a domain error extends it and has `static readonly errorName: string = 'Name';` first in its body.
5. **Route**: `apps/web/src/app/api/<path>/route.ts`. Wrap each method in `handler()`, validate with `parseBody()` /
   `parseQuery()`, answer with `json()` / `error()` (all from `lib/server/http.ts`), call the service. Put what the route
   does and who may call it in the top comment. Dynamic params arrive as a promise: `{ params }: { params: Promise<{ id: string }> }`.
   Never `request.json()`, never `Number(param)` into a query, never import `lib/server/db` from a route.
6. **Policy**: add a line to `routePolicy()` in `apps/web/src/lib/server/auth/policy.ts` before the final fallback:
   `if (under('/api/<thing>')) return { scope: read ? 'workflows:read' : 'workflows:write' };`. Without a line, an API key
   needs the `admin` scope. If a path names a workflow, credential, data table, agent or execution, check whether
   `resourceRule()` already covers it.
7. **Configuration**: a new environment variable is an entry of `CONFIG_CATALOG` in `lib/server/config/catalog.ts`, read
   with `envInt`, `envFlag`, `envString` or `envUrl`; then `pnpm --filter @landflow/web gen:config-docs`.
8. **Background work**: a new entry in `SERVICES` in `lib/server/runtime.ts` (with `roles`, `leader: true` for leader-only
   work, and a `stop`). Process-wide state only through `singleton()`.
9. **Public API**: if it is part of the public API, add it to `lib/server/openapi.ts` (`add('post', '/api/...', { tag, id, summary, body, responses })`).
   `test/openapi.test.ts` fails when a documented path is not a real route.
10. **UI** (if any): use the shared components in `apps/web/src/components/ui`, the words in `docs/ui-review.md`, and check at
    1440 by 900 and 390 by 844. A client poll uses `api(path, { background: true })`.

Outbound URLs a user or model can influence go through `safeFetch` (`lib/server/net/safe-fetch.ts`). Logs use `logger`
from `lib/server/telemetry`, with no secrets. A list is never unbounded.

## 3. Tests

Tests sit in `apps/web/test`. A route test imports the handler and calls it with a `Request`; `test/setup.ts` signs the
call in as a synthetic owner. Set the environment before a dynamic import, with a fresh data directory:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-x-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { GET, POST } = await import('@/app/api/<path>/route');
const post = (body: unknown) => POST(new Request('http://localhost:3000/api/<path>', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
```

For access tests (who may see what), copy `test/goals.test.ts`: it calls `disableTestAuth()` and signs in real users with
`createOwner` / `createUser` and `createSession`. Add a test that fails without your change. A test that needs a real
service skips unless `LANDFLOW_INTEGRATION` names it. A test file that writes shared state sets its own `LANDFLOW_DATA_DIR`.

The enforcing tests to know: `policy-coverage.test.ts` (every mutating route has an entry or its own check),
`migrations-order.test.ts`, `error-mapping.test.ts` (an `errorName` per domain error), `execution-reads.test.ts` (finished
runs are read through the async seam), `config-catalog.test.ts` (every variable catalogued, the page generated),
`openapi.test.ts`.

## 4. Docs

In the same change: the feature's page under `docs/` (`docs/README.md` has the feature map), the route in
`docs/reference/api.md`, `docs/limitations.md` and `docs/roadmap.md` when it adds or closes something, and a row at the
end of the table in `docs/history.md` (`| (this change) | what changed, in plain words | [page](link) |`). A new page goes
in `docs/README.md`.

## 5. Check

```bash
(cd apps/web && npx vitest run test/<yours>.test.ts test/policy-coverage.test.ts test/migrations-order.test.ts test/openapi.test.ts)
pnpm typecheck
# before a pull request, the whole gate:
(cd apps/web && npx vitest run) && pnpm typecheck && pnpm test && pnpm check:deps
```

`pnpm check:deps` enforces the layers (no server code importing components, no `lib/shared` importing server values, no
routes importing `lib/server/db`, no new import cycles). A change to the boot (`lib/server/runtime.ts`, `bootstrap.ts`,
`lifecycle.ts`), `instrumentation.ts`, `proxy.ts` or anything the worker imports also needs `next build`
(`cd apps/web && rm -rf .next && npx next build`, then restore `next-env.d.ts`) and the queue stack's end-to-end script
(`docs/constitution.md`, "Testing and the regression gate"). When several agents share the machine, run typecheck and
your own test files and leave the full suite to the integrator.

## 6. Traps

- A route with no policy line is admin-only for API keys; a mutating route with neither a line nor a check fails
  `policy-coverage.test.ts`.
- A migration numbered below an existing one runs in a different order on old and new databases: always above the highest.
- `store.getExecution` is for runs in flight; a finished run is `await store.loadExecution(id)`.
- Never call a feature from the store; emit an event and subscribe at boot (`execution-reactions.ts`).
- Never hand-edit `apps/web/.data`. Use a scratch data directory.
- Never commit, push or merge unless the person asked. Scan a diff for secrets and personal data before any push; the repo is public.
