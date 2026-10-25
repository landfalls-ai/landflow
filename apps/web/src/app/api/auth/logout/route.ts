/**
 * POST /api/auth/logout: sign out (the session is deleted and the cookie cleared). A session that came from SAML
 * sign-in, with an IdP that has single logout, also answers `redirect`: the IdP's logout URL to go to next.
 */
import { SESSION_COOKIE } from '@/lib/shared/auth-paths';
import { clearSessionCookie, deleteSession, publicOrigin, readCookie } from '@/lib/server/auth';
import { logoutRedirect } from '@/lib/server/auth/saml';
import { sessionUser } from '@/lib/server/auth/sessions';
import { recordAudit } from '@/lib/server/audit';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const token = readCookie(request, SESSION_COOKIE);
  const redirect = await logoutRedirect(token, publicOrigin(request));
  const signedIn = sessionUser(token)?.user;
  deleteSession(token);
  if (signedIn) recordAudit({ action: 'auth.sign_out', actor: { id: signedIn.id, name: signedIn.name, email: signedIn.email }, target: { type: 'user', id: signedIn.id, name: signedIn.email }, summary: `${signedIn.email} signed out` });
  const response = json({ ok: true, ...(redirect && { redirect }) });
  clearSessionCookie(response, request);
  return response;
});
