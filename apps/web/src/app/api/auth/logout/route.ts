/** POST /api/auth/logout: sign out (the session is deleted and the cookie cleared). */
import { SESSION_COOKIE } from '@/lib/shared/auth-paths';
import { clearSessionCookie, deleteSession, readCookie } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  deleteSession(readCookie(request, SESSION_COOKIE));
  const response = json({ ok: true });
  clearSessionCookie(response, request);
  return response;
});
