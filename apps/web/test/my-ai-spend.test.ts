/**
 * SP12 (docs/llm-gateway.md, "The AI page" and "Who sees what", rule 5): GET /api/insights/ai/me answers the caller's
 * own rows and their own user caps, whoever asks; nothing in it is anyone else's; no "equivalent cost" anywhere.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-my-ai-spend-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const route = await import('@/app/api/insights/ai/me/route');
const forecastRoute = await import('@/app/api/insights/ai/forecast/route');
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
  row({ user_id: alma.id, cost: 0, provider: 'litellm', model: 'qwen3-coder:30b', gateway_provider: 'ollama_chat', source: 'litellm', input_tokens: 70, output_tokens: 7 });
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
    expect(body.today).toMatchObject({ cost: 3, calls: 4, runs: 2, unpricedCalls: 2 });
    expect(body.month.calls).toBe(4);
    expect(body.byModel.map((r: { label: string }) => r.label)).toEqual(['claude-sonnet-5-5', 'qwen3-coder:30b (ollama)', 'qwen3-coder:30b (litellm)']);
    expect(body.byModel.find((r: { label: string }) => r.label === 'qwen3-coder:30b (ollama)')).toMatchObject({ unpriced: true, calls: 1 });
    expect(body.byModel[0].unpriced).toBeUndefined();
    expect(body.byPurpose.map((r: { key: string }) => r.key).sort()).toEqual(['answer', 'judge', 'none']);
    expect(body.bySurface.find((r: { key: string }) => r.key === 'spotlight')).toMatchObject({ calls: 1 });
    expect(body.series).toHaveLength(7);
    expect(body.series.at(-1)).toMatchObject({ calls: 4, cost: 3 });
    // Nobody else's rows or names.
    expect(body.today.cost).toBeLessThan(9);
    expect(body.forecast).toBeUndefined();
  });

  it('prices the local model from now on: it stops being "Not priced"', async () => {
    savePriceOverrides([{ provider: 'ollama', model: 'qwen3-coder:30b', input: 1, output: 1 }]);
    aiUsageMeter().invalidatePrices();
    const { body } = await get(alma);
    expect(body.byModel.find((r: { label: string }) => r.label === 'qwen3-coder:30b (ollama)').unpriced).toBeUndefined();
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

  it('gives each own cap the forecast card’s figure for the same cap: a monthly forecast and reachesOn, a daily pace', async () => {
    const dana = await createUser({ email: 'dana@me.test', name: 'Dana', role: 'member', password: 'dana-password-1' });
    // Ten days of $4 a day before today, so the month's P50 line has a run rate (some days may fall in last month).
    const DAY = 86_400_000;
    for (let i = 1; i <= 10; i++) {
      const when = Date.now() - i * DAY;
      row({ user_id: dana.id, cost: 4, at: new Date(when).toISOString(), day: aiUsageMeter().today(when) });
    }
    row({ user_id: dana.id, cost: 1 });
    saveAiCaps({ credentials: {}, users: { [ben.id]: { name: 'Ben', dayCost: 77 }, [dana.id]: { name: 'Dana', monthCost: 30, dayCost: 50 } }, allUsers: { monthCost: 100 } });
    aiUsageMeter().invalidateCaps();
    // One clock for both reads: a daily cap's pace is by the minute of the day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    try {
      const { body } = await get(dana);
      enableTestAuth(dana);
      const forecast = await (await (forecastRoute.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/insights/ai/forecast'))).json();
      enableTestAuth();
      const month = body.caps.find((c: { id: string }) => c.id === `user:${dana.id}:month:cost`);
      const day = body.caps.find((c: { id: string }) => c.id === `user:${dana.id}:day:cost`);
      const cardMonth = forecast.caps.find((c: { capId: string }) => c.capId === month.id);
      const cardDay = forecast.caps.find((c: { capId: string }) => c.capId === day.id);
      expect(month.forecast).toBeDefined();
      expect(month.forecast).toEqual(cardMonth.forecast);
      expect(month.reachesOn).toEqual(cardMonth.reachesOn);
      expect(month.pace).toBeUndefined();
      expect(day.forecast).toBeUndefined();
      expect(typeof day.pace).toBe('number');
      expect(day.pace).toBe(cardDay.pace);
      expect(body.monthEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.monthEnd.slice(0, 7)).toBe(forecast.month);
      // Another person's rows never move Dana's figure.
      expect(month.forecast.monthToDate).toBeLessThanOrEqual(41);
    } finally {
      vi.useRealTimers();
      enableTestAuth();
      saveAiCaps({ credentials: {}, users: { [ben.id]: { name: 'Ben', dayCost: 77 } }, allUsers: { monthCost: 100 } });
      aiUsageMeter().invalidateCaps();
    }
  });

  it('has no "equivalent" field, and refuses a period it does not know', async () => {
    const { text } = await get(alma, '?period=30d');
    expect(text.toLowerCase()).not.toContain('equivalent');
    expect((await get(alma, '?period=custom')).status).toBe(400);
  });

  it('follows the 24h contract: 24 hourly points, ISO from/to, a rolling window by `at`', async () => {
    const cleo = await createUser({ email: 'cleo@me.test', name: 'Cleo', role: 'member', password: 'cleo-password-1' });
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
    const stamp = (hoursAgo: number) => ({ at: at(hoursAgo).toISOString(), day: aiUsageMeter().today(at(hoursAgo).getTime()) });
    row({ user_id: cleo.id, cost: 1, ...stamp(1) });
    row({ user_id: cleo.id, cost: 2, ...stamp(23) });
    row({ user_id: cleo.id, cost: 4, ...stamp(25) });
    const { body } = await get(cleo, '?period=24h');
    expect(body.period).toBe('24h');
    expect(body.series).toHaveLength(24);
    expect(Number.isNaN(Date.parse(body.from))).toBe(false);
    expect(Number.isNaN(Date.parse(body.to))).toBe(false);
    expect(body.series[0].at).toMatch(/T\d\d:00:00\.000Z$/);
    expect(body.series.reduce((sum: number, p: { cost: number }) => sum + p.cost, 0)).toBe(3);
    expect(body.byModel.reduce((sum: number, r: { cost: number }) => sum + r.cost, 0)).toBe(3);
  });

  it('folds the leading partial hour of the 24 hours into the first point, so the series equals the page totals', async () => {
    const eve = await createUser({ email: 'eve@me.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
    const at = new Date(Date.now() - 23.9 * 3_600_000);
    row({ user_id: eve.id, cost: 5, at: at.toISOString(), day: aiUsageMeter().today(at.getTime()) });
    row({ user_id: eve.id, cost: 1 });
    const { body } = await get(eve, '?period=24h');
    const total = body.series.reduce((sum: number, p: { cost: number }) => sum + p.cost, 0);
    expect(body.byModel.reduce((sum: number, r: { cost: number }) => sum + r.cost, 0)).toBe(6);
    expect(total).toBe(6);
    expect(body.series.reduce((sum: number, p: { calls: number }) => sum + p.calls, 0)).toBe(2);
  });

  it("counts the report's days for 7d in a zone with daylight saving, just after midnight in the week after spring forward", async () => {
    const zone = getSettings().timezone;
    updateSettings({ timezone: 'America/Los_Angeles' });
    const gus = await createUser({ email: 'gus@me.test', name: 'Gus', role: 'member', password: 'gus-password-1' });
    // 2026-03-12 00:30 in Los Angeles: the clocks went forward on 2026-03-08. The 7 days are 6 to 12 March.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-03-12T07:30:00.000Z'));
    try {
      row({ user_id: gus.id, cost: 1, day: '2026-03-05', at: '2026-03-05T20:00:00.000Z' });
      row({ user_id: gus.id, cost: 2, day: '2026-03-06', at: '2026-03-06T20:00:00.000Z' });
      row({ user_id: gus.id, cost: 4, day: '2026-03-12', at: '2026-03-12T07:00:00.000Z' });
      const { body } = await get(gus, '?period=7d');
      expect(body.from).toBe('2026-03-06');
      expect(body.series.map((p: { at: string }) => p.at)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12']);
      expect(body.byModel.reduce((sum: number, r: { cost: number }) => sum + r.cost, 0)).toBe(6);
    } finally {
      vi.useRealTimers();
      updateSettings({ timezone: zone });
    }
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
