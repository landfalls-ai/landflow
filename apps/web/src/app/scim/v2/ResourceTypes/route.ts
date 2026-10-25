/** GET /scim/v2/ResourceTypes (no token needed): User and Group. */
import { listResponse, resourceTypes, scimJson, scimPublicRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimPublicRoute((base) => scimJson(listResponse(resourceTypes(base), new URL(`${base}/ResourceTypes`))));
