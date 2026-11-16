/**
 * The month-end forecast and the cache card (docs/llm-gateway.md, "The AI page"): the method on fixed series, who sees
 * which cap (rule 5 of "Who sees what"), and the cache card's numbers against the Run Trace's own `cacheLine`.
 * Run under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too: day keys are the instance's, never the machine's.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { addDays, FORECAST_Z90, forecastMonth, monthEndOf, paceToday, reachesOn } from '@/lib/shared/ai-forecast';
import { amountOf, capOutlook, dayWord, forecastNote, forecastRange, missesLead, money } from '@/lib/client/ai-forecast';

const series = (from: string, values: number[]): Record<string, number> => Object.fromEntries(values.map((v, i) => [addDays(from, i), v]));

describe('forecastMonth', () => {
  it('projects a flat month: month to date plus the mean times the days left, no band', () => {
    // Oct 25 to Nov 16 at $10 a day; Nov 1 to 16 is 16 days.
    const f = forecastMonth(series('2026-10-25', Array(23).fill(10)), '2026-11-16', '2026-11-30');
    expect(f).toEqual({ monthToDate: 160, p50: 300, low: 300, high: 300, early: false, daysObserved: 22, daysLeft: 14 });
  });

  it('keeps today out of the run rate but in the month to date', () => {
    const values = series('2026-11-01', Array(15).fill(10));
    values['2026-11-16'] = 1000;
    const f = forecastMonth(values, '2026-11-16', '2026-11-30');
    expect(f.monthToDate).toBe(1150);
    expect(f.p50).toBe(1150 + 10 * 14);
  });

  it('takes the band from the sample σ of the last 7 complete days, ±1.2816·σ·√days left', () => {
    const last7 = [4, 6, 8, 10, 12, 14, 16];
    const values = { ...series('2026-11-01', Array(8).fill(10)), ...series('2026-11-09', last7) };
    const f = forecastMonth(values, '2026-11-16', '2026-11-30');
    const mean = 10;
    const sigma = Math.sqrt(last7.reduce((s, v) => s + (v - mean) ** 2, 0) / 6);
    expect(f.p50).toBeCloseTo(f.monthToDate + mean * 14, 9);
    expect(f.high - f.p50).toBeCloseTo(FORECAST_Z90 * sigma * Math.sqrt(14), 9);
    expect(f.p50 - f.low).toBeCloseTo(FORECAST_Z90 * sigma * Math.sqrt(14), 9);
    expect(f.early).toBe(false);
  });

  it('follows a rising series by its last 7 days, not the month', () => {
    const f = forecastMonth(series('2026-11-01', [...Array(8).fill(1), 2, 3, 4, 5, 6, 7, 8, 0]), '2026-11-16', '2026-11-30');
    // 2..8 are Nov 9..15; Nov 16 is today (0 so far).
    expect(f.p50).toBeCloseTo(f.monthToDate + 5 * 14, 9);
  });

  it('never lets the low end go below what is spent', () => {
    const f = forecastMonth(series('2026-11-01', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0]), '2026-11-20', '2026-11-30');
    expect(f.low).toBe(f.monthToDate);
    expect(f.high).toBeGreaterThan(f.p50);
  });

  it('says early with under 7 complete days of data, and uses the days there are', () => {
    const f = forecastMonth(series('2026-11-14', [6, 8, 10]), '2026-11-16', '2026-11-30');
    expect(f.early).toBe(true);
    expect(f.daysObserved).toBe(2);
    expect(f.p50).toBeCloseTo(f.monthToDate + 7 * 14, 9);
    expect(forecastMonth(series('2026-11-10', [1, 1, 1, 1, 1, 1, 1]), '2026-11-17', '2026-11-30').early).toBe(false);
  });

  it('is zero and early with no data', () => {
    expect(forecastMonth({}, '2026-11-16', '2026-11-30')).toEqual({ monthToDate: 0, p50: 0, low: 0, high: 0, early: true, daysObserved: 0, daysLeft: 14 });
  });

  it('reaches back into the month before for the last 7 days of a new month', () => {
    const f = forecastMonth(series('2026-10-20', Array(14).fill(3)), '2026-11-02', '2026-11-30');
    expect(f.monthToDate).toBe(6);
    expect(f.p50).toBe(6 + 3 * 28);
    expect(f.daysLeft).toBe(28);
  });

  it('counts the days left in months of 28, 29, 30 and 31 days', () => {
    expect(monthEndOf('2027-02-10')).toBe('2027-02-28');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
    expect(monthEndOf('2026-11-10')).toBe('2026-11-30');
    expect(monthEndOf('2026-12-10')).toBe('2026-12-31');
    expect(forecastMonth(series('2027-02-01', Array(10).fill(1)), '2027-02-10', monthEndOf('2027-02-10')).daysLeft).toBe(18);
    expect(forecastMonth(series('2026-12-01', Array(10).fill(1)), '2026-12-10', monthEndOf('2026-12-10')).daysLeft).toBe(21);
  });

  it('does not depend on the machine’s time zone (day keys are strings)', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(dayWord('2026-11-24')).toBe('Nov 24');
  });
});

describe('reachesOn and paceToday', () => {
  const f = forecastMonth(series('2026-10-25', Array(23).fill(10)), '2026-11-16', '2026-11-30');
  it('is the first day the P50 line reaches the limit', () => {
    // month to date 160, $10 a day: 200 is reached on the 4th day after today.
    expect(reachesOn(f, 200, '2026-11-16')).toBe('2026-11-20');
    expect(reachesOn(f, 161, '2026-11-16')).toBe('2026-11-17');
    expect(reachesOn(f, 300, '2026-11-16')).toBe('2026-11-30');
  });
  it('is none when it stays under or is already over', () => {
    expect(reachesOn(f, 301, '2026-11-16')).toBeUndefined();
    expect(reachesOn(f, 160, '2026-11-16')).toBeUndefined();
    expect(reachesOn(f, 100, '2026-11-16')).toBeUndefined();
    expect(reachesOn(forecastMonth({}, '2026-11-16', '2026-11-30'), 5, '2026-11-16')).toBeUndefined();
  });
  it('spreads today’s use over 24 hours', () => {
    expect(paceToday(3, 6)).toBe(12);
    expect(paceToday(5, 24)).toBe(5);
    expect(paceToday(5, 0)).toBe(5);
  });
});

describe('the words', () => {
  it('writes a range, the P50 and the early flag', () => {
    const f = { monthToDate: 160, p50: 460, low: 410, high: 520, early: false, daysObserved: 20, daysLeft: 14 };
    expect(forecastRange(f, '2026-11-30')).toBe('$410 to $520 by Nov 30');
    expect(forecastRange({ ...f, low: 460, high: 460 }, '2026-11-30')).toBe('about $460 by Nov 30');
    expect(forecastNote(f)).toContain('Most likely about $460');
    expect(forecastNote(f)).not.toContain('Early');
    expect(forecastNote({ ...f, early: true })).toContain('Early: under 7 days');
    expect(money(12.5)).toBe('$12.50');
    expect(amountOf('tokens', 1_500_000)).toBe('1.5M tokens');
  });
  it('says when a cap is reached, that it stays under, or the pace', () => {
    const base = { capId: 'user:u:month:cost', subject: 'user “Mia”', metric: 'cost' as const, max: 40, used: 32 };
    expect(capOutlook({ ...base, period: 'month', reachesOn: '2026-11-20' }, '2026-11-30').text).toBe('Reaches its limit on Nov 20');
    expect(capOutlook({ ...base, period: 'month' }, '2026-11-30').text).toBe('Stays under its limit to Nov 30');
    expect(capOutlook({ ...base, period: 'month', used: 45 }, '2026-11-30').text).toBe('Already at its limit');
    expect(capOutlook({ ...base, period: 'day', max: 10, used: 3, pace: 12 }, '2026-11-30').text).toBe('On pace for $12.00 today, over its limit');
  });
});

// The route and the report, as people see them.
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-forecast-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { agentStore } = await import('@/lib/server/agents/store');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps, findPrice } = await import('@/lib/server/ai-usage');
const { saveBudget } = await import('@/lib/server/budgets/store');
const { aiForecast } = await import('@/lib/server/ai-usage/forecast');
const { aiCacheReport } = await import('@/lib/server/ai-usage/cache-report');
const { cacheLine, callOf, partsOf } = await import('@/lib/server/ai-usage/run-spend');
const { priceOverrides } = await import('@/lib/server/ai-usage/prices');
const forecastRoute = await import('@/app/api/insights/ai/forecast/route');
const cacheRoute = await import('@/app/api/insights/ai/cache/route');

type User = Awaited<ReturnType<typeof createUser>>;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const dayOf = (ms: number) => aiUsageMeter().today(ms);
let owner: User;
let member: User;
let other: User;
let wfMine = '';
let wfTheirs = '';
let mineProject = '';
let readableAgent = { id: '', name: '' };
let hiddenAgent = { id: '', name: '' };
let counter = 0;

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

function row(fields: Record<string, unknown>) {
  const at = Number(fields.atMs ?? NOW);
  delete fields.atMs;
  database().insertNew('ai_usage', {
    id: `au_fc_${counter++}`,
    at: new Date(at).toISOString(),
    day: dayOf(at),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100,
    output_tokens: 50,
    cost: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...fields,
  });
}

function workflow(id: string, project: string) {
  store.saveWorkflow({ id, name: id, nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
  return id;
}

beforeAll(async () => {
  owner = await createUser({ email: 'olga@forecast.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  member = await createUser({ email: 'mia@forecast.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  other = await createUser({ email: 'omar@forecast.test', name: 'Omar', role: 'member', password: 'omar-password-1' });
  mineProject = projects.createTeamProject({ name: 'Alpha' }).id;
  const theirs = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(mineProject, member.id, 'editor');
  projects.setMember(mineProject, other.id, 'editor');
  wfMine = workflow('wf_fc_mine', mineProject);
  wfTheirs = workflow('wf_fc_theirs', theirs);
  readableAgent = agentStore.create({ name: 'Support agent', settings: { monthlyCostLimit: 500 } });
  hiddenAgent = agentStore.create({ name: 'Secret desk', settings: { monthlyCostLimit: 900 } });
  projects.setHomeProject('agent', readableAgent.id, mineProject);
  projects.setHomeProject('agent', hiddenAgent.id, theirs);

  // The last 22 days (Oct 25 to Nov 16): Mia $2 a day in Alpha, Omar $5 a day in Beta, the support agent $1 a day.
  for (let k = 0; k <= 22; k++) {
    const atMs = NOW - k * DAY;
    row({ atMs, workflow_id: wfMine, user_id: member.id, project_id: mineProject, cost: 2 });
    row({ atMs, workflow_id: wfTheirs, user_id: other.id, project_id: theirs, cost: 5 });
    row({ atMs, agent_id: readableAgent.id, session_id: `s_${k}`, user_id: owner.id, project_id: mineProject, cost: 1 });
  }
  saveAiCaps({
    credentials: { cred_x: { name: 'Shared key', monthCost: 3000 } },
    users: { [member.id]: { name: 'Mia', monthCost: 60, dayCost: 3 }, [other.id]: { name: 'Omar', monthCost: 1000 } },
  });
  aiUsageMeter().invalidateCaps();
  saveBudget({ projectId: mineProject, monthlyUsd: 90, warnPercent: 80, hardStop: false });
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('the forecast report', () => {
  const today = dayOf(NOW);
  const monthEnd = monthEndOf(today);
  // What the test's own method says for Mia's rows: $2 a day from Oct 25 to today.
  const mias = forecastMonth(Object.fromEntries(Array.from({ length: 23 }, (_, k) => [dayOf(NOW - k * DAY), 2])), today, monthEnd);

  it('sums what the viewer can see and forecasts it like the method does', () => {
    const report = aiForecast(member, NOW);
    expect(report.month).toBe(today.slice(0, 7));
    // Mia sees her workflow's rows, the readable agent's and her own; never Omar's Beta workflow.
    const visible = Object.fromEntries(Array.from({ length: 23 }, (_, k) => [dayOf(NOW - k * DAY), 3]));
    expect(report.total).toEqual(forecastMonth(visible, today, monthEnd));
    const everything = aiForecast(owner, NOW).total;
    expect(everything).toEqual(forecastMonth(Object.fromEntries(Array.from({ length: 23 }, (_, k) => [dayOf(NOW - k * DAY), 8])), today, monthEnd));
  });

  it("forecasts a member's own caps and the budget of their project, never another person's cap", () => {
    const report = aiForecast(member, NOW);
    const n = Number(today.slice(8));
    const ids = report.caps.map((c) => c.capId);
    expect(ids).toContain(`user:${member.id}:month:cost`);
    expect(ids).toContain(`user:${member.id}:day:cost`);
    expect(ids).toContain(`agent:${readableAgent.id}:month:cost`);
    expect(ids).toContain(`project:${mineProject}:month:cost`);
    expect(ids).not.toContain(`user:${other.id}:month:cost`);
    expect(ids).not.toContain(`agent:${hiddenAgent.id}:month:cost`);
    expect(ids).not.toContain('credential:cred_x:month:cost');
    expect(JSON.stringify(report)).not.toContain('Omar');
    expect(JSON.stringify(report)).not.toContain('Secret desk');
    const own = report.caps.find((c) => c.capId === `user:${member.id}:month:cost`)!;
    expect(own.forecast).toEqual(mias);
    expect(own.max).toBe(60);
    // Month to date is $2 a day for n days; $60 is reached after the days that take it from there, at $2 a day.
    expect(own.reachesOn).toBe(addDays(today, 30 - n));
    const budget = report.caps.find((c) => c.capId === `project:${mineProject}:month:cost`)!;
    // Alpha takes $3 a day (Mia's $2 and the agent's $1): $90 is the month's 30th day's worth.
    expect(budget.forecast?.monthToDate).toBe(3 * n);
    expect(budget.reachesOn).toBe(addDays(today, 30 - n));
    const agent = report.caps.find((c) => c.capId === `agent:${readableAgent.id}:month:cost`)!;
    expect(agent.forecast?.p50).toBe(30);
    expect(agent.reachesOn).toBeUndefined();
  });

  it("gives a daily cap today's pace, not a forecast", () => {
    const day = aiForecast(member, NOW).caps.find((c) => c.capId === `user:${member.id}:day:cost`)!;
    expect(day.forecast).toBeUndefined();
    expect(day.reachesOn).toBeUndefined();
    expect(day.pace).toBeCloseTo(paceToday(day.used, day.pace !== undefined && day.used > 0 ? (day.used * 24) / day.pace : 1), 6);
  });

  it('shows an owner every cap, a credential cap included', () => {
    const ids = aiForecast(owner, NOW).caps.map((c) => c.capId);
    for (const id of [`user:${member.id}:month:cost`, `user:${other.id}:month:cost`, `agent:${hiddenAgent.id}:month:cost`, 'credential:cred_x:month:cost']) expect(ids).toContain(id);
    // A credential's cap forecasts from its own rows: none, so zero.
    expect(aiForecast(owner, NOW).caps.find((c) => c.capId === 'credential:cred_x:month:cost')?.forecast?.p50).toBe(0);
  });

  it('answers through the route as the caller', async () => {
    const body = await as(member, async () => (await forecastRoute.GET(new Request('http://x.test/api/insights/ai/forecast'), { params: Promise.resolve({}) } as never)).json());
    expect(body.caps.map((c: { capId: string }) => c.capId)).not.toContain(`user:${other.id}:month:cost`);
    expect(body.total.daysLeft).toBeGreaterThanOrEqual(0);
  });
});

describe('the cache card\'s reasons line', () => {
  it('says "Not cached", not "Misses", for an agent with a reason but no miss call', () => {
    expect(missesLead({ missCalls: 0, missRuns: 0, runs: 4 })).toBe('Not cached');
    expect(missesLead({ missCalls: 2, missRuns: 0, runs: 4 })).toBe('Misses');
    expect(missesLead({ missCalls: 2, missRuns: 1, runs: 1 })).toBe('Misses in 1 of 1 run');
    expect(missesLead({ missCalls: 5, missRuns: 2, runs: 9 })).toBe('Misses in 2 of 9 runs');
  });
});

describe('the cache card', () => {
  const t = (minutes: number) => NOW - minutes * 60_000;
  beforeAll(() => {
    // Support agent: one session writes the prefix, then reads it; a second call writes again after 20 minutes (a miss).
    const calls = [
      { atMs: t(60), input_tokens: 10_000, cache_write_tokens: 8000, cache_read_tokens: 0 },
      { atMs: t(55), input_tokens: 10_000, cache_write_tokens: 0, cache_read_tokens: 8000 },
      { atMs: t(30), input_tokens: 10_000, cache_write_tokens: 8000, cache_read_tokens: 0 },
    ];
    calls.forEach((c, i) => {
      const id = `au_fc_cache_${i}`;
      row({ ...c, id, agent_id: readableAgent.id, session_id: 'cache_s1', workflow_id: wfMine, user_id: member.id, purpose: 'answer' });
      database().insertNew('ai_call_parts', { id: `acp_${id}`, usage_id: id, gateway_request_id: null, at: new Date(c.atMs).toISOString(), source: 'landflow', method: 'estimate', input_tokens: 9000, parts: JSON.stringify({ toolDefinitions: 1500, instructions: 3000, history: 4500 }), prefix_hash: 'p', prompt_hash: null, part_hashes: JSON.stringify({ toolDefinitions: 'a', instructions: 'b' }), tool_names: null });
    });
    // The AI Agent node: Anthropic, an execution and a node, no session, no cache.
    row({ atMs: t(20), id: 'au_fc_node_1', execution_id: 'ex_fc_1', node_id: 'n1', workflow_id: wfMine, user_id: member.id, input_tokens: 4000 });
    row({ atMs: t(19), id: 'au_fc_node_2', execution_id: 'ex_fc_1', node_id: 'n1', workflow_id: wfMine, user_id: member.id, input_tokens: 6000 });
    // Another person's call in a workflow Mia cannot read.
    row({ atMs: t(10), id: 'au_fc_theirs', execution_id: 'ex_fc_2', node_id: 'n2', workflow_id: wfTheirs, user_id: other.id, input_tokens: 99_000 });
    // A local model reports no cache and is not counted.
    row({ atMs: t(5), id: 'au_fc_local', provider: 'ollama', model: 'qwen3-coder:30b', workflow_id: wfMine, user_id: member.id, input_tokens: 777, cost: 0 });
  });

  it("equals the Run Trace's cacheLine over the same calls", () => {
    const report = aiCacheReport(member, '24h', NOW);
    const found = database().all<Parameters<typeof callOf>[0]>("SELECT * FROM ai_usage WHERE (workflow_id = ? OR user_id = ? OR agent_id = ?) AND at >= ? AND (provider IN ('anthropic','openai') OR cache_read_tokens + cache_write_tokens > 0)", wfMine, member.id, readableAgent.id, new Date(NOW - DAY).toISOString());
    const overrides = priceOverrides();
    const price = (c: { provider: string; model: string }) => findPrice(c.provider, c.model, overrides);
    const parts = partsOf(found);
    // Each call is grouped by its own run: its session, else its execution, else itself.
    const expected = cacheLine(found.map((r) => ({ ...callOf(r, price, parts.has(r.id), true), sessionId: r.session_id ?? r.execution_id ?? r.id })), parts, price);
    expect(report.cache).toEqual(expected);
    expect(report.cache.hitRate).toBeGreaterThan(0);
    expect(report.cache.missCalls).toBe(1);
    expect(report.cache.missReasons).toContain('expired');
    expect(report.cache.savedUsd).toBeGreaterThan(0);
  });

  it('counts a run once however many misses it had, and says how many runs broke the cache', () => {
    const report = aiCacheReport(member, '24h', NOW);
    // The session has one miss; the node's execution counts as a run with no miss.
    const support = report.agents.find((a) => a.key === readableAgent.id)!;
    expect(support.missCalls).toBe(1);
    expect(support.missRuns).toBe(1);
    expect(support.runs).toBe(3); // the session, and the two seeded days' one-call runs
    expect(report.missRuns).toBeLessThanOrEqual(report.runs);
    expect(report.missRuns).toBe(1);
    // A second miss in the same session still counts one run.
    row({ atMs: t(2), id: 'au_fc_cache_x1', agent_id: readableAgent.id, session_id: 'cache_s1', workflow_id: wfMine, user_id: member.id, purpose: 'answer', input_tokens: 10_000, cache_write_tokens: 8000 });
    const again = aiCacheReport(member, '24h', NOW);
    expect(again.cache.missCalls).toBe(2);
    expect(again.missRuns).toBe(1);
    expect(again.agents.find((a) => a.key === readableAgent.id)!.missRuns).toBe(1);
    database().delete('ai_usage', { id: 'au_fc_cache_x1' });
  });

  it('does not chain independent session-less runs of one model into false misses', () => {
    // Two healthy gateway sessions (write, then read), each its own run, hours apart; and two agents' runs that interleave.
    const gw = (id: string, atMs: number, agent: string, execution: string, write: number, read: number, hash: string) => {
      row({ atMs, id, agent_id: agent, execution_id: execution, workflow_id: wfMine, user_id: member.id, input_tokens: 10_000, cache_write_tokens: write, cache_read_tokens: read, purpose: 'answer' });
      database().insertNew('ai_call_parts', { id: `acp_${id}`, usage_id: id, gateway_request_id: null, at: new Date(atMs).toISOString(), source: 'landflow', method: 'estimate', input_tokens: 9000, parts: JSON.stringify({ toolDefinitions: 1500, instructions: 3000, history: 4500 }), prefix_hash: 'p', prompt_hash: null, part_hashes: JSON.stringify({ toolDefinitions: 'a', instructions: hash }), tool_names: null });
    };
    const a = agentStore.create({ name: 'Run agent A' });
    const b = agentStore.create({ name: 'Run agent B' });
    projects.setHomeProject('agent', a.id, mineProject);
    projects.setHomeProject('agent', b.id, mineProject);
    gw('au_fc_rk_a1', t(400), a.id, 'ex_rk_a', 8000, 0, 'ha');
    gw('au_fc_rk_a2', t(399), a.id, 'ex_rk_a', 0, 8000, 'ha');
    gw('au_fc_rk_b1', t(300), b.id, 'ex_rk_b', 8000, 0, 'hb');
    gw('au_fc_rk_b2', t(299), b.id, 'ex_rk_b', 0, 8000, 'hb');
    gw('au_fc_rk_a3', t(200), a.id, 'ex_rk_c', 8000, 0, 'ha');
    gw('au_fc_rk_a4', t(199), a.id, 'ex_rk_c', 0, 8000, 'ha');
    const report = aiCacheReport(member, '24h', NOW);
    const forA = report.agents.find((x) => x.key === a.id);
    expect(forA?.missCalls ?? 0).toBe(0);
    expect(report.agents.find((x) => x.key === b.id)?.missCalls ?? 0).toBe(0);
    // Only the seeded session's one miss remains; no reason made up by chaining other runs.
    expect(report.cache.missCalls).toBe(1);
    expect(report.cache.missReasons).toContain('expired');
    expect(report.cache.missReasons).not.toContain('instructions-changed');
    expect(report.missRuns).toBe(1);
  });

  it('counts a call with no session and no execution as no run, and finds no miss in a write then a read', () => {
    const before = aiCacheReport(owner, '24h', NOW);
    // Two gateway rows, same model, no session and no execution: a write, then a read.
    row({ atMs: t(3), id: 'au_fc_gw_1', user_id: owner.id, input_tokens: 10_000, cache_write_tokens: 8000 });
    row({ atMs: t(2), id: 'au_fc_gw_2', user_id: owner.id, input_tokens: 10_000, cache_read_tokens: 8000 });
    try {
      const after = aiCacheReport(owner, '24h', NOW);
      expect(after.cache.missCalls).toBe(before.cache.missCalls);
      expect(after.runs).toBe(before.runs);
      expect(after.missRuns).toBe(before.missRuns);
      expect(after.cache.readTokens).toBe(before.cache.readTokens + 8000);
    } finally {
      database().delete('ai_usage', { id: 'au_fc_gw_1' });
      database().delete('ai_usage', { id: 'au_fc_gw_2' });
    }
  });

  it('lists the agents by uncached input with their miss reasons, and counts the AI Agent node', () => {
    const report = aiCacheReport(member, '24h', NOW);
    const support = report.agents.find((a) => a.key === readableAgent.id)!;
    expect(support.label).toBe('Support agent');
    // 2,000 each from the three calls (input minus reads and writes), and 100 each from the two seeded days inside the 24 hours.
    expect(support.uncachedTokens).toBe(6_200);
    expect(support.missReasons).toEqual(['expired']);
    expect(report.agents.length).toBeLessThanOrEqual(5);
    expect(report.agentNode).toEqual({ calls: 2, uncachedTokens: 10_000 });
    expect(report.reasonsPartial).toBe(false);
  });

  it("leaves out calls the viewer can't see, and never carries prompt text", async () => {
    const report = aiCacheReport(member, '24h', NOW);
    expect(JSON.stringify(report)).not.toContain('99000');
    expect(aiCacheReport(owner, '24h', NOW).agentNode.calls).toBe(3);
    const body = await as(member, async () => (await cacheRoute.GET(new Request('http://x.test/api/insights/ai/cache?period=24h'), { params: Promise.resolve({}) } as never)).json());
    expect(body.agentNode.calls).toBe(2);
  });

  it('says miss reasons are partial for a period reaching past 30 days of splits', () => {
    expect(aiCacheReport(owner, '30d', NOW).reasonsPartial).toBe(false);
    expect(aiCacheReport(owner, '90d', NOW).reasonsPartial).toBe(true);
  });

  it("follows the AI page's 90 days and custom ranges, and answers 400 for a bad custom one", async () => {
    // Integration of SP08 (90 days and custom ranges on the AI page) with SP11's card.
    expect(aiCacheReport(owner, '90d', NOW).agentNode.calls).toBe(3);
    const today = dayOf(NOW);
    const todayOnly = aiCacheReport(owner, 'custom', NOW, { from: today, to: today });
    expect(todayOnly.period).toBe('custom');
    expect(todayOnly.agentNode.calls).toBe(3);
    const before = aiCacheReport(owner, 'custom', NOW, { from: '2025-01-01', to: '2025-01-31' });
    expect(before.runs).toBe(0);
    expect(before.agentNode.calls).toBe(0);
    const get = (query: string) => as(member, () => cacheRoute.GET(new Request(`http://x.test/api/insights/ai/cache?${query}`), { params: Promise.resolve({}) } as never));
    expect((await get(`period=custom&from=${today}&to=${today}`)).status).toBe(200);
    expect((await get('period=custom')).status).toBe(400);
    expect((await get('period=custom&from=2020-01-01&to=2026-01-01')).status).toBe(400);
  });

  it("narrows by the page's filters with the report's rules, as the card over only those rows", async () => {
    const overrides = priceOverrides();
    const price = (c: { provider: string; model: string }) => findPrice(c.provider, c.model, overrides);
    const found = database().all<Parameters<typeof callOf>[0]>("SELECT * FROM ai_usage WHERE agent_id = ? AND at >= ? AND (provider IN ('anthropic','openai') OR cache_read_tokens + cache_write_tokens > 0)", readableAgent.id, new Date(NOW - DAY).toISOString());
    const parts = partsOf(found);
    const expected = cacheLine(found.map((r) => ({ ...callOf(r, price, parts.has(r.id), true), sessionId: r.session_id ?? r.execution_id ?? r.id })), parts, price);
    const filtered = aiCacheReport(owner, '24h', NOW, {}, { agentId: readableAgent.id });
    expect(filtered.cache).toEqual(expected);
    expect(filtered.cache.missCalls).toBe(1);
    // The AI Agent node's calls have no agent: filtered out, not shown from the unfiltered period.
    expect(filtered.agentNode.calls).toBe(0);
    expect(aiCacheReport(owner, '24h', NOW).agentNode.calls).toBe(3);
    // The project filter resolves a row with no project to its home project, as the report does.
    expect(aiCacheReport(owner, '24h', NOW, {}, { projectId: mineProject }).agentNode.calls).toBe(2);
    // `provider/model`, `none` and the empty filter read as they do in the report.
    expect(aiCacheReport(owner, '24h', NOW, {}, { model: 'anthropic/claude-sonnet-5-5' }).agentNode.calls).toBe(3);
    expect(aiCacheReport(owner, '24h', NOW, {}, { model: 'ollama/qwen3-coder:30b' }).agentNode.calls).toBe(0);
    expect(aiCacheReport(owner, '24h', NOW, {}, { surface: 'none' }).agentNode.calls).toBe(3);
    expect(aiCacheReport(owner, '24h', NOW, {}, { purpose: 'answer' }).cache.missCalls).toBe(1);
    expect(aiCacheReport(owner, '24h', NOW, {}, { userId: other.id }).agentNode.calls).toBe(1);
    const get = (query: string) => as(member, () => cacheRoute.GET(new Request(`http://x.test/api/insights/ai/cache?${query}`), { params: Promise.resolve({}) } as never));
    const viaRoute = await (await get(`period=24h&workflowId=${wfMine}`)).json();
    expect(viaRoute.agentNode.calls).toBe(2);
    // An id the viewer can't read is a 404 as in the report, and an unknown filter value is no confirmation either.
    expect((await get(`period=24h&workflowId=${wfTheirs}`)).status).toBe(404);
    expect((await get(`period=24h&agentId=${hiddenAgent.id}`)).status).toBe(404);
    expect((await get('period=24h&purpose=nonsense')).status).toBe(400);
  });
});
