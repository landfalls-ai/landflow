# W1a notes: debugging a remote workflow over the instance MCP server

For the integrator: the rows to merge into the shared docs.

## Feature page text (docs/reference, the instance MCP server)

**New and changed tools** of `/api/mcp` (now 16; each is checked like the first 11: a workflow the caller cannot see is "not found", `run` is needed to retry or run a node; the debugging tools return text redacted of credential values of the workflow's nodes, `$vars` values, external-secret values and any key named like a secret, with long text cut to 3,000 characters):

| Tool | Does |
|---|---|
| `get_node_type` | now includes `outputSchema` (the fields one output item holds) when the node declares it |
| `validate_workflow` | now warns when an expression (`{{ $json.x }}`, `$input.first().json.x`, `$('Node').item.json.x`, `$node["Node"].json.x`) or a Code node's JavaScript reads a field the node before it does not write, with a "Did you mean" hint. Fields come from the selected operation's or the node's `outputSchema`, else from the last five runs of a saved workflow; a node with neither is never flagged |
| `explain_failure` | one call for a failed execution: failing node (type, plugin, credential names), error text, node logs, parameters raw and resolved against the input it got (`$vars` masked), a sample input item, per upstream node its output fields (actual and declared), field mismatches, and a `whatToCheck` list |
| `get_run_trace` | the Run Trace journal of an execution, paged by `after` (seq) and `limit` (default 200, max 500) |
| `get_plugin_logs` | recent logs of an installed node plugin, named by installed id, plugin id or a node type; instance admins only, not on project-scoped servers |
| `retry_execution` | the execution retry as a tool: from the failed node or `start`, on the `original` or `current` version; waits for the result unless `wait: false` |
| `run_node` | run one node of a saved workflow on pinned input items, or on the input of an earlier execution (`fromExecution`); saves a manual execution |

## limitations.md

- The expression field check reads only the top-level fields of what a node writes, from its `outputSchema` or the last five runs: a field that appears only in some runs, or after the workflow changed, can raise a warning that does not apply. It covers JavaScript Code nodes and `{{ }}` expressions, not Python code or computed keys.
- `run_node` runs one node with the input you pin: `$('Other node')` reads nothing unless `fromExecution` is given.
- `get_plugin_logs` has nothing for plugins started with `LANDFLOW_PLUGINS`; only marketplace-installed node plugins keep logs.

## roadmap.md

- W1a: the instance MCP server can debug a failed run (`explain_failure`, `get_run_trace`, `get_plugin_logs`, `retry_execution`, `run_node`) and `validate_workflow` catches a read of a field the node before it does not write. Open: W1b (CLI bundle, `landflow claude init`), W1c (debug token).

## history.md row

| W1a | Instance MCP debugging tools: `outputSchema` on `get_node_type`; `validate_workflow` checks expression field reads against `outputSchema` or the last run (fixture: a Code node reading `$json.browserSnapshot` after the Browser node, which writes `snapshot`); new tools `explain_failure`, `get_run_trace`, `get_plugin_logs`, `retry_execution`, `run_node`, redacted of credentials and `$vars`. `lib/server/mcp/{debug-tools,expression-fields}.ts`, tests in `apps/web/test/mcp-debug.test.ts`. | (hash) |

No route was added, so `policy.ts` and `openapi.ts` are unchanged. `apps/web/test/mcp.test.ts` lists the tools: its expected list gained the five names.
