/**
 * POST /api/me/mfa/totp/<id>/confirm { code } (a signed-in person, session only): confirm a started authenticator app
 * with a current code. The first confirmed factor also makes ten recovery codes, answered once as `recoveryCodes`. This
 * session counts as having passed a second-factor check. Wrong codes count against the sign-in limits (429).
 */
import { z } from 'zod';
import { clientIp, currentPrincipal, requireUser } from '@/lib/server/auth';
import { answerSecondFactor, confirmTotp, listFactors } from '@/lib/server/auth/mfa';
import { markMfaVerified } from '@/lib/server/auth/sessions';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ code: z.string().trim().min(1, 'Enter the code').max(32) });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  let confirmed: Awaited<ReturnType<typeof confirmTotp>> = { ok: false };
  const answer = await answerSecondFactor(
    user,
    clientIp(request),
    async () => {
      confirmed = await confirmTotp(user, id, body.data.code);
      return { ok: confirmed.ok };
    },
    'totp',
  );
  if (answer.status === 'limited') return error('Too many failed attempts. Try again later.', 429, { retryAfter: answer.retryAfter });
  if (answer.status === 'wrong') return error('That code didn’t work. Check your app (and that your device’s clock is right); a code works once, so wait for the next one if you just used it.', 400);
  markMfaVerified(currentPrincipal()?.sessionId);
  return json({ factor: listFactors(user.id).find((f) => f.id === id), ...(confirmed.recoveryCodes && { recoveryCodes: confirmed.recoveryCodes }) }, { headers: { 'cache-control': 'no-store' } });
});
