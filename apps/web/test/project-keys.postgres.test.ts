/**
 * Project keys across two processes sharing one Postgres (opt-in: LANDFLOW_INTEGRATION=queue). Creates a throwaway
 * database (`landflow_project_keys_<run>_test`) on the infra stack's Postgres (55432, or LANDFLOW_TEST_POSTGRES_ADMIN_URL),
 * opens it twice as two queue-mode processes would, and drops it at the end:
 *
 * - a credential the main process seals with a project's fresh key opens in the worker (the key row and the credential
 *   row replicate), and Postgres holds the wrapped key, never the key;
 * - the main rotates the project's key: the worker opens the re-sealed value and seals a new one with version 2, read
 *   from the database, not from a cache;
 * - a root rotation in the main re-wraps the key rows, and a worker that has only the new ring opens everything;
 * - migrate and revert, run in the main, reach Postgres: reverted rows are plain version 2 values the ring alone opens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const ADMIN_URL = process.env.LANDFLOW_TEST_POSTGRES_ADMIN_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/postgres';
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));
const DB_NAME = `landflow_project_keys_${Date.now().toString(36)}_test`;
const K1 = `k1:${'a1'.repeat(32)}`;
const K2 = `k2:${'b2'.repeat(32)}`;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('project keys in Postgres, two processes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-pg-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEYS: K1 });
  delete process.env.LANDFLOW_ENCRYPTION_KEY;
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { CredentialTable, CredentialVault } = await import('@/lib/server/credentials/vault');
  const { projectKeysOf } = await import('@/lib/server/credentials/project-keys');
  const ring = await import('@/lib/server/credentials/key-ring');
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  registry.registerBuiltin(corePlugin);

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  const opened: Database[] = [];
  const tables: Array<InstanceType<typeof CredentialTable>> = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const header = (value: string) => ({ name: 'X-Key', value });
  const home = new Map<string, string>();
  let direct: InstanceType<typeof pg.Pool>;
  let main: Database;
  let worker: Database;

  const vaultOn = (db: Database, keys = K1) => {
    process.env.LANDFLOW_ENCRYPTION_KEYS = keys;
    const table = new CredentialTable(join(dataDir, 'credentials.json'), () => db);
    tables.push(table);
    const vault = new CredentialVault({ dir: dataDir, backend: table, keyDb: () => db });
    vault.setProjectResolver((id) => home.get(id));
    return vault;
  };

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    direct = new pg.Pool({ connectionString: url.toString(), max: 1 });
    main = await openPostgres(url.toString(), mkdtempSync(join(tmpdir(), 'landflow-project-keys-pg-main-')), { instanceId: 'pk-main' });
    opened.push(main);
    worker = await openPostgres(url.toString(), mkdtempSync(join(tmpdir(), 'landflow-project-keys-pg-worker-')), { instanceId: 'pk-worker' });
    opened.push(worker);
  });

  afterAll(async () => {
    for (const table of tables) table.close();
    await direct?.end();
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  });

  it('a credential sealed by one process with a fresh project key opens in the other; Postgres holds only the wrapped key', async () => {
    const mainVault = vaultOn(main);
    const workerVault = vaultOn(worker);
    home.set('cred_pg_1', 'prj_pg');
    mainVault.create({ name: 'Sealed on main', type: 'core.httpHeaderAuth', data: header('main-secret-1234567') }, { id: 'cred_pg_1' });
    await main.flush();
    await until(() => expect(workerVault.sealedWith('cred_pg_1')).toBe('dek:prj_pg.1'));
    expect(workerVault.dataFor({ id: 'cred_pg_1', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'main-secret-1234567' });
    const row = (await direct.query<{ wrapped: string; state: string }>('SELECT wrapped, state FROM project_keys WHERE project_id = $1', ['prj_pg'])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ state: 'active' });
    expect(row[0]!.wrapped).toMatch(/^v2\.k1\./);
    expect(row[0]!.wrapped).not.toContain(mainVault.projectKeys.keyFor('prj_pg', 1).toString('hex'));
  });

  it('a rotation in one process: the other opens the re-sealed value and seals new ones with version 2', async () => {
    const mainVault = vaultOn(main);
    const workerVault = vaultOn(worker);
    await until(() => expect(workerVault.sealedWith('cred_pg_1')).toBe('dek:prj_pg.1'));
    // The worker has used version 1 (and has it cached); the main rotates.
    expect(workerVault.dataFor({ id: 'cred_pg_1', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'main-secret-1234567' });
    const result = projectKeysOf(mainVault).rotate('prj_pg');
    expect(result).toMatchObject({ version: 2, resealed: 1, failed: [] });
    await main.flush();
    await until(() => expect(workerVault.sealedWith('cred_pg_1')).toBe('dek:prj_pg.2'));
    expect(workerVault.dataFor({ id: 'cred_pg_1', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'main-secret-1234567' });
    home.set('cred_pg_2', 'prj_pg');
    workerVault.create({ name: 'Sealed on worker', type: 'core.httpHeaderAuth', data: header('worker-secret-12345') }, { id: 'cred_pg_2' });
    expect(workerVault.sealedWith('cred_pg_2')).toBe('dek:prj_pg.2');
    await worker.flush();
    await until(() => expect(mainVault.sealedWith('cred_pg_2')).toBe('dek:prj_pg.2'));
    expect(mainVault.dataFor({ id: 'cred_pg_2', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'worker-secret-12345' });
  });

  it('root rotation re-wraps the key rows in Postgres and no credential row; a process with only the new ring opens everything', async () => {
    const before = new Map((await direct.query<{ id: string; data: string }>('SELECT id, data FROM credentials')).rows.map((r) => [r.id, r.data]));
    // The ring after the rotation: new first, old still listed, in a vault of its own on the main's database.
    const rotated = vaultOn(main, `${K2},${K1}`);
    const result = projectKeysOf(rotated).rewrapAll();
    expect(result).toMatchObject({ rewrapped: 1, failed: [] });
    await main.flush();
    const wrapped = (await direct.query<{ wrapped: string }>('SELECT wrapped FROM project_keys')).rows.map((r) => r.wrapped);
    expect(wrapped.every((w) => w.startsWith('v2.k2.'))).toBe(true);
    const after = new Map((await direct.query<{ id: string; data: string }>('SELECT id, data FROM credentials')).rows.map((r) => [r.id, r.data]));
    for (const [id, data] of before) expect(after.get(id)).toBe(data);
    // The worker restarts with the new key only.
    const fresh = vaultOn(worker, K2);
    await until(() => expect(fresh.dataFor({ id: 'cred_pg_1', name: 'x' }, 'core.httpHeaderAuth')).toMatchObject({ value: 'main-secret-1234567' }));
  });

  it('revert in one process reaches Postgres as plain version 2 values the ring alone opens; migrate puts them back', async () => {
    const mainVault = vaultOn(main, `${K2},${K1}`);
    const keys = projectKeysOf(mainVault);
    const reverted = keys.revert();
    expect(reverted).toMatchObject({ failed: [], onProjectKeys: 0, done: true });
    await main.flush();
    const rows = (await direct.query<{ id: string; data: string }>('SELECT id, data FROM credentials')).rows;
    const ringOnly = ring.buildKeyRing(`${K2},${K1}`, undefined);
    for (const { id, data } of rows) {
      const sealed = JSON.parse(data) as import('@/lib/server/credentials/key-ring').SealedValue;
      expect(sealed).toMatchObject({ v: 2, kid: 'k2' });
      expect(JSON.parse(ring.openWith(ringOnly, sealed, `landflow:credential:${id}`))).toHaveProperty('value');
    }
    expect(keys.migrate()).toMatchObject({ failed: [], done: true });
    await main.flush();
    expect(JSON.parse((await direct.query<{ data: string }>('SELECT data FROM credentials WHERE id = $1', ['cred_pg_1'])).rows[0]!.data)).toMatchObject({ v: 3, dek: 'prj_pg.2' });
  });
});
