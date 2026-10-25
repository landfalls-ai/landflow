/**
 * Shared pieces of the /api/data-tables routes: a handler that turns
 * DataTableError into JSON errors with its status, and the zod schemas of
 * filters and row queries.
 */
import { z } from 'zod';
import { CONDITION_OPERATORS, type ConditionOperator, type RowQuery } from '../../shared/data-tables';
import { error, handler } from '../http';
import { DataTableError } from './storage';

/** `handler` plus DataTableError → `{ error }` with the error's status. */
export function dataTableRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return handler(async (...args: A) => {
    try {
      return await fn(...args);
    } catch (caught) {
      if (caught instanceof DataTableError) return error(caught.message, caught.status);
      throw caught;
    }
  });
}

const operators = CONDITION_OPERATORS.map((o) => o.value) as [ConditionOperator, ...ConditionOperator[]];

export const rowFilterSchema = z.object({
  type: z.enum(['and', 'or']).optional(),
  conditions: z.array(z.object({ column: z.string(), operator: z.enum(operators), value: z.unknown().optional() })).max(50).optional(),
  ids: z.array(z.number().int()).max(10_000).optional(),
});

export const rowValuesSchema = z.record(z.string(), z.unknown());

export const MAX_PAGE = 1000;

/** GET …/rows?offset&limit&sortBy&sortDirection&search&filter=<JSON RowFilter> */
export function rowQueryFrom(url: URL): RowQuery | { error: string } {
  const params = url.searchParams;
  const number = (name: string, fallback: number) => {
    const raw = params.get(name);
    const value = raw === null || raw === '' ? fallback : Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  };
  let filter: RowQuery['filter'];
  const rawFilter = params.get('filter');
  if (rawFilter) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFilter);
    } catch {
      return { error: '`filter` must be JSON' };
    }
    const checked = rowFilterSchema.safeParse(parsed);
    if (!checked.success) return { error: `Invalid filter: ${checked.error.issues[0]?.message ?? 'bad shape'}` };
    filter = checked.data;
  }
  const sortDirection = params.get('sortDirection') === 'desc' ? 'desc' : 'asc';
  return {
    offset: number('offset', 0),
    limit: Math.min(MAX_PAGE, Math.max(1, number('limit', 50))),
    ...(params.get('sortBy') && { sortBy: params.get('sortBy')!, sortDirection }),
    ...(params.get('search') && { search: params.get('search')! }),
    ...(filter && { filter }),
  };
}
