/**
 * Landflow's own calls through a LiteLLM gateway (lib/server/llm-gateway/call.ts, nodes/models.ts): the headers that say
 * who is calling, no fallback beta, the call id and cost on the ai_usage row and the ai.call event, a spent budget shown as a
 * cap, the gateway's model list, Spotlight with `litellm/<model>`, and the credential test. Talks only to the fake LiteLLM.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sentLiteLlmKey, startFakeLiteLlm } from './fake-litellm';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-llm-gateway-calls-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, executionScope, isUsageCapError, runInUsageScope, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { credentials } = await import('@/lib/server/credentials/vault');
const { anthropicModel, openAiConnection, openAiModel } = await import('@/lib/server/nodes/models');
const { anthropicApiCredential, openAiApiCredential } = await import('@/lib/server/nodes/credentials');
const { gatewayBudgetError, gatewayHeaders, scopeProjectId, trustsGatewayCost } = await import('@/lib/server/llm-gateway/call');
const { forgetGatewayModels } = await import('@/lib/server/llm-gateway/models');
const { modelOptions } = await import('@/lib/server/agents/models');
const { assistantModel } = await import('@/lib/server/assistant/model');
const { saveGatewaySettings } = await import('@/lib/server/llm-gateway/settings');
const { UsageScope } = await import('@/lib/server/ai-usage/scope');
const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');

registry.registerBuiltin(corePlugin);
const fake = await startFakeLiteLlm({ models: ['claude-sonnet-5-5', 'qwen3-coder:30b'], costPerCall: 0.001 });
const project = createTeamProject({ name: 'Gateway test' });
setHomeProject('workflow', 'wf_gw', project.id);
setHomeProject('workflow', 'wf_h', project.id);
const virtual = fake.addKey({ key_alias: 'landflow-test' }).key;
const fallbackBeta = await startFakeModels();

afterAll(async () => {
  await fake.close();
  await fallbackBeta.close();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_KEY']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const rows = () => database().all<Record<string, unknown>>('SELECT * FROM ai_usage ORDER BY at, id');
const events = () => database().all<{ attrs: string }>("SELECT attrs FROM usage_events WHERE kind = 'ai.call'");
const turn = { messages: [{ role: 'user' as const, content: 'hello' }], tools: [] };
const calc = { name: 'calculator', description: 'calc', inputSchema: { type: 'object', properties: { expression: { type: 'string' } } } };

const inScope = <T>(execution: string, fn: () => Promise<T>) =>
  runInUsageScope(executionScope({ executionId: execution, workflowId: 'wf_gw', userId: 'u_gw' }), fn);

beforeEach(() => {
  fake.requests.length = 0;
  delete process.env.LANDFLOW_LLM_GATEWAY_URL;
  savePriceOverrides([]);
  aiUsageMeter().invalidatePrices();
});

describe('trustsGatewayCost', () => {
  it('trusts only the server-configured gateway, by scheme, host, port and path', () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = 'http://LiteLLM.local:80/';
    expect(trustsGatewayCost('http://litellm.local')).toBe(true);
    expect(trustsGatewayCost('http://litellm.local/v1')).toBe(true);
    expect(trustsGatewayCost('https://litellm.local')).toBe(false);
    expect(trustsGatewayCost('http://litellm.local:8080')).toBe(false);
    expect(trustsGatewayCost('http://litellm.local/other')).toBe(false);
    expect(trustsGatewayCost('not a url')).toBe(false);
    delete process.env.LANDFLOW_LLM_GATEWAY_URL;
    expect(trustsGatewayCost('http://litellm.local')).toBe(false);
  });
});

describe('gatewayHeaders', () => {
  // A scope with a meter: its calls are counted in process, so they are marked `in-process`.
  const scope = new UsageScope({ userId: 'u1', workflowId: 'wf_h', executionId: 'ex_h', surface: 'spotlight', projectId: 'p_h' }, [], undefined, {} as never);

  it('names the person, the tags, the metadata and the trace', () => {
    const headers = gatewayHeaders(scope, { portalHeaders: false });
    expect(headers['x-litellm-end-user-id']).toBe('landflow-user-u1');
    expect(headers['x-litellm-tags'].split(',')).toEqual(['landflow', 'landflow-project:p_h', 'landflow-workflow:wf_h', 'landflow-surface:spotlight', 'landflow-runtime:landflow']);
    expect(JSON.parse(headers['x-litellm-spend-logs-metadata'])).toMatchObject({ landflow: 'in-process', runtime: 'landflow', project: 'p_h', workflow: 'wf_h', execution: 'ex_h', surface: 'spotlight' });
    expect(headers['x-litellm-trace-id']).toBe('ex_h');
    expect(headers['x-litellm-customer-org-alias']).toBeUndefined();
    expect(headers['x-litellm-customer-member-id']).toBeUndefined();
  });

  it('adds the portal headers only when they are on, and nothing personal without a user', () => {
    const portal = gatewayHeaders(scope, { portalHeaders: true });
    expect(portal['x-litellm-customer-org-alias']).toBe('landflow-project-p_h');
    expect(portal['x-litellm-customer-member-id']).toBe('landflow-user-u1');
    const anonymous = gatewayHeaders(new UsageScope({ workflowId: 'wf_h', projectId: 'p_h' }), { portalHeaders: true });
    expect(anonymous['x-litellm-end-user-id']).toBeUndefined();
    expect(anonymous['x-litellm-customer-member-id']).toBeUndefined();
    expect(gatewayHeaders(undefined, { portalHeaders: false })['x-litellm-tags']).toBe('landflow,landflow-runtime:landflow');
  });

  it('marks a call outside any metered scope `unmetered`, so the spend import counts it', () => {
    expect(JSON.parse(gatewayHeaders(undefined, { portalHeaders: false })['x-litellm-spend-logs-metadata'])).toMatchObject({ landflow: 'unmetered' });
    expect(JSON.parse(gatewayHeaders(new UsageScope({ workflowId: 'wf_h' }), { portalHeaders: false })['x-litellm-spend-logs-metadata'])).toMatchObject({ landflow: 'unmetered' });
  });

  it('drops what is not ASCII and uses the home project of a workflow', () => {
    const odd = gatewayHeaders(new UsageScope({ userId: 'ué中2', sessionId: 's1' }), { portalHeaders: false });
    expect(odd['x-litellm-end-user-id']).toBe('landflow-user-u2');
    expect(odd['x-litellm-trace-id']).toBe('s1');
    expect(scopeProjectId(new UsageScope({ workflowId: 'wf_h' }))).toBe(project.id);
  });
});

describe('Anthropic through the gateway', () => {
  const model = () => anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 200, fallback: true, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' });

  it('sends the virtual key, who is calling and no fallback, and keeps the call id and cost', async () => {
    // The call id is kept only from the server-configured gateway.
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    const before = rows().length;
    const turnResult = await inScope('ex_a1', () => model().generate(turn));
    expect(turnResult.text).toBe('Echo: hello');
    const request = fake.last('/v1/messages')!;
    expect(sentLiteLlmKey(request.headers)).toBe(virtual);
    expect(request.headers['anthropic-beta']).toBeUndefined();
    expect(request.headers['x-landflow-gateway-call']).toBeUndefined();
    expect(request.headers['x-litellm-end-user-id']).toBe('landflow-user-u_gw');
    expect(request.headers['x-litellm-spend-logs-metadata']).toContain('in-process');
    expect(request.body.fallbacks).toBeUndefined();
    expect(request.body.output_config).toEqual({ effort: 'low' });
    const added = rows().slice(before);
    expect(added).toHaveLength(1);
    const callId = fake.spendLogs.at(-1)!.litellm_call_id;
    expect(added[0]).toMatchObject({ call_id: callId, source: 'landflow', runtime: 'landflow', gateway_cost: 0.001, provider: 'litellm', execution_id: 'ex_a1' });
    // The response id is the spend row's request_id: the import pairs the two by it. The key is not the server's own.
    expect(added[0].gateway_request_id).toBe(fake.spendLogs.at(-1)!.request_id);
    expect(added[0].gateway_key_hash).toBeNull();
    expect(added[0].project_id).toBe(project.id);
    const attrs = events().map((e) => JSON.parse(e.attrs) as Record<string, unknown>);
    expect(attrs.some((a) => a.callId === callId && a.gatewayCost === 0.001)).toBe(true);
  });

  it('does the same streamed and with a tool', async () => {
    // The call id is kept only from the server-configured gateway.
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    const streamed: string[] = [];
    await inScope('ex_a2', () => model().generate({ ...turn, onToken: (d) => void streamed.push(d) }));
    expect(streamed.join('')).toBe('Echo: hello');
    const streamCall = fake.spendLogs.at(-1)!.litellm_call_id;
    const tool = await inScope('ex_a3', () => model().generate({ ...turn, tools: [calc] }));
    expect(tool.toolCalls[0]?.name).toBe('calculator');
    const toolCall = fake.spendLogs.at(-1)!.litellm_call_id;
    const ids = rows().map((r) => r.call_id);
    // A streamed message's response id is message_start's.
    expect(rows().find((r) => r.call_id === streamCall)?.gateway_request_id).toBe(fake.spendLogs.find((s) => s.litellm_call_id === streamCall)!.request_id);
    expect(ids).toContain(streamCall);
    expect(ids).toContain(toolCall);
    expect(new Set(ids.filter(Boolean)).size).toBe(ids.filter(Boolean).length);
  });

  it('keeps the fallback beta without a gateway', async () => {
    fallbackBeta.requests.length = 0;
    await anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 200, fallback: true, apiKey: 'sk-ant-test', baseUrl: fallbackBeta.url.replace(/\/v1$/, '') }).generate(turn);
    const request = fallbackBeta.requests.find((r) => r.path.includes('/v1/messages'))!;
    expect(String(request.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(request.body.fallbacks).toBe('default');
  });

  it('needs a Base URL', () => {
    expect(() => anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 10, fallback: true, apiKey: virtual, gateway: 'litellm' })).toThrow(/Base URL/);
  });
});

describe('cost', () => {
  it('takes the table price for a priced model and the gateway cost for an unpriced one, from the configured gateway', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    savePriceOverrides([{ provider: 'litellm', model: 'claude-sonnet-5-5', input: 1000, output: 1000 }]);
    aiUsageMeter().invalidatePrices();
    const before = rows().length;
    const claude = anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 50, fallback: false, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' });
    await inScope('ex_c1', () => claude.generate(turn));
    const unpriced = anthropicModel({ model: 'qwen3-coder:30b', effort: 'low', maxTokens: 50, fallback: false, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' });
    await inScope('ex_c2', () => unpriced.generate(turn));
    const [priced, free] = rows().slice(before);
    expect(priced.cost).toBeCloseTo((12 * 1000 + 8 * 1000) / 1_000_000, 8);
    expect(priced.gateway_cost).toBe(0.001);
    expect(free.cost).toBe(0.001);
    expect(free.gateway_cost).toBe(0.001);
  });

  it('only informs when the gateway is named by a credential, not by the server', async () => {
    const before = rows().length;
    const unpriced = anthropicModel({ model: 'qwen3-coder:30b', effort: 'low', maxTokens: 50, fallback: false, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' });
    await inScope('ex_c3', () => unpriced.generate(turn));
    const [row] = rows().slice(before);
    expect(row.cost).toBe(0);
    expect(row.gateway_cost).toBe(0.001);
    // Nor is its call id kept: the spend import dedupes on it, and another gateway could answer with someone else's.
    expect(row.call_id).toBeNull();
  });

  it('records every call even when a call id repeats', async () => {
    const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
    const before = rows().length;
    await inScope('ex_dup', async () => {
      for (let i = 0; i < 2; i++) afterModelCall({ provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', inputTokens: 3, outputTokens: 1, callId: 'call-repeated' });
    });
    const added = rows().slice(before);
    expect(added).toHaveLength(2);
    expect(added.map((r) => r.call_id).sort()).toEqual(['call-repeated', null].sort());
  });
});

describe('OpenAI-compatible through the gateway', () => {
  const connection = () => openAiConnection({ baseUrl: `${fake.origin}/v1`, apiKey: virtual, gateway: 'litellm' });

  it('is the litellm system and records the call id and cost, plain and streamed', async () => {
    // The call id is kept only from the server-configured gateway.
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    const c = connection();
    expect(c.system).toBe('litellm');
    expect(c.label).toBe('LiteLLM');
    const model = openAiModel(c, { model: 'qwen3-coder:30b' });
    const before = rows().length;
    expect((await inScope('ex_o1', () => model.generate(turn))).text).toBe('Echo: hello');
    const plain = fake.spendLogs.at(-1)!.litellm_call_id;
    const request = fake.last('/v1/chat/completions')!;
    expect(request.headers.authorization).toBe(`Bearer ${virtual}`);
    expect(request.headers['x-litellm-end-user-id']).toBe('landflow-user-u_gw');
    const out: string[] = [];
    await inScope('ex_o2', () => model.generate({ ...turn, onToken: (d) => void out.push(d) }));
    expect(out.join('')).toBe('Echo: hello');
    const streamed = fake.spendLogs.at(-1)!.litellm_call_id;
    const added = rows().slice(before);
    expect(added.map((r) => r.call_id)).toEqual([plain, streamed]);
    expect(added.every((r) => r.gateway_cost === 0.001 && r.source === 'landflow')).toBe(true);
    // A stream's response id is its first chunk's (each chunk has its own id in front of Ollama), as LiteLLM files it.
    const requestIdOf = (callId: unknown) => fake.spendLogs.find((s) => s.litellm_call_id === callId)!.request_id;
    expect(added.map((r) => r.gateway_request_id)).toEqual([requestIdOf(plain), requestIdOf(streamed)]);
  });

  it('keeps no response id from a response-cache hit (it would be another call’s)', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    fake.setCacheHits(true);
    try {
      const before = rows().length;
      await inScope('ex_cache', () => openAiModel(connection(), { model: 'qwen3-coder:30b' }).generate(turn));
      await inScope('ex_cache2', () => anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 200, fallback: true, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' }).generate(turn));
      const added = rows().slice(before);
      expect(added).toHaveLength(2);
      expect(added.every((r) => r.call_id && r.gateway_request_id === null)).toBe(true);
    } finally {
      fake.setCacheHits(false);
    }
  });

  it('marks a call on the server’s own key with the key’s hash, so a call without a response id pairs by its call id', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = virtual;
    try {
      const before = rows().length;
      await inScope('ex_o3', () => openAiModel(connection(), { model: 'qwen3-coder:30b' }).generate(turn));
      const [row] = rows().slice(before);
      expect(row.gateway_key_hash).toBe(fake.spendLogs.at(-1)!.api_key);
    } finally {
      delete process.env.LANDFLOW_LLM_GATEWAY_KEY;
    }
  });
});

describe('a spent budget', () => {
  it('is a usage cap that names the gateway', async () => {
    fake.customers.set('landflow-user-u_gw', { user_id: 'landflow-user-u_gw', max_budget: 0.01, spend: 0.5 });
    const model = anthropicModel({ model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 50, fallback: false, apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' });
    const error = await inScope('ex_b1', () => model.generate(turn)).then(() => undefined, (e: unknown) => e);
    expect(isUsageCapError(error)).toBe(true);
    expect((error as Error).message).toMatch(/The LLM gateway stopped the call: the budget of customer landflow-user-u_gw is spent/);
    const openAi = openAiModel(openAiConnection({ baseUrl: `${fake.origin}/v1`, apiKey: virtual, gateway: 'litellm' }), { model: 'qwen3-coder:30b' });
    const second = await inScope('ex_b2', () => openAi.generate(turn)).then(() => undefined, (e: unknown) => e);
    expect(isUsageCapError(second)).toBe(true);
    fake.customers.delete('landflow-user-u_gw');
  });

  it('leaves other errors alone', () => {
    expect(gatewayBudgetError({ status: 400, message: 'Invalid model name' })).toBeUndefined();
    expect(gatewayBudgetError({ status: 500, message: 'budget_exceeded' })).toBeUndefined();
    expect(gatewayBudgetError(new Error('x'))).toBeUndefined();
  });
});

describe('model lists, Spotlight and the credential test', () => {
  const normal = credentials.create({ name: 'Plain Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-x', baseUrl: '' } });
  const gateway = credentials.create({ name: 'Gateway', type: 'core.anthropicApi', data: { apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' } });
  const openGateway = credentials.create({ name: 'Gateway OpenAI', type: 'core.openAiApi', data: { apiKey: virtual, baseUrl: `${fake.origin}/v1`, gateway: 'litellm' } });

  it('lists the gateway models for a gateway credential and the fixed list for a normal one', async () => {
    forgetGatewayModels();
    const listed = await modelOptions('anthropic', { credentialId: gateway.id });
    expect(listed.map((m) => m.model)).toEqual(['claude-sonnet-5-5', 'qwen3-coder:30b']);
    expect(listed[0].description).toBe('via LiteLLM');
    const fixed = await modelOptions('anthropic', { credentialId: normal.id });
    expect(fixed.some((m) => m.model === 'claude-opus-5-5')).toBe(true);
    expect((await modelOptions('openai', { credentialId: openGateway.id })).map((m) => m.model)).toContain('qwen3-coder:30b');
  });

  it('runs Spotlight on litellm/<model> through the configured gateway', async () => {
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = virtual;
    const model = assistantModel('litellm/qwen3-coder:30b');
    expect(`${model.provider}/${model.model}`).toBe('litellm/qwen3-coder:30b');
    expect((await model.generate(turn)).text).toBe('Echo: hello');
    expect(fake.last('/v1/chat/completions')?.body.model).toBe('qwen3-coder:30b');
  });

  it('says so when there is no gateway', async () => {
    delete process.env.LANDFLOW_LLM_GATEWAY_URL;
    saveGatewaySettings({ credentialId: '' });
    await expect(assistantModel('litellm/qwen3-coder:30b').generate(turn)).rejects.toThrow(/No LLM gateway/);
  });

  it('tests a gateway credential', async () => {
    const http = (input: string, init?: RequestInit) => fetch(input, init);
    const ctx = { http } as never;
    expect(await anthropicApiCredential.test!({ apiKey: virtual, baseUrl: fake.origin, gateway: 'litellm' }, ctx)).toEqual({ ok: true, message: 'Connected to LiteLLM: 2 models' });
    expect(await openAiApiCredential.test!({ apiKey: virtual, baseUrl: `${fake.origin}/v1`, gateway: 'litellm' }, ctx)).toEqual({ ok: true, message: 'Connected to LiteLLM: 2 models' });
    expect((await anthropicApiCredential.test!({ apiKey: 'sk-wrong', baseUrl: fake.origin, gateway: 'litellm' }, ctx)).ok).toBe(false);
    expect((await anthropicApiCredential.test!({ apiKey: virtual, baseUrl: '', gateway: 'litellm' }, ctx)).message).toMatch(/Base URL/);
  });
});
