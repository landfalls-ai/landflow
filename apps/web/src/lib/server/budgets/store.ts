/**
 * A project's monthly AI budget (docs/projects-and-goals.md#ai-budget): the rows (`project_budgets`, one per project),
 * its incidents (`project_budget_incidents`), the month's spend and the view the routes answer with. Spend is every
 * `ai_usage` row of the project this month, from every source (Landflow's meter and the LiteLLM import). The rules that
 * stop calls and open incidents are in ./enforce.
 */
import { createHash } from 'node:crypto';
import { projectCapId, type BudgetIncident, type BudgetIncidentKind, type ProjectBudget, type ProjectBudgetView } from '../../shared/project-budget';
import { findPrice, priceOverrides } from '../ai-usage/prices';
import { database, type Database } from '../db';

interface BudgetRow {
  project_id: string;
  monthly_usd: number;
  warn_percent: number;
  hard_stop: number;
  owner_id: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface IncidentRow {
  id: string;
  project_id: string;
  month: string;
  kind: string;
  status: string;
  used_usd: number;
  budget_usd: number;
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

const budgetOf = (row: BudgetRow): ProjectBudget => ({
  projectId: row.project_id,
  monthlyUsd: Number(row.monthly_usd),
  warnPercent: Number(row.warn_percent),
  hardStop: Number(row.hard_stop) === 1,
  ...(row.owner_id && { ownerId: row.owner_id }),
  updatedAt: row.updated_at,
  ...(row.updated_by && { updatedBy: row.updated_by }),
});

const incidentOf = (row: IncidentRow): BudgetIncident => ({
  id: row.id,
  projectId: row.project_id,
  month: row.month,
  kind: row.kind as BudgetIncident['kind'],
  status: row.status as BudgetIncident['status'],
  usedUsd: Number(row.used_usd),
  budgetUsd: Number(row.budget_usd),
  ...(row.resolution && { resolution: row.resolution as BudgetIncident['resolution'] }),
  ...(row.resolved_by && { resolvedBy: row.resolved_by }),
  createdAt: row.created_at,
  ...(row.resolved_at && { resolvedAt: row.resolved_at }),
});

// ---- budgets ----------------------------------------------------------------------------------------------

export function getBudget(projectId: string, db: Database = database()): ProjectBudget | undefined {
  const row = db.get<BudgetRow>('SELECT * FROM project_budgets WHERE project_id = ?', projectId);
  return row && budgetOf(row);
}

/** Every budget that sets an amount (the sweep and the watched caps read these). */
export function listBudgets(db: Database = database()): ProjectBudget[] {
  return db.all<BudgetRow>('SELECT * FROM project_budgets WHERE monthly_usd > 0 ORDER BY project_id').map(budgetOf);
}

export function saveBudget(budget: ProjectBudget, db: Database = database()): ProjectBudget {
  const next = { ...budget, updatedAt: budget.updatedAt ?? new Date().toISOString() };
  db.upsert('project_budgets', {
    project_id: next.projectId,
    monthly_usd: next.monthlyUsd,
    warn_percent: next.warnPercent,
    hard_stop: next.hardStop ? 1 : 0,
    owner_id: next.ownerId ?? null,
    updated_at: next.updatedAt,
    updated_by: next.updatedBy ?? null,
  });
  return next;
}

export function deleteBudget(projectId: string, db: Database = database()) {
  db.delete('project_budgets', { project_id: projectId });
}

// ---- incidents --------------------------------------------------------------------------------------------

export function getIncident(id: string, db: Database = database()): BudgetIncident | undefined {
  const row = db.get<IncidentRow>('SELECT * FROM project_budget_incidents WHERE id = ?', id);
  return row && incidentOf(row);
}

/** The project's incidents of `month`, newest first. */
export function incidentsOf(projectId: string, month: string, db: Database = database()): BudgetIncident[] {
  return db.all<IncidentRow>('SELECT * FROM project_budget_incidents WHERE project_id = ? AND month = ? ORDER BY created_at DESC, id DESC', projectId, month).map(incidentOf);
}

/** The open incidents of `month` across projects (Needs you). */
export function openIncidents(month: string, db: Database = database()): BudgetIncident[] {
  return db.all<IncidentRow>("SELECT * FROM project_budget_incidents WHERE month = ? AND status = 'open' ORDER BY created_at DESC, id DESC", month).map(incidentOf);
}

/**
 * Open an incident unless one of its kind is open for the project and month. A race that passes the check is stopped by
 * the unique index on open incidents: nothing is inserted twice. Returns the new incident, or undefined.
 */
export function openIncident(db: Database, input: { projectId: string; month: string; kind: BudgetIncidentKind; usedUsd: number; budgetUsd: number; at?: string }): BudgetIncident | undefined {
  if (db.get('SELECT 1 AS found FROM project_budget_incidents WHERE project_id = ? AND month = ? AND kind = ? AND status = ?', input.projectId, input.month, input.kind, 'open')) return undefined;
  // Deterministic, so two processes (each with its own copy of the rows) that open the same incident compute the same
  // id and the replay's ON CONFLICT (id) drops the second, instead of the partial unique index rejecting it on Postgres.
  const earlier = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM project_budget_incidents WHERE project_id = ? AND month = ? AND kind = ?', input.projectId, input.month, input.kind)?.n ?? 0);
  const id = `pbi_${createHash('sha256').update(`${input.projectId}|${input.month}|${input.kind}|${earlier}`).digest('hex').slice(0, 12)}`;
  try {
    const inserted = db.insertNew('project_budget_incidents', {
      id,
      project_id: input.projectId,
      month: input.month,
      kind: input.kind,
      status: 'open',
      used_usd: input.usedUsd,
      budget_usd: input.budgetUsd,
      created_at: input.at ?? new Date().toISOString(),
    });
    return inserted ? getIncident(id, db) : undefined;
  } catch {
    // The unique index: another caller opened it first.
    return undefined;
  }
}

/** Resolve an open incident (`dismissed` for a warning put away, else `resolved`). Returns it, or undefined when it was not open. */
export function resolveIncident(db: Database, id: string, resolution: 'resumed' | 'raised' | 'dismissed', by?: string, at = new Date().toISOString()): BudgetIncident | undefined {
  const row = db.get<IncidentRow>('SELECT * FROM project_budget_incidents WHERE id = ?', id);
  if (!row || row.status !== 'open') return undefined;
  db.upsert('project_budget_incidents', { ...row, status: resolution === 'dismissed' ? 'dismissed' : 'resolved', resolution, resolved_by: by ?? null, resolved_at: at });
  return incidentOf({ ...row, status: resolution === 'dismissed' ? 'dismissed' : 'resolved', resolution, resolved_by: by ?? null, resolved_at: at });
}

/** Resolve the project's open incidents of `month` as `raised`; returns how many. */
export function resolveOpenAsRaised(db: Database, projectId: string, month: string, by?: string): number {
  let n = 0;
  for (const incident of incidentsOf(projectId, month, db)) if (incident.status === 'open' && resolveIncident(db, incident.id, 'raised', by)) n += 1;
  return n;
}

/** Whether a `stop` of the month was resolved `resumed`: its priced calls go on until the month ends. */
export function resumedThisMonth(db: Database, projectId: string, month: string): boolean {
  return Boolean(db.get("SELECT 1 AS found FROM project_budget_incidents WHERE project_id = ? AND month = ? AND kind = 'stop' AND resolution = 'resumed'", projectId, month));
}

// ---- spend ------------------------------------------------------------------------------------------------

/** The part of the usage meter (ai-usage/index.ts `BudgetMeter`) the budgets read: the day and the project's totals. */
export interface BudgetMeter {
  today(now?: number): string;
  /** Drop the meter's cached project budgets after a write. */
  invalidateBudgets(): void;
  sinceTotals(column: 'project_id', id: string, period: 'month', day?: string): { cost: number };
}

/** The current month, YYYY-MM, in the instance time zone. */
export const currentMonth = (meter: BudgetMeter, now = Date.now()): string => meter.today(now).slice(0, 7);

/** What the project used this month from every source (priced by Landflow, or reported by the gateway). */
export const usedUsd = (meter: BudgetMeter, projectId: string, now = Date.now()): number => meter.sinceTotals('project_id', projectId, 'month', meter.today(now)).cost;

/** This month's calls to models the price table does not price: one grouped query, never row by row. */
export function unpricedCalls(meter: BudgetMeter, projectId: string, db: Database = database(), now = Date.now()): number {
  const rows = db.all<{ provider: string | null; model: string | null; calls: number }>(
    'SELECT provider, model, COUNT(*) AS calls FROM ai_usage WHERE project_id = ? AND day >= ? GROUP BY provider, model LIMIT 500',
    projectId,
    `${currentMonth(meter, now)}-01`,
  );
  const overrides = priceOverrides(db);
  return rows.reduce((sum, row) => (findPrice(row.provider ?? '', row.model ?? '', overrides) ? sum : sum + Number(row.calls)), 0);
}

// ---- the view ---------------------------------------------------------------------------------------------

export interface ViewFlags {
  canEdit: boolean;
  canResume: boolean;
  canAsk: boolean;
}

/** The ProjectBudgetView for one project and month. */
export function budgetView(meter: BudgetMeter, projectId: string, flags: ViewFlags, db: Database = database(), now = Date.now()): ProjectBudgetView {
  const budget = getBudget(projectId, db);
  const month = currentMonth(meter, now);
  const used = round(usedUsd(meter, projectId, now));
  const incidents = incidentsOf(projectId, month, db);
  const hasBudget = Boolean(budget && budget.monthlyUsd > 0);
  return {
    ...(hasBudget && budget && { budget }),
    month,
    usedUsd: used,
    unpricedCalls: unpricedCalls(meter, projectId, db, now),
    percent: hasBudget && budget ? Math.round((used / budget.monthlyUsd) * 100) : 0,
    paused: hasBudget && Boolean(budget?.hardStop) && incidents.some((i) => i.kind === 'stop' && i.status === 'open'),
    incidents,
    canEdit: flags.canEdit,
    canResume: flags.canResume,
    canAsk: flags.canAsk && hasBudget,
    ...(hasBudget && { capId: projectCapId(projectId) }),
  };
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;
