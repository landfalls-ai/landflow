/**
 * SB03: a test session cannot wreck a flow (docs/assistant.md#test-and-fix). The session is driven in Node with the real
 * editor and assistant stores; the run and the assistant's reply are stubbed, and `applyChanges` is a small stand-in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AssistantOp } from '@/lib/shared/assistant-ops';

let agentsGate: Promise<void> | undefined;
vi.mock('@/components/editor/new-agent', async (original) => ({ ...(await original<typeof import('@/components/editor/new-agent')>()), agentsSettled: async () => { await agentsGate; } }));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-session-safety-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const applied: AssistantOp[][] = [];
let useEditor: typeof import('@/components/editor/store').useEditor;
vi.mock('@/components/editor/assistant', async (original) => {
  const real = await original<typeof import('@/components/editor/assistant')>();
  return {
    ...real,
    // Just enough of applyChanges for the ops these tests use.
    applyChanges: vi.fn((changes: Array<{ ops: AssistantOp[] }>, _label: string, options: { onApplied?: (a: { undo: () => void; skipped: string[] }) => void } = {}) => {
      const before = useEditor.getState().toWorkflow();
      for (const change of changes) {
        applied.push(change.ops);
        for (const op of change.ops) {
          const node = useEditor.getState().nodes.find((n) => n.data.wf.name === (op as { node?: string }).node);
          if (op.op === 'setParameters' && node) useEditor.getState().updateNode(node.id, { parameters: { ...node.data.wf.parameters, ...op.parameters } });
          if (op.op === 'setNodeSettings' && node) useEditor.getState().updateNode(node.id, { disabled: (op as { settings: { disabled?: boolean } }).settings.disabled });
          if (op.op === 'removeNode' && node) useEditor.getState().removeNodes([node.id]);
        }
      }
      options.onApplied?.({ undo: () => useEditor.getState().load(before, []), skipped: [] });
      return true;
    }),
  };
});
const published = vi.fn(async () => ({ published: { versionNumber: 3 } }));
vi.mock('@/components/editor/publish-control', () => ({ publishVersion: published, toastApprovalRequested: vi.fn() }));

({ useEditor } = await import('@/components/editor/store'));
const { useAssistant, undos } = await import('@/components/editor/assistant');
const { testUntilItRuns, approveDestinations, sendsAllowed, publishToProduction } = await import('@/components/editor/test-session');
const { autonomyOf, noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');

const WF = 'wf_orders';
const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const flow = (): Workflow => ({
  id: WF,
  name: 'Orders',
  nodes: [
    node('a', 'Start', 'core.manualTrigger'),
    node('b', 'Notify VIP', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/vip' }),
    node('c', 'Notify Standard', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/standard' }),
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
  ],
});

type ScriptedRun = Record<string, { error?: string; items?: number }>;
const nodeTypes = { 'core.manualTrigger': { type: 'core.manualTrigger', descriptor: { kind: 'trigger' } } } as never;
let runs: ScriptedRun[] = [];
const run = vi.fn();
const send = vi.fn();
let sentSessions: Array<string | undefined> = [];

/** The next scripted reply of the assistant: text and proposals. */
let replies: Array<{ text?: string; proposals?: Array<{ summary: string; ops: AssistantOp[] }> }> = [];

beforeEach(() => {
  applied.length = 0;
  published.mockClear();
  runs = [];
  replies = [];
  sentSessions = [];
  sendsAllowed.clear();
  useAutonomyFacts.setState({ switchOn: true, workflows: {} });
  useAssistant.getState().reset();
  useEditor.getState().load(flow(), []);
  useEditor.setState({ nodeTypes });
  run.mockReset().mockImplementation(() => {
    const scripted = runs.shift() ?? {};
    useEditor.setState({ running: true, executionId: `ex_${run.mock.calls.length}` });
    setTimeout(() => {
      const statuses: Record<string, unknown> = {};
      let failed = false;
      for (const n of useEditor.getState().nodes) {
        const r = scripted[n.data.wf.name];
        if (!r) continue;
        if (r.error) failed = true;
        statuses[n.id] = r.error ? { state: 'error', error: r.error } : { state: 'success', itemCounts: [r.items ?? 1] };
      }
      useEditor.setState({ running: false, statuses: statuses as never, runStatus: failed ? 'error' : 'success' });
    }, 0);
  });
  useEditor.setState({ run: run as never });
  send.mockReset().mockImplementation(async (_request: string, options: { session?: string; testId?: string }) => {
    sentSessions.push(options.session);
    const next = replies.shift() ?? { text: 'No change.' };
    const id = `r${sentSessions.length}`;
    useAssistant.getState().append([
      {
        id,
        role: 'assistant',
        testId: options.testId,
        done: { model: 'test', durationMs: 1, steps: 1 },
        parts: [
          ...(next.text ? [{ kind: 'text' as const, text: next.text }] : []),
          ...(next.proposals ?? []).map((p, i) => ({ kind: 'proposal' as const, proposal: { id: `${id}p${i}`, summary: p.summary, ops: p.ops, dropped: [], warnings: [] } })),
        ],
      },
    ]);
  });
  useAssistant.setState({ send: send as never });
});

const needs = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'needs' ? [p.need] : [])) : []));
const outcomes = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'outcome' ? [p.outcome] : [])) : []));
const actions = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'action' ? [p.action] : [])) : []));
const urls = () => useEditor.getState().nodes.map((n) => n.data.wf.parameters.url).filter(Boolean);
const decide = (proposal: string, state: 'applied' | 'dismissed') => {
  const item = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal' && p.proposal.id === proposal))!;
  useAssistant.getState().setProposalState(item.id, proposal, state);
};
const goal = 'POST big orders to Notify VIP and the rest to Notify Standard';
const yes = () => approveDestinations(WF, ['127.0.0.1:3399']);

describe('a policy block', () => {
  it('ends the session with a "blocked" row, asks for no fix and changes nothing (the evaluation’s incident)', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { error: 'Blocked: 127.0.0.1 resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)' } }];
    await testUntilItRuns(goal);
    expect(needs().map((n) => n.what)).toEqual(['blocked']);
    expect(needs()[0].text).toContain('127.0.0.1:3399');
    expect(send).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual(['http://127.0.0.1:3399/vip', 'http://127.0.0.1:3399/standard']);
    expect(actions()).toEqual([]);
  });
});

describe('a destination', () => {
  it('asks again when a fix brings one in, before the next run', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'Wrong port.', proposals: [{ summary: 'Set the url', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'http://127.0.0.1:3400/vip' } }] }] }];
    await testUntilItRuns('Tell the desk about big orders');
    expect(run).toHaveBeenCalledTimes(1);
    expect(needs().map((n) => n.what)).toEqual(['destination']);
    expect(needs()[0].destinations).toEqual(['http://127.0.0.1:3400']); // SB18: with its scheme
    expect(needs()[0].fix?.proposals).toHaveLength(1);
  });

  it('asks before the first run, per destination, not per workflow', async () => {
    approveDestinations(WF, ['somewhere.else:1']);
    await testUntilItRuns(goal);
    expect(needs().map((n) => n.what)).toEqual(['sends']);
    expect(needs()[0].text).toBe('A test runs “Notify VIP” and “Notify Standard” for real: they send to http://127.0.0.1:3399.');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('an address not filled in yet (review fixes)', () => {
  it('is a Needs-you row that opens the step, before any run, not "it sends to {{ … }}"', async () => {
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: '' } });
    yes();
    await testUntilItRuns(goal);
    expect(needs().map((n) => n.what)).toEqual(['address']);
    expect(needs()[0].node).toBe('Notify VIP');
    expect(needs()[0].text).toBe('“Notify VIP” sends to an address not filled in yet: open the step and fill it in.');
    expect(needs()[0].text).not.toContain('{{');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('the session sends its autonomy with each request (review fixes)', () => {
  const failedThenFix = async () => {
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ text: 'Nothing to change.' }];
    await testUntilItRuns(goal);
    return send.mock.calls.map((c) => (c[1] as { autonomy?: string }).autonomy);
  };

  it('asks-first on a saved workflow, auto on a brand-new draft', async () => {
    noteOpened(WF, 3);
    expect(await failedThenFix()).toEqual(['asks-first']);
    send.mockClear();
    sendsAllowed.clear();
    useAssistant.getState().reset();
    noteOpened('wf_orders_new', 0);
    useEditor.getState().load({ ...flow(), id: 'wf_orders_new' }, []);
    useEditor.setState({ nodeTypes });
    approveDestinations('wf_orders_new', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ text: 'Nothing to change.' }];
    await testUntilItRuns(goal);
    expect(send.mock.calls.map((c) => (c[1] as { autonomy?: string }).autonomy)).toEqual(['auto']);
  });
});

describe('an expression destination asks every time (review fixes)', () => {
  it('is never kept in sendsAllowed: the yes covers one run, and the next asks again', async () => {
    noteOpened(WF, 0);
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: '={{ $json.url }}' } });
    yes();
    await testUntilItRuns(goal);
    expect(needs().map((n) => n.what)).toEqual(['sends']);
    expect(needs()[0].destinations).toEqual(['{{ … }}']);
    approveDestinations(WF, ['{{ … }}'], needs()[0].once);
    expect([...(sendsAllowed.get(WF) ?? [])]).toEqual(['127.0.0.1:3399']);
    // A step added after the row was shown is not covered by its yes: the new row names it with the first one, and nothing runs.
    useEditor.getState().updateNode('c', { parameters: { method: 'POST', url: '={{ $json.other }}' } });
    await testUntilItRuns(goal);
    expect(run).not.toHaveBeenCalled();
    expect(needs().at(-1)?.nodes).toEqual(['Notify VIP', 'Notify Standard']);
    // One yes covers both, once; the next test asks again.
    approveDestinations(WF, ['{{ … }}'], needs().at(-1)?.once);
    runs = [{ 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    const firstRow = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'needs'))!.id;
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(1);
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(1);
    const rows = useAssistant.getState().items.filter((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'needs'));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(firstRow); // asked again, a new row
  });

  it('a yes does not outlive a session that only asked: a changed expression asks again, and a yes on the new step does not send the old one', async () => {
    noteOpened(WF, 0);
    yes();
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: '={{ $json.url }}' } });
    await testUntilItRuns(goal);
    approveDestinations(WF, ['{{ … }}'], needs().at(-1)?.once); // yes on A (Notify VIP)
    useEditor.getState().updateNode('c', { parameters: { method: 'POST', url: '={{ $json.other }}' } });
    await testUntilItRuns(goal); // stops on B's row, runs nothing
    expect(run).not.toHaveBeenCalled();
    const bRow = needs().at(-1)!;
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: '={{ $json.somewhereElse }}' } });
    approveDestinations(WF, ['{{ … }}'], bRow.once); // a yes on B's row as it was shown
    await testUntilItRuns(goal);
    expect(run).not.toHaveBeenCalled();
    expect(needs().at(-1)?.nodes).toContain('Notify VIP');
  });

  it('a URL that changes while the agents settle is asked about before the first run', async () => {
    noteOpened(WF, 0);
    yes();
    let release!: () => void;
    agentsGate = new Promise<void>((r) => (release = r));
    const session = testUntilItRuns(goal);
    await Promise.resolve();
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: 'http://evil.example:9/x' } }); // e.g. an older proposal card applied
    release();
    agentsGate = undefined;
    await session;
    expect(run).not.toHaveBeenCalled();
    expect(needs().map((n) => n.what)).toContain('destination');
    expect(needs().at(-1)?.destinations).toEqual(['http://evil.example:9']); // SB18: with its scheme
  });

  it('a step deleted and added back under the same name asks again', async () => {
    noteOpened(WF, 0);
    yes();
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: '={{ $json.url }}' } });
    await testUntilItRuns(goal);
    approveDestinations(WF, ['{{ … }}'], needs().at(-1)?.once);
    useEditor.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === 'b' ? { ...n, id: 'b2' } : n)) })); // deleted and added back, same name and URL
    await testUntilItRuns(goal);
    expect(run).not.toHaveBeenCalled();
    expect(needs().at(-1)?.nodes).toEqual(['Notify VIP']);
  });
});

describe('a Stop before the run starts', () => {
  it('stopped while an agent is being designed, no real run starts', async () => {
    noteOpened(WF, 0);
    yes();
    let release!: () => void;
    agentsGate = new Promise<void>((resolve) => (release = resolve));
    const session = testUntilItRuns(goal);
    await Promise.resolve();
    useAssistant.getState().testing?.abort();
    release();
    await session;
    agentsGate = undefined;
    expect(run).not.toHaveBeenCalled();
  });
});

describe('what a fix may not do', () => {
  it('a fix removing a step the goal names is not applied; the outcome card says what and why', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Removed the HTTP steps', ops: [{ op: 'removeNode', node: 'Notify VIP' }, { op: 'removeNode', node: 'Notify Standard' }] }] }];
    await testUntilItRuns(goal);
    expect(applied).toEqual([]);
    expect(useEditor.getState().nodes).toHaveLength(3);
    expect(outcomes()[0].text).toBe('The fix wanted to remove “Notify VIP”, which you asked for. I kept it.');
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions()).toEqual([]);
  });

  it('a pass after steps were removed shows no publish card', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 } }];
    replies = [{ proposals: [{ summary: 'Dropped the second step', ops: [{ op: 'removeNode', node: 'Notify Standard' }] }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    useEditor.getState().removeNodes(['c']);
    decide('r1p0', 'applied');
    await session;
    expect(actions()).toEqual([]);
    expect(outcomes()[0].text).toContain('removed “Notify Standard”');
  });
});

describe('turning a step off', () => {
  it('a pass after a step was turned off shows no publish card and names it', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 } }];
    replies = [{ proposals: [{ summary: 'Turned off the second step', ops: [{ op: 'setNodeSettings', node: 'Notify Standard', settings: { disabled: true } }] }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    useEditor.getState().updateNode('c', { disabled: true });
    decide('r1p0', 'applied');
    await session;
    expect(actions()).toEqual([]);
    expect(outcomes()[0].text).toContain('turned off “Notify Standard”');
  });

  it('reset() while a fix waits leaves the conversation empty', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { method: 'PUT' } }] }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix']));
    useAssistant.getState().reset();
    await session;
    expect(useAssistant.getState().items).toEqual([]);
  });
});

describe('autonomy (D1)', () => {
  const fixOps: AssistantOp[] = [{ op: 'setParameters', node: 'Notify VIP', parameters: { method: 'PUT' } }];

  it('asks-first: the fix waits for Apply, then runs again', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix']));
    await new Promise((r) => setTimeout(r, 20));
    expect(applied).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    // The person clicks Apply (the card applies it and marks it).
    const { applyChanges } = await import('@/components/editor/assistant');
    applyChanges([{ ops: fixOps, kind: 'proposal' }], 'Use PUT', { onApplied: ({ undo }) => undos.set('r1p0', undo) });
    decide('r1p0', 'applied');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix', 'review']));
    useAssistant.getState().testing?.abort();
    await session;
  });

  it('asks-first: Dismiss ends the session with an outcome card', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix']));
    decide('r1p0', 'dismissed');
    await session;
    expect(applied).toEqual([]);
    expect(outcomes()[0].text).toBe('You kept the flow as it was.');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks-first: Stop while waiting ends it', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }];
    const session = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix']));
    useAssistant.getState().testing?.abort();
    await session;
    expect(applied).toEqual([]);
    expect(outcomes()[0].text).toContain('You stopped before the change was applied');
    expect(useAssistant.getState().testing).toBeUndefined();
  });

  it('auto: a fix that removes a step waits, with the reason; one that only sets parameters is applied', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Drop the second step', ops: [{ op: 'removeNode', node: 'Notify Standard' }] }] }];
    const waiting = testUntilItRuns('Tell the desk about big orders');
    await vi.waitFor(() => expect(sentSessions).toEqual(['fix']));
    await new Promise((r) => setTimeout(r, 20));
    expect(applied).toEqual([]);
    const proposal = useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : [])) : []))[0];
    expect(proposal.warnings).toEqual(['Waits for you: removes “Notify Standard”']);
    decide('r1p0', 'dismissed');
    await waiting;

    useAssistant.getState().reset();
    useEditor.getState().load(flow(), []);
    useEditor.setState({ nodeTypes, run: run as never });
    sentSessions = [];
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }, { text: 'Yes, it does.' }];
    await testUntilItRuns('Tell the desk about big orders');
    expect(applied).toEqual([fixOps]);
  });
});

describe('before "Ready for production"', () => {
  it('a pass after a fix is reviewed first, and the card shows only on a yes', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { method: 'PUT' } }] }] }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns('Tell the desk about big orders');
    expect(sentSessions).toEqual(['fix', 'review']);
    expect(actions()).toEqual(['publish']);
  });

  it('a review that says no ends with the outcome card, not the publish card', async () => {
    noteOpened(WF, 0);
    yes();
    runs = [{ 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'No, the standard orders are missing.' }];
    await testUntilItRuns('Tell the desk about big orders');
    expect(sentSessions).toEqual(['review']);
    expect(actions()).toEqual([]);
    expect(outcomes()).toHaveLength(1);
  });
});

describe('publishing', () => {
  it('notes the publish, so the workflow is asks-first from then on', async () => {
    noteOpened(WF, 0);
    expect(autonomyOf(WF)).toBe('auto');
    expect(await publishToProduction()).toBe(true);
    expect(published).toHaveBeenCalled();
    expect(autonomyOf(WF)).toBe('asks-first');
  });
});
