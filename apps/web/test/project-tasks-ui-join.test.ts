/**
 * The join of project tasks (contracts/w10/tasks-api.md): PC19's real routes (create, checkout, request, decide, list, Needs
 * you) with PC20's client helpers (`createTask`, `checkoutTask`, `decideTaskRun`, `tasksUrl`), its pure model
 * (`groupTasks`, `fieldOfError`, `presetCron`), `actionsFor` and the Needs you rows. Each side tested itself with fakes; here
 * the helpers' requests go to the real handlers and the agent runs on the fake model server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/client/api';
import { decideTaskRun, type NeedsYouRow } from '../src/lib/client/run-trace';
import { actionsFor } from '../src/components/run-trace/needs-you-actions';
import { BudgetRow, TaskRow as NeedsYouTaskRow } from '../src/components/run-trace/run-lists';
import { presetCron } from '../src/components/projects/tasks/schedule';
import { fieldOfError, groupTasks } from '../src/components/projects/tasks/tasks-model';
import { askToRun, checkoutTask, createTask, fetchTask, releaseTask, tasksUrl } from '../src/components/projects/tasks/use-tasks';
import type { ProjectTasksResponse, ProjectTaskView, TaskRun } from '../src/lib/shared/project-tasks';
import { startFakeModels } from './fake-ai-services';
import { routeFetch } from './join-fetch';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-tasks-join-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { agentStore } = await import('@/lib/server/agents/store');
const { canReadSession } = await import('@/lib/server/agents/session-scope');
const projects = await import('@/lib/server/projects');
const { setNextWake } = await import('@/lib/server/tasks/store');
const { taskWakeups } = await import('@/lib/server/tasks/wakeups');
const { saveBudget, openIncident, currentMonth } = await import('@/lib/server/budgets/store');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { database } = await import('@/lib/server/db');
const listRoute = await import('@/app/api/projects/[id]/tasks/route');
const taskRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/route');
const checkoutRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/checkout/route');
const runsRoute = await import('@/app/api/projects/[id]/tasks/[taskId]/runs/route');
const runRoute = await import('@/app/api/task-runs/[runId]/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const ollama = fake.url.replace(/\/v1$/, '');
const realFetch = globalThis.fetch;
const routed = routeFetch([
  ['/api/projects/:id/tasks', listRoute],
  ['/api/projects/:id/tasks/:taskId', taskRoute],
  ['/api/projects/:id/tasks/:taskId/checkout', checkoutRoute],
  ['/api/projects/:id/tasks/:taskId/runs', runsRoute],
  ['/api/task-runs/:runId', runRoute],
  ['/api/runs/needs-you', needsYouRoute],
]);
// The client helpers' /api/ requests go to the handlers; the fake model server is reached over the real fetch.
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

type User = Awaited<ReturnType<typeof createUser>>;
const as = async <T>(user: User, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
const person = (name: string) =>
  createUser({
    email: `${name.toLowerCase()}@tasks-join.test`,
    name,
    role: 'member',
    password: 'password-123',
  });
const ann = await person('Ann');
const ben = await person('Ben');
const viewer = await person('Vic');
const outsider = await person('Sam');

const project = projects.createTeamProject({ name: 'Billing' }).id;
const elsewhere = projects.createTeamProject({ name: 'Elsewhere' }).id;
projects.setMember(project, ann.id, 'admin');
projects.setMember(project, ben.id, 'editor');
projects.setMember(project, viewer.id, 'viewer');
projects.setMember(elsewhere, outsider.id, 'editor');
const model = {
  provider: 'ollama' as const,
  model: 'tasks-join',
  baseUrl: ollama,
};
const makeAgent = (name: string, extra: Record<string, unknown> = {}) => {
  const agent = agentStore.create({
    name,
    instructions: 'Be brief.',
    model,
    ...extra,
  });
  projects.setHomeProject('agent', agent.id, project);
  return agentStore.publish(agent.id)!.id;
};
const clerk = makeAgent('Ledger clerk');
const careful = makeAgent('Careful', {
  tools: [
    {
      id: 't1',
      type: 'node',
      name: 'Echo',
      description: 'Echo',
      nodeType: 'core.noOp',
      parameters: {},
      requireApproval: true,
    },
  ],
});

const needsYou = async (user: User) => (await as(user, () => api<{ items: NeedsYouRow[] }>('/api/runs/needs-you'))).items;
const taskItems = async (user: User) => (await needsYou(user)).filter((item) => item.kind === 'task');
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 200 && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}
const runOf = async (user: User, taskId: string, runId: string) => (await as(user, () => fetchTask(project, taskId))).runs.find((r) => r.id === runId) as TaskRun;

describe('the dialog’s body through the real routes', () => {
  it('creates an agent task with the weekdays preset and the list groups as the pure grouping expects', async () => {
    const cron = presetCron('weekdays')!;
    expect(cron).toBe('0 9 * * 1-5');
    const task = await as(ann, () =>
      createTask(project, {
        title: 'Reconcile the ledger',
        assignee: { kind: 'agent', id: clerk },
        wake: { cron },
        priority: 'high',
      }),
    );
    expect(task).toMatchObject({
      status: 'todo',
      priority: 'high',
      wake: { cron },
      canEdit: true,
      assigneeName: 'Ledger clerk',
    });
    expect(Date.parse(task.nextWakeAt!)).toBeGreaterThan(Date.now());
    await as(ann, () => createTask(project, { title: 'Call the vendor', status: 'in_progress' }));
    const list = await as(ben, () => api<ProjectTasksResponse>(tasksUrl(project, {})));
    expect(list.canCreate).toBe(true);
    const groups = groupTasks(list.tasks);
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.title)])).toEqual([
      ['In progress', ['Call the vendor']],
      ['To do', ['Reconcile the ledger']],
    ]);
    expect(groupTasks(list.tasks).flatMap((g) => g.tasks).length).toBe(list.tasks.length);
  });

  it('a real 400 maps to the field its message is about', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: 'W', wake: { cron: '0 0 31 2 *' } }, 'schedule'],
      [
        {
          title: 'W',
          wake: { cron: '0 9 * * *' },
          assignee: { kind: 'person', id: ann.id },
        },
        'schedule',
      ],
      [{ title: 'W', assignee: { kind: 'person', id: outsider.id } }, 'assignee'],
      [{ title: 'W', goalId: 'goal_nope' }, 'goal'],
    ];
    for (const [body, field] of cases) {
      const error = await as(ann, () => createTask(project, body as never)).then(
        () => undefined,
        (e: Error & { status?: number }) => e,
      );
      expect(error, JSON.stringify(body)).toBeDefined();
      expect((error as { status?: number }).status).toBe(400);
      expect(fieldOfError(error!.message), error!.message).toBe(field);
    }
  });

  it('a second editor’s checkout gets 409 "Checked out by Ann"; releasing frees it', async () => {
    const task = await as(ann, () => createTask(project, { title: 'Held task' }));
    const mine = await as(ann, () => checkoutTask(project, task.id));
    expect(mine.checkedOutByName).toBe('Ann');
    const refused = await as(ben, () => checkoutTask(project, task.id)).then(
      () => undefined,
      (e: Error & { status?: number }) => e,
    );
    expect([(refused as { status?: number }).status, refused!.message]).toEqual([409, 'Checked out by Ann']);
    expect((await as(ann, () => releaseTask(project, task.id))).checkedOutBy).toBeUndefined();
  });
});

describe('a wake-up, the Needs you item and Approve', () => {
  it('the tick makes one requested run; Needs you holds it for editors only; Approve runs it to done', async () => {
    const task = await as(ann, () =>
      createTask(project, {
        title: 'Reconcile the October ledger',
        assignee: { kind: 'agent', id: clerk },
        wake: { cron: '*/5 * * * *' },
      }),
    );
    setNextWake(task.id, new Date(Date.now() - 1000).toISOString());
    taskWakeups.tick(new Date());
    const [open] = (await as(ann, () => fetchTask(project, task.id))).runs;
    expect(open).toMatchObject({
      status: 'requested',
      reason: 'wake',
      agentId: clerk,
    });
    // A click merges into the open run.
    expect(await as(ann, () => askToRun(project, task.id))).toMatchObject({
      merged: true,
      run: { id: open.id },
    });

    const items = (await taskItems(ann)).filter((item) => item.taskRunId === open.id);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      kind: 'task',
      projectId: project,
      taskId: task.id,
      taskRunStatus: 'requested',
      canDecide: true,
      executionId: '',
      workflowId: '',
    });
    expect(item.href).toBe(`/projects/${project}?tab=tasks&task=${task.id}`);
    expect(actionsFor(item).map((a) => a.label)).toEqual(['Approve', 'Deny', 'Open task']);
    const html = renderToStaticMarkup(createElement(NeedsYouTaskRow, { item }));
    expect(html).toContain('Approve');
    expect(html).toContain('Reconcile the October ledger');
    expect(html).not.toContain('/runs/');
    // The viewer and someone outside the project get no item.
    for (const other of [viewer, outsider]) expect((await taskItems(other)).filter((i) => i.taskRunId === open.id)).toEqual([]);

    // Approve through the helper: a session (the test caller), not an API key.
    const approved = await as(ben, () => decideTaskRun(open.id, 'approve'));
    expect(approved.run.status).toBe('approved');
    const settled = await until(
      () => runOf(ann, task.id, open.id),
      (run) => !['approved', 'running'].includes(run.status),
    );
    expect(settled).toMatchObject({
      status: 'done',
      sessionId: expect.stringMatching(/^as_/),
    });
    expect((await taskItems(ann)).filter((i) => i.taskRunId === open.id)).toEqual([]);
    // A second decision is the 409 the buttons show.
    const again = await as(ann, () => decideTaskRun(open.id, 'deny')).then(
      () => undefined,
      (e: Error & { status?: number }) => e,
    );
    expect([(again as { status?: number }).status, again!.message]).toEqual([409, 'Already done']);
  });

  it('a tool that needs approval gives a waiting item whose href opens a session only the project’s members may read (lesson 12)', async () => {
    const task = await as(ann, () =>
      createTask(project, {
        title: 'Careful work',
        assignee: { kind: 'agent', id: careful },
      }),
    );
    const { run } = await as(ann, () => askToRun(project, task.id));
    await as(ann, () => decideTaskRun(run.id, 'approve'));
    const waiting = await until(
      () => runOf(ann, task.id, run.id),
      (r) => r.status === 'waiting',
    );
    expect(waiting.status).toBe('waiting');
    const item = (await taskItems(ann)).find((i) => i.taskRunId === run.id)!;
    expect(item).toMatchObject({
      taskRunStatus: 'waiting',
      canDecide: false,
      href: `/agents/${careful}?tab=sessions&session=${waiting.sessionId}`,
    });
    expect(actionsFor(item)).toEqual([{ id: 'open', label: 'Open session' }]);
    expect(renderToStaticMarkup(createElement(NeedsYouTaskRow, { item }))).not.toContain('/runs/');
    const session = agentStore.getSession(waiting.sessionId!)!;
    const read = (user: User) => canReadSession({ id: user.id, role: user.role }, session);
    expect(read(ben)).toBe(true);
    expect(read(outsider)).toBe(false);
  });

  it('a budget item and a task item in one answer both render', async () => {
    const task = await as(ann, () =>
      createTask(project, {
        title: 'Both kinds',
        assignee: { kind: 'agent', id: clerk },
      }),
    );
    await as(ann, () => askToRun(project, task.id));
    saveBudget({
      projectId: project,
      monthlyUsd: 1,
      warnPercent: 80,
      hardStop: true,
    });
    openIncident(database(), {
      projectId: project,
      month: currentMonth(aiUsageMeter()),
      kind: 'stop',
      usedUsd: 2,
      budgetUsd: 1,
    });
    aiUsageMeter().invalidateBudgets();
    try {
      const items = await needsYou(ann);
      const budget = items.find((i) => i.kind === 'budget')!;
      const taskItem = items.find((i) => i.kind === 'task' && i.taskId === task.id)!;
      expect(budget).toBeDefined();
      expect(taskItem).toBeDefined();
      const html = renderToStaticMarkup(
        createElement('ul', null, createElement(BudgetRow, { item: budget, onDone: () => {} }), createElement(NeedsYouTaskRow, { item: taskItem })),
      );
      expect(html).toContain('Both kinds');
      expect(html).toContain('budget');
    } finally {
      database().delete('project_budgets', { project_id: project });
      for (const row of database().all<{ id: string }>('SELECT id FROM project_budget_incidents WHERE project_id = ?', project))
        database().delete('project_budget_incidents', { id: row.id });
      aiUsageMeter().invalidateBudgets();
    }
  });
});
