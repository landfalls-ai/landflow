/**
 * GET /api/projects/:id/goals — the goals a project serves, in order (the first planned or active one is its primary goal).
 * PUT { goalIds } — replace them and their order (the project's admins). Docs: docs/projects-and-goals.md.
 */
import { projectGoalsSchema } from '@/lib/server/goals/schema';
import { projectGoalViews, setProjectGoalsAs } from '@/lib/server/goals/views';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { getProject, projectRole } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  if (!project || !projectRole(actor, project.id)) return error('Project not found', 404);
  return json({ goals: projectGoalViews(actor, project.id) });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, projectGoalsSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const { id } = await params;
  setProjectGoalsAs(actor, id, body.data.goalIds);
  return json({ goals: projectGoalViews(actor, id) });
});
