import { callbackPage, completeAuthorization } from '@/lib/server/credentials/oauth2-flow';
import { handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/**
 * GET: where OAuth2 providers send the browser after consent. Public (on the sign-in guard's allow-list): it trusts
 * only its signed state, plus the cookie the authorize route set in the same browser, then exchanges the code.
 */
export const GET = handler(async (request: Request) => callbackPage(await completeAuthorization(request)));
