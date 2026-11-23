/**
 * POST /api/me/mfa/passkeys/options { purpose: 'register', password } or { purpose: 'step-up' } (a signed-in person,
 * session only; open to a session that may only enrol): the options for `navigator.credentials.create()` (adding a
 * passkey; needs the account's current password, 403 when wrong, wrong tries count against the sign-in limits; 409 at
 * ten passkeys) or `.get()` (a fresh second-factor check with a passkey). Answers `{ challenge, options }`: the
 * challenge token (single use, five minutes, this person and this purpose only) goes back with the browser's answer to
 * POST /api/me/mfa/passkeys or POST /api/me/mfa/step-up.
 */
import { z } from 'zod';
import { clientIp, requireUser } from '@/lib/server/auth';
import { checkEnrolPassword, registrationOptions, stepUpOptions } from '@/lib/server/auth/mfa';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('purpose', [z.object({ purpose: z.literal('register'), password: z.string().max(1024).optional() }), z.object({ purpose: z.literal('step-up') })]);

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const headers = { 'cache-control': 'no-store' };
  if (body.data.purpose === 'step-up') return json(await stepUpOptions(user), { headers });
  if (user.passwordHash && !body.data.password) return error('Enter your password', 400);
  const checked = await checkEnrolPassword(user, body.data.password, clientIp(request));
  if (!checked.ok) return error(checked.message, checked.status, checked.retryAfter !== undefined ? { retryAfter: checked.retryAfter } : undefined);
  return json(await registrationOptions(user), { headers });
});
