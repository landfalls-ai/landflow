# Notes for the integrator: P25 `secret-routes` (C26)

Apply after the last merge of W4b; `docs/history.d/2026-11-22-c26-secret-routes.md` is the history row.

## docs/limitations.md

- Secret routes (C26) send one static header per host from a Bearer Auth or Header Auth credential, for Claude Code agents on kagent only. No OAuth2 or other refreshing credentials, no per-request signatures, no body or query substitution, no per-call session tokens (a lease from C30 could feed a route later), and no Landflow-run proxy in the request path.
- A host belongs to one route of an agent, and a route's header is one per host (the gateway's destination has one `authentication`).
- The rotation timer runs every minute on the leader, 50 agents a tick: an instance with more than 250 routed agents rewrites a changed Secret later than the five minutes the spec asks.
- The gateway's swap was proven only in unit tests against a fake Kubernetes API; the live check on `kind-landflow-kagent` is still open (needs the person's yes, C26-D1).

## docs/roadmap.md

- Built: C26 agent secret proxy (narrow): secret routes on the kagent card, `<name>-routes` Secret and EgressPolicy, keyed-hash drift, leader rotation timer, audit `kagent.route.*`, Run Trace connection rows.
- Open: the kind live check (C26-D1); C30 dynamic secrets feeding a route with a lease; routes for non-Claude runtimes (their tools go through Landflow's MCP endpoint, so none planned).

## docs/development.md (test list)

- Secret routes: `cd apps/web && npx vitest run test/kagent-routes.test.ts test/kagent-routes-deploy.test.ts test/kagent-route-refresh.test.ts test/kagent-routes-ui.test.ts` (rules, vault and objects, deploy and status against a fake Kubernetes API, the refresh timer, the editor); the header-recording upstream is `@landflow/test-fakes/upstream`.

## docs/README.md

- No new page; the feature map's kagent row may link [a2a.md#secret-routes](../../a2a.md#secret-routes).
