/**
 * Stage 1 of the first draft (lib/server/assistant/build-plan.ts, docs/assistant.md "Building a flow in stages"): the
 * candidates a search finds for the ask, the plan the model answers (checked, sent back once, repaired in code), the plan
 * route, the build with a plan (only the plan's types' docs go on), and the plan card's state.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { estimatedTokens, largestPrompt, planProblems, type BuildPlan } from '@/lib/shared/build-plan';

vi.mock('@/lib/client/api', async (original) => ({ ...(await original<typeof import('@/lib/client/api')>()), api: vi.fn() }));

let queue: Array<string | FakeReply> = [];
const fake = await startFakeModels({
  reply: (provider, body) => {
    if (body?.model !== undefined && provider === 'ollama' && !queue.length) return { text: '{}' };
    const next = queue.shift() ?? '{}';
    return typeof next === 'string' ? { text: next } : next;
  },
});
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-build-plan-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const { forgetSpotlightModels } = await import('@/lib/server/assistant/models-list');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { availableTypes } = await import('@/lib/server/assistant/research');
const { allowedTypes } = await import('@/lib/server/assistant/scope');
const { candidatesFor, planFlow, repairPlan, parsePlan, alternativesFor, subnodeProblems } = await import('@/lib/server/assistant/build-plan');
const { buildFlow } = await import('@/lib/server/flow-builder');
const planRoute = await import('@/app/api/ai/build/plan/route');
const buildRoute = await import('@/app/api/ai/build/route');

const B1 = 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table';

type Route = (request: Request) => Promise<Response>;
const post = (path: string, body: unknown) => new Request(`http://build-plan.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const rows = () => database().all<{ surface: string | null; purpose: string | null }>('SELECT surface, purpose FROM ai_usage ORDER BY at');
const chats = () => fake.requests.filter((r) => r.path === '/api/chat');
/** What a model call was sent, as one string (system and every message). */
const sent = (index: number) => JSON.stringify(chats()[index]?.body?.messages ?? []);

const reply = (value: unknown) => JSON.stringify(value);
const GOOD = {
  name: 'Bug triage',
  steps: [
    { key: 's1', type: 'core.schedule', name: 'Every weekday', does: 'Run every weekday at 8' },
    { key: 's2', type: 'linear.linear', name: 'Get bugs', does: 'Read new Linear issues labelled bug', from: 's1' },
    { key: 's3', type: 'core.aiAgent', name: 'Triage', does: 'Triage each issue into P0–P3', from: 's2' },
    { key: 's4', type: 'messaging.slack', name: 'Post P0', does: 'Post P0s to Slack', from: 's3' },
    { key: 's5', type: 'core.dataTable', name: 'Save the rest', does: 'Put the rest in a data table', from: 's3' },
  ],
  assumptions: ['weekdays only'],
  cannot: [],
};

let owner: Awaited<ReturnType<typeof createUser>>;
beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  // The Linear, Messaging and GitHub plugins' real descriptors (their node code runs in this process; nothing starts).
  for (const dir of ['linear', 'messaging', 'github']) {
    const path = ['..', '..', '..', 'plugins', dir, 'src', 'main'].join('/');
    const { plugin } = (await import(/* @vite-ignore */ new URL(path, import.meta.url).href)) as { plugin: Parameters<typeof registry.registerBuiltin>[0] };
    registry.registerBuiltin(plugin);
  }
  owner = await createUser({ email: 'mia@build-plan.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
});
afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  queue = [];
  fake.requests.length = 0;
  forgetSpotlightModels();
  aiUsageMeter().invalidateCaps();
  database().sqlite.exec('DELETE FROM ai_usage');
});

describe('the candidates a search finds', () => {
  it('offers Linear, Messaging and a data table for the B1 ask, at most 24 types besides the triggers', () => {
    const { types } = candidatesFor(B1, availableTypes());
    const names = types.map((t) => t.type);
    expect(names.some((t) => t.startsWith('linear.'))).toBe(true);
    expect(names.some((t) => t.startsWith('messaging.'))).toBe(true);
    expect(names).toContain('core.dataTable');
    expect(names).toContain('core.manualTrigger');
    expect(types.filter((t) => t.descriptor.kind !== 'trigger').length).toBeLessThanOrEqual(24);
    // Not the whole catalog.
    expect(types.length).toBeLessThan(availableTypes().length / 2);
  });

  it('never offers a type the workflow\'s policy blocks', async () => {
    updateGovernancePolicy({ nodes: { mode: 'block', types: ['messaging.slack'], plugins: [] } } as never);
    try {
      const allowed = allowedTypes(undefined, owner as never);
      expect(allowed.some((t) => t.type === 'messaging.slack')).toBe(false);
      expect(candidatesFor(B1, allowed).types.some((t) => t.type === 'messaging.slack')).toBe(false);
      // The route offers the model nothing blocked either.
      queue = [reply({ ...GOOD, steps: GOOD.steps.filter((s) => s.type !== 'messaging.slack') })];
      const response = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1 }));
      expect(response.status).toBe(200);
      expect(sent(0)).not.toContain('messaging.slack:');
    } finally {
      updateGovernancePolicy({ nodes: { mode: 'off', types: [], plugins: [] } } as never);
    }
  });
});

describe('the plan call', () => {
  it('sends no node\'s properties and stays under 6000 tokens for B1 with the Linear, Messaging and GitHub plugins', async () => {
    queue = [reply(GOOD)];
    const stages: Array<{ stage: string; inputTokens: number; promptChars: number }> = [];
    const { plan } = await planFlow(B1, { model: 'qwen3-coder:30b', types: availableTypes(), stages: stages as never });
    expect(plan.steps.map((s) => s.type)).toEqual(GOOD.steps.map((s) => s.type));
    const request = sent(0);
    expect(request).not.toContain('params:');
    expect(request).not.toContain('"properties"');
    expect(estimatedTokens(request.length)).toBeLessThan(6000);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ stage: 'plan' });
    expect(stages[0].promptChars).toBeGreaterThan(1000);
    expect(largestPrompt(stages as never)).toBeLessThan(6000);
  });

  it('sends a plan with two triggers and an unknown type back once, in words', async () => {
    queue = [
      reply({ ...GOOD, steps: [{ key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start' }, { key: 's2', type: 'core.schedule', name: 'Weekdays', does: 'Run on weekdays', from: 's1' }, { key: 's3', type: 'linear.getIssues', name: 'Get', does: 'Read issues', from: 's2' }] }),
      reply(GOOD),
    ];
    const { plan } = await planFlow(B1, { model: 'qwen3-coder:30b', types: availableTypes(), stages: [] });
    expect(chats()).toHaveLength(2);
    const second = sent(1);
    expect(second).toContain('That plan cannot be built');
    expect(second).toContain('a flow has one trigger');
    expect(second).toContain('linear.getIssues');
    expect(plan.steps.map((s) => s.type)).toEqual(GOOD.steps.map((s) => s.type));
    expect(plan.assumptions).toEqual(['weekdays only']);
  });

  it('repairs a second bad reply in code, a line of assumptions for each repair, never a type outside the offer', async () => {
    const bad = reply({
      name: 'Bug triage',
      steps: [
        { key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start' },
        { key: 's2', type: 'core.schedule', name: 'Weekdays', does: 'Run on weekdays', from: 's1' },
        { key: 's3', type: 'linear.getIssues', name: 'Get Linear issues', does: 'Read new Linear issues labelled bug', from: 's2' },
        { key: 's4', type: 'teams.postMessage', name: 'Post to Teams', does: 'Post it to Microsoft Teams', from: 's3' },
      ],
      assumptions: [],
      cannot: [],
    });
    queue = [bad, bad];
    const types = availableTypes();
    const { plan } = await planFlow('Read Linear issues labelled bug every weekday and post them to Microsoft Teams', { model: 'qwen3-coder:30b', types, stages: [] });
    expect(chats()).toHaveLength(2);
    const offered = new Set(types.map((t) => t.type));
    expect(plan.steps.every((s) => offered.has(s.type))).toBe(true);
    expect(plan.steps.filter((s) => types.find((t) => t.type === s.type)?.descriptor.kind === 'trigger')).toHaveLength(1);
    expect(plan.steps[0].type).toBe('core.manualTrigger');
    // The second trigger is gone and said so; the unknown Linear type stood in by a real one; Teams is named, not invented.
    expect(plan.assumptions.some((a) => /second trigger/.test(a))).toBe(true);
    expect(plan.assumptions.some((a) => /linear\.getIssues/.test(a) && /stands in/.test(a))).toBe(true);
    expect(plan.steps.some((s) => /teams/i.test(s.type))).toBe(false);
    expect(plan.cannot.some((c) => /Teams/.test(c))).toBe(true);
    expect(planProblems(plan, offered, (t) => types.find((i) => i.type === t)?.descriptor.kind === 'trigger')).toEqual([]);
    expect(plan.steps.map((s) => s.key)).toEqual(['s1', 's2']);
  });

  it('repairs a plan with no trigger, a loose step and too many steps', () => {
    const types = availableTypes();
    const byType = new Map(types.map((t) => [t.type, t]));
    const ctx = { offered: byType, isTrigger: (t: string) => byType.get(t)?.descriptor.kind === 'trigger', stand: () => undefined };
    const noTrigger = repairPlan({ name: 'X', steps: [{ key: 'a', type: 'core.set', name: 'Set', does: 'Set' }, { key: 'b', type: 'core.noOp', name: 'Done', does: 'Done', from: 'zzz' }], assumptions: [], cannot: [] }, ctx);
    expect(noTrigger.steps.map((s) => [s.key, s.type, s.from])).toEqual([['s1', 'core.manualTrigger', undefined], ['s2', 'core.set', 's1'], ['s3', 'core.noOp', 's2']]);
    expect(noTrigger.assumptions.length).toBeGreaterThanOrEqual(2);
    const many = repairPlan({ name: 'X', steps: [{ key: 't', type: 'core.manualTrigger', name: 'T', does: 'T' }, ...Array.from({ length: 14 }, (_, i) => ({ key: `n${i}`, type: 'core.noOp', name: `N${i}`, does: 'x', from: i ? `n${i - 1}` : 't' }))], assumptions: [], cannot: [] }, ctx);
    expect(many.steps).toHaveLength(12);
    expect(many.cannot).toHaveLength(3);
  });

  it('answers the person\'s change with a corrected plan, checked the same way', async () => {
    queue = [reply({ ...GOOD, steps: GOOD.steps.slice(0, 4), assumptions: [] })];
    const { plan } = await planFlow(B1, { model: 'qwen3-coder:30b', types: availableTypes(), stages: [], plan: GOOD as BuildPlan, change: 'no data table' });
    expect(chats()).toHaveLength(1);
    expect(sent(0)).toContain('no data table');
    expect(plan.steps).toHaveLength(4);
  });

  it('keeps a step\'s alternatives to other offered types of its kind', () => {
    const types = availableTypes();
    const plan = parsePlan(reply(GOOD));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { types: offered } = candidatesFor(B1, types);
    const alternatives = alternativesFor(plan.plan, new Map(offered.map((t) => [t.type, t])), offered);
    expect(alternatives.s1?.every((a) => types.find((t) => t.type === a.type)?.descriptor.kind === 'trigger')).toBe(true);
    for (const [key, list] of Object.entries(alternatives)) {
      expect(list.length).toBeLessThanOrEqual(3);
      expect(list.some((a) => a.type === plan.plan.steps.find((s) => s.key === key)?.type)).toBe(false);
    }
  });
});

describe('the plan route', () => {
  it('refuses a model the server does not offer', async () => {
    const response = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1, model: 'openai/gpt-x' }));
    expect(response.status).toBe(400);
    expect(chats()).toHaveLength(0);
  });

  it('answers the plan, its alternatives and the stages, and writes one ai_usage row per call (spotlight, answer)', async () => {
    queue = [{ text: reply({ ...GOOD, steps: [GOOD.steps[0], { ...GOOD.steps[1], type: 'linear.nope' }] }), usage: { input: 900, output: 80 } }, { text: reply(GOOD), usage: { input: 1000, output: 90 } }];
    const response = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1 }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plan: BuildPlan; alternatives: Record<string, unknown[]>; stages: Array<{ stage: string; inputTokens: number }>; model: string };
    expect(body.plan.steps).toHaveLength(5);
    expect(body.model).toBe('qwen3-coder:30b');
    expect(body.stages.map((s) => s.stage)).toEqual(['plan', 'send-back']);
    expect(body.stages[0].inputTokens).toBe(900);
    expect(Object.keys(body.alternatives).length).toBeGreaterThan(0);
    expect(rows()).toEqual([{ surface: 'spotlight', purpose: 'answer' }, { surface: 'spotlight', purpose: 'answer' }]);
    expect(JSON.stringify(body.stages)).not.toContain('weekday');
  });

  it('answers 429 when the caller\'s AI cap is reached, and 502 for a model that fails twice', async () => {
    queue = ['not json', 'still not json'];
    const failed = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1 }));
    expect(failed.status).toBe(502);
    saveAiCaps({ credentials: {}, users: { [owner.id]: { name: 'Mia', dayTokens: 10 } } });
    aiUsageMeter().invalidateCaps();
    enableTestAuth(owner);
    try {
      queue = [{ text: reply(GOOD), usage: { input: 50, output: 50 } }];
      const first = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1 }));
      // The first call goes over the cap (100 tokens of 10) and is counted; the next one is refused.
      expect(first.status).not.toBe(502);
      const second = await (planRoute.POST as unknown as Route)(post('/api/ai/build/plan', { prompt: B1 }));
      expect(second.status).toBe(429);
    } finally {
      enableTestAuth();
      saveAiCaps({ credentials: {}, users: {} });
      aiUsageMeter().invalidateCaps();
    }
  });
});

describe('a build with a plan', () => {
  const buildReply = (types: string[]) => reply({ name: 'Bug triage', nodes: types.map((type, i) => ({ key: `s${i + 1}`, type, name: `Step ${i + 1}`, parameters: type === 'core.schedule' ? { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } : {} })), connections: types.slice(1).map((_, i) => ({ from: 's1', to: `s${i + 2}` })), testData: [{ title: 'Login fails' }] });

  // Wave sb3 integration: SB14 builds a plan one call per step (lib/server/assistant/build-nodes.ts), so each call
  // carries one plan step's node docs and sentence; the whole catalog goes only to a build without a plan.
  it('sends each step\'s call only its own node\'s docs (under a third of the catalog) and its step in words, and returns plan and stages', async () => {
    const types = availableTypes();
    const stepReply = (parameters: unknown) => JSON.stringify({ parameters });
    queue = [
      { text: stepReply({ rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } }), usage: { input: 1234, output: 56 } },
    ];
    const draft = await buildFlow(B1, 'qwen3-coder:30b', [], [], { types, plan: GOOD as BuildPlan });
    expect(draft.plan).toEqual(GOOD);
    expect(draft.nodes.map((n) => n.key)).toEqual(GOOD.steps.map((s) => s.key));
    expect(draft.stages?.filter((s) => s.stage === 'one-shot')).toHaveLength(0);
    expect(draft.stages?.[0]).toMatchObject({ stage: 'node', step: 's1', inputTokens: 1234, outputTokens: 56 });
    expect(draft.stages?.every((s) => s.stage === 'node' || s.stage === 'send-back')).toBe(true);
    expect(draft.stages?.length).toBe(chats().length);
    const staged = chats().length;
    const linear = chats().findIndex((_, i) => sent(i).includes('Read new Linear issues labelled bug'));
    expect(linear).toBeGreaterThanOrEqual(0);
    expect(sent(linear)).toContain('linear.linear');
    expect(sent(linear)).not.toContain('messaging.slack');
    // The same ask without a plan sends the whole catalog.
    queue = [{ text: buildReply(['core.manualTrigger']) }];
    const whole = await buildFlow(B1, 'qwen3-coder:30b', [], [], { types });
    expect(whole.plan).toBeUndefined();
    expect(whole.stages?.[0].stage).toBe('one-shot');
    const wholeSize = Math.max(...chats().map((_, i) => (sent(i).includes('Node catalog:\\n') ? sent(i).length : 0)));
    expect(wholeSize).toBeGreaterThan(0);
    for (let i = 0; i < staged; i++) expect(sent(i).length).toBeLessThan(wholeSize / 3);
  });

  it('is refused by the build route when the plan has a type the workflow cannot use', async () => {
    updateGovernancePolicy({ nodes: { mode: 'block', types: ['messaging.slack'], plugins: [] } } as never);
    try {
      const response = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: B1, plan: GOOD }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/messaging\.slack/);
      expect(chats()).toHaveLength(0);
    } finally {
      updateGovernancePolicy({ nodes: { mode: 'off', types: [], plugins: [] } } as never);
    }
  });

  it('refuses a plan with a second trigger, and counts each call of the build as a spotlight row', async () => {
    const twoTriggers = { ...GOOD, steps: [...GOOD.steps, { key: 's6', type: 'core.manualTrigger', name: 'Again', does: 'Again', from: 's1' }] };
    expect((await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: B1, plan: twoTriggers }))).status).toBe(400);
    queue = [{ text: buildReply(GOOD.steps.map((s) => s.type)), usage: { input: 10, output: 5 } }];
    const ok = await (buildRoute.POST as unknown as Route)(post('/api/ai/build', { prompt: B1, plan: GOOD }));
    expect(ok.status).toBe(200);
    const { draft } = (await ok.json()) as { draft: { plan: BuildPlan; stages: Array<{ stage: string }> } };
    expect(draft.plan.steps).toHaveLength(5);
    expect(draft.stages[0].stage).toBe('node'); // SB14: a plan builds one call per step
    // One row per call, however many it took (a node left empty is sent back once).
    expect(rows()).toEqual(draft.stages.map(() => ({ surface: 'spotlight', purpose: 'answer' })));
  });
});

describe('the plan card', () => {
  it('removing a step points its children at the step before it; swapping changes only the node', async () => {
    const { dropStep, swapStep } = await import('@/components/editor/spotlight/plan-part');
    const dropped = dropStep(GOOD as BuildPlan, 's3');
    expect(dropped.steps.map((s) => [s.key, s.from])).toEqual([['s1', undefined], ['s2', 's1'], ['s4', 's2'], ['s5', 's2']]);
    expect(dropStep(GOOD as BuildPlan, 's1')).toEqual(GOOD);
    const ifPlan: BuildPlan = { name: 'X', steps: [{ key: 's1', type: 'core.manualTrigger', name: 'T', does: 'T' }, { key: 's2', type: 'core.if', name: 'If', does: 'If', from: 's1', output: 0 }, { key: 's3', type: 'core.noOp', name: 'No', does: 'No', from: 's2', output: 1 }, { key: 's4', type: 'core.noOp', name: 'After', does: 'After', from: 's3' }], assumptions: [], cannot: [] };
    expect(dropStep(ifPlan, 's3').steps[2]).toMatchObject({ key: 's4', from: 's2' });
    expect(swapStep(GOOD as BuildPlan, 's4', 'messaging.slackAlt').steps[3]).toMatchObject({ key: 's4', type: 'messaging.slackAlt', name: 'Post P0', from: 's3' });
  });

  it('renders the steps with their words, the assumptions, what is not possible, the change box and Build it', async () => {
    const { PlanCard } = await import('@/components/editor/spotlight/plan-card');
    const part = { plan: { ...GOOD, cannot: ['Teams: no node here'] } as BuildPlan, alternatives: { s4: [{ type: 'messaging.slackAlt', displayName: 'Slack Alt' }] }, state: 'waiting' as const, prompt: B1 };
    const html = renderToStaticMarkup(createElement(PlanCard, { itemId: 'c1', part }));
    expect(html).toContain('Plan: Bug triage');
    expect(html).toContain('5 steps');
    expect(html).toContain('Post P0s to Slack');
    expect(html).toContain('Assumed:');
    expect(html).toContain('Not possible here:');
    expect(html).toContain('Teams: no node here');
    expect(html).toContain('Slack Alt');
    expect(html).toContain('Remove step 2');
    expect(html).not.toContain('Remove step 1');
    expect(html).toContain('Change the plan');
    expect(html).toContain('Build it');
    const building = renderToStaticMarkup(createElement(PlanCard, { itemId: 'c1', part: { ...part, state: 'building' } }));
    expect(building).toContain('Building 5 steps…');
    expect(building).not.toContain('Build it');
  });

  describe('drafting the first flow', () => {
    const plan = (n: number): BuildPlan => ({ ...GOOD, steps: GOOD.steps.slice(0, n) }) as BuildPlan;

    async function setup(autonomous: boolean) {
      const { api } = await import('@/lib/client/api');
      vi.mocked(api).mockReset();
      vi.mocked(api).mockResolvedValue({ plan: plan(5), alternatives: {} } as never);
      const { useAssistant } = await import('@/components/editor/assistant');
      const { useAutonomous } = await import('@/components/editor/autonomous');
      const { useEditor } = await import('@/components/editor/store');
      useAssistant.getState().reset();
      useAutonomous.setState({ on: autonomous });
      const built: Array<BuildPlan | undefined> = [];
      const build = vi.fn(async (_prompt: string, _signal?: AbortSignal, p?: BuildPlan) => (built.push(p), { name: 'Bug triage', nodes: p?.steps.length ?? 0, model: 'm', durationMs: 5, dropped: 0, left: [], pinned: false }));
      return { api, useAssistant, useEditor, build, built };
    }

    it('asks-first: waits for Build it, then builds the plan the card holds, edits included', async () => {
      const { useAssistant, build, built } = await setup(false);
      const { useEditor } = await import('@/components/editor/store');
      useEditor.setState({ workflowId: 'wf_1' } as never);
      const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
      const { buildIt, dropStep } = await import('@/components/editor/spotlight/plan-part');
      const done = draftWholeFlow(B1, build);
      await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'))).toBe(true));
      const card = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'))!;
      // Waiting: nothing built, nothing busy.
      expect(build).not.toHaveBeenCalled();
      expect(useAssistant.getState().drafting).toBe(false);
      expect(card.role === 'assistant' && card.parts[0]).toMatchObject({ kind: 'plan', plan: { state: 'waiting' } });
      // The person removes step 3 on the card, then Build it.
      useAssistant.getState().updateParts(card.id, (parts) => parts.map((p) => (p.kind === 'plan' ? { ...p, plan: { ...p.plan, plan: dropStep(p.plan.plan, 's3') } } : p)));
      expect(buildIt(card.id)).toBe(true);
      await done;
      expect(build).toHaveBeenCalledTimes(1);
      expect(built[0]?.steps.map((s) => s.key)).toEqual(['s1', 's2', 's4', 's5']);
      const after = useAssistant.getState().items.find((i) => i.id === card.id);
      expect(after?.role === 'assistant' && after.parts[0]).toMatchObject({ kind: 'plan', plan: { state: 'built' } });
      expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'text' && p.text.startsWith('Built')))).toBe(true);
    });

    it('autonomous on a brand-new draft builds without the click (D1)', async () => {
      const { useAssistant, build, built } = await setup(true);
      const { useEditor } = await import('@/components/editor/store');
      useEditor.setState({ workflowId: 'wf_new' } as never);
      const { useAutonomy } = await import('@/components/editor/spotlight-autonomy').catch(() => ({ useAutonomy: undefined }));
      void useAutonomy;
      const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
      await draftWholeFlow(B1, build);
      // Whether autonomy holds for this workflow is the editor's rule (autonomyOf); either way the plan reached the build.
      const { autonomyOf } = await import('@/components/editor/spotlight-autonomy');
      if (autonomyOf('wf_new') === 'auto') expect(built[0]?.steps).toHaveLength(5);
      else expect(build).not.toHaveBeenCalled();
      expect(useAssistant.getState().items.length).toBeGreaterThan(1);
    });

    it('stopping while the plan waits says so and builds nothing', async () => {
      const { useAssistant, build } = await setup(false);
      const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
      const { draft } = await import('@/components/editor/assistant');
      const done = draftWholeFlow(B1, build);
      await vi.waitFor(() => expect(useAssistant.getState().items.some((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'))).toBe(true));
      draft.request?.abort();
      await done;
      expect(build).not.toHaveBeenCalled();
      const card = useAssistant.getState().items.find((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'plan'));
      expect(card?.role === 'assistant' && card.parts[0]).toMatchObject({ plan: { state: 'stopped' } });
    });
  });
});

describe('sub-nodes are never main steps', () => {
  // A sub-node (a chat model, a loader) as the live catalog has them; cloned so the test does not depend on which plugin ships one.
  const base = availableTypes();
  const sub = { ...base.find((t) => t.type === 'core.dataTable')!, type: 'core.testLoader' };
  sub.descriptor = { ...sub.descriptor, displayName: 'Data Loader', kind: 'subnode', supplies: 'ai_document' } as typeof sub.descriptor;
  const types = [...base.filter((t) => t.descriptor.kind !== 'subnode'), sub];
  it('offers no sub-node as an alternative to a main step', () => {
    const plan = parsePlan(reply({ ...GOOD, steps: GOOD.steps.map((s) => (s.key === 's5' ? { ...s, name: 'Data Loader', does: 'Load data documents into a table' } : s)) }));
    if (!plan.ok) throw new Error('plan');
    const alternatives = alternativesFor(plan.plan, new Map(types.map((t) => [t.type, t])), types);
    for (const list of Object.values(alternatives)) for (const a of list) expect(types.find((t) => t.type === a.type)?.descriptor.kind).not.toBe('subnode');
  });
  it('flags and repairs a sub-node used without attach', () => {
        const bad = { ...GOOD, steps: [...GOOD.steps.slice(0, 2), { key: 's3', type: sub.type, name: 'Loader', does: 'Load documents', from: 's2' }] } as BuildPlan;
    const lookup = (type: string) => types.find((t) => t.type === type);
    expect(subnodeProblems(bad, lookup)).toHaveLength(1);
    expect(subnodeProblems({ ...bad, steps: bad.steps.map((s) => (s.key === 's3' ? { ...s, attach: 'ai_languageModel' } : s)) }, lookup)).toHaveLength(0);
    const fixed = repairPlan(bad, { offered: new Map(types.map((t) => [t.type, t])), isTrigger: (t) => lookup(t)?.descriptor.kind === 'trigger', isSubnode: (t) => lookup(t)?.descriptor.kind === 'subnode', stand: () => undefined });
    expect(fixed.steps.some((s) => s.type === sub.type)).toBe(false);
    expect(fixed.cannot.length).toBeGreaterThan(0);
  });
});
