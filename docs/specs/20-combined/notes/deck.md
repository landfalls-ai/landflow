# Notes for the integrator: P32 `deck` (C33)

## docs/README.md

- Feature map: add a row "dot-agent-deck from a flow: a Dispatch node that starts a unit in the person's deck and resumes a Wait when it reports (opt-in plugin, run in a deck pane, `pnpm plugin:deck`)" linking [plugins/deck](../plugins/deck/README.md) and [harnesses.md](harnesses.md#dot-agent-deck-from-a-flow). In the plugins row at the end, add `[deck](../plugins/deck/README.md)`.

## docs/development.md

- Add `deck` to the `pnpm plugin:...` list (7122 / 7222, not in `dev:all`), and `pnpm --filter @landflow/plugin-deck test` (a fake `dot-agent-deck` script on PATH through `LANDFLOW_DECK_BIN`; no deck, no container) to the plugin suites.

## docs/limitations.md

- Add: the deck plugin runs only inside a deck pane, because the deck's `dispatch` and `inbox` commands refuse outside one; it must be started by hand there, and closing that pane ends it. It ships Dispatch only (Delegate is orchestrator-only in the deck).
- Add: the plugin's watches live in memory: a plugin restart loses them and the run's Wait times out while the unit keeps running. Completion is matched on the deck's wording (commit 720a5f05); a deck release that rewords it breaks the match.
- Add: the deck's spans and a run's spans are joined in the collector by the unit name (`deck.unit.name`, `landflow.execution.id` on the Dispatch span), not parented: the deck ignores `TRACEPARENT`.
- Add: a dispatched unit runs as the person on the deck's machine; a unit's own command is off unless `LANDFLOW_DECK_ALLOW_COMMAND=1`. The plugin never runs `trust approve`.

## docs/roadmap.md

- C33 (dot-agent-deck as a sibling): built as `plugins/deck` (Dispatch, watches, Report To). Open, for the person to raise with the deck project: a token-authenticated dispatch and inbox entry outside a pane; `TRACEPARENT` honoured on dispatch. Later: a deck view in Landlens; Delegate if the deck lets a non-orchestrator use it.

## docs/transports.md (and docs/protocol.md if it lists the HTTP faces)

- Add: a plugin may opt in to an **HTTP guard** (`serve(plugin, { guardHttp: true })`, `@landflow/sdk/guard`): its POST routes and `/mcp` refuse requests that carry an `Origin` header or `Sec-Fetch-Site` other than `none`, bodies that are not `application/json`, and calls without the `x-landflow-plugin-token` header (an HMAC of `LANDFLOW_TRANSPORT_SECRET`, else `LANDFLOW_REGISTRY_SECRET`); `serve()` refuses to start without a secret. The host sends the token on every HTTP call to a plugin when it holds a secret (`lib/server/plugins/clients.ts`); plugins that do not opt in ignore it and behave as before. The deck plugin is the first user.

## docs/limitations.md (additions to the deck lines above)

- Add: the deck plugin's report is untrusted text from the unit (`trust: "untrusted"`, the deck's wrapper kept); `status` is `completed`, `failed`, `timed_out` or `inbox_unreadable`. One item per run when Report To is set; unit names must be unique across flows; the 50-watch cap is shared by every flow that uses the plugin. The gRPC face of the plugin is not guarded (a browser cannot reach it).

## Residual: the token follows the id the plugin reports

The host takes the plugin id for the HTTP guard token from the plugin's own well-known document. A plugin registering under another
plugin's id would therefore be sent that plugin's token. The registry does not refuse or replace a second registration under an
existing id: it adds the endpoint to the plugin (replica join) and the newest manifest wins. Refused: a built-in id, and (for an
announce without a proof) a join from another host unless `LANDFLOW_REGISTRY_ALLOW_JOIN=true` (`lib/server/plugins/registry.ts`
`connectEndpoint`, `registry-policy.ts`). A proven announce (same `LANDFLOW_REGISTRY_SECRET`) is not host-checked. So the guard is
the secret itself: whoever holds it can join as any plugin, and a joined endpoint receives that plugin's calls anyway.
Possible hardening, not done: the host pins each plugin's endpoints to the first registrant unless a person approves the join.
