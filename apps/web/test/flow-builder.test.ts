/**
 * The AI builder's sample items (lib/server/flow-builder.ts): pinned on the Manual Trigger for test runs, and one only when
 * the flow runs an agent or a team, since each item is a whole agent run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startFakeModels, type FakeReply } from './fake-ai-services';

let answer = '{}';
// SB01: replies to give first, one per call, before `answer` repeats.
let queue: Array<string | FakeReply> = [];
let slowMs = 0;
const fake = await startFakeModels({
  reply: () => {
    const next = queue.length ? queue.shift()! : answer;
    return typeof next === 'string' ? { text: next, ...(slowMs && { delayMs: slowMs }) } : next;
  },
});
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-flow-builder-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { buildFlow, builderTimeoutMs, jsonOf, emptyParts } = await import('@/lib/server/flow-builder');
const { defineNode, definePlugin } = await import('@landflow/sdk');
registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const draft = (nodes: Array<{ key: string; type: string; name: string }>) =>
  JSON.stringify({ name: 'Draft', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, ...nodes], connections: nodes.map((n, i) => ({ from: i ? nodes[i - 1].key : 'start', to: n.key })), testData: [{ q: 'one' }, { q: 'two' }, { q: 'three' }] });

describe('AI builder sample items', () => {
  it('pins every sample item on a plain flow', async () => {
    answer = draft([{ key: 'set', type: 'core.set', name: 'Set' }]);
    expect((await buildFlow('copy the fields')).pinData?.start).toHaveLength(3);
  });

  it('pins one item when the flow runs a team or an agent', async () => {
    answer = draft([{ key: 'team', type: 'core.runTeam', name: 'Team' }]);
    expect((await buildFlow('review the plugin with the team')).pinData?.start).toEqual([{ json: { q: 'one' } }]);
    answer = draft([{ key: 'agent', type: 'core.aiAgent', name: 'Agent' }]);
    expect((await buildFlow('answer questions')).pinData?.start).toHaveLength(1);
  });
});

describe('AI builder teams', () => {
  const teams = [
    { id: 'team_desk1', name: 'Release notes desk', version: 1, members: [{ title: 'Editor' }, { title: 'Writer', reportsTo: 'Editor' }] },
    { id: 'team_tl1', name: 'Tech Lead team', version: 2, members: [{ title: 'Tech Lead' }] },
  ];

  it('tells the model the published teams, and turns the team name it writes into the id', async () => {
    answer = JSON.stringify({ name: 'Notes', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'team', type: 'core.runTeam', name: 'Run Team', parameters: { teamId: 'Release notes desk team', message: 'Write the notes' } }], connections: [{ from: 'start', to: 'team' }] });
    const flow = await buildFlow('run the release notes desk', undefined, teams);
    expect(flow.nodes.find((n) => n.key === 'team')!.parameters).toEqual({ teamId: 'team_desk1', teamName: 'Release notes desk', message: 'Write the notes' });
    const prompt = JSON.stringify(fake.last('/api/chat')?.body);
    expect(prompt).toContain('teamId team_desk1');
    // A lead's title is a name too; a name no team has stays as written (the node then asks for a team).
    answer = answer.replace('Release notes desk team', 'Tech Lead');
    expect((await buildFlow('review it', undefined, teams)).nodes.find((n) => n.key === 'team')!.parameters).toMatchObject({ teamId: 'team_tl1', teamName: 'Tech Lead team' });
    answer = answer.replace('Tech Lead', 'Marketing');
    expect((await buildFlow('market it', undefined, teams)).nodes.find((n) => n.key === 'team')!.parameters).toMatchObject({ teamId: 'Marketing' });
  });
});

describe('AI builder timeout', () => {
  it('defaults to 10 minutes and reads LANDFLOW_BUILDER_TIMEOUT_SECONDS', () => {
    expect(builderTimeoutMs(undefined)).toBe(600_000);
    expect(builderTimeoutMs('')).toBe(600_000);
    expect(builderTimeoutMs('900')).toBe(900_000);
    expect(builderTimeoutMs('0.5')).toBe(500);
    expect(builderTimeoutMs('0')).toBe(600_000);
    expect(builderTimeoutMs('soon')).toBe(600_000);
  });

  it('says the model was too slow, not that Ollama is unreachable', async () => {
    answer = draft([]);
    slowMs = 400;
    process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS = '0.1';
    try {
      await expect(buildFlow('anything', 'slow-model')).rejects.toThrow(/slow-model on Ollama at .* did not finish the draft within 0\.1 s \(LANDFLOW_BUILDER_TIMEOUT_SECONDS\)/);
    } finally {
      slowMs = 0;
      delete process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS;
    }
  });
});

describe('AI builder, the Ollama adapter\'s 300 s cap', () => {
  it('says the model was slow (not unreachable) when the adapter\'s own cap fires before the build\'s bound', async () => {
    answer = draft([]);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => (String(url).endsWith('/api/chat') ? Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) : real(url, init)));
    try {
      await expect(buildFlow('anything', 'slow-model')).rejects.toThrow(/slow-model on Ollama at .* did not finish the draft within 300 s \(the Ollama adapter's cap/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still says unreachable for a refused connection', async () => {
    answer = draft([]);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => (String(url).endsWith('/api/chat') ? Promise.reject(new TypeError('fetch failed')) : real(url, init)));
    try {
      await expect(buildFlow('anything', 'slow-model')).rejects.toThrow(/Cannot reach Ollama/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AI builder on Claude or an OpenAI-compatible API', () => {
  it('takes the JSON object out of a reply with a fence or prose around it', () => {
    expect(jsonOf('{"a":1}')).toBe('{"a":1}');
    expect(jsonOf('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonOf('Here it is: {"a":{"b":2}} done')).toBe('{"a":{"b":2}}');
    expect(jsonOf('')).toBe('{}');
  });

  it('drafts through anthropic/<model> with the server key, the schema in the system prompt', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-for-tests';
    process.env.ANTHROPIC_BASE_URL = fake.url.replace(/\/v1$/, '');
    answer = '```json\n' + draft([{ key: 'set', type: 'core.set', name: 'Set' }]) + '\n```';
    try {
      const built = await buildFlow('a manual flow that sets a field', 'anthropic/claude-sonnet-5-5');
      expect(built.nodes.map((n) => n.name)).toEqual(['Start', 'Set']);
      const request = fake.last('/v1/messages')!;
      expect(request.body.model).toBe('claude-sonnet-5-5');
      expect(request.body.max_tokens).toBe(16000);
      expect(request.body.temperature).toBeUndefined();
      expect(String(JSON.stringify(request.body.system))).toContain('matching this JSON schema');
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('AI builder agents', () => {
  const agents = [
    { id: 'ag_triage', name: 'Support triage', description: 'Routes support tickets', version: 3, skills: [], tools: ['search_crm'] },
    { id: 'ag_notes', name: 'Release notes writer', version: 1, skills: [], tools: [] },
  ];
  const withAgent = (agentId: string) =>
    JSON.stringify({ name: 'Tickets', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'agent', type: 'core.messageAgent', name: 'Triage', parameters: { agentId, message: 'Route it' } }], connections: [{ from: 'start', to: 'agent' }] });

  it('tells the model the published agents and when to run one, and turns the agent name it writes into the id', async () => {
    answer = withAgent('Support triage');
    const flow = await buildFlow('route each new ticket', undefined, [], agents);
    expect(flow.nodes.find((n) => n.key === 'agent')!.parameters).toEqual({ agentId: 'ag_triage', message: 'Route it' });
    const prompt = JSON.stringify(fake.last('/api/chat')?.body);
    expect(prompt).toContain('agentId ag_triage');
    expect(prompt).toContain('Tools: search_crm.');
    expect(prompt).toContain('when a step needs an agent, first look at');
  });

  it('clears an agent id nobody has, so the node asks for one', async () => {
    answer = withAgent('ag_made_up');
    expect((await buildFlow('route each new ticket', undefined, [], agents)).nodes.find((n) => n.key === 'agent')!.parameters).toEqual({ agentId: '', message: 'Route it' });
    answer = withAgent('ag_made_up');
    expect((await buildFlow('route each new ticket')).nodes.find((n) => n.key === 'agent')!.parameters).toEqual({ agentId: '', message: 'Route it' });
  });
});

describe('AI builder test items on a webhook', () => {
  it('pins them on a Webhook trigger too, so a test runs at once instead of waiting for a call', async () => {
    answer = JSON.stringify({
      name: 'Tickets',
      nodes: [{ key: 'hook', type: 'core.webhook', name: 'Ticket in', parameters: { path: 'tickets' } }, { key: 'set', type: 'core.set', name: 'Subject', parameters: { mode: 'manual' } }],
      connections: [{ from: 'hook', to: 'set' }],
      testData: [{ body: { subject: 'Export times out' } }],
    });
    expect((await buildFlow('take tickets by webhook')).pinData).toEqual({ hook: [{ json: { body: { subject: 'Export times out' } } }] });
    expect(JSON.stringify(fake.last('/api/chat')?.body)).toContain('With a Webhook trigger, each item is what a call brings');
  });

  it('pins a made-up item with the fields the steps read when the model gave none that fit', async () => {
    const flow = (testData?: unknown[]) =>
      JSON.stringify({
        name: 'Tickets',
        nodes: [
          { key: 'hook', type: 'core.webhook', name: 'Ticket in', parameters: { path: 'tickets' } },
          { key: 'set', type: 'core.set', name: 'Subject', parameters: { mode: 'manual', fields: { values: [{ name: 'line', type: 'string', value: '{{ $json.ticketDescription }} from {{ $json.body.customer_name }}' }] } } },
        ],
        connections: [{ from: 'hook', to: 'set' }],
        ...(testData && { testData }),
      });
    answer = flow();
    expect((await buildFlow('take tickets by webhook')).pinData).toEqual({ hook: [{ json: { ticketDescription: 'Sample ticket description', body: { customer_name: 'Sample customer name' } } }] });
    // Items that carry none of the fields read are dropped as noise, and the sample takes their place.
    answer = flow([{ subject: 'x' }]);
    expect((await buildFlow('take tickets by webhook')).pinData?.hook[0].json).toHaveProperty('ticketDescription');
  });
});

// SB01: the first draft fills its collections.
const chatCalls = () => fake.requests.filter((r) => r.path === '/api/chat');
const mark = () => chatCalls().length;
const byTypeOf = () => new Map(registry.nodeTypes().filter((t) => t.available).map((t) => [t.type, t]));

registry.registerBuiltin(
  definePlugin({
    info: { id: 'sb01app', name: 'Tracker (test)', version: '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({ description: { name: 'linear', displayName: 'Linear', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [{ name: 'operation', displayName: 'Operation', type: 'options', default: 'getAll', options: [{ name: 'Get all', value: 'getAll' }, { name: 'Create', value: 'create' }] }] }, async execute() { return [[]]; } }),
      defineNode({ description: { name: 'issueEvent', displayName: 'Issue Event', version: 1, kind: 'trigger', inputs: [], outputs: [{ type: 'main' }], properties: [] }, async execute() { return [[]]; } }),
    ],
  }),
);

const ifReply = (condition: unknown[]) =>
  JSON.stringify({
    name: 'Orders',
    nodes: [
      { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
      { key: 'check', type: 'core.if', name: 'Check total', parameters: { conditions: { condition }, combinator: 'and' } },
      { key: 'vip', type: 'core.respondToWebhook', name: 'Reply', parameters: {} },
    ],
    connections: [{ from: 'hook', to: 'check' }, { from: 'check', to: 'vip', output: 0 }],
    testData: [{ body: { total: 1500 } }],
  });
const FILLED = [{ left: '{{ $json.body.total }}', operator: 'gt', right: '1000' }];

describe('SB01: the first draft is held in JSON mode, checked and sent back once', () => {
  it('asks Ollama for json, with the schema in the system prompt', async () => {
    answer = ifReply(FILLED);
    const before = mark();
    await buildFlow('branch on the total');
    const body = chatCalls()[before].body;
    expect(body.format).toBe('json');
    expect(body.messages[0].content).toContain('matching this JSON schema');
    expect(body.messages[0].content).toContain('"connections"');
  });

  it('sends an empty If back once with the line for it, and takes the filled second draft', async () => {
    queue = [ifReply([]), ifReply(FILLED)];
    const before = mark();
    const flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(2);
    expect(flow.nodes.find((n) => n.key === 'check')!.parameters).toMatchObject({ conditions: { condition: FILLED } });
    expect(flow.left?.filter((l) => l.kind === 'empty')).toEqual([]);
    const second = chatCalls()[before + 1].body.messages;
    const asked = second[second.length - 1].content;
    expect(asked).toContain('“Check total”');
    expect(asked).toContain('conditions');
    expect(asked).toContain('core.if');
    expect(second.at(-2).role).toBe('assistant');
  });

  it('keeps the first draft and lists the If as empty when the second is empty too', async () => {
    queue = [ifReply([]), ifReply([])];
    const before = mark();
    const flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(2);
    expect(flow.left).toEqual([expect.objectContaining({ node: 'Check total', field: 'conditions', kind: 'empty', text: expect.stringContaining('Check total') })]);
  });

  const dropsReply = JSON.stringify({
    name: 'Orders',
    nodes: [
      { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
      { key: 'check', type: 'core.if', name: 'Check total', parameters: { conditions: { condition: FILLED }, combinator: 'and' } },
    ],
    connections: [{ from: 'hook', to: 'check' }],
  });

  it('keeps the first draft when the second fills the If but loses a step type', async () => {
    queue = [ifReply([]), dropsReply];
    const before = mark();
    const flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(2);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.left).toEqual([expect.objectContaining({ node: 'Check total', kind: 'empty' })]);
  });

  it('keeps the first draft when the second reply does not parse', async () => {
    for (const second of ['not json at all', JSON.stringify({ nodes: { a: 1 } })]) {
      queue = [ifReply([]), second];
      const before = mark();
      const flow = await buildFlow('branch on the total');
      expect(chatCalls().length - before).toBe(2);
      expect(flow.nodes).toHaveLength(3);
      expect(flow.left).toEqual([expect.objectContaining({ node: 'Check total', kind: 'empty' })]);
    }
  });

  it('keeps the first draft when the second has more empty parts', async () => {
    const worse = JSON.parse(ifReply([]));
    worse.nodes.push({ key: 'sw', type: 'core.set', name: 'Shape', parameters: { mode: 'manual' } });
    worse.connections.push({ from: 'vip', to: 'sw' });
    queue = [ifReply([]), JSON.stringify(worse)];
    const flow = await buildFlow('branch on the total');
    expect(flow.nodes).toHaveLength(3);
  });

  it('keeps the first draft when the send-back fails: an Ollama 500, or a timeout in what is left of the budget', async () => {
    queue = [ifReply([]), { error: { status: 500, body: '{"error":"out of memory"}' } }];
    let before = mark();
    let flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(2);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.left).toEqual([expect.objectContaining({ node: 'Check total', kind: 'empty' })]);

    queue = [ifReply([]), { text: ifReply(FILLED), delayMs: 1500 }];
    process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS = '1';
    try {
      before = mark();
      flow = await buildFlow('branch on the total');
    } finally {
      delete process.env.LANDFLOW_BUILDER_TIMEOUT_SECONDS;
    }
    expect(chatCalls().length - before).toBe(2);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.left).toEqual([expect.objectContaining({ node: 'Check total', kind: 'empty' })]);
  });

  it('takes a reply whose name, test data and outputs are the wrong shape, and nodes numbered with numbers', async () => {
    answer = JSON.stringify({
      name: 7,
      nodes: [{ key: 1, type: 'core.manualTrigger', name: 'Start' }, { key: 2, type: 'core.noOp', name: 'Done' }],
      connections: [{ from: 1, to: 2, output: 'first' }],
      testData: { q: 1 },
    });
    const before = mark();
    const flow = await buildFlow('do nothing');
    expect(chatCalls().length - before).toBe(1);
    expect(flow.name).toBe('Generated workflow');
    expect(flow.edges).toEqual([['1', '2', 0, 'main']]);
    expect(flow.dropped).toEqual([]);
  });

  it('makes one request for a draft with nothing empty', async () => {
    answer = ifReply(FILLED);
    const before = mark();
    const flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(1);
    expect(flow.left).toEqual([]);
  });

  it('sends a reply without a nodes array back once, with the words of the parse', async () => {
    queue = [JSON.stringify({ name: 'x', nodes: { a: 1 }, connections: [] }), ifReply(FILLED)];
    const before = mark();
    const flow = await buildFlow('branch on the total');
    expect(chatCalls().length - before).toBe(2);
    expect(flow.nodes).toHaveLength(3);
    const second = chatCalls()[before + 1].body.messages;
    expect(second.at(-1).content).toMatch(/nodes/);
    queue = [JSON.stringify({ nodes: { a: 1 } }), JSON.stringify({ nodes: 'no' })];
    await expect(buildFlow('branch on the total')).rejects.toThrow('The model did not return valid JSON. Try again or rephrase.');
  });
});

describe('SB01: emptyParts', () => {
  const node = (key: string, type: string, name: string, parameters: Record<string, unknown>) => ({ key, type, name, x: 0, y: 0, parameters });
  const parts = (nodes: ReturnType<typeof node>[]) => emptyParts({ nodes, edges: [] }, byTypeOf());

  it('lists a Switch with an empty rule, a schedule with no interval and a Set in manual mode with no fields', () => {
    const found = parts([
      node('s', 'core.switch', 'Route', { mode: 'rules', rules: { values: [{}] } }),
      node('t', 'core.schedule', 'Every morning', { unit: 'rules' }),
      node('u', 'core.set', 'Shape', { mode: 'manual' }),
      node('v', 'core.set', 'Shape json', { mode: 'json', json: '{}' }),
      node('i', 'core.if', 'Check', { conditions: { condition: [{ left: '{{ $json.a }}', operator: 'gt', right: '1' }] }, combinator: 'and' }),
    ]).filter((p) => p.kind === 'empty');
    expect(found.map((p) => `${p.node}:${p.field}`).sort()).toEqual(['Every morning:rule', 'Route:rules', 'Shape:fields']);
    expect(found.find((p) => p.node === 'Route')!.ask).toContain('“Route” (core.switch): rules is empty');
  });

  it('does not list what the node ships filled: a workflow trigger’s inputs, a form’s fields, a schedule rule of a named kind', () => {
    expect(
      parts([
        node('w', 'core.workflowTrigger', 'When called', {}),
        node('x', 'core.workflowTrigger', 'When called 2', { inputs: {} }),
        node('f', 'core.formTrigger', 'Form in', {}),
        node('g', 'core.form', 'Ask', { formFields: {} }),
        node('t', 'core.schedule', 'Daily', { unit: 'rules', rule: { interval: [{ field: 'days' }] } }),
      ]).filter((p) => p.kind === 'empty'),
    ).toEqual([]);
    // A rule with no kind and a form whose fields were emptied are still listed.
    expect(parts([node('t', 'core.schedule', 'Daily', { unit: 'rules', rule: { interval: [{}] } }), node('g', 'core.form', 'Ask', { formFields: { values: [] } })]).filter((p) => p.kind === 'empty').map((p) => p.field).sort()).toEqual(['formFields', 'rule']);
  });

  it('does not list a rule row with a time, or an optional list nobody needs', () => {
    expect(
      parts([
        node('t', 'core.schedule', 'Daily', { unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } }),
        node('h', 'core.httpRequest', 'Call', { url: 'http://127.0.0.1:3402/x', method: 'POST' }),
      ]).filter((p) => p.kind === 'empty'),
    ).toEqual([]);
  });
});

describe('SB01: table columns', () => {
  const table = (parameters: Record<string, unknown>) => emptyParts({ nodes: [{ key: 'd', type: 'core.dataTable', name: 'Save', x: 0, y: 0, parameters }], edges: [] }, byTypeOf()).filter((p) => p.kind === 'empty');

  it('lists a table write with no column values, however the empty value is written', () => {
    for (const columns of [undefined, {}, { column: [] }, { column: [{}] }]) {
      const found = table({ operation: 'insert', mappingMode: 'defineBelow', dataTableId: 'Bugs', ...(columns && { columns }) });
      expect(found.map((p) => p.field)).toEqual(['columns']);
      expect(found[0].left).toContain('no column values yet');
    }
  });

  it('does not list a filled table, or one that maps automatically', () => {
    expect(table({ operation: 'insert', mappingMode: 'defineBelow', dataTableId: 'Bugs', columns: { column: [{ column: 'title', value: '{{ $json.title }}' }] } })).toEqual([]);
    expect(table({ operation: 'insert', mappingMode: 'autoMapInputData', dataTableId: 'Bugs' })).toEqual([]);
    expect(table({ operation: 'get', dataTableId: 'Bugs' })).toEqual([]);
  });
});

describe('SB01: near-miss types', () => {
  const reply = (type: string) => JSON.stringify({ name: 'Linear', nodes: [{ key: 'a', type, name: 'Get issues', parameters: { operation: 'getAll' } }], connections: [], testData: [{ id: 'ISS-1' }] });

  it('maps core.linear.linear to the one linear node', async () => {
    answer = reply('core.linear.linear');
    const flow = await buildFlow('get my Linear issues');
    expect(flow.nodes.find((n) => n.name === 'Get issues')!.type).toBe('sb01app.linear');
    expect(flow.dropped.join(' ')).not.toContain('core.linear.linear');
  });

  it('lists the remapped type, so the person can check it is the one meant', async () => {
    answer = reply('core.linear.linear');
    const flow = await buildFlow('get my Linear issues');
    expect(flow.left).toContainEqual(expect.objectContaining({ node: 'Get issues', kind: 'dropped', text: expect.stringContaining('core.linear.linear') }));
  });

  it('lists no remap for a step that is left out anyway (a repeated key)', async () => {
    answer = JSON.stringify({ name: 'Linear', nodes: [{ key: 'a', type: 'core.manualTrigger', name: 'Go' }, { key: 'a', type: 'core.linear.linear', name: 'Get issues', parameters: {} }], connections: [] });
    const flow = await buildFlow('get my Linear issues');
    expect(flow.left.some((l) => l.text.includes('was used instead'))).toBe(false);
  });

  it('drops it and lists it when two types could be meant', async () => {
    registry.registerBuiltin(definePlugin({ info: { id: 'sb01other', name: 'Other (test)', version: '1.0.0', language: 'typescript' }, nodes: [defineNode({ description: { name: 'linear', displayName: 'Linear too', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] }, async execute() { return [[]]; } })] }));
    answer = JSON.stringify({ name: 'Linear', nodes: [{ key: 'a', type: 'core.linear.linear', name: 'Get issues', parameters: {} }, { key: 'b', type: 'core.manualTrigger', name: 'Go' }], connections: [{ from: 'b', to: 'a' }] });
    const flow = await buildFlow('get my Linear issues');
    expect(flow.nodes.some((n) => n.name === 'Get issues')).toBe(false);
    expect(flow.left).toContainEqual(expect.objectContaining({ node: 'Get issues', kind: 'dropped' }));
    registry.remove('sb01other');
  });
});

describe('SB01: test data for schedule and app triggers', () => {
  const sched = { key: 't', type: 'core.schedule', name: 'Every day', parameters: { unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } } };
  const flowOf = (nodes: unknown[], connections: unknown[]) => JSON.stringify({ name: 'Flow', nodes, connections, testData: [{ id: 'ISS-1', title: 'Crash' }, { id: 'ISS-2', title: 'Slow' }] });

  it('pins the items on an app step that reads data after a schedule', async () => {
    answer = flowOf([sched, { key: 'g', type: 'sb01app.linear', name: 'Get issues', parameters: { operation: 'getAll' } }], [{ from: 't', to: 'g' }]);
    expect((await buildFlow('every day get the issues')).pinData).toEqual({ g: [{ json: { id: 'ISS-1', title: 'Crash' } }, { json: { id: 'ISS-2', title: 'Slow' } }] });
  });

  it('pins nothing after a schedule that goes to a Set', async () => {
    answer = flowOf([sched, { key: 's', type: 'core.set', name: 'Stamp', parameters: { mode: 'manual', fields: { values: [{ name: 'a', type: 'string', value: 'b' }] } } }], [{ from: 't', to: 's' }]);
    expect((await buildFlow('every day stamp')).pinData).toBeUndefined();
  });

  it('pins the items on an app trigger', async () => {
    answer = flowOf([{ key: 'e', type: 'sb01app.issueEvent', name: 'New issue', parameters: {} }, { key: 's', type: 'core.set', name: 'Stamp', parameters: { mode: 'manual', fields: { values: [{ name: 'a', type: 'string', value: 'b' }] } } }], [{ from: 'e', to: 's' }]);
    expect(Object.keys((await buildFlow('when an issue is created')).pinData ?? {})).toEqual(['e']);
  });
});
