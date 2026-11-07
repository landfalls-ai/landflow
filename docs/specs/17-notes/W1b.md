# W1b notes (for the integrator)

## CLI reference text

`packages/cli/README.md` has the four rows (done). Add them to any `docs/reference/` CLI page: `debug-bundle`, `replay`, `claude init`, `executions watch`. They use the host's REST API and its instance MCP endpoint (`POST /api/mcp`, one stateless `tools/call` per request) with the CLI's API key as the bearer token.

## docs/limitations.md

- `landflow replay` does not start a scratch host: it needs `--target` (another host with its own data directory) and prints the steps without it. It restores no credentials or `$vars` (the bundle holds none) and pins only recorded outputs of nodes before the failed node; nodes after the pins run for real, so side effects need a scratch host with fakes. It does not run a remote plugin build.
- `debug-bundle` reads through the MCP server with the CLI's key: a host with MCP off, or a key the MCP server does not accept, lists explain_failure, trace, node types and plugin logs as skipped (the REST parts are still written). Plugin logs need an instance admin. Redaction is by key name, known `$vars` values, bearer tokens and `"secret": "..."` pairs inside JSON text: a secret in free text under an ordinary key is not found.
- `claude init` writes a `${LANDFLOW_API_KEY}` reference, so the key must be in Claude Code's environment and be one the MCP endpoint accepts (instance access token, MCP token, API key).

## docs/roadmap.md

W1b built: `landflow debug-bundle`, `replay` (minimal), `claude init`, `executions watch`. Open: a scratch host the CLI starts itself (`replay --spawn`), a fake-plugin transport for replay, W1c's debug token instead of an admin key, merging into an existing `.mcp.json`.

## docs/history.md row

`CLI: debug-bundle, replay, claude init, executions watch (W1b)`: a redacted folder about one execution (workflow, run data, explain_failure, trace, node types, plugin versions and logs); replay of a bundle on a named scratch host with upstream data pinned; `.mcp.json` and a skill for a local Claude Code; a node-progress watcher. Decisions: the CLI redacts a second time on top of the host's redaction; replay never starts a host and never touches the source host without `--same-host`; `claude init` never writes the key and never overwrites without `--force`.

## docs/README.md

No new page. The feature map row for the CLI can name the four commands.
