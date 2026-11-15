/**
 * What a person does with a project's tasks (docs/projects-and-goals.md#tasks): create, change, delete, check out, release
 * and ask an agent to run. Each change is checked here and audited here (`project.task.*`); the routes only parse and answer.
 */
import { nanoid } from 'nanoid';
import { TASK_LIMITS, type ProjectTask, type ProjectTaskView, type TaskAssignee, type TaskRun } from '../../shared/project-tasks';
import { recordAudit } from '../audit';
import { getUser } from '../auth/users';
import { getGoal, projectGoalIds } from '../goals/store';
import { projectRole } from '../projects/access';
import { logger } from '../telemetry/logger';
import { instanceTimezone } from '../settings';
import { nextWake } from './next-wake';
import type { CreateTaskBody, UpdateTaskBody } from './schema';
import { checkoutTask, childrenOf, getTask, insertTask, releaseTask, removeTask, requestRun, saveTask, TaskError } from './store';
import { agentProblem, taskView, type Viewer } from './views';

interface Project {
  id: string;
  name: string;
}

const EDITORS_ONLY = 'Only the project’s editors and admins change its tasks';
export const requireEditor = (viewer: Viewer): void => {
  if (!viewer.canEdit) throw new TaskError(EDITORS_ONLY, 403);
};

const LIVE = ['todo', 'in_progress'];

/** When the task wakes next: only while it has a schedule, an agent and work to do. */
function wakeAt(task: Pick<ProjectTask, 'assignee' | 'wake' | 'status'>, from = new Date()): string | undefined {
  if (!task.wake || task.assignee?.kind !== 'agent' || !LIVE.includes(task.status)) return undefined;
  return nextWake(task.wake.cron, from, instanceTimezone())?.toISOString();
}

function checkAssignee(assignee: TaskAssignee, project: Project): void {
  if (assignee.kind === 'agent') {
    const problem = agentProblem(assignee.id, project);
    if (problem) throw new TaskError(problem);
    return;
  }
  const user = getUser(assignee.id);
  if (!user || !projectRole({ id: user.id, role: user.role }, project.id)) throw new TaskError(`${user?.name ?? 'That person'} isn't a member of this project`);
}

function checkWake(cron: string, task: Pick<ProjectTask, 'assignee' | 'status'>): void {
  if (task.assignee?.kind !== 'agent') throw new TaskError('Only an agent task has a wake-up schedule');
  let next: Date | undefined;
  try {
    next = nextWake(cron, new Date(), instanceTimezone());
  } catch (error) {
    throw new TaskError((error as Error).message);
  }
  if (!next) throw new TaskError('This schedule never fires');
}

function checkGoal(goalId: string, project: Project): void {
  const goal = getGoal(goalId);
  if (!goal || !(goal.projectId === project.id || projectGoalIds(project.id).includes(goalId))) throw new TaskError("That goal isn't one of this project's goals");
}

function checkParent(parentId: string, project: Project, self?: ProjectTask): void {
  const parent = getTask(parentId);
  const problem = new TaskError("A task's parent is a top-level task of the same project");
  if (!parent || parent.projectId !== project.id || parent.id === self?.id || parent.parentId) throw problem;
  if (self && childrenOf(self.id).length) throw problem;
}

const flat = (changed: string[]) => ({ fields: changed.join(',') });

/** POST: a new task. */
export function createTask(viewer: Viewer, project: Project, body: CreateTaskBody): ProjectTaskView {
  requireEditor(viewer);
  const at = new Date().toISOString();
  const assignee = body.assignee ?? undefined;
  if (assignee) checkAssignee(assignee, project);
  const status = body.status ?? 'todo';
  if (body.wake) checkWake(body.wake.cron, { assignee, status });
  if (body.goalId) checkGoal(body.goalId, project);
  if (body.parentId) checkParent(body.parentId, project);
  const base: ProjectTask = {
    id: `tsk_${nanoid(10)}`,
    projectId: project.id,
    ...(body.goalId && { goalId: body.goalId }),
    ...(body.parentId && { parentId: body.parentId }),
    title: body.title.trim().slice(0, TASK_LIMITS.title),
    ...(body.description?.trim() && { description: body.description.trim().slice(0, TASK_LIMITS.description) }),
    status,
    priority: body.priority ?? 'normal',
    ...(assignee && { assignee }),
    ...(body.wake && { wake: { cron: body.wake.cron.trim() } }),
    createdAt: at,
    updatedAt: at,
    createdBy: viewer.actor.id,
  };
  const next = wakeAt(base);
  const task: ProjectTask = { ...base, ...(next && { nextWakeAt: next }) };
  if (!insertTask(task, TASK_LIMITS.perProject)) throw new TaskError(`A project has at most ${TASK_LIMITS.perProject} tasks`);
  recordAudit({ action: 'project.task.create', target: { type: 'task', id: task.id, name: task.title }, project: project.id, summary: `Created the task “${task.title}” in “${project.name}”`, details: { priority: task.priority, ...(assignee && { assigneeKind: assignee.kind, assigneeId: assignee.id }) } });
  return taskView(task, viewer);
}

/** PATCH: change the named fields (null clears an optional one). */
export function updateTask(viewer: Viewer, project: Project, id: string, body: UpdateTaskBody): ProjectTaskView {
  requireEditor(viewer);
  const task = getTask(id);
  if (!task || task.projectId !== project.id) throw new TaskError('Task not found', 404);
  const next: ProjectTask = { ...task };
  const changed: string[] = [];
  const set = <K extends keyof ProjectTask>(key: K, value: ProjectTask[K] | undefined, label: string = key) => {
    if (JSON.stringify(task[key]) === JSON.stringify(value)) return;
    if (value === undefined) delete next[key];
    else next[key] = value;
    changed.push(label);
  };
  if (body.title !== undefined) set('title', body.title.trim().slice(0, TASK_LIMITS.title));
  if (body.description !== undefined) set('description', body.description?.trim() ? body.description.trim().slice(0, TASK_LIMITS.description) : undefined);
  if (body.status !== undefined) set('status', body.status);
  if (body.priority !== undefined) set('priority', body.priority);
  if (body.goalId !== undefined) {
    if (body.goalId && body.goalId !== task.goalId) checkGoal(body.goalId, project);
    set('goalId', body.goalId ?? undefined);
  }
  if (body.parentId !== undefined) {
    if (body.parentId && body.parentId !== task.parentId) checkParent(body.parentId, project, task);
    set('parentId', body.parentId ?? undefined);
  }
  if (body.assignee !== undefined) {
    // A person who left stays the assignee until someone changes it: only a new assignee is checked.
    if (body.assignee && (body.assignee.kind !== task.assignee?.kind || body.assignee.id !== task.assignee.id)) checkAssignee(body.assignee, project);
    set('assignee', body.assignee ?? undefined);
  }
  if (body.wake !== undefined) set('wake', body.wake ? { cron: body.wake.cron.trim() } : undefined);
  if (next.wake && (body.wake !== undefined || body.assignee !== undefined)) checkWake(next.wake.cron, next);
  if (!changed.length) return taskView(task, viewer);
  // The schedule moves with its inputs; an edit of something else leaves a due wake-up as it is.
  const reschedule = changed.some((field) => ['assignee', 'wake', 'status'].includes(field));
  const wake = reschedule ? wakeAt(next) : next.nextWakeAt && next.wake && next.assignee?.kind === 'agent' && LIVE.includes(next.status) ? next.nextWakeAt : undefined;
  if (wake) next.nextWakeAt = wake;
  else delete next.nextWakeAt;
  next.updatedAt = new Date().toISOString();
  saveTask(next);
  recordAudit({ action: 'project.task.update', target: { type: 'task', id, name: next.title }, project: project.id, summary: `Changed the task “${next.title}” (${changed.join(', ')})`, details: flat(changed) });
  return taskView(next, viewer);
}

export function deleteTask(viewer: Viewer, project: Project, id: string): void {
  requireEditor(viewer);
  const task = getTask(id);
  if (!task || task.projectId !== project.id) throw new TaskError('Task not found', 404);
  if (removeTask(id)) recordAudit({ action: 'project.task.delete', target: { type: 'task', id, name: task.title }, project: project.id, summary: `Deleted the task “${task.title}” from “${project.name}”` });
}

export function checkout(viewer: Viewer, project: Project, id: string): ProjectTaskView {
  requireEditor(viewer);
  if (getTask(id)?.projectId !== project.id) throw new TaskError('Task not found', 404);
  const before = getTask(id)?.checkedOutBy;
  const task = checkoutTask(id, viewer.actor.id);
  if (!task) throw new TaskError('Task not found', 404);
  if (before !== viewer.actor.id) recordAudit({ action: 'project.task.checkout', target: { type: 'task', id, name: task.title }, project: project.id, summary: `Checked out the task “${task.title}”` });
  return taskView(task, viewer);
}

export function release(viewer: Viewer, project: Project, id: string): ProjectTaskView {
  requireEditor(viewer);
  if (getTask(id)?.projectId !== project.id) throw new TaskError('Task not found', 404);
  const held = getTask(id)?.checkedOutBy;
  const result = releaseTask(id, (holder) => holder === viewer.actor.id || viewer.canRelease);
  if (!result) throw new TaskError('Task not found', 404);
  if (result.refused) throw new TaskError('Only the one who checked it out, or a project admin, releases it', 403);
  if (held) recordAudit({ action: 'project.task.release', target: { type: 'task', id, name: result.task.title }, project: project.id, summary: `Released the task “${result.task.title}”` });
  return taskView(result.task, viewer);
}

/** The task's agent, or a 400 saying why it has none to run. */
export function runnableAgent(task: ProjectTask): string {
  if (task.assignee?.kind !== 'agent') throw new TaskError('Only an agent task runs');
  return task.assignee.id;
}

/** POST …/runs: a person asks for a run now. A task with a run in flight answers with that one. */
export function askToRun(viewer: Viewer, project: Project, id: string): { run: TaskRun; merged: boolean } {
  requireEditor(viewer);
  const task = getTask(id);
  if (!task || task.projectId !== project.id) throw new TaskError('Task not found', 404);
  const agentId = runnableAgent(task);
  if (task.status === 'done' || task.status === 'cancelled') throw new TaskError('Reopen the task first');
  const result = requestRun(task, agentId, 'manual', viewer.actor.id);
  if (!result.merged) {
    recordAudit({ action: 'project.task.run_requested', target: { type: 'task', id, name: task.title }, project: project.id, summary: `Asked “${task.title}” to run`, details: { runId: result.run.id, agentId, reason: 'manual' } });
    logger.info('a task run was requested', { 'landflow.project.id': project.id, 'landflow.task.id': id, 'landflow.task.reason': 'manual' });
  }
  return result;
}
