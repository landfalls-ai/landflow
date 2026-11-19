/** POST { credentialId, page } — what a Notion page is and what a copy would do; writes nothing (the project's admins). */
import { checkPage } from '@/lib/server/brain/notion/check';
import { linkCheckSchema } from '@/lib/server/brain/notion/schemas';
import { json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'manage');
  const body = await parseBody(request, linkCheckSchema);
  if (!body.ok) return body.response;
  return json((await checkPage(project, body.data)).result);
});
