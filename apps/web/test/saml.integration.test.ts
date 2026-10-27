/**
 * SAML sign-in against the real Keycloak from the infra stack (docs/deployment.md, profile `auth`; SAML client
 * `http://localhost:3000/api/auth/saml/metadata` in the `landflow` realm): our login route sends the AuthnRequest,
 * the test fills in Keycloak's login form with fetch and cookies like a browser, takes the auto-submitting form with
 * the signed SAMLResponse and posts it to our ACS route. The IdP comes from Keycloak's metadata. alice (realm role
 * landflow-admin) becomes an admin, bob (landflow-editor, group data-team) a member and an editor of the Data
 * project; then single logout goes to Keycloak and back. Last, encrypted assertions: the realm's test client
 * `urn:landflow:test:saml-encrypted` encrypts to the test-only certificate in test/fixtures/saml (sp-encryption.*),
 * whose key is uploaded as the decryption key; with "Require encrypted assertions" the plain client is refused. Run with
 * LANDFLOW_INTEGRATION=saml.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('saml');
const REALM = process.env.LANDFLOW_TEST_SAML_REALM ?? 'http://localhost:58080/realms/landflow';
const BASE = 'http://localhost:3000';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-saml-it-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SAML_IDP_METADATA_URL: `${REALM}/protocol/saml/descriptor`,
  LANDFLOW_SAML_ROLE_MAP: 'landflow-admin=admin,landflow-editor=member',
  LANDFLOW_SAML_PROJECT_MAP: 'data-team=Data:editor',
  LANDFLOW_SAML_LABEL: 'Sign in with Keycloak (SAML)',
};
const UNSET = ['LANDFLOW_PUBLIC_URL', 'LANDFLOW_SAML_ENTRY_POINT', 'LANDFLOW_SAML_IDP_CERT', 'LANDFLOW_SAML_IDP_ISSUER', 'LANDFLOW_SAML_ISSUER', 'LANDFLOW_SAML_LOGOUT_URL', 'LANDFLOW_SAML_JIT'];
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

const decodeHtml = (text: string) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&#x3D;/gi, '=').replace(/&#x2B;/gi, '+');

/** The auto-submitting form Keycloak answers with in the HTTP-POST binding: its action and hidden fields. */
function postForm(html: string): { action: string; fields: Record<string, string> } {
  const action = decodeHtml(/<form[^>]*action="([^"]+)"/i.exec(html)?.[1] ?? '');
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(match[0])?.[1];
    const value = /value="([^"]*)"/.exec(match[0])?.[1];
    if (name && value !== undefined) fields[name] = decodeHtml(value);
  }
  return { action, fields };
}

describe.skipIf(!enabled)('SAML sign-in with Keycloak (LANDFLOW_INTEGRATION=saml)', () => {
  let auth: typeof import('@/lib/server/auth');
  let saml: typeof import('@/lib/server/auth/saml');
  let projects: typeof import('@/lib/server/projects');
  let loginRoute: { GET: unknown };
  let acsRoute: { POST: unknown };
  let metadataRoute: { GET: unknown };
  let logoutRoute: { GET: unknown; POST: unknown };
  let appLogoutRoute: { POST: unknown };
  let meRoute: { GET: unknown };
  let securityRoute: { GET: unknown };
  let dataProject = '';

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    for (const key of UNSET) delete process.env[key];
    auth = await import('@/lib/server/auth');
    saml = await import('@/lib/server/auth/saml');
    projects = await import('@/lib/server/projects');
    loginRoute = await import('@/app/api/auth/saml/login/route');
    acsRoute = await import('@/app/api/auth/saml/acs/route');
    metadataRoute = await import('@/app/api/auth/saml/metadata/route');
    logoutRoute = await import('@/app/api/auth/saml/logout/route');
    appLogoutRoute = await import('@/app/api/auth/logout/route');
    meRoute = await import('@/app/api/auth/me/route');
    securityRoute = await import('@/app/api/settings/security/route');
    auth.disableTestAuth();
    await auth.createOwner({ email: 'owner@landflow.test', name: 'Owner', password: 'owner-password' });
    dataProject = projects.createTeamProject({ name: 'Data' }).id;
  });

  afterAll(() => {
    auth?.enableTestAuth();
    saml?.resetSamlCaches();
    for (const key of [...Object.keys(ENV), ...UNSET]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  /** The whole browser round trip for one Keycloak user: the Landflow session, where it lands and Keycloak's cookies. */
  async function signInAs(username: string, password: string, next = '/workflows') {
    // 1. Landflow sends the browser to Keycloak with an AuthnRequest (and sets the RelayState cookie).
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login?next=${encodeURIComponent(next)}`));
    expect(started.status).toBe(307);
    const stateCookie = started.headers.getSetCookie().find((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=`))!.split(';')[0];
    const ssoUrl = started.headers.get('location')!;
    expect(ssoUrl.startsWith(`${REALM}/protocol/saml?SAMLRequest=`)).toBe(true);

    // 2. Keycloak's login page.
    const jar = new Jar();
    const page = await fetch(ssoUrl, { redirect: 'manual' });
    jar.take(page);
    const html = await page.text();
    expect(page.status, html.slice(0, 500)).toBe(200);
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1] ?? /<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"/.exec(html)?.[1];
    expect(action, 'Keycloak login form').toBeTruthy();

    // 3. Submit the credentials: Keycloak answers with a form that posts the signed SAMLResponse to our ACS.
    const submitted = await fetch(decodeHtml(action!), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username, password, credentialId: '' }),
    });
    jar.take(submitted);
    const formHtml = await submitted.text();
    expect(submitted.status, formHtml.slice(0, 300)).toBe(200);
    const form = postForm(formHtml);
    expect(form.action).toBe(`${BASE}/api/auth/saml/acs`);
    expect(form.fields.SAMLResponse, 'SAMLResponse in Keycloak’s form').toBeTruthy();
    const xml = Buffer.from(form.fields.SAMLResponse, 'base64').toString('utf8');
    expect(xml).toContain('<dsig:Signature');

    // 4. The browser posts it to Landflow's ACS (with the RelayState cookie): validated, user found or made, signed in.
    const done = await (acsRoute.POST as Route)(
      new Request(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:58080', cookie: stateCookie },
        body: new URLSearchParams(form.fields),
      }),
    );
    const location = done.headers.get('location') ?? '';
    const session = done.headers.getSetCookie().find((c) => c.startsWith('landflow_session='))?.split(';')[0].slice('landflow_session='.length);
    return { location, session, jar, response: form.fields.SAMLResponse };
  }

  async function me(session: string) {
    const response = await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${session}` } }));
    expect(response.status).toBe(200);
    return (await response.json()).user as { id: string; email: string; name: string; role: string; sso: boolean; hasPassword: boolean; provisionedBy?: string };
  }

  it('Settings → Security reads Keycloak’s metadata', async () => {
    const owner = auth.findUserByEmail('owner@landflow.test')!;
    const { token } = auth.createSession(owner, 'password');
    const response = await (securityRoute.GET as Route)(new Request(`${BASE}/api/settings/security`, { headers: { cookie: `landflow_session=${token}` } }));
    const view = (await response.json()).saml;
    expect(view).toMatchObject({
      configured: true,
      entityId: `${BASE}/api/auth/saml/metadata`,
      acsUrl: `${BASE}/api/auth/saml/acs`,
      idpIssuer: REALM,
      idpSsoUrl: `${REALM}/protocol/saml`,
      idpSloUrl: `${REALM}/protocol/saml`,
    });
    expect(view.idpCerts).toBeGreaterThan(0);
    expect(view.error).toBeUndefined();
    // Our metadata (what Keycloak's client was made from) has the same entity id.
    const metadata = await (await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`))).text();
    expect(metadata).toContain(`entityID="${BASE}/api/auth/saml/metadata"`);
  });

  it('alice (landflow-admin) signs in as a new admin and lands where she was going', async () => {
    const { location, session, response } = await signInAs('alice', 'alice-test-only', '/workflows');
    expect(location).toBe(`${BASE}/workflows`);
    expect(session).toBeTruthy();
    const user = await me(session!);
    expect(user).toMatchObject({ email: 'alice@landflow.test', name: 'Alice Admin', role: 'admin', sso: true, hasPassword: false, provisionedBy: 'saml' });
    expect(auth.findUserByEmail('alice@landflow.test')).toMatchObject({ samlIssuer: REALM, provisionedBy: 'saml' });
    expect(auth.findUserByEmail('alice@landflow.test')!.samlSubject).toMatch(/^G-/);

    // Keycloak's response can't be posted again (a new sign-in around it doesn't help).
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login`));
    const state = started.headers.getSetCookie().find((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=`))!.split(';')[0];
    const replay = await (acsRoute.POST as Route)(
      new Request(`${BASE}/api/auth/saml/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: state },
        body: new URLSearchParams({ SAMLResponse: response, RelayState: state.split('=')[1] }),
      }),
    );
    expect(decodeURIComponent(replay.headers.get('location') ?? '')).toContain('This SAML response was already used');

    // A second sign-in finds the same user.
    const again = await signInAs('alice', 'alice-test-only', '/');
    expect((await me(again.session!)).id).toBe(user.id);
  });

  it('bob (landflow-editor, group data-team) signs in as a member and an editor of the Data project', async () => {
    const { session } = await signInAs('bob', 'bob-test-only');
    const user = await me(session!);
    expect(user).toMatchObject({ email: 'bob@landflow.test', name: 'Bob Editor', role: 'member' });
    expect(projects.membershipsOf(user.id).find((m) => m.projectId === dataProject)).toMatchObject({ role: 'editor', source: 'saml' });
  });

  it('a deactivated user is refused after Keycloak signs them in', async () => {
    const bob = auth.findUserByEmail('bob@landflow.test')!;
    auth.setUserDisabled(bob.id, true);
    const { session, location } = await signInAs('bob', 'bob-test-only');
    expect(session).toBeUndefined();
    expect(decodeURIComponent(location)).toContain('This account is deactivated');
    auth.setUserDisabled(bob.id, false);
  });

  it('single logout: signing out goes to Keycloak, which ends its session and answers our logout endpoint', async () => {
    const { session, jar } = await signInAs('alice', 'alice-test-only');
    const signedOut = await (appLogoutRoute.POST as Route)(new Request(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: `landflow_session=${session}` } }));
    const { redirect } = await signedOut.json();
    expect(redirect.startsWith(`${REALM}/protocol/saml?SAMLRequest=`)).toBe(true);
    expect(auth.sessionUser(session)).toBeUndefined();

    // Keycloak logs alice out and sends the LogoutResponse back (HTTP-POST binding: a form to our logout URL).
    const atKeycloak = await fetch(redirect, { redirect: 'manual', headers: { cookie: jar.header() } });
    const html = await atKeycloak.text();
    let back: Response;
    if (atKeycloak.status === 200) {
      const form = postForm(html);
      expect(form.action).toBe(`${BASE}/api/auth/saml/logout`);
      expect(form.fields.SAMLResponse).toBeTruthy();
      back = await (logoutRoute.POST as Route)(new Request(form.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields) }));
    } else {
      const location = atKeycloak.headers.get('location')!;
      expect(location.startsWith(`${BASE}/api/auth/saml/logout?`)).toBe(true);
      back = await (logoutRoute.GET as Route)(new Request(location));
    }
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`${BASE}/login`);

    // Keycloak's own session is gone: the next sign-in shows the login form again.
    const started = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login`));
    const page = await fetch(started.headers.get('location')!, { redirect: 'manual', headers: { cookie: jar.header() } });
    expect(await page.text()).toContain('kc-form-login');
  });

  it('encrypted assertions: Keycloak encrypts to our certificate, Landflow decrypts with the uploaded key; required refuses plain ones', async () => {
    const keys = await import('@/lib/server/auth/saml-keys');
    const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'saml', name), 'utf8');
    keys.uploadSamlEncryptionKey({ cert: fixture('sp-encryption.cert.pem'), key: fixture('sp-encryption.key.pem') });
    process.env.LANDFLOW_SAML_ISSUER = 'urn:landflow:test:saml-encrypted';
    try {
      // Our metadata offers the certificate for encryption.
      const metadata = await (await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`))).text();
      expect(metadata).toContain('entityID="urn:landflow:test:saml-encrypted"');
      expect(metadata).toContain('<KeyDescriptor use="encryption">');

      const { session, response } = await signInAs('alice', 'alice-test-only');
      const xml = Buffer.from(response, 'base64').toString('utf8');
      expect(xml).toMatch(/<saml:EncryptedAssertion|<EncryptedAssertion/);
      expect(xml).not.toContain('alice@landflow.test');
      expect(session).toBeTruthy();
      expect(await me(session!)).toMatchObject({ email: 'alice@landflow.test', role: 'admin' });

      keys.setSamlEncryptionRequired(true);
      expect((await signInAs('alice', 'alice-test-only')).session).toBeTruthy();
      // The plain client (assertions in the clear) is refused now.
      delete process.env.LANDFLOW_SAML_ISSUER;
      const plain = await signInAs('alice', 'alice-test-only');
      expect(plain.session).toBeUndefined();
      expect(decodeURIComponent(plain.location)).toContain('requires encrypted assertions');
    } finally {
      delete process.env.LANDFLOW_SAML_ISSUER;
      keys.removeSamlEncryptionKey();
    }
  });
});
