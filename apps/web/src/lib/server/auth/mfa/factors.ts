/**
 * A person's second factors (`user_mfa_factors`): an authenticator app (TOTP) and passkeys (./webauthn). The TOTP secret is sealed with the key ring (`sealSecret`, the default purpose: key rotation re-seals only values of that purpose) and
 * is returned once, at enrolment; a factor counts only once a valid code confirmed it. A code is accepted once: the
 * factor's `last_step` only moves forward (decided in `takeOnce`, so two mains agree). Adding, removing and resetting
 * are audited with ids and kinds, never a secret or a code.
 */
import { nanoid } from 'nanoid';
import type { MfaFactorView, MfaMethod } from '../../../shared/auth';
import { auditedTransaction, recordAudit } from '../../audit';
import { credentials } from '../../credentials/vault';
import { authDb } from '../db';
import { deleteUserSessions, sessionMfaVerifiedAt } from '../sessions';
import type { UserRecord } from '../users';
import { MfaError } from './errors';
import { hasUsablePasskey, stepUpPasskey, type Assertion } from './webauthn';
import { takeOnce } from './once';
import { loginLimits } from '../rate-limit';
import { deleteRecoveryCodes, newRecoveryCodes, recoveryCodesLeft, useRecoveryCode } from './recovery';
import { matchingStep, newTotpSecret, otpauthUrl } from './totp';
import { mfaCovers } from './policy';

export { MfaError };

/** A fresh second-factor check (FR-9) is one from the last five minutes. */
export const STEP_UP_MINUTES = 5;
const UNCONFIRMED_MINUTES = 15;

interface FactorRow {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  secret: string | null;
  last_step: number | null;
  confirmed_at: string | null;
  flagged_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

const rows = (userId: string) => authDb().all<FactorRow>('SELECT * FROM user_mfa_factors WHERE user_id = ? ORDER BY created_at', userId);

/** The factors as the person may see them: never a secret. */
export function listFactors(userId: string): MfaFactorView[] {
  return rows(userId).map((row) => ({
    id: row.id,
    kind: row.kind as MfaFactorView['kind'],
    name: row.name,
    confirmed: Boolean(row.confirmed_at),
    createdAt: row.created_at,
    ...(row.last_used_at && { lastUsedAt: row.last_used_at }),
    ...(row.flagged_at && { flagged: true }),
  }));
}

export const hasConfirmedFactor = (userId: string): boolean => listFactors(userId).some((factor) => factor.confirmed);

/** What can answer a sign-in challenge: a passkey (if one is unflagged), the authenticator app (if any) and the recovery codes (if any are left). */
export function methodsFor(userId: string): MfaMethod[] {
  const methods: MfaMethod[] = [];
  if (hasUsablePasskey(userId)) methods.push('webauthn');
  if (rows(userId).some((row) => row.kind === 'totp' && row.confirmed_at)) methods.push('totp');
  if (recoveryCodesLeft(userId) > 0) methods.push('recovery');
  return methods;
}

/** A TOTP factor's secret in the clear (tests and the verifier only; nothing returns it to a client after enrolment). */
export function secretOf(factorId: string): string {
  const row = authDb().get<FactorRow>('SELECT * FROM user_mfa_factors WHERE id = ?', factorId);
  if (!row?.secret) throw new MfaError('Factor not found', 404);
  return credentials.openSecret(row.secret);
}

/** Begin enrolling an authenticator app: a sealed secret, returned once with its otpauth URL. An earlier unconfirmed try is dropped. */
export function startTotp(user: UserRecord): { factorId: string; secret: string; otpauthUrl: string } {
  if (!user.passwordHash) throw new MfaError('Accounts that sign in with single sign-on use their identity provider’s second factor', 409);
  const db = authDb();
  if (rows(user.id).some((row) => row.kind === 'totp' && row.confirmed_at)) throw new MfaError('You already have an authenticator app. Remove it first to add another', 409);
  // An enrolment left unconfirmed for UNCONFIRMED_MINUTES is dropped (anyone's), so abandoned secrets don't pile up.
  for (const stale of db.all<{ id: string }>('SELECT id FROM user_mfa_factors WHERE confirmed_at IS NULL AND created_at < ?', new Date(Date.now() - UNCONFIRMED_MINUTES * 60_000).toISOString())) db.delete('user_mfa_factors', { id: stale.id });
  const secret = newTotpSecret();
  const id = `mfa_${nanoid(14)}`;
  db.transaction(() => {
    for (const row of rows(user.id)) if (!row.confirmed_at && row.kind === 'totp') db.delete('user_mfa_factors', { id: row.id });
    db.insertNew('user_mfa_factors', { id, user_id: user.id, kind: 'totp', name: 'Authenticator app', secret: credentials.sealSecret(secret), created_at: new Date().toISOString() });
  });
  return { factorId: id, secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

/** Claim `step` for the factor: true once per step, and only forward. */
async function claimStep(factorId: string, step: number, now: number): Promise<boolean> {
  const at = new Date(now).toISOString();
  return Boolean(await takeOnce({ table: 'user_mfa_factors', key: { id: factorId }, set: { last_step: step, last_used_at: at }, when: 'last_step IS NULL OR last_step < ?', whenParams: [step], check: (row) => row.last_step == null || Number(row.last_step) < step }));
}

/** Confirm an enrolment with a current code. The first confirmed factor makes the recovery codes, returned once. */
export async function confirmTotp(user: UserRecord, factorId: string, code: string, now = Date.now()): Promise<{ ok: boolean; recoveryCodes?: string[] }> {
  const row = authDb().get<FactorRow>('SELECT * FROM user_mfa_factors WHERE id = ? AND user_id = ?', factorId, user.id);
  if (!row || row.kind !== 'totp' || row.confirmed_at || !row.secret || now - Date.parse(row.created_at) > UNCONFIRMED_MINUTES * 60_000) throw new MfaError('Nothing to confirm: start again', 404);
  const step = matchingStep(credentials.openSecret(row.secret), code, now);
  if (step === undefined || !(await claimStep(row.id, step, now))) return { ok: false };
  const first = !hasConfirmedFactor(user.id);
  authDb().upsert('user_mfa_factors', { ...(authDb().get<Record<string, string | number | null>>('SELECT * FROM user_mfa_factors WHERE id = ?', row.id) ?? {}), confirmed_at: new Date(now).toISOString() });
  const recoveryCodes = first ? newRecoveryCodes(user.id) : undefined;
  recordAudit({ action: 'auth.mfa_added', target: { type: 'user', id: user.id }, summary: 'Added a second factor', details: { kind: 'totp', factorId: row.id } });
  return { ok: true, ...(recoveryCodes && { recoveryCodes }) };
}

/** Does `code` match any confirmed authenticator app of the user, in a step not used before? Moves the step forward. */
export async function verifyTotp(userId: string, code: string, now = Date.now()): Promise<boolean> {
  let ok = false;
  for (const row of rows(userId)) {
    if (row.kind !== 'totp' || !row.confirmed_at || !row.secret) continue;
    const step = matchingStep(credentials.openSecret(row.secret), code, now);
    if (step !== undefined && (await claimStep(row.id, step, now))) ok = true;
  }
  return ok;
}

/** Remove one of your own factors: needs a second-factor check in the last five minutes, and is refused for the last one while the policy covers you. */
export function removeFactor(actor: UserRecord, sessionId: string | undefined, factorId: string, now = Date.now()): void {
  const db = authDb();
  const row = db.get<FactorRow>('SELECT * FROM user_mfa_factors WHERE id = ? AND user_id = ?', factorId, actor.id);
  if (!row) throw new MfaError('Factor not found', 404);
  if (row.confirmed_at) {
    const checked = sessionMfaVerifiedAt(sessionId);
    if (!checked || now - Date.parse(checked) > STEP_UP_MINUTES * 60_000) throw new MfaError('Check your second factor first, then try again', 403, 'mfa_step_up_required');
    const confirmed = rows(actor.id).filter((r) => r.confirmed_at);
    if (confirmed.length === 1 && mfaCovers(actor)) throw new MfaError('Your account has to keep a second factor: this instance requires one for your role (LANDFLOW_MFA_REQUIRED)', 409, 'mfa_required_by_policy');
  }
  db.transaction(() => {
    db.delete('user_mfa_factors', { id: row.id });
    if (!rows(actor.id).some((r) => r.confirmed_at)) deleteRecoveryCodes(actor.id);
  });
  recordAudit({ action: 'auth.mfa_removed', target: { type: 'user', id: actor.id }, summary: 'Removed a second factor', details: { kind: row.kind, factorId: row.id } });
}

/** An owner's or admin's reset of another person's factors: audited in the same transaction (fail-closed when asked to be), then their sessions end. */
export function resetFactors(actor: UserRecord, target: UserRecord): number {
  const db = authDb();
  const removed = auditedTransaction(() => {
    const factors = rows(target.id);
    for (const factor of factors) db.delete('user_mfa_factors', { id: factor.id });
    deleteRecoveryCodes(target.id);
    recordAudit({
      action: 'auth.mfa_reset',
      target: { type: 'user', id: target.id },
      summary: 'Reset a person’s second factors',
      details: { kinds: [...new Set(factors.map((f) => f.kind))].join(','), count: factors.length, by: actor.id },
    });
    return factors.length;
  });
  deleteUserSessions(target.id);
  return removed;
}

export type AnswerResult = { status: 'ok'; left?: number } | { status: 'wrong' } | { status: 'limited'; retryAfter: number };

/**
 * A signed-in person's second-factor answer (a step-up before removing a factor or making new codes): counted against
 * the same per-email and per-IP limits as sign-in, and a failure is audited. `confirm` is for the enrolment code, which
 * is not an answer to an existing factor but is limited the same way.
 */
export async function answerSecondFactor(user: UserRecord, ip: string, run: () => Promise<{ ok: boolean; left?: number }>, method: string): Promise<AnswerResult> {
  const limits = loginLimits();
  const blocked = (await Promise.all([limits.email.check(user.email), limits.ip.check(ip)])).find((result) => !result.ok);
  if (blocked) return { status: 'limited', retryAfter: blocked.retryAfter };
  const result = await run();
  if (result.ok) return { status: 'ok', ...(result.left !== undefined && { left: result.left }) };
  await Promise.all([limits.email.hit(user.email), limits.ip.hit(ip)]);
  recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', target: { type: 'user', id: user.id }, summary: 'Failed second-factor check', details: { reason: 'mfa', method } });
  return { status: 'wrong' };
}

/** What answers a step-up: a code (authenticator app or recovery), or a passkey's assertion for a challenge from `stepUpOptions`. */
export interface StepUpInput {
  code?: string;
  challenge?: string;
  response?: Assertion;
}

/** Answer a step-up with an authenticator code, a recovery code or a passkey. */
export async function stepUpCheck(user: UserRecord, method: MfaMethod, input: StepUpInput): Promise<{ ok: boolean; left?: number }> {
  if (method === 'webauthn') return { ok: Boolean(input.challenge && input.response && (await stepUpPasskey(user, input.challenge, input.response))) };
  if (method === 'totp') return { ok: await verifyTotp(user.id, input.code ?? '') };
  const used = await useRecoveryCode(user.id, input.code ?? '');
  return used.ok ? { ok: true, left: used.left } : { ok: false };
}
