/**
 * HttpError and `handler` (lib/server/errors.ts, lib/server/http.ts): a thrown HttpError answers its status, code and
 * details; a ZodError a 400 with the issues; anything else a generic 500 with the request id and no message (the
 * message goes to the log); `mapError` and `formatError` let a wrapper translate its own errors.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-http-errors-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { HttpError } = await import('@/lib/server/errors');
const { AuthError } = await import('@/lib/server/auth/errors');
const { handler, parseBody } = await import('@/lib/server/http');
const { projectRoute } = await import('@/lib/server/projects/http');
const { ProjectError } = await import('@/lib/server/projects/store');
const { dataTableRoute } = await import('@/lib/server/datatables/http');
const { DataTableError } = await import('@/lib/server/datatables/storage');
const { MarketplaceError } = await import('@/lib/server/marketplace/service');
const { FetchError } = await import('@/lib/server/marketplace/reader');
const { marketplaceRoute } = await import('@/lib/server/marketplace/http');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const request = (method = 'GET') => new Request('http://localhost/api/http-errors-test', { method, headers: { 'x-request-id': 'req-123' } });
const throwing = (caught: unknown) => handler(async () => {
  throw caught;
});
const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('HttpError', () => {
  it('defaults to 400, exposes 4xx messages only and names its code after the class', () => {
    class NoSuchThingError extends HttpError {}
    const plain = new NoSuchThingError('nope');
    expect(plain).toMatchObject({ status: 400, code: 'no_such_thing_error', expose: true, message: 'nope' });
    expect(new HttpError('x', 503)).toMatchObject({ status: 503, expose: false });
    expect(new HttpError('x', 502, { expose: true, code: 'bad_gateway', details: { a: 1 }, cause: 'c' })).toMatchObject({ expose: true, code: 'bad_gateway', details: { a: 1 } });
  });

  it('is what AuthError extends', () => {
    const denied = new AuthError('no', 403);
    expect(denied).toBeInstanceOf(HttpError);
    expect(denied.status).toBe(403);
    expect(new AuthError('who?').status).toBe(401);
  });
});

describe('handler', () => {
  it('answers an HttpError with its status, code and details', async () => {
    const response = await throwing(new HttpError('Out of stock', 409, { code: 'out_of_stock', details: { sku: 'a1' } }))(request());
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: 'Out of stock', code: 'out_of_stock', sku: 'a1' });
  });

  it('answers a ZodError as 400 with the issues', async () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    const response = await throwing(parsed.error)(request());
    expect(response.status).toBe(400);
    const answer = await body(response);
    expect(answer).toMatchObject({ error: 'Invalid request', code: 'invalid_request' });
    expect(answer.issues).toHaveLength(1);
  });

  it('answers anything else with a generic 500, the request id and none of the message', async () => {
    const response = await throwing(new Error('SQLITE_ERROR: no such table: secrets at /var/lib/landflow/db.sqlite'))(request());
    expect(response.status).toBe(500);
    const text = JSON.stringify(await body(response));
    expect(text).not.toContain('SQLITE');
    expect(text).not.toContain('/var/lib');
    expect(JSON.parse(text)).toEqual({ error: 'Internal error', code: 'internal_error', requestId: 'req-123' });
    expect(response.headers.get('x-request-id')).toBe('req-123');
    expect((await throwing('a string')(request())).status).toBe(500);
  });

  it('keeps a 5xx HttpError with expose false generic', async () => {
    const response = await throwing(new HttpError('db password is hunter2', 503, { code: 'store_down' }))(request());
    expect(response.status).toBe(503);
    expect(await body(response)).toMatchObject({ error: 'Internal error', code: 'store_down' });
    const shown = await throwing(new HttpError('GitHub answered 500', 502, { expose: true }))(request());
    expect(await body(shown)).toMatchObject({ error: 'GitHub answered 500' });
  });

  it('lets a wrapper translate its errors (mapError) and render its own document (formatError)', async () => {
    class Mine extends Error {}
    const mapped = handler(
      async () => {
        throw new Mine('mine');
      },
      { mapError: (caught) => (caught instanceof Mine ? new HttpError('translated', 418) : undefined), formatError: (http) => Response.json({ detail: http.message, status: http.status }, { status: http.status }) },
    );
    const response = await mapped(request());
    expect(response.status).toBe(418);
    expect(await body(response)).toEqual({ detail: 'translated', status: 418 });
    // An error the wrapper does not know is still the generic 500, in the wrapper's format.
    const other = await handler(async () => Promise.reject(new Error('boom')), { formatError: (http) => Response.json({ detail: http.message }, { status: http.status }) })(request());
    expect(other.status).toBe(500);
    expect(await body(other)).toEqual({ detail: 'Internal error' });
  });

  it('puts the request id of a generic 500 in the SCIM error document', async () => {
    const { scimErrorFor, ScimError, SCHEMAS } = await import('@/lib/server/scim/http');
    const generic = await handler(async () => Promise.reject(new Error('SQLITE_BUSY at /var/lib')), { formatError: scimErrorFor })(request());
    expect(generic.status).toBe(500);
    expect(await body(generic)).toEqual({ schemas: [SCHEMAS.error], status: '500', detail: 'Internal error (request req-123)' });
    const refused = await handler(async () => Promise.reject(new ScimError(409, 'User exists', 'uniqueness')), { formatError: scimErrorFor })(request());
    expect(await body(refused)).toEqual({ schemas: [SCHEMAS.error], status: '409', scimType: 'uniqueness', detail: 'User exists' });
  });
});

describe('the wrappers', () => {
  it('projectRoute and dataTableRoute map their domain errors', async () => {
    const project = await projectRoute(async () => {
      throw new ProjectError('Project not found', 404);
    })(request());
    expect(project.status).toBe(404);
    expect(await body(project)).toMatchObject({ error: 'Project not found' });
    const table = await dataTableRoute(async () => {
      throw new DataTableError('Column exists', 409);
    })(request());
    expect(table.status).toBe(409);
    expect(await body(table)).toMatchObject({ error: 'Column exists' });
  });

  it('marketplace errors are HttpErrors: their status and extra fields, 502 for a failed fetch', async () => {
    const missing = await handler(marketplaceRoute(async () => {
      throw new MarketplaceError('The marketplace “x” isn’t added', 404, { missing: 'marketplace' });
    }))(request());
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({ error: 'The marketplace “x” isn’t added', missing: 'marketplace' });
    const fetched = await handler(marketplaceRoute(async () => {
      throw new FetchError('Not found: https://example.test/x', 404);
    }))(request());
    expect(fetched.status).toBe(502);
    expect(await body(fetched)).toMatchObject({ error: 'Not found: https://example.test/x', code: 'marketplace_fetch_failed' });
  });
});

describe('the approval email route', () => {
  it('runs through handler (request id, error mapping) and stays public', async () => {
    const { isPublicPath } = await import('@/lib/shared/auth-paths');
    expect(isPublicPath('/api/approvals/email/abc')).toBe(true);
    const route = await import('@/app/api/approvals/email/[token]/route');
    const response = await route.GET(new Request('http://localhost/api/approvals/email/not-a-token'), { params: Promise.resolve({ token: 'not-a-token' }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('parseBody', () => {
  const post = (text: string) => new Request('http://localhost/api/x', { method: 'POST', body: text });
  const schema = z.object({ a: z.number().optional() }).passthrough();

  it('refuses unreadable JSON and bad shapes, or treats them as empty when the body is optional', async () => {
    expect((await parseBody(post('{'), schema)).ok).toBe(false);
    expect((await parseBody(post('{"a":"x"}'), schema)).ok).toBe(false);
    expect(await parseBody(post(''), schema, { optional: true })).toEqual({ ok: true, data: {} });
    const custom = await parseBody(post('{'), schema, { message: 'Send JSON' });
    expect(custom.ok === false && (await body(custom.response)).error).toBe('Send JSON');
  });
});
