// @vitest-environment happy-dom
/** Review: a session that waits on its own card always has a way out: the header Stop, and on the card Dismiss (designed) or Not now (applied), with a phone-size target. */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { prepare } = await import('./spotlight-scenarios/harness');
const { cardFromPreview } = await import('@/components/editor/spotlight/agent-ask');
const { AgentCardView } = await import('@/components/editor/spotlight/agent-card');
const { useAssistant } = await import('@/components/editor/assistant');
const { agentFixWaits, headerStopShown } = await import('@/components/editor/timeline');
const { agentFixOutcome } = await import('@/components/editor/test-session');
beforeAll(() => prepare());

const base = (over: Record<string, unknown>) => ({
  ...cardFromPreview({ config: { name: 'Summary', description: 'x', memory: { crossSession: false }, tools: [] }, needs: [], missing: [], designed: true, cases: [], models: [] } as never, { description: 'x', placed: false, tools: [] }),
  base: { agentId: 'ag_1', name: 'Summary' }, changes: ['Tools: added SQLite'], fix: { attempt: 1 }, ...over,
}) as never;

function render(card: never) {
  useAssistant.getState().reset();
  useAssistant.getState().append([{ id: 'item1', role: 'assistant', testId: 't1', parts: [{ kind: 'text', text: 'Fix' }, { kind: 'agentCard', card }] } as never]);
  const el = document.createElement('div');
  document.body.append(el);
  act(() => createRoot(el).render(createElement(AgentCardView, { itemId: 'item1', card })));
  return el;
}
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('a waiting session always has an exit', () => {
  it('the header Stop shows while the session works and while it waits (desktop and folded)', () => {
    for (const collapsed of [false, true]) expect(headerStopShown({ collapsed, live: false, testing: true }), `collapsed ${collapsed}`).toBe(true);
    expect(headerStopShown({ collapsed: false, live: false, testing: false })).toBe(false);
    expect(headerStopShown({ collapsed: false, live: true, testing: true })).toBe(false); // the composer's own Stop while a reply streams
  });
  it.each([
    ['designed', { state: 'designed' }, 'Dismiss'],
    ['applied and tested', { state: 'created', smoke: { state: 'passed' } }, 'Not now'],
    ['applied, waiting for a credential', { state: 'created', smoke: { state: 'untested', reason: 'needs a credential: pick one' } }, 'Not now'],
  ])('%s: the card has %s with a phone-size target, and it settles the session', (_name, over, label) => {
    const card = base(over);
    expect(agentFixWaits([{ id: 'item1', role: 'assistant', testId: 't1', parts: [{ kind: 'agentCard', card }] }] as never, 't1')).toBe(true);
    const el = render(card);
    const exit = button(el, label)!;
    expect(exit, label).toBeDefined();
    expect(exit.className).toContain('max-md:h-11');
    act(() => exit.click());
    // The card is gone: the session reads that as "You kept the agent as it was."
    expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'agentCard'))).toBe(false);
  });
});

describe('the card after Apply', () => {
  it('hides Not now while a publish is in progress', () => {
    const el = render(base({ state: 'created', smoke: { state: 'passed' }, publish: { state: 'publishing' } }));
    expect(button(el, 'Not now')).toBeUndefined();
  });
  it('a swap that failed shows its note and Ask again', () => {
    const el = render(base({ state: 'created', smoke: { state: 'passed' }, casesNote: 'The tests changed since this was designed; ask again.', askedChange: 'Give it SQLite' }));
    expect(el.textContent).toContain('The tests changed since this was designed; ask again.');
    expect(button(el, 'Ask again')).toBeDefined();
  });
  it('dismissed after Apply, the session says the change is saved to the draft, not that it was kept as it was', async () => {
    useAssistant.getState().reset();
    const card = base({ state: 'created', smoke: { state: 'passed' } });
    useAssistant.getState().append([{ id: 'item1', role: 'assistant', testId: 't1', parts: [{ kind: 'agentCard', card }] } as never]);
    const done = agentFixOutcome('item1', new AbortController().signal);
    useAssistant.setState({ items: [] });
    expect(await done).toBe('The change is saved to the draft, not published.');
  });
  it('dismissed before Apply it still says it was kept as it was', async () => {
    useAssistant.getState().reset();
    useAssistant.getState().append([{ id: 'item1', role: 'assistant', testId: 't1', parts: [{ kind: 'agentCard', card: base({ state: 'designed' }) }] } as never]);
    const done = agentFixOutcome('item1', new AbortController().signal);
    useAssistant.setState({ items: [] });
    expect(await done).toBe('You kept the agent as it was.');
  });
});

describe('Ask again on a fix card', () => {
  it('sends the typed ask the session had, never the model text; a card with none sends ""', async () => {
    const { askAgentChangeAgain } = await import('@/components/editor/spotlight/agent-ask');
    for (const typedAsk of ['let it write rows to the sales table', undefined]) {
      useAssistant.getState().reset();
      const card = base({ state: 'created', smoke: { state: 'passed' }, casesNote: 'x', askedChange: 'Give it SQLite', ...(typedAsk !== undefined && { typedAsk }) });
      useAssistant.getState().append([{ id: 'item1', role: 'assistant', testId: 't1', parts: [{ kind: 'agentCard', card }] } as never]);
      const bodies: Array<Record<string, unknown>> = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({ config: { name: 'Summary', description: 'x', memory: { crossSession: false }, tools: [] }, changes: ['Tools: added SQLite'], needs: [], missing: [], designed: true, cases: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }));
      try { await askAgentChangeAgain('item1', card); } finally { vi.unstubAllGlobals(); }
      expect(bodies[0].typedAsk).toBe(typedAsk ?? '');
      expect(bodies[0].change).toBe('Give it SQLite');
    }
  });
});
