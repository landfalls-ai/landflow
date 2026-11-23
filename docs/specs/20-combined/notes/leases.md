# Notes: C30 dynamic secrets with leases (P29 `leases`)

## docs/limitations.md

- Dynamic secrets (leases) are OpenBao / Vault only, and only for engines that issue on `GET <mount>/creds/<role>` (database, RabbitMQ, Consul); AWS, PKI and other engines are not recognised as dynamic. Landflow does not issue credentials itself (no native Postgres roles, AWS STS or cloud IAM users).
- A dynamic path works only in a node's credential during a run. Test connection, agents' models and channels, alert channels, OAuth2 Connect, app webhook registration, option lists and node parameters refuse it ("a dynamic secret is issued per run: use it in a node credential").
- A run that waits past its lease loses its user: the lease is not renewed while a run waits, so a node after a wait longer than the lease (15 minutes by default, 1 hour at most, renewed only while the run goes) fails with "the run’s lease … ended" instead of getting a new user.
- A lease's first length is the role's (OpenBao's `default_ttl`); Lease TTL sets how far each renewal extends it, never past an hour after issue, and the store's `max_ttl` can cap it sooner.
- A process that dies between asking the store for a credential and saving its row leaves a credential only the store's TTL removes (at most the role's default TTL).
- A lease whose provider was deleted can't be revoked by Landflow (the row retries for 24 hours, then `revoke_failed`); the store removes it at its TTL. A turned-off provider still revokes.
- A lease for a run with no saved execution row yet is left alone for two minutes by the sweeper.
- The sweeper looks at 200 leases per step a minute; an instance with more than 10,000 open leases refuses new ones.
- A `revoke_failed` lease keeps its sealed lease id (so an admin can retry) but drops its values; it is never deleted by retention.

## docs/roadmap.md

- C30 slice 1 built: leased reads from OpenBao/Vault's database engine in node credentials during a run, one lease per run and path, revoked at the run's end, swept, renewed and listed (Settings → External secrets → Leases). Open: Landflow-native issuers, other providers' dynamic engines, dynamic secrets outside node credentials, a new lease for a run after a long wait.

## docs/README.md

No new page.

## docs/development.md

- Test files: `test/secret-leases.test.ts` (table, rotation, the fake, the provider, the lease store), `test/secret-leases-run.test.ts` (whole runs), `test/secret-leases-sweeper.test.ts`, `test/secret-leases-routes.test.ts`, `e2e/secret-leases.spec.ts` (browser tier), and against real services `test/secret-leases.postgres.test.ts` (`LANDFLOW_INTEGRATION=postgres`) and `test/secret-leases-openbao.integration.test.ts` (`LANDFLOW_INTEGRATION=secrets,postgres`, with `deploy/scripts/openbao-db-engine.sh` applied to the infra OpenBao).
- `LANDFLOW_INTEGRATION=secrets,postgres` needs the `landflow-infra` OpenBao (`http://127.0.0.1:58200`) and Postgres.

## For the integrator and P28

- Migration 2933 and the `secrets.lease.*` audit labels are P29's; P28 appends 2934 and `network.*` after them.
- P29 owns `openapi.ts` and `docs/reference/api.md` in step 2: the two leases operations (`listSecretLeases`, `revokeSecretLeases`) and one `api.md` row are in (after the external secrets row); P28 adds its networks lines after them.
- `credentials/rotate.ts`: `TABLES` entries may now name a `purpose` (the sealed strings of `secret_leases.lease_values` and `.lease_id` are bound to their own).
- `runtime.ts`: one `SERVICES` entry, `secret lease sweeper` (leader, main only), right after `kagent route refresh`; `test/runtime.test.ts` lists it.
- Migration 2933 adds two columns to the plan's SQL: `failing_since` (when a revoke first failed: the 24 hours count from it) and `dismissed_at` (a failed lease set aside: the banner counts only the others).
