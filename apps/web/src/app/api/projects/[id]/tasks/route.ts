/**
 * A project's tasks (docs/projects-and-goals.md#tasks; lib/server/tasks).
 * GET ?limit&cursor&status&mine=1 — `{ tasks, nextCursor?, canCreate }` for any role in the project (404 otherwise).
 * POST { title, description?, status?, priority?, goalId?, parentId?, assignee?, wake? } — editors and admins; 201 `{ task }`.
 */
import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { requireProject, routeActor } from '@/lib/server/projects/http';
import { createTask } from '@/lib/server/tasks/service';
import { createTaskSchema, listTasksQuery } from '@/lib/server/tasks/schema';
import { tasksPage, viewerOf } from '@/lib/server/tasks/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'read');
  const query = parseQuery(request, listTasksQuery);
  if (!query.ok) return query.response;
  const { limit, cursor, status, mine } = query.data;
  return json(tasksPage(project.id, viewerOf(actor, project.id)!, { limit, ...(cursor && { cursor }), ...(status && { status }), mine: Boolean(mine) }));
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'read');
  const body = await parseBody(request, createTaskSchema);
  if (!body.ok) return body.response;
  return json({ task: createTask(viewerOf(actor, project.id)!, project, body.data) }, { status: 201 });
});
