// @vitest-environment happy-dom
/**
 * AG19 (wave ag4): the agent card draws the proposed agent as bubbles, with the reuse row and Use. The real AgentCardView and
 * BubbleDiagram in happy-dom; the routes are a stubbed fetch with made-up data (the design route's own tests are
 * `agent-reuse-ag4.test.ts`, in the node environment: happy-dom blocks the local fake model's origin). Nothing leaves this machine.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCard } from '@/lib/shared/agent-card';
import { attachedLine } from '@/lib/shared/agent-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');
const { agentStore } = await import('@/lib/server/agents/store');
const { registry } = await import('@/lib/server/plugins/registry');
const { cardFromPreview, useExistingAgent } = await import('@/components/editor/spotlight/agent-ask');
const { AgentCardView } = await import('@/components/editor/spotlight/agent-card');
const { useAssistant } = await import('@/components/editor/assistant');
const { useEditor } = await import('@/components/editor/store');

beforeAll(async () => {
  prepare();
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging'] } }, 'unit');
});

// ---------------------------------------------------------------------------
// The card: Use places the agent, and the proposed agent is drawn as bubbles
// ---------------------------------------------------------------------------

const preview = (over: Record<string, unknown> = {}) =>
  ({
    config: {
      name: 'Alert advisor',
      description: 'Reads an alert.',
      model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      memory: { crossSession: false },
      tools: [
        { id: 't1', type: 'node', name: 'extract_iocs', description: 'x', nodeType: 'triage.extractIocs', parameters: { operation: 'extract' } },
        { id: 't2', type: 'knowledge', name: 'search_runbooks', description: 'x', store: 'sqlite', collection: 'runbooks', embeddings: { provider: 'none', model: 'bm25' } },
      ],
    },
    needs: [],
    missing: [],
    designed: true,
    cases: [],
    models: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-4-5'],
    knowledge: { collection: 'runbooks', existing: true, search: 'keyword', embeddings: 'keyword search (BM25, built in)' },
    attached: { collection: 'runbooks', documents: 4, search: 'keyword' },
    modelWhy: 'asked',
    catalog: [{ tool: 'list_agents', count: 3 }, { tool: 'list_tool_nodes', count: 14 }],
    ...over,
  }) as never;
const ASK = { description: 'Reads an alert.', placed: false, tools: [] as string[] };

describe('the agent card draws the proposed agent as bubbles', () => {
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/api\/agents\/[^/?]+$/.test(String(url))) return ok({ agent: { id: 'x', tools: [], model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } });
    return ok({ nodeTypes: [] });
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function Shown({ id }: { id: string }) {
  const card = useAssistant((s) => (s.items.find((i) => i.id === id) as { parts?: Array<{ kind: string; card?: AgentCard }> } | undefined)?.parts?.find((p) => p.kind === 'agentCard')?.card);
  return card ? createElement(AgentCardView, { itemId: id, card }) : null;
}
async function show(card: AgentCard): Promise<string> {
  const id = `ag19-${Math.random().toString(36).slice(2, 8)}`;
  useAssistant.getState().append([{ id, role: 'assistant', parts: [{ kind: 'text', text: 'Designed “x”.' }, { kind: 'agentCard', card }] } as never]);
  await act(async () => root.render(createElement(Shown, { id })));
  await settle();
  return id;
}
const bubbles = () => [...container.querySelectorAll('[data-testid="bubble"]')].map((b) => b.getAttribute('data-bubble'));
const click = async (selector: string) => { await act(async () => { (container.querySelector(selector) as HTMLElement).click(); }); };

  it('asks.md B: model, memory, Extract IOCs and runbooks as bubbles, no Model or Tools text row; each opens its detail; the select redraws the model', async () => {
    const card = cardFromPreview(preview(), ASK, true, 'I need an agent …');
    await show(card);
    expect(container.querySelector('[data-testid="bubble-diagram"]')).toBeTruthy();
    expect(bubbles()).toEqual(['model', 'memory', 'tool:extract_iocs', 'tool:runbooks']);
    expect(container.textContent).toContain('claude-haiku-4-5');
    expect(container.textContent).toContain('This conversation');
    expect(container.textContent).toMatch(/4 documents/);
    const rowLabels = [...container.querySelectorAll('span')].filter((s) => s.className.includes('w-[68px]')).map((s) => s.textContent);
    expect(rowLabels).not.toContain('Model');
    expect(rowLabels).not.toContain('Tools');
    expect(rowLabels).toContain('Knowledge');
    // The detail of each bubble: the tool's node, the knowledge base's attachedLine, the model's why.
    await click('[data-bubble="tool:extract_iocs"]');
    expect(container.querySelector('[data-testid="bubble-detail"]')!.textContent).toContain('triage.extractIocs');
    expect(container.querySelector('[data-testid="bubble-detail"]')!.getAttribute('aria-live')).toBe('polite');
    await click('[data-bubble="tool:runbooks"]');
    expect(container.querySelector('[data-testid="bubble-detail"]')!.textContent).toBe(attachedLine({ collection: 'runbooks', documents: 4, search: 'keyword' }));
    await click('[data-bubble="model"]');
    expect(container.querySelector('[data-testid="bubble-detail"]')!.textContent).toContain('you asked for it');
    // The Model select sits under the diagram, labelled Change model; a change redraws the model bubble.
    const select = container.querySelector('select[aria-label="Model the agent runs on"]') as HTMLSelectElement;
    expect(select.closest('label')!.textContent).toContain('Change model');
    expect(container.querySelector('[data-testid="bubble-diagram"]')!.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { select.value = 'anthropic/claude-sonnet-5-5'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[data-bubble="model"]')!.textContent).toContain('claude-sonnet-5-5');
    // The Knowledge row, Tests and the "Looked at" line.
    expect(container.querySelector('[data-testid="agent-knowledge"]')!.textContent).toContain('runbooks');
    expect(container.querySelector('[data-testid="agent-looked-at"]')!.textContent).toBe('Looked at: list_agents 3, list_tool_nodes 14');
  });

  it('a card with no reuse offers Create agent, not Use', async () => {
    await show(cardFromPreview(preview(), ASK, true));
    expect(container.textContent).toContain('Create agent and flow');
    expect(container.querySelector('[data-testid="agent-reuse"]')).toBeNull();
  });

  it('the triage agent’s card: Send Email carries the lock and asks first; the reuse row offers Use <name> first and Create anyway second', async () => {
    const s1 = { agentId: 'ag_s1', name: 'Alert triager', why: 'it normalises alerts and emails oncall', published: true, gaps: [] as string[] };
    const body = preview({
      config: { name: 'Alert triager', description: 'Triages.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, memory: { crossSession: false }, tools: [{ id: 't1', type: 'node', name: 'send_email', description: 'x', nodeType: 'messaging.emailSend', requireApproval: true, parameters: {} }] },
      reuse: s1,
      attached: undefined,
      knowledge: undefined,
    });
    const card = cardFromPreview(body, ASK, true);
    expect(card.reuse).toEqual(s1);
    await show(card);
    const buttons = [...container.querySelectorAll('[data-testid="agent-reuse"] button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Use Alert triager', 'Create anyway']);
    expect(container.querySelector('[data-testid="agent-reuse"]')!.textContent).toContain('“Alert triager” already does this');
    expect([...container.querySelectorAll('button')].some((b) => /^Create agent/.test(b.textContent ?? ''))).toBe(false);
    // The reused agent's own bubbles (read from the agents page's draft): the diagram is its.
    expect(container.querySelector('[data-testid="bubble-diagram"]')!.getAttribute('aria-label')).toContain('Alert triager');
  });

  it('Use on an empty canvas lays out the starter flow bound to the agent, makes no agent and says Reuses “name”: why', async () => {
    const s1 = agentStore.create({ name: 'Alert triager', description: 'Triages.', instructions: 'x', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    agentStore.publish(s1.id);
    const count = agentStore.list().length;
    const reuse = { agentId: s1.id, name: 'Alert triager', why: 'it normalises alerts and emails oncall.', published: true, gaps: [] as string[] };
    const card = cardFromPreview(preview({ reuse }), ASK, true);
    useEditor.setState({ nodes: [], edges: [], workflowId: 'wf-ag19', name: 'Untitled workflow', nodeTypes: Object.fromEntries(registry.nodeTypes().map((t) => [t.type, t])) } as never);
    const id = await show({ ...card, workflowId: 'wf-ag19' });
    expect(useExistingAgent(id, { ...card, workflowId: 'wf-ag19' })).toBe(true);
    const agentNode = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent');
    expect(agentNode?.data.wf.parameters.agentId).toBe(s1.id);
    expect(agentStore.list().length).toBe(count);
    const item = useAssistant.getState().items.find((i) => i.id === id) as { parts: Array<{ kind: string; text?: string }> };
    expect(item.parts.some((p) => p.kind === 'agentCard')).toBe(false);
    expect(item.parts.find((p) => p.kind === 'text')?.text).toBe('Reuses “Alert triager”: it normalises alerts and emails oncall.');
  });

  it('a draft-only agent is placed too, and the reply says it must be published first', async () => {
    const draftOnly = agentStore.create({ name: 'Draft triager', description: 'Triages.', instructions: 'x', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const reuse = { agentId: draftOnly.id, name: 'Draft triager', why: 'it triages', published: false, gaps: [] as string[] };
    const card = { ...cardFromPreview(preview({ reuse }), ASK, true), workflowId: 'wf-ag19b' };
    useEditor.setState({ nodes: [], edges: [], workflowId: 'wf-ag19b', name: 'Untitled workflow', nodeTypes: Object.fromEntries(registry.nodeTypes().map((t) => [t.type, t])) } as never);
    const id = await show(card);
    expect(useExistingAgent(id, card)).toBe(true);
    const item = useAssistant.getState().items.find((i) => i.id === id) as { parts: Array<{ kind: string; text?: string }> };
    expect(item.parts.find((p) => p.kind === 'text')?.text).toMatch(/^Reuses “Draft triager”: it triages\. It is not published yet: publish “Draft triager” before the flow runs\.$/);
  });

  it('at phone width the card wraps: no fixed width in the diagram, 44 px targets on the card’s buttons', async () => {
    await show(cardFromPreview(preview({ reuse: { agentId: 'ag_s1', name: 'Alert triager', why: 'it does it', published: true, gaps: [] } }), ASK, true));
    const html = container.innerHTML;
    expect(html).toContain('max-md:h-11');
    expect(/overflow-x-(?:auto|scroll)/.test(html)).toBe(false);
  });
});
