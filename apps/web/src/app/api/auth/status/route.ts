/** GET /api/auth/status (public): whether the owner setup is pending, whether SSO is on (its button label) and whether email works. */
import type { AuthStatus } from '@/lib/shared/auth';
import { setupRequired } from '@/lib/server/auth';
import { mailConfigured } from '@/lib/server/auth/mail';
import { localSignInMode, type LocalSignIn } from '@/lib/server/auth/local-sign-in';
import { oidcConfig } from '@/lib/server/auth/oidc';
import { samlConfig } from '@/lib/server/auth/saml';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const oidc = oidcConfig();
  const saml = samlConfig();
  const status: AuthStatus & { localSignIn: LocalSignIn } = { setupRequired: setupRequired(), smtp: mailConfigured(), localSignIn: localSignInMode(), ...(oidc && { oidc: { label: oidc.label } }), ...(saml && { saml: { label: saml.label } }) };
  return json(status);
});
