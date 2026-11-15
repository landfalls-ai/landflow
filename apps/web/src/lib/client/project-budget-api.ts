/** Fetch helpers and pure view helpers for a project's AI budget (docs/projects-and-goals.md#ai-budget). */
import { useEffect } from 'react';
import { api } from './api';
import type { BudgetAction, ProjectBudgetInput, ProjectBudgetView } from '../shared/project-budget';

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/budget`;

export const fetchBudget = (projectId: string) => api<ProjectBudgetView>(base(projectId));
export const saveBudget = (projectId: string, input: ProjectBudgetInput) => api<ProjectBudgetView>(base(projectId), { method: 'PUT', json: input });
export const runIncidentAction = (projectId: string, incidentId: string, action: BudgetAction) =>
  api<ProjectBudgetView>(`${base(projectId)}/incidents/${encodeURIComponent(incidentId)}`, { method: 'POST', json: action });
/** Insights → AI's "Ask for more": the same request the cap-raise flow takes. */
export const askForMore = (capId: string, requested: number, reason: string) => api<unknown>('/api/ai/cap-requests', { method: 'POST', json: { capId, requested, reason } });

export const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

export type BarTone = 'ok' | 'warn' | 'full';

/** The bar's fill, 0-100. */
export const barPercent = (view: Pick<ProjectBudgetView, 'percent'>): number => Math.max(0, Math.min(100, view.percent));

/** Amber from the warning percent, red at 100 or when paused. */
export function barTone(view: Pick<ProjectBudgetView, 'percent' | 'paused' | 'budget'>): BarTone {
  if (view.paused || view.percent >= 100) return 'full';
  if (view.budget && view.percent >= view.budget.warnPercent) return 'warn';
  return 'ok';
}

export interface BudgetFields {
  monthly: string;
  warn: string;
  hardStop: boolean;
  ownerId: string;
}

export const fieldsFrom = (view: Pick<ProjectBudgetView, 'budget'>): BudgetFields => ({
  monthly: view.budget ? String(view.budget.monthlyUsd) : '',
  warn: String(view.budget?.warnPercent ?? 80),
  hardStop: view.budget?.hardStop ?? false,
  ownerId: view.budget?.ownerId ?? '',
});

/** The PUT body for the fields, or what is wrong with them. */
export function budgetInput(fields: BudgetFields): { input: ProjectBudgetInput } | { error: string } {
  const monthlyUsd = fields.monthly.trim() === '' ? 0 : Number(fields.monthly);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 1_000_000) return { error: 'The budget is an amount from 0 to 1,000,000 dollars.' };
  const warnPercent = Number(fields.warn);
  if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100) return { error: 'Warn at is a whole number from 1 to 100.' };
  return { input: { monthlyUsd, warnPercent, hardStop: fields.hardStop, ownerId: fields.ownerId || null } };
}

/**
 * The browser's own jump to `#<id>` misses a card that mounts after the project loads: scroll to it once it has, then keep it
 * in place while the cards above it settle (they grow as their own answers arrive), until the reader scrolls or a few seconds pass.
 */
export function useScrollToHash(id: string, ready: boolean) {
  useEffect(() => {
    if (!ready || window.location.hash !== `#${id}`) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = () => document.getElementById(id);
    target()?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    let done = false;
    let first = true;
    const stop = () => {
      done = true;
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.removeEventListener(e, stop);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (first) return void (first = false); // observe() fires once at once
      if (!done) target()?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    const parent = target()?.parentElement;
    if (parent) observer?.observe(parent);
    for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.addEventListener(e, stop, { passive: true });
    const timer = window.setTimeout(stop, 4000);
    return stop;
  }, [id, ready]);
}
