/**
 * SB14: a first draft built from a plan, one small call per step (lib/server/assistant/build-nodes.ts): each call sees
 * only that node's docs and what arrives from the step before, its reply is checked and sent back once to that step
 * alone, and the wiring is the plan's. A fake Ollama answers by the step each request names.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { planEdges, type BuildPlan } from '@/lib/shared/build-plan';
import { startFakeModels, type FakeReply } from './fake-ai-services';

/** The replies each step gets, in order; the last one repeats. A step without replies gets `{}`. */
let script: Record<string, Array<string | FakeReply>> = {};
const asked: Record<string, number> = {};
const fake = await startFakeModels({
  reply: (_provider, body) => {
    const first = String(body?.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '');
    const step = /This step: “([^”]*)”/.exec(first)?.[1];
    if (!step) return { text: '{}' };
    const list = script[step] ?? ['{}'];
    const n = (asked[step] = (asked[step] ?? 0) + 1);
    const next = list[Math.min(n, list.length) - 1];
    return typeof next === 'string' ? { text: next } : next;
  },
});
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-flow-builder-staged-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const flowBuilder = await import('@/lib/server/flow-builder');
const { buildFlow } = flowBuilder;
const { buildFromPlan } = await import('@/lib/server/assistant/build-nodes');
const { validateNodeParameters } = await import('@/lib/server/assistant/ops');
const { defineNode, definePlugin } = await import('@landflow/sdk');
const buildRoute = await import('@/app/api/ai/build/route');
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'sb14app', name: 'Tracker (test)', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: {
          name: 'linear',
          displayName: 'Linear',
          version: 1,
          kind: 'action',
          inputs: [{ type: 'main' }],
          outputs: [{ type: 'main' }],
          properties: [
            { name: 'operation', displayName: 'Operation', type: 'options', default: 'getAll', options: [{ name: 'Get all', value: 'getAll', outputSchema: { type: 'object', properties: { identifier: { type: 'string', description: 'ENG-12' }, title: { type: 'string' }, url: { type: 'string' } } } }, { name: 'Create', value: 'create' }] },
            { name: 'labelName', displayName: 'Label', type: 'string', default: '' },
          ],
        },
        async execute() {
          return [[]];
        },
      }),
      defineNode({
        description: { name: 'slack', displayName: 'Slack', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [{ name: 'channelName', displayName: 'Channel name', type: 'string', default: '' }, { name: 'text', displayName: 'Message', type: 'string', default: '' }] },
        async execute() {
          return [[]];
        },
      }),
    ],
  }),
);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  script = {};
  for (const key of Object.keys(asked)) delete asked[key];
  fake.requests.length = 0;
});

const chatCalls = () => fake.requests.filter((r) => r.path === '/api/chat');
const callsFor = (step: string) => chatCalls().filter((r) => String(r.body.messages.find((m: { role: string }) => m.role === 'user')?.content).includes(`This step: “${step}”`));
const reply = (parameters: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ parameters, ...extra });

const CONDITION = [{ left: '{{ $json.body.total }}', operator: 'gt', right: '1000' }];
const step = (key: string, type: string, name: string, does: string, from?: string, rest: Record<string, unknown> = {}) => ({ key, type, name, does, ...(from && { from }), ...rest });

/** B4: a webhook, an If on the total, two POSTs, a response. */
const B4: BuildPlan = {
  name: 'Orders',
  steps: [
    step('s1', 'core.webhook', 'Order in', 'Receive an order'),
    step('s2', 'core.if', 'Total over 1000', 'Branch on the total', 's1', { reads: ['body.total'] }),
    step('s3', 'core.httpRequest', 'Send to VIP', 'POST the order to the VIP endpoint', 's2', { output: 0 }),
    step('s4', 'core.httpRequest', 'Send to regular', 'POST the order to the regular endpoint', 's2', { output: 1 }),
    step('s5', 'core.respondToWebhook', 'Reply ok', 'Respond with ok', 's3'),
  ],
  assumptions: [],
  cannot: [],
};
const B4_REPLIES = {
  'Order in': [reply({ path: 'orders', httpMethod: 'POST' }, { testData: [{ body: { total: 1500 } }, { body: { total: 500 } }] })],
  'Total over 1000': [reply({ conditions: { condition: CONDITION }, combinator: 'and' })],
  'Send to VIP': [reply({ method: 'POST', url: 'http://127.0.0.1:3399/vip', sendBody: true, body: '{{ JSON.stringify($json.body) }}' })],
  'Send to regular': [reply({ method: 'POST', url: 'http://127.0.0.1:3399/regular', sendBody: true, body: '{{ JSON.stringify($json.body) }}' })],
  'Reply ok': [reply({ respondWith: 'json', responseBody: '{"ok": true}' })],
};

const ASK = 'when a webhook receives an order, if the total is over 1000 POST it to /vip, otherwise to /regular, then respond';

describe('SB14: a plan becomes nodes, one call per step', () => {
  it('builds one node per step with the plan’s keys and names, wired exactly as the plan, and a call per step with parameters', async () => {
    script = { ...B4_REPLIES, 'Order in': [reply({ path: 'orders' }, { testData: [{ body: { total: 1500 } }], connections: [{ from: 's5', to: 's1' }] })] };
    const draft = await buildFlow(ASK, undefined, [], [], { plan: B4 });
    expect(draft.nodes.map((n) => [n.key, n.name, n.type])).toEqual(B4.steps.map((s) => [s.key, s.name, s.type]));
    expect(draft.edges).toEqual(planEdges(B4));
    expect(draft.plan).toEqual(B4);
    // Every step of B4 has parameters to fill: one call each, none repeated.
    expect(chatCalls()).toHaveLength(5);
    expect(draft.calls).toBe(5);
    expect(draft.nodes.find((n) => n.key === 's2')!.parameters).toMatchObject({ conditions: { condition: CONDITION } });
    expect(draft.pinData?.s1).toHaveLength(1);
    expect(draft.left?.filter((l) => l.kind === 'empty')).toEqual([]);
  });

  it('sends each call only that step’s docs, and what arrives from the step before', async () => {
    const plan: BuildPlan = {
      name: 'Bugs',
      steps: [step('s1', 'core.schedule', 'Every weekday', 'Run weekdays at 8'), step('s2', 'sb14app.linear', 'Get bugs', 'Read new bug issues', 's1'), step('s3', 'sb14app.slack', 'Tell Slack', 'Post the bug titles', 's2')],
      assumptions: [],
      cannot: [],
    };
    script = {
      'Every weekday': [reply({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } })],
      'Get bugs': [reply({ operation: 'getAll', labelName: 'bug' }, { testData: [{ identifier: 'ENG-1', title: 'Crash', url: 'https://x' }] })],
      'Tell Slack': [reply({ text: '{{ $json.identifier }}: {{ $json.title }}' })],
    };
    const draft = await buildFlow('every weekday at 8 read bug issues from Linear and post them to Slack', undefined, [], [], { plan });
    const linear = JSON.stringify(callsFor('Get bugs')[0].body.messages);
    const slack = JSON.stringify(callsFor('Tell Slack')[0].body.messages);
    expect(linear).toContain('labelName');
    expect(linear).not.toContain('channelName');
    expect(linear).not.toContain('Trigger Rules');
    expect(slack).toContain('channelName');
    expect(slack).not.toContain('labelName');
    // The Linear step's output fields reach the Slack step's call.
    expect(slack).toContain('identifier (string) — ENG-12');
    expect(slack).toContain('url (string)');
    // The schedule's own item is only a time; the Linear step's sample items are pinned on it.
    expect(JSON.stringify(callsFor('Get bugs')[0].body.messages)).toContain('firedAt');
    expect(draft.pinData?.s2).toEqual([{ json: { identifier: 'ENG-1', title: 'Crash', url: 'https://x' } }]);
    expect(draft.left?.filter((l) => l.kind === 'made-up' || l.kind === 'empty')).toEqual([]);
  });

  it('sends an empty If back once, to that step alone, and leaves it empty when the second reply is empty too', async () => {
    script = { ...B4_REPLIES, 'Total over 1000': [reply({ conditions: [] })] };
    const draft = await buildFlow(ASK, undefined, [], [], { plan: B4 });
    expect(callsFor('Total over 1000')).toHaveLength(2);
    expect(chatCalls()).toHaveLength(6);
    const second = callsFor('Total over 1000')[1].body.messages;
    expect(second.at(-2).role).toBe('assistant');
    expect(second.at(-1).content).toContain('conditions');
    expect(second.at(-1).content).toContain('core.if');
    expect(draft.left).toEqual([expect.objectContaining({ node: 'Total over 1000', field: 'conditions', kind: 'empty' })]);
    expect(draft.calls).toBe(6);

    // The second reply fills it: no left item, and still only that step repeated.
    script = { ...B4_REPLIES, 'Total over 1000': [reply({}), reply({ conditions: { condition: CONDITION } })] };
    for (const key of Object.keys(asked)) delete asked[key];
    fake.requests.length = 0;
    const fixed = await buildFlow(ASK, undefined, [], [], { plan: B4 });
    expect(callsFor('Total over 1000')).toHaveLength(2);
    expect(chatCalls()).toHaveLength(6);
    expect(fixed.left?.filter((l) => l.kind === 'empty')).toEqual([]);
    expect(fixed.nodes.find((n) => n.key === 's2')!.parameters).toMatchObject({ conditions: { condition: CONDITION } });
  });

  it('sends an expression that reads a field the step before does not write back, naming the fields it has', async () => {
    const plan: BuildPlan = { name: 'Since', steps: [step('s1', 'core.schedule', 'Every day', 'Run daily'), step('s2', 'core.set', 'Set since', 'Set the time window', 's1')], assumptions: [], cannot: [] };
    const bad = reply({ mode: 'manual', fields: { values: [{ name: 'since', type: 'string', value: '{{ $json.lastRun }}' }] } });
    const good = reply({ mode: 'manual', fields: { values: [{ name: 'since', type: 'string', value: '{{ $json.firedAt }}' }] } });
    script = { 'Every day': [reply({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } })], 'Set since': [bad, good] };
    const draft = await buildFlow('every day at 8 set since', undefined, [], [], { plan });
    expect(callsFor('Set since')).toHaveLength(2);
    expect(callsFor('Every day')).toHaveLength(1);
    const back = callsFor('Set since')[1].body.messages.at(-1).content as string;
    expect(back).toContain('$json.lastRun');
    expect(back).toContain('firedAt');
    expect(JSON.stringify(draft.nodes.find((n) => n.key === 's2')!.parameters)).toContain('firedAt');
    expect(draft.left?.filter((l) => l.kind === 'made-up')).toEqual([]);

    // Still wrong after the one send-back: a `made-up` item, no third call.
    script = { 'Every day': script['Every day'], 'Set since': [bad] };
    for (const key of Object.keys(asked)) delete asked[key];
    fake.requests.length = 0;
    const stuck = await buildFlow('every day at 8 set since', undefined, [], [], { plan });
    expect(callsFor('Set since')).toHaveLength(2);
    expect(stuck.left).toEqual([expect.objectContaining({ node: 'Set since', kind: 'made-up', text: expect.stringContaining('lastRun') })]);
  });

  it('sends a Slack step that reads $json.title after an agent back once, to that step alone, naming title', async () => {
    const plan: BuildPlan = {
      name: 'Triage',
      steps: [step('s1', 'core.schedule', 'Every day', 'Run daily'), step('s2', 'core.aiAgent', 'Triage agent', 'Triage the bug', 's1'), step('s3', 'sb14app.slack', 'Tell Slack', 'Post the answer', 's2')],
      assumptions: [],
      cannot: [],
    };
    script = {
      'Every day': [reply({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } })],
      'Triage agent': [reply({ prompt: 'Triage this bug' })],
      'Tell Slack': [reply({ text: '{{ $json.title }}' }), reply({ text: '{{ $json.output }}' })],
    };
    const draft = await buildFlow('every day triage a bug with an agent and post it to Slack', undefined, [], [], { plan });
    expect(callsFor('Tell Slack')).toHaveLength(2);
    expect(callsFor('Triage agent')).toHaveLength(1);
    expect(callsFor('Every day')).toHaveLength(1);
    expect(callsFor('Tell Slack')[1].body.messages.at(-1).content as string).toContain('title');
    expect(draft.stages!.filter((s) => s.stage === 'send-back').map((s) => s.step)).toEqual(['s3']);
    expect(JSON.stringify(draft.nodes.find((n) => n.key === 's3')!.parameters)).toContain('output');
  });

  it('a message to an agent writes `reply`: a step reading $json.output gets one send-back naming output, one reading $json.reply gets none', async () => {
    const plan: BuildPlan = {
      name: 'Agent answer',
      steps: [step('s1', 'core.schedule', 'Every day', 'Run daily'), step('s2', 'core.messageAgent', 'Ask the agent', 'Have the agent answer', 's1'), step('s3', 'sb14app.slack', 'Tell Slack', 'Post the answer', 's2')],
      assumptions: [],
      cannot: [],
    };
    const day = reply({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } });
    script = { 'Every day': [day], 'Ask the agent': [reply({ message: 'Answer today' })], 'Tell Slack': [reply({ text: '{{ $json.output }}' }), reply({ text: '{{ $json.reply }}' })] };
    const draft = await buildFlow('every day ask the agent and post the answer to Slack', undefined, [], [], { plan });
    expect(callsFor('Tell Slack')).toHaveLength(2);
    const back = callsFor('Tell Slack')[1].body.messages.at(-1).content as string;
    expect(back).toContain('output');
    expect(JSON.stringify(draft.nodes.find((n) => n.key === 's3')!.parameters)).toContain('$json.reply');
    // Reading `reply` the first time is right: no send-back.
    for (const key of Object.keys(asked)) delete asked[key];
    fake.requests.length = 0;
    script = { 'Every day': [day], 'Ask the agent': [reply({ message: 'Answer today' })], 'Tell Slack': [reply({ text: '{{ $json.reply }}' })] };
    await buildFlow('every day ask the agent and post the answer to Slack', undefined, [], [], { plan });
    expect(callsFor('Tell Slack')).toHaveLength(1);
  });

  it('a team writes `reason` on its Needs a person output: a step on output 1 reading $json.reason gets no send-back', async () => {
    const plan: BuildPlan = {
      name: 'Team answer',
      steps: [step('s1', 'core.schedule', 'Every day', 'Run daily'), step('s2', 'core.runTeam', 'Ask the team', 'Have the team work', 's1'), step('s3', 'sb14app.slack', 'Tell Slack', 'Say why a person is needed', 's2', { output: 1 })],
      assumptions: [],
      cannot: [],
    };
    const day = reply({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } });
    script = { 'Every day': [day], 'Ask the team': [reply({ message: 'Work on it' })], 'Tell Slack': [reply({ text: '{{ $json.reason }}' })] };
    const draft = await buildFlow('every day ask the team and say in Slack why a person is needed', undefined, [], [], { plan });
    expect(callsFor('Tell Slack')).toHaveLength(1);
    expect(JSON.stringify(draft.nodes.find((n) => n.key === 's3')!.parameters)).toContain('$json.reason');
  });

  it('sends a weekday cron back when the request said "every morning", and keeps a daily rule', async () => {
    const plan: BuildPlan = { name: 'Morning', steps: [step('s1', 'core.schedule', 'Every morning', 'Run every morning at 9')], assumptions: [], cannot: [] };
    const weekdays = reply({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] } });
    const daily = reply({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] } });
    script = { 'Every morning': [weekdays, daily] };
    const draft = await buildFlow('every morning at 9 do something', undefined, [], [], { plan });
    expect(callsFor('Every morning')).toHaveLength(2);
    expect(callsFor('Every morning')[1].body.messages.at(-1).content).toContain('runs only on Mon–Fri');
    expect(JSON.stringify(draft.nodes[0].parameters)).toContain('0 9 * * *');
    // "every weekday" names the days: no send-back.
    for (const key of Object.keys(asked)) delete asked[key];
    fake.requests.length = 0;
    script = { 'Every morning': [weekdays] };
    await buildFlow('every weekday at 9 do something', undefined, [], [], { plan });
    expect(callsFor('Every morning')).toHaveLength(1);
  });

  it('keeps a step whose call fails with empty parameters and a left item, and builds the rest', async () => {
    script = { ...B4_REPLIES, 'Reply ok': [{ error: { status: 500, body: '{"error":"out of memory"}' } }] };
    const draft = await buildFlow(ASK, undefined, [], [], { plan: B4 });
    expect(draft.nodes).toHaveLength(5);
    expect(draft.nodes.find((n) => n.key === 's5')!.parameters).toEqual({});
    expect(draft.left).toEqual([expect.objectContaining({ node: 'Reply ok', kind: 'empty', text: expect.stringContaining('could not be drafted') })]);
    expect(draft.nodes.find((n) => n.key === 's2')!.parameters).toMatchObject({ conditions: { condition: CONDITION } });
    expect(draft.edges).toEqual(planEdges(B4));
  });

  it('fails the build when every call failed (a model that is down), as the one-shot draft does', async () => {
    script = Object.fromEntries(Object.keys(B4_REPLIES).map((name) => [name, [{ error: { status: 500, body: '{"error":"down"}' } }]]));
    await expect(buildFlow(ASK, undefined, [], [], { plan: B4 })).rejects.toThrow();
  });

  it('leaves out a step whose type is not available, names it, and never replaces it', async () => {
    const plan: BuildPlan = { ...B4, steps: [...B4.steps.slice(0, 4), step('s5', 'nope.teams', 'Post to Teams', 'Tell Teams', 's3')] };
    script = B4_REPLIES;
    const draft = await buildFlow(ASK, undefined, [], [], { plan });
    expect(draft.nodes.map((n) => n.key)).toEqual(['s1', 's2', 's3', 's4']);
    expect(draft.left).toEqual([expect.objectContaining({ node: 'Post to Teams', kind: 'dropped' })]);
    expect(draft.dropped).toEqual(['node Post to Teams (nope.teams)']);
    expect(draft.edges).toEqual(planEdges(plan).filter(([, to]) => to !== 's5'));
  });

  it('counts its calls and reports one stage per call, with sizes and never text', async () => {
    script = { ...B4_REPLIES, 'Total over 1000': [reply({ conditions: [] }), reply({ conditions: { condition: CONDITION } })] };
    const draft = await buildFlow(ASK, undefined, [], [], { plan: B4 });
    expect(draft.calls).toBe(chatCalls().length);
    expect(draft.stages).toHaveLength(chatCalls().length);
    expect(draft.stages!.filter((s) => s.stage === 'node').map((s) => s.step)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(draft.stages!.filter((s) => s.stage === 'send-back').map((s) => s.step)).toEqual(['s2']);
    for (const stage of draft.stages!) {
      expect(stage.promptChars).toBeGreaterThan(0);
      expect(Object.keys(stage).sort()).toEqual(['inputTokens', 'ms', 'outputTokens', 'promptChars', 'stage', 'step']);
    }
    // Each call stays under the contract's prompt budget (6000 tokens, four characters each).
    expect(Math.max(...draft.stages!.map((s) => s.promptChars))).toBeLessThan(6000 * 4);
  });

  it('uses the ask it is given, and records its tokens', async () => {
    const prompts: string[] = [];
    const built = await buildFromPlan(B4, ASK, {
      kit: flowBuilder,
      model: 'x',
      types: registry.nodeTypes().filter((t) => t.available),
      timeoutMs: 60_000,
      ask: async (messages, _budget, note) => {
        prompts.push(`${note.stage}:${note.step}`);
        const name = /This step: “([^”]*)”/.exec(messages[0].content)![1];
        return { text: String(B4_REPLIES[name as keyof typeof B4_REPLIES][0]), inputTokens: 100, outputTokens: 20 };
      },
    });
    expect(prompts).toEqual(['node:s1', 'node:s2', 'node:s3', 'node:s4', 'node:s5']);
    expect(built.stages.every((s) => s.inputTokens === 100 && s.outputTokens === 20)).toBe(true);
    expect(chatCalls()).toHaveLength(0);
  });

  it('checks a node’s option values by itself', () => {
    const lookup = (type: string) => registry.nodeTypes().find((t) => t.type === type)?.descriptor;
    expect(validateNodeParameters('sb14app.linear', { operation: 'getEverything' }, lookup)).toEqual([expect.stringContaining('getEverything')]);
    expect(validateNodeParameters('sb14app.linear', { operation: 'create' }, lookup)).toEqual([]);
  });

  it('judges an option by the list its resource shows, not by another resource’s list of the same name', () => {
    const op = (resource: string, values: string[]) => ({ name: 'operation', displayName: 'Operation', type: 'options' as const, default: values[0], options: values.map((value) => ({ name: value, value })), displayOptions: { show: { resource: [resource] } } });
    const descriptor = { properties: [{ name: 'resource', displayName: 'Resource', type: 'options' as const, default: 'issue', options: [{ name: 'Issue', value: 'issue' }, { name: 'User', value: 'user' }] }, op('issue', ['getManySince', 'create']), op('user', ['getAll'])] } as never;
    const lookup = () => descriptor;
    expect(validateNodeParameters('x.y', { resource: 'issue', operation: 'getManySince' }, lookup)).toEqual([]);
    expect(validateNodeParameters('x.y', { resource: 'user', operation: 'getManySince' }, lookup)).toEqual([expect.stringContaining('getManySince')]);
  });
});

describe('SB14: the build route', () => {
  const post = (body: unknown) => new Request('http://staged.test/api/ai/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  type Route = (request: Request) => Promise<Response>;

  it('answers 400 for a plan whose `from` follows itself or a later step, repeats a key or has a second trigger', async () => {
    const bad = (steps: unknown[]) => (buildRoute.POST as unknown as Route)(post({ prompt: ASK, plan: { name: 'x', steps, assumptions: [], cannot: [] } }));
    const s1 = step('s1', 'core.manualTrigger', 'Start', 'Start');
    for (const steps of [
      [s1, step('s2', 'core.noOp', 'Loop', 'loop', 's2'), step('s3', 'core.httpRequest', 'Call', 'call', 's2')],
      [s1, step('s2', 'core.httpRequest', 'A', 'a', 's3'), step('s3', 'core.httpRequest', 'B', 'b', 's1')],
      [s1, step('s1', 'core.httpRequest', 'Again', 'a', 's1')],
      [s1, step('s2', 'core.manualTrigger', 'Second', 'second')],
    ]) {
      const res = await bad(steps);
      expect(res.status).toBe(400);
    }
    expect((await bad([s1, step('s2', 'core.httpRequest', 'A', 'a', 's1', { attach: 'nonsense' })])).status).toBe(400);
  });

  it('ends a walk through pass-through steps that follow each other', async () => {
    const plan: BuildPlan = { name: 'x', steps: [step('s1', 'core.manualTrigger', 'Start', 'Start'), step('s2', 'core.noOp', 'A', 'a', 's3'), step('s3', 'core.noOp', 'B', 'b', 's2'), step('s4', 'core.httpRequest', 'Call', 'call', 's2')], assumptions: [], cannot: [] };
    script = {};
    const types = registry.nodeTypes().filter((t) => t.available);
    const built = await Promise.race([buildFromPlan(plan, 'x', { kit: flowBuilder, model: 'ollama/x', types, timeoutMs: 10_000, ask: async () => ({ text: '{"parameters":{}}' }) }), new Promise((r) => setTimeout(() => r('hung'), 5_000))]);
    expect(built).not.toBe('hung');
  });

  it('gives the staged draft when the body has a plan, and the one-shot draft with `staged: false`', async () => {
    script = B4_REPLIES;
    const staged = await (buildRoute.POST as unknown as Route)(post({ prompt: ASK, plan: B4 }));
    expect(staged.status).toBe(200);
    const body = (await staged.json()) as { draft: { nodes: Array<{ key: string }>; edges: unknown[]; plan?: unknown; calls: number } };
    expect(body.draft.nodes.map((n) => n.key)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(body.draft.edges).toEqual(planEdges(B4));
    expect(body.draft.plan).toEqual(B4);
    expect(body.draft.calls).toBe(5);

    fake.requests.length = 0;
    script = { ...Object.fromEntries(Object.keys(B4_REPLIES).map((n) => [n, ['{}']])) };
    // Integration (sb3): a body without a plan plans first now; `staged: false` is the one-shot draft this checked.
    const oneShot = await (buildRoute.POST as unknown as Route)(post({ prompt: ASK, staged: false }));
    // The base's one-shot draft answers `{}` here: no usable nodes. It is one request, with the catalog.
    expect(oneShot.status).toBe(502);
    expect(chatCalls().length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(chatCalls()[0].body.messages)).toContain('Node catalog');
  });
});

describe('SB14: the reads-right judge', () => {
  it('fails a Slack step that reads title or url after an agent, and passes output', async () => {
    const { badReads } = await import('./spotlight-scenarios/sb14');
    const agent = { key: 'a', type: 'core.aiAgent', name: 'Triage each bug' };
    const slack = (text: string) => ({ key: 's', type: 'messaging.slack', name: 'Slack', parameters: { text } });
    expect(badReads(slack('{{ $json.title }} {{ $json.url }}'), agent, [agent])).toEqual(['title', 'url']);
    expect(badReads(slack('{{ $json.output }}'), agent, [agent])).toEqual([]);
  });
});
