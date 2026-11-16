/**
 * GET /api/executions/:id/spend: one run's spend (docs/run-trace.md#spend): totals, slices, the cache line and the calls,
 * the run's sub-runs the viewer may open included. A run the caller can't open answers 404.
 */
import { runSpend } from '@/lib/server/ai-usage/run-spend';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const spend = await runSpend(id, routeActor());
  return spend ? json(spend) : error('Execution not found', 404);
});
