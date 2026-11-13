/**
 * The reset-password page's API (public): GET ?token= names the account a reset link is for (404 when invalid,
 * used or expired); POST { token, password } sets the new password, signs the user out everywhere else and signs
 * this browser in.
 */
import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/shared/auth';
import { clientIp, deleteUserSessions, findToken, formLimit, getUser, markTokenUsed, setPassword, signedInResponse } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

const GONE = 'This reset link is invalid, was used already or has expired. Ask for a new one.';

export const GET = handler(async (request: Request) => {
  const reset = findToken('reset', new URL(request.url).searchParams.get('token') ?? undefined);
  const user = reset?.userId ? getUser(reset.userId) : undefined;
  if (!reset || !user) return error(GONE, 404);
  return json({ email: user.email, name: user.name });
});

const schema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH),
});

export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);
  const limit = formLimit();
  const check = await limit.check(ip);
  if (!check.ok) return error('Too many attempts. Try again later.', 429, { retryAfter: check.retryAfter });
  await limit.hit(ip);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const reset = findToken('reset', body.data.token);
  const existing = reset?.userId ? getUser(reset.userId) : undefined;
  if (!reset || !existing) return error(GONE, 404);
  // Always a reset, even from a browser that is signed in (as this user or another): auth.password_reset, below, is the event.
  const user = await setPassword(existing.id, body.data.password, 'reset');
  markTokenUsed(reset.id);
  deleteUserSessions(user.id);
  recordAudit({ action: 'auth.password_reset', actor: { id: user.id, name: user.name, email: user.email }, target: { type: 'user', id: user.id, name: user.email }, summary: `${user.email} reset their password` });
  return signedInResponse(request, user, 'reset');
});
