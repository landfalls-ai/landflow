/**
 * POST /api/auth/mfa/verify { challenge, method: 'totp' | 'recovery', code } or { challenge, method: 'webauthn', response } (public, gated by the challenge; a passkey's options come from POST /api/auth/mfa/options): the second
 * step of a sign-in. The challenge came from a correct password (POST /api/auth/login or a password reset); it is
 * single use, five minutes, bound to its user, and five answers (each claimed before it is checked) end it. Failures count against the same
 * per-email and per-IP limits as passwords (429 with `retryAfter`) and are audited as `auth.sign_in_failed` with reason
 * `mfa`. A right answer starts the session (`password+totp`, `password+recovery` or `password+webauthn`); a recovery code also answers how
 * many are left and emails the person when mail is set up.
 */
import { z } from 'zod';
import { clientIp, getUser, loginLimits, signedInResponse } from '@/lib/server/auth';
import { emailedOrigin } from '@/lib/server/auth/cookies';
import { localSignInAllowed } from '@/lib/server/auth/local-sign-in';
import { mailConfigured, recoveryUsedMessage, sendMail } from '@/lib/server/auth/mail';
import { claimAttempt, MAX_WRONG, peekChallenge, useChallenge } from '@/lib/server/auth/mfa/challenges';
import { verifyTotp } from '@/lib/server/auth/mfa/factors';
import { assertionSchema, verifyPasskey } from '@/lib/server/auth/mfa/webauthn';
import { useRecoveryCode } from '@/lib/server/auth/mfa/recovery';
import { recordAudit } from '@/lib/server/audit';
import { error, handler, parseBody } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

const challengeField = z.string().min(1).max(100);
const schema = z.discriminatedUnion('method', [
  z.object({ challenge: challengeField, method: z.enum(['totp', 'recovery']), code: z.string().trim().min(1, 'Enter the code').max(32) }),
  z.object({ challenge: challengeField, method: z.literal('webauthn'), response: assertionSchema }),
]);
const EXPIRED = 'This sign-in has expired. Sign in again.';

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const { challenge, method } = body.data;
  const ip = clientIp(request);
  const limits = loginLimits();
  const challenged = peekChallenge(challenge);
  const user = challenged?.purpose === 'sign-in' ? getUser(challenged.userId) : undefined;
  const blocked = (await Promise.all([limits.ip.check(ip), ...(user ? [limits.email.check(user.email)] : [])])).find((result) => !result.ok);
  if (blocked) {
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'denied', actor: 'anonymous', target: { type: 'user', ...(user && { id: user.id }) }, summary: 'Second-factor sign-in refused: too many failed attempts', details: { reason: 'rate-limited', method } });
    return error('Too many failed sign-ins. Try again later.', 429, { retryAfter: blocked.retryAfter });
  }
  if (!challenged || !user || user.disabledAt || !localSignInAllowed(user)) return error(EXPIRED, 401);

  // Claim one of the challenge's five answers before looking at the code, so answers in flight at once (several mains) can't exceed five.
  const attempt = await claimAttempt(challenge);
  if (attempt === undefined) return error('Too many wrong codes. Sign in again.', 401);
  const recovered = body.data.method === 'recovery' ? await useRecoveryCode(user.id, body.data.code) : undefined;
  const ok = body.data.method === 'webauthn' ? await verifyPasskey(user.id, challenge, body.data.response) : body.data.method === 'totp' ? await verifyTotp(user.id, body.data.code) : recovered?.ok === true;
  if (!ok) {
    await Promise.all([limits.email.hit(user.email), limits.ip.hit(ip)]);
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', actor: 'anonymous', target: { type: 'user', id: user.id }, summary: 'Failed second-factor sign-in', details: { reason: 'mfa', method } });
    logger.info('second factor failed', { 'landflow.auth.reason': 'mfa' });
    if (attempt >= MAX_WRONG) return error('Too many wrong codes. Sign in again.', 401);
    if (method === 'webauthn') return error('That passkey didn’t work. Try again, or use another way to sign in.', 401);
    return error(method === 'totp' ? 'That code didn’t work. Check the code in your app (and that your device’s clock is right), or use a recovery code.' : 'That recovery code didn’t work. Each one works once.', 401);
  }
  // The code was right; the challenge is spent here, so one challenge makes one session.
  const spent = await useChallenge(challenge);
  if (!spent) return error(EXPIRED, 401);
  await limits.email.reset(user.email);
  logger.info('signed in', { 'landflow.user.id': user.id, 'landflow.auth.method': `password+${method}` });
  const left = recovered?.ok ? recovered.left : undefined;
  if (left !== undefined) {
    recordAudit({ action: 'auth.mfa_recovery_used', actor: { id: user.id, name: user.name, email: user.email }, target: { type: 'user', id: user.id }, summary: 'Used a recovery code to sign in', details: { left } });
    if (mailConfigured()) {
      try {
        await sendMail(recoveryUsedMessage({ to: user.email, left, link: `${emailedOrigin(request)}/account/security` }));
      } catch (caught) {
        logger.warn('sending the recovery code email failed', { error: (caught as Error).message });
      }
    }
  }
  return signedInResponse(request, user, method === 'webauthn' ? 'password+webauthn' : method === 'totp' ? 'password+totp' : 'password+recovery', { ...(left !== undefined && { recoveryCodesLeft: left }) }, 200, {
    mfaVerifiedAt: new Date().toISOString(),
    ...(spent.firstMethod === 'reset' && { via: 'reset' }),
  });
});
