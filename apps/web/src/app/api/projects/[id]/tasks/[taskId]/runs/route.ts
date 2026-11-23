/**
 * POST — ask an agent task to run now (docs/projects-and-goals.md#tasks): editors and admins. Creates a `requested` run
 * (201 `{ run, merged: false }`) or answers the run the task already has open (200 `merged: true`). Nothing runs until a
 * person approves it (POST /api/task-runs/:runId).
 */
import { handler, json } from '@/lib/server/http';
import { requireProject, routeActor } from '@/lib/server/projects/http';
import { askToRun } from '@/lib/server/tasks/service';
import { viewerOf } from '@/lib/server/tasks/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; taskId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, taskId } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  const { run, merged } = askToRun(viewerOf(actor, project.id)!, project, taskId);
  return json({ run, merged }, { status: merged ? 200 : 201 });
});
