/**
 * Log lines you can join: inside an API request every line carries the request id, user, API key id and route, and the
 * response carries `traceparent` when a span is active (lib/server/audit/context, audit/http, telemetry/logger).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

Object.assign(process.env, {  LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-logctx-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { handler, json } = await import('@/lib/server/http');
const { telemetryConfig } = await import('@/lib/server/telemetry/config');
// The setup file loaded the config with the suite's level (error): lines under it would not be written.
telemetryConfig.logLevel = 'info';
const { logger } = await import('@/lib/server/telemetry/logger');
const { withAuditRequest } = await import('@/lib/server/audit/context');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');

const lines: Record<string, unknown>[] = [];
const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
  try {
    lines.push(JSON.parse(String(chunk)));
  } catch {}
  return true;
});

const manager = new AsyncLocalStorageContextManager().enable();
beforeAll(() => context.setGlobalContextManager(manager));
afterAll(() => {
  spy.mockRestore();
  context.disable();
});
afterEach(() => (lines.length = 0));

const route = handler(async () => {
  logger.info('inside the route', { note: 'x' });
  return json({ ok: true });
});
const call = (headers: Record<string, string> = {}) => route(new Request('http://t.test/api/log-context', { headers }), { params: Promise.resolve({}) });

describe('request-joined log lines', () => {
  it('stamps request id, user and route on a line written in a handler', async () => {
    const response = await call({ 'x-request-id': 'req-from-client-1' });
    const line = lines.find((l) => l.msg === 'inside the route');
    expect(line).toMatchObject({ request_id: 'req-from-client-1', 'user.id': TEST_OWNER.id, 'http.route': '/api/log-context', note: 'x' });
    expect(response.headers.get('x-request-id')).toBe('req-from-client-1');
  });

  it('adds the API key id (not redacted as a key) when the principal came from a key', () => {
    withAuditRequest(
      {
        requestId: 'r2',
        method: 'GET',
        path: '/api/x',
        route: '/api/x',
        recorded: 0,
        principal: { user: { id: 'u_1' } as never, via: 'api-key', apiKey: { id: 'key_42', scopes: [] } },
      },
      () => logger.info('with key'),
    );
    expect(lines.find((l) => l.msg === 'with key')).toMatchObject({ request_id: 'r2', 'user.id': 'u_1', 'landflow.api_key.id': 'key_42' });
  });

  it('writes no request fields outside a request', () => {
    logger.info('outside');
    const line = lines.find((l) => l.msg === 'outside')!;
    expect(line.request_id).toBeUndefined();
    expect(line['user.id']).toBeUndefined();
  });

  it('answers with traceparent when a span is active, and none otherwise', async () => {
    expect((await call()).headers.get('traceparent')).toBeNull();
    lines.length = 0;
    const span = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    const response = await context.with(trace.setSpan(context.active(), span), () => call());
    expect(response.headers.get('traceparent')).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(lines.find((l) => l.msg === 'inside the route')).toMatchObject({ trace_id: 'a'.repeat(32) });
  });
});
