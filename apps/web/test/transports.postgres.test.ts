/**
 * The transport policy and broker connections on a real Postgres, across two processes (opt-in:
 * LANDFLOW_INTEGRATION=queue; LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test`, in a schema of
 * its own). A main stores a plugin's policy and a connection; a worker sees both within moments (LISTEN/NOTIFY drops
 * its caches), the connection's secrets opened with the shared encryption key. A worker's broker manager opens a
 * connection the main added (and closes it when the main deletes it), with the in-memory driver as the kind.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_transports_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('transport policy and connections on Postgres, two processes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-transports-pg-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'transports-postgres-test-key' });
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { TransportPolicyStore } = await import('@/lib/server/transports/policy-store');
  const { TransportConnections } = await import('@/lib/server/transports/connections');
  const { TransportProviderRegistry } = await import('@/lib/server/transports/provider');
  const { BrokerConnectionManager, DriverModules } = await import('@/lib/server/transports/brokers');
  const { registerBrokerProviders } = await import('@/lib/server/transports/broker-provider');
  const { MemoryBroker } = await import('@landflow/transports/memory');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  let main: Database;
  let worker: Database;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-tpg-main-')), { instanceId: 'tpg-main' });
    worker = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-tpg-worker-')), { instanceId: 'tpg-worker' });
    opened.push(main, worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('a policy set by the main is what the worker reads', async () => {
    const onMain = new TransportPolicyStore({ db: () => main });
    const onWorker = new TransportPolicyStore({ db: () => worker });
    expect(onWorker.get('twilio')).toEqual({ mode: 'auto', objective: 'balanced' });
    onMain.set('twilio', { mode: 'pinned', pinned: 'kafka', objective: 'throughput' }, 'u1');
    await main.flush();
    await until(() => expect(onWorker.get('twilio')).toEqual({ mode: 'pinned', pinned: 'kafka', objective: 'throughput' }));
    onMain.set('twilio', { mode: 'auto' });
    await main.flush();
    await until(() => expect(onWorker.get('twilio')).toEqual({ mode: 'auto', objective: 'balanced' }));
  });

  it('a connection added by the main is read by the worker, secrets opened with the shared key', async () => {
    const onMain = new TransportConnections({ db: () => main, env: {} });
    const onWorker = new TransportConnections({ db: () => worker, env: {} });
    const created = onMain.create({ name: 'Kafka main', kind: 'kafka', config: { url: 'kafka://kafka:9092' }, secrets: { password: 'pg-secret' } });
    await main.flush();
    await until(() => expect(onWorker.get(created.id)?.secrets).toEqual({ password: 'pg-secret' }));
    const raw = await admin.query<{ secrets: string }>('SELECT secrets FROM transport_connections WHERE id = $1', [created.id]);
    expect(raw.rows[0]?.secrets).toMatch(/^v[12]\./);
    expect(raw.rows[0]?.secrets).not.toContain('pg-secret');
    expect(onMain.delete(created.id)).toBe(true);
    await main.flush();
    await until(() => expect(onWorker.get(created.id)).toBeUndefined());
  });

  it('a broker connection the main adds is opened by the worker’s manager, and closed when the main deletes it', async () => {
    const broker = new MemoryBroker();
    const modules = new DriverModules();
    modules.register({ kind: 'memory', label: 'Memory (test)', capabilities: broker.capabilities, exampleUrl: 'memory://local', create: () => broker.driver(), configFrom: (connectionId) => ({ connectionId }) });
    const providers = new TransportProviderRegistry();
    const onMain = new TransportConnections({ db: () => main, env: {}, providers });
    const onWorker = new TransportConnections({ db: () => worker, env: {}, providers });
    const manager = new BrokerConnectionManager({ connections: onWorker, modules, env: { LANDFLOW_TRANSPORT_SECRET: 'pg-transport-secret' }, discovery: { addEndpoint: async () => undefined, withdraw: () => true, removeEndpoint: () => true }, probeIntervalMs: 0 });
    await registerBrokerProviders({ modules, providers, manager });
    try {
      await manager.start();
      expect(manager.openConnections()).toEqual([]);
      const created = onMain.create({ name: 'Memory main', kind: 'memory', config: { url: 'memory://local' } });
      await main.flush();
      await until(() => expect(manager.openConnections()).toEqual([created.id]));
      expect(manager.health(created.id)).toMatchObject({ state: 'connected' });
      onMain.update(created.id, { enabled: false });
      await main.flush();
      await until(() => expect(manager.openConnections()).toEqual([]));
      onMain.update(created.id, { enabled: true });
      await main.flush();
      await until(() => expect(manager.openConnections()).toEqual([created.id]));
      expect(onMain.delete(created.id)).toBe(true);
      await main.flush();
      await until(() => expect(manager.openConnections()).toEqual([]));
    } finally {
      await manager.stop();
    }
  });
});
