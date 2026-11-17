// @vitest-environment happy-dom
/**
 * AG12 (wave ag3): the Run an Agent node shows what its agent is connected to, read-only, in a band above its slots, and follows
 * the agent when it changes (this tab's events and another tab's BroadcastChannel). The real NodeTile and AgentBand in
 * happy-dom; the route is a stubbed fetch with made-up data. An AI Agent node and a Set node are drawn as they were.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeTypeInfo } from '../src/lib/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { NodeTile } = await import('../src/components/canvas/node-tile');
const { AgentBand, useAgentConnections, stepLine, forgetAgentConnections } = await import('../src/components/canvas/agent-band');
const { announceSaved, useAgentDraft } = await import('../src/lib/client/agent-change');

const descriptor = (name: string, inputs: unknown[], extra: Record<string, unknown> = {}) => ({ name, displayName: name, description: '', icon: 'lucide:bot', inputs, outputs: [{ type: 'main' }], properties: [], ...extra });
const type = (t: string, d: ReturnType<typeof descriptor>): NodeTypeInfo => ({ type: t, pluginId: 'core', pluginName: 'Core', language: 'typescript', transport: 'http', available: true, descriptor: d } as never);
const SLOTS = [{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1 }, { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }, { type: 'ai_tool', displayName: 'Tool' }];
const runAnAgent = type('core.messageAgent', descriptor('Run an Agent', SLOTS));
const aiAgent = type('core.aiAgent', descriptor('AI Agent', SLOTS));
const setNode = type('core.set', descriptor('Edit Fields', [{ type: 'main' }]));

const answer = (extra: Record<string, unknown> = {}, tools: Array<Record<string, unknown>> = []) => ({
  agent: { id: 'a1', name: 'Alert triager', published: true, draftDiffers: false, icon: 'bot', color: '#000', ...extra },
  connections: [
    { kind: 'model', name: 'claude-sonnet-5-5', detail: 'Anthropic', icon: 'brand:anthropic', from: 'agent' },
    { kind: 'memory', name: 'Remembers across sessions', from: 'agent' },
    { kind: 'tool', name: 'Normalize Alert', nodeType: 'triage.normalize', toolId: 't_norm', from: 'agent' },
    { kind: 'tool', name: 'Send Email', nodeType: 'messaging.emailSend', toolId: 't_mail', asksFirst: true, credential: 'Mailpit SMTP', from: 'agent' },
    { kind: 'knowledge', name: 'runbooks', toolId: 't_kb', documents: 2, detail: 'SQLite · keyword search (BM25, built in)', from: 'agent' },
    ...tools,
  ],
});

let reads: string[];
let next: unknown;
let draftReads: number;
beforeEach(() => {
  forgetAgentConnections();
  reads = [];
  draftReads = 0;
  next = answer();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.includes('/connections')) {
        reads.push(path);
        return ok(next);
      }
      if (/\/api\/agents\/[^/?]+$/.test(path)) {
        draftReads++;
        return ok({ agent: { id: 'a1', tools: [] } });
      }
      return ok({ nodeTypes: [] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** What FlowNodeView does for a Run an Agent node: the node's tile with the band once the route answered. */
function RunAnAgent({ agentId = 'a1', wired, onSelect }: { agentId?: string; wired?: { model?: string; memory?: string; tools?: number }; onSelect?: () => void }) {
  const data = useAgentConnections(agentId, 'wf1', 'n1');
  return createElement('div', { onClick: onSelect }, createElement(ReactFlowProvider, null, createElement(NodeTile, { name: 'Run Alert triager', info: runAnAgent, parameters: { agentId }, readOnly: true, band: data ? createElement(AgentBand, { agentId, data, wired }) : undefined })));
}
const show = async (props: Parameters<typeof RunAnAgent>[0] = {}) => {
  await act(async () => root.render(createElement(RunAnAgent, props)));
  await settle();
};
const text = () => container.textContent ?? '';

describe('the band on a Run an Agent node', () => {
  it('shows the model, each tool’s call name, asks first, the knowledge base with its documents', async () => {
    await show();
    expect(reads[0]).toBe('/api/agents/a1/connections?workflowId=wf1&nodeId=n1');
    expect(text()).toContain('claude-sonnet-5-5');
    expect(text()).toContain('Remembers across sessions');
    expect(text()).toContain('Normalize Alert');
    expect(text()).toContain('Send Email');
    expect(container.querySelector('button[aria-label*="Send Email, asks first"]')).toBeTruthy();
    // Two rows only: the knowledge base is behind "+1 more" (its row, with the documents, is on the agent's page).
    expect(text()).toContain('+1 more');
    expect(container.querySelector('[title*="Mailpit SMTP"]')).toBeTruthy();
    expect(container.querySelector('[data-agent-band]')?.className).toContain('border-dashed');
    // No handle of its own: the node still has its four (main in and out, three slots counted apart).
    expect(container.querySelector('[data-agent-band] .react-flow__handle')).toBeNull();
    expect(text()).not.toContain('Not published');
  });

  it('says Not published for a draft-only agent, and Draft has changes for a changed one', async () => {
    next = answer({ published: false });
    await show();
    expect(text()).toContain('Not published');
    next = answer({ draftDiffers: true });
    await act(async () => announceSaved('a1'));
    await settle();
    expect(text()).toContain('Draft has changes');
    expect(text()).not.toContain('Not published');
  });

  it('a click on a tool row opens the agent’s page at that tool and does not select the node', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const selected = vi.fn();
    await show({ onSelect: selected });
    const row = container.querySelector<HTMLButtonElement>('button[aria-label*="Send Email"]')!;
    expect(row.getAttribute('aria-label')).toContain('Alert triager');
    await act(async () => row.click());
    expect(open).toHaveBeenCalledWith('/agents/a1?tab=abilities&open=capabilities&tool=t_mail', '_blank', 'noopener');
    expect(selected).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label*="model claude-sonnet-5-5"]')!.click());
    expect(open).toHaveBeenLastCalledWith('/agents/a1?tab=abilities&open=model', '_blank', 'noopener');
  });

  it('a wired Chat Model and Memory show the agent’s own replaced, and a wired tool adds', async () => {
    await show({ wired: { model: 'Local llama', memory: 'Short memory', tools: 1 } });
    expect(text()).toContain('replaced by Local llama');
    expect(text()).toContain('replaced by Short memory');
    expect(text()).toContain('+ 1 wired');
    expect(container.querySelector('.line-through')?.textContent).toContain('claude-sonnet-5-5');
  });

  it('keeps two rows (the band stays above where wired sub-nodes sit) and says how many more', async () => {
    next = answer({}, [{ kind: 'tool', name: 'Extra tool', toolId: 't_x', from: 'agent' }, { kind: 'tool', name: 'Last tool', toolId: 't_y', from: 'agent' }]);
    await show({ wired: { tools: 1 } });
    expect(text()).toContain('+3 more · + 1 wired');
    expect(text()).toContain('Normalize Alert');
    expect(text()).not.toContain('Last tool');
    expect(container.querySelectorAll('[data-agent-band] button[aria-label*="tool"], [data-agent-band] button[aria-label*="knowledge base"]')).toHaveLength(2);
  });

  it('reads again when this tab announces a save, and when another tab posts on the channel', async () => {
    await show();
    expect(reads).toHaveLength(1);
    next = { ...answer(), connections: [{ kind: 'tool', name: 'Field Statistics', toolId: 't_stats', from: 'agent' }] };
    await act(async () => announceSaved('a1'));
    await settle();
    expect(reads).toHaveLength(2);
    expect(text()).toContain('Field Statistics');
    const other = new BroadcastChannel('landflow-agents');
    next = answer({ draftDiffers: true });
    await act(async () => other.postMessage({ type: 'landflow:agent-saved', agentId: 'a1' }));
    await settle();
    other.close();
    expect(reads).toHaveLength(3);
    expect(text()).toContain('Draft has changes');
    // Another agent's message changes nothing here.
    const again = new BroadcastChannel('landflow-agents');
    await act(async () => again.postMessage({ type: 'landflow:agent-saved', agentId: 'other' }));
    await settle();
    again.close();
    expect(reads).toHaveLength(3);
  });

  it('shows no band for an agent the caller cannot read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Agent not found' }), { status: 404, headers: { 'content-type': 'application/json' } })));
    await show({ agentId: 'hidden' });
    expect(container.querySelector('[data-agent-band]')).toBeNull();
  });
});

describe('the band on a Run a Team node', () => {
  it('shows with the team body, labelled for the lead, above the body', async () => {
    const runTeam = type('core.runTeam', descriptor('Run a Team', SLOTS));
    await act(async () =>
      root.render(
        createElement(ReactFlowProvider, null, createElement(NodeTile, { name: 'Team', info: runTeam, parameters: {}, readOnly: true, live: { body: createElement('div', { 'data-team-body': '' }, 'roster') } as never, band: createElement(AgentBand, { agentId: 'a1', data: answer() as never, lead: true }) })),
      ),
    );
    const band = container.querySelector('[data-agent-band]')!;
    expect(band.getAttribute('aria-label')).toBe('What Alert triager (lead) is connected to');
    expect(text()).toContain('Alert triager · connected to');
    const body = container.querySelector('[data-team-body]')!;
    expect(body).toBeTruthy();
    expect(band.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('nodes without a band', () => {
  const tile = (info: NodeTypeInfo, band?: undefined) => {
    const html = document.createElement('div');
    const r = createRoot(html);
    act(() => r.render(createElement(ReactFlowProvider, null, createElement(NodeTile, { name: 'N', info, parameters: {}, readOnly: true, ...(band !== undefined && { band }) }))));
    const out = html.innerHTML;
    act(() => r.unmount());
    return out;
  };
  it('an AI Agent node and a Set node render as before: no band, the wide tile 240 px, the same DOM', () => {
    for (const info of [aiAgent, setNode]) {
      const plain = tile(info);
      expect(plain).not.toContain('data-agent-band');
      expect(plain).toBe(tile(info, undefined));
    }
    expect(tile(aiAgent)).toContain('width: 240px');
  });
  it('a Run an Agent node with a band is wider and not otherwise changed', async () => {
    await show();
    expect(container.querySelector<HTMLElement>('.group')!.style.width).toBe('300px');
  });
});

describe('the step card line', () => {
  it('reads the model, tools and knowledge bases', () => {
    expect(stepLine('Run an Agent', answer().connections as never)).toBe('Run an Agent · claude-sonnet-5-5 · 2 tools · 1 knowledge base');
    expect(stepLine('Run an Agent', undefined)).toBe('Run an Agent');
  });
});

describe('the card’s draft follows another tab', () => {
  it('useAgentDraft reads again on a message from another tab', async () => {
    function Probe() {
      useAgentDraft('a1');
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    await settle();
    const before = draftReads;
    const other = new BroadcastChannel('landflow-agents');
    await act(async () => other.postMessage({ type: 'landflow:agent-saved', agentId: 'a1' }));
    await settle();
    other.close();
    expect(draftReads).toBe(before + 1);
  });
});

describe('the agent page’s deep link', () => {
  it('open and tool reach the target; an unknown value is ignored', async () => {
    const { mapLegacyTab } = await import('../src/components/agents/tabs');
    expect(mapLegacyTab('abilities', undefined, undefined, 'capabilities', 't_mail')).toEqual({ tab: 'abilities', open: 'capabilities', tool: 't_mail' });
    expect(mapLegacyTab('abilities', undefined, undefined, 'model')).toEqual({ tab: 'abilities', open: 'model' });
    expect(mapLegacyTab('abilities', undefined, undefined, 'nope', 'x')).toEqual({ tab: 'abilities' });
    expect(mapLegacyTab('abilities')).toEqual({ tab: 'abilities' });
  });
});
