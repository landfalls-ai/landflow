/** Pure helpers for the AI page (components/insights/ai-console*.tsx): formatting, sorting and the near-cap colour. */
import { formatCost, formatTokens } from '../shared/ai-usage';
import type { AiConsoleCap, AiConsoleGroup, AiConsolePeriod, AiConsoleRow, AiConsoleTotals, CapRaiseStatus, GatewayHealth } from '../shared/llm-gateway';

export const AI_PERIODS: Array<{ value: AiConsolePeriod; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export const AI_GROUPS: Array<{ value: AiConsoleGroup; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'agent', label: 'Agent' },
  { value: 'person', label: 'Person' },
  { value: 'model', label: 'Model' },
  { value: 'source', label: 'Source' },
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
  };
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
