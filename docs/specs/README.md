# Specs

Proposals and plans written before the code. Each states a status and date, the problem, the decisions needed, the design, a phased plan,
risks, open questions and what is not planned.

| Spec | Status | What it covers |
|---|---|---|
| [16-chat-with-agents.md](16-chat-with-agents.md) | proposed (2026-11-07) | One chat in front of several agents or a team, attribution, a roster the visitor picks from, voice. |
| [17-parallel-build-plan.md](17-parallel-build-plan.md) | proposed (2026-11-07) | Landing the 2026-11-07 session and splitting what it left open across parallel worktrees; notes in [17-notes](17-notes). |
| [18-desktop-agent-node.md](18-desktop-agent-node.md) | proposed (2026-11-07) | A Desktop agent node: an agent loop driving a disposable virtual desktop by screenshot, mouse and keyboard; the sandbox; image tool results; Run Trace; the standalone-product question. |
| [19-debug-token.md](19-debug-token.md) | built (2026-11-07), except the one-node override | A short-lived read-only token bound to one execution, accepted only by a three-tool MCP server; REST routes and `landflow debug-token`. |
| [20-sap-plugin.md](20-sap-plugin.md) | phases 1 to 4 built (2026-11-07) | An SAP S/4HANA Cloud plugin (Public Edition first): a metadata-driven OData node and curated presets, a credential type, a polling trigger and an event trigger (webhook), read-only agent tool with approval-gated writes, a fake S/4HANA server for tests, a go/no-go list and phases. Phases 0, 5 and 6 and decision D6 are open. |
