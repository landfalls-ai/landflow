/**
 * AG22  * AG20: Spotlight runs the flow, reads the run's log, makes one focused fix to the flow or the agent, runs again and stops
 * within a bound saying what is left (docs/assistant.md "Test and fix"). The session is driven in Node with the real editor
 * and assistant stores; the run and the assistant's reply are stubbed (as spotlight-session-safety.test.ts does), the agent
 * routes are a recording stand-in for `api`.
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
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-session-stable-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

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
const apiCalls: Array<{ path: string; method: string; json?: unknown }> = [];
let apiAnswers: Record<string, (init: { json?: unknown }) => unknown> = {};
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string, init: { method?: string; json?: unknown } = {}) => {
    apiCalls.push({ path, method: init.method ?? 'GET', ...(init.json !== undefined && { json: init.json }) });
    const answer = apiAnswers[`${init.method ?? 'GET'} ${path}`];
    if (!answer) return {};
    return answer(init);
  }),
}));
const published = vi.fn(async (_id: string, _options?: unknown) => ({ published: { versionNumber: 3, versionId: 'ver3' } }));
vi.mock('@/components/editor/publish-control', () => ({ publishVersion: published, toastApprovalRequested: vi.fn() }));

({ useEditor } = await import('@/components/editor/store'));
const { useAssistant, undos } = await import('@/components/editor/assistant');
const { testUntilItRuns, approveDestinations, sendsAllowed } = await import('@/components/editor/test-session');
const { applyAgentChange, publishAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { ApiError } = await import('@/lib/client/api');
const { showSmoke } = await import('@/components/editor/spotlight/agent-credential-picker');
const { fixLine } = await import('@/lib/shared/agent-card');
const { noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');
const { keptOwnFixLine } = await import('@/lib/shared/fix-autonomy');


const WF = 'wf_sales';
const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const flow = (): Workflow => ({
  id: WF,
  name: 'Sales digest',
  nodes: [
    node('a', 'Start', 'core.manualTrigger'),
    node('b', 'Ask analyst', 'core.messageAgent', { agentId: 'ag_q', message: 'Sales by region?' }),
    node('c', 'Post', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/received' }),
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
  ],
});
const nodeTypes = {
  'core.manualTrigger': { type: 'core.manualTrigger', descriptor: { kind: 'trigger' } },
  'sales.query': { type: 'sales.query', descriptor: { properties: [], credentials: [{ name: 'salesDb', required: true }] } },
} as never;
type ScriptedRun = Record<string, { error?: string; items?: number }>;
let runs: ScriptedRun[] = [];
const run = vi.fn();
const send = vi.fn();
let sentSessions: Array<string | undefined> = [];
let sentRequests: string[] = [];
let sentAutonomy: Array<string | undefined> = [];

/** The next scripted reply of the assistant: text and proposals. */
let replies: Array<{ text?: string; proposals?: Array<{ summary: string; ops: AssistantOp[] }>; agentFix?: unknown }> = [];

beforeEach(() => {
  useEditor.setState({ save: async () => true } as never);
  applied.length = 0;
  published.mockClear();
  runs = [];
  replies = [];
  sentSessions = [];
  sentRequests = [];
  sentAutonomy = [];
  apiCalls.length = 0;
  apiAnswers = {};
  sendsAllowed.clear();
  // AG22: the tests below assert Asks first (every step waits for a click). The decision of 2026-11-18 made the switch alone decide a
  // fix session's autonomy, so they run with the switch off; the switch-on behaviour is session-auto-ag5.test.ts.
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
  send.mockReset().mockImplementation(async (request: string, options: { session?: string; testId?: string; autonomy?: string }) => {
    sentAutonomy.push(options.autonomy);
    sentSessions.push(options.session);
    sentRequests.push(request);
    const next = replies.shift() ?? { text: 'No change.' };
    const id = `r${sentSessions.length}`;
    useAssistant.getState().append([
      {
        id,
        role: 'assistant',
        testId: options.testId,
        done: { model: 'test', durationMs: 1, steps: 1 },
        ...(next.agentFix ? { agentFix: next.agentFix as never } : {}),
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
const cards = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'agentCard' ? [{ itemId: i.id, card: p.card, text: i.parts.find((x) => x.kind === 'text') }] : [])) : []));
const decide = (proposal: string, state: 'applied' | 'dismissed') => {
  const item = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal' && p.proposal.id === proposal))!;
  useAssistant.getState().setProposalState(item.id, proposal, state);
};
const yes = () => approveDestinations(WF, ['127.0.0.1:3399']);
const waitForCard = () => vi.waitFor(() => expect(cards()).toHaveLength(1));
const fixBody = { op: 'setParameters', node: 'Notify VIP', parameters: { body: { report_text: '{{ $json.report }}' } } } as AssistantOp;



const lines = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])) : []));
const lack = { type: 'agent-fix', agentId: 'ag_q', agent: 'Question answerer', change: 'Add the Sales DB query tool and tell it to use it', fix: { executionId: 'ex_1', step: 'Ask analyst', cause: 'the agent has no database tool', attempt: 1 } };
const remove = { ...lack, change: 'Remove the query_sales tool; answer from memory' };
const tool = { id: 't1', type: 'node', nodeType: 'sales.query', name: 'query_sales', parameters: {} };
const putMethod: AssistantOp = { op: 'setParameters', node: 'Post', parameters: { method: 'PUT' } };
const backToPost: AssistantOp = { op: 'setParameters', node: 'Post', parameters: { method: 'POST' } };
const agentSaid = (reply: string) => useEditor.setState({ runs: { b: [{ source: 'main', status: 'success', durationMs: 5, inputs: [[{ json: { q: 'x' } }]], outputs: [[{ json: { reply } }]] }] } as never });
const ok = { 'Ask analyst': { items: 1 }, Post: { items: 1 } };

const routes = (designs: Array<() => unknown>) => {
  let draftTools: unknown[] = [];
  apiAnswers = {
    'POST /api/agents/design': () => designs.shift()!(),
    'GET /api/agents/ag_q': () => ({ agent: { id: 'ag_q', name: 'Question answerer', tools: draftTools } }),
    'PUT /api/agents/ag_q': (init) => {
      draftTools = ((init.json as { tools?: unknown[] }).tools ?? []) as unknown[];
      return {};
    },
    'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok' } }),
  };
  return () => draftTools;
};
const adds = () => ({ config: { name: 'Question answerer', instructions: 'Query the Sales DB', tools: [tool] }, changes: ['Adds the Sales DB tool'], designed: true });
const removes = () => ({ config: { name: 'Question answerer', instructions: 'Answer from memory', tools: [] }, changes: ['Removes the tool query_sales'], designed: true });

beforeEach(() => {
  noteOpened(WF, 3);
  useEditor.setState({ active: true } as never);
  yes();
  agentSaid('North 4,150');
});

describe('the session’s own fixes stay', () => {
  it('a second round whose design removes the tool the session added is dropped with the kept line; the draft keeps the tool and no round is spent', async () => {
    const draft = routes([adds, removes]);
    runs = [{ ...ok }, { ...ok }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }, { text: 'No, the numbers are not from the database.', agentFix: remove }];
    await testUntilItRuns('Post the sales by region to the receiver');
    const kept = keptOwnFixLine({ summary: 'added “query_sales” to “Question answerer”' });
    expect(lines()).toContain(kept);
    expect(draft()).toEqual([tool]); // the draft still has the tool
    expect(apiCalls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(sentRequests).toHaveLength(2); // the dropped round asked for no third reply
    expect(outcomes()[0].text).toContain('would undo my own earlier fix');
    expect(published).not.toHaveBeenCalled(); // not "Ready for production": it did not pass the review
  });

  it('with the switch off, Asks first tracks an applied agent fix too: the second design posts keep and the removing design is dropped', async () => {
    useAutonomyFacts.setState({ switchOn: false });
    const draft = routes([adds, removes]);
    runs = [{ ...ok }, { ...ok }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }, { text: 'No, the numbers are not from the database.', agentFix: remove }];
    const session = testUntilItRuns('Post the sales by region to the receiver');
    await waitForCard();
    await applyAgentChange(cards()[0].itemId, cards()[0].card);
    await publishAgentChange(cards()[0].itemId, cards()[0].card);
    await session;
    const designs = apiCalls.filter((c) => c.path === '/api/agents/design');
    expect(designs).toHaveLength(2);
    expect((designs[0].json as { keep?: unknown }).keep).toBeUndefined();
    expect((designs[1].json as { keep?: { tools: string[] } }).keep?.tools).toEqual(['query_sales']);
    expect(lines()).toContain(keptOwnFixLine({ summary: 'added “query_sales” to “Question answerer”' }));
    expect(cards()).toHaveLength(1); // the removing design showed no second card
    expect(draft()).toEqual([tool]);
  });

  it('every design in the session posts keep with the tools it added, and none before it added any', async () => {
    routes([adds, removes]);
    runs = [{ ...ok }, { ...ok }];
    replies = [{ text: 'No.', agentFix: lack }, { text: 'No, still wrong.', agentFix: remove }];
    await testUntilItRuns('Post the sales by region to the receiver');
    const designs = apiCalls.filter((c) => c.path === '/api/agents/design');
    expect((designs[0].json as { keep?: unknown }).keep).toBeUndefined();
    expect((designs[1].json as { keep?: { tools: string[]; reason: string } }).keep).toEqual({ tools: ['query_sales'], reason: expect.stringContaining('this test-and-fix session') });
  });

  it('designChange posts keep only with tools', async () => {
    const { designChange } = await import('@/lib/client/agent-change');
    apiAnswers = { 'POST /api/agents/design': () => ({ config: {}, changes: [], designed: true }) };
    await designChange({ name: 'A', base: { agentId: 'x' }, change: 'c', keep: { tools: ['t'], reason: 'r' } });
    await designChange({ name: 'A', base: { agentId: 'x' }, change: 'c', keep: { tools: [], reason: 'r' } });
    expect((apiCalls[0].json as { keep?: unknown }).keep).toEqual({ tools: ['t'], reason: 'r' });
    expect((apiCalls[1].json as { keep?: unknown }).keep).toBeUndefined();
  });

  it('a flow proposal that sets the fixed field back is dropped before it is shown', async () => {
    runs = [{ Post: { error: 'HTTP 405' } }, { ...ok }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: [putMethod] }] }, { text: 'No, it still posts the wrong thing.', proposals: [{ summary: 'Use POST again', ops: [backToPost] }] }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(applied).toEqual([[putMethod]]); // the second proposal was never applied
    expect(lines().some((l) => l.startsWith('Kept: this session already fixed it'))).toBe(true);
    expect(useEditor.getState().nodes.find((n) => n.id === 'c')!.data.wf.parameters.method).toBe('PUT');
    const proposals = useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : [])) : []));
    expect(proposals.map((p) => p.state)).toEqual(['applied', 'dismissed']);
  });

  it('the same fix twice stops the session with what is left, never a loop', async () => {
    runs = [{ Post: { error: 'HTTP 405' } }, { 'Ask analyst': { error: 'the agent timed out' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: [putMethod] }] }, { proposals: [{ summary: 'Use PUT', ops: [putMethod] }] }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(applied).toHaveLength(1);
    expect(outcomes()[0].text).toContain('I already made that fix (Use PUT)');
    expect(outcomes()[0].text).toContain('Left:');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a reply with an agent fix and a flow proposal takes the agent fix; the flow proposal is dropped with a line, never a card to click', async () => {
    routes([adds]);
    runs = [{ ...ok }, { ...ok }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack, proposals: [{ summary: 'Use PUT', ops: [putMethod] }] }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(applied).toEqual([]);
    expect(lines()).toContain('Left for the next round: Use PUT.');
    const proposals = useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : [])) : []));
    expect(proposals.map((p) => p.state)).toEqual(['dismissed']);
    expect(cards()[0].card.state).toBe('created');
  });
});
