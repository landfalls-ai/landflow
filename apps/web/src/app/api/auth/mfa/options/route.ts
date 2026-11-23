/**
 * POST /api/auth/mfa/options { challenge } (public, gated by the sign-in challenge): the options a browser needs for
 * `navigator.credentials.get()` to answer the second step with a passkey. Asking again replaces the earlier options; the
 * answer goes to POST /api/auth/mfa/verify with `method: 'webauthn'`. 401 when the challenge has expired or was used;
 * 409 when the account has no usable passkey. Counts nothing against the limits (the answer does).
 */
import { z } from 'zod';
import { clientIp, getUser, loginLimits } from '@/lib/server/auth';
import { localSignInAllowed } from '@/lib/server/auth/local-sign-in';
import { authenticationOptions } from '@/lib/server/auth/mfa';
import { peekChallenge } from '@/lib/server/auth/mfa/challenges';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ challenge: z.string().min(1).max(100) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const blocked = await loginLimits().ip.check(clientIp(request));
  if (!blocked.ok) return error('Too many failed sign-ins. Try again later.', 429, { retryAfter: blocked.retryAfter });
  const challenged = peekChallenge(body.data.challenge);
  const user = challenged?.purpose === 'sign-in' ? getUser(challenged.userId) : undefined;
  if (!challenged || !user || user.disabledAt || !localSignInAllowed(user)) return error('This sign-in has expired. Sign in again.', 401);
  const options = await authenticationOptions(user.id, body.data.challenge);
  return json({ options }, { headers: { 'cache-control': 'no-store' } });
});
