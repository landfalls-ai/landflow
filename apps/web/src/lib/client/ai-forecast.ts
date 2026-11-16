/** Words and figures for the AI page's forecast and cache cards (docs/llm-gateway.md, "The AI page"). */
import type { AiCacheReport } from '../shared/ai-cache';
import type { AiForecast, AiForecastCap } from '../shared/ai-spend';
import { formatCost, formatTokens } from '../shared/ai-usage';

/** Dollars: whole dollars from $100, else as `formatCost`. */
export const money = (value: number): string => (value >= 100 ? `$${Math.round(value).toLocaleString('en-US')}` : formatCost(value));

export const amountOf = (metric: 'cost' | 'tokens', value: number): string => (metric === 'cost' ? money(value) : `${formatTokens(Math.round(value))} tokens`);

/** "Nov 24" from a `YYYY-MM-DD` day key (calendar arithmetic: the browser's time zone does not move it). */
export const dayWord = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "$410 to $520 by Nov 30"; "about $460 by Nov 30" when the band is flat. */
export function forecastRange(forecast: AiForecast, monthEnd: string, metric: 'cost' | 'tokens' = 'cost'): string {
  const low = amountOf(metric, forecast.low);
  const high = amountOf(metric, forecast.high);
  const by = dayWord(monthEnd);
  return low === high ? `about ${low} by ${by}` : `${low} to ${high} by ${by}`;
}

/** The P50 in words, and why the band is rough when it is. */
export function forecastNote(forecast: AiForecast, metric: 'cost' | 'tokens' = 'cost'): string {
  const base = `Most likely about ${amountOf(metric, forecast.p50)}: ${amountOf(metric, forecast.monthToDate)} so far, plus the last ${Math.min(7, forecast.daysObserved) || 'few'} days’ average for the ${forecast.daysLeft} day${forecast.daysLeft === 1 ? '' : 's'} left.`;
  return forecast.early ? `${base} Early: under 7 days of data, so the range is rough.` : base;
}

export type CapOutlook = { tone: 'ok' | 'near' | 'full'; text: string };

/** What a cap's forecast says: when it is reached, that it stays under, or today's pace. */
export function capOutlook(cap: AiForecastCap, monthEnd: string): CapOutlook {
  if (cap.used >= cap.max) return { tone: 'full', text: 'Already at its limit' };
  if (cap.period === 'day') {
    const pace = cap.pace ?? 0;
    return pace > cap.max
      ? { tone: 'near', text: `On pace for ${amountOf(cap.metric, pace)} today, over its limit` }
      : { tone: 'ok', text: `On pace for ${amountOf(cap.metric, pace)} today, under its limit` };
  }
  if (cap.reachesOn) return { tone: 'near', text: `Reaches its limit on ${dayWord(cap.reachesOn)}${cap.forecast?.early ? ' (early)' : ''}` };
  return { tone: 'ok', text: `Stays under its limit to ${dayWord(monthEnd)}${cap.forecast?.early ? ' (early)' : ''}` };
}

export const hitPercent = (rate: number): string => `${Math.round(rate * 100)}%`;

/** The cache card's sentence over the period: hit rate, savings and misses, or why there is nothing to say. */
export function cacheHeadline(report: AiCacheReport): string {
  const { cache } = report;
  if (cache.hitRate === undefined) return 'No call in this period reported cache numbers.';
  const saved = cache.savedUsd > 0 ? ` · saved ${formatCost(cache.savedUsd)}` : '';
  return `${hitPercent(cache.hitRate)} of the prompt came from the cache${saved}`;
}
