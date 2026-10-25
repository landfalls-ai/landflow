# @landflow/cli

`landflow`: the Landflow command line. Workflows, runs, executions, data tables, variables and Git sync of workflows as files, from a terminal, a script or CI. Every command prints a table or text for people, or with `--json` one JSON document with a stable shape.

```bash
pnpm --filter @landflow/cli build          # → dist/main.js: one ESM file, Node 22+, no runtime dependencies
node packages/cli/dist/main.js --help       # from the repository root; or `pnpm landflow --help`
```

`dist/main.js` is the package's `bin` (`landflow`): link or copy it anywhere Node runs (`ln -s "$PWD/packages/cli/dist/main.js" ~/bin/landflow`). pnpm does not put a workspace package's own `bin` on its PATH, so `pnpm --filter @landflow/cli exec landflow` does not find it; use `node packages/cli/dist/main.js` or the root script `pnpm landflow …`.

## Connecting

| Setting | Where it comes from, first match wins |
|---|---|
| Host URL | `--url`, `LANDFLOW_URL`, the config file, `http://localhost:3000` |
| API key | `--api-key`, `LANDFLOW_API_KEY`, the config file, none |

`landflow login [--url <url>] [--api-key <key>]` checks the key against the host (`--no-verify` skips that) and saves both to `~/.config/landflow/config.json` (`$XDG_CONFIG_HOME/landflow/config.json`, or `LANDFLOW_CONFIG`), mode 0600 in a 0700 directory. Run interactively without flags, it asks; the key prompt doesn't echo. `landflow logout` removes the file. `landflow whoami` shows the host, where each setting came from, the key's user and scopes.

The key (Settings → API keys, `lf_…`) is sent as `Authorization: Bearer <key>`. Commands work without a key against a host that lets them through; otherwise they exit 4. What a key may do depends on its scopes: `workflows:read` for listing and exporting, `workflows:write` for changes, `run` for `run`, `executions:read`/`executions:write` for executions, `admin` for `sync push`, `sync status` and `source-control`.

## Commands

Workflows are named by id or by exact name (case-insensitive; an ambiguous name is a usage error).

| Command | |
|---|---|
| `login`, `logout`, `whoami` | see above |
| `workflows list [--search t] [--tag t] [--folder f] [--active\|--inactive]` | workflows, sorted by name |
| `workflows get <workflow>` | details and nodes; `--json` prints the whole document |
| `workflows create --file <path\|-> [--name n] [--folder f]` | create from Landflow JSON (`{ workflow }` wrappers and `export` output work; credential references by name are matched to the host's credentials) |
| `workflows update <workflow> [--file <path\|->] [--name n]` | the file's fields replace the saved ones; saving an active workflow makes a draft, publish it to go live |
| `workflows delete <workflow> [--yes]` | asks first; without a terminal it needs `--yes` |
| `workflows activate\|deactivate <workflow>` | publish / unpublish (older hosts without draft and publish: the `active` flag) |
| `workflows publish <workflow> [--version <id>] [--note t]`, `workflows unpublish <workflow>` | draft and publish; `--version` publishes an older version (a rollback) |
| `run <workflow> [--input <file\|->] [--wait] [--timeout s] [--start-node n] [--idempotency-key k]` | start a manual run; the input is an object (one item) or an array (items). `--wait` polls until it ends and exits 1 if it failed |
| `executions list [--workflow w] [--status s] [--limit n]` | newest first (default 20) |
| `executions get <id> [--data]` | status, each node's runs and items, the last node's output; `--data` adds the raw run data |
| `executions retry <id> [--from failed\|start] [--version original\|current] [--wait]` | retry a failed or canceled execution |
| `executions stop <id>`, `executions stop --all` | stop one (exit 5 when it already ended), or everything |
| `import <file\|->… [--name n] [--folder f]` | Landflow or n8n workflow JSON, one workflow or an array (n8n's `export:workflow --all`); nodes n8n has and Landflow doesn't become disabled placeholders, listed in the report |
| `export <workflow>…`, `export --all [--dir d] [--values]` | the Git sync documents (credentials as `{ name, type }`): printed, or written into `--dir` in the sync layout (`--all --dir` mirrors the instance) |
| `data-tables list`, `data-tables rows <table> [--limit n] [--offset n] [--search t] [--sort col] [--desc]` | tables by id or name |
| `variables list`, `variables set <key> <value>`, `variables set <key> --value-file <file\|->`, `variables delete <key>` | `$vars` |
| `sync pull\|push\|status\|diff [--dir d]` | Git sync, below |
| `source-control status\|push\|pull` | the host's own Git (Settings → Source control): `push [-m msg] [--dry-run]`, `pull [--dry-run] [--prune] [--force]` |

`landflow <command> --help` lists a command's options. Global options: `--json`, `--url`, `--api-key`, `--help`, `--version`.

## Git sync

`landflow sync` keeps a directory of files in step with an instance; commit the directory to Git. The layout (`landflow-sync/v1`) is the same one Settings → Source control commits (README "Git sync"): `landflow-sync.json`, `variables.json` (names; values with `--values`), `credentials.json` (names and types only), `data-tables/<slug>.schema.json`, and `workflows/` with one directory per folder (`.folder.json`) and a `<slug>.workflow.json` per workflow, pretty-printed in a fixed key order.

```bash
landflow sync pull --dir flows            # instance → files
$EDITOR flows/workflows/ops/nightly-report.workflow.json
landflow sync diff --dir flows            # unified diff: instance (a/) → files (b/)
landflow sync push --dir flows --dry-run  # the plan
landflow sync push --dir flows            # files → instance (creates and updates by id)
landflow sync push --dir flows --prune    # …and deletes what has no file
git -C flows add -A && git -C flows commit -m "Nightly report: retry twice"
```

- `pull` writes only the files the format owns and removes those the instance no longer has; anything else in the directory stays. A file edited since the last pull is not overwritten (exit 5, the paths in `error.details.conflicts`) unless `--force`. Variable values are written only with `--values`, and later pulls remember it.
- `push` sends every managed file to `POST /api/sync/apply`. Workflows, folders and data tables are matched by `id` (a new file without one gets an id derived from its path), variables by key. Deletes need `--prune`. Changes the instance made since this directory last synced with it are conflicts: nothing is applied (exit 5, the plan in `error.details`) unless `--force`. Files that don't parse or validate stop the push before anything changes (exit 1, `sync_failed`). A workflow whose file says `"active": true` is published.
- `status` is a dry-run push (`--prune` counts deletes) plus the files edited locally since the last sync; `--exit-code` exits 1 when they differ.
- `diff [paths…]` prints a unified diff that `git apply` accepts; differences of key order or whitespace alone are skipped. `--exit-code` exits 1 when there are differences.
- The directory remembers, per instance URL, the files and the instance's state as of the last pull or push in `.landflow/state.json` (git-ignored by `.landflow/.gitignore`). That is what makes the conflict checks work, and lets one directory be pulled from staging and pushed to production.

## JSON output

With `--json` a command prints exactly one document on stdout, nothing on stderr, and exits with its code:

```jsonc
{ "ok": true, /* the command's fields */ }
{ "ok": false, "error": { "code": "not_found", "message": "No workflow with the id or name \"x\"", "status": 404, "details": { } } }
```

`status` is the HTTP status when the host answered one; `details` is there when there is more to say. The shapes below are the contract: fields may be added, but not renamed or removed without a major version.

### Exit codes and error codes

| Exit | Meaning | `error.code` |
|---|---|---|
| 0 | done | |
| 1 | it failed | `server_error`, `bad_request`, `io` (a file), `not_supported` (the host lacks the route), `execution_failed` (`run --wait`, `executions retry --wait`; the execution in `details.execution`), `sync_failed` (the plan in `details`), `internal` |
| 2 | wrong usage | `usage`, `config` |
| 3 | not found | `not_found` |
| 4 | authentication or permission | `unauthorized` (401), `forbidden` (403) |
| 5 | conflict | `conflict` (409/423, sync conflicts, a running execution that ended) |
| 6 | the host can't be reached | `network` |
| 7 | `--wait` gave up | `timeout` (`details: { executionId, status }`) |

`sync diff --exit-code` and `sync status --exit-code` exit 1 with `ok: true` when there are differences.

### Shapes

```ts
type WorkflowSummary = { id: string; name: string; active: boolean; folderId: string | null; tags: string[]; nodeCount: number; updatedAt: string | null };
type ExecutionSummary = {
  id: string; workflowId: string; workflowName: string;
  status: 'running' | 'queued' | 'waiting' | 'success' | 'error' | 'canceled'; mode: string;
  startedAt: string; durationMs: number; error: { message: string; node: string | null } | null;
};
type ExecutionDetail = ExecutionSummary & {
  finishedAt: string | null; retryOf: string | null;
  waitingFor: { node: string; resume: string; until: string | null } | null;
  nodes: Array<{ id: string; name: string; status: string; runs: number; items: number; error: string | null }>;
  output: unknown[];          // the last node's first output, item JSON, at most 100
  runData?: object;           // executions get --data
};
type SyncChange = {
  kind: 'workflow' | 'folder' | 'variable' | 'dataTable'; action: 'create' | 'update' | 'delete';
  id: string; name: string; path?: string; fields?: string[];
  conflict?: string;          // held back: changed on the instance since the last sync
  skipped?: 'prune';          // a delete that needs --prune
};
```

| Command | `--json` fields (besides `ok`) |
|---|---|
| `--version` | `version` |
| `--help` | `version`, `commands: [{ name, summary, usage }]` |
| `login` | `url`, `apiKey` (masked, `lf_…abcd`, or null), `configPath`, `verified`, `user: { id, email, name, role } \| null` |
| `logout` | `configPath`, `removed` |
| `whoami` | `url`, `urlSource`, `apiKey` (masked), `keySource` (`flag`, `env`, `config`, `default`, `none`), `user`, `via` (`session`, `api-key`, …), `scopes: string[] \| null`, `host: { status, workflows, nodeTypes, plugins }` |
| `workflows list` | `workflows: WorkflowSummary[]` |
| `workflows get` | `workflow` (the full document, as `GET /api/workflows/:id` answers it) |
| `workflows create`, `workflows update` | `workflow` (full), `warnings: string[]` |
| `workflows delete` | `deleted: { id, name }` |
| `workflows activate`, `workflows deactivate` | `workflow: WorkflowSummary` |
| `workflows publish`, `workflows unpublish` | `workflowId`, `published: { versionId, versionNumber, publishedAt } \| null`, `unpublishedChanges`, `triggerErrors: [{ nodeName, message }]` |
| `run` | `executionId`, `workflowId`, `status: 'running'`, `duplicate?: true`; with `--wait`: `workflowId`, `duplicate?`, `execution: ExecutionDetail` |
| `executions list` | `executions: ExecutionSummary[]` |
| `executions get` | `execution: ExecutionDetail` |
| `executions retry` | `executionId`, `retryOf`, `status: 'running'`; with `--wait`: `retryOf`, `execution: ExecutionDetail` |
| `executions stop` | `executionId`, `stopped: true`, `previousStatus`; with `--all`: `all: true`, `stopped: { running, waiting, queued, retries }` |
| `import` | `imported: [{ file, workflow: WorkflowSummary, report: { format: 'landflow' \| 'n8n' \| …, placeholders: [{ name, type }], warnings: string[] } }]` |
| `export` | `workflows: [{ id, name, path, document }]`; with `--dir`: `dir`, `workflows: [{ id, name, path }]`, `written: string[]`, `removed: string[]` |
| `data-tables list` | `tables: [{ id, name, columns: [{ name, type }], rowCount, updatedAt }]` |
| `data-tables rows` | `table: { id, name, columns }`, `rows: object[]` (with `id`, `createdAt`, `updatedAt` and the columns), `total`, `offset`, `limit` |
| `variables list` | `variables: [{ key, value }]` |
| `variables set` | `variable: { key, value }`, `created` |
| `variables delete` | `deleted` (the key) |
| `sync pull` | `dir`, `url`, `dryRun`, `values`, `written: string[]`, `removed: string[]`, `unchanged`, `conflicts: string[]` (local edits overwritten or, refused, in `error.details`), `summary: { workflows, folders, variables, dataTables, credentials }` |
| `sync push` | `dir`, `url`, `dryRun`, `applied`, `appliedCount`, `changes: SyncChange[]`, `conflicts` (a count), `warnings: string[]`, `errors: string[]` |
| `sync status` | `dir`, `url`, `inSync`, `lastSync: string \| null`, `changes: SyncChange[]`, `conflicts`, `warnings`, `local: { added, modified, deleted }` |
| `sync diff` | `dir`, `url`, `files: [{ path, status: 'added' \| 'removed' \| 'modified', diff }]` (`added`: only in the directory), `identical` (a count) |
| `source-control status` | `sourceControl: { configured, config?, tokenSource, credentialName?, workingCopy, lastPush?, lastPull? }` |
| `source-control push` | `dryRun`, `committed`, `commit?`, `branch`, `files: [{ status: 'A' \| 'M' \| 'D', path }]` |
| `source-control pull` | `dryRun`, `applied`, `appliedCount`, `changes: SyncChange[]`, `conflicts`, `warnings`, `errors`, `commit`, `branch` |

## Development

```bash
pnpm --filter @landflow/cli test        # vitest: the CLI in-process against the web app's real route handlers, and the built binary
pnpm --filter @landflow/cli typecheck
```

`test/host.ts` serves `apps/web/src/app/api/**/route.ts` through a small `node:http` server with a temporary data directory, routing paths the way Next does. Requests without credentials run as a test owner, as in the web tests; requests with an API key go through the real key check.
