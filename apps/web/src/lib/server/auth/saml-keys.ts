/**
 * Encrypted SAML assertions (Settings → Security → SAML): the service provider's decryption key and its certificate.
 * The IdP encrypts each assertion to the certificate, which our metadata publishes as a `use="encryption"`
 * KeyDescriptor, and node-saml decrypts it with the key (lib/server/auth/saml.ts). The key pair is generated here
 * (RSA 2048, self-signed, ten years: ./x509) or uploaded (PEM; an encrypted key with its passphrase is stored
 * decrypted), and kept in the `settings` table under `saml_encryption` with the key sealed by the credentials key.
 * LANDFLOW_SAML_DECRYPTION_KEY and LANDFLOW_SAML_DECRYPTION_CERT set it from the environment instead (they win, and
 * Settings can't change them). "Require encrypted assertions" refuses responses whose assertion arrives in the clear.
 *
 * The key must be RSA: assertion encryption wraps its content key with RSA-OAEP (or RSA 1.5) to the certificate.
 *
 * Rotation with two certificates: besides the current pair there is a `next` one (generated or uploaded into that slot,
 * or LANDFLOW_SAML_DECRYPTION_NEXT_KEY / _CERT). Our metadata publishes both as `use="encryption"` KeyDescriptors, so
 * the IdP can start encrypting to the next certificate whenever it has picked it up, and responses are decrypted with
 * either key. "Switch over" makes the next pair the current one and keeps the old key as `previous`: it only decrypts
 * (the metadata no longer offers its certificate) until it is discarded, so assertions already in flight still work.
 */
import { HttpError } from '../errors';
import { createPrivateKey } from 'node:crypto';
import type { SamlEncryptionView, SamlKeyInfo } from '../../shared/auth';
import { credentials } from '../credentials/vault';
import { parse } from '../db/rows';
import { authDb } from './db';
import { certificateInfo, createCertificate, keyPairProblem, pemCertificates } from './x509';

const SETTINGS_KEY = 'saml_encryption';

/** A bad or env-managed key: the caller's to fix (400). */
export class SamlKeyError extends HttpError {
  constructor(message: string) {
    super(message, 400, { expose: true });
  }
}

/** A key pair kept beside the current one. */
interface Slot {
  cert: string;
  /** Sealed PKCS#8 PEM. */
  key: string;
  source: 'generated' | 'uploaded';
  createdAt?: string;
  createdBy?: string;
  /** `previous` only: when the switch-over retired it. */
  retiredAt?: string;
}

interface Stored {
  cert?: string;
  /** Sealed PKCS#8 PEM. */
  key?: string;
  source?: 'generated' | 'uploaded';
  createdAt?: string;
  createdBy?: string;
  /** Refuse unencrypted assertions. */
  required?: boolean;
  /** Published beside the current certificate for rotation; decrypts too. */
  next?: Slot;
  /** The key the last switch-over retired: decrypts only, until discarded. */
  previous?: Slot;
}

export type SamlKeySlot = 'current' | 'next';

export interface SamlDecryption {
  key: string;
  cert: string;
  source: 'generated' | 'uploaded' | 'env';
  required: boolean;
}

const pemText = (text: string | undefined) => text?.replace(/\\n/g, '\n').trim() || undefined;

function stored(): Stored {
  return parse<Stored>(authDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value) ?? {};
}

function save(next: Stored) {
  authDb().upsert('settings', { key: SETTINGS_KEY, value: JSON.stringify(next) });
}

function fromEnv(): { key: string; cert: string } | undefined {
  const key = pemText(process.env.LANDFLOW_SAML_DECRYPTION_KEY);
  const cert = pemText(process.env.LANDFLOW_SAML_DECRYPTION_CERT);
  return key && cert ? { key, cert } : undefined;
}

function nextFromEnv(): { key: string; cert: string } | undefined {
  const key = pemText(process.env.LANDFLOW_SAML_DECRYPTION_NEXT_KEY);
  const cert = pemText(process.env.LANDFLOW_SAML_DECRYPTION_NEXT_CERT);
  return key && cert ? { key, cert } : undefined;
}

/** A stored slot's key and certificate; undefined when sealed with another credentials key. */
function openSlot(slot: Slot | undefined): { key: string; cert: string } | undefined {
  if (!slot) return undefined;
  try {
    return { key: credentials.openSecret(slot.key), cert: slot.cert };
  } catch {
    return undefined;
  }
}

/** The next pair: from the environment, else the stored slot. */
function nextPair(saved = stored()): { key: string; cert: string } | undefined {
  return nextFromEnv() ?? openSlot(saved.next);
}

/** Every key that may decrypt an assertion, in the order to try: current, next, then the one the last switch-over retired. */
export function samlDecryptionKeys(): string[] {
  const saved = stored();
  const keys = [samlDecryption()?.key, nextPair(saved)?.key, openSlot(saved.previous)?.key].filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

/** The certificates our metadata offers for encryption: the current one, then the next. */
export function samlEncryptionCerts(): string[] {
  const current = samlDecryption()?.cert;
  const next = nextPair()?.cert;
  return [current, next].filter((cert): cert is string => Boolean(cert)).filter((cert, i, all) => all.findIndex((c) => pemCertificates(c)[0] === pemCertificates(cert)[0]) === i);
}

/** The decryption key node-saml gets, and whether encrypted assertions are required; none when not set up. */
export function samlDecryption(): SamlDecryption | undefined {
  const saved = stored();
  const env = fromEnv();
  if (env) return { ...env, source: 'env', required: Boolean(saved.required) };
  if (!saved.cert || !saved.key) return undefined;
  try {
    return { key: credentials.openSecret(saved.key), cert: saved.cert, source: saved.source ?? 'uploaded', required: Boolean(saved.required) };
  } catch {
    // Sealed with another credentials key: as good as none (Settings shows it, and generating a new one fixes it).
    return undefined;
  }
}

const pemFirst = (cert: string) => pemCertificates(cert)[0] ?? cert;

/** A certificate's public details for the view (the key never leaves). */
function certView(cert: string): Pick<SamlKeyInfo, 'subject' | 'validTo' | 'fingerprint' | 'certificate'> | { error: string } {
  try {
    const info = certificateInfo(cert);
    return { subject: info.subject, validTo: info.validTo, fingerprint: info.fingerprint, certificate: pemFirst(cert) };
  } catch {
    return { error: 'The certificate can’t be read' };
  }
}

function slotInfo(slot: Slot | undefined): SamlKeyInfo | undefined {
  if (!slot) return undefined;
  return { source: slot.source, ...(slot.createdAt && { createdAt: slot.createdAt }), ...(slot.retiredAt && { retiredAt: slot.retiredAt }), ...certView(slot.cert) };
}

function nextEnvOrSaved(saved: Stored): SamlKeyInfo | undefined {
  const env = nextFromEnv();
  if (env) return { source: 'env', ...certView(env.cert) };
  return slotInfo(saved.next);
}

/** Settings → Security: the certificate (never the key) and whether assertions must be encrypted. */
export function samlEncryptionView(): SamlEncryptionView {
  const saved = stored();
  const env = fromEnv();
  const cert = env?.cert ?? saved.cert;
  const view: SamlEncryptionView = { configured: Boolean(cert), required: Boolean(saved.required && cert), fromEnv: Boolean(env) };
  const next = nextEnvOrSaved(saved);
  if (next) view.next = next;
  const previous = slotInfo(saved.previous);
  if (previous) view.previous = previous;
  if (!cert) return view;
  view.source = env ? 'env' : (saved.source ?? 'uploaded');
  if (!env && saved.createdAt) view.createdAt = saved.createdAt;
  try {
    const info = certificateInfo(cert);
    Object.assign(view, { subject: info.subject, validTo: info.validTo, fingerprint: info.fingerprint, certificate: pemCertificates(cert)[0] ?? cert });
  } catch {
    view.error = 'The certificate can’t be read';
  }
  if (!env && saved.key && !samlDecryption()) view.error = 'The key was sealed with another credentials key: generate or upload a new one';
  if (env) {
    const problem = keyPairProblem(env.cert, env.key);
    if (problem) view.error = `LANDFLOW_SAML_DECRYPTION_KEY / _CERT: ${problem}`;
  }
  return view;
}

function refuseWhenEnv(slot: SamlKeySlot = 'current') {
  if (slot === 'current' && fromEnv()) throw new SamlKeyError('The decryption key comes from LANDFLOW_SAML_DECRYPTION_KEY and LANDFLOW_SAML_DECRYPTION_CERT: change it there');
  if (slot === 'next' && nextFromEnv()) throw new SamlKeyError('The next decryption key comes from LANDFLOW_SAML_DECRYPTION_NEXT_KEY and LANDFLOW_SAML_DECRYPTION_NEXT_CERT: change it there');
}

/** The next slot needs a current key to rotate from (and an environment-set current key can't be rotated here). */
function needCurrentForNext() {
  if (!samlDecryption()) throw new SamlKeyError('Set up the current decryption key first: the next one is published beside it');
}

/** Store a key pair in `slot` (the current pair, or the next one published beside it). */
function put(slot: SamlKeySlot, pair: { cert: string; key: string; source: 'generated' | 'uploaded' }, userId?: string) {
  const saved = stored();
  const fields = { cert: pair.cert, key: credentials.sealSecret(pair.key), source: pair.source, createdAt: new Date().toISOString(), ...(userId && { createdBy: userId }) };
  if (slot === 'next') save({ ...saved, next: fields });
  else save({ ...saved, ...fields });
}

/**
 * A new key pair: replacing the current one, or (`slot: 'next'`) staged beside it for rotation. The IdP needs the new
 * certificate (from our metadata) afterwards.
 */
export function generateSamlEncryptionKey(commonName: string, userId?: string, slot: SamlKeySlot = 'current'): SamlEncryptionView {
  refuseWhenEnv(slot);
  if (slot === 'next') needCurrentForNext();
  const { cert, key } = createCertificate({ commonName: commonName.slice(0, 64) || 'Landflow SAML', organization: 'Landflow', keyUsage: ['keyEncipherment', 'dataEncipherment'] });
  put(slot, { cert, key, source: 'generated' }, userId);
  return samlEncryptionView();
}

/** An uploaded certificate and RSA private key (PEM; an encrypted key needs its passphrase), as the current or the next pair. */
export function uploadSamlEncryptionKey(input: { cert: string; key: string; passphrase?: string }, userId?: string, slot: SamlKeySlot = 'current'): SamlEncryptionView {
  refuseWhenEnv(slot);
  if (slot === 'next') needCurrentForNext();
  const certs = pemCertificates(input.cert);
  const problem = keyPairProblem(input.cert, input.key, input.passphrase || undefined);
  if (problem) throw new SamlKeyError(problem);
  const privateKey = createPrivateKey({ key: input.key, ...(input.passphrase && { passphrase: input.passphrase }) });
  if (privateKey.asymmetricKeyType !== 'rsa') throw new SamlKeyError('The key must be an RSA key: IdPs encrypt assertions with RSA key transport');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  if (slot === 'next' && certs[0] === pemCertificates(samlDecryption()!.cert)[0]) throw new SamlKeyError('That is the current certificate: upload a different one as the next');
  put(slot, { cert: certs[0], key: pkcs8, source: 'uploaded' }, userId);
  return samlEncryptionView();
}

/**
 * The switch-over: the next pair becomes the current one (our metadata stops offering the old certificate) and the old
 * key is kept as `previous`, to decrypt what the IdP encrypted before it moved, until it is discarded.
 */
export function switchSamlEncryptionKey(): SamlEncryptionView {
  refuseWhenEnv('current');
  refuseWhenEnv('next');
  const saved = stored();
  if (!saved.next) throw new SamlKeyError('There is no next key to switch to: generate or upload one first');
  if (!openSlot(saved.next)) throw new SamlKeyError('The next key was sealed with another credentials key: generate or upload it again');
  const { next, previous: _dropped, ...rest } = saved;
  const retired: Slot | undefined = saved.cert && saved.key ? { cert: saved.cert, key: saved.key, source: saved.source ?? 'uploaded', ...(saved.createdAt && { createdAt: saved.createdAt }), retiredAt: new Date().toISOString() } : undefined;
  save({ ...rest, cert: next.cert, key: next.key, source: next.source, ...(next.createdAt && { createdAt: next.createdAt }), ...(next.createdBy && { createdBy: next.createdBy }), ...(retired && { previous: retired }) });
  return samlEncryptionView();
}

/** Drop the staged next key, or the retired previous one (which then stops decrypting). */
export function discardSamlEncryptionKey(slot: 'next' | 'previous'): SamlEncryptionView {
  if (slot === 'next') refuseWhenEnv('next');
  const { next, previous, ...rest } = stored();
  if (slot === 'next' ? !next : !previous) throw new SamlKeyError(`There is no ${slot} key`);
  save({ ...rest, ...(slot === 'next' ? { previous } : { next }) });
  return samlEncryptionView();
}

/** Require (or stop requiring) encrypted assertions; needs a key. */
export function setSamlEncryptionRequired(required: boolean): SamlEncryptionView {
  if (required && !samlDecryption()) throw new SamlKeyError('Generate or upload a decryption key first');
  save({ ...stored(), required });
  return samlEncryptionView();
}

/** Remove the stored key pairs (current, next and previous; assertions are no longer required to be encrypted). */
export function removeSamlEncryptionKey(): SamlEncryptionView {
  refuseWhenEnv();
  save({});
  return samlEncryptionView();
}
