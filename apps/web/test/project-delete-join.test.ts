/**
 * The join of a project's deletion (constitution lesson 11) across PC14's budget, PC16's workspace and wave 8's retirement
 * of practices: deleting a project removes its budget, incidents and workspace and retires its practices in the same
 * transaction (a failure part way leaves all of them as they were), Needs you no longer lists its incidents, an agent shared
 * to it loses the share, and moving a resource between projects moves no budget. Each package tested its own rows alone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PracticeDraftInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-delete-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations (the practices port and source) are the real ones.
await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { authDb } = await import('@/lib/server/auth/db');
const { database } = await import('@/lib/server/db');
const projects = await import('@/lib/server/projects');
const { agentStore } = await import('@/lib/server/agents/store');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { saveBudget, getBudget, incidentsOf, currentMonth, openIncident } = await import('@/lib/server/budgets/store');
const { saveWorkspace } = await import('@/lib/server/projects/workspace');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const { getPractice } = await import('@/lib/server/practices/store');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const { requestRun, getTask } = await import('@/lib/server/tasks/store');

const owner = await createUser({ email: 'owner@delete-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
enableTestAuth(owner);
const meter = aiUsageMeter();

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let seq = 0;
const practice = (projectId: string) => {
  const input: PracticeDraftInput = { handle: `rules/delete-join-${++seq}`, title: 'A rule', level: 'project', projectId, strength: 'recommended', topics: [`t-delete-join-${seq}`], repos: [], paths: [], summary: 'A short rule', body: 'The full rule.' };
  const { practice: draft } = storePort.draft(input, { source: 'person', actor: owner });
  approvePractice(owner, draft.id, { version: 1 });
  return draft.id;
};

/** A project with everything this test deletes: a budget with an open stop, a workspace, a practice and an agent share. */
async function furnished(name: string) {
  const id = projects.createTeamProject({ name }).id;
  saveBudget({ projectId: id, monthlyUsd: 1, warnPercent: 80, hardStop: true });
  const incident = openIncident(database(), { projectId: id, month: currentMonth(meter), kind: 'stop', usedUsd: 2, budgetUsd: 1 })!;
  saveWorkspace(owner, id, { repos: {}, worktree: 'shared', branchTemplate: 'landflow/{project}/{run}' });
  const practiceId = practice(id);
  const agent = agentStore.create({ name: `${name} helper`, instructions: 'Help.' });
  projects.putShare('agent', agent.id, id, 'user');
  meter.invalidateBudgets();
  return { id, incident, practiceId, agentId: agent.id };
}

const rows = (projectId: string) => ({
  budget: database().all('SELECT 1 FROM project_budgets WHERE project_id = ?', projectId).length,
  incidents: database().all('SELECT 1 FROM project_budget_incidents WHERE project_id = ?', projectId).length,
  workspace: database().all('SELECT 1 FROM project_workspaces WHERE project_id = ?', projectId).length,
  shares: database().all('SELECT 1 FROM resource_shares WHERE project_id = ?', projectId).length,
});
const budgetItems = async () => {
  const response = await needsYouRoute.GET(new Request('http://landflow.test/api/runs/needs-you'));
  return ((await response.json()) as { items: Array<{ kind: string; projectId?: string }> }).items.filter((i) => i.kind === 'budget');
};

describe('deleting a project', () => {
  it('a failure part way leaves the budget, workspace, practice and share as they were (one transaction)', async () => {
    const doomed = await furnished('Half deleted');
    expect(rows(doomed.id)).toEqual({ budget: 1, incidents: 1, workspace: 1, shares: 1 });
    const db = authDb();
    const real = db.delete.bind(db);
    const spy = vi.spyOn(db, 'delete').mockImplementation(((table: string, where: Record<string, unknown>) => {
      if (table === 'projects') throw new Error('disk full');
      return real(table as never, where as never);
    }) as never);
    try {
      expect(() => projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id)).toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(rows(doomed.id)).toEqual({ budget: 1, incidents: 1, workspace: 1, shares: 1 });
    expect(getPractice(doomed.practiceId)?.status).toBe('approved');
    expect(projects.getProject(doomed.id)).toBeDefined();
    // Clean up for the next case.
    projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id);
  });

  it('removes the budget, incidents and workspace, retires the practice, drops the share, and Needs you forgets it', async () => {
    const doomed = await furnished('Doomed');
    const kept = await furnished('Kept');
    expect((await budgetItems()).map((i) => i.projectId).sort()).toEqual([doomed.id, kept.id].sort());

    projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id);
    meter.invalidateBudgets();

    expect(rows(doomed.id)).toEqual({ budget: 0, incidents: 0, workspace: 0, shares: 0 });
    expect(getBudget(doomed.id)).toBeUndefined();
    expect(getPractice(doomed.practiceId)?.status).toBe('retired');
    expect(projects.availableAgentIds(kept.id, [doomed.agentId]).has(doomed.agentId)).toBe(false);
    expect((await budgetItems()).map((i) => i.projectId)).toEqual([kept.id]);
    // The other project keeps everything.
    expect(rows(kept.id)).toEqual({ budget: 1, incidents: 1, workspace: 1, shares: 1 });
    expect(getPractice(kept.practiceId)?.status).toBe('approved');
  });
});

describe('transferring', () => {
  it('moving a resource, or deleting with a transfer, moves no budget', async () => {
    const from = await furnished('From');
    const to = projects.createTeamProject({ name: 'To' }).id;
    saveBudget({ projectId: to, monthlyUsd: 7, warnPercent: 80, hardStop: false });
    const agent = agentStore.create({ name: 'Mover', instructions: 'Move.' });
    projects.setHomeProject('agent', agent.id, from.id);
    projects.moveResource('agent', agent.id, to);
    expect(getBudget(from.id)?.monthlyUsd).toBe(1);
    expect(getBudget(to)?.monthlyUsd).toBe(7);

    const owned = agentStore.create({ name: 'Owned', instructions: 'Stay.' });
    projects.setHomeProject('agent', owned.id, from.id);
    projects.deleteProjectWithTransfer(from.id, to, owner.id);
    expect(projects.homeProjectId('agent', owned.id)).toBe(to);
    expect(getBudget(to)?.monthlyUsd).toBe(7);
    expect(incidentsOf(to, currentMonth(meter))).toEqual([]);
    expect(rows(from.id)).toEqual({ budget: 0, incidents: 0, workspace: 0, shares: 0 });
  });
});

// ---- tasks (PC19): a project's tasks and their runs are its own data --------------------------------------------------

const at = new Date().toISOString();
/** A project with a task checked out by the owner, and an open (requested) run of it by a published agent. */
function withTasks(name: string) {
  const id = projects.createTeamProject({ name }).id;
  const agent = agentStore.create({ name: `${name} worker`, instructions: 'Work.' });
  agentStore.publish(agent.id);
  const taskId = `tsk_${name.replace(/\W/g, '')}`;
  database().upsert('project_tasks', { id: taskId, project_id: id, title: `${name} task`, status: 'todo', priority: 'normal', assignee_kind: 'agent', assignee_id: agent.id, checked_out_by: owner.id, created_at: at, updated_at: at });
  const { run } = requestRun({ id: taskId, projectId: id }, agent.id, 'manual', owner.id);
  return { id, taskId, runId: run.id, agentId: agent.id };
}
const taskRows = (projectId: string) => ({
  tasks: database().all('SELECT 1 FROM project_tasks WHERE project_id = ?', projectId).length,
  runs: database().all('SELECT 1 FROM task_runs WHERE project_id = ?', projectId).length,
});
const taskItems = async () => {
  const response = await needsYouRoute.GET(new Request('http://landflow.test/api/runs/needs-you'));
  return ((await response.json()) as { items: Array<{ kind: string; taskId?: string }> }).items.filter((i) => i.kind === 'task');
};

describe('deleting a project that has tasks', () => {
  it('a failure part way keeps the tasks and their runs', async () => {
    const doomed = withTasks('HalfTasks');
    const db = authDb();
    const real = db.delete.bind(db);
    const spy = vi.spyOn(db, 'delete').mockImplementation(((table: string, where: Record<string, unknown>) => {
      if (table === 'projects') throw new Error('disk full');
      return real(table as never, where as never);
    }) as never);
    try {
      expect(() => projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id)).toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(taskRows(doomed.id)).toEqual({ tasks: 1, runs: 1 });
    expect(getTask(doomed.taskId)?.checkedOutBy).toBe(owner.id);
    projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id);
  });

  it('deletes the tasks, their runs and the checkout; Needs you forgets the item; the count is gone; another project keeps its own', async () => {
    const doomed = withTasks('DoomedTasks');
    const kept = withTasks('KeptTasks');
    expect((await taskItems()).map((i) => i.taskId).sort()).toEqual([doomed.taskId, kept.taskId].sort());
    expect(projects.taskCounts().get(doomed.id)).toBe(1);

    projects.deleteProjectWithTransfer(doomed.id, undefined, owner.id);

    expect(taskRows(doomed.id)).toEqual({ tasks: 0, runs: 0 });
    expect(getTask(doomed.taskId)).toBeUndefined();
    expect(projects.taskCounts().has(doomed.id)).toBe(false);
    expect((await taskItems()).map((i) => i.taskId)).toEqual([kept.taskId]);
    expect(taskRows(kept.id)).toEqual({ tasks: 1, runs: 1 });
    expect(projects.taskCounts().get(kept.id)).toBe(1);
  });

  it('deleting with a transfer moves what it owns but no task or run', async () => {
    const from = withTasks('FromTasks');
    const to = projects.createTeamProject({ name: 'ToTasks' }).id;
    const owned = agentStore.create({ name: 'Moved along', instructions: 'Stay.' });
    projects.setHomeProject('agent', owned.id, from.id);
    projects.deleteProjectWithTransfer(from.id, to, owner.id);
    expect(projects.homeProjectId('agent', owned.id)).toBe(to);
    expect(taskRows(from.id)).toEqual({ tasks: 0, runs: 0 });
    expect(taskRows(to)).toEqual({ tasks: 0, runs: 0 });
    expect(database().all('SELECT 1 FROM project_tasks WHERE id = ?', from.taskId)).toEqual([]);
  });
});
