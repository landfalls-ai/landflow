'use client';
/**
 * /insights: how the workflows have been doing over the last 24 hours, 7 or 30
 * days — runs, failures, failure rate, time saved and run time against the
 * period before, runs per hour or day, and a row per workflow. Manual runs
 * (editor and chat tests) are left out unless "Include manual runs" is on.
 * The estimated AI cost of the workflows' model calls (/api/insights/ai-usage)
 * comes alongside, test runs included.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { InsightsPeriod, InsightsReport, InsightsTotals } from '@/lib/shared/platform';
import { EMPTY_USAGE, formatCache, formatCost, formatTokens, type AiUsageReport, type AiUsageTotals } from '@/lib/shared/ai-usage';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionLabel, Switch } from '@/components/ui/inputs';
import { change, formatMinutes, formatRate, formatRunTime } from '@/components/insights/format';
import { FAILED_COLOR, RunsChart, SUCCEEDED_COLOR } from '@/components/insights/runs-chart';
import { BrainPanel } from '@/components/brain/brain-panel';
import { WorkflowTable } from '@/components/insights/workflow-table';
import { AgentLayersCard } from '@/components/insights/agent-layers-card';

const PERIODS: { value: InsightsPeriod; label: string; previous: string; days: number }[] = [
  { value: '24h', label: '24 hours', previous: 'previous 24 hours', days: 1 },
  { value: '7d', label: '7 days', previous: 'previous 7 days', days: 7 },
  { value: '30d', label: '30 days', previous: 'previous 30 days', days: 30 },
];

/** The workflows' AI usage in the period: per workflow, and summed. */
interface PeriodUsage {
  period: InsightsPeriod;
  byWorkflow: Record<string, AiUsageTotals>;
  total: AiUsageTotals;
}

function CostKpi({ usage, index }: { usage?: PeriodUsage; index: number }) {
  if (!usage) {
    return (
      <Card>
        <SectionLabel>AI cost (est.)</SectionLabel>
        <div className="mt-2 h-[26px] w-20 rounded bg-acdim animate-pulse-soft" />
        <div className="mt-2 h-3 w-28 rounded bg-acdim animate-pulse-soft" />
      </Card>
    );
  }
  const { total } = usage;
  return (
    <Card className="animate-fade-up" style={{ animationDelay: `${index * 50}ms` }}>
      <SectionLabel>AI cost (est.)</SectionLabel>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums text-t1" title="Estimated from the price table in Settings → AI prices; test runs included">
        {formatCost(total.cost)}
      </div>
      <div className="mt-2 truncate text-[12px] text-t3" title={`${total.inputTokens.toLocaleString()} input + ${total.outputTokens.toLocaleString()} output tokens`}>
        {formatTokens(total.inputTokens + total.outputTokens)} tokens · {total.calls.toLocaleString()} model call{total.calls === 1 ? '' : 's'}
      </div>
      {formatCache(total) && (
        <div className="mt-0.5 truncate text-[11px] text-t3" title="Input tokens served from the provider’s cache (read) or written to it, priced with the cache prices">
          cached: {formatCache(total)}
        </div>
      )}
    </Card>
  );
}

type Metric = 'runs' | 'failed' | 'failureRate' | 'timeSavedMinutes' | 'avgDurationMs';

const KPIS: { metric: Metric; label: string; format: (t: InsightsTotals) => string }[] = [
  { metric: 'runs', label: 'Runs', format: (t) => t.runs.toLocaleString() },
  { metric: 'failed', label: 'Failed runs', format: (t) => t.failed.toLocaleString() },
  { metric: 'failureRate', label: 'Failure rate', format: (t) => formatRate(t.failureRate) },
  { metric: 'timeSavedMinutes', label: 'Time saved', format: (t) => formatMinutes(t.timeSavedMinutes) },
  { metric: 'avgDurationMs', label: 'Avg run time', format: (t) => formatRunTime(t.avgDurationMs) },
];

function Kpi({ label, value, metric, report, index, previousLabel }: { label: string; value: string; metric: Metric; report: InsightsReport; index: number; previousLabel: string }) {
  const delta = change(metric, report.current, report.previous);
  const Icon = delta.direction > 0 ? ArrowUp : delta.direction < 0 ? ArrowDown : Minus;
  const before = KPIS.find((k) => k.metric === metric)!.format(report.previous);
  return (
    <Card className="animate-fade-up" style={{ animationDelay: `${index * 50}ms` }}>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums text-t1">{value}</div>
      <div className="mt-2 flex items-center gap-1 text-[12px]" title={`${previousLabel}: ${before}`}>
        <span className={cn('inline-flex items-center gap-0.5 font-medium', delta.trend === 'good' ? 'text-gn' : delta.trend === 'bad' ? 'text-rd' : 'text-t2')}>
          <Icon className="size-3" strokeWidth={2.4} />
          {delta.text}
        </span>
        <span className="truncate text-t3">vs {previousLabel}</span>
      </div>
    </Card>
  );
}

export default function InsightsPage() {
  const [period, setPeriod] = useState<InsightsPeriod>('7d');
  const [includeManual, setIncludeManual] = useState(false);
  const [report, setReport] = useState<InsightsReport>();
  const [error, setError] = useState<string>();
  const [usage, setUsage] = useState<PeriodUsage>();

  const load = useCallback(() => {
    api<InsightsReport>(`/api/insights?period=${period}&includeManual=${includeManual}`)
      .then((r) => {
        setReport(r);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, [period, includeManual]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const days = PERIODS.find((p) => p.value === period)!.days;
    api<AiUsageReport>(`/api/insights/ai-usage?group=workflow&days=${days}`)
      .then((r) => {
        const byWorkflow: Record<string, AiUsageTotals> = {};
        const total = { ...EMPTY_USAGE };
        for (const { workflowId, ...totals } of r.workflows ?? []) {
          byWorkflow[workflowId] = totals;
          total.inputTokens += totals.inputTokens;
          total.outputTokens += totals.outputTokens;
          total.cost += totals.cost;
          total.calls += totals.calls;
          if (totals.cacheReadTokens) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + totals.cacheReadTokens;
          if (totals.cacheWriteTokens) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + totals.cacheWriteTokens;
        }
        setUsage({ period, byWorkflow, total });
      })
      // Usage is extra: the page works without it.
      .catch(() => setUsage({ period, byWorkflow: {}, total: { ...EMPTY_USAGE } }));
  }, [period]);

  const meta = PERIODS.find((p) => p.value === period)!;
  const shown = report?.period === period && report.includeManual === includeManual ? report : undefined;
  const shownUsage = usage?.period === period ? usage : undefined;
  const noTimeSaved = shown && shown.workflows.length > 0 && shown.workflows.every((w) => w.minutesSavedPerRun === undefined);

  return (
    <>
      <PageHeader
        title="Insights"
        meta={report && <span>{includeManual ? 'All runs' : 'Production runs'} · days in {report.timezone}</span>}
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-t2" title="Manual runs are test runs from the editor and the chat panel">
              <Switch checked={includeManual} onChange={setIncludeManual} label="Include manual runs" />
              Include manual runs
            </label>
            <div role="tablist" aria-label="Period" className="flex items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  role="tab"
                  aria-selected={period === p.value}
                  onClick={() => setPeriod(p.value)}
                  className={cn(
                    'flex h-7 items-center rounded-full px-3.5 text-[13px] text-t2 transition-all duration-200 hover:text-t1',
                    period === p.value && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        }
      />
      <PageBody className="flex max-w-[1240px] flex-col gap-4">
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {KPIS.map((kpi, index) =>
            shown ? (
              <Kpi key={`${kpi.metric}-${period}-${includeManual}`} label={kpi.label} value={kpi.format(shown.current)} metric={kpi.metric} report={shown} index={index} previousLabel={meta.previous} />
            ) : (
              <Card key={kpi.metric}>
                <SectionLabel>{kpi.label}</SectionLabel>
                <div className="mt-2 h-[26px] w-20 rounded bg-acdim animate-pulse-soft" />
                <div className="mt-2 h-3 w-28 rounded bg-acdim animate-pulse-soft" />
              </Card>
            ),
          )}
          <CostKpi key={`cost-${period}`} usage={shownUsage} index={KPIS.length} />
        </div>

        <AgentLayersCard days={meta.days} label={meta.label} />

        <Card className="px-4 pb-3 pt-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <SectionLabel>Runs per {period === '24h' ? 'hour' : 'day'}</SectionLabel>
            <div className="ml-auto flex items-center gap-3 text-[12px] text-t2">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px]" style={{ background: SUCCEEDED_COLOR }} /> Succeeded
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px]" style={{ background: FAILED_COLOR }} /> Failed
              </span>
            </div>
          </div>
          {shown ? <RunsChart series={shown.series} period={period} /> : <div className="h-[232px] rounded-xl bg-acdim animate-pulse-soft" />}
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="flex h-11 items-center gap-3 border-b border-hair px-4">
            <SectionLabel>By workflow</SectionLabel>
            {noTimeSaved && <span className="truncate text-[12px] text-t3">Set how many minutes a run saves to see time saved.</span>}
          </div>
          {shown && shown.workflows.length > 0 && <WorkflowTable rows={shown.workflows} usage={shownUsage?.byWorkflow} onChanged={load} />}
          {shown && !shown.workflows.length && (
            <EmptyState
              compact
              className="py-10"
              title={`No workflow finished a run in the last ${meta.label}`}
              hint={includeManual ? 'Runs appear here as soon as they finish.' : 'Test runs from the editor and the chat panel are left out — turn on “Include manual runs” to count them.'}
            />
          )}
        </Card>

        <BrainPanel />

        <p className="text-[12px] leading-relaxed text-t3">
          Insights are counted as runs finish and kept for 400 days, apart from execution history, so pruning executions doesn’t change them. Time saved is the
          successful runs times the minutes a run saves, which you set per workflow above. AI cost is estimated per model call from the price table in Settings → AI
          prices (local models such as Ollama cost nothing unless priced there) and includes test runs.
        </p>
      </PageBody>
    </>
  );
}
