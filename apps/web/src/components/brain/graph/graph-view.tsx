'use client';
/**
 * The Graph tab of the Brain workbench (docs/second-brain.md#the-graph): the facts the caller may see as a force graph on a
 * canvas, subjects as squares and facts as dots, with Show history (version edges and earlier versions, faded), Show
 * forgotten, Fit and Load more. Hover a node for its details; click a subject to open its page and a fact for its versions.
 * Pan by dragging, zoom with the wheel or + and -, 0 fits everything, arrows pan. On a phone, and from the List switch, the
 * same data is a list (./graph-list.tsx). Reads happen on opening, on a toggle and on Load more: no timer. Adapted from
 * Supermemory's memory-graph canvas component (see ./NOTICE.md); this module builds no zod schema (CSP rule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { usePhone } from '@/lib/client/use-phone';
import { plural } from '@/lib/client/format';
import { type GraphFactNode, type GraphNode, type GraphPage } from '@/lib/shared/brain-graph';
import type { BrainFact } from '@/lib/shared/brain';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state';
import { Switch } from '../../ui/inputs';
import { Segmented } from '../../ui/segmented';
import { FactHistory } from '../fact-history';
import { GraphList } from './graph-list';
import { SpatialIndex } from './hit-test';
import { Legend } from './legend';
import { mergePage, type GraphData } from './merge';
import { NodePopover } from './popover';
import { draw, readColors } from './renderer';
import { ForceSimulation } from './simulation';
import { FACT_SIZE, SUBJECT_SIZE, type LayoutEdge, type LayoutNode } from './types';
import { VersionChainIndex } from './version-chain';
import { applyKey, ViewportState } from './viewport';

const EMPTY: GraphData = { nodes: [], edges: [] };

/** The route's query for the current toggles. */
export function graphUrl(o: { about?: string; depth: 1 | 2; history: boolean; forgotten: boolean; cursor?: string }): string {
  const q = new URLSearchParams({ depth: String(o.depth), history: o.history ? '1' : '0', forgotten: o.forgotten ? '1' : '0', limit: '500' });
  if (o.about) q.set('about', o.about);
  if (o.cursor) q.set('cursor', o.cursor);
  return `/api/brain/graph?${q}`;
}

export function GraphView({ about, onOpenPage }: { about?: string; onOpenPage: (ref: string) => void }) {
  const phone = usePhone();
  const [mode, setMode] = useState<'graph' | 'list'>('graph');
  const [history, setHistory] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [data, setData] = useState<GraphData>(EMPTY);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [versions, setVersions] = useState<BrainFact>();
  const [hover, setHover] = useState<{ node: GraphNode; x: number; y: number }>();
  const seq = useRef(0);

  const load = useCallback(
    (reset: boolean, from?: string) => {
      const mine = ++seq.current;
      setLoading(true);
      api<GraphPage>(graphUrl({ about, depth, history, forgotten, cursor: from }))
        .then((page) => {
          if (mine !== seq.current) return;
          setData((current) => mergePage(reset ? EMPTY : current, page, history));
          setCursor(page.nextCursor);
          setError(undefined);
        })
        .catch((e: Error) => mine === seq.current && setError(e.message))
        .finally(() => mine === seq.current && setLoading(false));
    },
    [about, depth, history, forgotten],
  );
  // A read on opening and on a toggle: a person's action, never a timer.
  useEffect(() => load(true), [load]);

  const facts = data.nodes.filter((n) => n.kind === 'fact').length;
  const openVersions = (fact: GraphFactNode, subject: string) =>
    setVersions({ id: fact.factId, subjectType: 'workflow', subjectId: subject, subjectName: subject, kind: fact.factKind, statement: fact.statement, evidence: [], confidence: fact.confidence, firstSeen: fact.firstSeen, lastSeen: fact.lastSeen, status: fact.status });
  const showList = phone || mode === 'list';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-t2">
        <label className="flex items-center gap-2 max-md:min-h-11">
          <Switch checked={history} onChange={setHistory} label="Show history" />
          Show history
        </label>
        <label className="flex items-center gap-2 max-md:min-h-11">
          <Switch checked={forgotten} onChange={setForgotten} label="Show forgotten" />
          Show forgotten
        </label>
        {about && <Segmented label="Reach" size="sm" value={String(depth) as '1' | '2'} onChange={(v) => setDepth(v === '2' ? 2 : 1)} options={[{ value: '1', label: 'This page' }, { value: '2', label: 'One link away' }]} />}
        {!phone && <Segmented label="View" size="sm" value={mode} onChange={setMode} options={[{ value: 'graph', label: 'Graph' }, { value: 'list', label: 'List' }]} />}
        <span className="text-t3" aria-live="polite">
          {loading ? 'Loading…' : plural(facts, 'fact')}
        </span>
        {cursor && (
          <Button size="sm" className="max-md:h-11" disabled={loading} onClick={() => load(false, cursor)}>
            Load more
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-rd">
          {error}
        </p>
      )}
      {!loading && !error && data.nodes.length === 0 ? (
        <EmptyState title="Nothing to draw yet" hint="Facts appear here as the brain learns about your work." />
      ) : showList ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GraphList data={data} onOpenPage={onOpenPage} onVersions={openVersions} />
        </div>
      ) : (
        <GraphCanvas data={data} history={history} onHover={setHover} onOpenPage={onOpenPage} onVersions={openVersions} hover={hover} />
      )}
      {versions && <FactHistory fact={versions} onClose={() => setVersions(undefined)} />}
    </div>
  );
}

function GraphCanvas({ data, history, hover, onHover, onOpenPage, onVersions }: { data: GraphData; history: boolean; hover?: { node: GraphNode; x: number; y: number }; onHover: (h?: { node: GraphNode; x: number; y: number }) => void; onOpenPage: (ref: string) => void; onVersions: (fact: GraphFactNode, subject: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef({
    sim: new ForceSimulation(),
    viewport: new ViewportState(0, 0, 1),
    index: new SpatialIndex(),
    chains: new VersionChainIndex(),
    nodes: new Map<string, LayoutNode>(),
    edges: [] as LayoutEdge[],
    size: { w: 0, h: 0 },
    hovered: undefined as string | undefined,
    fitted: false,
    raf: 0,
  });
  const labels = useMemo(() => new Map(data.nodes.flatMap((n) => (n.kind === 'subject' ? [[n.id, n.label] as const] : []))), [data]);
  const subjectOfFact = useMemo(() => new Map(data.edges.filter((e) => e.type === 'about').map((e) => [e.from, e.to])), [data]);

  const frame = useCallback(() => {
    const e = engine.current;
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    e.raf = 0;
    if (!el || !ctx || !wrap.current) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let active = e.sim.frame(performance.now(), document.hidden);
    // Reduce motion: no animated settling, the layout is finished before it is shown.
    for (let t = 0; reduced && active && t < 400; t++) active = e.sim.frame(performance.now() + t * 16, false);
    const moving = e.viewport.tick();
    if (!active && !e.fitted && e.nodes.size) {
      e.viewport.fitToNodes([...e.nodes.values()], e.size.w, e.size.h, { animate: false });
      e.viewport.setMinZoomForNodes([...e.nodes.values()], e.size.w, e.size.h);
      e.fitted = true;
    }
    const nodes = [...e.nodes.values()];
    e.index.rebuild(nodes);
    draw(ctx, { width: e.size.w, height: e.size.h, dpr: window.devicePixelRatio || 1, viewport: e.viewport, nodes, edges: e.edges, colors: readColors(wrap.current), hoveredId: e.hovered });
    if (active || moving) e.raf = requestAnimationFrame(frame);
  }, []);
  const schedule = useCallback(() => {
    if (!engine.current.raf) engine.current.raf = requestAnimationFrame(frame);
  }, [frame]);

  // The data changed: keep settled nodes where they are, put new ones next to their subject, let the layout run again.
  useEffect(() => {
    const e = engine.current;
    e.chains.rebuild(data.nodes);
    const first = e.nodes.size === 0;
    const next = new Map<string, LayoutNode>();
    const subjectPos = (factId: string) => e.nodes.get(subjectOfFact.get(factId) ?? '');
    data.nodes.forEach((n, i) => {
      const old = e.nodes.get(n.id);
      const faded = n.kind === 'fact' && !n.latest;
      if (old) {
        old.data = n;
        old.faded = faded;
        next.set(n.id, old);
        return;
      }
      const anchor = n.kind === 'fact' ? subjectPos(n.id) : undefined;
      const angle = i * 2.399963;
      next.set(n.id, { id: n.id, kind: n.kind, data: n, size: n.kind === 'subject' ? SUBJECT_SIZE : FACT_SIZE, faded, x: (anchor?.x ?? 0) + Math.cos(angle) * (20 + (i % 7) * 6), y: (anchor?.y ?? 0) + Math.sin(angle) * (20 + (i % 7) * 6) });
    });
    e.nodes = next;
    e.edges = data.edges.filter((ed) => next.has(ed.from) && next.has(ed.to)).map((ed) => ({ source: ed.from, target: ed.to, type: ed.type }));
    e.fitted = !first && e.fitted;
    if (first) e.sim.init([...next.values()], e.edges);
    else e.sim.update([...next.values()], e.edges);
    schedule();
  }, [data, schedule, subjectOfFact]);

  // Size and pixel density, a hidden tab pausing the layout and the theme changing.
  useEffect(() => {
    const e = engine.current;
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      e.size = { w: r.width, h: r.height };
      el.width = Math.max(1, Math.floor(r.width * dpr));
      el.height = Math.max(1, Math.floor(r.height * dpr));
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      if (!e.fitted && e.nodes.size) e.viewport.fitToNodes([...e.nodes.values()], r.width, r.height, { animate: false });
      else if (!e.nodes.size) {
        e.viewport.panX = r.width / 2;
        e.viewport.panY = r.height / 2;
      }
      schedule();
    };
    const visible = () => {
      if (!document.hidden && e.sim.wasPaused) {
        e.sim.resume();
        schedule();
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    dark.addEventListener('change', schedule);
    document.addEventListener('visibilitychange', visible);
    resize();
    return () => {
      ro.disconnect();
      dark.removeEventListener('change', schedule);
      document.removeEventListener('visibilitychange', visible);
      cancelAnimationFrame(e.raf);
      e.raf = 0;
      e.sim.destroy();
      e.nodes.clear();
    };
  }, [schedule]);

  // Pointer: drag to pan, wheel to zoom, hover for details, click to open.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const nodeAt = (p: { x: number; y: number }) => {
    const e = engine.current;
    const w = e.viewport.screenToWorld(p.x, p.y);
    return e.index.queryPoint(w.x, w.y);
  };
  const hoverAt = (p: { x: number; y: number }) => {
    const e = engine.current;
    const n = nodeAt(p);
    if (n?.id === e.hovered) return;
    e.hovered = n?.id;
    onHover(n ? { node: n.data, x: p.x, y: p.y } : undefined);
    schedule();
  };
  const subjectLabel = (n: GraphNode) => (n.kind === 'fact' ? labels.get(subjectOfFact.get(n.id) ?? '') : undefined);

  return (
    <div ref={wrap} className="relative min-h-[360px] flex-1 overflow-hidden rounded-xl border border-hair bg-sf2">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="application"
        aria-label="Memory graph. Plus and minus zoom, 0 fits everything, arrow keys pan. Use the List view to read it as text."
        className="block touch-none cursor-grab outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ac active:cursor-grabbing"
        onPointerDown={(ev) => {
          ev.currentTarget.setPointerCapture(ev.pointerId);
          drag.current = { ...at(ev), moved: false };
          engine.current.viewport.cancelAnimation();
        }}
        onPointerMove={(ev) => {
          const p = at(ev);
          const d = drag.current;
          if (d) {
            const dx = p.x - d.x;
            const dy = p.y - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
            engine.current.viewport.pan(dx, dy);
            d.x = p.x;
            d.y = p.y;
            schedule();
          } else hoverAt(p);
        }}
        onPointerUp={(ev) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved) return;
          const n = nodeAt(at(ev));
          if (!n) return;
          if (n.data.kind === 'subject' && n.data.page) onOpenPage(n.data.page);
          else if (n.data.kind === 'fact') onVersions(n.data, subjectLabel(n.data) ?? '');
        }}
        onPointerLeave={() => {
          engine.current.hovered = undefined;
          onHover(undefined);
          schedule();
        }}
        onWheel={(ev) => {
          const p = at(ev);
          engine.current.viewport.zoomImmediate(ev.deltaY < 0 ? 1.1 : 1 / 1.1, p.x, p.y);
          schedule();
        }}
        onKeyDown={(ev) => {
          const e = engine.current;
          if (applyKey(e.viewport, ev.key, [...e.nodes.values()], e.size.w, e.size.h)) {
            ev.preventDefault();
            schedule();
          }
        }}
      />
      <div className="pointer-events-none absolute bottom-3 left-3">
        <Legend history={history} />
      </div>
      <div className="absolute right-3 top-3">
        <Button
          size="sm"
          onClick={() => {
            const e = engine.current;
            e.viewport.fitToNodes([...e.nodes.values()], e.size.w, e.size.h);
            schedule();
          }}
        >
          Fit
        </Button>
      </div>
      {hover && (
        <div className="pointer-events-none absolute" style={{ left: Math.min(Math.max(hover.x + 14, 8), Math.max(8, engine.current.size.w - 316)), top: Math.min(Math.max(hover.y + 14, 8), Math.max(8, engine.current.size.h - 200)) }}>
          <NodePopover node={hover.node} subject={subjectLabel(hover.node)} />
        </div>
      )}
    </div>
  );
}
