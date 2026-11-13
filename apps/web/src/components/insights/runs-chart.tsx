'use client';
/**
 * Runs per hour (24h) or per day (7d, 30d) as stacked bars, drawn in plain SVG
 * from the theme tokens so it follows light and dark mode. Succeeded runs sit on
 * the baseline with failed runs on top; hovering a column shows its counts,
 * canceled runs included.
 */
import { useEffect, useRef, useState } from 'react';
import type { InsightsBucket, InsightsPeriod } from '@/lib/shared/platform';

export const SUCCEEDED_COLOR = 'var(--gn)';
export const FAILED_COLOR = 'color-mix(in oklab, var(--rd) 85%, var(--bg))';

const HEIGHT = 232;
const MARGIN = { top: 12, right: 4, bottom: 26, left: 40 };
const GAP = 2;
const RADIUS = 4;

/** A round top for the y axis and a step giving about four gridlines; counts are whole numbers. */
function niceScale(max: number) {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const step = Math.max(1, (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude);
  return { top: Math.ceil(max / step) * step, step };
}

/** A bar whose top corners are rounded and whose foot sits square on the baseline. */
function roundedTop(x: number, y: number, w: number, h: number) {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function RunsChart({ series, period }: { series: InsightsBucket[]; period: InsightsPeriod }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number>();

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = Math.max(0, ...series.map((b) => b.succeeded + b.failed));
  const { top, step } = niceScale(max);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const band = series.length ? innerW / series.length : 0;
  const barW = Math.max(2, Math.min(32, band * 0.66));
  const scale = (v: number) => (v / top) * innerH;
  // Label every n-th column, always including the latest.
  const stride = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(innerW / 58))));
  const total = series.reduce((sum, b) => sum + b.succeeded + b.failed + b.canceled, 0);
  const failed = series.reduce((sum, b) => sum + b.failed, 0);
  const unit = period === '24h' ? 'hour' : 'day';
  const hovered = hover === undefined ? undefined : series[hover];
  const tooltipX = hover === undefined ? 0 : MARGIN.left + band * (hover + 0.5);

  return (
    <div ref={box} className="relative w-full select-none" style={{ height: HEIGHT }} onMouseLeave={() => setHover(undefined)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Runs per ${unit}: ${total} in total, ${failed} failed`} className="block overflow-visible">
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {ticks.map((tick) => (
              <g key={tick} transform={`translate(0,${innerH - scale(tick)})`}>
                <line x1={0} x2={innerW} style={{ stroke: tick === 0 ? 'var(--bd)' : 'var(--hair)' }} shapeRendering="crispEdges" />
                <text x={-8} dy="0.32em" textAnchor="end" className="tabular-nums" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                  {compact.format(tick)}
                </text>
              </g>
            ))}
            {series.map((bucket, i) => {
              const x = band * i + (band - barW) / 2;
              const hS = bucket.succeeded ? Math.max(2, scale(bucket.succeeded)) : 0;
              const hF = bucket.failed ? Math.max(2, scale(bucket.failed) - (hS ? GAP : 0)) : 0;
              const yS = innerH - hS;
              const yF = yS - (hS ? GAP : 0) - hF;
              return (
                <g key={bucket.key}>
                  {hover === i && <rect x={band * i} y={0} width={band} height={innerH} rx={6} style={{ fill: 'var(--acdim)' }} />}
                  {hS > 0 && (hF > 0 ? <rect x={x} y={yS} width={barW} height={hS} style={{ fill: SUCCEEDED_COLOR }} /> : <path d={roundedTop(x, yS, barW, hS)} style={{ fill: SUCCEEDED_COLOR }} />)}
                  {hF > 0 && <path d={roundedTop(x, yF, barW, hF)} style={{ fill: FAILED_COLOR }} />}
                  {(series.length - 1 - i) % stride === 0 && (
                    <text x={band * (i + 0.5)} y={innerH + 17} textAnchor="middle" style={{ fill: 'var(--t3)', fontSize: 11 }}>
                      {bucket.label}
                    </text>
                  )}
                  <rect x={band * i} y={0} width={band} height={innerH + MARGIN.bottom} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {width > 0 && total === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center pb-6 pl-10 text-[13px] text-t3">No finished runs in this period</div>
      )}
      {hovered && (
        <div
          className="pointer-events-none absolute z-10 min-w-[150px] rounded-xl border border-hair bg-sf px-3 py-2 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          style={{ left: Math.min(Math.max(tooltipX, 80), width - 80), top: 0, transform: 'translateX(-50%)' }}
        >
          <div className="mb-1 font-semibold text-t1">{period === '24h' ? `${hovered.label} – ${String((Number(hovered.label.slice(0, 2)) + 1) % 24).padStart(2, '0')}:00` : hovered.label}</div>
          {[
            ['Succeeded', hovered.succeeded, SUCCEEDED_COLOR],
            ['Failed', hovered.failed, FAILED_COLOR],
            ['Canceled', hovered.canceled, undefined],
          ].map(([label, value, color]) => (
            <div key={label as string} className="flex items-center gap-2 text-t2">
              <span className="size-2 rounded-sm" style={{ background: (color as string) ?? 'transparent', boxShadow: color ? undefined : 'inset 0 0 0 1px var(--bd)' }} />
              <span className="flex-1">{label}</span>
              <span className="font-mono tabular-nums text-t1">{(value as number).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
