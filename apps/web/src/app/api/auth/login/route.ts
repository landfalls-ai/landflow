/**
 * POST /api/auth/login { email, password } (public): sign in with a password; sets the session cookie. Failed
 * attempts are limited per email and per IP (429 with `retryAfter` seconds); a wrong email takes as long as a wrong
 * password.
 */
import { z } from 'zod';
import { clientIp, findUserByEmail, loginLimits, normalizeEmail, signedInResponse, verifyPassword } from '@/lib/server/auth';
import { dummyHash } from '@/lib/server/auth/passwords';
import { localSignInAllowed, localSignInMode } from '@/lib/server/auth/local-sign-in';
import { DEACTIVATED_MESSAGE } from '@/lib/server/auth/sessions';
import { error, handler, parseBody } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().min(1, 'Enter your email').max(320), password: z.string().min(1, 'Enter your password').max(1024) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const email = normalizeEmail(body.data.email);
  const ip = clientIp(request);
  const limits = loginLimits();
  const blocked = (await Promise.all([limits.email.check(email), limits.ip.check(ip)])).find((result) => !result.ok);
  if (blocked) {
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'denied', actor: 'anonymous', target: { type: 'user', name: email }, summary: `Sign-in for ${email} refused: too many failed attempts`, details: { email, reason: 'rate-limited' } });
    return error('Too many failed sign-ins. Try again later.', 429, { retryAfter: blocked.retryAfter });
  }
  const user = findUserByEmail(email);
  const ok = await verifyPassword(body.data.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || !user.passwordHash || !ok) {
    await Promise.all([limits.email.hit(email), limits.ip.hit(ip)]);
    const reason = user ? (user.passwordHash ? 'password' : 'no-password') : 'unknown-email';
    logger.info('sign-in failed', { 'landflow.auth.reason': reason });
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', actor: 'anonymous', target: { type: 'user', ...(user && { id: user.id }), name: email }, summary: `Failed sign-in for ${email}`, details: { email, reason, method: 'password' } });
    return error('Wrong email or password', 401);
  }
  await limits.email.reset(email);
  // Deactivated (SCIM): the right password still doesn't sign them in.
  if (user.disabledAt) {
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'denied', actor: 'anonymous', target: { type: 'user', id: user.id, name: email }, summary: `Sign-in for ${email} refused: deactivated`, details: { email, reason: 'deactivated', method: 'password' } });
    return error(DEACTIVATED_MESSAGE, 403);
  }
  // LANDFLOW_LOCAL_SIGN_IN: checked after the password so a refusal does not tell a stranger which emails exist.
  const mode = localSignInMode();
  if (!localSignInAllowed(user)) {
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'denied', actor: 'anonymous', target: { type: 'user', id: user.id, name: email }, summary: `Password sign-in for ${email} refused: local sign-in is ${mode}`, details: { email, reason: 'local-sign-in-disabled', method: 'password' } });
    return error('Password sign-in is turned off on this instance. Use single sign-on.', 403);
  }
  logger.info('signed in', { 'landflow.user.id': user.id, 'landflow.auth.method': 'password' });
  return signedInResponse(request, user, 'password');
});
