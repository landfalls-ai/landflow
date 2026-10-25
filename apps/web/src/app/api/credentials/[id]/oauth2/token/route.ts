import { CredentialError, credentials } from '@/lib/server/credentials/vault';
import { requestTokenNow } from '@/lib/server/credentials/oauth2-flow';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST: get a token now (client credentials grant) or renew the stored one with its refresh token. */
export const POST = handler(async (_request: Request, { params }: Ctx) => {
  try {
    return json({ credential: await requestTokenNow((await params).id) });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});

/** DELETE: disconnect — forget the stored token (the client settings stay). */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  try {
    return json({ credential: credentials.disconnectOAuth2((await params).id) });
  } catch (caught) {
    if (caught instanceof CredentialError) return error(caught.message, caught.status);
    throw caught;
  }
});
