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
const { useAssistant } = await import('@/components/editor/assistant');
const { toolNeedingCredential } = await import('@/components/editor/spotlight/agent-credential-picker');
const { useCredentialStore } = await import('@/components/credentials/use-credentials');

let failScope = false;
let container: HTMLDivElement;
let root: Root;
const gets: string[] = [];
const puts: Array<{ url: string; body: { tools: Array<{ credentials?: Record<string, { id: string; name: string }> }> } }> = [];
const draft = { id: 'ag_q', name: 'Question answerer', model: { provider: 'anthropic', model: 'm' }, tools: [{ id: 't1', type: 'node', name: 'sqlite', description: 'x', nodeType: 'databases.sqlite', parameters: {} }] };
beforeEach(() => {
  puts.length = 0;
  gets.length = 0;
  failScope = false;
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
    if (/\/api\/credentials/.test(u)) gets.push(u);
    if (failScope && /agentId=/.test(u)) return new Response('{"error":"x"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (/\/api\/credentials/.test(u)) return ok({ credentials: [{ id: 'c1', name: 'Sales DB', type: 'databases.sqlite' }, { id: 'c2', name: 'Other', type: 'slack.slackApi' }], projectId: 'proj_team' });
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
    // Blocker: the list is the agent's project's (?agentId=), never everything the person sees.
    expect(gets.some((u) => /agentId=ag_q/.test(u)), 'asked for the agent’s credentials').toBe(true);
    expect(gets.filter((u) => !/agentId=ag_q/.test(u))).toEqual([]);
  });

  it('the smoke result of a pick reaches the build card and the change card in the conversation too (re-check 3, status line)', async () => {
    const stale = { state: 'untested', reason: 'needs a credential: SQLite' };
    useAssistant.getState().reset();
    useAssistant.getState().append([
      { id: 'b1', role: 'assistant', parts: [{ kind: 'agentCard', card: { ...card, smoke: stale } as never }] },
      { id: 'b2', role: 'assistant', parts: [{ kind: 'agentCard', card: { ...card, agentId: undefined, base: { agentId: 'ag_q', name: 'Question answerer' }, smoke: stale } as never }] },
      { id: 'b3', role: 'assistant', parts: [{ kind: 'agentCard', card: { ...card, state: 'designed', agentId: undefined, base: { agentId: 'ag_q', name: 'Question answerer' }, smoke: undefined } as never }] },
    ] as never);
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'b1', card: card as never })));
    await settle();
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    await act(async () => button(/Use it/)!.click());
    await settle();
    const smokes = useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'agentCard' ? [p.card.smoke?.state] : [])) : []));
    expect(smokes).toEqual(['passed', 'passed', undefined]); // the change card still waiting for Apply is left alone
  });

  it('a failed filter says so with Retry instead of an empty list, and Retry lists them', async () => {
    failScope = true;
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'i1', card: card as never })));
    await settle();
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    expect(container.textContent).toMatch(/Couldn’t check which credentials this agent’s project may use/);
    failScope = false;
    await act(async () => button(/^Retry$/)!.click());
    await settle();
    expect([...container.querySelectorAll('[data-testid="credential-picker"] label')].map((l) => l.textContent)).toEqual(['Sales DB']);
  });

  it('after a pick the card stops saying it needs a credential', async () => {
    useAssistant.setState({ agents: [{ nodeId: 'n1', agentId: 'ag_q', name: 'Question answerer', state: 'draft', smoke: card.smoke }] } as never);
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'i1', card: card as never })));
    await settle();
    expect(container.textContent).toMatch(/needs a credential/);
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    await act(async () => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    await act(async () => button(/Use it/)!.click());
    await settle();
    expect(container.textContent).not.toMatch(/needs a credential/);
    useAssistant.setState({ agents: [] } as never);
  });


  it('a change card after Apply shows Pick it for a Left row that says pick a credential (re-check 3)', async () => {
    const change = { ...card, state: 'created', base: { agentId: 'ag_q', name: 'Question answerer' }, needs: ['sqlite: pick a sqlite credential'], changes: ['Adds sqlite'], smoke: { state: 'passed' } };
    await act(async () => root.render(createElement(AgentCardView, { itemId: 'i2', card: change as never })));
    await settle();
    expect(container.textContent).toMatch(/Left/);
    await act(async () => button(/^Pick it$/)!.click());
    await settle();
    expect([...container.querySelectorAll('[data-testid="credential-picker"] label')].map((l) => l.textContent)).toEqual(['Sales DB']);
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

describe('toolNeedingCredential', () => {
  const slots = (tool: { parameters?: Record<string, unknown> }) => [{ name: 'a', required: true }, { name: 'b', required: true, hidden: true }].filter((c) => !c.hidden || tool.parameters?.show);
  it('skips filled slots and the ones the tool’s settings hide', () => {
    const tool = { id: 't', type: 'node', nodeType: 'x.y', credentials: { a: { id: 'c', name: 'n' } } };
    expect(toolNeedingCredential({ tools: [tool] }, slots)).toBeUndefined();
    expect(toolNeedingCredential({ tools: [{ ...tool, credentials: {} }] }, slots)?.slots).toEqual(['a']);
    expect(toolNeedingCredential({ tools: [{ ...tool, credentials: {}, parameters: { show: true } }] }, slots)?.slots).toEqual(['a', 'b']);
  });
});
