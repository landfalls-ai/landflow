/**
 * SP12 (docs/observability.md, "Prices"; docs/llm-gateway.md, "The AI page"): one price for a local model covers
 * Landflow's `ollama` calls and the gateway's `ollama_chat` rows; the import records the gateway's provider name;
 * Settings lists the local models seen in 30 days; an unpriced local model is labelled and ranks by tokens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLiteLlm, type FakeLiteLlm, type FakeSpendLog } from './fake-litellm';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-local-prices-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { database } = await import('@/lib/server/db');
const { aiUsageMeter, savePriceOverrides, runInUsageScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { findPrice, isLocalProvider } = await import('@/lib/server/ai-usage/prices');
const { localModels } = await import('@/lib/server/ai-usage/local-models');
const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
const { saveGatewaySettings, saveIngestStatus } = await import('@/lib/server/llm-gateway/settings');
const { sortByTokens, rowModel } = await import('@/lib/client/ai-console');
const { aiConsoleReport } = await import('@/lib/server/llm-gateway/console');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { serverKeyHash } = await import('@/lib/server/llm-gateway/call');
const localRoute = await import('@/app/api/settings/ai-prices/local/route');
const pricesRoute = await import('@/app/api/settings/ai-prices/route');

interface Usage {
  id: string;
  provider: string;
  model: string;
  cost: number;
  gateway_provider: string | null;
  gateway_request_id: string | null;
}

let litellm: FakeLiteLlm;
const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_KEY'];
const saved: Record<string, string | undefined> = {};
let seq = 0;
const later = () => Date.now() + 5 * 60_000;

/** A spend-log row of an Ollama model, as the gateway writes it (`custom_llm_provider = 'ollama_chat'`). */
function ollamaLog(fields: Partial<FakeSpendLog> & { custom_llm_provider?: string } = {}): FakeSpendLog {
  const now = new Date().toISOString();
  const id = `chatcmpl-lp-${process.pid}-${++seq}`;
  return {
    request_id: id,
    litellm_call_id: `call-lp-${process.pid}-${seq}`,
    call_type: 'acompletion',
    api_key: 'hashed-key',
    spend: 0,
    total_tokens: 1_000_000 + 500_000,
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
    startTime: now,
    endTime: now,
    model: 'ollama_chat/qwen3-coder:30b',
    model_group: 'qwen3-coder:30b',
    end_user: '',
    team_id: '',
    request_tags: [],
    status: 'success',
    metadata: {},
    custom_llm_provider: 'ollama_chat',
    ...fields,
  } as FakeSpendLog;
}
const usage = (model = 'qwen3-coder:30b') => database().all<Usage>('SELECT * FROM ai_usage WHERE model = ? ORDER BY at, id', model);
const importLogs = async (...logs: FakeSpendLog[]) => {
  litellm.spendLogs.length = 0;
  litellm.spendLogs.push(...logs);
  await importSpend({ now: later() });
};

beforeAll(async () => {
  litellm = await startFakeLiteLlm({ costPerCall: 0, usage: { input: 30, output: 10 } });
  for (const name of ENV) saved[name] = process.env[name];
  process.env.LANDFLOW_LLM_GATEWAY_URL = litellm.origin;
  process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
  process.env.LANDFLOW_LLM_GATEWAY_KEY = litellm.addKey({ key_alias: 'landflow-own' }).key;
});
afterAll(async () => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await litellm.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});
beforeEach(() => {
  saveGatewaySettings({ ingest: true });
  saveIngestStatus({ enabled: false, imported: 0, skipped: 0, totalImported: 0 });
  savePriceOverrides([]);
  aiUsageMeter().invalidatePrices();
});

const meterOllama = (inputTokens = 1_000_000, outputTokens = 500_000) =>
  runInUsageScope(executionScope({ executionId: `ex_lp_${++seq}`, workflowId: 'wf_lp', userId: 'u_lp' }), async () => afterModelCall({ provider: 'ollama', model: 'qwen3-coder:30b', operation: 'chat', inputTokens, outputTokens }));

describe('local prices', () => {
  it('knows local providers, and a local provider takes the overrides of any local provider, never the built-ins', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('Ollama_Chat')).toBe(true);
    expect(isLocalProvider('anthropic')).toBe(false);
    const price = { provider: 'ollama', model: 'qwen3-coder:30b', input: 0.2, output: 0.6 };
    expect(findPrice('ollama_chat', 'qwen3-coder:30b', [price])).toBe(price);
    expect(findPrice('ollama', 'qwen3-coder:30b', [{ ...price, provider: 'ollama_chat' }])).toMatchObject({ input: 0.2 });
    // Not priced: no override, and a local provider never takes a built-in or a hosted provider's override.
    expect(findPrice('ollama_chat', 'qwen3-coder:30b', [])).toBeUndefined();
    expect(findPrice('ollama_chat', 'claude-sonnet-5-5', [])).toBeUndefined();
    expect(findPrice('ollama', 'qwen3-coder:30b', [{ ...price, provider: 'openai' }])).toBeUndefined();
    // Hosted providers are unchanged.
    expect(findPrice('anthropic', 'claude-sonnet-5-5', [])).toBeDefined();
  });

  it('records the gateway’s provider on an imported row, and prices a new imported row and a new Landflow row once the model has a price', async () => {
    const free = ollamaLog();
    await importLogs(free);
    expect(usage()).toEqual([expect.objectContaining({ provider: 'litellm', gateway_provider: 'ollama_chat', cost: 0 })]);

    savePriceOverrides([{ provider: 'ollama', model: 'qwen3-coder:30b', input: 0.2, output: 0.6 }]);
    aiUsageMeter().invalidatePrices();
    await importLogs(ollamaLog());
    await meterOllama();
    const rows = usage();
    expect(rows).toHaveLength(3);
    // 1M input at $0.2 + 0.5M output at $0.6 = $0.50, for the new imported row and the new Landflow row; the old row keeps $0.
    expect(rows.filter((r) => r.cost === 0)).toHaveLength(1);
    expect(rows.filter((r) => Math.abs(r.cost - 0.5) < 1e-9)).toHaveLength(2);
    expect(rows.find((r) => r.id === usage()[0].id)!.cost).toBe(0);
  });

  it('leaves a hosted model’s price alone', async () => {
    savePriceOverrides([{ provider: 'ollama', model: 'qwen3-coder:30b', input: 9, output: 9 }]);
    aiUsageMeter().invalidatePrices();
    const hosted = aiUsageMeter().cost({ provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 0 });
    savePriceOverrides([]);
    aiUsageMeter().invalidatePrices();
    expect(aiUsageMeter().cost({ provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 0 })).toBe(hosted);
  });

  it('gives a Landflow row the import pairs the gateway’s provider too', async () => {
    const log = ollamaLog();
    // Landflow's meter counted this call on a LiteLLM credential first (provider litellm, the response id).
    database().insertNew('ai_usage', { id: `au_pair_${process.pid}`, at: new Date().toISOString(), day: aiUsageMeter().today(), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 5, output_tokens: 5, cost: 0, source: 'landflow', runtime: 'landflow', gateway_request_id: log.request_id });
    await importLogs(log);
    expect(database().get<Usage>('SELECT * FROM ai_usage WHERE id = ?', `au_pair_${process.pid}`)).toMatchObject({ gateway_provider: 'ollama_chat', provider: 'litellm', model: 'qwen3-coder:30b', input_tokens: 5, output_tokens: 5, source: 'landflow', runtime: 'landflow', gateway_request_id: log.request_id });

    // The spend row arrives before the response id is known: paired by the call id on the server's own key.
    const second = ollamaLog({ api_key: serverKeyHash() });
    database().insertNew('ai_usage', { id: `au_pair2_${process.pid}`, at: new Date().toISOString(), day: aiUsageMeter().today(), provider: 'litellm', model: 'qwen3-coder:30b', operation: 'chat', input_tokens: 5, output_tokens: 5, cost: 0, source: 'landflow', runtime: 'landflow', call_id: second.litellm_call_id, gateway_key_hash: serverKeyHash() });
    await importLogs(second);
    expect(database().get<Usage>('SELECT * FROM ai_usage WHERE id = ?', `au_pair2_${process.pid}`)).toMatchObject({ gateway_request_id: second.request_id, gateway_provider: 'ollama_chat' });
  });

  it('lists a model seen under both providers once, with its price once there is one; an unpriced one is labelled and ranks by tokens', async () => {
    database().deleteBefore('ai_usage', 'at', '9999');
    await importLogs(ollamaLog());
    await meterOllama(100, 50);
    const before = localModels();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ model: 'qwen3-coder:30b', providers: ['ollama', 'ollama_chat'], calls: 2, inputTokens: 1_000_100, outputTokens: 500_050 });
    expect(before[0].price).toBeUndefined();

    // The AI page's model group: "Not priced", ranked by tokens when asked.
    const report = aiConsoleReport(TEST_OWNER, '7d');
    const models = report.groups.model;
    const local = models.find((r) => r.label.startsWith('qwen3-coder'))!;
    expect(local.unpriced).toBe(true);
    expect(rowModel(local).unpriced).toBe(true);
    const cheap = { ...local, key: 'x/big-hosted', label: 'big-hosted', unpriced: undefined, cost: 5, inputTokens: 10, outputTokens: 1 };
    expect(sortByTokens([cheap, { ...local, key: 'other', label: 'Other', inputTokens: 9e9 }, local]).map((r) => r.label)).toEqual([local.label, 'big-hosted', 'Other']);

    // One price, saved through the settings route, covers both and shows in the list.
    const response = await (pricesRoute.PUT as (r: Request) => Promise<Response>)(new Request('http://x.test/api/settings/ai-prices', { method: 'PUT', body: JSON.stringify({ overrides: [{ provider: 'ollama', model: 'qwen3-coder:30b', input: 0.1, output: 0.3 }] }), headers: { 'content-type': 'application/json' } }));
    expect(response.status).toBe(200);
    const list = await (await (localRoute.GET as () => Promise<Response>)()).json();
    expect(list).toEqual([expect.objectContaining({ model: 'qwen3-coder:30b', providers: ['ollama', 'ollama_chat'], price: expect.objectContaining({ input: 0.1, output: 0.3 }) })]);
    // Recorded rows keep their cost (no repricing).
    expect(usage().every((r) => r.cost === 0)).toBe(true);
    expect(aiConsoleReport(TEST_OWNER, '7d').groups.model.find((r) => r.label.startsWith('qwen3-coder'))!.unpriced).toBeUndefined();
    expect(JSON.stringify(list).toLowerCase()).not.toContain('equivalent');
  });
});
