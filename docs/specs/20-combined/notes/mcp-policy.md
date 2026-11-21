# Notes: C14 MCP policy hook (P14 `mcp-policy`)

## docs/limitations.md

- MCP policy hooks cover what goes through Landflow's MCP client (`callMcpTool`, `readMcpResource`, `getMcpPrompt`): not kagent agents' direct MCP calls, not calls through the agentgateway, not inbound calls to Landflow's own MCP server, not non-MCP tools.
- A standalone agent chat (no workflow node) has no span: the model reads the denial and the audit event and counter still record it, but there is no `policy` check (`activeNode()` is empty there).
- Where the `policy` check does not land on a span: `aroundNode` is passed only by `runner/run.ts` and `mcp/trigger.ts` (every `executeWorkflow` caller in the host), so workflow runs, sub-workflows and tool sub-runs are covered. Not covered, the check is missing but the audit event and counter still record the decision: standalone agent sessions (test chat, A2A, channels, schedules of an agent), team runs on the agent runtime, and Spotlight or architect calls outside a run (`activeNode()` is empty there).
- The request carries no agent version or team (the usage scope does not hold them yet).
- The allow cache (60 s) is per process and per run: a worker that did not see the allow asks the hook again.
- Arguments reach the hook whole (never cut, 256 KB cap for the request); values under secret-looking keys are masked and listed in `masked`, so a service cannot see them. Receivers must reject stale timestamps (over 5 min) and repeated `requestId`s.
- A hook cannot rewrite arguments, only allow or deny; credential injection is C26.
- A tool's read-only flag (`AgentTool.readOnlyHint`) is the MCP server's own hint, not a guarantee; nothing here relies on it for safety.
- `mcp/approval-mode.ts` still reads `process.env` directly.
- `docs/limitations.md` "Outbound address policy": remove "the agent policy webhook (`agents/policy.ts`)" from the not-covered list; it now goes through `safeFetch`.

## docs/roadmap.md

- C14 built: MCP policy hooks (Settings → MCP → Policy hooks), the `policy` check on the Run Trace span, `mcp.policy.*` audit events, the `landflow.mcp.policy.decisions` counter, and the engine seam (`report` on `aroundNode`, `AgentTool.readOnlyHint`) that C13 uses. The tool-access engine moved onto `safeFetch`.

## docs/README.md

No new page (the feature map line for "MCP governance" may add: policy hooks, in [features/audit-and-governance.md](features/audit-and-governance.md#mcp-policy-hooks)).

## For the integrator and P13

- T-1 (the seam) is its own commit on `combined/w3-mcp-policy`; P13 rebases on it. `ActiveNode.report` is set by `runInNode` from what the engine passes.
- Audit actions are `mcp.policy.denied`, `mcp.policy.failed`, `mcp.policy_hook.create|update|delete` (the plan's names; the spec text says `mcp.call_denied` and `mcp.policy_hook_failed`).
- Six OpenAPI operations (the five plus the test route) and one `api.md` row group are in.
- No SQL migration (2921 stays free). No new configuration variable.
