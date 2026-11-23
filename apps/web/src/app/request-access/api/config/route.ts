/**
 * GET /request-access/api/config (public): what the sign-in page needs before anyone signs in: `{ enabled, google, email }`. Nothing else, ever:
 * no domain, no entry, no name. While an admin has not switched the feature on it says `enabled: false` and the page shows "Asking here is
 * switched off"; every other route of the page answers 404 then.
 */
import { mailConfigured } from '@/lib/server/auth/mail';
import { json } from '@/lib/server/http';
import { outsidePublic } from '@/lib/server/access/outside/http';
import { googleReady, outsideSettings } from '@/lib/server/access/outside/settings';

export const dynamic = 'force-dynamic';

export const GET = outsidePublic(
  async () => {
    const settings = outsideSettings();
    return json({ enabled: settings.enabled, google: settings.enabled && googleReady(settings), email: settings.enabled && mailConfigured() });
  },
  { whenOff: 'allow' },
);
