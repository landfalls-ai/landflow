import { handler, json } from '@/lib/server/http';
import { insightsReport, type InsightsPeriod } from '@/lib/server/insights';

export const dynamic = 'force-dynamic';

const PERIODS: InsightsPeriod[] = ['24h', '7d', '30d'];

/** GET ?period=24h|7d|30d&includeManual=true — KPIs vs the previous period, the runs chart and a row per workflow. */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const requested = url.searchParams.get('period') as InsightsPeriod;
  const period = PERIODS.includes(requested) ? requested : '7d';
  const includeManual = ['1', 'true'].includes(url.searchParams.get('includeManual') ?? '');
  return json(insightsReport(period, includeManual));
});
