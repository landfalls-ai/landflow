/**
 * Sign-in and access control (Wave 2a): users and roles (./users), scrypt passwords, sessions, API keys, invites
 * and password resets (./tokens) by email (./mail), OIDC single sign-on (./oidc), the guard every API route goes
 * through (./guard, ./policy) and edit locks (./edit-locks). The role checks themselves live in
 * lib/shared/auth.ts (`can`), the public allow-list in lib/shared/auth-paths.ts.
 */
import { NextResponse } from 'next/server';
import type { LinkResponse } from '../../shared/auth';
import { logger } from '../telemetry';
import { emailedOrigin, setSessionCookie } from './cookies';
import { inviteMessage, mailConfigured, resetMessage, sendMail } from './mail';
import { clientIp } from './rate-limit';
import { createSession, type SessionMethod } from './sessions';
import { viewerOf, type UserRecord } from './users';

export { createApiKey, deleteApiKey, getApiKey, listApiKeys, verifyApiKey, apiKeyView } from './api-keys';
export { currentActorId, requestAuth, withAuth, type Principal } from './context';
export { clearSessionCookie, publicOrigin, readCookie, setSessionCookie } from './cookies';
export { AuthError, currentPrincipal, guardRequest, requireUser, resolvePrincipal } from './guard';
export { disableTestAuth, enableTestAuth, TEST_OWNER } from './test-bypass';
export { createSession, deleteSession, deleteUserSessions, sessionTtlHours, sessionUser } from './sessions';
export { clientIp, formLimit, loginLimits } from './rate-limit';
export { hashPassword, verifyPassword } from './passwords';
export * from './users';
export * from './tokens';

/** Send an invite or reset link by email when SMTP is configured; the link always comes back so the UI can show it. */
export async function deliverLink(
  kind: 'invite' | 'reset',
  input: { to: string; token: string; request?: Request; invitedBy?: string; role?: string },
): Promise<LinkResponse> {
  const link = `${emailedOrigin(input.request)}/${kind === 'invite' ? 'invite' : 'reset-password'}/${input.token}`;
  if (!mailConfigured()) return { link, emailed: false };
  try {
    await sendMail(kind === 'invite' ? inviteMessage({ to: input.to, link, invitedBy: input.invitedBy, role: input.role ?? 'member' }) : resetMessage({ to: input.to, link }));
    return { link, emailed: true };
  } catch (error) {
    logger.warn(`sending the ${kind} email failed`, { error });
    return { link, emailed: false, emailError: (error as Error).message };
  }
}

/** Start a session for `user` and answer `{ user, ...extra }` with the session cookie set. */
export function signedInResponse(request: Request, user: UserRecord, method: SessionMethod, extra: Record<string, unknown> = {}, status = 200): NextResponse {
  const { token, expiresAt } = createSession(user, method, { ip: clientIp(request), userAgent: request.headers.get('user-agent') ?? undefined });
  const response = NextResponse.json({ user: viewerOf(user), ...extra }, { status });
  setSessionCookie(response, request, token, expiresAt);
  return response;
}
