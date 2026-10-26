/**
 * Credentials and settings documents in Postgres, across two processes (opt-in: LANDFLOW_INTEGRATION=queue).
 *
 * Creates a throwaway database (`landflow_config_store_<run>_test`) on the infra stack's Postgres (55432, or
 * LANDFLOW_TEST_POSTGRES_ADMIN_URL), opens it twice as two queue-mode processes would (each with its own data
 * directory and replica), and drops it at the end:
 *
 * - the first process imports credentials.json once; the second finds the rows (no second import) and the file stays
 *   as it was;
 * - a credential created, changed or deleted in one process is seen by the other within moments (LISTEN/NOTIFY);
 * - both creating credentials at once keeps both (no last-writer-wins file);
 * - a settings document (mcp.json) written by one is read by the other.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const ADMIN_URL = process.env.LANDFLOW_TEST_POSTGRES_ADMIN_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/postgres';
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));
const DB_NAME = `landflow_config_store_${Date.now().toString(36)}_test`;

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('credentials and settings documents in Postgres, two processes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-config-pg-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEY: 'config-store-postgres-test-key' });
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { ConfigFile } = await import('@/lib/server/config-store');
  const { CredentialFile, CredentialTable, CredentialVault } = await import('@/lib/server/credentials/vault');
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  registry.registerBuiltin(corePlugin);

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  const opened: Database[] = [];
  const tables: Array<InstanceType<typeof CredentialTable>> = [];
  /** The data directory both processes share (credentials.json from before database mode). */
  const shared = mkdtempSync(join(tmpdir(), 'landflow-config-pg-shared-'));
  const file = join(shared, 'credentials.json');
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const header = (value: string) => ({ name: 'X-Key', value });
  let main: Database;
  let worker: Database;
  const vaultOn = (db: Database) => {
    const table = new CredentialTable(file, () => db);
    tables.push(table);
    return new CredentialVault({ dir: shared, backend: table });
  };

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    main = await openPostgres(url.toString(), mkdtempSync(join(tmpdir(), 'landflow-config-pg-main-')), { instanceId: 'cfg-main' });
    opened.push(main);
    worker = await openPostgres(url.toString(), mkdtempSync(join(tmpdir(), 'landflow-config-pg-worker-')), { instanceId: 'cfg-worker' });
    opened.push(worker);
  });

  afterAll(async () => {
    for (const table of tables) table.close();
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  });

  it('imports credentials.json once, leaves it, and both processes follow each other’s changes', async () => {
    const before = new CredentialVault({ dir: shared, backend: new CredentialFile(file) });
    const imported = before.create({ name: 'From the file', type: 'core.httpHeaderAuth', data: header('file-secret') });
    const bytes = readFileSync(file);

    const mainVault = vaultOn(main);
    expect(mainVault.list().map((c) => c.id)).toEqual([imported.id]);
    await main.flush();
    const workerVault = vaultOn(worker);
    await until(() => expect(workerVault.list().map((c) => c.id)).toEqual([imported.id]));
    expect(workerVault.dataFor({ id: imported.id, name: 'From the file' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'file-secret' });
    expect(main.get('SELECT value FROM meta WHERE key = ?', 'config_store.imported.credentials.json')).toBeDefined();

    // Created on the main, seen on the worker; changed on the worker, seen on the main; deleted, gone on both.
    const created = mainVault.create({ name: 'Created on main', type: 'core.httpHeaderAuth', data: header('main-secret') });
    await main.flush();
    await until(() => expect(workerVault.get(created.id)?.name).toBe('Created on main'));
    workerVault.update(created.id, { name: 'Renamed on worker', data: { value: 'worker-secret' } });
    await worker.flush();
    await until(() => expect(mainVault.get(created.id)?.name).toBe('Renamed on worker'));
    expect(mainVault.dataFor({ id: created.id, name: 'Renamed on worker' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'worker-secret' });
    mainVault.delete(imported.id);
    await main.flush();
    await until(() => expect(workerVault.get(imported.id)).toBeUndefined());

    // At once on both: both kept.
    const a = mainVault.create({ name: 'A', type: 'core.httpHeaderAuth', data: header('a') });
    const b = workerVault.create({ name: 'B', type: 'core.httpHeaderAuth', data: header('b') });
    await Promise.all([main.flush(), worker.flush()]);
    await until(() => {
      expect(mainVault.list().map((c) => c.id).sort()).toEqual([a.id, b.id, created.id].sort());
      expect(workerVault.list().map((c) => c.id).sort()).toEqual([a.id, b.id, created.id].sort());
    });

    // The file was never written, and the deleted credential doesn't come back from it in a new process.
    expect(readFileSync(file).equals(bytes)).toBe(true);
    const restarted = vaultOn(worker);
    expect(restarted.get(imported.id)).toBeUndefined();
  });

  it('shares a settings document between the processes', async () => {
    const onMain = new ConfigFile<{ enabled: boolean }>('mcp.json', { dir: () => shared, kind: () => 'database', db: () => main, writer: 'cfg-main' });
    const onWorker = new ConfigFile<{ enabled: boolean }>('mcp.json', { dir: () => shared, kind: () => 'database', db: () => worker, writer: 'cfg-worker' });
    expect(onMain.read()).toBeUndefined();
    onMain.write({ enabled: true });
    await main.flush();
    await until(() => expect(onWorker.read()).toEqual({ enabled: true }));
    onWorker.write({ enabled: false });
    await worker.flush();
    await until(() => expect(onMain.read()).toEqual({ enabled: false }));
  });
});
