/**
 * The current-password check that adding a second factor asks of an account that has a password, so a session left open
 * can't be used to enrol the thief's own authenticator or passkey. A wrong password counts against the sign-in limits
 * (per email and per address) and is audited as a failed `mfa-enrol` password check. Shared by the TOTP and passkey routes.
 */
import { recordAudit } from '../../audit';
import { verifyPassword } from '../passwords';
import { loginLimits } from '../rate-limit';
import type { UserRecord } from '../users';

export type EnrolPassword = { ok: true } | { ok: false; status: 403 | 429; message: string; retryAfter?: number };

export async function checkEnrolPassword(user: UserRecord, password: string | undefined, ip: string): Promise<EnrolPassword> {
  if (!user.passwordHash) return { ok: true };
  const limits = loginLimits();
  const blocked = (await Promise.all([limits.email.check(user.email), limits.ip.check(ip)])).find((result) => !result.ok);
  if (blocked) return { ok: false, status: 429, message: 'Too many failed attempts. Try again later.', retryAfter: blocked.retryAfter };
  if (!password || !(await verifyPassword(password, user.passwordHash))) {
    await Promise.all([limits.email.hit(user.email), limits.ip.hit(ip)]);
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', target: { type: 'user', id: user.id }, summary: 'Wrong password when adding a second factor', details: { reason: 'password', method: 'mfa-enrol' } });
    // 403, not 401: the person is signed in, and a 401 sends the page to the sign-in form.
    return { ok: false, status: 403, message: 'That password is not right' };
  }
  return { ok: true };
}
