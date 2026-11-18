// @vitest-environment happy-dom
/**
 * AG16 (wave ag4): a Run an Agent node's agent is drawn as bubbles on the canvas. Derived virtual nodes and edges on the slot
 * handles; nothing about the agent in the node card; the draft marked against the published version and the flow's moves; edits
 * change the agent's DRAFT (the PUT, never the workflow); Publish runs the smoke test, then the gate; a pinned version is drawn
 * read-only from its own route (AG21's, stubbed here); the step list's mini bubbles carry no names as text.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUBBLE, SLOT_HANDLE, bubblePositions, cardLeaks, pendingLine } from '@/lib/shared/agent-bubbles';
import type { AgentMove } from '@/lib/shared/agent-bubbles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(Element.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {}, removeEventListener() {} });

const wire = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; json?: unknown }>, answers: {} as Record<string, (init: { json?: unknown }) => unknown> }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string, init: { method?: string; json?: unknown } = {}) => {
    const method = init.method ?? 'GET';
    wire.calls.push({ path, method, json: init.json });
    const answer = wire.answers[`${method} ${path}`];
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer(init);
  }),
}));

const { ApiError } = await import('@/lib/client/api');
const data = await import('@/lib/client/agent-bubble-data');
const { bubbleGraph, AgentChip, isBubbleId } = await import('@/components/canvas/agent-bubbles');
const edit = await import('@/lib/client/agent-edit');
const { announceSaved } = await import('@/lib/client/agent-change');
const { useEditor } = await import('@/components/editor/store');

const conn = (kind: string, name: string, extra: Record<string, unknown> = {}) => ({ kind, name, from: 'agent', ...extra });
const published = [conn('model', 'claude-sonnet-5-5', { detail: 'Anthropic' }), conn('tool', 'Fetch Alerts', { toolId: 't_http', nodeType: 'core.httpRequest' }), conn('tool', 'Send Email', { toolId: 't_mail', asksFirst: true })];
const answer = (over: Record<string, unknown> = {}) => ({ agent: { id: 'ag_1', name: 'Alert triager', published: true, draftDiffers: false }, connections: published, ...over }) as never;
const REQ = { agentId: 'ag_1', workflowId: 'wf_1', nodeId: 'n1' };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  wire.calls = [];
  wire.answers = {};
  data.resetBubbleData();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('the bubbles of an answer', () => {
  it('model, memory and each tool, memory always there, the flow’s wired sub-nodes left out', () => {
    const labels = data.bubblesFromAnswer(answer({ connections: [...published, conn('tool', 'Wired', { from: 'flow' })] })).map((b) => b.label);
    expect(labels).toEqual(['claude-sonnet-5-5', 'This conversation', 'Fetch Alerts', 'Send Email']);
  });

  it('marks what the draft adds, changes and removes, and says it in the chip line', () => {
    const draft = [published[0], conn('model', 'x'), conn('tool', 'Fetch Alerts', { toolId: 't_http', nodeType: 'core.httpRequest', detail: 'GET' }), conn('tool', 'Lookup', { toolId: 't_new' })].filter((c) => c.name !== 'x');
    const bubbles = data.bubblesFromAnswer(answer({ draft }));
    const mark = (id: string) => bubbles.find((b) => b.id === id)?.pending;
    expect([mark('tool:t_new'), mark('tool:t_http'), mark('tool:t_mail'), mark('model')]).toEqual(['added', 'changed', 'removed', undefined]);
    expect(pendingLine(bubbles)).toBe('3 changes not published');
  });

  it('marks a bubble the flow moved in', () => {
    const moves = [{ nodeId: 'n1', subNodeId: 's1', outcome: 'moved', state: 'pending', as: 'tool', agentToolId: 't_http', slot: 'tool', name: 'Fetch Alerts' }] as unknown as AgentMove[];
    const moved = data.bubblesFromAnswer(answer(), moves, 'n1').find((b) => b.id === 'tool:t_http');
    expect(moved?.movedHere).toBe(true);
    expect(data.bubblesFromAnswer(answer(), moves, 'n2').find((b) => b.id === 'tool:t_http')?.movedHere).toBeUndefined();
  });

  it('a pinned version is its own connections, unmarked', () => {
    const bubbles = data.bubblesFromAnswer(answer({ version: 2, draft: [conn('tool', 'Extra', { toolId: 'x' })] }));
    expect(bubbles.some((b) => b.pending)).toBe(false);
  });
});

describe('the canvas layer', () => {
  const parent = { id: 'n1', position: { x: 100, y: 50 }, width: 240, agentName: 'Alert triager', request: REQ };

  it('draws a dashed bubble edge per bubble into its slot handle', () => {
    const bubbles = data.bubblesFromAnswer(answer());
    const { nodes, edges } = bubbleGraph([parent], { n1: bubbles });
    expect(nodes).toHaveLength(4);
    expect(nodes.every((n) => n.type === 'agentBubble' && n.draggable === false && n.id.startsWith('bubble:n1:'))).toBe(true);
    expect(nodes.every((n) => n.position.y === 50 + BUBBLE.below)).toBe(true);
    expect(edges.map((e) => e.targetHandle).sort()).toEqual([`${SLOT_HANDLE.model}:0`, `${SLOT_HANDLE.memory}:0`, `${SLOT_HANDLE.tool}:0`, `${SLOT_HANDLE.tool}:0`].sort());
    expect(edges.every((e) => e.type === 'bubble' && e.target === 'n1')).toBe(true);
  });

  it('a card never holds what the bubbles hold', () => {
    const bubbles = data.bubblesFromAnswer(answer());
    expect(cardLeaks('Alert triager Run an Agent', bubbles)).toEqual([]);
    expect(cardLeaks('Alert triager Run an Agent claude-sonnet-5-5 Fetch Alerts', bubbles)).toEqual(['claude-sonnet-5-5', 'Fetch Alerts']);
  });

  it('a hidden node hides its bubbles', () => {
    const { nodes } = bubbleGraph([{ ...parent, hidden: true }], { n1: data.bubblesFromAnswer(answer()) });
    expect(nodes.every((n) => n.hidden)).toBe(true);
  });
});

describe('the six-bubble canvas (the S1 agent and its runbooks knowledge base)', () => {
  const six = [
    conn('model', 'claude-sonnet-5-5', { detail: 'Anthropic' }),
    conn('tool', 'Fetch Alerts', { toolId: 't_http', nodeType: 'core.httpRequest' }),
    conn('tool', 'Send Email', { toolId: 't_mail', asksFirst: true, credential: 'Mailpit SMTP' }),
    conn('tool', 'SQLite', { toolId: 't_sql' }),
    conn('knowledge', 'runbooks', { toolId: 't_kb', documents: 4 }),
  ];
  const parent = { id: 'n1', position: { x: 100, y: 50 }, width: 240, agentName: 'Alert triager', request: REQ };

  it('draws six bubbles on six dashed edges, each into its slot handle, the knowledge base on the tool slot', () => {
    const bubbles = data.bubblesFromAnswer(answer({ connections: six }));
    expect(bubbles).toHaveLength(6);
    const { nodes, edges } = bubbleGraph([parent], { n1: bubbles });
    expect(nodes).toHaveLength(6);
    expect(edges).toHaveLength(6);
    const handle = (label: string) => edges.find((e) => e.source === nodes.find((n) => n.data.bubble.label === label)!.id)!.targetHandle;
    expect(handle('claude-sonnet-5-5')).toBe(`${SLOT_HANDLE.model}:0`);
    expect(handle('This conversation')).toBe(`${SLOT_HANDLE.memory}:0`);
    for (const tool of ['Fetch Alerts', 'Send Email', 'SQLite', 'runbooks']) expect(handle(tool)).toBe(`${SLOT_HANDLE.tool}:0`);
    expect(bubbles.filter((b) => b.asksFirst).map((b) => b.label)).toEqual(['Send Email']);
  });

  it('no bubble overlaps another, and eight tools wrap to a second row', () => {
    for (const count of [3, 6, 8, 12]) {
      const spots = bubblePositions(240, count);
      for (let i = 0; i < spots.length; i++)
        for (let j = i + 1; j < spots.length; j++) {
          const apart = spots[i].y !== spots[j].y || Math.abs(spots[i].x - spots[j].x) >= BUBBLE.size;
          expect(apart, `${count}: ${i} and ${j}`).toBe(true);
        }
    }
    const eight = bubblePositions(240, 8);
    expect(eight.slice(0, 6).every((s) => s.y === BUBBLE.below)).toBe(true);
    expect(eight.slice(6).every((s) => s.y === BUBBLE.below + BUBBLE.rowGap)).toBe(true);
  });

  it('a bubble clears a real sub-node still wired (the occupied range)', () => {
    const occupied = [{ x: 0, width: 88 }];
    const spots = bubblePositions(240, 4, occupied);
    expect(spots.every((s) => s.x >= 88 + 24 || s.x + BUBBLE.size <= 0)).toBe(true);
  });

  it('bubbles are never the store’s: their ids are recognised, a flow node’s are not', () => {
    const { nodes, edges } = bubbleGraph([parent], { n1: data.bubblesFromAnswer(answer({ connections: six })) });
    expect([...nodes, ...edges].every((e) => isBubbleId(e.id))).toBe(true);
    expect(isBubbleId('n1')).toBe(false);
    expect(nodes.every((n) => n.draggable === false && n.deletable === false && n.selectable === false && n.connectable === false)).toBe(true);
  });
  it('the store holds no bubble: select-all, copy and toWorkflow see only the flow’s nodes', () => {
    const { nodes } = bubbleGraph([parent], { n1: data.bubblesFromAnswer(answer({ connections: six })) });
    expect(nodes.length).toBeGreaterThan(0);
    const flow = { id: 'wf_b', name: 'B', nodes: [{ id: 'n1', name: 'n1', type: 'core.messageAgent', typeVersion: 1, position: [0, 0] as [number, number], parameters: { agentId: 'ag_one' } }], connections: [] };
    useEditor.getState().load(flow as never, []);
    useEditor.getState().selectAll?.();
    const st = useEditor.getState();
    expect(st.nodes.every((n) => !isBubbleId(n.id))).toBe(true);
    expect(st.edges.every((e) => !isBubbleId(e.id))).toBe(true);
    expect(st.toWorkflow().nodes.map((n) => n.id)).toEqual(['n1']);
  });
});

describe('edits change the draft, never the flow', () => {
  const draft = { id: 'ag_1', name: 'Alert triager', updatedAt: 'now', model: { provider: 'anthropic', model: 'm' }, tools: [{ id: 't_http', type: 'node', name: 'fetch_alerts' }] };
  beforeEach(() => {
    wire.answers['GET /api/agents/ag_1'] = () => ({ agent: draft });
    wire.answers['PUT /api/agents/ag_1'] = () => ({});
    wire.answers['POST /api/agents/ag_1/smoke-test'] = () => ({ smoke: { state: 'passed' } });
  });

  it('removing a tool PUTs the draft without it, then the smoke test, and announces it', async () => {
    const heard = vi.fn();
    window.addEventListener('landflow:agent-saved', heard);
    await edit.removeFromAgent('ag_1', 't_http');
    const put = wire.calls.find((c) => c.method === 'PUT')!;
    expect((put.json as { tools: unknown[] }).tools).toEqual([]);
    expect(wire.calls.map((c) => c.method + ' ' + c.path)).toEqual(['GET /api/agents/ag_1', 'PUT /api/agents/ag_1', 'POST /api/agents/ag_1/smoke-test']);
    expect(wire.calls.some((c) => c.path.startsWith('/api/workflows'))).toBe(false);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener('landflow:agent-saved', heard);
  });

  it('adding a tool keeps the others and gives it an id; a model change keeps the provider’s settings', async () => {
    await edit.addToAgent('ag_1', { tool: { type: 'node', name: 'send_email' } });
    const tools = (wire.calls.find((c) => c.method === 'PUT')!.json as { tools: Array<{ id: string }> }).tools;
    expect(tools).toHaveLength(2);
    expect(tools[1].id).toMatch(/^tool_/);
    wire.calls = [];
    await edit.setAgentModel('ag_1', { provider: 'anthropic', model: 'opus' });
    expect((wire.calls.find((c) => c.method === 'PUT')!.json as { model: { model: string } }).model.model).toBe('opus');
  });
});

describe('the chip', () => {
  const mount = () => act(async () => root.render(createElement(ReactFlowProvider, null, createElement(AgentChip, REQ))));

  it('says what is not published and Publish runs the test, then the gate', async () => {
    wire.answers['GET /api/agents/ag_1/connections?workflowId=wf_1&nodeId=n1'] = () => answer({ agent: { id: 'ag_1', name: 'Alert triager', published: true, draftDiffers: true }, draft: [...published, conn('tool', 'Lookup', { toolId: 'new' })] });
    wire.answers['GET /api/workflows/wf_1/agent-moves'] = () => ({ moves: [] });
    wire.answers['POST /api/agents/ag_1/smoke-test'] = () => ({ smoke: { state: 'passed' } });
    wire.answers['POST /api/agents/ag_1/publish'] = () => ({});
    await mount();
    await settle();
    expect(container.textContent).toContain('1 change not published');
    const publish = [...container.querySelectorAll('button')].find((b) => /Publish/.test(b.textContent ?? ''))!;
    await act(async () => publish.click());
    await settle();
    expect(wire.calls.map((c) => `${c.method} ${c.path}`).filter((c) => /smoke|publish/.test(c))).toEqual(['POST /api/agents/ag_1/smoke-test', 'POST /api/agents/ag_1/publish']);
    expect(JSON.stringify(wire.calls.map((c) => c.json))).not.toContain('skipEval');
  });

  it('a gate hold shows its verdict, links to the agent and keeps the mark; nothing skips the gate', async () => {
    wire.answers['GET /api/agents/ag_1/connections?workflowId=wf_1&nodeId=n1'] = () => answer({ agent: { id: 'ag_1', name: 'Alert triager', published: true, draftDiffers: true }, draft: [...published, conn('tool', 'Lookup', { toolId: 'new' })] });
    wire.answers['GET /api/workflows/wf_1/agent-moves'] = () => ({ moves: [] });
    wire.answers['POST /api/agents/ag_1/smoke-test'] = () => ({ smoke: { state: 'passed' } });
    wire.answers['POST /api/agents/ag_1/publish'] = () => {
      throw new ApiError('held', 409, { gate: { verdict: { average: 2.8, reason: 'The send case failed' } } });
    };
    await mount();
    await settle();
    await act(async () => [...container.querySelectorAll('button')].find((b) => /Publish/.test(b.textContent ?? ''))!.click());
    await settle();
    expect(container.textContent).toContain('Held by the eval gate (2.8)');
    expect(container.textContent).toContain('The send case failed');
    expect(container.querySelector('a[href="/agents/ag_1"]')).not.toBeNull();
    expect(container.textContent).toContain('1 change not published');
    expect(JSON.stringify(wire.calls.map((c) => c.json))).not.toContain('skipEval');
  });

  it('a change made elsewhere is read again', async () => {
    let n = 0;
    wire.answers['GET /api/agents/ag_1/connections?workflowId=wf_1&nodeId=n1'] = () => answer({ agent: { id: 'ag_1', name: 'Alert triager', published: true, draftDiffers: n++ > 0 } });
    wire.answers['GET /api/workflows/wf_1/agent-moves'] = () => ({ moves: [] });
    await mount();
    await settle();
    expect(container.textContent).not.toContain('not published');
    await act(async () => announceSaved('ag_1'));
    await settle();
    expect(container.textContent).toContain('Changes not published');
  });
});

describe('a pinned version', () => {
  it('is read from the version’s own route, never the draft’s', async () => {
    wire.answers['GET /api/agents/ag_1/versions/2/connections'] = () => answer({ version: 2 });
    const probe = () => {
      const a = data.useBubbleAnswer({ ...REQ, version: 2 });
      return createElement('span', { 'data-v': a?.version }, a ? 'read' : 'none');
    };
    await act(async () => root.render(createElement(probe)));
    await settle();
    expect(container.querySelector('[data-v]')?.getAttribute('data-v')).toBe('2');
    expect(wire.calls.map((c) => c.path)).toEqual(['/api/agents/ag_1/versions/2/connections']);
  });
});

describe('a published or older workflow version (V10)', () => {
  const flow = (agentId: string) =>
    ({
      id: 'wf_1',
      name: 'Triage',
      nodes: [{ id: 'n1', type: 'core.messageAgent', typeVersion: 1, name: 'Run an Agent', position: [0, 0], parameters: { agentId } }],
      connections: [],
    }) as never;
  const v1 = [conn('model', 'claude-sonnet-5-5', { detail: 'Anthropic' }), conn('tool', 'Fetch Alerts', { toolId: 't_http', nodeType: 'core.httpRequest' })];
  const draftTools = [...v1, conn('tool', 'Lookup Draft Only', { toolId: 't_new' })];
  const stub = () => {
    wire.answers['GET /api/workflows/wf_1/versions/v_1/pins'] = () => ({ pins: [{ nodeId: 'n1', agentId: 'ag_1', version: 1 }] });
    wire.answers['GET /api/agents/ag_1/versions/1/connections'] = () => answer({ version: 1, connections: v1 });
    wire.answers['GET /api/agents/ag_1/connections?workflowId=wf_1&nodeId=n1'] = () => answer({ agent: { id: 'ag_1', name: 'Alert triager', published: true, draftDiffers: true }, connections: v1, draft: draftTools });
    wire.answers['GET /api/workflows/wf_1/agent-moves'] = () => ({ moves: [] });
  };
  const mount = async (versions: Record<string, number | 'draft'> | undefined) => {
    const { ExecutionCanvas: Canvas } = await import('@/components/executions/execution-canvas');
    await act(async () => root.render(createElement('div', { style: { width: 800, height: 600 } }, createElement(Canvas, { workflow: flow('ag_1'), nodeTypes: {}, runData: {}, agentVersions: versions }))));
    await settle();
    await settle();
  };

  it('reads the pins, asks for the pinned version’s connections, draws its tools, and chips "<name> v1" with no +, menu or Publish', async () => {
    stub();
    const { usePinnedVersions } = data;
    const probe = () => {
      const pins = usePinnedVersions('wf_1', 'v_1');
      return createElement('span', { 'data-pins': JSON.stringify(pins ?? null) });
    };
    await act(async () => root.render(createElement(probe)));
    await settle();
    expect(container.querySelector('[data-pins]')?.getAttribute('data-pins')).toBe('{"n1":1}');
    await act(async () => root.render(createElement('span')));
    await mount({ n1: 1 });
    const paths = wire.calls.map((c) => c.path);
    expect(paths).toContain('/api/agents/ag_1/versions/1/connections');
    expect(paths.some((p) => p.startsWith('/api/agents/ag_1/connections'))).toBe(false);
    const text = container.textContent ?? '';
    expect(text).toContain('Fetch Alerts');
    expect(text).not.toContain('Lookup Draft Only');
    expect(container.querySelector('[data-testid="agent-chip"]')?.textContent).toBe('Alert triager v1');
    expect(text).not.toContain('Publish');
    // The rendered Run an Agent tile holds nothing of what the bubbles hold.
    const card = container.querySelector('[data-id="n1"]')?.textContent ?? '';
    expect(card.length).toBeGreaterThan(0);
    expect(data.bubblesFromAnswer(answer({ version: 1, connections: v1 })).length).toBeGreaterThan(0);
    expect(cardLeaks(card, data.bubblesFromAnswer(answer({ version: 1, connections: v1 })))).toEqual([]);
    // model, memory (always) and the one tool: no node of the draft's extra tool, and nothing that adds.
    expect(container.querySelectorAll('[data-bubble-node]')).toHaveLength(3);
    expect(container.querySelector('[aria-label*="Add to"], [title*="Add to"]')).toBeNull();
  });

  it('the editor’s canvas of the same workflow draws the draft, editable', async () => {
    stub();
    const { useBubbleLayer } = await import('@/components/canvas/agent-bubbles');
    let drawn: string[] = [];
    const probe = () => {
      const nodes = [{ id: 'n1', type: 'lf', position: { x: 0, y: 0 }, data: { wf: { type: 'core.messageAgent', parameters: { agentId: 'ag_1' } } } }];
      const layer = useBubbleLayer(nodes, [], { workflowId: 'wf_1' });
      drawn = layer.nodes.map((n) => `${n.data.bubble.label}|${n.data.readOnly ?? false}`);
      return createElement('span');
    };
    await act(async () => root.render(createElement(probe)));
    await settle();
    expect(wire.calls.some((c) => c.path === '/api/agents/ag_1/connections?workflowId=wf_1&nodeId=n1')).toBe(true);
    expect(drawn).toContain('Lookup Draft Only|false');
    expect(wire.calls.some((c) => c.path.includes('/versions/'))).toBe(false);
  });

  it('a 404 from the pins route draws the plain node: no chip, no bubbles', async () => {
    wire.answers['GET /api/workflows/wf_1/versions/v_1/pins'] = () => {
      throw new Error('404');
    };
    const probe = () => createElement('span', { 'data-pins': JSON.stringify(data.usePinnedVersions('wf_1', 'v_1') ?? null) });
    await act(async () => root.render(createElement(probe)));
    await settle();
    expect(container.querySelector('[data-pins]')?.getAttribute('data-pins')).toBe('null');
    await act(async () => root.render(createElement('span')));
    await mount(undefined);
    expect(container.querySelector('[data-testid="agent-chip"]')).toBeNull();
    expect(container.querySelector('[data-bubble-node]')).toBeNull();
  });

  it('a run of the draft says "<name> draft"', async () => {
    stub();
    await mount({ n1: 'draft' });
    expect(container.querySelector('[data-testid="agent-chip"]')?.textContent).toBe('Alert triager draft');
  });
});

describe('a tool bubble reads as the node it is, never the agent’s tool id', () => {
  const tools = [
    conn('tool', 'extract_iocs', { toolId: 't1', nodeType: 'triage.extractIocs', nodeTitle: 'Extract IOCs' }),
    conn('tool', 'hash', { toolId: 't2', nodeType: 'textToolkit.hash', nodeTitle: 'Hash' }),
    conn('tool', 'uuid', { toolId: 't3', nodeType: 'textToolkit.uuid', nodeTitle: 'UUID' }),
    conn('tool', 'slugify', { toolId: 't4', nodeType: 'textToolkit.slugify', nodeTitle: 'Slugify' }),
    conn('tool', 'jwt_decode', { toolId: 't5', nodeType: 'textToolkit.jwtDecode', nodeTitle: 'JWT Decode' }),
  ];

  it('the label is the node type’s display name; the tool id is only in the hover title', async () => {
    const bubbles = data.bubblesFromAnswer(answer({ connections: tools }));
    expect(bubbles.filter((b) => b.slot === 'tool').map((b) => b.label)).toEqual(['Extract IOCs', 'Hash', 'UUID', 'Slugify', 'JWT Decode']);
    expect(bubbles.find((b) => b.id === 'tool:t1')!.callName).toBe('extract_iocs');
    const { bubbleTitle } = await import('@/lib/shared/agent-bubbles');
    expect(bubbleTitle('Tool desk', bubbles.find((b) => b.id === 'tool:t1')!)).toContain('Extract IOCs (extract_iocs)');
    // The canvas's bubble and Spotlight's diagram draw the same words, and neither draws “Extract Iocs” or a bare “hash”.
    const { BubbleDiagram } = await import('@/components/canvas/bubble-view');
    await act(async () => root.render(createElement(BubbleDiagram, { agentName: 'Tool desk', bubbles })));
    const text = container.textContent!;
    for (const label of ['Extract IOCs', 'Hash', 'UUID', 'Slugify', 'JWT Decode']) expect(text).toContain(label);
    expect(text).not.toContain('Extract Iocs');
    expect(text).not.toMatch(/\bhash\b|\buuid\b|\bslugify\b/);
    expect(container.querySelector('[data-bubble="tool:t1"]')!.getAttribute('title')).toContain('extract_iocs');
  });

  it('a tool whose node is not known keeps the agent’s own name (nothing to read it as)', () => {
    const [b] = data.bubblesFromAnswer(answer({ connections: [conn('tool', 'Fetch Alerts', { toolId: 'tx', nodeType: 'core.httpRequest' })] })).filter((x) => x.slot === 'tool');
    expect(b.label).toBe('Fetch Alerts');
    expect(b.callName).toBeUndefined();
  });
});
