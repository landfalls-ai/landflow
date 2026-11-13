/**
 * SAML 2.0 single sign-on (SP-initiated) with any identity provider: Keycloak, Okta, Entra ID, ADFS… Responses are
 * validated with @node-saml/node-saml: a valid XML signature from the IdP's certificate (the assertion, or the
 * whole response), the audience (our entity id), NotBefore/NotOnOrAfter with LANDFLOW_SAML_CLOCK_SKEW_SECONDS of
 * skew, and InResponseTo against the AuthnRequests this instance sent (10 minutes, one use). On top of that every
 * response and assertion id is recorded in `saml_replay` until it expires, so a captured response can't be posted
 * twice, and the RelayState must match a cookie set on the browser that started the sign-in.
 *
 * Encrypted assertions: with a decryption key (generated or uploaded in Settings → Security, or from the environment:
 * ./saml-keys) our metadata publishes its certificate for encryption and node-saml decrypts `EncryptedAssertion`s
 * (the decrypted assertion's signature and id are checked like a plain one's); "Require encrypted assertions" refuses
 * the rest.
 *
 * Configuration (env, like OIDC; docs/features/authentication.md): the IdP comes from LANDFLOW_SAML_IDP_METADATA_URL (fetched and
 * cached for an hour) and/or LANDFLOW_SAML_ENTRY_POINT, LANDFLOW_SAML_IDP_ISSUER and LANDFLOW_SAML_IDP_CERT (PEM or
 * base64; several separated by commas or `|` for key rotation). Our entity id is LANDFLOW_SAML_ISSUER (default
 * `<public URL>/api/auth/saml/metadata`, which serves our metadata), the ACS `<public URL>/api/auth/saml/acs`.
 *
 * Users are created on their first sign-in (LANDFLOW_SAML_JIT, default true; marked `provisionedBy: saml`) or linked
 * to an existing user by email. Their role comes from an attribute (LANDFLOW_SAML_ROLE_ATTRIBUTE, default `roles`)
 * through LANDFLOW_SAML_ROLE_MAP, else LANDFLOW_SAML_DEFAULT_ROLE (`member`; `none` refuses unmapped users), and is
 * refreshed at every sign-in; the owner's role never changes. LANDFLOW_SAML_PROJECT_ATTRIBUTE (default `groups`)
 * and LANDFLOW_SAML_PROJECT_MAP grant team project memberships (lib/server/projects/mapping.ts). Deactivated users
 * are refused.
 *
 * Single logout: signing out of a SAML session sends a LogoutRequest to the IdP when it has a logout URL; the IdP's
 * LogoutResponse, and LogoutRequests it starts (which sign the user out of every session), arrive at
 * /api/auth/saml/logout.
 *
 * Sign-ins in flight (RelayStates), the request ids InResponseTo must match and the NameID and SessionIndex each SAML
 * session's logout needs live in the database (`saml_state`, ./saml-state) with an expiry, not in memory: a sign-in
 * can finish on another main than the one that started it, a logout reach any main, and both survive restarts. Only
 * the IdP metadata is cached per process.
 */
import { X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { decryptXml, parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml';
import type { AssignableRole, SamlKeyInfo, SamlSecurityView } from '../../shared/auth';
import { describeProjectMap, grantsFor, parseProjectMap, syncManagedMemberships, type ProjectGrant } from '../projects/mapping';
import { safeFetch } from '../net/safe-fetch';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { authDb } from './db';
import { parseRoleMap } from './oidc';
import { randomToken, tokenHash } from './passwords';
import { samlDecryption, samlDecryptionKeys, samlEncryptionCerts, samlEncryptionView } from './saml-keys';
import { clearSamlState, dropUserStates, putState, readState, recordReplayIds, takeState } from './saml-state';
import { DEACTIVATED_MESSAGE, deleteUserSessions } from './sessions';
import { createUser, findUserByEmail, findUserBySaml, setupRequired, updateUser, type UserPatch, type UserRecord } from './users';

export const SAML_STATE_COOKIE = 'landflow_saml_state';
const STATE_TTL_MS = 10 * 60_000;
const METADATA_TTL_MS = 60 * 60_000;
const DEFAULT_SKEW_S = 120;
/** How long a replay id is kept when the assertion says nothing about its lifetime. */
const DEFAULT_REPLAY_TTL_MS = 60 * 60_000;
/** How long a SAML session's logout details are kept when the session's own expiry isn't given. */
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

export class SamlError extends Error {}

export interface SamlConfig {
  /** The IdP's metadata (entity id, SSO and logout URLs, signing certificates). */
  metadataUrl?: string;
  /** The IdP's single sign-on URL (HTTP-Redirect binding). */
  entryPoint?: string;
  idpIssuer?: string;
  idpCerts: string[];
  /** The IdP's single logout URL. */
  logoutUrl?: string;
  /** Our entity id; default `<origin>/api/auth/saml/metadata`. */
  issuer?: string;
  /** Our ACS; default `<origin>/api/auth/saml/acs`. */
  callbackUrl?: string;
  /** Sign AuthnRequests and LogoutRequests (and publish the certificate in our metadata). */
  privateKey?: string;
  publicCert?: string;
  /** Key rotation: the certificate of the key that will sign next (LANDFLOW_SAML_NEXT_CERT), published beside `publicCert`. */
  nextPublicCert?: string;
  clockSkewSeconds: number;
  wantAssertionsSigned: boolean;
  wantResponseSigned: boolean;
  /** NameIDPolicy Format to ask for; none lets the IdP choose. */
  nameIdFormat?: string;
  emailAttribute?: string;
  nameAttribute?: string;
  roleAttribute?: string;
  projectAttribute?: string;
  roleMap: Record<string, AssignableRole>;
  defaultRole: AssignableRole | 'none';
  projectMap: Record<string, ProjectGrant>;
  /** Create team projects the project map names that don't exist yet. */
  createProjects: boolean;
  jit: boolean;
  label: string;
}

const env = (name: string) => process.env[name]?.trim() || undefined;
const flag = (name: string, fallback: boolean) => {
  const value = env(name)?.toLowerCase();
  return value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value);
};

/** Certificates from one env value: PEM blocks, or base64 bodies separated by commas or `|`. */
export function parseCerts(text: string | undefined): string[] {
  if (!text) return [];
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (pems) return pems.map((pem) => pem.trim());
  return text
    .split(/[,|]/)
    .map((part) => part.replace(/\s+/g, ''))
    .filter(Boolean);
}

/** A PEM (or a PEM's base64 body) with real line breaks: env files often carry `\n`. */
const pemText = (text: string | undefined) => text?.replace(/\\n/g, '\n').trim() || undefined;

export function samlConfig(): SamlConfig | undefined {
  const metadataUrl = env('LANDFLOW_SAML_IDP_METADATA_URL');
  const entryPoint = env('LANDFLOW_SAML_ENTRY_POINT') ?? env('LANDFLOW_SAML_IDP_SSO_URL');
  const idpCerts = parseCerts(pemText(env('LANDFLOW_SAML_IDP_CERT')));
  if (!metadataUrl && !(entryPoint && idpCerts.length)) return undefined;
  const defaultRole = env('LANDFLOW_SAML_DEFAULT_ROLE')?.toLowerCase();
  const skew = Number(env('LANDFLOW_SAML_CLOCK_SKEW_SECONDS'));
  return {
    ...(metadataUrl && { metadataUrl }),
    ...(entryPoint && { entryPoint }),
    ...(env('LANDFLOW_SAML_IDP_ISSUER') && { idpIssuer: env('LANDFLOW_SAML_IDP_ISSUER') }),
    idpCerts,
    ...(env('LANDFLOW_SAML_LOGOUT_URL') && { logoutUrl: env('LANDFLOW_SAML_LOGOUT_URL') }),
    ...(env('LANDFLOW_SAML_ISSUER') && { issuer: env('LANDFLOW_SAML_ISSUER') }),
    ...(env('LANDFLOW_SAML_CALLBACK_URL') && { callbackUrl: env('LANDFLOW_SAML_CALLBACK_URL') }),
    ...(pemText(env('LANDFLOW_SAML_PRIVATE_KEY')) && { privateKey: pemText(env('LANDFLOW_SAML_PRIVATE_KEY')) }),
    ...(pemText(env('LANDFLOW_SAML_CERT')) && { publicCert: pemText(env('LANDFLOW_SAML_CERT')) }),
    ...(pemText(env('LANDFLOW_SAML_NEXT_CERT')) && { nextPublicCert: pemText(env('LANDFLOW_SAML_NEXT_CERT')) }),
    clockSkewSeconds: Number.isFinite(skew) && skew >= 0 ? Math.min(skew, 3600) : DEFAULT_SKEW_S,
    wantAssertionsSigned: flag('LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED', true),
    wantResponseSigned: flag('LANDFLOW_SAML_WANT_RESPONSE_SIGNED', false),
    ...(env('LANDFLOW_SAML_NAMEID_FORMAT') && { nameIdFormat: env('LANDFLOW_SAML_NAMEID_FORMAT') }),
    ...(env('LANDFLOW_SAML_EMAIL_ATTRIBUTE') && { emailAttribute: env('LANDFLOW_SAML_EMAIL_ATTRIBUTE') }),
    ...(env('LANDFLOW_SAML_NAME_ATTRIBUTE') && { nameAttribute: env('LANDFLOW_SAML_NAME_ATTRIBUTE') }),
    ...(env('LANDFLOW_SAML_ROLE_ATTRIBUTE') && { roleAttribute: env('LANDFLOW_SAML_ROLE_ATTRIBUTE') }),
    ...(env('LANDFLOW_SAML_PROJECT_ATTRIBUTE') && { projectAttribute: env('LANDFLOW_SAML_PROJECT_ATTRIBUTE') }),
    roleMap: parseRoleMap(env('LANDFLOW_SAML_ROLE_MAP')),
    defaultRole: defaultRole === 'none' || defaultRole === 'admin' ? defaultRole : 'member',
    projectMap: parseProjectMap(env('LANDFLOW_SAML_PROJECT_MAP')),
    createProjects: flag('LANDFLOW_SAML_CREATE_PROJECTS', false),
    jit: flag('LANDFLOW_SAML_JIT', true),
    label: env('LANDFLOW_SAML_LABEL') ?? 'Sign in with SAML',
  };
}

// ---- where things are ----------------------------------------------------------------------------------------

export interface SpUrls {
  entityId: string;
  acsUrl: string;
  logoutUrl: string;
  metadataUrl: string;
}

export function spUrls(config: Pick<SamlConfig, 'issuer' | 'callbackUrl'>, origin: string): SpUrls {
  return {
    entityId: config.issuer ?? `${origin}/api/auth/saml/metadata`,
    acsUrl: config.callbackUrl ?? `${origin}/api/auth/saml/acs`,
    logoutUrl: `${origin}/api/auth/saml/logout`,
    metadataUrl: `${origin}/api/auth/saml/metadata`,
  };
}

export interface IdpInfo {
  entryPoint: string;
  issuer?: string;
  certs: string[];
  logoutUrl?: string;
}

/** The IdP metadata, per process (an hour). */
const caches = () => singleton('saml-caches', () => ({ metadata: new Map<string, { idp: Omit<IdpInfo, 'entryPoint'> & { entryPoint?: string }; at: number }>() }));

/** What a SAML session's logout needs, by the hash of its session token (`saml_state` kind `session`). */
interface SessionEntry {
  nameID: string;
  nameIDFormat: string;
  sessionIndex?: string;
}

/**
 * node-saml's cache of the AuthnRequest and LogoutRequest ids this instance sent (`saml_state` kind `request`, shared
 * by every main). node-saml reads an id, then removes it; `track.consumed` says whether this call's remove was the one
 * that took it (another main given the same response may have been first).
 */
export function requestCache(track?: { consumed: boolean }): CacheProvider {
  return {
    async saveAsync(key, value) {
      await putState('request', key, value, STATE_TTL_MS);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      return (await readState('request', key)) ?? null;
    },
    async removeAsync(key) {
      if (!key) return null;
      const value = await takeState('request', key);
      if (value !== undefined && track) track.consumed = true;
      return value ?? null;
    },
  };
}

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** Read an IdP's metadata document: entity id, SSO and logout URLs (redirect binding preferred), signing certificates. */
export async function parseIdpMetadata(xml: string): Promise<Omit<IdpInfo, 'entryPoint'> & { entryPoint?: string }> {
  const doc = await parseDomFromString(xml);
  const entity = xpath.selectElements(doc, `//*[local-name()='EntityDescriptor' and namespace-uri()='${MD}']`)[0];
  const sso = xpath.selectElements(doc, `//*[local-name()='IDPSSODescriptor']`)[0];
  if (!entity || !sso) throw new SamlError('The IdP metadata has no IDPSSODescriptor');
  const pick = (name: string) => {
    const services = xpath.selectElements(sso, `./*[local-name()='${name}']`);
    return (services.find((s) => s.getAttribute('Binding') === REDIRECT) ?? services[0])?.getAttribute('Location') ?? undefined;
  };
  const certs = xpath
    .selectElements(sso, `./*[local-name()='KeyDescriptor' and (not(@use) or @use='signing')]//*[local-name()='X509Certificate']`)
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ''))
    .filter(Boolean);
  return { issuer: entity.getAttribute('entityID') ?? undefined, entryPoint: pick('SingleSignOnService'), logoutUrl: pick('SingleLogoutService'), certs: [...new Set(certs)] };
}

/** The IdP as configured: metadata (cached) with the explicit env values winning. */
export async function resolveIdp(config: SamlConfig, force = false): Promise<IdpInfo> {
  let fromMetadata: (Omit<IdpInfo, 'entryPoint'> & { entryPoint?: string }) | undefined;
  if (config.metadataUrl) {
    const cache = caches().metadata;
    const hit = cache.get(config.metadataUrl);
    if (hit && !force && Date.now() - hit.at < METADATA_TTL_MS) fromMetadata = hit.idp;
    else {
      const response = await safeFetch(config.metadataUrl, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' } });
      if (!response.ok) throw new SamlError(`The IdP metadata answered ${response.status}`);
      fromMetadata = await parseIdpMetadata(await response.text());
      cache.set(config.metadataUrl, { idp: fromMetadata, at: Date.now() });
    }
  }
  const entryPoint = config.entryPoint ?? fromMetadata?.entryPoint;
  const certs = config.idpCerts.length ? config.idpCerts : (fromMetadata?.certs ?? []);
  if (!entryPoint) throw new SamlError('No IdP single sign-on URL (LANDFLOW_SAML_ENTRY_POINT or the metadata)');
  if (!certs.length) throw new SamlError('No IdP signing certificate (LANDFLOW_SAML_IDP_CERT or the metadata)');
  const issuer = config.idpIssuer ?? fromMetadata?.issuer;
  const logoutUrl = config.logoutUrl ?? fromMetadata?.logoutUrl;
  return { entryPoint, certs, ...(issuer && { issuer }), ...(logoutUrl && { logoutUrl }) };
}

/**
 * A node-saml instance for this host and IdP (InResponseTo always checked, unless `inResponseTo` says otherwise), with
 * the decryption key for encrypted assertions when there is one.
 */
export function samlClient(config: SamlConfig, origin: string, idp: IdpInfo, inResponseTo = ValidateInResponseTo.always, cache: CacheProvider = requestCache(), decryptionKey?: string): SAML {
  const urls = spUrls(config, origin);
  const decryption = samlDecryption();
  return new SAML({
    entryPoint: idp.entryPoint,
    issuer: urls.entityId,
    audience: urls.entityId,
    callbackUrl: urls.acsUrl,
    logoutCallbackUrl: urls.logoutUrl,
    ...(idp.logoutUrl && { logoutUrl: idp.logoutUrl }),
    ...(idp.issuer && { idpIssuer: idp.issuer }),
    idpCert: idp.certs,
    ...(config.privateKey && { privateKey: config.privateKey, ...(config.publicCert && { publicCert: config.publicCert }) }),
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    identifierFormat: config.nameIdFormat ?? null,
    // Entra ID and others refuse a requested authentication context they didn't plan for (MFA): let the IdP decide.
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: config.clockSkewSeconds * 1000,
    wantAssertionsSigned: config.wantAssertionsSigned,
    wantAuthnResponseSigned: config.wantResponseSigned,
    validateInResponseTo: inResponseTo,
    requestIdExpirationPeriodMs: STATE_TTL_MS,
    cacheProvider: cache,
    ...((decryptionKey ?? decryption?.key) && { decryptionPvk: decryptionKey ?? decryption!.key }),
  });
}

/**
 * Our SP metadata: entity id, ACS (HTTP-POST), single logout, NameID format, our certificate when we sign, and the
 * certificate to encrypt assertions to when we have a decryption key.
 */
export function spMetadata(config: SamlConfig, origin: string): string {
  const decryption = samlDecryption();
  const client = new SAML({
    issuer: spUrls(config, origin).entityId,
    callbackUrl: spUrls(config, origin).acsUrl,
    logoutCallbackUrl: spUrls(config, origin).logoutUrl,
    idpCert: config.idpCerts[0] ?? 'unused',
    identifierFormat: config.nameIdFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    wantAssertionsSigned: config.wantAssertionsSigned,
    ...(config.privateKey && { privateKey: config.privateKey }),
    ...(decryption && { decryptionPvk: decryption.key }),
    signatureAlgorithm: 'sha256',
  });
  const xml = client.generateServiceProviderMetadata(decryption?.cert ?? null, config.privateKey && config.publicCert ? [config.publicCert, ...(config.nextPublicCert ? [config.nextPublicCert] : [])] : null);
  return withNextEncryptionCert(xml, samlEncryptionCerts().slice(1));
}

const certBody = (cert: string) => cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');

/**
 * Key rotation: node-saml publishes one `use="encryption"` KeyDescriptor, for the current decryption certificate; the
 * next certificate gets one of its own beside it (a copy of the first with the certificate swapped), so an IdP can
 * pick either up before the switch-over.
 */
function withNextEncryptionCert(xml: string, extra: string[]): string {
  const block = xml.match(/<(?:\w+:)?KeyDescriptor[^>]*\buse="encryption"[^>]*>[\s\S]*?<\/(?:\w+:)?KeyDescriptor>/)?.[0];
  if (!block || !extra.length) return xml;
  const first = block.match(/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/)?.[1];
  if (!first) return xml;
  const copies = extra.map((cert) => block.replace(first, certBody(cert))).join('');
  return xml.replace(block, `${block}${copies}`);
}

// ---- signing in -------------------------------------------------------------------------------------------------

/** Step 1: the IdP's sign-in URL (a deflated AuthnRequest), and the RelayState to bind to the browser (cookie). */
export async function beginLogin(config: SamlConfig, origin: string, next: string): Promise<{ url: string; state: string }> {
  const idp = await resolveIdp(config);
  const state = randomToken(24);
  await putState('relay', state, JSON.stringify({ next }), STATE_TTL_MS);
  const url = await samlClient(config, origin, idp).getAuthorizeUrlAsync(state, undefined, {});
  return { url, state };
}

/** The attributes of an assertion, every value of every attribute with that name (IdPs may repeat names). */
export function assertionAttributes(profile: Profile): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const assertion = (profile.getAssertion?.() as { Assertion?: { AttributeStatement?: Array<{ Attribute?: Array<{ $?: { Name?: string }; AttributeValue?: unknown[] }> }> } } | undefined)?.Assertion;
  for (const statement of assertion?.AttributeStatement ?? []) {
    for (const attribute of statement.Attribute ?? []) {
      const name = attribute.$?.Name;
      if (!name) continue;
      for (const value of attribute.AttributeValue ?? []) {
        const text = typeof value === 'string' ? value : (value as { _?: unknown })?._;
        if (text !== undefined && text !== null && String(text).trim()) (out[name] ??= []).push(String(text).trim());
      }
    }
  }
  return out;
}

const ALIASES = {
  email: ['email', 'mail', 'emailAddress', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
  name: ['name', 'displayName', 'urn:oid:2.16.840.1.113730.3.1.241', 'http://schemas.microsoft.com/identity/claims/displayname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'],
  givenName: ['firstName', 'givenName', 'urn:oid:2.5.4.42', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'],
  surname: ['lastName', 'sn', 'surname', 'urn:oid:2.5.4.4', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'],
  role: ['roles', 'Role', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'],
  project: ['groups', 'memberOf', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'],
};

/** Values of the configured attribute, else of the first well-known alias present. */
function valuesOf(attributes: Record<string, string[]>, configured: string | undefined, aliases: string[]): string[] {
  if (configured) return attributes[configured] ?? [];
  for (const name of aliases) if (attributes[name]?.length) return attributes[name];
  return [];
}

/** The highest role the values map to, if any. */
export function mappedSamlRole(values: string[], roleMap: Record<string, AssignableRole>): AssignableRole | undefined {
  const roles = values.flatMap((value) => value.split(/[\s,]+/)).map((value) => roleMap[value]).filter(Boolean);
  return roles.includes('admin') ? 'admin' : roles.includes('member') ? 'member' : undefined;
}

export interface SamlIdentity {
  issuer: string;
  nameID: string;
  nameIDFormat?: string;
  sessionIndex?: string;
  email?: string;
  name?: string;
  roleValues: string[];
  projectValues: string[];
  attributes: Record<string, string[]>;
}

export function identityOf(profile: Profile, config: SamlConfig, idpIssuer?: string): SamlIdentity {
  const attributes = assertionAttributes(profile);
  const nameID = String(profile.nameID ?? '').trim();
  if (!nameID) throw new SamlError('The SAML assertion has no NameID');
  let email = valuesOf(attributes, config.emailAttribute, ALIASES.email)[0]?.toLowerCase();
  if (!email && /^[^\s@]+@[^\s@]+$/.test(nameID)) email = nameID.toLowerCase();
  const given = valuesOf(attributes, undefined, ALIASES.givenName)[0];
  const surname = valuesOf(attributes, undefined, ALIASES.surname)[0];
  const name = valuesOf(attributes, config.nameAttribute, ALIASES.name)[0] ?? ([given, surname].filter(Boolean).join(' ') || undefined);
  return {
    issuer: String(profile.issuer ?? idpIssuer ?? ''),
    nameID,
    ...(profile.nameIDFormat && { nameIDFormat: profile.nameIDFormat }),
    ...(profile.sessionIndex && { sessionIndex: profile.sessionIndex }),
    ...(email && { email }),
    ...(name && { name }),
    roleValues: valuesOf(attributes, config.roleAttribute, ALIASES.role),
    projectValues: valuesOf(attributes, config.projectAttribute, ALIASES.project),
    attributes,
  };
}

// ---- replay protection -------------------------------------------------------------------------------------------

export interface ResponseFacts {
  /** `response:<ID>` and, for a plain assertion, `assertion:<ID>` (an encrypted one's id is known once decrypted). */
  ids: string[];
  /** The latest NotOnOrAfter it states (in the clear). */
  notOnOrAfter?: number;
  /** The Response's InResponseTo. */
  inResponseTo?: string;
  /** Its assertion is an EncryptedAssertion. */
  encrypted: boolean;
}

/** What a SAMLResponse (base64) says before validation: its ids, the latest NotOnOrAfter, InResponseTo, encryption. */
export async function responseIds(samlResponse: string): Promise<ResponseFacts> {
  const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  const doc = await parseDomFromString(xml);
  const ids = [
    ...xpath.selectAttributes(doc, "/*[local-name()='Response']/@ID").map((a) => `response:${a.value}`),
    ...xpath.selectAttributes(doc, "/*[local-name()='Response']/*[local-name()='Assertion']/@ID").map((a) => `assertion:${a.value}`),
  ];
  const times = xpath
    .selectAttributes(doc, "//*[local-name()='Conditions' or local-name()='SubjectConfirmationData']/@NotOnOrAfter")
    .map((a) => Date.parse(a.value))
    .filter(Number.isFinite);
  const inResponseTo = xpath.selectAttributes(doc, "/*[local-name()='Response']/@InResponseTo")[0]?.value;
  const encrypted = xpath.selectElements(doc, "/*[local-name()='Response']/*[local-name()='EncryptedAssertion']").length > 0;
  return { ids, ...(times.length && { notOnOrAfter: Math.max(...times) }), ...(inResponseTo && { inResponseTo }), encrypted };
}

/** The ID and latest NotOnOrAfter of an assertion's XML (a decrypted one). */
async function assertionFacts(xml: string): Promise<{ id?: string; notOnOrAfter?: number }> {
  const doc = await parseDomFromString(xml);
  const id = xpath.selectAttributes(doc, "/*[local-name()='Assertion']/@ID")[0]?.value;
  const times = xpath
    .selectAttributes(doc, "//*[local-name()='Conditions' or local-name()='SubjectConfirmationData']/@NotOnOrAfter")
    .map((a) => Date.parse(a.value))
    .filter(Number.isFinite);
  return { ...(id && { id }), ...(times.length && { notOnOrAfter: Math.max(...times) }) };
}

const REPLAYED = 'This SAML response was already used. Sign in again.';

/** Throws when any id was seen before (and hasn't expired). */
export function checkReplay(ids: string[], now = Date.now()) {
  const db = authDb();
  for (const id of ids) {
    const row = db.get<{ expires_at: string }>('SELECT expires_at FROM saml_replay WHERE id = ?', id);
    if (row && Date.parse(row.expires_at) > now) throw new SamlError(REPLAYED);
  }
}

/**
 * Record ids until they expire (sweeping expired ones); throws when one is already there (a concurrent replay, on this
 * main or another: on Postgres the insert is decided there, ./saml-state).
 */
export async function recordReplay(ids: string[], expiresAt: number, now = Date.now()): Promise<void> {
  await recordReplayIds(ids, expiresAt, () => new SamlError(REPLAYED), now);
}

/**
 * The key (of `keys`, in order) that decrypts the response's EncryptedAssertion; the first when none does (node-saml then
 * fails with its usual decryption error), none when there are no keys.
 */
async function keyThatDecrypts(samlResponse: string, keys: string[]): Promise<string | undefined> {
  return keyThatOpens(Buffer.from(samlResponse, 'base64').toString('utf8'), "/*[local-name()='Response']/*[local-name()='EncryptedAssertion']/*[local-name()='EncryptedData']", keys);
}

/**
 * The key (of `keys`, in order) that decrypts the `EncryptedData` at `path` in `xml`: an assertion, or the EncryptedID of
 * an IdP's LogoutRequest (which the IdP may already encrypt to the next certificate). The first when none does.
 */
async function keyThatOpens(xml: string, path: string, keys: string[]): Promise<string | undefined> {
  if (keys.length < 2) return keys[0];
  try {
    const doc = await parseDomFromString(xml);
    const encrypted = xpath.selectElements(doc, path)[0]?.toString();
    if (!encrypted) return keys[0];
    for (const key of keys) {
      try {
        await decryptXml(encrypted, key);
        return key;
      } catch {
        // Not this one.
      }
    }
  } catch {
    // Unreadable: node-saml says why.
  }
  return keys[0];
}

const DECRYPTION_FAILURE = /decrypt|EncryptedAssertion|EncryptedKey|xmlenc|oaep|padding|rsa routines|decoding error|unsupported state|authenticate data/i;

/** Readable reasons for node-saml's validation errors. */
function explain(error: Error): string {
  const message = error.message ?? String(error);
  if (/signature/i.test(message)) return 'The SAML response isn’t signed by the identity provider’s certificate';
  if (/NotOnOrAfter|expired/i.test(message)) return 'The SAML response has expired (check the clocks)';
  if (/NotBefore|not yet valid/i.test(message)) return 'The SAML response isn’t valid yet (check the clocks)';
  if (/audience/i.test(message)) return 'The SAML response is meant for another service provider (audience)';
  if (/InResponseTo/i.test(message)) return 'This SAML response doesn’t answer a sign-in started here, or it timed out. Try again.';
  if (/subject confirmation/i.test(message)) return 'The SAML response has expired or is for another sign-in';
  if (/No decryption key/i.test(message)) return 'The identity provider encrypted the assertion, but this instance has no decryption key (Settings → Security → SAML)';
  if (DECRYPTION_FAILURE.test(message)) return 'The encrypted SAML assertion can’t be decrypted with this instance’s key (the IdP may have an old certificate)';
  return `The SAML response was refused: ${message}`;
}

/**
 * Validate a SAMLResponse (base64, from the ACS form): replay check, encryption when required, node-saml (signature,
 * audience, timestamps, InResponseTo; decryption), the IdP's issuer, that this call took the request id (one use, on
 * any main), then record its ids (a decrypted assertion's too). Returns the identity it asserts.
 */
export async function validateResponse(config: SamlConfig, origin: string, samlResponse: string, now = Date.now()): Promise<SamlIdentity> {
  let parsed: ResponseFacts;
  try {
    parsed = await responseIds(samlResponse);
  } catch {
    throw new SamlError('The SAML response isn’t valid XML');
  }
  if (!parsed.ids.length) throw new SamlError('The SAML response has no ID');
  checkReplay(parsed.ids, now);
  if (!parsed.encrypted && samlDecryption()?.required) throw new SamlError('The identity provider sent the assertion unencrypted, and this instance requires encrypted assertions');
  let idp = await resolveIdp(config);
  const track = { consumed: false };
  let profile: Profile | null;
  // Key rotation: an assertion may be encrypted to the current certificate or to the next (or the retired) one. node-saml
  // takes one key and spends the request id before it decrypts, so the key that opens this one is found first.
  const decryptionKey = parsed.encrypted ? await keyThatDecrypts(samlResponse, samlDecryptionKeys()) : undefined;
  const validate = (info: IdpInfo): Promise<{ profile: Profile | null }> =>
    samlClient(config, origin, info, ValidateInResponseTo.always, requestCache(track), decryptionKey).validatePostResponseAsync({ SAMLResponse: samlResponse });
  try {
    ({ profile } = await validate(idp));
  } catch (caught) {
    // The IdP may have rotated its key: with metadata, fetch it again once and retry.
    if (config.metadataUrl && /signature/i.test((caught as Error).message ?? '') && !config.idpCerts.length) {
      const fresh = await resolveIdp(config, true).catch(() => idp);
      if (fresh.certs.join() !== idp.certs.join()) {
        idp = fresh;
        try {
          ({ profile } = await validate(idp));
        } catch (again) {
          throw new SamlError(explain(again as Error));
        }
      } else throw new SamlError(explain(caught as Error));
    } else throw new SamlError(explain(caught as Error));
  }
  if (!profile) throw new SamlError('The identity provider didn’t sign you in');
  if (idp.issuer && profile.issuer && profile.issuer !== idp.issuer) throw new SamlError(`The SAML assertion is from ${profile.issuer}, not ${idp.issuer}`);
  // One use: node-saml removes the request id when the subject names it; take it here otherwise. Only one main gets it.
  if (!track.consumed && parsed.inResponseTo) track.consumed = (await takeState('request', parsed.inResponseTo)) !== undefined;
  if (!track.consumed) throw new SamlError(REPLAYED);
  const ids = [...parsed.ids];
  let notOnOrAfter = parsed.notOnOrAfter;
  if (parsed.encrypted) {
    const assertion = await assertionFacts(profile.getAssertionXml?.() ?? '').catch(() => ({}) as { id?: string; notOnOrAfter?: number });
    if (assertion.id) ids.push(`assertion:${assertion.id}`);
    if (assertion.notOnOrAfter) notOnOrAfter = Math.max(notOnOrAfter ?? 0, assertion.notOnOrAfter);
    // Seen before (a captured assertion re-wrapped in a new response)?
    checkReplay(ids, now);
  }
  await recordReplay(ids, (notOnOrAfter ?? now + DEFAULT_REPLAY_TTL_MS) + config.clockSkewSeconds * 1000, now);
  return identityOf(profile, config, idp.issuer);
}

/** Find (by SAML identity, then email) or create the user of an identity, with their mapped role and projects. */
export async function signInUser(config: SamlConfig, identity: SamlIdentity): Promise<UserRecord> {
  const role = mappedSamlRole(identity.roleValues, config.roleMap);
  let user = findUserBySaml(identity.issuer, identity.nameID);
  if (!user && identity.email) {
    const byEmail = findUserByEmail(identity.email);
    if (byEmail) {
      if (byEmail.disabledAt) throw new SamlError(DEACTIVATED_MESSAGE);
      user = updateUser(byEmail.id, { samlIssuer: identity.issuer, samlSubject: identity.nameID });
    }
  }
  if (user) {
    if (user.disabledAt) throw new SamlError(DEACTIVATED_MESSAGE);
    const patch: UserPatch = {};
    if (role && user.role !== 'owner' && user.role !== role) patch.role = role;
    if (!user.name && identity.name) patch.name = identity.name;
    if (Object.keys(patch).length) user = updateUser(user.id, patch);
  } else {
    if (!config.jit) throw new SamlError(`There is no Landflow account for ${identity.email ?? identity.nameID}. Ask an admin to invite you.`);
    if (!identity.email) throw new SamlError('The identity provider didn’t send an email address (add an email attribute)');
    const assigned = role ?? (config.defaultRole === 'none' ? undefined : config.defaultRole);
    if (!assigned) throw new SamlError('Your account has no Landflow role at the identity provider. Ask an admin for access.');
    user = await createUser({ email: identity.email, name: identity.name || identity.email, role: assigned, saml: { issuer: identity.issuer, subject: identity.nameID }, provisionedBy: 'saml' });
  }
  if (Object.keys(config.projectMap).length) {
    syncManagedMemberships(user.id, 'saml', grantsFor(identity.projectValues, config.projectMap, { create: config.createProjects }));
  }
  return user;
}

/** Step 2 (ACS): check the RelayState against the browser's cookie, validate the response, find or create the user. */
export async function completeLogin(
  config: SamlConfig,
  origin: string,
  params: { samlResponse?: string | null; relayState?: string | null; cookieState?: string },
): Promise<{ user: UserRecord; next: string; identity: SamlIdentity }> {
  if (!params.samlResponse) throw new SamlError('The identity provider sent no SAML response');
  const state = params.relayState ?? '';
  const expired = () => new SamlError('This sign-in expired or was started in another browser. Try again.');
  if (!state || !params.cookieState || params.cookieState !== state) throw expired();
  const entry = await takeState('relay', state);
  if (entry === undefined) throw expired();
  const next = (JSON.parse(entry) as { next?: string }).next ?? '/';
  if (setupRequired()) throw new SamlError('Finish the owner setup before signing in with SAML');
  const identity = await validateResponse(config, origin, params.samlResponse);
  return { user: await signInUser(config, identity), next, identity };
}

// ---- single logout ---------------------------------------------------------------------------------------------

/** Remember the NameID and SessionIndex of a session started with SAML (for single logout), until the session expires. */
export async function rememberSession(sessionToken: string, user: UserRecord, identity: SamlIdentity, expiresAt?: string): Promise<void> {
  const entry: SessionEntry = {
    nameID: identity.nameID,
    nameIDFormat: identity.nameIDFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    ...(identity.sessionIndex && { sessionIndex: identity.sessionIndex }),
  };
  const until = expiresAt ? Date.parse(expiresAt) : NaN;
  await putState('session', tokenHash(sessionToken), JSON.stringify(entry), Number.isFinite(until) && until > Date.now() ? until - Date.now() : SESSION_TTL_MS, user.id);
}

/**
 * Signing out of a session: the IdP's logout URL (a LogoutRequest) when the session came from SAML and the IdP has
 * single logout; undefined otherwise (a local sign-out). Forgets the session either way.
 */
export async function logoutRedirect(sessionToken: string | undefined, origin: string, next = '/login'): Promise<string | undefined> {
  if (!sessionToken) return undefined;
  const stored = await takeState('session', tokenHash(sessionToken)).catch((error) => {
    logger.warn('could not read the SAML session for single logout', { error });
    return undefined;
  });
  const config = samlConfig();
  if (!stored || !config) return undefined;
  const entry = JSON.parse(stored) as SessionEntry;
  try {
    const idp = await resolveIdp(config);
    if (!idp.logoutUrl) return undefined;
    const profile = { issuer: idp.issuer ?? '', nameID: entry.nameID, nameIDFormat: entry.nameIDFormat, ...(entry.sessionIndex && { sessionIndex: entry.sessionIndex }) } as Profile;
    return await samlClient(config, origin, idp).getLogoutUrlAsync(profile, next, {});
  } catch (error) {
    logger.warn('SAML single logout unavailable; signed out locally', { error });
    return undefined;
  }
}

/**
 * A LogoutResponse in the HTTP-POST binding. node-saml's POST validator looks for InResponseTo on a login Response
 * only, so it runs without that check (the signature is still required) and the LogoutResponse's InResponseTo is
 * checked here against the LogoutRequests this host sent.
 */
async function validatePostLogoutResponse(config: SamlConfig, origin: string, idp: IdpInfo, samlResponse: string): Promise<{ profile: Profile | null; loggedOut: boolean }> {
  const doc = await parseDomFromString(Buffer.from(samlResponse, 'base64').toString('utf8'));
  const inResponseTo = xpath.selectAttributes(doc, "/*[local-name()='LogoutResponse']/@InResponseTo")[0]?.value;
  if (!inResponseTo) throw new Error('it isn’t a LogoutResponse to a logout started here');
  const result = await samlClient(config, origin, idp, ValidateInResponseTo.ifPresent).validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!result.loggedOut) throw new Error('it isn’t a LogoutResponse');
  if ((await takeState('request', inResponseTo)) === undefined) throw new Error('it doesn’t answer a logout started here');
  return result;
}

const ENCRYPTED_NAME_ID = "/*[local-name()='LogoutRequest']/*[local-name()='EncryptedID']/*[local-name()='EncryptedData']";

/** The XML of an IdP's LogoutRequest: base64 (HTTP-POST) or base64 of raw DEFLATE (HTTP-Redirect); none for a response. */
function logoutRequestXml(message: { query?: Record<string, string>; body?: Record<string, string> }): string | undefined {
  try {
    if (message.body?.SAMLRequest) return Buffer.from(message.body.SAMLRequest, 'base64').toString('utf8');
    if (message.query?.SAMLRequest) return inflateRawSync(Buffer.from(message.query.SAMLRequest, 'base64')).toString('utf8');
  } catch {
    // Unreadable: node-saml says why.
  }
  return undefined;
}

/**
 * A message at /api/auth/saml/logout from the IdP: a LogoutResponse to our LogoutRequest (→ `{ done }`), or a
 * LogoutRequest it started (→ sign that user out of every session, and the URL of our LogoutResponse).
 */
export async function handleLogoutMessage(
  config: SamlConfig,
  origin: string,
  message: { query?: Record<string, string>; originalQuery?: string; body?: Record<string, string> },
): Promise<{ kind: 'response'; relayState?: string } | { kind: 'request'; redirect: string; userId?: string }> {
  const idp = await resolveIdp(config);
  const request = logoutRequestXml(message);
  const decryptionKey = request ? await keyThatOpens(request, ENCRYPTED_NAME_ID, samlDecryptionKeys()) : undefined;
  const client = samlClient(config, origin, idp, ValidateInResponseTo.always, requestCache(), decryptionKey);
  let result: { profile: Profile | null; loggedOut: boolean };
  try {
    if (message.body?.SAMLRequest) result = await client.validatePostRequestAsync(message.body);
    else if (message.body?.SAMLResponse) result = await validatePostLogoutResponse(config, origin, idp, message.body.SAMLResponse);
    else if (message.query?.Signature) result = await client.validateRedirectAsync(message.query, message.originalQuery ?? '');
    else throw new Error('it isn’t signed');
  } catch (caught) {
    throw new SamlError(`The logout message was refused: ${(caught as Error).message}`);
  }
  const relayState = message.body?.RelayState ?? message.query?.RelayState;
  if (!result.profile) return { kind: 'response', ...(relayState && { relayState }) };
  const user = findUserBySaml(String(result.profile.issuer ?? idp.issuer ?? ''), String(result.profile.nameID ?? ''));
  if (user) {
    deleteUserSessions(user.id);
    await dropUserStates('session', user.id);
    logger.info('signed out by the SAML identity provider', { 'landflow.user.id': user.id });
  }
  const redirect = await client.getLogoutResponseUrlAsync(result.profile, relayState ?? '', {}, true);
  return { kind: 'request', redirect, ...(user && { userId: user.id }) };
}

// ---- settings -----------------------------------------------------------------------------------------------------

/** A signing certificate's public details (the key is in the environment, never shown). */
function signingInfo(cert: string): SamlKeyInfo {
  try {
    const x509 = new X509Certificate(cert);
    return { source: 'env', subject: x509.subject.replace(/\n/g, ', '), validTo: new Date(x509.validTo).toISOString(), fingerprint: x509.fingerprint256, certificate: cert };
  } catch {
    return { source: 'env', error: 'The certificate can’t be read' };
  }
}

/** Settings → Security: the SAML configuration, with the IdP checked (metadata fetched, certificates read). */
export async function samlSecurityView(origin: string): Promise<SamlSecurityView> {
  const config = samlConfig();
  const base: SamlSecurityView = {
    configured: Boolean(config),
    label: config?.label ?? process.env.LANDFLOW_SAML_LABEL?.trim() ?? 'Sign in with SAML',
    idpCerts: 0,
    wantAssertionsSigned: config?.wantAssertionsSigned ?? true,
    clockSkewSeconds: config?.clockSkewSeconds ?? DEFAULT_SKEW_S,
    emailAttribute: config?.emailAttribute ?? 'email',
    nameAttribute: config?.nameAttribute ?? 'name',
    roleAttribute: config?.roleAttribute ?? 'roles',
    roleMap: config?.roleMap ?? {},
    defaultRole: config?.defaultRole ?? 'member',
    projectAttribute: config?.projectAttribute ?? 'groups',
    projectMap: describeProjectMap(config?.projectMap ?? {}),
    jit: config?.jit ?? true,
  };
  if (!config) return base;
  const urls = spUrls(config, origin);
  const view: SamlSecurityView = { ...base, entityId: urls.entityId, acsUrl: urls.acsUrl, metadataUrl: urls.metadataUrl, encryption: samlEncryptionView() };
  if (config.privateKey && config.publicCert) view.signing = { current: signingInfo(config.publicCert), ...(config.nextPublicCert && { next: signingInfo(config.nextPublicCert) }) };
  try {
    const idp = await resolveIdp(config, true);
    view.idpSsoUrl = idp.entryPoint;
    if (idp.issuer) view.idpIssuer = idp.issuer;
    if (idp.logoutUrl) view.idpSloUrl = idp.logoutUrl;
    view.idpCerts = idp.certs.length;
    const expiries = idp.certs.flatMap((cert) => {
      try {
        const pem = cert.includes('BEGIN') ? cert : `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
        return [new Date(new X509Certificate(pem).validTo).toISOString()];
      } catch {
        return [];
      }
    });
    if (expiries.length) view.idpCertExpires = expiries.sort()[0];
  } catch (caught) {
    view.error = (caught as Error).message;
  }
  return view;
}

/** Tests: the metadata cache and every SAML state row. */
export function resetSamlCaches() {
  caches().metadata.clear();
  try {
    clearSamlState();
  } catch {
    // No database (closed already).
  }
}
