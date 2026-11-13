/**
 * The audit log's generic layer: `handler` (lib/server/http.ts) runs every API request through `auditRequest`, which
 * sets up the request's audit context (./context: request id, client address, user agent, method, route pattern)
 * and, for a change (POST, PUT, PATCH, DELETE) that recorded no domain event of its own, records an `api.request`
 * event with the method, route pattern, status and outcome (2xx/3xx success, 401/403 denied, otherwise failure).
 * A read (GET, HEAD) refused with 401 or 403 records `api.denied`, at most once a minute per (user or client address,
 * route pattern), so probing shows up in the log without a polling tab flooding it.
 * Nothing reads the request body, and only the route pattern is kept (no query string, no parameter values beyond
 * the target id). Paths that change nothing anyone audits, or that fire constantly (edit-lock heartbeats, plugin
 * announcements, public webhooks and form resumes, Slack callbacks, MCP JSON-RPC, remote agents' trace batches, editor
 * helpers like load-options and expression previews, assistant chats, binary uploads), are skipped.
 *
 * The response carries the request id as `X-Request-Id` (taken from the request's own header when it is sane).
 */
import { randomUUID } from 'node:crypto';
import type { AuditOutcome } from '../../shared/audit';
import type { Principal } from '../auth/context';
import { resolvePrincipal } from '../auth/guard';
import { clientIp } from '../auth/rate-limit';
import { testPrincipal } from '../auth/test-bypass';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { withAuditRequest, type AuditRequestContext } from './context';
import { recordAudit } from './index';
import { projectTarget, targetProject } from './project';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Denied reads are recorded once per window per (who, route), and the map holds at most this many keys. */
const DENIED_WINDOW_MS = 60_000;
const DENIED_KEYS = 10_000;
const deniedSeen = () => singleton('audit-denied-reads', () => new Map<string, number>());

/** True when a denied read by `who` on `route` has not been recorded in the last minute (and remembers it now). */
export function deniedReadDue(who: string, route: string, now = Date.now()): boolean {
  const seen = deniedSeen();
  const key = `${who}\n${route}`;
  const last = seen.get(key);
  if (last !== undefined && now - last < DENIED_WINDOW_MS) return false;
  seen.delete(key);
  if (seen.size >= DENIED_KEYS) {
    // Full: forget what has expired, and if that is not enough the oldest entries (insertion order is age order).
    for (const [k, at] of seen) if (now - at >= DENIED_WINDOW_MS) seen.delete(k);
    for (const k of seen.keys()) {
      if (seen.size < DENIED_KEYS) break;
      seen.delete(k);
    }
  }
  seen.set(key, now);
  return true;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Changes the generic layer leaves out (see the module comment). */
const SKIP: RegExp[] = [
  /^\/api\/workflows\/[^/]+\/lock$/,
  /^\/api\/plugins\/announce$/,
  /^\/api\/webhook(\/|$)/,
  /^\/api\/waiting\//,
  /^\/api\/slack\//,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/node-types\/load-options$/,
  /^\/api\/expressions\/preview$/,
  /^\/api\/assistant\//,
  /^\/api\/ai\//,
  /^\/api\/agents\/[^/]+\/chat$/,
  /^\/api\/agents\/[^/]+\/sessions\//,
  /^\/api\/binary(\/|$)/,
  /^\/api\/agent-trace\//,
  /^\/api\/auth\/saml\/acs$/,
];

export const auditSkipped = (path: string) => SKIP.some((pattern) => pattern.test(path));

/** `/api/workflows/wf_1/publish` with `{ id: 'wf_1' }` → `/api/workflows/[id]/publish`. */
export function routePattern(path: string, params: Record<string, string | string[]> | undefined): string {
  if (!params || !Object.keys(params).length) return path;
  const segments = path.split('/');
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const joined = value.map((v) => encodeURIComponent(v)).join('/');
      const at = path.lastIndexOf(`/${joined}`);
      if (joined && at >= 0) return routePattern(`${path.slice(0, at)}/[...${name}]${path.slice(at + joined.length + 1)}`, Object.fromEntries(Object.entries(params).filter(([n]) => n !== name)));
      continue;
    }
    const encoded = encodeURIComponent(value);
    const index = segments.findIndex((segment, i) => i > 1 && (segment === encoded || segment === value) && !segment.startsWith('['));
    if (index >= 0) segments[index] = `[${name}]`;
  }
  return segments.join('/');
}

export function outcomeOf(status: number): AuditOutcome {
  if (status === 401 || status === 403) return 'denied';
  return status >= 200 && status < 400 ? 'success' : 'failure';
}

/** The target of a generic event: the resource the route names (`/api/<type>/[id]…`). */
function targetOf(route: string, params: Record<string, string> | undefined): { type: string; id?: string } | undefined {
  const match = /^\/api\/([a-z-]+)(?:\/\[([a-zA-Z]+)\])?/.exec(route);
  if (!match) return undefined;
  const type = match[1].replace(/-/g, '_').replace(/ies$/, 'y').replace(/s$/, '');
  const id = match[2] ? params?.[match[2]] : undefined;
  return { type, ...(id && { id }) };
}

async function paramsOf(ctx: unknown): Promise<Record<string, string> | undefined> {
  const raw = (ctx as { params?: unknown } | undefined)?.params;
  if (!raw) return undefined;
  try {
    const value = (await raw) as Record<string, string | string[]>;
    return value && typeof value === 'object' ? (Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : String(v)])) as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/** Run a route handler with an audit context, and record the generic event afterwards (see the module comment). */
export async function auditRequest(args: unknown[], run: () => Promise<Response>): Promise<Response> {
  const request = args[0] instanceof Request ? args[0] : undefined;
  if (!request) return run();
  let path = '/';
  try {
    path = new URL(request.url).pathname;
  } catch {}
  const method = request.method.toUpperCase();
  const given = request.headers.get('x-request-id')?.trim();
  const ctx: AuditRequestContext = {
    requestId: given && REQUEST_ID.test(given) ? given : randomUUID(),
    ip: clientIp(request),
    ...(request.headers.get('user-agent') && { userAgent: request.headers.get('user-agent')!.slice(0, 300) }),
    method,
    path,
    recorded: 0,
  };
  const params = await paramsOf(args[1]);
  ctx.route = routePattern(path, params);
  if (params) ctx.params = params;
  // A change to a project resource: its project now, while it still exists (a delete takes it along).
  const named = MUTATING.has(method) && path.startsWith('/api/') ? targetOf(ctx.route, params) : undefined;
  if (named?.id && projectTarget(named)) ctx.target = { type: named.type, id: named.id, projectId: targetProject(named) };

  const response = await withAuditRequest(ctx, run);
  try {
    response.headers.set('x-request-id', ctx.requestId);
  } catch {
    // Immutable headers (a redirect): no id on this one.
  }
  if (!path.startsWith('/api/') || auditSkipped(path) || ctx.recorded > 0) return response;
  const denied = response.status === 401 || response.status === 403;
  if (!MUTATING.has(method) && !(denied && (method === 'GET' || method === 'HEAD'))) return response;
  try {
    const outcome = outcomeOf(response.status);
    // Refused by the guard: find out who it was (the guard doesn't hand the principal over when it refuses).
    let principal: Principal | undefined = ctx.principal;
    if (!principal && outcome === 'denied') {
      const resolved = resolvePrincipal(request);
      // (Tests sign guarded requests in through the bypass, which the guard uses the same way.)
      if (resolved.ok) principal = resolved.principal ?? testPrincipal();
    }
    if (principal) ctx.principal = principal;
    const target = targetOf(ctx.route, params);
    if (!MUTATING.has(method)) {
      if (!deniedReadDue(principal ? `user:${principal.user.id}` : `ip:${ctx.ip ?? 'unknown'}`, ctx.route)) return response;
      withAuditRequest(ctx, () =>
        recordAudit({ action: 'api.denied', outcome: 'denied', status: response.status, ...(target && { target }), summary: `${method} ${ctx.route} → ${response.status}` }),
      );
      return response;
    }
    withAuditRequest(ctx, () =>
      recordAudit({
        action: 'api.request',
        outcome,
        status: response.status,
        ...(target && { target }),
        summary: `${method} ${ctx.route} → ${response.status}`,
      }),
    );
  } catch (error) {
    logger.warn('could not audit an API request', { error: (error as Error).message });
  }
  return response;
}
