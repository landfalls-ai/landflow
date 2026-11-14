# Specs

Proposals and plans written before the code. Each states a status and date, the problem, the decisions needed, the design, a phased plan,
risks, open questions and what is not planned.

| Spec | Status | What it covers |
|---|---|---|
| [01-agent-code-sandbox.md](01-agent-code-sandbox.md) | proposed (2026-11-05) | A per-run sandbox for Code nodes and agent code. |
| [02-guard-enforcement.md](02-guard-enforcement.md) | proposed (2026-11-05) | Guard enforcement outside the landflow-harness mod. |
| [03-durable-pause.md](03-durable-pause.md) | proposed (2026-11-05) | A durable pause and take-over of team members. |
| [04-auto-runbook.md](04-auto-runbook.md) | proposed (2026-11-05) | A runbook made automatically when a Landfall war room ends. |
| [05-runbook-plugin-steps.md](05-runbook-plugin-steps.md) | proposed (2026-11-05) | Runbook steps that call a plugin node. |
| [06-brain-auto-apply.md](06-brain-auto-apply.md) | proposed (2026-11-05) | The second brain auto-applies a named set of low-risk suggestions, with undo and audit. |
| [07-postgres-lazy-loading.md](07-postgres-lazy-loading.md) | partly built (2026-11-13: run data kept hot in Postgres mode, `LANDFLOW_PG_HOT_MINUTES`) | Lazy loading and paging for the largest tables in Postgres mode. |
| [08-durable-telemetry.md](08-durable-telemetry.md) | proposed (2026-11-05) | Durable local telemetry: a PVC, retention, and the first-increment gap. |
| [09-shared-trace-comments.md](09-shared-trace-comments.md) | proposed (2026-11-05) | Shared Run Trace line comments. |
| [10-more-webhook-triggers.md](10-more-webhook-triggers.md) | proposed (2026-11-05) | Webhook triggers for Jira, Linear, Shopify and Notion. |
| [11-per-rule-switch-outputs.md](11-per-rule-switch-outputs.md) | proposed (2026-11-05) | Per-rule outputs for Switch and Text Classifier. |
| [12-agent-evals.md](12-agent-evals.md) | proposed (2026-11-05) | Agent evals: saved task sets, run on every change, scored and diffed. |
| [13-public-run-report-link.md](13-public-run-report-link.md) | proposed (2026-11-05) | A public run report link: signed, expiring, read-only, redacted. |
| [14-composite-governance-rules.md](14-composite-governance-rules.md) | first slice built (2026-11-14) | Composite governance rules ("AI calls only inside an AI step"); see [composites.md](../composites.md#governance-rules). |
| [15-live-integration-checks.md](15-live-integration-checks.md) | proposed (2026-11-05) | Live checks of the Landfall node and trigger and the GitHub MCP tools. |
| [16-chat-with-agents.md](16-chat-with-agents.md) | proposed (2026-11-07) | One chat in front of several agents or a team, attribution, a roster the visitor picks from, voice. |
| [17-parallel-build-plan.md](17-parallel-build-plan.md) | proposed (2026-11-07) | Landing the 2026-11-07 session and splitting what it left open across parallel worktrees; notes in [17-notes](17-notes). |
| [18-desktop-agent-node.md](18-desktop-agent-node.md) | proposed (2026-11-07) | A Desktop agent node: an agent loop driving a disposable virtual desktop by screenshot, mouse and keyboard; the sandbox; image tool results; Run Trace; the standalone-product question. |
| [19-debug-token.md](19-debug-token.md) | built (2026-11-07), except the one-node override | A short-lived read-only token bound to one execution, accepted only by a three-tool MCP server; REST routes and `landflow debug-token`. |
