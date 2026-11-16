/**
 * POST /api/insights/ai/flags/:id/ack — acknowledge a forecast-over-a-cap or unusual-spend flag
 * (docs/llm-gateway.md#forecasts-and-unusual-spend). Anyone in the flag's audience may (the person it is about, the editors of
 * the agent or workflow, a project's admins, owners and admins); anyone else gets a 404. It clears the item from Needs you
 * for everyone, with who and when; audited as `ai.spend.acknowledged`. A day whose value doubles after it opens again.
 */
import { acknowledgeFlag } from '@/lib/server/ai-usage/spend-flags';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const flag = acknowledgeFlag(id, routeActor());
  return json({ id: flag.id, acknowledgedBy: flag.acknowledgedBy, acknowledgedAt: flag.acknowledgedAt });
});
