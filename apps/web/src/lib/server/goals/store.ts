/**
 * Goals in the database (migration 2300): the tree of goals, the goals each project serves in order, and the brain
 * initiatives a goal links. Plain data and its invariants; who may see or change what is in ./views. Every change is
 * audited here (`goal.created`, `goal.updated`, `goal.deleted`, `project.goals_changed`).
 */
import { nanoid } from 'nanoid';
import { GOAL_LIMITS, type Goal, type GoalLevel, type GoalStatus } from '../../shared/goals';
import { recordAudit } from '../audit';
import { database } from '../db';
import { HttpError } from '../errors';

interface GoalRow {
  id: string;
  title: string;
  why: string | null;
  level: string;
  status: string;
  owner_id: string | null;
  target_date: string | null;
  parent_id: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export class GoalError extends HttpError {
  static readonly errorName: string = 'GoalError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

export class GoalHasChildren extends HttpError {
  static readonly errorName: string = 'GoalHasChildren';
  constructor() {
    super('Move or delete its sub-goals first', 409, { expose: true });
  }
}

const db = () => database();

function goalFrom(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    ...(row.why && { why: row.why }),
    level: row.level === 'project' ? 'project' : 'company',
    status: row.status as GoalStatus,
    ...(row.owner_id && { ownerId: row.owner_id }),
    ...(row.target_date && { targetDate: row.target_date }),
    ...(row.parent_id && { parentId: row.parent_id }),
    ...(row.project_id && { projectId: row.project_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by && { createdBy: row.created_by }),
  };
}

const goalRow = (goal: Goal) => ({
  id: goal.id,
  title: goal.title,
  why: goal.why ?? null,
  level: goal.level,
  status: goal.status,
  owner_id: goal.ownerId ?? null,
  target_date: goal.targetDate ?? null,
  parent_id: goal.parentId ?? null,
  project_id: goal.projectId ?? null,
  created_at: goal.createdAt,
  updated_at: goal.updatedAt,
  created_by: goal.createdBy ?? null,
});

/** Audit details are flat: `{ title: { from, to } }` becomes `titleFrom` and `titleTo`. */
export const flat = (changes: Record<string, { from: string | null; to: string | null }>): Record<string, string | null> =>
  Object.fromEntries(Object.entries(changes).flatMap(([field, change]) => [[`${field}From`, change.from], [`${field}To`, change.to]]));

// ---- reads ------------------------------------------------------------------------------------------------

/** Every goal, oldest first (the tree orders siblings by creation). Not capped here: `goalsResponse` filters to what the viewer sees and then keeps the first `GOAL_LIMITS.list`. */
export function listGoals(): Goal[] {
  return db().all<GoalRow>('SELECT * FROM goals ORDER BY created_at, id').map(goalFrom);
}

export function getGoal(id: string): Goal | undefined {
  const row = db().get<GoalRow>('SELECT * FROM goals WHERE id = ?', id);
  return row && goalFrom(row);
}

export const childrenOf = (id: string): Goal[] => db().all<GoalRow>('SELECT * FROM goals WHERE parent_id = ? ORDER BY created_at, id', id).map(goalFrom);

/** The goal and its parents, root first, the goal itself last (cut at `limit`, keeping the goal and its nearest parents). */
export function chain(id: string, limit: number = GOAL_LIMITS.depth): Goal[] {
  const out: Goal[] = [];
  const seen = new Set<string>();
  for (let goal = getGoal(id); goal && !seen.has(goal.id) && out.length < limit; goal = goal.parentId ? getGoal(goal.parentId) : undefined) {
    seen.add(goal.id);
    out.unshift(goal);
  }
  return out;
}

/** A goal's depth: a root is 1. */
export const depthOf = (id: string): number => chain(id, 100).length;

/** How many levels the goal's own subtree adds below it (a goal without children: 0). */
export function heightBelow(id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  return childrenOf(id).reduce((max, child) => Math.max(max, 1 + heightBelow(child.id, seen)), 0);
}

/** Whether `id` is `of` or one of its descendants. */
export function isWithin(id: string, of: string): boolean {
  return chain(id, 100).some((goal) => goal.id === of);
}

/** The goals a project serves, in order (cancelled ones too unless `withoutCancelled`). */
export function projectGoalIds(projectId: string, options: { withoutCancelled?: boolean } = {}): string[] {
  return db()
    .all<{ goal_id: string; status: string | null }>(
      `SELECT pg.goal_id AS goal_id, g.status AS status FROM project_goals pg LEFT JOIN goals g ON g.id = pg.goal_id WHERE pg.project_id = ? ORDER BY pg.position, pg.created_at, pg.goal_id`,
      projectId,
    )
    .filter((row) => row.status && (!options.withoutCancelled || row.status !== 'cancelled'))
    .map((row) => row.goal_id);
}

/** Project ids that serve a goal. */
export const projectsServing = (goalId: string): string[] => db().all<{ project_id: string }>('SELECT project_id FROM project_goals WHERE goal_id = ? ORDER BY created_at, project_id', goalId).map((r) => r.project_id);

/** Every goal's serving projects, by goal id. */
export function allServing(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of db().all<{ goal_id: string; project_id: string }>('SELECT goal_id, project_id FROM project_goals ORDER BY created_at, project_id')) {
    const list = map.get(row.goal_id) ?? [];
    list.push(row.project_id);
    map.set(row.goal_id, list);
  }
  return map;
}

/** Linked initiative ids, by goal id (every goal with a link). */
export function allInitiatives(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of db().all<{ goal_id: string; ref_id: string }>(`SELECT goal_id, ref_id FROM goal_links WHERE kind = 'initiative' ORDER BY created_at, ref_id`)) {
    const list = map.get(row.goal_id) ?? [];
    list.push(row.ref_id);
    map.set(row.goal_id, list);
  }
  return map;
}

// ---- writes -----------------------------------------------------------------------------------------------

export interface GoalInput {
  title: string;
  why?: string;
  level: GoalLevel;
  status?: GoalStatus;
  ownerId?: string;
  targetDate?: string;
  parentId?: string;
  projectId?: string;
  createdBy?: string;
}

/** Add a goal. A project goal also goes at the end of its home project's list. The caller has checked who may. */
export function createGoal(input: GoalInput, alsoServes: string[] = []): Goal {
  const now = new Date().toISOString();
  const goal: Goal = {
    id: `goal_${nanoid(10)}`,
    title: input.title.trim().slice(0, GOAL_LIMITS.title),
    ...(input.why?.trim() && { why: input.why.trim().slice(0, GOAL_LIMITS.why) }),
    level: input.level,
    status: input.status ?? 'active',
    ...(input.ownerId && { ownerId: input.ownerId }),
    ...(input.targetDate && { targetDate: input.targetDate }),
    ...(input.parentId && { parentId: input.parentId }),
    ...(input.level === 'project' && input.projectId && { projectId: input.projectId }),
    createdAt: now,
    updatedAt: now,
    ...(input.createdBy && { createdBy: input.createdBy }),
  };
  const serving = [...new Set([...(goal.projectId ? [goal.projectId] : []), ...alsoServes])];
  db().transaction(() => {
    db().insertNew('goals', goalRow(goal));
    for (const projectId of serving) appendToProject(projectId, goal.id, now);
  });
  recordAudit({ action: 'goal.created', target: { type: 'goal', id: goal.id, name: goal.title }, ...(goal.projectId && { project: goal.projectId }), summary: `Created the ${goal.level} goal ${goal.title}`, details: { level: goal.level, status: goal.status, ...(goal.parentId && { parentId: goal.parentId }), ...(goal.projectId && { projectId: goal.projectId }) } });
  for (const projectId of serving) recordAudit({ action: 'project.goals_changed', target: { type: 'project', id: projectId }, project: projectId, summary: `Added the goal ${goal.title} to a project`, details: { goalIds: projectGoalIds(projectId).join(',') } });
  return goal;
}

function appendToProject(projectId: string, goalId: string, now: string) {
  const last = db().get<{ n: number | null }>('SELECT MAX(position) AS n FROM project_goals WHERE project_id = ?', projectId)?.n;
  db().upsert('project_goals', { project_id: projectId, goal_id: goalId, position: last === null || last === undefined ? 0 : Number(last) + 1, created_at: now });
}

export type GoalPatch = { title?: string; why?: string | null; status?: GoalStatus; ownerId?: string | null; targetDate?: string | null; parentId?: string | null };

/** Change a goal. Audits `goal.updated` with each changed field's old and new value. */
export function updateGoal(id: string, patch: GoalPatch): Goal {
  const goal = getGoal(id);
  if (!goal) throw new GoalError('Goal not found', 404);
  const next: Goal = { ...goal, updatedAt: new Date().toISOString() };
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  const set = (field: 'title' | 'why' | 'status' | 'ownerId' | 'targetDate' | 'parentId', value: string | null | undefined) => {
    if (value === undefined) return;
    const clean = typeof value === 'string' ? value.trim() || undefined : undefined;
    if (field === 'title' && !clean) throw new GoalError('Give the goal a title');
    if (clean === goal[field]) return;
    changes[field] = { from: goal[field] ?? null, to: clean ?? null };
    if (clean === undefined) delete next[field];
    else (next as unknown as Record<string, string>)[field] = field === 'title' ? clean.slice(0, GOAL_LIMITS.title) : field === 'why' ? clean.slice(0, GOAL_LIMITS.why) : clean;
  };
  set('title', patch.title);
  set('why', patch.why);
  set('status', patch.status);
  set('ownerId', patch.ownerId);
  set('targetDate', patch.targetDate);
  set('parentId', patch.parentId);
  if (!Object.keys(changes).length) return goal;
  db().upsert('goals', goalRow(next));
  recordAudit({ action: 'goal.updated', target: { type: 'goal', id, name: next.title }, ...(next.projectId && { project: next.projectId }), summary: `Changed the goal ${next.title} (${Object.keys(changes).join(', ')})`, details: flat(changes) });
  return next;
}

/** Delete a goal with its project and initiative links; a goal with sub-goals is refused (409). */
export function deleteGoal(id: string): boolean {
  const goal = getGoal(id);
  if (!goal) return false;
  if (childrenOf(id).length) throw new GoalHasChildren();
  const serving = projectsServing(id);
  db().transaction(() => {
    for (const projectId of serving) db().delete('project_goals', { project_id: projectId, goal_id: id });
    for (const row of db().all<{ kind: string; ref_id: string }>('SELECT kind, ref_id FROM goal_links WHERE goal_id = ?', id)) db().delete('goal_links', { goal_id: id, kind: row.kind, ref_id: row.ref_id });
    db().delete('goals', { id });
  });
  recordAudit({ action: 'goal.deleted', target: { type: 'goal', id, name: goal.title }, ...(goal.projectId && { project: goal.projectId }), summary: `Deleted the goal ${goal.title}`, details: { level: goal.level } });
  return true;
}

/** Replace the goals a project serves, in order. The caller has checked who may and that every goal is one it may serve. */
export function setProjectGoals(projectId: string, goalIds: string[]): string[] {
  const before = projectGoalIds(projectId);
  const ids = [...new Set(goalIds)];
  const now = new Date().toISOString();
  db().transaction(() => {
    for (const goalId of before) if (!ids.includes(goalId)) db().delete('project_goals', { project_id: projectId, goal_id: goalId });
    const created = new Map(db().all<{ goal_id: string; created_at: string }>('SELECT goal_id, created_at FROM project_goals WHERE project_id = ?', projectId).map((r) => [r.goal_id, r.created_at]));
    ids.forEach((goalId, position) => db().upsert('project_goals', { project_id: projectId, goal_id: goalId, position, created_at: created.get(goalId) ?? now }));
  });
  if (before.join() !== ids.join()) recordAudit({ action: 'project.goals_changed', target: { type: 'project', id: projectId }, project: projectId, summary: `Changed the goals of a project (${before.length} to ${ids.length})`, details: { from: before.join(','), to: ids.join(',') } });
  return ids;
}

/** Replace a goal's linked initiatives. The caller has checked each is an initiative the actor may read. */
export function setInitiatives(goalId: string, ids: string[], createdBy?: string): string[] {
  const wanted = [...new Set(ids)];
  const before = allInitiatives().get(goalId) ?? [];
  const now = new Date().toISOString();
  db().transaction(() => {
    for (const refId of before) if (!wanted.includes(refId)) db().delete('goal_links', { goal_id: goalId, kind: 'initiative', ref_id: refId });
    for (const refId of wanted) if (!before.includes(refId)) db().upsert('goal_links', { goal_id: goalId, kind: 'initiative', ref_id: refId, created_at: now, created_by: createdBy ?? null });
  });
  if (before.join() !== wanted.join()) {
    const goal = getGoal(goalId);
    recordAudit({ action: 'goal.updated', target: { type: 'goal', id: goalId, name: goal?.title }, ...(goal?.projectId && { project: goal.projectId }), summary: `Changed the initiatives linked to the goal ${goal?.title ?? goalId}`, details: { initiativesFrom: before.join(','), initiativesTo: wanted.join(',') } });
  }
  return wanted;
}
