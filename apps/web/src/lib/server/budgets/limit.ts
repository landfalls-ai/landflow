/**
 * What the usage meter needs at call time for a project's hard-stop budget (docs/projects-and-goals.md#ai-budget): the
 * cached entry, the limit it hands out for a priced call and the stop incident it opens when the call finds it reached.
 * Kept small so the meter imports little; the rest of what a budget does is in ./enforce.
 */
import type { ProjectBudget, BudgetIncident } from '../../shared/project-budget';
import type { UsageLimit } from '../ai-usage/scope';
import type { Database } from '../db';
import { getProject } from '../projects/store';
import { singleton } from '../singleton';
import { currentMonth, getBudget, openIncident, resumedThisMonth, type BudgetMeter } from './store';

/** What the meter caches per project for a few seconds: the budget, the project's name and whether a stop was resumed this month. */
export interface BudgetEntry {
  budget: ProjectBudget;
  name: string;
  resumed: boolean;
}

/** The budget and resume state the meter needs for one project; undefined when the project has no budget that stops anything. */
export function budgetEntry(db: Database, projectId: string, month: string): BudgetEntry | undefined {
  const budget = getBudget(projectId, db);
  if (!budget || !(budget.monthlyUsd > 0) || !budget.hardStop) return undefined;
  return { budget, name: getProject(projectId)?.name ?? projectId, resumed: resumedThisMonth(db, projectId, month) };
}

/** The hard-stop limit for one priced call of a project (the meter has checked the call is priced and the budget stops). */
export function hardStopLimit(entry: BudgetEntry, used: () => number, onReached: UsageLimit['onReached']): UsageLimit {
  return {
    metric: 'cost',
    max: entry.budget.monthlyUsd,
    subject: `project “${entry.name}” this month`,
    setIn: `Project “${entry.name}” → Settings → AI budget`,
    used,
    ...(onReached && { onReached }),
  };
}

/** The limit was reached by a call: open the month's `stop` incident when none is open, and say so once. */
export function stopReached(meter: BudgetMeter, db: Database, budget: ProjectBudget, used: number, now = Date.now()) {
  const month = currentMonth(meter, now);
  openStop(db, budget, month, used, now);
}

/** Told when a stop incident opens (./enforce registers the audit event and the log line; kept out of here so the meter's imports stay few). */
const announcer = singleton('project-budget-stop', () => ({ fn: undefined as undefined | ((incident: BudgetIncident, budget: ProjectBudget) => void) }));

export function onStopOpened(fn: (incident: BudgetIncident, budget: ProjectBudget) => void) {
  announcer.fn = fn;
}

export function openStop(db: Database, budget: ProjectBudget, month: string, used: number, now: number): BudgetIncident | undefined {
  const incident = openIncident(db, { projectId: budget.projectId, month, kind: 'stop', usedUsd: used, budgetUsd: budget.monthlyUsd, at: new Date(now).toISOString() });
  if (incident) announcer.fn?.(incident, budget);
  return incident;
}

