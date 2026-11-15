/**
 * Project tasks and their runs in the database (migration 2800). Plain rows and the atomic steps: the database layer has
 * no raw UPDATE, so each step is a read and a write inside one `transaction()` (SQLite takes the write lock, so two
 * callers never both pass the read). Who may do what is in ./service and ./views; what a run does is in ./run.
 */
import { nanoid } from 'nanoid';
import { OPEN_TASK_RUN_STATUSES, TASK_STATUSES, type ProjectTask, type TaskPriority, type TaskRun, type TaskRunStatus, type TaskStatus } from '../../shared/project-tasks';
import { getUser } from '../auth/users';
import { database, type Database } from '../db';
import { HttpError } from '../errors';

export type TaskRow = {
  id: string;
  project_id: string;
  goal_id: string | null;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_kind: string | null;
  assignee_id: string | null;
  wake_cron: string | null;
  next_wake_at: string | null;
  checked_out_by: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

export type RunRow = {
  id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  status: string;
  reason: string;
  requested_at: string;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  session_id: string | null;
  reply: string | null;
  error: string | null;
  finished_at: string | null;
};

export class TaskError extends HttpError {
  static readonly errorName: string = 'TaskError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

/** Someone else holds the task (409). */
export class TaskCheckedOut extends HttpError {
  static readonly errorName: string = 'TaskCheckedOut';
  constructor(holderId?: string) {
    const name = holderId ? getUser(holderId)?.name : undefined;
    super(`Checked out by ${name ?? 'someone else'}`, 409, { expose: true });
  }
}

const db = (): Database => database();

export const taskFrom = (row: TaskRow): ProjectTask => ({
  id: row.id,
  projectId: row.project_id,
  ...(row.goal_id && { goalId: row.goal_id }),
  ...(row.parent_id && { parentId: row.parent_id }),
  title: row.title,
  ...(row.description && { description: row.description }),
  status: (TASK_STATUSES as readonly string[]).includes(row.status) ? (row.status as TaskStatus) : 'todo',
  priority: row.priority === 'low' || row.priority === 'high' ? (row.priority as TaskPriority) : 'normal',
  ...(row.assignee_kind && row.assignee_id && { assignee: { kind: row.assignee_kind === 'person' ? ('person' as const) : ('agent' as const), id: row.assignee_id } }),
  ...(row.wake_cron && { wake: { cron: row.wake_cron } }),
  ...(row.next_wake_at && { nextWakeAt: row.next_wake_at }),
  ...(row.checked_out_by && { checkedOutBy: row.checked_out_by }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.created_by && { createdBy: row.created_by }),
});

export const taskRow = (task: ProjectTask): TaskRow => ({
  id: task.id,
  project_id: task.projectId,
  goal_id: task.goalId ?? null,
  parent_id: task.parentId ?? null,
  title: task.title,
  description: task.description ?? null,
  status: task.status,
  priority: task.priority,
  assignee_kind: task.assignee?.kind ?? null,
  assignee_id: task.assignee?.id ?? null,
  wake_cron: task.wake?.cron ?? null,
  next_wake_at: task.nextWakeAt ?? null,
  checked_out_by: task.checkedOutBy ?? null,
  created_at: task.createdAt,
  updated_at: task.updatedAt,
  created_by: task.createdBy ?? null,
});

const RUN_STATUSES: readonly TaskRunStatus[] = ['requested', 'approved', 'denied', 'running', 'waiting', 'done', 'failed'];

export const runFrom = (row: RunRow): TaskRun => ({
  id: row.id,
  taskId: row.task_id,
  projectId: row.project_id,
  agentId: row.agent_id,
  status: (RUN_STATUSES as readonly string[]).includes(row.status) ? (row.status as TaskRunStatus) : 'failed',
  reason: row.reason === 'wake' ? 'wake' : 'manual',
  requestedAt: row.requested_at,
  ...(row.requested_by && { requestedBy: row.requested_by }),
  ...(row.decided_by && { decidedBy: row.decided_by }),
  ...(row.decided_at && { decidedAt: row.decided_at }),
  ...(row.session_id && { sessionId: row.session_id }),
  ...(row.reply && { reply: row.reply }),
  ...(row.error && { error: row.error }),
  ...(row.finished_at && { finishedAt: row.finished_at }),
});

const runRow = (run: TaskRun): RunRow => ({
  id: run.id,
  task_id: run.taskId,
  project_id: run.projectId,
  agent_id: run.agentId,
  status: run.status,
  reason: run.reason,
  requested_at: run.requestedAt,
  requested_by: run.requestedBy ?? null,
  decided_by: run.decidedBy ?? null,
  decided_at: run.decidedAt ?? null,
  session_id: run.sessionId ?? null,
  reply: run.reply ?? null,
  error: run.error ?? null,
  finished_at: run.finishedAt ?? null,
});

const openList = OPEN_TASK_RUN_STATUSES.map((status) => `'${status}'`).join(', ');

// ---- tasks ------------------------------------------------------------------------------------------------

export function getTask(id: string): ProjectTask | undefined {
  const row = db().get<TaskRow>('SELECT * FROM project_tasks WHERE id = ?', id);
  return row && taskFrom(row);
}

/** A project's tasks (at most `TASK_LIMITS.perProject` exist), in no particular order; ./views sorts and pages them. */
export function projectTasks(projectId: string, filter: { status?: TaskStatus } = {}): ProjectTask[] {
  const rows = filter.status
    ? db().all<TaskRow>('SELECT * FROM project_tasks WHERE project_id = ? AND status = ?', projectId, filter.status)
    : db().all<TaskRow>('SELECT * FROM project_tasks WHERE project_id = ?', projectId);
  return rows.map(taskFrom);
}

export const countTasks = (projectId: string): number => Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM project_tasks WHERE project_id = ?', projectId)?.n ?? 0);

export const childrenOf = (taskId: string): ProjectTask[] => db().all<TaskRow>('SELECT * FROM project_tasks WHERE parent_id = ?', taskId).map(taskFrom);

/** Add a task; refuses past `limit` tasks in the project (the count and the insert are one step). */
export function insertTask(task: ProjectTask, limit: number): boolean {
  return db().transaction(() => {
    if (countTasks(task.projectId) >= limit) return false;
    db().insertNew('project_tasks', taskRow(task));
    return true;
  });
}

export function saveTask(task: ProjectTask): void {
  db().upsert('project_tasks', taskRow(task));
}

/** Delete a task with its runs; its sub-tasks lose their parent. */
export function removeTask(id: string): boolean {
  return db().transaction(() => {
    if (!db().get('SELECT id FROM project_tasks WHERE id = ?', id)) return false;
    for (const run of db().all<{ id: string }>('SELECT id FROM task_runs WHERE task_id = ?', id)) db().delete('task_runs', { id: run.id });
    for (const row of db().all<TaskRow>('SELECT * FROM project_tasks WHERE parent_id = ?', id)) db().upsert('project_tasks', { ...row, parent_id: null });
    db().delete('project_tasks', { id });
    return true;
  });
}

/** Take the task for `userId`: the read and the write are one step. Holding it already is fine; someone else holding it throws. */
export function checkoutTask(id: string, userId: string): { task: ProjectTask; changed: boolean } | undefined {
  return db().transaction(() => {
    const row = db().get<TaskRow>('SELECT * FROM project_tasks WHERE id = ?', id);
    if (!row) return undefined;
    if (row.checked_out_by && row.checked_out_by !== userId) throw new TaskCheckedOut(row.checked_out_by);
    if (row.checked_out_by === userId) return { task: taskFrom(row), changed: false };
    const next = { ...row, checked_out_by: userId, updated_at: new Date().toISOString() };
    db().upsert('project_tasks', next);
    return { task: taskFrom(next), changed: true };
  });
}

/** Let the task go. `allow` decides, given who holds it, whether this caller may (the holder, or an admin). */
export function releaseTask(id: string, allow: (holderId: string) => boolean): { task: ProjectTask; refused?: true; released?: boolean } | undefined {
  return db().transaction(() => {
    const row = db().get<TaskRow>('SELECT * FROM project_tasks WHERE id = ?', id);
    if (!row) return undefined;
    if (!row.checked_out_by) return { task: taskFrom(row) };
    if (!allow(row.checked_out_by)) return { task: taskFrom(row), refused: true as const };
    const next = { ...row, checked_out_by: null, updated_at: new Date().toISOString() };
    db().upsert('project_tasks', next);
    return { task: taskFrom(next), released: true };
  });
}

/** Set (or clear) the next wake-up only, re-reading the row so an edit made meanwhile is kept. */
export function setNextWake(id: string, nextWakeAt: string | null): void {
  db().transaction(() => {
    const row = db().get<TaskRow>('SELECT * FROM project_tasks WHERE id = ?', id);
    if (row && row.next_wake_at !== nextWakeAt) db().upsert('project_tasks', { ...row, next_wake_at: nextWakeAt });
  });
}

/** Tasks whose wake-up is due: an agent assignee, still to do or in progress (one query, capped). */
export function dueTasks(now: string, limit: number): ProjectTask[] {
  return db()
    .all<TaskRow>(`SELECT * FROM project_tasks WHERE next_wake_at IS NOT NULL AND next_wake_at <= ? AND assignee_kind = 'agent' AND status IN ('todo', 'in_progress') ORDER BY next_wake_at, id LIMIT ?`, now, limit)
    .map(taskFrom);
}

// ---- runs -------------------------------------------------------------------------------------------------

export function getRun(id: string): TaskRun | undefined {
  const row = db().get<RunRow>('SELECT * FROM task_runs WHERE id = ?', id);
  return row && runFrom(row);
}

/** A task's runs, newest first. */
export const runsOf = (taskId: string, limit: number): TaskRun[] => db().all<RunRow>('SELECT * FROM task_runs WHERE task_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?', taskId, limit).map(runFrom);

/**
 * Runs in these statuses, newest first (one query, capped). `before` keeps only runs requested before that instant;
 * `projectIds` keeps only runs of those projects (so the cap counts the caller's runs, not the instance's).
 */
export function runsWith(statuses: readonly TaskRunStatus[], limit: number, before?: string, projectIds?: readonly string[]): TaskRun[] {
  if (projectIds && !projectIds.length) return [];
  const list = statuses.map((status) => `'${status}'`).join(', ');
  const projects = projectIds ? ` AND project_id IN (${projectIds.map(() => '?').join(', ')})` : '';
  return db()
    .all<RunRow>(`SELECT * FROM task_runs WHERE status IN (${list})${before ? ' AND requested_at < ?' : ''}${projects} ORDER BY requested_at DESC, id DESC LIMIT ?`, ...(before ? [before] : []), ...(projectIds ?? []), limit)
    .map(runFrom);
}

/**
 * A run for the task: the one it has open, else a new `requested` one. The check and the insert are one step, so two
 * wake-ups, or a wake-up and a click, never make two open runs.
 */
export function requestRun(task: Pick<ProjectTask, 'id' | 'projectId'>, agentId: string, reason: TaskRun['reason'], requestedBy?: string): { run: TaskRun; merged: boolean } {
  return db().transaction(() => {
    const open = db().get<RunRow>(`SELECT * FROM task_runs WHERE task_id = ? AND status IN (${openList}) ORDER BY requested_at DESC LIMIT 1`, task.id);
    if (open) return { run: runFrom(open), merged: true };
    const run: TaskRun = { id: `trn_${nanoid(10)}`, taskId: task.id, projectId: task.projectId, agentId, status: 'requested', reason, requestedAt: new Date().toISOString(), ...(requestedBy && { requestedBy }) };
    db().insertNew('task_runs', runRow(run));
    return { run, merged: false };
  });
}

/**
 * Decide a `requested` run: `check` runs on it inside the step (it may throw to refuse; nothing is written then), and the
 * run moves to `approved` or `denied`. Any other status throws 409 `Already <status>`.
 */
export function decideRun(id: string, decision: 'approve' | 'deny', by: string, check?: (run: TaskRun) => void): TaskRun | undefined {
  return db().transaction(() => {
    const row = db().get<RunRow>('SELECT * FROM task_runs WHERE id = ?', id);
    if (!row) return undefined;
    if (row.status !== 'requested') throw new TaskError(`Already ${row.status}`, 409);
    check?.(runFrom(row));
    const at = new Date().toISOString();
    const next: RunRow = { ...row, status: decision === 'approve' ? 'approved' : 'denied', decided_by: by, decided_at: at, ...(decision === 'deny' && { finished_at: at }) };
    db().upsert('task_runs', next);
    return runFrom(next);
  });
}

/**
 * Change an open run (never a settled one, never one that is gone: a task deleted while its run goes on loses the run,
 * and the run's later saves do nothing). Returns the run as it is now.
 */
export function patchRun(id: string, patch: Partial<Pick<TaskRun, 'status' | 'sessionId' | 'reply' | 'error' | 'finishedAt'>>): TaskRun | undefined {
  return db().transaction(() => {
    const row = db().get<RunRow>('SELECT * FROM task_runs WHERE id = ?', id);
    if (!row) return undefined;
    if (!(OPEN_TASK_RUN_STATUSES as readonly string[]).includes(row.status)) return runFrom(row);
    const next: RunRow = {
      ...row,
      ...(patch.status && { status: patch.status }),
      ...(patch.sessionId && { session_id: patch.sessionId }),
      ...(patch.reply !== undefined && { reply: patch.reply }),
      ...(patch.error !== undefined && { error: patch.error }),
      ...(patch.finishedAt && { finished_at: patch.finishedAt }),
    };
    db().upsert('task_runs', next);
    return runFrom(next);
  });
}
