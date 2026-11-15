/**
 * Check a task out (docs/projects-and-goals.md#tasks): one person holds it at a time.
 * POST — editors and admins; 409 `TaskCheckedOut` (“Checked out by <name>”) when someone else holds it.
 * DELETE — releases it: the holder, or a project admin. Both answer `{ task }`.
 */
import { handler, json } from '@/lib/server/http';
import { requireProject, routeActor } from '@/lib/server/projects/http';
import { checkout, release } from '@/lib/server/tasks/service';
import { viewerOf } from '@/lib/server/tasks/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; taskId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  return json({ task: checkout(viewerOf(actor, project.id)!, project, taskId) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  return json({ task: release(viewerOf(actor, project.id)!, project, taskId) });
});
