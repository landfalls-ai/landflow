/**
 * Spotlight's autonomous mode (components/editor/autonomous.ts): on by default; a drafted flow goes straight into Test
 * and fix, and a chat reply's proposals are applied as it ends and the flow is tested; off, nothing happens without a
 * click. The canvas and the test run are stubbed: what's checked is what autonomous mode decides to do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const applied: unknown[] = [];
vi.mock('@/components/editor/test-session', () => ({ testUntilItRuns: vi.fn(async () => {}) }));
vi.mock('@/components/editor/assistant', async (original) => ({
  ...(await original<typeof import('@/components/editor/assistant')>()),
  applyChanges: vi.fn((changes: unknown[]) => {
    applied.push(...changes);
    return true;
  }),
}));

const { useAssistant } = await import('@/components/editor/assistant');
const { testUntilItRuns } = await import('@/components/editor/test-session');
const { afterReply, autonomous, testDraft, useAutonomous } = await import('@/components/editor/autonomous');

const proposal = (id: string, state?: 'applied' | 'dismissed') => ({ id, summary: `Change ${id}`, ops: [{ op: 'removeNode' as const, node: id }], dropped: [], warnings: [], ...(state && { state }) });

beforeEach(() => {
  applied.length = 0;
  vi.mocked(testUntilItRuns).mockClear();
  useAssistant.getState().reset();
  useAutonomous.setState({ on: true });
});

const done = { model: 'test', durationMs: 1, steps: 1 };

describe('autonomous mode', () => {
  it('is on by default', () => {
    // No localStorage here (Node): the default.
    expect(autonomous()).toBe(true);
  });

  it('applies what a reply proposed, marks it applied, and tests the flow with the request as its goal', async () => {
    useAssistant.getState().append([
      { id: 'u', role: 'user', text: 'Drop Check' },
      { id: 'r', role: 'assistant', done, parts: [{ kind: 'proposal', proposal: proposal('a') }, { kind: 'proposal', proposal: proposal('b', 'dismissed') }, { kind: 'proposal', proposal: proposal('c') }] },
    ]);
    await afterReply('Drop Check');
    expect(applied).toEqual([
      { ops: [{ op: 'removeNode', node: 'a' }], kind: 'proposal' },
      { ops: [{ op: 'removeNode', node: 'c' }], kind: 'proposal' },
    ]);
    const reply = useAssistant.getState().items.at(-1)!;
    expect(reply.role === 'assistant' && reply.parts.map((p) => (p.kind === 'proposal' ? p.proposal.state : undefined))).toEqual(['applied', 'dismissed', 'applied']);
    expect(testUntilItRuns).toHaveBeenCalledWith('Drop Check', { publishAgents: true });
  });

  it('does nothing for a reply without proposals, one that failed, one that was stopped, or when it is off', async () => {
    useAssistant.getState().append([{ id: 'r1', role: 'assistant', done, parts: [{ kind: 'text', text: 'It already does that.' }] }]);
    await afterReply('x');
    useAssistant.getState().append([{ id: 'r2', role: 'assistant', done, parts: [{ kind: 'proposal', proposal: proposal('a') }], error: 'Model went away' }]);
    await afterReply('x');
    // Stopped mid-stream: no `done`, so its half-written proposal waits.
    useAssistant.getState().append([{ id: 'r4', role: 'assistant', parts: [{ kind: 'proposal', proposal: proposal('a') }] }]);
    await afterReply('x');
    useAutonomous.setState({ on: false });
    useAssistant.getState().append([{ id: 'r3', role: 'assistant', done, parts: [{ kind: 'proposal', proposal: proposal('a') }] }]);
    await afterReply('x');
    expect(applied).toEqual([]);
    expect(testUntilItRuns).not.toHaveBeenCalled();
  });

  it('starts Test and fix on a drafted flow in place of the button, unless it is off', () => {
    useAssistant.getState().append([{ id: 'd', role: 'assistant', parts: [{ kind: 'action', action: 'test', goal: 'Send a digest' }] }]);
    expect(testDraft('d', 'Send a digest')).toBe(true);
    expect(testUntilItRuns).toHaveBeenCalledWith('Send a digest', { publishAgents: true });
    const reply = useAssistant.getState().items.at(-1)!;
    expect(reply.role === 'assistant' && reply.parts[0]).toMatchObject({ kind: 'action', action: 'test', state: 'done' });

    vi.mocked(testUntilItRuns).mockClear();
    useAutonomous.setState({ on: false });
    expect(testDraft('d', 'Send a digest')).toBe(false);
    expect(testUntilItRuns).not.toHaveBeenCalled();
  });
});
