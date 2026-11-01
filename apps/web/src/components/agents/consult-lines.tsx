'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { consultEdges, type ConsultEdge } from '@/lib/shared/agent-teams';

interface Line {
  key: string;
  d: string;
  /** Where the line leaves the `from` card and where it reaches the `to` card. */
  a: [number, number];
  b: [number, number];
  mid: [number, number];
  edge: ConsultEdge;
}

/**
 * The "may consult" lines of a team chart: a dashed curve between two member cards, drawn over the chart from where the
 * cards really are (any element inside `containerRef` with `data-member-id`), so it follows the layout at every width.
 * Cards in one column (a phone, or the Run Trace list) get a dashed bracket down the right edge; cards side by side get a
 * curve between their facing sides; cards in different rows a curve from one's bottom to the other's top. A dot marks the
 * consulted end (both ends when they may consult each other). The container must be `position: relative`.
 */
export function ConsultLines({ containerRef, members, titles, colors }: { containerRef: React.RefObject<HTMLElement | null>; members: readonly { id: string; consults?: string[] }[]; titles: Record<string, string>; colors?: Record<string, string> }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [shown, setShown] = useState<string>();
  const signature = consultEdges({ members }).map((e) => `${e.from}>${e.to}${e.mutual ? '*' : ''}`).join(',');
  const frame = useRef(0);

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const cards = [...root.querySelectorAll<HTMLElement>('[data-member-id]')];
    const rect = (id: string) => {
      const el = cards.find((n) => n.dataset.memberId === id);
      if (!el) return undefined;
      const r = el.getBoundingClientRect();
      return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, w: r.width, h: r.height };
    };
    let lane = 0;
    const next: Line[] = [];
    for (const edge of signature ? consultEdges({ members }) : []) {
      const a = rect(edge.from);
      const b = rect(edge.to);
      if (!a || !b) continue;
      const overlapX = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const overlapY = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      let p: [number, number];
      let q: [number, number];
      let d: string;
      let mid: [number, number];
      if (overlapX > Math.min(a.w, b.w) * 0.3) {
        // One column: a bracket out of the right edge of both cards, each line a little further out so they don't sit on each other.
        const out = Math.max(a.r, b.r) + 8 + 5 * lane++;
        p = [a.r, a.t + a.h / 2];
        q = [b.r, b.t + b.h / 2];
        d = `M${p[0]} ${p[1]} C${out + 6} ${p[1]} ${out + 6} ${q[1]} ${q[0]} ${q[1]}`;
        mid = [out + 4.5, (p[1] + q[1]) / 2];
      } else if (overlapY > 0) {
        // Side by side: from the facing sides, bowed up a little.
        const left = a.l < b.l;
        p = [left ? a.r : a.l, a.t + a.h / 2];
        q = [left ? b.l : b.r, b.t + b.h / 2];
        const dx = Math.abs(q[0] - p[0]) / 2;
        const s = left ? 1 : -1;
        d = `M${p[0]} ${p[1]} C${p[0] + s * dx} ${p[1] - 18} ${q[0] - s * dx} ${q[1] - 18} ${q[0]} ${q[1]}`;
        mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 - 13];
      } else {
        // Different rows: the bottom of the upper card to the top of the lower one.
        const up = a.t < b.t;
        p = [a.l + a.w / 2, up ? a.b : a.t];
        q = [b.l + b.w / 2, up ? b.t : b.b];
        const dy = Math.abs(q[1] - p[1]) / 2;
        const s = up ? 1 : -1;
        d = `M${p[0]} ${p[1]} C${p[0]} ${p[1] + s * dy} ${q[0]} ${q[1] - s * dy} ${q[0]} ${q[1]}`;
        mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      }
      next.push({ key: `${edge.from}>${edge.to}`, d, a: p, b: q, mid, edge });
    }
    setSize({ w: box.width, h: box.height });
    setLines(next);
  }, [containerRef, members, signature]);

  // Measure after every layout change that moves cards: the chart resizing, a card growing, members changing.
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const again = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(again);
    ro.observe(root);
    root.querySelectorAll('[data-member-id]').forEach((n) => ro.observe(n));
    window.addEventListener('resize', again);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', again);
      cancelAnimationFrame(frame.current);
    };
  }, [containerRef, measure]);

  if (!lines.length) return null;
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={size.w} height={size.h} role="group" aria-label="May consult lines">
      {lines.map((l) => {
        const color = colors?.[l.edge.from] ?? 'var(--ac)';
        const from = titles[l.edge.from] ?? '';
        const to = titles[l.edge.to] ?? '';
        const label = l.edge.mutual ? `${from} and ${to} may consult each other` : `${from} may consult ${to}`;
        const on = shown === l.key;
        return (
          <g key={l.key} style={{ color }}>
            <path d={l.d} fill="none" stroke="currentColor" strokeWidth={on ? 2 : 1.5} strokeDasharray="5 4" strokeLinecap="round" opacity={on ? 0.95 : 0.6} />
            <circle cx={l.b[0]} cy={l.b[1]} r={3.5} fill="currentColor" opacity={on ? 0.95 : 0.75} />
            {l.edge.mutual && <circle cx={l.a[0]} cy={l.a[1]} r={3.5} fill="currentColor" opacity={on ? 0.95 : 0.75} />}
            {/* A wide invisible stroke to hover or focus on; its title is the tooltip. */}
            <path d={l.d} fill="none" stroke="transparent" strokeWidth={14} tabIndex={0} role="img" aria-label={label} className="pointer-events-auto cursor-help outline-none" onMouseEnter={() => setShown(l.key)} onMouseLeave={() => setShown(undefined)} onFocus={() => setShown(l.key)} onBlur={() => setShown(undefined)}>
              <title>{label}</title>
            </path>
            {on && (
              <text x={l.mid[0]} y={l.mid[1] - 6} textAnchor="middle" fontSize={10} fill="currentColor" stroke="var(--wl)" strokeWidth={3} paintOrder="stroke" className="select-none">
                may consult
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
