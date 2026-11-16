'use client';
/**
 * The AI page's trend (docs/llm-gateway.md, "The AI page"): cost or tokens per day for the period (per hour for 24 hours)
 * as one line with the previous period behind it as a faint dashed one, or, with a "By" group, as stacked columns of that
 * group's top 5 and "Other". Plain SVG from the theme tokens (light and dark); the numbers are also a table for a screen
 * reader. The person stack is everyone's spend, any other group what the viewer can see, and the chart says which.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AI_GROUPS, fillDays, pointLabel, stackColor, stackColumns, stackScopeNote, tipLeft, trendPoints, trendValue, type TrendMetric } from '@/lib/client/ai-console';
import type { AiSpendGroup, AiSpendPoint, AiSpendReport } from '@/lib/shared/ai-spend';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/inputs';
import { cn } from '@/lib/utils';

const HEIGHT = 190;
const MARGIN = { top: 16, right: 12, bottom: 24, left: 12 };

export function AiTrend({
  report,
  previousSeries,
  metric,
  onMetric,
  stack,
  onStack,
  className,
}: {
  report: Pick<AiSpendReport, 'series' | 'stack' | 'from' | 'to' | 'period'>;
  /** The days just before the range, drawn faint; nothing for an hour range or a long custom one. */
  previousSeries?: AiSpendPoint[];
  metric: TrendMetric;
  onMetric: (metric: TrendMetric) => void;
  stack?: AiSpendGroup;
  onStack: (group: AiSpendGroup | undefined) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number>();
  // The tooltip's own width (it is 150 to 260 px), so it is kept inside the chart whatever its labels.
  const tipBox = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // SP10: an older host answers no series or stack; nothing to draw is better than a crash.
  const reported = report.series ?? [];
  const series = report.period === '24h' ? reported : fillDays(reported, report.from, report.to);
  const line = trendPoints(series, metric);
  const previous = previousSeries && report.period !== '24h' ? trendPoints(previousSeries, metric) : [];
  const stacked = report.stack && report.stack.group === stack ? report.stack : undefined;
  const columns = stacked ? stackColumns(stacked, metric) : [];
  const n = stacked ? columns.length : line.length;
  const tops = stacked ? columns.map((c) => c.total) : [...line.map((p) => p.value), ...previous.map((p) => p.value)];
  const max = Math.max(0, ...tops);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const step = n > 0 ? innerW / n : 0;
  const cx = (i: number) => (stacked ? step * i + step / 2 : n < 2 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => innerH - (max > 0 ? (v / max) * innerH : 0);
  const path = (points: Array<{ value: number }>) => points.map((p, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const at = (i: number) => (stacked ? columns[i]?.at : line[i]?.at) ?? '';

  const onMove = (clientX: number, left: number) => {
    if (n === 0 || innerW === 0) return;
    const x = clientX - left - MARGIN.left;
    const index = stacked ? Math.floor(x / step) : n < 2 ? 0 : Math.round((x / innerW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, index)));
  };

  const tip = hover === undefined ? undefined : hover;
  useLayoutEffect(() => setTipWidth(tipBox.current?.offsetWidth ?? 0), [tip, metric, stack, width]);
  const none = n === 0 || max === 0;

  return (
    <div className={cn('rounded-[14px] border border-hair bg-sf px-4 py-3', className)} data-testid="ai-trend">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-[13px] font-semibold text-t1">{report.period === '24h' ? 'Per hour' : 'Per day'}</h2>
        <Segmented size="sm" label="Measure" value={metric} onChange={onMetric} options={[{ value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }]} />
        <label className="ml-auto flex items-center gap-2 text-[12px] text-t3 max-md:ml-0">
          By
          <Select value={stack ?? ''} onChange={(e) => onStack((e.target.value || undefined) as AiSpendGroup | undefined)} aria-label="Stack the chart by" className="h-8 w-auto min-w-[120px] py-0 text-[12px]">
            <option value="">Nothing (total)</option>
            {AI_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div ref={box} className="relative mt-2 w-full select-none" style={{ height: HEIGHT }} onMouseLeave={() => setHover(undefined)}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`${metric === 'cost' ? 'Cost' : 'Tokens'} ${report.period === '24h' ? 'per hour' : 'per day'}, ${n} points, largest ${trendValue(max, metric)}`} className="block overflow-visible">
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              <line x1={0} x2={innerW} y1={innerH} y2={innerH} style={{ stroke: 'var(--bd)' }} shapeRendering="crispEdges" />
              <line x1={0} x2={innerW} y1={0} y2={0} style={{ stroke: 'var(--hair)', strokeDasharray: '3 4' }} shapeRendering="crispEdges" />
              <text x={0} y={-5} style={{ fill: 'var(--t3)', fontSize: 11 }}>
                {none ? 'Nothing in this range' : trendValue(max, metric)}
              </text>
              {n > 0 && (
                <>
                  <text x={0} y={innerH + 16} style={{ fill: 'var(--t3)', fontSize: 11 }}>
                    {pointLabel(at(0))}
                  </text>
                  {n > 1 && (
                    <text x={innerW} y={innerH + 16} textAnchor="end" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                      {pointLabel(at(n - 1))}
                    </text>
                  )}
                </>
              )}
              {stacked
                ? columns.map((col, i) => {
                    let base = innerH;
                    const w = Math.max(2, Math.min(40, step * 0.7));
                    return (
                      <g key={col.at} opacity={tip === undefined || tip === i ? 1 : 0.55}>
                        {col.values.map((v, j) => {
                          if (!(v > 0) || max === 0) return null;
                          const h = Math.max(1, (v / max) * innerH);
                          base -= h;
                          return <rect key={stacked.rows[j]?.key ?? j} x={cx(i) - w / 2} y={base} width={w} height={h} rx={w > 6 ? 2 : 0} style={{ fill: stackColor(stacked.rows[j] ?? { key: '' }, j), stroke: 'var(--sf)' }} strokeWidth={1} />;
                        })}
                      </g>
                    );
                  })
                : n > 0 && (
                    <>
                      {previous.length > 1 && <path d={path(previous)} fill="none" data-testid="ai-trend-previous" style={{ stroke: 'var(--t3)', opacity: 0.55 }} strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" />}
                      {n > 1 ? <path d={path(line)} fill="none" style={{ stroke: 'var(--viz-1)' }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
                      {tip === undefined && n > 0 && <circle cx={cx(n - 1)} cy={y(line[n - 1].value)} r={4} style={{ fill: 'var(--viz-1)', stroke: 'var(--sf)' }} strokeWidth={1.5} />}
                    </>
                  )}
              {tip !== undefined && n > 0 && (
                <g>
                  <line x1={cx(tip)} x2={cx(tip)} y1={0} y2={innerH} style={{ stroke: 'var(--bd)' }} />
                  {!stacked && <circle cx={cx(tip)} cy={y(line[tip].value)} r={4.5} style={{ fill: 'var(--viz-1)', stroke: 'var(--sf)' }} strokeWidth={1.5} />}
                </g>
              )}
              <rect x={0} y={-MARGIN.top} width={innerW} height={HEIGHT} fill="transparent" onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect().left - MARGIN.left)} onClick={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect().left - MARGIN.left)} />
            </g>
          </svg>
        )}
        {tip !== undefined && n > 0 && width > 0 && (
          <div
            ref={tipBox}
            className="pointer-events-none absolute top-0 z-10 min-w-[150px] max-w-[260px] rounded-lg border border-hair bg-sf px-2.5 py-1.5 text-[12px] shadow-pop"
            style={{ left: tipLeft(MARGIN.left + cx(tip), tipWidth || 260, width) }}
            role="status"
          >
            <p className="font-semibold text-t1">{pointLabel(at(tip), true)}</p>
            {stacked ? (
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {stacked.rows.map((row, j) => (
                  <li key={row.key} className="flex items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-sm" style={{ background: stackColor(row, j) }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-t2">{row.label}</span>
                    <span className="tabular-nums text-t1">{trendValue(columns[tip].values[j] ?? 0, metric)}</span>
                  </li>
                ))}
                <li className="mt-0.5 flex justify-between border-t border-hair pt-0.5 text-t2">
                  <span>Total</span>
                  <span className="tabular-nums text-t1">{trendValue(columns[tip].total, metric)}</span>
                </li>
              </ul>
            ) : (
              <>
                <p className="tabular-nums text-t1">{trendValue(line[tip].value, metric)}</p>
                {previous[tip] && (
                  <p className="tabular-nums text-t3">
                    Before: {trendValue(previous[tip].value, metric)} <span className="text-t3">({pointLabel(previous[tip].at)})</span>
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {stacked ? (
        <div className="mt-1.5 flex flex-col gap-1">
          <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-t2" aria-label="Legend">
            {stacked.rows.map((row, j) => (
              <li key={row.key} className="flex max-w-[220px] items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-sm" style={{ background: stackColor(row, j) }} aria-hidden />
                <span className="truncate">{row.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-t3">{stackScopeNote(stacked.scope)}</p>
        </div>
      ) : (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[12px] text-t3">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: 'var(--viz-1)' }} aria-hidden />
            This period
          </span>
          {previous.length > 1 && (
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t border-dashed border-t3" aria-hidden />
              The period before
            </span>
          )}
        </p>
      )}

      <table className="sr-only">
        <caption>{metric === 'cost' ? 'Cost' : 'Tokens'} by {report.period === '24h' ? 'hour' : 'day'}</caption>
        <tbody>
          {(stacked ? columns.map((c) => ({ at: c.at, value: c.total })) : line).map((p) => (
            <tr key={p.at}>
              <th scope="row">{pointLabel(p.at, true)}</th>
              <td>{trendValue(p.value, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
