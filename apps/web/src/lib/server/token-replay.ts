/**
 * Single use for a CI token (the JWT Auth credential's "Single use"): a verified token's id is remembered until the token
 * can no longer verify, so a token copied from a log cannot start a second run. It reuses the SAML replay store
 * (`saml_replay`, auth/saml-state.ts `recordReplayIds`), which Postgres decides across processes and which expires its own
 * rows; ids are hashes, so no token text is stored.
 *
 * "Once" is once per credential: the id is the credential's id, the issuer and the `jti`. A token with no `jti` is keyed
 * by its signed part (`header.payload`, byte for byte), never the whole token: a JWS signature has more than one valid
 * encoding (spare bits in the last base64url character, high-s ECDSA), so a re-encoded signature must be the same token.
 */
import { createHash } from 'node:crypto';
import type { JWTPayload } from 'jose';
import { recordReplayIds } from './auth/saml-state';
import type { Database } from './db';

/** `jose` accepts a token up to this long after `exp` (webhook-auth.ts `verifyJwt`). */
const CLOCK_TOLERANCE_MS = 30_000;
/** Slack for the time between verifying a token and recording it, so a row never lapses before `jose` stops accepting. */
const MARGIN_MS = 5_000;
/** A single-use token may not live longer than this, so its id never has to be kept longer. */
export const MAX_TOKEN_LIFETIME_MS = 24 * 3_600_000;

export type TokenUse = { ok: true } | { ok: false; reason: 'token_replayed' | 'no_expiry' | 'exp_too_far' };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** `header.payload` of a compact JWS, as sent. */
const signedPart = (token: string) => token.split('.').slice(0, 2).join('.');

/**
 * Marks the token used. `token_replayed` when it already was, `no_expiry` when it names no `exp` to remember it until,
 * `exp_too_far` when it lives more than 24 h (its id would lapse before the token does).
 */
export async function useTokenOnce(payload: JWTPayload, token: string, options: { credentialId?: string; now?: number; db?: Database } = {}): Promise<TokenUse> {
  const { credentialId = '', now = Date.now(), db } = options;
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'no_expiry' };
  if (payload.exp * 1000 - now > MAX_TOKEN_LIFETIME_MS) return { ok: false, reason: 'exp_too_far' };
  const expiresAt = payload.exp * 1000 + CLOCK_TOLERANCE_MS + MARGIN_MS;
  const key = typeof payload.jti === 'string' && payload.jti ? [credentialId, payload.iss ?? '', payload.jti] : [credentialId, signedPart(token)];
  const id = `jwt:${sha256(JSON.stringify(key))}`;
  const replayed = new Error('token replayed');
  try {
    await recordReplayIds([id], expiresAt, () => replayed, now, db);
    return { ok: true };
  } catch (caught) {
    if (caught === replayed) return { ok: false, reason: 'token_replayed' };
    throw caught;
  }
}
