# FinishDebugTokenUi notes (for the integrator)

Design: [19-debug-token.md](../19-debug-token.md), section "Debug access dialog". No new route, table or variable: `GET/POST /api/executions/:id/debug-tokens` and `DELETE …/:tokenId` already existed, with policy (`auth/policy.ts`) and OpenAPI entries, so nothing was added there. The only code change outside the UI is tests.

## docs/history.md row

| (commit) | Debug access dialog on the Run Trace page: mint (scopes, lifetime, label), the token shown once with copy buttons and ready `claude mcp add`, `.mcp.json` and `curl` snippets, the run's tokens listed (prefix, state, scopes, expiry, last use, calls) and revocable; one column, a bottom sheet on a phone. Tests for the list (last use, revoked rows, no token in the list, hidden from someone who cannot read the run) and for the snippet helpers. Checked live on a scratch host: mint, use over curl, listed with last use, revoke, refused with 401 |

## docs/limitations.md

Replace "There is no page for tokens yet: mint, list and revoke through REST or `landflow debug-token`" in the Debug tokens bullet with: "Tokens are minted, listed and revoked from the Debug access button on the Run Trace page (one run at a time), REST or `landflow debug-token`; there is no instance-wide list of tokens in Settings."

## docs/roadmap.md

Where the W1c row lists "a page for tokens" as open, mark it built (the dialog); the Settings-wide list stays open.

## docs/README.md

No new page. The feature map row for debugging can mention "Debug access on the Run Trace page" next to the debug-token spec link.

## docs/reference/api.md

No change (routes unchanged).

## Not done

- No Debug access button on the classic execution detail page (`/workflows/:id/executions/:id`), only on the Run Trace page it links to.
- Snippets use `window.location.origin`: behind a proxy whose public URL differs from the address the page was opened on, edit the host in the snippet.
- A per-minter token cap is still open (spec).
- Dev note for live checks: open the scratch host as `http://localhost:<port>`, not `127.0.0.1`, or Next dev blocks its client scripts and the sign-in form does not hydrate; cookies are shared by hostname across ports, so another host on localhost can sign you out.
