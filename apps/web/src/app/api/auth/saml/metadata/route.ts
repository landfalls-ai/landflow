/**
 * GET /api/auth/saml/metadata (public): our SAML service provider metadata, to load into the IdP: the entity id
 * (this URL, unless LANDFLOW_SAML_ISSUER says otherwise), the ACS (HTTP-POST), single logout and the NameID format,
 * plus our signing certificate when LANDFLOW_SAML_CERT is set.
 */
import { publicOrigin } from '@/lib/server/auth/cookies';
import { samlConfig, spMetadata } from '@/lib/server/auth/saml';
import { error, handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const config = samlConfig();
  if (!config) return error('SAML sign-in is not configured', 404);
  return new Response(spMetadata(config, publicOrigin(request)), { headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' } });
});
