/**
 * GET /api/auth/oidc/callback (public): the provider sends the browser back here with a code. The code is
 * exchanged, the ID token verified, the user found or created (role from the claim) and signed in; then on to the
 * page they asked for. Failures go back to /login with the reason.
 */
import { NextResponse } from 'next/server';
import { clientIp, createSession, setSessionCookie } from '@/lib/server/auth';
import { publicOrigin, readCookie, secureRequest } from '@/lib/server/auth/cookies';
import { completeLogin, OIDC_STATE_COOKIE, OidcError, oidcConfig } from '@/lib/server/auth/oidc';
import { UserError } from '@/lib/server/auth/users';
import { recordAudit } from '@/lib/server/audit';
import { handler } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const origin = publicOrigin(request);
  const url = new URL(request.url);
  // A refused sign-in is an audit event too (the reason is a category: no provider text, no claims).
  const fail = (message: string, reason: string) => {
    recordAudit({ action: 'auth.sign_in_failed', outcome: 'failure', actor: 'anonymous', summary: `Failed single sign-on (${reason})`, details: { method: 'oidc', reason } });
    const response = NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);
    response.cookies.set(OIDC_STATE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: '/api/auth/oidc', maxAge: 0 });
    return response;
  };
  const config = oidcConfig();
  if (!config) return fail('Single sign-on is not configured', 'not_configured');
  const providerError = url.searchParams.get('error');
  if (providerError) return fail(`The identity provider refused the sign-in: ${url.searchParams.get('error_description') ?? providerError}`, 'provider_error');
  try {
    const { user, next } = await completeLogin(config, {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      cookieState: readCookie(request, OIDC_STATE_COOKIE),
    });
    const { token, expiresAt } = createSession(user, 'oidc', { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined });
    logger.info('signed in', { 'landflow.user.id': user.id, 'landflow.auth.method': 'oidc' });
    const response = NextResponse.redirect(`${origin}${next}`);
    setSessionCookie(response, request, token, expiresAt);
    response.cookies.set(OIDC_STATE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: secureRequest(request), path: '/api/auth/oidc', maxAge: 0 });
    return response;
  } catch (caught) {
    if (caught instanceof OidcError || caught instanceof UserError) return fail(caught.message, 'refused');
    logger.warn('single sign-on failed', { error: caught });
    return fail(`Single sign-on failed: ${(caught as Error).message}`, 'error');
  }
});
