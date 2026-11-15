/**
 * Goal progress (docs/projects-and-goals.md#progress): what moved a goal in a window, read for one person. Runs, spend and
 * work updates for every goal asked about come from one query each, never one per goal. Work events are read only through
 * the ledger's one visibility rule (`scopeClause` with the person as the viewer), so a private event counts for its owner
 * alone, whatever anyone's role. The nightly sync's "Goals that moved" is `goalsMovedFor`.
 */
import { personalProjectId } from '../../shared/projects';
import type { Goal } from '../../shared/goals';
import type { GoalMoved, GoalProgress } from '../../shared/goal-progress';
import { canEntity, getEntity } from '../brain/entities';
import { database } from '../db';
import type { SqlValue } from '../db';
import { isInstanceAdmin, visibleProjectIds, type Actor } from '../projects/access';
import { defaultProjectId, membershipsOf } from '../projects/store';
import { instanceTimezone } from '../settings';
import { scopeClause } from '../usage/query';
import { allInitiatives, allServing, listGoals } from './store';
import { visibleGoals } from './views';

const DAY_MS = 86_400_000;
const MAX_DEPTH = 4;
const MAX_UPDATE_ROWS = 5000;
const NIGHTLY_GOALS = 5;

const db = () => database();
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Every goal in the subtree of `root` (itself first), only through goals in `allowed`, depth at most MAX_DEPTH. */
function subtreeOf(root: string, kids: Map<string, string[]>, allowed: Set<string>): string[] {
  const out: string[] = [root];
  const seen = new Set(out);
  let level = [root];
  for (let depth = 1; depth < MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const id of level)
      for (const child of kids.get(id) ?? []) {
        if (seen.has(child) || !allowed.has(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    level = next;
  }
  return out;
}

const lower = (value: unknown): string | undefined => (typeof value === 'string' && value ? value.toLowerCase() : undefined);

interface Counts {
  ok: number;
  failed: number;
  cost: number;
  updates: number;
  last: string;
}

/**
 * The progress of each goal in `goalIds` over `window` days back from `now` (or from `options.since`, the nightly sync's own
 * start), for `actor`. Each goal counts itself and the sub-goals the actor sees; projects, spend and work events are read
 * only where the actor may see them. A goal the actor cannot see (or an unknown one) answers an empty progress.
 */
export function progressFor(actor: Actor, goalIds: string[], window: GoalProgress['window'], now = Date.now(), options: { since?: number; until?: number } = {}): GoalProgress[] {
  if (!goalIds.length) return [];
  const from = new Date(options.since ?? now - window * DAY_MS).toISOString();
  const to = new Date(Math.min(now, options.until ?? now)).toISOString();
  const projects = visibleProjectIds(actor);
  const admin = isInstanceAdmin(actor);
  const all = listGoals();
  const goals = visibleGoals(actor, all, projects);
  const allowed = new Set(goals.map((goal) => goal.id));
  const byId = new Map(all.map((goal) => [goal.id, goal]));
  const kids = new Map<string, string[]>();
  for (const goal of goals) if (goal.parentId) kids.set(goal.parentId, [...(kids.get(goal.parentId) ?? []), goal.id]);
  const serving = allServing();
  const initiatives = allInitiatives();

  const members = new Map<string, string[]>(goalIds.filter((id) => allowed.has(id)).map((id) => [id, subtreeOf(id, kids, allowed)]));
  const memberRoots = new Map<string, string[]>();
  const projectRoots = new Map<string, string[]>();
  const initiativeRoots = new Map<string, string[]>();
  const readable = new Map<string, string[] | undefined>();
  const keysOf = (ref: string): string[] | undefined => {
    if (!readable.has(ref)) {
      const entity = getEntity('initiative', ref);
      readable.set(ref, entity && canEntity(actor, entity, 'read') ? [ref.toLowerCase(), entity.name.toLowerCase()] : undefined);
    }
    return readable.get(ref);
  };
  const push = (map: Map<string, string[]>, key: string, root: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(root)) list.push(root);
    map.set(key, list);
  };
  for (const root of members.keys())
    for (const id of members.get(root) ?? []) {
      push(memberRoots, id, root);
      const goal: Goal | undefined = byId.get(id);
      for (const projectId of [...(serving.get(id) ?? []), ...(goal?.projectId ? [goal.projectId] : [])]) if (!projects || projects.has(projectId)) push(projectRoots, projectId, root);
      for (const ref of initiatives.get(id) ?? []) for (const key of keysOf(ref) ?? []) push(initiativeRoots, key, root);
    }

  const counts = new Map<string, Counts>(goalIds.map((id) => [id, { ok: 0, failed: 0, cost: 0, updates: 0, last: '' }]));
  const bump = (roots: string[] | undefined, patch: Partial<Pick<Counts, 'ok' | 'failed' | 'cost' | 'updates'>>, at: string) => {
    for (const root of roots ?? []) {
      const c = counts.get(root);
      if (!c) continue;
      c.ok += patch.ok ?? 0;
      c.failed += patch.failed ?? 0;
      c.cost += patch.cost ?? 0;
      c.updates += patch.updates ?? 0;
      if (at > c.last) c.last = at;
    }
  };

  // Runs: one `executions` row each, finished ones only, of workflows homed in a serving project.
  const projectIds = [...projectRoots.keys()];
  if (projectIds.length) {
    // A workflow with no `project_resources` row is homed in the default project (the owner's personal one).
    const fallback = defaultProjectId();
    const unhomed = fallback !== undefined && projectIds.includes(fallback);
    const rows = db().all<{ project_id: string | null; status: string; n: number; last: string }>(
      `SELECT pr.project_id AS project_id, e.status AS status, COUNT(*) AS n, MAX(COALESCE(e.finished_at, e.started_at)) AS last
       FROM executions e LEFT JOIN project_resources pr ON pr.kind = 'workflow' AND pr.resource_id = e.workflow_id
       WHERE e.status IN ('success', 'error') AND e.evaluation_run_id IS NULL AND COALESCE(e.finished_at, e.started_at) >= ? AND COALESCE(e.finished_at, e.started_at) <= ?
         AND (pr.project_id IN (${marks(projectIds.length)})${unhomed ? ' OR pr.project_id IS NULL' : ''})
       GROUP BY pr.project_id, e.status`,
      from,
      to,
      ...projectIds,
    );
    for (const row of rows) bump(projectRoots.get(row.project_id ?? fallback ?? ''), row.status === 'success' ? { ok: Number(row.n) } : { failed: Number(row.n) }, row.last);
  }

  // Spend attributed to the goals (or their sub-goals), from projects the actor may see.
  const memberIds = [...memberRoots.keys()];
  if (memberIds.length) {
    const params: SqlValue[] = [from, to, ...memberIds];
    let visible = '';
    if (!admin && projects) {
      const ids = [...projects];
      visible = ids.length ? ` AND project_id IN (${marks(ids.length)})` : ' AND 1 = 0';
      params.push(...ids);
    }
    const rows = db().all<{ goal_id: string; cost: number | null; last: string }>(
      `SELECT goal_id, SUM(cost) AS cost, MAX(at) AS last FROM ai_usage WHERE at >= ? AND at <= ? AND goal_id IN (${marks(memberIds.length)})${visible} GROUP BY goal_id`,
      ...params,
    );
    for (const row of rows) bump(memberRoots.get(row.goal_id), { cost: Number(row.cost ?? 0) }, row.last);
  }

  // Work events: the ledger's visibility rule for this person, then attributed in code (ids and times only, never titles).
  if (memberIds.length || projectIds.length || initiativeRoots.size) {
    const where = [`kind LIKE 'work.%'`, 'source_id IS NOT NULL', 'at >= ?', 'at <= ?'];
    const params: SqlValue[] = [from, to];
    const links: string[] = [];
    if (memberIds.length) {
      links.push(`goal_id IN (${marks(memberIds.length)})`);
      params.push(...memberIds);
    }
    if (projectIds.length) {
      links.push(`project_id IN (${marks(projectIds.length)})`);
      params.push(...projectIds);
    }
    if (initiativeRoots.size) links.push(`attrs LIKE '%initiative%'`);
    where.push(`(${links.join(' OR ')})`);
    scopeClause({ viewerId: actor.id }, where, params);
    const rows = db().all<{ id: string; goal_id: string | null; project_id: string | null; attrs: string | null; at: string }>(
      `SELECT id, goal_id, project_id, attrs, at FROM usage_events WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ${MAX_UPDATE_ROWS}`,
      ...params,
    );
    for (const row of rows) {
      const roots = new Set<string>();
      for (const root of (row.goal_id && memberRoots.get(row.goal_id)) || []) roots.add(root);
      for (const root of (row.project_id && projectRoots.get(row.project_id)) || []) roots.add(root);
      if (row.attrs && initiativeRoots.size) {
        let initiative: string | undefined;
        try {
          initiative = lower((JSON.parse(row.attrs) as Record<string, unknown>).initiative);
        } catch {
          initiative = undefined;
        }
        for (const root of (initiative && initiativeRoots.get(initiative)) || []) roots.add(root);
      }
      bump([...roots], { updates: 1 }, row.at);
    }
  }

  return goalIds.map((goalId) => {
    const c = counts.get(goalId) as Counts;
    const cost = Math.round(c.cost * 1e6) / 1e6;
    return { goalId, window, runs: { ok: c.ok, failed: c.failed }, costUsd: cost, updates: c.updates, moved: c.ok + c.failed + c.updates > 0 || cost > 0, ...(c.last && { lastActivityAt: c.last }) };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Count-only words for why a goal moved: `4 runs ok, 2 updates`, `1 failed run`, `$0.12 spent`. No titles, no names. */
export function becauseText(progress: GoalProgress): string {
  const parts: string[] = [];
  if (progress.runs.ok) parts.push(`${plural(progress.runs.ok, 'run')} ok`);
  if (progress.runs.failed) parts.push(`${progress.runs.failed} failed ${progress.runs.failed === 1 ? 'run' : 'runs'}`);
  if (progress.updates) parts.push(plural(progress.updates, 'update'));
  if (progress.costUsd > 0) parts.push(`${progress.costUsd < 0.01 ? '< $0.01' : `$${progress.costUsd.toFixed(2)}`} spent`);
  return parts.join(', ');
}

/** The instant a calendar day (YYYY-MM-DD) starts in the instance time zone. */
function startOfDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date);
  let zone = 'UTC';
  try {
    zone = instanceTimezone();
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return guess;
}

/**
 * The goals of the projects `actor` has a role in (their own projects' goals and the company goals those serve) that moved
 * in the two days the nightly sync reads (the day before `day`, and `day` so far), as that person sees them: at most five,
 * the busiest first. Only counts and goal titles; never a work event's words.
 */
export function goalsMovedFor(actor: Actor, day: string, now = Date.now()): GoalMoved[] {
  const [year, month, date] = day.split('-').map(Number);
  const before = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  const projectIds = new Set([personalProjectId(actor.id), ...membershipsOf(actor.id).map((m) => m.projectId)]);
  const serving = allServing();
  const visible = visibleGoals(actor).filter((goal) => goal.status !== 'cancelled' && (goal.projectId ? projectIds.has(goal.projectId) : (serving.get(goal.id) ?? []).some((id) => projectIds.has(id))));
  if (!visible.length) return [];
  const titles = new Map(visible.map((goal) => [goal.id, goal.title]));
  const found = progressFor(actor, visible.map((goal) => goal.id), 1, now, { since: startOfDay(before), until: startOfDay(next) - 1 }).filter((p) => p.moved);
  return found
    .sort((a, b) => b.runs.ok + b.runs.failed + b.updates - (a.runs.ok + a.runs.failed + a.updates) || (titles.get(a.goalId) ?? '').localeCompare(titles.get(b.goalId) ?? ''))
    .slice(0, NIGHTLY_GOALS)
    .map((p) => ({ goalId: p.goalId, title: titles.get(p.goalId) ?? '', because: becauseText(p) }));
}
