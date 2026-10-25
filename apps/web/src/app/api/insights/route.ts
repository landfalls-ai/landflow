import { handler, json } from '@/lib/server/http';
import { insightsReport, type InsightsPeriod } from '@/lib/server/insights';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

const PERIODS: InsightsPeriod[] = ['24h', '7d', '30d'];

/** GET ?period=24h|7d|30d&includeManual=true — KPIs vs the previous period, the runs chart and a row per workflow. */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const requested = url.searchParams.get('period') as InsightsPeriod;
  const period = PERIODS.includes(requested) ? requested : '7d';
  const includeManual = ['1', 'true'].includes(url.searchParams.get('includeManual') ?? '');
  // Members: the workflows they see (owners and admins: all).
  const only = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  return json(insightsReport(period, includeManual, only));
});
