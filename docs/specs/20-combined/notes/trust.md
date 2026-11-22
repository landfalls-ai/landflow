# Notes for the integrator: P26 `trust` (C27)

## docs/limitations.md

- Add: the MCP Client Tool node in a flow is not held (C27-D6): only agents' MCP servers are compared with a published snapshot. A workflow-version equivalent (an opt-in "Hold Changed Tools" recorded at workflow publish) may follow.
- Add: a server whose tool descriptions or schemas carry volatile text (a timestamp, a count) changes at every listing and is held every run until a person approves; the agent's "Hold changed MCP tools" switch (Settings) turns the hold off for it.
- Add: a hold is per MCP server config of an agent, and the snapshot is whatever the config selected at publish; an agent that names its tools ("selected" or "except" with a list) is held only on tools in its snapshot, a tool the server added is not held unless the agent takes all tools.
- Add: a server that does not answer within 10 seconds at publish is snapshotted at the agent's first run after (marked "first seen at run", approved as the last publisher); until then nothing for that server is held, and an agent published before this change has the same gap until its first run.
- Add: trust covers marketplace node plugins and agents' MCP tools only. Plugins that announce over the registry (version audit only), Claude Code plugins packed for kagent (already pinned to a commit and packed into an image) and the Landflow MCP gateway's servers are not covered.
- Add: a marketplace install confirm without a `hash` (an API script) installs the files it downloaded and records their hash; only the drawer binds the yes to the files shown.
- Add: an update of a marketplace node plugin is an uninstall and an install, so the "changed since you approved" confirm appears at the install; there is no update button and no check for a newer commit.
- Add: an agent's own approval of a held change does not carry to a copy: an imported or transferred agent starts with no snapshot and takes its first view at its first run.

## docs/roadmap.md

- C27 (content-keyed trust: a `trust_records` table, canonical per-tool fingerprints, MCP tools snapshotted at publish and held when changed, the review banner and sheet, a Needs you item, marketplace node plugin installs asked by the hash): built. Open: the flows' MCP Client Tool (C27-D6), a descriptor hash for registry-announced plugins, an "approve all" for many agents, a cap on how long a hold may wait.

## docs/development.md

- Test list gains `trust-canonical.test.ts` (canonical form, the pure change list, the store on SQLite and a Postgres-mode `Database` over a fake sink), `trust-mcp-hold.test.ts` (a real MCP server whose tools the test edits: the hold, the switch, the snapshot at publish), `trust-routes.test.ts` (review routes, access, Needs you), `trust-marketplace.test.ts` (the staging, hash and confirm; the supervisor is stubbed), `trust-ui.test.ts` (happy-dom: banner, sheet, Needs you row, the switch, the drawer's confirm). Run `marketplace.test.ts` and `trust-marketplace.test.ts` one at a time.

## Other

- Migration 2928 (`trust_records`), `TABLES.trust_records`; audit labels `trust.approve`, `trust.reject`, `trust.revoke` (one block after `agent.tool_approval`). No new variable: nothing in `docs/reference/configuration.md`.
- `openapi.ts` and `docs/reference/api.md`: the agent routes are session-only API reads of an agent (not in the public spec before), so the rows are `GET/POST /api/agents/:id/trust` and the install route's `hash` and 409 `details.hash`.
- Deviations from the plan: `approveOnPublish` lives in `lib/server/trust/publish.ts` (not `mcp-tools.ts`: it lists through `agents/tools.ts`, which filters through `mcp-tools.ts`); the fingerprint also covers the tool `title` (the model sees it when there is no description); a viewer who may see the agent gets 403 (the platform's rule for a visible agent they may not change), only someone who cannot see it gets 404; the staging sweep runs at the start of each install (not at boot); the Needs you item is added inside `needsYou()` (not in the route); `NeedsYouRow` in `lib/client/run-trace.ts` gains the `trust` kind.
