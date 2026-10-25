/**
 * /api/auth/saml/logout (public): SAML single logout.
 *
 * - GET without a SAML message: sign this browser out (SP-initiated) and, when the session came from SAML and the IdP
 *   has a logout URL, send it a LogoutRequest; otherwise go to /login.
 * - GET (HTTP-Redirect, signed) or POST with `SAMLResponse`: the IdP answers our LogoutRequest; on to /login.
 * - GET or POST with `SAMLRequest`: the IdP signs the user out (IdP-initiated); every session of theirs ends and the
 *   IdP gets our LogoutResponse.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, safeNext } from '@/lib/shared/auth-paths';
import { clearSessionCookie, deleteSession, publicOrigin, readCookie } from '@/lib/server/auth';
import { handleLogoutMessage, logoutRedirect, SamlError, samlConfig } from '@/lib/server/auth/saml';
import { handler } from '@/lib/server/http';
import { logger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';

async function logout(request: Request, body?: Record<string, string>): Promise<Response> {
  const origin = publicOrigin(request);
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const toLogin = (error?: string) => NextResponse.redirect(`${origin}/login${error ? `?error=${encodeURIComponent(error)}` : ''}`, 303);
  const config = samlConfig();

  if (config && (query.SAMLRequest || query.SAMLResponse || body?.SAMLRequest || body?.SAMLResponse)) {
    try {
      const result = await handleLogoutMessage(config, origin, { query, originalQuery: url.search.slice(1), ...(body && { body }) });
      if (result.kind === 'request') return NextResponse.redirect(result.redirect, 303);
      const next = safeNext(result.relayState);
      return NextResponse.redirect(`${origin}${next === '/' ? '/login' : next}`, 303);
    } catch (caught) {
      if (!(caught instanceof SamlError)) logger.warn('SAML logout message failed', { error: caught });
      return toLogin((caught as Error).message);
    }
  }

  // SP-initiated: end the local session first, then (maybe) tell the IdP.
  const token = readCookie(request, SESSION_COOKIE);
  const idpLogout = await logoutRedirect(token, origin);
  deleteSession(token);
  const response = idpLogout ? NextResponse.redirect(idpLogout, 303) : toLogin();
  clearSessionCookie(response, request);
  return response;
}

export const GET = handler(async (request: Request) => logout(request));

export const POST = handler(async (request: Request) => {
  const body = Object.fromEntries(new URLSearchParams(await request.text().catch(() => '')));
  return logout(request, body);
});
