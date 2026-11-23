# Notes for the integrator: P31 `roles` (C32)

## docs/limitations.md

- Add: a custom role grants a subset of the existing role-gated actions to a member, and nothing else. A member holds **one** (no union of several), there are no conditions (a rule can't be limited to some projects), no custom project roles and no deny rules; routes still name actions, not roles.
- Add: `projects:manage` can't be granted through a custom role (it means "admin of every project"), and `isInstanceAdmin` is the built-in owner or admin role, so a holder never sees other people's projects. `users:manage`, `apiKeys:admin`, `scim:manage`, `plugins:manage` and `settings:manage` can only be granted by the owner (decision 2026-11-23, after the P31 review: SCIM rewrites users and groups, a plugin runs third-party code on the host with the host's access to the data directory, settings reach every project). Routes that reach every project (`/api/sync`, `/api/source-control`, environment changes, stop-all) and four-eyes or promotion approval need the built-in owner or admin role even then.
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

## Decision 2026-11-23 (P31 review: privilege escalations)

The person decided: `scim:manage`, `plugins:manage` and `settings:manage` are owner-only grants (`OWNER_ONLY_GRANTS`), the editor's notes say what each really allows, and routes that reach every project are blocked for non-admin holders (`instanceAdmin` in the route policy; `mayApprove`, `mayApprovePromotion` and the withdraw paths use `isInstanceAdmin`). Also: SCIM never changes the owner, its own person or (unless the owner's token) an admin, and a SCIM-mapped role is given only if the token's person could grant it; MCP grants bind only credentials their author can use; a user manager acts only on members whose role holds nothing they lack; role names are plain; deleting a role is checked like making one. Limitation to add: a holder of `settings:manage` (given by the owner) still can't use sync, source control or environment changes, only the settings routes that don't reach every project.

## Decision 2026-11-23 (P31 re-review: more routes that reach admin power)

Principle (the person's): instance-wide power stays with the built-in owner and admin; risky grants are owner-only; the editor's notes are truthful. Built: `instanceAdmin` now also covers every write under `/api/settings` (governance, retention, pruning, audit destinations, security, alerts, caps), the instance MCP server (`/api/settings/mcp`, `/api/mcp/gateway`), external secrets, the LLM gateway keys and sync, transports, `/api/brain/run`, and instance `/api/variables` (project variables are the project's admins'). Consequence to state in `limitations.md`: `settings:manage`, `variables:manage` and the writes of `mcp:manage` open little for a custom-role holder today (they see the tabs' data and manage MCP grants only); the notes in the editor say so. SCIM: non-owner tokens change no built-in role and only projects their person administers, skip their own person and anyone `/Users` would refuse (`scim/guard.ts`), and rename only accounts SCIM provisioned. A user manager with a custom role acts only on people whose memberships are within projects they administer (`auth/user-scope.ts`), moves a removed person's things only to the owner or a project they administer, and never sees a reset link. MCP grants re-check the stored credentials on update and delete, and a grant for anyone but its author needs `share` on each credential. Limitations to add: grants aren't re-checked after their author loses access to a credential; a requester who has been demoted below admin can no longer withdraw their own pending promotion request (the environment routes need the built-in admin role), so another owner or admin has to; the Settings tabs for Security, Source control, Environments, External secrets and Transports and Stop all show only to the built-in owner and admin role.

## docs/limitations.md (add, from the second review)

- A custom role's `settings:manage`, `variables:manage` and the writes of `mcp:manage` open little today: instance-wide writes need the built-in owner or admin role. The editor's notes say so.
- MCP grants are not re-checked after their author loses access to a credential they bound.
- A requester demoted below admin can't withdraw their own pending promotion request; another owner or admin must.
