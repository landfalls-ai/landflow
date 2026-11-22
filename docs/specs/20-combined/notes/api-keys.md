# Notes for the integrator: P16 `api-keys` (C17)

## docs/limitations.md

- Add: an API key's allow-list and use cap are fixed at creation: changing either means a new key (no PATCH, no rotate button; "rotate" is create-new-then-delete).
- Add: a capped key costs one Postgres round trip per request in queue mode (the exact count is decided in the database); a key with no cap costs nothing extra.
- Add: the last address a key was used from is written with the once-a-minute last-used touch, so it can lag by a minute (and in Postgres mode it follows the process that wrote it).
- Add: the allow-list is only as good as `LANDFLOW_TRUSTED_PROXIES`: with none counted (unset or 0) a caller can write its own `X-Forwarded-For` and get around the list (the same as rate limits and webhook allow-lists). In production a key or SCIM token with an address list is refused (400) until the variable is set on purpose; outside production `GET /api/api-keys` and the SCIM view carry `addressUnverified` and the forms warn. A caller with no address is refused by any list. `/connect` does not offer an allow-list or cap.
- Add: a use is a request that reaches its handler: a request refused for a scope, a role or the rate limiter is free. A key that is used up stays listed until the owner deletes it.
- Add: webhook `ipWhitelist` entries are still not validated at save (a malformed entry never matches, so it fails closed); only API key lists are checked.
- Add: an expiry is still optional for API keys ("never" stays a choice, C17-D1).

## docs/roadmap.md

- C17 built: per-key IP allow-list and use cap, last address, exact cross-process use count (`api_key_uses`), the same rules for SCIM and MCP tokens.

## docs/README.md

- No new page.

## docs/development.md

- `LANDFLOW_INTEGRATION=queue` also runs `test/api-key-uses.postgres.test.ts` (a cap of 100 taken by 150 calls from two processes: exactly 100 succeed). New tests: `ip-allow`, `api-keys-hardening`, `api-keys-ui`.
