/**
 * The audit log's filters as a reducer: a choice (a select, a date) applies at once; typing in a text box shows in the
 * box straight away and applies after a short pause (`commit`), so there is no Apply button.
 */
import type { AuditOutcome } from '@/lib/shared/audit';

export interface AuditFilters {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  projectId: string;
  outcome: '' | AuditOutcome;
  from: string;
  to: string;
  q: string;
}

export const NO_FILTERS: AuditFilters = { actor: '', action: '', targetType: '', targetId: '', projectId: '', outcome: '', from: '', to: '', q: '' };

/** `draft` is what the boxes show; `applied` is what the list was loaded with. */
export interface FilterState {
  draft: AuditFilters;
  applied: AuditFilters;
}

export type FilterAction =
  | { type: 'choose'; patch: Partial<AuditFilters> }
  | { type: 'type'; patch: Partial<AuditFilters> }
  | { type: 'commit' }
  | { type: 'reset'; to: AuditFilters };

export const initialFilters = (fixed: AuditFilters = NO_FILTERS): FilterState => ({ draft: fixed, applied: fixed });

export function filtersReducer(state: FilterState, action: FilterAction): FilterState {
  switch (action.type) {
    case 'choose': {
      const next = { ...state.draft, ...action.patch };
      return { draft: next, applied: next };
    }
    case 'type':
      return { ...state, draft: { ...state.draft, ...action.patch } };
    case 'commit':
      return state.applied === state.draft ? state : { ...state, applied: state.draft };
    case 'reset':
      return { draft: action.to, applied: action.to };
  }
}

/** True while a typed value has not applied yet. */
export const hasPending = (state: FilterState) => JSON.stringify(state.draft) !== JSON.stringify(state.applied);

/** The query string of the filters (a bare date in `to` runs to the end of that day). */
export function auditQuery(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}
