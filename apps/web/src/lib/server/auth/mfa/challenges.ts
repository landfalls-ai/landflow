/**
 * The sign-in challenge: what a correct password buys when the user has a second factor. A random 32-byte token (the
 * database keeps its SHA-256 as the row id), valid five minutes, single use, bound to the user. It grants nothing but
 * `POST /api/auth/mfa/verify`: it is not a session and no route accepts it as one. Five wrong answers burn it.
 * Rows live in `mfa_challenges`, so any main can verify what another made.
 */
import { authDb } from '../db';
import { randomToken, tokenHash } from '../passwords';
import type { UserRecord } from '../users';
import { takeOnce } from './once';

export const CHALLENGE_MINUTES = 5;
export const MAX_WRONG = 5;

export type ChallengePurpose = 'sign-in' | 'step-up';
export type FirstMethod = 'password' | 'reset';

export interface ChallengeRow {
  id: string;
  userId: string;
  purpose: ChallengePurpose;
  firstMethod: FirstMethod;
  wrong: number;
  expiresAt: string;
}

interface Stored {
  id: string;
  user_id: string;
  purpose: string;
  first_method: string;
  wrong: number;
  expires_at: string;
  used_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Make a challenge for `user`; the token is returned once and never stored. */
export async function openChallenge(user: UserRecord, purpose: ChallengePurpose, firstMethod: FirstMethod, now = Date.now()): Promise<string> {
  const token = randomToken(32);
  const db = authDb();
  db.transaction(() => {
    db.deleteBefore('mfa_challenges', 'expires_at', iso(now - 60 * 60_000));
    db.insertNew('mfa_challenges', { id: tokenHash(token), user_id: user.id, purpose, first_method: firstMethod, wrong: 0, created_at: iso(now), expires_at: iso(now + CHALLENGE_MINUTES * 60_000), used_at: null });
  });
  // In Postgres before another main can be asked to verify it.
  if (db.kind === 'postgres') await db.flush();
  return token;
}

const live = (row: Stored | undefined, now: number): row is Stored => Boolean(row && !row.used_at && Date.parse(row.expires_at) > now && Number(row.wrong) < MAX_WRONG);

/** The challenge of `token` when it is live (unused, unexpired, not burnt), else undefined. */
export function peekChallenge(token: string, now = Date.now()): ChallengeRow | undefined {
  if (!token || token.length > 100) return undefined;
  const row = authDb().get<Stored>('SELECT * FROM mfa_challenges WHERE id = ?', tokenHash(token));
  if (!live(row, now)) return undefined;
  return { id: row.id, userId: row.user_id, purpose: row.purpose as ChallengePurpose, firstMethod: row.first_method as FirstMethod, wrong: Number(row.wrong), expiresAt: row.expires_at };
}

/** Count a wrong answer; the fifth burns the challenge (the person signs in again). */
export async function noteWrong(token: string, now = Date.now()): Promise<'again' | 'burned'> {
  const id = tokenHash(token);
  const after = await takeOnce({ table: 'mfa_challenges', key: { id }, set: { wrong: { $inc: 1 } }, when: 'used_at IS NULL AND expires_at > ? AND wrong < ?', whenParams: [iso(now), MAX_WRONG], check: (row) => !row.used_at && String(row.expires_at) > iso(now) && Number(row.wrong) < MAX_WRONG });
  return !after || Number(after.wrong) >= MAX_WRONG ? 'burned' : 'again';
}

/** Spend the challenge: of several callers with the same token, one gets the row. */
export async function useChallenge(token: string, now = Date.now()): Promise<ChallengeRow | undefined> {
  if (!token || token.length > 100) return undefined;
  const id = tokenHash(token);
  const won = await takeOnce({ table: 'mfa_challenges', key: { id }, set: { used_at: iso(now) }, when: 'used_at IS NULL AND expires_at > ? AND wrong < ?', whenParams: [iso(now), MAX_WRONG], check: (row) => !row.used_at && String(row.expires_at) > iso(now) && Number(row.wrong) < MAX_WRONG });
  if (!won) return undefined;
  return { id, userId: String(won.user_id), purpose: won.purpose as ChallengePurpose, firstMethod: won.first_method as FirstMethod, wrong: Number(won.wrong), expiresAt: String(won.expires_at) };
}
