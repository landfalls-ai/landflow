/**
 * What a project's AI budget does (docs/projects-and-goals.md#ai-budget): the hard-stop limit the usage meter hands out
 * for the project's priced calls, the incidents (a warning, a stop), the sweep that opens them, what a person does with
 * one (resume, raise, dismiss) and the Needs you items. Rows and spend are in ./store.
 */
import { BUDGET_DEFAULTS, BUDGET_MAX_USD, budgetHref, projectCapId, type BudgetAction, type BudgetIncident, type BudgetNeedsYouFields, type ProjectBudget, type ProjectBudgetInput } from '../../shared/project-budget';
import { projectRoleCan } from '../../shared/projects';
import { recordAudit } from '../audit';
import { getUser } from '../auth/users';
import { database, type Database } from '../db';
import { HttpError } from '../errors';
import type { NeedsYouItem } from '../journal/needs-you';
import { projectRole, type Actor } from '../projects/access';
import { getProject, type ProjectRecord } from '../projects/store';
import { logger } from '../telemetry/logger';
import { onStopOpened, openStop } from './limit';
import { currentMonth, deleteBudget, getBudget, getIncident, incidentsOf, listBudgets, openIncident, openIncidents, resolveIncident, resolveOpenAsRaised, saveBudget, usedUsd, type BudgetMeter } from './store';

export class BudgetError extends HttpError {
  static readonly errorName: string = 'BudgetError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

/** A stop opened: audited (system actor) and logged once. */
onStopOpened((incident, budget) => {
  const name = getProject(budget.projectId)?.name ?? budget.projectId;
  recordAudit({
    action: 'project.budget.stopped',
    actor: 'system',
    target: { type: 'project', id: budget.projectId, name },
    project: budget.projectId,
    summary: `The AI budget of “${name}” was reached: its paid AI calls are refused until someone resumes or raises it`,
    details: { used: incident.usedUsd, budget: budget.monthlyUsd, incidentId: incident.id },
  });
  logger.warn('a project reached its AI budget', { 'landflow.project.id': budget.projectId, used: incident.usedUsd, budget: budget.monthlyUsd });
});

const money = (value: number) => `$${value.toFixed(2)}`;

/**
 * The warnings and stops the month's spend calls for: one warning per budget amount once spend reaches the warn share, and,
 * with a hard stop, a stop once it reaches the budget (spend that arrived by import, which no call check saw, included).
 * Sends nothing itself: the cost alerts and Needs you tell people.
 */
export async function sweepBudgets(now: number, meter: BudgetMeter, db: Database = database()): Promise<void> {
  const month = currentMonth(meter, now);
  for (const budget of listBudgets(db)) {
    const used = usedUsd(meter, budget.projectId, now);
    const incidents = incidentsOf(budget.projectId, month, db);
    if (used > 0 && used >= (budget.monthlyUsd * budget.warnPercent) / 100 && !incidents.some((i) => i.kind === 'warn' && i.budgetUsd === budget.monthlyUsd)) {
      openIncident(db, { projectId: budget.projectId, month, kind: 'warn', usedUsd: used, budgetUsd: budget.monthlyUsd, at: new Date(now).toISOString() });
    }
    if (budget.hardStop && used >= budget.monthlyUsd && !incidents.some((i) => i.kind === 'stop' && (i.status === 'open' || i.resolution === 'resumed'))) openStop(db, budget, month, used, now);
  }
}

// ---- what a person does -----------------------------------------------------------------------------------

export interface Viewer {
  actor: Actor;
  canEdit: boolean;
  canResume: boolean;
}

/** What `actor` may do with the project's budget: its admins (and instance owners and admins) edit; they and its owner resume and dismiss. */
export function viewerOf(actor: Actor, projectId: string, budget: ProjectBudget | undefined): Viewer {
  const canEdit = projectRoleCan.manage(projectRole(actor, projectId));
  return { actor, canEdit, canResume: canEdit || (Boolean(budget?.ownerId) && budget?.ownerId === actor.id) };
}

/** PUT: set (or, with 0, remove) the project's budget. */
export function putBudget(meter: BudgetMeter, project: Pick<ProjectRecord, 'id' | 'name'>, input: ProjectBudgetInput, actor: Actor, db: Database = database()): ProjectBudget | undefined {
  if (!Number.isFinite(input.monthlyUsd) || input.monthlyUsd < 0 || input.monthlyUsd > BUDGET_MAX_USD) throw new BudgetError(`The budget is 0 to ${BUDGET_MAX_USD.toLocaleString('en-US')} dollars a month`);
  const warnPercent = input.warnPercent ?? undefined;
  if (warnPercent !== undefined && (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100)) throw new BudgetError('The warning share is 1 to 100 percent');
  if (input.ownerId) {
    const owner = getUser(input.ownerId);
    if (!owner || !projectRole({ id: owner.id, role: owner.role }, project.id)) throw new BudgetError('The owner needs a role in the project');
  }
  const month = currentMonth(meter);
  const before = getBudget(project.id, db);
  const ownerId = input.ownerId === null ? undefined : (input.ownerId ?? before?.ownerId);
  let result: ProjectBudget | undefined;
  db.transaction(() => {
    if (input.monthlyUsd === 0) {
      if (before) deleteBudget(project.id, db);
      // A budget that no longer exists stops nothing.
      resolveOpenAsRaised(db, project.id, month, actor.id);
    } else {
      result = saveBudget(
        {
          projectId: project.id,
          monthlyUsd: input.monthlyUsd,
          warnPercent: warnPercent ?? before?.warnPercent ?? BUDGET_DEFAULTS.warnPercent,
          hardStop: input.hardStop ?? before?.hardStop ?? BUDGET_DEFAULTS.hardStop,
          ...(ownerId && { ownerId }),
          updatedAt: new Date().toISOString(),
          updatedBy: actor.id,
        },
        db,
      );
      // A higher budget settles the month's open incidents: they were about the old amount.
      if (before && input.monthlyUsd > before.monthlyUsd) resolveOpenAsRaised(db, project.id, month, actor.id);
    }
  });
  meter.invalidateBudgets();
  const shape = (b: ProjectBudget | undefined) => (b ? { monthlyUsd: b.monthlyUsd, warnPercent: b.warnPercent, hardStop: b.hardStop, ...(b.ownerId && { ownerId: b.ownerId }) } : null);
  recordAudit({ action: 'project.budget.update', target: { type: 'project', id: project.id, name: project.name }, project: project.id, summary: `Changed the AI budget of “${project.name}”`, details: { from: shape(before), to: shape(result) } });
  return result;
}

/** POST …/incidents/:incidentId: resume, raise or dismiss. Throws BudgetError with the contract's status. */
export function actOnIncident(meter: BudgetMeter, project: Pick<ProjectRecord, 'id' | 'name'>, incidentId: string, action: BudgetAction, actor: Actor, db: Database = database()): void {
  const incident = getIncident(incidentId, db);
  if (!incident || incident.projectId !== project.id) throw new BudgetError('Incident not found', 404);
  const budget = getBudget(project.id, db);
  const viewer = viewerOf(actor, project.id, budget);
  if (action.action === 'raise' ? !viewer.canEdit : !viewer.canResume) throw new BudgetError(action.action === 'raise' ? 'Only the project’s admins raise its AI budget' : 'Only the project’s admins and its budget’s owner do this', 403);
  if (incident.status !== 'open') throw new BudgetError(`Already ${incident.resolution ?? incident.status}`, 409);
  const target = { type: 'project', id: project.id, name: project.name };
  if (action.action === 'resume') {
    if (incident.kind !== 'stop') throw new BudgetError('Only a stop is resumed; dismiss a warning');
    resolveIncident(db, incident.id, 'resumed', actor.id);
    meter.invalidateBudgets();
    recordAudit({ action: 'project.budget.resumed', target, project: project.id, summary: `Resumed the paid AI calls of “${project.name}” for the rest of the month`, details: { incidentId: incident.id, used: incident.usedUsd, budget: incident.budgetUsd } });
  } else if (action.action === 'dismiss') {
    if (incident.kind !== 'warn') throw new BudgetError('Only a warning is dismissed; resume or raise a stop');
    resolveIncident(db, incident.id, 'dismissed', actor.id);
    recordAudit({ action: 'project.budget.dismissed', target, project: project.id, summary: `Dismissed the AI budget warning of “${project.name}”`, details: { incidentId: incident.id } });
  } else {
    if (!budget) throw new BudgetError('The project has no AI budget now', 409);
    if (!Number.isFinite(action.monthlyUsd) || action.monthlyUsd <= budget.monthlyUsd) throw new BudgetError(`Raise it above the budget now (${money(budget.monthlyUsd)})`);
    if (action.monthlyUsd > BUDGET_MAX_USD) throw new BudgetError(`The budget is at most ${BUDGET_MAX_USD.toLocaleString('en-US')} dollars a month`);
    db.transaction(() => {
      saveBudget({ ...budget, monthlyUsd: action.monthlyUsd, updatedAt: new Date().toISOString(), updatedBy: actor.id }, db);
      resolveIncident(db, incident.id, 'raised', actor.id);
      // A stop's warning is about the same overrun.
      if (incident.kind === 'stop') for (const other of incidentsOf(project.id, incident.month, db)) if (other.kind === 'warn' && other.status === 'open') resolveIncident(db, other.id, 'raised', actor.id);
    });
    meter.invalidateBudgets();
    recordAudit({ action: 'project.budget.raised', target, project: project.id, summary: `Raised the AI budget of “${project.name}” to ${money(action.monthlyUsd)}`, details: { from: budget.monthlyUsd, to: action.monthlyUsd, incidentId: incident.id } });
  }
}

/** An approved cap request raised the budget: set it, resolve the month's open incidents as raised by the approver. */
export function raiseFromCapRequest(meter: BudgetMeter, projectId: string, value: number, approverId: string, db: Database = database()) {
  const budget = getBudget(projectId, db);
  if (!budget) throw new Error('The cap no longer exists');
  value = Math.min(value, BUDGET_MAX_USD); // a request may ask for up to 100 times the cap; a budget never passes its ceiling
  if (budget.monthlyUsd >= value) throw new Error(`The cap is already ${budget.monthlyUsd}`);
  const month = currentMonth(meter);
  db.transaction(() => {
    saveBudget({ ...budget, monthlyUsd: value, updatedAt: new Date().toISOString(), updatedBy: approverId }, db);
    resolveOpenAsRaised(db, projectId, month, approverId);
  });
  meter.invalidateBudgets();
  const name = getProject(projectId)?.name ?? projectId;
  recordAudit({ action: 'project.budget.raised', actor: { id: approverId }, target: { type: 'project', id: projectId, name }, project: projectId, summary: `Raised the AI budget of “${name}” to ${money(value)}`, details: { from: budget.monthlyUsd, to: value, via: 'cap-request', capId: projectCapId(projectId) } });
}

// ---- Needs you --------------------------------------------------------------------------------------------

export type BudgetNeedsYouItem = NeedsYouItem & BudgetNeedsYouFields;

/** An item for each open incident of this month in a project where `actor` is an admin, the budget's owner, or an instance owner or admin. */
export function budgetItems(actor: Actor, meter: BudgetMeter, db: Database = database(), now = Date.now()): BudgetNeedsYouItem[] {
  const items: BudgetNeedsYouItem[] = [];
  for (const incident of openIncidents(currentMonth(meter, now), db)) {
    const project = getProject(incident.projectId);
    if (!project) continue;
    const budget = getBudget(project.id, db);
    if (incident.kind === 'stop' && !budget?.hardStop) continue; // the hard stop went off: nothing is paused any more
    const viewer = viewerOf(actor, project.id, budget);
    if (!viewer.canEdit && !viewer.canResume) continue;
    const amounts = `(${money(incident.usedUsd)} of ${money(incident.budgetUsd)})`;
    const stop = incident.kind === 'stop';
    items.push({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'budget',
      projectId: project.id,
      incidentId: incident.id,
      incidentKind: incident.kind,
      href: budgetHref(project.id),
      title: stop ? `Project “${project.name}” paused: AI budget reached ${amounts}` : `Project “${project.name}” used ${Math.floor((incident.usedUsd / incident.budgetUsd) * 100)}% of its AI budget ${amounts}`,
      detail: stop ? 'Paid AI calls in this project are refused until someone resumes or raises the budget. Local models still run.' : 'Dismiss it, or raise the budget in the project’s settings.',
      canRaise: viewer.canEdit,
      canResume: viewer.canResume,
      since: incident.createdAt,
    });
  }
  return items;
}
