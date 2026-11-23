/**
 * POST /request-access/api/sign-in/verify { token } (public): use the link from the email, once. The page posts the token from the link's
 * fragment when the person presses Continue (so a mail scanner that opens the link burns nothing). Starts the requester session (cookie
 * `landflow_requester`, HttpOnly, SameSite=Strict, only under /request-access) and answers `{ requester }`. 400 "expired or already used"; 409
 * `landflow_user` for an address that has a Landflow account; 429 after 20 wrong links from one network address in 15 minutes.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { OutsideAuthError, verifyLink } from '@/lib/server/access/outside/identity';
import { outsidePublic, setRequesterCookie, outsideClientIp } from '@/lib/server/access/outside/http';
import { readCookie } from '@/lib/server/auth/cookies';
import { parseBody } from '@/lib/server/http';
import { REQUESTER_COOKIE } from '@/lib/shared/auth-paths';

export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().min(1).max(200) });

export const POST = outsidePublic(
  async ({ req }) => {
    const body = await parseBody(req, schema, { maxBytes: 2048 });
    if (!body.ok) return body.response;
    let signedIn;
    try {
      signedIn = await verifyLink(body.data.token, { ip: outsideClientIp(req), userAgent: req.headers.get('user-agent') ?? undefined, replacing: readCookie(req, REQUESTER_COOKIE) });
    } catch (error) {
      if (error instanceof OutsideAuthError && error.reason === 'limited') {
        const retryAfter = Number(error.details?.retryAfter) || 60;
        return Response.json({ error: error.message, code: 'rate_limited', retryAfter }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
      }
      throw error;
    }
    const { requester, session } = signedIn;
    const response = NextResponse.json({ requester: { email: requester.email, name: requester.name, verifiedBy: requester.verifiedBy } });
    setRequesterCookie(response, req, session.token, session.expiresAt);
    return response;
  },
  { write: true },
);
