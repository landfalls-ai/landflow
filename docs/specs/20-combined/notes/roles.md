# Notes for the integrator: P31 `roles` (C32)

## docs/limitations.md

- Add: a custom role grants a subset of the existing role-gated actions to a member, and nothing else. A member holds **one** (no union of several), there are no conditions (a rule can't be limited to some projects), no custom project roles and no deny rules; routes still name actions, not roles.
- Add: `projects:manage` can't be granted through a custom role (it means "admin of every project"), and `isInstanceAdmin` is the built-in owner or admin role, so a holder never sees other people's projects. `users:manage` and `apiKeys:admin` can only be granted by the owner.
- Add: code that checks `user.role` directly (`isActiveAdmin` in `auth/users.ts`, the owner checks in routes such as encryption rotation) ignores custom roles: that is the safe side (fewer rights).
- Add: `audit:read` through a role reads the events of the holder's member projects, but the action also opens Verify, Sign now's head and the read-only audit settings (`GET /api/settings/audit`), which owners and admins see in full.
- Add: a role holder's controls come from `grants` on the viewer, read at page load: a role edited while a tab is open shows its new controls after a reload (the server enforces the change on the next request).
- Add: the SCIM-managed custom role follows the groups only for users the identity provider manages and only for roles the map names; a role given by hand that the map doesn't name stays.

## docs/roadmap.md

- C32 slice 1 built: custom instance roles (name, description, allow rules over the existing actions), one per member, the escalation check, SCIM `role:custom:<name>`, Settings → Users → Custom roles, audit events with from and to (migration 2931). Open: conditions (`projectIds`, slice 2), several roles per person, custom project roles, deny rules.

## docs/README.md

- No new page (the feature is in `features/authentication.md#custom-roles`).

## docs/development.md

- New tests: `custom-roles` (shared rules and the store), `custom-roles-routes` (AS-1, 3, 4, 5, 6, 7 and delete in use through the guard), `custom-roles-scim`, `custom-roles-ui`; `LANDFLOW_INTEGRATION=postgres` also runs `test/custom-roles.postgres.test.ts` (migration 2931 and the join on Postgres); `LANDFLOW_INTEGRATION=browser` runs `e2e/roles.spec.ts`.
