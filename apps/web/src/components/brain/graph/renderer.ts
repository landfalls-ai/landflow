/**
 * Draws the graph on a 2D canvas: edges (About thin and grey, Updates, Extends and Derives in colour with an arrow),
 * subjects as rounded squares, facts as dots (earlier versions faded, stale ones hollow, forgotten ones dashed in red).
 * Colours are the app's tokens read from CSS variables once per draw, so light and dark both work. Written for Landflow
 * after the structure of Supermemory's memory-graph renderer (see ./NOTICE.md); none of its drawing code is copied.
 */
import type { GraphEdgeType } from '@/lib/shared/brain-graph';
import type { LayoutEdge, LayoutNode } from './types';
import type { ViewportState } from './viewport';

export interface GraphColors {
  bg: string;
  text: string;
  textMuted: string;
  hair: string;
  subject: string;
  onSubject: string;
  fact: string;
  accent: string;
  danger: string;
  edge: Record<GraphEdgeType, string>;
}

const VARS = { bg: '--bg', text: '--t1', textMuted: '--t3', hair: '--bd', subject: '--ac', onSubject: '--on-ac', fact: '--t2', accent: '--viz-1', danger: '--rd', updates: '--viz-1', extends: '--viz-3', derives: '--viz-5', about: '--t3' } as const;

/** The tokens as the element sees them (a theme change is picked up on the next draw). */
export function readColors(el: Element): GraphColors {
  const style = getComputedStyle(el);
  const v = (name: keyof typeof VARS) => style.getPropertyValue(VARS[name]).trim() || '#888';
  return {
    bg: v('bg'),
    text: v('text'),
    textMuted: v('textMuted'),
    hair: v('hair'),
    subject: v('subject'),
    onSubject: v('onSubject'),
    fact: v('fact'),
    accent: v('accent'),
    danger: v('danger'),
    edge: { about: v('about'), updates: v('updates'), extends: v('extends'), derives: v('derives') },
  };
}

export interface DrawState {
  width: number;
  height: number;
  dpr: number;
  viewport: ViewportState;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  colors: GraphColors;
  hoveredId?: string;
  selectedId?: string;
}

const endpoint = (e: string | LayoutNode): LayoutNode | undefined => (typeof e === 'string' ? undefined : e);

export function draw(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { viewport: vp, colors: c } = s;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.clearRect(0, 0, s.width, s.height);
  ctx.save();
  ctx.translate(vp.panX, vp.panY);
  ctx.scale(vp.zoom, vp.zoom);

  const inView = (n: LayoutNode) => {
    const p = vp.worldToScreen(n.x, n.y);
    const r = n.size * vp.zoom;
    return p.x > -r && p.y > -r && p.x < s.width + r && p.y < s.height + r;
  };

  for (const e of s.edges) {
    const a = endpoint(e.source);
    const b = endpoint(e.target);
    if (!a || !b || (!inView(a) && !inView(b))) continue;
    const version = e.type !== 'about';
    const faded = a.faded || b.faded;
    ctx.globalAlpha = version ? (faded ? 0.55 : 0.9) : faded ? 0.25 : 0.5;
    ctx.strokeStyle = c.edge[e.type];
    ctx.lineWidth = (version ? 1.8 : 1) / Math.max(vp.zoom, 0.4);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (version) arrow(ctx, a, b, c.edge[e.type], vp.zoom);
  }

  for (const n of s.nodes) {
    if (!inView(n)) continue;
    const active = n.id === s.hoveredId || n.id === s.selectedId;
    ctx.globalAlpha = n.faded ? 0.4 : 1;
    if (n.kind === 'subject') subject(ctx, n, c, active);
    else fact(ctx, n, c, active);
    if (vp.zoom >= 1.4 || n.kind === 'subject') label(ctx, n, c, vp.zoom);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function subject(ctx: CanvasRenderingContext2D, n: LayoutNode, c: GraphColors, active: boolean) {
  const h = n.size / 2;
  ctx.fillStyle = c.subject;
  ctx.beginPath();
  ctx.roundRect(n.x - h, n.y - h, n.size, n.size, 6);
  ctx.fill();
  if (active) ring(ctx, n, c.accent, h + 3);
}

function fact(ctx: CanvasRenderingContext2D, n: LayoutNode, c: GraphColors, active: boolean) {
  if (n.data.kind !== 'fact') return;
  const r = n.size / 2;
  ctx.beginPath();
  ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  if (n.data.forgotten) {
    ctx.fillStyle = c.bg;
    ctx.fill();
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = c.danger;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (n.data.status === 'stale') {
    ctx.fillStyle = c.bg;
    ctx.fill();
    ctx.strokeStyle = c.fact;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = c.fact;
    ctx.fill();
  }
  if (active) ring(ctx, n, c.accent, r + 3);
}

function ring(ctx: CanvasRenderingContext2D, n: LayoutNode, color: string, radius: number) {
  ctx.beginPath();
  ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, a: LayoutNode, b: LayoutNode, color: string, zoom: number) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const tip = { x: b.x - Math.cos(angle) * (b.size / 2 + 2), y: b.y - Math.sin(angle) * (b.size / 2 + 2) };
  const len = 7 / Math.max(zoom, 0.5);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - Math.cos(angle - 0.45) * len, tip.y - Math.sin(angle - 0.45) * len);
  ctx.lineTo(tip.x - Math.cos(angle + 0.45) * len, tip.y - Math.sin(angle + 0.45) * len);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, n: LayoutNode, c: GraphColors, zoom: number) {
  const text = n.data.kind === 'subject' ? n.data.label : n.data.statement;
  if (!text) return;
  const size = 11 / zoom;
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = n.data.kind === 'subject' ? c.text : c.textMuted;
  const shown = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  ctx.fillText(shown, n.x, n.y + n.size / 2 + 3);
}
