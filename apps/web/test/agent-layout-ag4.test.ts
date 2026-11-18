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
import { clearOfBubbles, footprintBox, type ClearBox } from '@/components/editor/bubble-clearance';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-layout-ag4-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { useEditor } = await import('@/components/editor/store');
const { applyOps } = await import('@/lib/shared/assistant-ops');
const { corePlugin } = await import('@/lib/server/nodes');

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

  it('the footprint spans every bubble and their labels', () => {
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    expect(fp.bottom).toBe(BUBBLE.below + BUBBLE.size + BUBBLE.labelHeight);
    expect(fp.left).toBeLessThan(0);
  });
});

describe('clearOfBubbles', () => {
  it('moves a next step right of the bubbles and a node under them below', () => {
    const agent = box('agent', 0, 0, 5);
    const fp = footprintBox({ ...agent, width: 88 })!;
    const out = clearOfBubbles([agent, box('next', 280, 0), box('under', -100, 200)]);
    expect(out.next.x).toBe(fp.x1 + 40);
    expect(out.under.y).toBe(fp.y1 + 24);
    expect(out.agent).toBeUndefined();
  });

  it('leaves a node that is clear, a node with no bubbles and a wired sub-node alone', () => {
    const agent = { ...box('agent', 0, 0, 5), subNodes: new Set(['tool']) };
    expect(clearOfBubbles([agent, box('far', 2000, 0), box('tool', 0, 200)])).toEqual({});
    expect(clearOfBubbles([box('a', 0, 0), box('b', 10, 10)])).toEqual({});
  });

  it('moves only what may move', () => {
    const out = clearOfBubbles([box('agent', 0, 0, 5), box('next', 280, 0), box('other', 280, 100)], new Set(['next']));
    expect(Object.keys(out)).toEqual(['next']);
  });
});

const node = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, name: id, type: 'core.set', typeVersion: 1, position: [x, y] as [number, number], parameters: {}, ...extra });
const main = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });
const bound = (id: string, x: number, y: number) => node(id, x, y, { type: 'core.messageAgent', parameters: { agentId: 'ag_one' } });

const coreTypes = () => Object.fromEntries(corePlugin.nodes.map((n) => [`core.${n.description.name}`, { type: `core.${n.description.name}`, pluginId: 'core', pluginName: 'Landflow Core', language: 'typescript', transport: 'in-process', available: true, descriptor: n.description }]));

describe('Tidy up', () => {
  it('keeps the next step off the agent node’s bubbles', () => {
    const flow: Workflow = { id: 'wf_l', name: 'L', nodes: [node('start', 0, 0), bound('agent', 0, 0), node('after', 0, 0)], connections: [main('start', 'agent'), main('agent', 'after')] };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    useEditor.getState().tidyUp();
    const at = (id: string) => useEditor.getState().nodes.find((n) => n.id === id)!.position;
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    // The step after the agent is past the bubbles' right edge, not on them.
    expect(at('after').x).toBeGreaterThanOrEqual(at('agent').x + fp.right + 40 - 1);
  });
});

describe('placing a next step', () => {
  it('lands right of a bound node’s bubbles', () => {
    const flow: Workflow = { id: 'wf_p', name: 'P', nodes: [node('start', 0, 0), bound('agent', 280, 0)], connections: [main('start', 'agent')] };
    useEditor.getState().load(flow, []);
    useEditor.setState({ nodeTypes: coreTypes() as never });
    const id = useEditor.getState().placeNode('core.set', { from: { nodeId: 'agent', handleId: 'main:0', handleType: 'source' } }, { x: 520, y: 0 });
    const placed = useEditor.getState().nodes.find((n) => n.id === id)!;
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    expect(placed.position.x).toBeGreaterThanOrEqual(280 + fp.right + 40 - 1);
  });
});

describe('Spotlight placement', () => {
  it('puts a step added after a bound node right of its bubbles', () => {
    const types = Object.fromEntries(corePlugin.nodes.map((n) => [`core.${n.description.name}`, n.description]));
    const wf: Workflow = { id: 'wf_s', name: 'S', nodes: [bound('agent', 0, 0)], connections: [] };
    const out = applyOps(wf, [{ op: 'addNode', type: 'core.noOp', name: 'Then', after: 'agent' }], (t: string) => types[t] as never);
    const then = out.workflow.nodes.find((n) => n.name === 'Then')!;
    const fp = bubbleFootprint(240, ASSUMED_BUBBLES);
    expect(then.position[0]).toBeGreaterThanOrEqual(fp.right + 40);
  });
});
