/**
 * The Spotlight panel (components/editor/spotlight.tsx, ./timeline.ts, the store in ./assistant.ts): its header and steps
 * come from the conversation, an agent being designed is a row after the turn that created it, and nothing but the person
 * folds or unfolds it: a reply, a drafted flow, a test-and-fix session and autonomous mode leave `collapsed` alone. The runs
 * it starts are rows of its timeline, not toasts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/editor/test-session', () => ({ testUntilItRuns: vi.fn(async () => {}) }));
vi.mock('@/components/editor/assistant', async (original) => ({
  ...(await original<typeof import('@/components/editor/assistant')>()),
  applyChanges: vi.fn(() => true),
}));

const { fixedNodes, ownRun, spotlightOwnsRun, useAssistant } = await import('@/components/editor/assistant');
const { useEditor } = await import('@/components/editor/store');
const { afterReply, useAutonomous } = await import('@/components/editor/autonomous');
const { agentStep, lastRunOf, stepsOf, titleOf } = await import('@/components/editor/timeline');
type ChatItem = import('@/components/editor/assistant').ChatItem;

const session: ChatItem[] = [
  { id: 'u', role: 'user', text: 'When a ticket arrives, triage it and post to Slack' },
  { id: 'd', role: 'assistant', parts: [{ kind: 'text', text: 'Built “Tickets” with 4 nodes. ⌘Z undoes it.' }, { kind: 'action', action: 'test', state: 'done' }] },
  { id: 'r1', role: 'assistant', testId: 't', parts: [{ kind: 'run', run: { round: 1, state: 'failed', summary: 'failed at “Post to Slack”: No credential' } }] },
  { id: 'f1', role: 'user', testId: 't', auto: true, text: 'Fix “Post to Slack”: No credential. It failed at run 1.' },
  { id: 'a1', role: 'assistant', testId: 't', parts: [{ kind: 'text', text: 'Set the credential. Then it posts.' }, { kind: 'proposal', proposal: { id: 'p1', summary: 'Pick the Slack credential', ops: [{ op: 'setParameters', node: 'Post to Slack', parameters: { channel: '#support' } }], dropped: [], warnings: [], state: 'applied' } }] },
  { id: 'r2', role: 'assistant', testId: 't', parts: [{ kind: 'run', run: { round: 2, state: 'passed', summary: '4 steps, 1 item reached “Post to Slack”' } }] },
];

beforeEach(() => {
  useAssistant.getState().reset();
  useAssistant.setState({ collapsed: false });
  useAutonomous.setState({ on: true });
});

describe('the timeline', () => {
  it('lists the draft, each run (with the node it failed at), each fix and the agents, in order', () => {
    const agents = [{ nodeId: 'n1', name: 'Contract Reviewer', state: 'published' as const, summary: 'ollama/qwen3-coder:30b · 1 knowledge base', agentId: 'ag_1', after: 'a1' }];
    const { ask, steps } = stepsOf(session, { agents });
    expect(ask).toBe('When a ticket arrives, triage it and post to Slack');
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ['draft', 'Built “Tickets” with 4 nodes.'],
      ['run', 'Run 1 · failed at “Post to Slack”: No credential'],
      ['fix', 'Fixed · Set channel on “Post to Slack”'],
      ['agent', 'Agent “Contract Reviewer” published · ollama/qwen3-coder:30b · 1 knowledge base'],
      ['run', 'Run 2 · no errors: 4 steps, 1 item reached “Post to Slack”'],
    ]);
    expect(steps[1]).toMatchObject({ icon: 'failed', nodeName: 'Post to Slack' });
    expect(steps[3]).toMatchObject({ agentId: 'ag_1' });
    expect(lastRunOf(session)).toMatchObject({ state: 'passed' });
  });

  it('says what Spotlight is doing in the header', () => {
    const base = { drafting: false, testing: false, pending: false, hasItems: true };
    expect(titleOf({ ...base, drafting: true })).toBe('Drafting the flow');
    expect(titleOf({ ...base, testing: true, fixingName: 'Triage', designing: 'Contract Reviewer' })).toBe('Designing “Contract Reviewer”');
    expect(titleOf({ ...base, testing: true, fixingName: 'Triage' })).toBe('Fixing “Triage”');
    expect(titleOf({ ...base, testing: true })).toBe('Testing the flow');
    expect(titleOf({ ...base, lastRun: 'passed' })).toBe('Passed');
    expect(titleOf({ ...base, lastRun: 'failed' })).toBe('Stopped');
    expect(titleOf({ ...base, lastRun: 'failed', stoppedAt: 'Post to Slack' })).toBe('Stopped at “Post to Slack”');
    expect(titleOf({ ...base, lastRun: 'failed', needs: 'credential' })).toBe('Needs you: pick a credential');
    expect(titleOf({ ...base, hasItems: false })).toBe('Ask Spotlight');
  });

  it('writes an agent row for each state', () => {
    expect(agentStep({ nodeId: 'n', name: 'R', state: 'designing' }).text).toBe('Designing the agent “R”…');
    expect(agentStep({ nodeId: 'n', name: 'R', state: 'draft' }).text).toBe('Agent “R” saved as a draft');
    expect(agentStep({ nodeId: 'n', name: 'R', state: 'failed', summary: 'Model went away' })).toMatchObject({ icon: 'failed', text: 'Couldn’t create the agent “R”: Model went away' });
  });
});

describe('the panel stays where the person put it', () => {
  it('a reply, a drafted flow and autonomous mode never fold or unfold it', async () => {
    useAssistant.getState().setCollapsed(true);
    useAssistant.getState().append([{ id: 'u', role: 'user', text: 'Drop Check' }, { id: 'r', role: 'assistant', done: { model: 'test', durationMs: 1, steps: 1 }, parts: [{ kind: 'proposal', proposal: { id: 'p', summary: 'Drop Check', ops: [{ op: 'removeNode', node: 'Check' }], dropped: [], warnings: [] } }] }]);
    await afterReply('Drop Check');
    expect(useAssistant.getState().collapsed).toBe(true);
    useAssistant.getState().setCollapsed(false);
    useAssistant.getState().append([{ id: 'u2', role: 'user', text: 'again' }]);
    expect(useAssistant.getState().collapsed).toBe(false);
    // ⌘I unfolds it.
    useAssistant.getState().setCollapsed(true);
    useAssistant.getState().setOpen(true);
    expect(useAssistant.getState().collapsed).toBe(false);
  });

  it('records an agent after the turn that created it, then updates that row', () => {
    useAssistant.getState().append([{ id: 'x', role: 'assistant', parts: [] }]);
    useAssistant.getState().setAgent('n1', { name: 'Contract Reviewer' });
    useAssistant.getState().setAgent('n1', { state: 'published', agentId: 'ag_1' });
    expect(useAssistant.getState().agents).toEqual([{ nodeId: 'n1', name: 'Contract Reviewer', state: 'published', agentId: 'ag_1', after: 'x' }]);
    useAssistant.getState().reset();
    expect(useAssistant.getState().agents).toEqual([]);
  });

  it('puts what a fix changed on the nodes it touched, until dismissed', () => {
    useEditor.setState({ nodes: [{ id: 'n1', data: { wf: { name: 'Post to Slack' } } }, { id: 'n2', data: { wf: { name: 'Pick credential' } } }] as never });
    expect(fixedNodes([{ op: 'setParameters', node: 'Post to Slack', parameters: {} }, { op: 'connect', from: 'Pick credential', to: 'Post to Slack' }])).toEqual(['n1']);
    // One bubble: the node the fix was asked for, when the fix touched it or named no node.
    expect(fixedNodes([{ op: 'setParameters', node: 'Post to Slack', parameters: {} }, { op: 'setParameters', node: 'Pick credential', parameters: {} }], 'n2')).toEqual(['n2']);
    expect(fixedNodes([{ op: 'setParameters', node: 'Post to Slack', parameters: {} }], 'n2')).toEqual(['n1']);
    expect(fixedNodes([{ op: 'disconnect', from: 'a', to: 'b' }], 'n2')).toEqual(['n2']);
    expect(fixedNodes([], 'gone')).toEqual([]);
    useAssistant.getState().noteFix(['n1'], 'Pick the Slack credential');
    expect(useAssistant.getState().fixNotes.n1).toMatchObject({ text: 'Pick the Slack credential' });
    useAssistant.getState().dismissFix('n1');
    expect(useAssistant.getState().fixNotes).toEqual({});
    // Undoing the fix takes its bubble away too.
    useAssistant.getState().noteFix(['n1'], 'Pick the Slack credential');
    useAssistant.getState().setProposalState('x', 'p', 'undone');
    expect(useAssistant.getState().fixNotes).toEqual({});
  });

  it('owns the runs it starts: no run toast while it tests or a run row is still running', () => {
    expect(spotlightOwnsRun()).toBe(false);
    useAssistant.getState().append([{ id: 'r', role: 'assistant', testId: 't', parts: [{ kind: 'run', run: { round: 1, state: 'running' } }] }]);
    expect(spotlightOwnsRun()).toBe(true);
    useAssistant.getState().reset();
    useAssistant.setState({ testing: new AbortController() });
    expect(spotlightOwnsRun()).toBe(true);
    useAssistant.setState({ testing: undefined });
    expect(spotlightOwnsRun()).toBe(false);
    // Its run ends after the session asked the person and ended: still its own.
    useEditor.setState({ executionId: 'ex_1' });
    ownRun('ex_1');
    expect(spotlightOwnsRun()).toBe(true);
    useEditor.setState({ executionId: 'ex_2' });
    expect(spotlightOwnsRun()).toBe(false);
  });
});
