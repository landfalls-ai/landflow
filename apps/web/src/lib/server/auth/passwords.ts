/**
 * Password hashing with `crypto.scrypt` and a random 16-byte salt per password. Stored as
 * `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), so the cost can rise later without breaking old hashes.
 * Tokens (sessions, API keys, invite links) are random and long, so a plain SHA-256 is enough for them.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...options, maxmem: 128 * (options.N ?? N) * (options.r ?? R) * 2 }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Whether `password` matches `stored` (constant time). A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const options = { N: Number(n), r: Number(r), p: Number(p) };
  if (![options.N, options.r, options.p].every((v) => Number.isInteger(v) && v > 0) || options.N > 1 << 20) return false;
  const expected = Buffer.from(key, 'base64url');
  try {
    const actual = await derive(password, Buffer.from(salt, 'base64url'), options);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A hash to verify against when the user doesn't exist, so a wrong email takes as long as a wrong password. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

/** A random token: `bytes` random bytes, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 (hex) of a token: what the database keeps for sessions, API keys and one-time links. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two secrets (hashed first, so lengths don't leak either). */
export function sameSecret(given: string | undefined | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}
