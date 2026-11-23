/**
 * POST /request-access/api/sign-in/email { email } (public): ask for a one-time sign-in link. The answer is 202 with the same sentence whatever
 * happens: an address of a domain no one allowed, a `+tag`, a blocked person, a limit, a Landflow user's address (who is mailed a pointer to
 * Landflow's Access page), a missing mail server. Only 10 asks from one network address in 15 minutes answer differently (429). The mail
 * goes out after the answer, so the time it takes tells nothing either.
 */
import { z } from 'zod';
import { requestLink, SIGN_IN_ASKED } from '@/lib/server/access/outside/identity';
import { outsidePublic } from '@/lib/server/access/outside/http';
import { clientIp } from '@/lib/server/auth/rate-limit';
import { emailedOrigin } from '@/lib/server/auth/cookies';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().email('Enter a valid email address').max(320) });

export const POST = outsidePublic(
  async ({ req }) => {
    const body = await parseBody(req, schema, { maxBytes: 4096 });
    if (!body.ok) return body.response;
    // In production the link's origin is LANDFLOW_PUBLIC_URL, never a request header; without it nothing is sent (and the answer is the same).
    let origin: string | undefined;
    try {
      origin = emailedOrigin(req);
    } catch {
      origin = undefined;
    }
    const result = await requestLink(body.data.email, { ip: clientIp(req), ...(origin && { origin }) });
    if (result.limited) return Response.json({ error: 'Too many attempts. Try again later.', code: 'rate_limited', retryAfter: result.retryAfter }, { status: 429, headers: { 'Retry-After': String(result.retryAfter) } });
    return json({ ok: true, message: SIGN_IN_ASKED }, 202);
  },
  { write: true },
);
