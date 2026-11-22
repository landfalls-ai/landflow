/**
 * GET /api/me/mfa (a signed-in person, session only): your second factors (never a secret), how many recovery codes are
 * left, what LANDFLOW_MFA_REQUIRED asks of you and whether this session passed a second-factor check in the last five
 * minutes (the check removing a factor or making new codes needs).
 */
import type { MfaStateView } from '@/lib/shared/auth';
import { currentPrincipal, requireUser } from '@/lib/server/auth';
import { enrolmentRequired, listFactors, mfaCovers, mfaMode, recoveryCodesLeft, STEP_UP_MINUTES } from '@/lib/server/auth/mfa';
import { sessionMfaVerifiedAt } from '@/lib/server/auth/sessions';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await requireUser();
  const principal = currentPrincipal();
  const checked = sessionMfaVerifiedAt(principal?.sessionId);
  const view: MfaStateView = {
    factors: listFactors(user.id),
    recoveryCodesLeft: recoveryCodesLeft(user.id),
    mode: mfaMode(),
    covered: mfaCovers(user),
    enrolmentRequired: enrolmentRequired(user, principal?.sessionMethod),
    recentlyVerified: Boolean(checked && Date.now() - Date.parse(checked) <= STEP_UP_MINUTES * 60_000),
    canEnrol: Boolean(user.passwordHash),
  };
  return json(view);
});
