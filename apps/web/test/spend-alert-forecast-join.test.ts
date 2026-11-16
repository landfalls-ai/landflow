/**
 * Join test (wave 14, carryover-w14 §2, `spend-alert-forecast-join`): SP23's forecast flags, cost alerts and Needs you ↔
 * SP11's `capForecaster` ↔ SP12's `mySpend` (the You card). A month of calls goes through the real meter (a member's
 * monthly user cap, an agent's monthly cost limit and a project budget each forecast over before the month ends; a
 * second member's cap that stays under; a third member's cap whose forecast is still early), then one rollup pass, one
 * flags pass and one tick of the alert service, with a cost rule on a webhook channel to a local `node:http` catcher.
 * Exactly one forecast notice per cap over; the notice's P50 and date, the Needs you item's, the forecast card's and the
 * member's `/me` cap all equal `capForecaster(now).forecast(cap)` to the cent; each person's Needs you holds only the caps
 * that are theirs to hear; a second tick sends nothing; acknowledging clears an item for everyone; nothing changed a cap,
 * a budget or a call. Offline; run under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiForecastReport, AiMySpend } from '@/lib/shared/ai-spend';
import type { NeedsYouRow } from '@/lib/client/run-trace';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-alert-forecast-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://landflow.test' });

// runtime.ts first: its side-effect registrations are the host's.
await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps, savePriceOverrides, runInUsageScope, agentScope, assistantScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { markSpendDays, runRollup } = await import('@/lib/server/ai-usage/rollup');
const { scanSpendFlags } = await import('@/lib/server/ai-usage/anomalies');
const { capForecaster } = await import('@/lib/server/ai-usage/forecast');
const { watchedCaps } = await import('@/lib/server/ai-usage/alerts');
const flags = await import('@/lib/server/ai-usage/spend-flags');
const { formatCost } = await import('@/lib/shared/ai-usage');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { agentStore } = await import('@/lib/server/agents/store');
const projects = await import('@/lib/server/projects/store');
const { saveBudget, getBudget } = await import('@/lib/server/budgets/store');
const { projectCapId } = await import('@/lib/shared/project-budget');
const { DEFAULT_AGENT_SETTINGS } = await import('@/lib/shared/agents');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const ackRoute = await import('@/app/api/insights/ai/flags/[id]/ack/route');
const forecastRoute = await import('@/app/api/insights/ai/forecast/route');
const meRoute = await import('@/app/api/insights/ai/me/route');

type User = Awaited<ReturnType<typeof createUser>>;
type Hook = { event: string; summary: string; details?: Record<string, string>; workflow?: { id: string } };
const DAY_MS = 86_400_000;
// Late enough in the month that a cap's own days are not "early" (7 observed days) in either time zone.
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MODEL = 'claude-forecast-join';
const meter = aiUsageMeter();

let owner: User;
let mia: User;
let omar: User;
let zed: User;
let eve: User;
let pam: User;
let alpha: string;
let agentId: string;
let catcher: Server;
let hookUrl: string;
const hooks: Hook[] = [];
let seq = 0;

/** One chat call through the real meter at `atMs`, priced at $1 per million input tokens. */
async function spend(atMs: number, scope: () => Parameters<typeof runInUsageScope>[0], dollars: number) {
  vi.setSystemTime(atMs);
  try {
    await runInUsageScope(scope(), async () => afterModelCall({ provider: 'anthropic', model: MODEL, operation: 'chat', inputTokens: Math.round(dollars * 1_000_000), outputTokens: 100 }));
  } finally {
    vi.setSystemTime(NOW);
  }
}
/** `back` days before now, a minute earlier (today's call is before now; the day is `back` days back in any time zone). */
const at = (back: number) => NOW - back * DAY_MS - 60_000;

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
const getJson = async <T>(user: User, route: { GET: unknown }, path: string): Promise<T> =>
  as(user, async () => {
    const response = await (route.GET as (r: Request) => Promise<Response>)(new Request(`http://landflow.test${path}`));
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  });
const spendItems = async (user: User) => (await getJson<{ items: NeedsYouRow[] }>(user, needsYouRoute, '/api/runs/needs-you')).items.filter((i) => i.kind === 'spend');
const ack = (user: User, id: string) => as(user, () => ackRoute.POST(new Request('http://landflow.test/x', { method: 'POST' }), { params: Promise.resolve({ id }) }));
const forecastHooks = () => hooks.filter((h) => h.event === 'costForecast');

const capIds = () => ({
  mia: `user:${mia.id}:month:cost`,
  omar: `user:${omar.id}:month:cost`,
  zed: `user:${zed.id}:month:cost`,
  agent: `agent:${agentId}:month:cost`,
  budget: projectCapId(alpha),
});
const forecastFlagId = (capId: string, kind: string) => flags.flagId('forecast', `${meter.today(NOW).slice(0, 7)}-01`, kind, capId);
const cents = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  catcher = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hooks.push(JSON.parse(body) as Hook);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => catcher.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(catcher.address() as AddressInfo).port}/hook`;

  owner = await createUser({ email: 'olga@forecast-alert-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  mia = await createUser({ email: 'mia@forecast-alert-join.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  omar = await createUser({ email: 'omar@forecast-alert-join.test', name: 'Omar', role: 'member', password: 'omar-password-1' });
  zed = await createUser({ email: 'zed@forecast-alert-join.test', name: 'Zed', role: 'member', password: 'zed-password-1' });
  eve = await createUser({ email: 'eve@forecast-alert-join.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
  pam = await createUser({ email: 'pam@forecast-alert-join.test', name: 'Pam', role: 'member', password: 'pam-password-1' });
  alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  projects.setMember(alpha, mia.id, 'viewer');
  projects.setMember(alpha, eve.id, 'editor');
  projects.setMember(alpha, pam.id, 'admin');
  const settings = { ...DEFAULT_AGENT_SETTINGS, monthlyCostLimit: 150 };
  const agent = agentStore.create({ name: 'Orders desk', instructions: 'Be brief.', model: { provider: 'anthropic', model: MODEL }, settings } as never);
  agentId = agent.id;
  projects.setHomeProject('agent', agentId, alpha);
  saveBudget({ projectId: alpha, monthlyUsd: 160, warnPercent: 100, hardStop: false });
  savePriceOverrides([{ provider: 'anthropic', model: MODEL, input: 1, output: 0 }]);
  meter.invalidatePrices();
  saveAiCaps({
    credentials: {},
    users: {
      [mia.id]: { name: 'Mia', monthCost: 75 },
      [omar.id]: { name: 'Omar', monthCost: 100 },
      [zed.id]: { name: 'Zed', monthCost: 50 },
    },
  });
  meter.invalidateCaps();
  meter.invalidateBudgets();

  // 25 days up to now: Mia $3 a day in Spotlight, the agent $6 a day in Alpha (one session a day), Omar $2 a day; Zed
  // $10 a day for the last 3 days only (his forecast is early).
  for (let back = 24; back >= 0; back--) {
    await spend(at(back), () => assistantScope({ userId: mia.id, surface: 'spotlight' }), 3);
    await spend(at(back), () => agentScope({ agentId, agentName: 'Orders desk', sessionId: `s_fj_${back}`, settings, projectId: alpha }), 6);
    await spend(at(back), () => assistantScope({ userId: omar.id, surface: 'architect' }), 2);
    if (back <= 2) await spend(at(back), () => assistantScope({ userId: zed.id, surface: 'brain' }), 10);
    seq++;
  }
  expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_usage')!.n).toBe(25 * 3 + 3);

  // One rollup pass over every day, one flags pass, one tick with a cost rule on the catcher.
  markSpendDays(Array.from({ length: 25 }, (_, back) => meter.today(at(back))));
  runRollup();
  scanSpendFlags(NOW);
  const channel = alertStore.createChannel({ name: 'Catcher', kind: 'webhook', config: { url: hookUrl } });
  alertStore.createRule({ name: 'AI cost', kind: 'cost', enabled: true, workflows: { mode: 'all' }, events: ['costThreshold'], channelIds: [channel.id], throttleMinutes: 0, cost: { thresholdPercent: 99 } });
  await alerts.tick(NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  enableTestAuth();
  await new Promise<void>((resolve) => catcher.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('forecast alerts against the forecast and the You card', () => {
  it('sends exactly one forecast notice per cap the forecast passes, none for the cap that stays under or the early one', () => {
    const ids = capIds();
    const sent = forecastHooks().map((h) => h.workflow!.id).sort();
    expect(sent).toEqual([ids.agent, ids.budget, ids.mia].sort());
    // What the alert sent is what the forecast says of every monthly cap.
    const forecaster = capForecaster(NOW);
    for (const cap of watchedCaps().filter((c) => c.period === 'month')) {
      const fields = forecaster.forecast(cap)!;
      const over = !fields.forecast!.early && fields.forecast!.p50 >= cap.max && fields.forecast!.monthToDate < cap.max;
      expect(sent.includes(cap.id), `${cap.id}: ${JSON.stringify(fields)}`).toBe(over);
    }
    expect(forecaster.forecast(watchedCaps().find((c) => c.id === ids.zed)!)!.forecast!.early).toBe(true);
    expect(forecaster.forecast(watchedCaps().find((c) => c.id === ids.omar)!)!.forecast!.p50).toBeLessThan(100);
  });

  it('gives the notice, the Needs you item, the forecast card and the member’s /me cap the same P50 and date as capForecaster', async () => {
    const forecaster = capForecaster(NOW);
    const caps = watchedCaps();
    const ownerItems = await spendItems(owner);
    const card = await getJson<AiForecastReport>(owner, forecastRoute, '/api/insights/ai/forecast');
    const ids = capIds();
    for (const [id, kind] of [[ids.mia, 'user'], [ids.agent, 'agent'], [ids.budget, 'project']] as const) {
      const cap = caps.find((c) => c.id === id)!;
      const fields = forecaster.forecast(cap)!;
      const p50 = fields.forecast!.p50;
      expect(fields.reachesOn, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The notice.
      const notice = forecastHooks().find((h) => h.workflow!.id === id)!;
      expect(notice.details!['Forecast for the month']).toBe(`${formatCost(p50)} (the middle of the forecast)`);
      expect(notice.details!['Reaches the cap around']).toBe(fields.reachesOn);
      expect(notice.summary).toContain(`around ${fields.reachesOn}`);
      // The stored flag and the Needs you item.
      const flag = flags.getFlag(forecastFlagId(id, kind))!;
      expect(cents(flag.p50)).toBe(cents(p50));
      expect(flag.reachesOn).toBe(fields.reachesOn);
      const item = ownerItems.find((i) => i.flagId === flag.id)!;
      expect(item.title).toContain(`around ${fields.reachesOn}`);
      expect(item.detail).toContain(`forecast ${formatCost(p50)} by the month’s end`);
      // The forecast card.
      const onCard = card.caps.find((c) => c.capId === id)!;
      expect(cents(onCard.forecast!.p50)).toBe(cents(p50));
      expect(onCard.reachesOn).toBe(fields.reachesOn);
    }
    // The member's You card: her own cap, the same figure.
    const me = await getJson<AiMySpend>(mia, meRoute, '/api/insights/ai/me');
    const own = me.caps.find((c) => c.id === ids.mia)!;
    const fields = forecaster.forecast(caps.find((c) => c.id === ids.mia)!)!;
    expect(cents(own.forecast!.p50)).toBe(cents(fields.forecast!.p50));
    expect(own.reachesOn).toBe(fields.reachesOn);
    expect(cents(own.forecast!.monthToDate)).toBe(cents(fields.forecast!.monthToDate));
  });

  it('shows each person only the caps that are theirs to hear', async () => {
    const ids = capIds();
    const keysOf = async (user: User) => (await spendItems(user)).filter((i) => i.flagKind === 'forecast').map((i) => flags.getFlag(i.flagId!)!.key).sort();
    expect(await keysOf(mia)).toEqual([ids.mia]);
    expect(await keysOf(eve)).toEqual([ids.agent]);
    // A project admin edits the project's agent too.
    expect(await keysOf(pam)).toEqual([ids.agent, ids.budget].sort());
    expect(await keysOf(omar)).toEqual([]);
    expect(await keysOf(zed)).toEqual([]);
    expect(await keysOf(owner)).toEqual([ids.agent, ids.budget, ids.mia].sort());
    // No one else's person in a member's list.
    expect(JSON.stringify(await spendItems(eve))).not.toContain('Mia');
  });

  it('sends nothing on a second tick, and acknowledging clears an item for everyone', async () => {
    const before = forecastHooks().length;
    await alerts.tick(NOW);
    scanSpendFlags(NOW);
    await alerts.tick(NOW);
    expect(forecastHooks()).toHaveLength(before);

    const ids = capIds();
    const miaFlag = forecastFlagId(ids.mia, 'user');
    expect((await ack(omar, miaFlag)).status).toBe(404);
    expect((await ack(mia, miaFlag)).status).toBe(200);
    expect((await spendItems(mia)).some((i) => i.flagId === miaFlag)).toBe(false);
    expect((await spendItems(owner)).some((i) => i.flagId === miaFlag)).toBe(false);
    const agentFlag = forecastFlagId(ids.agent, 'agent');
    expect((await ack(eve, agentFlag)).status).toBe(200);
    expect((await spendItems(owner)).filter((i) => i.flagKind === 'forecast').map((i) => i.flagId)).toEqual([forecastFlagId(ids.budget, 'project')]);
    expect((await spendItems(pam)).filter((i) => i.flagKind === 'forecast').map((i) => i.flagId)).toEqual([forecastFlagId(ids.budget, 'project')]);
    // The flags pass keeps them acknowledged; the next tick sends nothing.
    scanSpendFlags(NOW);
    await alerts.tick(NOW);
    expect(forecastHooks()).toHaveLength(before);
    expect(flags.getFlag(miaFlag)!.acknowledgedBy).toBe(mia.id);
  });

  it('changed no cap, budget or call', () => {
    expect(meter.caps().users[mia.id]).toMatchObject({ monthCost: 75 });
    expect(getBudget(alpha)).toMatchObject({ monthlyUsd: 160, hardStop: false });
    expect(agentStore.get(agentId)!.settings).toMatchObject({ monthlyCostLimit: 150 });
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_usage')!.n).toBe(25 * 3 + 3);
    expect(seq).toBe(25);
  });
});
