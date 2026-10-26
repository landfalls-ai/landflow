/**
 * Folders and variables per project (migration 1400; lib/server/folders.ts, lib/server/projects/folders.ts,
 * lib/server/projects/variables.ts):
 *
 * - migration 1400 on an existing database: each folder tree goes to the project most of its workflows are in, else
 *   the owner's personal project; nothing else changes; the same on Postgres with LANDFLOW_INTEGRATION=postgres;
 * - folders through the API: listed per project, created in a project (subfolders in their parent's), only by its
 *   editors, a workflow only filed into a folder of its own project, "Move to project" refiles or keeps the folder;
 * - project variables: CRUD by role (members read, editors write, outsiders get 404), `$vars.KEY` in a run reads the
 *   project's value first, then the instance's; per-environment values; `/api/variables?workflowId=` merges them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { Folder } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-folders-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { MIGRATIONS } = await import('@/lib/server/db/schema');
const { migrateSqlite } = await import('@/lib/server/db');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { variables } = await import('@/lib/server/variables');
const { projectVariables } = await import('@/lib/server/projects/variables');
const foldersRoute = await import('@/app/api/folders/route');
const folderRoute = await import('@/app/api/folders/[id]/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const moveRoute = await import('@/app/api/workflows/[id]/move/route');
const transferRoute = await import('@/app/api/workflows/[id]/transfer/route');
const projectVariablesRoute = await import('@/app/api/projects/[id]/variables/route');
const projectVariableRoute = await import('@/app/api/projects/[id]/variables/[key]/route');
const projectVariableEnvRoute = await import('@/app/api/projects/[id]/variables/[key]/environments/route');
const variablesRoute = await import('@/app/api/variables/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let alice: User; // the team's admin
let bob: User; // its editor, and an editor of Ops
let carol: User; // its viewer
let dave: User; // in no project
let team = '';
let ops = '';

beforeAll(async () => {
  alice = await createUser({ email: 'alice@folders.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@folders.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  carol = await createUser({ email: 'carol@folders.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
  dave = await createUser({ email: 'dave@folders.test', name: 'Dave', role: 'member', password: 'dave-password-1' });
  team = projects.createTeamProject({ name: 'Growth' }).id;
  projects.setMember(team, alice.id, 'admin');
  projects.setMember(team, bob.id, 'editor');
  projects.setMember(team, carol.id, 'viewer');
  ops = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(ops, bob.id, 'editor');
});

afterAll(() => {
  enableTestAuth();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_ENVIRONMENT']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://folders.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
async function call<T = Record<string, any>>(user: User | undefined, fn: () => Promise<Response>): Promise<{ status: number; body: T }> {
  enableTestAuth(user);
  try {
    const response = await fn();
    return { status: response.status, body: (await response.json()) as T };
  } finally {
    enableTestAuth();
  }
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
const varsWorkflow = (name: string, folderId?: string) => ({
  name,
  ...(folderId && { folderId }),
  nodes: [node('Start', 'core.manualTrigger'), node('Set', 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'region', type: 'string', value: '={{ $vars.REGION }}' }, { name: 'only', type: 'string', value: '={{ $vars.INSTANCE_ONLY }}' }] } }, 200)],
  connections: [{ id: 'e', type: 'main' as const, source: 'Start', target: 'Set', sourceIndex: 0, targetIndex: 0 }],
});
async function createWorkflow(user: User, projectId: string | undefined, folderId?: string) {
  const created = await call<{ workflow: Workflow; error?: string }>(user, () => workflowsRoute.POST(req('POST', `/api/workflows${projectId ? `?projectId=${projectId}` : ''}`, varsWorkflow('TMP vars', folderId))));
  return created;
}
const output = async (workflowId: string) => {
  const record = (await runWorkflow({ workflow: store.getWorkflow(workflowId)!, mode: 'manual' })) as unknown as { status: string; runData: Record<string, Array<{ outputs: Array<Array<{ json: Record<string, unknown> }>> }>> };
  expect(record.status).toBe('success');
  return record.runData.Set[0].outputs[0][0].json;
};

// ---- migration 1400 -----------------------------------------------------------------------------------------

const NOW = '2026-09-01T10:00:00.000Z';
const BEFORE = MIGRATIONS.filter((m) => m.version < 1400);
/** A database from before folders had projects: two trees with workflows of different projects, one tree without. */
function seed(): Array<[string, unknown[]]> {
  const user = (id: string, role: string): [string, unknown[]] => ['INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, `${id}@example.com`, id, role, 'scrypt$x', NOW, NOW]];
  const project = (id: string, type: string, owner: string | null): [string, unknown[]] => ['INSERT INTO projects (id, name, type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, id, type, owner, NOW, NOW]];
  const folder = (id: string, parent: string | null): [string, unknown[]] => ['INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, id, parent, NOW, NOW]];
  const workflow = (id: string, folderId: string | null, projectId: string): Array<[string, unknown[]]> => [
    ['INSERT INTO workflows (id, name, active, folder_id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, id, 0, folderId, NOW, NOW, JSON.stringify({ id, name: id, nodes: [], connections: [], ...(folderId && { folderId }) })]],
    ['INSERT INTO project_resources (kind, resource_id, project_id, created_at) VALUES (?, ?, ?, ?)', ['workflow', id, projectId, NOW]],
  ];
  return [
    user('usr_owner', 'owner'),
    user('usr_member', 'member'),
    project('personal_usr_owner', 'personal', 'usr_owner'),
    project('personal_usr_member', 'personal', 'usr_member'),
    project('prj_team', 'team', null),
    // Tree A: Clients > Acme, Clients > Globex; two of its three workflows are the team's.
    folder('fld_clients', null),
    folder('fld_acme', 'fld_clients'),
    folder('fld_globex', 'fld_clients'),
    ...workflow('wf_1', 'fld_acme', 'prj_team'),
    ...workflow('wf_2', 'fld_globex', 'prj_team'),
    ...workflow('wf_3', 'fld_clients', 'personal_usr_member'),
    // Tree B: Personal > Drafts, the member's workflows.
    folder('fld_personal', null),
    folder('fld_drafts', 'fld_personal'),
    ...workflow('wf_4', 'fld_drafts', 'personal_usr_member'),
    // Tree C: an empty folder, and an orphan whose parent is gone.
    folder('fld_empty', null),
    folder('fld_orphan', 'fld_deleted'),
    ...workflow('wf_5', null, 'prj_team'),
  ];
}
const EXPECTED = [
  { id: 'fld_acme', project_id: 'prj_team' },
  { id: 'fld_clients', project_id: 'prj_team' },
  { id: 'fld_drafts', project_id: 'personal_usr_member' },
  { id: 'fld_empty', project_id: 'personal_usr_owner' },
  { id: 'fld_globex', project_id: 'prj_team' },
  { id: 'fld_orphan', project_id: 'personal_usr_owner' },
  { id: 'fld_personal', project_id: 'personal_usr_member' },
];

describe('migration 1400 on SQLite', () => {
  it('puts each folder tree in the project of most of its workflows, else the owner’s personal project', () => {
    const sqlite = new DatabaseSync(':memory:');
    expect(migrateSqlite(sqlite, BEFORE).length).toBe(BEFORE.length);
    for (const [sql, values] of seed()) sqlite.prepare(sql).run(...(values as Array<string | number | null>));
    const workflowsBefore = sqlite.prepare('SELECT * FROM workflows ORDER BY id').all();
    expect(migrateSqlite(sqlite)).toEqual(expect.arrayContaining([1400, 1401]));
    expect(sqlite.prepare('SELECT id, project_id FROM folders ORDER BY id').all()).toEqual(EXPECTED);
    expect(sqlite.prepare('SELECT * FROM workflows ORDER BY id').all()).toEqual(workflowsBefore);
    // The new tables are there and empty; a second run does nothing.
    for (const table of ['project_variables', 'project_variable_environment_values', 'project_settings', 'workflow_policies']) expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    expect(migrateSqlite(sqlite)).toEqual([]);
    sqlite.close();
  });
});

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_project_folders_test';
const PG_URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const postgres = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

describe.skipIf(!postgres)('migration 1400 on Postgres', () => {
  it('applies to a database with folders and workflows, once', async () => {
    if (!/_test$/.test(new URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    const pg = (await import('pg')).default;
    const { migratePostgres } = await import('@/lib/server/db/postgres');
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.query(`CREATE SCHEMA ${SCHEMA}`);
      await pool.query('CREATE TABLE IF NOT EXISTS schema_version (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const migration of BEFORE) {
        for (const statement of migration.postgres ?? migration.statements) await pool.query(statement);
        await pool.query('INSERT INTO schema_version (version, name, applied_at) VALUES ($1, $2, $3)', [migration.version, migration.name, NOW]);
      }
      for (const [sql, values] of seed()) {
        let n = 0;
        await pool.query(sql.replace(/\?/g, () => `$${++n}`), values);
      }
      expect(await migratePostgres(pool)).toEqual(expect.arrayContaining([1400, 1401]));
      expect((await pool.query('SELECT id, project_id FROM folders ORDER BY id')).rows).toEqual(EXPECTED);
      expect(await migratePostgres(pool)).toEqual([]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await pool.end();
    }
  });
});

// ---- folders per project ------------------------------------------------------------------------------------

describe('folders per project', () => {
  let teamFolder: Folder;
  let opsFolder: Folder;

  it('creates folders in a project (subfolders in their parent’s), by its editors only', async () => {
    const created = await call<{ folder: Folder }>(bob, () => foldersRoute.POST(req('POST', `/api/folders?projectId=${team}`, { name: 'TMP Campaigns' })));
    expect(created.status).toBe(201);
    teamFolder = created.body.folder;
    expect(teamFolder.projectId).toBe(team);
    const sub = await call<{ folder: Folder }>(bob, () => foldersRoute.POST(req('POST', '/api/folders', { name: 'TMP Q4', parentId: teamFolder.id, projectId: ops })));
    expect(sub.status).toBe(201);
    expect(sub.body.folder.projectId).toBe(team);
    opsFolder = (await call<{ folder: Folder }>(bob, () => foldersRoute.POST(req('POST', '/api/folders', { name: 'TMP Runbooks', projectId: ops })))).body.folder;
    expect(opsFolder.projectId).toBe(ops);
    // A viewer and an outsider can't.
    expect((await call(carol, () => foldersRoute.POST(req('POST', `/api/folders?projectId=${team}`, { name: 'TMP nope' })))).status).toBe(403);
    expect((await call(carol, () => foldersRoute.POST(req('POST', '/api/folders', { name: 'TMP nope', parentId: teamFolder.id })))).status).toBe(403);
    expect([403, 404]).toContain((await call(dave, () => foldersRoute.POST(req('POST', `/api/folders?projectId=${team}`, { name: 'TMP nope' })))).status);
    // Without a project: the caller's personal project.
    const mine = await call<{ folder: Folder }>(dave, () => foldersRoute.POST(req('POST', '/api/folders', { name: 'TMP Mine' })));
    expect(mine.body.folder.projectId).toBe(`personal_${dave.id}`);
  });

  it('lists folders per project, and only those of projects the caller sees', async () => {
    const inTeam = await call<{ folders: Folder[] }>(carol, () => foldersRoute.GET(req('GET', `/api/folders?projectId=${team}`)));
    expect(inTeam.body.folders.map((f) => f.name).sort()).toEqual(['TMP Campaigns', 'TMP Q4']);
    expect((await call(dave, () => foldersRoute.GET(req('GET', `/api/folders?projectId=${team}`)))).status).toBe(404);
    const all = await call<{ folders: Folder[] }>(bob, () => foldersRoute.GET(req('GET', '/api/folders')));
    expect(all.body.folders.map((f) => f.name)).toEqual(expect.arrayContaining(['TMP Campaigns', 'TMP Q4', 'TMP Runbooks']));
    expect(all.body.folders.map((f) => f.name)).not.toContain('TMP Mine');
    // Renaming: editors of its project; a parent from another project is refused.
    expect((await call(carol, () => folderRoute.PATCH(req('PATCH', `/api/folders/${teamFolder.id}`, { name: 'TMP x' }), params({ id: teamFolder.id })))).status).toBe(403);
    const reparent = await call<{ error: string }>(bob, () => folderRoute.PATCH(req('PATCH', `/api/folders/${teamFolder.id}`, { parentId: opsFolder.id }), params({ id: teamFolder.id })));
    expect(reparent.status).toBe(400);
  });

  it('files a workflow only into a folder of its own project, and refiles it on “Move to project”', async () => {
    // Created in the team's folder: it lands in the team project.
    const created = await createWorkflow(bob, undefined, teamFolder.id);
    expect(created.status).toBe(201);
    const workflow = created.body.workflow;
    expect(projects.homeProjectId('workflow', workflow.id)).toBe(team);
    expect(workflow.folderId).toBe(teamFolder.id);
    // Asking for another project and the team's folder is refused.
    expect((await createWorkflow(bob, ops, teamFolder.id)).status).toBe(403);

    const cross = await call<{ error: string }>(bob, () => moveRoute.POST(req('POST', `/api/workflows/${workflow.id}/move`, { folderId: opsFolder.id }), params({ id: workflow.id })));
    expect(cross.status).toBe(400);
    expect(cross.body.error).toMatch(/Ops/);
    expect((await call(bob, () => moveRoute.POST(req('POST', `/api/workflows/${workflow.id}/move`, { folderId: null }), params({ id: workflow.id })))).status).toBe(200);
    expect((await call(bob, () => moveRoute.POST(req('POST', `/api/workflows/${workflow.id}/move`, { folderId: teamFolder.id }), params({ id: workflow.id })))).status).toBe(200);

    // Moving it to Ops: into the Ops folder asked for (Alice, the team's admin, is no editor of Ops: an owner moves it).
    enableTestAuth();
    const moved = await call<{ error?: string }>(undefined, () => transferRoute.POST(req('POST', `/api/workflows/${workflow.id}/transfer`, { projectId: ops, folderId: opsFolder.id }), params({ id: workflow.id })));
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(projects.homeProjectId('workflow', workflow.id)).toBe(ops);
    expect(store.getWorkflow(workflow.id)?.folderId).toBe(opsFolder.id);
    // And back without a folder: to the team's top level (its Ops folder doesn't come along).
    expect((await call(undefined, () => transferRoute.POST(req('POST', `/api/workflows/${workflow.id}/transfer`, { projectId: team }), params({ id: workflow.id })))).status).toBe(200);
    expect(store.getWorkflow(workflow.id)?.folderId).toBeUndefined();
    // A folder of another project is refused.
    expect((await call(undefined, () => transferRoute.POST(req('POST', `/api/workflows/${workflow.id}/transfer`, { projectId: ops, folderId: teamFolder.id }), params({ id: workflow.id })))).status).toBe(400);
  });

  it('deletes an empty folder (its editors only)', async () => {
    const sub = (await call<{ folders: Folder[] }>(bob, () => foldersRoute.GET(req('GET', `/api/folders?projectId=${team}`)))).body.folders.find((f) => f.name === 'TMP Q4')!;
    expect((await call(carol, () => folderRoute.DELETE(req('DELETE', `/api/folders/${sub.id}`), params({ id: sub.id })))).status).toBe(403);
    expect((await call(bob, () => folderRoute.DELETE(req('DELETE', `/api/folders/${sub.id}`), params({ id: sub.id })))).status).toBe(200);
  });
});

// ---- project variables --------------------------------------------------------------------------------------

describe('project variables', () => {
  const base = () => `/api/projects/${team}/variables`;

  it('are read by the project’s members and changed by its editors', async () => {
    const created = await call(bob, () => projectVariablesRoute.POST(req('POST', base(), { key: 'REGION', value: 'us-east' }), params({ id: team })));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'REGION', value: 'us-east' });
    expect((await call(bob, () => projectVariablesRoute.POST(req('POST', base(), { key: 'REGION', value: 'x' }), params({ id: team })))).status).toBe(409);
    expect((await call(bob, () => projectVariablesRoute.POST(req('POST', base(), { key: '1bad', value: 'x' }), params({ id: team })))).status).toBe(400);
    expect((await call(carol, () => projectVariablesRoute.POST(req('POST', base(), { key: 'NOPE', value: 'x' }), params({ id: team })))).status).toBe(403);
    expect((await call(dave, () => projectVariablesRoute.GET(req('GET', base()), params({ id: team })))).status).toBe(404);

    const listed = await call<{ variables: Array<{ key: string; value: string }>; canEdit: boolean }>(carol, () => projectVariablesRoute.GET(req('GET', base()), params({ id: team })));
    expect(listed.body).toMatchObject({ variables: [{ key: 'REGION', value: 'us-east' }], canEdit: false });
    expect((await call<{ canEdit: boolean }>(bob, () => projectVariablesRoute.GET(req('GET', base()), params({ id: team })))).body.canEdit).toBe(true);

    // Rename and change, then back.
    const renamed = await call(bob, () => projectVariableRoute.PATCH(req('PATCH', `${base()}/REGION`, { key: 'ZONE', value: 'us-west' }), params({ id: team, key: 'REGION' })));
    expect(renamed.body).toMatchObject({ key: 'ZONE', value: 'us-west' });
    expect((await call(carol, () => projectVariableRoute.PATCH(req('PATCH', `${base()}/ZONE`, { value: 'x' }), params({ id: team, key: 'ZONE' })))).status).toBe(403);
    await call(bob, () => projectVariableRoute.PATCH(req('PATCH', `${base()}/ZONE`, { key: 'REGION', value: 'us-east' }), params({ id: team, key: 'ZONE' })));
    expect((await call(carol, () => projectVariableRoute.GET(req('GET', `${base()}/REGION`), params({ id: team, key: 'REGION' })))).body).toMatchObject({ key: 'REGION', value: 'us-east' });

    const temp = await call(bob, () => projectVariablesRoute.POST(req('POST', base(), { key: 'TMP_GONE', value: '1' }), params({ id: team })));
    expect(temp.status).toBe(201);
    expect((await call(carol, () => projectVariableRoute.DELETE(req('DELETE', `${base()}/TMP_GONE`), params({ id: team, key: 'TMP_GONE' })))).status).toBe(403);
    expect((await call(bob, () => projectVariableRoute.DELETE(req('DELETE', `${base()}/TMP_GONE`), params({ id: team, key: 'TMP_GONE' })))).status).toBe(200);
    expect(projectVariables.get(team, 'TMP_GONE')).toBeUndefined();
  });

  it('come before the instance’s in $vars, for that project’s workflows only', async () => {
    variables.create({ key: 'REGION', value: 'eu-central' });
    variables.create({ key: 'INSTANCE_ONLY', value: 'shared' });
    const inTeam = (await createWorkflow(bob, team)).body.workflow;
    const inOps = (await createWorkflow(bob, ops)).body.workflow;
    expect(await output(inTeam.id)).toEqual({ region: 'us-east', only: 'shared' });
    expect(await output(inOps.id)).toEqual({ region: 'eu-central', only: 'shared' });
    expect(variables.forWorkflow(inTeam.id)).toMatchObject({ REGION: 'us-east', INSTANCE_ONLY: 'shared' });

    // The variables list for a workflow: the project's (marked) over the instance's.
    const merged = await call<Array<{ key: string; value: string; projectId?: string }>>(carol, () => variablesRoute.GET(req('GET', `/api/variables?workflowId=${inTeam.id}`)));
    expect(merged.body).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'REGION', value: 'us-east', projectId: team }), expect.objectContaining({ key: 'INSTANCE_ONLY', value: 'shared' })]));
    expect(merged.body.find((v) => v.key === 'INSTANCE_ONLY')?.projectId).toBeUndefined();
    expect((await call(dave, () => variablesRoute.GET(req('GET', `/api/variables?workflowId=${inTeam.id}`)))).status).toBe(404);

    // Moving the workflow to Ops: it reads the instance's value now.
    expect((await call(undefined, () => transferRoute.POST(req('POST', `/api/workflows/${inTeam.id}/transfer`, { projectId: ops }), params({ id: inTeam.id })))).status).toBe(200);
    expect(await output(inTeam.id)).toMatchObject({ region: 'eu-central' });
  });

  it('have values per environment: the one of this instance’s environment wins', async () => {
    const path = `${base()}/REGION/environments`;
    expect((await call(carol, () => projectVariableEnvRoute.PUT(req('PUT', path, { values: { staging: 'us-staging' } }), params({ id: team, key: 'REGION' })))).status).toBe(403);
    const saved = await call(bob, () => projectVariableEnvRoute.PUT(req('PUT', path, { values: { staging: 'us-staging', production: 'us-prod' } }), params({ id: team, key: 'REGION' })));
    expect(saved.status).toBe(200);
    expect(saved.body.values).toEqual({ production: 'us-prod', staging: 'us-staging' });
    expect((await call(bob, () => projectVariableEnvRoute.PUT(req('PUT', path, { values: { 'not an env': 'x' } }), params({ id: team, key: 'REGION' })))).status).toBe(400);
    expect((await call(carol, () => projectVariableEnvRoute.GET(req('GET', path), params({ id: team, key: 'REGION' })))).body.values).toEqual({ production: 'us-prod', staging: 'us-staging' });
    expect((await call<{ environments: Record<string, Record<string, string>> }>(carol, () => projectVariablesRoute.GET(req('GET', base()), params({ id: team })))).body.environments).toEqual({ REGION: { production: 'us-prod', staging: 'us-staging' } });

    const workflow = (await createWorkflow(bob, team)).body.workflow;
    expect(await output(workflow.id)).toMatchObject({ region: 'us-east' });
    process.env.LANDFLOW_ENVIRONMENT = 'staging';
    try {
      expect(await output(workflow.id)).toMatchObject({ region: 'us-staging' });
    } finally {
      delete process.env.LANDFLOW_ENVIRONMENT;
    }
    // Removing one leaves the other.
    expect((await call(bob, () => projectVariableEnvRoute.PUT(req('PUT', path, { values: { staging: null } }), params({ id: team, key: 'REGION' })))).body.values).toEqual({ production: 'us-prod' });
  });
});
