# Notes for the integrator: C36-B `outside-requests`

## docs/limitations.md (Access requests)

- Add: an outside requester's email is trusted as typed and proven by a link or Google; a mail alias a server maps to another address (`robert@` to `bob@`) can't be seen, so self-approval by email compares only the canonical address (lower case, the part after `+` cut). The approver's question shows the address.
- Add: the outsider's GitHub username is typed and unverified, as a Landflow user's; it is unique across users and outside requesters.
- Add: `ext_…` ids show as ids where a screen resolves names with `getUser` (usage by user, the Run Trace of an outsider's chat run).
- Add: a blocked requester's grants stay until they end or are revoked; Block cancels only waiting requests.
- Add: the outsiders' chat is limited per requester and for the whole instance, and the run's model spend counts under the `ext_…` id.

## docs/roadmap.md

- C36-B built: the access library works for outside requesters (principal.ts, kind columns, self-approval by email, the outsider's allow-listed views, cancel and give back, the chat) and the public request routes. Next: the page (C36-C), sign-in and sessions (C36-A), an embeddable widget, Entra, the Landbright identity backend.

## docs/README.md

- No new page; access-requests.md gained "Outside requesters: what they can ask and see".

## docs/development.md

- Tests: `access-outside-requests.test.ts` (C36-A's identity, session, settings modules mocked), `access-outside-requests-chat.test.ts` (limits mocked, a fake model).

## For C36-A (merge points)

- `requests.ts` exports `cancelOpenRequestsOf(requesterId, auditActor): Promise<number>`: call it from Block (cancels waiting requests, audited `access.request.cancel` with `reason: blocked`).
- `chat.ts` exports `outsideChatPerHour()`: the `session` route's `chat` flag is `outsideChatPerHour() > 0` and the chat flow is installed.
- `principal.ts` exports `outsideStanding(requester)` (enabled, domain allowed, not blocked, no Landflow user on the address): sessions may use the same rule.
- `outsideRoute` must wrap `handler()` (my routes throw `AccessError`, an `HttpError`) and pass `params` awaited as `Record<string,string>`.
- `/request-access` must be in `PUBLIC_PAGES` (`lib/shared/auth-paths.ts`): `policy-coverage.test.ts` and `openapi.test.ts` go green with it (checked here by adding it temporarily).
