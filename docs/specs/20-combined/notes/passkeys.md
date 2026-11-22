# Notes for the integrator: P15b `passkeys` (C16 step 3)

## docs/limitations.md

- In the line about local accounts and the second factor (P15a's replacement): passkeys are now built; remove "passkeys are pending". Keep one authenticator app per account.
- Add: WebAuthn needs `LANDFLOW_PUBLIC_URL` to be the address the browser uses (the relying party id is its host, the expected origin its origin); behind a proxy or on another port without it every passkey call fails. `localhost` works over http, anything else needs https.
- Add: passkeys are only a second factor (no passwordless sign-in); attestation is `none`, so there is no check of the authenticator's maker or model; a passkey cannot be renamed (remove and add again); at most ten per account.
- Add: a passkey whose signature counter goes back or repeats is flagged and refused for good until removed; synced passkeys that report a counter that does not move forward (but is not 0) would trip this, and the person must add the passkey again.

## docs/roadmap.md

- C16 P15b built: passkeys (WebAuthn) as a second factor, the counter check, the passkey step in sign-in and step-up. C16 is complete; what is left is in `limitations.md` (passwordless sign-in, attestation policy, a local factor when an SSO sign-in links to a local account).

## docs/README.md

- No new page.

## docs/development.md

- New tests: `mfa-webauthn` (with the software authenticator `test/fake-authenticator.ts`), more cases in `mfa-ui`. `LANDFLOW_INTEGRATION=queue` also runs two more cases in `mfa.postgres.test.ts` (the WebAuthn challenge and the counter taken by two mains at once).
- The browser check uses Chrome's virtual authenticator (DevTools Protocol `WebAuthn.addVirtualAuthenticator`) on `http://localhost:<port>` with `LANDFLOW_PUBLIC_URL` set to that origin.

## Behaviour to know

- `LANDFLOW_PUBLIC_URL` is read at call time; changing it makes existing passkeys unusable (they are bound to the old relying party id).
- The counter rule is stricter than the plan's SQL: 0 is allowed only on a passkey whose stored counter is 0 (a drop to 0 after counting is a regression).
- `POST /api/me/mfa/passkeys/options` carries both purposes (`register`, `step-up`) so no extra route was needed; the shared current-password check moved to `auth/mfa/enrol-password.ts` and the TOTP route uses it too.
- `MfaError` moved to `auth/mfa/errors.ts` (still exported from `factors.ts` and `index.ts`) to avoid an import cycle with `webauthn.ts`.
