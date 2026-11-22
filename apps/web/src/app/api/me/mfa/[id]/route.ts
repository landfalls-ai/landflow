/**
 * DELETE /api/me/mfa/<id> (a signed-in person, session only): remove one of your own factors. Needs a second-factor
 * check from the last five minutes (403 `mfa_step_up_required`; POST /api/me/mfa/step-up); the last one is refused
 * (409) while LANDFLOW_MFA_REQUIRED covers you. Removing the last factor deletes the recovery codes too.
 */
import { currentPrincipal, requireUser } from '@/lib/server/auth';
import { removeFactor } from '@/lib/server/auth/mfa';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const user = await requireUser();
  removeFactor(user, currentPrincipal()?.sessionId, (await params).id);
  return json({ ok: true });
});
