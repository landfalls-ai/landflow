/**
 * Data tables, evaluation datasets, agents and Git sync folders per project:
 *
 * - table names are unique within a project, not across the instance (create, rename, upload by name, transfers);
 * - a table can't move where another has its name; a removed user's or deleted project's tables take a free name;
 * - the Evaluation Trigger's dataset picker and an agent's tool pickers list only their project's tables, and an
 *   evaluation reads the workflow's project's table (by name when several projects have one of that name);
 * - Git sync pulls folders into the project of the workflows filed in them, keeps a workflow out of another
 *   project's folder, and creates the tables it makes in the default project.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-table-names-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { folders } = await import('@/lib/server/folders');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { dataTables } = await import('@/lib/server/datatables/service');
const { loadDataset } = await import('@/lib/server/evaluations/dataset');
const sync = await import('@/lib/server/sync');
const workflowsRoute = await import('@/app/api/workflows/route');
const dataTablesRoute = await import('@/app/api/data-tables/route');
const dataTableRoute = await import('@/app/api/data-tables/[id]/route');
const transferRoute = await import('@/app/api/data-tables/[id]/transfer/route');
const loadOptionsRoute = await import('@/app/api/node-types/load-options/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let bob: User; // an admin of Sales and Ops
let owner: User; // the instance owner: the default project is theirs
let team = '';
let ops = '';

beforeAll(async () => {
  owner = await createUser({ email: 'owner@names.test', name: 'Olive', role: 'owner', password: 'owner-password-1' });
  bob = await createUser({ email: 'bob@names.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  void owner;
  team = projects.createTeamProject({ name: 'Sales' }).id;
  ops = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(team, bob.id, 'admin');
  projects.setMember(ops, bob.id, 'admin');
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://names.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
async function call<T = Record<string, any>>(user: User | undefined, fn: () => Promise<Response>): Promise<{ status: number; body: T }> {
  enableTestAuth(user);
  try {
    const response = await fn();
    return { status: response.status, body: (await response.json()) as T };
  } finally {
    enableTestAuth();
  }
}
const createTable = (project: string, name: string) =>
  call<{ table: { id: string; name: string }; error?: string }>(bob, () => dataTablesRoute.POST(req('POST', `/api/data-tables?projectId=${project}`, { name, columns: [{ name: 'q', type: 'string' }] })));

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
async function createWorkflow(project: string, name: string, extra: WorkflowNode[] = []) {
  const created = await call<{ workflow: Workflow }>(bob, () => workflowsRoute.POST(req('POST', `/api/workflows?projectId=${project}`, { name, nodes: [node('Start', 'core.manualTrigger'), ...extra], connections: [] })));
  expect(created.status).toBe(201);
  return created.body.workflow;
}
const options = async (type: string, method: string, scope: Record<string, string>, parameters: Record<string, unknown> = {}) =>
  (await call<{ options: Array<{ name: string; value: string }> }>(bob, () => loadOptionsRoute.POST(req('POST', '/api/node-types/load-options', { type, method, parameters, ...scope })))).body.options;

describe('table names per project', () => {
  it('lets two projects have a table of the same name, and refuses a second one in a project', async () => {
    const sales = await createTable(team, 'Customers');
    const opsOne = await createTable(ops, 'Customers');
    expect(sales.status).toBe(201);
    expect(opsOne.status).toBe(201);
    expect(opsOne.body.table.id).not.toBe(sales.body.table.id);
    const again = await createTable(team, 'customers');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('A data table named “customers” already exists in this project');

    // Renames follow the same rule, in the table's own project.
    const other = await createTable(team, 'Orders');
    const clash = await call<{ error?: string }>(bob, () => dataTableRoute.PATCH(req('PATCH', `/api/data-tables/${other.body.table.id}`, { name: 'CUSTOMERS' }), params({ id: other.body.table.id })));
    expect(clash.status).toBe(409);
    const free = await call(bob, () => dataTableRoute.PATCH(req('PATCH', `/api/data-tables/${opsOne.body.table.id}`, { name: 'Orders' }), params({ id: opsOne.body.table.id })));
    expect(free.status).toBe(200);
    // …and back: Ops has no “Customers” any more, so renaming it again is free, and Sales still has its own.
    expect((await call(bob, () => dataTableRoute.PATCH(req('PATCH', `/api/data-tables/${opsOne.body.table.id}`, { name: 'Customers' }), params({ id: opsOne.body.table.id })))).status).toBe(200);
  });

  it('finds a table by name in the asking project first', () => {
    const service = dataTables();
    const inTeam = service.findTable('Customers', team)!;
    const inOps = service.findTable('Customers', ops)!;
    expect(inTeam.id).not.toBe(inOps.id);
    expect(projects.homeProjectId('dataTable', inTeam.id)).toBe(team);
    expect(projects.homeProjectId('dataTable', inOps.id)).toBe(ops);
    // No project given, or one without such a table: any table of that name.
    expect(service.findTable('Customers')).toBeDefined();
    expect(service.findTable('Orders', ops)?.id).toBe(service.findTable('Orders', team)?.id); // Ops has none: Sales's is found (the node then refuses it)
  });

  it('refuses to move a table where another has its name; a free name moves', async () => {
    const stray = await createTable(team, 'Stray');
    const clashing = await createTable(team, 'Ledger');
    await createTable(ops, 'Ledger');
    const refused = await call<{ error?: string }>(bob, () => transferRoute.POST(req('POST', `/api/data-tables/${clashing.body.table.id}/transfer`, { projectId: ops }), params({ id: clashing.body.table.id })));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('That project already has a data table named “Ledger”: rename one of them first');
    expect(projects.homeProjectId('dataTable', clashing.body.table.id)).toBe(team);
    const moved = await call(bob, () => transferRoute.POST(req('POST', `/api/data-tables/${stray.body.table.id}/transfer`, { projectId: ops }), params({ id: stray.body.table.id })));
    expect(moved.status).toBe(200);
    expect(projects.homeProjectId('dataTable', stray.body.table.id)).toBe(ops);
  });

  it('gives a table the next free name when a deleted project’s tables are moved into a project that has its name', async () => {
    const doomed = projects.createTeamProject({ name: 'Doomed' }).id;
    projects.setMember(doomed, bob.id, 'admin');
    const inDoomed = await createTable(doomed, 'Archive');
    const keeper = await createTable(ops, 'Archive');
    projects.deleteProjectWithTransfer(doomed, ops);
    expect(projects.homeProjectId('dataTable', inDoomed.body.table.id)).toBe(ops);
    expect(dataTables().getTable(inDoomed.body.table.id).name).toBe('Archive 2');
    expect(dataTables().getTable(keeper.body.table.id).name).toBe('Archive');
  });
});

describe('evaluation datasets and agent tools per project', () => {
  const trigger = (table: string) => node('Trigger', 'core.evaluationTrigger', { source: 'dataTable', dataTableId: table });

  it('the Evaluation Trigger’s picker lists the edited workflow’s project’s tables, and its columns', async () => {
    const inTeam = await createWorkflow(team, 'TN eval team', [trigger('')]);
    const inOps = await createWorkflow(ops, 'TN eval ops', [trigger('')]);
    const teamIds = dataTables().inProject(dataTables().listTables(), team).map((t) => t.id);
    const opsIds = dataTables().inProject(dataTables().listTables(), ops).map((t) => t.id);
    expect((await options('core.evaluationTrigger', 'tables', { workflowId: inTeam.id })).map((o) => o.value).sort()).toEqual([...teamIds].sort());
    expect((await options('core.evaluationTrigger', 'tables', { workflowId: inOps.id })).map((o) => o.value).sort()).toEqual([...opsIds].sort());
    // Another project's table has no columns here.
    const opsTable = opsIds[0];
    expect(await options('core.evaluationTrigger', 'columns', { workflowId: inTeam.id }, { dataTableId: opsTable })).toEqual([{ name: '(automatic)', value: '', description: expect.any(String) }]);
    expect((await options('core.evaluationTrigger', 'columns', { workflowId: inOps.id }, { dataTableId: opsTable })).map((o) => o.value)).toContain('q');
  });

  it('reads the workflow’s project’s table, by name among several, and refuses another project’s', async () => {
    const inTeam = await createWorkflow(team, 'TN eval read team', [trigger('Customers')]);
    const inOps = await createWorkflow(ops, 'TN eval read ops', [trigger('Customers')]);
    const teamCustomers = dataTables().findTable('Customers', team)!;
    const opsCustomers = dataTables().findTable('Customers', ops)!;
    dataTables().insertRows(teamCustomers.id, [{ q: 'from sales' }]);
    dataTables().insertRows(opsCustomers.id, [{ q: 'from ops one' }, { q: 'from ops two' }]);
    expect(loadDataset({ dataTableId: 'Customers' }, { workflowId: inTeam.id })).toMatchObject({ id: teamCustomers.id, total: 1 });
    expect(loadDataset({ dataTableId: 'Customers' }, { workflowId: inOps.id })).toMatchObject({ id: opsCustomers.id, total: 2 });
    expect(() => loadDataset({ dataTableId: opsCustomers.id }, { workflowId: inTeam.id })).toThrow(/belongs to the “Ops” project/);
  });

  it('an agent’s tools list its project’s tables', async () => {
    projects.setHomeProject('agent', 'agt_names_team', team);
    projects.setHomeProject('agent', 'agt_names_ops', ops);
    const teamIds = dataTables().inProject(dataTables().listTables(), team).map((t) => t.id).sort();
    const opsIds = dataTables().inProject(dataTables().listTables(), ops).map((t) => t.id).sort();
    expect((await options('core.dataTable', 'tables', { agentId: 'agt_names_team' })).map((o) => o.value).sort()).toEqual(teamIds);
    expect((await options('core.dataTable', 'tables', { agentId: 'agt_names_ops' })).map((o) => o.value).sort()).toEqual(opsIds);
  });
});

describe('Git sync folders and tables per project', () => {
  const files = (extra: Array<{ path: string; content: string }>) => [{ path: 'landflow-sync.json', content: '{ "format": "landflow-sync/v1" }\n' }, ...extra];
  const workflowFile = (dir: string, id: string, name: string) => ({
    path: `workflows/${dir}/${name.toLowerCase().replace(/\W+/g, '-')}.workflow.json`,
    content: JSON.stringify({ id, name, active: false, nodes: [node('Start', 'core.manualTrigger')], connections: [] }),
  });
  const folderFile = (dir: string, id: string, name: string) => ({ path: `workflows/${dir}/.folder.json`, content: JSON.stringify({ id, name }) });

  it('creates a new folder in the project of the workflows filed in it, and its subfolders there too', async () => {
    const mine = await createWorkflow(ops, 'TN sync mine');
    const plan = sync.planSync(
      files([
        folderFile('ops-stuff', 'fd_syncops', 'Ops stuff'),
        folderFile('ops-stuff/deeper', 'fd_syncdeep', 'Deeper'),
        workflowFile('ops-stuff/deeper', mine.id, 'TN sync mine'),
        folderFile('fresh', 'fd_syncfresh', 'Fresh'),
        workflowFile('fresh', 'wf_syncnew', 'TN sync new'),
      ]),
    );
    expect(plan.errors).toEqual([]);
    await sync.applySync(
      files([
        folderFile('ops-stuff', 'fd_syncops', 'Ops stuff'),
        folderFile('ops-stuff/deeper', 'fd_syncdeep', 'Deeper'),
        workflowFile('ops-stuff/deeper', mine.id, 'TN sync mine'),
        folderFile('fresh', 'fd_syncfresh', 'Fresh'),
        workflowFile('fresh', 'wf_syncnew', 'TN sync new'),
      ]),
    );
    expect(folders.get('fd_syncops')?.projectId).toBe(ops);
    expect(folders.projectOf('fd_syncdeep')).toBe(ops);
    expect(store.getWorkflow(mine.id)?.folderId).toBe('fd_syncdeep');
    // A folder holding only new workflows goes to the default project, and so do they.
    expect(folders.projectOf('fd_syncfresh')).toBe(projects.defaultProjectId());
    expect(projects.homeProjectId('workflow', 'wf_syncnew')).toBe(projects.defaultProjectId());
  });

  it('keeps a workflow out of another project’s folder, with a warning', async () => {
    const teamFlow = await createWorkflow(team, 'TN sync team flow');
    const result = sync.planSync(files([folderFile('ops-stuff', 'fd_syncops', 'Ops stuff'), workflowFile('ops-stuff', teamFlow.id, 'TN sync team flow')]));
    expect(result.warnings.join('\n')).toContain('stays at the top level: the folder “workflows/ops-stuff” belongs to another project than the workflow');
    expect(result.changes.find((c) => c.kind === 'workflow' && c.id === teamFlow.id)?.fields ?? []).not.toContain('folder');
    await sync.applySync(files([folderFile('ops-stuff', 'fd_syncops', 'Ops stuff'), workflowFile('ops-stuff', teamFlow.id, 'TN sync team flow')]));
    expect(store.getWorkflow(teamFlow.id)?.folderId).toBeUndefined();
  });

  it('a new workflow filed in another project’s existing folder is made in that project', async () => {
    await sync.applySync(files([folderFile('ops-stuff', 'fd_syncops', 'Ops stuff'), workflowFile('ops-stuff', 'wf_syncinops', 'TN sync in ops')]));
    expect(projects.homeProjectId('workflow', 'wf_syncinops')).toBe(ops);
    expect(store.getWorkflow('wf_syncinops')?.folderId).toBe('fd_syncops');
  });

  it('creates tables in the default project, matching by name only there', async () => {
    const created = await createTable(ops, 'Synced');
    const plan = sync.planSync(files([{ path: 'data-tables/synced.schema.json', content: JSON.stringify({ name: 'Synced', columns: [{ name: 'q', type: 'string' }] }) }]));
    // Ops's “Synced” isn't the default project's: a table is made, in the default project.
    expect(plan.changes.find((c) => c.kind === 'dataTable')).toMatchObject({ action: 'create', name: 'Synced' });
    await sync.applySync(files([{ path: 'data-tables/synced.schema.json', content: JSON.stringify({ name: 'Synced', columns: [{ name: 'q', type: 'string' }] }) }]));
    const homes = dataTables().listTables().filter((t) => t.name === 'Synced').map((t) => projects.homeProjectId('dataTable', t.id)).sort();
    expect(homes).toEqual([ops, projects.defaultProjectId()].sort());
    expect(created.status).toBe(201);
  });
});
