/** GET /scim/v2/Schemas (no token needed): the User and Group schemas. */
import { listResponse, schemas, scimJson, scimPublicRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimPublicRoute((base) => scimJson(listResponse(schemas(base), new URL(`${base}/Schemas`))));
