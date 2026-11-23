/**
 * Join test (wave 13, plan-v2 "Join tests are the integrator's", `spend-local-price-join`): SP12's local model prices
 * and `gateway_provider` ↔ SP08's daily rollup, report and "Not priced" flag ↔ SP12's Local models list and You card.
 * A Landflow call on a LiteLLM credential (paired with its spend row by the response id), Landflow's own Ollama call
 * and two rows of another client of the gateway (`ollama_chat`, one of them late, on a day the rollup already holds)
 * go through the real meter and the real spend import (the fake LiteLLM's spend log); the AI page's report, Settings →
 * AI prices → Local models and `GET /api/insights/ai/me` read them before and after one price is set in Settings and
 * after a rollup pass. Offline; run under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiLocalModel, AiMySpend, AiPageReport, AiSpendCallsPage, AiSpendGroup, AiSpendRow } from '@/lib/shared/ai-spend';
import { startFakeLiteLlm, type FakeLiteLlm, type FakeSpendLog } from './fake-litellm';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-local-price-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { aiUsageMeter, savePriceOverrides, runInUsageScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { runRollup } = await import('@/lib/server/ai-usage/rollup');
const { importSpend } = await import('@/lib/server/llm-gateway/ingest');
const { saveGatewaySettings, saveIngestStatus } = await import('@/lib/server/llm-gateway/settings');
const reportRoute = await import('@/app/api/insights/ai/route');
const callsRoute = await import('@/app/api/insights/ai/calls/route');
const meRoute = await import('@/app/api/insights/ai/me/route');
const localRoute = await import('@/app/api/settings/ai-prices/local/route');
const pricesRoute = await import('@/app/api/settings/ai-prices/route');

type User = Awaited<ReturnType<typeof createUser>>;
type Report = AiPageReport & { groups: Record<AiSpendGroup, AiSpendRow[]> };
const DAY_MS = 86_400_000;
const MODEL = 'qwen3-coder:30b';
const GATEWAY_KEY = `litellm/${MODEL}`;
const OWN_KEY = `ollama/${MODEL}`;
const ENV = ['LANDFLOW_LLM_GATEWAY_URL', 'LANDFLOW_LLM_GATEWAY_ADMIN_KEY', 'LANDFLOW_LLM_GATEWAY_KEY'];
let litellm: FakeLiteLlm;
let owner: User;
let seq = 0;

/** A day `back` days ago, as the rows name it. */
const dayAgo = (back: number) => aiUsageMeter().today(Date.now() - back * DAY_MS);
const OLD = 3;

/** A spend-log row of an Ollama model behind the gateway (1M in, 0.5M out). */
function ollamaLog(fields: Partial<FakeSpendLog> = {}): FakeSpendLog {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  ++seq;
  return {
    request_id: `chatcmpl-lpj-${process.pid}-${seq}`,
    litellm_call_id: `call-lpj-${process.pid}-${seq}`,
    call_type: 'acompletion',
    api_key: 'hashed-other-client',
    spend: 0,
    total_tokens: 1_500_000,
    prompt_tokens: 1_000_000,
    completion_tokens: 500_000,
    startTime: at,
    endTime: at,
    model: `ollama_chat/${MODEL}`,
    model_group: MODEL,
    end_user: '',
    team_id: '',
    request_tags: [],
    status: 'success',
    metadata: {},
    custom_llm_provider: 'ollama_chat',
    ...fields,
  } as FakeSpendLog;
}
/** The same call `back` days ago (the gateway wrote it late), at the instant `dayAgo(back)` names. */
const lateLog = (back: number) => {
  const at = new Date(Date.now() - back * DAY_MS).toISOString();
  return ollamaLog({ startTime: at, endTime: at });
};

/** The spend import over the last five days (a late row's day included). */
async function importLogs(...logs: FakeSpendLog[]) {
  litellm.spendLogs.length = 0;
  litellm.spendLogs.push(...logs);
  saveIngestStatus({ enabled: true, imported: 0, skipped: 0, totalImported: 0, lastEnd: new Date(Date.now() - 5 * DAY_MS).toISOString() });
  return importSpend({ now: Date.now() + 5 * 60_000 });
}

/** One Landflow call in a run of the owner's: Ollama itself, or a LiteLLM credential whose response id the gateway logs. */
const landflowCall = (provider: 'ollama' | 'litellm', gatewayRequestId?: string) =>
  runInUsageScope(executionScope({ executionId: `ex_lpj_${++seq}`, workflowId: 'wf_lpj', userId: owner.id }), async () =>
    afterModelCall({ provider, model: MODEL, operation: 'chat', inputTokens: 1_000_000, outputTokens: 500_000, ...(gatewayRequestId && { gatewayRequestId }) }),
  );

async function get<T>(route: { GET: unknown }, path: string, params: Record<string, string> = {}): Promise<T> {
  enableTestAuth(owner);
  try {
    const response = await (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test${path}?${new URLSearchParams(params)}`));
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  } finally {
    enableTestAuth();
  }
}
const report = (params: Record<string, string> = {}) => get<Report>(reportRoute, '/api/insights/ai', { period: '7d', ...params });
const modelRow = (page: { groups?: Record<string, AiSpendRow[]>; byModel?: AiSpendRow[] }, key: string) => (page.groups?.model ?? page.byModel ?? []).find((r) => r.key === key);
const raw = (where: string, ...params: string[]) =>
  database().get<{ calls: number; cost: number }>(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost FROM ai_usage WHERE model = ? AND ${where}`, MODEL, ...params)!;

beforeAll(async () => {
  litellm = await startFakeLiteLlm({ costPerCall: 0 });
  for (const name of ENV) previousEnv[name] = process.env[name];
  process.env.LANDFLOW_LLM_GATEWAY_URL = litellm.origin;
  process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = litellm.masterKey;
  process.env.LANDFLOW_LLM_GATEWAY_KEY = litellm.addKey({ key_alias: 'landflow-own' }).key;
  owner = await createUser({ email: 'olga@local-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  saveGatewaySettings({ ingest: true });
  savePriceOverrides([]);
  aiUsageMeter().invalidatePrices();
});

afterAll(async () => {
  enableTestAuth();
  await litellm.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv) || previousEnv[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries(previousEnv)) if (value !== undefined) process.env[key] = value;
});

describe('a local model, Not priced, then priced once in Settings', () => {
  it('before a price: the paired row keeps the gateway’s provider; the report, the rollup, Local models and the You card all say Not priced', async () => {
    const paired = ollamaLog();
    await landflowCall('litellm', paired.request_id);
    await landflowCall('ollama');
    // The pass that rolls up the old day before the late row arrives.
    runRollup();
    const status = await importLogs(paired, ollamaLog(), lateLog(OLD));
    expect(status.imported).toBe(2);
    expect(database().get<{ gateway_provider: string }>('SELECT gateway_provider FROM ai_usage WHERE gateway_request_id = ? AND source = ?', paired.request_id, 'landflow')).toEqual({ gateway_provider: 'ollama_chat' });

    // The late row's day is rolled up already: the report shows it after the next pass, not before.
    const before = modelRow(await report(), GATEWAY_KEY)!;
    expect(before.calls).toBe(2);
    expect(runRollup()).toContain(dayAgo(OLD));
    const page = await report();
    const gateway = modelRow(page, GATEWAY_KEY)!;
    const own = modelRow(page, OWN_KEY)!;
    expect(gateway).toMatchObject({ calls: 3, cost: 0, unpriced: true, unpricedCalls: 3, label: `${MODEL} (litellm)` });
    expect(own).toMatchObject({ calls: 1, cost: 0, unpriced: true, unpricedCalls: 1, label: `${MODEL} (ollama)` });
    expect(page.totals.unpricedCalls).toBe(4);
    expect(page.series.find((p) => p.at === dayAgo(OLD))).toMatchObject({ calls: 1, cost: 0 });

    // Settings → AI prices → Local models: one model, seen under both local names, not priced.
    const local = await get<AiLocalModel[]>(localRoute, '/api/settings/ai-prices/local');
    expect(local).toEqual([expect.objectContaining({ model: MODEL, providers: ['ollama', 'ollama_chat'], calls: 4, inputTokens: 4_000_000, outputTokens: 2_000_000 })]);
    expect(local[0].price).toBeUndefined();

    // The You card: the owner's own two calls, each model Not priced, as the report says for the owner's rows.
    const me = await get<AiMySpend>(meRoute, '/api/insights/ai/me');
    const mine = await report({ userId: owner.id });
    for (const key of [GATEWAY_KEY, OWN_KEY]) {
      expect(modelRow(me, key)).toMatchObject({ calls: 1, cost: 0, unpriced: true, unpricedCalls: 1 });
      expect(modelRow(mine, key)).toMatchObject({ calls: 1, cost: 0, unpriced: true, unpricedCalls: 1 });
    }
    expect(me.today.unpricedCalls).toBe(2);
  });

  it('after one price in Settings: recorded calls keep $0 and stop being Not priced; new and late calls are priced; the rollup and the report agree with the rows', async () => {
    enableTestAuth(owner);
    try {
      const response = await (pricesRoute.PUT as (r: Request) => Promise<Response>)(
        new Request('http://x.test/api/settings/ai-prices', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: [{ provider: 'ollama', model: MODEL, input: 0.2, output: 0.6 }] }) }),
      );
      expect(response.status).toBe(200);
    } finally {
      enableTestAuth();
    }
    // No repricing: every recorded row keeps its $0.
    expect(raw('1 = 1')).toEqual({ calls: 4, cost: 0 });
    let page = await report();
    expect(modelRow(page, GATEWAY_KEY)).toMatchObject({ calls: 3, cost: 0, unpricedCalls: 0 });
    expect(modelRow(page, GATEWAY_KEY)!.unpriced).toBeUndefined();
    expect(modelRow(page, OWN_KEY)!.unpriced).toBeUndefined();
    expect(page.totals.unpricedCalls).toBe(0);
    const local = await get<AiLocalModel[]>(localRoute, '/api/settings/ai-prices/local');
    expect(local[0].price).toMatchObject({ provider: 'ollama', model: MODEL, input: 0.2, output: 0.6 });

    // From now on: 1M in at $0.2 and 0.5M out at $0.6 is $0.50 a call, Landflow's own and the gateway's alike.
    await landflowCall('ollama');
    const status = await importLogs(ollamaLog(), lateLog(OLD));
    expect(status.imported).toBe(2);
    expect(raw('day = ?', dayAgo(OLD))).toEqual({ calls: 2, cost: 0.5 });
    expect(runRollup()).toContain(dayAgo(OLD));

    page = await report();
    const since = dayAgo(6);
    for (const [key, provider] of [[GATEWAY_KEY, 'litellm'], [OWN_KEY, 'ollama']] as const) {
      const sums = raw('provider = ? AND day >= ?', provider, since);
      expect(modelRow(page, key)).toMatchObject({ calls: Number(sums.calls), unpricedCalls: 0 });
      expect(modelRow(page, key)!.cost).toBeCloseTo(Number(sums.cost), 9);
      // The drill sheet lists the same calls and cost.
      const calls = await get<AiSpendCallsPage>(callsRoute, '/api/insights/ai/calls', { period: '7d', group: 'model', key });
      expect(calls.calls.length + calls.hidden.calls).toBe(Number(sums.calls));
      expect(calls.calls.reduce((sum, c) => sum + c.cost, 0)).toBeCloseTo(Number(sums.cost), 9);
      expect(calls.calls.every((c) => c.priced)).toBe(true);
    }
    expect(modelRow(page, OWN_KEY)!.cost).toBeCloseTo(0.5, 9);
    expect(page.series.find((p) => p.at === dayAgo(OLD))).toMatchObject({ calls: 2, cost: 0.5 });

    // The You card: priced, the new call's $0.50 today, and the same rows as the report's for the owner.
    const me = await get<AiMySpend>(meRoute, '/api/insights/ai/me');
    const mine = await report({ userId: owner.id });
    for (const key of [GATEWAY_KEY, OWN_KEY]) {
      expect(modelRow(me, key)!.unpriced).toBeUndefined();
      expect(modelRow(me, key)!.calls).toBe(modelRow(mine, key)!.calls);
      expect(modelRow(me, key)!.cost).toBeCloseTo(modelRow(mine, key)!.cost, 9);
    }
    expect(modelRow(me, OWN_KEY)).toMatchObject({ calls: 2, cost: 0.5 });
    expect(me.today.unpricedCalls).toBe(0);
  });
});
