/**
 * Wave 6 of token & cost tracking: cached-token prices (Anthropic cache reads and writes, OpenAI cached input) from the
 * usage the adapters get, stored and shown in totals; caps per model credential and per user (who started the run), per day
 * or month, enforced like the other caps; cost alerts at a threshold of any cap, once per period, through an alert channel.
 * Model calls go to the fake OpenAI/Anthropic server, alerts to a fake receiver.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode, WorkflowSettings } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-caps-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { withAuth } = await import('@/lib/server/auth/context');
const { createUser } = await import('@/lib/server/auth/users');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, estimateCost, DEFAULT_PRICES, findPrice, savePriceOverrides, saveAiCaps } = await import('@/lib/server/ai-usage');
const { anthropicUsage } = await import('@/lib/server/nodes/models');
const { checkCosts, periodKey, watchedCaps } = await import('@/lib/server/ai-usage/alerts');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const usageRoute = await import('@/app/api/insights/ai-usage/route');
const pricesRoute = await import('@/app/api/settings/ai-prices/route');
const capsRoute = await import('@/app/api/settings/ai-caps/route');
const { formatCache } = await import('@/lib/shared/ai-usage');

registry.registerBuiltin(corePlugin);

/** OpenAI-style: 1,000 prompt tokens of which 400 cached. Anthropic-style: 200 + 600 read + 100 written. */
const fake = await startFakeModels({
  reply: (provider) => ({
    text: 'ok',
    usage: provider === 'anthropic' ? { input: 200, output: 100, cacheRead: 600, cacheWrite: 100 } : { input: 1_000, output: 100, cacheRead: 400 },
  }),
});

const received: Array<{ path: string; json: Record<string, unknown> }> = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ path: req.url ?? '', json: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
    res.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

const openAi = credentials.create({ name: 'Team OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const otherOpenAi = credentials.create({ name: 'Other OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-other', baseUrl: fake.url } });
const anthropic = credentials.create({ name: 'Team Claude', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: fake.origin } });
const ref = (credential: { id: string; name: string }) => ({ id: credential.id, name: credential.name });

afterAll(async () => {
  alerts.stop();
  await fake.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

/** Manual trigger → AI Agent (one model call) on gpt-test via `credential`, or on Claude. */
function agentWorkflow(id: string, options: { settings?: WorkflowSettings; credential?: { id: string; name: string }; claude?: boolean } = {}): Workflow {
  const model = options.claude
    ? node('Model', 'core.anthropicChatModel', { model: 'claude-test', effort: 'low', maxTokens: 1024, fallback: false }, { credentials: { anthropicApi: ref(anthropic) } })
    : node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: options.credential ?? ref(openAi) } });
  const workflow: Workflow = {
    id,
    name: `Caps ${id}`,
    settings: options.settings ?? {},
    nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.aiAgent', { prompt: 'Hello' }), model],
    connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel')],
  };
  store.saveWorkflow(workflow);
  return workflow;
}

const run = (workflow: Workflow) => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
const runAs = (userId: string, workflow: Workflow) => withAuth({ principal: { user: { id: userId } as never, via: 'test' } }, () => run(workflow));
const chatCalls = () => fake.requests.filter((r) => r.path === '/v1/chat/completions' || r.path === '/v1/messages').length;
const report = async (query: string) => (await usageRoute.GET(new Request(`http://usage.test/api/insights/ai-usage?${query}`))).json();
const json = (method: string, body: unknown) => new Request('http://caps.test/api', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  // gpt-test and claude-test: $1 in / $2 out; cache read $0.1, cache write $1.5 (per million tokens).
  savePriceOverrides([
    { provider: 'openai', model: 'gpt-test', input: 1, output: 2, cacheRead: 0.1 },
    { provider: 'anthropic', model: 'claude-test', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
  ]);
  aiUsageMeter().invalidatePrices();
  saveAiCaps({ credentials: {}, users: {} });
  aiUsageMeter().invalidateCaps();
  const db = database();
  for (const table of ['ai_usage', 'alert_state', 'alert_rules', 'alert_channels'] as const) db.sqlite.exec(`DELETE FROM ${table}`);
  received.length = 0;
});

describe('cached-token prices', () => {
  it('prices the cached parts with the cache prices and the rest with the input price', () => {
    const price = { provider: 'anthropic', model: 'x', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    // 1,000 prompt tokens: 600 read, 100 written, 300 plain; 200 out.
    expect(estimateCost(price, 1_000, 200, 600, 100)).toBeCloseTo((300 * 3 + 600 * 0.3 + 100 * 3.75 + 200 * 15) / 1e6, 10);
    // Without cache prices, cached tokens cost the input price (no discount).
    expect(estimateCost({ provider: 'x', model: 'y', input: 2, output: 4 }, 1_000, 0, 500, 0)).toBeCloseTo(0.002, 10);
    // Cached counts never exceed the prompt.
    expect(estimateCost(price, 100, 0, 500, 500)).toBeCloseTo((100 * 0.3) / 1e6, 10);
    expect(estimateCost(undefined, 1_000, 1_000, 100, 100)).toBe(0);
  });

  it('ships cache prices for Anthropic (0.1x read, 1.25x write) and OpenAI (cached input)', () => {
    const sonnet = findPrice('anthropic', 'claude-sonnet-4-6')!;
    expect(sonnet.cacheRead).toBeCloseTo(sonnet.input * 0.1, 6);
    expect(sonnet.cacheWrite).toBeCloseTo(sonnet.input * 1.25, 6);
    const gpt4o = findPrice('openai', 'gpt-4o')!;
    expect(gpt4o.cacheRead).toBe(1.25);
    expect(gpt4o.cacheWrite).toBeUndefined();
    expect(DEFAULT_PRICES.filter((price) => price.provider === 'openai' && price.model.startsWith('gpt')).every((price) => price.cacheRead !== undefined && price.cacheRead < price.input)).toBe(true);
  });

  it('counts the whole Anthropic prompt as input, with its cached parts', () => {
    expect(anthropicUsage({ input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 600, cache_creation_input_tokens: 100 })).toEqual({ inputTokens: 900, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100 });
    expect(anthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null })).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('prices an OpenAI call with cached input and stores it, in the execution totals and the report', async () => {
    const record = await run(agentWorkflow('wf_cache_openai'));
    expect(record.status).toBe('success');
    // gpt-test: 600 plain x $1 + 400 cached x $0.1 + 100 out x $2 = $0.00084.
    expect(record.aiUsage).toMatchObject({ inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 400, calls: 1, models: [{ model: 'gpt-test', cacheReadTokens: 400 }] });
    expect(record.aiUsage!.cost).toBeCloseTo(0.00084, 9);
    expect(record.aiUsage!.cacheWriteTokens).toBeUndefined();
    const stored = store.getExecution(record.executionId)!.aiUsage!;
    expect(stored.cacheReadTokens).toBe(400);
    const totals = (await report(`executionId=${record.executionId}`)).totals;
    expect(totals).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 400 });
    expect(totals.cost).toBeCloseTo(0.00084, 9);
    expect(formatCache(stored)).toBe('400 read');
    const grouped = await report('group=workflow');
    expect(grouped.workflows).toContainEqual(expect.objectContaining({ workflowId: 'wf_cache_openai', cacheReadTokens: 400 }));
  });

  it('prices an Anthropic call with cache reads and writes', async () => {
    const record = await run(agentWorkflow('wf_cache_claude', { claude: true }));
    expect(record.error?.message).toBeUndefined();
    expect(record.status).toBe('success');
    // claude-test: 900 prompt tokens = 200 plain x $1 + 600 read x $0.1 + 100 written x $1.5; 100 out x $2 = $0.00061.
    expect(record.aiUsage).toMatchObject({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 100, calls: 1 });
    expect(record.aiUsage!.cost).toBeCloseTo(0.00061, 9);
    expect(formatCache(record.aiUsage!)).toBe('600 read · 100 written');
  });

  it('Settings → AI prices keeps the cache columns and rejects negative ones', async () => {
    const saved = await pricesRoute.PUT(json('PUT', { overrides: [{ provider: 'openai', model: 'gpt-test', input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6 }] }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).overrides).toEqual([{ provider: 'openai', model: 'gpt-test', input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6 }]);
    expect(aiUsageMeter().cost({ provider: 'openai', model: 'gpt-test', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.5, 9);
    expect((await pricesRoute.PUT(json('PUT', { overrides: [{ provider: 'openai', model: 'gpt-test', input: 1, output: 1, cacheRead: -1 }] }))).status).toBe(400);
    const table = await (await pricesRoute.GET()).json();
    expect(table.defaults.find((price: { model: string }) => price.model === 'gpt-4o')).toMatchObject({ cacheRead: 1.25 });
  });
});

describe('caps per credential', () => {
  it('stops calls made with a credential past its daily cap, with a clear error, and leaves other credentials alone', async () => {
    const saved = await capsRoute.PUT(json('PUT', { credentials: { [openAi.id]: { dayTokens: 1_500 } }, users: {} }));
    expect(saved.status).toBe(200);
    // The name is saved with the cap, for the error.
    expect((await saved.json()).caps.credentials[openAi.id]).toEqual({ name: 'Team OpenAI', dayTokens: 1_500 });

    const workflow = agentWorkflow('wf_cred_cap');
    expect((await run(workflow)).status).toBe('success');
    const second = await run(workflow);
    expect(second.status).toBe('error');
    expect(second.error!.message).toContain('AI usage cap reached: credential “Team OpenAI” today used 2,200 tokens of its 1,500 tokens limit (Settings → AI prices → AI usage caps)');
    const before = chatCalls();
    const third = await run(workflow);
    expect(third.status).toBe('error');
    expect(chatCalls()).toBe(before);
    // Another credential, even in the same workflow type, is not affected.
    expect((await run(agentWorkflow('wf_cred_cap_other', { credential: ref(otherOpenAi) }))).status).toBe('success');
  });

  it('caps a credential by cost per month', async () => {
    saveAiCaps({ credentials: { [openAi.id]: { name: 'Team OpenAI', monthCost: 0.001 } }, users: {} });
    aiUsageMeter().invalidateCaps();
    const workflow = agentWorkflow('wf_cred_month');
    expect((await run(workflow)).status).toBe('success'); // $0.00084
    const second = await run(workflow);
    expect(second.status).toBe('error');
    expect(second.error!.message).toContain('credential “Team OpenAI” this month used $0.0017 of its $0.0010 limit');
  });

  it('validates the ids on save and shows usage', async () => {
    expect((await capsRoute.PUT(json('PUT', { credentials: { cred_missing: { dayTokens: 1 } }, users: {} }))).status).toBe(400);
    expect((await capsRoute.PUT(json('PUT', { credentials: {}, users: { usr_missing: { dayTokens: 1 } } }))).status).toBe(400);
    expect((await capsRoute.PUT(json('PUT', { credentials: { [openAi.id]: { dayTokens: -5 } }, users: {} }))).status).toBe(400);
    await capsRoute.PUT(json('PUT', { credentials: { [openAi.id]: { dayTokens: 1_000_000 } }, users: {} }));
    await run(agentWorkflow('wf_cred_usage'));
    const view = await (await capsRoute.GET()).json();
    expect(view.usage.credentials[openAi.id].day).toMatchObject({ inputTokens: 1_000, outputTokens: 100, calls: 1 });
    // A zero means no cap: the set disappears.
    await capsRoute.PUT(json('PUT', { credentials: { [openAi.id]: { dayTokens: 0 } }, users: {} }));
    expect((await (await capsRoute.GET()).json()).caps.credentials).toEqual({});
  });
});

describe('caps per user', () => {
  it('counts the runs a user started and stops them at the cap', async () => {
    const ann = await createUser({ email: 'ann@example.com', name: 'Ann', role: 'editor' });
    const bob = await createUser({ email: 'bob@example.com', name: 'Bob', role: 'editor' });
    const saved = await capsRoute.PUT(json('PUT', { credentials: {}, users: { [ann.id]: { dayTokens: 1_500 } } }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).caps.users[ann.id].name).toBe('Ann');

    const workflow = agentWorkflow('wf_user_cap');
    expect((await runAs(ann.id, workflow)).status).toBe('success');
    const second = await runAs(ann.id, workflow);
    expect(second.status).toBe('error');
    expect(second.error!.message).toContain('AI usage cap reached: user “Ann” today used 2,200 tokens of its 1,500 tokens limit');
    const before = chatCalls();
    expect((await runAs(ann.id, workflow)).status).toBe('error');
    expect(chatCalls()).toBe(before);
    // Bob and runs without a user (a trigger) are not capped.
    expect((await runAs(bob.id, workflow)).status).toBe('success');
    expect((await runWorkflow({ workflow, mode: 'trigger', startNodeId: 'Start' })).status).toBe('success');
    const rows = database().all<{ user_id: string | null }>('SELECT DISTINCT user_id FROM ai_usage ORDER BY user_id').map((row) => row.user_id);
    expect(rows).toContain(ann.id);
    expect(rows).toContain(null);
  });

  it('applies the cap for every user to users without one of their own', async () => {
    const cy = await createUser({ email: 'cy@example.com', name: 'Cy', role: 'editor' });
    const di = await createUser({ email: 'di@example.com', name: 'Di', role: 'editor' });
    saveAiCaps({ credentials: {}, users: { [di.id]: { name: 'Di', dayTokens: 100_000 } }, allUsers: { dayTokens: 1_500 } });
    aiUsageMeter().invalidateCaps();
    const workflow = agentWorkflow('wf_user_all');
    expect((await runAs(cy.id, workflow)).status).toBe('success');
    const second = await runAs(cy.id, workflow);
    expect(second.error!.message).toContain('user “Cy” (the cap for every user) today used 2,200 tokens of its 1,500 tokens limit');
    // Di has her own, higher cap.
    expect((await runAs(di.id, workflow)).status).toBe('success');
    expect((await runAs(di.id, workflow)).status).toBe('success');
  });
});

describe('cost alerts', () => {
  const webhook = () => alertStore.createChannel({ name: 'Finance', kind: 'webhook', config: { url: `${receiverUrl}/hook` } });
  const costRule = (channelId: string, thresholdPercent = 80) =>
    alertStore.createRule({ name: 'AI cost', kind: 'cost', enabled: true, workflows: { mode: 'all' }, events: ['costThreshold'], channelIds: [channelId], throttleMinutes: 0, cost: { thresholdPercent } });

  it('lists every cap with a period and its usage', async () => {
    const workflow = agentWorkflow('wf_cost_list', { settings: { aiMaxTokensPerDay: 2_000 } });
    saveAiCaps({ credentials: { [openAi.id]: { name: 'Team OpenAI', monthCost: 5 } }, users: {} });
    aiUsageMeter().invalidateCaps();
    await run(workflow);
    const caps = watchedCaps();
    expect(caps).toContainEqual(expect.objectContaining({ id: 'workflow:wf_cost_list:day:tokens', max: 2_000, used: 1_100, period: 'day', metric: 'tokens' }));
    expect(caps).toContainEqual(expect.objectContaining({ id: `credential:${openAi.id}:month:cost`, max: 5, period: 'month', metric: 'cost' }));
    expect(periodKey('day', '2026-10-27')).toBe('2026-10-27');
    expect(periodKey('month', '2026-10-27')).toBe('2026-10');
  });

  it('alerts once per period when usage reaches the threshold, before the cap stops anything', async () => {
    const channel = webhook();
    costRule(channel.id, 80);
    // 1,100 of 1,300 tokens a day: 84%.
    const workflow = agentWorkflow('wf_cost_alert', { settings: { aiMaxTokensPerDay: 1_300 } });
    expect((await run(workflow)).status).toBe('success');
    await alerts.tick();
    const hooks = received.filter((r) => r.path === '/hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].json).toMatchObject({ type: 'alert', event: 'costThreshold' });
    expect(String(hooks[0].json.summary)).toContain('AI cost: workflow “Caps wf_cost_alert” used 84% of its daily token cap');
    expect(hooks[0].json.details).toMatchObject({ Used: '1,100 tokens of 1,300 tokens (84%)' });
    // Once per period: more ticks, and more usage, send nothing more.
    await alerts.tick();
    expect(received.filter((r) => r.path === '/hook')).toHaveLength(1);
    // The cap is not reached yet, so the next run still works (and then stops at the cap).
    expect((await run(workflow)).status).toBe('error');
    await alerts.tick();
    expect(received.filter((r) => r.path === '/hook')).toHaveLength(1);
  });

  it('stays quiet below the threshold, and watches credential and user caps too', async () => {
    const channel = webhook();
    costRule(channel.id, 90);
    const workflow = agentWorkflow('wf_cost_quiet', { settings: { aiMaxTokensPerDay: 5_000 } });
    saveAiCaps({ credentials: { [openAi.id]: { name: 'Team OpenAI', dayTokens: 1_200 } }, users: {} });
    aiUsageMeter().invalidateCaps();
    await run(workflow);
    await alerts.tick();
    // The workflow is at 22%; the credential at 92%: one alert, for the credential.
    const hooks = received.filter((r) => r.path === '/hook');
    expect(hooks).toHaveLength(1);
    expect(String(hooks[0].json.summary)).toContain('credential “Team OpenAI” used 91% of its daily token cap');
  });

  it('does nothing without a cost rule or when its channel is gone', async () => {
    const workflow = agentWorkflow('wf_cost_none', { settings: { aiMaxTokensPerDay: 1_200 } });
    await run(workflow);
    await alerts.tick();
    expect(received).toHaveLength(0);
    const channel = webhook();
    const rule = costRule(channel.id);
    alertStore.deleteChannel(channel.id);
    await alerts.tick();
    expect(alertStore.rule(rule.id)!.channelIds).toEqual([]);
    expect(received).toHaveLength(0);
  });

  it('Settings → Alerts validates a cost rule through the API defaults', async () => {
    const channel = webhook();
    const rule = alertStore.createRule({ name: 'AI', kind: 'cost', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: [channel.id], throttleMinutes: 10 });
    // Events are the kind's own; the threshold gets its default.
    expect(rule.events).toEqual(['costThreshold']);
    expect(rule.cost).toEqual({ thresholdPercent: 80 });
    void checkCosts;
  });
});
