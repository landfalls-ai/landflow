'use client';
/**
 * A workflow's runs over time (`GET /api/runs/measures`): one measure at a time (duration, tokens or cost) as a line with a
 * dot per run, in plain SVG from the theme tokens so it follows light and dark mode. The last run's dot is larger and
 * labelled with its value; the axis names the largest value and the dates of the first and last run. A run with a failed
 * step has a red dot. The numbers are also listed under the chart for a screen reader.
 */
import { useEffect, useRef, useState } from 'react';
import { duration } from '@/lib/client/format';
import { formatCost } from '@/lib/shared/ai-usage';
import type { RunMeasure } from '@/lib/shared/run-compare';
import { cn } from '@/lib/utils';

type Metric = 'duration' | 'tokens' | 'cost';

const METRICS: Array<{ id: Metric; label: string; read: (run: RunMeasure) => number | undefined; show: (value: number) => string }> = [
  { id: 'duration', label: 'Duration', read: (r) => r.durationMs, show: (v) => duration(Math.round(v)) },
  { id: 'tokens', label: 'Tokens', read: (r) => r.tokensIn + r.tokensOut, show: (v) => `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)} tokens` },
  { id: 'cost', label: 'Cost', read: (r) => r.costUsd, show: (v) => formatCost(v) },
];

const HEIGHT = 150;
const MARGIN = { top: 22, right: 14, bottom: 22, left: 10 };
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function TrendChart({ runs, className }: { runs: RunMeasure[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [metric, setMetric] = useState<Metric>('duration');
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const spec = METRICS.find((m) => m.id === metric)!;
  const points = runs.flatMap((run, index) => {
    const value = spec.read(run);
    return value === undefined ? [] : [{ run, value, index }];
  });
  const available = METRICS.filter((m) => runs.some((r) => m.read(r) !== undefined));
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = Math.max(0, ...points.map((p) => p.value));
  const x = (i: number) => (points.length < 2 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => innerH - (max > 0 ? (v / max) * innerH : 0);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const last = points.at(-1);
  const shown = hover === undefined ? last : points[hover];

  return (
    <div className={cn('rounded-2xl border border-hair bg-sf px-3.5 py-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Measure" className="flex gap-1">
          {available.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={m.id === metric}
              onClick={() => setMetric(m.id)}
              className={cn('min-h-9 rounded-full px-3 text-[12px] font-semibold transition-colors', m.id === metric ? 'bg-acdim text-t1' : 'text-t3 hover:text-t1')}
            >
              {m.label}
            </button>
          ))}
        </div>
        {shown && (
          <p className="text-[12px] text-t2" aria-live="polite">
            {day(shown.run.startedAt)} · <b className="tabular-nums text-t1">{spec.show(shown.value)}</b>
            {shown.run.failedSteps > 0 && <span className="text-rd"> · {shown.run.failedSteps} failed</span>}
          </p>
        )}
      </div>
      <div ref={box} className="relative mt-1 w-full select-none" style={{ height: HEIGHT }} onMouseLeave={() => setHover(undefined)}>
        {width > 0 && points.length > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${spec.label} of the last ${points.length} runs: latest ${spec.show(last!.value)}, largest ${spec.show(max)}`} className="block overflow-visible">
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              <line x1={0} x2={innerW} y1={innerH} y2={innerH} style={{ stroke: 'var(--bd)' }} shapeRendering="crispEdges" />
              <line x1={0} x2={innerW} y1={0} y2={0} style={{ stroke: 'var(--hair)', strokeDasharray: '3 4' }} shapeRendering="crispEdges" />
              <text x={0} y={-8} style={{ fill: 'var(--t3)', fontSize: 11 }}>
                largest {spec.show(max)}
              </text>
              <text x={0} y={innerH + 16} style={{ fill: 'var(--t3)', fontSize: 11 }}>
                {day(points[0].run.startedAt)}
              </text>
              {points.length > 1 && (
                <text x={innerW} y={innerH + 16} textAnchor="end" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                  {day(last!.run.startedAt)}
                </text>
              )}
              {points.length > 1 && <path d={path} fill="none" style={{ stroke: 'var(--viz-1)' }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {points.map((p, i) => {
                const isLast = i === points.length - 1;
                const failed = p.run.failedSteps > 0 || p.run.checksFailed > 0 || p.run.status === 'error';
                return (
                  <g key={p.run.executionId} transform={`translate(${x(i)},${y(p.value)})`}>
                    {(isLast || hover === i) && <circle r={8} style={{ fill: failed ? 'var(--rd)' : 'var(--viz-1)', opacity: 0.18 }} />}
                    <circle r={isLast ? 4.5 : 3} style={{ fill: failed ? 'var(--rd)' : 'var(--viz-1)', stroke: 'var(--sf)' }} strokeWidth={1.5} />
                    {/* A target of 44 px tall for a thumb. */}
                    <rect x={-Math.max(10, innerW / Math.max(1, points.length) / 2)} y={-y(p.value) - MARGIN.top} width={Math.max(20, innerW / Math.max(1, points.length))} height={HEIGHT} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                  </g>
                );
              })}
              {last && points.length > 1 && (
                <text x={x(points.length - 1)} y={y(last.value) - 12} textAnchor="end" className="tabular-nums" style={{ fill: 'var(--t1)', fontSize: 11, fontWeight: 600 }}>
                  {spec.show(last.value)}
                </text>
              )}
            </g>
          </svg>
        )}
        {points.length === 0 && <p className="pt-10 text-center text-[13px] text-t3">No {spec.label.toLowerCase()} recorded for these runs.</p>}
      </div>
      <ul className="sr-only">
        {points.map((p) => (
          <li key={p.run.executionId}>
            {day(p.run.startedAt)}: {spec.show(p.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}
