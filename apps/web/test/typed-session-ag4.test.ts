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
