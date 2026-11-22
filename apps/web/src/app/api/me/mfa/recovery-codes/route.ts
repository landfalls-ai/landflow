/**
 * POST /api/me/mfa/recovery-codes (a signed-in person, session only): make a new set of ten recovery codes; the old set
 * stops working. Answered once as `recoveryCodes`. Needs a second-factor check from the last five minutes (403
 * `mfa_step_up_required`) and at least one factor (409).
 */
import { currentPrincipal, requireUser } from '@/lib/server/auth';
import { hasConfirmedFactor, MfaError, newRecoveryCodes, STEP_UP_MINUTES } from '@/lib/server/auth/mfa';
import { sessionMfaVerifiedAt } from '@/lib/server/auth/sessions';
import { recordAudit } from '@/lib/server/audit';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  const user = await requireUser();
  if (!hasConfirmedFactor(user.id)) throw new MfaError('Add a second factor first', 409);
  const checked = sessionMfaVerifiedAt(currentPrincipal()?.sessionId);
  if (!checked || Date.now() - Date.parse(checked) > STEP_UP_MINUTES * 60_000) throw new MfaError('Check your second factor first, then try again', 403, 'mfa_step_up_required');
  const recoveryCodes = newRecoveryCodes(user.id);
  recordAudit({ action: 'auth.mfa_recovery_regenerated', target: { type: 'user', id: user.id }, summary: 'Made new recovery codes', details: { count: recoveryCodes.length } });
  return json({ recoveryCodes }, { headers: { 'cache-control': 'no-store' } });
});
