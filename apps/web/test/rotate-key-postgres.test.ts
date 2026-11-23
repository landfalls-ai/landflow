/**
 * `pnpm --filter @landflow/web rotate-key` on Postgres (opt-in: LANDFLOW_INTEGRATION=queue). Creates a throwaway database
 * (`landflow_rotate_<run>_test`) on the infra stack's Postgres (55432, or LANDFLOW_TEST_POSTGRES_ADMIN_URL), seeds a
 * credential and a settings row sealed under the old key, runs the script as the stopped host would (its own process,
 * the same database), and reads Postgres afterwards: both are sealed under the new primary and still open; a second run
 * finds nothing to do. Dropped at the end.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ADMIN_URL = process.env.LANDFLOW_TEST_POSTGRES_ADMIN_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/postgres';
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));
const DB_NAME = `landflow_rotate_${Date.now().toString(36)}_test`;
const OLD = `old:${'a1'.repeat(32)}`;
const NEW = `new:${'b2'.repeat(32)}`;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('rotate-key on Postgres', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-rotate-pg-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_ENCRYPTION_KEYS: OLD });
  delete process.env.LANDFLOW_ENCRYPTION_KEY;
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { CredentialTable, CredentialVault, parseSealedString } = await import('@/lib/server/credentials/vault');
  const ring = await import('@/lib/server/credentials/key-ring');
  const { registry } = await import('@/lib/server/plugins/registry');
  const { corePlugin } = await import('@/lib/server/nodes');
  registry.registerBuiltin(corePlugin);

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  let direct: InstanceType<typeof pg.Pool>;
  let credentialId = '';

  /** The script, as `pnpm --filter @landflow/web rotate-key` runs it, with the host's environment. */
  const rotate = () =>
    promisify(execFile)('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'scripts/rotate-encryption-key.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, LANDFLOW_DB: 'postgres', DATABASE_URL: url.toString(), LANDFLOW_CONFIG_STORE: 'database', LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-rotate-pg-script-')), LANDFLOW_ENCRYPTION_KEYS: `${NEW},${OLD}`, LANDFLOW_PROFILE: 'development' },
    });

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    direct = new pg.Pool({ connectionString: url.toString(), max: 1 });
    // What the host left behind before the new key was added: a credential and a settings value under `old`.
    const db = await openPostgres(url.toString(), mkdtempSync(join(tmpdir(), 'landflow-rotate-pg-host-')));
    const table = new CredentialTable(join(dataDir, 'credentials.json'), () => db);
    try {
      const vault = new CredentialVault({ dir: dataDir, backend: table });
      credentialId = vault.create({ name: 'Old key', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'header-secret' } }).id;
      const sealed = ring.sealWith(ring.buildKeyRing(OLD, undefined), 'saml-private-key', 'landflow:secret');
      db.upsert('settings', { key: 'rotate-test', value: JSON.stringify({ privateKey: `v2.${sealed.kid}.${sealed.iv}.${sealed.tag}.${sealed.value}` }) });
      await db.flush();
    } finally {
      table.close();
      await db.close();
    }
  });

  afterAll(async () => {
    await direct?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  });

  it('re-seals the credential and the settings row in Postgres under the new primary, then finds nothing to do', async () => {
    const before = (await direct.query<{ data: string }>('SELECT data FROM credentials WHERE id = $1', [credentialId])).rows[0];
    expect(JSON.parse(before.data)).toMatchObject({ v: 2, kid: 'old' });

    const first = await rotate();
    expect(first.stdout).toMatch(/Primary key new: re-sealed 2, already current 0, failed 0/);

    const credential = JSON.parse((await direct.query<{ data: string }>('SELECT data FROM credentials WHERE id = $1', [credentialId])).rows[0].data);
    expect(credential).toMatchObject({ v: 2, kid: 'new' });
    const setting = JSON.parse((await direct.query<{ value: string }>("SELECT value FROM settings WHERE key = 'rotate-test'")).rows[0].value) as { privateKey: string };
    expect(parseSealedString(setting.privateKey)).toMatchObject({ v: 2, kid: 'new' });

    // The values still open with the new ring (the old key no longer needed for them).
    const newRing = ring.buildKeyRing(NEW, undefined);
    expect(ring.openWith(newRing, parseSealedString(setting.privateKey)!, 'landflow:secret')).toBe('saml-private-key');

    const second = await rotate();
    expect(second.stdout).toMatch(/re-sealed 0, already current 2, failed 0/);
    expect((await direct.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'encryption.rotate'")).rows[0].n).toBe(2);
  });
});
