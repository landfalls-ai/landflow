/**
 * The AI page's month-end forecast (docs/llm-gateway.md, "The AI page"): the month's total of what the viewer can see,
 * and every cap and budget they may see, each forecast from the days of its own subject (`lib/shared/ai-forecast.ts`).
 * Reads `ai_usage` by day through one small function (`dayRows`); money for cost caps, tokens for token caps.
 * Visibility is D1's rule 2 for the total and rule 5 for the caps: `capsFor` decides which caps a viewer gets.
 */
import { addDays, forecastMonth, monthEndOf, paceToday, reachesOn } from '../../shared/ai-forecast';
import type { AiForecastCap, AiForecastReport } from '../../shared/ai-spend';
import { parseCapId } from '../../shared/llm-gateway';
import { agentStore } from '../agents/store';
import { database } from '../db';
import { capsFor } from '../llm-gateway/console';
import { isInstanceAdmin, visibleIds, type Actor } from '../projects/access';
import { instanceTimezone } from '../settings';
import { store } from '../store';
import { aiUsageMeter } from './index';

/** One day of one combination of people, agents, workflows, credentials and projects. */
export interface DayRow {
  day: string;
  user_id: string | null;
  agent_id: string | null;
  workflow_id: string | null;
  credential_id: string | null;
  project_id: string | null;
  cost: number;
  tokens: number;
}

const COLUMNS = 'user_id, agent_id, workflow_id, credential_id, project_id';
const WINDOW_DAYS = 8;

/** The days from `since` (a day key), and the first day each combination appears (the whole table). */
function dayRows(since: string): { rows: DayRow[]; firsts: Array<DayRow & { first: string }> } {
  const db = database();
  const rows = db.all<DayRow>(`SELECT day, ${COLUMNS}, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE day >= ? GROUP BY day, ${COLUMNS}`, since);
  const firsts = db.all<DayRow & { first: string }>(`SELECT ${COLUMNS}, MIN(day) AS first, 0 AS cost, 0 AS tokens, '' AS day FROM ai_usage GROUP BY ${COLUMNS}`);
  return { rows, firsts };
}

/** Which rows a viewer's totals hold: all for an admin; else their own, and those of workflows and agents they can read (as the AI page's totals). */
export function visibleRow(actor: Actor): (row: { user_id: string | null; workflow_id: string | null; agent_id: string | null }) => boolean {
  if (isInstanceAdmin(actor)) return () => true;
  const workflows = visibleIds(actor, 'workflow', store.listWorkflows().map((w) => w.id));
  const agents = visibleIds(actor, 'agent', agentStore.list().map((a) => a.id));
  return (row) => row.user_id === actor.id || Boolean(row.workflow_id && workflows?.has(row.workflow_id)) || Boolean(row.agent_id && agents?.has(row.agent_id));
}

/** Hours since midnight in the instance's time zone. */
export function hoursSoFar(now: number, timezone = instanceTimezone()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return get('hour') + get('minute') / 60;
  } catch {
    const d = new Date(now);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  }
}

type Metric = 'cost' | 'tokens';

function series(rows: DayRow[], keep: (row: DayRow) => boolean, metric: Metric): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) if (keep(row)) out[row.day] = (out[row.day] ?? 0) + Number(row[metric]);
  return out;
}

/** The report for `actor` as of `now`. */
export function aiForecast(actor: Actor, now = Date.now()): AiForecastReport {
  const today = aiUsageMeter().today(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = monthEndOf(today);
  const { rows, firsts } = dayRows(monthStart < addDays(today, -WINDOW_DAYS) ? monthStart : addDays(today, -WINDOW_DAYS));
  const admin = isInstanceAdmin(actor);
  const sees = visibleRow(actor);
  const firstOf = (keep: (row: DayRow) => boolean) => firsts.filter(keep).map((r) => r.first).sort()[0];

  const total = forecastMonth(series(rows, sees, 'cost'), today, monthEnd, firstOf(sees));

  const hours = hoursSoFar(now);
  const caps: AiForecastCap[] = [];
  for (const cap of capsFor(actor, admin)) {
    const parsed = parseCapId(cap.id);
    if (!parsed) continue;
    const column = ({ user: 'user_id', agent: 'agent_id', credential: 'credential_id', workflow: 'workflow_id', project: 'project_id' } as const)[parsed.kind];
    const of = (row: DayRow) => row[column] === parsed.subjectId;
    const item: AiForecastCap = { capId: cap.id, subject: cap.subject, period: cap.period, metric: cap.metric, max: cap.max, used: cap.used };
    if (cap.period === 'month') {
      const forecast = forecastMonth(series(rows, of, cap.metric), today, monthEnd, firstOf(of));
      item.forecast = forecast;
      const reaches = reachesOn(forecast, cap.max, today);
      if (reaches) item.reachesOn = reaches;
    } else item.pace = paceToday(cap.used, hours);
    caps.push(item);
  }
  return { month: today.slice(0, 7), total, caps };
}
