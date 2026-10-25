/**
 * POST /api/auth/password/forgot { email } (public): email a password reset link. The answer is the same whether
 * or not the email has an account. Without SMTP it says so: an admin can make a reset link in Settings → Users.
 */
import { z } from 'zod';
import { clientIp, createResetToken, deliverLink, findUserByEmail, formLimit } from '@/lib/server/auth';
import { mailConfigured } from '@/lib/server/auth/mail';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().email('Enter a valid email address').max(320) });

export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);
  const limit = formLimit();
  const check = limit.check(ip);
  if (!check.ok) return error('Too many attempts. Try again later.', 429, { retryAfter: check.retryAfter });
  limit.hit(ip);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (!mailConfigured()) return error('This Landflow can’t send email. Ask an admin for a password reset link (Settings → Users).', 503);
  const user = findUserByEmail(body.data.email);
  if (user) {
    const { token } = createResetToken(user);
    const sent = await deliverLink('reset', { to: user.email, token, request });
    if (!sent.emailed) logger.warn('the password reset email was not sent', { 'landflow.user.id': user.id, error: sent.emailError });
    recordAudit({ action: 'auth.password_reset_request', actor: 'anonymous', target: { type: 'user', id: user.id, name: user.email }, summary: `Password reset link asked for ${user.email}`, details: { emailed: sent.emailed } });
  }
  return json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
});
