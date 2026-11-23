# C36-A `outside-identity`: notes for the integrator

Branch `combined/outside-identity` (from `combined/access-outside` 0c5d1ac5). The package: sign-in and sessions of people without a Landflow account. Packages B (`outside-requests`: the C35 library made principal-aware, the public request and chat routes) and C (`outside-ui`: the page) build on the contract below.

## The contract, as built

- `lib/server/access/outside/identity.ts`: `type OutsideRequester = { id: string; email: string; name: string | null; verifiedBy: 'link' | 'google'; blocked: boolean }`; `getOutsideRequester(id)`; `outsideRequesterByEmail(email)` (canonical form); `requestLink`, `verifyLink`, `beginGoogle`, `completeGoogle`, `OutsideAuthError`, `mailSettled()` (tests).
- `lib/server/access/outside/sessions.ts`: `requesterFromRequest(req, options?): Promise<OutsideRequester | null>`; `endSessionsFor(requesterId)`; `startSession`, `endSession`, `pruneOutside(now)`.
- `lib/server/access/outside/http.ts`: `outsideRoute(fn, { write?, whenOff? })` (fn gets `{ req, requester, params }`; 401 `{ error: 'signed_out' }`), `outsidePublic(fn, opts)` (`{ req, params }`); cookie helpers.
- `lib/server/access/outside/settings.ts`: `outsideSettings()`, `domainAllowed(email)`, `googleReady()`.
- `lib/server/access/outside/limits.ts`: `takeOutside(bucket, key, limit, windowMs): boolean` (sliding window, this process), `takeOutsideShared(...)` (async, shared in queue mode).
- `lib/server/access/outside/store.ts` (new, mine): rows and queries, `canonicalEmail(email)` (lower case, local part cut at the first `+`), `hasSubaddress`, `landflowUserWithEmail`. B's `principal.ts` can re-export `canonicalEmail` instead of writing a second one.

## Deviations and choices to know

- Public sign-in routes use the plan's names (`sign-in/email`, `sign-in/verify`, `sign-in/google`, `sign-in/google/callback`, `sign-out`, `session`, `config`), not the shorter list in the brief.
- A write that is not JSON answers 415 (`json_only`); a cross-site write 403 (`cross_site`).
- `sign-out` is public (it works with an ended session) rather than session-only, so a stale tab can always sign out.
- `GET session` answers `chat: true`; B owns that flag (the chat cap of 0 turns it false): one line in `app/request-access/api/session/route.ts`.
- Housekeeping is opportunistic (each link and sign-in prunes) and `pruneOutside(now)` exists for the hourly pass; `access/sweeper.ts` is not mine, so the one-line call is left to B or the integrator.
- The IP-limit 429 on link asks is not audited (a flood would fill the log); the metric `auth limited` counts it.
- No new environment variable: the limits are constants (`OUTSIDE_LIMITS`). B adds `LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR`.
- `nodes/index.ts` registers `oidcClient` (stored type `core.oidcClient`) in this branch because the settings need the credential type; it is a one-line change.

## For limitations.md and roadmap.md (the integrator writes them)

- A mailbox reassigned inside an allowed domain can be signed into by the link method (the link proves the inbox, not the person); Google's `sub` pinning catches it for Google only. Block and removing the domain are the levers.
- The sign-in link is not tied to the asking browser (asking on a laptop, opening on a phone works): whoever holds the mail holds the link for 15 minutes.
- Only Google is a sign-in provider for outsiders (`hd` is Google's claim); Microsoft Entra (`tid`) is the next one. The credential type is a generic OpenID Connect client.
- Sessions and links live in the database copy each Postgres main reads: a Block reaches another main when its replication lands (seconds).
- `takeOutside` counts per process; use `takeOutsideShared` where several mains must agree.
- No CAPTCHA, no second factor for outsiders; the per-address, per-domain and per-network limits are the defence.
- The fake OIDC server binds a free port, so the credential's issuer is whatever `scripts/fake-oidc.ts` prints.
