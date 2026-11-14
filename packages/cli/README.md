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

The key (Settings → API keys, `lf_…`) is sent as `Authorization: Bearer <key>`. Commands work without a key against a host that lets them through; otherwise they exit 4. What a key may do depends on its scopes: `workflows:read` for listing and exporting, `workflows:write` for changes, `run` for `run`, `executions:read`/`executions:write` for executions, `admin` for `sync push`, `sync status` and `source-control`; `env status` needs `workflows:read`, `env promote` and `env pull` an admin.

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
| `audit verify` | the host checks the audit log's hash chain (every event's hash and link, the newest against its head record): exit 0 when intact, exit 9 (`integrity_failed`, the report in `error.details`) when broken |
| `audit verify --head <file> [--public-key <pem file>]` | checks a signed chain head offline, without the host: the Ed25519 signature over the exact payload text, against the key you pinned (without `--public-key` it proves only that the head is consistent); exit 9 when it doesn't check out. Accepts a head file from `audit head --out`, a copy anchored in S3 or at a webhook, or the whole `audit head --json` document |
| `audit head [--out file]` | the newest signed head (`head`, `signedAt`, `anchoredAt`, `keys`); exit 3 before the first signature |
| `audit key [--out file]` | the public keys that signed heads; `--out` saves the current one as PEM, to pin for `audit verify --public-key` |
| `env status` | the host's environment (`LANDFLOW_ENVIRONMENT`), whether it is protected, its branch, the environments it promotes to, publish on pull and credential mappings |
| `env promote <environment> [--workflow w]… [--from env] [--rows table]… [--no-rows] [--no-credentials] [--dry-run] [--diff] [--force] [--prune] [-m msg]` | copy workflows from this environment's branch (or `--from`'s) to another's: all, or the `--workflow`s (id or name), with the definitions of the credentials they use (no secret values; `--no-credentials` leaves them out) and the rows of the tables opted in on the host (`--rows` names them for this promotion, `--no-rows` sends none); `--dry-run --diff` previews with unified diffs; a workflow edited on the target branch since the last promotion is a conflict (exit 5, the preview in `error.details`) unless `--force`; `--prune` (all workflows only) removes what the source no longer has; with four-eyes on, the promotion waits for another owner or admin (exit 8, the request in `error.details.request`) |
| `debug-bundle <execution> [--out d] [--force] [--trace-limit n] [--no-logs]` | writes a redacted folder about one execution: `workflow.json`, `execution.json`, `run-data.json`, the host's `explain_failure` and `get_run_trace` (`explanation.json`, `trace.json`), `node-types.json`, `plugins.json`, `plugin-logs/`, `bundle.json` (failed node, redaction counts, what was skipped) and a README. Credentials keep a name and type; `$vars` values, secret-named keys, bearer tokens and API keys are redacted. What the key may not read (plugin logs need an instance admin) is skipped and listed. Run data is still your data: read the folder before sharing it. The MCP tools get the CLI's key as a bearer token (a host with its MCP server off lists them as skipped) |
| `replay <bundle> [--target url] [--target-key k] [--pin upstream\|trigger\|none] [--same-host] [--keep]` | copies the bundle's workflow to `--target`, pins the recorded output of the nodes before the failed node (`--pin trigger`: only the trigger), runs it and says whether it ended as the original did. It does not start a host, restore credentials or `$vars`, or stub the nodes after the pins. Without `--target` (or with the host the bundle came from, unless `--same-host`) nothing runs and the exact steps are printed. The copy is deleted unless `--keep` |
| `claude init [--dir d] [--force] [--offline]` | writes `.mcp.json` (the host's `/api/mcp`; the key is `${LANDFLOW_API_KEY}`, never written) and `.claude/skills/landflow/SKILL.md` (workflow JSON format, the tools, the host's node types). Files that exist are left alone and listed, unless `--force` |
| `executions watch <id> [--timeout s] [--interval ms]` | prints a line whenever a node starts, ends or fails, until the execution ends; exit 1 when it failed, 7 on timeout. `--json`: one document with the final execution and `events` |
| `debug-token --execution <id> [--ttl 1h] [--scopes executions:read,trace:read] [--label t]` | mints a short-lived read-only token (`lf_dbg_…`, shown once) bound to that one execution, for an agent that explains a failed run: it opens `explain_failure`, `get_run_trace` and `get_execution` at the host's `/api/mcp` and nothing else (every other tool and REST route refuses it), redacted of credentials and `$vars`, audited per call. Default 1 h, at most 24 h. `--list` shows the execution's tokens, `--revoke <token id>` closes one. Needs read access to the execution and the host's MCP server on |
| `env pull [--dry-run] [--prune] [--force] [--publish file\|all\|none]` | apply this environment's branch, like `source-control pull`; `--publish` defaults to the environment's publish on pull (`file`: what the files say) |
| `work repos add [<path>] \| remove <path> \| list` | the allow-list of working copies `landflow work` may read (kept in `work/repos.json` next to the config file); `add` records the path and its `origin`'s `owner/name` |
| `work collect [--since today\|yesterday\|<ISO>] [--repo <path>]…` | reads the day's commits (subjects, branches, directories touched) and, when `gh` is installed, your PRs, in the allowed repos; summarises them here without a model and holds one entry per repo per day (`work/held.json`, 0600). Nothing is sent. Collecting a day again updates its entry |
| `work review [--send <id\|all>] [--drop <id>] [--title <id> <text>]` | lists what is held; sends, drops or retitles entries |
| `work send [--yes]` | sends everything held (batches of 50, private). Asks on a terminal; without one it needs `--yes`, and the host must allow tools to send work (`brain.workAutoSend`) |
| `work status` | what was sent, with ids |
| `work forget <sourceId>` | deletes a sent entry on the host (`DELETE /api/brain/work/:sourceId?source=landflow-cli`) and here |

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
| 8 | waiting for approval | `approval_pending`: four-eyes publishing is on, so `workflows publish`, `unpublish`, `activate` and `deactivate` recorded a request another person approves (Settings → Governance); `status: 202`, `details: { workflowId, request }` with the request's `id`, `kind` and `status: "pending"`; `env promote` made a promotion request (Settings → Environments → Promotion requests), `details: { request }` with its `id`, `source`, `target` and `status: "pending"` |
| 9 | integrity check failed | `integrity_failed`: `audit verify` found the hash chain broken (`details` is the chain report with `brokenAt`) or `audit verify --head` found a signed head that doesn't verify (`details: { verified: false, reason }`) |

`sync diff --exit-code` and `sync status --exit-code` exit 1 with `ok: true` when there are differences.

### Daily work offload

`landflow work` is for people who do not use Claude Code. It never reads a diff or a file: only commit subjects (redacted, clipped), branch names, the directories touched (two path levels, never a file name) and counts, plus PR links and states from `gh pr list` when `gh` is on the PATH. Entries use the source `landflow-cli` and `sourceId` `<owner>/<name>@<day>`, so a day collected again updates the same row in the brain. `--json` prints `{ ok, entries | sent | refused, … }`; an entry is `{ id, sourceId, status: held|sent|dropped, day, title, repo, branch, commits, areas, prs, heldAt, sentAt, serverId, error }`. Held entries are kept 14 days at most, 500 at most.

Scheduling is yours to set up; run `collect` only, and review by hand:

```bash
# cron: every weekday at 18:00
0 18 * * 1-5  /usr/local/bin/landflow work collect
```

```xml
<!-- ~/Library/LaunchAgents/com.landflow.work.plist, then: launchctl load ~/Library/LaunchAgents/com.landflow.work.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.landflow.work</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/landflow</string><string>work</string><string>collect</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
</dict></plist>
```

```powershell
# Windows Task Scheduler, every day at 18:00
schtasks /Create /SC DAILY /ST 18:00 /TN "Landflow work collect" /TR "landflow work collect"
```

Add `landflow work send --yes` to the job only if you want unattended sending and your admin allows it.

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
| `env status` | `environment: { name?, protected, protectedSource: 'env' \| 'settings' \| 'none', branch?, environments: [{ name, branch, current }], publishOnPull: 'file' \| 'all' \| 'none', credentialMap: [{ type, name, credentialId, credentialName? }], sourceControl }` |
| `env promote` | `dryRun`, `promoted`, `from: { environment, branch, commit }`, `to: { environment, branch, commit? }`, `entries: [{ id, name, path?, targetPath?, status: 'added' \| 'modified' \| 'unchanged' \| 'deleted', conflict?, fields?, diff? }]` (`diff` with `--diff`), `conflicts`, `files: [{ status, path, diff? }]` (folders, variables, credentials, tables and their rows), `credentials: [{ name, type, status, secretFields, mapped }]`, `tables: [{ id, name, path, rows, status }]`, `digest`, `commit?`, `warnings`; a conflict exits 5 with this object in `error.details`, an approval request exits 8 with `{ request }` there |
| `env pull` | as `source-control pull` |

## Development

```bash
pnpm --filter @landflow/cli test        # vitest: the CLI in-process against the web app's real route handlers, and the built binary
pnpm --filter @landflow/cli typecheck
```

`test/host.ts` serves `apps/web/src/app/api/**/route.ts` through a small `node:http` server with a temporary data directory, routing paths the way Next does. Requests without credentials run as a test owner, as in the web tests; requests with an API key go through the real key check.
