# Notes for the integrator: P6 `ci-claims` (C18 security slice)

## docs/limitations.md

- Add: Bound Claims on JWT Auth are a text field (`claim: pattern` per line, top-level claims only, a claim name cannot contain `:`). Single use of a token (`jti`), the GitHub and GitLab presets, the claims editor, the token payload in run data and the API workload login are not built yet (C18, wave W4a).
- Do not add the webhook JWKS to the list of callers outside `safeFetch` (near line 418): it now goes through `safeFetch`.
- Add: only `repository`, `project_path`, `sub` and the id claims (`repository_id`, `repository_owner_id`, `project_id`, `namespace_id`) with a literal owner count as binding; a self-managed GitLab issuer is not recognised as a public CI issuer (only gitlab.com, GitHub Actions and GitHub Enterprise Cloud hosts are). Other shared CI issuers (Buildkite, Terraform Cloud) are not covered: a credential for them needs no binding.

## docs/roadmap.md

- C18 W1 slice built: bound claims, the CI rule (breaking for existing GitHub and GitLab JWT credentials) and the JWKS through `safeFetch`. Open in W4a: single use, presets and claims editor, token payload in run data, workload login.

## docs/README.md

- No new page.
