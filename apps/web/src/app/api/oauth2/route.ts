import { OAUTH2_PRESETS } from '@/lib/shared/oauth2';
import { oauth2RedirectUrl } from '@/lib/server/credentials/oauth2-flow';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** GET: the redirect URL to register with OAuth2 providers, and the presets the credential dialog offers. */
export const GET = handler(async (request: Request) => json({ redirectUrl: oauth2RedirectUrl(request), presets: OAUTH2_PRESETS }));
