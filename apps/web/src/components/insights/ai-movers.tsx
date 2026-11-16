'use client';
/**
 * The AI page's movers: the five biggest rises and the five biggest falls in cost against the period before, across every
 * group (docs/llm-gateway.md, "The AI page"). A row opens its runs. Never an "Another …", "Other" or "No …" row: the report
 * leaves those out.
 */
import { AI_GROUPS, formatDelta, moverLists, type MoverRow } from '@/lib/client/ai-console';
import { formatCost } from '@/lib/shared/ai-usage';
import type { AiSpendGroup, AiSpendReport } from '@/lib/shared/ai-spend';
import { cn } from '@/lib/utils';

const groupWord = (group: AiSpendGroup) => AI_GROUPS.find((g) => g.value === group)?.label ?? group;

function MoverList({ title, rows, tone, onOpen }: { title: string; rows: MoverRow[]; tone: 'up' | 'down'; onOpen?: (row: MoverRow) => void }) {
  return (
    <div className="min-w-0 flex-1">
      <h3 className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-t3">{title}</h3>
      {rows.length === 0 ? (
        <p className="px-4 pb-3 text-[13px] text-t3">Nothing {tone === 'up' ? 'rose' : 'fell'}.</p>
      ) : (
        <ul className="divide-y divide-hair">
          {rows.map((row) => (
            <li key={`${row.group}:${row.key}`}>
              <button type="button" onClick={() => onOpen?.(row)} className="flex min-h-11 w-full items-baseline gap-2 px-4 py-2 text-left text-[13px] hover:bg-acdim">
                <span className="min-w-0 flex-1 truncate text-t1" title={row.label}>
                  {row.label}
                  <span className="ml-1.5 text-[11px] text-t3">{groupWord(row.group)}</span>
                </span>
                <span className="shrink-0 tabular-nums text-t3">
                  {formatCost(row.previousCost)} → {formatCost(row.cost)}
                </span>
                <span className={cn('w-[72px] shrink-0 text-right font-semibold tabular-nums', tone === 'up' ? 'text-warn' : 'text-gn')}>{formatDelta(row.delta)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiMovers({ movers, onOpen }: { movers: AiSpendReport['movers']; onOpen?: (row: MoverRow) => void }) {
  const { rises, falls } = moverLists(movers ?? []);
  if (rises.length === 0 && falls.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-[14px] border border-hair bg-sf" data-testid="ai-movers" aria-label="Movers">
      <div className="flex flex-col divide-hair md:flex-row md:divide-x max-md:divide-y">
        <MoverList title="Biggest rises" rows={rises} tone="up" onOpen={onOpen} />
        <MoverList title="Biggest falls" rows={falls} tone="down" onOpen={onOpen} />
      </div>
      <p className="border-t border-hair px-4 py-2 text-[12px] text-t3">Against the period before, by cost. Click one to see its runs.</p>
    </section>
  );
}
