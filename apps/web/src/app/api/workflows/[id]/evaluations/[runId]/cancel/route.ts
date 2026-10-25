/** POST /api/workflows/:id/evaluations/:runId/cancel — stop a running evaluation: the current case is canceled, the rest never run. */
import { cancelEvaluation, getRun } from '@/lib/server/evaluations';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; runId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, runId } = await params;
  if (getRun(runId)?.workflowId !== id) return error('Evaluation run not found', 404);
  return cancelEvaluation(runId) ? json({ ok: true }) : error('The run is not running', 409);
});
