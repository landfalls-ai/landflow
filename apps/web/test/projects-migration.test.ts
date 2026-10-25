/**
 * Migrations 800 (projects) and 801 (SAML/SCIM columns) on existing data: a database at schema version 600 with an
 * owner, an admin, a member, workflows and data tables (what a live instance has) opens with every migration applied;
 * each user gets a personal project, every workflow and data table lands in the owner's personal project, nothing
 * that existed changes, and running it again does nothing. Credentials and agents (files) are adopted at boot.
 * The same on Postgres with LANDFLOW_INTEGRATION=postgres (schema `landflow_projects_test` of the `_test` database).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-projects-migration-'));
const previous = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { MIGRATIONS, LATEST_VERSION } = await import('@/lib/server/db/schema');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

afterAll(() => {
  if (previous === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous;
});

const BEFORE = MIGRATIONS.filter((m) => m.version <= 600);
const NOW = '2026-05-01T10:00:00.000Z';
const USERS = [
  { id: 'usr_owner', email: 'owner@example.com', name: 'Olive Owner', role: 'owner' },
  { id: 'usr_admin', email: 'admin@example.com', name: 'Ada Admin', role: 'admin' },
  { id: 'usr_member', email: 'member@example.com', name: 'Max Member', role: 'member' },
];
const WORKFLOWS = ['wf_a', 'wf_b', 'wf_c'];
const TABLES = ['dt_one', 'dt_two'];

/** Seed statements, the same on SQLite and Postgres. */
function seed(): Array<[string, unknown[]]> {
  return [
    ...USERS.map((u): [string, unknown[]] => [
      'INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [u.id, u.email, u.name, u.role, 'scrypt$x', NOW, NOW],
    ]),
    ...WORKFLOWS.map((id, i): [string, unknown[]] => [
      'INSERT INTO workflows (id, name, active, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)',
      [id, `Workflow ${i}`, i === 0 ? 1 : 0, i === 2 ? null : NOW, NOW, JSON.stringify({ id, name: `Workflow ${i}`, nodes: [], connections: [] })],
    ]),
    ...TABLES.map((id): [string, unknown[]] => ['INSERT INTO data_tables (id, name, next_row_id, data) VALUES (?, ?, ?, ?)', [id, id, 1, JSON.stringify({ id, name: id, columns: [] })]]),
    ['INSERT INTO sessions (id, user_id, created_at, expires_at, method) VALUES (?, ?, ?, ?, ?)', ['sess_1', 'usr_member', NOW, '2099-01-01T00:00:00.000Z', 'password']],
  ];
}

describe('migration 800 on SQLite', () => {
  it('parses: every migration applies to an empty database (a fresh install, no users yet)', async () => {
    const { migrateSqlite } = await import('@/lib/server/db');
    const sqlite = new DatabaseSync(':memory:');
    expect(migrateSqlite(sqlite)).toEqual(expect.arrayContaining([800, 801]));
    expect(Number((sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n)).toBe(0);
    sqlite.close();
  });

  it('moves the live data of a version-600 database into projects when the host opens it', async () => {
    // The data directory of an instance from before projects: schema 600 and data.
    const file = new DatabaseSync(join(dataDir, 'landflow.db'));
    file.exec('CREATE TABLE IF NOT EXISTS schema_version (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of BEFORE) {
      for (const statement of migration.statements) file.exec(statement);
      file.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, NOW);
    }
    for (const [sql, params] of seed()) file.prepare(sql).run(...(params as Array<string | number | null>));
    const workflowsBefore = file.prepare('SELECT * FROM workflows ORDER BY id').all();
    file.close();

    const { database } = await import('@/lib/server/db');
    const db = database();
    expect(db.schemaVersion()).toBe(LATEST_VERSION);
    const versions = db.all<{ version: number }>('SELECT version FROM schema_version ORDER BY version').map((r) => Number(r.version));
    expect(versions).toEqual(expect.arrayContaining([600, 800, 801]));

    // Personal projects for each user, each its owner's admin.
    expect(db.all('SELECT id, name, type, owner_id FROM projects ORDER BY id')).toEqual([
      { id: 'personal_usr_admin', name: 'Ada Admin', type: 'personal', owner_id: 'usr_admin' },
      { id: 'personal_usr_member', name: 'Max Member', type: 'personal', owner_id: 'usr_member' },
      { id: 'personal_usr_owner', name: 'Olive Owner', type: 'personal', owner_id: 'usr_owner' },
    ]);
    expect(db.all('SELECT project_id, user_id, role, source FROM project_members ORDER BY user_id')).toEqual([
      { project_id: 'personal_usr_admin', user_id: 'usr_admin', role: 'admin', source: 'personal' },
      { project_id: 'personal_usr_member', user_id: 'usr_member', role: 'admin', source: 'personal' },
      { project_id: 'personal_usr_owner', user_id: 'usr_owner', role: 'admin', source: 'personal' },
    ]);
    // Workflows and data tables in the owner's personal project.
    expect(db.all('SELECT kind, resource_id, project_id FROM project_resources ORDER BY kind, resource_id')).toEqual([
      { kind: 'dataTable', resource_id: 'dt_one', project_id: 'personal_usr_owner' },
      { kind: 'dataTable', resource_id: 'dt_two', project_id: 'personal_usr_owner' },
      ...WORKFLOWS.map((id) => ({ kind: 'workflow', resource_id: id, project_id: 'personal_usr_owner' })),
    ]);
    // A workflow without created_at gets the owner's.
    expect(db.get<{ created_at: string }>(`SELECT created_at FROM project_resources WHERE resource_id = 'wf_c'`)?.created_at).toBe(NOW);
    // Nothing that existed changed; the new user columns are empty; sessions survive.
    expect(db.all('SELECT * FROM workflows ORDER BY id')).toEqual(workflowsBefore);
    expect(db.all('SELECT id, role, disabled_at, saml_subject, external_id FROM users ORDER BY id')).toEqual(USERS.map((u) => ({ id: u.id, role: u.role, disabled_at: null, saml_subject: null, external_id: null })).sort((a, b) => a.id.localeCompare(b.id)));
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n).toBe(1);

    // Credentials and agents live in files: adopted at boot, into the owner's personal project, once.
    const { adoptUnassigned, resourceAccess, homeProjectId } = await import('@/lib/server/projects');
    expect(adoptUnassigned({ credential: ['cred_x'], agent: ['agt_y'], workflow: WORKFLOWS })).toBe(2);
    expect(adoptUnassigned({ credential: ['cred_x'], agent: ['agt_y'] })).toBe(0);
    expect(homeProjectId('credential', 'cred_x')).toBe('personal_usr_owner');
    // Single-user behaviour: the owner (and admins) see everything; the member sees none of it until shared.
    const owner = { id: 'usr_owner', role: 'owner' as const };
    const member = { id: 'usr_member', role: 'member' as const };
    expect(resourceAccess(owner, 'workflow', 'wf_a')).toEqual({ role: 'admin', home: true });
    expect(resourceAccess({ id: 'usr_admin', role: 'admin' }, 'credential', 'cred_x')).toEqual({ role: 'admin', home: true });
    expect(resourceAccess(member, 'workflow', 'wf_a')).toBeUndefined();
    // Something nobody recorded yet (an older file) still belongs to the owner.
    expect(homeProjectId('agent', 'agt_unrecorded')).toBe('personal_usr_owner');
  });

  it('is a no-op the second time', async () => {
    const { migrateSqlite, database } = await import('@/lib/server/db');
    const db = database();
    const before = db.all('SELECT * FROM project_resources ORDER BY kind, resource_id');
    expect(migrateSqlite(db.sqlite)).toEqual([]);
    // Re-running the 800 inserts by hand changes nothing either (insert-if-absent).
    const migration = MIGRATIONS.find((m) => m.version === 800)!;
    for (const statement of migration.statements.filter((s) => s.trim().startsWith('INSERT'))) db.sqlite.exec(statement);
    expect(db.all('SELECT * FROM project_resources ORDER BY kind, resource_id')).toEqual(before);
  });
});

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_projects_test';
const PG_URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const postgres = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

describe.skipIf(!postgres)('migration 800 on Postgres', () => {
  it('applies to a version-600 database with data, once', async () => {
    if (!/_test$/.test(new URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    const pg = (await import('pg')).default;
    const { migratePostgres } = await import('@/lib/server/db/postgres');
    const admin = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.query('CREATE TABLE IF NOT EXISTS schema_version (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const migration of BEFORE) {
        for (const statement of migration.postgres ?? migration.statements) await admin.query(statement);
        await admin.query('INSERT INTO schema_version (version, name, applied_at) VALUES ($1, $2, $3)', [migration.version, migration.name, NOW]);
      }
      for (const [sql, params] of seed()) {
        let n = 0;
        await admin.query(sql.replace(/\?/g, () => `$${++n}`), params);
      }
      const applied = await migratePostgres(admin);
      expect(applied).toEqual(expect.arrayContaining([800, 801]));
      expect((await admin.query('SELECT id FROM projects ORDER BY id')).rows.map((r: { id: string }) => r.id)).toEqual(['personal_usr_admin', 'personal_usr_member', 'personal_usr_owner']);
      expect((await admin.query('SELECT kind, resource_id, project_id FROM project_resources ORDER BY kind, resource_id')).rows).toEqual([
        { kind: 'dataTable', resource_id: 'dt_one', project_id: 'personal_usr_owner' },
        { kind: 'dataTable', resource_id: 'dt_two', project_id: 'personal_usr_owner' },
        ...WORKFLOWS.map((id) => ({ kind: 'workflow', resource_id: id, project_id: 'personal_usr_owner' })),
      ]);
      expect((await admin.query('SELECT disabled_at FROM users')).rows.every((r: { disabled_at: string | null }) => r.disabled_at === null)).toBe(true);
      expect(await migratePostgres(admin)).toEqual([]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await admin.end();
    }
  });
});
