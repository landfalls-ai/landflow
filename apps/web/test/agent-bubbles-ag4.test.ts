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
import { BUBBLE, SLOT_HANDLE, cardLeaks, pendingLine } from '@/lib/shared/agent-bubbles';
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

const data = await import('@/lib/client/agent-bubble-data');
const { bubbleGraph, AgentChip } = await import('@/components/canvas/agent-bubbles');
const edit = await import('@/lib/client/agent-edit');
const { announceSaved } = await import('@/lib/client/agent-change');

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
