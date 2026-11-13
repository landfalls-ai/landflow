/**
 * The encryption key ring behind the credential vault. Keys have ids (kids): the first entry of
 * LANDFLOW_ENCRYPTION_KEYS (`kid:key,kid:key`) seals everything new, the others (and the legacy key, kid `k0`, from
 * LANDFLOW_ENCRYPTION_KEY or encryption.key) only open older data, so a key can be retired after a rotation re-sealed
 * everything. A key of 64 hex characters is used as is; any other string is a passphrase, stretched with scrypt and a
 * per-kid salt. The old unsalted SHA-256 of a passphrase stays available as `k0-legacy` so existing data still opens.
 * Pure functions: the vault owns the files, this module only builds keys and seals text.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync } from 'node:crypto';

/** The kid of the key from LANDFLOW_ENCRYPTION_KEY / encryption.key, and of its pre-scrypt SHA-256 form. */
export const LEGACY_KID = 'k0';
export const LEGACY_SHA_KID = 'k0-legacy';

const KID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_KEY = /^[0-9a-f]{64}$/i;

export interface KeyRing {
  /** Seals everything new. */
  primary: string;
  keys: Map<string, Buffer>;
}

/** Sealed value, version 2: bound to `aad`, names its key. Version 1 (no `v`, no `kid`) has neither. */
export interface SealedValue {
  v?: 2;
  kid?: string;
  iv: string;
  tag: string;
  value: string;
}

/** One key from its configured text: 64 hex characters as is, otherwise scrypt (N=2^15, r=8, p=1) salted per kid. */
export function keyFromText(kid: string, text: string): Buffer {
  if (HEX_KEY.test(text)) return Buffer.from(text, 'hex');
  // 128 * N * r = 32 MiB is exactly Node's default limit, which it treats as too much.
  return scryptSync(text, `landflow:kdf:v2:${kid}`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/** The key the first versions made from a passphrase: one unsalted SHA-256. Only for opening what they sealed. */
export const legacyPassphraseKey = (text: string): Buffer => createHash('sha256').update(text).digest();

/** `kid:key,kid:key` → entries; throws on a bad kid, a missing key or a repeated kid, so a typo stops the host at start. */
export function parseKeyList(text: string): Array<{ kid: string; key: string }> {
  const entries = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      const kid = at < 0 ? '' : part.slice(0, at).trim();
      const key = at < 0 ? '' : part.slice(at + 1).trim();
      if (!KID.test(kid) || !key) throw new Error(`LANDFLOW_ENCRYPTION_KEYS: "${part.slice(0, at < 0 ? 12 : at)}…" is not kid:key (a kid is letters, digits, _ or -, up to 32)`);
      return { kid, key };
    });
  const seen = new Set<string>();
  for (const { kid } of entries) {
    if (seen.has(kid) || kid === LEGACY_KID || kid === LEGACY_SHA_KID) throw new Error(`LANDFLOW_ENCRYPTION_KEYS: kid "${kid}" is ${seen.has(kid) ? 'listed twice' : 'reserved'}`);
    seen.add(kid);
  }
  return entries;
}

/** The ring: the listed keys (first = primary), then the legacy key (and its SHA-256 form for a passphrase) for old data. */
export function buildKeyRing(listed: string | undefined, legacy: string | undefined): KeyRing {
  const entries = listed?.trim() ? parseKeyList(listed) : [];
  const keys = new Map<string, Buffer>();
  for (const { kid, key } of entries) keys.set(kid, keyFromText(kid, key));
  if (legacy) {
    keys.set(LEGACY_KID, HEX_KEY.test(legacy) ? Buffer.from(legacy, 'hex') : keyFromText(LEGACY_KID, legacy));
    if (!HEX_KEY.test(legacy)) keys.set(LEGACY_SHA_KID, legacyPassphraseKey(legacy));
  }
  const primary = entries[0]?.kid ?? LEGACY_KID;
  if (!keys.has(primary)) throw new Error('No encryption key');
  return { primary, keys };
}

export class OpenError extends Error {}

export function sealWith(ring: KeyRing, text: string, aad: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.primary)!, iv);
  cipher.setAAD(Buffer.from(aad));
  const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { v: 2, kid: ring.primary, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
}

function decrypt(key: Buffer, sealed: SealedValue, aad?: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.value, 'base64')), decipher.final()]).toString('utf8');
}

/** Opens a v2 value with its key and `aad`; a v1 value (no kid) with k0, then k0-legacy, without AAD. */
export function openWith(ring: KeyRing, sealed: SealedValue, aad: string): string {
  if (sealed.v === 2) {
    const key = sealed.kid ? ring.keys.get(sealed.kid) : undefined;
    if (!key) throw new OpenError(`key "${sealed.kid}" is not in the key ring`);
    return decrypt(key, sealed, aad);
  }
  for (const kid of [LEGACY_KID, LEGACY_SHA_KID]) {
    const key = ring.keys.get(kid);
    if (!key) continue;
    try {
      return decrypt(key, sealed);
    } catch {
      // The next legacy form.
    }
  }
  throw new OpenError('no key in the ring opens it');
}

/** The key id a value is sealed with; v1 values report the legacy kid (rotation re-seals them). */
export const kidOf = (sealed: SealedValue): string => (sealed.v === 2 && sealed.kid ? sealed.kid : LEGACY_KID);

/** A key for another purpose (signing OAuth2 state, resume URLs), HKDF-SHA256 from the primary key with the label as info. */
export function hkdfKey(ring: KeyRing, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ring.keys.get(ring.primary)!, 'landflow:hkdf:v1', `landflow:${label}`, 32));
}
