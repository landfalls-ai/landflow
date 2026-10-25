/** GET /api/workflows/:id/evaluations/compare?a=<runId>&b=<runId> — run b against run a (the baseline): metric and per-case deltas. */
import { compareRuns } from '@/lib/server/evaluations';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const [a, b] = [query.get('a') ?? '', query.get('b') ?? ''];
  if (!a || !b) return error('Name two runs: ?a=<runId>&b=<runId>');
  const comparison = compareRuns(a, b);
  if (!comparison || comparison.a.workflowId !== id || comparison.b.workflowId !== id) return error('Evaluation run not found', 404);
  return json(comparison);
});
