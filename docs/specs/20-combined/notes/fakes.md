# Notes for the integrator: P23 `fakes` (C24)

## docs/limitations.md

- Add: only the Notion fake is on the `@landflow/test-fakes` contract (`asFake()`, with no `delayMs` script); the other ten host fakes (`apps/web/test/fake-*.ts`) and the plugins' own (`fake-slack.ts`, `fake-github.ts`, `fake-twilio.ts`) keep their own servers until they are next touched. The plugins' old Slack and GitHub fakes stay beside the new stateful ones.
- Add: the Slack and GitHub fakes cover what the nodes call today (messages, threads, history; branches, contents, git data, pull requests, comments), not the whole APIs; the GitHub fake keeps text files only and has no merge, review or compare endpoints (the old `fake-github.ts` has them).
- Add: the browser tier has no visual-diff baselines, nothing runs it on its own (no CI by decision; a person runs `pnpm --filter @landflow/web test:browser`), and it needs this machine's Chrome (`LANDFLOW_E2E_CHANNEL=chromium` after `npx playwright install chromium` otherwise). It starts `next dev` from `apps/web`, so it cannot run while `pnpm dev` runs in the same checkout.
- Add: its dev host runs with the Content Security Policy enforced; the production-profile CSP check is opt-in (`LANDFLOW_E2E_PROD=1` after `pnpm --filter @landflow/web build`).
- Add: the browser tier covers four flows (owner setup and sign in, build and run, Run Trace, API keys; the credential picker follows P22) and a CSP smoke test; the editor's Spotlight, settings other than API keys and the agent builder are still checked by hand.

## docs/roadmap.md

- C24 built: `@landflow/test-fakes` (`defineFake`, Slack, GitHub, Notion on the contract), node-state tests in the messaging and GitHub plugins, a Playwright browser tier at two viewports behind `LANDFLOW_INTEGRATION=browser`.

## docs/README.md

- No new page (the harness and the tier are in `docs/development.md`: "Fakes" and "Browser tests").

## docs/development.md

- Done in this package (P23 owns it in step 1): the Fakes and Browser tests sections, the `browser` row in the `LANDFLOW_INTEGRATION` table, `test-fakes` in the package test loop.

## Other

- **Last tasks not done in this package (they wait for other merges, W4b "Last tasks"):** root `package.json` `"test:browser": "pnpm --filter @landflow/web test:browser"` (after P24 merges; until then `pnpm --filter @landflow/web test:browser` is the command, and `docs/development.md` says so; switch its examples to `pnpm test:browser` once the root script exists), and `apps/web/e2e/credential-picker.spec.ts` (after P22 merges: HTTP Request, Authentication Header Auth, type a name with no match, Create "e2e upstream", fill the value, save, the combobox shows it picked, run against the `upstream` fixture, 200; `fixtures.ts` already has `upstream`, a worker-scoped `defineFake` echo that takes the credential's value in `x-api-key`). The flows paragraph in development.md names it as following.

- P21 (connectors) adds Drive, S3 and site fakes as `packages/test-fakes/src/{drive,s3,site}.ts` on `defineFake`, each a subpath export; P25 adds `./upstream`.
- `pnpm install` adds `@playwright/test` as a dev dependency of `@landflow/web` only; it downloads no browser.
