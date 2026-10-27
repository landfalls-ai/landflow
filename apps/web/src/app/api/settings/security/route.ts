/**
 * GET /api/settings/security (owners and admins): how sign-in is configured, for Settings → Security. Single
 * sign-on (with a live discovery check), email, session length, the plugin registry secret and metrics access.
 * Read-only: these come from the environment (docs/features/authentication.md), except SAML assertion encryption's key
 * (./saml/encryption).
 */
import type { SecurityView } from '@/lib/shared/auth';
import { publicOrigin } from '@/lib/server/auth/cookies';
import { metricsPublic } from '@/lib/server/auth/guard';
import { smtpConfig } from '@/lib/server/auth/mail';
import { discover, oidcConfig, redirectUri } from '@/lib/server/auth/oidc';
import { samlSecurityView } from '@/lib/server/auth/saml';
import { requireUser, sessionTtlHours } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { scimSecurityView } from '@/lib/server/scim/settings';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  await requireUser('settings:manage');
  const oidc = oidcConfig();
  let reachable: boolean | undefined;
  let oidcError: string | undefined;
  if (oidc) {
    try {
      await discover(oidc, true);
      reachable = true;
    } catch (caught) {
      reachable = false;
      oidcError = (caught as Error).message;
    }
  }
  const smtp = smtpConfig();
  const view: SecurityView = {
    oidc: {
      configured: Boolean(oidc),
      label: oidc?.label ?? 'Sign in with SSO',
      roleClaim: oidc?.roleClaim ?? process.env.LANDFLOW_OIDC_ROLE_CLAIM ?? 'roles',
      roleMap: oidc?.roleMap ?? {},
      defaultRole: oidc?.defaultRole ?? 'member',
      ...(oidc && { issuer: oidc.issuer, clientId: oidc.clientId, redirectUrl: redirectUri(oidc, publicOrigin(request)), reachable }),
      ...(oidcError && { error: oidcError }),
    },
    smtp: { configured: Boolean(smtp), ...(smtp && { host: smtp.host, port: smtp.port, from: smtp.from }) },
    saml: await samlSecurityView(publicOrigin(request)),
    sessionHours: sessionTtlHours(),
    registrySecret: Boolean(process.env.LANDFLOW_REGISTRY_SECRET),
    metricsPublic: metricsPublic(),
    scim: scimSecurityView(request),
  };
  return json(view);
});
