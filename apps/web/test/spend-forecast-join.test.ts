/**
 * Join test (wave 13, plan-v2 "Join tests are the integrator's", `spend-forecast-join`): SP11's month-end forecast ↔
 * SP12's You card. A person's own user caps (their own set, and everyone's default for another person) answer the same
 * figure in `GET /api/insights/ai/forecast` (the forecast card, as that person and as an owner) and in `GET
 * /api/insights/ai/me` (the You card): a monthly cap's `forecast` and `reachesOn`, a daily cap's `pace`, and the words
 * both cards show for them. One clock for every read (a daily cap's pace is by the minute). Offline; run under
 * TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AiForecastCap, AiForecastReport, AiMySpend } from '@/lib/shared/ai-spend';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-forecast-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const { monthEndOf } = await import('@/lib/shared/ai-forecast');
const { capOutlook } = await import('@/lib/client/ai-forecast');
const forecastRoute = await import('@/app/api/insights/ai/forecast/route');
const meRoute = await import('@/app/api/insights/ai/me/route');

type User = Awaited<ReturnType<typeof createUser>>;
type MyCap = AiMySpend['caps'][number];
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
let owner: User;
let mia: User;
let omar: User;
let counter = 0;

function row(atMs: number, fields: Record<string, unknown>) {
  database().insertNew('ai_usage', {
    id: `fj-${++counter}`,
    call_id: `fj-call-${counter}`,
    at: new Date(atMs).toISOString(),
    day: aiUsageMeter().today(atMs),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 200,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 1,
    ...fields,
  });
}

async function get<T>(user: User, route: { GET: unknown }, path: string): Promise<T> {
  enableTestAuth(user);
  try {
    const response = await (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test${path}`));
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  } finally {
    enableTestAuth();
  }
}
const forecastOf = (user: User) => get<AiForecastReport>(user, forecastRoute, '/api/insights/ai/forecast');
const meOf = (user: User) => get<AiMySpend>(user, meRoute, '/api/insights/ai/me');

/** The forecast fields both cards carry for one cap. */
const figure = (cap: MyCap | AiForecastCap) => ({ period: cap.period, metric: cap.metric, max: cap.max, used: cap.used, forecast: cap.forecast, pace: cap.pace, reachesOn: cap.reachesOn });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  owner = await createUser({ email: 'olga@forecast-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  mia = await createUser({ email: 'mia@forecast-join.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  omar = await createUser({ email: 'omar@forecast-join.test', name: 'Omar', role: 'member', password: 'omar-password-1' });
  const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  projects.setMember(alpha, mia.id, 'editor');
  store.saveWorkflow({ id: 'wf_fj', name: 'Alpha flow', nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', 'wf_fj', alpha);

  // 20 days up to now (into last month): Mia $2 a day in a workflow and a varying Spotlight call; Omar $5 a day; an
  // agent's calls with no person. Today Mia has made one more call so far.
  for (let k = 0; k <= 20; k++) {
    const at = NOW - k * DAY_MS - 2 * 3_600_000;
    row(at, { user_id: mia.id, workflow_id: 'wf_fj', execution_id: `ex_m_${k}`, project_id: alpha, cost: 2 });
    row(at, { user_id: mia.id, surface: 'spotlight', session_id: `s_m_${k}`, cost: 0.25 * (k % 4), input_tokens: 50 * (k % 5) });
    row(at, { user_id: omar.id, execution_id: `ex_o_${k}`, cost: 5, input_tokens: 900 });
    row(at, { agent_id: 'ag_fj', session_id: `s_a_${k}`, cost: 3 });
  }
  row(NOW - 60_000, { user_id: mia.id, cost: 1.5, input_tokens: 400 });

  saveAiCaps({
    credentials: {},
    users: { [mia.id]: { name: 'Mia', monthCost: 60, dayCost: 3, monthTokens: 12_000, dayTokens: 10_000 } },
    allUsers: { monthCost: 500, dayTokens: 2_000 },
  });
  aiUsageMeter().invalidateCaps();
});

afterAll(() => {
  vi.useRealTimers();
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('a cap’s forecast on the forecast card and the You card', () => {
  it('gives each of a person’s own caps the same figure on both cards, as the person and as an owner', async () => {
    const me = await meOf(mia);
    const own = await forecastOf(mia);
    const owners = await forecastOf(owner);
    expect(me.caps.map((c) => c.id).sort()).toEqual([`user:${mia.id}:day:cost`, `user:${mia.id}:day:tokens`, `user:${mia.id}:month:cost`, `user:${mia.id}:month:tokens`]);
    for (const cap of me.caps) {
      const card = own.caps.find((c) => c.capId === cap.id);
      const ownerCard = owners.caps.find((c) => c.capId === cap.id);
      expect(card, cap.id).toBeDefined();
      expect(figure(cap)).toEqual(figure(card!));
      expect(figure(cap)).toEqual(figure(ownerCard!));
      if (cap.period === 'month') {
        expect(cap.forecast).toBeDefined();
        expect(cap.pace).toBeUndefined();
      } else {
        expect(cap.forecast).toBeUndefined();
        expect(typeof cap.pace).toBe('number');
      }
    }
  });

  it('forecasts from the person’s own rows: month to date is the You card’s month, in money and in tokens', async () => {
    const me = await meOf(mia);
    const cost = me.caps.find((c) => c.id === `user:${mia.id}:month:cost`)!;
    const tokens = me.caps.find((c) => c.id === `user:${mia.id}:month:tokens`)!;
    expect(cost.forecast!.monthToDate).toBeCloseTo(me.month.cost, 6);
    expect(cost.used).toBeCloseTo(me.month.cost, 6);
    expect(tokens.forecast!.monthToDate).toBe(me.month.inputTokens + me.month.outputTokens);
    // $60 at about $2.4 a day is reached before the month ends; Omar's $5 a day never counts in it.
    expect(cost.reachesOn).toBeDefined();
    expect(cost.reachesOn! <= me.monthEnd).toBe(true);
    expect(me.monthEnd).toBe(monthEndOf(aiUsageMeter().today(NOW)));
  });

  it('shows the same words for a cap on both cards', async () => {
    const me = await meOf(mia);
    const card = await forecastOf(mia);
    const cardMonthEnd = monthEndOf(`${card.month}-01`);
    expect(me.monthEnd).toBe(cardMonthEnd);
    for (const cap of me.caps) {
      const other = card.caps.find((c) => c.capId === cap.id)!;
      expect(capOutlook(cap, me.monthEnd)).toEqual(capOutlook(other, cardMonthEnd));
    }
    expect(capOutlook(me.caps.find((c) => c.id === `user:${mia.id}:month:cost`)!, me.monthEnd).text).toMatch(/^Reaches its limit on /);
  });

  it('gives a person on everyone’s default cap the same figure too, and nobody else’s cap', async () => {
    const me = await meOf(omar);
    expect(me.caps.map((c) => c.id).sort()).toEqual([`user:${omar.id}:day:tokens`, `user:${omar.id}:month:cost`]);
    const own = await forecastOf(omar);
    const owners = await forecastOf(owner);
    for (const cap of me.caps) {
      expect(figure(cap)).toEqual(figure(own.caps.find((c) => c.capId === cap.id)!));
      expect(figure(cap)).toEqual(figure(owners.caps.find((c) => c.capId === cap.id)!));
    }
    // Omar's month: $5 a day; the $500 default stays out of reach.
    const month = me.caps.find((c) => c.id === `user:${omar.id}:month:cost`)!;
    expect(month.reachesOn).toBeUndefined();
    expect(capOutlook(month, me.monthEnd).text).toMatch(/^Stays under its limit to /);
    // Neither person's response names the other.
    expect(JSON.stringify(me)).not.toContain(mia.id);
    expect(JSON.stringify(await meOf(mia))).not.toContain(omar.id);
  });
});
