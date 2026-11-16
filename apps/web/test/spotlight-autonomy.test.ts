/**
 * Decision D1 (components/editor/spotlight-autonomy.ts, autonomous.ts): Spotlight acts alone only while it builds a
 * brand-new draft; a saved or published workflow asks first; what removes a step waits for a click even on a new draft;
 * a question is never sent as `auto` nor applied. The canvas and the test run are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const applied: unknown[] = [];
const versions = vi.hoisted(() => ({ published: undefined as string | undefined }));
vi.mock('@/components/editor/test-session', () => ({ testUntilItRuns: vi.fn(async () => {}) }));
vi.mock('@/lib/client/api', () => ({ api: vi.fn(async () => ({ versions: [], ...(versions.published && { publishedVersionId: versions.published }) })) }));
vi.mock('@/components/editor/assistant', async (original) => ({
  ...(await original<typeof import('@/components/editor/assistant')>()),
  applyChanges: vi.fn((changes: unknown[]) => {
    applied.push(...changes);
    return true;
  }),
}));

const { useAssistant } = await import('@/components/editor/assistant');
const { useEditor } = await import('@/components/editor/store');
const { testUntilItRuns } = await import('@/components/editor/test-session');
const { afterReply, holdsForClick, testDraft, typedSession, useAutonomous } = await import('@/components/editor/autonomous');
const { autonomyFor, autonomyOf, needsAClick, noteOpened, notePublished, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');

const graph = {
  nodes: [
    { id: 'a', name: 'Start' },
    { id: 'b', name: 'Check total' },
    { id: 'c', name: 'Notify VIP' },
  ],
  connections: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};
const done = { model: 'test', durationMs: 1, steps: 1 };
const proposal = (id: string, ops: object[]) => ({ id, summary: `Change ${id}`, ops: ops as never, dropped: [], warnings: [] as string[] });
const reply = (...proposals: ReturnType<typeof proposal>[]) =>
  useAssistant.getState().append([
    { id: 'u', role: 'user', text: 'change it' },
    { id: 'r', role: 'assistant', done, parts: proposals.map((p) => ({ kind: 'proposal' as const, proposal: p })) },
  ]);
const states = () => {
  const r = useAssistant.getState().items.at(-1)!;
  return r.role === 'assistant' ? r.parts.map((p) => (p.kind === 'proposal' ? (p.proposal.state ?? 'waiting') : p.kind)) : [];
};
const open = async (id: string, nodes: number) => {
  // The editor loads the workflow: the same state holds the id and its nodes.
  useEditor.setState({ workflowId: id, nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, data: { wf: { id: `n${i}`, name: `Node ${i}` } } }) as never), edges: [] });
  await vi.waitFor(() => expect(useAutonomyFacts.getState().workflows[id]).toBeDefined());
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  applied.length = 0;
  versions.published = undefined;
  vi.mocked(testUntilItRuns).mockClear();
  useAssistant.getState().reset();
  useAutonomous.setState({ on: true });
  useAutonomyFacts.setState({ workflows: {} });
  useEditor.setState({ workflowId: '', nodes: [], edges: [] });
});

describe('the rule', () => {
  it('is auto only for the switch on, born empty and never published', () => {
    for (const switchOn of [true, false]) {
      for (const bornEmpty of [true, false]) {
        for (const published of [true, false]) {
          expect(autonomyFor({ switchOn, bornEmpty, published })).toBe(switchOn && bornEmpty && !published ? 'auto' : 'asks-first');
        }
      }
    }
  });

  it('keeps the first note of a workflow, and knows nothing of one it never saw opened', () => {
    noteOpened('w1', 0);
    noteOpened('w1', 5);
    expect(autonomyOf('w1')).toBe('auto');
    expect(autonomyOf('never-seen')).toBe('asks-first');
    notePublished('w1');
    expect(autonomyOf('w1')).toBe('asks-first');
  });

  it('follows the switch as moved, and a workflow opened with nodes is asks-first with it on', async () => {
    await open('saved', 3);
    expect(autonomyOf('saved')).toBe('asks-first');
    await open('fresh', 0);
    expect(autonomyOf('fresh')).toBe('auto');
    useAutonomous.getState().set(false);
    expect(autonomyOf('fresh')).toBe('asks-first');
    useAutonomous.getState().set(true);
    expect(autonomyOf('fresh')).toBe('auto');
  });

  it('reads the versions of a workflow opened empty: a published one is asks-first', async () => {
    versions.published = 'v1';
    await open('published-empty', 0);
    await vi.waitFor(() => expect(autonomyOf('published-empty')).toBe('asks-first'));
  });

  it('carries the facts of a new workflow to its new id when its canvas is kept', async () => {
    await open('draft-1', 0);
    const nodes = useEditor.getState().nodes;
    useEditor.setState({ workflowId: 'wf_real', nodes });
    expect(autonomyOf('wf_real')).toBe('auto');
  });
});

describe('needsAClick', () => {
  it('names a removal, and a disconnect that orphans a step', () => {
    expect(needsAClick([{ op: 'removeNode', node: 'Notify VIP' }], graph)).toEqual(['removes “Notify VIP”']);
    expect(needsAClick([{ op: 'disconnect', from: 'Check total', to: 'Notify VIP' }], graph)).toEqual(['leaves “Notify VIP” without its input']);
  });
  it('asks nothing when the step is connected again, when it has another input, or when a node is added before another', () => {
    expect(needsAClick([{ op: 'disconnect', from: 'Check total', to: 'Notify VIP' }, { op: 'connect', from: 'Start', to: 'Notify VIP' }], graph)).toEqual([]);
    expect(needsAClick([{ op: 'disconnect', from: 'Check total', to: 'Notify VIP' }], { ...graph, connections: [...graph.connections, { source: 'a', target: 'c' }] })).toEqual([]);
    expect(needsAClick([{ op: 'addNode', type: 'core.code', name: 'X', before: 'Notify VIP' }, { op: 'setParameters', node: 'Check total' }], graph)).toEqual([]);
  });
});

describe('afterReply', () => {
  it('applies nothing on a saved workflow', async () => {
    await open('saved', 3);
    reply(proposal('p1', [{ op: 'setParameters', node: 'Node 0', parameters: { a: 1 } }]));
    await afterReply('make it retry 3 times');
    expect(applied).toEqual([]);
    expect(states()).toEqual(['waiting']);
    expect(testUntilItRuns).not.toHaveBeenCalled();
  });

  it('on a new draft applies a setParameters and leaves a removeNode waiting with its reason', async () => {
    await open('fresh', 0);
    // The canvas the removal reads: the draft has grown since it was opened.
    useEditor.setState({ nodes: [{ id: 'n9', data: { wf: { id: 'n9', name: 'Notify VIP' } } }] as never });
    reply(proposal('p1', [{ op: 'setParameters', node: 'Notify VIP', parameters: { a: 1 } }]), proposal('p2', [{ op: 'removeNode', node: 'Notify VIP' }]));
    await afterReply('tidy up');
    expect(applied).toEqual([{ ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { a: 1 } }], kind: 'proposal' }]);
    expect(states()).toEqual(['applied', 'waiting']);
    const waiting = useAssistant.getState().items.at(-1)!;
    expect(waiting.role === 'assistant' && waiting.parts[1].kind === 'proposal' && waiting.parts[1].proposal.warnings).toEqual(['Waits for you: removes “Notify VIP”']);
    expect(testUntilItRuns).toHaveBeenCalledTimes(1);
  });

  it('tests nothing when every proposal waits', async () => {
    await open('fresh', 0);
    useEditor.setState({ nodes: [{ id: 'n9', data: { wf: { id: 'n9', name: 'Notify VIP' } } }] as never });
    reply(proposal('p1', [{ op: 'removeNode', node: 'Notify VIP' }]));
    await afterReply('remove Notify VIP');
    expect(applied).toEqual([]);
    expect(testUntilItRuns).not.toHaveBeenCalled();
  });

  it('applies nothing for a question, even on a new draft', async () => {
    await open('fresh', 0);
    reply(proposal('p1', [{ op: 'setParameters', node: 'Node 0', parameters: { a: 1 } }]));
    await afterReply('why did the last run fail?');
    expect(applied).toEqual([]);
  });
});

describe('what is sent', () => {
  it('marks a change auto only on a new draft, and never a question', async () => {
    await open('fresh', 0);
    expect(typedSession('make it retry 3 times')).toEqual({ session: 'auto' });
    expect(typedSession('why did the last run fail?')).toEqual({});
    expect(typedSession('why did it fail? fix it')).toEqual({ session: 'auto' });
    await open('saved', 4);
    expect(typedSession('make it retry 3 times')).toEqual({});
  });

  it('holds a reply for a click on a saved workflow, and on a new draft only when it removes a step', async () => {
    const rm = [{ ops: [{ op: 'removeNode', node: 'Node 0' }] as never }];
    const set = [{ ops: [{ op: 'setParameters', node: 'Node 0', parameters: {} }] as never }];
    await open('saved', 2);
    expect(holdsForClick(set)).toBe(true);
    await open('fresh', 0);
    useEditor.setState({ nodes: [{ id: 'n0', data: { wf: { id: 'n0', name: 'Node 0' } } }] as never });
    expect(holdsForClick(set)).toBe(false);
    expect(holdsForClick(rm)).toBe(true);
  });

  it('tests a drafted flow by itself only on a new draft', async () => {
    useAssistant.getState().append([{ id: 'd', role: 'assistant', parts: [{ kind: 'action', action: 'test', goal: 'x' }] }]);
    await open('saved', 4);
    expect(testDraft('d', 'x')).toBe(false);
    await open('fresh', 0);
    expect(testDraft('d', 'x')).toBe(true);
  });
});
