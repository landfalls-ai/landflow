/**
 * Wave sb3's join tests (carryover-sb3.md §2): each contract between two packages of the wave, with both real sides and
 * no fake between them. Only the edges are stubbed: the models (a fake Ollama for the builder and the Agent architect, a
 * scripted model for the agent itself and the eval gate's judge, a scripted LanguageModel for the chat), and the browser's
 * HTTP client, which goes straight to the real route handlers.
 *
 * 1. Plan → parameters → summary (SB13 → SB14 → SB15; contracts/sb3/build-plan.ts), on B1 (sb00.ts, the Linear/Slack ask).
 * 2. Brief → card → smoke test → publish (SB17 → SB16 → SB18; contracts/sb3/agent-card.ts), the PR-review ask on an empty canvas.
 * 3. Empty canvas → the starter flow runs the agent (SB16 × SB18 × the engine).
 * 4. The chat's new agent keeps what was asked (SB16 × SB17), sb05's ask.
 * 6. The contract copies are byte-identical to backbone/contracts (LANDFLOW_BACKBONE_CONTRACTS names that folder).
 * (5, the scenario suite under both time zones, is the gate's command, not a test here.)
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { estimatedTokens, planEdges, planLines, planProblems, PROMPT_TOKEN_BUDGET, type BuildPlan } from '@/lib/shared/build-plan';
import { starterSample, type AgentCard } from '@/lib/shared/agent-card';
import { summaryText, type DraftSummary } from '@/lib/shared/draft-summary';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeModels, type FakeReply } from './fake-ai-services';

// ---------------------------------------------------------------------------
// The edges: models and the browser's client
// ---------------------------------------------------------------------------

/** The fake Ollama's script: the plan replies in order, each step's replies by its name, the architect's design. */
const script = { plans: [] as string[], steps: {} as Record<string, string[]>, design: undefined as Record<string, unknown> | undefined, prompts: [] as string[] };
type OllamaBody = { messages?: Array<{ role: string; content?: string }>; tools?: Array<{ function?: { name: string }; name?: string }> };
const fake = await startFakeModels({
  reply: (_provider, raw): FakeReply => {
    const body = (raw ?? {}) as OllamaBody;
    const messages = body.messages ?? [];
    const firstUser = String(messages.find((m) => m.role === 'user')?.content ?? '');
    const system = String(messages.find((m) => m.role === 'system')?.content ?? '');
    const last = messages.at(-1);
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
    script.prompts.push(firstUser);
    if (/Plan this workflow/.test(firstUser)) return { text: script.plans.length > 1 ? script.plans.shift()! : (script.plans[0] ?? '{}'), usage: { input: estimatedTokens(firstUser.length), output: 40 } };
    const step = /This step: “([^”]*)”/.exec(firstUser)?.[1];
    if (step) {
      const list = script.steps[step] ?? ['{"parameters":{}}'];
      return { text: list.length > 1 ? list.shift()! : list[0], usage: { input: estimatedTokens(firstUser.length), output: 30 } };
    }
    if (tools.includes('propose_design') && last?.role !== 'tool' && script.design) return { toolCalls: [{ id: 'd1', name: 'propose_design', arguments: script.design }] };
    if (/You write test cases/.test(system)) return { text: 'Review pull request 12 => Names the practices it breaks\nIs pull request 7 fine? => Answers from the check\nMerge pull request 3 => Says it only reviews' };
    return { text: 'Done.' };
  },
});

// The agent's own model (the smoke test, the run) and the eval gate's judge: scripted, as SB18's tests do.
const agentSide = vi.hoisted(() => ({ reply: 'Looks fine: it follows the practices.' as string | Error, score: 5, asked: [] as string[] }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  // The host's local model (agentResources lists it, so the design gets it).
  modelOptions: async (provider: string) => (provider === 'ollama' ? [{ provider: 'ollama', model: 'qwen3-coder:30b', label: 'qwen3-coder:30b', description: 'tools ✓' }] : []),
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        if ((input.system ?? '').includes('"score"')) return { text: JSON.stringify({ score: agentSide.score, reasoning: 'scripted' }), toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
        const user = input.messages.findLast((m) => m.role === 'user');
        agentSide.asked.push(typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content));
        if (agentSide.reply instanceof Error) throw agentSide.reply;
        return { text: agentSide.reply, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
  },
}));

// The browser's client: every path goes to its real route handler; the calls are kept in order.
const wire = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; json?: unknown }>, impl: undefined as undefined | ((path: string, init: { method?: string; json?: unknown }) => Promise<unknown>) }));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => wire.impl!(path, init)),
  streamEvents: vi.fn(),
}));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const ENV = {
  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-sb3-joins-')),
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_BUILDER_MODEL: 'qwen3-coder:30b',
  OLLAMA_URL: fake.url.replace(/\/v1$/, ''),
};
const UNSET = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY'];
const previousEnv = { ...process.env };
for (const key of UNSET) delete process.env[key];
Object.assign(process.env, ENV);

const { ApiError } = await import('@/lib/client/api');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { agentStore } = await import('@/lib/server/agents/store');
const { listCases } = await import('@/lib/server/agents/eval-gate');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault'); // AG05:
const { runWorkflow } = await import('@/lib/server/runner');
const { replyText } = await import('@/lib/server/streaming');
const { buildPlanFirst } = await import('@/lib/server/assistant/build-plan');
const { cronProblems } = await import('@/lib/server/assistant/change-checks');
const { runChat } = await import('@/lib/server/assistant/chat');
type ChatEvent = Parameters<Parameters<typeof runChat>[0]['onEvent']>[0];
const { designAgent } = await import('@/lib/server/assistant/architect');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const buildRoute = await import('@/app/api/ai/build/route');
const planRoute = await import('@/app/api/ai/build/plan/route');
const designRoute = await import('@/app/api/agents/design/route');
const importRoute = await import('@/app/api/agents/import/route');
const evalGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const smokeRoute = await import('@/app/api/agents/[id]/smoke-test/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const previewRoute = await import('@/app/api/expressions/preview/route');
const { plugin: linear } = await import('../../../plugins/linear/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { plugin: github } = await import('../../../plugins/github/src/main');
const { useEditor } = await import('@/components/editor/store');
const { useAssistant } = await import('@/components/editor/assistant');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { noteOpened, useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');
const { cardAskFor, createFromCard, designAgentCard } = await import('@/components/editor/spotlight/agent-ask');
const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
const { buildIt } = await import('@/components/editor/spotlight/plan-part');
const { agentStep } = await import('@/components/editor/timeline');
const { publishAgentFor } = await import('@/components/editor/new-agent');

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, method: string, path: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Handler)(new Request(`http://localhost:3000${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
};

let github_: { id: string; name: string } | undefined;
const pickedGithub = () => (github_ ??= (({ id, name }) => ({ id, name }))(credentials.create({ name: 'GitHub (picked)', type: 'github.githubApi', data: { accessToken: 'ghp_made_up_for_the_test' } })));

wire.impl = async (path, init) => {
  const method = init.method ?? 'GET';
  if (!/\/versions$/.test(path)) wire.calls.push({ method, path, json: init.json });
  const id = /^\/api\/agents\/([^/]+)\/[a-z-]+$/.exec(path)?.[1];
  let result: { status: number; body: Record<string, any> };
  // The editor reads the workflow's versions for its autonomy (D1): a new workflow has none.
  if (/^\/api\/workflows\/[^/]+\/versions$/.test(path)) return { versions: [] };
  if (path === '/api/ai/build/plan') result = await call(planRoute.POST, 'POST', path, init.json);
  else if (path === '/api/ai/build') result = await call(buildRoute.POST, 'POST', path, init.json);
  else if (path === '/api/agents/design') {
    result = await call(method === 'DELETE' ? designRoute.DELETE : designRoute.POST, method, path, init.json);
    // AG05: the smoke test is honest now (a node tool with no credential is not tested), so the person's pick of a GitHub credential is part of the story.
    const config = result.body.config as { tools?: Array<{ type: string; nodeType?: string; credentials?: unknown }> } | undefined;
    for (const tool of config?.tools ?? []) if (tool.type === 'node' && tool.nodeType === 'github.github') tool.credentials = { githubApi: pickedGithub() };
  }
  else if (path === '/api/agents/import') result = await call(importRoute.POST, 'POST', path, init.json);
  else if (path === '/api/expressions/preview') result = await call(previewRoute.POST, 'POST', path, init.json);
  else if (id && path.endsWith('/eval-gate')) result = await call(evalGateRoute.POST, 'POST', path, init.json, { id });
  else if (id && path.endsWith('/smoke-test')) result = await call(smokeRoute.POST, 'POST', path, init.json, { id });
  else if (id && path.endsWith('/publish')) result = await call(publishRoute.POST, 'POST', path, init.json, { id });
  else throw new Error(`unrouted ${method} ${path}`);
  if (result.status >= 400) throw new ApiError(result.body?.error ?? `${result.status}`, result.status, result.body);
  return result.body;
};

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(linear);
  registry.registerBuiltin(messaging);
  registry.registerBuiltin(github);
  types = registry.nodeTypes().filter((t) => t.available);
});
afterAll(async () => {
  await fake.close();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  script.plans = [];
  script.steps = {};
  script.design = undefined;
  script.prompts.length = 0;
  fake.requests.length = 0;
  wire.calls.length = 0;
  agentSide.reply = 'Looks fine: it follows the practices.';
  agentSide.score = 5;
  agentSide.asked.length = 0;
  enableTestAuth(TEST_OWNER);
  database().sqlite.exec('DELETE FROM ai_usage');
  useAssistant.getState().reset();
  useAutonomous.setState({ on: false });
});

const spotlightRows = () => database().all<{ surface: string | null }>('SELECT surface FROM ai_usage').filter((r) => r.surface === 'spotlight').length;
const json = (value: unknown) => JSON.stringify(value);

// ---------------------------------------------------------------------------
// 1. Plan → parameters → summary
// ---------------------------------------------------------------------------

const B1 = 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table';
const PLAN_B1 = {
  name: 'Bug triage',
  steps: [
    { key: 's1', type: 'core.schedule', name: 'Every weekday at 8', does: 'Run every weekday at 8' },
    { key: 's2', type: 'linear.linear', name: 'Get bug issues', does: 'Read new Linear issues labelled bug', from: 's1' },
    { key: 's3', type: 'core.aiAgent', name: 'Triage each issue', does: 'Give each issue a P0–P3 and a reason', from: 's2', reads: ['title'] },
    { key: 's4', type: 'core.if', name: 'Is it P0', does: 'Tell P0 from the rest', from: 's3', reads: ['output'] },
    { key: 's5', type: 'messaging.slack', name: 'Post P0 to Slack', does: 'Post P0s to #oncall', from: 's4', output: 0 },
    { key: 's6', type: 'core.dataTable', name: 'Save the rest', does: 'Put the other issues in a data table', from: 's4', output: 1 },
  ],
  assumptions: ['“every weekday at 8” read as 8:00 on weekdays'],
  cannot: [],
};
function scriptB1(firstPlan?: unknown) {
  script.plans = [...(firstPlan ? [json(firstPlan)] : []), json(PLAN_B1)];
  script.steps = {
    'Every weekday at 8': [json({ parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } })],
    'Get bug issues': [json({ parameters: { resource: 'issue', operation: 'getManySince' }, testData: [{ title: 'Login fails', summary: 'Cannot sign in' }] })],
    'Triage each issue': [json({ parameters: { prompt: 'Triage this issue into P0, P1, P2 or P3 with a reason: {{ $json.title }}' } })],
    'Is it P0': [json({ parameters: { conditions: { condition: [{ left: '{{ $json.output }}', operator: 'contains', right: 'P0' }] }, combinator: 'and' } })],
    'Post P0 to Slack': [json({ parameters: { resource: 'message', operation: 'post', text: "P0: {{ $('Get bug issues').item.json.title }} — {{ $json.output }}" } })],
    'Save the rest': [json({ parameters: { operation: 'insert', columns: { column: [{ column: 'title', value: "{{ $('Get bug issues').item.json.title }}" }] } } })],
  };
}

describe('1. plan → parameters → summary (SB13 → SB14 → SB15)', () => {
  it('(a, b, c, d) the build route plans from searched hits, builds one call per step, keeps every prompt under budget, and summarises the plan', async () => {
    // A first plan naming a type nobody offered is sent back once (SB13).
    scriptB1({ ...PLAN_B1, steps: PLAN_B1.steps.map((s) => (s.key === 's5' ? { ...s, type: 'teams.postMessage' } : s)) });
    const answer = await call(buildRoute.POST, 'POST', '/api/ai/build', { prompt: B1 });
    expect(answer.status).toBe(200);
    const draft = answer.body.draft as { name: string; nodes: Array<{ key: string; type: string; name: string; parameters: Record<string, unknown> }>; edges: Array<[string, string, number, string]>; plan: BuildPlan; stages: Array<{ stage: string; step?: string; inputTokens: number; promptChars: number }>; calls: number; summary: DraftSummary; left: Array<{ node: string; kind: string; text: string }> };

    // (a) SB13: the plan call holds the search's hits, not the whole catalog; the agreed plan passes planProblems.
    // The plan call and its one send-back (the same first message, then the problems).
    const planPrompts = script.prompts.filter((p) => /Plan this workflow/.test(p));
    expect(planPrompts).toHaveLength(2);
    expect(planPrompts[0]).toContain('Node types offered');
    expect(planPrompts[0]).not.toContain('Node catalog:');
    const offeredLines = planPrompts[0].split('Node types offered (use only these):\n')[1].split('\n\n')[0].split('\n');
    // The search's hits (at most CANDIDATE_LIMIT, 24) plus the triggers: never the whole catalog.
    const isTrigger = (line: string) => types.find((t) => t.type === line.split(':')[0])?.descriptor.kind === 'trigger';
    expect(offeredLines.filter((l) => !isTrigger(l)).length).toBeLessThanOrEqual(24);
    expect(offeredLines.length).toBeLessThan(types.length);
    expect(offeredLines.some((l) => l.startsWith('linear.linear:'))).toBe(true);
    expect(offeredLines.some((l) => l.startsWith('messaging.slack:'))).toBe(true);
    expect(draft.stages.filter((s) => s.stage === 'send-back' && !s.step)).toHaveLength(1);
    const offered = new Set(types.map((t) => t.type));
    expect(planProblems(draft.plan, offered, (t) => types.find((i) => i.type === t)?.descriptor.kind === 'trigger')).toEqual([]);
    expect(draft.plan.steps.map((s) => s.type)).toEqual(PLAN_B1.steps.map((s) => s.type));

    // (b) SB14: a call per step, each with only its own node's docs; Slack reads a field Linear outputs; the wiring is the plan's.
    const stepPrompts = script.prompts.filter((p) => /^Request: /.test(p));
    expect(stepPrompts.length).toBe(draft.stages.filter((s) => s.step).length);
    expect(new Set(draft.stages.filter((s) => s.stage === 'node').map((s) => s.step)).size).toBe(draft.stages.filter((s) => s.stage === 'node').length);
    const slackPrompt = stepPrompts.find((p) => p.includes('“Post P0 to Slack”'))!;
    expect(slackPrompt).toContain('messaging.slack');
    expect(slackPrompt).not.toContain('(linear.linear)');
    const slack = draft.nodes.find((n) => n.type === 'messaging.slack')!;
    expect(json(slack.parameters)).toMatch(/\$\('Get bug issues'\)\.item\.json\.title/);
    expect(json(draft.nodes)).not.toMatch(/\$json\.(issues|lastRun)\b/);
    expect(draft.edges).toEqual(planEdges(draft.plan));
    const asWorkflow = (nodes: typeof draft.nodes): Workflow => ({ id: 'wf_b1', name: 'B1', nodes: nodes.map((n) => ({ id: n.key, name: n.name, type: n.type, typeVersion: 1, position: [0, 0] as [number, number], parameters: n.parameters })), connections: [] });
    const schedule = draft.nodes.find((n) => n.type === 'core.schedule')!;
    expect(cronProblems([{ op: 'setParameters', node: schedule.name, parameters: schedule.parameters }], asWorkflow([]), asWorkflow(draft.nodes), { latest: B1 })).toEqual([]);

    // (c) every stage under 6k tokens by max(reported, chars / 4); draft.calls equals the Spotlight usage rows.
    for (const stage of draft.stages) expect(Math.max(stage.inputTokens, estimatedTokens(stage.promptChars))).toBeLessThanOrEqual(PROMPT_TOKEN_BUDGET);
    expect(draft.calls).toBe(draft.stages.length);
    expect(draft.calls).toBe(spotlightRows());

    // (d) SB15: the summary's steps are the plan's lines, its assumptions the plan's, its left the guarded left with the Linear credential.
    const label = (type: string) => types.find((t) => t.type === type)?.descriptor.displayName ?? type;
    expect(draft.summary.steps).toEqual(planLines(draft.plan, label));
    expect(draft.summary.assumptions).toEqual(expect.arrayContaining(PLAN_B1.assumptions));
    expect(draft.summary.left).toEqual(draft.left);
    const linearCredential = draft.summary.left.find((l) => l.kind === 'credential' && l.node === 'Get bug issues');
    expect(linearCredential).toBeDefined();
    expect(summaryText(draft.name, draft.summary)).toContain('Get bug issues');
  });

  it('(d) the editor: the plan card waits for Build it, then one sentence, the summary part and the test action', async () => {
    scriptB1();
    useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId: 'wf_sb3_b1' });
    const build = async (prompt: string, _signal?: AbortSignal, plan?: BuildPlan) => {
      const { draft } = (await wire.impl!('/api/ai/build', { method: 'POST', json: { prompt, ...(plan && { plan }) } })) as { draft: { name: string; nodes: unknown[]; summary?: DraftSummary; model: string; durationMs: number; pinData?: Record<string, unknown> } };
      return { name: draft.name, nodes: draft.nodes.length, pinned: Boolean(draft.pinData), summary: draft.summary, model: draft.model, durationMs: draft.durationMs } as never;
    };
    const drafting = draftWholeFlow(B1, build);
    await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'))).toBe(true));
    // Asks-first: nothing is built until Build it.
    expect(wire.calls.map((c) => c.path)).toEqual(['/api/ai/build/plan']);
    const card = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'))!;
    expect(buildIt(card.id)).toBe(true);
    await drafting;
    expect(wire.calls.map((c) => c.path)).toEqual(['/api/ai/build/plan', '/api/ai/build']);
    expect(wire.calls[1].json).toMatchObject({ plan: { name: 'Bug triage' } });
    const reply = useAssistant.getState().items.at(-1)!;
    const parts = reply.role === 'assistant' ? reply.parts : [];
    expect(parts.map((p) => p.kind)).toEqual(['text', 'summary', 'action']);
    expect(parts[0].kind === 'text' && parts[0].text).toMatch(/^Built “Bug triage” in 6 steps[^.]*\.$/);
    const summary = parts[1].kind === 'summary' ? parts[1].summary : undefined;
    // D2: the credential is an item to pick, never picked: no step holds a credential.
    expect(summary?.left.some((l) => l.kind === 'credential')).toBe(true);
    expect(json(useEditor.getState().nodes.map((n) => n.data.wf.credentials ?? null))).not.toMatch(/"id"/);
  });

  it('(e) the brain writer’s buildPlanFirst(prompt, model), with no options, builds staged', async () => {
    scriptB1();
    const draft = await buildPlanFirst(B1, 'qwen3-coder:30b');
    expect(draft.plan?.name).toBe('Bug triage');
    expect(draft.stages?.[0].stage).toBe('plan');
    expect(draft.nodes).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 2 and 3. Brief → card → smoke test → publish; the starter flow runs the agent
// ---------------------------------------------------------------------------

const PR_ASK = 'create an agent that reviews pull requests against our practices, and run it after Sample PR';
const DESIGN = {
  summary: 'A pull request reviewer',
  name: 'PR reviewer',
  role: 'Pull request reviewer',
  description: 'Reviews pull requests against our approved practices.',
  instructions: 'Input: a pull request.\nSteps: read it, check the practices.\nOutput: what breaks a practice.\nHand over when: it is not a review.',
  model: 'ollama/qwen3-coder:30b',
  nodeTools: 'github.github, messaging.slack',
};

async function designCard(workflowId: string) {
  script.design = DESIGN;
  useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId, nodeTypes: Object.fromEntries(types.map((t) => [t.type, t])) as never });
  const ask = cardAskFor(PR_ASK);
  expect(ask).toBeDefined();
  await designAgentCard(PR_ASK, ask!, { starter: true });
}
const cardOf = (): { id: string; card: AgentCard } => {
  for (const item of useAssistant.getState().items) if (item.role === 'assistant') for (const p of item.parts) if (p.kind === 'agentCard') return { id: item.id, card: p.card };
  throw new Error('no agent card');
};
const agentRow = (agentId: string) => useAssistant.getState().agents.find((a) => a.agentId === agentId);
const editorWorkflow = (): Workflow => ({ ...useEditor.getState().toWorkflow(), id: useEditor.getState().workflowId });

describe('2. brief → card → smoke test → publish (SB17 → SB16 → SB18)', () => {
  it('(a, b, c) asks-first: the card carries the brief, Create imports it with its cases and the starter flow, the smoke test passes, Publish waits for the click', async () => {
    await designCard('wf_sb3_pr_ask');
    // (a) SB16: no flow build; the design route's preview saved nothing; the card is SB17's brief.
    expect(wire.calls.map((c) => c.path)).toEqual(['/api/agents/design']);
    expect(wire.calls[0].json).toMatchObject({ preview: true });
    expect(agentStore.list().some((a) => a.name === 'PR reviewer')).toBe(false);
    const { id, card } = cardOf();
    expect(card.practices).toBe(true);
    expect(card.tools.some((t) => /practice/i.test(t.name))).toBe(true);
    const githubTools = card.tools.filter((t) => t.type === 'github.github');
    expect(githubTools.length).toBeGreaterThan(0);
    for (const t of githubTools) expect(!t.writes || t.requireApproval).toBe(true);
    expect(card.tools.some((t) => t.type === 'messaging.slack')).toBe(false);
    expect(card.guardrails.length).toBeGreaterThan(0);
    expect(card.cases.length).toBeGreaterThanOrEqual(3);
    expect(card.cases.length).toBeLessThanOrEqual(5);

    // (b) Create: one import, one eval-gate post per case, the starter flow with the new agent and the pinned chat input.
    await createFromCard(id, card);
    const created = cardOf().card;
    expect(created.state).toBe('created');
    const agentId = created.agentId!;
    expect(wire.calls.filter((c) => c.path === '/api/agents/import')).toHaveLength(1);
    expect(wire.calls.filter((c) => c.path.endsWith('/eval-gate'))).toHaveLength(card.cases.length);
    expect(listCases(agentId).map((c) => c.input).sort()).toEqual(card.cases.map((c) => c.input).sort());
    const nodes = useEditor.getState().nodes;
    expect(nodes.map((n) => n.data.wf.type)).toEqual(['core.chatTrigger', 'core.messageAgent']);
    expect(nodes[1].data.wf.parameters.agentId).toBe(agentId);
    expect(useEditor.getState().pinData[nodes[0].id]?.[0]?.json).toMatchObject({ chatInput: starterSample(card) });

    // (c) SB18: the smoke test ran on the starter's pinned item and passed; asks-first, not published until Publish.
    expect(wire.calls.find((c) => c.path.endsWith('/smoke-test'))?.json).toEqual({ message: starterSample(card) });
    expect(agentRow(agentId)).toMatchObject({ state: 'tested', smoke: { state: 'passed' } });
    expect(agentStep(agentRow(agentId)!).text).toMatch(/tested, 1 of 1 passed/);
    expect(wire.calls.some((c) => c.path.endsWith('/publish'))).toBe(false);
    expect(agentStore.get(agentId)?.published).toBeUndefined();

    // 3 (before publishing): the starter flow's run fails "Publish … first", the published version is what runs.
    const unpublished = await runWorkflow({ workflow: editorWorkflow(), mode: 'manual', startNodeId: nodes[0].id });
    expect(unpublished.status).toBe('error');
    expect(JSON.stringify(unpublished.error)).toMatch(/Publish “PR reviewer” first/);

    expect(await publishAgentFor(nodes[1].id)).toBe(true);
    expect(agentStore.get(agentId)?.published).toBeDefined();
    expect(agentStep(agentRow(agentId)!).text).toMatch(/tested, 1 of 1 passed · published/);
  });

  it('(c) + 3. autonomous on a brand-new draft: created, smoke-tested, published in that order; the starter flow runs the published agent', async () => {
    useAutonomous.setState({ on: true });
    useAutonomyFacts.setState({ switchOn: true, workflows: {} });
    noteOpened('wf_sb3_pr_auto', 0);
    await designCard('wf_sb3_pr_auto');
    await vi.waitFor(() => expect(cardOf().card.state).toBe('created'));
    const agentId = cardOf().card.agentId!;
    await vi.waitFor(() => expect(agentRow(agentId)?.state).toBe('published'));
    const order = wire.calls.map((c) => c.path).filter((p) => /import|smoke-test|publish/.test(p)).map((p) => p.replace(agentId, ':id'));
    expect(order).toEqual(['/api/agents/import', '/api/agents/:id/smoke-test', '/api/agents/:id/publish']);
    expect(agentStep(agentRow(agentId)!).text).toMatch(/^Agent “PR reviewer” tested, 1 of 1 passed · published/);
    expect(wire.calls.some((c) => (c.json as { skipEval?: unknown } | undefined)?.skipEval !== undefined)).toBe(false);

    // 3. The starter flow through the executor with its pinned item: the agent's reply is the run's chat reply.
    agentSide.reply = 'PR 12 breaks the naming practice.';
    const record = await runWorkflow({ workflow: editorWorkflow(), mode: 'manual', startNodeId: useEditor.getState().nodes[0].id });
    expect(record.status).toBe('success');
    expect(replyText(record)).toBe('PR 12 breaks the naming practice.');
  });

  it('(d) the eval gate scores under 3 of 5: the publish is held (409 with the gate), the agent stays a draft and the row names the score', async () => {
    useAutonomous.setState({ on: true });
    useAutonomyFacts.setState({ switchOn: true, workflows: {} });
    noteOpened('wf_sb3_pr_held', 0);
    agentSide.score = 2;
    await designCard('wf_sb3_pr_held');
    await vi.waitFor(() => expect(agentRow(cardOf().card.agentId ?? '')?.held).toBeDefined());
    const agentId = cardOf().card.agentId!;
    expect(agentRow(agentId)?.held).toMatch(/held by the eval gate: 2\.0 \/ 5/);
    expect(agentStore.get(agentId)?.published).toBeUndefined();
    const held = await call(publishRoute.POST, 'POST', `/api/agents/${agentId}/publish`, undefined, { id: agentId });
    expect(held.status).toBe(409);
    expect(held.body.gate).toBeDefined();
  });

  it('(e) a smoke failure: failed, never published, the row says why', async () => {
    useAutonomous.setState({ on: true });
    useAutonomyFacts.setState({ switchOn: true, workflows: {} });
    noteOpened('wf_sb3_pr_fail', 0);
    agentSide.reply = new Error('model offline');
    await designCard('wf_sb3_pr_fail');
    await vi.waitFor(() => expect(cardOf().card.smoke?.state).toBe('failed'));
    const agentId = cardOf().card.agentId!;
    expect(agentStep(agentRow(agentId)!).text).toMatch(/test failed: .*model offline/);
    expect(wire.calls.some((c) => c.path.endsWith('/publish'))).toBe(false);
    expect(agentStore.get(agentId)?.published).toBeUndefined();
  });

  it('(f) ⌘Z of the card’s change removes both steps and deletes the agent; one another workflow uses is kept, naming it', async () => {
    await designCard('wf_sb3_pr_undo');
    await createFromCard(cardOf().id, cardOf().card);
    const agentId = cardOf().card.agentId!;
    useEditor.getState().undo();
    expect(useEditor.getState().nodes).toHaveLength(0);
    await vi.waitFor(() => expect(agentRow(agentId)?.taken).toEqual({ deleted: true }));
    expect(agentStore.get(agentId)).toBeUndefined();

    // A second workflow's step points at the next one: kept, and the row names that workflow.
    useAssistant.getState().reset();
    wire.calls.length = 0;
    await designCard('wf_sb3_pr_undo2');
    await createFromCard(cardOf().id, cardOf().card);
    const kept = cardOf().card.agentId!;
    store.saveWorkflow({ id: 'wf_sb3_other', name: 'Other flow', nodes: [{ id: 'x', name: 'Review', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: kept } }], connections: [] } as never);
    useEditor.getState().undo();
    await vi.waitFor(() => expect(agentRow(kept)?.taken?.deleted).toBe(false));
    expect(agentRow(kept)?.taken?.usedBy?.join()).toMatch(/Other flow/);
    expect(agentStore.get(kept)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. The chat's new agent keeps what was asked
// ---------------------------------------------------------------------------

function scripted(turns: Array<Partial<ModelTurn>>): LanguageModel {
  return {
    provider: 'test',
    model: 'scripted',
    async generate() {
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
}

describe('4. the chat’s new agent keeps what was asked (SB16 × SB17)', () => {
  it('sb05’s ask: the proposal’s newAgent has the Linear tool and the knowledge "docs", and the design honours the tool', async () => {
    const SB05 = 'add an agent after Sample question that answers from our docs and can look up Linear issues';
    const flow: Workflow = {
      id: 'wf_sb05',
      name: 'Sample',
      nodes: [
        { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'b', name: 'Sample question', type: 'core.set', typeVersion: 1, position: [200, 0], parameters: {} },
      ],
      connections: [{ id: 'k1', source: 'a', target: 'b', sourceIndex: 0, targetIndex: 0, type: 'main' }],
    };
    const events: ChatEvent[] = [];
    const agent = { op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers from the docs.', instructions: 'Answer.', after: 'Sample question' };
    await runChat({
      messages: [{ role: 'user', content: SB05 }],
      workflow: flow,
      model: scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'A docs agent', ops: [agent] } }] }, { text: 'Adds the Docs Answerer agent.' }]),
      types,
      onEvent: (e) => events.push(e),
    });
    const proposal = events.find((e): e is Extract<ChatEvent, { type: 'proposal' }> => e.type === 'proposal')!;
    const spec = (proposal.ops[0] as { newAgent?: { name: string; description: string; instructions: string; tools?: string[]; knowledge?: string } }).newAgent!;
    expect(spec.tools?.some((t) => /^Linear:/.test(t))).toBe(true);
    expect(spec.knowledge).toBe('docs');

    // Applying it designs through SB17 with spec.tools honoured: the model proposes no tool, the brief brings Linear back as a read.
    const model = scripted([{ toolCalls: [{ id: 'p1', name: 'propose_agent', input: { summary: 'Draft', name: 'Docs Answerer', role: 'Docs answerer', instructions: 'Answer.', tools: [] } }] }, { text: 'Review pull request 1 => x\nIs it fine? => y\nMerge it => z' }, { text: 'Done.' }]);
    const done = await designAgent({ ...spec, workflow: 'Sample', after: 'Sample question' }, { model: { ...model, provider: 'anthropic' } as LanguageModel, types, actor: TEST_OWNER });
    const linearTool = (done.config.tools ?? []).find((t) => t.type === 'node' && t.nodeType === 'linear.linear') as { parameters?: Record<string, unknown>; requireApproval?: boolean } | undefined;
    expect(linearTool).toBeDefined();
    expect(String(linearTool?.parameters?.operation ?? '')).not.toMatch(/^create|^update|^delete/);
  });
});

// ---------------------------------------------------------------------------
// 6. Contract copies
// ---------------------------------------------------------------------------

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copies.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';
describe.skipIf(!CONTRACTS || !existsSync(CONTRACTS))('6. the contract copies are byte-identical', () => {
  const pairs: Array<[string, string]> = [
    ['src/lib/shared/build-plan.ts', 'sb3/build-plan.ts'],
    // Wave ag2 replaced these two contracts (contracts/ag2, checked in agents-ag2-joins.test.ts).
    ['src/lib/shared/agent-card.ts', 'ag2/agent-card.ts'],
    ['test/spotlight-scenarios/scenario.ts', 'ag2/spotlight-scenario.ts'],
    ['src/lib/shared/spotlight-scope.ts', 'sb2/spotlight-scope.ts'],
    ['src/lib/shared/spotlight-wire.ts', 'sb2/spotlight-wire.ts'],
    ['test/spotlight-scenarios/local-only.cjs', 'sb1/local-only.cjs'],
    ['src/lib/shared/draft-left.ts', 'sb1/draft-left.ts'],
    ['src/components/editor/spotlight-autonomy.ts', 'sb1/spotlight-autonomy.ts'],
  ];
  it.each(pairs)('%s = contracts/%s', (copy, contract) => {
    expect(readFileSync(join(import.meta.dirname, '..', copy), 'utf8')).toBe(readFileSync(join(CONTRACTS, contract), 'utf8'));
  });
});
