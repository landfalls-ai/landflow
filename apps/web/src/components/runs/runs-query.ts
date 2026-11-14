/**
 * The Runs list's filters and how they sit in the URL (`/runs?status=error&workflowId=…`), plus where the old pages
 * send people. Pure functions, no React, so a test can read them (docs/run-trace.md#the-runs-list).
 */
import type { ExecutionSummary } from '@/lib/shared/types';

export interface RunFilters {
  /** One search box: workflow name, error text, node. */
  q: string;
  status: string;
  workflowId: string;
  // More filters
  actor: string;
  tool: string;
  from: string;
  to: string;
  failedSteps: boolean;
  /** A check name, or `*` for any check. Empty: off. */
  failedCheck: string;
}

export const NO_FILTERS: RunFilters = { q: '', status: '', workflowId: '', actor: '', tool: '', from: '', to: '', failedSteps: false, failedCheck: '' };
const TEXT_KEYS = ['q', 'status', 'workflowId', 'actor', 'tool', 'from', 'to'] as const;
export const STATUS_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'error', label: 'Failed' },
  { value: 'running', label: 'Running' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'success', label: 'Succeeded' },
  { value: 'canceled', label: 'Canceled' },
];

type Params = { get(name: string): string | null };

export function parseFilters(params: Params): RunFilters {
  const f: RunFilters = { ...NO_FILTERS };
  for (const key of TEXT_KEYS) f[key] = (params.get(key) ?? '').trim();
  f.failedSteps = params.get('failedSteps') === '1';
  f.failedCheck = (params.get('failedCheck') ?? '').trim();
  return f;
}

/** Only what is set; the empty filter is the empty string. */
export function filtersQuery(f: RunFilters): string {
  const q = new URLSearchParams();
  for (const key of TEXT_KEYS) if (f[key].trim()) q.set(key, f[key].trim());
  if (f.failedSteps) q.set('failedSteps', '1');
  if (f.failedCheck.trim()) q.set('failedCheck', f.failedCheck.trim());
  return q.toString();
}

export const runsHref = (f: RunFilters) => {
  const q = filtersQuery(f);
  return q ? `/runs?${q}` : '/runs';
};

/** How many "More filters" are on. */
export const moreCount = (f: RunFilters) => (['actor', 'tool', 'from', 'to'] as const).filter((k) => f[k]).length + (f.failedSteps ? 1 : 0) + (f.failedCheck ? 1 : 0);
/** Filters only the journal search can answer. */
export const needsJournal = (f: RunFilters) => Boolean(f.actor || f.tool || f.failedSteps || f.failedCheck);

/** The filters the loaded list can apply itself. */
export function matchesFilters(run: ExecutionSummary, f: RunFilters): boolean {
  if (f.status && run.status !== f.status) return false;
  if (f.workflowId && run.workflowId !== f.workflowId) return false;
  const q = f.q.toLowerCase();
  if (q && ![run.workflowName, run.error?.message, run.error?.nodeName].some((s) => s?.toLowerCase().includes(q))) return false;
  const at = Date.parse(run.startedAt);
  if (f.from && at < Date.parse(f.from)) return false;
  if (f.to && at >= Date.parse(f.to) + 86_400_000) return false;
  return true;
}

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Where `/executions?…` goes: `?id=` opens that run, anything else keeps its query on `/runs`. */
export function executionsRedirect(search: Search): string {
  const id = first(search.id);
  if (id) return `/runs/${encodeURIComponent(id)}`;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) q.append(key, v);
  const text = q.toString();
  return text ? `/runs?${text}` : '/runs';
}

/** `/runs/compare` needs two runs; with fewer it goes back to the list. */
export function compareRedirect(search: { a?: string; b?: string }): string | undefined {
  return search.a && search.b ? undefined : '/runs';
}
