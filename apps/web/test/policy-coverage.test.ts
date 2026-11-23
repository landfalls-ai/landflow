/**
 * Access-rule coverage (backend review S12): routes the policy table (lib/server/auth/policy.ts) doesn't name fall to
 * a default that needs the admin scope from an API key and nothing from a session, so a new route would be open to every
 * member unless its author checks access. This walks every route.ts under src/app and, for each exported mutating
 * method, requires one of: a public path (it authenticates its callers itself), a policy or resource rule that names
 * the path, a check in the handler's source (CHECK_MARKERS), or an entry in ALLOWED with the reason. A new route
 * without any of them fails here: add a policy entry (preferred), a check, or an ALLOWED line saying why.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicPath } from '@/lib/shared/auth-paths';
import { resourceRule, routePolicy } from '@/lib/server/auth/policy';

const APP = join(__dirname, '..', 'src', 'app');
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** In-handler access checks: a call to one of these in the route's source counts as the route guarding itself. */
const CHECK_MARKERS = [
  /\brequireUser\(/,
  /\brouteActor\(/,
  /\brequireFolder\(/,
  /\brequireProject\(/,
  /\btemplateAccess\(/,
  /\bcanResource\(/,
  /\bprojectRoute\(/,
  /\bdataTableRoute\(/,
  /\bcan\(/,
  /\bcheckResourceRule\(/,
];

/** Mutating routes the table doesn't name and that check nothing in the handler, each with why that is fine. */
const ALLOWED: Record<string, string> = {};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

/** `/api/workflows/[id]/shares` → `/api/workflows/x1/shares`; a catch-all gets two segments. */
function urlOf(file: string): string {
  const dir = relative(APP, file).split(sep).slice(0, -1);
  return '/' + dir.filter((segment) => !/^\(.*\)$/.test(segment)).map((s) => (/^\[\.\.\./.test(s) ? 'a/b' : /^\[.*\]$/.test(s) ? 'x1' : s)).join('/');
}

const methodsOf = (source: string) => MUTATING.filter((method) => new RegExp(`export\\s+(const|async function|function)\\s+${method}\\b`).test(source) || new RegExp(`export\\s*\\{[^}]*\\b${method}\\b`).test(source));

describe('every mutating route has an access rule', () => {
  const unguarded: string[] = [];
  let checked = 0;
  for (const file of routeFiles(APP)) {
    const source = readFileSync(file, 'utf8');
    const path = urlOf(file);
    for (const method of methodsOf(source)) {
      checked += 1;
      const key = `${method} ${path}`;
      if (isPublicPath(path) || path.startsWith('/_') || ALLOWED[key]) continue;
      if (!routePolicy(method, path).fallback) continue;
      if (resourceRule(method, path)) continue;
      if (CHECK_MARKERS.some((marker) => marker.test(source))) continue;
      unguarded.push(`${key}  (${relative(APP, file)})`);
    }
  }

  it('walks the routes', () => {
    expect(checked).toBeGreaterThan(200);
  });

  it('leaves no mutating route to the default policy without a check of its own', () => {
    expect(unguarded, 'Name these in routePolicy (lib/server/auth/policy.ts), check access in the handler, or list them in ALLOWED with a reason').toEqual([]);
  });

  it('flags a route nothing guards', () => {
    expect(routePolicy('POST', '/api/not-a-route-yet')).toMatchObject({ fallback: true });
    expect(routePolicy('POST', '/api/workflows')).not.toHaveProperty('fallback');
  });
});
