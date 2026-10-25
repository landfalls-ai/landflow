/**
 * What each API route needs beyond a signed-in user: the API key scope (keys only), the role action (`can`, for
 * admin-only routes) and whether a session is required (API keys can't manage API keys). One table for the whole
 * API, applied by the guard before any handler runs; routes the table doesn't name need the `admin` scope from an
 * API key and nothing extra from a session.
 */
import type { Action, ApiKeyScope } from '../../shared/auth';
import { underPath } from '../../shared/auth-paths';

export interface RoutePolicy {
  /** Scope an API key needs; `any` = any valid key. */
  scope: ApiKeyScope | 'any';
  /** Role action a user needs (see `can`). */
  action?: Action;
  /** Only with a session, never an API key. */
  sessionOnly?: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Routes that read workflows data whatever the method (POST bodies carry the question). */
const READ_POSTS = ['/api/node-types/load-options', '/api/expressions/preview'];

/** The policy for `method` on `path` (a pathname under /api). */
export function routePolicy(method: string, path: string): RoutePolicy {
  const read = READ_METHODS.has(method.toUpperCase()) || READ_POSTS.includes(path);
  const under = (prefix: string) => underPath(path, prefix);

  if (under('/api/auth/me')) return { scope: 'any' };
  if (under('/api/api-keys')) return { scope: 'any', sessionOnly: true };
  if (path === '/api/openapi.json') return { scope: 'any' };

  // Starting runs.
  if (/^\/api\/workflows\/[^/]+\/(run|execute)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/executions\/[^/]+\/(retry|rerun|debug)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/agents\/[^/]+\/chat$/.test(path)) return { scope: 'run' };

  // Git sync (the CLI) and Settings → Source control: reading the files is a read; applying them changes variables too.
  if (path === '/api/sync/export') return { scope: 'workflows:read' };
  if (under('/api/sync') || under('/api/source-control')) return { scope: 'admin', action: 'settings:manage' };

  if (under('/api/users')) return read ? { scope: 'admin' } : { scope: 'admin', action: 'users:manage' };
  if (under('/api/settings/mcp')) return { scope: 'admin', action: 'mcp:manage' };
  if (under('/api/settings/security')) return { scope: 'admin', action: 'settings:manage' };
  if (under('/api/settings')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage' };
  if (under('/api/variables')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'variables:manage' };
  if (under('/api/plugins') || under('/api/marketplaces')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'plugins:manage' };
  if (under('/api/credentials')) return { scope: 'admin' };

  if (['/api/workflows', '/api/folders', '/api/data-tables', '/api/agents', '/api/skills', '/api/node-types', '/api/credential-types', '/api/expressions'].some(under)) {
    return { scope: read ? 'workflows:read' : 'workflows:write' };
  }
  if (under('/api/ai') || under('/api/assistant')) return { scope: 'workflows:write' };
  if (under('/api/executions') || under('/api/binary')) return { scope: read ? 'executions:read' : 'executions:write' };
  if (under('/api/events') || under('/api/insights') || under('/api/metrics')) return { scope: 'executions:read' };
  return { scope: 'admin' };
}
