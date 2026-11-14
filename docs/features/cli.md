# CLI

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

`packages/cli` is the `landflow` command line: workflows, runs, executions, data tables, variables and Git sync from a terminal or CI, with a stable JSON output for scripts ([packages/cli/README.md](../../packages/cli/README.md) has every command and the JSON contract).

```bash
pnpm --filter @landflow/cli build                  # → packages/cli/dist/main.js (one file, Node 22, no dependencies)
node packages/cli/dist/main.js login --url http://localhost:3000 --api-key lf_…   # or: pnpm landflow login …
landflow workflows list
landflow run "Daily report" --input input.json --wait --json | jq .execution.output
landflow executions list --status error
landflow import n8n-export.json                     # Landflow or n8n workflow JSON
landflow export --all --dir ./flows
landflow sync pull --dir ./flows && landflow sync push --dir ./flows --dry-run
```

- **Connection**: `--url`/`--api-key`, else `LANDFLOW_URL`/`LANDFLOW_API_KEY`, else what `landflow login` saved in `~/.config/landflow/config.json` (mode 0600; `$XDG_CONFIG_HOME` or `LANDFLOW_CONFIG` move it), else `http://localhost:3000` without a key. The key goes out as `Authorization: Bearer lf_…` (Settings → API keys).
- **Commands**: `login`, `logout`, `whoami`; `workflows list/get/create/update/delete/activate/deactivate/publish/unpublish/schedules/unschedule` (by id or exact name; `publish` and `unpublish`, also top-level `landflow publish <wf>`, take `--at <ISO time | +30m | +2h | +1d>` to schedule, `schedules <wf>` lists the schedules and `unschedule <wf> <id>` cancels one); `run <workflow> [--input file|-] [--wait]`; `executions list/get/retry/stop/watch`; `debug-bundle <execution>` (a redacted folder: workflow JSON, run data, trace, node manifests, plugin versions and logs); `replay <bundle>` (a bundle's data pinned and run on a named scratch host); `debug-token --execution <id> [--ttl 1h] [--scopes executions:read,trace:read] [--label t]` with `--list` and `--revoke <token id>` (a short-lived read-only token for one execution, see [specs/19-debug-token.md](../specs/19-debug-token.md)); `claude init` (writes `.mcp.json` and a short skill for a local Claude Code); `import <file>…`; `export <workflow>… | --all [--dir]`; `data-tables list/rows`; `variables list/set/delete`; `sync pull/push/status/diff`; `source-control status/push/pull` (`push --workflow <ids>` commits only those workflows); `env status/promote/pull` (`pull --update-credentials`); `work repos/collect/review/send/status/forget` (the daily offload, below).
- **Output**: tables and text for people; with `--json` exactly one JSON document on stdout, `{ "ok": true, … }` or `{ "ok": false, "error": { "code", "message", "status"?, "details"? } }`. Exit codes: 0 ok, 1 error (also a failed execution under `run --wait`), 2 usage, 3 not found, 4 auth (401/403), 5 conflict, 6 host unreachable, 7 `--wait` timed out, 8 approval pending (four-eyes publishing: the publish became a request).
- Tests run the CLI against the web app's real route handlers behind a small HTTP server (`packages/cli/test/host.ts`), and the built binary as a child process.

## Recording your day: `landflow work`

For people who do not use Claude Code, `landflow work` collects the day's activity, summarises it on the machine and sends it to the [company brain](../work-and-briefings.md) only when a person says so.

```bash
landflow work repos add ~/code/widgets     # allow a working copy; its origin names it (owner/name)
landflow work collect                      # today's commits and PRs → held entries; nothing is sent
landflow work review                       # what is held; --drop <id>, --title <id> "text", --send <id|all>
landflow work send                         # everything held (asks; without a terminal it needs --yes)
landflow work status                       # what was sent, with ids;  landflow work forget <sourceId> deletes one
```

- **What it reads**: for each allowed repo, `git log` by your configured git user since the window (`--since today|yesterday|<ISO>`): commit subjects, branch names and the names of changed files, which are cut down to directories. With `gh` installed, `gh pr list --author @me` adds PR links and states. It never runs a diff or reads a file, and no model is involved: the title is "N commits on <branch>: first three subjects" (redacted, at most 200 characters), made the same way every time.
- **What is kept**: `~/.config/landflow/work/held.json` (and `repos.json`), mode 0600, up to 500 entries and 14 days. One entry per repo per day, `source` `landflow-cli`, `sourceId` `<owner>/<name>@<day>`; collecting the day again updates it, and once sent, sending it again updates the same row.
- **What is sent**: only on `review --send` or `send`, in batches of 50, as `private` work events (`POST /api/brain/work`, key with `brain:write`). `send` and `review --send` away from a terminal need `--yes` and a host that allows it (`brain.workAutoSend`); if the setting can't be read they refuse. A title you edited with `review --title` survives collecting the day again. `forget` deletes on the host and here.
- **Scheduling** is documented, not installed: cron, launchd and Task Scheduler examples that run `landflow work collect` are in [the CLI README](../../packages/cli/README.md#daily-work-offload).
- The CLI keeps its own copy of the work-event contract (`packages/cli/src/work/contract.ts`; a test fails when it drifts from `packages/protocol/src/work-events.ts`) so the bundle stays one file with no dependencies.
