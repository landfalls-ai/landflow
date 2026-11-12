/**
 * What each API route needs beyond a signed-in user: the API key scope (keys only), the role action (`can`, for
 * admin-only routes) and whether a session is required (API keys can't manage API keys). One table for the whole
 * API, applied by the guard before any handler runs; routes the table doesn't name need the `admin` scope from an
 * API key and nothing extra from a session.
 */
import type { Action, ApiKeyScope } from '../../shared/auth';
import { underPath } from '../../shared/auth-paths';
import type { ResourceAction, ResourceKind } from '../../shared/projects';

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
  // Listening for a test event runs the editor's workflow too (lib/server/test-webhooks.ts).
  if (/^\/api\/workflows\/[^/]+\/(run|execute|listen)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/executions\/[^/]+\/(retry|rerun|debug)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/agents\/[^/]+\/chat$/.test(path)) return { scope: 'run' };

  // Git sync (the CLI) and Settings → Source control: reading the files is a read; applying them changes variables too.
  if (path === '/api/sync/export') return { scope: 'workflows:read' };
  if (under('/api/sync') || under('/api/source-control')) return { scope: 'admin', action: 'settings:manage' };

  // External secrets providers and environments (promotion, pull, settings): changes are admin; anyone sees the environment.
  if (under('/api/external-secrets')) return read ? { scope: 'admin' } : { scope: 'admin', action: 'settings:manage' };
  if (under('/api/environment')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage' };
  if (under('/api/users')) return read ? { scope: 'admin' } : { scope: 'admin', action: 'users:manage' };
  if (under('/api/settings/mcp')) return { scope: 'admin', action: 'mcp:manage' };
  // The MCP tool browser (every exposed plugin's tools): anyone who reads workflows; the endpoints themselves are public paths.
  if (path === '/api/mcp/tools') return { scope: 'workflows:read' };
  // MCP identity (docs/transports.md): tokens are personal and session-only like API keys; grants are admin; status is for the Settings page.
  if (under('/api/mcp/tokens')) return { scope: 'any', sessionOnly: true };
  if (under('/api/mcp/grants')) return { scope: 'admin', action: 'mcp:manage' };
  if (under('/api/mcp/status')) return { scope: 'any' };
  // Approvals of destructive MCP tool calls: a signed-in user lists and answers the ones they may (lib/server/mcp/approvals.ts decides which).
  if (under('/api/mcp/approvals')) return { scope: 'any' };
  // The gateway sync (lib/server/mcp/gateway-sync.ts): anyone sees its status on the Settings page; forcing a resync is admin.
  if (under('/api/mcp/gateway')) return read ? { scope: 'any' } : { scope: 'admin', action: 'mcp:manage' };
  // Audit log: reading (and exporting) needs `audit:read`: owners and admins read every event, project admins their
  // projects' (the route limits it, lib/server/audit/access.ts). Verifying the hash chain, its settings and SIEM destinations are admin-only.
  if (path === '/api/audit/verify' || path === '/api/audit/head') return { scope: 'audit:read', action: 'audit:read' };
  if (under('/api/audit')) return { scope: 'audit:read' };
  if (under('/api/settings/audit')) return { scope: 'admin', action: read ? 'audit:read' : 'settings:manage' };
  // Four-eyes publish requests: builders list, ask and decide (who may approve is checked by lib/server/governance).
  if (under('/api/publish-requests')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  if (under('/api/settings/security')) return { scope: 'admin', action: 'settings:manage' };
  if (under('/api/settings')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage' };
  if (under('/api/variables')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'variables:manage' };
  if (under('/api/plugins') || under('/api/marketplaces')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'plugins:manage' };
  // Transports (docs/transports.md): anyone who reads workflows sees the kinds and connections; connections change like other settings.
  if (under('/api/transports')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage' };
  if (under('/api/credentials')) return { scope: 'admin' };

  if (['/api/workflows', '/api/folders', '/api/data-tables', '/api/agents', '/api/agent-teams', '/api/agent-templates', '/api/skills', '/api/node-types', '/api/credential-types', '/api/expressions', '/api/projects', '/api/templates', '/api/composites', '/api/runbooks'].some(under)) {
    return { scope: read ? 'workflows:read' : 'workflows:write' };
  }
  if (under('/api/ai') || under('/api/assistant')) return { scope: 'workflows:write' };
  if (under('/api/executions') || under('/api/binary')) return { scope: read ? 'executions:read' : 'executions:write' };
  // Run Trace: the needs-you list across runs (docs/run-trace.md) reads like executions; the route limits it to what the caller sees.
  if (under('/api/events') || under('/api/runs') || under('/api/insights') || under('/api/metrics')) return { scope: 'executions:read' };
  // The second brain (docs/second-brain.md): reading usage and facts is like reading insights; the editor reports its own
  // signals; suggestions are decided by builders (the routes check the target); running it now is for admins.
  if (path === '/api/usage/signal') return { scope: 'workflows:write' };
  // Declaring a custom event kind (Record Event's shapes) is building, like editing a workflow.
  if (under('/api/usage/kinds')) return { scope: read ? 'executions:read' : 'workflows:write' };
  if (under('/api/usage')) return { scope: 'executions:read' };
  if (path === '/api/brain/run' || path === '/api/brain/backtest') return { scope: 'admin', action: 'settings:manage' };
  if (path === '/api/brain/analyst') return { scope: 'workflows:write' };
  if (under('/api/brain')) return { scope: 'executions:read' };
  if (under('/api/proposals')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  // Entities (initiatives, people, customers, systems): the routes check the entity's project, like suggestions.
  if (under('/api/entities')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  return { scope: 'admin' };
}

/**
 * Projects and sharing: the resource a path names and what the method does with it, which the guard checks against
 * the caller's access (lib/server/projects/access.ts; owners and admins pass). An execution stands for its workflow.
 * Collection routes (lists, create) aren't here: they filter by access and check the target project themselves.
 */
export interface ResourceRule {
  kind: ResourceKind | 'execution';
  id: string;
  action: ResourceAction;
}

/** `/api/<prefix>/<id>…`, the kind it names and the segments that are routes rather than ids. */
const RESOURCE_ROUTES: Array<{ pattern: RegExp; kind: ResourceRule['kind']; reserved: string[] }> = [
  { pattern: /^\/api\/workflows\/([^/]+)(\/.*)?$/, kind: 'workflow', reserved: ['import'] },
  { pattern: /^\/api\/insights\/workflows\/([^/]+)(\/.*)?$/, kind: 'workflow', reserved: [] },
  { pattern: /^\/api\/brain\/workflows\/([^/]+)(\/.*)?$/, kind: 'workflow', reserved: [] },
  { pattern: /^\/api\/credentials\/([^/]+)(\/.*)?$/, kind: 'credential', reserved: ['test'] },
  { pattern: /^\/api\/data-tables\/([^/]+)(\/.*)?$/, kind: 'dataTable', reserved: [] },
  { pattern: /^\/api\/agents\/([^/]+)(\/.*)?$/, kind: 'agent', reserved: ['import', 'models', 'workflow-tools'] },
  { pattern: /^\/api\/agent-teams\/([^/]+)(\/.*)?$/, kind: 'agentTeam', reserved: [] },
  { pattern: /^\/api\/executions\/([^/]+)(\/.*)?$/, kind: 'execution', reserved: ['stop-all'] },
];

/** The resource rule for `method` on `path`, if the path names one. */
export function resourceRule(method: string, path: string): ResourceRule | undefined {
  for (const route of RESOURCE_ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return undefined;
    }
    if (route.reserved.includes(id)) return undefined;
    return { kind: route.kind, id, action: resourceAction(route.kind, match[2] ?? '', method.toUpperCase()) };
  }
  return undefined;
}

function resourceAction(kind: ResourceRule['kind'], rest: string, method: string): ResourceAction {
  const sub = (name: string) => rest === `/${name}` || rest.startsWith(`/${name}/`);
  if (sub('shares')) return READ_METHODS.has(method) ? 'read' : 'share';
  if (sub('transfer')) return 'move';
  // A workflow's governance policy: its project's admins (who may move it) change it.
  if (kind === 'workflow' && sub('policy') && !READ_METHODS.has(method)) return 'move';
  // Starting, retrying or stopping runs and chats; credentials' OAuth2 Connect writes the token.
  if (kind === 'workflow' && (sub('run') || sub('execute') || sub('listen') || (sub('evaluations') && method === 'POST'))) return 'run';
  // Debug tokens (docs/specs/19-debug-token.md): minting one needs no more than reading the execution (the token reads less than its minter).
  if (kind === 'execution' && sub('debug-tokens')) return 'read';
  if (kind === 'execution' && (sub('retry') || sub('rerun') || sub('debug') || sub('stop') || sub('approvals') || sub('asks') || sub('agents'))) return READ_METHODS.has(method) ? 'read' : 'run';
  if (kind === 'agent' && (sub('chat') || (sub('sessions') && !READ_METHODS.has(method)))) return 'run';
  if (kind === 'credential' && sub('oauth2')) return 'update';
  if (READ_METHODS.has(method)) return 'read';
  if (method === 'DELETE' && !rest && kind !== 'execution') return 'delete';
  return 'update';
}
