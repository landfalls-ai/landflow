/**
 * POST /api/auth/saml/acs (public): the assertion consumer service. The IdP's browser form posts `SAMLResponse` and
 * `RelayState` here; the response is validated (signature, audience, timestamps, InResponseTo, replay), the user
 * found or created (role and projects from attributes) and signed in, then sent on with a 303 to the page they asked
 * for. Failures go back to /login with the reason.
 */
import { NextResponse } from 'next/server';
import { clientIp, createSession, setSessionCookie } from '@/lib/server/auth';
import { publicOrigin, readCookie, secureRequest } from '@/lib/server/auth/cookies';
import { completeLogin, rememberSession, SAML_STATE_COOKIE, SamlError, samlConfig } from '@/lib/server/auth/saml';
import { UserError } from '@/lib/server/auth/users';
import { handler } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const origin = publicOrigin(request);
  const secure = secureRequest(request);
  const clearState = (response: NextResponse) => {
    response.cookies.set(SAML_STATE_COOKIE, '', { httpOnly: true, sameSite: secure ? 'none' : 'lax', secure, path: '/api/auth/saml', maxAge: 0 });
    return response;
  };
  const fail = (message: string) => clearState(NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`, 303));
  const config = samlConfig();
  if (!config) return fail('SAML sign-in is not configured');
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return fail('The identity provider sent an unreadable form');
  }
  try {
    const { user, next, identity } = await completeLogin(config, origin, {
      samlResponse: form.get('SAMLResponse'),
      relayState: form.get('RelayState'),
      cookieState: readCookie(request, SAML_STATE_COOKIE),
    });
    const { token, expiresAt } = createSession(user, 'saml', { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined });
    rememberSession(token, user, identity);
    logger.info('signed in', { 'landflow.user.id': user.id, 'landflow.auth.method': 'saml' });
    const response = NextResponse.redirect(`${origin}${next}`, 303);
    setSessionCookie(response, request, token, expiresAt);
    return clearState(response);
  } catch (caught) {
    if (caught instanceof SamlError || caught instanceof UserError) {
      logger.info('SAML sign-in refused', { 'landflow.auth.reason': caught.message });
      return fail(caught.message);
    }
    logger.warn('SAML sign-in failed', { error: caught });
    return fail(`SAML sign-in failed: ${(caught as Error).message}`);
  }
});
