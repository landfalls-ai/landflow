/** GET /scim/v2/Schemas/<urn> (no token needed): one schema. */
import { schemas, ScimError, scimJson, scimPublicRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimPublicRoute<{ id: string }>((base, { id }) => {
  const schema = schemas(base).find((s) => s.id === decodeURIComponent(id));
  if (!schema) throw new ScimError(404, `Schema ${id} not found`);
  return scimJson(schema);
});
