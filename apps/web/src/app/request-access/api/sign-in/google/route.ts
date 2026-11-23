/**
 * GET /request-access/api/sign-in/google (public): start Google sign-in: 302 to Google (code flow with PKCE S256, state, nonce; `hd` as a hint
 * when one domain is allowed) with the state in a SameSite=Lax cookie that only this path and the callback see. 404 while Google sign-in is off
 * or its credential is gone.
 */
import { NextResponse } from 'next/server';
import { beginGoogle, OutsideAuthError } from '@/lib/server/access/outside/identity';
import { outsidePublic, setGoogleStateCookie, outsideClientIp } from '@/lib/server/access/outside/http';
import { publicOrigin } from '@/lib/server/auth/cookies';

export const dynamic = 'force-dynamic';

export const GET = outsidePublic(async ({ req }) => {
  try {
    const { url, state } = await beginGoogle(publicOrigin(req), { ip: outsideClientIp(req) });
    const response = new NextResponse(null, { status: 302, headers: { location: url } });
    setGoogleStateCookie(response, req, state);
    return response;
  } catch (error) {
    // A person who pressed a button gets the page back, not a JSON error.
    if (error instanceof OutsideAuthError && error.reason === 'limited') return new NextResponse(null, { status: 303, headers: { location: '/request-access?error=limited' } });
    throw error;
  }
});
