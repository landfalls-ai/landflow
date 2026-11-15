import { error, handler, json } from '@/lib/server/http';
import { canResource, executionWorkflowId } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { runPractices } from '@/lib/server/practices/compliance';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET — the practices this run was given or checked, as `handle@version` with whether it cited each and how its check went; only practices the caller may see. 404 for a run the caller may not read. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const actor = routeActor();
  const workflowId = executionWorkflowId(id);
  if (!workflowId || !canResource(actor, 'workflow', workflowId, 'read')) return error('Execution not found', 404);
  return json({ practices: await runPractices(actor, id) });
});
