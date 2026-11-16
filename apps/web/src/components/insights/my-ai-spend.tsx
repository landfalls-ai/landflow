'use client';
/**
 * The You card, first on the AI page for everyone (docs/llm-gateway.md, "The AI page"): your own AI spend today, this
 * month and in the page's period, the models you used (a local model nobody priced says "Not priced" and ranks by
 * tokens) and your own caps. Only your rows and your caps: the rest of the page is everyone's, by name.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { capPeriodLabel, formatCapAmount, formatPercent, totalTokens } from '@/lib/client/ai-console';
import { formatCost, formatTokens } from '@/lib/shared/ai-usage';
import type { AiMySpend, AiSpendRow } from '@/lib/shared/ai-spend';
import type { AiConsolePeriod } from '@/lib/shared/llm-gateway';
import { Card } from '@/components/shell/page-header';
import { SectionLabel } from '@/components/ui/inputs';
import { CapBar } from './ai-console-caps';

const LIMIT = 5;

const tokens = (row: Pick<AiSpendRow, 'inputTokens' | 'outputTokens'>) => `${formatTokens(totalTokens(row))} tokens`;

/** Priced models by cost, then the unpriced ones by tokens, so a local model nobody priced is not lost under $0. */
export function youModels(rows: AiSpendRow[]): AiSpendRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost || totalTokens(b) - totalTokens(a) || a.label.localeCompare(b.label)).slice(0, LIMIT);
}

export function MyAiSpend({ period }: { period: AiConsolePeriod }) {
  const [spend, setSpend] = useState<AiMySpend>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<AiMySpend>(`/api/insights/ai/me?period=${period}`)
      .then((r) => live && (setSpend(r), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [period]);

  if (failed) return null;
  if (!spend) return <div className="h-32 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  const periodTotal = spend.series.reduce((sum, p) => ({ cost: sum.cost + p.cost, tokens: sum.tokens + p.inputTokens + p.outputTokens, calls: sum.calls + p.calls }), { cost: 0, tokens: 0, calls: 0 });
  const models = youModels(spend.byModel);
  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SectionLabel>You</SectionLabel>
        <span className="text-[12px] text-t3">Your own AI calls only</span>
      </div>
      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <Figure label="Today" cost={spend.today.cost} sub={`${tokens(spend.today)} · ${spend.today.calls.toLocaleString('en-US')} call${spend.today.calls === 1 ? '' : 's'}`} />
        <Figure label="This month" cost={spend.month.cost} sub={`${tokens(spend.month)} · ${spend.month.calls.toLocaleString('en-US')} call${spend.month.calls === 1 ? '' : 's'}`} />
        <Figure label="This period" cost={periodTotal.cost} sub={`${formatTokens(periodTotal.tokens)} tokens · ${periodTotal.calls.toLocaleString('en-US')} call${periodTotal.calls === 1 ? '' : 's'}`} />
      </div>
      {models.length > 0 && (
        <ul className="mt-3 divide-y divide-hair border-t border-hair text-[13px]">
          {models.map((row) => (
            <li key={row.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
              <span className="min-w-0 flex-1 break-words text-t1">
                {row.label}
                {row.unpriced && (
                  <span className="ml-2 whitespace-nowrap rounded-full border border-hair px-1.5 py-px text-[11px] text-t3" title="No price for this model: its calls count as $0">
                    Not priced
                  </span>
                )}
              </span>
              <span className="tabular-nums text-t3">{tokens(row)}</span>
              <span className="w-16 text-right font-semibold tabular-nums text-t1">{formatCost(row.cost)}</span>
            </li>
          ))}
        </ul>
      )}
      {spend.caps.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2.5 border-t border-hair pt-3">
          {spend.caps.map((cap) => (
            <li key={cap.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                <span className="text-t1">Your cap {capPeriodLabel(cap.period)}</span>
                <span className="ml-auto tabular-nums text-t2">
                  {formatCapAmount(cap, cap.used)} of {formatCapAmount(cap, cap.max)} · {formatPercent(cap.ratio)}
                </span>
              </div>
              <CapBar cap={cap} />
            </li>
          ))}
        </ul>
      )}
      {spend.today.calls === 0 && spend.month.calls === 0 && models.length === 0 && <p className="mt-2 text-[13px] text-t3">You have not made an AI call this month.</p>}
    </Card>
  );
}

function Figure({ label, cost, sub }: { label: string; cost: number; sub: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[12px] text-t3">{label}</span>
      <span className="text-[22px] font-semibold tabular-nums text-t1">{formatCost(cost)}</span>
      <span className="text-[12px] tabular-nums text-t3">{sub}</span>
    </div>
  );
}
