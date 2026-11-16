/**
 * `my_ai_spend`'s text (SP14): the caller's own AI spend as short lines (today, this month, the period by model and by
 * purpose, each of their caps with its forecast or pace). Names, numbers and labels only: no prompt text, never a
 * colleague's row.
 */
import type { AiMySpend, AiSpendRow, AiSpendTotals } from '../../shared/ai-spend';
import { formatCost } from '../../shared/ai-usage';

const count = (n: number) => n.toLocaleString('en-US');
const unpriced = (t: AiSpendTotals) => (t.unpricedCalls > 0 ? `, ${t.unpricedCalls} not priced` : '');
const totals = (t: AiSpendTotals) => `${formatCost(t.cost)} (${count(t.calls)} ${t.calls === 1 ? 'call' : 'calls'}, ${count(t.inputTokens)} in / ${count(t.outputTokens)} out tokens${unpriced(t)})`;
const SHOWN = 10;
const rows = (list: AiSpendRow[]) =>
  list.length === 0
    ? ['  none']
    : [...list.slice(0, SHOWN).map((r) => `  ${r.label}: ${totals(r)}`), ...(list.length > SHOWN ? [`  and ${list.length - SHOWN} more (all of them are in the JSON)`] : [])];
const amount = (metric: 'cost' | 'tokens', n: number) => (metric === 'cost' ? formatCost(n) : `${count(Math.round(n))} tokens`);

function capLine(cap: AiMySpend['caps'][number]): string {
  const base = `${cap.subject}, ${cap.period === 'day' ? 'daily' : 'monthly'}: ${amount(cap.metric, cap.used)} of ${amount(cap.metric, cap.max)}`;
  if (cap.forecast) {
    const reach = cap.reachesOn ? `; reaches the cap on ${cap.reachesOn}` : '; stays under the cap';
    return `${base}; forecast ${amount(cap.metric, cap.forecast.p50)} by month end${cap.forecast.early ? ' (early)' : ''}${reach}`;
  }
  if (cap.pace !== undefined) return `${base}; at today's pace ${amount(cap.metric, cap.pace)} by the end of the day`;
  return base;
}

export function mySpendText(spend: AiMySpend): string {
  const lines = [
    `Your AI spend (${spend.period}, ${spend.from} to ${spend.to}); only your own calls.`,
    `Today: ${totals(spend.today)}`,
    `This month: ${totals(spend.month)}`,
    'By model:',
    ...rows(spend.byModel),
    'By purpose:',
    ...rows(spend.byPurpose),
    'Your caps:',
    ...(spend.caps.length === 0 ? ['  none'] : spend.caps.map((cap) => `  ${capLine(cap)}`)),
  ];
  return lines.join('\n');
}
