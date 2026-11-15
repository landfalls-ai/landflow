'use client';
/**
 * Insights → AI (docs/llm-gateway.md, "The AI page"): spend and tokens for the period, spend by project, agent, person,
 * model and source, the caps and how near each is, the requests for more, and the gateway. The report holds only what
 * the viewer may see. On a phone each row is a card; desktop shows tables in cards like the other Insights pages.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { AI_GROUPS, AI_PERIODS, rowModel, totalTokens } from '@/lib/client/ai-console';
import { formatCache, formatCost, formatTokens } from '@/lib/shared/ai-usage';
import type { AiConsoleGroup, AiConsolePeriod, AiConsoleReport, AiConsoleRow, GatewayStatus } from '@/lib/shared/llm-gateway';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Segmented } from '@/components/ui/segmented';
import { StatCard } from '@/components/ui/stat-card';
import { SectionLabel } from '@/components/ui/inputs';
import { CapsCard, RequestsCard } from './ai-console-caps';
import { GatewayCard } from './ai-console-gateway';

const REFRESH_MS = 60_000;

function Label({ row }: { row: ReturnType<typeof rowModel> }) {
  return row.href ? (
    <Link href={row.href} className="text-t1 hover:text-ac hover:underline">
      {row.label}
    </Link>
  ) : (
    <span className="text-t1">{row.label}</span>
  );
}

function ShareBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-nudim" aria-hidden>
      <div className="h-full rounded-full bg-ac" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SpendBy({ rows, label }: { rows: AiConsoleRow[]; label: string }) {
  const models = rows.map(rowModel);
  if (models.length === 0) return <p className="px-4 py-4 text-[13px] text-t3">Nothing to show for this period.</p>;
  return (
    <>
      <table className="w-full border-collapse text-[13px] max-md:hidden">
        <thead>
          <tr className="border-b border-hair text-left text-[11px] uppercase tracking-wide text-t3">
            <th className="px-4 py-2 font-semibold">{label}</th>
            <th className="px-3 py-2 text-right font-semibold">Cost</th>
            <th className="px-3 py-2 text-right font-semibold">Tokens</th>
            <th className="px-3 py-2 text-right font-semibold">Calls</th>
            <th className="w-[26%] px-4 py-2 font-semibold">Share</th>
          </tr>
        </thead>
        <tbody>
          {models.map((row) => (
            <tr key={row.key} className="border-b border-hair last:border-0">
              <td className="max-w-[320px] truncate px-4 py-2.5" title={row.label}>
                <Label row={row} />
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-t1">{row.cost}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-t2" title={row.tokenDetail}>
                {row.tokens}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-t2">{row.calls}</td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <ShareBar percent={row.bar} />
                  <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-t3">{row.share}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="hidden flex-col divide-y divide-hair max-md:flex">
        {models.map((row) => (
          <li key={row.key} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 break-words text-[14px] font-medium">
                <Label row={row} />
              </span>
              <span className="text-[14px] font-semibold tabular-nums text-t1">{row.cost}</span>
            </div>
            <div className="flex items-baseline gap-3 text-[12px] text-t3">
              <span className="min-w-0 flex-1">
                {row.tokens} · {row.calls}
              </span>
              <span className="tabular-nums">{row.share}</span>
            </div>
            <ShareBar percent={row.bar} />
          </li>
        ))}
      </ul>
    </>
  );
}

export function Totals({ report }: { report?: AiConsoleReport }) {
  const totals = report?.totals;
  const cache = totals ? formatCache(totals) : '';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <StatCard index={0} label="AI cost (est.)" value={totals ? formatCost(totals.cost) : '–'} />
      <StatCard
        index={1}
        label="Tokens"
        value={totals ? formatTokens(totalTokens(totals)) : '–'}
        sub={totals ? <span title="Input and output">{`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out${cache ? ` · cached ${cache}` : ''}`}</span> : undefined}
      />
      <StatCard index={2} label="Calls" value={totals ? totals.calls.toLocaleString('en-US') : '–'} className="max-md:col-span-2" />
    </div>
  );
}

export function AiConsole() {
  const [period, setPeriod] = useState<AiConsolePeriod>('7d');
  const [group, setGroup] = useState<AiConsoleGroup>('project');
  const [report, setReport] = useState<AiConsoleReport>();
  const [status, setStatus] = useState<GatewayStatus>();
  const [error, setError] = useState<string>();
  const requestId = useRef(0);

  const load = useCallback(
    (background = false) => {
      const mine = ++requestId.current;
      api<AiConsoleReport>(`/api/insights/ai?period=${period}`, { background })
        .then((r) => {
          if (mine !== requestId.current) return;
          setReport(r);
          setError(undefined);
        })
        .catch((e: Error) => {
          if (mine === requestId.current) setError(e.message);
        });
      api<GatewayStatus>('/api/llm-gateway/status', { background })
        .then(setStatus)
        .catch(() => {});
    },
    [period],
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const shown = report?.period === period ? report : undefined;
  const label = AI_GROUPS.find((g) => g.value === group)!.label;
  return (
    <>
      <PageHeader title="AI" meta={shown && <span>Estimated from the price table · {shown.viewer.admin ? 'everything' : 'what you can see'}</span>} actions={<Segmented label="Period" options={AI_PERIODS} value={period} onChange={setPeriod} />} />
      <PageBody className="flex max-w-[1240px] flex-col gap-4">
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        <Totals report={shown} />
        {shown && shown.totals.calls === 0 && <p className="text-[13px] text-t3">No AI calls in this period.</p>}
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hair px-4 py-2.5">
            <SectionLabel>Spend by</SectionLabel>
            <Segmented label="Spend by" options={AI_GROUPS} value={group} onChange={setGroup} stretch className="ml-auto max-md:ml-0 max-md:w-full" />
          </div>
          {shown ? <SpendBy rows={shown.groups[group]} label={label} /> : <div className="m-4 h-24 rounded-xl bg-acdim animate-pulse-soft" />}
        </Card>
        {shown && <CapsCard report={shown} onChanged={() => load()} />}
        {shown && <RequestsCard report={shown} onChanged={() => load()} />}
        <GatewayCard status={status} admin={Boolean(shown?.viewer.admin)} />
      </PageBody>
    </>
  );
}
