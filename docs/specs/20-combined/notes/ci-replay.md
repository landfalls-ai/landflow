# Notes for the integrator: P17 `ci-replay` (C18 rest)

## docs/limitations.md

- Lift W1's note that single use of a token, the GitHub and GitLab presets, the claims editor and the token payload in run data are not built: all are built (C18, W4a).
- Add: the API workload login (a token calling `POST /api/workflows/:id/run` with no `lf_` key, C18 FR-8) is not built; a published webhook with bound claims covers CI.
- Add: Single Use refuses a CI retry that reuses a token (even with the same `Idempotency-Key`); a token without `exp` is refused while Single Use is on. Single Use is once per credential, refuses tokens that expire more than 24 h ahead, and keeps used-token ids in `saml_replay` until 35 s after `exp`; test URLs spend the token; a Form Trigger page view does not.
- Add: `item.json.jwtPayload` keeps every verified claim (C18-D2); only the token itself is kept out of run data.

## docs/roadmap.md

- C18 built (W1 claims, W4a Single Use, presets, claims editor). Open: the API workload login (FR-8, a new principal kind in the auth guard).

## docs/README.md

- No new page.
