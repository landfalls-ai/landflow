/** Number formatting for the Insights page. */
import type { InsightsTotals } from '@/lib/shared/platform';

const trim = (n: number, digits = 1) => n.toFixed(digits).replace(/\.0+$/, '');

/** Minutes as "45 min", "3.5 h" or "12 d" (calendar days). */
export function formatMinutes(minutes: number): string {
  if (!minutes) return '0 min';
  if (minutes < 60) return `${trim(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${trim(hours)} h`;
  return `${trim(hours / 24)} d`;
}

/** 0.0734 → "7.3%". */
export const formatRate = (rate: number) => `${trim(rate * 100)}%`;

/** A run time: "420 ms", "2.4 s", "3m 5s". */
export function formatRunTime(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export type Trend = 'good' | 'bad' | 'neutral';

/** How a KPI moved since the previous period, as text and whether that is good. */
export function change(metric: keyof Pick<InsightsTotals, 'runs' | 'failed' | 'failureRate' | 'timeSavedMinutes' | 'avgDurationMs'>, current: InsightsTotals, previous: InsightsTotals) {
  const now = current[metric];
  const before = previous[metric];
  // Up is bad for failures and run time, good for time saved, neither for the number of runs.
  const upIs: Trend = metric === 'timeSavedMinutes' ? 'good' : metric === 'runs' ? 'neutral' : 'bad';
  const direction = now > before ? 1 : now < before ? -1 : 0;
  const trend: Trend = direction === 0 || upIs === 'neutral' ? 'neutral' : (direction > 0) === (upIs === 'good') ? 'good' : 'bad';
  let text: string;
  if (metric === 'failureRate') text = `${trim(Math.abs(now - before) * 100)} pp`;
  else if (!before) text = now ? 'new' : 'no change';
  else text = `${trim((Math.abs(now - before) / before) * 100, Math.abs(now - before) / before < 0.1 ? 1 : 0)}%`;
  if (direction === 0) text = 'no change';
  return { direction, trend, text };
}
