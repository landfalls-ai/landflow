/**
 * Single sign-on against the real Keycloak from the infra stack (docs/deployment.md, profile `auth`): the sign-in route
 * redirects to Keycloak, the test fills in Keycloak's own login form with fetch and cookies like a browser, and the
 * callback route exchanges the code. alice (realm role landflow-admin) becomes an admin, bob (landflow-editor) a
 * member. Run with LANDFLOW_INTEGRATION=oidc and Keycloak at http://localhost:58080 (LANDFLOW_TEST_OIDC_ISSUER).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('oidc');
const ISSUER = process.env.LANDFLOW_TEST_OIDC_ISSUER ?? 'http://localhost:58080/realms/landflow';
const BASE = 'http://localhost:3000';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-oidc-it-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_OIDC_ISSUER: ISSUER,
  LANDFLOW_OIDC_CLIENT_ID: 'landflow',
  LANDFLOW_OIDC_CLIENT_SECRET: 'landflow-dev-client-secret',
  LANDFLOW_OIDC_ROLE_MAP: 'landflow-admin=admin,landflow-editor=member',
};
const previousEnv = { ...process.env };

type Route = (request: Request) => Promise<Response>;

/** Cookies the "browser" holds for Keycloak (one host, so a name → value map is enough). */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const decodeHtml = (text: string) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe.skipIf(!enabled)('OIDC sign-in with Keycloak (LANDFLOW_INTEGRATION=oidc)', () => {
  let auth: typeof import('@/lib/server/auth');
  let oidc: typeof import('@/lib/server/auth/oidc');
  let loginRoute: { GET: unknown };
  let callbackRoute: { GET: unknown };
  let meRoute: { GET: unknown };
  let securityRoute: { GET: unknown };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    auth = await import('@/lib/server/auth');
    oidc = await import('@/lib/server/auth/oidc');
    loginRoute = await import('@/app/api/auth/oidc/login/route');
    callbackRoute = await import('@/app/api/auth/oidc/callback/route');
    meRoute = await import('@/app/api/auth/me/route');
    securityRoute = await import('@/app/api/settings/security/route');
    auth.disableTestAuth();
    await auth.createOwner({ email: 'owner@landflow.test', name: 'Owner', password: 'owner-password' });
  });

  afterAll(() => {
    auth?.enableTestAuth();
    oidc?.resetOidcCaches();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  /** The whole browser round trip for one Keycloak user: the Landflow session cookie and where it lands. */
  async function signInAs(username: string, password: string, next = '/workflows') {
    // 1. Landflow sends the browser to Keycloak (and sets the state cookie).
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/oidc/login?next=${encodeURIComponent(next)}`));
    expect(started.status).toBe(307);
    const stateCookie = started.headers.getSetCookie().find((c) => c.startsWith(`${oidc.OIDC_STATE_COOKIE}=`))!.split(';')[0];
    const authorizeUrl = started.headers.get('location')!;
    expect(authorizeUrl.startsWith(`${ISSUER}/protocol/openid-connect/auth?`)).toBe(true);

    // 2. Keycloak's login page.
    const jar = new Jar();
    const page = await fetch(authorizeUrl, { redirect: 'manual' });
    jar.take(page);
    const html = await page.text();
    expect(page.status, html.slice(0, 500)).toBe(200);
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1] ?? /<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"/.exec(html)?.[1];
    expect(action, 'Keycloak login form').toBeTruthy();

    // 3. Submit the credentials: Keycloak redirects back to Landflow's callback with a code.
    const submitted = await fetch(decodeHtml(action!), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username, password, credentialId: '' }),
    });
    const callback = submitted.headers.get('location') ?? '';
    expect(submitted.status, `Keycloak answered ${submitted.status}: ${(await submitted.text()).slice(0, 300)}`).toBe(302);
    expect(callback.startsWith(`${BASE}/api/auth/oidc/callback?`)).toBe(true);
    expect(new URL(callback).searchParams.get('code')).toBeTruthy();

    // 4. Landflow's callback exchanges the code (PKCE + client secret) and starts a session.
    const done = await (callbackRoute.GET as Route)(new Request(callback, { headers: { cookie: stateCookie } }));
    const location = done.headers.get('location') ?? '';
    const session = done.headers.getSetCookie().find((c) => c.startsWith('landflow_session='))?.split(';')[0].slice('landflow_session='.length);
    return { location, session };
  }

  async function me(session: string) {
    const response = await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${session}` } }));
    expect(response.status).toBe(200);
    return (await response.json()).user as { id: string; email: string; role: string; sso: boolean; hasPassword: boolean };
  }

  it('Settings → Security sees Keycloak (discovery works)', async () => {
    const owner = auth.findUserByEmail('owner@landflow.test')!;
    const { token } = auth.createSession(owner, 'password');
    const response = await (securityRoute.GET as Route)(new Request(`${BASE}/api/settings/security`, { headers: { cookie: `landflow_session=${token}` } }));
    const view = await response.json();
    expect(view.oidc).toMatchObject({ configured: true, reachable: true, issuer: ISSUER, clientId: 'landflow', redirectUrl: `${BASE}/api/auth/oidc/callback`, roleClaim: 'roles' });
  });

  it('alice (landflow-admin) signs in as a new admin and lands where she was going', async () => {
    const { location, session } = await signInAs('alice', 'alice-test-only', '/workflows');
    expect(location).toBe(`${BASE}/workflows`);
    expect(session).toBeTruthy();
    const user = await me(session!);
    expect(user).toMatchObject({ email: 'alice@landflow.test', role: 'admin', sso: true, hasPassword: false });

    // A second sign-in finds the same user.
    const again = await signInAs('alice', 'alice-test-only', '/');
    expect((await me(again.session!)).id).toBe(user.id);
  });

  it('bob (landflow-editor) signs in as a member', async () => {
    const { session } = await signInAs('bob', 'bob-test-only');
    expect((await me(session!)).role).toBe('member');
  });

  it('a wrong password stays on Keycloak’s form (no callback)', async () => {
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/oidc/login`));
    const jar = new Jar();
    const page = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    jar.take(page);
    const action = decodeHtml(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(await page.text())![1]);
    const submitted = await fetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username: 'alice', password: 'not-her-password', credentialId: '' }),
    });
    expect(submitted.status).toBe(200);
    expect(submitted.headers.get('location')).toBeNull();
  });
});
