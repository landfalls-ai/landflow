/** GET /api/workflows/:id/evaluations/:runId — a run with its per-case results. DELETE — remove it (a running one is stopped). */
import { deleteEvaluation, evaluationDetail, getRun } from '@/lib/server/evaluations';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; runId: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, runId } = await params;
  const run = evaluationDetail(runId);
  return run && run.workflowId === id ? json({ run }) : error('Evaluation run not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, runId } = await params;
  if (getRun(runId)?.workflowId !== id) return error('Evaluation run not found', 404);
  deleteEvaluation(runId);
  return json({ ok: true });
});
