/**
 * C32 on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres): migration 2931 applies (the `custom_roles` table and
 * `users.custom_role_id`), and the user read's join (`USER_SELECT`, lib/server/auth/users.ts) returns a member with their
 * role's name and rules and a member without one with none, with a role edited in one process seen by the other's next
 * read. Uses LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of its own
 * (`landflow_roles_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_roles_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('custom roles on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { USER_SELECT } = await import('@/lib/server/auth/users');
  const { parseStoredRules } = await import('@/lib/shared/roles');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgroles-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  const now = () => new Date().toISOString();
  const user = (id: string, roleId: string | null) => ({ id, email: `${id}@example.test`, name: id, role: 'member', password_hash: null, oidc_issuer: null, oidc_subject: null, saml_issuer: null, saml_subject: null, external_id: null, provisioned_by: null, disabled_at: null, custom_role_id: roleId, created_at: now(), updated_at: now(), last_login_at: null });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'roles-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'roles-worker' });
    opened.push(main, worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('applies migration 2931: the table and the column exist', async () => {
    const table = await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'custom_roles'`, [SCHEMA]);
    expect(table.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual(['created_at', 'created_by', 'description', 'id', 'name', 'name_key', 'rules', 'updated_at']);
    const column = await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'custom_role_id'`, [SCHEMA]);
    expect(column.rows).toHaveLength(1);
  });

  it('the join returns a member with and without a role, and an edit in one process shows in the other’s next read', async () => {
    main.insertNew('custom_roles', { id: 'role_a', name: 'Platform', name_key: 'platform', description: null, rules: JSON.stringify([{ action: 'plugins:manage', effect: 'allow' }]), created_by: null, created_at: now(), updated_at: now() });
    main.insertNew('users', user('with', 'role_a'));
    main.insertNew('users', user('without', null));
    const read = (db: Database, id: string) => db.get<{ custom_role_name: string | null; custom_role_rules: string | null }>(`${USER_SELECT} WHERE u.id = ?`, id);
    await vi.waitFor(() => expect(read(worker, 'with')?.custom_role_name).toBe('Platform'), { timeout: 15_000, interval: 50 });
    expect(read(worker, 'without')).toMatchObject({ custom_role_name: null, custom_role_rules: null });
    expect(parseStoredRules(read(worker, 'with')!.custom_role_rules).map((r) => r.action)).toEqual(['plugins:manage']);
    worker.upsert('custom_roles', { id: 'role_a', name: 'Platform', name_key: 'platform', description: null, rules: JSON.stringify([{ action: 'mcp:manage', effect: 'allow' }]), created_by: null, created_at: now(), updated_at: now() });
    await vi.waitFor(() => expect(parseStoredRules(read(main, 'with')!.custom_role_rules).map((r) => r.action)).toEqual(['mcp:manage']), { timeout: 15_000, interval: 50 });
  });
});
