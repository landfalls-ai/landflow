/**
 * C10: the Graph tab's client modules (components/brain/graph/): the layout simulation and its
 * 2 s budget, the viewport (fit, keys), the hit test, joining pages, the popover (text, never HTML), the list a phone gets,
 * the legend, and the CSP rule that no module builds a zod schema.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupBySubject, GraphList } from '@/components/brain/graph/graph-list';
import { graphUrl } from '@/components/brain/graph/graph-view';
import { SpatialIndex } from '@/components/brain/graph/hit-test';
import { Legend } from '@/components/brain/graph/legend';
import { mergePage } from '@/components/brain/graph/merge';
import { NodePopover } from '@/components/brain/graph/popover';
import { FORCE_CONFIG, ForceSimulation, handleVisibility, SETTLE_BUDGET_MS } from '@/components/brain/graph/simulation';
import { FACT_SIZE, SUBJECT_SIZE, type LayoutEdge, type LayoutNode } from '@/components/brain/graph/types';
import { applyKey, ViewportState } from '@/components/brain/graph/viewport';
import { factNodeId, subjectNodeId, type GraphEdge, type GraphFactNode, type GraphNode, type GraphSubjectNode } from '@/lib/shared/brain-graph';

const subject = (id: string, label = id): GraphSubjectNode => ({ id: subjectNodeId('entity', id), kind: 'subject', subjectType: 'entity', subjectId: id, label, page: id });
const fact = (id: string, patch: Partial<GraphFactNode> = {}): GraphFactNode => ({ id: factNodeId(id), kind: 'fact', factId: id, chainId: id.split('#')[0]!, statement: `Statement ${id}`, factKind: 'health', version: 1, latest: true, confidence: 0.7, firstSeen: '2026-11-01T00:00:00Z', lastSeen: '2026-11-02T00:00:00Z', status: 'active', ...patch });
const chain: GraphNode[] = [fact('h#v1', { latest: false }), fact('h#v2', { latest: false, version: 2, parentId: 'h#v1', relation: 'updates' }), fact('h', { version: 3, parentId: 'h#v2', relation: 'updates' })];

const layout = (n: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } => {
  const nodes: LayoutNode[] = [{ id: 's', kind: 'subject', data: subject('s'), x: 0, y: 0, size: SUBJECT_SIZE, faded: false }];
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < n - 1; i++) {
    nodes.push({ id: `f${i}`, kind: 'fact', data: fact(`f${i}`), x: Math.cos(i) * 10, y: Math.sin(i) * 10, size: FACT_SIZE, faded: false });
    edges.push({ source: `f${i}`, target: 's', type: 'about' });
  }
  return { nodes, edges };
};

describe('the simulation (FR-7)', () => {
  it('settles 500 nodes within its 2 s budget on a fake clock', () => {
    const { nodes, edges } = layout(500);
    const sim = new ForceSimulation();
    sim.init(nodes, edges);
    let now = 1000;
    let frames = 0;
    // Each frame costs 16 ms of the fake clock: a graph that never settles must still stop at the budget.
    while (sim.frame(now) && frames < 1000) {
      now += 16;
      frames++;
    }
    expect(frames).toBeLessThan(Math.ceil(SETTLE_BUDGET_MS / 16) + 1);
    expect(sim.isActive()).toBe(false);
    expect(sim.frame(now + 16)).toBe(false);
    expect(Number.isFinite(nodes[1]!.x)).toBe(true);
  });
  it('pauses when the tab is hidden, keeps its heat, and finishes with a fresh budget when shown', () => {
    const { nodes, edges } = layout(500);
    const sim = new ForceSimulation();
    sim.init(nodes, edges);
    expect(sim.frame(0)).toBe(true);
    // The tab is hidden: no frames fire, then the person comes back after 10 s.
    expect(handleVisibility(sim, true)).toBe(false);
    expect(sim.isPaused).toBe(true);
    expect(sim.isActive()).toBe(true);
    expect(sim.frame(16)).toBe(false);
    // Shown again: not stopped half-settled by the time that passed.
    expect(handleVisibility(sim, false)).toBe(true);
    expect(sim.isPaused).toBe(false);
    expect(sim.frame(10_000)).toBe(true);
    expect(sim.frame(10_016)).toBe(true);
  });
  it('does not wake a layout that had already settled', () => {
    const { nodes, edges } = layout(10);
    const sim = new ForceSimulation();
    sim.init(nodes, edges);
    for (let t = 0; sim.frame(t * 16); t++);
    expect(handleVisibility(sim, true)).toBe(false);
    expect(handleVisibility(sim, false)).toBe(false);
  });
  it('keeps settled positions when nodes are added', () => {
    const { nodes, edges } = layout(30);
    const sim = new ForceSimulation();
    sim.init(nodes, edges);
    for (let t = 0; sim.frame(t * 16); t++);
    const before = { x: nodes[3]!.x, y: nodes[3]!.y };
    sim.update([...nodes, { id: 'new', kind: 'fact', data: fact('new'), x: before.x + 5, y: before.y, size: FACT_SIZE, faded: false }], [...edges, { source: 'new', target: 's', type: 'about' }]);
    expect(Math.hypot(nodes[3]!.x - before.x, nodes[3]!.y - before.y)).toBeLessThan(5);
    expect(FORCE_CONFIG.preSettleTicks).toBeGreaterThan(0);
  });
});

describe('the viewport and hit test (AS-6)', () => {
  it('fits every node into the view', () => {
    const { nodes } = layout(200);
    nodes.forEach((n, i) => ((n.x = (i % 20) * 90 - 400), (n.y = Math.floor(i / 20) * 70 - 300)));
    const vp = new ViewportState(0, 0, 1);
    vp.fitToNodes(nodes, 1000, 700, { animate: false });
    for (const n of nodes) {
      const p = vp.worldToScreen(n.x, n.y);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1000);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(700);
    }
  });
  it('answers + - 0 and the arrow keys', () => {
    const { nodes } = layout(20);
    const vp = new ViewportState(10, 20, 1);
    expect(applyKey(vp, '+', nodes, 800, 600)).toBe(true);
    expect(vp.zoom).toBeGreaterThan(1);
    expect(applyKey(vp, '-', nodes, 800, 600)).toBe(true);
    expect(vp.zoom).toBeCloseTo(1, 5);
    const panX = vp.panX;
    expect(applyKey(vp, 'ArrowLeft', nodes, 800, 600)).toBe(true);
    expect(vp.panX).toBeGreaterThan(panX);
    vp.pan(5000, 5000);
    expect(applyKey(vp, '0', nodes, 800, 600)).toBe(true);
    const p = vp.worldToScreen(nodes[0]!.x, nodes[0]!.y);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(800);
    expect(applyKey(vp, 'q', nodes, 800, 600)).toBe(false);
  });
  it('finds the node under a point', () => {
    const { nodes } = layout(10);
    nodes[2]!.x = 400;
    nodes[2]!.y = 400;
    const index = new SpatialIndex();
    index.rebuild(nodes);
    expect(index.queryPoint(402, 399)?.id).toBe(nodes[2]!.id);
    expect(index.queryPoint(900, 900)).toBeNull();
  });
});

describe('joining pages', () => {
  it('merges repeated subjects and joins a version to a parent that came on the other page', () => {
    const about = (f: GraphNode, s: GraphNode): GraphEdge => ({ from: f.id, to: s.id, type: 'about' });
    const s = subject('customer/acme');
    const [v1, , v3] = chain as [GraphFactNode, GraphFactNode, GraphFactNode];
    const first = mergePage({ nodes: [], edges: [] }, { nodes: [s, v3], edges: [about(v3, s)] }, true);
    expect(first.edges.filter((e) => e.type === 'updates')).toHaveLength(0);
    const second = mergePage(first, { nodes: [s, chain[1]!, v1], edges: [about(v1, s), about(chain[1]!, s), { from: v1.id, to: chain[1]!.id, type: 'updates' }] }, true);
    expect(second.nodes.filter((n) => n.kind === 'subject')).toHaveLength(1);
    expect(second.edges.filter((e) => e.type === 'updates')).toHaveLength(2);
    // With history off no version edge is drawn.
    expect(mergePage(first, { nodes: [chain[1]!], edges: [] }, false).edges.filter((e) => e.type === 'updates')).toHaveLength(0);
  });
  it('builds the route query from the toggles', () => {
    expect(graphUrl({ about: 'customer/acme', depth: 2, history: true, forgotten: false, cursor: 'c' })).toBe('/api/brain/graph?depth=2&history=1&forgotten=0&limit=500&about=customer%2Facme&cursor=c');
  });
});

describe('what a node shows (AS-5, FR-9)', () => {
  it('renders a statement as text, never HTML', () => {
    const html = renderToStaticMarkup(createElement(NodePopover, { node: fact('x', { statement: '<script>x</script>' }), subject: 'Acme' }));
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Version 1, now');
    expect(html).toContain('70%');
  });
  it('groups the phone list by subject and indents later versions', () => {
    const s = subject('customer/acme', 'Acme');
    const data = { nodes: [s, ...chain, fact('other')], edges: [...chain, fact('other')].map((f) => ({ from: f.id, to: s.id, type: 'about' as const })) };
    const groups = groupBySubject(data);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.subject.label).toBe('Acme');
    expect(groups[0]!.facts.filter((f) => f.node.chainId === 'h').map((f) => f.depth)).toEqual([0, 1, 2]);
    // An unrelated fact seen between the chain's versions must not split it or reorder its versions.
    const mixed = { nodes: [s, fact('z', { lastSeen: '2026-11-02T12:00:00Z' }), ...chain, fact('y', { lastSeen: '2026-11-02T12:00:00Z' })], edges: [fact('z'), ...chain, fact('y')].map((f) => ({ from: f.id, to: s.id, type: 'about' as const })) };
    const order = groupBySubject(mixed)[0]!.facts.map((f) => f.node.factId);
    expect(order).toEqual(['y', 'z', 'h#v1', 'h#v2', 'h']);
    const html = renderToStaticMarkup(createElement(GraphList, { data, onOpenPage: () => undefined, onVersions: () => undefined }));
    expect(html).toContain('Acme');
    expect(html).toContain('margin-left:32px');
    expect(html).toContain('Open page');
  });
  it('names the edge types in the legend', () => {
    const html = renderToStaticMarkup(createElement(Legend, { history: true }));
    for (const word of ['Updates', 'Extends', 'Derives', 'About']) expect(html).toContain(word);
    expect(renderToStaticMarkup(createElement(Legend, { history: false }))).not.toContain('Updates');
  });
});

describe('the CSP rule (FR-10)', () => {
  it('builds no zod schema in the client modules or the shared types', () => {
    const dir = join(__dirname, '..', 'src', 'components', 'brain', 'graph');
    const files = [...readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(dir, f)), join(__dirname, '..', 'src', 'lib', 'shared', 'brain-graph.ts')];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"]zod|\bz\.object\(/);
  });
  it('keeps the MIT header on every file adapted from Supermemory', () => {
    const dir = join(__dirname, '..', 'src', 'components', 'brain', 'graph');
    for (const f of ['simulation.ts', 'viewport.ts', 'hit-test.ts']) expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/Supermemory[\s\S]*MIT[\s\S]*Copyright \(c\) 2025 supermemory/);
  });
});
