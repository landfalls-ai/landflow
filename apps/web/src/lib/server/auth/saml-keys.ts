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
 */
import { createPrivateKey } from 'node:crypto';
import type { SamlEncryptionView } from '../../shared/auth';
import { credentials } from '../credentials/vault';
import { parse } from '../db/rows';
import { authDb } from './db';
import { certificateInfo, createCertificate, keyPairProblem, pemCertificates } from './x509';

const SETTINGS_KEY = 'saml_encryption';

export class SamlKeyError extends Error {}

interface Stored {
  cert?: string;
  /** Sealed PKCS#8 PEM. */
  key?: string;
  source?: 'generated' | 'uploaded';
  createdAt?: string;
  createdBy?: string;
  /** Refuse unencrypted assertions. */
  required?: boolean;
}

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

/** Settings → Security: the certificate (never the key) and whether assertions must be encrypted. */
export function samlEncryptionView(): SamlEncryptionView {
  const saved = stored();
  const env = fromEnv();
  const cert = env?.cert ?? saved.cert;
  const view: SamlEncryptionView = { configured: Boolean(cert), required: Boolean(saved.required && cert), fromEnv: Boolean(env) };
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

function refuseWhenEnv() {
  if (fromEnv()) throw new SamlKeyError('The decryption key comes from LANDFLOW_SAML_DECRYPTION_KEY and LANDFLOW_SAML_DECRYPTION_CERT: change it there');
}

/** A new key pair (replacing the current one). The IdP needs the new certificate (from our metadata) afterwards. */
export function generateSamlEncryptionKey(commonName: string, userId?: string): SamlEncryptionView {
  refuseWhenEnv();
  const { cert, key } = createCertificate({ commonName: commonName.slice(0, 64) || 'Landflow SAML', organization: 'Landflow', keyUsage: ['keyEncipherment', 'dataEncipherment'] });
  save({ ...stored(), cert, key: credentials.sealSecret(key), source: 'generated', createdAt: new Date().toISOString(), ...(userId && { createdBy: userId }) });
  return samlEncryptionView();
}

/** An uploaded certificate and RSA private key (PEM; an encrypted key needs its passphrase). */
export function uploadSamlEncryptionKey(input: { cert: string; key: string; passphrase?: string }, userId?: string): SamlEncryptionView {
  refuseWhenEnv();
  const certs = pemCertificates(input.cert);
  const problem = keyPairProblem(input.cert, input.key, input.passphrase || undefined);
  if (problem) throw new SamlKeyError(problem);
  const privateKey = createPrivateKey({ key: input.key, ...(input.passphrase && { passphrase: input.passphrase }) });
  if (privateKey.asymmetricKeyType !== 'rsa') throw new SamlKeyError('The key must be an RSA key: IdPs encrypt assertions with RSA key transport');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  save({ ...stored(), cert: certs[0], key: credentials.sealSecret(pkcs8), source: 'uploaded', createdAt: new Date().toISOString(), ...(userId && { createdBy: userId }) });
  return samlEncryptionView();
}

/** Require (or stop requiring) encrypted assertions; needs a key. */
export function setSamlEncryptionRequired(required: boolean): SamlEncryptionView {
  if (required && !samlDecryption()) throw new SamlKeyError('Generate or upload a decryption key first');
  save({ ...stored(), required });
  return samlEncryptionView();
}

/** Remove the stored key pair (assertions are no longer required to be encrypted). */
export function removeSamlEncryptionKey(): SamlEncryptionView {
  refuseWhenEnv();
  save({});
  return samlEncryptionView();
}
