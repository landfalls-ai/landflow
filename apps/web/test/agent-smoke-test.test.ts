/**
 * SB18 (wave sb3): test before publish (docs/assistant.md "Agents and teams", decision D3). A new agent Spotlight makes is run
 * once on the item that reaches its step and published only after a pass; Undo of the change removes an agent nothing else
 * uses; and the test session's leftovers: "Run it for real" goes on with the same session, one yes per scheme, a review's
 * "no" names what is missing, a "Publish … first" is not a fix round, and a pending row survives a reload.
 *
 * Both sides are real: the editor's stores and `applyChanges` on one side, the smoke-test, publish, expressions and design
 * routes on the other; only the browser's HTTP client (routed straight to the handlers), the agent's model (scripted) and the
 * run of the flow are stubbed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, Workflow } from '@landflow/engine';
import { parseOps, type AssistantOp } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-smoke-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The agent's scripted model: what it answers, what it was asked, and the judge's score for the eval gate.
const model = vi.hoisted(() => ({ reply: 'Refunds are paid within 14 days.' as string | Error, asked: [] as string[], score: 5 }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        if ((input.system ?? '').includes('"score"')) return { text: JSON.stringify({ score: model.score, reasoning: 'scripted' }), toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
        const last = input.messages.findLast((m) => m.role === 'user');
        model.asked.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
        if (model.reply instanceof Error) throw model.reply;
        return { text: model.reply, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
  },
}));

// The browser's client: each path goes to the real route handler, and the calls are kept in order.
const wire = vi.hoisted(() => ({ calls: [] as string[], impl: undefined as undefined | ((path: string, init: { method?: string; json?: unknown }) => Promise<unknown>) }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => wire.impl!(path, init)),
  streamEvents: vi.fn(),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
const published = vi.hoisted(() => vi.fn(async () => ({ published: { versionNumber: 3 } })));
vi.mock('@/components/editor/publish-control', () => ({ publishVersion: published, toastApprovalRequested: vi.fn() }));

const { ApiError } = await import('@/lib/client/api');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { addCase } = await import('@/lib/server/agents/eval-gate');
const { store } = await import('@/lib/server/store');
const { recordVersion, versionFor } = await import('@/lib/server/versions');
const { setPublication, clearPublication } = await import('@/lib/server/publications');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const designRoute = await import('@/app/api/agents/design/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const { useEditor } = await import('@/components/editor/store');
const { applyChanges, useAssistant, undos } = await import('@/components/editor/assistant');
const { agentsSettled, itemReaching, publishAgentFor, smokeTestAgent, takeBackAgents } = await import('@/components/editor/new-agent');
const { agentStep } = await import('@/components/editor/timeline');
const { approveDestinations, sendsAllowed, testUntilItRuns, missingPart, pendingNeedFor } = await import('@/components/editor/test-session');
const { autonomyOf, noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');
const { idleBubbles, TEST_BUBBLE } = await import('@/lib/shared/spotlight');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
};

// The client's api(): the design POST makes a draft agent the scripted model can run (the architect needs a real model); the rest are the routes.
wire.impl = async (path, init) => {
  const method = init.method ?? 'GET';
  wire.calls.push(`${method} ${path.replace(/ag_[A-Za-z0-9_-]+/, ':id')}`);
  let result: { status: number; body: Record<string, any> };
  const id = /^\/api\/agents\/([^/]+)\//.exec(path)?.[1];
  if (path === '/api/agents/design' && method === 'POST') {
    const spec = init.json as { name: string; instructions?: string };
    const agent = agentStore.create({ name: spec.name, instructions: spec.instructions ?? 'Answer briefly.', model: { provider: 'ollama', model: 'scripted-1' } });
    result = { status: 201, body: { agent, needs: [], missing: [], designed: true } };
  } else if (path === '/api/agents/design' && method === 'DELETE') result = await call(designRoute.DELETE, 'DELETE', path, init.json);
  else if (path === '/api/expressions/preview') result = await call(previewRoute.POST, 'POST', path, init.json);
  else if (id && path.endsWith('/smoke-test')) result = await call(smokeRoute.POST, 'POST', path, init.json, { id });
  else if (id && path.endsWith('/publish')) result = await call(publishRoute.POST, 'POST', path, init.json, { id });
  else throw new Error(`unrouted ${method} ${path}`);
  if (result.status >= 400) throw new ApiError(result.body?.error ?? `${result.status}`, result.status, result.body);
  return result.body;
};

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
const WF = 'wf_refunds';
const sample = { chatInput: 'What is the refund window?' };
const flow = (pinned: Record<string, unknown> | null = sample): Workflow => ({
  id: WF,
  name: 'Refund answers',
  nodes: [node('a', 'Start', 'core.manualTrigger'), node('z', 'Done', 'core.noOp')],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'z', targetIndex: 0 }],
  ...(pinned && { pinData: { a: [{ json: pinned }] } }),
});
const addAgent: AssistantOp[] = parseOps([{ op: 'newAgent', ref: 'r', name: 'Refund policy answerer', description: 'Answers questions about our refund policy', instructions: 'Answer refund questions.', after: 'Start' }]).ops;
const agentNode = () => useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent');
const agentRow = () => useAssistant.getState().agents[0];
const agentOf = () => agentStore.get(agentRow()!.agentId!)!;

beforeEach(() => {
  wire.calls.length = 0;
  model.reply = 'Refunds are paid within 14 days.';
  model.asked.length = 0;
  model.score = 5;
  published.mockClear();
  enableTestAuth(TEST_OWNER);
  useAutonomyFacts.setState({ switchOn: true, workflows: {} });
  useAssistant.getState().reset();
  useEditor.getState().load(flow(), types);
});

/** A change adding the new agent's step, applied the way Spotlight applies it (autonomous: `publishAgents`). */
async function addTheAgent(publishAgents: boolean) {
  let undo: (() => void) | undefined;
  expect(applyChanges([{ ops: addAgent, kind: 'proposal' }], 'Applied 1 change', { quiet: true, publishAgents, onApplied: (a) => (undo = a.undo) })).toBe(true);
  await agentsSettled();
  return undo!;
}

describe('the smoke-test route', () => {
  const draft = () => agentStore.create({ name: 'Maths', instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'scripted-1' } });

  it('passes on a reply, with the reply cut to 300 characters, and leaves no session behind', async () => {
    const agent = draft();
    model.reply = 'x'.repeat(500);
    const sessions = agentStore.listSessions(agent.id).length;
    const { status, body } = await call(smokeRoute.POST, 'POST', `/api/agents/${agent.id}/smoke-test`, { message: 'hi' }, { id: agent.id });
    expect(status).toBe(200);
    expect(body.smoke).toMatchObject({ state: 'passed' });
    expect(body.smoke.reply).toHaveLength(300);
    expect(model.asked).toEqual(['hi']);
    expect(agentStore.listSessions(agent.id)).toHaveLength(sessions);
  });

  it('fails with the reason when the run ends with an error, and still leaves no session behind', async () => {
    const agent = draft();
    model.reply = new Error('the model fell over');
    const { body } = await call(smokeRoute.POST, 'POST', `/api/agents/${agent.id}/smoke-test`, { message: 'hi' }, { id: agent.id });
    expect(body.smoke.state).toBe('failed');
    expect(body.smoke.reason).toMatch(/^The run ended with an error: /);
    expect(agentStore.listSessions(agent.id)).toHaveLength(0);
  });

  it('fails with "No reply" for an empty answer', async () => {
    const agent = draft();
    model.reply = '   ';
    const { body } = await call(smokeRoute.POST, 'POST', `/api/agents/${agent.id}/smoke-test`, { message: 'hi' }, { id: agent.id });
    expect(body.smoke).toMatchObject({ state: 'failed', reason: 'No reply' });
  });

  it('is 400 with no model, 404 for an unknown agent, and 404 for another project’s agent', async () => {
    const bare = agentStore.create({ name: 'No model', instructions: 'Hi.' });
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${bare.id}/smoke-test`, { message: 'hi' }, { id: bare.id })).status).toBe(400);
    expect((await call(smokeRoute.POST, 'POST', '/api/agents/ag_nope/smoke-test', { message: 'hi' }, { id: 'ag_nope' })).status).toBe(404);
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${bare.id}/smoke-test`, { message: '' }, { id: bare.id })).status).toBe(400);
    const agent = draft();
    // Someone who is in no project of the agent's home does not see it.
    enableTestAuth({ ...TEST_OWNER, id: 'usr_outsider', email: 'outsider@landflow.test', role: 'member' });
    expect((await call(smokeRoute.POST, 'POST', `/api/agents/${agent.id}/smoke-test`, { message: 'hi' }, { id: agent.id })).status).toBe(404);
  });
});

describe('a new agent is tested before it is published', () => {
  it('autonomous: the smoke test runs first, the publish follows the pass, and the row says so in that order', async () => {
    await addTheAgent(true);
    expect(wire.calls.filter((c) => /smoke-test|publish/.test(c))).toEqual(['POST /api/agents/:id/smoke-test', 'POST /api/agents/:id/publish']);
    expect(agentRow()).toMatchObject({ state: 'published', smoke: { state: 'passed' } });
    expect(agentOf().published?.version).toBe(1);
    expect(agentStep(agentRow()).text).toMatch(/^Agent “Refund policy answerer” tested, 1 of 1 passed · published/);
  });

  it('runs the step’s message resolved for the item that reaches it ({{ $json.chatInput ?? $json.text }} with chatInput "hi")', async () => {
    useEditor.getState().load(flow({ chatInput: 'hi' }), types);
    await addTheAgent(true);
    expect(model.asked).toEqual(['hi']);
  });

  it('falls back to the item’s chatInput when the step’s message resolves empty, like the node at run time', async () => {
    useEditor.getState().load(flow({ chatInput: 'hi' }), types);
    await addTheAgent(false);
    model.asked.length = 0;
    const id = agentNode()!.id;
    useEditor.getState().updateNode(id, { parameters: { ...useEditor.getState().nodes.find((n) => n.id === id)!.data.wf.parameters, message: '{{ "" }}' } });
    await smokeTestAgent(id);
    expect(model.asked).toEqual(['hi']);
  });

  it('takes the item from the last run of the step before it, ahead of nothing', async () => {
    useEditor.getState().load(flow(null), types);
    expect(applyChanges([{ ops: addAgent, kind: 'proposal' }], 'x', { quiet: true })).toBe(true);
    await agentsSettled();
    // No run and nothing pinned: not tested yet, and no smoke call was made.
    expect(agentRow()).toMatchObject({ state: 'untested', smoke: { state: 'untested', reason: 'run the step before it once' } });
    expect(agentStep(agentRow()).text).toContain('not tested yet: run the step before it once');
    expect(wire.calls.some((c) => c.includes('smoke-test'))).toBe(false);
    // A run of Start put out an item: now there is one.
    useEditor.setState({ runs: { a: [{ startedAt: '', durationMs: 1, status: 'success', source: 'main', inputs: [[]], outputs: [[{ json: { text: 'from a run' } }]] }] } });
    expect(itemReaching(agentNode()!.id)?.item).toEqual({ text: 'from a run' });
    await smokeTestAgent(agentNode()!.id);
    expect(model.asked).toEqual(['from a run']);
  });

  it('a failed test leaves a draft that was never published, and says why', async () => {
    model.reply = new Error('no luck');
    await addTheAgent(true);
    expect(wire.calls.some((c) => c.includes('/publish'))).toBe(false);
    expect(agentRow()).toMatchObject({ state: 'draft', smoke: { state: 'failed' } });
    expect(agentOf().published).toBeUndefined();
    expect(agentStep(agentRow()).text).toMatch(/^Agent “Refund policy answerer” test failed: The run ended with an error/);
  });

  it('a held eval gate leaves it a draft, and the row names the score', async () => {
    // A case the agent will score low on, added once the agent exists: the design stub creates it, so add it on the way.
    const original = wire.impl!;
    wire.impl = async (path, init) => {
      const answer = await original(path, init);
      if (path === '/api/agents/design' && init.method === 'POST') addCase((answer as { agent: { id: string } }).agent.id, { input: 'Refund window?', expected: '14 days' });
      return answer;
    };
    model.score = 2;
    try {
      await addTheAgent(true);
    } finally {
      wire.impl = original;
    }
    expect(wire.calls.filter((c) => /smoke-test|publish/.test(c))).toEqual(['POST /api/agents/:id/smoke-test', 'POST /api/agents/:id/publish']);
    expect(agentRow().state).toBe('tested');
    expect(agentRow().held).toMatch(/held by the eval gate: 2\.0 \/ 5/);
    expect(agentOf().published).toBeUndefined();
    expect(agentStep(agentRow()).text).toMatch(/tested, 1 of 1 passed · held by the eval gate: 2\.0 \/ 5/);
  });

  it('asks-first never publishes by itself: the row offers Publish after the pass, and Publish does it', async () => {
    await addTheAgent(false);
    expect(wire.calls.some((c) => c.includes('/publish'))).toBe(false);
    expect(agentRow()).toMatchObject({ state: 'tested', smoke: { state: 'passed' } });
    expect(agentOf().published).toBeUndefined();
    expect(await publishAgentFor(agentRow().nodeId)).toBe(true);
    expect(agentRow().state).toBe('published');
    expect(agentOf().published?.version).toBe(1);
  });
});

describe('Undo takes back an agent nothing else uses', () => {
  it('Undo of the change removes the agent, and the row says so', async () => {
    const undo = await addTheAgent(true);
    const id = agentRow().agentId!;
    undo();
    await takeBackAgents([], WF);
    await vi.waitFor(() => expect(agentStore.get(id)).toBeUndefined());
    expect(wire.calls).toContain('DELETE /api/agents/design');
    expect(agentRow().taken).toEqual({ deleted: true });
    expect(agentStep(agentRow()).text).toBe('Removed the agent “Refund policy answerer” (nothing else used it)');
  });

  it('keeps it when a step of another workflow points at it, and names that workflow', async () => {
    const undo = await addTheAgent(true);
    const id = agentRow().agentId!;
    store.saveWorkflow({ id: 'wf_other', name: 'Support desk', nodes: [node('s', 'Ask', 'core.messageAgent', { agentId: id })], connections: [] });
    undo();
    await vi.waitFor(() => expect(agentRow().taken).toBeDefined());
    expect(agentStore.get(id)).toBeDefined();
    expect(agentRow().taken).toEqual({ deleted: false, usedBy: ['the workflow “Support desk”'] });
    expect(agentStep(agentRow()).text).toBe('Kept the agent “Refund policy answerer”: used by the workflow “Support desk”');
    store.deleteWorkflow('wf_other');
  });

  it('keeps it when the workflow\'s own published version still has the agent\'s step, and names that version', async () => {
    const undo = await addTheAgent(true);
    const id = agentRow().agentId!;
    // The workflow was published with the agent's step; Undo then takes the step out of the draft only.
    const withStep: Workflow = { id: WF, name: 'Refunds', nodes: [node('s', 'Ask', 'core.messageAgent', { agentId: id })], connections: [] };
    store.saveWorkflow(withStep);
    const version = recordVersion(withStep) ?? versionFor(withStep)!;
    setPublication(WF, version.id);
    undo();
    await vi.waitFor(() => expect(agentRow().taken).toBeDefined());
    expect(agentStore.get(id)).toBeDefined();
    expect(agentRow().taken).toEqual({ deleted: false, usedBy: ['the published version of “Refunds”'] });
    expect(agentStep(agentRow()).text).toBe('Kept the agent “Refund policy answerer”: used by the published version of “Refunds”');
    clearPublication(WF);
  });

  it('keeps it when a team has it as a member, or when a later version was published', async () => {
    const undo = await addTheAgent(true);
    const id = agentRow().agentId!;
    const team = agentTeamStore.create({ name: 'Desk', members: [{ id: 'm1', title: 'Lead', kind: 'agent', agentId: id }] });
    undo();
    await vi.waitFor(() => expect(agentRow().taken).toBeDefined());
    expect(agentRow().taken?.usedBy).toEqual(['the team “Desk”']);
    agentTeamStore.delete(team.id);
    // A version beyond Spotlight's own first one means a person published it too.
    agentStore.publish(id);
    const again = await call(designRoute.DELETE, 'DELETE', '/api/agents/design', { agentId: id, workflowId: WF });
    expect(again.body).toEqual({ deleted: false, usedBy: ['a later published version'] });
    expect(agentStore.get(id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The test session's leftovers
// ---------------------------------------------------------------------------------------------------------------------

const stored = new Map<string, string>();
beforeAll(() => {
  (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
});
afterAll(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

type ScriptedRun = Record<string, { error?: string; items?: number }>;
let runs: ScriptedRun[] = [];
let replies: Array<{ text?: string; proposals?: Array<{ summary: string; ops: AssistantOp[] }> }> = [];
const run = vi.fn();
const send = vi.fn();

function sessionFlow(): Workflow {
  return {
    id: WF,
    name: 'Orders',
    nodes: [node('a', 'Start', 'core.manualTrigger'), node('b', 'Notify VIP', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/vip' })],
    connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
  };
}

function stubTheSession() {
  runs = [];
  replies = [];
  stored.clear();
  sendsAllowed.clear();
  useAutonomyFacts.setState({ switchOn: true, workflows: {} });
  useAssistant.getState().reset();
  useAssistant.getState().bind(WF);
  useEditor.getState().load(sessionFlow(), types);
  run.mockReset().mockImplementation(() => {
    const scripted = runs.shift() ?? {};
    useEditor.setState({ running: true, executionId: `ex_${run.mock.calls.length}` });
    setTimeout(() => {
      const statuses: Record<string, unknown> = {};
      const ran: Record<string, unknown[]> = {};
      let failed = false;
      for (const n of useEditor.getState().nodes) {
        const r = scripted[n.data.wf.name];
        if (!r) continue;
        if (r.error) failed = true;
        statuses[n.id] = r.error ? { state: 'error', error: r.error } : { state: 'success', itemCounts: [r.items ?? 1] };
        if (!r.error) ran[n.id] = [{ startedAt: '', durationMs: 1, status: 'success', source: 'main', inputs: [[]], outputs: [[{ json: { status: 200, delivered: true } }]] }];
      }
      useEditor.setState({ running: false, statuses: statuses as never, runStatus: failed ? 'error' : 'success', runs: ran as never });
    }, 0);
  });
  useEditor.setState({ run: run as never });
  send.mockReset().mockImplementation(async () => {
    const next = replies.shift() ?? { text: 'No change.' };
    const id = `r${send.mock.calls.length}`;
    useAssistant.getState().append([
      {
        id,
        role: 'assistant',
        done: { model: 'test', durationMs: 1, steps: 1 },
        parts: [
          ...(next.text ? [{ kind: 'text' as const, text: next.text }] : []),
          ...(next.proposals ?? []).map((p, i) => ({ kind: 'proposal' as const, proposal: { id: `${id}p${i}`, summary: p.summary, ops: p.ops, dropped: [], warnings: [] } })),
        ],
      },
    ]);
  });
  useAssistant.setState({ send: send as never });
}

const needs = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'needs' ? [p.need] : [])) : []));
const outcomes = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'outcome' ? [p.outcome] : [])) : []));
const actions = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'action' ? [p.action] : [])) : []));
const texts = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])) : []));
const setUrl = (summary: string, url: string) => ({ summary, ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url } } as AssistantOp] });
const goal = 'POST big orders to Notify VIP';

describe('"Run it for real" goes on with the same session', () => {
  beforeEach(() => {
    stubTheSession();
    noteOpened(WF, 0); // a brand-new draft: autonomous
    approveDestinations(WF, ['http://127.0.0.1:3399']);
  });

  it('a session at 3 fixes that asks about a new destination keeps its 3 fixes after the yes (it does not get 4 more)', async () => {
    runs = [{ 'Notify VIP': { error: 'HTTP 500 first' } }, { 'Notify VIP': { error: 'HTTP 502 second' } }, { 'Notify VIP': { error: 'HTTP 404 third' } }];
    replies = [
      { text: 'a', proposals: [setUrl('Try /vip2', 'http://127.0.0.1:3399/vip2')] },
      { text: 'b', proposals: [setUrl('Try /vip3', 'http://127.0.0.1:3399/vip3')] },
      { text: 'c', proposals: [setUrl('Move it to another host', 'http://127.0.0.1:3400/vip')] },
    ];
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(3);
    expect(needs().map((n) => n.what)).toEqual(['destination']);
    // The yes goes on with the same session: one more fix is all that is left of its four.
    approveDestinations(WF, needs()[0].destinations ?? [], needs()[0].once ?? []);
    runs = [{ 'Notify VIP': { error: 'HTTP 503 fourth' } }, { 'Notify VIP': { error: 'HTTP 504 fifth' } }];
    replies = [{ text: 'd', proposals: [setUrl('Try /vip5', 'http://127.0.0.1:3400/vip5')] }, { text: 'e', proposals: [setUrl('Try /vip6', 'http://127.0.0.1:3400/vip6')] }];
    approveDestinations(WF, ['http://127.0.0.1:3400']);
    await testUntilItRuns(goal, { resume: true });
    expect(send).toHaveBeenCalledTimes(4); // 3 before, 1 after: not 4 more
    expect(run).toHaveBeenCalledTimes(5);
    expect(outcomes().at(-1)?.text).toMatch(/after 4 fixes/);
    // Its fixes are all still there to undo from the outcome card.
    expect(outcomes().at(-1)?.fixes).toHaveLength(4);
  });
});

describe('one yes per scheme', () => {
  beforeEach(() => {
    stubTheSession();
    noteOpened(WF, 0);
  });

  it('a yes to http://127.0.0.1:3399 (or the bare host:port from before) covers http, and an https step asks again', async () => {
    approveDestinations(WF, ['127.0.0.1:3399']);
    runs = [{ 'Notify VIP': { items: 1 } }];
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(1); // the bare yes still covers http
    expect(needs()).toEqual([]);

    useAssistant.getState().reset();
    useEditor.getState().updateNode('b', { parameters: { method: 'POST', url: 'https://127.0.0.1:3399/vip' } });
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(needs().map((n) => n.what)).toEqual(['sends']);
    expect(needs()[0].destinations).toEqual(['https://127.0.0.1:3399']);

    approveDestinations(WF, ['http://127.0.0.1:3399']);
    approveDestinations(WF, needs()[0].destinations ?? []);
    runs = [{ 'Notify VIP': { items: 1 } }];
    await testUntilItRuns(goal);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a yes to https does not cover http', async () => {
    approveDestinations(WF, ['https://127.0.0.1:3399']);
    await testUntilItRuns(goal);
    expect(run).not.toHaveBeenCalled();
    expect(needs()[0].destinations).toEqual(['http://127.0.0.1:3399']);
  });
});

describe('the review after a right fix names what is missing', () => {
  beforeEach(() => {
    stubTheSession();
    noteOpened(WF, 0);
    approveDestinations(WF, ['http://127.0.0.1:3399']);
  });

  it('missingPart reads a named part, and nothing for a bare no', () => {
    expect(missingPart('No, it never tells the desk about big orders. I will fix that.')).toBe('it never tells the desk about big orders');
    expect(missingPart('No.')).toBeUndefined();
    expect(missingPart('Not yet, sorry')).toBeUndefined();
    expect(missingPart('Yes, it does.')).toBeUndefined();
    expect(missingPart('It posts to Slack but never emails the desk.')).toBe('It posts to Slack but never emails the desk');
    expect(missingPart('Partially: the email step is missing.')).toBe('Partially: the email step is missing');
  });

  it('asks the review with the goal and each step’s output fields', async () => {
    runs = [{ 'Notify VIP': { items: 1 } }];
    replies = [{ text: 'Yes, it posts.' }];
    await testUntilItRuns(goal);
    const asked = send.mock.calls[0][0] as string;
    expect(asked).toContain(`“${goal}”`);
    expect(asked).toContain('“Notify VIP” has: status, delivered');
    expect(asked).toContain('name the part of what I asked that did not happen');
    expect(actions()).toEqual(['publish']);
  });

  it('a "no" with nothing named reads as a pass: "Reviewed: nothing missing"', async () => {
    runs = [{ 'Notify VIP': { items: 1 } }];
    replies = [{ text: 'No.' }];
    await testUntilItRuns(goal);
    expect(texts()).toContain('Reviewed: nothing missing.');
    expect(actions()).toEqual(['publish']);
    expect(outcomes()).toEqual([]);
  });

  it('a "no" that names the part stops with that part in "It runs, but doesn’t do all you asked yet"', async () => {
    runs = [{ 'Notify VIP': { items: 1 } }];
    replies = [{ text: 'No, it never tells the desk about big orders.' }];
    await testUntilItRuns(goal);
    expect(actions()).toEqual([]);
    expect(outcomes().at(-1)?.text).toBe('It runs, but doesn’t do all you asked yet: it never tells the desk about big orders. I have no change for it: tell me what to change.');
  });
});

describe('an agent that is not published when the flow runs', () => {
  const agentFlow = (): Workflow => ({
    id: WF,
    name: 'Refund answers',
    nodes: [node('a', 'Start', 'core.manualTrigger'), node('g', 'Answerer', 'core.messageAgent', { agentId: '', message: '{{ $json.chatInput ?? $json.text }}' })],
    connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'g', targetIndex: 0 }],
    pinData: { a: [{ json: sample }] },
  });
  let agentId = '';

  beforeEach(() => {
    stubTheSession();
    useEditor.getState().load(agentFlow(), types);
    agentId = agentStore.create({ name: 'Answerer', instructions: 'Answer.', model: { provider: 'ollama', model: 'scripted-1' } }).id;
    useEditor.getState().updateNode('g', { parameters: { agentId, message: '{{ $json.chatInput ?? $json.text }}' } });
  });

  it('autonomous: "Publish … first" is not a fix round: it is tested, published on the pass, and the run goes again', async () => {
    noteOpened(WF, 0);
    useAssistant.getState().setAgent('g', { name: 'Answerer', state: 'draft', agentId });
    runs = [{ Answerer: { error: 'Publish “Answerer” first' } }, { Answerer: { items: 1 } }];
    replies = [{ text: 'Yes, it answers.' }];
    await testUntilItRuns('Answer refund questions');
    expect(run).toHaveBeenCalledTimes(2);
    expect(model.asked).toEqual([sample.chatInput]);
    expect(agentStore.get(agentId)?.published?.version).toBe(1);
    // The one call to the assistant is the review of the passing run, never a fix of the failed one.
    expect(send.mock.calls.map((c) => (c[1] as { session?: string }).session)).toEqual(['review']);
    expect(outcomes()).toEqual([]);
  });

  it('autonomous: an untested agent whose step now has an item is tested before the first run', async () => {
    noteOpened(WF, 0);
    useAssistant.getState().setAgent('g', { name: 'Answerer', state: 'untested', agentId, smoke: { state: 'untested', reason: 'run the step before it once' } });
    runs = [{ Answerer: { items: 1 } }];
    replies = [{ text: 'Yes.' }];
    await testUntilItRuns('Answer refund questions');
    expect(wire.calls.filter((c) => /smoke-test|publish/.test(c))).toEqual(['POST /api/agents/:id/smoke-test', 'POST /api/agents/:id/publish']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(agentStore.get(agentId)?.published?.version).toBe(1);
  });

  it('asks-first: a Needs-you row publishes it after the pass, and nothing is published before the click', async () => {
    noteOpened(WF, 5);
    expect(autonomyOf(WF)).toBe('asks-first');
    useAssistant.getState().setAgent('g', { name: 'Answerer', state: 'draft', agentId });
    runs = [{ Answerer: { error: 'Publish “Answerer” first' } }];
    await testUntilItRuns('Answer refund questions');
    expect(send).not.toHaveBeenCalled();
    expect(needs().map((n) => [n.what, n.text])).toEqual([['publish', 'Publish “Answerer”: tested, 1 of 1 passed.']]);
    expect(agentStore.get(agentId)?.published).toBeUndefined();
    expect(await publishAgentFor('g')).toBe(true);
    expect(agentStore.get(agentId)?.published?.version).toBe(1);
  });
});

describe('a pending "Run it for real" row after a reload', () => {
  beforeEach(() => {
    stubTheSession();
    noteOpened(WF, 0);
  });

  it('is kept by workflow in the tab, comes back when the workflow reopens, and is still waiting for the yes', async () => {
    await testUntilItRuns(goal);
    expect(needs().map((n) => n.what)).toEqual(['sends']);
    const kept = [...stored.entries()].filter(([k]) => k.includes(WF));
    expect(kept).toHaveLength(1);
    expect(kept[0][1]).not.toMatch(/yes|approved|allowed/i);

    // A reload: the page's stores start over (the assistant is bound to the workflow again, with no conversation).
    sendsAllowed.clear();
    useAssistant.getState().bind('wf_elsewhere');
    expect(needs()).toEqual([]);
    useAssistant.getState().bind(WF);
    expect(needs().map((n) => [n.what, n.state, n.destinations])).toEqual([['sends', undefined, ['http://127.0.0.1:3399']]]);
    expect(sendsAllowed.get(WF)?.size ?? 0).toBe(0);
    expect(pendingNeedFor(WF)?.goal).toBe(goal);

    // The yes clears it from the tab.
    approveDestinations(WF, needs()[0].destinations ?? []);
    expect([...stored.keys()].some((k) => k.includes(WF))).toBe(false);
  });
});

describe('the idle test bubble', () => {
  it('shows on a saved flow with a trigger and no outcome, and waits behind a failure or a missing model', () => {
    const ctx = {
      types: [],
      selectedId: 'b',
      nodes: [
        { id: 'a', name: 'Start', type: 'core.manualTrigger', trigger: true, outgoing: true, x: 0, failed: true },
        { id: 'b', name: 'Agent', type: 'core.aiAgent', outgoing: false, x: 1, agent: true, hasModel: false },
      ],
    } as never;
    expect(idleBubbles(ctx).map((b) => b.id)).not.toContain(TEST_BUBBLE); // what needs attention comes first and the test bubble waits
    expect(idleBubbles(ctx)).toHaveLength(3);
    expect(idleBubbles({ types: [], nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', trigger: true, outgoing: false, x: 0 }] } as never).map((b) => b.id)).toContain(TEST_BUBBLE);
  });
});
