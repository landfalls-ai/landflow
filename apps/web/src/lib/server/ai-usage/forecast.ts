/**
 * The AI page's month-end forecast (docs/llm-gateway.md, "The AI page"): the month's total of what the viewer can see,
 * and every cap and budget they may see, each forecast from the days of its own subject (`lib/shared/ai-forecast.ts`).
 * Reads `ai_usage` by day through one small function (`dayRows`); money for cost caps, tokens for token caps.
 * Visibility is D1's rule 2 for the total and rule 5 for the caps: `capsFor` decides which caps a viewer gets.
 */
import { addDays, forecastMonth, monthEndOf, paceToday, reachesOn } from '../../shared/ai-forecast';
import type { AiForecast, AiForecastCap, AiForecastReport } from '../../shared/ai-spend';
import { parseCapId } from '../../shared/llm-gateway';
import { agentStore } from '../agents/store';
import { database, type Database } from '../db';
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

/**
 * The days from `since` (a day key), and the first day each combination appears (the whole table). `userId` keeps one
 * person's rows only (the You card's own caps): a `user:` cap's subject is those rows, so its figures are the same.
 */
function dayRows(since: string, userId?: string, db: Database = database()): { rows: DayRow[]; firsts: Array<DayRow & { first: string }> } {
  const only = userId === undefined ? '' : 'user_id = ?';
  const args = userId === undefined ? [] : [userId];
  const rows = db.all<DayRow>(
    `SELECT day, ${COLUMNS}, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE day >= ?${only && ` AND ${only}`} GROUP BY day, ${COLUMNS}`,
    since,
    ...args,
  );
  const firsts = db.all<DayRow & { first: string }>(`SELECT ${COLUMNS}, MIN(day) AS first, 0 AS cost, 0 AS tokens, '' AS day FROM ai_usage${only && ` WHERE ${only}`} GROUP BY ${COLUMNS}`, ...args);
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

/** What a cap's forecast adds: `forecast` and `reachesOn` for a monthly cap, `pace` for a daily one. */
export interface CapForecastFields {
  forecast?: AiForecast;
  pace?: number;
  reachesOn?: string;
}

/** A cap as the forecast reads it (a watched cap, a console cap or the You card's own). */
export interface ForecastableCap {
  id: string;
  period: 'day' | 'month';
  metric: 'cost' | 'tokens';
  max: number;
  used: number;
}

interface ForecastDays {
  today: string;
  monthEnd: string;
  hours: number;
  rows: DayRow[];
  firsts: Array<DayRow & { first: string }>;
}

function forecastDays(now: number, userId?: string, db?: Database): ForecastDays {
  const today = aiUsageMeter().today(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const window = addDays(today, -WINDOW_DAYS);
  return { today, monthEnd: monthEndOf(today), hours: hoursSoFar(now), ...dayRows(monthStart < window ? monthStart : window, userId, db) };
}

const firstOf = (days: ForecastDays, keep: (row: DayRow) => boolean) => days.firsts.filter(keep).map((r) => r.first).sort()[0];

const CAP_COLUMN = { user: 'user_id', agent: 'agent_id', credential: 'credential_id', workflow: 'workflow_id', project: 'project_id' } as const;

/** One cap's forecast from the days of its own subject; undefined for a cap id `parseCapId` does not read. */
function capForecast(days: ForecastDays, cap: ForecastableCap): CapForecastFields | undefined {
  const parsed = parseCapId(cap.id);
  if (!parsed) return undefined;
  const column = CAP_COLUMN[parsed.kind];
  const of = (row: DayRow) => row[column] === parsed.subjectId;
  if (cap.period === 'day') return { pace: paceToday(cap.used, days.hours) };
  const forecast = forecastMonth(series(days.rows, of, cap.metric), days.today, days.monthEnd, firstOf(days, of));
  const reaches = reachesOn(forecast, cap.max, days.today);
  return reaches ? { forecast, reachesOn: reaches } : { forecast };
}

/**
 * The one per-cap forecast, for the forecast card and the You card alike: reads the days once, then answers each cap.
 * `userId` reads only that person's rows (enough for their own `user:` caps; another subject's figures would be short).
 */
export function capForecaster(now = Date.now(), userId?: string, db?: Database): { monthEnd: string; forecast: (cap: ForecastableCap) => CapForecastFields | undefined } {
  const days = forecastDays(now, userId, db);
  return { monthEnd: days.monthEnd, forecast: (cap) => capForecast(days, cap) };
}

/** The report for `actor` as of `now`. */
export function aiForecast(actor: Actor, now = Date.now()): AiForecastReport {
  const days = forecastDays(now);
  const admin = isInstanceAdmin(actor);
  const sees = visibleRow(actor);
  const total = forecastMonth(series(days.rows, sees, 'cost'), days.today, days.monthEnd, firstOf(days, sees));
  const caps: AiForecastCap[] = [];
  for (const cap of capsFor(actor, admin)) {
    const fields = capForecast(days, cap);
    if (!fields) continue;
    caps.push({ capId: cap.id, subject: cap.subject, period: cap.period, metric: cap.metric, max: cap.max, used: cap.used, ...fields });
  }
  return { month: days.today.slice(0, 7), total, caps };
}
