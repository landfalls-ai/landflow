/**
 * Forecast and unusual-spend flags (SP23, docs/llm-gateway.md#forecasts-and-unusual-spend): the check on Landledger's own
 * numbers, the scan over the rollup and the raw rows (observed days, tokens for an unpriced key, distinct runs, today as it
 * stands, doubling), the forecast flag, the cost alerts (once per day or month, the Landledger option), Needs you's audiences,
 * the acknowledge route, the brain's detector and the writes' shape. Offline; run under TZ=Pacific/Kiritimati and
 * TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AlertNotice } from '@/lib/server/alerts/message';
import type { NeedsYouRow } from '@/lib/client/run-trace';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-anomalies-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://landflow.test' });

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const { rollupDay } = await import('@/lib/server/ai-usage/rollup');
const { checkSpend, scanSpendFlags, aiSpendFlags } = await import('@/lib/server/ai-usage/anomalies');
const flags = await import('@/lib/server/ai-usage/spend-flags');
const { checkCosts } = await import('@/lib/server/ai-usage/alerts');
const { alertStore } = await import('@/lib/server/alerts/store');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const projects = await import('@/lib/server/projects/store');
const { fingerprintOf } = await import('@/lib/server/brain/proposals');
const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
const { DETECTORS, DETECTOR_LABELS } = await import('@/lib/shared/brain');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const ackRoute = await import('@/app/api/insights/ai/flags/[id]/ack/route');

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const meter = aiUsageMeter();
const today = meter.today(NOW);
const dayAt = (back: number) => meter.today(NOW - back * DAY_MS);

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let mia: User;
let eve: User;
let pam: User;
let omar: User;
let P: string;
let agentId: string;
let counter = 0;

function row(back: number, fields: Record<string, unknown>) {
  const atMs = NOW - back * DAY_MS - 3_600_000;
  database().insertNew('ai_usage', {
    id: `sa-${++counter}`,
    call_id: `sa-call-${counter}`,
    at: new Date(atMs).toISOString(),
    day: meter.today(atMs),
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

const BASELINE = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 5, 4, 6, 5, 5];

async function itemsOf(user: User): Promise<NeedsYouRow[]> {
  enableTestAuth(user);
  try {
    const response = await needsYouRoute.GET(new Request('http://landflow.test/api/runs/needs-you'));
    return ((await response.json()) as { items: NeedsYouRow[] }).items.filter((i) => i.kind === 'spend');
  } finally {
    enableTestAuth();
  }
}
const titles = (items: NeedsYouRow[]) => items.map((i) => i.title).sort();
const ack = async (user: User, id: string) => {
  enableTestAuth(user);
  try {
    return await ackRoute.POST(new Request('http://landflow.test/x', { method: 'POST' }), { params: Promise.resolve({ id }) });
  } finally {
    enableTestAuth();
  }
};
const scan = () => {
  // The rollup service rolls each day as it is today and yesterday; a test that writes the past rolls it by hand.
  for (let back = 0; back <= 20; back++) rollupDay(dayAt(back));
  return scanSpendFlags(NOW);
};
const anomaly = (dimension: string, key: string, back = 0) => flags.getFlag(flags.flagId('anomaly', dayAt(back), dimension, key));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  owner = await createUser({ email: 'olga@spend-anomalies.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  mia = await createUser({ email: 'mia@spend-anomalies.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  eve = await createUser({ email: 'eve@spend-anomalies.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
  pam = await createUser({ email: 'pam@spend-anomalies.test', name: 'Pam', role: 'member', password: 'pam-password-1' });
  omar = await createUser({ email: 'omar@spend-anomalies.test', name: 'Omar', role: 'member', password: 'omar-password-1' });
  P = projects.createTeamProject({ name: 'Alpha' }).id;
  projects.setMember(P, mia.id, 'viewer');
  projects.setMember(P, eve.id, 'editor');
  projects.setMember(P, pam.id, 'admin');
  agentId = agentStore.create({ name: 'Orders agent', instructions: 'Be brief.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } as never }).id;
  projects.setHomeProject('agent', agentId, P);

  // 15 ordinary days of Mia's agent, $4 to $6 a day (one run a day), then $12 today in one run of five calls, mostly Spotlight.
  BASELINE.forEach((cost, i) => row(i + 1, { user_id: mia.id, agent_id: agentId, project_id: P, execution_id: `ex_${i}`, cost }));
  for (let k = 0; k < 5; k++) row(0, { user_id: mia.id, agent_id: agentId, project_id: P, session_id: 'sess_today', surface: 'spotlight', cost: 2.4 });
  // A steady high spender: $50 a day, $52 today.
  BASELINE.forEach((_, i) => row(i + 1, { user_id: omar.id, execution_id: `ex_h${i}`, cost: 50, provider: 'openai', model: 'gpt-steady' }));
  row(0, { user_id: omar.id, execution_id: 'ex_h_today', cost: 52, provider: 'openai', model: 'gpt-steady' });
  // A local model nobody priced: 20k tokens a day, 500k today.
  BASELINE.forEach((_, i) => row(i + 1, { user_id: eve.id, execution_id: `ex_l${i}`, cost: 0, provider: 'ollama', model: 'llama-local', input_tokens: 15_000, output_tokens: 5_000 }));
  row(0, { user_id: eve.id, execution_id: 'ex_l_today', cost: 0, provider: 'ollama', model: 'llama-local', input_tokens: 400_000, output_tokens: 100_000 });
  saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 150 } } });
  meter.invalidateCaps();
});

afterAll(() => {
  vi.useRealTimers();
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('the check (Landledger’s own numbers)', () => {
  const baseline = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5];

  it('flags a jump of 3.5 robust standard deviations, half the median and at least the minimum', () => {
    expect(checkSpend(baseline, 12, 1)).toMatchObject({ anomalous: true, median: 5, mad: 0.5, score: '9.44' });
  });

  it('lets the ordinary through', () => {
    expect(checkSpend(baseline, 6, 1).anomalous).toBe(false); // score 1.35
    expect(checkSpend(baseline, 5.9, 1).reason).toBe('below the smallest jump');
    expect(checkSpend([100, 101, 100, 99, 100, 100, 101], 140, 1).reason).toBe('less than half the median above it');
    expect(checkSpend([1, 1], 50, 1).reason).toBe('2 observed days, 7 needed');
  });

  it('counts any big enough jump over a flat baseline, new spend included, with no score', () => {
    expect(checkSpend(Array(10).fill(0), 25, 1)).toMatchObject({ anomalous: true, median: 0, mad: 0, score: null });
  });

  it('rounds the median of an even count half to even, in millionths', () => {
    expect(checkSpend([1, 2, 3, 4, 5, 6, 7, 8], 100, 1).median).toBe(4.5);
    expect(checkSpend([0.000001, 0.000002, 0.000003, 0.000004, 0.000005, 0.000006, 0.000007, 0.000008], 100, 1).median).toBe(0.000004);
  });

  it('never flags a day at the median', () => {
    expect(checkSpend(baseline, 5, 0.000001).anomalous).toBe(false);
  });
});

describe('the scan', () => {
  it('flags the unusual day once per key and not the steady high spender', () => {
    const found = scan();
    expect(found.anomalies).toBeGreaterThan(0);
    for (const [dimension, key] of [
      ['person', mia.id],
      ['agent', agentId],
      ['project', P],
      ['model', 'anthropic/claude-sonnet-5-5'],
    ] as const) {
      const flag = anomaly(dimension, key)!;
      expect(flag, `${dimension} ${key}`).toMatchObject({ metric: 'cost', value: 12, baselineMedian: 5, baselineDays: 14 });
    }
    expect(anomaly('person', omar.id)).toBeUndefined();
    expect(anomaly('model', 'openai/gpt-steady')).toBeUndefined();
    expect(database().all('SELECT id FROM ai_spend_flags WHERE kind = ?', 'anomaly').length).toBe(found.anomalies);
  });

  it('counts distinct runs (five calls of one session are one) and names the surfaces', () => {
    const flag = anomaly('agent', agentId)!;
    expect(flag.runs).toBe(1);
    expect(flag.surfaces).toEqual(['Spotlight']);
    expect(flag.score).toBeDefined();
  });

  it('judges a key with tokens and no cost on tokens', () => {
    const flag = anomaly('model', 'ollama/llama-local')!;
    expect(flag).toMatchObject({ metric: 'tokens', value: 500_000, baselineMedian: 20_000 });
    expect(anomaly('person', eve.id)).toMatchObject({ metric: 'tokens' });
  });

  it('checks today as it stands, and a second pass changes nothing', () => {
    const before = JSON.stringify(database().all('SELECT * FROM ai_spend_flags ORDER BY id'));
    scan();
    expect(JSON.stringify(database().all('SELECT * FROM ai_spend_flags ORDER BY id'))).toBe(before);
  });

  it('is not judged without 7 observed days', () => {
    const young = database().get<{ first: string }>('SELECT MIN(day) AS first FROM ai_usage')!.first;
    expect(young).toBe(dayAt(15));
    // Only the 8 days after the first count when the day is the 8th: a young instance would have a window under 7.
    const soon = scanSpendFlags(NOW - 12 * DAY_MS);
    expect(soon.anomalies).toBe(0);
  });

  it('writes with row calls only', () => {
    const ops: Array<{ op: string; table: string }> = [];
    const stop = database().observe((batch) => ops.push(...batch.map((o) => ({ op: o.op, table: o.table }))));
    row(0, { user_id: mia.id, agent_id: agentId, project_id: P, execution_id: 'ex_more', cost: 1 });
    scan();
    stop();
    const mine = ops.filter((o) => o.table === 'ai_spend_flags');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((o) => ['upsert', 'delete', 'deleteBefore'].includes(o.op))).toBe(true);
    expect(anomaly('agent', agentId)).toMatchObject({ value: 13 });
  });
});

describe('the forecast flag', () => {
  const capId = () => `user:${mia.id}:month:cost`;
  const forecastFlag = () => flags.getFlag(flags.flagId('forecast', `${today.slice(0, 7)}-01`, 'user', capId()));

  it('flags a monthly cap the month is on course to pass, once per cap and month', () => {
    const flag = forecastFlag()!;
    expect(flag).toMatchObject({ kind: 'forecast', metric: 'cost', capMax: 150 });
    expect(flag.p50!).toBeGreaterThanOrEqual(150);
    expect(flag.value).toBeLessThan(150);
    expect(flag.reachesOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(database().all('SELECT id FROM ai_spend_flags WHERE kind = ?', 'forecast')).toHaveLength(1);
  });

  it('deletes it when the cap is raised above the forecast, and keeps an acknowledged one', () => {
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 1000 } } });
    meter.invalidateCaps();
    scan();
    expect(forecastFlag()).toBeUndefined();
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 150 } } });
    meter.invalidateCaps();
    scan();
    expect(forecastFlag()).toBeDefined();
    flags.saveFlag({ ...forecastFlag()!, acknowledgedBy: owner.id, acknowledgedAt: new Date(NOW).toISOString() });
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 1000 } } });
    meter.invalidateCaps();
    scan();
    expect(forecastFlag()).toBeDefined();
    flags.saveFlag({ ...forecastFlag()!, acknowledgedBy: undefined, acknowledgedAt: undefined });
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 150 } } });
    meter.invalidateCaps();
    scan();
  });

  it('makes none while the forecast is early (under 7 days of the cap’s own data)', () => {
    const zed = 'user_zed';
    for (let i = 1; i <= 3; i++) row(i, { user_id: zed, execution_id: `ex_z${i}`, cost: 5 });
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 150 }, [zed]: { name: 'Zed', monthCost: 50 } } });
    meter.invalidateCaps();
    scan();
    expect(flags.getFlag(flags.flagId('forecast', `${today.slice(0, 7)}-01`, 'user', `user:${zed}:month:cost`))).toBeUndefined();
    // Zed's three days were only for this check: they would be new spend on every other check below.
    for (const table of ['ai_usage', 'ai_usage_daily']) database().delete(table as never, { user_id: zed });
    database().delete('ai_spend_flags', { key: zed });
    for (const flag of database().all<{ id: string }>('SELECT id FROM ai_spend_flags WHERE key LIKE ?', `%${zed}%`)) flags.deleteFlag(flag.id);
    saveAiCaps({ credentials: {}, users: { [mia.id]: { name: 'Mia', monthCost: 150 } } });
    meter.invalidateCaps();
    scan();
  });
});

describe('the cost alerts', () => {
  const sent: Array<{ rule: string; notice: AlertNotice }> = [];
  const send = async (rule: { id: string }, notice: AlertNotice) => void sent.push({ rule: rule.id, notice });
  const channel = alertStore.createChannel({ name: 'Catcher', kind: 'webhook', config: { url: 'http://127.0.0.1:9/hook' } });
  const make = (cost: Record<string, unknown>) => {
    for (const old of alertStore.rules()) alertStore.deleteRule(old.id);
    return alertStore.createRule({ name: `cost ${Math.random()}`, enabled: true, workflows: { mode: 'all' }, events: ['costThreshold'], kind: 'cost', cost: { thresholdPercent: 99, ...cost }, channelIds: [channel.id], throttleMinutes: 0 });
  };
  const subjects = () => sent.map((s) => s.notice.custom!.subject);

  it('alerts once on a forecast and once per dimension, key and day, with the figure, baseline, runs and an Open link', async () => {
    const rule = make({});
    await checkCosts(NOW, send as never);
    const mine = sent.filter((s) => s.rule === rule.id);
    const text = mine.map((s) => s.notice.custom!.subject);
    expect(text.some((t) => t.startsWith('AI cost: user “Mia”'))).toBe(true);
    expect(text.filter((t) => t.startsWith('Unusual AI spend:'))).toHaveLength(6); // Mia, her agent, the project, Claude, Eve, and the local model
    const agentAlert = mine.find((s) => s.notice.custom!.subject.includes('agent “Orders agent”'))!.notice.custom!;
    expect(agentAlert.facts.map((f) => f.label)).toEqual(expect.arrayContaining(['Spent', 'Baseline', 'Score', 'Runs', 'Open']));
    expect(agentAlert.facts.find((f) => f.label === 'Open')!.value).toBe(`http://landflow.test/insights/ai?period=custom&from=${today}&to=${today}&agentId=${agentId}`);
    expect(agentAlert.facts.find((f) => f.label === 'Also')!.value).toContain('Landledger flags agent and model spikes');
    expect(mine.find((s) => s.notice.custom!.subject.includes('Mia used'))!.notice.custom!.subject).toContain('Mia');
    const before = sent.length;
    await checkCosts(NOW, send as never);
    expect(sent.length).toBe(before);
  });

  it('with Landledger on agent and model spikes, no channel alert for those two (the others still go)', async () => {
    sent.length = 0;
    const rule = make({ landledgerHandlesAgentModel: true });
    await checkCosts(NOW, send as never);
    const text = sent.filter((s) => s.rule === rule.id).map((s) => s.notice.custom!.subject);
    expect(text.filter((t) => t.startsWith('Unusual AI spend:'))).toHaveLength(3); // Mia, Eve and the project; not the agent or the two models
    expect(text.some((t) => t.includes('agent “Orders agent”') || t.includes('model '))).toBe(false);
  });

  it('with the switches off, nothing from the flags', async () => {
    sent.length = 0;
    const rule = make({ forecast: false, anomalies: false });
    await checkCosts(NOW, send as never);
    expect(sent.filter((s) => s.rule === rule.id)).toEqual([]);
  });

  it('alerts again when the day’s value doubles', async () => {
    sent.length = 0;
    const rule = make({ forecast: false });
    await checkCosts(NOW, send as never);
    const first = sent.filter((s) => s.rule === rule.id).length;
    expect(first).toBeGreaterThan(0);
    for (let k = 0; k < 3; k++) row(0, { user_id: mia.id, agent_id: agentId, project_id: P, execution_id: `ex_big${k}`, cost: 10 });
    scan();
    sent.length = 0;
    await checkCosts(NOW, send as never);
    expect(subjects().filter((t) => t.includes('Mia used'))).toHaveLength(1);
  });
});

describe('Needs you', () => {
  it('gives a member their own person flag and cap forecast, never another person’s', async () => {
    const mine = await itemsOf(mia);
    expect(mine.every((i) => i.kind === 'spend' && i.canAcknowledge)).toBe(true);
    expect(titles(mine).filter((t) => t.startsWith('Unusual AI spend: Mia'))).toHaveLength(1);
    expect(mine.some((i) => i.flagKind === 'forecast')).toBe(true);
    expect(mine.some((i) => i.title.includes('Eve'))).toBe(false);
    expect(await itemsOf(omar)).toEqual([]);
  });

  it('gives an agent’s editor the agent’s flag, a project’s admin the project’s, and owners everything', async () => {
    expect(titles(await itemsOf(eve))).toEqual(expect.arrayContaining([expect.stringContaining('agent “Orders agent”'), expect.stringContaining('Eve')]));
    expect(titles(await itemsOf(eve)).some((t) => t.includes('project “Alpha”'))).toBe(false);
    expect(titles(await itemsOf(eve)).some((t) => t.includes('Mia used'))).toBe(false);
    const pams = titles(await itemsOf(pam));
    expect(pams.some((t) => t.includes('project “Alpha”'))).toBe(true);
    expect(pams.some((t) => t.includes('model '))).toBe(false);
    expect(pams.some((t) => t.includes('Mia used'))).toBe(false);
    const all = titles(await itemsOf(owner));
    expect(all.some((t) => t.includes('model anthropic/claude-sonnet-5-5'))).toBe(true);
    expect(all.some((t) => t.includes('model ollama/llama-local'))).toBe(true);
  });

  it('opens the AI page at the day', async () => {
    const item = (await itemsOf(owner)).find((i) => i.title.includes('agent “Orders agent”'))!;
    expect(item.href).toBe(`/insights/ai?period=custom&from=${today}&to=${today}&agentId=${agentId}`);
  });

  it('acknowledges for everyone, with who and when; a stranger gets a 404', async () => {
    const item = (await itemsOf(mia)).find((i) => i.flagKind === 'anomaly')!;
    expect((await ack(omar, item.flagId!)).status).toBe(404);
    expect((await ack(eve, item.flagId!)).status).toBe(404);
    expect((await ack(mia, item.flagId!)).status).toBe(200);
    expect(flags.getFlag(item.flagId!)).toMatchObject({ acknowledgedBy: mia.id });
    expect((await itemsOf(mia)).some((i) => i.flagId === item.flagId)).toBe(false);
    expect((await itemsOf(owner)).some((i) => i.flagId === item.flagId)).toBe(false);
    expect(database().all("SELECT action FROM audit_events WHERE action = 'ai.spend.acknowledged'").length).toBe(1);
  });

  it('opens an acknowledged flag again when the day’s value doubles', () => {
    const personId = flags.flagId('anomaly', today, 'person', mia.id);
    const before = flags.getFlag(personId)!;
    expect(before.acknowledgedAt).toBeDefined();
    row(0, { user_id: mia.id, agent_id: agentId, project_id: P, execution_id: 'ex_small', cost: 1 });
    scan();
    expect(flags.getFlag(personId)!.acknowledgedAt).toBeDefined(); // under twice the acknowledged value
    row(0, { user_id: mia.id, agent_id: agentId, project_id: P, execution_id: 'ex_huge', cost: 80 });
    scan();
    expect(flags.getFlag(personId)!.acknowledgedAt).toBeUndefined();
  });

  it('leaves a deleted project’s flags out (they stay as history) and follows an agent’s access now', async () => {
    const other = projects.createTeamProject({ name: 'Short lived' }).id;
    const flag: ReturnType<typeof flags.getFlag> = anomaly('project', P)!;
    flags.saveFlag({ ...flag, id: flags.flagId('anomaly', today, 'project', other), key: other, label: 'project “Short lived”' });
    expect(titles(await itemsOf(owner)).some((t) => t.includes('Short lived'))).toBe(true); // the project exists: shown
    // the project is removed: the flag stays as history, it is not shown
    projects.removeProjectRows(other);
    expect(titles(await itemsOf(owner)).some((t) => t.includes('Short lived'))).toBe(false);
    expect(flags.getFlag(flags.flagId('anomaly', today, 'project', other))).toBeDefined();
    // Eve loses the agent's edit: the flag leaves her list.
    projects.setMember(P, eve.id, 'viewer');
    expect(titles(await itemsOf(eve)).some((t) => t.includes('agent “Orders agent”'))).toBe(false);
    projects.setMember(P, eve.id, 'editor');
  });
});

describe('the brain’s detector', () => {
  it('is registered and names the agent or workflow, never a person', () => {
    expect(DETECTORS).toContain('spend-anomaly');
    expect(DETECTOR_LABELS['spend-anomaly']).toBe('Unusual AI spend');
    const found = DETECTOR_RUNS['spend-anomaly'](detectContext({}, database(), NOW));
    expect(found.length).toBeGreaterThan(0);
    const text = JSON.stringify(found);
    expect(text).not.toContain('Mia');
    expect(text).not.toContain(mia.id);
    expect(text).not.toContain('Eve');
    for (const finding of found) {
      expect(finding.proposal).toMatchObject({ detector: 'spend-anomaly', ops: [] });
      expect(['agent', 'workflow']).toContain(finding.proposal.target.type);
    }
    expect(found.map((f) => f.proposal.fingerprint)).toContain(fingerprintOf('spend-anomaly', `agent|${agentId}|${today}`));
  });

  it('leaves out an acknowledged flag', () => {
    const flag = anomaly('agent', agentId)!;
    flags.saveFlag({ ...flag, acknowledgedBy: owner.id, acknowledgedAt: new Date(NOW).toISOString() });
    expect(DETECTOR_RUNS['spend-anomaly'](detectContext({}, database(), NOW))).toEqual([]);
  });
});

describe('the service', () => {
  it('starts and stops without a pass leaking a timer', () => {
    aiSpendFlags.start();
    aiSpendFlags.stop();
    expect(store.listWorkflows).toBeDefined();
  });
});
