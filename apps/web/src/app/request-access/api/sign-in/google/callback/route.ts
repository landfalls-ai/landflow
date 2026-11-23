/**
 * GET /request-access/api/sign-in/google/callback (public): Google sends the browser back here. The state must be the one in this browser's
 * cookie and a pending outside sign-in (Landflow's own SSO state never finishes it, nor the reverse), taken once; the ID token must be verified
 * (signature, issuer, audience, expiry, nonce), `email_verified`, an allowed `hd` equal to the address's domain. Then 303 to /request-access with
 * the requester session cookie, or to /request-access?error=<code> (`expired`, `failed`, `denied`, `not_verified`, `domain`, `blocked`,
 * `landflow_user`, `subject_changed`) with no session.
 */
import { NextResponse } from 'next/server';
import { completeGoogle, OutsideAuthError } from '@/lib/server/access/outside/identity';
import { clearGoogleStateCookie, outsidePublic, setRequesterCookie, outsideClientIp } from '@/lib/server/access/outside/http';
import { readCookie } from '@/lib/server/auth/cookies';
import { REQUESTER_COOKIE, REQUESTER_OIDC_COOKIE } from '@/lib/shared/auth-paths';

export const dynamic = 'force-dynamic';

const back = (to: string) => new NextResponse(null, { status: 303, headers: { location: to } });

export const GET = outsidePublic(async ({ req }) => {
  const query = new URL(req.url).searchParams;
  try {
    const { session } = await completeGoogle(
      { code: query.get('code'), state: query.get('state'), cookieState: readCookie(req, REQUESTER_OIDC_COOKIE), error: query.get('error') },
      { ip: outsideClientIp(req), userAgent: req.headers.get('user-agent') ?? undefined, replacing: readCookie(req, REQUESTER_COOKIE) },
    );
    const response = back('/request-access');
    setRequesterCookie(response, req, session.token, session.expiresAt);
    clearGoogleStateCookie(response, req);
    return response;
  } catch (error) {
    if (!(error instanceof OutsideAuthError)) throw error;
    const response = back(`/request-access?error=${encodeURIComponent(error.reason)}`);
    clearGoogleStateCookie(response, req);
    return response;
  }
});
