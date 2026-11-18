/**
 * AG16 (wave ag4): a bound Run an Agent node keeps its bubbles' box clear. The pure clearance (`clearOfBubbles`), Tidy up, placing
 * a next step with the node creator's store, and Spotlight's placement (`applyOps`) never put another node on the bubbles: a next
 * step goes right of them (+ 40), anything else below. No DOM.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { ASSUMED_BUBBLES, BUBBLE, bubbleFootprint, bubblePositions } from '@/lib/shared/agent-bubbles';
import { clearOfBubbles, footprintBox, occupiedOf, type ClearBox } from '@/components/editor/bubble-clearance';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-layout-ag4-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { useEditor } = await import('@/components/editor/store');
const { applyOps } = await import('@/lib/shared/assistant-ops');
const { corePlugin } = await import('@/lib/server/nodes');
const { bubbleGraph } = await import('@/components/canvas/agent-bubbles');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates');

const box = (id: string, x: number, y: number, bubbles = 0): ClearBox => ({ id, x, y, width: 88, height: 88, bubbles });

describe('the bubbles row', () => {
  it('is centred under the node and wraps after six', () => {
    const spots = bubblePositions(240, 5);
    expect(spots).toHaveLength(5);
    expect(spots.every((s) => s.y === BUBBLE.below)).toBe(true);
    expect(spots[0].x + (spots[4].x + BUBBLE.size - spots[0].x) / 2).toBeCloseTo(120);
    expect(bubblePositions(240, 7)[6].y).toBe(BUBBLE.below + BUBBLE.rowGap);
  });

  it('a wired sub-node is passed on the right', () => {
    const [first] = bubblePositions(240, 3, [{ x: 60, width: 88 }]);
    expect(first.x).toBeGreaterThanOrEqual(60 + 88 + 24);
  });

  it('two kept sub-nodes: the row clears both, one bubble gap from each (a single pass would land on the second)', () => {
    const gap = BUBBLE.pitch - BUBBLE.size;
    const kept = [{ x: 60, width: 64 }, { x: 60 + 64 + 60, width: 64 }];
    const spots = bubblePositions(240, 3, kept);
    const rowLeft = spots[0].x;
    for (const o of kept) expect(rowLeft >= o.x + o.width + gap || rowLeft + 2 * BUBBLE.pitch + BUBBLE.size <= o.x - gap).toBe(true);
    expect(rowLeft).toBeGreaterThanOrEqual(kept[1].x + kept[1].width + gap);
    // The footprint counts the shift, so the layout keeps clear what is drawn.
    expect(bubbleFootprint(240, 3, kept).right).toBe(rowLeft + 2 * BUBBLE.pitch + BUBBLE.size);
    expect(bubbleFootprint(240, 3).right).toBeLessThan(bubbleFootprint(240, 3, kept).right);
  });

  it('the footprint spans every bubble and their labels', () => {
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    expect(fp.bottom).toBe(BUBBLE.below + BUBBLE.size + BUBBLE.labelHeight);
    expect(fp.left).toBeLessThan(0);
  });
});

describe('clearOfBubbles', () => {
  it('moves a node on the bubble row right of the bubbles when it is a next step, and below them when it is under', () => {
    const agent = box('agent', 0, 0, 5);
    const fp = footprintBox({ ...agent, width: 88 })!;
    // The If's second branch sits a row lower (y 120): its top is inside the bubble row, so it goes right of the bubbles.
    const out = clearOfBubbles([agent, box('branch', 280, BUBBLE.below - 40), box('under', -100, BUBBLE.below + 10)]);
    expect(out.branch.x).toBe(fp.x1 + 40);
    expect(out.under.y).toBe(fp.y1 + 24);
    expect(out.agent).toBeUndefined();
  });

  it('a node in the agent’s own row, left or right of it, is never moved (a trigger before a six-bubble agent stays)', () => {
    const agent = { ...box('agent', 280, 0, 6), width: 240 };
    // trigger → agent (6 bubbles) → If, the column layout of Tidy up: 280 px apart.
    expect(clearOfBubbles([box('trigger', 0, 0), agent, box('if', 712, 0)])).toEqual({});
    expect(clearOfBubbles([box('trigger', 0, 0), agent, box('if', 280 + 337, 0)])).toEqual({});
  });

  it('a node moved below the bubbles takes its downstream main chain with it', () => {
    const agent = box('agent', 0, 0, 5);
    const fp = footprintBox(agent)!;
    const under = { ...box('under', -100, BUBBLE.below + 10), downstream: new Set(['then', 'last']) };
    const out = clearOfBubbles([agent, under, box('then', -100, BUBBLE.below + 150), box('last', -100, BUBBLE.below + 300)]);
    const d = fp.y1 + 24 - (BUBBLE.below + 10);
    expect([out.under.y, out.then.y, out.last.y]).toEqual([BUBBLE.below + 10 + d, BUBBLE.below + 150 + d, BUBBLE.below + 300 + d]);
  });

  it('a next step that moves right takes every later column with it, so the column gap stays', () => {
    const agent = { ...box('agent', 0, 0, 6), width: 240 };
    const fp = footprintBox(agent)!;
    const out = clearOfBubbles([agent, box('a', 200, BUBBLE.below - 40), box('b', 480, 0), box('c', 760, 100)]);
    const d = fp.x1 + 40 - 200;
    expect([out.a.x, out.b.x, out.c.x]).toEqual([200 + d, 480 + d, 760 + d]);
    expect(out.agent).toBeUndefined();
  });

  it('leaves a node that is clear, a node with no bubbles and a wired sub-node alone', () => {
    const agent = { ...box('agent', 0, 0, 5), subNodes: new Set(['tool']) };
    expect(clearOfBubbles([agent, box('far', 2000, 0), box('tool', 0, 200)])).toEqual({});
    expect(clearOfBubbles([box('a', 0, 0), box('b', 10, 10)])).toEqual({});
  });

  it('moves only what may move', () => {
    const out = clearOfBubbles([box('agent', 0, 0, 5), box('next', 280, BUBBLE.below), box('other', 280, BUBBLE.below + 100)], new Set(['next']));
    expect(Object.keys(out)).toEqual(['next']);
  });

  it('a tall tile (a team’s roster, measured 260 px) lowers the box to height + 64', () => {
    const tall = { ...box('team', 0, 0, 5), height: 260 };
    expect(footprintBox(tall)!.y0).toBe(260 + 64);
    expect(footprintBox(box('team', 0, 0, 5))!.y0).toBe(BUBBLE.below);
    const { nodes } = bubbleGraph([{ id: 'team', position: { x: 0, y: 0 }, width: 240, height: 260, agentName: 'Lead', request: { agentId: 'ag' } }], { team: [{ id: 'model', kind: 'model', slot: 'model', label: 'm' }] as never });
    expect(nodes[0].position.y).toBe(260 + 64);
  });
});

const node = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, name: id, type: 'core.set', typeVersion: 1, position: [x, y] as [number, number], parameters: {}, ...extra });
const main = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });
const bound = (id: string, x: number, y: number) => node(id, x, y, { type: 'core.messageAgent', parameters: { agentId: 'ag_one' } });

const coreTypes = () => Object.fromEntries(corePlugin.nodes.map((n) => [`core.${n.description.name}`, { type: `core.${n.description.name}`, pluginId: 'core', pluginName: 'Landflow Core', language: 'typescript', transport: 'in-process', available: true, descriptor: n.description }]));

describe('Tidy up', () => {
  it('keeps the trigger on the agent’s row and the next step off the bubbles', () => {
    const flow: Workflow = { id: 'wf_l', name: 'L', nodes: [node('start', 0, 0), bound('agent', 0, 0), node('after', 0, 0)], connections: [main('start', 'agent'), main('agent', 'after')] };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    useEditor.getState().tidyUp();
    const at = (id: string) => useEditor.getState().nodes.find((n) => n.id === id)!.position;
    expect(at('start').y).toBe(at('agent').y);
    expect(at('start').x).toBeLessThan(at('agent').x);
    expect(at('after').y).toBe(at('agent').y);
    expect(at('after').x).toBeGreaterThan(at('agent').x);
  });
});

describe('Tidy up after a column shift', () => {
  it.each([1, 6])('a later AI Agent stays centred over its wired sub-nodes (%i tools wired into it)', (extra) => {
    const sub = (id: string) => ({ id: `${id}-ai`, type: 'ai_tool' as const, source: id, sourceIndex: 0, target: 'ai', targetIndex: 0 });
    const tools = Array.from({ length: extra }, (_v, i) => node(`t${i}`, 0, 0));
    const flow: Workflow = {
      id: 'wf_s', name: 'S',
      nodes: [node('start', 0, 0), bound('agent', 0, 0), node('other', 0, 0), node('n1', 0, 0), node('n2', 0, 0), node('ai', 0, 0, { type: 'core.aiAgent' }), ...tools],
      connections: [main('start', 'agent'), main('start', 'other'), main('agent', 'n1'), main('other', 'n2'), main('n2', 'ai'), ...tools.map((t) => sub(t.id))],
    };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    useEditor.getState().tidyUp();
    const at = (id: string) => useEditor.getState().nodes.find((n) => n.id === id)!.position;
    const w = 240;
    const centres = tools.map((t) => at(t.id).x + 32);
    const mid = (Math.min(...centres) + Math.max(...centres)) / 2;
    const aiMid = at('ai').x + (useEditor.getState().nodes.find((n) => n.id === 'ai')!.measured?.width ?? w) / 2;
    expect(Math.abs(mid - aiMid)).toBeLessThan(2);
  });
});

describe('Tidy up keeps clear what bubbleGraph draws (a kept sub-node shifts the row)', () => {
  it('a bound node with a kept memory, then an AI Agent with wired sub-nodes: nothing sits on a drawn bubble, and no two labels overlap', () => {
    const sub = (id: string, target: string, type: 'ai_tool' | 'ai_memory' | 'ai_languageModel') => ({ id: `${id}-${target}`, type, source: id, sourceIndex: 0, target, targetIndex: 0 });
    const flow: Workflow = {
      id: 'wf_clear',
      name: 'Clear',
      nodes: [node('start', 0, 0), bound('agent', 0, 0), node('mem', 0, 0), node('n1', 0, 0), node('other', 0, 0), node('n2', 0, 0), node('ai', 0, 0, { type: 'core.aiAgent' }), node('m', 0, 0), node('t1', 0, 0), node('t2', 0, 0), node('t3', 0, 0)],
      connections: [main('start', 'agent'), main('agent', 'n1'), main('start', 'other'), main('other', 'n2'), main('n2', 'ai'), sub('mem', 'agent', 'ai_memory'), sub('m', 'ai', 'ai_languageModel'), sub('t1', 'ai', 'ai_tool'), sub('t2', 'ai', 'ai_tool'), sub('t3', 'ai', 'ai_tool')],
    };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    useEditor.getState().tidyUp();
    const { nodes, edges } = useEditor.getState();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const agent = byId.get('agent')!;
    const occupied = occupiedOf(agent, edges, byId);
    expect(occupied).toHaveLength(1); // the kept memory
    const bubbles = Array.from({ length: ASSUMED_BUBBLES }, (_v, i) => ({ id: i === 0 ? 'model' : `b${i}`, kind: i === 0 ? 'model' : 'tool', slot: i === 0 ? 'model' : 'tool', label: `Bubble ${i}` }));
    const { nodes: drawn } = bubbleGraph([{ id: 'agent', position: agent.position, width: 240, agentName: 'A', request: { agentId: 'ag_one' }, occupied }], { agent: bubbles as never });
    // Bubble boxes (64 wide, its label below) against every other node's box (88 or 240 wide, a sub-node 64).
    const sizeOf = (id: string) => (id === 'agent' || id === 'ai' ? { w: 240, h: 88 } : ['mem', 'm', 't1', 't2', 't3'].includes(id) ? { w: 64, h: 64 } : { w: 88, h: 88 });
    const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const bubbleBox = (b: { position: { x: number; y: number } }) => ({ x: b.position.x, y: b.position.y, w: BUBBLE.size, h: BUBBLE.size + BUBBLE.labelHeight });
    for (const n of nodes) {
      const s = sizeOf(n.id);
      for (const b of drawn) expect(hits({ x: n.position.x, y: n.position.y, ...s }, bubbleBox(b)), `${n.id} on ${b.id}`).toBe(false);
    }
    // Labels: a label is as wide as the pitch, centred on its circle; the kept sub-node's must not touch the first bubble's.
    const label = (cx: number, y: number) => ({ x: cx - BUBBLE.pitch / 2, y, w: BUBBLE.pitch, h: BUBBLE.size + BUBBLE.labelHeight });
    const mem = byId.get('mem')!;
    const first = drawn[0];
    expect(hits(label(mem.position.x + 32, mem.position.y), label(first.position.x + BUBBLE.size / 2, first.position.y)), 'the kept memory’s label on the model bubble’s').toBe(false);
    for (let i = 1; i < drawn.length; i++) expect(hits(label(drawn[i - 1].position.x + 32, drawn[i - 1].position.y), label(drawn[i].position.x + 32, drawn[i].position.y))).toBe(false);
    // The later AI Agent's own wired sub-nodes are the AI Agent's, not on a bubble (checked above), and Tidy up's own clearance has nothing left to move.
    const state = useEditor.getState();
    const boxes: ClearBox[] = state.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, width: sizeOf(n.id).w, height: sizeOf(n.id).h, bubbles: n.id === 'agent' ? ASSUMED_BUBBLES : 0, occupied: n.id === 'agent' ? occupied : [], subNodes: new Set(state.edges.filter((e) => e.target === n.id && e.data?.connectionType !== 'main').map((e) => e.source)) }));
    expect(clearOfBubbles(boxes)).toEqual({});
  });
});

describe('built-in templates', () => {
  const plain = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('=') && !v.includes('{{');
  const withAgents = BUILTIN_TEMPLATES.filter((t) => t.workflow.nodes.some((n) => (n.type === 'core.messageAgent' && plain(n.parameters.agentId)) || (n.type === 'core.runTeam' && plain(n.parameters.teamId))));

  it('there are some with a Run an Agent or Run a Team node', () => {
    expect(withAgents.length).toBeGreaterThan(0);
  });

  it('open unchanged, and are overlap-free after Tidy up', () => {
    for (const t of withAgents) {
      const flow = { ...t.workflow, id: `wf_${t.id}` } as Workflow;
      useEditor.getState().load(flow, []);
      useEditor.setState({ nodeTypes: coreTypes() as never });
      const opened = useEditor.getState().nodes.map((n) => [n.id, n.position.x, n.position.y]);
      expect(opened, `${t.id} opened`).toEqual(flow.nodes.map((n) => [n.id, n.position[0], n.position[1]]));
      useEditor.getState().tidyUp();
      const state = useEditor.getState();
      const boxes: ClearBox[] = state.nodes.map((n) => {
        const w = n.data.wf;
        const isBound = (w.type === 'core.messageAgent' && plain(w.parameters.agentId)) || (w.type === 'core.runTeam' && plain(w.parameters.teamId));
        const wide = Object.values(state.nodeTypes).find((i) => i.type === w.type)?.descriptor.inputs.some((p) => p.type !== 'main');
        return { id: n.id, x: n.position.x, y: n.position.y, width: wide ? 240 : 88, height: 88, bubbles: isBound ? ASSUMED_BUBBLES : 0, subNodes: new Set(state.edges.filter((e) => e.target === n.id && e.data?.connectionType !== 'main').map((e) => e.source)) };
      });
      expect(clearOfBubbles(boxes), `${t.id} after Tidy up`).toEqual({});
    }
  });
});

describe('a flow saved before ag4', () => {
  it('keeps every position on open', () => {
    const flow: Workflow = { id: 'wf_old', name: 'Old', nodes: [node('start', 40, 60), bound('agent', 320, 60), node('x', 330, 200), node('after', 600, 60)], connections: [main('start', 'agent'), main('agent', 'after')] };
    useEditor.getState().load(flow, []);
    expect(useEditor.getState().nodes.map((n) => [n.id, n.position.x, n.position.y])).toEqual(flow.nodes.map((n) => [n.id, n.position[0], n.position[1]]));
  });
});

describe('placing a next step', () => {
  it('lands clear of a bound node’s bubbles, and in its row when the row is free', () => {
    const flow: Workflow = { id: 'wf_p', name: 'P', nodes: [node('start', 0, 0), bound('agent', 280, 0)], connections: [main('start', 'agent')] };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    const id = useEditor.getState().placeNode('core.set', { from: { nodeId: 'agent', handleId: 'main:0', handleType: 'source' } }, { x: 520, y: 0 });
    const placed = useEditor.getState().nodes.find((n) => n.id === id)!;
    expect(placed.position.y).toBe(0);
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    expect(placed.position.x).toBeGreaterThanOrEqual(280 + 240);
    expect(placed.position.y + 88 <= BUBBLE.below || placed.position.x >= 280 + fp.right + 40).toBe(true);
  });

  it('a trigger placed before the agent stays on its row', () => {
    const flow: Workflow = { id: 'wf_t', name: 'T', nodes: [bound('agent', 280, 0)], connections: [] };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    const id = useEditor.getState().placeNode('core.set', {}, { x: 0, y: 0 });
    expect(useEditor.getState().nodes.find((n) => n.id === id)!.position).toMatchObject({ x: 0, y: 0 });
  });
});

describe('Spotlight placement', () => {
  const types = Object.fromEntries(corePlugin.nodes.map((n) => [`core.${n.description.name}`, n.description]));
  const lookup = (t: string) => types[t] as never;

  it('puts a step added after a bound node in its row, never on a bubble', () => {
    const wf: Workflow = { id: 'wf_s', name: 'S', nodes: [bound('agent', 0, 0)], connections: [] };
    const out = applyOps(wf, [{ op: 'addNode', type: 'core.noOp', name: 'Then', after: 'agent' }], lookup);
    const then = out.workflow.nodes.find((n) => n.name === 'Then')!;
    expect(then.position[1] + 88).toBeLessThanOrEqual(BUBBLE.below);
  });

  it('a step before the agent stays on its row, left of it', () => {
    const wf: Workflow = { id: 'wf_s2', name: 'S2', nodes: [bound('agent', 560, 0)], connections: [] };
    const out = applyOps(wf, [{ op: 'addNode', type: 'core.noOp', name: 'Before', before: 'agent' }], lookup);
    const before = out.workflow.nodes.find((n) => n.name === 'Before')!;
    const agent = out.workflow.nodes.find((n) => n.id === 'agent')!;
    expect(before.position[1]).toBe(agent.position[1]);
    expect(before.position[0]).toBeLessThan(agent.position[0]);
  });
});
