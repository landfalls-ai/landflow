/**
 * One task of a project (docs/projects-and-goals.md#tasks).
 * GET — `{ task }` for any role in the project; PATCH (any field of the create body, null clears) and DELETE (204, its runs
 * go with it) — editors and admins.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { requireProject, routeActor } from '@/lib/server/projects/http';
import { updateTaskSchema } from '@/lib/server/tasks/schema';
import { deleteTask, updateTask } from '@/lib/server/tasks/service';
import { getTask, TaskError } from '@/lib/server/tasks/store';
import { taskView, viewerOf } from '@/lib/server/tasks/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; taskId: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  const task = getTask(taskId);
  if (!task || task.projectId !== project.id) throw new TaskError('Task not found', 404);
  return json({ task: taskView(task, viewerOf(actor, project.id)!) });
});

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  const body = await parseBody(request, updateTaskSchema);
  if (!body.ok) return body.response;
  return json({ task: updateTask(viewerOf(actor, project.id)!, project, taskId, body.data) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  deleteTask(viewerOf(actor, project.id)!, project, taskId);
  return new Response(null, { status: 204 });
});
