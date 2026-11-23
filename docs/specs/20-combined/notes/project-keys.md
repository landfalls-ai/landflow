# Notes for the integrator: P30 `project-keys` (C31)

## docs/limitations.md

- Add: project keys cover credentials only. Alert channels, SIEM destinations, MCP and audit signing keys, TOTP secrets and every other `sealSecret` value stay on the key ring (and are still re-sealed by root rotation).
- Add: the ring still wraps every project key, so a stolen ring key opens everything; per-project keys give crypto-shredding of a project and a rotation that costs one row per project, not a separate root of trust. The root key still lives in `LANDFLOW_ENCRYPTION_KEYS` or `encryption.key` (no OpenBao Transit).
- Add: `LANDFLOW_PROJECT_KEYS=off` (new catalog row) is the downgrade switch: set it on every process, then `revert`.
- Add: no settings screen for project keys: status, migrate, revert and per-project rotation are owner `curl` calls (`/api/settings/encryption/project-keys`), like root rotation.
- Add: a build without project keys can't open version 3 credentials: run `revert` (and check `onProjectKeys` is 0) before a downgrade. Without `LANDFLOW_PROJECT_KEYS=off`, a credential saved after a revert is version 3 again.
- Add: existing credentials move onto project keys only when the owner runs `migrate`; until then they stay on the ring (version 2), readable as before.
- Add: in queue mode the first credential saved in a project, by a process that has no key for it yet, is sealed on the ring (version 2) while the key is made in Postgres in the background; the next save or `migrate` moves it. The routes, moves and `migrate` wait for the key first. A key is only ever made in Postgres (one transaction, a lock per project), so two processes never end up with different keys.
- Add: crypto-shredding a project is delayed: deleting a project (or rotating its key) only retires keys; `migrate` sweeps keys retired for 15 minutes that no stored credential names (asked of Postgres). Until then, and in any backup taken before, the wrapped key can still open the project's old ciphertext.
- Add: a process may seal one more value with a version it has not yet heard is retired (until the change notice reaches it, or its ten-minute cache ends); the 15-minute grace keeps that key, so the value stays readable.
- Add: credentials created by Git sync or a promotion are sealed with their project's key only if the key exists; otherwise they stay on the ring until the next save or `migrate`.
- Add: plaintext copies outside the vault (the secrets kagent holds for deployed agents, the keys given to LiteLLM) are not covered by destroying a project key.
- Add: moving a credential re-seals it after the move commits, not in the move's transaction (the credential may live in `credentials.json`, which no database transaction covers): a failed re-seal leaves it on the old project's key, readable, and `migrate` finishes it.
- Add: restoring `credentials.json` or the `credentials` table without `project_keys` (or the reverse) loses the credentials sealed with the missing half; back them up together with the ring.

## docs/roadmap.md

- C31 slice 1 built: per-project data keys for credentials (migration 2932), root rotation that re-wraps keys only, re-seal on move, destroy on project or user delete, owner routes to migrate, revert, rotate one project and read status.
- Open: OpenBao Transit as the key wrapper (spec slice 2, FR-10), project keys for the other sealed values, a Settings screen.

## docs/README.md

- No new page (the feature is a section of `features/secrets-and-environments.md`).

## docs/development.md

- New tests: `project-keys` (the key store and the vault with a resolver), `project-keys-move`, `project-keys-rotate` (10,000 credentials rotate in under 5 s; migrate killed half-way; revert), `project-keys-routes`. `LANDFLOW_INTEGRATION=queue` also runs `test/project-keys.postgres.test.ts` (two processes on one Postgres; needs only infra Postgres); `test/rotate-key-postgres.test.ts` is unchanged.
