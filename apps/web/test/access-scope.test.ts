/**
 * Access scope of three instance-wide reads and one control (members see only what their projects hold):
 * POST /api/executions/stop-all is for owners and admins; GET /api/insights/ai-usage is limited to the workflows and
 * agents the caller can open (another project's ids answer 404); GET /api/binary/<id> answers 404 for a file of
 * another project's execution. Owners and admins see everything.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-access-scope-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { binaryStore } = await import('@/lib/server/binary/access');
const stopAllRoute = await import('@/app/api/executions/stop-all/route');
const usageRoute = await import('@/app/api/insights/ai-usage/route');
const fileRoute = await import('@/app/api/binary/[id]/route');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { routePolicy } = await import('@/lib/server/auth/policy');

type User = Awaited<ReturnType<typeof createUser>>;
let member: User;
let admin: User;
let mineWf = '';
let theirsWf = '';
let myFile = '';
let theirFile = '';
let looseFile = '';

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

function workflow(id: string, project: string) {
  store.saveWorkflow({ id, name: id, nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
  return id;
}

function execution(executionId: string, workflowId: string) {
  const now = new Date().toISOString();
  store.saveExecution({ executionId, workflowId, workflowName: workflowId, mode: 'manual', status: 'success', startedAt: now, finishedAt: now, durationMs: 1, runData: {}, executionOrder: [] });
}

/** A row in the usage ledger (the meter's own table). */
function usage(workflowId: string, executionId: string, cost: number) {
  const now = new Date();
  database().insertNew('ai_usage', {
    id: `au_${executionId}`,
    at: now.toISOString(),
    day: now.toISOString().slice(0, 10),
    execution_id: executionId,
    workflow_id: workflowId,
    provider: 'openai',
    model: 'gpt-test',
    operation: 'chat',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost,
  });
}

beforeAll(async () => {
  member = await createUser({ email: 'mia@scope.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  admin = await createUser({ email: 'ada@scope.test', name: 'Ada', role: 'admin', password: 'ada-password-1' });
  const mine = projects.createTeamProject({ name: 'Mine' }).id;
  const theirs = projects.createTeamProject({ name: 'Theirs' }).id;
  projects.setMember(mine, member.id, 'editor');
  mineWf = workflow('wf_scope_mine', mine);
  theirsWf = workflow('wf_scope_theirs', theirs);
  execution('ex_scope_mine', mineWf);
  execution('ex_scope_theirs', theirsWf);
  usage(mineWf, 'ex_scope_mine', 0.25);
  usage(theirsWf, 'ex_scope_theirs', 0.5);
  const binary = await binaryStore();
  myFile = (await binary.put('ex_scope_mine', Buffer.from('mine'), { fileName: 'a.txt', mimeType: 'text/plain' })).id!;
  theirFile = (await binary.put('ex_scope_theirs', Buffer.from('theirs'), { fileName: 'b.txt', mimeType: 'text/plain' })).id!;
  // An editor upload: no execution to derive an owner from.
  looseFile = (await binary.put('upload_scope_loose', Buffer.from('loose'), { fileName: 'c.txt', mimeType: 'text/plain' })).id!;
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const get = (url: string) => new Request(`http://scope.test${url}`);
const usageOf = async (user: User | undefined, query = '') => {
  const response = await as(user, () => (usageRoute.GET as (r: Request) => Promise<Response>)(get(`/api/insights/ai-usage?days=0&group=workflow${query}`)));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const fileOf = (user: User | undefined, id: string) => as(user, () => (fileRoute.GET as (r: Request, c: unknown) => Promise<Response>)(get(`/api/binary/${id}`), { params: Promise.resolve({ id }) }));

describe('stop-all', () => {
  it('is refused for members and works for admins and the owner', async () => {
    const post = () => (stopAllRoute.POST as (r: Request) => Promise<Response>)(new Request('http://scope.test/api/executions/stop-all', { method: 'POST' }));
    expect((await as(member, post)).status).toBe(403);
    expect((await as(admin, post)).status).toBe(200);
    expect((await as(undefined, post)).status).toBe(200);
  });

  it('keeps the executions:write key scope (the CLI) and leaves the decision to the role', () => {
    expect(routePolicy('POST', '/api/executions/stop-all')).toEqual({ scope: 'executions:write', action: 'settings:manage' });
  });
});

describe('AI usage report', () => {
  it('shows a member only the workflows they can open', async () => {
    const all = await usageOf(admin);
    expect(all.body.workflows.map((w: { workflowId: string }) => w.workflowId).sort()).toEqual([mineWf, theirsWf].sort());
    const own = await usageOf(member);
    expect(own.status).toBe(200);
    expect(own.body.workflows.map((w: { workflowId: string }) => w.workflowId)).toEqual([mineWf]);
    expect(own.body.totals.cost).toBeCloseTo(0.25);
  });

  it('groups a row that has both ids only under the ids the member can see', () => {
    // An agent the member can open ran inside another project's workflow: its cost counts for the agent, but the
    // other workflow gets no group of its own in the member's report.
    const now = new Date();
    database().insertNew('ai_usage', {
      id: 'au_scope_both', at: now.toISOString(), day: now.toISOString().slice(0, 10), execution_id: 'ex_scope_both', workflow_id: theirsWf, agent_id: 'agent_scope_seen',
      provider: 'openai', model: 'gpt-test', operation: 'chat', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0.125,
    });
    try {
      const within = { workflows: new Set([mineWf]), agents: new Set(['agent_scope_seen']) };
      const byWorkflow = aiUsageMeter().report({ group: 'workflow', within });
      expect(byWorkflow.workflows?.map((w) => w.workflowId)).toEqual([mineWf]);
      expect(byWorkflow.totals.cost).toBeCloseTo(0.375);
      const byAgent = aiUsageMeter().report({ group: 'agent', within: { workflows: new Set([theirsWf]), agents: new Set<string>() } });
      expect(byAgent.agents).toEqual([]);
    } finally {
      database().delete('ai_usage', { id: 'au_scope_both' });
    }
  });

  it('answers 404 for another project’s workflow, agent or execution, and 200 for their own', async () => {
    expect((await usageOf(member, `&workflowId=${theirsWf}`)).status).toBe(404);
    expect((await usageOf(member, '&executionId=ex_scope_theirs')).status).toBe(404);
    expect((await usageOf(member, '&agentId=agent_nobody_has')).status).toBe(404);
    expect((await usageOf(member, `&workflowId=${mineWf}`)).status).toBe(200);
    expect((await usageOf(member, '&executionId=ex_scope_mine')).body.totals.cost).toBeCloseTo(0.25);
    expect((await usageOf(admin, `&workflowId=${theirsWf}`)).status).toBe(200);
  });
});

describe('files by id', () => {
  it('serves a member their own execution’s file and 404s another project’s', async () => {
    const mine = await fileOf(member, myFile);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toBe('mine');
    expect((await fileOf(member, theirFile)).status).toBe(404);
  });

  it('serves admins everything, and files with no execution to derive an owner from stay readable', async () => {
    expect((await fileOf(admin, theirFile)).status).toBe(200);
    expect((await fileOf(member, looseFile)).status).toBe(200);
  });
});
