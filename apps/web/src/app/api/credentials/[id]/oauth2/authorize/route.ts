import { OAUTH2_MESSAGE_CHANNEL } from '@/lib/shared/oauth2';
import { callbackPage, startAuthorization } from '@/lib/server/credentials/oauth2-flow';
import { handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET: the credential dialog opens this in a popup. Redirects to the provider's consent page with a signed state,
 * PKCE, and the cookie the callback checks (client fields that read `$secrets` resolved first); a credential that
 * can't connect gets the callback page with the reason.
 */
export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  try {
    const { url, cookie } = await startAuthorization(id, request);
    return new Response(null, { status: 302, headers: { location: url, 'set-cookie': cookie, 'cache-control': 'no-store' } });
  } catch (error) {
    return callbackPage({ message: { source: OAUTH2_MESSAGE_CHANNEL, credentialId: id, ok: false, message: (error as Error).message } });
  }
});
