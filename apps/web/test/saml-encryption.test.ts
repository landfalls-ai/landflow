/**
 * Encrypted SAML assertions and the SAML state every main shares (lib/server/auth/saml-keys.ts, saml-state.ts,
 * saml.ts): the decryption key generated or uploaded in Settings → Security (sealed at rest, audited), our metadata's
 * encryption certificate, sign-in with an assertion signed by the test IdP and then encrypted here to our certificate
 * (xml-encryption, RSA-OAEP + AES-256-GCM, as Keycloak and others send it), one encrypted to another key, "Require
 * encrypted assertions", the decrypted assertion's id against replays; then sign-ins and logouts that survive the
 * database being closed and reopened between their steps (another main, or a restart), one-use request ids and
 * RelayStates, and expiry. Keycloak with a client that encrypts: saml.integration.test.ts.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing';
import type { SamlEncryptionView } from '@/lib/shared/auth';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'saml', name), 'utf8');
const IDP_KEY = fixture('idp.key.pem');
const IDP_CERT = fixture('idp.cert.pem');
const OTHER_CERT = fixture('other.cert.pem');
const SP_KEY = fixture('sp-encryption.key.pem');
const SP_CERT = fixture('sp-encryption.cert.pem');

/** xml-encryption, as node-saml has it (not a dependency of the app itself). */
const xmlenc = createRequire(require.resolve('@node-saml/node-saml/package.json'))('xml-encryption') as {
  encrypt(content: string, options: Record<string, unknown>, callback: (error: Error | null, result: string) => void): void;
};

const BASE = 'http://localhost:3000';
const IDP = 'https://idp.example.test/realms/acme';
const SSO_URL = `${IDP}/protocol/saml`;
const ENTITY_ID = `${BASE}/api/auth/saml/metadata`;
const ACS = `${BASE}/api/auth/saml/acs`;

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-saml-enc-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SAML_ENTRY_POINT: SSO_URL,
  LANDFLOW_SAML_IDP_ISSUER: IDP,
  LANDFLOW_SAML_IDP_CERT: IDP_CERT,
  LANDFLOW_SAML_LOGOUT_URL: `${IDP}/protocol/saml/logout`,
};
const UNSET = ['LANDFLOW_PUBLIC_URL', 'LANDFLOW_SECURE_COOKIES', 'LANDFLOW_SAML_IDP_METADATA_URL', 'LANDFLOW_SAML_ISSUER', 'LANDFLOW_SAML_DECRYPTION_KEY', 'LANDFLOW_SAML_DECRYPTION_CERT', 'LANDFLOW_OIDC_ISSUER'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const saml = await import('@/lib/server/auth/saml');
const state = await import('@/lib/server/auth/saml-state');
const { authDb } = await import('@/lib/server/auth/db');
const { closeDatabase } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const loginRoute = await import('@/app/api/auth/saml/login/route');
const acsRoute = await import('@/app/api/auth/saml/acs/route');
const metadataRoute = await import('@/app/api/auth/saml/metadata/route');
const appLogoutRoute = await import('@/app/api/auth/logout/route');
const securityRoute = await import('@/app/api/settings/security/route');
const encryptionRoute = await import('@/app/api/settings/security/saml/encryption/route');

type Route = (request: Request) => Promise<Response>;
let ownerSession = '';

beforeAll(async () => {
  auth.disableTestAuth();
  const owner = await auth.createOwner({ email: 'owner@acme.test', name: 'Olive Owner', password: 'owner-password-1' });
  ownerSession = auth.createSession(owner, 'password').token;
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
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RESPONSE_XPATH = "/*[local-name(.)='Response' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:protocol']";
const ASSERTION_XPATH = `${RESPONSE_XPATH}/*[local-name(.)='Assertion' and namespace-uri(.)='urn:oasis:names:tc:SAML:2.0:assertion']`;
const SIGNING = { privateKey: IDP_KEY, publicCert: IDP_CERT, signatureAlgorithm: 'sha256' as const, digestAlgorithm: 'sha256' };

/** Call a settings route as the owner. */
async function settings(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const request = new Request(`${BASE}/api/settings/security/saml/encryption`, {
    method,
    headers: { cookie: `landflow_session=${ownerSession}`, origin: BASE, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const response = await (encryptionRoute[method] as Route)(request);
  return { status: response.status, body: (await response.json()) as SamlEncryptionView & { error?: string } };
}

/** Start a sign-in like a browser: the RelayState cookie and the AuthnRequest's id. */
async function startLogin(next = '/workflows') {
  const response = await (loginRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/login?next=${encodeURIComponent(next)}`));
  const location = new URL(response.headers.get('location')!);
  const cookieLine = response.headers.getSetCookie().find((c) => c.startsWith(`${saml.SAML_STATE_COOKIE}=`))!;
  const relayState = cookieLine.split(';')[0].slice(saml.SAML_STATE_COOKIE.length + 1);
  const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  return { relayState, requestId: /\sID="([^"]+)"/.exec(request)![1] };
}

interface Options {
  inResponseTo: string;
  nameID?: string;
  email?: string;
  assertionId?: string;
  /** Encrypt the (signed) assertion to this certificate; plain when absent. */
  encryptTo?: string;
  signResponse?: boolean;
}

function encrypt(content: string, cert: string): Promise<string> {
  return new Promise((resolve, reject) =>
    xmlenc.encrypt(
      content,
      {
        rsa_pub: cert,
        pem: cert,
        encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
        warnInsecureAlgorithm: false,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}

/** A SAMLResponse (base64): the assertion signed with the test IdP key, then (maybe) encrypted, the response (maybe) signed. */
async function samlResponse(options: Options): Promise<string> {
  const now = iso(0);
  const notOnOrAfter = iso(5 * MIN);
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.assertionId ?? `_a${randomUUID()}`}" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${esc(options.nameID ?? 'G-enc-0001')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${esc(options.inResponseTo)}" NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-MIN)}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_session-${randomUUID()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${esc(options.email ?? 'enc@acme.test')}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="name"><saml:AttributeValue>Encrypted Ella</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;
  const open = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${ACS}" InResponseTo="${esc(options.inResponseTo)}">`;
  const head = `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`;
  const signed = signSamlPost(`${open}${head}${assertion}</samlp:Response>`, ASSERTION_XPATH, SIGNING);
  let xml = signed;
  if (options.encryptTo) {
    const signedAssertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(signed)![0];
    xml = `${open}${head}<saml:EncryptedAssertion>${await encrypt(signedAssertion, options.encryptTo)}</saml:EncryptedAssertion></samlp:Response>`;
  }
  if (options.signResponse) xml = signSamlPost(xml, RESPONSE_XPATH, SIGNING);
  return Buffer.from(xml).toString('base64');
}

async function postAcs(response: string, relayState: string) {
  const result = await (acsRoute.POST as Route)(
    new Request(ACS, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example.test', cookie: `${saml.SAML_STATE_COOKIE}=${relayState}` },
      body: new URLSearchParams({ SAMLResponse: response, RelayState: relayState }),
    }),
  );
  const location = result.headers.get('location') ?? '';
  const session = result.headers.getSetCookie().find((c) => c.startsWith('landflow_session='))?.split(';')[0].slice('landflow_session='.length) || undefined;
  return { location, session, error: location.includes('/login?error=') ? new URL(location).searchParams.get('error') : undefined };
}

async function signIn(options: Omit<Options, 'inResponseTo'> = {}) {
  const login = await startLogin();
  return postAcs(await samlResponse({ inResponseTo: login.requestId, ...options }), login.relayState);
}

const stateRows = (kind: string) => authDb().all<{ id: string; value: string; user_id: string | null; expires_at: string }>('SELECT * FROM saml_state WHERE kind = ?', kind);

// ---- tests -------------------------------------------------------------------------------------------------

describe('the decryption key (Settings → Security)', () => {
  beforeEach(async () => {
    await settings('DELETE');
  });

  it('generates a key pair: the certificate in Settings and in our metadata, the key sealed, the change audited', async () => {
    expect((await settings('GET')).body).toMatchObject({ configured: false, required: false, fromEnv: false });
    expect(await (await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`))).text()).not.toContain('use="encryption"');

    const generated = await settings('POST', { action: 'generate' });
    expect(generated.status).toBe(200);
    expect(generated.body).toMatchObject({ configured: true, source: 'generated', required: false, subject: expect.stringContaining('CN=Landflow SAML localhost:3000') });
    expect(generated.body.certificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(Date.parse(generated.body.validTo!) - Date.now()).toBeGreaterThan(9 * 365 * 86_400_000);

    const metadata = await (await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`))).text();
    const body = generated.body.certificate!.replace(/-----[^-]+-----|\s/g, '');
    expect(metadata).toMatch(/<KeyDescriptor use="encryption">/);
    expect(metadata.replace(/\s/g, '')).toContain(body);
    expect(metadata).toContain('http://www.w3.org/2009/xmlenc11#aes256-gcm');

    const stored = authDb().get<{ value: string }>(`SELECT value FROM settings WHERE key = 'saml_encryption'`)!.value;
    expect(stored).not.toContain('PRIVATE KEY');
    expect(queryEvents({ targetId: 'saml-encryption' }, { limit: 1 }).events[0]).toMatchObject({ action: 'settings.update', summary: 'Generated a new SAML decryption key', details: { source: 'generated' } });

    // Settings → Security shows it with the rest of SAML.
    const security = await (securityRoute.GET as Route)(new Request(`${BASE}/api/settings/security`, { headers: { cookie: `landflow_session=${ownerSession}` } }));
    expect((await security.json()).saml.encryption).toMatchObject({ configured: true, source: 'generated', fingerprint: generated.body.fingerprint });
  });

  it('uploads a certificate and its RSA key (an encrypted key with its passphrase), and refuses what doesn’t fit', async () => {
    expect((await settings('POST', { action: 'upload', cert: IDP_CERT, key: SP_KEY })).body.error).toBe('The private key doesn’t belong to the certificate');
    expect((await settings('POST', { action: 'upload', cert: 'nope', key: SP_KEY })).body.error).toMatch(/isn’t a PEM certificate/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect((await settings('POST', { action: 'upload', cert: SP_CERT, key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).status).toBe(400);
    const encrypted = createPrivateKey(SP_KEY).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'sp-passphrase' }) as string;
    expect((await settings('POST', { action: 'upload', cert: SP_CERT, key: encrypted })).body.error).toBe('The private key is encrypted: enter its passphrase');
    const uploaded = await settings('POST', { action: 'upload', cert: SP_CERT, key: encrypted, passphrase: 'sp-passphrase' });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ configured: true, source: 'uploaded', subject: expect.stringContaining('Landflow test SAML SP encryption') });
    expect(JSON.stringify(uploaded.body)).not.toContain('PRIVATE KEY');
  });

  it('requires a key before requiring encryption; removing the key stops requiring it', async () => {
    expect((await settings('PATCH', { required: true })).body.error).toBe('Generate or upload a decryption key first');
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    expect((await settings('PATCH', { required: true })).body).toMatchObject({ required: true });
    expect((await settings('DELETE')).body).toMatchObject({ configured: false, required: false });
  });

  it('from the environment, the key can’t be changed in Settings', async () => {
    process.env.LANDFLOW_SAML_DECRYPTION_KEY = SP_KEY.replace(/\n/g, '\\n');
    process.env.LANDFLOW_SAML_DECRYPTION_CERT = SP_CERT;
    try {
      expect((await settings('GET')).body).toMatchObject({ configured: true, source: 'env', fromEnv: true });
      expect((await settings('POST', { action: 'generate' })).body.error).toMatch(/LANDFLOW_SAML_DECRYPTION_KEY/);
      expect((await settings('PATCH', { required: true })).body).toMatchObject({ required: true });
      await settings('PATCH', { required: false });
    } finally {
      delete process.env.LANDFLOW_SAML_DECRYPTION_KEY;
      delete process.env.LANDFLOW_SAML_DECRYPTION_CERT;
    }
  });
});

describe('signing in with encrypted assertions', () => {
  beforeAll(async () => {
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
  });

  it('decrypts an assertion encrypted to our certificate (RSA-OAEP + AES-256-GCM) and signs the user in', async () => {
    const result = await signIn({ encryptTo: SP_CERT, nameID: 'G-ella', email: 'ella@acme.test' });
    expect(result.error).toBeUndefined();
    expect(result.session).toBeTruthy();
    expect(auth.findUserByEmail('ella@acme.test')).toMatchObject({ samlSubject: 'G-ella', name: 'Encrypted Ella' });
    // A response signed as a whole around the encrypted assertion works too.
    expect((await signIn({ encryptTo: SP_CERT, nameID: 'G-ella', email: 'ella@acme.test', signResponse: true })).session).toBeTruthy();
  });

  it('records the decrypted assertion’s id: a captured assertion re-sent is a replay', async () => {
    const login = await startLogin();
    const ok = await postAcs(await samlResponse({ inResponseTo: login.requestId, encryptTo: SP_CERT, assertionId: '_enc-assertion-1' }), login.relayState);
    expect(ok.session).toBeTruthy();
    expect(authDb().get('SELECT id FROM saml_replay WHERE id = ?', 'assertion:_enc-assertion-1')).toBeDefined();
    const again = await startLogin();
    const replayed = await postAcs(await samlResponse({ inResponseTo: again.requestId, encryptTo: SP_CERT, assertionId: '_enc-assertion-1' }), again.relayState);
    expect(replayed.session).toBeUndefined();
    expect(replayed.error).toBe('This SAML response was already used. Sign in again.');
  });

  it('refuses an assertion encrypted to another key, and one this instance has no key for', async () => {
    const wrong = await signIn({ encryptTo: OTHER_CERT });
    expect(wrong.session).toBeUndefined();
    expect(wrong.error).toBe('The encrypted SAML assertion can’t be decrypted with this instance’s key (the IdP may have an old certificate)');
    await settings('DELETE');
    try {
      const noKey = await signIn({ encryptTo: SP_CERT });
      expect(noKey.error).toBe('The identity provider encrypted the assertion, but this instance has no decryption key (Settings → Security → SAML)');
    } finally {
      await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    }
  });

  it('with "Require encrypted assertions", refuses plain ones', async () => {
    expect((await signIn({ nameID: 'G-plain', email: 'plain@acme.test' })).session).toBeTruthy();
    await settings('PATCH', { required: true });
    try {
      const plain = await signIn({ nameID: 'G-plain', email: 'plain@acme.test' });
      expect(plain.session).toBeUndefined();
      expect(plain.error).toBe('The identity provider sent the assertion unencrypted, and this instance requires encrypted assertions');
      expect((await signIn({ nameID: 'G-plain', email: 'plain@acme.test', encryptTo: SP_CERT })).session).toBeTruthy();
    } finally {
      await settings('PATCH', { required: false });
    }
  });
});

describe('SAML state shared by every main', () => {
  it('keeps sign-ins in flight in the database: a sign-in started before a restart (or on another main) finishes', async () => {
    const login = await startLogin('/workflows/wf_after_restart');
    expect(stateRows('relay').map((r) => r.id)).toContain(login.relayState);
    const request = stateRows('request').find((r) => r.id === login.requestId)!;
    expect(Date.parse(request.expires_at) - Date.now()).toBeGreaterThan(9 * MIN);
    // Another process: nothing in memory carries over, only the database.
    await closeDatabase();
    const response = await samlResponse({ inResponseTo: login.requestId, nameID: 'G-roam', email: 'roam@acme.test' });
    const result = await postAcs(response, login.relayState);
    expect(result.error).toBeUndefined();
    expect(result.location).toBe(`${BASE}/workflows/wf_after_restart`);
    // One use: both are gone.
    expect(stateRows('relay').map((r) => r.id)).not.toContain(login.relayState);
    expect(stateRows('request').map((r) => r.id)).not.toContain(login.requestId);

    // The session's logout details too: signing out after another restart still tells the IdP who.
    const user = auth.findUserByEmail('roam@acme.test')!;
    expect(stateRows('session').some((r) => r.user_id === user.id && JSON.parse(r.value).nameID === 'G-roam')).toBe(true);
    await closeDatabase();
    const logout = await (appLogoutRoute.POST as Route)(new Request(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: `landflow_session=${result.session}`, origin: BASE } }));
    const redirect = new URL((await logout.json()).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${IDP}/protocol/saml/logout`);
    expect(inflateRawSync(Buffer.from(redirect.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8')).toContain('>G-roam</saml:NameID>');
    expect(stateRows('session').some((r) => r.user_id === user.id)).toBe(false);
    // The LogoutRequest's id waits for the IdP's LogoutResponse, on whichever main it lands.
    expect(stateRows('request').length).toBeGreaterThan(0);
  });

  it('a RelayState and a request id are taken once, and expired ones are never handed out', async () => {
    const login = await startLogin();
    const response = await samlResponse({ inResponseTo: login.requestId });
    const [first, second] = await Promise.all([postAcs(response, login.relayState), postAcs(response, login.relayState)]);
    expect([first.session, second.session].filter(Boolean)).toHaveLength(1);
    expect([first.error, second.error].filter(Boolean)).toHaveLength(1);

    const now = Date.now();
    await state.putState('request', '_short', 'x', 1_000, undefined, now);
    expect(await state.readState('request', '_short', now + 500)).toBe('x');
    expect(await state.readState('request', '_short', now + 1_500)).toBeUndefined();
    expect(await state.takeState('request', '_short', now + 1_500)).toBeUndefined();
    // Writing sweeps what expired.
    await state.putState('request', '_old', 'x', 1, undefined, now - 10_000);
    await state.putState('relay', '_new', '{}', 60_000);
    expect(stateRows('request').map((r) => r.id)).not.toContain('_old');
  });
});
