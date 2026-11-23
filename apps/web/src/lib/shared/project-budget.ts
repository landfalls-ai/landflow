/**
 * A project's monthly AI budget (docs/projects-and-goals.md#ai-budget), shared by the server (lib/server/budgets) and the
 * client. No runtime imports, no zod. Written by the plan for Paperclip wave 9: PC14 owns it and PC15 copies it byte for
 * byte. It replaces the wave-7 draft (contracts/pc-w9): the budget is one more cap in LiteLLM wave L1's cap system (its
 * cap id is `project:<projectId>:month:cost`, Insights → AI lists it and "Ask for more" goes through the cap-raise flow),
 * with what a cap has not got: a warning, an optional hard stop, incidents and Needs you items.
 */
export const BUDGET_DEFAULTS = { warnPercent: 80, hardStop: false } as const;

/** The most a project's monthly budget may be, in USD. */
export const BUDGET_MAX_USD = 1_000_000;

/** The watched cap's id for a project's budget (lib/server/ai-usage/alerts.ts `watchedCaps`, lib/shared/llm-gateway.ts `parseCapId`). */
export const projectCapId = (projectId: string): string => `project:${projectId}:month:cost`;

export interface ProjectBudget {
  projectId: string;
  /** USD per calendar month in the instance time zone; 0 = no budget (nothing is watched or stopped). */
  monthlyUsd: number;
  /** 1–100: a warning incident opens once spend reaches this share of the budget. */
  warnPercent: number;
  /** Off by default: when on, the project's priced AI calls stop at the budget until a person resumes or raises it. */
  hardStop: boolean;
  /** Who is asked besides the project's admins (a user with a role in the project). May resume and dismiss; raising is for admins. */
  ownerId?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type BudgetIncidentKind = 'warn' | 'stop';
export type BudgetIncidentStatus = 'open' | 'resolved' | 'dismissed';

export interface BudgetIncident {
  id: string;
  projectId: string;
  /** YYYY-MM, in the instance time zone. */
  month: string;
  kind: BudgetIncidentKind;
  status: BudgetIncidentStatus;
  /** Priced spend when it opened. */
  usedUsd: number;
  /** The budget it was opened against (a raise opens a new incident against the new amount). */
  budgetUsd: number;
  /** resumed: priced calls go on for the rest of the month; raised: the budget was raised (here or through the cap-raise flow); dismissed: a warning put away. */
  resolution?: 'resumed' | 'raised' | 'dismissed';
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** GET /api/projects/:id/budget (any role in the project). */
export interface ProjectBudgetView {
  budget?: ProjectBudget;
  month: string;
  /** Spend this month from every source (Landflow's meter and the LiteLLM import), priced or reported by the gateway. */
  usedUsd: number;
  /** Calls this month to models without a price in the price table (local models): counted, never stopped. */
  unpricedCalls: number;
  /** round(usedUsd / monthlyUsd × 100); 0 without a budget. */
  percent: number;
  /** A stop incident is open and not resumed: the project's priced calls are refused. */
  paused: boolean;
  /** The month's incidents, newest first. */
  incidents: BudgetIncident[];
  /** The project's admins (and instance owners and admins): edit the budget, raise, resume, dismiss. */
  canEdit: boolean;
  /** canEdit, or the budget's owner: resume and dismiss. */
  canResume: boolean;
  /** The viewer may ask for more through the cap-raise flow (Insights → AI): an editor who can't edit, while the flow is on. */
  canAsk: boolean;
  /** `projectCapId(projectId)` when there is a budget: what "Ask for more" sends. */
  capId?: string;
}

/** PUT /api/projects/:id/budget (project admins, instance owners and admins). monthlyUsd 0 removes the budget. */
export interface ProjectBudgetInput {
  monthlyUsd: number;
  warnPercent?: number;
  hardStop?: boolean;
  /** null clears it. */
  ownerId?: string | null;
}

/** POST /api/projects/:id/budget/incidents/:incidentId */
export type BudgetAction = { action: 'resume' } | { action: 'raise'; monthlyUsd: number } | { action: 'dismiss' };

/**
 * The fields a project budget item adds to a Needs you item (GET /api/runs/needs-you). The server's `NeedsYouItem` and the
 * client's `NeedsYouRow` both gain them; such an item has `executionId`, `workflowId` and `workflowName` set to ''.
 */
export interface BudgetNeedsYouFields {
  kind: 'budget';
  projectId: string;
  incidentId: string;
  incidentKind: BudgetIncidentKind;
  /** `/projects/<id>?tab=settings#budget` */
  href: string;
  /** What the viewer may do from the row (the same rule as the view's canEdit and canResume). */
  canRaise: boolean;
  canResume: boolean;
}

/** The link a budget item opens. */
export const budgetHref = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}?tab=settings#budget`;
