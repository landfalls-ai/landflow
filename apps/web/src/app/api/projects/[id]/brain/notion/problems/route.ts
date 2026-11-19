/** GET — the open sync problems of the project's Notion link (its members). */
import { getLink, problemView, problems } from '@/lib/server/brain/notion/links';
import { json } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { PROBLEM_KIND_ACTIONS } from '@/lib/shared/notion-brain';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  const link = getLink(project.id);
  if (!link) return json([]);
  return json(problems(link.id).map((row) => problemView(row, { member: true, offered: ['dismiss', ...PROBLEM_KIND_ACTIONS[row.kind]] })));
});
