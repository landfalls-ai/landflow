/**
 * POST /request-access/api/sign-out (public, same-origin JSON): end this browser's requester session and clear its cookie. Answers 200 even when
 * the session had already ended, so a stale tab can always sign out.
 */
import { NextResponse } from 'next/server';
import { recordAudit } from '@/lib/server/audit';
import { clearRequesterCookie, outsidePublic } from '@/lib/server/access/outside/http';
import { endSession } from '@/lib/server/access/outside/sessions';
import { requesterRow } from '@/lib/server/access/outside/store';
import { readCookie } from '@/lib/server/auth/cookies';
import { REQUESTER_COOKIE } from '@/lib/shared/auth-paths';

export const dynamic = 'force-dynamic';

export const POST = outsidePublic(
  async ({ req }) => {
    const ended = endSession(readCookie(req, REQUESTER_COOKIE));
    const who = ended && requesterRow(ended.requester_id);
    if (who) {
      recordAudit({ action: 'access.outside.sign_out', actor: { id: who.id, name: who.name ?? who.email, email: who.email }, target: { type: 'access_outside', id: who.id, name: who.email }, project: null, summary: `${who.email} signed out` });
    }
    const response = NextResponse.json({ ok: true });
    clearRequesterCookie(response, req);
    return response;
  },
  { write: true },
);
