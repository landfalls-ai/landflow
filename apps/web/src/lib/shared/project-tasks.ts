/**
 * Project tasks (docs/projects-and-goals.md#tasks): work with an assignee and an optional wake-up schedule. A wake-up only
 * asks: an agent runs after a person approves, through the same runner and checks as every agent run in the project.
 * No runtime imports, no zod. Wave 10 contract: PC19 owns it, PC20 copies it byte for byte.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = { low: 'Low', normal: 'Normal', high: 'High' };
/** `reply` and `error` of a run are cut to `reply` characters; `listRuns` is how many runs a task's view carries. */
export const TASK_LIMITS = { title: 200, description: 4000, perProject: 1000, reply: 4000, listRuns: 5 } as const;

export type TaskAssignee = { kind: 'agent'; id: string } | { kind: 'person'; id: string };

export interface ProjectTask {
  id: string;
  projectId: string;
  /** A goal the project serves, or one of its own project goals. */
  goalId?: string;
  /** A task of the same project that has no parent itself (one level). */
  parentId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: TaskAssignee;
  /** A 5-field cron (minute hour day-of-month month day-of-week) in the instance time zone; agent assignees only. */
  wake?: { cron: string };
  /** The next wake-up (ISO), while `wake` is set and the task is `todo` or `in_progress`. */
  nextWakeAt?: string;
  /** The person who checked it out (one at a time). */
  checkedOutBy?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/**
 * `requested`: waits for a person's Approve or Deny. `approved`: decided, starting. `running`: the agent works.
 * `waiting`: a tool call waits for approval in the agent's session (decided there). `done`/`failed`/`denied`: settled.
 */
export type TaskRunStatus = 'requested' | 'approved' | 'denied' | 'running' | 'waiting' | 'done' | 'failed';
/** A task has at most one run in these at a time: a new request merges into it. */
export const OPEN_TASK_RUN_STATUSES: readonly TaskRunStatus[] = ['requested', 'approved', 'running', 'waiting'];

export interface TaskRun {
  id: string;
  taskId: string;
  projectId: string;
  /** The agent asked to run (the task's assignee when it was requested). */
  agentId: string;
  status: TaskRunStatus;
  reason: 'wake' | 'manual';
  requestedAt: string;
  /** The person who asked (manual); absent for a wake-up. */
  requestedBy?: string;
  decidedBy?: string;
  decidedAt?: string;
  /** The agent session of the run: `/agents/<agentId>?tab=sessions&session=<sessionId>`. */
  sessionId?: string;
  /** The agent's answer, at most TASK_LIMITS.reply characters. */
  reply?: string;
  error?: string;
  finishedAt?: string;
}

export interface ProjectTaskView extends ProjectTask {
  /** The agent's or person's name; absent when they are gone. */
  assigneeName?: string;
  goalTitle?: string;
  checkedOutByName?: string;
  /** Newest first, at most TASK_LIMITS.listRuns. */
  runs: TaskRun[];
  /** The viewer may edit, delete, check out and ask it to run (the project's editors and admins). */
  canEdit: boolean;
  /** The viewer may release someone else's checkout (the project's admins). */
  canRelease: boolean;
}

/** GET /api/projects/:id/tasks */
export interface ProjectTasksResponse {
  tasks: ProjectTaskView[];
  nextCursor?: string;
  /** The viewer may create tasks here. */
  canCreate: boolean;
}

/** POST /api/projects/:id/tasks and PATCH …/tasks/:taskId (PATCH: every field optional; null clears an optional one). */
export interface ProjectTaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  goalId?: string | null;
  parentId?: string | null;
  assignee?: TaskAssignee | null;
  wake?: { cron: string } | null;
}

/** POST /api/task-runs/:runId */
export interface TaskRunDecision {
  decision: 'approve' | 'deny';
}

/** The Needs you fields of a `task` item (GET /api/runs/needs-you); its executionId, workflowId and workflowName are ''. */
export interface TaskNeedsYouFields {
  kind: 'task';
  projectId: string;
  taskId: string;
  taskRunId: string;
  /** `requested`: Approve and Deny; `waiting`: a tool approval in the agent's session (href opens it). */
  taskRunStatus: 'requested' | 'waiting';
  href: string;
  /** The viewer may approve or deny (`requested` only). */
  canDecide: boolean;
}
