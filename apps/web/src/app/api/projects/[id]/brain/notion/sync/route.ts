/** POST — sync now (the project's admins): the link's next sync is due at once. Answers 202; the sync itself is wave nb2. */
import { recordAudit } from '@/lib/server/audit';
import { getLink, linkView, notionBrainEnabled, requestSync, SWITCHED_OFF } from '@/lib/server/brain/notion/links';
import { error, json } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'manage');
  if (!notionBrainEnabled()) return error(SWITCHED_OFF, 409);
  const link = getLink(project.id);
  if (!link) return error('This project is not linked to Notion', 404);
  const next = requestSync(link.id) ?? link;
  recordAudit({ action: 'notion-brain.sync', target: { type: 'project', id: project.id, name: project.name }, summary: `Asked for a Notion sync of “${project.name}”`, details: { linkId: link.id } });
  return json(linkView(next, { member: true, canManage: true }), 202);
});
