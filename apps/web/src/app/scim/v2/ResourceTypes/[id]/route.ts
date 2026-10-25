/** GET /scim/v2/ResourceTypes/<id> (no token needed): User or Group. */
import { resourceTypes, ScimError, scimJson, scimPublicRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimPublicRoute<{ id: string }>((base, { id }) => {
  const type = resourceTypes(base).find((t) => t.id === decodeURIComponent(id));
  if (!type) throw new ScimError(404, `Resource type ${id} not found`);
  return scimJson(type);
});
