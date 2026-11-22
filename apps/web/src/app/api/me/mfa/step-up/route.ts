/**
 * POST /api/me/mfa/step-up { method: 'totp' | 'recovery', code } (a signed-in person, session only): a fresh second-factor
 * check for this session, which removing a factor and making new recovery codes need within five minutes. Counts
 * against the sign-in limits (429). A recovery code used here is spent.
 */
import { z } from 'zod';
import { clientIp, currentPrincipal, requireUser } from '@/lib/server/auth';
import { answerSecondFactor, hasConfirmedFactor, stepUpCheck } from '@/lib/server/auth/mfa';
import { markMfaVerified } from '@/lib/server/auth/sessions';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ method: z.enum(['totp', 'recovery']), code: z.string().trim().min(1, 'Enter the code').max(32) });

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (!hasConfirmedFactor(user.id)) return error('You have no second factor to check', 409);
  const answer = await answerSecondFactor(user, clientIp(request), () => stepUpCheck(user, body.data.method, body.data.code), body.data.method);
  if (answer.status === 'limited') return error('Too many failed attempts. Try again later.', 429, { retryAfter: answer.retryAfter });
  if (answer.status === 'wrong') return error('That code didn’t work', 401);
  markMfaVerified(currentPrincipal()?.sessionId);
  return json({ ok: true, ...(answer.left !== undefined && { recoveryCodesLeft: answer.left }) });
});
