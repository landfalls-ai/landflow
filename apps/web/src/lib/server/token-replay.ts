/**
 * Single use for a CI token (the JWT Auth credential's "Single use"): a verified token's id is remembered until the token
 * can no longer verify, so a token copied from a log cannot start a second run. It reuses the SAML replay store
 * (`saml_replay`, auth/saml-state.ts `recordReplayIds`), which Postgres decides across processes and which expires its own
 * rows; ids are hashes, so no token text is stored. The id is `iss` plus `jti`, or the token's hash when it has no `jti`.
 */
import { createHash } from 'node:crypto';
import type { JWTPayload } from 'jose';
import { recordReplayIds } from './auth/saml-state';
import type { Database } from './db';

/** `jose` accepts a token up to this long after `exp` (webhook-auth.ts `verifyJwt`). */
const CLOCK_TOLERANCE_MS = 30_000;
/** However long a token says it lives, its id is not kept longer than this. */
const MAX_REMEMBER_MS = 24 * 3_600_000;

export type TokenUse = { ok: true } | { ok: false; reason: 'token_replayed' | 'no_expiry' };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Marks the token used; `token_replayed` when it already was, `no_expiry` when it names no `exp` to remember it until. */
export async function useTokenOnce(payload: JWTPayload, token: string, now = Date.now(), db?: Database): Promise<TokenUse> {
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'no_expiry' };
  const expiresAt = Math.min(payload.exp * 1000 + CLOCK_TOLERANCE_MS, now + MAX_REMEMBER_MS);
  const id = `jwt:${sha256(typeof payload.jti === 'string' && payload.jti ? `${payload.iss ?? ''}|${payload.jti}` : token)}`;
  const replayed = new Error('token replayed');
  try {
    await recordReplayIds([id], expiresAt, () => replayed, now, db);
    return { ok: true };
  } catch (caught) {
    if (caught === replayed) return { ok: false, reason: 'token_replayed' };
    throw caught;
  }
}
