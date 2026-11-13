/**
 * Where the current API request comes from, for audit events recorded below the route handler: the request id, the
 * client's address and user agent, the method and route pattern, and (once the guard let it through) the principal.
 * `handler` (lib/server/http.ts) runs each request inside `withAuditRequest` (./http); outside a request (schedules,
 * triggers, workers) there is none and events are recorded as the system.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../auth/context';
import { singleton } from '../singleton';

export interface AuditRequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  method: string;
  /** The pathname (never the query string). */
  path: string;
  /** The route pattern (`/api/workflows/[id]`) and its non-secret parameters, when known. */
  route?: string;
  params?: Record<string, string>;
  principal?: Principal;
  /** The resource the route names and its project, looked up before the handler ran (a delete removes it: ./project). */
  target?: { type: string; id: string; projectId?: string };
  /** Domain events recorded during this request (the generic `api.request` event is skipped when there are any). */
  recorded: number;
}

const storage = () => singleton('audit-request-context', () => new AsyncLocalStorage<AuditRequestContext>());

export function withAuditRequest<T>(ctx: AuditRequestContext, fn: () => T): T {
  return storage().run(ctx, fn);
}

/** The current request's audit context, if any. */
export function auditRequestContext(): AuditRequestContext | undefined {
  return storage().getStore();
}

/** The guard's principal for this request (handler calls it once the request is let through). */
export function noteAuditPrincipal(principal: Principal | undefined) {
  const ctx = storage().getStore();
  if (ctx && principal) ctx.principal = principal;
}

/**
 * The fields the logger stamps on every line written while a request runs, so a line joins to its request id and actor
 * (`landflow.api_key.id` is the key's id, never the key). Cheap: one store lookup and a small object; nothing outside a request.
 */
export function requestLogFields(): Record<string, string> | undefined {
  const ctx = storage().getStore();
  if (!ctx) return undefined;
  const fields: Record<string, string> = { request_id: ctx.requestId };
  const principal = ctx.principal;
  if (principal) {
    fields['user.id'] = principal.user.id;
    if (principal.apiKey) fields['landflow.api_key.id'] = principal.apiKey.id;
  }
  if (ctx.route) fields['http.route'] = ctx.route;
  return fields;
}
