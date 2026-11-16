/**
 * Join test (wave 14, carryover-w14 §2, `spend-status-line-join`): SP15's landflow-brain mod (`getMySpend` in
 * hooks/client.ts and `statusLine` in hooks/journal.ts) ↔ SP14's `GET /api/brain/my-spend`. The mod's own code runs
 * with an engine whose `http.fetch` calls the real route handler through the real guard (a `brain:write` API key, no
 * test bypass). The status line's figure is the You card's `today.cost` for the same person (or its tokens when nothing
 * today was priced), formatted as the mod does; a key the route refuses (403) shows no spend; and the mod reads only
 * fields of `MySpendWire`: the route's answer cut down to the wire's fields gives the same line. Offline; run under
 * TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMySpend } from '@/lib/shared/ai-spend';
import type { MySpendTotals, MySpendWire } from '@/lib/shared/my-spend-wire';
import { getMySpend } from '../claude-plugins/landflow-brain/hooks/client';
import { statusLine } from '../claude-plugins/landflow-brain/hooks/journal';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-status-line-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, disableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { aiUsageMeter, savePriceOverrides, runInUsageScope, assistantScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { MY_SPEND_PATH } = await import('@/lib/shared/my-spend-wire');
const myRoute = await import('@/app/api/brain/my-spend/route');
const meRoute = await import('@/app/api/insights/ai/me/route');

type User = Awaited<ReturnType<typeof createUser>>;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY_MS = 86_400_000;
const URL_BASE = 'http://landflow.test';
const meter = aiUsageMeter();
/** The fields of MySpendTotals: what the mod may read of `today` (and `month`). */
const WIRE_FIELDS: Array<keyof MySpendTotals> = ['cost', 'inputTokens', 'outputTokens', 'calls', 'unpricedCalls'];

let mia: User;
let leo: User;
let ada: User;

async function spend(atMs: number, scope: () => Parameters<typeof runInUsageScope>[0], call: { provider: string; model: string; inputTokens: number; outputTokens: number }) {
  vi.setSystemTime(atMs);
  try {
    await runInUsageScope(scope(), async () => afterModelCall({ operation: 'chat', ...call }));
  } finally {
    vi.setSystemTime(NOW);
  }
}

/** The wire's view of an answer: `today` and `month` with the MySpendTotals fields only. */
const toWire = (body: AiMySpend): MySpendWire => {
  const pick = (t: AiMySpend['today']) => Object.fromEntries(WIRE_FIELDS.map((f) => [f, t[f]])) as unknown as MySpendTotals;
  return { today: pick(body.today), month: pick(body.month) };
};

/**
 * The engine beneath the mod: `http.fetch` sends the mod's request to the real route handler (the real guard reads the
 * bearer), and answers as the engine does (`status`, `text`). `cut` narrows the body to the wire's fields first.
 */
function engine(options: { cut?: boolean } = {}) {
  const urls: string[] = [];
  const $ = {
    http: {
      async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
        urls.push(url);
        const parsed = new URL(url);
        expect(parsed.pathname).toBe(MY_SPEND_PATH);
        disableTestAuth();
        try {
          const response = await (myRoute.GET as (r: Request) => Promise<Response>)(new Request(url, { method: init.method ?? 'GET', headers: init.headers }));
          let text = await response.text();
          if (options.cut && response.ok) text = JSON.stringify(toWire(JSON.parse(text) as AiMySpend));
          return { status: response.status, ok: response.ok, headers: {}, text };
        } finally {
          enableTestAuth();
        }
      },
    },
    clock: { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), now: async () => Date.now() },
  };
  return { $: $ as never, urls };
}

async function youCard(user: User): Promise<AiMySpend> {
  enableTestAuth(user);
  try {
    const response = await (meRoute.GET as (r: Request) => Promise<Response>)(new Request(`${URL_BASE}/api/insights/ai/me?period=24h`));
    expect(response.status).toBe(200);
    return (await response.json()) as AiMySpend;
  } finally {
    enableTestAuth();
  }
}
const keyOf = (user: User, scopes: Array<'brain:write' | 'brain:read' | 'executions:read'>) => createApiKey(user, { label: scopes.join(), scopes }).token;
/** The line as the mod formats today's spend: dollars, tokens when nothing today was priced. */
function expected(card: AiMySpend): string {
  const t = card.today;
  if (!(t.cost > 0) && t.unpricedCalls > 0) {
    const tokens = t.inputTokens + t.outputTokens;
    return `brain: on · 0 held · ${tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens today`;
  }
  return `brain: on · 0 held · $${t.cost.toFixed(2)} today`;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mia = await createUser({ email: 'mia@status-line-join.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  leo = await createUser({ email: 'leo@status-line-join.test', name: 'Leo', role: 'member', password: 'leo-password-1' });
  ada = await createUser({ email: 'ada@status-line-join.test', name: 'Ada', role: 'owner', password: 'ada-password-1' });
  savePriceOverrides([{ provider: 'anthropic', model: 'claude-status-join', input: 3, output: 15 }]);
  meter.invalidatePrices();
  // Mia: priced calls today (and yesterday, which is not today's); Leo: only an unpriced local model today; Ada: a lot.
  await spend(NOW - 60_000, () => executionScope({ executionId: 'ex_m1', workflowId: 'wf_status', userId: mia.id }), { provider: 'anthropic', model: 'claude-status-join', inputTokens: 412_345, outputTokens: 20_111 });
  await spend(NOW - 120_000, () => assistantScope({ userId: mia.id, surface: 'spotlight' }), { provider: 'ollama', model: 'qwen-status:7b', inputTokens: 9_000, outputTokens: 900 });
  await spend(NOW - DAY_MS - 60_000, () => assistantScope({ userId: mia.id, surface: 'spotlight' }), { provider: 'anthropic', model: 'claude-status-join', inputTokens: 5_000_000, outputTokens: 0 });
  await spend(NOW - 60_000, () => assistantScope({ userId: leo.id, surface: 'architect' }), { provider: 'ollama', model: 'qwen-status:7b', inputTokens: 37_000, outputTokens: 4_400 });
  await spend(NOW - 60_000, () => executionScope({ executionId: 'ex_a1', workflowId: 'wf_status', userId: ada.id }), { provider: 'anthropic', model: 'claude-status-join', inputTokens: 3_000_000, outputTokens: 100_000 });
});

afterAll(() => {
  vi.useRealTimers();
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('the mod’s status line against the real route', () => {
  it('shows the You card’s today in dollars for the same person, with a brain:write key', async () => {
    const { $, urls } = engine();
    const totals = await getMySpend($, { url: URL_BASE, key: keyOf(mia, ['brain:write']) });
    const card = await youCard(mia);
    expect(urls).toEqual([`${URL_BASE}${MY_SPEND_PATH}?period=24h`]);
    expect(totals).toEqual(toWire(card).today);
    expect(card.today.cost).toBeGreaterThan(0.01);
    expect(statusLine('review', 'allowed', 0, totals)).toBe(expected(card));
    expect(statusLine('review', 'allowed', 0, totals)).toBe(`brain: on · 0 held · $${card.today.cost.toFixed(2)} today`);
  });

  it('shows tokens when nothing today was priced, and each person only their own', async () => {
    const { $ } = engine();
    const totals = await getMySpend($, { url: URL_BASE, key: keyOf(leo, ['brain:write']) });
    const card = await youCard(leo);
    expect(card.today.cost).toBe(0);
    expect(card.today.unpricedCalls).toBe(1);
    expect(statusLine('review', 'allowed', 0, totals)).toBe(expected(card));
    expect(statusLine('review', 'allowed', 0, totals)).toBe('brain: on · 0 held · 41k tokens today');
    // An owner's key reads the owner's own spend, not the instance's.
    const owners = await getMySpend($, { url: URL_BASE, key: keyOf(ada, ['brain:write']) });
    expect(statusLine('review', 'allowed', 0, owners)).toBe(expected(await youCard(ada)));
    expect(owners!.cost).toBeCloseTo((await youCard(ada)).today.cost, 6);
  });

  it('shows no spend for a key the route refuses (403)', async () => {
    const { $ } = engine();
    const key = keyOf(mia, ['executions:read']);
    disableTestAuth();
    try {
      const response = await (myRoute.GET as (r: Request) => Promise<Response>)(new Request(`${URL_BASE}${MY_SPEND_PATH}?period=24h`, { headers: { authorization: `Bearer ${key}` } }));
      expect(response.status).toBe(403);
    } finally {
      enableTestAuth();
    }
    const totals = await getMySpend($, { url: URL_BASE, key });
    expect(totals).toBeUndefined();
    expect(statusLine('review', 'allowed', 0, totals)).toBe('brain: on · 0 held');
  });

  it('reads only fields of MySpendWire: the answer cut down to the wire gives the same line', async () => {
    const key = keyOf(mia, ['brain:write']);
    const full = await getMySpend(engine().$, { url: URL_BASE, key });
    const cut = await getMySpend(engine({ cut: true }).$, { url: URL_BASE, key });
    expect(cut).toEqual(full);
    expect(Object.keys(full!).sort()).toEqual([...WIRE_FIELDS].sort());
    expect(statusLine('auto', 'allowed', 2, cut)).toBe(statusLine('auto', 'allowed', 2, full));
  });
});
