'use client';
/**
 * The Platform analyst's chat in the new look (docs/second-brain.md#the-analyst-agent): chips for what it can read, one
 * "Looking across N sources…" line in place of the scrolling tool calls (the calls stay behind "Show steps"), and its
 * answer as a card with a chart drawn from the tool results it really fetched (lib/shared/analyst-chart.ts).
 */
import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, ListTree, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ANALYST_SOURCE_LABEL,
  analystChart,
  chartHeading,
  formatMetric,
  runsHref,
  sourcesOf,
  splitAnswer,
  type AnalystChart,
  type AnalystSource,
} from '@/lib/shared/analyst-chart';
import type { TimelineEntry } from '@/lib/shared/agents';
import { TimelineView, type ToolEntry } from './timeline';

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

/** Bars of the values the tools returned: the biggest in the accent colour, a dashed line at a stated budget, labelled ends only. */
export function AnalystChartSvg({ chart }: { chart: AnalystChart }) {
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
export function AnswerCard({ chart, text, onSuggest, busy }: { chart: AnalystChart; text: string; onSuggest: () => void; busy: boolean }) {
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
        <Link href={runsHref(chart)} className="rounded-full border border-bd px-3 py-1 text-[12px] text-t1 transition-colors hover:border-ac hover:text-ac">
          Open the runs
        </Link>
        <button
          onClick={onSuggest}
          disabled={busy}
          title="Asks the analyst to file a suggestion; you still apply it in the suggestions inbox"
          className="rounded-full bg-ac2 px-3 py-1 text-[12px] text-on-ac transition-colors hover:bg-ac2-hover disabled:opacity-40"
        >
          Suggest a fix
        </button>
      </div>
    </div>
  );
}

type Segment = { kind: 'tools'; entries: ToolEntry[]; turn: ToolEntry[] } | { kind: 'other'; entries: TimelineEntry[] };

/** The tool calls of a turn become one line; everything else is shown as it is. */
function LookingLine({ group, turn, live, children }: { group: ToolEntry[]; turn: ToolEntry[]; live: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const n = sourcesOf(turn.map((e) => e.tool)).length;
  const failed = group.some((e) => e.status === 'error');
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-full border border-acbd bg-acdim text-ac">
          <Wrench className="size-3.5" />
        </span>
        <span
          className={cn('min-w-0 flex-1 text-[13px]', live ? 'animate-pulse-soft text-t1' : 'text-t2')}
        >
          {live ? `Looking across ${n || 1} source${n === 1 ? '' : 's'}…` : `Looked across ${n || 1} source${n === 1 ? '' : 's'}${failed ? ' (one failed)' : ''}`}
        </span>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-t3 hover:bg-acdim hover:text-t1"
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          <ListTree className="size-3" />
          {open ? 'Hide steps' : 'Show steps'}
        </button>
      </div>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function AnalystTimeline({
  entries,
  running,
  childHref,
  onDecide,
  deciding,
  onSuggest,
}: {
  entries: TimelineEntry[];
  running: boolean;
  childHref?: (entry: ToolEntry) => string | undefined;
  onDecide: (callId: string, approved: boolean) => void;
  deciding: boolean;
  onSuggest: () => void;
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
  let turnTools: ToolEntry[] = [];
  entries.forEach((e, i) => {
    if (i === cardAt) return;
    if (e.type === 'user') turnTools = [];
    if (e.type === 'tool') {
      turnTools = [...turnTools, e];
      const prev = segments[segments.length - 1];
      if (prev?.kind === 'tools') {
        prev.entries.push(e);
        prev.turn = turnTools;
      } else segments.push({ kind: 'tools', entries: [e], turn: turnTools });
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
    />
  );
  return (
    <div className="space-y-3">
      {segments.map((seg, i) => {
        if (seg.kind === 'other') return <TimelineView key={i} entries={seg.entries} childHref={childHref} onDecide={onDecide} deciding={deciding} />;
        const view = <TimelineView entries={seg.entries} childHref={childHref} onDecide={onDecide} deciding={deciding} />;
        // A call waiting for approval is shown in full: the person has to decide.
        if (seg.entries.some((e) => e.status === 'awaiting_approval')) return <div key={i}>{view}</div>;
        const live = running && i === segments.length - 1;
        return (
          <LookingLine key={i} group={seg.entries} turn={seg.turn} live={live || seg.entries.some((e) => e.status === 'running')}>
            {view}
          </LookingLine>
        );
      })}
      {card}
    </div>
  );
}
