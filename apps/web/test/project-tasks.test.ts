/**
 * Project tasks (PC19, docs/projects-and-goals.md#tasks, contracts/w10/tasks-api.md): CRUD and roles, the checks on
 * assignees, schedules, goals and parents, atomic checkout, the wake-up tick (it only asks), approve and deny, the limits an
 * approved run obeys (allow-list, tool kinds, budget), runs that wait for a tool approval, reconciling on read, Needs you
 * items and the project's removal. Made-up data; model calls go to the fake model server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectTaskView, TaskRun } from '@/lib/shared/project-tasks';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-tasks-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const auth = await import('@/lib/server/auth');
const { getUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { agentStore } = await import('@/lib/server/agents/store');
const { canReadSession } = await import('@/lib/server/agents/session-scope');
const { credentials } = await import('@/lib/server/credentials/vault');
const { aiUsageMeter, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { createTeamProject, getProject, setMember, setHomeProject, putShare, removeProjectRows, afterRemoved, taskCounts } = await import('@/lib/server/projects/store');
const { projectView } = await import('@/lib/server/projects/views');
const { updateProjectSettings } = await import('@/lib/server/governance/scopes');
const { createGoal, setProjectGoals, deleteGoal } = await import('@/lib/server/goals/store');
const { saveBudget, incidentsOf, currentMonth } = await import('@/lib/server/budgets/store');
const { requestRun, decideRun, patchRun, getRun, setNextWake, getTask, dueTasks } = await import('@/lib/server/tasks/store');
const { taskWakeups, nextWake } = await import('@/lib/server/tasks/wakeups');
const { taskItems } = await import('@/lib/server/tasks/needs-you');
const { queryEvents } = await import('@/lib/server/audit/store');
const { TASK_LIMITS } = await import('@/lib/shared/project-tasks');

const listRoute = await import('@/app/api/projects/[id]/tasks/route');
const taskRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/route');
const checkoutRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/checkout/route');
const runsRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/runs/route');
const runRoute = await import('@/app/api/task-runs/[runId]/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels({ reply: (_provider, body) => (body.model === 'tasks-silent' ? { text: '' } : undefined) });
const ollama = fake.url.replace(/\/v1$/, '');

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

async function call(route: unknown, path: string, method: string, caller: Caller | { key: string }, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if ('key' in caller) headers.authorization = `Bearer ${caller.key}`;
  else headers.cookie = `landflow_session=${caller.session}`;
  const response = await (route as Route)(new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

let owner: Caller, padmin: Caller, ed: Caller, ed2: Caller, vw: Caller, out: Caller, qm: Caller;
let P = '';
let Q = '';
let X = ''; // the agent that works in P
let Y = ''; // an agent of Q, not available in P
let Z = ''; // an agent of Q shared to P
let W = ''; // an agent whose tool needs approval
let T = ''; // an agent with a plain tool

const list = (caller: Caller, query = '', project = P) => call(listRoute.GET, `/api/projects/${project}/tasks${query}`, 'GET', caller, undefined, { id: project });
const create = (caller: Caller, body: Record<string, unknown>, project = P) => call(listRoute.POST, `/api/projects/${project}/tasks`, 'POST', caller, body, { id: project });
const get = (caller: Caller, id: string, project = P) => call(taskRoute.GET, `/api/projects/${project}/tasks/${id}`, 'GET', caller, undefined, { id: project, taskId: id });
const patch = (caller: Caller, id: string, body: Record<string, unknown>, project = P) => call(taskRoute.PATCH, `/api/projects/${project}/tasks/${id}`, 'PATCH', caller, body, { id: project, taskId: id });
const remove = (caller: Caller, id: string, project = P) => call(taskRoute.DELETE, `/api/projects/${project}/tasks/${id}`, 'DELETE', caller, undefined, { id: project, taskId: id });
const checkout = (caller: Caller, id: string, method = 'POST', project = P) => call(method === 'POST' ? checkoutRoute.POST : checkoutRoute.DELETE, `/api/projects/${project}/tasks/${id}/checkout`, method, caller, undefined, { id: project, taskId: id });
const ask = (caller: Caller, id: string, project = P) => call(runsRoute.POST, `/api/projects/${project}/tasks/${id}/runs`, 'POST', caller, undefined, { id: project, taskId: id });
const readRun = (caller: Caller, runId: string) => call(runRoute.GET, `/api/task-runs/${runId}`, 'GET', caller, undefined, { runId });
const decide = (caller: Caller | { key: string }, runId: string, decision: string) => call(runRoute.POST, `/api/task-runs/${runId}`, 'POST', caller, { decision }, { runId });
const needsYou = async (caller: Caller) => ((await call(needsYouRoute.GET, '/api/runs/needs-you', 'GET', caller)).body.items as Array<Record<string, any>>).filter((item) => item.kind === 'task');

let counter = 0;
const newTask = async (body: Record<string, unknown> = {}, caller = ed) => {
  const made = await create(caller, { title: `Task ${++counter}`, assignee: { kind: 'agent', id: X }, ...body });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.task as ProjectTaskView;
};
/** Poll the run through the route until it is no longer starting or running. */
async function settled(runId: string, caller = ed): Promise<TaskRun> {
  for (let i = 0; i < 200; i++) {
    const run = (await readRun(caller, runId)).body.run as TaskRun;
    if (!['approved', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the run did not settle');
}
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 50 }).events.length;

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@tasks.test', 'Olive Owner', 'owner');
  padmin = await makeUser('ada@tasks.test', 'Ada', 'member');
  ed = await makeUser('eve@tasks.test', 'Eve', 'member');
  ed2 = await makeUser('ed@tasks.test', 'Ed', 'member');
  vw = await makeUser('vic@tasks.test', 'Vic', 'member');
  out = await makeUser('sam@tasks.test', 'Sam', 'member');
  qm = await makeUser('quin@tasks.test', 'Quin', 'member');
  P = createTeamProject({ name: 'Billing' }).id;
  Q = createTeamProject({ name: 'Quiet' }).id;
  setMember(P, padmin.id, 'admin');
  setMember(P, ed.id, 'editor');
  setMember(P, ed2.id, 'editor');
  setMember(P, vw.id, 'viewer');
  setMember(Q, qm.id, 'editor');
  const model = { provider: 'ollama' as const, model: 'tasks-model', baseUrl: ollama };
  const make = (name: string, home: string, extra: Record<string, unknown> = {}) => {
    const agent = agentStore.create({ name, instructions: 'Be brief.', model, ...extra });
    setHomeProject('agent', agent.id, home);
    return agentStore.publish(agent.id)!.id;
  };
  X = make('Ledger clerk', P);
  Y = make('Elsewhere', Q);
  Z = make('Visitor', Q);
  putShare('agent', Z, P, 'user');
  T = make('Echoer', P, { tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: false }] });
  W = make('Careful', P, { tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
});

afterAll(async () => {
  auth.enableTestAuth();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('tasks and who may do what', () => {
  it('an editor creates, changes and deletes; the audit says so', async () => {
    const made = await create(ed, { title: '  Reconcile the ledger  ', description: 'Compare it with the bank feed.', priority: 'high' });
    expect(made.status).toBe(201);
    const task = made.body.task as ProjectTaskView;
    expect(task).toMatchObject({ projectId: P, title: 'Reconcile the ledger', status: 'todo', priority: 'high', createdBy: ed.id, canEdit: true, canRelease: false, runs: [] });
    const changed = await patch(ed, task.id, { status: 'in_progress', description: null, priority: 'low' });
    expect(changed.status).toBe(200);
    expect(changed.body.task).toMatchObject({ status: 'in_progress', priority: 'low' });
    expect(changed.body.task.description).toBeUndefined();
    expect((await remove(ed, task.id)).status).toBe(204);
    expect((await get(ed, task.id)).status).toBe(404);
    for (const action of ['project.task.create', 'project.task.update', 'project.task.delete']) expect(audited(action), action).toBeGreaterThan(0);
  });

  it('a viewer reads and cannot write (403); a non-member gets 404 everywhere', async () => {
    const task = await newTask();
    expect((await list(vw)).body).toMatchObject({ canCreate: false });
    expect((await get(vw, task.id)).body.task).toMatchObject({ canEdit: false, canRelease: false });
    expect((await create(vw, { title: 'No' })).status).toBe(403);
    expect((await patch(vw, task.id, { title: 'No' })).status).toBe(403);
    expect((await remove(vw, task.id)).status).toBe(403);
    expect((await checkout(vw, task.id)).status).toBe(403);
    expect((await ask(vw, task.id)).status).toBe(403);
    expect((await list(out)).status).toBe(404);
    expect((await list(out)).body.error).toBe('Project not found');
    expect((await create(out, { title: 'No' })).status).toBe(404);
    expect((await get(out, task.id)).status).toBe(404);
    expect((await patch(out, task.id, { title: 'No' })).status).toBe(404);
    expect((await checkout(out, task.id)).status).toBe(404);
    expect((await ask(out, task.id)).status).toBe(404);
    expect((await readRun(out, 'trn_nope')).status).toBe(404);
    // Another project's task is not found through this project.
    expect((await get(ed, task.id, Q)).status).toBe(404);
    expect((await get(qm, task.id, Q)).status).toBe(404);
    expect((await get(owner, task.id)).status).toBe(200);
  });

  it('lists by status group, priority and update time, pages with a cursor, filters', async () => {
    const project = createTeamProject({ name: 'Ordering' }).id;
    setMember(project, ed.id, 'editor');
    const make = async (body: Record<string, unknown>) => (await create(ed, body, project)).body.task as ProjectTaskView;
    const done = await make({ title: 'done', status: 'done' });
    const low = await make({ title: 'low', priority: 'low' });
    const high = await make({ title: 'high', priority: 'high' });
    const doing = await make({ title: 'doing', status: 'in_progress' });
    const blocked = await make({ title: 'blocked', status: 'blocked', priority: 'high' });
    const all = await list(ed, '', project);
    expect(all.body.tasks.map((t: ProjectTaskView) => t.id)).toEqual([doing.id, high.id, low.id, blocked.id, done.id]);
    const first = await list(ed, '?limit=2', project);
    expect(first.body.tasks.map((t: ProjectTaskView) => t.id)).toEqual([doing.id, high.id]);
    const second = await list(ed, `?limit=2&cursor=${first.body.nextCursor}`, project);
    expect(second.body.tasks.map((t: ProjectTaskView) => t.id)).toEqual([low.id, blocked.id]);
    const third = await list(ed, `?limit=2&cursor=${second.body.nextCursor}`, project);
    expect(third.body.tasks.map((t: ProjectTaskView) => t.id)).toEqual([done.id]);
    expect(third.body.nextCursor).toBeUndefined();
    expect((await list(ed, '?status=done', project)).body.tasks.map((t: ProjectTaskView) => t.id)).toEqual([done.id]);
    expect((await list(ed, '?limit=0', project)).status).toBe(400);
    expect((await list(ed, '?cursor=junk', project)).status).toBe(400);
    await patch(ed, low.id, { assignee: { kind: 'person', id: ed.id } }, project);
    await checkout(ed, high.id, 'POST', project);
    expect((await list(ed, '?mine=1', project)).body.tasks.map((t: ProjectTaskView) => t.id).sort()).toEqual([high.id, low.id].sort());
  });
});

describe('what a task may name', () => {
  it('an agent must be available in the project and allowed by its rules', async () => {
    const unavailable = await create(ed, { title: 'A', assignee: { kind: 'agent', id: Y } });
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.error).toBe('“Elsewhere” isn\'t available in project “Billing”');
    expect((await create(ed, { title: 'A', assignee: { kind: 'agent', id: 'agt_gone' } })).status).toBe(400);
    expect((await create(ed, { title: 'A', assignee: { kind: 'agent', id: Z } })).status).toBe(201);
    updateProjectSettings(P, { agents: { mode: 'allow', ids: [X] } });
    try {
      const refused = await create(ed, { title: 'A', assignee: { kind: 'agent', id: Z } });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('“Visitor” isn\'t allowed in project “Billing” (Project settings → Agents)');
      expect((await create(ed, { title: 'A', assignee: { kind: 'agent', id: X } })).status).toBe(201);
    } finally {
      updateProjectSettings(P, { agents: { mode: 'off', ids: [] } });
    }
  });

  it('a person needs a role in the project; a wake-up only on an agent task', async () => {
    const stranger = await create(ed, { title: 'P', assignee: { kind: 'person', id: out.id } });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toBe('Sam isn\'t a member of this project');
    expect((await create(ed, { title: 'P', assignee: { kind: 'person', id: vw.id } })).status).toBe(201);
    for (const body of [{ title: 'W', assignee: { kind: 'person', id: ed.id }, wake: { cron: '0 9 * * *' } }, { title: 'W', wake: { cron: '0 9 * * *' } }]) {
      const refused = await create(ed, body);
      expect([refused.status, refused.body.error]).toEqual([400, 'Only an agent task has a wake-up schedule']);
    }
    const task = await newTask({ wake: { cron: '0 9 * * *' } });
    expect(task.nextWakeAt).toBeTruthy();
    // Changing the assignee to a person while the schedule stays is refused; clearing it in the same patch is fine.
    expect((await patch(ed, task.id, { assignee: { kind: 'person', id: ed.id } })).status).toBe(400);
    const moved = await patch(ed, task.id, { assignee: { kind: 'person', id: ed.id }, wake: null });
    expect(moved.status).toBe(200);
    expect(moved.body.task.nextWakeAt).toBeUndefined();
  });

  it('a schedule has five fields, parses, and fires within a year', async () => {
    const never = await create(ed, { title: 'N', assignee: { kind: 'agent', id: X }, wake: { cron: '0 0 31 2 *' } });
    expect([never.status, never.body.error]).toEqual([400, 'This schedule never fires']);
    const six = await create(ed, { title: 'N', assignee: { kind: 'agent', id: X }, wake: { cron: '0 0 9 * * *' } });
    expect([six.status, six.body.error]).toEqual([400, 'A wake-up schedule has five fields']);
    expect((await create(ed, { title: 'N', assignee: { kind: 'agent', id: X }, wake: { cron: '61 * * * *' } })).status).toBe(400);
    const ok = await newTask({ wake: { cron: '*/5 * * * *' } });
    expect(Date.parse(ok.nextWakeAt!)).toBeGreaterThan(Date.now());
    // done, cancelled and blocked clear the next wake-up; todo sets it again.
    for (const status of ['done', 'blocked', 'cancelled']) expect((await patch(ed, ok.id, { status })).body.task.nextWakeAt, status).toBeUndefined();
    expect((await patch(ed, ok.id, { status: 'todo' })).body.task.nextWakeAt).toBeTruthy();
  });

  it('a goal is one the project serves or its own; a parent is a top-level task of the same project', async () => {
    const company = createGoal({ title: 'Close invoices in two days', level: 'company' });
    expect((await create(ed, { title: 'G', goalId: company.id })).body.error).toBe('That goal isn\'t one of this project\'s goals');
    setProjectGoals(P, [company.id]);
    const withGoal = await create(ed, { title: 'G', goalId: company.id });
    expect(withGoal.body.task).toMatchObject({ goalId: company.id, goalTitle: 'Close invoices in two days' });
    const own = createGoal({ title: 'Own', level: 'project', projectId: P });
    expect((await create(ed, { title: 'G', goalId: own.id })).status).toBe(201);
    expect((await create(ed, { title: 'G', goalId: 'goal_nope' })).status).toBe(400);

    const parent = await newTask();
    const child = await create(ed, { title: 'Child', parentId: parent.id });
    expect(child.body.task.parentId).toBe(parent.id);
    const message = 'A task\'s parent is a top-level task of the same project';
    expect((await create(ed, { title: 'Grandchild', parentId: child.body.task.id })).body.error).toBe(message);
    expect((await patch(ed, parent.id, { parentId: parent.id })).body.error).toBe(message);
    expect((await patch(ed, parent.id, { parentId: child.body.task.id })).body.error).toBe(message);
    const elsewhere = (await create(qm, { title: 'Q task' }, Q)).body.task;
    expect((await create(ed, { title: 'X', parentId: elsewhere.id })).body.error).toBe(message);
    // A task with sub-tasks cannot become a sub-task; deleting a parent frees its sub-tasks.
    const other = await newTask();
    expect((await patch(ed, parent.id, { parentId: other.id })).body.error).toBe(message);
    await remove(ed, parent.id);
    expect((await get(ed, child.body.task.id)).body.task.parentId).toBeUndefined();
  });

  it('a project has at most 1000 tasks', async () => {
    const project = createTeamProject({ name: 'Crowded' }).id;
    setMember(project, ed.id, 'editor');
    const at = new Date().toISOString();
    database().transaction(() => {
      for (let i = 0; i < TASK_LIMITS.perProject; i++) database().insertNew('project_tasks', { id: `tsk_fill${i}`, project_id: project, title: `t${i}`, status: 'todo', priority: 'normal', created_at: at, updated_at: at });
    });
    const refused = await create(ed, { title: 'One more' }, project);
    expect([refused.status, refused.body.error]).toEqual([400, 'A project has at most 1000 tasks']);
  });
});

describe('checkout', () => {
  it('two at once: one gets it, the other 409 TaskCheckedOut', async () => {
    const task = await newTask();
    const results = await Promise.all([checkout(ed, task.id), checkout(ed2, task.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.code).toBe('task_checked_out');
    expect(refused.body.error).toMatch(/^Checked out by (Eve|Ed)$/);
    const holder = results.find((r) => r.status === 200)!;
    expect(holder.body.task.checkedOutByName).toMatch(/^(Eve|Ed)$/);
  });

  it('checking out your own again is fine; the holder or an admin releases, another editor cannot', async () => {
    const task = await newTask();
    expect((await checkout(ed, task.id)).status).toBe(200);
    expect((await checkout(ed, task.id)).body.task.checkedOutBy).toBe(ed.id);
    const refused = await checkout(ed2, task.id, 'DELETE');
    expect(refused.status).toBe(403);
    expect((await get(ed2, task.id)).body.task).toMatchObject({ canRelease: false, checkedOutBy: ed.id });
    expect((await get(padmin, task.id)).body.task.canRelease).toBe(true);
    const released = await checkout(padmin, task.id, 'DELETE');
    expect(released.status).toBe(200);
    expect(released.body.task.checkedOutBy).toBeUndefined();
    expect((await checkout(ed2, task.id)).status).toBe(200);
    expect((await checkout(ed2, task.id, 'DELETE')).status).toBe(200);
    expect(audited('project.task.checkout')).toBeGreaterThan(0);
    expect(audited('project.task.release')).toBeGreaterThan(0);
  });
});

describe('nextWake', () => {
  const at = (iso: string) => new Date(iso);
  it('crosses midnight in the zone, not in UTC', () => {
    expect(nextWake('0 0 * * *', at('2026-06-15T06:59:00Z'), 'America/Los_Angeles')?.toISOString()).toBe('2026-06-15T07:00:00.000Z');
    expect(nextWake('0 0 * * *', at('2026-06-15T09:59:00Z'), 'Pacific/Kiritimati')?.toISOString()).toBe('2026-06-15T10:00:00.000Z');
    expect(nextWake('0 0 * * *', at('2026-06-15T00:00:00Z'), 'UTC')?.toISOString()).toBe('2026-06-16T00:00:00.000Z');
  });

  it('follows a DST change: a wall-clock hour that does not exist is skipped, the day after counts', () => {
    // 2026-03-08 02:30 does not exist in Los Angeles: the next 02:30 is the 9th (PDT, UTC-7).
    expect(nextWake('30 2 * * *', at('2026-03-07T12:00:00Z'), 'America/Los_Angeles')?.toISOString()).toBe('2026-03-09T09:30:00.000Z');
    // 09:00 on the morning the clocks went back (PST, UTC-8), and the one before (PDT, UTC-7).
    expect(nextWake('0 9 * * *', at('2026-10-31T20:00:00Z'), 'America/Los_Angeles')?.toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(nextWake('0 9 * * *', at('2026-10-30T20:00:00Z'), 'America/Los_Angeles')?.toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('steps by minutes, lists, ranges and weekdays; the next minute is after `after`, never equal', () => {
    expect(nextWake('*/15 * * * *', at('2026-06-15T10:00:00Z'), 'UTC')?.toISOString()).toBe('2026-06-15T10:15:00.000Z');
    expect(nextWake('0 9 * * 1-5', at('2026-06-13T10:00:00Z'), 'UTC')?.toISOString()).toBe('2026-06-15T09:00:00.000Z'); // Saturday to Monday
    expect(nextWake('0 0 1 1 *', at('2026-06-01T00:00:00Z'), 'UTC')?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('gives up on a schedule that never fires, quickly, and refuses six fields', () => {
    const started = Date.now();
    expect(nextWake('0 0 31 2 *', new Date(), 'UTC')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(() => nextWake('0 0 9 * * *', new Date(), 'UTC')).toThrow('five fields');
    expect(() => nextWake('x * * * *', new Date(), 'UTC')).toThrow();
  });
});

describe('the wake-up tick only asks', () => {
  it('a due task gets one requested run; a second tick and a click merge into it; the schedule moves on', async () => {
    const task = await newTask({ wake: { cron: '*/5 * * * *' } });
    const calls = fake.requests.length;
    const later = new Date(Date.now() + 10 * 60_000);
    expect(taskWakeups.tick(later)).toBeGreaterThanOrEqual(1);
    const runs = (await get(ed, task.id)).body.task.runs as TaskRun[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'requested', reason: 'wake', agentId: X });
    const moved = getTask(task.id)!;
    expect(Date.parse(moved.nextWakeAt!)).toBeGreaterThan(later.getTime());
    // The schedule is due again: still the one run.
    setNextWake(task.id, new Date(Date.now() - 1000).toISOString());
    taskWakeups.tick(new Date(later.getTime() + 6 * 60_000));
    const clicked = await ask(ed, task.id);
    expect([clicked.status, clicked.body.merged, clicked.body.run.id]).toEqual([200, true, runs[0].id]);
    expect(((await get(ed, task.id)).body.task.runs as TaskRun[]).filter((run) => run.status === 'requested')).toHaveLength(1);
    expect(getTask(task.id)!.nextWakeAt).not.toBe(moved.nextWakeAt);
    // Nothing ran: no model was called.
    expect(fake.requests.length).toBe(calls);
  });

  it('a person task, a finished task and a task whose agent is unavailable never get a request', async () => {
    const person = await newTask({ assignee: { kind: 'person', id: ed.id } });
    expect((await ask(ed, person.id)).body.error).toBe('Only an agent task runs');
    const at = new Date().toISOString();
    database().upsert('project_tasks', { id: 'tsk_person_due', project_id: P, title: 'p', status: 'todo', priority: 'normal', assignee_kind: 'person', assignee_id: ed.id, wake_cron: '* * * * *', next_wake_at: '2020-01-01T00:00:00.000Z', created_at: at, updated_at: at });
    expect(dueTasks(new Date().toISOString(), 200).map((t) => t.id)).not.toContain('tsk_person_due');
    const done = await newTask({ wake: { cron: '* * * * *' } });
    await patch(ed, done.id, { status: 'done' });
    expect((await ask(ed, done.id)).body.error).toBe('Reopen the task first');
    // The agent leaves the project after the task was made: the wake-up does not ask, and its schedule moves on so it holds no slot.
    const gone = await newTask({ wake: { cron: '* * * * *' }, assignee: { kind: 'agent', id: Z } });
    updateProjectSettings(P, { agents: { mode: 'allow', ids: [X] } });
    try {
      setNextWake(gone.id, '2020-01-01T00:00:00.000Z');
      taskWakeups.tick();
      expect(((await get(ed, gone.id)).body.task.runs as TaskRun[]).length).toBe(0);
      expect(Date.parse(getTask(gone.id)!.nextWakeAt!)).toBeGreaterThan(Date.now() - 1000);
    } finally {
      updateProjectSettings(P, { agents: { mode: 'off', ids: [] } });
    }
  });

  it('LANDFLOW_TASK_WAKEUP_SECONDS=0 starts no timer; a number starts one', () => {
    process.env.LANDFLOW_TASK_WAKEUP_SECONDS = '0';
    taskWakeups.stop();
    taskWakeups.start();
    expect(taskWakeups.running).toBe(false);
    process.env.LANDFLOW_TASK_WAKEUP_SECONDS = '3600';
    taskWakeups.start();
    expect(taskWakeups.running).toBe(true);
    taskWakeups.stop();
    expect(taskWakeups.running).toBe(false);
    delete process.env.LANDFLOW_TASK_WAKEUP_SECONDS;
  });
});

describe('approve runs the agent through the project’s limits', () => {
  it('approve answers 202 and the run ends done with the reply, in a session that belongs to the project', async () => {
    const goal = createGoal({ title: 'Own goal for the run', level: 'project', projectId: P });
    const task = await newTask({ title: 'Reconcile the October ledger', description: 'Compare it with the bank feed.', goalId: goal.id, priority: 'high' });
    const asked = await ask(ed, task.id);
    expect([asked.status, asked.body.merged, asked.body.run.status, asked.body.run.requestedBy]).toEqual([201, false, 'requested', ed.id]);
    const before = fake.requests.length;
    const approved = await decide(ed2, asked.body.run.id, 'approve');
    expect([approved.status, approved.body.run.status, approved.body.run.decidedBy]).toEqual([202, 'approved', ed2.id]);
    const run = await settled(asked.body.run.id);
    expect(run).toMatchObject({ status: 'done', sessionId: expect.stringMatching(/^as_/) });
    expect(run.reply).toContain('Reconcile the October ledger');
    expect(run.reply).toContain('Compare it with the bank feed.');
    expect(fake.requests.length).toBeGreaterThan(before);
    const session = agentStore.getSession(run.sessionId!)!;
    expect(session).toMatchObject({ source: 'task', userId: `task:${task.id}`, agentId: X });
    expect(session.context).toMatchObject({ projectId: P, goalId: goal.id });
    expect(session.context?.text).toContain('project task “Reconcile the October ledger”');
    const ann = getUser(ed.id)!;
    expect(canReadSession({ id: ann.id, role: ann.role }, session)).toBe(true);
    const outsider = getUser(qm.id)!;
    expect(canReadSession({ id: outsider.id, role: outsider.role }, session)).toBe(false);
    expect(audited('project.task.run_decided')).toBeGreaterThan(0);
  });

  it('a second decision is 409; deny settles it and nothing runs; a viewer and an API key are refused', async () => {
    const task = await newTask();
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    expect((await decide(vw, run.id, 'deny')).status).toBe(403);
    expect((await decide(out, run.id, 'deny')).status).toBe(404);
    const key = createApiKey(getUser(ed.id)!, { label: 'ci', scopes: ['workflows:write'] }).token;
    const viaKey = await decide({ key }, run.id, 'approve');
    expect([viaKey.status, viaKey.body.error]).toEqual([403, 'API keys can’t do this; sign in instead']);
    expect((await readRun(ed, run.id)).body.run.status).toBe('requested');
    const before = fake.requests.length;
    const denied = await decide(ed, run.id, 'deny');
    expect([denied.status, denied.body.run.status, denied.body.run.decidedBy]).toEqual([200, 'denied', ed.id]);
    const again = await decide(ed2, run.id, 'approve');
    expect([again.status, again.body.error]).toEqual([409, 'Already denied']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.requests.length).toBe(before);
    expect((await decide(ed, run.id, 'maybe')).status).toBe(400);
  });

  it('lesson 15: a project allow-list changed after the request makes approve 409 with no model call', async () => {
    const task = await newTask({ assignee: { kind: 'agent', id: Z } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    updateProjectSettings(P, { agents: { mode: 'allow', ids: [X] } });
    try {
      const before = fake.requests.length;
      const refused = await decide(ed, run.id, 'approve');
      expect([refused.status, refused.body.error]).toEqual([409, '“Visitor” isn\'t allowed in project “Billing” (Project settings → Agents)']);
      expect((await readRun(ed, run.id)).body.run.status).toBe('requested');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fake.requests.length).toBe(before);
    } finally {
      updateProjectSettings(P, { agents: { mode: 'off', ids: [] } });
    }
    // Reassigned meanwhile: approving a run for an agent the task no longer has is refused too.
    await patch(ed, task.id, { assignee: { kind: 'agent', id: X } });
    expect((await decide(ed, run.id, 'approve')).status).toBe(409);
  });

  it('an agent that is not published, or gone, is refused at approve', async () => {
    const draft = agentStore.create({ name: 'Draft only', instructions: 'x', model: { provider: 'ollama', model: 'm', baseUrl: ollama } });
    setHomeProject('agent', draft.id, P);
    const at = new Date().toISOString();
    database().upsert('project_tasks', { id: 'tsk_draft', project_id: P, title: 'd', status: 'todo', priority: 'normal', assignee_kind: 'agent', assignee_id: draft.id, created_at: at, updated_at: at });
    const run = requestRun({ id: 'tsk_draft', projectId: P }, draft.id, 'manual', ed.id).run;
    const refused = await decide(ed, run.id, 'approve');
    expect([refused.status, refused.body.error]).toEqual([409, 'Publish “Draft only” before it works on tasks']);
    agentStore.delete(draft.id);
    expect((await decide(ed, run.id, 'approve')).status).toBe(409);
  });

  it('lesson 15: a project that withholds node tools offers the run none', async () => {
    const task = await newTask({ assignee: { kind: 'agent', id: T } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    updateProjectSettings(P, { agentTools: { mode: 'allow', kinds: ['mcp'] } });
    try {
      expect((await decide(ed, run.id, 'approve')).status).toBe(202);
      expect((await settled(run.id)).status).toBe('done');
      const sent = fake.last('/api/chat')!.body;
      expect(sent.tools ?? []).toEqual([]);
    } finally {
      updateProjectSettings(P, { agentTools: { mode: 'off', kinds: [] } });
    }
    // With the project's kinds off again, the same agent's tool is offered and the run uses it.
    const again = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, again.id, 'approve');
    expect((await settled(again.id)).status).toBe('done');
    expect(fake.last('/api/chat')!.body.tools?.length).toBeGreaterThan(0);
  });

  it('lesson 15: a hard-stop budget ends the run failed with the cap message and opens the stop', async () => {
    savePriceOverrides([{ provider: 'openai', model: 'gpt-task-priced', input: 1000, output: 1000 }]);
    aiUsageMeter().invalidatePrices();
    const key = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: fake.url } });
    setHomeProject('credential', key.id, P);
    const paid = agentStore.create({ name: 'Paid clerk', instructions: 'Be brief.', model: { provider: 'openai', model: 'gpt-task-priced', credential: { id: key.id, name: key.name } } });
    setHomeProject('agent', paid.id, P);
    agentStore.publish(paid.id);
    saveBudget({ projectId: P, monthlyUsd: 0.01, warnPercent: 80, hardStop: true, updatedAt: new Date().toISOString() });
    aiUsageMeter().invalidateBudgets();
    try {
      const task = await newTask({ assignee: { kind: 'agent', id: paid.id } });
      const run = (await ask(ed, task.id)).body.run as TaskRun;
      await decide(ed, run.id, 'approve');
      const first = await settled(run.id);
      expect(first.status).toBe('failed');
      expect(first.error).toContain('Billing');
      expect(incidentsOf(P, currentMonth(aiUsageMeter())).filter((i) => i.kind === 'stop')).toHaveLength(1);
      // The next one is refused before any model call.
      const next = (await ask(ed, task.id)).body.run as TaskRun;
      const calls = fake.requests.length;
      await decide(ed, next.id, 'approve');
      expect((await settled(next.id)).status).toBe('failed');
      expect(fake.requests.length).toBe(calls);
    } finally {
      database().delete('project_budgets', { project_id: P });
      for (const row of database().all<{ id: string }>('SELECT id FROM project_budget_incidents WHERE project_id = ?', P)) database().delete('project_budget_incidents', { id: row.id });
      aiUsageMeter().invalidateBudgets();
    }
  });
});

describe('a tool that needs approval', () => {
  it('leaves the run waiting; Needs you shows it with the session link, and the settled run leaves the list', async () => {
    const task = await newTask({ title: 'Careful work', assignee: { kind: 'agent', id: W } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, run.id, 'approve');
    const waiting = await settled(run.id).catch(() => undefined);
    void waiting;
    let current = (await readRun(ed, run.id)).body.run as TaskRun;
    for (let i = 0; i < 200 && current.status !== 'waiting'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = (await readRun(ed, run.id)).body.run as TaskRun;
    }
    expect(current.status).toBe('waiting');
    const items = (await needsYou(ed)).filter((item) => item.taskRunId === run.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'task',
      projectId: P,
      taskId: task.id,
      taskRunStatus: 'waiting',
      title: '“Careful” waits for a tool approval on “Careful work”',
      href: `/agents/${W}?tab=sessions&session=${current.sessionId}`,
      canDecide: false,
    });
    // The person decides in the session; the next read settles the run and the item goes.
    const session = agentStore.getSession(current.sessionId!)!;
    session.status = 'idle';
    session.timeline.push({ id: 'a_done', type: 'assistant', text: 'All done after approval', at: new Date().toISOString() });
    agentStore.saveSession(session);
    expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'done', reply: 'All done after approval' });
    expect((await needsYou(ed)).filter((item) => item.taskRunId === run.id)).toHaveLength(0);
  });

  it('a waiting run whose session ends on a Stopped notice reads failed with it', async () => {
    const task = await newTask({ title: 'Budget stop', assignee: { kind: 'agent', id: W } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, run.id, 'approve');
    let current = (await readRun(ed, run.id)).body.run as TaskRun;
    for (let i = 0; i < 200 && current.status !== 'waiting'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = (await readRun(ed, run.id)).body.run as TaskRun;
    }
    expect(current.status).toBe('waiting');
    const session = agentStore.getSession(current.sessionId!)!;
    session.status = 'idle';
    session.timeline.push({ id: 'n_stop', type: 'notice', message: 'Stopped: the project budget is spent', at: new Date().toISOString() });
    agentStore.saveSession(session);
    expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'failed', error: 'Stopped: the project budget is spent' });
  });
});

describe('reconciling on read', () => {
  const approve = (taskId: string) => {
    const { run } = requestRun({ id: taskId, projectId: P }, X, 'manual', ed.id);
    return decideRun(run.id, 'approve', ed.id)!;
  };
  const age = (runId: string, minutes: number) => {
    const row = database().get<Record<string, string>>('SELECT * FROM task_runs WHERE id = ?', runId)!;
    const old = new Date(Date.now() - minutes * 60_000).toISOString();
    database().upsert('task_runs', { ...row, decided_at: old, requested_at: old });
  };

  it('a running run whose session finished in another process reads done; an errored one reads failed', async () => {
    const task = await newTask();
    const run = approve(task.id);
    const session = { id: 'as_other_done', agentId: X, agentName: 'Ledger clerk', source: 'task', userId: `task:${task.id}`, title: 't', status: 'idle', version: 1, messages: [], timeline: [{ id: 'a1', type: 'assistant', text: 'Finished elsewhere', at: new Date().toISOString() }], usage: { inputTokens: 0, outputTokens: 0 }, traceIds: [], context: { projectId: P }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    agentStore.saveSession(session as never);
    patchRun(run.id, { status: 'running', sessionId: session.id });
    expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'done', reply: 'Finished elsewhere' });
    const second = approve((await newTask()).id);
    agentStore.saveSession({ ...session, id: 'as_other_failed', status: 'error', timeline: [{ id: 'e1', type: 'error', message: 'The model refused', at: new Date().toISOString() }] } as never);
    patchRun(second.id, { status: 'running', sessionId: 'as_other_failed' });
    expect((await readRun(ed, second.id)).body.run).toMatchObject({ status: 'failed', error: 'The model refused' });
  });

  it('a run whose session ended idle without a final answer reads failed (step limit, cancel)', async () => {
    const at = new Date().toISOString();
    const base = { agentId: X, agentName: 'Ledger clerk', source: 'task', title: 't', status: 'idle', version: 1, messages: [], usage: { inputTokens: 0, outputTokens: 0 }, traceIds: [], context: { projectId: P }, createdAt: at, updatedAt: at };
    const tool = { id: 't1', type: 'tool', name: 'x' };
    const cases: Array<[string, unknown[], string]> = [
      ['as_step', [{ id: 'u', type: 'user', text: 'go', at }, tool, { id: 'n', type: 'notice', message: 'Stopped after 3 iterations without a final answer (Settings → Max iterations).', at }], 'Stopped after 3 iterations without a final answer (Settings → Max iterations).'],
      ['as_cancel', [{ id: 'u', type: 'user', text: 'go', at }, tool], 'The run stopped before a final answer'],
    ];
    for (const [id, timeline, error] of cases) {
      const run = approve((await newTask()).id);
      agentStore.saveSession({ ...base, id, userId: `task:${run.taskId}`, timeline } as never);
      patchRun(run.id, { status: 'running', sessionId: id });
      expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'failed', error });
    }
  });

  it('an approved run with no session after 2 minutes, and a running one nobody runs, read failed after a restart', async () => {
    const fresh = approve((await newTask()).id);
    expect((await readRun(ed, fresh.id)).body.run.status).toBe('approved');
    age(fresh.id, 3);
    expect((await readRun(ed, fresh.id)).body.run).toMatchObject({ status: 'failed', error: 'Landflow restarted before the run finished' });
    const lost = approve((await newTask()).id);
    patchRun(lost.id, { status: 'running', sessionId: 'as_never_saved' });
    age(lost.id, 3);
    expect((await readRun(ed, lost.id)).body.run.status).toBe('failed');
    // The tick settles stale runs too.
    const stale = approve((await newTask()).id);
    age(stale.id, 15);
    taskWakeups.tick();
    expect(getRun(stale.id)!.status).toBe('failed');
  });
});

describe('Needs you', () => {
  it('an editor sees the requested item with canDecide; a viewer and a non-member see none; an admin sees it', async () => {
    const task = await newTask({ title: 'Reconcile the October ledger', wake: { cron: '0 9 * * 1-5' } });
    expect(taskWakeups.tick(new Date(Date.now() + 7 * 86_400_000))).toBeGreaterThanOrEqual(1);
    const run = ((await get(ed, task.id)).body.task.runs as TaskRun[])[0];
    const mine = (await needsYou(ed)).find((item) => item.taskRunId === run.id)!;
    expect(mine).toEqual({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'task',
      projectId: P,
      taskId: task.id,
      taskRunId: run.id,
      taskRunStatus: 'requested',
      title: '“Ledger clerk” wants to work on “Reconcile the October ledger”',
      detail: 'Wake-up (0 9 * * 1-5)',
      href: `/projects/${P}?tab=tasks&task=${task.id}`,
      canDecide: true,
      since: run.requestedAt,
    });
    expect((await needsYou(vw)).filter((item) => item.taskRunId === run.id)).toHaveLength(0);
    expect((await needsYou(out)).filter((item) => item.taskRunId === run.id)).toHaveLength(0);
    expect((await needsYou(qm)).filter((item) => item.taskRunId === run.id)).toHaveLength(0);
    expect((await needsYou(padmin)).some((item) => item.taskRunId === run.id)).toBe(true);
    expect((await needsYou(owner)).some((item) => item.taskRunId === run.id)).toBe(true);
    // A person's ask names them.
    const asked = (await ask(ed2, (await newTask()).id)).body.run as TaskRun;
    expect((await needsYou(ed)).find((item) => item.taskRunId === asked.id)?.detail).toBe('Asked by Ed');
    // Deciding takes it out of the list.
    await decide(ed, run.id, 'deny');
    expect((await needsYou(ed)).some((item) => item.taskRunId === run.id)).toBe(false);
  });
});

describe('Needs you under load and after changes', () => {
  it('open runs of other projects do not push a person’s own item past the cap', async () => {
    const mine = await newTask({ title: 'Mine among many' });
    const myRun = (await ask(ed, mine.id)).body.run as TaskRun;
    // Newer, open runs in a project the person is not in: more of them than the cap.
    for (let i = 0; i < 6; i++) {
      const at = new Date().toISOString();
      const id = `tsk_load_${i}`;
      database().upsert('project_tasks', { id, project_id: Q, title: `Load ${i}`, status: 'todo', priority: 'normal', assignee_kind: 'agent', assignee_id: Y, created_at: at, updated_at: at });
      requestRun({ id, projectId: Q }, Y, 'manual', qm.id);
    }
    const actor = { id: ed.id, role: getUser(ed.id)!.role };
    expect(taskItems(actor, 3).some((item) => item.taskRunId === myRun.id)).toBe(true);
    expect(taskItems(actor, 3).every((item) => item.projectId === P)).toBe(true);
    // The people of the other project still see theirs, and the instance owner sees every project's.
    expect(taskItems({ id: qm.id, role: getUser(qm.id)!.role }, 3).every((item) => item.projectId === Q)).toBe(true);
    expect(taskItems({ id: owner.id, role: 'owner' }, 500).filter((item) => item.projectId === Q)).toHaveLength(6);
  });

  it('a request whose agent was deleted leaves Needs you, reads denied, and cannot be approved', async () => {
    const doomed = agentStore.create({ name: 'Short lived', instructions: 'x', model: { provider: 'ollama', model: 'm', baseUrl: ollama } });
    setHomeProject('agent', doomed.id, P);
    agentStore.publish(doomed.id);
    const task = await newTask({ title: 'Orphaned', assignee: { kind: 'agent', id: doomed.id } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    expect((await needsYou(ed)).some((item) => item.taskRunId === run.id)).toBe(true);
    agentStore.delete(doomed.id);
    expect((await needsYou(ed)).some((item) => item.taskRunId === run.id)).toBe(false);
    expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'denied', error: 'The agent was deleted before this was approved' });
    expect((await decide(ed, run.id, 'approve')).status).toBe(409);
  });

  it('Deny still works on such a request before anything has read it', async () => {
    const doomed = agentStore.create({ name: 'Short lived two', instructions: 'x', model: { provider: 'ollama', model: 'm', baseUrl: ollama } });
    setHomeProject('agent', doomed.id, P);
    agentStore.publish(doomed.id);
    const task = await newTask({ title: 'Orphaned two', assignee: { kind: 'agent', id: doomed.id } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    agentStore.delete(doomed.id);
    expect((await decide(ed, run.id, 'deny')).body.run.status).toBe('denied');
  });
});

describe('a final turn with no text', () => {
  it('a run whose last model turn is empty fails the same way the reconciler reads its session', async () => {
    const silent = agentStore.create({ name: 'Silent clerk', instructions: 'x', model: { provider: 'ollama', model: 'tasks-silent', baseUrl: ollama } });
    setHomeProject('agent', silent.id, P);
    agentStore.publish(silent.id);
    const task = await newTask({ assignee: { kind: 'agent', id: silent.id } });
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, run.id, 'approve');
    const done = await settled(run.id);
    expect(done).toMatchObject({ status: 'failed', error: 'The run stopped before a final answer' });
    // Read again from its session: the same answer.
    expect((await readRun(ed, run.id)).body.run).toMatchObject({ status: 'failed', error: 'The run stopped before a final answer' });
  });
});

describe('a task’s goal that is gone', () => {
  it('deleting the goal clears the task’s link', async () => {
    const goal = createGoal({ title: 'Short lived goal', level: 'project', projectId: P });
    const task = await newTask({ goalId: goal.id });
    expect(deleteGoal(goal.id)).toBe(true);
    const read = (await get(ed, task.id)).body.task as ProjectTaskView;
    expect(read.goalId).toBeUndefined();
    expect(read.goalTitle).toBeUndefined();
  });

  it('a goal unlinked from the project is not passed to the run', async () => {
    const company = createGoal({ title: 'Company goal to unlink', level: 'company' });
    setProjectGoals(P, [company.id]);
    const task = await newTask({ goalId: company.id });
    setProjectGoals(P, []);
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, run.id, 'approve');
    const done = await settled(run.id);
    expect(done.status).toBe('done');
    // The run falls back to the project's own primary goal, never the dead link.
    expect(agentStore.getSession(done.sessionId!)!.context?.goalId).not.toBe(company.id);
    // Still linked: it is passed on.
    setProjectGoals(P, [company.id]);
    const again = (await ask(ed, task.id)).body.run as TaskRun;
    await decide(ed, again.id, 'approve');
    expect(agentStore.getSession((await settled(again.id)).sessionId!)!.context?.goalId).toBe(company.id);
    setProjectGoals(P, []);
  });
});

describe('deleting', () => {
  it('a task takes its runs with it, and a run in progress then saves nothing', async () => {
    const task = await newTask();
    const run = (await ask(ed, task.id)).body.run as TaskRun;
    expect((await remove(ed, task.id)).status).toBe(204);
    expect(getRun(run.id)).toBeUndefined();
    expect(patchRun(run.id, { status: 'done', reply: 'late' })).toBeUndefined();
    expect(getRun(run.id)).toBeUndefined();
  });

  it('the project’s removal deletes its tasks and runs in the same transaction', async () => {
    const project = createTeamProject({ name: 'Doomed' }).id;
    const other = createTeamProject({ name: 'Survivor' }).id;
    setMember(project, ed.id, 'editor');
    setMember(other, ed.id, 'editor');
    setHomeProject('agent', X, P);
    putShare('agent', X, project, 'user');
    putShare('agent', X, other, 'user');
    const mine = (await create(ed, { title: 'Doomed task', assignee: { kind: 'agent', id: X } }, project)).body.task as ProjectTaskView;
    const kept = (await create(ed, { title: 'Kept task', assignee: { kind: 'agent', id: X } }, other)).body.task as ProjectTaskView;
    const run = (await ask(ed, mine.id, project)).body.run as TaskRun;
    await ask(ed, kept.id, other);
    // The project view counts its tasks, so the delete dialog can say they go with it (counts holds only what moves).
    const view = projectView(getProject(project)!, getUser(ed.id)!);
    expect(view.taskCount).toBe(1);
    expect(view.counts).toEqual({});
    expect(projectView(getProject(createTeamProject({ name: 'Taskless' }).id)!, getUser(ed.id)!).taskCount).toBeUndefined();
    removeProjectRows(project);
    await afterRemoved;
    expect(getTask(mine.id)).toBeUndefined();
    expect(getRun(run.id)).toBeUndefined();
    expect(database().all('SELECT id FROM task_runs WHERE project_id = ?', project)).toEqual([]);
    expect(getTask(kept.id)).toBeDefined();
    expect(database().all('SELECT id FROM task_runs WHERE project_id = ?', other)).toHaveLength(1);
    expect(taskCounts().get(project)).toBeUndefined();
    expect(taskCounts().get(other)).toBe(1);
  });
});
