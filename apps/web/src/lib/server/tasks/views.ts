/**
 * Who may do what with a project's tasks, and the task as a person sees it (`ProjectTaskView`): names, the goal's title,
 * the newest runs (each settled against its session first) and the keyset-paged list. Plain data is in ./store.
 */
import { TASK_LIMITS, TASK_PRIORITIES, type ProjectTask, type ProjectTaskView, type ProjectTasksResponse, type TaskStatus } from '../../shared/project-tasks';
import { projectRoleCan, type ProjectRole } from '../../shared/projects';
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import { getGoal } from '../goals/store';
import { decodeCursor, encodeCursor } from '../pagination';
import { agentNotAllowedMessage, projectAgentRules } from '../project-context/project-settings';
import { agentAvailableIn, projectRole, type Actor } from '../projects/access';
import { reconcileRun } from './reconcile';
import { projectTasks, runsOf } from './store';

export interface Viewer {
  actor: Actor;
  role: ProjectRole;
  canEdit: boolean;
  canRelease: boolean;
}

/** `actor`'s role in the project and what it lets them do; undefined without a role (the route answers 404). */
export function viewerOf(actor: Actor, projectId: string): Viewer | undefined {
  const role = projectRole(actor, projectId);
  return role && { actor, role, canEdit: projectRoleCan.create(role), canRelease: projectRoleCan.manage(role) };
}

/**
 * Why the agent may not work in the project: not available there, or refused by its allow-list; undefined when it may.
 * One message for the 400 of a save and the 409 of an approval.
 */
export function agentProblem(agentId: string, project: { id: string; name: string }): string | undefined {
  const agent = agentStore.get(agentId);
  const name = agent?.published?.config.name ?? agent?.name ?? agentId;
  if (!agent || !agentAvailableIn(agentId, project.id)) return `“${name}” isn't available in project “${project.name}”`;
  if (!(projectAgentRules(project.id)?.agentAllowed(agentId) ?? true)) return agentNotAllowedMessage(name, project.name);
  return undefined;
}

export const assigneeName = (task: Pick<ProjectTask, 'assignee'>): string | undefined => {
  if (!task.assignee) return undefined;
  return task.assignee.kind === 'agent' ? agentStore.get(task.assignee.id)?.name : getUser(task.assignee.id)?.name;
};

export function taskView(task: ProjectTask, viewer: Viewer): ProjectTaskView {
  const name = assigneeName(task);
  const goal = task.goalId ? getGoal(task.goalId) : undefined;
  const holder = task.checkedOutBy ? getUser(task.checkedOutBy)?.name : undefined;
  return {
    ...task,
    ...(name && { assigneeName: name }),
    ...(goal && { goalTitle: goal.title }),
    ...(holder && { checkedOutByName: holder }),
    runs: runsOf(task.id, TASK_LIMITS.listRuns).map((run) => reconcileRun(run)),
    canEdit: viewer.canEdit,
    canRelease: viewer.canRelease,
  };
}

const statusRank = (status: TaskStatus) => ['in_progress', 'todo', 'blocked', 'done', 'cancelled'].indexOf(status);
const priorityRank = (priority: string) => TASK_PRIORITIES.length - 1 - (TASK_PRIORITIES as readonly string[]).indexOf(priority);

/** The sort position of a task: status group, priority (high first), then newest update first, then id. */
function position(task: ProjectTask): string {
  // Dates are ISO strings of one length, so inverting each character makes "newest first" sort ascending.
  const inverted = [...task.updatedAt].map((c) => String.fromCharCode(0x7e - (c.charCodeAt(0) - 0x20))).join('');
  return `${statusRank(task.status)}${priorityRank(task.priority)}${inverted}`;
}

/** GET /api/projects/:id/tasks: the viewer's page of the project's tasks. */
export function tasksPage(projectId: string, viewer: Viewer, options: { limit: number; cursor?: string; status?: TaskStatus; mine?: boolean }): ProjectTasksResponse {
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  const sorted = projectTasks(projectId, { ...(options.status && { status: options.status }) })
    .filter((task) => !options.mine || (task.assignee?.kind === 'person' && task.assignee.id === viewer.actor.id) || task.checkedOutBy === viewer.actor.id)
    .map((task) => ({ task, key: position(task) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.task.id < b.task.id ? -1 : 1));
  const rest = after ? sorted.filter((entry) => entry.key > after.s || (entry.key === after.s && entry.task.id > after.i)) : sorted;
  const page = rest.slice(0, options.limit);
  const last = page.at(-1);
  return {
    tasks: page.map((entry) => taskView(entry.task, viewer)),
    ...(last && rest.length > page.length && { nextCursor: encodeCursor({ s: last.key, i: last.task.id }) }),
    canCreate: viewer.canEdit,
  };
}
