/**
 * The join of a project's AI budget (contracts/w9/budget-api.md): PC14's server (the hard stop in the meter, incidents,
 * routes, Needs you items, the cap in L1's system) with PC15's client (the fetch helpers, `NeedsYouRow`, `actionsFor`) and
 * LiteLLM wave L1's cap-raise flow and AI console. Each side tested itself with fakes; this one runs the real sides
 * together: real agent runs whose model calls go to the fake model server and are priced by a made-up price override, the
 * client helpers' requests sent to the real routes, and an editor's "Ask for more" decided through the installed flow.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NeedsYouRow } from '../src/lib/client/run-trace';
import { askForMore, fetchBudget, runIncidentAction, saveBudget } from '../src/lib/client/project-budget-api';
import { actionsFor } from '../src/components/run-trace/needs-you-actions';
import { readSse, startFakeModels } from './fake-ai-services';
import { routeFetch } from './join-fetch';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-budget-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const { aiUsageMeter, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { createTeamProject, setMember, setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { sweepBudgets } = await import('@/lib/server/budgets/enforce');
const { getBudget, incidentsOf, currentMonth } = await import('@/lib/server/budgets/store');
const { watchedCaps } = await import('@/lib/server/ai-usage/alerts');
const { aiConsoleReport } = await import('@/lib/server/llm-gateway/console');
const { scopeOf } = await import('@/lib/server/llm-gateway/sync');
const budgetRoute = await import('@/app/api/projects/[id]/budget/route');
const incidentRoute = await import('@/app/api/projects/[id]/budget/incidents/[incidentId]/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const capRequestsRoute = await import('@/app/api/ai/cap-requests/route');
const capSetupRoute = await import('@/app/api/ai/cap-requests/setup/route');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const realFetch = globalThis.fetch;
const routed = routeFetch([
  ['/api/projects/:id/budget', budgetRoute],
  ['/api/projects/:id/budget/incidents/:incidentId', incidentRoute],
  ['/api/runs/needs-you', needsYouRoute],
  ['/api/ai/cap-requests', capRequestsRoute],
]);
// Client helpers' /api/ requests go to the route handlers; the fake model server is reached over the real fetch.
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return href.startsWith('/api/') ? routed(input, init) : realFetch(input, init);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  enableTestAuth();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const meter = aiUsageMeter();
const admin = await createUser({ email: 'ada@budget-join.test', name: 'Ada', role: 'admin', password: 'ada-password-1' });
const owner = await createUser({ email: 'ola@budget-join.test', name: 'Ola', role: 'member', password: 'ola-password-1' });
const editor = await createUser({ email: 'eve@budget-join.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
const P = createTeamProject({ name: 'Billing revamp' }).id;
setMember(P, owner.id, 'editor');
setMember(P, editor.id, 'editor');
const capId = `project:${P}:month:cost`;

// $1,000 per million tokens: the fake's 12 + 8 tokens cost $0.02, over a $0.01 budget in one call. Made up.
savePriceOverrides([{ provider: 'openai', model: 'gpt-join-priced', input: 1000, output: 1000 }]);
meter.invalidatePrices();
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
setHomeProject('credential', openAi.id, P);
const agentIn = (name: string, model: Record<string, unknown>) => {
  const agent = agentStore.create({ name, instructions: 'Be brief.', model: model as never });
  setHomeProject('agent', agent.id, P);
  return agent.id;
};
const paid = agentIn('Paid', { provider: 'openai', model: 'gpt-join-priced', credential: { id: openAi.id, name: openAi.name } });
const local = agentIn('Local', { provider: 'ollama', model: 'llama-join', baseUrl: fake.url.replace(/\/v1$/, '') });
const run = async (agentId: string) => {
  const agent = agentStore.get(agentId)!;
  const session = newSession(agent, { source: 'test', userId: editor.id, version: 'draft' });
  const result = await runAgent({ agent, session, message: 'Price this', context: { caller: 'chat', agentId, projectId: P } } as never);
  // A cap stops the run with a notice ("Stopped: …"), not an error.
  const stopped = result.session.timeline.find((e) => e.type === 'notice' && e.message.startsWith('Stopped: '));
  return { reason: result.reason, stopped: stopped?.type === 'notice' ? stopped.message : undefined };
};
const stops = () => incidentsOf(P, currentMonth(meter)).filter((i) => i.kind === 'stop');
const needsYou = async (user: typeof admin) => {
  enableTestAuth(user);
  const response = await needsYouRoute.GET(new Request('http://landflow.test/api/runs/needs-you'));
  return ((await response.json()) as { items: NeedsYouRow[] }).items.filter((i) => i.kind === 'budget');
};

describe('the hard stop on real calls', () => {
  it('PC15’s card saves a $0.01 budget with a hard stop through PC14’s route', async () => {
    enableTestAuth(admin);
    const view = await saveBudget(P, { monthlyUsd: 0.01, hardStop: true, ownerId: owner.id });
    expect(view.budget).toMatchObject({ monthlyUsd: 0.01, hardStop: true, ownerId: owner.id });
    expect(view.capId).toBe(capId);
  });

  it('a priced call over the budget throws the cap error naming the project, opening exactly one stop', async () => {
    const first = await run(paid);
    expect(first.reason).toBe('budget');
    expect(first.stopped).toContain('project “Billing revamp” this month');
    const callsBefore = fake.requests.length;
    const second = await run(paid);
    expect(second.stopped).toContain('project “Billing revamp”');
    // Refused before the call: nothing reached the model.
    expect(fake.requests.length).toBe(callsBefore);
    await run(paid);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toMatchObject({ status: 'open', budgetUsd: 0.01 });
  });

  it('a local (unpriced) model still runs while stopped, and counts in unpricedCalls', async () => {
    const before = (await (enableTestAuth(owner), fetchBudget(P))).unpricedCalls;
    expect((await run(local)).reason).toBe('completed');
    const view = await fetchBudget(P);
    expect(view.unpricedCalls).toBe(before + 1);
    expect(view.paused).toBe(true);
    expect(view.usedUsd).toBeGreaterThanOrEqual(0.02);
  });
});

describe('Needs you, through PC15’s row and actions', () => {
  it('holds the stop; an admin gets Resume, Raise, Open project and the owner Resume, Open project', async () => {
    await sweepBudgets(Date.now(), meter);
    const forAdmin = await needsYou(admin);
    const stop = forAdmin.find((i) => i.incidentKind === 'stop')!;
    expect(stop).toMatchObject({ kind: 'budget', projectId: P, executionId: '', href: `/projects/${P}?tab=settings#budget` });
    expect(stop.title).toContain('Project “Billing revamp” paused: AI budget reached');
    expect(actionsFor(stop).map((a) => a.id)).toEqual(['resume', 'raise', 'open']);
    const forOwner = (await needsYou(owner)).find((i) => i.incidentKind === 'stop')!;
    expect(actionsFor(forOwner).map((a) => a.id)).toEqual(['resume', 'open']);
    // The sweep opened the warning too: Dismiss for whoever may resume.
    const warn = forAdmin.find((i) => i.incidentKind === 'warn')!;
    expect(actionsFor(warn).map((a) => a.id)).toEqual(['dismiss', 'open']);
    expect(await needsYou(editor)).toEqual([]);
  });

  it('PC15’s helpers read the real budget, resume through the real route, and the next priced call goes through', async () => {
    enableTestAuth(owner);
    const view = await fetchBudget(P);
    expect(view).toMatchObject({ paused: true, canResume: true, canEdit: false, capId });
    const stop = view.incidents.find((i) => i.kind === 'stop' && i.status === 'open')!;
    const resumed = await runIncidentAction(P, stop.id, { action: 'resume' });
    expect(resumed.paused).toBe(false);
    meter.invalidateBudgets();
    const callsBefore = fake.requests.length;
    expect((await run(paid)).reason).toBe('completed');
    expect(fake.requests.length).toBe(callsBefore + 1);
    // A warning is dismissed the same way, and leaves Needs you.
    enableTestAuth(owner);
    const warn = (await fetchBudget(P)).incidents.find((i) => i.kind === 'warn' && i.status === 'open')!;
    const dismissed = await runIncidentAction(P, warn.id, { action: 'dismiss' });
    expect(dismissed.incidents.find((i) => i.id === warn.id)).toMatchObject({ status: 'dismissed' });
    expect(await needsYou(owner)).toEqual([]);
  });
});

describe('the budget as a cap in L1’s system', () => {
  it('is watched, listed on Insights → AI for members (Ask for more for a non-admin editor), and outside the sync’s scope', async () => {
    expect(watchedCaps(meter).find((c) => c.id === capId)).toMatchObject({ max: 0.01, metric: 'cost', period: 'month' });
    enableTestAuth(admin);
    const setup = await capSetupRoute.POST(new Request('http://landflow.test/api/ai/cap-requests/setup', { method: 'POST' }));
    expect(setup.status).toBe(200);
    expect(aiConsoleReport(editor, '7d').caps.find((c) => c.id === capId)).toMatchObject({ canRequest: true, subject: 'project “Billing revamp”' });
    expect(aiConsoleReport(admin, '7d').caps.find((c) => c.id === capId)).toMatchObject({ canRequest: false });
    expect(scopeOf([capId])).toEqual({ users: new Set(), credentials: new Set(), agents: new Set() });
    enableTestAuth(editor);
    expect((await fetchBudget(P)).canAsk).toBe(true);
  });

  it('an editor’s Ask for more, approved through the flow, sets monthlyUsd and resolves the open incidents as raised', async () => {
    // A new amount, still under this month's spend: the sweep opens a warning against it (the month stays resumed, so no stop).
    enableTestAuth(admin);
    await saveBudget(P, { monthlyUsd: 0.02, hardStop: true, ownerId: owner.id });
    meter.invalidateBudgets();
    await sweepBudgets(Date.now(), meter);
    const open = incidentsOf(P, currentMonth(meter)).filter((i) => i.status === 'open');
    expect(open.length).toBeGreaterThan(0);

    enableTestAuth(editor);
    const asked = (await askForMore(capId, 1.5, 'The month-end run needs more')) as { id: string; executionId: string; status: string };
    expect(asked.status).toBe('asking');
    enableTestAuth(admin);
    const answer = await approvalsRoute.POST(
      new Request(`http://landflow.test/api/executions/${asked.executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'confirm', approved: true }) }),
      { params: Promise.resolve({ id: asked.executionId }) },
    );
    if (answer.headers.get('content-type')?.includes('event-stream')) await readSse(answer);
    expect(answer.status).toBe(200);
    const stored = database().get<{ status: string; gateway: string | null }>('SELECT status, gateway FROM ai_cap_requests WHERE id = ?', asked.id);
    expect(stored).toMatchObject({ status: 'approved', gateway: 'skipped' });
    expect(getBudget(P)?.monthlyUsd).toBe(1.5);
    for (const incident of open) {
      expect(incidentsOf(P, currentMonth(meter)).find((i) => i.id === incident.id)).toMatchObject({ status: 'resolved', resolution: 'raised', resolvedBy: admin.id });
    }
    enableTestAuth(owner);
    expect((await fetchBudget(P)).paused).toBe(false);
  });
});
