/**
 * SAML 2.0 sign-in (lib/server/auth/saml.ts and /api/auth/saml/*) against responses built and signed here with the
 * test IdP key in test/fixtures/saml (xml-crypto through node-saml's signer): the SP-initiated login and its
 * AuthnRequest, our metadata, response validation (signed assertion or response, unsigned, wrong certificate,
 * expired, clock skew, replay, audience, issuer, InResponseTo, RelayState), just-in-time users, role and project
 * mapping, linking by email, deactivated users, single logout both ways, IdP metadata and Settings → Security.
 * The test bypass is off: requests carry real cookies or none.
 */
import { createSign, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'saml', name), 'utf8');
const IDP_KEY = fixture('idp.key.pem');
const IDP_CERT = fixture('idp.cert.pem');
const OTHER_KEY = fixture('other.key.pem');
const OTHER_CERT = fixture('other.cert.pem');

const BASE = 'http://localhost:3000';
const IDP = 'https://idp.example.test/realms/acme';
const SSO_URL = `${IDP}/protocol/saml`;
const ENTITY_ID = `${BASE}/api/auth/saml/metadata`;
const ACS = `${BASE}/api/auth/saml/acs`;

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-saml-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SAML_ENTRY_POINT: SSO_URL,
  LANDFLOW_SAML_IDP_ISSUER: IDP,
  LANDFLOW_SAML_IDP_CERT: IDP_CERT,
  LANDFLOW_SAML_LOGOUT_URL: `${IDP}/protocol/saml/logout`,
  LANDFLOW_SAML_ROLE_MAP: 'landflow-admins=admin,landflow-users=member',
  LANDFLOW_SAML_PROJECT_MAP: 'data-team=Data:editor,ops=Ops:viewer',
  LANDFLOW_SAML_LABEL: 'Sign in with Acme',
};
const UNSET = ['LANDFLOW_PUBLIC_URL', 'LANDFLOW_SECURE_COOKIES', 'LANDFLOW_SAML_IDP_METADATA_URL', 'LANDFLOW_SAML_ISSUER', 'LANDFLOW_SAML_JIT', 'LANDFLOW_SAML_DEFAULT_ROLE', 'LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED', 'LANDFLOW_SAML_CLOCK_SKEW_SECONDS', 'LANDFLOW_OIDC_ISSUER'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const saml = await import('@/lib/server/auth/saml');
const projects = await import('@/lib/server/projects');
const { authDb } = await import('@/lib/server/auth/db');
const loginRoute = await import('@/app/api/auth/saml/login/route');
const acsRoute = await import('@/app/api/auth/saml/acs/route');
const metadataRoute = await import('@/app/api/auth/saml/metadata/route');
const logoutRoute = await import('@/app/api/auth/saml/logout/route');
const appLogoutRoute = await import('@/app/api/auth/logout/route');
const meRoute = await import('@/app/api/auth/me/route');
const statusRoute = await import('@/app/api/auth/status/route');
const securityRoute = await import('@/app/api/settings/security/route');

type Route = (request: Request) => Promise<Response>;

let ownerSession = '';

beforeAll(async () => {
  auth.disableTestAuth();
  const owner = await auth.createOwner({ email: 'owner@acme.test', name: 'Olive Owner', password: 'owner-password-1' });
  ownerSession = auth.createSession(owner, 'password').token;
});
beforeEach(() => {
  for (const key of ['LANDFLOW_SAML_JIT', 'LANDFLOW_SAML_DEFAULT_ROLE', 'LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED', 'LANDFLOW_SAML_CLOCK_SKEW_SECONDS']) delete process.env[key];
});
afterAll(() => {
  auth.enableTestAuth();
  saml.resetSamlCaches();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- helpers -----------------------------------------------------------------------------------------------

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;

/** Start a sign-in like a browser: the RelayState cookie and the AuthnRequest the IdP would get. */
async function startLogin(next = '/workflows') {
  const response = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login?next=${encodeURIComponent(next)}`));
  const location = new URL(response.headers.get('location')!);
  const cookieLine = response.headers.getSetCookie().find((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=`))!;
  const state = cookieLine.split(';')[0].slice(saml.SAML_STATE_COOKIE.length + 1);
  const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  const requestId = /\sID="([^"]+)"/.exec(request)![1];
  return { response, location, cookieLine, state, request, requestId, relayState: location.searchParams.get('RelayState')! };
}

interface ResponseOptions {
  inResponseTo?: string;
  nameID?: string;
  attributes?: Record<string, string[]>;
  notBefore?: string;
  notOnOrAfter?: string;
  audience?: string;
  issuer?: string;
  responseId?: string;
  assertionId?: string;
  sign?: 'assertion' | 'response' | 'both' | 'none';
  key?: string;
  cert?: string;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RESPONSE_XPATH = "/*[local-name(.)='Response' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:protocol']";
const ASSERTION_XPATH = `${RESPONSE_XPATH}/*[local-name(.)='Assertion' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:assertion']`;

/** A SAMLResponse (base64) as an IdP posts it, signed with the test IdP key unless told otherwise. */
function samlResponse(options: ResponseOptions = {}): string {
  const issuer = options.issuer ?? IDP;
  const now = iso(0);
  const inResponseTo = options.inResponseTo ? ` InResponseTo="${esc(options.inResponseTo)}"` : '';
  const attributes = Object.entries(options.attributes ?? { email: ['ada@acme.test'], firstName: ['Ada'], lastName: ['Lovelace'], roles: ['landflow-users'] })
    .map(([name, values]) => `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
    .join('');
  const notOnOrAfter = options.notOnOrAfter ?? iso(5 * MIN);
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.responseId ?? `_r${randomUUID()}`}" Version="2.0" IssueInstant="${now}" Destination="${ACS}"${inResponseTo}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${options.assertionId ?? `_a${randomUUID()}`}" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${esc(options.nameID ?? 'G-ada-0001')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${options.notBefore ?? iso(-MIN)}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${esc(options.audience ?? ENTITY_ID)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_session-${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const signing = { privateKey: options.key ?? IDP_KEY, publicCert: options.cert ?? IDP_CERT, signatureAlgorithm: 'sha256' as const, digestAlgorithm: 'sha256' };
  const sign = options.sign ?? 'assertion';
  let signed = xml;
  if (sign === 'assertion' || sign === 'both') signed = signSamlPost(signed, ASSERTION_XPATH, signing);
  if (sign === 'response' || sign === 'both') signed = signSamlPost(signed, RESPONSE_XPATH, signing);
  return Buffer.from(signed).toString('base64');
}

/** POST the IdP's form to the ACS route with the browser's RelayState cookie. */
async function postAcs(response: string, relayState: string, cookieState: string | undefined = relayState) {
  const result = await (acsRoute.POST as Route)(
    new Request(ACS, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.test', ...(cookieState && { cookie: `${saml.SAML_STATE_COOKIE}=${cookieState}` }) },
      body: new URLSearchParams({ SAMLResponse: response, RelayState: relayState }),
    }),
  );
  const location = result.headers.get('location') ?? '';
  const session = result.headers.getSetCookie().find((c) => c.startsWith('landflow_session='))?.split(';')[0].slice('landflow_session='.length) || undefined;
  const error = location.includes('/login?error=') ? new URL(location).searchParams.get('error') : undefined;
  return { status: result.status, location, session, error, cookies: result.headers.getSetCookie() };
}

/** A full sign-in: start, have the IdP answer, post it. */
async function signIn(options: ResponseOptions = {}, next = '/workflows') {
  const login = await startLogin(next);
  return postAcs(samlResponse({ inResponseTo: login.requestId, ...options }), login.state);
}

async function me(session: string) {
  const response = await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${session}` } }));
  expect(response.status).toBe(200);
  return (await response.json()).user as { id: string; email: string; name: string; role: string; sso: boolean; hasPassword: boolean; provisionedBy?: string };
}

// ---- tests -------------------------------------------------------------------------------------------------

describe('configuration and metadata', () => {
  it('reads the environment', () => {
    const config = saml.samlConfig()!;
    expect(config).toMatchObject({ entryPoint: SSO_URL, idpIssuer: IDP, clockSkewSeconds: 120, wantAssertionsSigned: true, wantResponseSigned: false, jit: true, defaultRole: 'member', label: 'Sign in with Acme' });
    expect(config.idpCerts).toHaveLength(1);
    expect(config.roleMap).toEqual({ 'landflow-admins': 'admin', 'landflow-users': 'member' });
    expect(config.projectMap).toEqual({ 'data-team': { project: 'Data', role: 'editor' }, ops: { project: 'Ops', role: 'viewer' } });
    expect(saml.parseCerts(`${IDP_CERT}\n${OTHER_CERT}`)).toHaveLength(2);
    expect(saml.parseCerts('MIIBbase64one, MIIBbase64two')).toEqual(['MIIBbase64one', 'MIIBbase64two']);
  });

  it('serves the SP metadata: entity id, ACS (HTTP-POST), single logout, signed assertions wanted', async () => {
    const response = await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/samlmetadata+xml');
    const xml = await response.text();
    expect(xml).toContain(`entityID="${ENTITY_ID}"`);
    expect(xml).toMatch(/<AssertionConsumerService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]*Location="http:\/\/localhost:3000\/api\/auth\/saml\/acs"/);
    expect(xml).toMatch(/<SingleLogoutService[^>]*Location="http:\/\/localhost:3000\/api\/auth\/saml\/logout"/);
    expect(xml).toContain('WantAssertionsSigned="true"');
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });

  it('puts our certificate in the metadata when we sign requests', () => {
    const xml = saml.spMetadata({ ...saml.samlConfig()!, privateKey: OTHER_KEY, publicCert: OTHER_CERT }, BASE);
    expect(xml).toContain('AuthnRequestsSigned="true"');
    expect(xml).toContain(OTHER_CERT.split('\n')[1].slice(0, 40));
  });

  it('reads IdP metadata: entity id, redirect-binding SSO and logout URLs, signing certificates', async () => {
    const body = IDP_CERT.replace(/-----[^-]+-----|\s/g, '');
    const idp = await saml.parseIdpMetadata(
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>ENCRYPTIONONLY</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP}/slo-post"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP}/slo"/>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP}/sso-post"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP}/sso"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`,
    );
    expect(idp).toEqual({ issuer: IDP, entryPoint: `${IDP}/sso`, logoutUrl: `${IDP}/slo`, certs: [body] });
  });

  it('the sign-in page learns the button label; Settings → Security shows the configuration', async () => {
    const status = await (await (statusRoute.GET as Route)(new Request(`${BASE}/api/auth/status`))).json();
    expect(status.saml).toEqual({ label: 'Sign in with Acme' });
    const response = await (securityRoute.GET as Route)(new Request(`${BASE}/api/settings/security`, { headers: { cookie: `landflow_session=${ownerSession}` } }));
    expect(response.status).toBe(200);
    const view = (await response.json()).saml;
    expect(view).toMatchObject({
      configured: true,
      label: 'Sign in with Acme',
      entityId: ENTITY_ID,
      acsUrl: ACS,
      metadataUrl: ENTITY_ID,
      idpSsoUrl: SSO_URL,
      idpIssuer: IDP,
      idpSloUrl: `${IDP}/protocol/saml/logout`,
      idpCerts: 1,
      wantAssertionsSigned: true,
      clockSkewSeconds: 120,
      roleAttribute: 'roles',
      projectAttribute: 'groups',
      roleMap: { 'landflow-admins': 'admin', 'landflow-users': 'member' },
      projectMap: { 'data-team': 'Data:editor', ops: 'Ops:viewer' },
      jit: true,
    });
    expect(view.idpCertExpires).toMatch(/^2126-10-01T/);
    expect(view.error).toBeUndefined();
  });
});

describe('SP-initiated sign-in', () => {
  it('redirects to the IdP with a deflated AuthnRequest and binds the RelayState to a cookie', async () => {
    const login = await startLogin('/workflows/wf_1');
    expect(login.response.status).toBe(307);
    expect(`${login.location.origin}${login.location.pathname}`).toBe(SSO_URL);
    expect(login.relayState).toBe(login.state);
    expect(login.cookieLine).toMatch(/HttpOnly/i);
    expect(login.cookieLine).toMatch(/Path=\/api\/auth\/saml/i);
    expect(login.cookieLine).toMatch(/SameSite=lax/i);
    expect(login.request).toContain(`Destination="${SSO_URL}"`);
    expect(login.request).toContain(`AssertionConsumerServiceURL="${ACS}"`);
    expect(login.request).toContain(`ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`);
    expect(login.request).toMatch(new RegExp(`<saml:Issuer[^>]*>${ENTITY_ID}</saml:Issuer>`));
    expect(login.request).not.toContain('RequestedAuthnContext');
  });

  it('sets the state cookie SameSite=None; Secure behind https (the IdP posts from its own site)', async () => {
    const response = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login`, { headers: { 'x-forwarded-proto': 'https' } }));
    const line = response.headers.getSetCookie().find((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=`))!;
    expect(line).toMatch(/SameSite=none/i);
    expect(line).toMatch(/Secure/i);
  });

  it('a signed assertion signs in a new user (just in time) and lands on the page asked for', async () => {
    const result = await signIn({}, '/workflows/wf_1');
    expect(result.status).toBe(303);
    expect(result.location).toBe(`${BASE}/workflows/wf_1`);
    expect(result.session).toBeTruthy();
    expect(result.cookies.some((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=;`) && /Max-Age=0/i.test(c))).toBe(true);
    const user = await me(result.session!);
    expect(user).toMatchObject({ email: 'ada@acme.test', name: 'Ada Lovelace', role: 'member', sso: true, hasPassword: false, provisionedBy: 'saml' });
    const stored = auth.findUserByEmail('ada@acme.test')!;
    expect(stored).toMatchObject({ samlIssuer: IDP, samlSubject: 'G-ada-0001', provisionedBy: 'saml' });

    // Again: the same user, found by the SAML identity.
    const again = await signIn();
    expect((await me(again.session!)).id).toBe(user.id);
  });

  it('a response signed as a whole (assertion unsigned) needs LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED=false', async () => {
    const refused = await signIn({ sign: 'response', nameID: 'G-ada-0001' });
    expect(refused.session).toBeUndefined();
    expect(refused.error).toBe('The SAML response isn’t signed by the identity provider’s certificate');
    process.env.LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED = 'false';
    const accepted = await signIn({ sign: 'response', nameID: 'G-ada-0001' });
    expect(accepted.session).toBeTruthy();
    const both = await signIn({ sign: 'both', nameID: 'G-ada-0001' });
    expect(both.session).toBeTruthy();
  });

  it('refuses an unsigned response', async () => {
    const result = await signIn({ sign: 'none' });
    expect(result.status).toBe(303);
    expect(result.session).toBeUndefined();
    expect(result.location.startsWith(`${BASE}/login?error=`)).toBe(true);
    expect(result.error).toBe('The SAML response isn’t signed by the identity provider’s certificate');
  });

  it('refuses a response signed with another key', async () => {
    const result = await signIn({ key: OTHER_KEY, cert: OTHER_CERT });
    expect(result.session).toBeUndefined();
    expect(result.error).toBe('The SAML response isn’t signed by the identity provider’s certificate');
  });

  it('refuses a response whose signed content was changed', async () => {
    const login = await startLogin();
    const tampered = Buffer.from(Buffer.from(samlResponse({ inResponseTo: login.requestId }), 'base64').toString('utf8').replace('landflow-users', 'landflow-admins')).toString('base64');
    const result = await postAcs(tampered, login.state);
    expect(result.session).toBeUndefined();
    expect(result.error).toBe('The SAML response isn’t signed by the identity provider’s certificate');
  });

  it('refuses an expired response', async () => {
    const result = await signIn({ notBefore: iso(-20 * MIN), notOnOrAfter: iso(-10 * MIN) });
    expect(result.session).toBeUndefined();
    expect(result.error).toMatch(/expired/);
  });

  it('allows clock skew within LANDFLOW_SAML_CLOCK_SKEW_SECONDS and refuses beyond it', async () => {
    // The IdP's clock is a minute ahead: NotBefore is in our future, within the default 120 s.
    expect((await signIn({ notBefore: iso(MIN) })).session).toBeTruthy();
    // Expired 90 s ago: still within 120 s of skew.
    expect((await signIn({ notBefore: iso(-5 * MIN), notOnOrAfter: iso(-1.5 * MIN) })).session).toBeTruthy();
    // Ten minutes ahead is too far.
    const ahead = await signIn({ notBefore: iso(10 * MIN) });
    expect(ahead.session).toBeUndefined();
    expect(ahead.error).toBe('The SAML response isn’t valid yet (check the clocks)');
    // With no skew allowed, 90 s expired is expired.
    process.env.LANDFLOW_SAML_CLOCK_SKEW_SECONDS = '0';
    expect((await signIn({ notBefore: iso(-5 * MIN), notOnOrAfter: iso(-1.5 * MIN) })).error).toMatch(/expired/);
  });

  it('refuses a replayed response, even with a fresh sign-in around it', async () => {
    const first = await startLogin();
    const response = samlResponse({ inResponseTo: first.requestId, responseId: '_replay-response-1', assertionId: '_replay-assertion-1' });
    expect((await postAcs(response, first.state)).session).toBeTruthy();
    const rows = authDb().all<{ id: string; expires_at: string }>(`SELECT * FROM saml_replay WHERE id LIKE '%_replay-%' ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['assertion:_replay-assertion-1', 'response:_replay-response-1']);
    // Kept until NotOnOrAfter (5 minutes) plus the skew (2 minutes).
    expect(Date.parse(rows[0].expires_at) - Date.now()).toBeGreaterThan(6.5 * MIN);

    const second = await startLogin();
    const replayed = await postAcs(response, second.state);
    expect(replayed.session).toBeUndefined();
    expect(replayed.error).toBe('This SAML response was already used. Sign in again.');
    // A new response that reuses the signed assertion's id is a replay too.
    const third = await startLogin();
    const reused = await postAcs(samlResponse({ inResponseTo: third.requestId, assertionId: '_replay-assertion-1' }), third.state);
    expect(reused.error).toBe('This SAML response was already used. Sign in again.');
  });

  it('refuses a response for another service provider (audience)', async () => {
    const result = await signIn({ audience: 'https://other-sp.example.test/metadata' });
    expect(result.session).toBeUndefined();
    expect(result.error).toBe('The SAML response is meant for another service provider (audience)');
  });

  it('refuses an assertion from another issuer, even signed with the IdP key', async () => {
    const result = await signIn({ issuer: 'https://evil.example.test' });
    expect(result.session).toBeUndefined();
    expect(result.error).toBe(`The SAML assertion is from https://evil.example.test, not ${IDP}`);
  });

  it('refuses a response to a request this host never sent, and unsolicited (IdP-initiated) responses', async () => {
    const login = await startLogin();
    const forged = await postAcs(samlResponse({ inResponseTo: '_never-sent' }), login.state);
    expect(forged.session).toBeUndefined();
    expect(forged.error).toBe('This SAML response doesn’t answer a sign-in started here, or it timed out. Try again.');
    const again = await startLogin();
    const unsolicited = await postAcs(samlResponse({}), again.state);
    expect(unsolicited.session).toBeUndefined();
    expect(unsolicited.error).toMatch(/doesn’t answer a sign-in started here/);
  });

  it('refuses a RelayState that doesn’t match the browser’s cookie (login CSRF)', async () => {
    const victim = await startLogin();
    const attacker = await startLogin();
    const response = samlResponse({ inResponseTo: attacker.requestId });
    expect((await postAcs(response, attacker.state, victim.state)).error).toBe('This sign-in expired or was started in another browser. Try again.');
    expect((await postAcs(response, attacker.state, '')).error).toBe('This sign-in expired or was started in another browser. Try again.');
  });

  it('refuses a form without a SAMLResponse, or garbage', async () => {
    const login = await startLogin();
    expect((await postAcs('', login.state)).error).toBe('The identity provider sent no SAML response');
    const other = await startLogin();
    expect((await postAcs(Buffer.from('not xml at all').toString('base64'), other.state)).error).toBe('The SAML response isn’t valid XML');
  });
});

describe('users, roles and projects', () => {
  it('maps roles and refreshes them at every sign-in', async () => {
    const result = await signIn({ nameID: 'G-grace', attributes: { email: ['grace@acme.test'], name: ['Grace Hopper'], roles: ['landflow-admins', 'other'] } });
    expect(await me(result.session!)).toMatchObject({ email: 'grace@acme.test', name: 'Grace Hopper', role: 'admin' });
    const later = await signIn({ nameID: 'G-grace', attributes: { email: ['grace@acme.test'], roles: ['landflow-users'] } });
    expect((await me(later.session!)).role).toBe('member');
    // No mapped role: the role stays as it is.
    const unmapped = await signIn({ nameID: 'G-grace', attributes: { email: ['grace@acme.test'], roles: ['something-else'] } });
    expect((await me(unmapped.session!)).role).toBe('member');
  });

  it('reads Entra ID style claim names and repeated attributes', async () => {
    const result = await signIn({
      nameID: 'entra-oid-1',
      attributes: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': ['Edsger@Acme.test'],
        'http://schemas.microsoft.com/identity/claims/displayname': ['Edsger Dijkstra'],
        'http://schemas.microsoft.com/ws/2008/06/identity/claims/role': ['landflow-admins'],
      },
    });
    expect(await me(result.session!)).toMatchObject({ email: 'edsger@acme.test', name: 'Edsger Dijkstra', role: 'admin' });
  });

  it('links an existing user by email, and never changes the owner’s role', async () => {
    const owner = await signIn({ nameID: 'G-owner', attributes: { email: ['owner@acme.test'], roles: ['landflow-users'] } });
    const viewer = await me(owner.session!);
    expect(viewer).toMatchObject({ email: 'owner@acme.test', role: 'owner', hasPassword: true, sso: true });
    expect(auth.findUserByEmail('owner@acme.test')).toMatchObject({ samlSubject: 'G-owner', samlIssuer: IDP });
    expect(auth.findUserByEmail('owner@acme.test')!.provisionedBy).toBeUndefined();
  });

  it('grants team project memberships from the project attribute, and takes back only its own', async () => {
    const data = projects.createTeamProject({ name: 'Data' });
    const ops = projects.createTeamProject({ name: 'Ops' });
    const manual = projects.createTeamProject({ name: 'Handmade' });
    const first = await signIn({ nameID: 'G-linus', attributes: { email: ['linus@acme.test'], groups: ['data-team', 'ops', 'unmapped'] } });
    const user = await me(first.session!);
    const memberships = () => Object.fromEntries(projects.membershipsOf(user.id).filter((m) => m.source !== 'personal').map((m) => [m.projectId, `${m.role}/${m.source ?? 'manual'}`]));
    expect(memberships()).toEqual({ [data.id]: 'editor/saml', [ops.id]: 'viewer/saml' });

    projects.setMember(manual.id, user.id, 'viewer');
    const second = await signIn({ nameID: 'G-linus', attributes: { email: ['linus@acme.test'], groups: ['ops'] } });
    expect(second.session).toBeTruthy();
    expect(memberships()).toEqual({ [ops.id]: 'viewer/saml', [manual.id]: 'viewer/manual' });
  });

  it('refuses a deactivated user, and ends the sessions they had', async () => {
    const result = await signIn({ nameID: 'G-mallory', attributes: { email: ['mallory@acme.test'], roles: ['landflow-users'] } });
    const user = await me(result.session!);
    auth.setUserDisabled(user.id, true);
    const meAfter = await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${result.session}` } }));
    expect(meAfter.status).toBe(401);
    const again = await signIn({ nameID: 'G-mallory', attributes: { email: ['mallory@acme.test'] } });
    expect(again.session).toBeUndefined();
    expect(again.error).toBe('This account is deactivated. Ask an admin to reactivate it.');
    // Matched by email (a new SAML subject) it is refused as well.
    const byEmail = await signIn({ nameID: 'G-mallory-2', attributes: { email: ['mallory@acme.test'] } });
    expect(byEmail.error).toBe('This account is deactivated. Ask an admin to reactivate it.');
    auth.setUserDisabled(user.id, false);
    expect((await signIn({ nameID: 'G-mallory', attributes: { email: ['mallory@acme.test'] } })).session).toBeTruthy();
  });

  it('without just-in-time provisioning, or with default role none, unknown users are refused', async () => {
    process.env.LANDFLOW_SAML_JIT = 'false';
    const noJit = await signIn({ nameID: 'G-new-1', attributes: { email: ['new1@acme.test'], roles: ['landflow-users'] } });
    expect(noJit.error).toBe('There is no Landflow account for new1@acme.test. Ask an admin to invite you.');
    expect(auth.findUserByEmail('new1@acme.test')).toBeUndefined();
    delete process.env.LANDFLOW_SAML_JIT;
    process.env.LANDFLOW_SAML_DEFAULT_ROLE = 'none';
    const unmapped = await signIn({ nameID: 'G-new-2', attributes: { email: ['new2@acme.test'], roles: ['guests'] } });
    expect(unmapped.error).toBe('Your account has no Landflow role at the identity provider. Ask an admin for access.');
    const mapped = await signIn({ nameID: 'G-new-3', attributes: { email: ['new3@acme.test'], roles: ['landflow-users'] } });
    expect((await me(mapped.session!)).role).toBe('member');
  });

  it('needs an email for a new user (or an email NameID)', async () => {
    const none = await signIn({ nameID: 'opaque-id', attributes: { roles: ['landflow-users'] } });
    expect(none.error).toBe('The identity provider didn’t send an email address (add an email attribute)');
    const nameIdEmail = await signIn({ nameID: 'barbara@acme.test', attributes: {} });
    expect(await me(nameIdEmail.session!)).toMatchObject({ email: 'barbara@acme.test', role: 'member' });
  });
});

describe('single logout', () => {
  it('signing out of a SAML session sends a LogoutRequest to the IdP', async () => {
    const result = await signIn({ nameID: 'G-ken', attributes: { email: ['ken@acme.test'] } });
    const response = await (appLogoutRoute.POST as Route)(new Request(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: `landflow_session=${result.session}` } }));
    const body = await response.json();
    expect(body.ok).toBe(true);
    const url = new URL(body.redirect);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/protocol/saml/logout`);
    const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    expect(request).toContain('LogoutRequest');
    expect(request).toContain('>G-ken</saml:NameID>');
    expect(request).toMatch(/<saml2?p:SessionIndex[^>]*>_session-/);
    // The session is gone here already.
    expect((await (meRoute.GET as Route)(new Request(`${BASE}/api/auth/me`, { headers: { cookie: `landflow_session=${result.session}` } }))).status).toBe(401);
  });

  it('a password session signs out locally', async () => {
    const owner = auth.findUserByEmail('owner@acme.test')!;
    const { token } = auth.createSession(owner, 'password');
    const response = await (logoutRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/logout`, { headers: { cookie: `landflow_session=${token}` } }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${BASE}/login`);
    expect(auth.sessionUser(token)).toBeUndefined();
  });

  /** An IdP's signed LogoutRequest in the HTTP-Redirect binding (the signature covers the query string). */
  function idpLogoutQuery(nameID: string, key = IDP_KEY): string {
    const xml =
      `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr${randomUUID()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${BASE}/api/auth/saml/logout">` +
      `<saml:Issuer>${IDP}</saml:Issuer><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${nameID}</saml:NameID></samlp:LogoutRequest>`;
    const params = new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(xml)).toString('base64'), RelayState: 'idp-state', SigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
    const signature = createSign('RSA-SHA256').update(params.toString()).sign(key, 'base64');
    params.set('Signature', signature);
    return params.toString();
  }

  it('an IdP-initiated LogoutRequest ends every session of that user and answers with a LogoutResponse', async () => {
    const one = await signIn({ nameID: 'G-dennis', attributes: { email: ['dennis@acme.test'] } });
    const two = await signIn({ nameID: 'G-dennis', attributes: { email: ['dennis@acme.test'] } });
    const response = await (logoutRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/logout?${idpLogoutQuery('G-dennis')}`));
    expect(response.status).toBe(303);
    const url = new URL(response.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/protocol/saml/logout`);
    expect(url.searchParams.get('RelayState')).toBe('idp-state');
    const answer = inflateRawSync(Buffer.from(url.searchParams.get('SAMLResponse')!, 'base64')).toString('utf8');
    expect(answer).toContain('LogoutResponse');
    expect(answer).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
    expect(auth.sessionUser(one.session)).toBeUndefined();
    expect(auth.sessionUser(two.session)).toBeUndefined();
  });

  it('refuses unsigned or wrongly signed IdP logout requests (nobody is signed out)', async () => {
    const result = await signIn({ nameID: 'G-bjarne', attributes: { email: ['bjarne@acme.test'] } });
    const wrongKey = await (logoutRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/logout?${idpLogoutQuery('G-bjarne', OTHER_KEY)}`));
    expect(wrongKey.headers.get('location')).toMatch(/\/login\?error=The\+logout\+message\+was\+refused|\/login\?error=The%20logout%20message%20was%20refused/);
    const unsigned = new URLSearchParams(idpLogoutQuery('G-bjarne'));
    unsigned.delete('Signature');
    unsigned.delete('SigAlg');
    const response = await (logoutRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/logout?${unsigned}`));
    expect(decodeURIComponent(response.headers.get('location')!)).toContain('The logout message was refused: it isn’t signed');
    expect(auth.sessionUser(result.session)).toBeDefined();
  });
});
