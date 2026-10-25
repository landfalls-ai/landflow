/** GET, PUT, PATCH and DELETE /scim/v2/Groups/<id> (SCIM token): one group and its members (lib/server/scim). */
import { deleteGroup, groupResource, noContent, patchScimGroup, project, replaceScimGroup, requireScimGroup, scimBody, ScimError, scimJson, scimRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';
type Params = { id: string };

export const GET = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(project(groupResource(requireScimGroup(id), base), new URL(request.url))));

export const PUT = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(groupResource(replaceScimGroup(id, await scimBody(request)), base)));

export const PATCH = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(project(groupResource(patchScimGroup(id, await scimBody(request)), base), new URL(request.url))));

export const DELETE = scimRoute<Params>(async (_ctx, { id }) => {
  if (!deleteGroup(id)) throw new ScimError(404, `Group ${id} not found`);
  return noContent();
});
