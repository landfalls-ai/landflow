'use client';
/**
 * Insights → AI (docs/llm-gateway.md, "The AI page"): spend and tokens for the period, spend by project, agent, person,
 * model and source, the caps and how near each is, the requests for more, and the gateway. The report holds only what
 * the viewer may see. On a phone each row is a card; desktop shows tables in cards like the other Insights pages.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { api } from '@/lib/client/api';
import { AI_GROUPS, AI_PERIODS, drillLabel, drillable, fillDays, filterChips, parseView, previousRange, rangeDays, rangeProblem, reportQuery, rowModel, totalTokens, viewParams, viewReady, withoutFilter, type AiView } from '@/lib/client/ai-console';
import { formatCache, formatCost, formatTokens } from '@/lib/shared/ai-usage';
import type { AiConsoleReport, AiConsoleRow, AiConsoleTotals, GatewayStatus } from '@/lib/shared/llm-gateway';
import type { AiPageReport, AiSpendGroup, AiSpendPeriod, AiSpendPoint } from '@/lib/shared/ai-spend';
import { cn } from '@/lib/utils';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Segmented } from '@/components/ui/segmented';
import { StatCard } from '@/components/ui/stat-card';
import { Input, SectionLabel, Select } from '@/components/ui/inputs';
import { CapsCard, RequestsCard } from './ai-console-caps';
import { GatewayCard } from './ai-console-gateway';
import { AiDrill } from './ai-drill';
import { AiMovers } from './ai-movers';
import { AiTrend } from './ai-trend';

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

export function SpendBy({ rows, label, onOpen }: { rows: AiConsoleRow[]; label: string; onOpen?: (row: AiConsoleRow) => void }) {
  // SP10: a click on a row (not on a link in it) opens its runs; a button keeps that reachable by keyboard.
  const openable = (row: AiConsoleRow) => Boolean(onOpen) && drillable(row);
  const rowClick = (row: AiConsoleRow) => (e: React.MouseEvent) => {
    if (openable(row) && !(e.target as HTMLElement).closest('a,button')) onOpen!(row);
  };
  const byKey = new Map(rows.map((r) => [r.key, r]));
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
            {onOpen && <th className="w-10 px-2 py-2" aria-label="Runs" />}
          </tr>
        </thead>
        <tbody>
          {models.map((row) => (
            <tr key={row.key} onClick={rowClick(byKey.get(row.key)!)} className={cn('border-b border-hair last:border-0', openable(byKey.get(row.key)!) && 'cursor-pointer hover:bg-acdim')}>
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
              {onOpen && (
                <td className="px-2 py-2.5 text-right">
                  {openable(byKey.get(row.key)!) && (
                    <button type="button" onClick={() => onOpen(byKey.get(row.key)!)} aria-label={`Runs behind ${row.label}`} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
                      <ChevronRight className="size-4" />
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="hidden flex-col divide-y divide-hair max-md:flex">
        {models.map((row) => (
          <li key={row.key} onClick={rowClick(byKey.get(row.key)!)} className={cn('flex flex-col gap-1.5 px-4 py-3', openable(byKey.get(row.key)!) && 'cursor-pointer')}>
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

/**
 * SP20 (D1): the person group is everyone's, whatever the page's own totals above can open. An owner or admin sees
 * everything, so the page's totals already are this total: for them the line is the caption alone, not the same figure twice.
 */
export function PeopleTotal({ totals, admin }: { totals: AiConsoleTotals; admin: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair px-4 py-2.5 text-[13px]">
      <span className="text-t2">Everyone&apos;s AI spend in this period, by person</span>
      {!admin && (
        <>
          <span className="font-semibold tabular-nums text-t1">{formatCost(totals.cost)}</span>
          <span className="tabular-nums text-t3">
            {formatTokens(totalTokens(totals))} tokens · {totals.calls.toLocaleString('en-US')} call{totals.calls === 1 ? '' : 's'}
          </span>
        </>
      )}
    </div>
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

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const asConsole = (r: AiPageReport) => r as AiConsoleReport;

export function AiConsole() {
  // SP10: the view (period, range, group, filters, stack, drill) lives in the URL, so a person row's link
  // (`/insights/ai?userId=<id>`), a reload and the Back button from a run all land on the same page.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = useMemo(() => parseView(params), [params]);
  const go = useCallback(
    (next: AiView) => {
      const query = viewParams(next).toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const today = localDay();
  const ready = viewReady(view, today);
  const key = reportQuery(view, { compare: true }).toString();
  const fullQuery = reportQuery(view, { compare: true, stack: true }).toString();

  const [loaded, setLoaded] = useState<{ key: string; report: AiPageReport }>();
  const [previous, setPrevious] = useState<{ key: string; series: AiSpendPoint[] }>();
  const [status, setStatus] = useState<GatewayStatus>();
  const [error, setError] = useState<string>();
  const requestId = useRef(0);

  const load = useCallback(
    (background = false) => {
      if (!ready) return;
      const mine = ++requestId.current;
      api<AiPageReport>(`/api/insights/ai?${fullQuery}`, { background })
        .then((r) => {
          if (mine !== requestId.current) return;
          setLoaded({ key, report: r });
          setError(undefined);
        })
        .catch((e: Error) => {
          if (mine === requestId.current) setError(e.message);
        });
      api<GatewayStatus>('/api/llm-gateway/status', { background })
        .then(setStatus)
        .catch(() => {});
    },
    [fullQuery, key, ready],
  );

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const shown = loaded?.key === key ? loaded.report : undefined;

  // The faint line: the days just before the range, asked as a custom range (the report holds only the previous totals).
  const prevRange = shown && shown.period !== '24h' && rangeDays(shown.from, shown.to) <= 90 ? previousRange(shown.from, shown.to) : undefined;
  const prevQuery = prevRange ? reportQuery({ ...view, period: 'custom', from: prevRange.from, to: prevRange.to }).toString() : undefined;
  useEffect(() => {
    if (!prevQuery || !prevRange) return;
    let alive = true;
    api<AiPageReport>(`/api/insights/ai?${prevQuery}`, { background: true })
      .then((r) => alive && setPrevious({ key: prevQuery, series: fillDays(r.series, prevRange.from, prevRange.to) }))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevQuery]);

  const label = AI_GROUPS.find((g) => g.value === view.group)!.label;
  const chips = shown ? filterChips(view.filters, shown.groups) : filterChips(view.filters);
  const problem = view.period === 'custom' ? rangeProblem(view.from, view.to, today) : undefined;
  const open = (group: AiSpendGroup, rowKey: string) => go({ ...view, drill: { group, key: rowKey } });
  return (
    <>
      <PageHeader
        title="AI"
        meta={shown && <span>Estimated from the price table · {shown.viewer.admin ? 'everything' : 'what you can open'}</span>}
        actions={<Segmented label="Period" options={AI_PERIODS} value={view.period} onChange={(period: AiSpendPeriod) => go({ ...view, period, drill: undefined })} />}
      />
      <PageBody className="flex max-w-[1240px] flex-col gap-4">
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {view.period === 'custom' && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-t2" data-testid="ai-range">
            <label className="flex items-center gap-2">
              From
              <Input type="date" value={view.from ?? ''} max={today} onChange={(e) => go({ ...view, from: e.target.value || undefined, drill: undefined })} className="h-8 w-[150px]" />
            </label>
            <label className="flex items-center gap-2">
              To
              <Input type="date" value={view.to ?? ''} max={today} onChange={(e) => go({ ...view, to: e.target.value || undefined, drill: undefined })} className="h-8 w-[150px]" />
            </label>
            <span className={problem ? 'text-warn' : 'text-t3'}>{problem ?? 'At most 400 days.'}</span>
          </div>
        )}
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Filters" data-testid="ai-chips">
            {chips.map((chip) => (
              <li key={chip.key}>
                <button type="button" onClick={() => go(withoutFilter(view, chip.key))} aria-label={`Remove the ${chip.label} filter: ${chip.value}`} className="inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border border-acbd bg-acdim px-3 text-[13px] text-t1 hover:border-ac">
                  <span className="text-t3">{chip.label}</span>
                  <span className="truncate font-semibold">{chip.value}</span>
                  <span aria-hidden className="text-t3">
                    ×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Totals report={shown && asConsole(shown)} />
        {shown && shown.totals.calls === 0 && <p className="text-[13px] text-t3">No AI calls in this period.</p>}
        {/* SP10: the trend and the movers */}
        {shown ? (
          <AiTrend report={shown} previousSeries={previous?.key === prevQuery ? previous?.series : undefined} metric={view.metric} onMetric={(metric) => go({ ...view, metric })} stack={view.stack} onStack={(stack) => go({ ...view, stack })} />
        ) : (
          ready && <div className="h-[260px] rounded-[14px] bg-acdim animate-pulse-soft" />
        )}
        {shown && <AiMovers movers={shown.movers} onOpen={(row) => open(row.group, row.key)} />}
        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hair px-4 py-2.5">
            <SectionLabel>Spend by</SectionLabel>
            <div className="ml-auto max-md:ml-0 max-md:w-full">
              <Select value={view.group} onChange={(e) => go({ ...view, group: e.target.value as AiSpendGroup, drill: undefined })} aria-label="Spend by" className="h-8 w-auto min-w-[150px] py-0 text-[13px] max-md:w-full">
                {AI_GROUPS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {shown && view.group === 'person' && <PeopleTotal totals={shown.peopleTotals} admin={shown.viewer.admin} />}
          {shown ? <SpendBy rows={shown.groups[view.group]} label={label} onOpen={(row) => open(view.group, row.key)} /> : <div className="m-4 h-24 rounded-xl bg-acdim animate-pulse-soft" />}
        </Card>
        {shown && <CapsCard report={asConsole(shown)} onChanged={() => load()} />}
        {shown && <RequestsCard report={asConsole(shown)} onChanged={() => load()} />}
        <GatewayCard status={status} admin={Boolean(shown?.viewer.admin)} />
      </PageBody>
      <AiDrill view={view} target={view.drill} title={view.drill ? drillLabel(shown, view.drill) : ''} chips={chips} onClose={() => go({ ...view, drill: undefined })} />
    </>
  );
}
