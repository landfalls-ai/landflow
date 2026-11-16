/**
 * Wave sb1's join tests (carryover-sb1.md §2): each contract between two packages of the wave, with both real sides
 * and no fake between them. Only the edges are stubbed: the model (a fake Ollama or a scripted LanguageModel), the
 * editor's test run, the browser's HTTP client and the publish call.
 *
 * 1. sb1-autonomy-join (SB03 × SB04): autonomous.ts, test-session.ts, spotlight-autonomy.ts and the reply's rule
 *    (holdsForClick, which reply.tsx reads) decide together when a fix waits for the person.
 * 2. The draft (SB01 × SB02): the build route's send-back and SB02's guards, merged into one `left` with mergeLeft.
 * 3. A chat fix's destination (SB02 × SB03): the made-up values strip and the given-values check in one reply.
 * 4. A question and a session (SB03 × SB04): a session's fix is never a question; a typed question sends no session.
 * 5. A new agent on a local model (SB05 × SB06): the design route's hints reach the flat tool's first request.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { GenerateInput } from '@/lib/server/nodes/models';
import type { AssistantOp } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeModels, type FakeReply } from './fake-ai-services';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
// The browser's HTTP client: a workflow opened empty reads its versions once (none published here); feedback is dropped.
vi.mock('@/lib/client/api', () => ({ api: vi.fn(async () => ({ versions: [] })), streamEvents: vi.fn() }));
const published = vi.hoisted(() => vi.fn(async () => ({ published: { versionNumber: 1 } })));
vi.mock('@/components/editor/publish-control', () => ({ publishVersion: published, toastApprovalRequested: vi.fn() }));

/** The fake Ollama's /api/chat answers, in order; every other path (tags, show) takes none. */
const queue: FakeReply[] = [];
const fake = await startFakeModels({ reply: (provider) => (provider === 'ollama' ? (queue.shift() ?? { text: 'Done.' }) : {}) });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-sb1-joins-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { defineNode, definePlugin } = await import('@landflow/sdk');
registry.registerBuiltin(corePlugin);
// Two app steps no plugin of this host ships under these ids: a chat post that needs a credential, and an issue reader.
registry.registerBuiltin(
  definePlugin({
    info: { id: 'sb1chat', name: 'Chat (test)', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { name: 'post', displayName: 'Chat post', description: 'Post a message to a chat channel', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], credentials: [{ name: 'sb1ChatApi', required: true }], properties: [{ name: 'channel', displayName: 'Channel', type: 'string', default: '' }, { name: 'text', displayName: 'Text', type: 'string', default: '' }] },
        async execute() {
          return [[]];
        },
      }),
    ],
    credentialTypes: [{ name: 'sb1ChatApi', displayName: 'Chat API (test)', properties: [{ name: 'token', displayName: 'Token', type: 'string', default: '' }] }],
  }),
);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'linear', name: 'Linear', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: { name: 'issues', displayName: 'Linear issues', description: 'Read Linear issues', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [{ name: 'operation', displayName: 'Operation', type: 'options', default: 'getAll', options: [{ name: 'Get all', value: 'getAll' }] }] },
        async execute() {
          return [[]];
        },
      }),
    ],
  }),
);

const { DRAFT_LEFT_LIMIT } = await import('@/lib/shared/draft-left');
const { askKind } = await import('@/lib/shared/ask-kind');
const { runChat } = await import('@/lib/server/assistant/chat');
type ChatEvent = Parameters<Parameters<typeof runChat>[0]['onEvent']>[0];
const buildRoute = await import('@/app/api/ai/build/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const policyRoute = await import('@/app/api/workflows/[id]/policy/route');
const designRoute = await import('@/app/api/agents/design/route');
const { useEditor } = await import('@/components/editor/store');
const { applyChanges, undos, useAssistant } = await import('@/components/editor/assistant');
const { approveDestinations, publishToProduction, sendsAllowed, testUntilItRuns } = await import('@/components/editor/test-session');
const { afterReply, holdsForClick, typedSession, useAutonomous } = await import('@/components/editor/autonomous');
const { autonomyOf, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');
const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const coreTypes = (): NodeTypeInfo[] => registry.nodeTypes().filter((t) => t.pluginId === 'core');
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// 1. sb1-autonomy-join (SB03 × SB04)
// ---------------------------------------------------------------------------------------------------------------------

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const orders = (id: string): Workflow => ({
  id,
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
const goal = 'Tell the desk about big orders';
const fixOps: AssistantOp[] = [{ op: 'setParameters', node: 'Notify VIP', parameters: { method: 'PUT' } }];
const removeOps: AssistantOp[] = [{ op: 'removeNode', node: 'Notify Standard' }];

type ScriptedRun = Record<string, { error?: string }>;
let runs: ScriptedRun[] = [];
let replies: Array<{ text?: string; proposals?: Array<{ summary: string; ops: AssistantOp[] }> }> = [];
const sent: Array<{ request: string; session?: string }> = [];
const run = vi.fn();
const send = vi.fn();

/** What the editor does when a workflow opens: load it (autonomous.ts notes it from the store, as in the app). */
const open = async (workflow: Workflow) => {
  useEditor.getState().load(workflow, coreTypes());
  useEditor.setState({ run: run as never, save: async () => true });
  await vi.waitFor(() => expect(useAutonomyFacts.getState().workflows[workflow.id]).toBeDefined());
  await sleep(0);
};
const method = () => useEditor.getState().nodes.find((n) => n.data.wf.name === 'Notify VIP')?.data.wf.parameters.method;
const proposals = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' ? [{ item: i.id, proposal: p.proposal }] : [])) : []));
const outcomes = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'outcome' ? [p.outcome] : [])) : []));
/** The card's Apply (reply.tsx `applyAll`): the real applyChanges, then the proposal marked applied. */
const clickApply = (item: string, proposal: { id: string; ops: AssistantOp[] }) => {
  expect(applyChanges([{ ops: proposal.ops, kind: 'proposal' }], 'Applied 1 change', { onApplied: ({ undo }) => undos.set(proposal.id, undo) })).toBe(true);
  useAssistant.getState().setProposalState(item, proposal.id, 'applied');
};

beforeEach(() => {
  runs = [];
  replies = [];
  sent.length = 0;
  published.mockClear();
  sendsAllowed.clear();
  useAutonomous.getState().set(true);
  useAssistant.getState().reset();
  run.mockReset().mockImplementation(() => {
    const scripted = runs.shift() ?? {};
    useEditor.setState({ running: true, executionId: `ex_${run.mock.calls.length}` });
    setTimeout(() => {
      const statuses: Record<string, unknown> = {};
      let failed = false;
      for (const n of useEditor.getState().nodes) {
        if (n.data.wf.disabled) continue;
        const r = scripted[n.data.wf.name];
        if (r?.error) failed = true;
        statuses[n.id] = r?.error ? { state: 'error', error: r.error } : { state: 'success', itemCounts: [1] };
      }
      useEditor.setState({ running: false, statuses: statuses as never, runStatus: failed ? 'error' : 'success' });
    }, 0);
  });
  // The server's reply to what the session (or the person) sends: the scripted text and proposals, as the stream gives them.
  send.mockReset().mockImplementation(async (request: string, options: { session?: string; testId?: string }) => {
    sent.push({ request, session: options.session });
    const next = replies.shift() ?? { text: 'No change.' };
    const id = `r${sent.length}`;
    useAssistant.getState().append([
      {
        id,
        role: 'assistant',
        testId: options.testId,
        done: { model: 'test', durationMs: 1, steps: 1 },
        parts: [...(next.text ? [{ kind: 'text' as const, text: next.text }] : []), ...(next.proposals ?? []).map((p, i) => ({ kind: 'proposal' as const, proposal: { id: `${id}p${i}`, summary: p.summary, ops: p.ops, dropped: [], warnings: [] } }))],
      },
    ]);
  });
  useAssistant.setState({ send: send as never });
});

describe('sb1-autonomy-join: a saved workflow with the switch on asks first', () => {
  it('a typed change sends no auto session, afterReply applies nothing, and the reply waits as a card', async () => {
    await open(orders('wf_join_saved'));
    expect(autonomyOf('wf_join_saved')).toBe('asks-first');
    expect(typedSession('make Notify VIP use PUT')).toEqual({});
    useAssistant.getState().append([
      { id: 'u', role: 'user', text: 'make Notify VIP use PUT' },
      { id: 'r', role: 'assistant', done: { model: 'test', durationMs: 1, steps: 1 }, parts: [{ kind: 'proposal', proposal: { id: 'p', summary: 'Use PUT', ops: fixOps, dropped: [], warnings: [] } }] },
    ]);
    await afterReply('make Notify VIP use PUT');
    expect(method()).toBe('POST');
    expect(proposals()[0].proposal.state).toBeUndefined();
    expect(holdsForClick([{ ops: fixOps }])).toBe(true);
  });

  it('Test and fix: the fix waits until its card is applied, then the next run happens', async () => {
    await open(orders('wf_join_saved'));
    approveDestinations('wf_join_saved', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 405 Method Not Allowed' } }, {}];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }, { text: 'Yes, it does what you asked.' }];
    const session = testUntilItRuns(goal);
    await vi.waitFor(() => expect(sent.map((s) => s.session)).toEqual(['fix']));
    await sleep(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(method()).toBe('POST');
    const { item, proposal } = proposals()[0];
    clickApply(item, proposal);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await session;
    expect(method()).toBe('PUT');
    expect(sent.map((s) => s.session)).toEqual(['fix', 'review']);
  });

  it('Test and fix: a dismissed fix ends with the outcome card', async () => {
    await open(orders('wf_join_saved'));
    approveDestinations('wf_join_saved', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 405 Method Not Allowed' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }];
    const session = testUntilItRuns(goal);
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    const { item, proposal } = proposals()[0];
    useAssistant.getState().setProposalState(item, proposal.id, 'dismissed');
    await session;
    expect(run).toHaveBeenCalledTimes(1);
    expect(method()).toBe('POST');
    expect(outcomes().map((o) => o.text)).toEqual(['You kept the flow as it was.']);
  });
});

describe('sb1-autonomy-join: a brand-new draft with the switch on', () => {
  /** Opened empty in this tab, then drafted on the canvas under the same id (Spotlight building it). */
  const draftNew = async (id: string) => {
    await open({ id, name: 'Orders', nodes: [], connections: [] });
    useEditor.getState().replaceGraph(orders(id));
    expect(useEditor.getState().nodes).toHaveLength(3);
  };

  it('the session applies a parameter fix by itself, and a removal waits with its reason', async () => {
    await draftNew('wf_join_new');
    expect(autonomyOf('wf_join_new')).toBe('auto');
    expect(typedSession('make Notify VIP use PUT')).toEqual({ session: 'auto' });
    approveDestinations('wf_join_new', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 405 Method Not Allowed' } }, {}];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns(goal);
    expect(method()).toBe('PUT');
    expect(proposals()[0].proposal.state).toBe('applied');

    useAssistant.getState().reset();
    run.mockClear();
    runs = [{ 'Notify VIP': { error: 'HTTP 500 Internal Server Error' } }];
    replies = [{ proposals: [{ summary: 'Drop the second step', ops: removeOps }] }];
    const session = testUntilItRuns(goal);
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    await sleep(20);
    const { item, proposal } = proposals()[0];
    expect(proposal.warnings).toEqual(['Waits for you: removes “Notify Standard”']);
    expect(holdsForClick([proposal])).toBe(true);
    expect(useEditor.getState().nodes).toHaveLength(3);
    useAssistant.getState().setProposalState(item, proposal.id, 'dismissed');
    await session;
    expect(useEditor.getState().nodes).toHaveLength(3);
  });

  it('after publishToProduction the draft asks first, and the next fix waits', async () => {
    await draftNew('wf_join_published');
    expect(autonomyOf('wf_join_published')).toBe('auto');
    expect(await publishToProduction()).toBe(true);
    expect(published).toHaveBeenCalledWith('wf_join_published');
    expect(autonomyOf('wf_join_published')).toBe('asks-first');
    expect(typedSession('make Notify VIP use PUT')).toEqual({});

    approveDestinations('wf_join_published', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 405 Method Not Allowed' } }];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }];
    const session = testUntilItRuns(goal);
    await vi.waitFor(() => expect(proposals()).toHaveLength(1));
    await sleep(20);
    expect(method()).toBe('POST');
    expect(proposals()[0].proposal.state).toBeUndefined();
    useAssistant.getState().testing?.abort();
    await session;
    expect(method()).toBe('POST');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. The draft (SB01 × SB02): POST /api/ai/build with a fake Ollama
// ---------------------------------------------------------------------------------------------------------------------

describe('the draft join: SB01’s send-back and SB02’s guards in one answer', () => {
  const prompt = 'When an order webhook comes in, check whether its total is over 100, post it to our team chat and send it on to the VIP desk';
  const draftWith = (condition: unknown[]) =>
    JSON.stringify({
      name: 'Orders',
      nodes: [
        { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
        { key: 'go', type: 'core.manualTrigger', name: 'Run by hand', parameters: {} },
        { key: 'check', type: 'core.if', name: 'Big order?', parameters: { conditions: { condition }, combinator: 'and' } },
        { key: 'set', type: 'core.set', name: 'Edit fields', parameters: { mode: 'manual', fields: { values: [] } } },
        { key: 'chat', type: 'sb1chat.post', name: 'Post to chat', parameters: { channel: '#bugs', text: 'Big order: {{ $json.total }}' } },
        { key: 'vip', type: 'core.httpRequest', name: 'Send to VIP desk', parameters: { method: 'POST', url: 'https://httpbin.org/post' } },
      ],
      connections: [
        { from: 'hook', to: 'check' },
        { from: 'go', to: 'check' },
        { from: 'check', to: 'set' },
        { from: 'set', to: 'chat' },
        { from: 'chat', to: 'vip' },
      ],
    });
  const filled = [{ left: '{{ $json.total }}', operator: 'gt', right: '100' }];
  type Answer = { draft: { nodes: Array<{ key: string; type: string; name: string; parameters?: Record<string, unknown> }>; left?: Array<{ node: string; field?: string; kind: string; text: string }> } };

  it('fills the If on the send-back, keeps one trigger and no empty Set, clears the channel and the URL, and lists them once', async () => {
    queue.length = 0;
    queue.push({ text: draftWith([]) }, { text: draftWith(filled) });
    const chatsBefore = fake.requests.filter((r) => r.path === '/api/chat').length;
    const res = await buildRoute.POST(post('/api/ai/build', { prompt }));
    expect(res.status).toBe(200);
    const { draft } = (await res.json()) as Answer;
    // SB01: one send-back, the second draft stands.
    expect(fake.requests.filter((r) => r.path === '/api/chat').length - chatsBefore).toBe(2);
    const byName = new Map(draft.nodes.map((n) => [n.name, n]));
    expect((byName.get('Big order?')?.parameters?.conditions as { condition: unknown[] }).condition).toEqual(filled);
    // SB02: one trigger (the one the prompt names), no empty Set, nothing made up.
    expect(draft.nodes.filter((n) => n.type === 'core.webhook' || n.type === 'core.manualTrigger').map((n) => n.name)).toEqual(['Order in']);
    expect(byName.has('Edit fields')).toBe(false);
    expect(byName.get('Post to chat')?.parameters).not.toHaveProperty('channel');
    expect(byName.get('Send to VIP desk')?.parameters).not.toHaveProperty('url');
    // One left list: SB02's made-up and credential items, the dropped steps, and nothing SB01 said about a step SB02 removed.
    const left = draft.left ?? [];
    expect(left).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: 'Post to chat', field: 'channel', kind: 'made-up' }),
        expect.objectContaining({ node: 'Send to VIP desk', field: 'url', kind: 'made-up' }),
        expect.objectContaining({ node: 'Post to chat', field: 'credential', kind: 'credential' }),
        expect.objectContaining({ node: 'Run by hand', kind: 'dropped' }),
        expect.objectContaining({ node: 'Edit fields', kind: 'dropped' }),
      ]),
    );
    expect(left.some((l) => l.node === 'Edit fields' && l.kind === 'empty')).toBe(false);
    expect(left.some((l) => l.node === 'Big order?')).toBe(false);
    const keys = left.map((l) => `${l.node}|${l.field ?? ''}|${l.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(left.length).toBeLessThanOrEqual(DRAFT_LEFT_LIMIT);
  });

  it('a dropped trigger’s test data is not moved onto a schedule: no pin, since a schedule’s own item is only a time', async () => {
    const withData = JSON.stringify({
      name: 'Morning orders',
      nodes: [
        { key: 'go', type: 'core.manualTrigger', name: 'Run by hand', parameters: {} },
        { key: 'sch', type: 'core.schedule', name: 'Every morning', parameters: { unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } } },
        { key: 'vip', type: 'core.httpRequest', name: 'Fetch orders', parameters: { method: 'GET', url: 'http://127.0.0.1:3399/orders' } },
      ],
      connections: [
        { from: 'go', to: 'vip' },
        { from: 'sch', to: 'vip' },
      ],
      testData: [{ id: 1 }],
    });
    queue.length = 0;
    queue.push({ text: withData });
    const { draft } = (await (await buildRoute.POST(post('/api/ai/build', { prompt: 'Every morning at 9, fetch the orders from http://127.0.0.1:3399/orders' }))).json()) as Answer & { draft: { pinData?: Record<string, unknown> } };
    expect(draft.nodes.filter((n) => n.type === 'core.manualTrigger' || n.type === 'core.schedule').map((n) => n.name)).toEqual(['Every morning']);
    expect(Object.keys(draft.pinData ?? {})).toEqual([]);
  });

  it('keeps SB01’s empty items for a step SB02 keeps', async () => {
    queue.length = 0;
    // The model leaves the If empty twice: SB01 says so, SB02 keeps the step and adds its own items.
    queue.push({ text: draftWith([]) }, { text: draftWith([]) });
    const { draft } = (await (await buildRoute.POST(post('/api/ai/build', { prompt }))).json()) as Answer;
    expect(draft.left).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'Big order?', kind: 'empty' }), expect.objectContaining({ node: 'Post to chat', kind: 'made-up' })]));
  });

  it('with a workflowId whose policy leaves a type out, the model’s catalog lacks it', async () => {
    const created = await workflowsRoute.POST(post('/api/workflows', { name: 'Limited', nodes: [], connections: [] }));
    const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;
    const allowed = ['core.webhook', 'core.manualTrigger', 'core.if', 'core.set', 'core.httpRequest'];
    const saved = await policyRoute.PUT(new Request(`http://localhost/api/workflows/${id}/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodes: { mode: 'allow', types: allowed } }) }), { params: Promise.resolve({ id }) });
    expect(saved.status).toBe(200);
    queue.length = 0;
    queue.push({ text: draftWith(filled) }, { text: draftWith(filled) });
    const before = fake.requests.length;
    const { draft } = (await (await buildRoute.POST(post('/api/ai/build', { prompt, workflowId: id }))).json()) as Answer;
    // The first request's catalog (a send-back repeats the model's own draft, which names the type).
    const first = fake.requests.slice(before).find((r) => r.path === '/api/chat')?.body as { messages: Array<{ role: string; content: string }> };
    const catalog = first.messages.find((m) => m.role === 'user')!.content;
    expect(catalog).toContain('Node catalog:');
    expect(catalog).not.toContain('sb1chat.post');
    expect(catalog).toContain('core.httpRequest');
    expect(draft.nodes.some((n) => n.type === 'sb1chat.post')).toBe(false);
    expect(draft.left).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'Post to chat', kind: 'dropped' })]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. A chat fix's destination (SB02 × SB03)
// ---------------------------------------------------------------------------------------------------------------------

function scripted(turns: Array<Partial<ModelTurn>>, provider = 'test') {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider,
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = turns.shift();
      if (!next) return { text: 'Done.', toolCalls: [], stopReason: 'stop' };
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}

describe('the chat destination join: a fix session never swaps a destination', () => {
  const given = 'POST big orders to http://127.0.0.1:3399/vip (Notify VIP) and the rest to http://127.0.0.1:3399/standard';
  const ask = async (url: string) => {
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Change the address', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url } }] } }] }, { text: 'I changed nothing.' }, { text: 'I changed nothing.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: `Test run 1 failed at “Notify VIP”: HTTP 500. I asked for: “${given}”. Fix it.` }], workflow: orders('wf_join_chat'), model, types: coreTypes(), session: 'fix', onEvent: (e) => events.push(e) });
    const told = calls[1]?.messages.at(-1);
    return { proposals: events.filter((e) => e.type === 'proposal'), told: JSON.stringify(told) };
  };

  it('a host nobody gave (the httpbin swap): no card, and the model is told why', async () => {
    const { proposals, told } = await ask('https://httpbin.org/post');
    expect(proposals).toEqual([]);
    expect(told).toMatch(/Not shown|Nothing could be proposed/);
    expect(told).toContain('Only the person can change that');
  });

  it('another port on the same machine: still not shown, since the person gave the address', async () => {
    const { proposals, told } = await ask('http://127.0.0.1:3400/vip');
    expect(proposals).toEqual([]);
    expect(told).toMatch(/Not shown|Nothing could be proposed/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. A question and a session (SB03 × SB04)
// ---------------------------------------------------------------------------------------------------------------------

describe('the question × session join', () => {
  it('the session’s real fix and review requests are never classed questions: the chat offers propose_changes', async () => {
    await open({ id: 'wf_join_session_new', name: 'Orders', nodes: [], connections: [] });
    useEditor.getState().replaceGraph(orders('wf_join_session_new'));
    approveDestinations('wf_join_session_new', ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { error: 'HTTP 405 Method Not Allowed' } }, {}];
    replies = [{ proposals: [{ summary: 'Use PUT', ops: fixOps }] }, { text: 'Yes, it does what you asked.' }];
    await testUntilItRuns('Why does the desk not hear about big orders? Tell it about each one.');
    expect(sent.map((s) => s.session)).toEqual(['fix', 'review']);
    for (const { request, session } of sent) {
      const { model, calls } = scripted([{ text: 'It needs PUT.' }]);
      await runChat({ messages: [{ role: 'user', content: request }], workflow: orders('wf_join_session_new'), model, types: coreTypes(), session: session as 'fix' | 'review', onEvent: () => {} });
      expect(calls[0].tools?.map((t) => t.name), session).toContain('propose_changes');
    }
  });

  it('a typed question sends no session, on a saved workflow and on a new draft, and the chat answers without propose_changes', async () => {
    const question = 'why did the last run fail?';
    expect(askKind(question)).toBe('question');
    await open(orders('wf_join_saved'));
    expect(autonomyOf('wf_join_saved')).toBe('asks-first');
    expect(typedSession(question)).toEqual({});
    await open({ id: 'wf_join_question_new', name: 'New', nodes: [], connections: [] });
    expect(autonomyOf('wf_join_question_new')).toBe('auto');
    expect(typedSession(question)).toEqual({});
    const { model, calls } = scripted([{ text: '“Notify VIP” got a 405.' }]);
    await runChat({ messages: [{ role: 'user', content: question }], workflow: orders('wf_join_saved'), model, types: coreTypes(), ...typedSession(question), onEvent: () => {} });
    expect(calls[0].tools?.map((t) => t.name)).not.toContain('propose_changes');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. A new agent on a local model (SB05 × SB06): POST /api/agents/design with a fake Ollama
// ---------------------------------------------------------------------------------------------------------------------

describe('the new agent join: SB05’s hints reach SB06’s flat tool', () => {
  const spec = { name: 'Docs Answerer', description: 'Answers questions from our docs and looks up Linear issues', instructions: 'Answer from the docs; look up Linear issues when asked.', after: 'Sample question', tools: ['Linear: read issues'], knowledge: 'our docs' };
  const design: FakeReply = { toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'A docs answerer', name: 'Docs Answerer', role: 'Docs answerer', instructions: 'Answer from the docs.', nodeTools: 'linear.issues' } }] };
  type Designed = { agent: { name: string; tools?: Array<{ type: string; nodeType?: string }> }; designed: boolean };
  const chats = () => fake.requests.filter((r) => r.path === '/api/chat');

  it('the spec’s tools and knowledge reach the first request, which offers propose_design; the Linear tool is kept', async () => {
    queue.length = 0;
    queue.push(design, { text: 'Drafted.' });
    const before = chats().length;
    const res = await designRoute.POST(post('/api/agents/design', spec));
    expect(res.status).toBe(201);
    const first = chats()[before].body as { messages: Array<{ content: string }>; tools?: Array<{ function: { name: string } }> };
    const asked = JSON.stringify(first.messages);
    expect(asked).toContain('It needs: Linear: read issues.');
    expect(asked).toContain('It answers from: our docs');
    expect(asked).toContain('after the step “Sample question”');
    expect(first.tools?.map((t) => t.function.name)).toEqual(['propose_design']);
    const body = (await res.json()) as Designed;
    expect(body.designed).toBe(true);
    expect(body.agent.name).toBe('Docs Answerer');
    expect(body.agent.tools).toEqual([expect.objectContaining({ type: 'node', nodeType: 'linear.issues' })]);
  });

  it('a parse error on the first call still ends with a designed agent', async () => {
    queue.length = 0;
    queue.push({ error: { status: 500, body: '{"error":"XML syntax error on line 41: unexpected EOF"}' } }, design, { text: 'Drafted.' });
    const res = await designRoute.POST(post('/api/agents/design', spec));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Designed;
    expect(body.designed).toBe(true);
    expect(body.agent.tools).toEqual([expect.objectContaining({ type: 'node', nodeType: 'linear.issues' })]);
  });
});

describe('the draft reply says it tests only where Spotlight does (review fixes)', () => {
  const built = { name: 'Orders', nodes: 3, left: [], pinned: false, model: 'm', durationMs: 1 };
  const said = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])) : [])).join(' ');

  it('a draft on a workflow that was saved before is not "Testing it now" even with the switch on', async () => {
    useAssistant.getState().reset();
    useAutonomous.setState({ on: true });
    useAutonomyFacts.setState({ switchOn: true, workflows: { wf_draft_saved: { bornEmpty: false, published: false } } });
    useEditor.setState({ workflowId: 'wf_draft_saved' });
    await draftWholeFlow('Post big orders', async () => built as never);
    expect(said()).toContain('Built “Orders”');
    expect(said()).not.toContain('Testing it now');
  });

  it('a brand-new draft with the switch on says it', async () => {
    useAssistant.getState().reset();
    useAutonomyFacts.setState({ switchOn: true, workflows: { wf_draft_new: { bornEmpty: true, published: false } } });
    useEditor.setState({ workflowId: 'wf_draft_new' });
    await draftWholeFlow('Post big orders', async () => built as never);
    expect(said()).toContain('Testing it now');
    useAssistant.getState().reset();
  });
});
