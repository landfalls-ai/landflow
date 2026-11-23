/**
 * Goals as the API shows them, and the rules of who may see and change what (docs/projects-and-goals.md#who-sees-and-edits-what):
 * company goals are everyone's; a project goal is its project's. The `...As` functions check the rules, then call the store.
 */
import { GOAL_LIMITS, type Goal, type GoalDetailResponse, type GoalNode, type GoalsResponse, type GoalView, type ProjectBriefView } from '../../shared/goals';
import { projectRoleCan } from '../../shared/projects';
import { getUser } from '../auth/users';
import { canEntity, getEntity } from '../brain/entities';
import { isInstanceAdmin, projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { getProject, type ProjectRecord } from '../projects/store';
import { companyProfile } from '../settings';
import {
  allInitiatives,
  allServing,
  chain,
  createGoal,
  deleteGoal,
  depthOf,
  getGoal,
  GoalError,
  heightBelow,
  isWithin,
  listGoals,
  projectsServing,
  projectGoalIds,
  setInitiatives,
  setProjectGoals,
  updateGoal,
} from './store';
import type { CreateGoalBody, UpdateGoalBody } from './schema';

// ---- rules ------------------------------------------------------------------------------------------------

/** Company goals: owners and admins. Project goals: admins of the goal's project. */
export function canEditGoal(actor: Actor, goal: Pick<Goal, 'level' | 'projectId'>): boolean {
  if (goal.level === 'company') return isInstanceAdmin(actor);
  return projectRoleCan.manage(projectRole(actor, goal.projectId));
}

/** The goals `actor` sees: company goals, and project goals of the projects they see (all of them for owners and admins). */
export function visibleGoals(actor: Actor, goals: Goal[] = listGoals(), projects = visibleProjectIds(actor)): Goal[] {
  return goals.filter((goal) => goal.level === 'company' || !projects || (goal.projectId !== undefined && projects.has(goal.projectId)));
}

/** One goal if `actor` sees it. */
export function visibleGoal(actor: Actor, id: string): Goal | undefined {
  const goal = getGoal(id);
  return goal && visibleGoals(actor, [goal])[0];
}

// ---- views ------------------------------------------------------------------------------------------------

function viewBuilder(actor: Actor) {
  const projects = visibleProjectIds(actor);
  const serving = allServing();
  const initiatives = allInitiatives();
  const names = new Map<string, string | undefined>();
  const owners = new Map<string, string | undefined>();
  const ownerName = (id: string) => {
    if (!owners.has(id)) owners.set(id, getUser(id)?.name);
    return owners.get(id);
  };
  const initiativeNames = new Map<string, string | undefined>();
  const initiativeName = (id: string) => {
    if (!initiativeNames.has(id)) {
      const entity = getEntity('initiative', id);
      initiativeNames.set(id, entity && canEntity(actor, entity, 'read') ? entity.name : undefined);
    }
    return initiativeNames.get(id);
  };
  const projectName = (id: string) => {
    if (!names.has(id)) names.set(id, !projects || projects.has(id) ? getProject(id)?.name : undefined);
    return names.get(id);
  };
  return (goal: Goal): GoalView => ({
    ...goal,
    ...(goal.ownerId && ownerName(goal.ownerId) && { ownerName: ownerName(goal.ownerId) }),
    projects: (serving.get(goal.id) ?? []).flatMap((id) => {
      const name = projectName(id);
      return name ? [{ id, name }] : [];
    }),
    initiatives: (initiatives.get(goal.id) ?? []).flatMap((id) => {
      const name = initiativeName(id);
      return name ? [{ id, name }] : [];
    }),
    canEdit: canEditGoal(actor, goal),
  });
}

/** The tree of `goals`: a goal whose parent isn't among them is a root. Siblings stay in creation order. */
export function buildTree(goals: GoalView[]): GoalNode[] {
  const nodes = new Map(goals.map((goal) => [goal.id, { ...goal, children: [] as GoalNode[] }]));
  const roots: GoalNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    (parent && parent.id !== node.id ? parent.children : roots).push(node);
  }
  return roots;
}

export function goalsResponse(actor: Actor, filter: { projectId?: string; status?: string } = {}): GoalsResponse {
  const view = viewBuilder(actor);
  const serving = filter.projectId ? new Set(projectGoalIds(filter.projectId)) : undefined;
  // A project the caller can't see answers as if it had no goals (so the filter can't probe which company goals a hidden project serves).
  const hidden = filter.projectId !== undefined && !projectRole(actor, filter.projectId);
  const goals = (hidden ? [] : visibleGoals(actor))
    .filter((goal) => (!filter.status || goal.status === filter.status) && (!serving || serving.has(goal.id) || goal.projectId === filter.projectId))
    .slice(0, GOAL_LIMITS.list)
    .map(view);
  const mission = companyProfile().mission;
  return { ...(mission && { mission }), goals: buildTree(goals), canCreateCompanyGoals: isInstanceAdmin(actor) };
}

export function goalView(actor: Actor, goal: Goal): GoalView {
  return viewBuilder(actor)(goal);
}

export function goalDetail(actor: Actor, id: string): GoalDetailResponse | undefined {
  const goal = visibleGoal(actor, id);
  if (!goal) return undefined;
  const visible = new Set(visibleGoals(actor, chain(id)).map((g) => g.id));
  return { goal: goalView(actor, goal), chain: chain(id).filter((g) => visible.has(g.id)).map(({ id: goalId, title, level, status }) => ({ id: goalId, title, level, status })) };
}

/** A project's goals as views, in order (those `actor` sees). */
export function projectGoalViews(actor: Actor, projectId: string): GoalView[] {
  const view = viewBuilder(actor);
  return projectGoalIds(projectId).flatMap((id) => {
    const goal = visibleGoal(actor, id);
    return goal ? [view(goal)] : [];
  });
}

/** `project.brief` of GET /api/projects/:id. */
export function briefView(project: ProjectRecord, actor: Actor): ProjectBriefView {
  const name = (id?: string) => (id ? getUser(id)?.name : undefined);
  const leadName = name(project.leadId);
  const decisionOwnerName = name(project.decisionOwnerId);
  return {
    ...(project.brief && { brief: project.brief }),
    ...(project.briefConstraints && { constraints: project.briefConstraints }),
    ...(project.doneWhen && { doneWhen: project.doneWhen }),
    ...(project.glossary && { glossary: project.glossary }),
    ...(project.status && { status: project.status as ProjectBriefView['status'] }),
    ...(project.targetDate && { targetDate: project.targetDate }),
    ...(project.leadId && { leadId: project.leadId }),
    ...(leadName && { leadName }),
    ...(project.decisionOwnerId && { decisionOwnerId: project.decisionOwnerId }),
    ...(decisionOwnerName && { decisionOwnerName }),
    goals: projectGoalViews(actor, project.id).map(({ id, title, level, status }) => ({ id, title, level, status })),
    canEdit: projectRoleCan.manage(projectRole(actor, project.id)),
  };
}

// ---- changes ----------------------------------------------------------------------------------------------

const notFound = () => new GoalError('Goal not found', 404);

function checkOwner(ownerId: string | null | undefined) {
  if (ownerId && !getUser(ownerId)) throw new GoalError('The owner must be a user of this instance');
}

/** The parent of a new or moved goal: it exists, `actor` sees it, a company goal's is a company goal, and the tree stays within its depth. */
function checkParent(actor: Actor, parentId: string, level: Goal['level'], below: { selfId?: string; height?: number }) {
  const parent = visibleGoal(actor, parentId);
  if (!parent) throw new GoalError('The parent goal was not found');
  if (level === 'company' && parent.level !== 'company') throw new GoalError('A company goal’s parent must be a company goal');
  if (below.selfId && (parent.id === below.selfId || isWithin(parent.id, below.selfId))) throw new GoalError('A goal can’t be moved under itself or one of its own sub-goals');
  if (depthOf(parent.id) + 1 + (below.height ?? 0) > GOAL_LIMITS.depth) throw new GoalError(`Goals go ${GOAL_LIMITS.depth} levels deep at most`);
}

export function createGoalAs(actor: Actor, body: CreateGoalBody): Goal {
  checkOwner(body.ownerId);
  const serving: string[] = [];
  if (body.level === 'company') {
    if (!isInstanceAdmin(actor)) throw new GoalError('Only owners and admins can add company goals', 403);
    for (const id of new Set(body.projectIds ?? [])) {
      if (!getProject(id)) throw new GoalError(`Project ${id} was not found`);
      if (!projectRoleCan.manage(projectRole(actor, id))) throw new GoalError('You must be an admin of each project that serves the goal', 403);
      if (projectGoalIds(id).length >= GOAL_LIMITS.goalsPerProject) throw new GoalError(`A project serves ${GOAL_LIMITS.goalsPerProject} goals at most`);
      serving.push(id);
    }
  } else {
    const project = body.projectId ? getProject(body.projectId) : undefined;
    if (!project || !projectRole(actor, project.id)) throw new GoalError('Project not found', 404);
    if (!projectRoleCan.manage(projectRole(actor, project.id))) throw new GoalError(`Only admins of “${project.name}” can add its goals`, 403);
    if (projectGoalIds(project.id).length >= GOAL_LIMITS.goalsPerProject) throw new GoalError(`A project serves ${GOAL_LIMITS.goalsPerProject} goals at most`);
  }
  if (body.parentId) checkParent(actor, body.parentId, body.level, {});
  return createGoal({ ...body, createdBy: actor.id }, serving);
}

export function updateGoalAs(actor: Actor, id: string, body: UpdateGoalBody): Goal {
  const goal = visibleGoal(actor, id);
  if (!goal) throw notFound();
  if (!canEditGoal(actor, goal)) throw new GoalError(goal.level === 'company' ? 'Only owners and admins can change company goals' : 'Only the project’s admins can change this goal', 403);
  checkOwner(body.ownerId);
  if (body.parentId && body.parentId !== goal.parentId) checkParent(actor, body.parentId, goal.level, { selfId: goal.id, height: heightBelow(goal.id) });
  return updateGoal(id, body);
}

export function deleteGoalAs(actor: Actor, id: string): void {
  const goal = visibleGoal(actor, id);
  if (!goal) throw notFound();
  if (!canEditGoal(actor, goal)) throw new GoalError('You can’t delete this goal', 403);
  deleteGoal(id);
}

/** Replace the initiatives of a goal: each must be a brain initiative `actor` may read (links they can't read stay). */
export function setInitiativesAs(actor: Actor, id: string, ids: string[]): Goal {
  const goal = visibleGoal(actor, id);
  if (!goal) throw notFound();
  if (!canEditGoal(actor, goal)) throw new GoalError('You can’t change this goal', 403);
  const bad = ids.filter((ref) => {
    const entity = getEntity('initiative', ref);
    return !entity || !canEntity(actor, entity, 'read');
  });
  if (bad.length) throw new GoalError(`Not initiatives you can read: ${bad.join(', ')}`);
  const hidden = (allInitiatives().get(id) ?? []).filter((ref) => {
    const entity = getEntity('initiative', ref);
    return !entity || !canEntity(actor, entity, 'read');
  });
  setInitiatives(id, [...ids, ...hidden.filter((ref) => !ids.includes(ref))], actor.id);
  return getGoal(id) as Goal;
}

/** Replace the goals a project serves, in order (its admins). Each is a goal `actor` sees: a company goal, or one of the project's own. */
export function setProjectGoalsAs(actor: Actor, projectId: string, goalIds: string[]): void {
  const project = getProject(projectId);
  if (!project || !projectRole(actor, projectId)) throw new GoalError('Project not found', 404);
  if (!projectRoleCan.manage(projectRole(actor, projectId))) throw new GoalError(`Only admins of “${project.name}” can change its goals`, 403);
  for (const id of goalIds) {
    const goal = visibleGoal(actor, id);
    if (!goal) throw new GoalError(`Goal ${id} was not found`);
    if (goal.level === 'project' && goal.projectId !== projectId) throw new GoalError(`“${goal.title}” belongs to another project`);
    const serving = projectsServing(id);
    if (!serving.includes(projectId) && serving.length >= GOAL_LIMITS.projectsPerGoal) throw new GoalError(`“${goal.title}” is served by ${GOAL_LIMITS.projectsPerGoal} projects already`);
  }
  setProjectGoals(projectId, goalIds);
}
