/** GET, PUT, PATCH and DELETE /scim/v2/Users/<id> (SCIM token): one provisioned user (lib/server/scim/users.ts). */
import { deleteScimUser, noContent, patchScimUser, project, replaceScimUser, requireScimUser, scimBody, scimJson, scimRoute, userResource } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';
type Params = { id: string };

export const GET = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(project(userResource(requireScimUser(id), base), new URL(request.url))));

export const PUT = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(userResource(replaceScimUser(id, await scimBody(request)), base)));

export const PATCH = scimRoute<Params>(async ({ request, base }, { id }) => scimJson(userResource(patchScimUser(id, await scimBody(request)), base)));

export const DELETE = scimRoute<Params>(async ({ caller }, { id }) => {
  deleteScimUser(id, caller.user.id);
  return noContent();
});
