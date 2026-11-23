// @vitest-environment happy-dom
/**
 * AG20 live re-check (wave ag4): in a Test and fix session that reached an agent fix, the session waits for the person on the
 * agent's change card, so the card's Apply and Dismiss are enabled while the session is "testing"; any other card stays
 * disabled while Spotlight is busy. The real ReplyView in happy-dom with the real store.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');
const { cardFromPreview } = await import('@/components/editor/spotlight/agent-ask');
const { ReplyView } = await import('@/components/editor/spotlight/reply');
const { useAssistant } = await import('@/components/editor/assistant');

beforeAll(async () => {
  prepare();
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging'] } }, 'unit');
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agent: { id: 'ag_q', tools: [], model: { provider: 'anthropic', model: 'm' } }, nodeTypes: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useAssistant.setState({ testing: undefined, testingId: undefined, pending: false, items: [] });
});

const fixCard = (withFix: boolean) => ({
  ...cardFromPreview({ config: { name: 'Question answerer', description: 'x', model: { provider: 'anthropic', model: 'm' }, tools: [{ id: 't1', type: 'node', name: 'sqlite', description: 'x', nodeType: 'databases.sqlite', parameters: {} }] }, needs: [], missing: [], designed: true, cases: [], models: [] } as never, { description: 'x', placed: false, tools: [] }, true),
  base: { agentId: 'ag_q', name: 'Question answerer' },
  changes: ['Adds the tool SQLite'],
  ...(withFix && { fix: { executionId: 'ex_1', step: 'Ask sales analyst', cause: 'the agent has no database tool', attempt: 1 } }),
});
const item = (testId: string | undefined, withFix: boolean) => ({ id: 'i1', role: 'assistant' as const, ...(testId && { testId }), parts: [{ kind: 'agentCard' as const, card: fixCard(withFix) as never }] });
const apply = () => [...container.querySelectorAll('button')].find((b) => /Apply to its draft/.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const mount = async (i: ReturnType<typeof item>) => {
  await act(async () => root.render(createElement(ReplyView, { item: i as never, live: false })));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

describe('an agent fix card in a session that waits for the person', () => {
  it('Apply and Dismiss are enabled while the session is testing, and the card is the one the session waits on', async () => {
    useAssistant.setState({ testing: new AbortController(), testingId: 't1', pending: false });
    await mount(item('t1', true));
    expect(apply(), 'Apply is on the card').toBeTruthy();
    expect(apply()!.disabled).toBe(false);
    const dismiss = [...container.querySelectorAll('button')].find((b) => /Dismiss/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(dismiss.disabled).toBe(false);
  });

  it('a card of another session, a card without a fix, or a turn that is still streaming stays disabled', async () => {
    useAssistant.setState({ testing: new AbortController(), testingId: 'other', pending: false });
    await mount(item('t1', true));
    expect(apply()!.disabled).toBe(true);
    useAssistant.setState({ testingId: 't1' });
    await mount(item('t1', false));
    expect(apply()!.disabled).toBe(true);
    useAssistant.setState({ pending: true });
    await mount(item('t1', true));
    expect(apply()!.disabled).toBe(true);
  });
});
