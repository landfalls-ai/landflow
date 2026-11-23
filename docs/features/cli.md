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
- **Commands**: `login`, `logout`, `whoami`; `workflows list/get/create/update/delete/activate/deactivate/publish/unpublish/schedules/unschedule` (by id or exact name; `publish` and `unpublish`, also top-level `landflow publish <wf>`, take `--at <ISO time | +30m | +2h | +1d>` to schedule, `schedules <wf>` lists the schedules and `unschedule <wf> <id>` cancels one); `run <workflow> [--input file|-] [--wait]`; `executions list/get/retry/stop/watch`; `debug-bundle <execution>` (a redacted folder: workflow JSON, run data, trace, node manifests, plugin versions and logs); `replay <bundle>` (a bundle's data pinned and run on a named scratch host); `debug-token --execution <id> [--ttl 1h] [--scopes executions:read,trace:read] [--label t]` with `--list` and `--revoke <token id>` (a short-lived read-only token for one execution, see the debug-token spec in the repository); `debug-node <execution> <node> --plugin-url http://localhost:PORT [--ttl 15m]` (runs one node of a recorded execution against a plugin on your machine through a single-use `runs:debug` token the command mints and spends; prints the result tagged as a debug run, exit 1 when the node fails; needs an owner to have turned the override on and allowed the plugin's host); `claude init` (writes `.mcp.json` and a short skill for a local Claude Code); `import <file>…`; `export <workflow>… | --all [--dir]`; `data-tables list/rows`; `variables list/set/delete`; `sync pull/push/status/diff`; `source-control status/push/pull` (`push --workflow <ids>` commits only those workflows); `env status/promote/pull` (`pull --update-credentials`); `work repos/collect/review/send/status/forget/context` (the daily offload and project context, below); `practices list/show/check/learn` ([below](#practices-landflow-practices)); `harness detect` and `harness watch codex` ([below](#installed-harnesses-landflow-harness-detect)).
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
landflow work context                      # the project goals this repository belongs to (reads only)
```

- **What it reads**: for each allowed repo, `git log` by your configured git user since the window (`--since today|yesterday|<ISO>`): commit subjects, branch names and the names of changed files, which are cut down to directories. With `gh` installed, `gh pr list --author @me` adds PR links and states. It never runs a diff or reads a file, and no model is involved: the title is "N commits on <branch>: first three subjects" joined with " · " (redacted, at most 200 characters), made the same way every time.
- **What is kept**: `~/.config/landflow/work/held.json` (and `repos.json`), mode 0600, up to 500 entries and 14 days. One entry per repo per day, `source` `landflow-cli`, `sourceId` `<owner>/<name>@<day>`; collecting the day again updates it, and once sent, sending it again updates the same row. A dropped day stays dropped when it is collected again, and a day older than 14 days is not kept (collect says so in a note).
- **What is sent**: only on `review --send` or `send`, in batches of 50, as `private` work events (`POST /api/brain/work`, key with `brain:write`). `send` and `review --send` away from a terminal need `--yes` and a host that allows it (`brain.workAutoSend`); if the setting can't be read they refuse. A title you edited with `review --title` survives collecting the day again. `forget` deletes on the host and here.
- **Scheduling** is documented, not installed: cron, launchd and Task Scheduler examples that run `landflow work collect` are in [the CLI README](../../packages/cli/README.md#daily-work-offload).
- **Project context**: `landflow work context [--repo owner/name] [--project <id>] [--size full|compact] [--json]` prints the "Where this work fits" block of the project that lists the repository (`GET /api/projects/context`, key with `brain:read`), then the other projects that list it. The repository defaults to the `origin` remote of the current directory, as for `practices`; `--project` asks for one project by id. It reads only and records nothing. With no project it says "No project lists <owner/name>." and exits 0; `--json` prints `{ repo, projects, context }`. The text is background for your work, not instructions. See [projects-and-goals.md](../projects-and-goals.md#in-claude-code-and-the-shell).
- The CLI keeps its own copy of the work-event contract (`packages/cli/src/work/contract.ts`; a test fails when it drifts from `packages/protocol/src/work-events.ts`) so the bundle stays one file with no dependencies.

## Your AI spend: `landflow spend`

```bash
landflow spend [--period 24h|7d|30d|90d] [--json]   # today, this month, the period by model, your caps with their forecast
```

Reads `GET /api/brain/my-spend` (the `brain:read` scope; `brain:write` includes it), the same answer as the AI page's You card. Only your own calls and caps, whoever you are; other people's spend is on the AI page ([llm-gateway.md](../llm-gateway.md#the-ai-page)). A local model nobody priced shows "not priced". `--json` prints `{ "ok": true, today, month, period, from, to, byModel, byPurpose, caps, … }`. A bad `--period` exits 2; a key without `brain:read` exits 4.

## Installed harnesses: `landflow harness detect`

Lists the coding harnesses of the [registry](../harnesses.md#live-status) (Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code,
OpenCode, Claude Desktop) with whether each is installed on this machine: a binary on `PATH` or one of its config files. The
version is the first dotted number `<binary> --version` prints, read within 2 seconds (a binary that hangs counts as
installed with no version). It needs no host and no login and sends nothing: no network request is made. `--json` prints
`{ harnesses: [{ id, label, installed, foundBy?, path?, version?, strategy }] }`.

### Watching Codex: `landflow harness watch codex`

`landflow harness watch codex [-- <codex args>]` runs `codex` on your terminal (arguments after `--` go to it) and tells Landflow
when a provider limit stops one of its turns, so the session shows as Blocked on `/connect` ([harnesses.md](../harnesses.md#live-status)).
It reads the rollout files of the sessions it starts (`$CODEX_HOME/sessions`, default `~/.codex/sessions`; a session that began
before the watch is never read) and sends one `quota_blocked` event per stopped turn to `POST /api/harness/codex/hooks`: the
session id, the kind (usage limit, credits depleted, unknown) and the provider's message, never a prompt, tool output or path.
It needs an API key with the `harness:write` scope. `landflow login` only saves a key you give it and creates none, so make one for the watch: the hook key from `/connect` (Live status, step 1) or a key from Settings → API keys with `harness:write` ticked, then `LANDFLOW_API_KEY=lf_… landflow harness watch codex` (a key without the scope is told so once and the watch goes on without reporting),
A Blocked Codex session stays Blocked until it goes stale: the watch sends no other event, and the host accepts no other event from a Codex session.
ends when `codex` exits and exits with its code. `--json` prints `{ harness, sessionsDir, exitCode, reported }`.

## Practices: `landflow practices`

The [practices](../practices.md) your admins approved, from a shell. No GitHub token is needed.

```bash
landflow practices list [--repo owner/name] [--project <id>] [--path <p>]…   # what applies; the repo defaults to this directory's origin
landflow practices show <handle>                                            # the approved rules and machine checks
landflow practices check [--base main] [--repo owner/name]                  # your change against the machine checks
landflow practices learn [paths…] [--repo] [--project <id>] [--topic <t>]…  # draft practices from this checkout
```

- **`list`** asks `GET /api/practices/applicable` with `size=full&preview=1` (a preview records nothing on the host).
- **`show`** reads the approved practice (`GET /api/practices?status=approved&q=<handle>`): its body and checks.
- **`check`** reads the files the branch changed (`git diff --name-status <base>...HEAD`: added and modified; a deleted file counts as gone) and their added lines (`git diff -U0`), asks `applicable` for the practices that apply to those paths (in groups of 20; when the host says some practices did not fit its block, the group is split and asked again down to single paths), reads each listed practice's approved checks by its `id` (`GET /api/practices/resolve?id=`, for the paths it was listed for, so it is never another practice of the same handle) and runs them here. Each practice with checks is `pass`, `FAIL` (required) or `warn` (recommended), with the files that failed; a practice with none says `no machine check`. The three kinds: `pathExists` (with `when`), `pathAbsent` (with `unless`) and `fileMatches` (a regular expression over a file's added lines, or never with `absent`). It exits 1 when a required practice fails and 0 otherwise (a recommended failure warns). Nothing is sent but the reads: no diff, file or path content leaves the machine except the paths in the `applicable` query. It runs no model; a practice with no machine check is for a person or a reviewer ([limitations](../limitations.md#practices-in-claude-code-and-the-shell)).
- **`learn`** reads up to 20 text files under the paths (default `CLAUDE.md` and `deploy/`; each at most 20,000 characters, binary or larger ones are listed as skipped; hidden folders, `node_modules` and the like are not walked), takes the commit from `git rev-parse HEAD`, and sends them with the repository to `POST /api/practices/learn`. That sends the files' text to your Landflow host. It prints the drafts with their links; a person approves each on `/brain` → Practices.
- `--json` prints one document each: `list` `{ repo, practices, text, omitted }`, `show` `{ practices }`, `check` `{ base, repo, changed, ok, omitted, moved, practices: [{ handle, version, strength, result, checks }] }`, `learn` `{ repo, sha, sent, skippedFiles, drafts, skipped }`.
- The glob and the three checks are `@landflow/protocol`'s (`practice-checks`, imported as a subpath so the CLI does not pull in zod), shared with the host's Check Practices step; the protocol's test and the host's glob test run the same table.
