/** GET /api/auth/status (public): whether the owner setup is pending, whether SSO is on (its button label) and whether email works. */
import type { AuthStatus } from '@/lib/shared/auth';
import { setupRequired } from '@/lib/server/auth';
import { mailConfigured } from '@/lib/server/auth/mail';
import { oidcConfig } from '@/lib/server/auth/oidc';
import { samlConfig } from '@/lib/server/auth/saml';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const oidc = oidcConfig();
  const saml = samlConfig();
  const status: AuthStatus = { setupRequired: setupRequired(), smtp: mailConfigured(), ...(oidc && { oidc: { label: oidc.label } }), ...(saml && { saml: { label: saml.label } }) };
  return json(status);
});
