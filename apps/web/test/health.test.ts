/**
 * The probes: /api/health/live never touches a dependency, /api/health/ready answers from boot state, draining, the
 * database, the write queue, the schema version (and Valkey in queue mode), and /api/health keeps its counts for
 * callers with credentials only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-health-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_OWNER_EMAIL;
delete process.env.LANDFLOW_OWNER_PASSWORD;

const auth = await import('@/lib/server/auth');
const { forgetSingleton } = await import('@/lib/server/singleton');
const { database } = await import('@/lib/server/db');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const lifecycle = await import('@/lib/server/lifecycle');
const { clusterState } = await import('@/lib/server/cluster/state');
const liveRoute = await import('@/app/api/health/live/route');
const readyRoute = await import('@/app/api/health/ready/route');
const healthRoute = await import('@/app/api/health/route');

const get = (route: unknown, key?: string) =>
  (route as (r: Request) => Response | Promise<Response>)(new Request('http://localhost/api/health', { headers: key ? { 'x-landflow-api-key': key } : {} }));

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  forgetSingleton('lifecycle');
  process.env = previousEnv;
});

describe('before boot', () => {
  beforeAll(() => forgetSingleton('lifecycle'));

  it('live answers 200 and ready answers 503 while starting', async () => {
    expect(lifecycle.bootState()).toBe('starting');
    const live = await liveRoute.GET();
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'ok', uptimeSeconds: expect.any(Number) });
    const ready = await readyRoute.GET();
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.boot.ok).toBe(false);
    expect(body.checks.database).toBeUndefined();
  });
});

describe('after boot', () => {
  beforeAll(async () => {
    forgetSingleton('lifecycle');
    await ensureBootstrapped();
  });

  it('ready answers 200 with the check names and timings only', async () => {
    const ready = await readyRoute.GET();
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.status).toBe('ready');
    expect(Object.keys(body.checks).sort()).toEqual(['boot', 'database', 'migrations', 'writeQueue']);
    for (const result of Object.values<any>(body.checks)) expect(Object.keys(result).sort()).toEqual(['ms', 'ok']);
  });

  it('ready answers 503 when the write queue is blocked or lags', async () => {
    const db = database();
    const spy = vi.spyOn(db, 'writeHealth').mockReturnValue({ state: 'blocked', queuedBatches: 1, queuedOps: 3, oldestAgeMs: 1000 });
    let res = await readyRoute.GET();
    expect(res.status).toBe(503);
    expect((await res.json()).checks.writeQueue.ok).toBe(false);
    spy.mockReturnValue({ state: 'retrying', queuedBatches: 1, queuedOps: 3, oldestAgeMs: 31_000 });
    res = await readyRoute.GET();
    expect(res.status).toBe(503);
    spy.mockReturnValue({ state: 'retrying', queuedBatches: 1, queuedOps: 3, oldestAgeMs: 5_000 });
    expect((await readyRoute.GET()).status).toBe(200);
  });

  it('ready answers 503 when the database throws, without the error text in the body', async () => {
    vi.spyOn(database(), 'get').mockImplementation(() => {
      throw new Error('connection refused to db.internal:5432');
    });
    const res = await readyRoute.GET();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db.internal');
  });

  it('ready answers 503 when the schema is behind', async () => {
    vi.spyOn(database(), 'schemaVersion').mockReturnValue(0);
    expect((await readyRoute.GET()).status).toBe(503);
  });

  it('live still answers while draining; ready answers 503', async () => {
    await lifecycle.shutdown('test');
    expect((await liveRoute.GET()).status).toBe(200);
    const ready = await readyRoute.GET();
    expect(ready.status).toBe(503);
    expect((await ready.json()).checks.boot.ok).toBe(false);
  });
});

describe('valkey check in queue mode', () => {
  beforeAll(async () => {
    forgetSingleton('lifecycle'); // the drain test above left it draining
    await ensureBootstrapped();
    lifecycle.markBooted();
  });
  afterEach(() => {
    const state = clusterState();
    state.config.mode = 'regular' as never;
    state.coordinator = undefined;
  });

  const withCoordinator = (get: (() => Promise<unknown>) | undefined) => {
    const state = clusterState();
    state.config.mode = 'queue' as never;
    state.coordinator = get ? ({ get } as never) : undefined;
  };

  it('is ok when Valkey answers', async () => {
    withCoordinator(async () => null);
    const body = await (await readyRoute.GET()).json();
    expect(body.checks.valkey.ok).toBe(true);
  });

  it('is not ok when Valkey rejects or there is no coordinator', async () => {
    withCoordinator(async () => {
      throw new Error('down');
    });
    expect((await readyRoute.GET()).status).toBe(503);
    withCoordinator(undefined);
    expect((await readyRoute.GET()).status).toBe(503);
  });

  it('is not ok after 1 s when Valkey never answers', async () => {
    withCoordinator(() => new Promise(() => {}));
    const started = Date.now();
    const ready = await readyRoute.GET();
    expect(ready.status).toBe(503);
    expect((await ready.json()).checks.valkey.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('/api/health', () => {
  const anOwner = async () => auth.listUsers()[0] ?? (await auth.createOwner({ email: 'owner@example.com', name: 'Owner', password: 'owner-password-1' }));
  beforeAll(async () => {
    forgetSingleton('lifecycle'); // the Valkey block's state; this also forgets the bootstrapper setup.ts registered
    await ensureBootstrapped();
    lifecycle.markBooted(); // handler() waits on whenReady(), which reads the lifecycle state
    auth.disableTestAuth();
  });
  afterAll(() => auth.enableTestAuth());

  it('anonymous callers get the status only; an API key gets the counts', async () => {
    const anonymous = await get(healthRoute.GET);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ status: 'ok' });
    const { token } = auth.createApiKey(await anOwner(), { label: 'health', scopes: ['workflows:read'] });
    const keyed = await (await get(healthRoute.GET, token)).json();
    expect(keyed).toMatchObject({ status: 'ok', plugins: expect.any(Number), nodeTypes: expect.any(Number) });
  });

  it('an unknown or expired API key gets the status only', async () => {
    expect(await (await get(healthRoute.GET, 'lf_not-a-real-key')).json()).toEqual({ status: 'ok' });
    const { token } = auth.createApiKey(await anOwner(), { label: 'expired', scopes: ['workflows:read'], expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const expired = await get(healthRoute.GET, token);
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ status: 'ok' });
  });

  it('still answers the status when resolving the caller throws (the store is down)', async () => {
    const { token } = auth.createApiKey(await anOwner(), { label: 'store down', scopes: ['workflows:read'] });
    vi.spyOn(database(), 'get').mockImplementation(() => {
      throw new Error('store unavailable');
    });
    const response = await get(healthRoute.GET, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
