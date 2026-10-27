/**
 * SAML key rotation with two certificates (lib/server/auth/saml-keys.ts, saml.ts): a next decryption key staged beside
 * the current one (generated or uploaded), both published in our metadata as encryption KeyDescriptors, assertions
 * decrypted with either, the switch-over (the old key is kept to decrypt, no longer published) and discarding it, the
 * environment's next key, audited changes; and the signing certificates (LANDFLOW_SAML_CERT and _NEXT_CERT) both in
 * the metadata and in Settings → Security.
 */
import { createPrivateKey, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing';
import type { SamlEncryptionView } from '@/lib/shared/auth';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'saml', name), 'utf8');
const IDP_KEY = fixture('idp.key.pem');
const IDP_CERT = fixture('idp.cert.pem');
const OTHER_CERT = fixture('other.cert.pem');
const OTHER_KEY = fixture('other.key.pem');
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

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-saml-rot-'));
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
const UNSET = ['LANDFLOW_PUBLIC_URL', 'LANDFLOW_SECURE_COOKIES', 'LANDFLOW_SAML_IDP_METADATA_URL', 'LANDFLOW_SAML_ISSUER', 'LANDFLOW_SAML_DECRYPTION_KEY', 'LANDFLOW_SAML_DECRYPTION_CERT', 'LANDFLOW_SAML_DECRYPTION_NEXT_KEY', 'LANDFLOW_SAML_DECRYPTION_NEXT_CERT', 'LANDFLOW_SAML_PRIVATE_KEY', 'LANDFLOW_SAML_CERT', 'LANDFLOW_SAML_NEXT_CERT', 'LANDFLOW_OIDC_ISSUER'];
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
const samlLogoutRoute = await import('@/app/api/auth/saml/logout/route');
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

const metadata = async () => (await (metadataRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/metadata`))).text();
const certBody = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, '');
const encryptionDescriptors = (xml: string) => [...xml.matchAll(/<KeyDescriptor use="encryption">[\s\S]*?<\/KeyDescriptor>/g)].map((m) => m[0].replace(/\s/g, ''));
const signingDescriptors = (xml: string) => [...xml.matchAll(/<KeyDescriptor use="signing">[\s\S]*?<\/KeyDescriptor>/g)].map((m) => m[0].replace(/\s/g, ''));

describe('rotating the decryption key', () => {
  beforeEach(async () => {
    await settings('DELETE');
  });

  it('needs a current key first; stages the next one (uploaded or generated) and publishes both certificates', async () => {
    expect((await settings('POST', { action: 'generate', slot: 'next' })).body.error).toMatch(/Set up the current decryption key first/);
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    expect((await metadata()).match(/use="encryption"/g)).toHaveLength(1);
    // Not the certificate it already has.
    expect((await settings('POST', { action: 'upload', slot: 'next', cert: SP_CERT, key: SP_KEY })).body.error).toMatch(/That is the current certificate/);
    // A key that doesn't match its certificate is refused like any upload.
    expect((await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: SP_KEY })).status).toBe(400);

    const staged = await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: OTHER_KEY });
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({ configured: true, source: 'uploaded', next: { source: 'uploaded', subject: expect.any(String), fingerprint: expect.any(String) } });
    expect(staged.body.next?.fingerprint).not.toBe(staged.body.fingerprint);
    expect(JSON.stringify(staged.body)).not.toContain('PRIVATE KEY');
    expect(staged.body.previous).toBeUndefined();

    const xml = await metadata();
    const published = encryptionDescriptors(xml);
    expect(published).toHaveLength(2);
    expect(published[0]).toContain(certBody(SP_CERT));
    expect(published[1]).toContain(certBody(OTHER_CERT));
    expect(published[1]).toContain('xmlenc11#aes256-gcm');
    // Both are sealed at rest.
    expect(authDb().get<{ value: string }>(`SELECT value FROM settings WHERE key = 'saml_encryption'`)!.value).not.toContain('PRIVATE KEY');

    // Generating into the slot replaces the staged key, and leaves the current one alone.
    const generated = await settings('POST', { action: 'generate', slot: 'next' });
    expect(generated.body.next).toMatchObject({ source: 'generated' });
    expect(generated.body.fingerprint).toBe(staged.body.fingerprint);
    expect(generated.body.next?.fingerprint).not.toBe(staged.body.next?.fingerprint);
    expect(queryEvents({ targetId: 'saml-encryption' }, { limit: 1 }).events[0]).toMatchObject({ summary: 'Generated the next SAML decryption key (published beside the current one)', details: { slot: 'next' } });
  });

  it('decrypts with either key while both are published: the IdP can move to the next certificate whenever it likes', async () => {
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: OTHER_KEY });
    const toCurrent = await signIn({ encryptTo: SP_CERT, nameID: 'G-rot-a', email: 'rot-a@acme.test' });
    expect(toCurrent.error).toBeUndefined();
    expect(toCurrent.session).toBeTruthy();
    const toNext = await signIn({ encryptTo: OTHER_CERT, nameID: 'G-rot-b', email: 'rot-b@acme.test' });
    expect(toNext.error).toBeUndefined();
    expect(auth.findUserByEmail('rot-b@acme.test')).toMatchObject({ samlSubject: 'G-rot-b' });
    // The key that opens the assertion is picked before node-saml spends the request id: one try, one sign-in.
    expect(toNext.session).toBeTruthy();
    // A key neither has still fails, with the usual reason.
    const { certificate } = (await settings('POST', { action: 'generate', slot: 'next' })).body.next!;
    await settings('POST', { action: 'discard', slot: 'next' });
    expect(certificate).toBeTruthy();
    const stranger = await signIn({ encryptTo: OTHER_CERT });
    expect(stranger.session).toBeUndefined();
    expect(stranger.error).toBe('The encrypted SAML assertion can’t be decrypted with this instance’s key (the IdP may have an old certificate)');
  });

  it('an IdP-initiated logout whose NameID is encrypted to the next certificate signs the user out', async () => {
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: OTHER_KEY });
    const signedIn = await signIn({ encryptTo: OTHER_CERT, nameID: 'G-rot-slo', email: 'rot-slo@acme.test' });
    expect(signedIn.session).toBeTruthy();
    const nameID = `<saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">G-rot-slo</saml:NameID>`;
    const xml =
      `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr${randomUUID()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${BASE}/api/auth/saml/logout">` +
      `<saml:Issuer>${IDP}</saml:Issuer><saml:EncryptedID>${await encrypt(nameID, OTHER_CERT)}</saml:EncryptedID></samlp:LogoutRequest>`;
    const params = new URLSearchParams({ SAMLRequest: deflateRawSync(Buffer.from(xml)).toString('base64'), RelayState: 'idp-state', SigAlg: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
    params.set('Signature', createSign('RSA-SHA256').update(params.toString()).sign(IDP_KEY, 'base64'));
    const response = await (samlLogoutRoute.GET as Route)(new Request(`${BASE}/api/auth/saml/logout?${params}`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain(`${IDP}/protocol/saml/logout`);
    expect(auth.sessionUser(signedIn.session!)).toBeUndefined();
  });

  it('switches over: the next pair becomes current, the old key only decrypts until it is discarded', async () => {
    expect((await settings('POST', { action: 'switch' })).body.error).toMatch(/no next key/);
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    const before = (await settings('GET')).body;
    await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: OTHER_KEY });

    const switched = await settings('POST', { action: 'switch' });
    expect(switched.status).toBe(200);
    expect(switched.body.next).toBeUndefined();
    expect(switched.body.fingerprint).not.toBe(before.fingerprint);
    expect(switched.body.certificate).toContain(certBody(OTHER_CERT).slice(0, 60));
    expect(switched.body.previous).toMatchObject({ fingerprint: before.fingerprint, retiredAt: expect.any(String) });
    expect(queryEvents({ targetId: 'saml-encryption' }, { limit: 1 }).events[0]).toMatchObject({
      summary: 'Switched the SAML decryption key over to the next one',
      details: { retiredFingerprint: before.fingerprint },
    });

    // Our metadata offers the new certificate only; the retired key still opens what the IdP encrypted to it.
    const published = encryptionDescriptors(await metadata());
    expect(published).toHaveLength(1);
    expect(published[0]).toContain(certBody(OTHER_CERT));
    expect((await signIn({ encryptTo: OTHER_CERT, nameID: 'G-rot-c', email: 'rot-c@acme.test' })).session).toBeTruthy();
    expect((await signIn({ encryptTo: SP_CERT, nameID: 'G-rot-d', email: 'rot-d@acme.test' })).session).toBeTruthy();

    // Discarding the retired key ends that.
    expect((await settings('POST', { action: 'discard', slot: 'previous' })).body.previous).toBeUndefined();
    const refused = await signIn({ encryptTo: SP_CERT });
    expect(refused.session).toBeUndefined();
    expect(refused.error).toMatch(/can’t be decrypted/);
    expect((await signIn({ encryptTo: OTHER_CERT, nameID: 'G-rot-c', email: 'rot-c@acme.test' })).session).toBeTruthy();
    expect((await settings('POST', { action: 'discard', slot: 'previous' })).body.error).toMatch(/no previous key/);
  });

  it('a next key from the environment is published and decrypts, and Settings can’t change it', async () => {
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    process.env.LANDFLOW_SAML_DECRYPTION_NEXT_KEY = OTHER_KEY.replace(/\n/g, '\\n');
    process.env.LANDFLOW_SAML_DECRYPTION_NEXT_CERT = OTHER_CERT;
    try {
      const view = (await settings('GET')).body;
      expect(view.next).toMatchObject({ source: 'env', fingerprint: expect.any(String) });
      expect(encryptionDescriptors(await metadata())).toHaveLength(2);
      expect((await signIn({ encryptTo: OTHER_CERT, nameID: 'G-rot-e', email: 'rot-e@acme.test' })).session).toBeTruthy();
      expect((await settings('POST', { action: 'generate', slot: 'next' })).body.error).toMatch(/LANDFLOW_SAML_DECRYPTION_NEXT_KEY/);
      expect((await settings('POST', { action: 'switch' })).body.error).toMatch(/LANDFLOW_SAML_DECRYPTION_NEXT_KEY/);
      expect((await settings('POST', { action: 'discard', slot: 'next' })).body.error).toMatch(/LANDFLOW_SAML_DECRYPTION_NEXT_KEY/);
    } finally {
      delete process.env.LANDFLOW_SAML_DECRYPTION_NEXT_KEY;
      delete process.env.LANDFLOW_SAML_DECRYPTION_NEXT_CERT;
    }
  });

  it('removing the keys removes the staged and retired ones too', async () => {
    await settings('POST', { action: 'upload', cert: SP_CERT, key: SP_KEY });
    await settings('POST', { action: 'upload', slot: 'next', cert: OTHER_CERT, key: OTHER_KEY });
    await settings('POST', { action: 'switch' });
    await settings('POST', { action: 'generate', slot: 'next' });
    const removed = await settings('DELETE');
    expect(removed.body).toMatchObject({ configured: false });
    expect(removed.body.next).toBeUndefined();
    expect(removed.body.previous).toBeUndefined();
    expect(encryptionDescriptors(await metadata())).toHaveLength(0);
  });
});

describe('rotating the signing certificate', () => {
  it('publishes the next signing certificate beside the current one and shows both in Settings → Security', async () => {
    process.env.LANDFLOW_SAML_PRIVATE_KEY = IDP_KEY.replace(/\n/g, '\\n');
    process.env.LANDFLOW_SAML_CERT = IDP_CERT;
    try {
      let xml = await metadata();
      expect(signingDescriptors(xml)).toHaveLength(1);
      process.env.LANDFLOW_SAML_NEXT_CERT = OTHER_CERT;
      xml = await metadata();
      const published = signingDescriptors(xml);
      expect(published).toHaveLength(2);
      expect(published[0]).toContain(certBody(IDP_CERT));
      expect(published[1]).toContain(certBody(OTHER_CERT));
      const security = await (securityRoute.GET as Route)(new Request(`${BASE}/api/settings/security`, { headers: { cookie: `landflow_session=${ownerSession}` } }));
      const { saml: view } = await security.json();
      expect(view.signing.current).toMatchObject({ source: 'env', fingerprint: expect.any(String) });
      expect(view.signing.next).toMatchObject({ source: 'env', fingerprint: expect.any(String) });
      expect(view.signing.next.fingerprint).not.toBe(view.signing.current.fingerprint);
    } finally {
      delete process.env.LANDFLOW_SAML_PRIVATE_KEY;
      delete process.env.LANDFLOW_SAML_CERT;
      delete process.env.LANDFLOW_SAML_NEXT_CERT;
    }
  });

  it('a next certificate without a signing key publishes nothing (we don’t sign)', async () => {
    process.env.LANDFLOW_SAML_NEXT_CERT = OTHER_CERT;
    try {
      expect(signingDescriptors(await metadata())).toHaveLength(0);
    } finally {
      delete process.env.LANDFLOW_SAML_NEXT_CERT;
    }
  });
});
