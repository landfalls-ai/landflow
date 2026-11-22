/**
 * POST /api/me/mfa/totp (a signed-in person, session only): start adding an authenticator app. Answers the secret (as
 * text), the otpauth URL and a QR code (an SVG data URL), once; the factor counts only after
 * POST /api/me/mfa/totp/<id>/confirm with a current code. An earlier unconfirmed try is dropped.
 */
import { requireUser } from '@/lib/server/auth';
import { qrSvgDataUrl, startTotp } from '@/lib/server/auth/mfa';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  const user = await requireUser();
  const started = startTotp(user);
  return json({ ...started, qr: await qrSvgDataUrl(started.otpauthUrl) }, { status: 201, headers: { 'cache-control': 'no-store' } });
});
