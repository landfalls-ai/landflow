import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { withAuth } from './auth/context';
import { AuthError, guardRequest } from './auth/guard';
import { noteAuditPrincipal } from './audit/context';
import { auditRequest } from './audit/http';
import { isDraining, trackRequest, whenReady } from './lifecycle';
import { logger } from './telemetry';

export function json<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Wrap a route handler: wait until the host booted (lifecycle.ts `whenReady`, which boots it through the registered
 * bootstrapper), then the auth guard (lib/server/auth/guard.ts: a session or API key unless the path is on the
 * public allow-list, plus the route's scope and role), then the handler as that user; thrown
 * errors become JSON. Every request runs in an audit context, and a change that recorded no audit event of its own
 * gets a generic one (lib/server/audit/http.ts). While the host drains for shutdown, new requests get 503 with
 * Retry-After (health checks excepted); requests in flight are counted so the shutdown can wait for them.
 */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    if (isDraining() && !routePath(args[0])?.startsWith('/api/health')) {
      return NextResponse.json({ error: 'The server is shutting down' }, { status: 503, headers: { 'Retry-After': '5' } });
    }
    return trackRequest(() => run(fn, args));
  };
}

function run<A extends unknown[]>(fn: (...args: A) => Promise<Response>, args: A): Promise<Response> {
  return (
    auditRequest(args, async () => {
      try {
        await whenReady();
        const gate = guardRequest(args[0] instanceof Request ? args[0] : undefined);
        if (!gate.ok) return gate.response;
        noteAuditPrincipal(gate.auth.principal);
        return await withAuth(gate.auth, () => fn(...args));
      } catch (caught) {
        if (caught instanceof AuthError) return error(caught.message, caught.status);
        // Postgres mode refuses writes while a batch is blocked (db/database.ts StoreUnavailableError): a 503 to retry
        // later, not a 500. Matched by name so this module doesn't import the database layer.
        if (caught instanceof Error && caught.name === 'StoreUnavailableError') {
          return NextResponse.json({ error: caught.message }, { status: 503, headers: { 'Retry-After': '30' } });
        }
        logger.error('route error', { error: caught, 'url.path': routePath(args[0]) });
        return error((caught as Error).message ?? 'Internal error', 500);
      }
    })
  );
}

function routePath(request: unknown): string | undefined {
  if (!(request instanceof Request)) return undefined;
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: error('Request body must be JSON') };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: error('Invalid request', 400, { issues: parsed.error.issues.slice(0, 10) }) };
  }
  return { ok: true, data: parsed.data };
}

export const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
