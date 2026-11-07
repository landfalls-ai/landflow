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
- **Commands**: `login`, `logout`, `whoami`; `workflows list/get/create/update/delete/activate/deactivate/publish/unpublish/schedules/unschedule` (by id or exact name; `publish` and `unpublish`, also top-level `landflow publish <wf>`, take `--at <ISO time | +30m | +2h | +1d>` to schedule, `schedules <wf>` lists the schedules and `unschedule <wf> <id>` cancels one); `run <workflow> [--input file|-] [--wait]`; `executions list/get/retry/stop/watch`; `debug-bundle <execution>` (a redacted folder: workflow JSON, run data, trace, node manifests, plugin versions and logs); `replay <bundle>` (a bundle's data pinned and run on a named scratch host); `claude init` (writes `.mcp.json` and a short skill for a local Claude Code); `import <file>…`; `export <workflow>… | --all [--dir]`; `data-tables list/rows`; `variables list/set/delete`; `sync pull/push/status/diff`; `source-control status/push/pull` (`push --workflow <ids>` commits only those workflows); `env status/promote/pull` (`pull --update-credentials`).
- **Output**: tables and text for people; with `--json` exactly one JSON document on stdout, `{ "ok": true, … }` or `{ "ok": false, "error": { "code", "message", "status"?, "details"? } }`. Exit codes: 0 ok, 1 error (also a failed execution under `run --wait`), 2 usage, 3 not found, 4 auth (401/403), 5 conflict, 6 host unreachable, 7 `--wait` timed out, 8 approval pending (four-eyes publishing: the publish became a request).
- Tests run the CLI against the web app's real route handlers behind a small HTTP server (`packages/cli/test/host.ts`), and the built binary as a child process.
