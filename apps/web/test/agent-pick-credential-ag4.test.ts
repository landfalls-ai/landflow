// @vitest-environment happy-dom
/**
 * Live re-check (wave ag4): "Pick it" on Spotlight's agent card opens the credential picker in place: the fitting credentials
 * are listed, one pick writes it into the agent's draft (PUT), and "Create one" opens the credential dialog. The agent's page is
 * not needed (Open stays a link). Real AgentCardView in happy-dom; the routes are a stubbed fetch with made-up data.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AgentCardView } = await import('@/components/editor/spotlight/agent-card');
const { useEditor } = await import('@/components/editor/store');
const { useCredentialStore } = await import('@/components/credentials/use-credentials');

let container: HTMLDivElement;
let root: Root;
const puts: Array<{ url: string; body: { tools: Array<{ credentials?: Record<string, { id: string; name: string }> }> } }> = [];
const draft = { id: 'ag_q', name: 'Question answerer', model: { provider: 'anthropic', model: 'm' }, tools: [{ id: 't1', type: 'node', name: 'sqlite', description: 'x', nodeType: 'databases.sqlite', parameters: {} }] };
beforeEach(() => {
  puts.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useEditor.setState({ nodeTypes: { 'databases.sqlite': { type: 'databases.sqlite', descriptor: { displayName: 'SQLite', credentials: [{ name: 'sqlite', required: true }], properties: [], inputs: [], outputs: [] } } } as never });
  useCredentialStore.setState({ credentials: undefined, types: undefined } as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    const u = String(url);
    if (init?.method === 'PUT') { puts.push({ url: u, body: JSON.parse(init.body!) }); return ok({ agent: draft }); }
    if (/smoke-test/.test(u)) return ok({ smoke: { state: 'passed' } });
    if (/\/api\/credentials/.test(u)) return ok({ credentials: [{ id: 'c1', name: 'Sales DB', type: 'databases.sqlite' }, { id: 'c2', name: 'Other', type: 'slack.slackApi' }] });
    if (/credential-types/.test(u)) return ok({ types: [] });
    if (/\/api\/agents\/ag_q/.test(u)) return ok({ agent: draft });
    return ok({});
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useEditor.setState({ nodeTypes: {} as never });
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const card = {
  state: 'created', agentId: 'ag_q', name: 'Question answerer', description: 'x', config: {}, tools: [], practices: false, guardrails: [], needs: [], missing: [], cases: [], smoke: { state: 'untested', reason: 'needs a credential: SQLite' },
};
const button = (re: RegExp) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));

describe('Pick it, in place', () => {
  it('lists the fitting credentials only, one pick puts it in the agent draft, and the agent page is only the Open link', async () => {
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'i1', card: card as never })));
    await settle();
    expect(container.querySelector('a[href*="tab=abilities"]'), 'no jump to the abilities page').toBeNull();
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    const names = [...container.querySelectorAll('[data-testid="credential-picker"] label')].map((l) => l.textContent);
    expect(names).toEqual(['Sales DB']);
    await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    await act(async () => button(/Use it/)!.click());
    await settle();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.tools[0]!.credentials).toEqual({ sqlite: { id: 'c1', name: 'Sales DB' } });
    expect(container.querySelector('a[href="/agents/ag_q"]')).toBeTruthy();
  });

  it('Create one opens the credential dialog', async () => {
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'i1', card: card as never })));
    await settle();
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    await act(async () => button(/Create one/)!.click());
    await settle();
    expect(document.body.textContent).toMatch(/credential/i);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });
});
