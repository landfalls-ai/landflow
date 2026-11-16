/**
 * SP12 (docs/llm-gateway.md, "The AI page" and "Who sees what", rule 5): GET /api/insights/ai/me answers the caller's
 * own rows and their own user caps, whoever asks; nothing in it is anyone else's; no "equivalent cost" anywhere.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-my-ai-spend-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps, savePriceOverrides } = await import('@/lib/server/ai-usage');
const route = await import('@/app/api/insights/ai/me/route');
const { youModels } = await import('@/components/insights/my-ai-spend');

type User = Awaited<ReturnType<typeof createUser>>;
let alma: User;
let ben: User;
let counter = 0;

function row(fields: Record<string, unknown>) {
  const now = new Date();
  database().insertNew('ai_usage', {
    id: `me-${++counter}`,
    call_id: `me-call-${counter}`,
    at: now.toISOString(),
    day: aiUsageMeter().today(now.getTime()),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
    ...fields,
  });
}

const get = async (user: User, query = '') => {
  enableTestAuth(user);
  try {
    const response = await (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test/api/insights/ai/me${query}`));
    return { status: response.status, text: await response.clone().text(), body: await response.json() };
  } finally {
    enableTestAuth();
  }
};

beforeAll(async () => {
  alma = await createUser({ email: 'alma@me.test', name: 'Alma', role: 'member', password: 'alma-password-1' });
  ben = await createUser({ email: 'ben@me.test', name: 'Ben', role: 'member', password: 'ben-password-1' });
  row({ user_id: alma.id, cost: 1, execution_id: 'ex_1', purpose: 'answer', surface: 'spotlight' });
  row({ user_id: alma.id, cost: 2, execution_id: 'ex_1', purpose: 'judge' });
  row({ user_id: alma.id, cost: 0, provider: 'ollama', model: 'qwen3-coder:30b', input_tokens: 5000, output_tokens: 500, session_id: 's_1' });
  row({ user_id: ben.id, cost: 40, execution_id: 'ex_ben' });
  row({ cost: 9 });
  saveAiCaps({ credentials: {}, users: { [ben.id]: { name: 'Ben', dayCost: 77 } }, allUsers: { monthCost: 100 } });
  aiUsageMeter().invalidateCaps();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('GET /api/insights/ai/me', () => {
  it('answers only the caller’s own rows, with runs counted once and local models "Not priced"', async () => {
    const { status, body } = await get(alma);
    expect(status).toBe(200);
    expect(body.today).toMatchObject({ cost: 3, calls: 3, runs: 2, unpricedCalls: 1 });
    expect(body.month.calls).toBe(3);
    expect(body.byModel.map((r: { label: string }) => r.label)).toEqual(['claude-sonnet-5-5', 'qwen3-coder:30b']);
    expect(body.byModel.find((r: { label: string }) => r.label === 'qwen3-coder:30b')).toMatchObject({ unpriced: true, calls: 1 });
    expect(body.byModel[0].unpriced).toBeUndefined();
    expect(body.byPurpose.map((r: { key: string }) => r.key).sort()).toEqual(['answer', 'judge', 'none']);
    expect(body.bySurface.find((r: { key: string }) => r.key === 'spotlight')).toMatchObject({ calls: 1 });
    expect(body.series).toHaveLength(7);
    expect(body.series.at(-1)).toMatchObject({ calls: 3, cost: 3 });
    // Nobody else's rows or names.
    expect(body.today.cost).toBeLessThan(9);
    expect(body.forecast).toBeUndefined();
  });

  it('prices the local model from now on: it stops being "Not priced"', async () => {
    savePriceOverrides([{ provider: 'ollama', model: 'qwen3-coder:30b', input: 1, output: 1 }]);
    aiUsageMeter().invalidatePrices();
    const { body } = await get(alma);
    expect(body.byModel.find((r: { label: string }) => r.label === 'qwen3-coder:30b').unpriced).toBeUndefined();
    savePriceOverrides([]);
    aiUsageMeter().invalidatePrices();
  });

  it('gives a member only their own caps (everyone’s default, or their own set), never another person’s', async () => {
    const almaView = await get(alma);
    expect(almaView.body.caps.map((c: { id: string }) => c.id)).toEqual([`user:${alma.id}:month:cost`]);
    expect(almaView.body.caps[0]).toMatchObject({ max: 100, used: 3, canRequest: true });
    expect(almaView.text).not.toContain(ben.id);
    expect(almaView.text).not.toContain('ben@me.test');
    const benView = await get(ben);
    expect(benView.body.caps.map((c: { id: string }) => c.id)).toEqual([`user:${ben.id}:day:cost`]);
    expect(benView.body.today.cost).toBe(40);
  });

  it('has no "equivalent" field, and refuses a period it does not know', async () => {
    const { text } = await get(alma, '?period=30d');
    expect(text.toLowerCase()).not.toContain('equivalent');
    expect((await get(alma, '?period=custom')).status).toBe(400);
  });

  it('ranks models for the You card: cost first, then tokens', () => {
    const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 1, unpricedCalls: 0, runs: 1, share: 0 };
    const rows = [
      { ...base, key: 'a', label: 'small-local', inputTokens: 10, unpriced: true },
      { ...base, key: 'b', label: 'big-local', inputTokens: 9000, unpriced: true },
      { ...base, key: 'c', label: 'hosted', cost: 2 },
    ];
    expect(youModels(rows).map((r) => r.label)).toEqual(['hosted', 'big-local', 'small-local']);
  });
});
