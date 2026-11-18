/**
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
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-session-fix-ag4-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

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
let apiAnswers: Record<string, () => unknown> = {};
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string, init: { method?: string; json?: unknown } = {}) => {
    apiCalls.push({ path, method: init.method ?? 'GET', ...(init.json !== undefined && { json: init.json }) });
    const answer = apiAnswers[`${init.method ?? 'GET'} ${path}`];
    if (!answer) return {};
    return answer();
  }),
}));
const published = vi.fn(async () => ({ published: { versionNumber: 3 } }));
vi.mock('@/components/editor/publish-control', () => ({ publishVersion: published, toastApprovalRequested: vi.fn() }));

({ useEditor } = await import('@/components/editor/store'));
const { useAssistant, undos } = await import('@/components/editor/assistant');
const { testUntilItRuns, approveDestinations, sendsAllowed } = await import('@/components/editor/test-session');
const { applyAgentChange, publishAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { ApiError } = await import('@/lib/client/api');
const { showSmoke } = await import('@/components/editor/spotlight/agent-credential-picker');
const { fixLine } = await import('@/lib/shared/agent-card');
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
let sentRequests: string[] = [];
let sentAutonomy: Array<string | undefined> = [];

/** The next scripted reply of the assistant: text and proposals. */
let replies: Array<{ text?: string; proposals?: Array<{ summary: string; ops: AssistantOp[] }>; agentFix?: unknown }> = [];

beforeEach(() => {
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
  useAutonomyFacts.setState({ switchOn: false, workflows: {} });
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

describe('the fix reads the run it fixes', () => {
  it('sends the execution id, applies one focused change after the person’s Apply, runs again and passes; the URL stays the person’s', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 400' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: '“Notify VIP” sent no report_text.', proposals: [{ summary: 'Send the body as report_text', ops: [fixBody] }] }];
    const session = testUntilItRuns();
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    expect(run).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]); // asks first: nothing applied before the person's Apply
    decide('r1p0', 'applied');
    await session;
    expect(sentRequests[0]).toContain('(execution ex_1)');
    expect(sentSessions).toEqual(['fix']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(useEditor.getState().nodes.find((n) => n.id === 'b')!.data.wf.parameters.url).toBe('http://127.0.0.1:3399/vip');
    expect(actions()).toEqual(['publish']);
    expect(outcomes()).toEqual([]);
  });
});

describe('wave ag4 carryover: an Apply that lands before the reply ends', () => {
  it('takes the fix the person already applied and runs again, never “I found no fix”', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 400' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    // The card is on screen while the model still works: the person clicks Apply, then the reply ends.
    send.mockImplementationOnce(async (_request: string, options: { session?: string; testId?: string }) => {
      sentSessions.push(options.session);
      useAssistant.getState().append([{ id: 'r1', role: 'assistant', testId: options.testId, done: { model: 'test', durationMs: 1, steps: 1 }, parts: [{ kind: 'text' as const, text: '“Notify VIP” sent no report_text.' }, { kind: 'proposal' as const, proposal: { id: 'r1p0', summary: 'Send the body as report_text', ops: [fixBody], dropped: [], warnings: [] } }] }]);
      decide('r1p0', 'applied');
    });
    await testUntilItRuns();
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual([]);
    expect(actions()).toEqual(['publish']);
  });
});

// AG22: this block asserted sb1's D1 for a fix session ("a saved workflow is never auto-applied, with the switch on"). The person's
// decision of 2026-11-18 replaced it: with the switch on a fix session applies its own fixes on a saved workflow too. It is now two
// tests: the new rule with the switch on, and the old wait kept as its twin with the switch off (Asks first unchanged).
describe('re-check 3 (item 10), as the decision of 2026-11-18 changed it', () => {
  const wrongOutput = 'The numbers in the report look made up. Test it and fix it.';
  const script = () => {
    runs = [{ 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'No, the numbers look invented.', proposals: [{ summary: 'Fix body', ops: [fixBody] }] }, { text: 'Yes, it does what you asked.' }];
  };

  it('switch on: a wrong-output session on a workflow opened with nodes applies its own fix, with no click, and runs again', async () => {
    noteOpened(WF, 3); // opened with nodes: saved
    useAutonomyFacts.setState({ switchOn: true });
    yes();
    script();
    await testUntilItRuns(wrongOutput);
    expect(sentAutonomy).toEqual(['auto', 'auto']);
    expect(autonomyOf(WF)).toBe('asks-first'); // builds and typed changes keep sb1's D1
    expect(applied).toEqual([[fixBody]]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('switch off (Asks first): the fix is a card that waits, nothing is applied by itself', async () => {
    noteOpened(WF, 3); // opened with nodes: saved
    yes();
    runs = [{ 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'No, the numbers look invented.', proposals: [{ summary: 'Fix body', ops: [fixBody] }] }];
    const session = testUntilItRuns(wrongOutput);
    await vi.waitFor(() => expect(sentSessions).toEqual(['review']));
    expect(useAutonomyFacts.getState().switchOn).toBe(false);
    expect(sentAutonomy).toEqual(['asks-first']);
    await new Promise((r) => setTimeout(r, 30));
    expect(applied).toEqual([]);
    decide('r1p0', 'dismissed');
    await session;
  });
});

describe('runs that write outside ask first', () => {
  it('asks before the run, and not again after the yes', async () => {
    noteOpened(WF, 3);
    runs = [{ 'Notify VIP': { error: 'HTTP 400' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'Fixing.', proposals: [{ summary: 'Send the body as report_text', ops: [fixBody] }] }];
    await testUntilItRuns();
    expect(run).not.toHaveBeenCalled();
    expect(needs().map((n) => n.what)).toEqual(['sends']);
    expect(needs()[0].destinations).toEqual(['http://127.0.0.1:3399']);
    yes();
    const session = testUntilItRuns(undefined, { resume: true });
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    decide('r1p0', 'applied');
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(needs().filter((n) => !n.state).map((n) => n.what)).toEqual(['sends']); // the one row from before; the re-run asked nothing more
    expect(needs()).toHaveLength(1);
  });

  it('in autonomous mode on a brand-new draft it still asks for a destination nobody allowed', async () => {
    noteOpened('wf_orders_new', 0);
    useEditor.getState().load({ ...flow(), id: 'wf_orders_new' }, []);
    useEditor.setState({ nodeTypes });
    await testUntilItRuns();
    expect(run).not.toHaveBeenCalled();
    expect(needs().map((n) => n.what)).toEqual(['sends']);
  });
});

describe('a failure inside an agent', () => {
  const agentFix = { type: 'agent-fix', agentId: 'ag_mail', agent: 'Mailer', change: 'Always send to oncall@landflow.test', fix: { executionId: 'ex_1', step: 'Notify VIP', tool: 'send_email', cause: 'send_email got an empty To', attempt: 1 } };
  const design = () => ({ config: { name: 'Mailer', instructions: 'Always send to oncall@landflow.test', tools: [] }, changes: ['Changes the instructions'], designed: true });

  it('shows the change card with its fix line, applies nothing by itself, then Apply, Publish through the gate, and runs again', async () => {
    noteOpened(WF, 3);
    yes();
    apiAnswers = { 'POST /api/agents/design': design, 'POST /api/agents/ag_mail/smoke-test': () => ({ smoke: { state: 'passed', reply: 'sent' } }) };
    runs = [{ 'Notify VIP': { error: 'send_email failed' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'It failed inside the agent.', agentFix }];
    const session = testUntilItRuns();
    await waitForCard();
    const [{ itemId, card, text }] = cards();
    expect(card.state).toBe('designed');
    expect(card.base).toEqual({ agentId: 'ag_mail', name: 'Mailer' });
    expect(card.fix).toEqual({ ...agentFix.fix, attempt: 1 });
    expect(text).toEqual({ kind: 'text', text: fixLine('Mailer', card.fix!) });
    expect(apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/agents/ag_mail', 'POST /api/agents/design']);
    expect(apiCalls[1].json).toMatchObject({ base: { agentId: 'ag_mail' }, change: 'Always send to oncall@landflow.test', preview: true });
    expect(applied).toEqual([]); // no flow change with an agent fix
    expect(run).toHaveBeenCalledTimes(1);
    await applyAgentChange(itemId, card);
    expect(apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/agents/ag_mail', 'POST /api/agents/design', 'PUT /api/agents/ag_mail', 'POST /api/agents/ag_mail/smoke-test']);
    expect(run).toHaveBeenCalledTimes(1); // not published yet: no run
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    const publish = apiCalls.find((c) => c.path === '/api/agents/ag_mail/publish')!;
    expect(publish.method).toBe('POST');
    expect(JSON.stringify(publish.json ?? {})).not.toContain('skipEval');
    expect(run).toHaveBeenCalledTimes(2);
    expect(actions()).toEqual(['publish']);
  });

  it('re-check 3: an applied fix whose test stops for a credential waits for the pick on the card, then Publish and the run, with no stop row', async () => {
    noteOpened(WF, 3);
    yes();
    let smokes = 0;
    apiAnswers = {
      'POST /api/agents/design': design,
      'POST /api/agents/ag_mail/smoke-test': () => (smokes++ === 0 ? { smoke: { state: 'untested', reason: 'needs a credential: SQLite' } } : { smoke: { state: 'passed', reply: 'sent' } }),
    };
    runs = [{ 'Notify VIP': { error: 'send_email failed' } }, { 'Notify VIP': { items: 1 }, 'Notify Standard': { items: 1 } }];
    replies = [{ text: 'It failed inside the agent.', agentFix }];
    const session = testUntilItRuns();
    await waitForCard();
    const [{ itemId, card }] = cards();
    await applyAgentChange(itemId, card);
    await new Promise((r) => setTimeout(r, 30));
    // It waits: no stop row, no second run, and the card says a credential is left.
    expect(outcomes()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cards()[0].card.smoke).toMatchObject({ state: 'untested', reason: 'needs a credential: SQLite' });
    // The person picks it in place: the picker's smoke result lands on the card.
    showSmoke('ag_mail', { state: 'passed', reply: 'sent' });
    await vi.waitFor(() => expect(cards()[0].card.smoke?.state).toBe('passed'));
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual([]);
    expect(actions()).toEqual(['publish']);
  });

  it('a held gate stops the session and says why', async () => {
    noteOpened(WF, 3);
    yes();
    apiAnswers = {
      'POST /api/agents/design': design,
      'POST /api/agents/ag_mail/smoke-test': () => ({ smoke: { state: 'passed' } }),
      'POST /api/agents/ag_mail/publish': () => {
        throw new ApiError('held', 409, { gate: { verdict: { average: 0.4, reason: 'two cases scored under the bar' } } });
      },
    };
    runs = [{ 'Notify VIP': { error: 'send_email failed' } }];
    replies = [{ agentFix }];
    const session = testUntilItRuns();
    await waitForCard();
    const [{ itemId, card }] = cards();
    await applyAgentChange(itemId, card);
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcomes()[0].text).toContain('held by its eval gate: two cases scored under the bar');
    expect(outcomes()[0].text).toContain('Left:');
  });
});

describe('a run that passed, with an agent that lacks a tool (AG20, live pass S3)', () => {
  const AGENT_FLOW = 'wf_sales_question';
  const askFlow = (): Workflow => ({
    id: AGENT_FLOW,
    name: 'Sales question',
    nodes: [node('a', 'Start', 'core.manualTrigger'), node('b', 'Ask sales analyst', 'core.messageAgent', { agentId: 'ag_q', message: 'Sales by region?' })],
    connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
  });
  const agentSaid = (reply: string) =>
    useEditor.setState({ runs: { b: [{ source: 'main', status: 'success', durationMs: 5, inputs: [[{ json: { q: 'x' } }]], outputs: [[{ json: { reply } }]] }] } as never });
  const lacks = { type: 'agent-fix', agentId: 'ag_q', agent: 'Question answerer', change: 'Add the Sales DB query tool and tell it to use it', fix: { executionId: 'ex_1', step: 'Ask sales analyst', cause: 'the agent has no database tool', attempt: 1 } };
  const design = () => ({ config: { name: 'Question answerer', instructions: 'Query the Sales DB', tools: [] }, changes: ['Adds the Sales DB tool'], designed: true });
  const openAgentFlow = () => {
    noteOpened(AGENT_FLOW, 3);
    useEditor.getState().load(askFlow(), []);
    useEditor.setState({ nodeTypes });
  };

  it('the review request carries the execution id and says to read get_run_log; the agent change card, not a flow change, goes through Apply and Publish, and the run goes again', async () => {
    openAgentFlow();
    apiAnswers = { 'POST /api/agents/design': design, 'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok' } }) };
    runs = [{ 'Ask sales analyst': { items: 1 } }, { 'Ask sales analyst': { items: 1 } }];
    replies = [{ text: 'No, the agent has no database tool.', agentFix: lacks }];
    const session = testUntilItRuns('sales by region');
    await waitForCard();
    expect(sentSessions).toEqual(['review']);
    expect(sentRequests[0]).toContain('(execution ex_1)');
    expect(sentRequests[0]).toContain('get_run_log');
    expect(sentRequests[0]).toContain('propose_agent_fix');
    const [{ itemId, card }] = cards();
    expect(card.base).toEqual({ agentId: 'ag_q', name: 'Question answerer' });
    expect(card.fix).toMatchObject({ step: 'Ask sales analyst', cause: 'the agent has no database tool' });
    expect(applied).toEqual([]); // no flow change with an agent fix
    expect(run).toHaveBeenCalledTimes(1);
    await applyAgentChange(itemId, card);
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcomes()).toEqual([]);
    expect(actions()).toEqual(['publish']);
  });

  it('re-check 3: a review that says no and names no change asks once more with the log rule and reaches the agent fix card in the same round', async () => {
    openAgentFlow();
    apiAnswers = { 'POST /api/agents/design': design, 'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok' } }) };
    runs = [{ 'Ask sales analyst': { items: 1 } }, { 'Ask sales analyst': { items: 1 } }];
    replies = [{ text: 'No, the report does not show any real sales figures.' }, { text: 'It invents them: no tool.', agentFix: lacks }];
    const session = testUntilItRuns('sales by region');
    await waitForCard();
    expect(sentSessions).toEqual(['review', 'fix']);
    expect(sentRequests[1]).toContain('get_run_log');
    expect(sentRequests[1]).toContain('propose_agent_fix');
    expect(sentRequests[1]).toContain('inventing them');
    const [{ itemId, card }] = cards();
    await applyAgentChange(itemId, card);
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    expect(outcomes()).toEqual([]);
  });

  it('a pass whose agent put out raw tool-call markup counts as a failed output: a fix session, not a pass', async () => {
    openAgentFlow();
    apiAnswers = { 'POST /api/agents/design': design, 'POST /api/agents/ag_q/smoke-test': () => ({ smoke: { state: 'passed' } }) };
    runs = [{ 'Ask sales analyst': { items: 1 } }, { 'Ask sales analyst': { items: 1 } }];
    const answer = (n: number, reply: string) => () => {
      useEditor.setState({ running: true, executionId: `ex_${n}` });
      setTimeout(() => {
        agentSaid(reply);
        useEditor.setState({ running: false, statuses: { b: { state: 'success', itemCounts: [1] } } as never, runStatus: 'success' });
      }, 0);
    };
    run.mockImplementationOnce(answer(1, '<invoke name="executeQuery"><parameter name="sql">select region, sum(amount) from sales group by region</parameter></invoke>')).mockImplementationOnce(answer(2, 'North 4,150'));
    replies = [{ text: 'The agent has no database tool.', agentFix: lacks }];
    const session = testUntilItRuns();
    await waitForCard();
    expect(sentSessions).toEqual(['fix']);
    expect(sentRequests[0]).toContain('raw tool-call markup');
    expect(sentRequests[0]).toContain('(execution ex_1)');
    const [{ itemId, card }] = cards();
    await applyAgentChange(itemId, card);
    await publishAgentChange(itemId, cards()[0].card);
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(actions()).toEqual(['publish']);
  });

  it('what is left names the tool or credential and the agent: connect “Sales DB” to “Question answerer”', async () => {
    openAgentFlow();
    const { useBubbleData } = await import('@/lib/client/agent-bubble-data');
    useBubbleData.setState({ answers: { 'ag_q|wf_x|n_ask|': { agent: { id: 'ag_q', name: 'Question answerer', published: true, draftDiffers: false }, connections: [] } as never } });
    runs = [{ 'Ask sales analyst': { items: 1 } }];
    replies = [{ text: 'No, the agent can’t query “Sales DB”: it has no access.' }];
    await testUntilItRuns('sales by region');
    expect(outcomes()[0].text).toContain('Left: connect “Sales DB” to “Question answerer”');
    useBubbleData.setState({ answers: {} });
  });

  it('a phrase that is only a complaint is not a name: “lacks a tool” and “has no tool for that” read “the tool it needs”', async () => {
    for (const text of ['No, the agent lacks a tool to send email.', 'No, it has no tool for that.']) {
      openAgentFlow();
      runs = [{ 'Ask sales analyst': { items: 1 } }];
      replies = [{ text }];
      await testUntilItRuns('sales by region');
      const left = outcomes().at(-1)!.text;
      expect(left).toContain('Left: connect the tool it needs to “');
      expect(left).not.toMatch(/connect “(?:lacks|has|no|a|any)/i);
    }
  });

  it('a pass with nothing to propose stops and names what is left, not “tell me what to change” alone', async () => {
    openAgentFlow();
    runs = [{ 'Ask sales analyst': { items: 1 } }];
    replies = [{ text: 'No, the agent says the database query tool isn’t available.' }];
    await testUntilItRuns('sales by region');
    expect(outcomes()[0].text).toContain('I have no change for it.');
    expect(outcomes()[0].text).toContain('Left: connect “database query tool” to “Ask sales analyst”');
  });
});

describe('the bound', () => {
  it('stops after the same failure twice in a row, undoes the flow change that did not help and says what is left', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 400' } }, { 'Notify VIP': { error: 'HTTP 400' } }];
    replies = [{ text: 'Try the body.', proposals: [{ summary: 'Send the body as report_text', ops: [fixBody] }] }];
    const session = testUntilItRuns();
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    decide('r1p0', 'applied');
    await session;
    expect(run).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcomes()[0].text).toMatch(/^Still failing at “Notify VIP”: HTTP 400\. The last fix didn’t change the error, so I undid it\. Left: open “Notify VIP”/);
  });

  it('keeps what the last fix changed across a pause, so the same failure after a resume still undoes it', async () => {
    noteOpened(WF, 3);
    yes();
    runs = [{ 'Notify VIP': { error: 'HTTP 400' } }, { 'Notify VIP': { error: 'No Slack credential selected' } }, { 'Notify VIP': { error: 'HTTP 400' } }];
    replies = [{ text: 'Try the body.', proposals: [{ summary: 'Send the body as report_text', ops: [fixBody] }] }];
    const first = testUntilItRuns();
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal'))).toBe(true));
    decide('r1p0', 'applied');
    await first;
    expect(needs().some((n) => !n.state)).toBe(true); // paused on a Needs-you row
    await testUntilItRuns(undefined, { resume: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(outcomes()[0].text).toMatch(/The last fix didn’t change the error, so I undid it\./);
  });

  it('stops after MAX_FIXES fixes as before', async () => {
    noteOpened(WF, 3);
    yes();
    const errors = ['HTTP 400 a', 'HTTP 500 b', 'HTTP 404 c', 'HTTP 418 d', 'HTTP 409 e'].map((error) => ({ 'Notify VIP': { error: error.replace(/ [a-e]$/, '') + ' ' + error.slice(-1).repeat(4) } }));
    runs = errors;
    const apply = async () => {
      for (let i = 1; i <= 4; i++) {
        await vi.waitFor(() => expect(useAssistant.getState().items.some((it) => it.role === 'assistant' && it.parts.some((p) => p.kind === 'proposal' && p.proposal.id === `r${i}p0`))).toBe(true), { timeout: 3000 });
        decide(`r${i}p0`, 'applied');
      }
    };
    replies = [1, 2, 3, 4].map((n) => ({ text: `Try ${n}.`, proposals: [{ summary: `fix ${n}`, ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { body: { n } } } as AssistantOp] }] }));
    const session = testUntilItRuns();
    await apply();
    await session;
    expect(run).toHaveBeenCalledTimes(5);
    expect(outcomes()[0].text).toContain('after 4 fixes');
  });
});
