/**
 * What each API route needs beyond a signed-in user: the API key scope (keys only), the role action (`can`, for
 * admin-only routes) and whether a session is required (API keys can't manage API keys). One table for the whole
 * API, applied by the guard before any handler runs; routes the table doesn't name need the `admin` scope from an
 * API key and nothing extra from a session.
 */
import type { Action, ApiKeyScope, Role } from '../../shared/auth';
import { underPath } from '../../shared/auth-paths';
import type { ResourceAction, ResourceKind } from '../../shared/projects';
import { envString } from '../config';
import { authDb } from './db';
import type { SessionMethod } from './sessions';
import type { UserRecord } from './users';

export interface RoutePolicy {
  /** Scope an API key needs; `any` = any valid key. */
  scope: ApiKeyScope | 'any';
  /** Role action a user needs (see `can`). */
  action?: Action;
  /** The built-in owner or admin role itself, whatever custom role is held: the route reaches every project (C32 review). */
  instanceAdmin?: true;
  /** Only with a session, never an API key. */
  sessionOnly?: boolean;
  /** No entry named the path: the default below applied (test/policy-coverage.test.ts requires every route to be named or to guard itself). */
  fallback?: true;
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
  // B02: a person's own preferences and chats; an API key can't read them (the handlers answer the owner only).
  // C16: your own second factors; a session only (an API key can't add or remove one).
  if (under('/api/me/mfa')) return { scope: 'any', sessionOnly: true };
  if (under('/api/me/preferences') || under('/api/conversations')) return { scope: 'any', sessionOnly: true };
  if (path === '/api/openapi.json') return { scope: 'any' };

  // Stopping every run of every project is instance-wide: admins, like the other instance-wide controls (/api/settings).
  // The key keeps the executions:write scope it always needed (the CLI's `executions stop --all`); the role decides.
  if (path === '/api/executions/stop-all') return { scope: 'executions:write', action: 'settings:manage', instanceAdmin: true };

  // Starting runs.
  // Listening for a test event runs the editor's workflow too (lib/server/test-webhooks.ts).
  if (/^\/api\/workflows\/[^/]+\/(run|execute|listen|test-update)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/executions\/[^/]+\/(retry|rerun|debug)$/.test(path)) return { scope: 'run' };
  if (/^\/api\/agents\/[^/]+\/chat$/.test(path)) return { scope: 'run' };

  // Git sync (the CLI) and Settings → Source control: reading the files is a read; applying them changes variables too.
  if (path === '/api/sync/export') return { scope: 'workflows:read' };
  if (under('/api/sync') || under('/api/source-control')) return { scope: 'admin', action: 'settings:manage', instanceAdmin: true };

  // External secrets providers and environments (promotion, pull, settings): changes are admin; anyone sees the environment.
  if (under('/api/external-secrets')) return read ? { scope: 'admin' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  if (under('/api/environment')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  // C16: resetting a person's second factors is a session's act, never an API key's (like /api/api-keys): a stolen admin key can't strip a factor.
  if (/^\/api\/users\/[^/]+\/mfa$/.test(path)) return { scope: 'admin', action: 'users:manage', sessionOnly: true };
  if (under('/api/users')) return read ? { scope: 'admin' } : { scope: 'admin', action: 'users:manage' };
  // The instance MCP server's token, policy hooks and gateway are instance-wide: writes need the built-in admin role. Grants (below) are what Manage MCP opens.
  if (under('/api/settings/mcp')) return read ? { scope: 'admin', action: 'mcp:manage' } : { scope: 'admin', action: 'mcp:manage', instanceAdmin: true };
  // The MCP tool browser (every exposed plugin's tools): anyone who reads workflows; the endpoints themselves are public paths.
  if (path === '/api/mcp/tools') return { scope: 'workflows:read' };
  // MCP identity (docs/transports.md): tokens are personal and session-only like API keys; grants are admin; status is for the Settings page.
  if (under('/api/mcp/tokens')) return { scope: 'any', sessionOnly: true };
  if (under('/api/mcp/grants')) return { scope: 'admin', action: 'mcp:manage' };
  if (under('/api/mcp/status')) return { scope: 'any' };
  // Approvals of destructive MCP tool calls: a signed-in user lists and answers the ones they may (lib/server/mcp/approvals.ts decides which).
  if (under('/api/mcp/approvals')) return { scope: 'any' };
  // The gateway sync (lib/server/mcp/gateway-sync.ts): anyone sees its status on the Settings page; forcing a resync is admin.
  if (under('/api/mcp/gateway')) return read ? { scope: 'any' } : { scope: 'admin', action: 'mcp:manage', instanceAdmin: true };
  // Audit log: reading (and exporting) needs `audit:read`: owners and admins read every event, project admins their
  // projects' (the route limits it, lib/server/audit/access.ts). Verifying the hash chain, its settings and SIEM destinations are admin-only.
  if (path === '/api/audit/verify' || path === '/api/audit/head') return { scope: 'audit:read', action: 'audit:read' };
  if (under('/api/audit')) return { scope: 'audit:read' };
  if (under('/api/settings/audit')) return read ? { scope: 'admin', action: 'audit:read' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  // Four-eyes publish requests: builders list, ask and decide (who may approve is checked by lib/server/governance).
  // C11: the memory playground and the inspector's item states only read; each handler checks its source (404 otherwise).
  if (under('/api/memory')) return { scope: 'workflows:read' };
  if (under('/api/publish-requests')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  // LL: the LLM gateway (docs/llm-gateway.md). Syncing budgets and minting keys change LiteLLM: admins. The status is for
  // anyone signed in (the route leaves out the admin detail). Cap-raise requests: anyone who reads runs may see theirs,
  // a builder may ask; installing the cap-raise flow is an admin's.
  if (under('/api/llm-gateway/sync') || under('/api/llm-gateway/keys')) return { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  if (under('/api/llm-gateway')) return { scope: 'executions:read' };
  if (path === '/api/ai/cap-requests/setup') return read ? { scope: 'executions:read' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  if (under('/api/ai/cap-requests')) return { scope: read ? 'executions:read' : 'workflows:write' };
  // Re-sealing every secret is the owner's (the route checks the role); an API key can't start it.
  if (under('/api/settings/encryption')) return { scope: 'admin', action: 'settings:manage', instanceAdmin: true, sessionOnly: true };
  if (under('/api/settings/security')) return { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  // Everything else under /api/settings is instance-wide (governance, retention, pruning, alerts, caps): writes are the built-in admin role's.
  if (under('/api/settings')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  // Instance variables reach every project; a project's own variables are at /api/projects/<id>/variables (its admins').
  if (under('/api/variables')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'variables:manage', instanceAdmin: true };
  if (under('/api/plugins') || under('/api/marketplaces')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'plugins:manage' };
  // Transports (docs/transports.md): anyone who reads workflows sees the kinds and connections; connections change like other settings.
  if (under('/api/transports')) return read ? { scope: 'workflows:read' } : { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  if (under('/api/credentials')) return { scope: 'admin' };

  // PC01: goals (docs/projects-and-goals.md); the routes check who may edit which goal.
  if (under('/api/goals')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  // PC19: a project task's run (docs/projects-and-goals.md#tasks); approving one starts an agent, so only a signed-in person does it.
  if (under('/api/task-runs')) return read ? { scope: 'workflows:read' } : { scope: 'workflows:write', sessionOnly: true };
  // AP01: the approval inbox (docs/approval-inbox.md): reading is like reading executions; a decision needs a signed-in person (never an API key) with run access, which the route checks.
  if (under('/api/approval-inbox')) return read ? { scope: 'executions:read' } : { scope: 'run', sessionOnly: true };
  // C04: a harness's hook events need the `harness:write` key scope (docs/harnesses.md#live-status); the route refuses a cookie session. Listing sessions reads like runs.
  if (/^\/api\/harness\/[^/]+\/hooks$/.test(path)) return { scope: 'harness:write' };
  if (path === '/api/harness/sessions') return { scope: 'executions:read' };
  if (path === '/api/projects/context') return { scope: 'brain:read' }; // PC10
  // NB03: a project's Notion link status (docs/features/notion-brain.md); every write stays session-or-workflows:write like /api/projects.
  // NB07: the problems list is words and ids, so it reads like the link it belongs to.
  if (read && /^\/api\/projects\/[^/]+\/brain\/notion(\/problems)?$/.test(path)) return { scope: 'brain:read' };
  // C27: approving or keeping held a changed MCP tool is a person's decision (docs/agents.md#changed-mcp-tools-are-held), never an API key's; reading the list is an agent read.
  if (!read && /^\/api\/agents\/[^/]+\/trust$/.test(path)) return { scope: 'workflows:write', sessionOnly: true };
  if (['/api/workflows', '/api/folders', '/api/data-tables', '/api/agents', '/api/agent-teams', '/api/agent-templates', '/api/skills', '/api/node-types', '/api/credential-types', '/api/expressions', '/api/projects', '/api/templates', '/api/composites', '/api/runbooks'].some(under)) {
    return { scope: read ? 'workflows:read' : 'workflows:write' };
  }
  if (under('/api/ai') || under('/api/assistant')) return { scope: 'workflows:write' };
  if (under('/api/executions') || under('/api/binary')) return { scope: read ? 'executions:read' : 'executions:write' };
  // SP05: one model call's view (docs/run-trace.md#spend); the route checks who may open it. Without a rule the fallback is admin-only.
  if (under('/api/ai-calls')) return { scope: 'executions:read' };
  // SP23: acknowledging a spend flag is a write; every other method under /api/insights reads.
  if (under('/api/insights/ai/flags')) return { scope: read ? 'executions:read' : 'executions:write' };
  // Run Trace: the needs-you list across runs (docs/run-trace.md) reads like executions; the route limits it to what the caller sees.
  if (under('/api/events') || under('/api/runs') || under('/api/insights') || under('/api/metrics')) return { scope: 'executions:read' };
  // The second brain (docs/second-brain.md): reading usage and facts is like reading insights; the editor reports its own
  // signals; suggestions are decided by builders (the routes check the target); running it now is for admins.
  if (path === '/api/usage/signal') return { scope: 'workflows:write' };
  // Declaring a custom event kind (Record Event's shapes) is building, like editing a workflow.
  if (under('/api/usage/kinds')) return { scope: read ? 'executions:read' : 'workflows:write' };
  if (under('/api/usage')) return { scope: 'executions:read' };
  if (path === '/api/brain/run' || path === '/api/brain/backtest') return { scope: 'admin', action: 'settings:manage', instanceAdmin: true };
  if (path === '/api/brain/analyst') return { scope: 'workflows:write' };
  // B05: work events are the caller's own (docs/work-and-briefings.md): recording needs `brain:write`; the briefing and asking, `brain:read`.
  if (under('/api/brain/work')) return { scope: 'brain:write' };
  if (path === '/api/brain/briefing' || path === '/api/brain/ask') return { scope: 'brain:read' };
  // SP14: your own AI spend, for a brain key (the CLI, the mod's status line); /api/insights/** stays executions:read.
  if (path === '/api/brain/my-spend') return { scope: 'brain:read' };
  // C02: forgetting and restoring a fact change what agents recall, so they are editing, not reading; the route checks the subject.
  if (/^\/api\/brain\/facts\/[^/]+\/(forget|restore)$/.test(path)) return { scope: 'workflows:write' };
  if (under('/api/brain')) return { scope: 'executions:read' };
  if (under('/api/proposals')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  // B04: the @ picker's search lists only what the caller can open (lib/server/mentions/search.ts).
  if (path === '/api/mentions') return { scope: 'workflows:read' };
  // Entities (initiatives, people, customers, systems): the routes check the entity's project, like suggestions.
  if (under('/api/entities')) return { scope: read ? 'workflows:read' : 'workflows:write' };
  // PR01: practices (docs/practices.md). Approving, rejecting, retiring and waiving are a person's (the handler checks the role).
  if (/^\/api\/practices\/[^/]+\/(approve|retire|waivers)$/.test(path) || /^\/api\/practices\/[^/]+\/versions\/[^/]+\/reject$/.test(path)) return { scope: 'admin', sessionOnly: true };
  if (under('/api/practices')) return { scope: read ? 'brain:read' : 'brain:write' };
  return { scope: 'admin', fallback: true };
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
  { pattern: /^\/api\/agents\/([^/]+)(\/.*)?$/, kind: 'agent', reserved: ['import', 'models', 'workflow-tools', 'design'] },
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
  // C09: forgetting or restoring one's own memory takes no more than running the agent (the handler narrows to the person's own, or an editor).
  if (kind === 'agent' && sub('memories') && !READ_METHODS.has(method)) return 'run';
  if (kind === 'agent' && (sub('chat') || (sub('sessions') && !READ_METHODS.has(method)))) return 'run';
  if (kind === 'credential' && sub('oauth2')) return 'update';
  if (READ_METHODS.has(method)) return 'read';
  if (method === 'DELETE' && !rest && kind !== 'execution') return 'delete';
  return 'update';
}

// ---- the second-factor policy (C16) ----
// Here, beside the route policy, because the guard reads it on every request (and test/runtime.test.ts caps the guard's static import closure).
// Who must have a second factor (`LANDFLOW_MFA_REQUIRED`: `off`, `admins`, `all`) is computed on each request, so a session made before
// the mode was switched on is caught too; single sign-on sessions are never asked. See docs/features/authentication.md#second-factor.

export type MfaMode = 'off' | 'admins' | 'all';

export function mfaMode(): MfaMode {
  const value = envString('LANDFLOW_MFA_REQUIRED')?.trim().toLowerCase();
  return value === 'admins' || value === 'all' ? value : 'off';
}

/** Does the current mode cover a user of this role? */
export function mfaCovers(user: { role: Role }): boolean {
  const mode = mfaMode();
  return mode === 'all' || (mode === 'admins' && (user.role === 'owner' || user.role === 'admin'));
}

const SSO: SessionMethod[] = ['oidc', 'saml'];

/** True when the policy covers this user, the session is a local one and the user has no usable factor (confirmed and not flagged: a flagged passkey is refused at sign-in): the session may only enrol one. */
export function enrolmentRequired(user: UserRecord, sessionMethod: SessionMethod | undefined): boolean {
  if (!mfaCovers(user)) return false;
  if (sessionMethod && SSO.includes(sessionMethod)) return false;
  return !authDb().get('SELECT 1 AS one FROM user_mfa_factors WHERE user_id = ? AND confirmed_at IS NOT NULL AND flagged_at IS NULL LIMIT 1', user.id);
}

/** What an enrol-only session may call: who it is, its own factors, and signing out. Everything else answers 403 `mfa_enrolment_required`. */
export function enrolOnlyAllowed(method: string, path: string): boolean {
  if (path === '/api/auth/me' && method === 'GET') return true;
  if (path === '/api/me/mfa' || path.startsWith('/api/me/mfa/')) return true;
  return path === '/api/auth/logout';
}
