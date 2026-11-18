/**
 * Re-check 3/4: a typed wrong-output ask (and a bare run) reaches the Test and fix session from the composer, with the typed
 * sentence as the goal; on a saved workflow the session asks first with the switch on (it takes `autonomyOf`, not the switch).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.fn(async () => undefined);
vi.mock('@/components/editor/test-session', () => ({ testUntilItRuns: session }));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { startTypedSession } = await import('@/components/editor/spotlight/typed-session');
const { composerBusy } = await import('@/components/editor/timeline');
const { autonomyOf, noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');

const node = (id: string, name: string, type: string) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters: {} });
const flow = { id: 'wf_saved', name: 'Digest', nodes: [node('a', 'Start', 'core.manualTrigger'), node('b', 'Post', 'core.httpRequest')], connections: [{ id: 'e', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }] };
const nodeTypes = { 'core.manualTrigger': { type: 'core.manualTrigger', descriptor: { kind: 'trigger', displayName: 'Manual', properties: [], inputs: [], outputs: [] } }, 'core.httpRequest': { type: 'core.httpRequest', descriptor: { kind: 'action', displayName: 'HTTP', properties: [], inputs: [], outputs: [] } } };

beforeEach(() => {
  session.mockClear();
  useAutonomyFacts.setState({ switchOn: true, workflows: {} });
  useAssistant.getState().reset();
  noteOpened('wf_saved', 2); // opened with nodes: saved
  useEditor.getState().load(flow as never, []);
  useEditor.setState({ nodeTypes: nodeTypes as never });
});

describe('the composer’s typed sessions', () => {
  it('a wrong-output ask on a saved flow starts the session with the typed sentence as the goal, and the session asks first', () => {
    const ask = 'The numbers in the summary look made up. Test it and fix it.';
    expect(startTypedSession(ask)).toBe(true);
    expect(session).toHaveBeenCalledWith(ask);
    expect(autonomyOf('wf_saved')).toBe('asks-first');
    expect(useAutonomyFacts.getState().switchOn).toBe(true);
    expect(useAssistant.getState().items.at(-1)).toMatchObject({ role: 'user', text: ask });
  });
  it('a bare run starts it with the flow’s description; a question or a change does not', () => {
    expect(startTypedSession('Run it now')).toBe(true);
    expect(session).toHaveBeenCalledTimes(1);
    for (const ask of ['Why are the numbers wrong?', 'The retry is off, turn it on', 'Run this step']) expect(startTypedSession(ask), ask).toBe(false);
    expect(session).toHaveBeenCalledTimes(1);
  });
});

describe('a session that waits on its own card', () => {
  const card = (c: object) => [{ id: 'k', role: 'assistant' as const, testId: 't1', parts: [{ kind: 'agentCard' as const, card: { fix: { attempt: 1 }, ...c } }] }] as never;
  it('leaves the composer free, and a typed wrong-output ask is a normal ask, not a second session', () => {
    const items = card({ state: 'designed' });
    expect(composerBusy({ testing: true, pending: false }, items, 't1')).toBe(false);
    expect(composerBusy({ testing: true, pending: true }, items, 't1')).toBe(true); // a reply streams
    expect(composerBusy({ testing: true, pending: false }, card({ state: 'creating', smoke: { state: 'testing' } }), 't1')).toBe(true); // it works
    useAssistant.setState({ testing: new AbortController(), testingId: 't1', items });
    expect(startTypedSession('The numbers in the summary look made up. Test it and fix it.')).toBe(false);
    expect(session).not.toHaveBeenCalled();
    expect(useAssistant.getState().testing).toBeTruthy(); // the session stays waiting
  });
  it('a session that works, with no card of its own open, still swallows the ask', () => {
    useAssistant.setState({ testing: new AbortController(), testingId: 't1', items: [] });
    expect(startTypedSession('Run it now')).toBe(true);
    expect(session).not.toHaveBeenCalled();
  });
});
