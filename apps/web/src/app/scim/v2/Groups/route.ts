/**
 * GET /scim/v2/Groups?filter=displayName eq "Data"&excludedAttributes=members and POST /scim/v2/Groups (SCIM token):
 * groups, which map to project memberships or instance roles (lib/server/scim/groups.ts).
 */
import { allGroupResources, createScimGroup, groupResource, listResponse, scimBody, scimJson, scimRoute } from '@/lib/server/scim';

export const dynamic = 'force-dynamic';

export const GET = scimRoute(async ({ request, base }) => scimJson(listResponse(allGroupResources(base), new URL(request.url))));

export const POST = scimRoute(async ({ request, base }) => {
  const group = createScimGroup(await scimBody(request));
  return scimJson(groupResource(group, base), 201, { location: `${base}/Groups/${group.id}` });
});
