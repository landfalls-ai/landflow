/**
 * OAuth2 credentials against the dev Keycloak (opt-in, it must be running):
 *
 *   docker compose -p landflow-infra -f deploy/compose.infra.yml --profile auth up -d keycloak
 *   LANDFLOW_INTEGRATION=oauth2 npx vitest run test/oauth2-keycloak.test.ts
 *
 * The whole authorization code + PKCE flow without a browser: the authorize route, Keycloak's login form submitted
 * with fetch and a cookie jar (alice / alice-test-only), the callback route with the flow's cookie. Then the token
 * reaches a node, is refreshed before expiry and after a 401 (Keycloak revokes the access token), and the client
 * credentials grant gets a service-account token. Realm `landflow`, confidential client `landflow`, whose redirect
 * URIs include http://localhost:3000/api/oauth2/callback (deploy/infra/keycloak/landflow-realm.json).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('oauth2'));
const KEYCLOAK = process.env.LANDFLOW_KEYCLOAK_URL ?? 'http://localhost:58080';
const REALM = `${KEYCLOAK}/realms/landflow`;
const OIDC = `${REALM}/protocol/openid-connect`;
const CLIENT = { clientId: 'landflow', clientSecret: 'landflow-dev-client-secret' };

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oauth2-keycloak-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://localhost:3000' };
const previousEnv = { ...process.env };

/** A minimal cookie jar: name → value, sent back to Keycloak on every request. */
class CookieJar {
  private cookies = new Map<string, string>();
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/max-age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const unescapeHtml = (value: string) => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe.skipIf(!enabled)('OAuth2 against Keycloak', async () => {
  Object.assign(process.env, ENV);
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  const { credentials } = await import('@/lib/server/credentials/vault');
  const { jwtClaims } = await import('@/lib/server/credentials/oauth2');
  const { store } = await import('@/lib/server/store');
  const { runWorkflow } = await import('@/lib/server/runner');
  const { waits } = await import('@/lib/server/waits');
  const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
  const callbackRoute = await import('@/app/api/oauth2/callback/route');
  const tokenRoute = await import('@/app/api/credentials/[id]/oauth2/token/route');
  registry.registerBuiltin(corePlugin);

  afterAll(() => {
    waits.stop();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const params = <T>(value: T) => ({ params: Promise.resolve(value) });
  const accessToken = (id: string) => credentials.oauth2(id).token!.access_token;
  const userinfo = (token: string) => fetch(`${OIDC}/userinfo`, { headers: { authorization: `Bearer ${token}` } });

  /** Sign in as `username` through Keycloak's login form; returns the callback page. */
  async function connect(id: string, username: string, password: string) {
    const start = await authorizeRoute.GET(new Request(`http://localhost:3000/api/credentials/${id}/oauth2/authorize`), params({ id }));
    expect(start.status).toBe(302);
    const landflowCookie = start.headers.get('set-cookie')!.split(';')[0];
    const authorizeUrl = new URL(start.headers.get('location')!);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const jar = new CookieJar();
    const loginPage = await fetch(authorizeUrl, { redirect: 'manual' });
    jar.take(loginPage);
    expect(loginPage.status).toBe(200);
    const html = await loginPage.text();
    const action = html.match(/action="([^"]*login-actions\/authenticate[^"]*)"/)?.[1];
    expect(action, 'Keycloak login form').toBeTruthy();

    const submitted = await fetch(unescapeHtml(action!), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username, password, credentialId: '' }),
    });
    jar.take(submitted);
    expect(submitted.status, 'login accepted (302 to the redirect URI)').toBe(302);
    const back = new URL(submitted.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('http://localhost:3000/api/oauth2/callback');
    expect(back.searchParams.get('code')).toBeTruthy();

    const page = await callbackRoute.GET(new Request(back, { headers: { cookie: landflowCookie } }));
    return { page, html: await page.text() };
  }

  function userinfoWorkflow(id: string, credentialId: string): Workflow {
    return store.saveWorkflow({
      id,
      name: id,
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'Me',
          name: 'Me',
          type: 'core.httpRequest',
          typeVersion: 1,
          position: [200, 0],
          parameters: { method: 'GET', url: `${OIDC}/userinfo`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
          credentials: { oAuth2Api: { id: credentialId, name: 'Keycloak' } },
        },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Me', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
  }

  const codeCredential = credentials.create({
    name: 'Keycloak',
    type: 'core.oAuth2Api',
    data: { grantType: 'pkce', authUrl: `${OIDC}/auth`, accessTokenUrl: `${OIDC}/token`, scope: 'openid email profile', ...CLIENT } as JsonObject,
  });

  it('runs the code + PKCE flow through Keycloak’s login form', async () => {
    const { page, html } = await connect(codeCredential.id, 'alice', 'alice-test-only');
    expect(html).toContain('Connected as alice@landflow.test');
    expect(page.status).toBe(200);
    const status = credentials.get(codeCredential.id)!.oauth2!;
    expect(status).toMatchObject({ connected: true, account: 'alice@landflow.test', refreshable: true, expired: false });
    // The realm's access tokens live 15 minutes.
    expect(Date.parse(status.expiresAt!) - Date.now()).toBeGreaterThan(10 * 60_000);
    const claims = jwtClaims(accessToken(codeCredential.id))!;
    expect(claims).toMatchObject({ azp: 'landflow', preferred_username: 'alice' });
    expect((await userinfo(accessToken(codeCredential.id))).status).toBe(200);
  });

  it('hands the token to the HTTP Request node', async () => {
    const record = await runWorkflow({ workflow: userinfoWorkflow('wf_kc_me', codeCredential.id), mode: 'manual', startNodeId: 'Start' });
    expect(record.status).toBe('success');
    expect(record.runData.Me[0].outputs[0][0].json).toMatchObject({ preferred_username: 'alice', email: 'alice@landflow.test' });
  });

  it('refreshes before expiry with the refresh token and persists it', async () => {
    const before = credentials.oauth2(codeCredential.id).token!;
    credentials.saveOAuth2Token(codeCredential.id, { ...before, expires_at: new Date(Date.now() - 1_000).toISOString() });
    expect(await credentials.refreshOAuth2(codeCredential.id)).toBe(true);
    const after = credentials.oauth2(codeCredential.id).token!;
    expect(after.access_token).not.toBe(before.access_token);
    expect(Date.parse(String(after.expires_at))).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect((await userinfo(after.access_token)).status).toBe(200);
  });

  it('refreshes after a 401 and runs the node again', async () => {
    const revoked = accessToken(codeCredential.id);
    const revoke = await fetch(`${OIDC}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: revoked, token_type_hint: 'access_token', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret }),
    });
    expect(revoke.status).toBe(200);
    expect((await userinfo(revoked)).status).toBe(401);
    const record = await runWorkflow({ workflow: userinfoWorkflow('wf_kc_401', codeCredential.id), mode: 'manual', startNodeId: 'Start' });
    expect(record.status).toBe('success');
    expect(accessToken(codeCredential.id)).not.toBe(revoked);
    expect(record.runData.Me[0].outputs[0][0].json).toMatchObject({ preferred_username: 'alice' });
  });

  it('gets a service-account token with client credentials', async () => {
    const machine = credentials.create({ name: 'Keycloak machine', type: 'core.oAuth2Api', data: { grantType: 'clientCredentials', accessTokenUrl: `${OIDC}/token`, ...CLIENT } as JsonObject });
    const response = await tokenRoute.POST(new Request('http://localhost:3000', { method: 'POST' }), params({ id: machine.id }));
    expect(response.status, await response.clone().text()).toBe(200);
    const status = credentials.get(machine.id)!.oauth2!;
    expect(status).toMatchObject({ grantType: 'clientCredentials', connected: true, account: 'service-account-landflow', refreshable: true });
    expect(jwtClaims(accessToken(machine.id))).toMatchObject({ azp: 'landflow', preferred_username: 'service-account-landflow' });
    // Renewed with the grant (Keycloak issues no refresh token for it).
    const first = accessToken(machine.id);
    expect(await credentials.refreshOAuth2(machine.id, { force: true })).toBe(true);
    expect(accessToken(machine.id)).not.toBe(first);
  });

  it('refuses a wrong password without touching the credential', async () => {
    const other = credentials.create({ name: 'Keycloak bob', type: 'core.oAuth2Api', data: { authUrl: `${OIDC}/auth`, accessTokenUrl: `${OIDC}/token`, scope: 'openid email', ...CLIENT } as JsonObject });
    const start = await authorizeRoute.GET(new Request(`http://localhost:3000/api/credentials/${other.id}/oauth2/authorize`), params({ id: other.id }));
    const jar = new CookieJar();
    const loginPage = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    jar.take(loginPage);
    const action = unescapeHtml((await loginPage.text()).match(/action="([^"]*login-actions\/authenticate[^"]*)"/)![1]);
    const wrong = await fetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username: 'bob', password: 'not-his-password', credentialId: '' }),
    });
    expect(wrong.status).toBe(200); // the login form again, with an error
    expect(credentials.get(other.id)!.oauth2!.connected).toBe(false);
    // The right one works.
    const { html } = await connect(other.id, 'bob', 'bob-test-only');
    expect(html).toContain('Connected as bob@landflow.test');
  });
});
