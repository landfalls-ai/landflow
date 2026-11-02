/**
 * Token & cost tracking with caps (lib/server/ai-usage): the price table (defaults, prefixes, overrides, Ollama
 * free), one row per model call, totals on the execution record and in the usage report, the per-execution and
 * per-workflow-per-day caps of Workflow settings (a resumed execution counts its earlier segments), and agent
 * usage limits. Model calls go to the fake OpenAI-compatible server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode, WorkflowSettings } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-usage-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { decideApproval } = await import('@/lib/server/approvals');
const { aiUsageMeter, DEFAULT_PRICES, estimateCost, findPrice, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const usageRoute = await import('@/app/api/insights/ai-usage/route');
const pricesRoute = await import('@/app/api/settings/ai-prices/route');
const { formatCost, formatTokens } = await import('@/lib/shared/ai-usage');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
const ref = { id: openAi.id, name: openAi.name };

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** gpt-test at $1 / $2 per million tokens: each fake call (12 in, 8 out) costs $0.000028. */
beforeEach(() => {
  savePriceOverrides([{ provider: 'openai', model: 'gpt-test', input: 1, output: 2 }]);
  aiUsageMeter().invalidatePrices();
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

/** Manual trigger → AI Agent on gpt-test; with the Calculator the agent makes two model calls, without it one. */
function agentWorkflow(id: string, settings: WorkflowSettings = {}, options: { calculator?: boolean; agent?: Record<string, unknown> } = {}): Workflow {
  const workflow: Workflow = {
    id,
    name: `Usage ${id}`,
    settings,
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Agent', 'core.aiAgent', { prompt: 'What is 6*7?', ...options.agent }),
      node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: ref } }),
      ...(options.calculator ? [node('Calculator', 'core.calculatorTool')] : []),
    ],
    connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), ...(options.calculator ? [edge('Calculator', 'Agent', 'ai_tool')] : [])],
  };
  store.saveWorkflow(workflow);
  return workflow;
}

const run = (workflow: Workflow) => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
const chatCalls = () => fake.requests.filter((r) => r.path === '/v1/chat/completions').length;
const report = async (query: string) => (await usageRoute.GET(new Request(`http://usage.test/api/insights/ai-usage?${query}`))).json();

describe('price table', () => {
  it('prices exact ids, dated ids by prefix, vendor-prefixed ids, and leaves Ollama free', () => {
    const sonnet = DEFAULT_PRICES.find((p) => p.provider === 'anthropic' && p.model.startsWith('claude-sonnet'))!;
    expect(findPrice('anthropic', sonnet.model)).toEqual(sonnet);
    expect(findPrice('anthropic', `${sonnet.model}-20261001`)).toEqual(sonnet);
    expect(findPrice('openai', `anthropic/${sonnet.model}`)).toEqual(sonnet);
    const gpt = DEFAULT_PRICES.find((p) => p.provider === 'openai' && p.model.startsWith('gpt-'))!;
    expect(findPrice('openai', gpt.model)).toEqual(gpt);
    expect(findPrice('ollama', 'qwen3-coder:30b')).toBeUndefined();
    expect(findPrice('ollama', gpt.model)).toBeUndefined();
    expect(findPrice('openai', 'totally-unknown-model')).toBeUndefined();
  });

  it('lets overrides win, Ollama included', () => {
    const overrides = [
      { provider: 'ollama', model: 'qwen3', input: 0.1, output: 0.2 },
      { provider: 'anthropic', model: 'claude-sonnet', input: 99, output: 99 },
    ];
    expect(findPrice('ollama', 'qwen3-coder:30b', overrides)).toMatchObject({ input: 0.1 });
    expect(findPrice('anthropic', 'claude-sonnet-5-5', overrides)).toMatchObject({ input: 99 });
    expect(estimateCost({ provider: 'x', model: 'y', input: 3, output: 15 }, 1_000_000, 100_000)).toBeCloseTo(4.5);
    expect(estimateCost(undefined, 1000, 1000)).toBe(0);
  });

  it('prices the 5.5 models: cache reads at 5% of input, and Haiku 5.5 at its long-context tier over 100K', () => {
    const sonnet = findPrice('anthropic', 'claude-sonnet-5-5')!;
    expect(sonnet).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(findPrice('anthropic', 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    // 10K fresh input, 90K read from the cache, 1K out.
    expect(estimateCost(sonnet, 100_000, 1_000, 90_000)).toBeCloseTo((10_000 * 2 + 90_000 * 0.1 + 1_000 * 10) / 1e6, 9);
    const haiku = findPrice('anthropic', 'claude-haiku-5-5')!;
    expect(haiku.longContext).toMatchObject({ above: 100_000, input: 0.5, output: 2.5 });
    expect(estimateCost(haiku, 100_000, 1_000)).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 9);
    // Over the threshold the whole request is at the long-context price.
    expect(estimateCost(haiku, 200_000, 1_000)).toBeCloseTo((200_000 * 0.5 + 1_000 * 2.5) / 1e6, 9);
  });

  it('formats costs and tokens', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.00002)).toBe('<$0.0001');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(12.5)).toBe('$12.50');
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });

  it('reads and saves overrides through Settings → AI prices', async () => {
    const put = (body: unknown) => pricesRoute.PUT(new Request('http://usage.test/api/settings/ai-prices', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const saved = await put({ overrides: [{ provider: 'openai', model: 'gpt-test', input: 5, output: 10 }] });
    expect(saved.status).toBe(200);
    expect((await saved.json()).overrides).toEqual([{ provider: 'openai', model: 'gpt-test', input: 5, output: 10 }]);
    const table = await (await pricesRoute.GET()).json();
    expect(table.defaults.length).toBeGreaterThan(5);
    expect(table.overrides[0].input).toBe(5);
    // The meter uses the new price at once.
    expect(aiUsageMeter().cost({ provider: 'openai', model: 'gpt-test', inputTokens: 1_000_000, outputTokens: 0 })).toBe(5);
    expect((await put({ overrides: [{ provider: 'openai', model: 'gpt-test', input: -1, output: 0 }] })).status).toBe(400);
  });
});

describe('accounting', () => {
  it('records every model call and keeps the totals on the execution', async () => {
    const record = await run(agentWorkflow('wf_usage_basic', {}, { calculator: true }));
    expect(record.status).toBe('success');
    expect(record.aiUsage).toMatchObject({ inputTokens: 24, outputTokens: 16, calls: 2, models: [{ provider: 'openai', model: 'gpt-test', inputTokens: 24, outputTokens: 16, calls: 2 }] });
    expect(record.aiUsage!.cost).toBeCloseTo(0.000056, 9);
    // Saved with the execution.
    expect(store.getExecution(record.executionId)!.aiUsage).toMatchObject({ calls: 2 });

    const byExecution = await report(`executionId=${record.executionId}`);
    expect(byExecution.totals).toMatchObject({ inputTokens: 24, outputTokens: 16, calls: 2 });
    expect(byExecution.totals.cost).toBeCloseTo(0.000056, 9);
    const byWorkflow = await report('workflowId=wf_usage_basic');
    expect(byWorkflow.today).toMatchObject({ inputTokens: 24, outputTokens: 16 });
    expect(byWorkflow.days).toHaveLength(1);
    const grouped = await report('group=workflow');
    expect(grouped.workflows).toContainEqual(expect.objectContaining({ workflowId: 'wf_usage_basic', calls: 2 }));
    expect((await usageRoute.GET(new Request('http://usage.test/api/insights/ai-usage?from=yesterday'))).status).toBe(400);
  });

  it('an execution without model calls has no aiUsage', async () => {
    const workflow: Workflow = { id: 'wf_usage_none', name: 'None', nodes: [node('Start', 'core.manualTrigger'), node('Noop', 'core.noOp')], connections: [edge('Start', 'Noop')] };
    store.saveWorkflow(workflow);
    expect((await run(workflow)).aiUsage).toBeUndefined();
  });
});

describe('workflow caps', () => {
  it('stops an execution once its token cap is passed, with a clear error', async () => {
    const before = chatCalls();
    const record = await run(agentWorkflow('wf_cap_tokens', { aiMaxTokensPerExecution: 25 }, { calculator: true }));
    expect(record.status).toBe('error');
    expect(record.error!.message).toContain('AI usage cap reached: this execution used 40 tokens of its 25 tokens limit (Workflow settings → AI usage limits)');
    // Both calls happened (the second one went over), and both are counted.
    expect(chatCalls() - before).toBe(2);
    expect(record.aiUsage).toMatchObject({ calls: 2, inputTokens: 24 });
  });

  it('stops on a cost cap per execution', async () => {
    savePriceOverrides([{ provider: 'openai', model: 'gpt-test', input: 1000, output: 1000 }]);
    aiUsageMeter().invalidatePrices();
    const record = await run(agentWorkflow('wf_cap_cost', { aiMaxCostPerExecution: 0.01 }));
    expect(record.status).toBe('error');
    expect(record.error!.message).toContain('this execution used $0.0200 of its $0.0100 limit');
  });

  it('caps a workflow per day: the run that goes over fails, the next one is refused before calling the model', async () => {
    const workflow = agentWorkflow('wf_cap_day', { aiMaxTokensPerDay: 30 });
    expect((await run(workflow)).status).toBe('success');
    const second = await run(workflow);
    expect(second.status).toBe('error');
    expect(second.error!.message).toContain('this workflow today used 40 tokens of its 30 tokens limit');
    const before = chatCalls();
    const third = await run(workflow);
    expect(third.status).toBe('error');
    expect(third.error!.message).toContain('this workflow today used 40 tokens');
    expect(chatCalls()).toBe(before);
    expect(third.aiUsage).toBeUndefined();
    // Other workflows are not affected.
    expect((await run(agentWorkflow('wf_cap_day_other'))).status).toBe('success');
  });

  it('counts the segments of a resumed execution together (tool approval in between)', async () => {
    const workflow = agentWorkflow('wf_cap_resume', { aiMaxTokensPerExecution: 30 }, { calculator: true, agent: { requireApproval: 'all' } });
    const waiting = await run(workflow);
    expect(waiting.status).toBe('waiting');
    expect(waiting.aiUsage).toMatchObject({ calls: 1, inputTokens: 12, outputTokens: 8 });
    const outcome = await decideApproval(waiting.executionId, 'call_1', true);
    expect(outcome.status).toBe('resumed');
    const done = outcome.status === 'resumed' ? outcome.record : undefined;
    expect(done!.status).toBe('error');
    expect(done!.error!.message).toContain('this execution used 40 tokens of its 30 tokens limit');
    expect(done!.aiUsage).toMatchObject({ calls: 2, inputTokens: 24, outputTokens: 16 });
  });
});

describe('agent limits', () => {
  it('stops an agent at its daily token limit and refuses the next run before calling the model', async () => {
    const agent = agentStore.create({ name: 'Budgeted', instructions: 'Be brief.', model: { provider: 'openai', model: 'gpt-test', credential: ref }, settings: { dailyTokenLimit: 15 } as never });
    const session = () => newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
    const first = await runAgent({ agent, session: session(), message: 'hello' });
    expect(first.reason).toBe('budget');
    const notice = agentStore.getSession(first.session.id)!.timeline.find((e) => e.type === 'notice') as { message: string } | undefined;
    expect(notice?.message).toContain('AI usage cap reached: agent “Budgeted” today used 20 tokens of its 15 tokens limit');

    const before = chatCalls();
    expect((await runAgent({ agent, session: session(), message: 'again' })).reason).toBe('budget');
    expect(chatCalls()).toBe(before);

    const usage = await report(`agentId=${agent.id}`);
    expect(usage.today).toMatchObject({ inputTokens: 12, outputTokens: 8, calls: 1 });
    expect(usage.month.calls).toBe(1);
    expect((await report('group=agent')).agents).toContainEqual(expect.objectContaining({ agentId: agent.id }));
  });

  it('applies a monthly cost limit', async () => {
    savePriceOverrides([{ provider: 'openai', model: 'gpt-test', input: 1000, output: 1000 }]);
    aiUsageMeter().invalidatePrices();
    const agent = agentStore.create({ name: 'Thrifty', instructions: 'x', model: { provider: 'openai', model: 'gpt-test', credential: ref }, settings: { monthlyCostLimit: 0.01 } as never });
    const result = await runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), message: 'hi' });
    expect(result.reason).toBe('budget');
    const notice = agentStore.getSession(result.session.id)!.timeline.find((e) => e.type === 'notice') as { message: string };
    expect(notice.message).toContain('agent “Thrifty” this month used $0.0200 of its $0.0100 limit');
  });
});
