'use client';
/**
 * The Platform analyst's chat (docs/second-brain.md#the-analyst-agent): chips for what it can read, one
 * kit's activity line in place of the scrolling tool calls (the calls stay behind it), and its answer as a card with a chart drawn from the tool results it really fetched (lib/shared/analyst-chart.ts).
 */
import Link from 'next/link';
import { Button } from '../ui/button';
import { ActivityTrace } from '../ui/activity-trace';
import { ReplyMeta, type ReplyInfo } from '../ui/chat';
import {
  ANALYST_SOURCE_LABEL,
  analystChart,
  chartHeading,
  formatMetric,
  runsHref,
  splitAnswer,
  type AnalystChart,
  type AnalystSource,
} from '@/lib/shared/analyst-chart';
import type { TimelineEntry } from '@/lib/shared/agents';
import { replyInfo, TimelineView, traceOf, type ToolEntry } from './timeline';

export const SUGGEST_FIX_MESSAGE =
  'Call suggest_improvement with one concrete fix for what you just found, with the numbers in why. It goes to the suggestions inbox for a person to apply or dismiss.';

/** What the analyst can look up, one chip per source. */
export function SourceChips({ sources }: { sources: AnalystSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-hair px-3 py-2" aria-label="What the analyst reads">
      <span className="text-[11px] text-t3">Reads</span>
      {sources.map((s) => (
        <span key={s} className="rounded-full border border-hair bg-wl px-2 py-px text-[11px] text-t2">
          {ANALYST_SOURCE_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/** Values by workflow, node or model: one labelled bar each, biggest first, the biggest in the accent colour, so every bar reads on a phone. */
function GroupBars({ chart }: { chart: AnalystChart }) {
  const { points, budget } = chart;
  const max = Math.max(...points.map((p) => p.value), budget ?? 0) || 1;
  const peak = Math.max(...points.map((p) => p.value));
  return (
    <div role="img" aria-label={`${chart.metricLabel} by ${chart.groupBy}: ${points.map((p) => `${p.label} ${formatMetric(chart.metric, p.value)}`).join(', ')}`} className="flex flex-col gap-1.5">
      <span className="text-[10.5px] text-t3">{chart.metricLabel}</span>
      {points.map((p, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,38%)_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px]">
          <span className="truncate text-t2" title={p.label}>{p.label}</span>
          <span className="relative h-2.5 rounded-full bg-acdim">
            <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, (p.value / max) * 100)}%`, background: p.value === peak ? 'var(--viz-1)' : 'color-mix(in oklab, var(--t3) 45%, transparent)' }} />
            {budget !== undefined && <span aria-hidden className="absolute inset-y-[-3px] border-l border-dashed border-t2" style={{ left: `${(budget / max) * 100}%` }} />}
          </span>
          <span className="font-mono tabular-nums text-t1">{formatMetric(chart.metric, p.value)}</span>
        </div>
      ))}
      {budget !== undefined && <span className="text-[10.5px] text-t3">Dashed: budget {formatMetric(chart.metric, budget)}</span>}
    </div>
  );
}

/** Bars of the values the tools returned: the biggest in the accent colour, a dashed line at a stated budget, labelled ends only. */
export function AnalystChartSvg({ chart }: { chart: AnalystChart }) {
  if (chart.groupBy !== 'day') return <GroupBars chart={chart} />;
  const W = 300;
  const H = 96;
  const top = 14;
  const base = H - 14;
  const { points, budget } = chart;
  const max = Math.max(...points.map((p) => p.value), budget ?? 0) || 1;
  const slot = W / points.length;
  const bar = Math.min(28, slot * 0.64);
  const y = (v: number) => base - (v / max) * (base - top);
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${chart.metricLabel} by ${chart.groupBy}: ${points.map((p) => `${p.label} ${formatMetric(chart.metric, p.value)}`).join(', ')}`}>
      <line x1={0} x2={W} y1={base} y2={base} stroke="var(--hair)" />
      {points.map((p, i) => {
        const h = Math.max(1.5, base - y(p.value));
        return (
          <rect key={i} x={slot * i + (slot - bar) / 2} y={base - h} width={bar} height={h} rx={2} fill={i === peak ? 'var(--viz-1)' : 'var(--t3)'} opacity={i === peak ? 1 : 0.4}>
            <title>{`${p.label}: ${formatMetric(chart.metric, p.value)}`}</title>
          </rect>
        );
      })}
      {budget !== undefined && (
        <g>
          <line x1={0} x2={W} y1={y(budget)} y2={y(budget)} stroke="var(--t2)" strokeWidth={1} strokeDasharray="4 3" />
          <text x={W} y={y(budget) - 3} textAnchor="end" fontSize={9} fill="var(--t2)">{`Budget ${formatMetric(chart.metric, budget)}`}</text>
        </g>
      )}
      <text x={0} y={9} fontSize={9} fill="var(--t3)">{`${chart.metricLabel} · max ${formatMetric(chart.metric, Math.max(...points.map((p) => p.value)))}`}</text>
      <text x={0} y={H - 2} fontSize={9} fill="var(--t3)">{first.label}</text>
      {points.length > 1 && <text x={W} y={H - 2} textAnchor="end" fontSize={9} fill="var(--t3)">{last.label}</text>}
    </svg>
  );
}

/** The answer as one card: period and scope, the sentence, the chart, up to two drivers and the next steps. */
export function AnswerCard({ chart, text, onSuggest, busy, info }: { chart: AnalystChart; text: string; onSuggest: () => void; busy: boolean; info?: ReplyInfo }) {
  const { answer, drivers } = splitAnswer(text);
  return (
    <div className="animate-in rounded-xl border border-hair bg-wl p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-t3">{chartHeading(chart)}</div>
      {answer && <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">{answer}</p>}
      <div className="mt-2.5">
        <AnalystChartSvg chart={chart} />
      </div>
      {drivers.length > 0 && (
        <ul className="mt-2 space-y-1">
          {drivers.map((d) => (
            <li key={d} className="flex gap-2 text-[12px] leading-snug text-t2">
              <span className="mt-[5px] size-1 shrink-0 rounded-full bg-t3" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{d}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={runsHref(chart)} className="inline-flex h-7 items-center rounded-full border border-bd px-3 text-[12px] font-medium text-t1 transition-colors hover:border-ac hover:text-ac max-md:h-11">
          Open the runs
        </Link>
        <Button size="sm" variant="primary" onClick={onSuggest} disabled={busy} title="Asks the analyst to file a suggestion; you still apply it in the suggestions inbox" className="max-md:h-11">
          Suggest a fix
        </Button>
      </div>
      <div className="mt-1.5">
        <ReplyMeta info={info} copy={text} />
      </div>
    </div>
  );
}

type Segment = { kind: 'tools'; entries: ToolEntry[] } | { kind: 'other'; entries: TimelineEntry[] };

export function AnalystTimeline({
  entries,
  running,
  childHref,
  onDecide,
  deciding,
  onSuggest,
  traceUrl,
}: {
  entries: TimelineEntry[];
  running: boolean;
  childHref?: (entry: ToolEntry) => string | undefined;
  onDecide: (callId: string, approved: boolean) => void;
  deciding: boolean;
  onSuggest: () => void;
  /** The last activity line's Open trace link. */
  traceUrl?: string;
}) {
  // The last turn: what came after the last thing the person said.
  let turnStart = 0;
  entries.forEach((e, i) => {
    if (e.type === 'user') turnStart = i;
  });
  const lastTurnTools = entries.slice(turnStart).filter((e): e is ToolEntry => e.type === 'tool');
  const lastAssistant = entries.length - 1 - [...entries].reverse().findIndex((e) => e.type === 'assistant');
  const done = !running && entries[entries.length - 1]?.type === 'assistant';
  const chart = done && lastAssistant >= turnStart
    ? analystChart(lastTurnTools.filter((e) => e.status === 'success').map((e) => ({ tool: e.tool, input: e.input, output: e.output })))
    : undefined;
  const cardAt = chart ? lastAssistant : -1;

  // Segments: runs of tool calls (one line each) between the other entries.
  const segments: Segment[] = [];
  entries.forEach((e, i) => {
    if (i === cardAt) return;
    if (e.type === 'tool') {
      const prev = segments[segments.length - 1];
      if (prev?.kind === 'tools') {
        prev.entries.push(e);
      } else segments.push({ kind: 'tools', entries: [e] });
    } else {
      const prev = segments[segments.length - 1];
      if (prev?.kind === 'other') prev.entries.push(e);
      else segments.push({ kind: 'other', entries: [e] });
    }
  });

  const card = chart && (
    <AnswerCard
      chart={chart}
      text={(entries[cardAt] as Extract<TimelineEntry, { type: 'assistant' }>).text}
      onSuggest={onSuggest}
      busy={running}
      info={replyInfo(entries, cardAt)}
    />
  );
  return (
    <div className="space-y-3">
      {segments.map((seg, i) => {
        if (seg.kind === 'other') return <TimelineView key={i} entries={seg.entries} childHref={childHref} onDecide={onDecide} deciding={deciding} />;
        // A call waiting for approval is shown in full: the person has to decide.
        if (seg.entries.some((e) => e.status === 'awaiting_approval')) return <TimelineView key={i} entries={seg.entries} childHref={childHref} onDecide={onDecide} deciding={deciding} />;
        const live = running && i === segments.length - 1;
        const { steps, durationMs } = traceOf(seg.entries);
        return (
          <div key={i} className="pl-7">
            <ActivityTrace steps={steps} live={live || seg.entries.some((e) => e.status === 'running')} durationMs={durationMs} {...(i === segments.length - 1 && traceUrl && { traceUrl })} />
          </div>
        );
      })}
      {card}
    </div>
  );
}
