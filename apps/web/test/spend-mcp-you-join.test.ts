/**
 * Join test (wave 14, carryover-w14 §2, `spend-mcp-you-join`): SP14's `my_ai_spend` MCP tool and `GET
 * /api/brain/my-spend` ↔ SP12's You card (`GET /api/insights/ai/me`). The three copies of the wire contract are byte for
 * byte the same. For an owner and a member, in each period, the tool's JSON over the real MCP endpoint (`POST /api/mcp`
 * with a `brain:read` API key), the route with the same key (the real guard, no test bypass) and the You card as the
 * person are equal; neither the tool nor the route carries another person's rows or caps; the instance access token is
 * refused by both. Offline; run under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMySpend } from '@/lib/shared/ai-spend';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-mcp-you-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' });

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, disableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const { aiUsageMeter, saveAiCaps, savePriceOverrides, runInUsageScope, assistantScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { markSpendDays, runRollup } = await import('@/lib/server/ai-usage/rollup');
const { MY_SPEND_PATH, MY_SPEND_PERIODS } = await import('@/lib/shared/my-spend-wire');
const mcpRoute = await import('@/app/api/mcp/route');
const myRoute = await import('@/app/api/brain/my-spend/route');
const meRoute = await import('@/app/api/insights/ai/me/route');

type User = Awaited<ReturnType<typeof createUser>>;
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const meter = aiUsageMeter();
const OWNER_MODEL = 'claude-owner-secret';
const MEMBER_MODEL = 'claude-member-secret';

let owner: User;
let mia: User;
let instanceToken: string;
const keys = new Map<string, string>();

const at = (back: number) => NOW - back * DAY_MS - 60_000;
async function spend(atMs: number, scope: () => Parameters<typeof runInUsageScope>[0], call: { provider: string; model: string; inputTokens: number; outputTokens: number; purpose?: 'answer' | 'judge' }) {
  vi.setSystemTime(atMs);
  try {
    await runInUsageScope(scope(), async () => afterModelCall({ operation: 'chat', ...call }));
  } finally {
    vi.setSystemTime(NOW);
  }
}

/** A request through the real guard: no test bypass, the bearer is all the route sees. */
async function unbypassed<T>(fn: () => Promise<T>): Promise<T> {
  disableTestAuth();
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
const rpc = (bearer: string, method: string, params?: unknown) =>
  unbypassed(async () => {
    const response = await mcpRoute.POST(new Request('http://localhost/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return { status: response.status, body: (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown } };
  });
async function tool(bearer: string, period: string): Promise<{ text: string; spend: AiMySpend }> {
  const { status, body } = await rpc(bearer, 'tools/call', { name: 'my_ai_spend', arguments: { period } });
  expect(status).toBe(200);
  expect(body.result?.isError, JSON.stringify(body)).toBeFalsy();
  return JSON.parse(body.result!.content![0]!.text) as { text: string; spend: AiMySpend };
}
const route = (bearer: string, period: string) =>
  unbypassed(async () => {
    const response = await (myRoute.GET as (r: Request) => Promise<Response>)(new Request(`http://landflow.test${MY_SPEND_PATH}?period=${period}`, { headers: { authorization: `Bearer ${bearer}` } }));
    return { status: response.status, body: (await response.json()) as AiMySpend };
  });
async function youCard(user: User, period: string): Promise<AiMySpend> {
  enableTestAuth(user);
  try {
    const response = await (meRoute.GET as (r: Request) => Promise<Response>)(new Request(`http://landflow.test/api/insights/ai/me?period=${period}`));
    expect(response.status).toBe(200);
    return (await response.json()) as AiMySpend;
  } finally {
    enableTestAuth();
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  owner = await createUser({ email: 'olga@mcp-you-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  mia = await createUser({ email: 'mia@mcp-you-join.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  savePriceOverrides([
    { provider: 'anthropic', model: OWNER_MODEL, input: 3, output: 15 },
    { provider: 'anthropic', model: MEMBER_MODEL, input: 1, output: 5 },
  ]);
  meter.invalidatePrices();
  // 40 days of each person's calls: their own runs, Spotlight, an unpriced local model; a few days are before the rollup's edge.
  for (let back = 40; back >= 0; back -= 3) {
    await spend(at(back), () => executionScope({ executionId: `ex_m_${back}`, workflowId: 'wf_you_join', userId: mia.id }), { provider: 'anthropic', model: MEMBER_MODEL, inputTokens: 20_000 + back * 100, outputTokens: 2_000, purpose: 'answer' });
    await spend(at(back), () => assistantScope({ userId: mia.id, surface: 'spotlight' }), { provider: 'ollama', model: 'qwen-you:7b', inputTokens: 5_000, outputTokens: 500 });
    await spend(at(back), () => executionScope({ executionId: `ex_o_${back}`, workflowId: 'wf_you_join', userId: owner.id }), { provider: 'anthropic', model: OWNER_MODEL, inputTokens: 90_000, outputTokens: 9_000, purpose: 'judge' });
  }
  await spend(at(0), () => assistantScope({ userId: mia.id, surface: 'architect' }), { provider: 'anthropic', model: MEMBER_MODEL, inputTokens: 1_234, outputTokens: 321 });
  await spend(at(0), () => assistantScope({ userId: owner.id, surface: 'spotlight' }), { provider: 'anthropic', model: OWNER_MODEL, inputTokens: 4_321, outputTokens: 123 });
  markSpendDays(Array.from({ length: 41 }, (_, back) => meter.today(at(back))));
  runRollup();
  saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 25, dayTokens: 900_000 }, [owner.id]: { name: 'Olga', monthCost: 7777 } } });
  meter.invalidateCaps();
  instanceToken = setMcpEnabled(true).token!;
  for (const user of [owner, mia]) keys.set(user.id, createApiKey(user, { label: 'brain', scopes: ['brain:read'] }).token);
});

afterAll(() => {
  vi.useRealTimers();
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('your own spend over MCP, the brain route and the You card', () => {
  it('keeps the three copies of the wire contract byte for byte the same', () => {
    const root = join(__dirname, '..', '..', '..');
    const copies = ['apps/web/src/lib/shared/my-spend-wire.ts', 'packages/cli/src/spend/my-spend-wire.ts', 'apps/web/claude-plugins/landflow-brain/hooks/my-spend-wire.ts'].map((path) => readFileSync(join(root, path)));
    expect(copies[0]!.length).toBeGreaterThan(0);
    for (const copy of copies.slice(1)) expect(copy.equals(copies[0]!)).toBe(true);
  });

  it('answers the same for an owner and a member in every period: the tool, the route and the You card', async () => {
    expect(MY_SPEND_PERIODS).toEqual(['24h', '7d', '30d', '90d']);
    for (const user of [owner, mia]) {
      const key = keys.get(user.id)!;
      for (const period of MY_SPEND_PERIODS) {
        const card = await youCard(user, period);
        const viaTool = await tool(key, period);
        const viaRoute = await route(key, period);
        expect(viaRoute.status, `${user.name} ${period}`).toBe(200);
        expect(viaTool.spend, `${user.name} ${period} tool`).toEqual(card);
        expect(viaRoute.body, `${user.name} ${period} route`).toEqual(card);
        expect(card.today.calls, `${user.name} ${period}`).toBeGreaterThan(0);
        expect(viaTool.text).toContain(`Your AI spend (${period}`);
      }
    }
  });

  it('never carries another person’s rows or caps, an owner’s included', async () => {
    for (const period of MY_SPEND_PERIODS) {
      const hers = JSON.stringify([await tool(keys.get(mia.id)!, period), (await route(keys.get(mia.id)!, period)).body]);
      expect(hers).not.toContain(OWNER_MODEL);
      expect(hers).not.toContain(owner.id);
      expect(hers).not.toContain('"max":7777');
      expect(hers).toContain(MEMBER_MODEL);
      const his = JSON.stringify([await tool(keys.get(owner.id)!, period), (await route(keys.get(owner.id)!, period)).body]);
      expect(his).not.toContain(MEMBER_MODEL);
      expect(his).not.toContain('qwen-you');
      expect(his).not.toContain(mia.id);
      expect(his).not.toContain('"max":25');
      expect(his).toContain(OWNER_MODEL);
    }
    const caps = (await tool(keys.get(mia.id)!, '30d')).spend.caps;
    expect(caps.map((c) => c.id).sort()).toEqual([`user:${mia.id}:day:tokens`, `user:${mia.id}:month:cost`]);
  });

  it('refuses the instance access token on both', async () => {
    const viaTool = await rpc(instanceToken, 'tools/call', { name: 'my_ai_spend', arguments: { period: '24h' } });
    expect(viaTool.body.result?.isError).toBe(true);
    expect(viaTool.body.result!.content![0]!.text).toContain('not the instance access token');
    expect((await route(instanceToken, '24h')).status).toBe(401);
    // A key without brain:read is refused by the route too (the You card's scope is not the brain's).
    const other = createApiKey(mia, { label: 'runs', scopes: ['executions:read'] }).token;
    expect((await route(other, '24h')).status).toBe(403);
  });
});
