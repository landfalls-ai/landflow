/**
 * Wave sb2's join tests (carryover-sb2.md §2): each contract between two packages of the wave, with both real sides and
 * no fake between them. Only the edges are stubbed: the model (a scripted LanguageModel, a fake Ollama, a fake LiteLLM
 * gateway), the browser's HTTP client and the editor's `send`.
 *
 * 1. Scope (SB07 → SB09, SB10, SB11): one chat reply on the "Bug triage" flow, the HTTP step selected and failed 401.
 * 2. Credential offer → diff card (SB12 → SB08): the stream's `proposal` and `credential` events, the editor's parts,
 *    `diffOps`, the picker's store action and Apply.
 * 3. Model pick → chat, draft, architect, spend (SB19 → the routes, SB10's `FlowDraft.calls`, spend 13's report).
 * 4. Ask × scope (SB11 × SB07): the chip's answer, sent as the editor sends it, scopes the change that follows.
 * 5. Suggestion after a block × metering (SB09 × SB19): the suggest route skips a blocked run with no call and no row.
 * 6. Scope × workflow settings (SB07 × SB10): a selected step and a request about the whole workflow's time limit.
 * 7. Checks × ask (SB09 × SB11): the checks of what was asked read the request across the question, not the chip's word.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { GenerateInput } from '@/lib/server/nodes/models';
import type { AssistantOp, RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeLiteLlm } from './fake-litellm';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
vi.mock('@/lib/client/api', () => ({ api: vi.fn(async () => ({ versions: [] })), streamEvents: vi.fn() }));

// A fake Ollama: two chat models, and /api/chat answering from a queue (else an empty suggestion list), recording what it was asked.
const ollamaAsked: Array<{ path: string; model?: string }> = [];
const ollamaQueue: string[] = [];
const ollama: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (path === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b', capabilities: ['completion', 'tools'] }, { name: 'qwen3.8', capabilities: ['completion', 'tools'] }] }));
      return;
    }
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }) : {};
    ollamaAsked.push({ path, model: body.model });
    const content = ollamaQueue.shift() ?? JSON.stringify({ suggestions: [] });
    res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 8 }));
  });
});
await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));

const DRAFT = JSON.stringify({
  name: 'Draft',
  nodes: [
    { key: 'start', type: 'core.manualTrigger', name: 'Start', parameters: {} },
    { key: 'set', type: 'core.set', name: 'Set', parameters: { mode: 'manual', fields: { field: [{ name: 'a', value: '1' }] } } },
  ],
  connections: [{ from: 'start', to: 'set' }],
  testData: [{ q: 'one' }],
});
const gateway = await startFakeLiteLlm({ models: ['qwen3-coder:30b'], answer: () => DRAFT });

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-sb2-joins-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BUILDER_MODEL: 'qwen3-coder:30b',
  OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
};
const UNSET = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY'];
const previousEnv = { ...process.env };
for (const key of UNSET) delete process.env[key];
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { runChat, TOOLS } = await import('@/lib/server/assistant/chat');
type ChatEvent = Parameters<Parameters<typeof runChat>[0]['onEvent']>[0];
const { registryLookup } = await import('@/lib/server/assistant/ops');
const { diffOps } = await import('@/lib/shared/assistant-ops');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { aiSpendReport } = await import('@/lib/server/ai-usage/spend-report');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { forgetSpotlightModels } = await import('@/lib/server/assistant/models-list');
const { forgetGatewayModels } = await import('@/lib/server/llm-gateway/models');
const chatRoute = await import('@/app/api/assistant/chat/route');
const buildRoute = await import('@/app/api/ai/build/route');
const designRoute = await import('@/app/api/agents/design/route');
const agentRoute = await import('@/app/api/assistant/agent/route');
const suggestRoute = await import('@/app/api/assistant/suggest/route');
const settingsRoute = await import('@/app/api/settings/spotlight/route');
const { useEditor } = await import('@/components/editor/store');
const { applyChanges, applyStreamEvent, useAssistant } = await import('@/components/editor/assistant');
type AssistantTurn = import('@/components/editor/assistant').AssistantTurn;
const { setStepCredential } = await import('@/components/editor/spotlight/credential-picker');
const { streamEvents } = await import('@/lib/client/api');
/** The editor's own `send` (join 4 stubs it in the store): join 7 sends a chip's answer through it to see the history it builds. */
const realSend = useAssistant.getState().send;

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  forgetSpotlightModels();
  forgetGatewayModels();
  aiUsageMeter().invalidateCaps();
  ollamaAsked.length = 0;
  ollamaQueue.length = 0;
  database().sqlite.exec('DELETE FROM ai_usage');
  database().sqlite.exec("DELETE FROM settings WHERE key = 'spotlight'");
  delete process.env.LANDFLOW_LLM_GATEWAY_URL;
  delete process.env.LANDFLOW_LLM_GATEWAY_KEY;
});

// ---------------------------------------------------------------------------------------------------------------------
// The "Bug triage" fixture, its HTTP step on a header credential nobody picked yet, failed 401.
// ---------------------------------------------------------------------------------------------------------------------

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'bug-triage.json'), 'utf8')) as Workflow;
const BODY = `{"title": "{{ $json.title }}", "notes": "${'n'.repeat(4000)}", "end": "END_OF_BODY"}`;
const triage = (http: Record<string, unknown> = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', body: BODY }): Workflow => ({
  ...structuredClone(fixture),
  nodes: structuredClone(fixture.nodes).map((n) => (n.name === 'Open status incident' ? { ...n, parameters: { ...n.parameters, ...http } } : n)),
});
/** The same flow with a second HTTP step after the backlog: two steps that call out. */
const twoHttp = (): Workflow => {
  const wf = triage();
  wf.nodes.push({ id: 'n_http2', name: 'Notify status page', type: 'core.httpRequest', typeVersion: 1, position: [1800, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3399/status' } });
  wf.connections.push({ id: 'c_http2', type: 'main', source: 'n_dt', sourceIndex: 0, target: 'n_http2', targetIndex: 0 });
  return wf;
};
const SELECTED = 'n_http';
const failed401 = { n_http: { status: 'error', durationMs: 12, error: { message: 'HTTP 401 Unauthorized' }, inputs: [{ count: 1, sample: [{ title: 'Login broken', priority: 'P0', reason: 'all users' }] }], outputs: [] } } as unknown as Record<string, RunDigest>;

function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}
const propose = (id: string, ops: unknown[]): Partial<ModelTurn> => ({ toolCalls: [{ id, name: 'propose_changes', input: { summary: 'Fix', ops } }], stopReason: 'tool_use' });
const toolResult = (calls: GenerateInput[], at: number) => (calls[at].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;
type Proposal = Extract<ChatEvent, { type: 'proposal' }>;

async function chat(turns: Array<Partial<ModelTurn>>, extra: Partial<Parameters<typeof runChat>[0]> = {}) {
  const { model, calls } = scripted(turns);
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content: 'this HTTP step fails with 401, fix it' }], workflow: triage(), selectedNodeId: SELECTED, runs: failed401, model, types, onEvent: (e) => events.push(e), ...extra });
  return { calls, events, proposals: events.filter((e) => e.type === 'proposal') as Proposal[] };
}
const settingsOf = (p: Proposal, node: string) => (p.ops as AssistantOp[]).flatMap((op) => (op.op === 'setNodeSettings' && op.node === node ? [op.settings] : []))[0];

// ---------------------------------------------------------------------------------------------------------------------
// 1. Scope join (SB07 → SB09, SB10, SB11; contracts/sb2/scope.md)
// ---------------------------------------------------------------------------------------------------------------------

describe('1. the scope join', () => {
  const retry = { op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3, retryOnFail: true } };
  const wander = [retry, { op: 'addNode', ref: 'x', type: 'core.set', name: 'Extra', after: 'Save to backlog' }, { op: 'setNodeSettings', node: 'Save to backlog', settings: { timeoutSeconds: 30 } }];

  it('(a) SB10: the system prompt holds the selected step whole, its settings and its credential state', async () => {
    const { calls } = await chat([{ text: 'It needs a credential.' }]);
    const system = String(calls[0].system);
    expect(BODY.length).toBeGreaterThan(4000);
    expect(system).toContain('END_OF_BODY');
    expect(system).toContain('Settings: defaults');
    expect(system).toContain('httpHeaderAuth: not set');
    expect(system).toContain('Scope: Only “Open status incident”');
  });

  it('(b) SB07: a change outside the step goes back once, then is left out and listed', async () => {
    const { calls, proposals } = await chat([propose('c1', wander), propose('c2', wander), { text: 'Done.' }]);
    expect(toolResult(calls, 1)).toMatch(/outside what was asked/i);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toEqual([retry]);
    expect(proposals[0].dropped.filter((d) => d.startsWith('Left out'))).toHaveLength(2);
  });

  it('(c) SB09 inside the scope: tries alone turn retry on, and a header from the data goes back once naming the input', async () => {
    const tries = await chat([propose('c1', [{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3 } }]), { text: 'Done.' }]);
    expect(tries.proposals).toHaveLength(1);
    expect(settingsOf(tries.proposals[0], 'Open status incident')).toMatchObject({ maxTries: 3, retryOnFail: true });

    const header = [{ op: 'setParameters', node: 'Open status incident', parameters: { headers: { header: [{ name: 'Authorization', value: 'Bearer {{ $json.api_token }}' }] } } }];
    const { calls, proposals } = await chat([propose('c1', header), { text: 'Pick a credential instead.' }]);
    const back = toolResult(calls, 1);
    expect(back).toMatch(/builds its Authorization header from the data/);
    expect(back).toContain('title');
    expect(back).toContain('priority');
    // Sent back, never a step added outside the scope for it.
    expect(proposals.flatMap((p) => p.ops as AssistantOp[]).filter((op) => op.op === 'addNode')).toEqual([]);
  });

  it('(d) SB11: ask_user is offered; the "Several steps fit" backstop only without a scope', async () => {
    expect(TOOLS.map((t) => t.name)).toContain('ask_user');
    const scoped = await chat([propose('c1', [retry]), { text: 'Done.' }], { workflow: twoHttp(), messages: [{ role: 'user', content: 'it should retry 3 times' }] });
    expect(scoped.calls[0].tools?.map((t) => t.name)).toContain('ask_user');
    expect(toolResult(scoped.calls, 1)).not.toContain('Several steps fit');
    expect(scoped.proposals).toHaveLength(1);

    const none = await chat([propose('c1', [retry]), { text: 'Which one?' }], { workflow: twoHttp(), selectedNodeId: undefined, messages: [{ role: 'user', content: 'it should retry 3 times' }] });
    // A settings change fits every step that calls out (SB11's rule): both HTTP steps among them.
    const back = toolResult(none.calls, 1);
    expect(back).toContain('Several steps fit (');
    expect(back).toContain('“Open status incident”');
    expect(back).toContain('“Notify status page”');
    expect(none.proposals).toHaveLength(0);
  });

  it('(e) scope: null lifts the scope only: SB09 still holds', async () => {
    const lifted = await chat([propose('c1', wander), { text: 'Done.' }], { scope: null });
    expect(lifted.proposals).toHaveLength(1);
    expect(lifted.proposals[0].ops).toHaveLength(3);
    expect(String(lifted.calls[0].system)).not.toContain('Scope:');
    const tries = await chat([propose('c1', [{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3 } }]), { text: 'Done.' }], { scope: null });
    expect(settingsOf(tries.proposals[0], 'Open status incident')).toMatchObject({ retryOnFail: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Credential offer → diff card (SB12 → SB08)
// ---------------------------------------------------------------------------------------------------------------------

describe('2. the credential offer and the diff card', () => {
  const auth: AssistantOp[] = [{ op: 'setParameters', node: 'Open status incident', parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } }];
  const plain = () => triage({ authentication: 'none' });

  it('a proposal then a credential event; the parts; the diff shows the parameter, never a credential; Apply keeps the pick', async () => {
    const { events } = await chat([propose('c1', auth), { text: 'Pick the token on the card.' }], { workflow: plain() });
    const kinds = events.map((e) => e.type).filter((t) => t === 'proposal' || t === 'credential');
    expect(kinds).toEqual(['proposal', 'credential']);
    const offer = events.find((e) => e.type === 'credential') as Extract<ChatEvent, { type: 'credential' }>;
    expect(offer).toMatchObject({ node: 'Open status incident', nodeId: SELECTED, credentialTypes: ['httpHeaderAuth'] });
    expect(JSON.stringify(offer)).not.toMatch(/"id"|"value"|"data"/);

    // The editor turns the two events into a proposal part and a "Needs you" part.
    let turn: AssistantTurn = { id: 'r1', role: 'assistant', parts: [] } as unknown as AssistantTurn;
    for (const event of events.filter((e) => e.type === 'proposal' || e.type === 'credential')) turn = applyStreamEvent(turn, event as never);
    expect(turn.parts.map((p) => p.kind)).toEqual(['proposal', 'needs']);
    const proposal = (turn.parts[0] as { proposal: { ops: AssistantOp[] } }).proposal;

    // The card's diff: Authentication None → Generic Credential Type, and no credential line.
    const lookup = registryLookup(types);
    const http = registry.nodeTypes().find((t) => t.type === 'core.httpRequest')!;
    useEditor.getState().load(plain(), [http, ...types]);
    const canvas = useEditor.getState().toWorkflow();
    const diff = diffOps(canvas, proposal.ops, lookup);
    const fields = diff.steps.find((s) => s.node === 'Open status incident')!.fields;
    expect(fields.find((f) => f.key === 'authentication')).toMatchObject({ label: 'Authentication', before: 'None', after: 'Generic Credential Type' });
    expect(fields.some((f) => /credential/i.test(f.key))).toBe(false);

    // The picker's store action, then Apply: the step has the parameters and the pick.
    expect(setStepCredential(SELECTED, 'Open status incident', 'httpHeaderAuth', { id: 'cred_echo', name: 'Echo token' })).toBe(true);
    const picked = useEditor.getState().toWorkflow();
    expect(diffOps(picked, proposal.ops, lookup).steps.flatMap((s) => s.fields).some((f) => /credential/i.test(f.key))).toBe(false);
    expect(applyChanges([{ ops: proposal.ops, kind: 'proposal' }], 'Applied 1 change', { quiet: true })).toBe(true);
    const step = useEditor.getState().toWorkflow().nodes.find((n) => n.id === SELECTED)!;
    expect(step.parameters).toMatchObject({ authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' });
    expect(step.credentials?.httpHeaderAuth).toEqual({ id: 'cred_echo', name: 'Echo token' });
  });

  it('for a step the proposal adds, the event has no nodeId and the picker finds it by name after Apply', async () => {
    const add: AssistantOp[] = [{ op: 'addNode', ref: 'h2', type: 'core.httpRequest', name: 'Call status API', after: 'Open status incident', parameters: { method: 'GET', url: 'http://127.0.0.1:3399/incidents', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } }];
    const { events } = await chat([propose('c1', add), { text: 'Pick its token.' }], { workflow: plain(), selectedNodeId: undefined, messages: [{ role: 'user', content: 'add a step after Open status incident that reads http://127.0.0.1:3399/incidents' }] });
    const offer = events.find((e) => e.type === 'credential') as Extract<ChatEvent, { type: 'credential' }>;
    expect(offer).toBeDefined();
    expect(offer.node).toBe('Call status API');
    expect(offer.nodeId).toBeUndefined();
    const proposal = events.find((e) => e.type === 'proposal') as Proposal;
    useEditor.getState().load(plain(), types);
    expect(applyChanges([{ ops: proposal.ops as AssistantOp[], kind: 'proposal' }], 'Applied 1 change', { quiet: true })).toBe(true);
    expect(setStepCredential(undefined, 'Call status API', 'httpHeaderAuth', { id: 'cred_echo', name: 'Echo token' })).toBe(true);
    expect(useEditor.getState().toWorkflow().nodes.find((n) => n.name === 'Call status API')!.credentials?.httpHeaderAuth).toEqual({ id: 'cred_echo', name: 'Echo token' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Model pick → chat, draft, architect, spend (SB19)
// ---------------------------------------------------------------------------------------------------------------------

const post = (path: string, body: unknown) => new Request(`http://sb2-joins.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Route = (request: Request) => Promise<Response>;
const call = (route: unknown, request: Request) => (route as Route)(request);
const usage = () => database().all<{ surface: string | null; purpose: string | null; model: string; provider: string }>('SELECT surface, purpose, model, provider FROM ai_usage ORDER BY at');
const sse = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; model?: string });
const small = { name: 'W', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} }], connections: [] };

describe('3. the model pick', () => {
  it('(a, b, d) the chat on qwen3.8 and a draft through the gateway are both Spotlight’s, with their models, in the spend report', async () => {
    ollamaQueue.push('Hello there.');
    const answered = await call(chatRoute.POST, post('/api/assistant/chat', { messages: [{ role: 'user', content: 'Hello' }], workflow: small, model: 'qwen3.8' }));
    expect(answered.status).toBe(200);
    const done = sse(await answered.text()).find((e) => e.type === 'done');
    expect(done?.model).toContain('qwen3.8');
    expect(usage()).toEqual([{ surface: 'spotlight', purpose: 'answer', provider: 'ollama', model: 'qwen3.8' }]);

    process.env.LANDFLOW_LLM_GATEWAY_URL = gateway.origin;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = 'sk-fake-master';
    forgetSpotlightModels();
    const before = ollamaAsked.filter((a) => a.path === '/api/chat').length;
    const built = await call(buildRoute.POST, post('/api/ai/build', { prompt: 'set a field', model: 'litellm/qwen3-coder:30b' }));
    expect(built.status).toBe(200);
    const { draft } = (await built.json()) as { draft: { calls?: number } };
    expect(ollamaAsked.filter((a) => a.path === '/api/chat').length).toBe(before);
    expect(gateway.requests.some((r) => r.path === '/v1/chat/completions')).toBe(true);
    const drafted = usage().filter((r) => r.surface === 'spotlight' && r.provider === 'litellm');
    expect(draft.calls).toBe(drafted.length);
    expect(drafted.length).toBeGreaterThan(0);

    const report = aiSpendReport(TEST_OWNER as never, { period: '24h', filters: { surface: 'spotlight' } });
    const models = report.groups.model.map((r) => `${r.key} ${r.label}`).join('\n');
    expect(models).toContain('qwen3.8');
    expect(models).toContain('qwen3-coder:30b');
    expect(report.totals.calls).toBe(1 + drafted.length);
  });

  it('(c) an admin’s saved default reaches the Agent architect, counted under architect', async () => {
    const saved = await call(settingsRoute.PUT, new Request('http://sb2-joins.test/api/settings/spotlight', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8' }) }));
    expect(saved.status).toBe(200);
    ollamaQueue.push('What should it do?');
    const answered = await call(agentRoute.POST, post('/api/assistant/agent', { messages: [{ role: 'user', content: 'make an agent that triages bugs' }] }));
    expect(answered.status).toBe(200);
    await answered.text();
    expect(ollamaAsked.filter((a) => a.path === '/api/chat').map((a) => a.model)).toEqual(['qwen3.8']);
    expect(usage()).toEqual([expect.objectContaining({ surface: 'architect', model: 'qwen3.8' })]);
  });

  it('(e) a model the server does not offer is a 400 on every Spotlight route, with no usage row', async () => {
    const model = 'anthropic/claude-x';
    const requests = [
      [chatRoute.POST, post('/api/assistant/chat', { messages: [{ role: 'user', content: 'Hello' }], workflow: small, model })],
      [buildRoute.POST, post('/api/ai/build', { prompt: 'send an email', model })],
      [designRoute.POST, post('/api/agents/design', { name: 'Triage', model })],
      [agentRoute.POST, post('/api/assistant/agent', { messages: [{ role: 'user', content: 'make one' }], model })],
      [suggestRoute.POST, post('/api/assistant/suggest', { workflow: small, nodeId: 'a', run: { status: 'error', error: { message: 'HTTP 500' } }, model })],
    ] as const;
    for (const [route, request] of requests) expect((await call(route, request)).status).toBe(400);
    expect(usage()).toEqual([]);
    expect(ollamaAsked.filter((a) => a.path === '/api/chat')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Ask × scope (SB11 × SB07)
// ---------------------------------------------------------------------------------------------------------------------

describe('4. ask, then the chip’s answer as the scope', () => {
  it('asks with nothing selected; the chip sends the step as the scope; a change outside it goes back', async () => {
    const asked = await chat([{ toolCalls: [{ id: 'q1', name: 'ask_user', input: { question: 'Which step should retry?', choices: ['Open status incident', 'Notify status page'] } }], stopReason: 'tool_use' }], {
      workflow: twoHttp(),
      selectedNodeId: undefined,
      runs: {},
      messages: [{ role: 'user', content: 'it should retry 3 times' }],
    });
    const ask = asked.events.find((e) => e.type === 'ask') as Extract<ChatEvent, { type: 'ask' }>;
    expect(ask).toMatchObject({ question: 'Which step should retry?', choices: ['Open status incident', 'Notify status page'] });
    expect(asked.proposals).toHaveLength(0);

    // The editor: the ask part, then the chip, sent as the editor sends it.
    useEditor.getState().load(twoHttp(), types);
    const sent: Array<{ text: string; options: unknown }> = [];
    const turn = applyStreamEvent({ id: 'r1', role: 'assistant', parts: [] } as unknown as AssistantTurn, ask as never);
    useAssistant.setState({ pending: false, items: [turn], send: (async (text: string, options: unknown) => void sent.push({ text, options })) as never });
    await useAssistant.getState().answerAsk('r1', 'Open status incident');
    expect(sent).toEqual([{ text: 'Open status incident', options: { scope: { kind: 'only', nodes: [SELECTED] } } }]);

    // The route hands `scope` to the chat as it came; the answer's change stays on that step.
    const { scope } = sent[0].options as { scope: { kind: 'only'; nodes: string[] } };
    const retry = (node: string) => ({ op: 'setNodeSettings', node, settings: { maxTries: 3, retryOnFail: true } });
    const answered = await chat([propose('c1', [retry('Open status incident'), retry('Notify status page')]), propose('c2', [retry('Open status incident'), retry('Notify status page')]), { text: 'Done.' }], {
      workflow: twoHttp(),
      selectedNodeId: undefined,
      runs: {},
      scope,
      messages: [
        { role: 'user', content: 'it should retry 3 times' },
        { role: 'assistant', content: 'Which step should retry?' },
        { role: 'user', content: 'Open status incident' },
      ],
    });
    expect(toolResult(answered.calls, 1)).toMatch(/outside what was asked/i);
    expect(answered.proposals).toHaveLength(1);
    expect(answered.proposals[0].ops).toEqual([retry('Open status incident')]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Suggestion after a block × metering (SB09 × SB19)
// ---------------------------------------------------------------------------------------------------------------------

describe('5. the suggestion after a block', () => {
  const flow = { name: 'Orders', nodes: [small.nodes[0], { id: 'h', name: 'Send to echo', type: 'core.httpRequest', typeVersion: 1, position: [280, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3415/vip' } }], connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'h', targetIndex: 0 }] };
  const suggest = (message: string) => call(suggestRoute.POST, post('/api/assistant/suggest', { workflow: flow, nodeId: 'h', run: { status: 'error', durationMs: 3, error: { message }, inputs: [{ count: 1, sample: [{}] }], outputs: [] } }));

  it('a blocked run: skipped, no model call, no usage row', async () => {
    const response = await suggest('Blocked: 127.0.0.1 resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggestions: [], skipped: expect.stringContaining('This host blocks') });
    expect(ollamaAsked.filter((a) => a.path === '/api/chat')).toEqual([]);
    expect(usage()).toEqual([]);
  });

  it('an HTTP 500: one Spotlight row, and a suggestion that moves the URL to httpbin comes back with no ops', async () => {
    ollamaQueue.push(JSON.stringify({ suggestions: [{ kind: 'fix', title: 'Change localhost URL to external address', detail: 'Use a public endpoint.', confidence: 0.9, ops: [{ op: 'setParameters', node: 'Send to echo', parameters: { url: 'https://httpbin.org/post' } }] }] }));
    const response = await suggest('HTTP 500 Internal Server Error');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { suggestions: Array<{ ops: unknown[]; title: string }> };
    expect(usage().map((r) => `${r.surface}/${r.purpose}`)).toEqual(['spotlight/answer']);
    expect(body.suggestions.every((s) => s.ops.length === 0)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('httpbin.org');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Scope × workflow settings (SB07 × SB10)
// ---------------------------------------------------------------------------------------------------------------------

describe('6. a selected step and a change to the workflow’s own settings', () => {
  const timeout = [{ op: 'setWorkflowSettings', settings: { timeoutSeconds: 300 } }];

  it('a workflow time limit asked with a step selected is one card with setWorkflowSettings, never sent back', async () => {
    for (const content of ['stop the workflow if it runs longer than 5 minutes', 'set the workflow timeout to 300 seconds']) {
      const { calls, proposals } = await chat([propose('c1', timeout), { text: 'Done.' }], { runs: {}, messages: [{ role: 'user', content }] });
      expect(String(calls[0].system)).toContain('Scope: Only “Open status incident”');
      expect(String(calls[0].system)).toContain('is setWorkflowSettings');
      expect(toolResult(calls, 1)).not.toMatch(/outside what was asked/i);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].ops).toEqual(timeout);
      expect(proposals[0].dropped).toEqual([]);
    }
  });

  it('a scope asked for in words ("only") still keeps the workflow’s settings out', async () => {
    const { calls, proposals } = await chat([propose('c1', timeout), propose('c2', timeout), { text: 'Done.' }], { runs: {}, messages: [{ role: 'user', content: 'only Open status incident: stop it after 5 minutes' }] });
    expect(toolResult(calls, 1)).toMatch(/setWorkflowSettings: outside what was asked/);
    expect(proposals.flatMap((p) => p.ops)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Checks × ask (SB09 × SB11)
// ---------------------------------------------------------------------------------------------------------------------

describe('7. the checks read the request across a question back', () => {
  /** Two schedule triggers: the bug triage one and a "Morning" one. */
  const twoSchedules = (): Workflow => {
    const wf = triage();
    wf.nodes.push({ id: 'n_sch2', name: 'Morning', type: 'core.schedule', typeVersion: 1, position: [0, 300], parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] } } });
    wf.connections.push({ id: 'c_sch2', type: 'main', source: 'n_sch2', sourceIndex: 0, target: 'n_lin', targetIndex: 0 });
    return wf;
  };
  const askTurn = (question: string, choices: string[]): Partial<ModelTurn> => ({ toolCalls: [{ id: 'q1', name: 'ask_user', input: { question, choices } }], stopReason: 'tool_use' });

  /** The question, then the chip as the editor sends it: the messages and scope of the request that follows. */
  async function answered(workflow: Workflow, request: string, question: string, choices: string[], choice: string) {
    const asked = await chat([askTurn(question, choices)], { workflow, selectedNodeId: undefined, runs: {}, messages: [{ role: 'user', content: request }] });
    const turn = asked.events.reduce((t, e) => (e.type === 'ask' || e.type === 'text' ? applyStreamEvent(t, e as never) : t), { id: 'r1', role: 'assistant', parts: [], text: '' } as unknown as AssistantTurn);
    expect(turn.parts.map((p) => p.kind)).toContain('ask');
    useEditor.getState().load(workflow, types);
    useEditor.setState({ openNodeId: undefined, nodes: useEditor.getState().nodes.map((n) => ({ ...n, selected: false })) } as never);
    vi.mocked(streamEvents).mockClear();
    useAssistant.setState({ pending: false, items: [{ id: 'u1', role: 'user', text: request } as never, turn], send: realSend });
    await useAssistant.getState().answerAsk('r1', choice);
    const body = vi.mocked(streamEvents).mock.calls.at(-1)?.[1] as { messages: Array<{ role: 'user' | 'assistant'; content: string }>; scope?: { kind: 'only'; nodes: string[] } };
    useAssistant.setState({ pending: false, abort: undefined });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: choice });
    return body;
  }
  const quiet = (calls: GenerateInput[], proposals: Proposal[]) => {
    expect(toolResult(calls, 1)).not.toMatch(/did not ask for|named no days/);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].warnings.join(' ')).not.toMatch(/did not ask for|named no days/);
  };

  it('a Monday schedule for "run it on Mondays at 9", after "Which schedule?" → "Morning": no send-back, no caution', async () => {
    const body = await answered(twoSchedules(), 'run it on Mondays at 9', 'Which schedule?', ['Morning', 'Weekdays at 8'], 'Morning');
    expect(body.scope).toEqual({ kind: 'only', nodes: ['n_sch2'] });
    const monday = [{ op: 'setParameters', node: 'Morning', parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1' }] } } }];
    const { calls, proposals } = await chat([propose('c1', monday), { text: 'Done.' }], { workflow: twoSchedules(), selectedNodeId: undefined, runs: {}, messages: body.messages, scope: body.scope });
    quiet(calls, proposals);

    // The control: the same answer with no question before it is read alone, and the Monday schedule goes back.
    const alone = await chat([propose('c1', monday), { text: 'Done.' }], { workflow: twoSchedules(), selectedNodeId: undefined, runs: {}, messages: [{ role: 'user', content: 'Morning' }] });
    expect(toolResult(alone.calls, 1)).toMatch(/named no days/);
  });

  it('continue on error for "continue on error", after "Which step?" → a step: no send-back, no caution', async () => {
    const body = await answered(twoHttp(), 'continue on error', 'Which step?', ['Open status incident', 'Notify status page'], 'Notify status page');
    expect(body.scope).toEqual({ kind: 'only', nodes: ['n_http2'] });
    const onError = [{ op: 'setNodeSettings', node: 'Notify status page', settings: { onError: 'continue' } }];
    const { calls, proposals } = await chat([propose('c1', onError), { text: 'Done.' }], { workflow: twoHttp(), selectedNodeId: undefined, runs: {}, messages: body.messages, scope: body.scope });
    quiet(calls, proposals);
    expect(proposals[0].ops).toEqual(onError);
  });
});
