/**
 * Recovery codes: ten one-use codes (10 Crockford base32 characters, shown as `XXXXX-XXXXX`, 50 bits) for a person who
 * lost the phone. The database keeps an HMAC-SHA-256 of each under a key derived from the vault's (`mfa.recovery`), so
 * a copy of the table can't be guessed offline; a code is looked up against every key of the ring (a rotation doesn't
 * void them) and compared in constant time. Shown once, a new set replaces the old, each works once (`takeOnce`).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { credentials } from '../../credentials/vault';
import { authDb } from '../db';
import { takeOnce } from './once';

/** C16-D3. */
export const RECOVERY_CODES = 10;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCodes(count = RECOVERY_CODES): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(32)]).join('');
    codes.add(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return [...codes];
}

/** Upper case, no dashes or spaces, and Crockford's look-alikes folded (O to 0, I and L to 1). */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const hashWith = (key: Buffer, code: string) => createHmac('sha256', key).update(normalizeRecoveryCode(code)).digest('hex');

/** Make a new set for the user (the old one stops working) and return the codes: the only time they are visible. */
export function newRecoveryCodes(userId: string): string[] {
  const codes = generateRecoveryCodes();
  const key = credentials.deriveKey('mfa.recovery');
  const now = new Date().toISOString();
  const db = authDb();
  db.transaction(() => {
    db.delete('user_recovery_codes', { user_id: userId });
    for (const code of codes) db.insertNew('user_recovery_codes', { user_id: userId, code_hash: hashWith(key, code), created_at: now, used_at: null });
  });
  return codes;
}

export function recoveryCodesLeft(userId: string): number {
  return Number(authDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId)?.n ?? 0);
}

export function deleteRecoveryCodes(userId: string): void {
  authDb().delete('user_recovery_codes', { user_id: userId });
}

/** Use `code` once. `left` counts the unused codes after it. */
export async function useRecoveryCode(userId: string, code: string): Promise<{ ok: true; left: number } | { ok: false }> {
  const rows = authDb().all<{ code_hash: string }>('SELECT code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId);
  const candidates = credentials.deriveKeys('mfa.recovery').map((key) => Buffer.from(hashWith(key, code)));
  // Every stored hash against every candidate, so the time doesn't say which (or whether one) matched.
  let match: string | undefined;
  for (const row of rows) {
    const stored = Buffer.from(row.code_hash);
    for (const candidate of candidates) if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = row.code_hash;
  }
  if (!match) return { ok: false };
  const now = new Date().toISOString();
  const won = await takeOnce({ table: 'user_recovery_codes', key: { user_id: userId, code_hash: match }, set: { used_at: now }, when: 'used_at IS NULL', whenParams: [], check: (row) => row.used_at == null });
  return won ? { ok: true, left: recoveryCodesLeft(userId) } : { ok: false };
}
