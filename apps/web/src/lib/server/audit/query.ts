/** The audit filters of GET /api/audit and /api/audit/export, from the query string. */
import type { AuditFilters, AuditOutcome } from '../../shared/audit';

const OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'];

/** A time filter as ISO: an ISO time, a date (`2026-10-01`, the start of that day in UTC), or nothing when unreadable. */
function time(value: string | null, endOfDay = false): string | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function filtersFrom(params: URLSearchParams): AuditFilters {
  const actions = params
    .getAll('action')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  const outcome = params.get('outcome') as AuditOutcome | null;
  const filters: AuditFilters = {
    ...(params.get('actor')?.trim() && { actor: params.get('actor')!.trim().slice(0, 200) }),
    ...(actions.length && { action: actions }),
    ...(params.get('targetType')?.trim() && { targetType: params.get('targetType')!.trim().slice(0, 100) }),
    ...(params.get('targetId')?.trim() && { targetId: params.get('targetId')!.trim().slice(0, 200) }),
    ...(params.get('projectId')?.trim() && { projectId: params.get('projectId')!.trim().slice(0, 200) }),
    ...(outcome && OUTCOMES.includes(outcome) && { outcome }),
    ...(time(params.get('from')) && { from: time(params.get('from')) }),
    ...(time(params.get('to'), true) && { to: time(params.get('to'), true) }),
    ...(params.get('q')?.trim() && { q: params.get('q')!.trim().slice(0, 200) }),
  };
  return filters;
}
