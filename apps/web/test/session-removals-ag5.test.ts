/**
 * Wave ag5 fix pass, the person's decision of 2026-11-18 (removals while fixing): an autonomous fix session removes or replaces a
 * step it added itself, and removes a step that duplicates what the bound agent does itself (`dropRepeatedAgentWork`'s rule),
 * without a click, naming each removal and why. A step the person built still waits, and Asks first waits for all three.
 * Driven like session-stable-ag5.test.ts: the real editor and assistant stores, the run and the reply scripted.
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
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-session-removals-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

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
          if (op.op === 'addNode') {
            const wf = useEditor.getState().toWorkflow();
            wf.nodes.push({ id: `n_${(op as { name?: string }).name}`, name: (op as { name?: string }).name ?? 'New', type: (op as { type: string }).type, typeVersion: 1, position: [0, 0], parameters: {} });
            useEditor.getState().load(wf, []);
          }
        }
      }
      const had = new Set(before.nodes.map((n) => n.id));
      options.onApplied?.({ undo: () => useEditor.getState().load(before, []), skipped: [], added: useEditor.getState().nodes.filter((n) => !had.has(n.id)).map((n) => n.id) });
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


const emailAgent = (asks: boolean) => ({ agent: { id: 'ag_q', name: 'Short writer', published: { version: 2, config: { name: 'Short writer', skills: [], tools: [{ id: 't1', type: 'node', nodeType: 'messaging.emailSend', name: 'send_email', parameters: { toEmail: 'ops@landflow.test' }, ...(asks && { requireApproval: true }) }] } } } });
const withSendEmail = () => {
  const wf = flow();
  wf.nodes.push(node('d', 'Send Email', 'messaging.emailSend', { toEmail: 'ops@landflow.test', subject: 's', text: 't' }));
  wf.connections.push({ id: 'e3', type: 'main', source: 'b', sourceIndex: 0, target: 'd', targetIndex: 0 });
  useEditor.getState().load(wf, []);
  useEditor.setState({ nodeTypes });
};
const proposals = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : [])) : []));
const addFallback: AssistantOp = { op: 'addNode', type: 'core.code', name: 'Fallback', after: 'Post' } as AssistantOp;
const removeFallback: AssistantOp = { op: 'removeNode', node: 'Fallback' };
const removePost: AssistantOp = { op: 'removeNode', node: 'Post' };
const removeEmail: AssistantOp = { op: 'removeNode', node: 'Send Email' };
const stillThere = (name: string) => useEditor.getState().nodes.some((n) => n.data.wf.name === name);
/** The session paused on a card that waits for a click: it is left there (the test dismisses it to end the session). */
const waiting = async (start: Promise<void>) => {
  await vi.waitFor(() => expect(proposals().some((p) => !p.state)).toBe(true));
  for (const p of proposals()) if (!p.state) decide(p.id, 'dismissed');
  await start;
};

describe('removals in an autonomous fix session', () => {
  it('a step the session added is removed again without a click, and the timeline names it and why', async () => {
    runs = [{ Post: { error: 'HTTP 500' } }, { Post: { error: 'connection refused by the receiver' } }, { ...ok }];
    replies = [{ proposals: [{ summary: 'Add a fallback', ops: [addFallback] }] }, { proposals: [{ summary: 'Drop the fallback', ops: [removeFallback] }] }];
    await testUntilItRuns('Send the sales figures on');
    expect(applied).toEqual([[addFallback], [removeFallback]]);
    expect(stillThere('Fallback')).toBe(false);
    expect(lines()).toContain('Removed “Fallback”: this session added it.');
    expect(proposals().map((p) => p.state)).toEqual(['applied', 'applied']);
  });

  it('a step that duplicates what the bound agent does itself is removed without a click', async () => {
    withSendEmail();
    apiAnswers = { 'GET /api/agents/ag_q': () => emailAgent(false) };
    runs = [{ 'Send Email': { error: 'SMTP down' } }, { ...ok }];
    replies = [{ proposals: [{ summary: 'Drop Send Email', ops: [removeEmail] }] }, { text: 'Yes.' }];
    await testUntilItRuns('Send the sales figures on');
    expect(applied).toEqual([[removeEmail]]);
    expect(stillThere('Send Email')).toBe(false);
    expect(lines()).toContain('Removed “Send Email”: “Short writer” does it itself.');
  });

  it('a step the person built still waits for a click, also when the agent has no such tool', async () => {
    runs = [{ Post: { error: 'HTTP 500' } }];
    replies = [{ proposals: [{ summary: 'Drop Post', ops: [removePost] }] }];
    await waiting(testUntilItRuns('Send the sales figures on'));
    expect(applied).toEqual([]);
    expect(stillThere('Post')).toBe(true);
    // A Send Email whose agent tool asks first is not "the agent does it itself": it waits too.
    withSendEmail();
    apiAnswers = { 'GET /api/agents/ag_q': () => emailAgent(true) };
    runs = [{ 'Send Email': { error: 'SMTP down' } }];
    replies = [{ proposals: [{ summary: 'Drop Send Email', ops: [removeEmail] }] }];
    await waiting(testUntilItRuns('Send the sales figures on'));
    expect(applied).toEqual([]);
    expect(stillThere('Send Email')).toBe(true);
  });

  it('a step the person adds while a card waits is theirs: its later removal waits for a click', async () => {
    runs = [{ Post: { error: 'HTTP 500' } }, { Post: { error: 'connection refused by the receiver' } }];
    replies = [{ proposals: [{ summary: 'Drop Post', ops: [removePost] }] }, { proposals: [{ summary: 'Drop Mine', ops: [{ op: 'removeNode', node: 'Mine' }] }] }];
    const start = testUntilItRuns('Send the sales figures on');
    await vi.waitFor(() => expect(proposals().some((p) => !p.state)).toBe(true));
    const wf = useEditor.getState().toWorkflow();
    wf.nodes.push(node('m', 'Mine', 'core.code'));
    useEditor.getState().load(wf, []); // the person adds a step while the card waits
    useEditor.setState({ nodeTypes });
    decide(proposals().find((p) => !p.state)!.id, 'applied');
    await vi.waitFor(() => expect(proposals().filter((p) => !p.state)).toHaveLength(1));
    expect(applied).toEqual([]); // the removal of the person's step waits
    expect(stillThere('Mine')).toBe(true);
    for (const p of proposals()) if (!p.state) decide(p.id, 'dismissed');
    await start;
  });

  it('Asks first waits for all three: the session’s own step, the duplicate and the person’s step', async () => {
    useAutonomyFacts.setState({ switchOn: false });
    // the session's own step: applied by the person's click, then its removal waits for another
    runs = [{ Post: { error: 'HTTP 500' } }, { Post: { error: 'connection refused by the receiver' } }];
    replies = [{ proposals: [{ summary: 'Add a fallback', ops: [addFallback] }] }, { proposals: [{ summary: 'Drop the fallback', ops: [removeFallback] }] }];
    const first = testUntilItRuns('Send the sales figures on', { autonomy: 'asks-first' });
    await vi.waitFor(() => expect(proposals().some((p) => !p.state)).toBe(true));
    decide(proposals().find((p) => !p.state)!.id, 'applied');
    await first; // the removal of what the session added is not offered or applied on its own here: it is dropped, as before
    expect(applied).toEqual([]); // nothing was applied by the session itself
    expect(lines().some((l) => l.startsWith('Removed '))).toBe(false);
    // the duplicate and the person's step
    for (const [ops, name] of [[removeEmail, 'Send Email'], [removePost, 'Post']] as const) {
      withSendEmail();
      apiAnswers = { 'GET /api/agents/ag_q': () => emailAgent(false) };
      runs = [{ [name]: { error: 'down' } }];
      replies = [{ proposals: [{ summary: `Drop ${name}`, ops: [ops] }] }];
      useAssistant.getState().reset();
      useAssistant.setState({ send: send as never });
      approveDestinations(WF, ['messaging.emailSend']);
      const sess = testUntilItRuns('Send the sales figures on', { autonomy: 'asks-first' });
      await waiting(sess);
      expect(stillThere(name), name).toBe(true);
    }
    expect(applied).toEqual([]);
  });
});
