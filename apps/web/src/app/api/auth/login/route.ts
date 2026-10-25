/**
 * POST /api/auth/login { email, password } (public): sign in with a password; sets the session cookie. Failed
 * attempts are limited per email and per IP (429 with `retryAfter` seconds); a wrong email takes as long as a wrong
 * password.
 */
import { z } from 'zod';
import { clientIp, findUserByEmail, loginLimits, normalizeEmail, signedInResponse, verifyPassword } from '@/lib/server/auth';
import { dummyHash } from '@/lib/server/auth/passwords';
import { error, handler, parseBody } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().min(1, 'Enter your email').max(320), password: z.string().min(1, 'Enter your password').max(1024) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const email = normalizeEmail(body.data.email);
  const ip = clientIp(request);
  const limits = loginLimits();
  const blocked = [limits.email.check(email), limits.ip.check(ip)].find((result) => !result.ok);
  if (blocked) {
    return error('Too many failed sign-ins. Try again later.', 429, { retryAfter: blocked.retryAfter });
  }
  const user = findUserByEmail(email);
  const ok = await verifyPassword(body.data.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || !user.passwordHash || !ok) {
    limits.email.hit(email);
    limits.ip.hit(ip);
    logger.info('sign-in failed', { 'landflow.auth.reason': user ? (user.passwordHash ? 'password' : 'no-password') : 'unknown-email' });
    return error('Wrong email or password', 401);
  }
  limits.email.reset(email);
  logger.info('signed in', { 'landflow.user.id': user.id, 'landflow.auth.method': 'password' });
  return signedInResponse(request, user, 'password');
});
