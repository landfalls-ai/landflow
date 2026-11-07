/**
 * What the model router and the response cache did across every agent (docs/agents.md "Layers"): requests, how many the router sent to
 * a cheaper model and how many the cache answered with no model call. Counted from the agents' newest sessions' notices.
 * GET ?days=7 (1 to 365)
 */
import { layerTotals } from '@/lib/server/agents/layer-stats';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const days = Math.min(365, Math.max(1, Math.round(Number(new URL(request.url).searchParams.get('days')) || 7)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return json({ days, stats: layerTotals(since) });
});
