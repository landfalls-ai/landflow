/**
 * A project's monthly AI budget (docs/projects-and-goals.md#ai-budget): the hard stop on priced calls, the incidents, the
 * sweep, the routes, the Needs you items and the project's removal. Prices are made up; spend is seeded rows.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BudgetNeedsYouFields, ProjectBudgetView } from '@/lib/shared/project-budget';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-budget-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database, openSqlite } = await import('@/lib/server/db');
const { aiUsageMeter, savePriceOverrides, UsageScope, isUsageCapError } = await import('@/lib/server/ai-usage');
const { createTeamProject, setMember, removeMember, removeProjectRows, afterRemoved } = await import('@/lib/server/projects/store');
const { sweepBudgets, budgetItems } = await import('@/lib/server/budgets/enforce');
const { getBudget, incidentsOf, saveBudget, currentMonth, openIncident, resolveIncident } = await import('@/lib/server/budgets/store');
const { needsYou } = await import('@/lib/server/journal/needs-you');
const { watchedCaps } = await import('@/lib/server/ai-usage/alerts');
const budgetRoute = await import('@/app/api/projects/[id]/budget/route');
const incidentRoute = await import('@/app/api/projects/[id]/budget/incidents/[incidentId]/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');

type User = Awaited<ReturnType<typeof createUser>>;
let admin: User;
let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId = '';
let counter = 0;
const meter = aiUsageMeter();

beforeAll(async () => {
  admin = await createUser({ email: 'ada@budget.test', name: 'Ada', role: 'admin', password: 'ada-password-1' });
  owner = await createUser({ email: 'ola@budget.test', name: 'Ola', role: 'member', password: 'ola-password-1' });
  editor = await createUser({ email: 'eve@budget.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
  viewer = await createUser({ email: 'vic@budget.test', name: 'Vic', role: 'member', password: 'vic-password-1' });
  stranger = await createUser({ email: 'sam@budget.test', name: 'Sam', role: 'member', password: 'sam-password-1' });
  projectId = createTeamProject({ name: 'Billing revamp' }).id;
  setMember(projectId, owner.id, 'editor');
  setMember(projectId, editor.id, 'editor');
  setMember(projectId, viewer.id, 'viewer');
  // $1 per million input tokens; made-up models. `gpt-budget` is priced, `local-llama` is not.
  savePriceOverrides([{ provider: 'openai', model: 'gpt-budget', input: 1, output: 1 }]);
  meter.invalidatePrices();
});

afterAll(() => {
  vi.useRealTimers();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

afterEach(() => {
  vi.useRealTimers();
  meter.invalidateBudgets();
  database().delete('project_budgets', { project_id: projectId });
  for (const row of database().all<{ id: string }>('SELECT id FROM project_budget_incidents WHERE project_id = ?', projectId)) database().delete('project_budget_incidents', { id: row.id });
  for (const row of database().all<{ id: string }>('SELECT id FROM ai_usage WHERE project_id = ?', projectId)) database().delete('ai_usage', { id: row.id });
});

const audited = (action: string) => database().all('SELECT id FROM audit_events WHERE action = ?', action).length;
const priced = { provider: 'openai', model: 'gpt-budget', operation: 'chat' as const };
const local = { provider: 'ollama', model: 'local-llama', operation: 'chat' as const };

function seed(cost: number, fields: Record<string, unknown> = {}) {
  database().insertNew('ai_usage', {
    id: `au_pb_${counter++}`,
    at: new Date().toISOString(),
    day: meter.today(),
    provider: 'openai',
    model: 'gpt-budget',
    operation: 'chat',
    input_tokens: 10,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    project_id: projectId,
    cost,
    ...fields,
  });
}

const setBudget = (fields: Record<string, unknown> = {}) => {
  saveBudget({ projectId, monthlyUsd: 1, warnPercent: 80, hardStop: true, ...fields } as never);
  meter.invalidateBudgets();
};
const scope = () => new UsageScope({ projectId, userId: editor.id }, [], undefined, meter);
const incidents = () => incidentsOf(projectId, currentMonth(meter));
const tryCall = (call: typeof priced | typeof local) => {
  try {
    scope().check('before', call);
    return undefined;
  } catch (error) {
    return isUsageCapError(error) ? error : (() => { throw error; })();
  }
};

describe('the hard stop', () => {
  it('passes below the budget and refuses a priced call at it, opening one stop', () => {
    setBudget();
    seed(0.5);
    expect(tryCall(priced)).toBeUndefined();
    seed(0.5);
    const error = tryCall(priced);
    expect(error?.message).toContain('project “Billing revamp” this month');
    expect(error?.message).toContain('Project “Billing revamp” → Settings → AI budget');
    tryCall(priced);
    tryCall(priced);
    expect(incidents().filter((i) => i.kind === 'stop' && i.status === 'open')).toHaveLength(1);
    expect(audited('project.budget.stopped')).toBeGreaterThan(0);
  });

  it('repeated calls open one stop', () => {
    setBudget();
    seed(2);
    tryCall(priced);
    tryCall(priced);
    expect(incidents().filter((i) => i.kind === 'stop')).toHaveLength(1);
  });

  it('two separate databases opening the same stop derive the same id; a reopened stop gets a new one', () => {
    const a = openSqlite(':memory:');
    const b = openSqlite(':memory:');
    const input = { projectId: 'prj_x', month: '2026-11', kind: 'stop' as const, usedUsd: 2, budgetUsd: 1 };
    const first = openIncident(a, input)!;
    expect(openIncident(b, input)!.id).toBe(first.id);
    resolveIncident(a, first.id, 'raised');
    const second = openIncident(a, input)!;
    expect(second.id).not.toBe(first.id);
  });

  it('never stops a model only the gateway prices, and counts its spend', async () => {
    setBudget();
    seed(2);
    seed(1.5, { provider: 'openai', model: 'gateway-only', source: 'litellm', runtime: 'claude', call_id: 'gw-1' });
    expect(tryCall(priced)).toBeDefined();
    expect(tryCall({ provider: 'openai', model: 'gateway-only', operation: 'chat' as const })).toBeUndefined();
    expect((await view(admin)).usedUsd).toBe(3.5);
    enableTestAuth();
  });

  it('never stops an unpriced call, which still counts', async () => {
    setBudget();
    seed(2);
    seed(0, { provider: 'ollama', model: 'local-llama' });
    seed(0, { provider: 'ollama', model: 'local-llama' });
    expect(tryCall(priced)).toBeDefined();
    expect(tryCall(local)).toBeUndefined();
    expect((await view(admin)).unpricedCalls).toBe(2);
    enableTestAuth();
  });

  it('is off by default: no hard stop, no error, but the warning still opens', async () => {
    setBudget({ hardStop: false });
    seed(2);
    expect(tryCall(priced)).toBeUndefined();
    await sweepBudgets(Date.now(), meter);
    expect(incidents().map((i) => i.kind)).toEqual(['warn']);
  });

  it('has no limit for a project without a budget', () => {
    seed(100);
    expect(tryCall(priced)).toBeUndefined();
  });

  it('resumes priced calls until the month changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T10:00:00Z'));
    setBudget();
    seed(2);
    expect(tryCall(priced)).toBeDefined();
    enableTestAuth(admin);
    const stop = incidents().find((i) => i.kind === 'stop')!;
    const response = await incidentRoute.POST(post({ action: 'resume' }), { params: Promise.resolve({ id: projectId, incidentId: stop.id }) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectBudgetView).paused).toBe(false);
    expect(audited('project.budget.resumed')).toBe(1);
    expect(tryCall(priced)).toBeUndefined();
    // A new month: the resume is over; with no spend this month the call passes, and spend there stops it again.
    vi.setSystemTime(new Date('2026-12-02T10:00:00Z'));
    meter.invalidateBudgets();
    seed(2, { day: meter.today() });
    expect(tryCall(priced)).toBeDefined();
    enableTestAuth();
  });
});

const post = (body: unknown) => new Request('http://t/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown) => new Request('http://t/api', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = () => ({ params: Promise.resolve({ id: projectId }) });
const view = async (user: User) => {
  enableTestAuth(user);
  return (await (await budgetRoute.GET(new Request('http://t/api'), ctx())).json()) as ProjectBudgetView;
};
const act = async (user: User, incidentId: string, body: unknown) => {
  enableTestAuth(user);
  const response = await incidentRoute.POST(post(body), { params: Promise.resolve({ id: projectId, incidentId }) });
  return { status: response.status, body: (await response.json()) as ProjectBudgetView & { error?: string } };
};

describe('raise, remove and the sweep', () => {
  it('a raise sets the budget, resolves the incident, and a later stop opens a new one', async () => {
    setBudget();
    seed(2);
    tryCall(priced);
    const stop = incidents()[0]!;
    const raised = await act(admin, stop.id, { action: 'raise', monthlyUsd: 5 });
    expect(raised.status).toBe(200);
    expect(raised.body.budget?.monthlyUsd).toBe(5);
    expect(raised.body.paused).toBe(false);
    expect(audited('project.budget.raised')).toBeGreaterThan(0);
    expect(tryCall(priced)).toBeUndefined();
    seed(4);
    expect(tryCall(priced)).toBeDefined();
    expect(incidents().filter((i) => i.kind === 'stop')).toHaveLength(2);
    expect(incidents().filter((i) => i.status === 'open')).toHaveLength(1);
  });

  it('budget 0 removes it and resolves the open incidents as raised', async () => {
    setBudget();
    seed(2);
    tryCall(priced);
    enableTestAuth(admin);
    const response = await budgetRoute.PUT(put({ monthlyUsd: 0 }), ctx());
    const body = (await response.json()) as ProjectBudgetView;
    expect(body.budget).toBeUndefined();
    expect(getBudget(projectId)).toBeUndefined();
    expect(incidents().every((i) => i.status === 'resolved' && i.resolution === 'raised')).toBe(true);
    expect(tryCall(priced)).toBeUndefined();
  });

  it('opens a warning once per budget amount; a dismissed one stays; a raise lets a new one open', async () => {
    setBudget({ hardStop: false });
    seed(0.9);
    await sweepBudgets(Date.now(), meter);
    await sweepBudgets(Date.now(), meter);
    expect(incidents()).toHaveLength(1);
    const warn = incidents()[0]!;
    expect((await act(admin, warn.id, { action: 'dismiss' })).status).toBe(200);
    expect(audited('project.budget.dismissed')).toBeGreaterThan(0);
    await sweepBudgets(Date.now(), meter);
    expect(incidents()).toHaveLength(1);
    setBudget({ hardStop: false, monthlyUsd: 1.1 });
    await sweepBudgets(Date.now(), meter);
    expect(incidents().filter((i) => i.kind === 'warn')).toHaveLength(2);
  });

  it('imported spend opens a stop with no call', async () => {
    setBudget();
    seed(3, { source: 'litellm', runtime: 'claude', call_id: 'imp-1' });
    await sweepBudgets(Date.now(), meter);
    expect(incidents().map((i) => i.kind).sort()).toEqual(['stop', 'warn']);
    await sweepBudgets(Date.now(), meter);
    expect(incidents()).toHaveLength(2);
  });
});

describe('the routes', () => {
  it('lets members read, refuses a viewer or editor to change it, and 404s a stranger', async () => {
    enableTestAuth(stranger);
    expect((await budgetRoute.GET(new Request('http://t/api'), ctx())).status).toBe(404);
    expect((await view(viewer)).canEdit).toBe(false);
    enableTestAuth(editor);
    const denied = await budgetRoute.PUT(put({ monthlyUsd: 10 }), ctx());
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe('Only the project’s admins change its AI budget');
    enableTestAuth(admin);
    expect((await budgetRoute.PUT(put({ monthlyUsd: -1 }), ctx())).status).toBe(400);
    expect((await budgetRoute.PUT(put({ monthlyUsd: 5, ownerId: stranger.id }), ctx())).status).toBe(400);
    const ok = await budgetRoute.PUT(put({ monthlyUsd: 50, warnPercent: 70, hardStop: true, ownerId: owner.id }), ctx());
    const body = (await ok.json()) as ProjectBudgetView;
    expect(body.budget).toMatchObject({ projectId, monthlyUsd: 50, warnPercent: 70, hardStop: true, ownerId: owner.id, updatedBy: admin.id });
    expect(body).toMatchObject({ canEdit: true, canResume: true, capId: `project:${projectId}:month:cost`, percent: 0, paused: false });
    expect(audited('project.budget.update')).toBeGreaterThan(0);
  });

  it('the owner resumes and dismisses but cannot raise; every error answers as the contract says', async () => {
    setBudget({ ownerId: owner.id });
    seed(2);
    tryCall(priced);
    await sweepBudgets(Date.now(), meter);
    const [stop, warn] = [incidents().find((i) => i.kind === 'stop')!, incidents().find((i) => i.kind === 'warn')!];
    expect((await act(owner, stop.id, { action: 'raise', monthlyUsd: 9 })).status).toBe(403);
    expect((await act(editor, stop.id, { action: 'resume' })).status).toBe(403);
    expect((await act(admin, 'pbi_missing', { action: 'resume' })).status).toBe(404);
    expect((await act(admin, stop.id, { action: 'dismiss' })).status).toBe(400);
    expect((await act(admin, warn.id, { action: 'resume' })).status).toBe(400);
    expect((await act(admin, stop.id, { action: 'raise', monthlyUsd: 1 })).status).toBe(400);
    expect((await act(owner, stop.id, { action: 'resume' })).status).toBe(200);
    const again = await act(owner, stop.id, { action: 'resume' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Already resumed');
    expect((await act(owner, warn.id, { action: 'dismiss' })).status).toBe(200);
  });

  it('a raise with no budget is a 409, and a stop whose hard stop went off leaves Needs you', async () => {
    setBudget();
    seed(2);
    tryCall(priced);
    const stop = incidents()[0]!;
    expect(budgetItems(admin, meter)).toHaveLength(1);
    setBudget({ hardStop: false });
    expect(budgetItems(admin, meter)).toHaveLength(0);
    database().delete('project_budgets', { project_id: projectId });
    meter.invalidateBudgets();
    expect((await act(admin, stop.id, { action: 'raise', monthlyUsd: 9 })).status).toBe(409);
  });

  it('answers the contract example for the seeded data', async () => {
    setBudget({ monthlyUsd: 50, hardStop: true, ownerId: owner.id });
    seed(50.12);
    seed(0, { provider: 'ollama', model: 'local-llama' });
    tryCall(priced);
    const body = await view(owner);
    expect(body).toMatchObject({ month: currentMonth(meter), usedUsd: 50.12, unpricedCalls: 1, percent: 100, paused: true, canEdit: false, canResume: true, capId: `project:${projectId}:month:cost` });
    expect(body.incidents[0]).toMatchObject({ kind: 'stop', status: 'open', usedUsd: 50.12, budgetUsd: 50 });
    const none = await (async () => {
      database().delete('project_budgets', { project_id: projectId });
      return view(admin);
    })();
    expect(none.budget).toBeUndefined();
    expect(none.capId).toBeUndefined();
    expect(none.percent).toBe(0);
  });
});

describe('the budget as a cap', () => {
  it('is watched for a budget above 0 only', () => {
    setBudget();
    const cap = watchedCaps(meter).find((c) => c.id === `project:${projectId}:month:cost`);
    expect(cap).toMatchObject({ period: 'month', metric: 'cost', max: 1, subject: 'project “Billing revamp”', setIn: 'Project “Billing revamp” → Settings → AI budget' });
    expect(cap?.link).toContain(`/projects/${projectId}?tab=settings#budget`);
    database().delete('project_budgets', { project_id: projectId });
    expect(watchedCaps(meter).some((c) => c.id.startsWith('project:'))).toBe(false);
  });
});

describe('Needs you', () => {
  it('shows an item per open incident to the admins, the owner and instance admins, newest first with the run items', async () => {
    setBudget({ ownerId: owner.id, monthlyUsd: 50 });
    seed(50.12);
    tryCall(priced);
    await sweepBudgets(Date.now(), meter);
    const as = async (user: User) => {
      enableTestAuth(user);
      return ((await (await needsYouRoute.GET(new Request('http://t/api'))).json()) as { items: Array<Record<string, unknown>> }).items.filter((i) => i.kind === 'budget');
    };
    const forOwner = await as(owner);
    expect(forOwner).toHaveLength(2);
    const stop = forOwner.find((i) => i.incidentKind === 'stop')!;
    const fields: BudgetNeedsYouFields = stop as never;
    expect(fields).toMatchObject({ kind: 'budget', projectId, href: `/projects/${projectId}?tab=settings#budget`, canRaise: false, canResume: true });
    expect(stop).toMatchObject({ executionId: '', workflowId: '', workflowName: '', title: 'Project “Billing revamp” paused: AI budget reached ($50.12 of $50.00)' });
    expect(forOwner.find((i) => i.incidentKind === 'warn')?.title).toBe('Project “Billing revamp” used 100% of its AI budget ($50.12 of $50.00)');
    expect(forOwner.map((i) => i.since)).toEqual([...forOwner.map((i) => i.since as string)].sort().reverse());
    expect(await as(admin)).toHaveLength(2);
    expect((await as(admin))[0]).toMatchObject({ canRaise: true, canResume: true });
    expect(await as(editor)).toHaveLength(0);
    expect(await as(viewer)).toHaveLength(0);
    // needsYou's own signature and answer do not include them.
    expect((await needsYou(undefined)).some((i) => i.kind === 'budget')).toBe(false);
    expect(budgetItems(owner, meter)).toHaveLength(2);
    enableTestAuth();
  });

  it('hides the items from an owner who was removed from the project', async () => {
    setBudget({ ownerId: owner.id, monthlyUsd: 50 });
    seed(50.12);
    tryCall(priced);
    await sweepBudgets(Date.now(), meter);
    expect(budgetItems(owner, meter).length).toBeGreaterThan(0);
    removeMember(projectId, owner.id);
    expect(budgetItems(owner, meter)).toHaveLength(0);
  });

  it('leaves out last month’s incidents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    setBudget({ ownerId: owner.id });
    seed(2);
    tryCall(priced);
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    expect(budgetItems(admin, meter)).toHaveLength(0);
  });
});

describe('deleting the project', () => {
  it('withdraws open cap-raise requests for its cap and leaves others', async () => {
    const other = createTeamProject({ name: 'Requests' }).id;
    const now = new Date().toISOString();
    const base = { subject: 's', metric: 'cost', period: 'month', current_max: 1, requested_max: 2, reason: 'r', requested_by: 'u', created_at: now, updated_at: now };
    database().insertNew('ai_cap_requests', { id: 'cr_open', cap_id: `project:${other}:month:cost`, status: 'pending', ...base });
    database().insertNew('ai_cap_requests', { id: 'cr_done', cap_id: `project:${other}:month:cost`, status: 'approved', ...base });
    database().insertNew('ai_cap_requests', { id: 'cr_else', cap_id: 'project:elsewhere:month:cost', status: 'pending', ...base });
    removeProjectRows(other);
    await afterRemoved;
    const status = (id: string) => database().get<{ status: string }>('SELECT status FROM ai_cap_requests WHERE id = ?', id)?.status;
    expect([status('cr_open'), status('cr_done'), status('cr_else')]).toEqual(['cancelled', 'approved', 'pending']);
  });

  it('removes its budget and incidents', () => {
    const other = createTeamProject({ name: 'Short lived' }).id;
    saveBudget({ projectId: other, monthlyUsd: 3, warnPercent: 80, hardStop: true });
    database().insertNew('project_budget_incidents', { id: 'pbi_gone', project_id: other, month: '2026-11', kind: 'warn', status: 'open', used_usd: 3, budget_usd: 3, created_at: new Date().toISOString() });
    removeProjectRows(other);
    expect(getBudget(other)).toBeUndefined();
    expect(database().get('SELECT 1 AS n FROM project_budget_incidents WHERE project_id = ?', other)).toBeUndefined();
  });
});
