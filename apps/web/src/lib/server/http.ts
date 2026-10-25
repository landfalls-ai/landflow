import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { withAuth } from './auth/context';
import { AuthError, guardRequest } from './auth/guard';
import { noteAuditPrincipal } from './audit/context';
import { auditRequest } from './audit/http';
import { ensureBootstrapped } from './bootstrap';
import { logger } from './telemetry';

export function json<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Wrap a route handler: bootstrap first, then the auth guard (lib/server/auth/guard.ts: a session or API key unless
 * the path is on the public allow-list, plus the route's scope and role), then the handler as that user; thrown
 * errors become JSON. Every request runs in an audit context, and a change that recorded no audit event of its own
 * gets a generic one (lib/server/audit/http.ts).
 */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> =>
    auditRequest(args, async () => {
      try {
        await ensureBootstrapped();
        const gate = guardRequest(args[0] instanceof Request ? args[0] : undefined);
        if (!gate.ok) return gate.response;
        noteAuditPrincipal(gate.auth.principal);
        return await withAuth(gate.auth, () => fn(...args));
      } catch (caught) {
        if (caught instanceof AuthError) return error(caught.message, caught.status);
        logger.error('route error', { error: caught, 'url.path': routePath(args[0]) });
        return error((caught as Error).message ?? 'Internal error', 500);
      }
    });
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
