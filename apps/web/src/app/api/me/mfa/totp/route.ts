/**
 * POST /api/me/mfa/totp { password } (a signed-in person, session only): start adding an authenticator app. Needs the
 * account's current password, so a stolen session can't enrol the thief's own app (403 when wrong; wrong tries count
 * against the sign-in limits). Answers the secret (as text), the otpauth URL and a QR code (an SVG data URL), once; the
 * factor counts only after POST /api/me/mfa/totp/<id>/confirm with a current code. An earlier unconfirmed try is dropped.
 */
import { z } from 'zod';
import { clientIp, requireUser } from '@/lib/server/auth';
import { checkEnrolPassword, qrSvgDataUrl, startTotp } from '@/lib/server/auth/mfa';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ password: z.string().min(1, 'Enter your password').max(1024) });

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const checked = await checkEnrolPassword(user, body.data.password, clientIp(request));
  if (!checked.ok) return error(checked.message, checked.status, checked.retryAfter !== undefined ? { retryAfter: checked.retryAfter } : undefined);
  const started = startTotp(user);
  return json({ ...started, qr: await qrSvgDataUrl(started.otpauthUrl) }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
