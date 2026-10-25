/**
 * List responses (RFC 7644 §3.4.2): `filter`, `startIndex` (1-based) and `count` pagination with `totalResults` and
 * `itemsPerPage`, and `attributes` / `excludedAttributes` (identity providers ask for groups without their
 * `members`). Lists are small (an instance's users and groups), so they are filtered in memory on the SCIM
 * representation, the same view the filter's attribute names refer to.
 */
import { SCHEMAS, ScimError } from './http';
import { matches, parseFilter } from './filter';

export const DEFAULT_COUNT = 100;
export const MAX_COUNT = 500;

/** Attributes always returned (RFC 7643 §7 `returned: always`). */
const ALWAYS = new Set(['id', 'schemas', 'meta']);

/** `attributes` / `excludedAttributes` from the query, applied to one resource (top-level attributes). */
export function project(resource: Record<string, unknown>, url: URL): Record<string, unknown> {
  const names = (param: string) =>
    (url.searchParams.get(param) ?? '')
      .split(',')
      .map((name) => name.trim().split('.')[0].toLowerCase())
      .map((name) => name.replace(/^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/, ''))
      .filter(Boolean);
  const include = names('attributes');
  const exclude = new Set(names('excludedAttributes'));
  return Object.fromEntries(
    Object.entries(resource).filter(([key]) => {
      const lower = key.toLowerCase();
      if (ALWAYS.has(lower)) return true;
      if (include.length) return include.includes(lower);
      return !exclude.has(lower);
    }),
  );
}

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ScimError(400, `“${raw}” is not a number`, 'invalidValue');
  return Math.floor(value);
}

/** A ListResponse of the resources matching the query's filter, one page of them. */
export function listResponse(resources: Array<Record<string, unknown>>, url: URL): Record<string, unknown> {
  const filterText = url.searchParams.get('filter');
  const filter = filterText?.trim() ? parseFilter(filterText) : undefined;
  const matching = filter ? resources.filter((resource) => matches(resource, filter)) : resources;
  const startIndex = Math.max(1, positiveInt(url.searchParams.get('startIndex'), 1));
  const count = Math.min(MAX_COUNT, Math.max(0, positiveInt(url.searchParams.get('count'), DEFAULT_COUNT)));
  const page = matching.slice(startIndex - 1, startIndex - 1 + count).map((resource) => project(resource, url));
  return { schemas: [SCHEMAS.list], totalResults: matching.length, startIndex, itemsPerPage: page.length, Resources: page };
}
