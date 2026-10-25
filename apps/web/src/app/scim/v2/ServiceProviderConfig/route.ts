/** GET /scim/v2/ServiceProviderConfig (no token needed): what this SCIM server supports. */
import { scimJson, scimPublicRoute, serviceProviderConfig } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimPublicRoute((base) => scimJson(serviceProviderConfig(base)));
