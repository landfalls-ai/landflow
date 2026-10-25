/**
 * GET /api/auth/saml/login?next=/path (public): start SAML sign-in. Redirects to the IdP with a deflated AuthnRequest
 * (HTTP-Redirect binding) and a RelayState that is also set in a short-lived cookie, so only this browser can finish
 * the sign-in at the ACS. The cookie is SameSite=None on https: the IdP posts the response from its own site.
 */
import { NextResponse } from 'next/server';
import { safeNext } from '@/lib/shared/auth-paths';
import { publicOrigin, secureRequest } from '@/lib/server/auth/cookies';
import { beginLogin, SAML_STATE_COOKIE, samlConfig } from '@/lib/server/auth/saml';
import { handler } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const origin = publicOrigin(request);
  const config = samlConfig();
  if (!config) return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('SAML sign-in is not configured')}`);
  try {
    const { url, state } = await beginLogin(config, origin, safeNext(new URL(request.url).searchParams.get('next')));
    const response = NextResponse.redirect(url);
    const secure = secureRequest(request);
    response.cookies.set(SAML_STATE_COOKIE, state, { httpOnly: true, sameSite: secure ? 'none' : 'lax', secure, path: '/api/auth/saml', maxAge: 600 });
    return response;
  } catch (caught) {
    logger.warn('starting SAML sign-in failed', { error: caught });
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(`SAML sign-in is unavailable: ${(caught as Error).message}`)}`);
  }
});
