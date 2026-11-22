/**
 * POST /api/me/mfa/totp { password } (a signed-in person, session only): start adding an authenticator app. Needs the
 * account's current password, so a stolen session can't enrol the thief's own app (403 when wrong; wrong tries count
 * against the sign-in limits). Answers the secret (as text), the otpauth URL and a QR code (an SVG data URL), once; the
 * factor counts only after POST /api/me/mfa/totp/<id>/confirm with a current code. An earlier unconfirmed try is dropped.
 */
import { z } from 'zod';
import { clientIp, loginLimits, requireUser, verifyPassword } from '@/lib/server/auth';
import { qrSvgDataUrl, startTotp } from '@/lib/server/auth/mfa';
import { recordAudit } from '@/lib/server/audit';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ password: z.string().min(1, 'Enter your password').max(1024) });

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (user.passwordHash) {
    const ip = clientIp(request);
    const limits = loginLimits();
    const blocked = (await Promise.all([limits.email.check(user.email), limits.ip.check(ip)])).find((result) => !result.ok);
    if (blocked) return error('Too many failed attempts. Try again later.', 429, { retryAfter: blocked.retryAfter });
    if (!(await verifyPassword(body.data.password, user.passwordHash))) {
      await Promise.all([limits.email.hit(user.email), limits.ip.hit(ip)]);
      recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', target: { type: 'user', id: user.id }, summary: 'Wrong password when adding a second factor', details: { reason: 'password', method: 'mfa-enrol' } });
      // 403, not 401: the person is signed in, and a 401 sends the page to the sign-in form.
      return error('That password is not right', 403);
    }
  }
  const started = startTotp(user);
  return json({ ...started, qr: await qrSvgDataUrl(started.otpauthUrl) }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
