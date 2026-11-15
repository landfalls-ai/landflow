/**
 * The join of an approved task run with the project's limits (constitution lesson 15; PC19 with PC13's project settings and
 * PC14's budget): a task run in project B starts the agent through the real runner with B's context, so B's allow-list, tool
 * kinds, default model and hard-stop budget apply. The routes are the real ones, and the model calls go to the fake model
 * server. PC19's own test covers the same limits for one project; here project B is a second project with its own settings,
 * and a shared agent of another project is the one the allow-list refuses.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startFakeModels } from './fake-ai-services';
import type { TaskRun } from '@/lib/shared/project-tasks';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-task-limits-join-'));
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
const { agentStore } = await import('@/lib/server/agents/store');
const { aiUsageMeter, savePriceOverrides } = await import('@/lib/server/ai-usage');
const projects = await import('@/lib/server/projects');
const { updateProjectSettings } = await import('@/lib/server/governance/scopes');
const { saveBudget, incidentsOf, currentMonth } = await import('@/lib/server/budgets/store');
const listRoute = await import('@/app/api/projects/[id]/tasks/route');
const runsRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/runs/route');
const runRoute = await import('@/app/api/task-runs/[runId]/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const ollama = fake.url.replace(/\/v1$/, '');

afterAll(async () => {
  enableTestAuth();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = async (route: unknown, path: string, method: string, body?: unknown, params?: Record<string, string>) => {
  const response = await (route as Route)(new Request(`http://landflow.test${path}`, { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
};

const editor = await createUser({ email: 'eve@limits-join.test', name: 'Eve', role: 'member', password: 'password-123' });
enableTestAuth(editor);
const A = projects.createTeamProject({ name: 'Alpha' }).id;
const B = projects.createTeamProject({ name: 'Billing' }).id;
projects.setMember(B, editor.id, 'editor');
const model = { provider: 'ollama' as const, model: 'limits-join', baseUrl: ollama };
const publish = (name: string, home: string, extra: Record<string, unknown> = {}) => {
  const agent = agentStore.create({ name, instructions: 'Be brief.', ...extra });
  projects.setHomeProject('agent', agent.id, home);
  return agentStore.publish(agent.id)!.id;
};
const own = publish('Ledger clerk', B, { model });
const visitor = publish('Visitor', A, { model });
projects.putShare('agent', visitor, B, 'user');
const tooled = publish('Echoer', B, { model, tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: false }] });
const modelless = publish('Modelless', B);

let n = 0;
async function requested(agentId: string) {
  const made = await call(listRoute.POST, `/api/projects/${B}/tasks`, 'POST', { title: `Task ${++n}`, assignee: { kind: 'agent', id: agentId } }, { id: B });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const asked = await call(runsRoute.POST, `/api/projects/${B}/tasks/${made.body.task.id}/runs`, 'POST', undefined, { id: B, taskId: made.body.task.id });
  expect(asked.status).toBe(201);
  return asked.body.run as TaskRun;
}
const approve = (runId: string) => call(runRoute.POST, `/api/task-runs/${runId}`, 'POST', { decision: 'approve' }, { runId });
async function settled(runId: string): Promise<TaskRun> {
  for (let i = 0; i < 200; i++) {
    const run = (await call(runRoute.GET, `/api/task-runs/${runId}`, 'GET', undefined, { runId })).body.run as TaskRun;
    if (!['approved', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the run did not settle');
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('an approved task run in project B obeys B’s limits', () => {
  it('the allow-list: a shared agent B does not name is refused at Approve (409, the PC13 wording) with no model call', async () => {
    const run = await requested(visitor);
    updateProjectSettings(B, { agents: { mode: 'allow', ids: [own] } });
    try {
      const calls = fake.requests.length;
      const refused = await approve(run.id);
      expect([refused.status, refused.body.error]).toEqual([409, '“Visitor” isn\'t allowed in project “Billing” (Project settings → Agents)']);
      await quiet();
      expect(fake.requests.length).toBe(calls);
      expect((await call(runRoute.GET, `/api/task-runs/${run.id}`, 'GET', undefined, { runId: run.id })).body.run.status).toBe('requested');
    } finally {
      updateProjectSettings(B, { agents: { mode: 'off', ids: [] } });
    }
  });

  it('the tool kinds: a withheld kind is not offered, and is again when the project allows it', async () => {
    const run = await requested(tooled);
    updateProjectSettings(B, { agentTools: { mode: 'allow', kinds: ['mcp'] } });
    try {
      await approve(run.id);
      expect((await settled(run.id)).status).toBe('done');
      expect(fake.last('/api/chat')!.body.tools ?? []).toEqual([]);
    } finally {
      updateProjectSettings(B, { agentTools: { mode: 'off', kinds: [] } });
    }
    const again = await requested(tooled);
    await approve(again.id);
    expect((await settled(again.id)).status).toBe('done');
    expect(fake.last('/api/chat')!.body.tools?.length).toBeGreaterThan(0);
  });

  it('the default model: an agent with none runs on the project’s', async () => {
    const without = await requested(modelless);
    await approve(without.id);
    expect((await settled(without.id)).status).toBe('failed');
    updateProjectSettings(B, { defaultModel: model });
    try {
      const run = await requested(modelless);
      await approve(run.id);
      const done = await settled(run.id);
      expect(done.status, done.error).toBe('done');
      expect(fake.last('/api/chat')!.body.model).toBe('limits-join');
    } finally {
      updateProjectSettings(B, { defaultModel: undefined });
    }
  });

  it('the hard-stop budget: a priced call ends the run failed with the cap message, opens one stop, and the next run makes no model call', async () => {
    savePriceOverrides([{ provider: 'openai', model: 'gpt-limits-join', input: 1000, output: 1000 }]);
    aiUsageMeter().invalidatePrices();
    const key = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
    projects.setHomeProject('credential', key.id, B);
    const paid = publish('Paid clerk', B, { model: { provider: 'openai', model: 'gpt-limits-join', credential: { id: key.id, name: key.name } } });
    saveBudget({ projectId: B, monthlyUsd: 0.01, warnPercent: 80, hardStop: true, updatedAt: new Date().toISOString() });
    aiUsageMeter().invalidateBudgets();
    try {
      const run = await requested(paid);
      await approve(run.id);
      const first = await settled(run.id);
      expect(first.status).toBe('failed');
      expect(first.error).toContain('Billing');
      expect(incidentsOf(B, currentMonth(aiUsageMeter())).filter((i) => i.kind === 'stop')).toHaveLength(1);
      const next = await requested(paid);
      const calls = fake.requests.length;
      await approve(next.id);
      expect((await settled(next.id)).status).toBe('failed');
      expect(fake.requests.length).toBe(calls);
      expect(incidentsOf(B, currentMonth(aiUsageMeter())).filter((i) => i.kind === 'stop')).toHaveLength(1);
    } finally {
      database().delete('project_budgets', { project_id: B });
      for (const row of database().all<{ id: string }>('SELECT id FROM project_budget_incidents WHERE project_id = ?', B)) database().delete('project_budget_incidents', { id: row.id });
      aiUsageMeter().invalidateBudgets();
    }
  });
});
