/**
 * The Google OpenID Connect fake (packages/test-fakes/src/google-oidc.ts) served on a port, for the outside-requester live check
 * (docs/access-requests.md#trying-it-without-google): an `OpenID Connect client` credential points at it (issuer = the printed URL, the
 * printed client ID and secret), and "Sign in with Google" on /request-access goes through its account chooser. No real Google, no token.
 *
 *   pnpm --filter @landflow/web exec tsx --tsconfig tsconfig.json scripts/fake-oidc.ts http://localhost:3100
 *
 * It binds a free loopback port (the harness's rule) and prints it. The argument is Landflow's public URL: the callback `<url>/request-access/api/sign-in/google/callback` is registered with the fake
 * (the SSO callback `<url>/api/auth/oidc/callback` too). Accounts: mia@acme.test and sam@acme.test (Workspace, hd acme.test); add more with
 * `POST /_fake/accounts { email, name, hd?, email_verified? }` (`hd: null` is a personal account); `GET /_fake/log` shows the flow;
 * `POST /_fake/next-error { mode }` scripts a refusal (token_error, wrong_aud, email_unverified, other_hd, ...).
 */
import { fakeGoogleOidc } from '@landflow/test-fakes/google-oidc';

const landflow = (process.argv[2] ?? 'http://localhost:3100').replace(/\/+$/, '');
const fake = fakeGoogleOidc({ redirectUris: [`${landflow}/request-access/api/sign-in/google/callback`, `${landflow}/api/auth/oidc/callback`] });

await fake.start();
console.log(`fake Google OpenID Connect on ${fake.url}`);
console.log(`  issuer / discovery: ${fake.url}`);
console.log(`  client ID:          ${fake.clientId}`);
console.log(`  client secret:      ${fake.clientSecret}`);
console.log(`  redirect URI:       ${landflow}/request-access/api/sign-in/google/callback`);
console.log('  accounts: POST /_fake/accounts; log: GET /_fake/log; scripted refusals: POST /_fake/next-error');
