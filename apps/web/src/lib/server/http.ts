import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { withAuth } from './auth/context';
import { guardRequest } from './auth/guard';
import { auditRequestContext, noteAuditPrincipal } from './audit/context';
import { auditRequest } from './audit/http';
import { HttpError } from './errors';
import { isDraining, trackRequest, whenReady } from './lifecycle';
import { logger } from './telemetry';

export function json<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export interface HandlerOptions {
  /** Translate a domain error into an HttpError (return undefined to leave it to the default). */
  mapError?: (caught: unknown) => HttpError | undefined;
  /** Render the normalized error as the route's own error document (SCIM); the default is `{ error, code, ...details }`. */
  formatError?: (error: HttpError, request: Request | undefined) => Response;
}

/**
 * Wrap a route handler: wait until the host booted (lifecycle.ts `whenReady`, which boots it through the registered
 * bootstrapper), then the auth guard (lib/server/auth/guard.ts: a session or API key unless the path is on the
 * public allow-list, plus the route's scope and role), then the handler as that user. Thrown errors become JSON: an
 * HttpError (lib/server/errors.ts) with its status, code and details, a ZodError as 400, and anything else as a
 * generic 500 with the request id (the message goes to the log, never to the client). Every request runs in an audit
 * context, and a change that recorded no audit event of its own gets a generic one (lib/server/audit/http.ts). While
 * the host drains for shutdown, new requests get 503 with Retry-After (health checks excepted); requests in flight
 * are counted so the shutdown can wait for them.
 */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>, options: HandlerOptions = {}) {
  return async (...args: A): Promise<Response> => {
    if (isDraining() && !routePath(args[0])?.startsWith('/api/health')) {
      return NextResponse.json({ error: 'The server is shutting down' }, { status: 503, headers: { 'Retry-After': '5' } });
    }
    return trackRequest(() => run(fn, args, options));
  };
}

function run<A extends unknown[]>(fn: (...args: A) => Promise<Response>, args: A, options: HandlerOptions): Promise<Response> {
  return (
    auditRequest(args, async () => {
      try {
        await whenReady();
        const gate = guardRequest(args[0] instanceof Request ? args[0] : undefined);
        if (!gate.ok) return gate.response;
        noteAuditPrincipal(gate.auth.principal);
        return await withAuth(gate.auth, () => fn(...args));
      } catch (caught) {
        return answer(caught, args[0], options);
      }
    })
  );
}

/** The response for a thrown error (see `handler`). */
function answer(caught: unknown, request: unknown, options: HandlerOptions): Response {
  const asked = request instanceof Request ? request : undefined;
  const mapped = options.mapError?.(caught);
  const known = mapped ?? (caught instanceof HttpError ? caught : undefined);
  // Postgres mode refuses writes while a batch is blocked (db/database.ts StoreUnavailableError): a 503 to retry
  // later, not a 500. Matched by name so this module doesn't import the database layer.
  if (!known && caught instanceof Error && caught.name === 'StoreUnavailableError') {
    return NextResponse.json({ error: caught.message }, { status: 503, headers: { 'Retry-After': '30' } });
  }
  let http: HttpError;
  // Only a 5xx is hidden: a 4xx HttpError is shown even with `expose: false`.
  if (known && (known.expose || known.status < 500)) {
    http = known;
  } else if (!known && caught instanceof ZodError) {
    http = new HttpError('Invalid request', 400, { code: 'invalid_request', details: { issues: caught.issues.slice(0, 10) } });
  } else {
    const requestId = auditRequestContext()?.requestId;
    logger.error('route error', { error: known ?? caught, 'url.path': routePath(request), ...(requestId && { requestId }) });
    http = new HttpError('Internal error', known?.status ?? 500, { code: known?.code ?? 'internal_error', expose: true, ...(requestId && { details: { requestId } }) });
  }
  return options.formatError ? options.formatError(http, asked) : error(http.message, http.status, { code: http.code, ...http.details });
}

function routePath(request: unknown): string | undefined {
  if (!(request instanceof Request)) return undefined;
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}

export interface ParseOptions {
  /** A missing, empty or unreadable body counts as `{}` (routes whose body is optional) instead of a 400. */
  optional?: boolean;
  /** The error text of a body that isn't valid (default: 'Request body must be JSON' / 'Invalid request'). */
  message?: string;
}

/** The request's JSON body checked against `schema`; a failure comes back as the 400 response to return. */
export async function parseBody<T>(request: Request, schema: ZodType<T>, options: ParseOptions = {}): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    if (!options.optional) return { ok: false, response: error(options.message ?? 'Request body must be JSON') };
    body = {};
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: error(options.message ?? 'Invalid request', 400, { code: 'invalid_request', issues: parsed.error.issues.slice(0, 10) }) };
  }
  return { ok: true, data: parsed.data };
}

export const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
