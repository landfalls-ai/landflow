/**
 * Join test (wave 13, plan-v2 "Join tests are the integrator's", `spend-report-join`): SP08's report ↔ SP09's lists.
 * Every row the AI page's report shows opens a drill sheet that lists the runs and calls behind it (`GET
 * /api/insights/ai/runs` and `…/calls`) with the report's period and filters. For every group key the report emits
 * (`none` and "Another …" included) and every filter a row can become (a `provider/model` model filter, `surface=none`
 * and `purpose=none` included), the calls listed plus the calls counted in `hidden` are the calls the report counts, and
 * the same for cost and runs. Days before yesterday come from the daily rollup (after a pass), the rest from the raw
 * rows; an owner and a member each see their own report. Offline; run under TZ=Pacific/Kiritimati and
 * TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AiPageReport, AiSpendCallsPage, AiSpendFilters, AiSpendGroup, AiSpendRow, AiSpendRunsPage } from '@/lib/shared/ai-spend';

vi.setConfig({ testTimeout: 120_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-report-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { credentials } = await import('@/lib/server/credentials/vault');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { markSpendDays, runRollup } = await import('@/lib/server/ai-usage/rollup');
const { FILTER_WORDS } = await import('@/lib/client/ai-console');
const reportRoute = await import('@/app/api/insights/ai/route');
const runsRoute = await import('@/app/api/insights/ai/runs/route');
const callsRoute = await import('@/app/api/insights/ai/calls/route');
registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
type Report = AiPageReport & { groups: Record<AiSpendGroup, AiSpendRow[]> };
const DAY_MS = 86_400_000;
let owner: User;
let mia: User;
let ben: User;
let counter = 0;

const as = async <T>(user: User, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

async function call<T>(route: { GET: unknown }, path: string, params: Record<string, string>): Promise<{ status: number; body: T }> {
  const response = await (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test${path}?${new URLSearchParams(params)}`));
  return { status: response.status, body: (await response.json()) as T };
}

/**
 * A raw row `back` days ago (an hour before now on that day, so 24h holds today's rows and not yesterday's). In the
 * instance's first hour an hour back is the day before, so the time walks forward to the start of the day meant: still
 * before now, and for `back` ≥ 1 still outside the last 24 hours.
 */
function row(back: number, fields: Record<string, unknown>) {
  const meter = aiUsageMeter();
  const day = meter.today(Date.now() - back * DAY_MS);
  let when = Date.now() - back * DAY_MS - (back === 0 ? 60_000 : 3_600_000);
  while (meter.today(when) !== day) when += 60_000;
  database().insertNew('ai_usage', {
    id: `rj-${++counter}`,
    call_id: `rj-call-${counter}`,
    at: new Date(when).toISOString(),
    day: aiUsageMeter().today(when),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100 + counter,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0.25 + counter / 100,
    ...fields,
  });
}

beforeAll(async () => {
  owner = await createUser({ email: 'ada@report-join.test', name: 'Ada', role: 'owner', password: 'ada-password-1' });
  mia = await createUser({ email: 'mia@report-join.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  ben = await createUser({ email: 'ben@report-join.test', name: 'Ben', role: 'member', password: 'ben-password-1' });
  const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  const beta = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(alpha, mia.id, 'editor');
  projects.setMember(beta, ben.id, 'editor');
  for (const [id, project] of [['wf_rj_alpha', alpha], ['wf_rj_beta', beta]] as const) {
    store.saveWorkflow({ id, name: id, nodes: [], connections: [] } as unknown as Workflow);
    projects.setHomeProject('workflow', id, project);
  }
  const agentA = agentStore.create({ name: 'Alpha desk' });
  const agentB = agentStore.create({ name: 'Beta desk' });
  projects.setHomeProject('agent', agentA.id, alpha);
  projects.setHomeProject('agent', agentB.id, beta);
  const credA = credentials.create({ name: 'Alpha key', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-a' } }).id;
  const credB = credentials.create({ name: 'Beta key', type: 'core.openAiApi', data: { apiKey: 'sk-b' } }).id;
  projects.setHomeProject('credential', credA, alpha);
  projects.setHomeProject('credential', credB, beta);

  // Today, yesterday (raw) and 4 days ago (the rollup): every group's keys, `none` and "Another …" included.
  for (const back of [0, 1, 4]) {
    const d = `d${back}`;
    row(back, { workflow_id: 'wf_rj_alpha', execution_id: `ex_a_${d}`, user_id: mia.id, credential_id: credA, project_id: alpha, purpose: 'answer' });
    row(back, { workflow_id: 'wf_rj_alpha', execution_id: `ex_a_${d}`, user_id: mia.id, credential_id: credA, project_id: alpha, purpose: 'judge', model: 'claude-haiku-4-5' });
    row(back, { user_id: mia.id, surface: 'spotlight', purpose: 'answer', session_id: `s_spot_${d}` });
    // Mia's own run of Beta's workflow on Beta's key: hers to see, "Another workflow" and "Another credential" to her.
    row(back, { workflow_id: 'wf_rj_beta', execution_id: `ex_mb_${d}`, user_id: mia.id, credential_id: credB, project_id: beta });
    row(back, { workflow_id: 'wf_rj_beta', execution_id: `ex_b_${d}`, user_id: ben.id, credential_id: credB, project_id: beta, provider: 'openai', model: 'gpt-5.1' });
    row(back, { agent_id: agentA.id, session_id: `s_agA_${d}` });
    row(back, { agent_id: agentB.id, session_id: `s_agB_${d}`, user_id: ben.id });
    row(back, { source: 'litellm', runtime: 'kagent', provider: 'litellm', model: 'claude-sonnet-5-5', agent_id: agentA.id, session_id: `s_kag_${d}` });
    row(back, { source: 'litellm', runtime: 'claude', provider: 'litellm', model: 'claude-sonnet-5-5' });
    row(back, { source: 'litellm', runtime: 'other', provider: 'litellm', model: 'qwen3-coder:30b', gateway_provider: 'ollama_chat', cost: 0 });
    row(back, { provider: 'ollama', model: 'qwen3-coder:30b', cost: 0, user_id: mia.id, execution_id: `ex_local_${d}`, workflow_id: 'wf_rj_alpha' });
    row(back, { goal_id: 'goal_gone', user_id: mia.id, surface: 'brain' });
    row(back, { user_id: ben.id, surface: 'architect', purpose: 'summary' });
  }
  // One run across days: the rollup's day and today.
  row(4, { workflow_id: 'wf_rj_alpha', execution_id: 'ex_long', user_id: mia.id, project_id: alpha });
  row(0, { workflow_id: 'wf_rj_alpha', execution_id: 'ex_long', user_id: mia.id, project_id: alpha });
  markSpendDays([aiUsageMeter().today(Date.now() - 4 * DAY_MS)]);
  runRollup();
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

async function report(user: User, period: string, filters: AiSpendFilters = {}): Promise<Report> {
  const { status, body } = await as(user, () => call<Report>(reportRoute, '/api/insights/ai', { period, ...(filters as Record<string, string>) }));
  expect(status, `report ${period} ${JSON.stringify(filters)}`).toBe(200);
  return body;
}

/** Every page of the runs and the calls behind one row. */
async function behind(user: User, query: Record<string, string>) {
  const calls: AiSpendCallsPage['calls'] = [];
  const runs: AiSpendRunsPage['runs'] = [];
  let callsHidden: AiSpendCallsPage['hidden'] | undefined;
  let runsHidden: AiSpendRunsPage['hidden'] | undefined;
  for (let cursor: string | undefined, first = true; first || cursor; first = false) {
    const page = await as(user, () => call<AiSpendCallsPage & { error?: string }>(callsRoute, '/api/insights/ai/calls', { ...query, ...(cursor && { cursor }) }));
    if (page.status !== 200) return { error: `calls ${page.status} ${page.body.error ?? ''}` };
    calls.push(...page.body.calls);
    callsHidden = page.body.hidden;
    cursor = page.body.next;
  }
  for (let cursor: string | undefined, first = true; first || cursor; first = false) {
    const page = await as(user, () => call<AiSpendRunsPage & { error?: string }>(runsRoute, '/api/insights/ai/runs', { ...query, ...(cursor && { cursor }) }));
    if (page.status !== 200) return { error: `runs ${page.status} ${page.body.error ?? ''}` };
    runs.push(...page.body.runs);
    runsHidden = page.body.hidden;
    cursor = page.body.next;
  }
  return {
    calls: calls.length + (callsHidden?.calls ?? 0),
    cost: calls.reduce((sum, c) => sum + c.cost, 0) + (callsHidden?.cost ?? 0),
    runs: runs.length + (runsHidden?.runs ?? 0),
  };
}

/** Each row of each group against the lists behind it; the mismatches, as words. */
async function mismatches(user: User, period: string, filters: AiSpendFilters): Promise<string[]> {
  const page = await report(user, period, filters);
  const out: string[] = [];
  for (const [group, rows] of Object.entries(page.groups) as Array<[AiSpendGroup, AiSpendRow[]]>) {
    for (const r of rows) {
      if (r.key === 'other') continue;
      const where = `${user.name} ${period} ${JSON.stringify(filters)} ${group}=${r.key}`;
      const got = await behind(user, { period, ...(filters as Record<string, string>), group, key: r.key });
      if ('error' in got) {
        out.push(`${where}: ${got.error}`);
        continue;
      }
      if (got.calls !== r.calls) out.push(`${where}: calls ${got.calls} listed, ${r.calls} in the report`);
      if (Math.abs(got.cost - r.cost) > 1e-6) out.push(`${where}: cost ${got.cost} listed, ${r.cost} in the report`);
      if (got.runs !== r.runs) out.push(`${where}: runs ${got.runs} listed, ${r.runs} in the report`);
    }
  }
  return out;
}

/** Every filter a row of the report can become: its group's key, `none` only where the filter takes it. */
function filtersOf(page: Report): AiSpendFilters[] {
  const out: AiSpendFilters[] = [];
  for (const [filter, word] of Object.entries(FILTER_WORDS) as Array<[keyof AiSpendFilters, { group: AiSpendGroup }]>) {
    for (const r of page.groups[word.group] ?? []) {
      if (r.key === 'other' || r.key === 'shared') continue;
      if (r.key === 'none' && filter !== 'surface' && filter !== 'purpose') continue;
      out.push({ [filter]: r.key } as AiSpendFilters);
    }
  }
  return out;
}

describe('the report and the runs and calls behind it', () => {
  it('lists, for every row of every group, the calls, cost and runs the report counts (no filter)', async () => {
    for (const user of [owner, mia, ben])
      for (const period of ['7d', '24h', '30d']) expect(await mismatches(user, period, {})).toEqual([]);
  });

  it('emits the keys the join is about: none, Another …, a model under two providers', async () => {
    const owners = await report(owner, '7d');
    expect(owners.groups.surface.map((r) => r.key)).toContain('none');
    expect(owners.groups.purpose.map((r) => r.key)).toContain('none');
    expect(owners.groups.model.map((r) => r.key)).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-5-5', 'litellm/claude-sonnet-5-5', 'ollama/qwen3-coder:30b', 'litellm/qwen3-coder:30b']));
    const mias = await report(mia, '7d');
    expect(mias.groups.workflow.map((r) => r.key)).toContain('shared');
    expect(mias.groups.credential.map((r) => r.key)).toContain('shared');
    // The rollup's day is in: ex_long's two calls on two days are one run.
    expect(owners.groups.workflow.find((r) => r.key === 'wf_rj_alpha')?.runs).toBe(7);
  });

  it('lists the same under every filter a row can become: provider/model, surface=none, purpose=none, a person, a project …', async () => {
    for (const user of [owner, mia]) {
      const filters = filtersOf(await report(user, '7d'));
      expect(filters).toEqual(expect.arrayContaining([{ model: 'anthropic/claude-sonnet-5-5' }, { surface: 'none' }, { purpose: 'none' }]));
      // A bare model name (the old filter form) is one more the report takes.
      filters.push({ model: 'claude-sonnet-5-5' });
      const out: string[] = [];
      for (const f of filters) out.push(...(await mismatches(user, '7d', f)));
      expect(out).toEqual([]);
    }
  });

  it('the filters narrow: a provider/model filter and surface=none list calls, not nothing', async () => {
    const byModel = await behind(owner, { period: '7d', model: 'anthropic/claude-sonnet-5-5', group: 'source', key: 'landflow:landflow' });
    expect('error' in byModel ? byModel.error : byModel.calls).toBeGreaterThan(0);
    const noSurface = await behind(owner, { period: '7d', surface: 'none', group: 'source', key: 'landflow:landflow' });
    expect('error' in noSurface ? noSurface.error : noSurface.calls).toBeGreaterThan(0);
  });
});
