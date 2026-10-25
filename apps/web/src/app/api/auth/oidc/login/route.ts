/**
 * GET /api/auth/oidc/login?next=/path (public): start single sign-on. Redirects to the provider with PKCE, a state
 * and a nonce; the state is also set in a short-lived cookie so only this browser can finish the sign-in.
 */
import { NextResponse } from 'next/server';
import { safeNext } from '@/lib/shared/auth-paths';
import { publicOrigin, secureRequest } from '@/lib/server/auth/cookies';
import { beginLogin, OIDC_STATE_COOKIE, oidcConfig } from '@/lib/server/auth/oidc';
import { handler } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const origin = publicOrigin(request);
  const config = oidcConfig();
  if (!config) return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('Single sign-on is not configured')}`);
  try {
    const { url, state } = await beginLogin(config, origin, safeNext(new URL(request.url).searchParams.get('next')));
    const response = NextResponse.redirect(url);
    response.cookies.set(OIDC_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: '/api/auth/oidc', maxAge: 600 });
    return response;
  } catch (caught) {
    logger.warn('starting single sign-on failed', { error: caught });
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(`Single sign-on is unavailable: ${(caught as Error).message}`)}`);
  }
});
