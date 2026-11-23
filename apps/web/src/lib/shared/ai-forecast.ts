/**
 * The month-end forecast (docs/llm-gateway.md, "The AI page"): month to date plus the mean of the last 7 complete days
 * times the days left, with a band from how much those days vary. Pure, in money or in tokens alike; days are
 * `YYYY-MM-DD` keys in the instance's time zone and the arithmetic on them is calendar arithmetic (no time zone).
 */
import type { AiForecast } from './ai-spend';

/** z of the 90th percentile of a normal distribution: the band's two ends sit this many σ either side of P50. */
export const FORECAST_Z90 = 1.2816;
/** The days the run rate and its spread are taken over, and the days of data below which the forecast is "early". */
export const FORECAST_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The day key `days` after `day` (before it when negative). */
export const addDays = (day: string, days: number): string => new Date(at(day) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((at(to) - at(from)) / DAY_MS);

/** The last day of `day`'s month: 28, 29, 30 or 31. */
export function monthEndOf(day: string): string {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * The forecast to the end of the month `today` is in.
 *
 * `dailyValues` is a day key → the day's value (cost or tokens); a day with no entry had none. It may hold days before
 * the month: the last 7 complete days (the 7 days before `today`) can reach back into the month before. Mean and σ
 * (sample standard deviation) are over those days, or the complete days since the first entry when there are fewer;
 * `early` is set when that is under 7. `firstDay` says when the data began when that is earlier than its first entry
 * (a subject with no spend yet but a history).
 */
export function forecastMonth(dailyValues: Readonly<Record<string, number>>, today: string, monthEnd: string, firstDay?: string): AiForecast {
  const monthStart = `${today.slice(0, 7)}-01`;
  const entries = Object.entries(dailyValues).filter(([, v]) => Number.isFinite(v));
  let monthToDate = 0;
  for (const [day, value] of entries) if (day >= monthStart && day <= today) monthToDate += value;
  const first = [...entries.map(([day]) => day), ...(firstDay ? [firstDay] : [])].sort()[0];
  const observed = first && first < today ? Math.min(daysBetween(first, today), 400) : 0;
  const used = Math.min(observed, FORECAST_WINDOW_DAYS);
  const window: number[] = [];
  for (let i = 1; i <= used; i++) window.push(dailyValues[addDays(today, -i)] ?? 0);
  const mean = used ? window.reduce((s, v) => s + v, 0) / used : 0;
  const sigma = used > 1 ? Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / (used - 1)) : 0;
  const daysLeft = Math.max(0, daysBetween(today, monthEnd));
  const p50 = monthToDate + mean * daysLeft;
  const half = FORECAST_Z90 * sigma * Math.sqrt(daysLeft);
  return {
    monthToDate,
    p50,
    low: Math.max(monthToDate, p50 - half),
    high: p50 + half,
    early: observed < FORECAST_WINDOW_DAYS,
    daysObserved: observed,
    daysLeft,
  };
}

/**
 * The first day the P50 line (month to date + mean × d, d days after `today`) reaches `limit`; undefined when it stays
 * under until the month's end or the limit is already reached.
 */
export function reachesOn(forecast: AiForecast, limit: number, today: string): string | undefined {
  if (!(limit > 0) || forecast.monthToDate >= limit || forecast.daysLeft <= 0) return undefined;
  const mean = (forecast.p50 - forecast.monthToDate) / forecast.daysLeft;
  if (!(mean > 0)) return undefined;
  const days = Math.max(1, Math.ceil((limit - forecast.monthToDate) / mean - 1e-9));
  return days > forecast.daysLeft ? undefined : addDays(today, days);
}

/** Today's pace: what was used so far today, spread over 24 hours. */
export const paceToday = (used: number, hoursSoFar: number): number => (hoursSoFar > 0 ? (used / hoursSoFar) * 24 : used);
