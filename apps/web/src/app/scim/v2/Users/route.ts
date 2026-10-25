/**
 * GET /scim/v2/Users?filter=userName eq "a@b.c"&startIndex=1&count=100 and POST /scim/v2/Users (SCIM token): list
 * and provision users (lib/server/scim/users.ts).
 */
import { createScimUser, listResponse, scimBody, scimJson, scimRoute, allUserResources, userResource } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimRoute(async ({ request, base }) => scimJson(listResponse(allUserResources(base), new URL(request.url))));

export const POST = scimRoute(async ({ request, base }) => {
  const user = await createScimUser(await scimBody(request));
  const resource = userResource(user, base);
  return scimJson(resource, 201, { location: `${base}/Users/${user.id}` });
});
