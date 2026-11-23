# Notes for the integrator: P15a `mfa` (C16 step 1)

## docs/limitations.md

- Lift the first clause of the line about local accounts having no second factor (near line 429): local accounts can add an authenticator app and recovery codes ([second factor](features/authentication.md#second-factor)); `LANDFLOW_LOCAL_SIGN_IN=off` stays the way to rely on an identity provider's MFA alone.
- Add: a second factor is optional (`LANDFLOW_MFA_REQUIRED=off` in every profile); there are no passkeys yet (the factors table has their columns), no SMS or email codes, no "trust this browser", no password-change screen on Sign-in & security, one authenticator app per account, and SSO accounts use their provider's factor.
- Add: a sole owner who loses both the phone and the recovery codes cannot be reset by anyone (only an owner resets an owner, and there is one): nobody may edit the live database. Keep the codes.
- Add: TOTP needs a device clock within about 30 seconds of the server's.
- Add: the second-factor check on `/api/me/mfa*` and the sign-in step count against the sign-in limits, which are per process unless Valkey is set up (queue mode).

## docs/roadmap.md

- C16 P15a built: TOTP, recovery codes, the 202 sign-in step, `LANDFLOW_MFA_REQUIRED`, admin reset, Sign-in & security. Next: P15b passkeys (the same challenge flow with a second verifier).

## docs/README.md

- No new page.

## docs/development.md

- `LANDFLOW_INTEGRATION=queue` also runs `test/mfa.postgres.test.ts` (challenge, recovery code and TOTP step taken by two mains at once). New tests: `mfa-totp`, `mfa-signin`, `mfa-enrolment`, `mfa-reset`, `mfa-ui`.

## Review round (replacement and additions)

- docs/limitations.md line 429 (local accounts have no second factor): replace with: local accounts can add one authenticator app and recovery codes ([second factor](features/authentication.md#second-factor)); passkeys are pending (P15b), there is one authenticator per account, single sign-on sessions (OIDC, SAML) are never asked for a second factor (their provider's is relied on), and the TOTP secret is sealed on the default seal purpose (so key rotation re-seals it).
- Add: an OIDC sign-in whose verified email matches an existing local account links to it (existing behaviour, `signInUser` in `auth/oidc.ts`) and signs in without the second step, even if that account has an authenticator app. Anyone who controls an identity-provider account with that email therefore bypasses the local factor. Linking was not changed; the mitigation is `LANDFLOW_LOCAL_SIGN_IN=off` or an IdP that verifies email ownership.
- docs/roadmap.md: C16 P15a built and reviewed; P15b passkeys next; a later step could ask for the local factor when an SSO sign-in links to a local account that has one.
- Behaviour changes in the review round: enrol-only sessions are no one on the MCP endpoint (403), the waiting-form page and the health probe's counts; each second-step answer is claimed (`wrong + 1`, at most five) before the code is checked, so parallel answers on several mains never exceed five; `/api/users/<id>/mfa` is session only; starting an authenticator app needs the account's current password; an unconfirmed enrolment expires after 15 minutes.
