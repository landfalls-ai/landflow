/**
 * The sign-in challenge: what a correct password buys when the user has a second factor. A random 32-byte token (the
 * database keeps its SHA-256 as the row id), valid five minutes, single use, bound to the user. It grants nothing but
 * `POST /api/auth/mfa/verify`: it is not a session and no route accepts it as one. Every answer is claimed first (`claimAttempt`): the fifth ends the challenge, however many are in flight at once.
 * Rows live in `mfa_challenges`, so any main can verify what another made.
 */
import { TABLES, type Database, type SqlValue } from '../../db';
import { authDb } from '../db';
import { randomToken, tokenHash } from '../passwords';
import type { UserRecord } from '../users';
import { takeOnce } from './once';

export const CHALLENGE_MINUTES = 5;
export const MAX_WRONG = 5;

/** `sign-in` (the second step), `register` (adding a passkey) and `step-up` (a fresh check by a signed-in person): a token of one purpose answers only that purpose's route. */
export type ChallengePurpose = 'sign-in' | 'register' | 'step-up';
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

/**
 * Claim one of the challenge's five answers, before the code is looked at: a conditional write decided where the row
 * lives, so answers in flight at once on several mains still total five. Returns how many answers have been claimed (the
 * fifth is the last), or undefined when the challenge is spent, expired or has no answers left.
 */
export async function claimAttempt(token: string, now = Date.now(), db?: Database): Promise<number | undefined> {
  if (!token || token.length > 100) return undefined;
  const live = (row: Record<string, unknown>) => !row.used_at && String(row.expires_at) > iso(now) && Number(row.wrong) < MAX_WRONG;
  const claimed = await takeOnce({ table: 'mfa_challenges', key: { id: tokenHash(token) }, set: { wrong: { $inc: 1 } }, when: 'used_at IS NULL AND expires_at > ? AND wrong < ?', whenParams: [iso(now), MAX_WRONG], check: live }, db);
  return claimed ? Number(claimed.wrong) : undefined;
}

/** Spend the challenge after a right answer: of several callers with the same token, one gets the row. */
export async function useChallenge(token: string, now = Date.now()): Promise<ChallengeRow | undefined> {
  if (!token || token.length > 100) return undefined;
  const id = tokenHash(token);
  const won = await takeOnce({ table: 'mfa_challenges', key: { id }, set: { used_at: iso(now) }, when: 'used_at IS NULL AND expires_at > ?', whenParams: [iso(now)], check: (row) => !row.used_at && String(row.expires_at) > iso(now) });
  if (!won) return undefined;
  return { id, userId: String(won.user_id), purpose: won.purpose as ChallengePurpose, firstMethod: won.first_method as FirstMethod, wrong: Number(won.wrong), expiresAt: String(won.expires_at) };
}

/**
 * Remember the WebAuthn challenge a passkey must sign for this token (one at a time: a new one replaces the last),
 * decided where the row lives. False when the token is not live. The challenge is random, never logged.
 */
export async function setWebauthnChallenge(token: string, webauthnChallenge: string, now = Date.now()): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const live = (row: Record<string, unknown>) => !row.used_at && String(row.expires_at) > iso(now) && Number(row.wrong) < MAX_WRONG;
  const won = await takeOnce({ table: 'mfa_challenges', key: { id: tokenHash(token) }, set: { webauthn_challenge: webauthnChallenge }, when: 'used_at IS NULL AND expires_at > ? AND wrong < ?', whenParams: [iso(now), MAX_WRONG], check: live });
  return Boolean(won);
}

/**
 * Take the WebAuthn challenge off the token, once: of several callers only one gets it (and a failed attempt burns it,
 * so the next try asks for new options). Undefined when the token is spent or expired, or has none. It does not look at
 * the wrong-answer count: the caller claimed its attempt (`claimAttempt`) first, so the fifth answer must still get its
 * challenge. On Postgres the take is one statement that locks the row and answers the value it held (`FOR UPDATE`), so a
 * verify on another main never works from a stale copy.
 */
export async function consumeWebauthnChallenge(token: string, now = Date.now(), db: Database = authDb()): Promise<string | undefined> {
  if (!token || token.length > 100) return undefined;
  const id = tokenHash(token);
  if (db.kind === 'postgres') {
    await db.flush();
    const taken = await db.direct(async (client) => {
      const result = await client.query<Record<string, SqlValue>>(
        `WITH old AS (SELECT id, webauthn_challenge FROM mfa_challenges WHERE id = $1 FOR UPDATE)
         UPDATE mfa_challenges m SET webauthn_challenge = NULL FROM old
         WHERE m.id = old.id AND old.webauthn_challenge IS NOT NULL AND m.used_at IS NULL AND m.expires_at > $2
         RETURNING m.*, old.webauthn_challenge AS previous`,
        [id, iso(now)],
      );
      const row = result.rows[0];
      if (row) {
        const notice = db.keyNotice('mfa_challenges', (TABLES.mfa_challenges as readonly string[]).map((c) => row[c]));
        if (notice) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', notice]);
      }
      return row;
    });
    if (!taken) return undefined;
    const { previous, ...rest } = taken;
    db.upsertLocal('mfa_challenges', rest);
    return String(previous);
  }
  const row = db.get<{ webauthn_challenge: string | null }>('SELECT webauthn_challenge FROM mfa_challenges WHERE id = ?', id);
  const expected = row?.webauthn_challenge;
  if (!expected) return undefined;
  const won = await takeOnce({ table: 'mfa_challenges', key: { id }, set: { webauthn_challenge: null }, when: 'webauthn_challenge = ? AND used_at IS NULL AND expires_at > ?', whenParams: [expected, iso(now)], check: (r) => r.webauthn_challenge === expected && !r.used_at && String(r.expires_at) > iso(now) }, db);
  return won ? expected : undefined;
}
