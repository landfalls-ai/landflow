/**
 * Pure helpers for the AI page (components/insights/ai-console*.tsx, ai-trend.tsx, ai-movers.tsx, ai-drill.tsx): formatting,
 * sorting and the near-cap colour; and, from wave 13 (the `// SP10:` blocks), the view in the URL, the trend's points and
 * stacks, the movers, the custom range's checks and the drill sheet's labels.
 */
import { formatCost, formatTokens } from '../shared/ai-usage';
import { AI_SPEND_GROUPS, AI_SPEND_MAX_DAYS, AI_SPEND_PERIODS, type AiSpendFilters, type AiSpendGroup, type AiSpendHidden, type AiSpendPeriod, type AiSpendPoint, type AiSpendReport, type AiSpendRow, type AiSpendStack } from '../shared/ai-spend';
import type { AiConsoleCap, AiConsoleRow, AiConsoleTotals, CapRaiseStatus, GatewayHealth } from '../shared/llm-gateway';

// SP10: the period adds 90 days and a custom range, the group switch lists the ten groups of the report.
export const AI_PERIODS: Array<{ value: AiSpendPeriod; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'custom', label: 'Custom' },
];

export const AI_GROUPS: Array<{ value: AiSpendGroup; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'goal', label: 'Goal' },
  { value: 'agent', label: 'Agent' },
  { value: 'workflow', label: 'Workflow' },
  { value: 'person', label: 'Person' },
  { value: 'model', label: 'Model' },
  { value: 'source', label: 'Source' },
  { value: 'credential', label: 'Credential' },
  { value: 'surface', label: 'Surface' },
  { value: 'purpose', label: 'Purpose' },
];

export type CapTone = 'ok' | 'near' | 'full';

/** A cap's bar: amber from 80%, red at 100% and over. */
export function capTone(ratio: number): CapTone {
  if (!(ratio > 0)) return 'ok';
  // Compare in whole percent so 0.7999999 from a division does not read as 79.
  const percent = Math.round(ratio * 10_000) / 100;
  return percent >= 100 ? 'full' : percent >= 80 ? 'near' : 'ok';
}

export const CAP_BAR_CLASS: Record<CapTone, string> = { ok: 'bg-ac', near: 'bg-warn', full: 'bg-rd' };

/** The bar's width, 0 to 100, with a sliver for any use so a small share is still seen. */
export function barPercent(fraction: number): number {
  if (!(fraction > 0)) return 0;
  return Math.min(100, Math.max(1, Math.round(fraction * 100)));
}

export const formatPercent = (fraction: number): string => (fraction > 0 && fraction < 0.01 ? '<1%' : `${Math.round(fraction * 100)}%`);

export const totalTokens = (totals: Pick<AiConsoleTotals, 'inputTokens' | 'outputTokens'>): number => totals.inputTokens + totals.outputTokens;

export function formatCapAmount(cap: Pick<AiConsoleCap, 'metric'>, value: number): string {
  return cap.metric === 'cost' ? formatCost(value) : `${formatTokens(Math.round(value))} tokens`;
}

export const capPeriodLabel = (period: 'day' | 'month'): string => (period === 'day' ? 'per day' : 'per month');

/** What a row shows on one line: the desktop table's cells, and the phone card's two lines. */
export function rowModel(row: AiConsoleRow) {
  return {
    key: row.key,
    label: row.label,
    href: row.href,
    cost: formatCost(row.cost),
    tokens: `${formatTokens(totalTokens(row))} tokens`,
    tokenDetail: `${row.inputTokens.toLocaleString('en-US')} in · ${row.outputTokens.toLocaleString('en-US')} out`,
    calls: `${row.calls.toLocaleString('en-US')} call${row.calls === 1 ? '' : 's'}`,
    share: formatPercent(row.share),
    bar: barPercent(row.share),
    // SP12: a model with no price whose calls cost nothing.
    unpriced: Boolean(row.unpriced),
  };
}

/** SP12: most tokens first (a local model nobody priced costs $0 and would sink to the bottom), then cost, then name. "Other" stays last. */
export function sortByTokens(rows: AiConsoleRow[]): AiConsoleRow[] {
  const last = (row: AiConsoleRow) => (row.key === 'other' ? 1 : 0);
  return [...rows].sort((a, b) => last(a) - last(b) || totalTokens(b) - totalTokens(a) || b.cost - a.cost || a.label.localeCompare(b.label));
}

/** Cost first, then tokens, then name: the order the server sends, for a client that merges or re-sorts rows. */
export function sortRows(rows: AiConsoleRow[]): AiConsoleRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost || totalTokens(b) - totalTokens(a) || a.label.localeCompare(b.label));
}

export const REQUEST_STATUS: Record<CapRaiseStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted' }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  asking: { label: 'With a person', tone: 'accent' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Declined', tone: 'danger' },
  failed: { label: 'Could not change', tone: 'danger' },
  cancelled: { label: 'Withdrawn', tone: 'muted' },
};

export const isOpenRequest = (status: CapRaiseStatus): boolean => status === 'pending' || status === 'asking';

export const GATEWAY_WORDS: Record<GatewayHealth, { label: string; dot: string }> = {
  ok: { label: 'Healthy', dot: 'bg-gn' },
  degraded: { label: 'Reachable, not ready', dot: 'bg-warn' },
  down: { label: 'Not answering', dot: 'bg-rd' },
  unknown: { label: 'Not set up', dot: 'bg-t3' },
};

/** The new maximum a person typed: a number above the current one, or why not. */
export function checkRaise(text: string, current: number): { value?: number; error?: string } {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value)) return { error: 'Enter the new maximum as a number' };
  if (value <= current) return { error: 'The new maximum has to be more than it is now' };
  return { value };
}

// SP10: the page's view (period, range, group, filters, stack, drill) as the URL holds it, the report's query, the trend,
// the movers and the drill sheet's words. Pure, so the tests read them without a browser.

export type TrendMetric = 'cost' | 'tokens';

export interface AiView {
  period: AiSpendPeriod;
  /** `YYYY-MM-DD`, only for `custom`. */
  from?: string;
  to?: string;
  group: AiSpendGroup;
  filters: AiSpendFilters;
  /** The trend's "By" group. */
  stack?: AiSpendGroup;
  metric: TrendMetric;
  /** The row whose runs the sheet lists. */
  drill?: { group: AiSpendGroup; key: string };
}

export const DEFAULT_VIEW: AiView = { period: '7d', group: 'project', filters: {}, metric: 'cost' };

export const FILTER_KEYS = ['projectId', 'agentId', 'workflowId', 'userId', 'credentialId', 'model', 'purpose', 'source', 'surface'] as const satisfies ReadonlyArray<keyof AiSpendFilters>;

/** The group a filter narrows, and the chip's word for it. */
export const FILTER_WORDS: Record<(typeof FILTER_KEYS)[number], { group: AiSpendGroup; label: string }> = {
  projectId: { group: 'project', label: 'Project' },
  agentId: { group: 'agent', label: 'Agent' },
  workflowId: { group: 'workflow', label: 'Workflow' },
  userId: { group: 'person', label: 'Person' },
  credentialId: { group: 'credential', label: 'Credential' },
  model: { group: 'model', label: 'Model' },
  purpose: { group: 'purpose', label: 'Purpose' },
  source: { group: 'source', label: 'Source' },
  surface: { group: 'surface', label: 'Surface' },
};

const isGroup = (value: string | null): value is AiSpendGroup => (AI_SPEND_GROUPS as readonly string[]).includes(value ?? '');
const isPeriod = (value: string | null): value is AiSpendPeriod => (AI_SPEND_PERIODS as readonly string[]).includes(value ?? '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const dayText = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** The days a range spans, both ends counted; NaN for a bad date. */
export function rangeDays(from: string, to: string): number {
  if (!DAY.test(from) || !DAY.test(to)) return NaN;
  const a = dayNumber(from);
  const b = dayNumber(to);
  return dayText(a) === from && dayText(b) === to ? b - a + 1 : NaN;
}

/** Why a custom range can't be asked for yet, or nothing: two real dates, in order, at most 400 days, none after today. */
export function rangeProblem(from: string | undefined, to: string | undefined, today?: string): string | undefined {
  if (!from || !to) return 'Pick the first and the last day.';
  const days = rangeDays(from, to);
  if (Number.isNaN(days)) return 'Use real dates.';
  if (days < 1) return 'The first day has to come before the last.';
  if (days > AI_SPEND_MAX_DAYS) return `A range spans at most ${AI_SPEND_MAX_DAYS} days.`;
  if (today && to > today) return 'The last day can’t be in the future.';
  return undefined;
}

/** The tooltip's left edge: right of the pointer, but never past the chart's right edge (the tooltip is `tipWidth` wide). */
export const tipLeft = (pointerX: number, tipWidth: number, chartWidth: number): number => Math.min(Math.max(0, pointerX + 12), Math.max(0, chartWidth - tipWidth));

/** The days of the same length just before a day range, for the faint line (nothing for an hour range). */
export function previousRange(from: string, to: string): { from: string; to: string } | undefined {
  const days = rangeDays(from, to);
  if (!(days >= 1)) return undefined;
  const start = dayNumber(from);
  return { from: dayText(start - days), to: dayText(start - 1) };
}

/** The page's view from its URL; anything unknown falls back to the default. */
export function parseView(params: { get(name: string): string | null }): AiView {
  const period = params.get('period');
  const group = params.get('group');
  const by = params.get('by');
  const drill = params.get('drill');
  const filters: AiSpendFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) (filters as Record<string, string>)[key] = value;
  }
  const colon = drill?.indexOf(':') ?? -1;
  const drillGroup = colon > 0 ? drill!.slice(0, colon) : null;
  const from = params.get('from');
  const to = params.get('to');
  return {
    period: isPeriod(period) ? period : DEFAULT_VIEW.period,
    ...(isPeriod(period) && period === 'custom' && from && DAY.test(from) ? { from } : {}),
    ...(isPeriod(period) && period === 'custom' && to && DAY.test(to) ? { to } : {}),
    group: isGroup(group) ? group : DEFAULT_VIEW.group,
    filters,
    ...(isGroup(by) ? { stack: by } : {}),
    metric: params.get('metric') === 'tokens' ? 'tokens' : 'cost',
    ...(isGroup(drillGroup) && drill ? { drill: { group: drillGroup, key: drill.slice(colon + 1) } } : {}),
  };
}

/** The view as the page's own URL query: what is at its default is left out. */
export function viewParams(view: AiView): URLSearchParams {
  const out = new URLSearchParams();
  if (view.period !== DEFAULT_VIEW.period) out.set('period', view.period);
  if (view.period === 'custom') {
    if (view.from) out.set('from', view.from);
    if (view.to) out.set('to', view.to);
  }
  if (view.group !== DEFAULT_VIEW.group) out.set('group', view.group);
  if (view.stack) out.set('by', view.stack);
  if (view.metric !== 'cost') out.set('metric', view.metric);
  for (const key of FILTER_KEYS) {
    const value = view.filters[key];
    if (value) out.set(key, value);
  }
  if (view.drill) out.set('drill', `${view.drill.group}:${view.drill.key}`);
  return out;
}

/** The report's query (`GET /api/insights/ai`): period, range, filters, and the previous period and stack when asked. */
export function reportQuery(view: AiView, options: { compare?: boolean; stack?: boolean } = {}): URLSearchParams {
  const out = new URLSearchParams({ period: view.period });
  if (view.period === 'custom') {
    if (view.from) out.set('from', view.from);
    if (view.to) out.set('to', view.to);
  }
  for (const key of FILTER_KEYS) {
    const value = view.filters[key];
    if (value) out.set(key, value);
  }
  if (options.compare) out.set('compare', '1');
  if (options.stack && view.stack) out.set('stack', view.stack);
  return out;
}

/** The query is askable: a custom range needs two good dates. */
export const viewReady = (view: AiView, today?: string): boolean => view.period !== 'custom' || !rangeProblem(view.from, view.to, today);

/** The instance's day, as the report that loaded last says it (the browser's can differ near midnight); none before a report. */
export const pageToday = (report?: { today?: string }): string | undefined => report?.today;

/**
 * The last day a custom range may end on, for the page's own message. The report's `today` once there is one; until then
 * (a deep link, or a first load the server refused) the day after the browser's, the furthest the instance's day can be
 * ahead, so a range plainly in the future gets the page's message and a valid one is never held back.
 */
export function rangeLimit(today: string | undefined, now: Date = new Date()): string {
  if (today) return today;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/** The page dims (and is busy) only while a changed view loads: not when it can't be asked (Custom with no good dates). */
export const pageStale = (loadedKey: string | undefined, key: string, ready: boolean): boolean => loadedKey !== undefined && loadedKey !== key && ready;

/**
 * The cache card's state: it asks only while the view is ready, and its last card is dimmed when the query changed (another
 * range, even one custom range to another) or can't be asked.
 */
export function cacheCardState(loadedQuery: string | undefined, query: string, ready: boolean): { ask: boolean; stale: boolean } {
  return { ask: ready, stale: loadedQuery !== undefined && (loadedQuery !== query || !ready) };
}

/** A row opens the sheet unless it is "Another …" (what the viewer can't open) or the tail past 50. */
export const drillable = (row: Pick<AiSpendRow, 'key'>): boolean => row.key !== 'shared' && row.key !== 'other';

export interface FilterChip {
  key: (typeof FILTER_KEYS)[number];
  label: string;
  value: string;
}

/** The filters as chips: the word for the filter and the name the report knows the value by (else the value). */
export function filterChips(filters: AiSpendFilters, groups?: Partial<Record<AiSpendGroup, Array<Pick<AiSpendRow, 'key' | 'label'>>>>): FilterChip[] {
  return FILTER_KEYS.flatMap((key) => {
    const raw = filters[key];
    if (!raw) return [];
    const word = FILTER_WORDS[key];
    const known = groups?.[word.group]?.find((r) => r.key === raw || r.key.endsWith(`/${raw}`));
    return [{ key, label: word.label, value: known?.label ?? raw }];
  });
}

/** The view without one filter. */
export function withoutFilter(view: AiView, key: FilterChip['key']): AiView {
  const filters = { ...view.filters };
  delete filters[key];
  return { ...view, filters };
}

const trendTokens = (p: Pick<AiSpendPoint, 'inputTokens' | 'outputTokens'>): number => p.inputTokens + p.outputTokens;

const zeroPoint = (at: string): AiSpendPoint => ({ at, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });

/** Every day of a day range is a point (a missing one is zero); an hourly series (24h) is left as it came. */
export function fillDays(series: AiSpendPoint[], from: string, to: string): AiSpendPoint[] {
  const days = rangeDays(from, to);
  if (!(days >= 1) || series.some((p) => !DAY.test(p.at))) return series;
  const byDay = new Map(series.map((p) => [p.at, p]));
  const start = dayNumber(from);
  return Array.from({ length: days }, (_, i) => {
    const at = dayText(start + i);
    return byDay.get(at) ?? zeroPoint(at);
  });
}

export interface TrendPoint {
  at: string;
  value: number;
}

export const trendPoints = (series: AiSpendPoint[], metric: TrendMetric): TrendPoint[] => series.map((p) => ({ at: p.at, value: metric === 'cost' ? p.cost : trendTokens(p) }));

export interface StackColumn {
  at: string;
  /** In the order of the stack's rows. */
  values: number[];
  total: number;
}

export const stackColumns = (stack: AiSpendStack, metric: TrendMetric): StackColumn[] =>
  stack.points.map((p) => {
    const values = (metric === 'cost' ? p.cost : p.tokens).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    return { at: p.at, values, total: values.reduce((a, b) => a + b, 0) };
  });

/** A stack's colours by position (the house categorical order, never cycled); "Other" is grey. */
export const STACK_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'] as const;
export const OTHER_COLOR = 'var(--t3)';
export const stackColor = (row: { key: string }, index: number): string => (row.key === 'other' || index >= STACK_COLORS.length ? OTHER_COLOR : STACK_COLORS[index]);

/** What the stack covers, said under the chart (D1: the person stack is everyone's). */
export const stackScopeNote = (scope: AiSpendStack['scope']): string => (scope === 'everyone' ? 'Everyone’s spend, by person.' : 'What you can see.');

export const trendValue = (value: number, metric: TrendMetric): string => (metric === 'cost' ? formatCost(value) : `${formatTokens(Math.round(value))} tokens`);

/** A point's label: the day for a day (`Nov 3`), the hour for an hour. */
export function pointLabel(at: string, long = false): string {
  if (DAY.test(at)) {
    const [y, m, d] = at.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A run's or call's moment: date and time both in the viewer's local zone (never the UTC date with a local time). */
export function momentLabel(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export interface Mover {
  group: AiSpendGroup;
  key: string;
  label: string;
  cost: number;
  previousCost: number;
}

export interface MoverRow extends Mover {
  delta: number;
}

/** Rises (largest first) and falls (largest first) by the change in cost; a row that didn't move is in neither. */
export function moverLists(movers: Mover[]): { rises: MoverRow[]; falls: MoverRow[] } {
  const rows = movers.map((m) => ({ ...m, delta: m.cost - m.previousCost }));
  return {
    rises: rows.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta || a.label.localeCompare(b.label)).slice(0, 5),
    falls: rows.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta || a.label.localeCompare(b.label)).slice(0, 5),
  };
}

/** `+$1.20` or `−$0.40`. */
export const formatDelta = (delta: number): string => `${delta < 0 ? '−' : '+'}${formatCost(Math.abs(delta))}`;

/** What the viewer can't open behind a list: a count and, when calls were behind it, their cost; never a name. */
export function hiddenLine(hidden: AiSpendHidden): string | undefined {
  if (hidden.runs <= 0 && hidden.calls <= 0) return undefined;
  const runs = hidden.runs > 0 ? `${hidden.runs} run${hidden.runs === 1 ? '' : 's'} you can’t open` : `${hidden.calls} call${hidden.calls === 1 ? '' : 's'} you can’t open`;
  return hidden.calls > 0 ? `${runs}: ${formatCost(hidden.cost)}` : runs;
}

/** The sheet's query: the page's report query plus the row it opened from. */
export function drillQuery(view: AiView, target: { group: AiSpendGroup; key: string }, extra: Record<string, string> = {}): URLSearchParams {
  const out = reportQuery(view);
  out.set('group', target.group);
  out.set('key', target.key);
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
}

/** The rows of the group the sheet opened from, for its title. */
export const drillLabel = (report: Pick<AiSpendReport, 'groups'> | undefined, target: { group: AiSpendGroup; key: string }): string =>
  report?.groups[target.group]?.find((r) => r.key === target.key)?.label ?? AI_GROUPS.find((g) => g.value === target.group)?.label ?? target.key;

/**
 * A row's link that only sets a filter (a person row's `/insights/ai?userId=<id>`) keeps the page's own view: period,
 * range, group and the other filters stay, and the filter is added. Any other link is returned as it is.
 */
export function applyFilterHref(view: AiView, href: string): string {
  if (!href.startsWith('/insights/ai?')) return href;
  const set = new URLSearchParams(href.slice(href.indexOf('?') + 1));
  const filters = { ...view.filters };
  let touched = false;
  for (const key of FILTER_KEYS) {
    const value = set.get(key);
    if (value) {
      (filters as Record<string, string>)[key] = value;
      touched = true;
    }
  }
  if (!touched) return href;
  const query = viewParams({ ...view, filters, drill: undefined }).toString();
  return query ? `/insights/ai?${query}` : '/insights/ai';
}
