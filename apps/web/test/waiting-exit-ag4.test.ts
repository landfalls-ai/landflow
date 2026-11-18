// @vitest-environment happy-dom
/** Review: a session that waits on its own card always has a way out: the header Stop, and on the card Dismiss (designed) or Not now (applied), with a phone-size target. */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { prepare } = await import('./spotlight-scenarios/harness');
const { cardFromPreview } = await import('@/components/editor/spotlight/agent-ask');
const { AgentCardView } = await import('@/components/editor/spotlight/agent-card');
const { useAssistant } = await import('@/components/editor/assistant');
const { agentFixWaits, headerStopShown } = await import('@/components/editor/timeline');
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
