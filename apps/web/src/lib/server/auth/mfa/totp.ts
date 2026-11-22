/**
 * TOTP (RFC 6238, built on HOTP, RFC 4226) by hand on `node:crypto`: SHA-1, 6 digits, 30 second steps, a 20-byte secret
 * as base32 (what authenticator apps read). Nothing here touches the database: `matchingStep` says which step a code
 * belongs to and factors.ts refuses a step that was used. The QR code is the one library, `qrcode`, drawing an SVG.
 */
import { createHmac, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { sameSecret } from '../passwords';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes, 32 base32 characters. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code of `step` (the Unix time divided by 30). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** What a person types: digits, possibly with a space in the middle. Undefined when it is not six digits. */
export function cleanCode(code: string): string | undefined {
  const digits = code.replace(/\s/g, '');
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

/**
 * The step `code` belongs to within one step either side of `now`, or undefined. All three candidates are compared
 * (constant time, `sameSecret`) whether or not the first matches.
 */
export function matchingStep(secret: string, code: string, now = Date.now()): number | undefined {
  const clean = cleanCode(code);
  if (!clean) return undefined;
  const current = stepAt(now);
  let found: number | undefined;
  for (const step of [current - 1, current, current + 1]) if (sameSecret(clean, totpAt(secret, step))) found = step;
  return found;
}

/** The URL an authenticator app takes (as a QR code, or typed as a setup key). */
export function otpauthUrl(secret: string, email: string): string {
  return `otpauth://totp/Landflow:${encodeURIComponent(email)}?secret=${secret}&issuer=Landflow&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** The QR code as an SVG data URL (the CSP allows `data:` images). */
export async function qrSvgDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
