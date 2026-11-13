'use client';
/**
 * A workflow's Evaluations tab (n8n's shape): the editor-style top bar with the Editor | Executions |
 * Evaluations switch, the evaluation runs on the left (run number, status, per-metric averages) and on
 * the right the selected run: metric tiles with their trend over runs, then the per-case results, each
 * linking its execution. "Compare with" puts two runs side by side; "AI Agent grading" holds the online
 * evaluation settings and scores of the workflow's AI Agent nodes.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Bot, ChevronRight, CircleStop, ExternalLink, FlaskConical, GitCompareArrows, Play, Table2, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { duration } from '@/lib/client/format';
import type { Workflow } from '@/lib/shared/types';
import type {
  EvaluationCase,
  EvaluationCaseStatus,
  EvaluationComparison,
  EvaluationRunDetail,
  EvaluationRunStatus,
  EvaluationRunSummary,
  EvaluationsOverview,
  MetricSummary,
  WorkflowOnlineEvals,
} from '@/lib/shared/evaluations';
import { WorkflowTabs } from '../shell/workflow-tabs';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Checkbox, Select } from '../ui/inputs';
import { RUN_STATE, RunStateIcon, formatStamp, useNow, type RunState } from '../run/run-status';
import { FileDataset, ScheduleCard } from './dataset-schedule';
import { OnlineEvalPanel, type OnlineEvalPatch } from './online-eval-panel';

const POLL_MS = 1500;

/** Run and case statuses in the executions' colours ('pending' reads as queued). */
const stateOf = (status: EvaluationRunStatus | EvaluationCaseStatus): RunState => (status === 'pending' ? 'queued' : status);

const trim = (n: number, digits = 2) => n.toFixed(digits).replace(/\.?0+$/, '');

/** 1 → "1", 0.8333 → "0.83". */
export const formatMetric = (value?: number) => (value === undefined || Number.isNaN(value) ? '—' : Number.isInteger(value) ? String(value) : trim(value));

/** The scale a metric is drawn on: 0–1 for the built-in checks, 1–5 for the LLM judge, else its own maximum. */
export function metricScale(summary: Pick<MetricSummary, 'min' | 'max'>): { min: number; max: number } {
  if (summary.min >= 0 && summary.max <= 1) return { min: 0, max: 1 };
  if (summary.min >= 1 && summary.max <= 5) return { min: 1, max: 5 };
  return { min: Math.min(0, summary.min), max: Math.max(summary.max, 1) };
}

/** A value as a short line: strings as they are, the rest as JSON. */
function preview(value: unknown, max = 140): string {
  if (value === undefined || value === null || value === '') return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function previewRecord(record: Record<string, unknown>, max = 140): string {
  const entries = Object.entries(record);
  if (!entries.length) return '—';
  if (entries.length === 1) return preview(entries[0][1], max);
  return preview(entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · '), max);
}

function DeltaText({ delta, className }: { delta?: number; className?: string }) {
  if (delta === undefined) return <span className={cn('text-t3', className)}>—</span>;
  const tone = delta > 1e-9 ? 'text-gn' : delta < -1e-9 ? 'text-rd' : 'text-t3';
  return <span className={cn('tabular-nums', tone, className)}>{delta > 1e-9 ? '+' : ''}{formatMetric(delta)}</span>;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function RunCard({ run, selected, onClick, now }: { run: EvaluationRunSummary; selected: boolean; onClick: () => void; now: number }) {
  const state = stateOf(run.status);
  const live = run.status === 'running';
  const ms = live ? Math.max(0, now - Date.parse(run.startedAt)) : run.durationMs;
  const metrics = Object.entries(run.metrics).slice(0, 3);
  return (
    <button
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        'group relative block w-full overflow-hidden rounded-[10px] border border-l-[3px] px-3 py-2 text-left transition-[background-color,border-color,box-shadow,translate] duration-150',
        selected ? 'border-acbd bg-acdim shadow-[0_1px_0_var(--hair)]' : 'border-hair bg-sf hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(0,0,0,0.07)]',
        RUN_STATE[state].border,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold tabular-nums text-t1">Run #{run.number}</span>
        <span className="truncate text-[12px] tabular-nums text-t3">{formatStamp(run.startedAt)}</span>
        {run.trigger === 'schedule' && <span className="ml-auto shrink-0 rounded-md border border-hair bg-wl px-1.5 py-px text-[10px] text-t3">scheduled</span>}
      </div>
      <div className={cn('mt-0.5 flex items-center gap-1.5 text-[12px]', RUN_STATE[state].text)}>
        <RunStateIcon state={state} className="size-3" />
        <span className="truncate tabular-nums">
          {run.completed}/{run.total} cases{run.failed ? ` · ${run.failed} failed` : ''} · {duration(ms)}
        </span>
      </div>
      {metrics.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {metrics.map(([name, summary]) => (
            <span key={name} className="inline-flex items-center gap-1 rounded-md border border-hair bg-wl px-1.5 py-px text-[11px] text-t2">
              <span className="max-w-[90px] truncate">{name}</span>
              <span className="font-semibold tabular-nums text-t1">{formatMetric(summary.average)}</span>
            </span>
          ))}
        </div>
      )}
      {live && <div className="lf-shimmer absolute inset-x-0 bottom-0 h-[2px]" />}
    </button>
  );
}

function TriggerCard({ overview, workflowId }: { overview?: EvaluationsOverview; workflowId: string }) {
  if (!overview) return <div className="h-[58px] rounded-[10px] border border-hair bg-sf animate-pulse-soft" />;
  const { trigger } = overview;
  if (!trigger)
    return (
      <div className="rounded-[10px] border border-warnbd bg-warndim px-3 py-2 text-[12px] text-t2">
        <div className="flex items-center gap-1.5 font-semibold text-warn">
          <TriangleAlert className="size-3.5" /> No Evaluation Trigger
        </div>
        <p className="mt-0.5 leading-snug">
          Add one in the <Link href={`/workflows/${workflowId}`} className="text-ac hover:underline">editor</Link> and point it at a Data Table (or an uploaded CSV or JSON file) of test cases.
        </p>
      </div>
    );
  return (
    <div className="rounded-[10px] border border-hair bg-sf px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5 text-t1">
        <Table2 className="size-3.5 text-t3" />
        <span className="truncate font-semibold">{trigger.source === 'file' ? (trigger.dataTableName ?? 'No file uploaded') : (trigger.dataTableName ?? (trigger.dataTableId ? 'Missing table' : 'No table chosen'))}</span>
        {trigger.rows !== undefined && <span className="ml-auto shrink-0 tabular-nums text-t3">{trigger.maxRows ? `${Math.min(trigger.maxRows, trigger.rows)} of ${trigger.rows}` : trigger.rows} rows</span>}
      </div>
      <div className="mt-0.5 text-t3">
        {trigger.expectedColumn ? (
          <>
            Expected answers in <span className="font-mono text-t2">{trigger.expectedColumn}</span>
          </>
        ) : (
          'No expected-answer column'
        )}
      </div>
      {!overview.hasMetrics && <div className="mt-1 text-warn">No Evaluation node sets metrics: runs only collect outputs.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const [w, h] = [72, 22];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * w},${h - 2 - ((v - lo) / span) * (h - 4)}`).join('');
  return (
    <svg width={w} height={h} aria-hidden className="shrink-0 overflow-visible">
      <path d={d} fill="none" style={{ stroke: 'var(--viz-1)', strokeWidth: 1.5 }} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={h - 2 - ((values[values.length - 1] - lo) / span) * (h - 4)} r={2.5} style={{ fill: 'var(--viz-1)' }} />
    </svg>
  );
}

function MetricTile({ name, summary, previous, history }: { name: string; summary: MetricSummary; previous?: number; history: number[] }) {
  const scale = metricScale(summary);
  const fill = Math.max(0, Math.min(1, (summary.average - scale.min) / (scale.max - scale.min || 1)));
  return (
    <div className="min-w-0 rounded-[12px] border border-hair bg-sf px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-[12px] font-semibold text-t2" title={name}>
          {name}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-t3">{summary.count} cases</span>
      </div>
      <div className="mt-1 flex items-end gap-2">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-t1">{formatMetric(summary.average)}</span>
        <span className="pb-0.5 text-[11px] text-t3">/ {scale.max}</span>
        {previous !== undefined && <DeltaText delta={summary.average - previous} className="pb-0.5 text-[12px]" />}
        <span className="ml-auto">
          <Sparkline values={history} />
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-nudim">
        <div className="h-full rounded-full bg-viz-1 transition-[width] duration-500" style={{ width: `${fill * 100}%` }} />
      </div>
      <div className="mt-1 text-[11px] tabular-nums text-t3">
        min {formatMetric(summary.min)} · max {formatMetric(summary.max)}
      </div>
    </div>
  );
}

function ExecutionLink({ workflowId, executionId }: { workflowId: string; executionId?: string }) {
  if (!executionId) return <span className="text-t3">—</span>;
  return (
    <Link href={`/workflows/${workflowId}/executions/${executionId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-ac hover:underline">
      View <ExternalLink className="size-3" />
    </Link>
  );
}

function KeyValues({ title, record }: { title: string; record: Record<string, unknown> }) {
  const entries = Object.entries(record);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{title}</div>
      {entries.length ? (
        <dl className="space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="font-mono text-[11px] text-t3">{key}</dt>
              <dd className="whitespace-pre-wrap break-words text-[12px] text-t1">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[12px] text-t3">—</p>
      )}
    </div>
  );
}

function CaseRows({ item, metricNames, workflowId }: { item: EvaluationCase; metricNames: string[]; workflowId: string }) {
  const [open, setOpen] = useState(false);
  const state = stateOf(item.status);
  return (
    <>
      <tr onClick={() => setOpen(!open)} className={cn('cursor-pointer border-t border-hair transition-colors hover:bg-acdim', open && 'bg-acdim')}>
        <td className="py-2 pl-3 pr-2 align-top">
          <span className="flex items-center gap-1 tabular-nums text-t3">
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {item.index + 1}
          </span>
        </td>
        <td className="px-2 py-2 align-top">
          <span className={cn('inline-flex items-center gap-1', RUN_STATE[state].text)} title={item.error}>
            <RunStateIcon state={state} className="size-3" />
            {RUN_STATE[state].label}
          </span>
        </td>
        <td className="max-w-[220px] px-2 py-2 align-top text-t1">
          <span className="line-clamp-2 break-words">{previewRecord(item.inputs)}</span>
        </td>
        <td className="max-w-[180px] px-2 py-2 align-top text-t2">
          <span className="line-clamp-2 break-words">{preview(item.expected)}</span>
        </td>
        <td className="max-w-[220px] px-2 py-2 align-top text-t1">
          <span className="line-clamp-2 break-words">{item.error && !Object.keys(item.outputs).length ? <span className="text-rd">{item.error}</span> : previewRecord(item.outputs)}</span>
        </td>
        {metricNames.map((name) => (
          <td key={name} className="px-2 py-2 text-right align-top font-semibold tabular-nums text-t1" title={item.reasons?.[name]}>
            {formatMetric(item.metrics[name])}
          </td>
        ))}
        <td className="py-2 pl-2 pr-3 text-right align-top">
          <ExecutionLink workflowId={workflowId} executionId={item.executionId} />
        </td>
      </tr>
      {open && (
        <tr className="bg-acdim">
          <td colSpan={6 + metricNames.length} className="px-4 pb-3 pt-1">
            <div className="grid gap-4 rounded-[10px] border border-hair bg-sf p-3 animate-in md:grid-cols-3">
              <KeyValues title="Inputs" record={{ ...item.inputs, ...(item.expected !== undefined && { expected: item.expected }) }} />
              <KeyValues title="Outputs" record={item.outputs} />
              <div className="min-w-0 space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Metrics</div>
                {Object.keys(item.metrics).length ? (
                  Object.entries(item.metrics).map(([name, value]) => (
                    <div key={name} className="text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-t2">{name}</span>
                        <span className="ml-auto font-semibold tabular-nums text-t1">{formatMetric(value)}</span>
                      </div>
                      {item.reasons?.[name] && <p className="mt-0.5 leading-snug text-t3">{item.reasons[name]}</p>}
                    </div>
                  ))
                ) : (
                  <p className="text-[12px] text-t3">—</p>
                )}
                {item.error && <p className="text-[12px] text-rd">{item.error}</p>}
                {item.durationMs !== undefined && <p className="text-[11px] tabular-nums text-t3">Ran in {duration(item.durationMs)}</p>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function RunView({
  run,
  runs,
  workflowId,
  onCompare,
  onCancel,
  onDelete,
}: {
  run: EvaluationRunDetail;
  runs: EvaluationRunSummary[];
  workflowId: string;
  onCompare: (otherId: string) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const state = stateOf(run.status);
  const live = run.status === 'running';
  const now = useNow(live);
  const metricNames = Object.keys(run.metrics).sort();
  // Earlier finished runs, oldest first, for the deltas and sparklines.
  const earlier = useMemo(() => runs.filter((r) => r.number < run.number && r.status !== 'running').sort((a, b) => a.number - b.number), [runs, run.number]);
  const others = runs.filter((r) => r.id !== run.id && r.status !== 'running');
  const progress = run.total ? run.completed / run.total : 0;

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 pb-12 pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[18px] font-semibold text-t1">Run #{run.number}</h1>
        <span className={cn('inline-flex items-center gap-1 text-[13px]', RUN_STATE[state].text)}>
          <RunStateIcon state={state} />
          {RUN_STATE[state].label}
        </span>
        <span className="text-[12px] tabular-nums text-t3">
          {formatStamp(run.startedAt)} · {duration(live ? Math.max(0, now - Date.parse(run.startedAt)) : run.durationMs)} · {run.dataTableName}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {others.length > 0 && (
            <div className="w-[190px]">
              <Select value="" onChange={(e) => e.target.value && onCompare(e.target.value)} aria-label="Compare with another run" className="h-8">
                <option value="">Compare with…</option>
                {others.map((r) => (
                  <option key={r.id} value={r.id}>
                    Run #{r.number} · {formatStamp(r.startedAt)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {live ? (
            <Button size="sm" variant="outline" onClick={onCancel}>
              <CircleStop className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button size="icon-sm" variant="ghost" onClick={onDelete} title="Delete run" aria-label="Delete run">
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {run.error && <p className="mt-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{run.error}</p>}
      {live && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-nudim">
            <div className="h-full rounded-full bg-warn transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <p className="mt-1 text-[12px] tabular-nums text-t3">
            {run.completed} of {run.total} cases done
          </p>
        </div>
      )}

      {metricNames.length > 0 ? (
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {metricNames.map((name) => {
            const history = [...earlier.filter((r) => r.metrics[name]).map((r) => r.metrics[name].average), run.metrics[name].average].slice(-12);
            const previous = [...earlier].reverse().find((r) => r.metrics[name])?.metrics[name].average;
            return <MetricTile key={name} name={name} summary={run.metrics[name]} previous={previous} history={history} />;
          })}
        </div>
      ) : (
        !live && <p className="mt-4 text-[13px] text-t3">No metrics recorded. Add an Evaluation node in “Set Metrics” mode to score the outputs.</p>
      )}

      <div className="mt-5 overflow-x-auto rounded-[12px] border border-hair bg-sf">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              <th className="py-2 pl-3 pr-2 font-semibold">#</th>
              <th className="px-2 py-2 font-semibold">Status</th>
              <th className="px-2 py-2 font-semibold">Inputs</th>
              <th className="px-2 py-2 font-semibold">Expected</th>
              <th className="px-2 py-2 font-semibold">Outputs</th>
              {metricNames.map((name) => (
                <th key={name} className="max-w-[110px] truncate px-2 py-2 text-right font-semibold normal-case tracking-normal" title={name}>
                  {name}
                </th>
              ))}
              <th className="py-2 pl-2 pr-3 text-right font-semibold">Execution</th>
            </tr>
          </thead>
          <tbody>
            {run.cases.map((item) => (
              <CaseRows key={item.index} item={item} metricNames={metricNames} workflowId={workflowId} />
            ))}
          </tbody>
        </table>
        {!run.cases.length && <EmptyState compact title="No test cases" hint="The Data Table had no rows to run." />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two runs side by side
// ---------------------------------------------------------------------------

function CompareView({ comparison, workflowId, onSwap, onClose }: { comparison: EvaluationComparison; workflowId: string; onSwap: () => void; onClose: () => void }) {
  const [changedOnly, setChangedOnly] = useState(false);
  const { a, b } = comparison;
  const names = comparison.metrics.map((m) => m.name);
  const cases = changedOnly ? comparison.cases.filter((c) => Object.values(c.deltas).some((d) => Math.abs(d) > 1e-9) || !c.a || !c.b || c.a.status !== c.b.status) : comparison.cases;

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 pb-12 pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <GitCompareArrows className="size-4 text-t3" />
        <h1 className="flex items-center gap-2 text-[18px] font-semibold text-t1">
          Run #{a.number} <ArrowRight className="size-4 text-t3" /> Run #{b.number}
        </h1>
        <span className="text-[12px] text-t3">Run #{a.number} is the baseline</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onSwap}>
            Swap
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close comparison" aria-label="Close comparison">
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <div className="rounded-[12px] border border-gnbd bg-gndim px-3.5 py-2.5">
          <div className="text-[12px] text-t2">Improved</div>
          <div className="text-[22px] font-semibold tabular-nums text-gn">{comparison.improved}</div>
        </div>
        <div className="rounded-[12px] border border-rdbd bg-rddim px-3.5 py-2.5">
          <div className="text-[12px] text-t2">Regressed</div>
          <div className="text-[22px] font-semibold tabular-nums text-rd">{comparison.regressed}</div>
        </div>
        <div className="rounded-[12px] border border-hair bg-sf px-3.5 py-2.5">
          <div className="text-[12px] text-t2">Unchanged</div>
          <div className="text-[22px] font-semibold tabular-nums text-t1">{comparison.unchanged}</div>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-[12px] border border-hair bg-sf">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              <th className="py-2 pl-3.5 pr-2 font-semibold">Metric</th>
              <th className="px-2 py-2 text-right font-semibold">Run #{a.number}</th>
              <th className="px-2 py-2 text-right font-semibold">Run #{b.number}</th>
              <th className="py-2 pl-2 pr-3.5 text-right font-semibold">Change</th>
            </tr>
          </thead>
          <tbody>
            {comparison.metrics.map((m) => (
              <tr key={m.name} className="border-t border-hair">
                <td className="py-2 pl-3.5 pr-2 text-t1">{m.name}</td>
                <td className="px-2 py-2 text-right tabular-nums text-t2">{formatMetric(m.a)}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums text-t1">{formatMetric(m.b)}</td>
                <td className="py-2 pl-2 pr-3.5 text-right font-semibold">
                  <DeltaText delta={m.delta} />
                </td>
              </tr>
            ))}
            {!comparison.metrics.length && (
              <tr>
                <td colSpan={4} className="px-3.5 py-4 text-center text-t3">
                  Neither run recorded metrics.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mb-2 mt-5 flex items-center gap-2">
        <h2 className="text-[14px] font-semibold text-t1">Cases</h2>
        <span className="text-[12px] text-t3">matched by Data Table row</span>
        <Checkbox checked={changedOnly} onChange={setChangedOnly} label="Changed only" className="ml-auto text-[12px]" />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-hair bg-sf">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              <th className="py-2 pl-3 pr-2 font-semibold">#</th>
              <th className="px-2 py-2 font-semibold">Inputs</th>
              {names.map((name) => (
                <th key={name} className="px-2 py-2 text-right font-semibold normal-case tracking-normal">
                  {name}
                </th>
              ))}
              <th className="py-2 pl-2 pr-3 text-right font-semibold">Executions</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={`${c.rowId ?? 'i'}-${c.index}`} className="border-t border-hair">
                <td className="py-2 pl-3 pr-2 align-top tabular-nums text-t3">{c.index + 1}</td>
                <td className="max-w-[300px] px-2 py-2 align-top text-t1">
                  <span className="line-clamp-2 break-words">{previewRecord(c.inputs)}</span>
                  {(!c.a || !c.b) && <Badge tone="muted" className="mt-1">Only in run #{c.a ? a.number : b.number}</Badge>}
                </td>
                {names.map((name) => (
                  <td key={name} className="px-2 py-2 text-right align-top tabular-nums">
                    <span className="text-t3">{formatMetric(c.a?.metrics[name])}</span>
                    <span className="px-1 text-t3">→</span>
                    <span className="font-semibold text-t1">{formatMetric(c.b?.metrics[name])}</span>
                    {c.deltas[name] !== undefined && Math.abs(c.deltas[name]) > 1e-9 && (
                      <div>
                        <DeltaText delta={c.deltas[name]} className="text-[11px]" />
                      </div>
                    )}
                  </td>
                ))}
                <td className="whitespace-nowrap py-2 pl-2 pr-3 text-right align-top">
                  <span className="inline-flex items-center gap-2">
                    {c.a?.executionId && (
                      <Link href={`/workflows/${workflowId}/executions/${c.a.executionId}`} className="text-ac hover:underline">
                        #{a.number}
                      </Link>
                    )}
                    {c.b?.executionId && (
                      <Link href={`/workflows/${workflowId}/executions/${c.b.executionId}`} className="text-ac hover:underline">
                        #{b.number}
                      </Link>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!cases.length && <EmptyState compact title="No changed cases" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Agent grading (online evaluations of the workflow's AI Agent nodes)
// ---------------------------------------------------------------------------

function OnlineView({ workflowId }: { workflowId: string }) {
  const [data, setData] = useState<WorkflowOnlineEvals>();
  const load = useCallback(() => {
    api<WorkflowOnlineEvals>(`/api/workflows/${workflowId}/online-evaluations`)
      .then(setData)
      .catch((e: Error) => toast.error(e.message));
  }, [workflowId]);
  useEffect(load, [load]);

  const save = async (nodeId: string, patch: OnlineEvalPatch) => {
    try {
      const { report } = await api<{ report: WorkflowOnlineEvals['nodes'][number]['report'] }>(`/api/workflows/${workflowId}/online-evaluations`, { method: 'PUT', json: { nodeId, ...patch } });
      setData((current) => current && { nodes: current.nodes.map((n) => (n.nodeId === nodeId ? { ...n, report } : n)) });
      toast.success('Saved grading settings');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12 pt-5">
      <h1 className="text-[18px] font-semibold text-t1">AI Agent grading</h1>
      <p className="mt-1 text-[13px] leading-snug text-t2">
        Online evaluation: an LLM judge grades a sample of the finished production runs of each AI Agent node against a rubric. Evaluation runs and debug runs are not graded.
      </p>
      <div className="mt-4 space-y-4">
        {!data && <div className="h-[260px] rounded-2xl border border-hair bg-sf animate-pulse-soft" />}
        {data && !data.nodes.length && <EmptyState title="No AI Agent nodes" hint="Add an AI Agent node to this workflow to grade its conversations." />}
        {data?.nodes.map((node) => (
          <section key={node.nodeId} className="rounded-2xl border border-hair bg-sf animate-fade-up">
            <div className="flex items-center gap-2.5 px-4 pb-3 pt-3.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
                <Bot className="size-4" />
              </span>
              <h2 className="truncate text-[14px] font-semibold text-t1">{node.nodeName}</h2>
              {node.report.config.enabled ? <Badge tone="success">Grading {node.report.config.sampleRate}%</Badge> : <Badge tone="muted">Off</Badge>}
            </div>
            <div className="border-t border-hair px-4 py-3.5">
              <OnlineEvalPanel
                report={node.report}
                onSave={(patch) => save(node.nodeId, patch)}
                fallbackLabel="The node’s chat model"
                linkOf={(score) => (score.executionId ? { href: `/workflows/${workflowId}/executions/${score.executionId}`, label: 'Open execution' } : undefined)}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function SetupHint({ workflowId }: { workflowId: string }) {
  const steps: Array<[string, ReactNode]> = [
    ['Test cases', 'Put inputs (and an expected answer column) in a Data Table.'],
    ['Evaluation Trigger', 'Add it to the workflow and choose the table: each row becomes one execution.'],
    ['Set Outputs', 'An Evaluation node records what the workflow answered for the row.'],
    ['Set Metrics', 'Another Evaluation node scores it: exact match, regex, JSON equality, LLM judge and more.'],
  ];
  return (
    <div className="mx-auto max-w-[620px] px-6 py-10 animate-fade-up">
      <div className="mx-auto grid size-11 place-items-center rounded-2xl border border-hair bg-sf text-viz-1">
        <FlaskConical className="size-5" />
      </div>
      <h1 className="mt-3 text-center text-[18px] font-semibold text-t1">Test this workflow against a dataset</h1>
      <p className="mt-1 text-center text-[13px] text-t2">Evaluations run the workflow once per test case and score the results, so you can tell whether a change made it better or worse.</p>
      <ol className="mt-5 space-y-2">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-3 rounded-[12px] border border-hair bg-sf px-3.5 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-acdim text-[12px] font-semibold text-ac">{i + 1}</span>
            <span className="text-[13px]">
              <span className="font-semibold text-t1">{title}</span> <span className="text-t2">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-5 text-center">
        <Link href={`/workflows/${workflowId}`}>
          <Button variant="primary">Open the editor</Button>
        </Link>
      </div>
    </div>
  );
}

type View = { kind: 'run'; runId?: string } | { kind: 'compare'; a: string; b: string } | { kind: 'online' };

export function EvaluationsPage({ workflowId }: { workflowId: string }) {
  const [workflow, setWorkflow] = useState<Workflow>();
  const [workflowMissing, setWorkflowMissing] = useState(false);
  const [overview, setOverview] = useState<EvaluationsOverview>();
  const [view, setView] = useState<View>({ kind: 'run' });
  const [detail, setDetail] = useState<EvaluationRunDetail>();
  const [comparison, setComparison] = useState<EvaluationComparison>();
  const [starting, setStarting] = useState(false);

  const loadOverview = useCallback(
    () =>
      api<EvaluationsOverview>(`/api/workflows/${workflowId}/evaluations`)
        .then((o) => {
          setOverview(o);
          return o;
        })
        .catch(() => undefined),
    [workflowId],
  );

  useEffect(() => {
    void loadOverview();
    api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`)
      .then((r) => setWorkflow(r.workflow))
      .catch(() => setWorkflowMissing(true));
  }, [workflowId, loadOverview]);

  // The newest run is selected until another is picked.
  const selectedId = view.kind === 'run' ? (view.runId ?? overview?.runs[0]?.id) : undefined;

  const loadDetail = useCallback(() => {
    if (!selectedId) return setDetail(undefined);
    api<{ run: EvaluationRunDetail }>(`/api/workflows/${workflowId}/evaluations/${selectedId}`)
      .then((r) => setDetail(r.run))
      .catch(() => setDetail(undefined));
  }, [workflowId, selectedId]);
  useEffect(loadDetail, [loadDetail]);

  useEffect(() => {
    if (view.kind !== 'compare') return setComparison(undefined);
    api<EvaluationComparison>(`/api/workflows/${workflowId}/evaluations/compare?a=${encodeURIComponent(view.a)}&b=${encodeURIComponent(view.b)}`)
      .then(setComparison)
      .catch((e: Error) => {
        toast.error(e.message);
        setView({ kind: 'run' });
      });
  }, [workflowId, view]);

  // Poll while a run is going.
  const running = Boolean(overview?.runs.some((r) => r.status === 'running'));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void loadOverview();
      loadDetail();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, loadOverview, loadDetail]);

  const start = async () => {
    setStarting(true);
    try {
      const { run } = await api<{ run: EvaluationRunSummary }>(`/api/workflows/${workflowId}/evaluations`, { method: 'POST', json: {} });
      setView({ kind: 'run', runId: run.id });
      await loadOverview();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (runId: string) => {
    await api(`/api/workflows/${workflowId}/evaluations/${runId}/cancel`, { method: 'POST' }).catch((e: Error) => toast.error(e.message));
    await loadOverview();
    loadDetail();
  };

  const remove = async (runId: string) => {
    try {
      await api(`/api/workflows/${workflowId}/evaluations/${runId}`, { method: 'DELETE' });
      setView({ kind: 'run' });
      await loadOverview();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const runs = overview?.runs ?? [];
  const now = useNow(running);
  const hasAgents = Boolean(workflow?.nodes.some((n) => n.type === 'core.aiAgent'));
  const canStart = Boolean(overview?.trigger?.source === 'file' ? overview.file : overview?.trigger?.dataTableId) && !running;

  let main: ReactNode;
  if (view.kind === 'online') main = <OnlineView workflowId={workflowId} />;
  else if (view.kind === 'compare')
    main = comparison ? (
      <CompareView comparison={comparison} workflowId={workflowId} onSwap={() => setView({ kind: 'compare', a: view.b, b: view.a })} onClose={() => setView({ kind: 'run', runId: view.b })} />
    ) : (
      <div className="m-6 h-[240px] rounded-2xl border border-hair bg-sf animate-pulse-soft" />
    );
  else if (!overview) main = <div className="m-6 h-[240px] rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  else if (!runs.length)
    main = overview.trigger ? (
      <EmptyState
        className="mt-16"
        title="No evaluation runs yet"
        hint={`Run the workflow over ${overview.trigger.dataTableName ? `“${overview.trigger.dataTableName}”` : overview.trigger.source === 'file' ? 'the uploaded file (upload it first)' : 'its Data Table'}, one execution per row, and the scores show up here.`}
        action={
          <Button variant="primary" onClick={() => void start()} loading={starting} disabled={!canStart}>
            <Play className="size-3.5" /> Run evaluation
          </Button>
        }
      />
    ) : (
      <SetupHint workflowId={workflowId} />
    );
  else if (detail && detail.id === selectedId)
    main = (
      <RunView
        run={detail}
        runs={runs}
        workflowId={workflowId}
        onCompare={(other) => {
          // The older run is the baseline.
          const otherRun = runs.find((r) => r.id === other);
          setView(otherRun && otherRun.number > detail.number ? { kind: 'compare', a: detail.id, b: other } : { kind: 'compare', a: other, b: detail.id });
        }}
        onCancel={() => void cancel(detail.id)}
        onDelete={() => void remove(detail.id)}
      />
    );
  else main = <div className="m-6 h-[240px] rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="relative flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-4">
        <Link href="/workflows" aria-label="Back to workflows" className="grid size-8 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1">
          <ArrowLeft className="size-4" />
        </Link>
        <span className="max-w-[30%] truncate text-[15px] font-semibold text-t1">{workflow?.name ?? (workflowMissing ? 'Deleted workflow' : ' ')}</span>
        {workflow?.active && <Badge tone="success">Published</Badge>}
        <WorkflowTabs workflowId={workflowId} active="evaluations" className="absolute left-1/2 -translate-x-1/2" />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-hair bg-sf2">
          <div className="shrink-0 space-y-2.5 px-4 pb-2 pt-3.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-t1">Evaluations</h2>
              {overview && <span className="font-mono text-[11px] text-t3">{runs.length}</span>}
              <Button size="sm" variant="primary" className="ml-auto" onClick={() => void start()} loading={starting} disabled={!canStart} title={running ? 'A run is in progress' : undefined}>
                <Play className="size-3" /> Run
              </Button>
            </div>
            <TriggerCard overview={overview} workflowId={workflowId} />
            {overview?.trigger && <FileDataset workflowId={workflowId} overview={overview} onChanged={() => void loadOverview()} />}
            {overview?.trigger && <ScheduleCard key={overview.schedule?.cron ?? 'none'} workflowId={workflowId} overview={overview} onChanged={() => void loadOverview()} />}
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 pt-1">
            {!overview &&
              Array.from({ length: 4 }, (_, i) => <div key={i} className="h-[64px] rounded-[10px] border border-hair bg-sf animate-pulse-soft" style={{ animationDelay: `${i * 90}ms` }} />)}
            {runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                now={now}
                selected={(view.kind === 'run' && run.id === selectedId) || (view.kind === 'compare' && (run.id === view.a || run.id === view.b))}
                onClick={() => setView({ kind: 'run', runId: run.id })}
              />
            ))}
          </div>
          {hasAgents && (
            <div className="shrink-0 border-t border-hair p-3">
              <button
                onClick={() => setView({ kind: 'online' })}
                aria-current={view.kind === 'online' || undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[10px] border px-3 py-2 text-left text-[13px] transition-colors',
                  view.kind === 'online' ? 'border-acbd bg-acdim font-semibold text-t1' : 'border-hair bg-sf text-t2 hover:text-t1',
                )}
              >
                <Bot className="size-4 text-t3" />
                AI Agent grading
                <ChevronRight className="ml-auto size-3.5 text-t3" />
              </button>
            </div>
          )}
        </aside>
        <div className="min-h-0 min-w-0 overflow-y-auto bg-bg">{main}</div>
      </div>
    </div>
  );
}
