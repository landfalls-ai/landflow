/**
 * AG22 (wave ag5): an autonomous fix session ... (the harness is session-fix-ag4's).
 * AG20: Spotlight runs the flow, reads the run's log, makes one focused fix to the flow or the agent, runs again and stops
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
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-session-auto-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

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
const { agentFixAwaitsApply, titleOf } = await import('@/components/editor/timeline');


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
  // fix session's autonomy, so they run with the switch on, so the sessions are autonomous (the switch-off twin is in session-stable-ag5.test.ts).
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
const calls = () => apiCalls.map((c) => `${c.method} ${c.path}`);
const lack = { type: 'agent-fix', agentId: 'ag_q', agent: 'Question answerer', change: 'Add the Sales DB query tool and tell it to use it', fix: { executionId: 'ex_1', step: 'Ask analyst', cause: 'the agent has no database tool', attempt: 1 } };
const tool = { id: 't1', type: 'node', nodeType: 'sales.query', name: 'query_sales', parameters: {} };
const design = () => ({ config: { name: 'Question answerer', instructions: 'Query the Sales DB', tools: [tool] }, changes: ['Adds the Sales DB tool'], designed: true });
const agentSaid = (reply: string) => useEditor.setState({ runs: { b: [{ source: 'main', status: 'success', durationMs: 5, inputs: [[{ json: { q: 'x' } }]], outputs: [[{ json: { reply } }]] }] } as never });

/** The agent routes of a flow whose agent has no tool yet: the draft keeps what the last PUT saved. */
const agentRoutes = (extra: Record<string, (init: { json?: unknown }) => unknown> = {}) => {
  let draftTools: unknown[] = [];
  let smokes = 0;
  apiAnswers = {
    'POST /api/agents/design': design,
    'GET /api/agents/ag_q': () => ({ agent: { id: 'ag_q', name: 'Question answerer', tools: draftTools } }),
    'PUT /api/agents/ag_q': (init) => {
      draftTools = ((init.json as { tools?: unknown[] }).tools ?? []) as unknown[];
      return {};
    },
    'POST /api/agents/ag_q/smoke-test': () => (smokes++ === 0 ? { smoke: { state: 'untested', reason: 'needs a credential: Sales DB' } } : { smoke: { state: 'passed', reply: 'ok' } }),
    'GET /api/credentials?agentId=ag_q': () => ({ credentials: [{ id: 'c1', name: 'Sales DB', type: 'sales.salesDb' }] }),
    'GET /api/workflows/wf_sales/versions/ver3/pins': () => ({ pins: [{ nodeId: 'b', nodeName: 'Ask analyst', agentId: 'ag_q', agentName: 'Question answerer', version: 5 }] }),
    ...extra,
  };
};
const everyBody = () => JSON.stringify([...apiCalls.map((c) => c.json ?? null), ...published.mock.calls]);

describe('an autonomous fix session on a saved, published flow (switch on)', () => {
  const open = () => {
    noteOpened(WF, 3); // opened with nodes: saved
    useEditor.setState({ active: true } as never); // and published
    yes();
    agentSaid('North 4,150');
  };

  it('applies the agent fix itself, picks the one fitting credential, sends approvals with the run, reads the agent’s reply, publishes the agent then the workflow', async () => {
    open();
    agentRoutes();
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }, { 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns('Post the sales by region to the receiver');
    // the first review request holds the agent step's reply (not only the receiver's { ok })
    expect(sentRequests[0]).toContain('The agent step “Ask analyst” replied');
    expect(sentRequests[0]).toContain('North 4,150');
    expect(sentAutonomy).toEqual(['auto', 'auto']);
    // the agent fix applied with no click: PUT, the smoke test, the pick (a second PUT), the second smoke test, the publish
    expect(calls()).toEqual([
      'GET /api/agents/ag_q',
      'POST /api/agents/design',
      'PUT /api/agents/ag_q',
      'POST /api/agents/ag_q/smoke-test',
      'GET /api/agents/ag_q',
      'GET /api/credentials?agentId=ag_q',
      'GET /api/agents/ag_q',
      'PUT /api/agents/ag_q',
      'POST /api/agents/ag_q/smoke-test',
      'POST /api/agents/ag_q/publish',
      'GET /api/workflows/wf_sales/versions/ver3/pins',
      'GET /api/workflows/wf_sales/unattended-approvals',
    ]);
    expect(cards()[0].card.state).toBe('created');
    expect(lines()).toContain('Picked “Sales DB” for “query_sales”: the only credential you have that fits.');
    // the agent was published before the workflow; the workflow publish names no `agents` choice
    expect(apiCalls.findIndex((c) => c.path === '/api/agents/ag_q/publish')).toBeGreaterThan(-1);
    expect(published).toHaveBeenCalledWith(WF);
    expect(published.mock.calls[0]).toHaveLength(1);
    expect(lines().at(-1)).toBe('Published: workflow v3 · Question answerer v5. Production runs it from its next trigger.');
    // the run carried Spotlight's approvals with the given destinations
    expect(run.mock.calls[0][0]).toMatchObject({ kind: 'run', by: 'spotlight', approvals: { approvals: 'spotlight', destinations: ['http://127.0.0.1:3399'] } });
    expect(run.mock.calls[0][0].approvals.sessionId).toEqual(expect.any(String));
    expect(everyBody()).not.toMatch(/skipEval|as-published|publish-first/);
    expect(needs()).toEqual([]);
  });

  it('a design that changes nothing publishes nothing: no PUT, no smoke test, no agent publish, and the session says so', async () => {
    open();
    agentRoutes({ 'POST /api/agents/design': () => ({ config: { name: 'Question answerer', instructions: 'Same', tools: [] }, changes: [], designed: true }) });
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(calls()).not.toContain('PUT /api/agents/ag_q');
    expect(calls()).not.toContain('POST /api/agents/ag_q/publish');
    expect(calls().some((c) => c.endsWith('/smoke-test'))).toBe(false);
    expect(cards()).toEqual([]);
    expect(outcomes()[0].text).toContain('changes nothing, so I changed and published nothing');
    expect(published).not.toHaveBeenCalled();
  });

  it('the run carries at most the run schema’s limits: 50 destinations of at most 2000 characters', async () => {
    open();
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'Yes.' }];
    const mails = Array.from({ length: 70 }, (_v, i) => `person${i}@landflow.test`).join(', ');
    await testUntilItRuns(`Email the figures to ${mails} and post to https://example.test/${'a'.repeat(2100)}`);
    const sent = run.mock.calls[0][0].approvals.destinations as string[];
    expect(sent.length).toBeLessThanOrEqual(50);
    expect(sent.every((d) => d.length <= 2000)).toBe(true);
  });

  it('with the switch off every step waits and the run carries no approvals; the header asks to apply the fix', async () => {
    open();
    useAutonomyFacts.setState({ switchOn: false });
    agentRoutes();
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }];
    const session = testUntilItRuns('Post the sales by region to the receiver');
    await waitForCard();
    expect(sentAutonomy).toEqual(['asks-first']);
    expect(cards()[0].card.state).toBe('designed');
    expect(calls()).toEqual(['GET /api/agents/ag_q', 'POST /api/agents/design']);
    expect(run.mock.calls[0][0]).toEqual({ kind: 'run', by: 'spotlight' });
    const items = useAssistant.getState().items;
    const testingId = useAssistant.getState().testingId;
    expect(agentFixAwaitsApply(items, testingId)).toBe(true);
    expect(titleOf({ drafting: false, testing: true, pending: false, hasItems: true, waitingForApply: true, waitingForAgent: true, agentAwaitsApply: true })).toBe('Needs you: apply the fix?');
    useAssistant.getState().testing?.abort();
    await session;
    expect(published).not.toHaveBeenCalled();
  });

  it('several fitting credentials: the session waits on Pick it, then goes on', async () => {
    open();
    agentRoutes({ 'GET /api/credentials?agentId=ag_q': () => ({ credentials: [{ id: 'c1', name: 'Sales DB', type: 'sales.salesDb' }, { id: 'c2', name: 'Sales DB 2', type: 'sales.salesDb' }] }) });
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }, { 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }, { text: 'Yes, it does what you asked.' }];
    const session = testUntilItRuns('Post the sales by region to the receiver');
    await vi.waitFor(() => expect(cards()[0]?.card.smoke?.state).toBe('untested'));
    await new Promise((r) => setTimeout(r, 40));
    expect(lines().some((l) => l.startsWith('Picked'))).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls()).not.toContain('POST /api/agents/ag_q/publish');
    showSmoke('ag_q', { state: 'passed', reply: 'ok' }); // the person picked it on the card
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls()).toContain('POST /api/agents/ag_q/publish');
  });

  it('a held gate is a finding: it says the score, makes one more agent fix from the lowest cases and publishes again; never skipEval', async () => {
    open();
    let publishes = 0;
    agentRoutes({
      'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok' } }),
      'POST /api/agents/ag_q/publish': () => {
        if (publishes++ === 0) throw new ApiError('held', 409, { gate: { verdict: { average: 2.7, basis: 'threshold', shared: 0, reason: '2.7 / 5, below the 3.0 it asks for' }, lowCases: [{ input: 'Sales by region?', score: 2, reasoning: 'it did not name the regions' }] } });
        return {};
      },
    });
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }, { 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(lines()).toContain('“Question answerer”: Held by the eval gate: 2.7 / 5 (judged on its own cases against 3.0). 2.7 / 5, below the 3.0 it asks for');
    const designs = apiCalls.filter((c) => c.path === '/api/agents/design');
    expect(designs).toHaveLength(2);
    expect(JSON.stringify(designs[1].json)).toContain('Sales by region?');
    expect(JSON.stringify(designs[1].json)).toContain('it did not name the regions');
    expect(apiCalls.filter((c) => c.path === '/api/agents/ag_q/publish')).toHaveLength(2);
    expect(lines().at(-1)).toMatch(/^Published: workflow v3/);
    expect(everyBody()).not.toMatch(/skipEval|as-published/);
  });

  it('out of fixes after a held gate: it stops with the verdict and the score', async () => {
    open();
    agentRoutes({
      'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok' } }),
      'POST /api/agents/ag_q/publish': () => {
        throw new ApiError('held', 409, { gate: { verdict: { average: 2.7, basis: 'threshold', reason: '2.7 / 5, below the 3.0 it asks for' } } });
      },
    });
    runs = [{ 'Ask analyst': { items: 1 }, Post: { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lack }];
    await testUntilItRuns('Post the sales by region to the receiver');
    expect(outcomes()[0].text).toContain('“Question answerer”: Held by the eval gate: 2.7 / 5');
    expect(outcomes()[0].text).toContain('out of fixes');
    expect(published).not.toHaveBeenCalled();
    expect(everyBody()).not.toMatch(/skipEval|as-published/);
  });

  it('a destination nobody gave still asks, also with the switch on', async () => {
    noteOpened(WF, 3);
    useEditor.setState({ active: true } as never);
    useEditor.getState().updateNode('c', { parameters: { method: 'POST', url: 'http://127.0.0.1:3400/other' } });
    // the flow's own destination is given at the start; one a fix brings in is not
    runs = [{ Post: { error: 'HTTP 500' } }];
    replies = [{ text: 'Wrong port.', proposals: [{ summary: 'Set the url', ops: [{ op: 'setParameters', node: 'Post', parameters: { url: 'http://evil.example/x' } }] }] }];
    await testUntilItRuns('Post the sales to the receiver');
    expect(run).toHaveBeenCalledTimes(1);
    expect(needs().map((n) => n.what)).toEqual(['destination']);
    expect(needs()[0].destinations).toEqual(['http://evil.example']);
  });
});
