/**
 * Data tables and templates per project:
 *
 * - the Data Table node only reads and writes its workflow's project's tables: another project's table fails the
 *   node with a clear error, and the node's pickers (load options) list the tables of the workflow being edited;
 * - saved templates belong to a project (its members see them, its editors change them) or the whole instance (owners
 *   and admins); the library filters to a project and the instance-wide ones; a saved template is edited in place
 *   (name, description, categories, setup steps, its workflow replaced from a saved workflow, its project);
 * - "Use template" creates the workflow and its data tables in the project asked for, reusing only that project's
 *   tables;
 * - remote templates page through more than 30 results (a local server, never the network).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { TemplateDetail, TemplateSummary, UseTemplateResult } from '@/lib/shared/templates';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-tables-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
delete process.env.LANDFLOW_TEMPLATES_URL;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { dataTables } = await import('@/lib/server/datatables/service');
const templates = await import('@/lib/server/templates');
const { clearRemoteCache } = await import('@/lib/server/templates/remote');
const workflowsRoute = await import('@/app/api/workflows/route');
const dataTablesRoute = await import('@/app/api/data-tables/route');
const loadOptionsRoute = await import('@/app/api/node-types/load-options/route');
const templatesRoute = await import('@/app/api/templates/route');
const templateRoute = await import('@/app/api/templates/[id]/route');
const useRoute = await import('@/app/api/templates/[id]/use/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let alice: User; // the team's admin
let bob: User; // its editor, and an editor of Ops
let carol: User; // its viewer
let dave: User; // in no project
let admin: User;
let team = '';
let ops = '';
let teamTable = '';

beforeAll(async () => {
  alice = await createUser({ email: 'alice@tables.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@tables.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  carol = await createUser({ email: 'carol@tables.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
  dave = await createUser({ email: 'dave@tables.test', name: 'Dave', role: 'member', password: 'dave-password-1' });
  admin = await createUser({ email: 'admin@tables.test', name: 'Ada', role: 'admin', password: 'admin-password-1' });
  team = projects.createTeamProject({ name: 'Sales' }).id;
  projects.setMember(team, alice.id, 'admin');
  projects.setMember(team, bob.id, 'editor');
  projects.setMember(team, carol.id, 'viewer');
  ops = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(ops, bob.id, 'editor');
  const created = await call<{ table: { id: string } }>(bob, () => dataTablesRoute.POST(req('POST', `/api/data-tables?projectId=${team}`, { name: 'TMP Leads', columns: [{ name: 'email', type: 'string' }] })));
  expect(created.status).toBe(201);
  teamTable = created.body.table.id;
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
  new Request(`http://tables.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
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
const tableWorkflow = (name: string, tableRef: string) => ({
  name,
  nodes: [node('Start', 'core.manualTrigger'), node('Table', 'core.dataTable', { dataTableId: tableRef, operation: 'insert', mappingMode: 'defineBelow', columns: { column: [{ column: 'email', value: 'a@b.io' }] } }, 200)],
  connections: [{ id: 'e', type: 'main' as const, source: 'Start', target: 'Table', sourceIndex: 0, targetIndex: 0 }],
});
async function createWorkflow(user: User, projectId: string, workflow: ReturnType<typeof tableWorkflow>) {
  const created = await call<{ workflow: Workflow }>(user, () => workflowsRoute.POST(req('POST', `/api/workflows?projectId=${projectId}`, workflow)));
  expect(created.status).toBe(201);
  return created.body.workflow;
}
const tableOptions = async (user: User, scope: Record<string, string>, method = 'tables', parameters: Record<string, unknown> = {}) =>
  (await call<{ options: Array<{ name: string; value: string }> }>(user, () => loadOptionsRoute.POST(req('POST', '/api/node-types/load-options', { type: 'core.dataTable', method, parameters, ...scope })))).body.options;

describe('the Data Table node per project', () => {
  it('uses its own project’s tables, and fails on another project’s with where it belongs', async () => {
    const inTeam = await createWorkflow(bob, team, tableWorkflow('TMP team insert', teamTable));
    const record = await runWorkflow({ workflow: store.getWorkflow(inTeam.id)!, mode: 'manual' });
    expect(record.status).toBe('success');
    expect(dataTables().listRows(teamTable).rows).toHaveLength(1);

    for (const ref of [teamTable, 'TMP Leads']) {
      const inOps = await createWorkflow(bob, ops, tableWorkflow(`TMP ops insert ${ref}`, ref));
      const failed = (await runWorkflow({ workflow: store.getWorkflow(inOps.id)!, mode: 'manual' })) as unknown as { status: string; runData: Record<string, Array<{ error?: { message: string; description?: string } }>> };
      expect(failed.status).toBe('error');
      expect(failed.runData.Table[0].error).toMatchObject({ message: 'Data table “TMP Leads” belongs to the “Sales” project', description: expect.stringContaining('(“Ops”)') });
    }
    expect(dataTables().listRows(teamTable).rows).toHaveLength(1);
  });

  it('lists the edited workflow’s project’s tables in its pickers', async () => {
    const inTeam = await createWorkflow(bob, team, tableWorkflow('TMP picker team', teamTable));
    const inOps = await createWorkflow(bob, ops, tableWorkflow('TMP picker ops', ''));
    const opsTable = (await call<{ table: { id: string } }>(bob, () => dataTablesRoute.POST(req('POST', `/api/data-tables?projectId=${ops}`, { name: 'TMP Incidents', columns: [{ name: 'sev', type: 'number' }] })))).body.table.id;

    expect((await tableOptions(bob, { workflowId: inTeam.id })).map((o) => o.value)).toEqual([teamTable]);
    expect((await tableOptions(bob, { workflowId: inOps.id })).map((o) => o.value)).toEqual([opsTable]);
    expect((await tableOptions(bob, { projectId: ops })).map((o) => o.value)).toEqual([opsTable]);
    // Without a workflow: what the caller sees.
    expect((await tableOptions(bob, {})).map((o) => o.value).sort()).toEqual([teamTable, opsTable].sort());
    expect((await tableOptions(dave, {})).map((o) => o.value)).toEqual([]);
    // A workflow the caller can't read doesn't scope anything: Dave still sees none of the team's tables.
    expect((await tableOptions(dave, { workflowId: inTeam.id })).map((o) => o.value)).toEqual([]);
    // Another project's table has no columns here.
    expect(await tableOptions(bob, { workflowId: inOps.id }, 'columns', { dataTableId: teamTable })).toEqual([]);
    expect((await tableOptions(bob, { workflowId: inTeam.id }, 'columns', { dataTableId: teamTable })).map((o) => o.value)).toEqual(['email']);
  });
});

// ---- templates ----------------------------------------------------------------------------------------------

const sampleWorkflow = (value: string, extra: WorkflowNode[] = []) => ({
  id: 'wf_draft',
  name: 'Draft',
  nodes: [node('Start', 'core.manualTrigger'), node('Set', 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'v', type: 'string', value }] } }, 200), ...extra],
  connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Set', sourceIndex: 0, targetIndex: 0 }],
});
const save = (user: User, body: Record<string, unknown>) => call<{ template: TemplateDetail; error?: string }>(user, () => templatesRoute.POST(req('POST', '/api/templates', body)));
const list = (user: User, query = '') => call<{ templates: TemplateSummary[]; remote: { enabled: boolean; page?: number; total?: number; hasMore?: boolean } }>(user, () => templatesRoute.GET(req('GET', `/api/templates${query}`)));
const localNames = (templatesList: TemplateSummary[]) => templatesList.filter((t) => t.source === 'local').map((t) => t.name).sort();

describe('templates per project', () => {
  let teamTemplate: TemplateDetail;

  it('saves to a project (its editors), to the instance (owners and admins), else to the caller’s personal project', async () => {
    const saved = await save(bob, { workflow: sampleWorkflow('team'), name: 'TMP Team template', projectId: team });
    expect(saved.status).toBe(201);
    teamTemplate = saved.body.template;
    expect(teamTemplate).toMatchObject({ projectId: team, projectName: 'Sales', canEdit: true });
    expect((await save(carol, { workflow: sampleWorkflow('x'), name: 'TMP nope', projectId: team })).status).toBe(403);
    expect((await save(dave, { workflow: sampleWorkflow('x'), name: 'TMP nope', projectId: team })).status).toBe(403);
    expect((await save(bob, { workflow: sampleWorkflow('x'), name: 'TMP nope', projectId: null })).status).toBe(403);
    const personal = await save(bob, { workflow: sampleWorkflow('mine'), name: 'TMP Bob personal' });
    expect(personal.body.template.projectId).toBe(`personal_${bob.id}`);
    const shared = await save(admin, { workflow: sampleWorkflow('everyone'), name: 'TMP Instance template' });
    expect(shared.body.template.projectId).toBeUndefined();
    // Importing a file into a project.
    const file = templates.templateFile(teamTemplate);
    const imported = await call<{ template: TemplateDetail }>(bob, () => templatesRoute.POST(req('POST', '/api/templates', { data: file, projectId: ops })));
    expect(imported.status).toBe(201);
    expect(imported.body.template).toMatchObject({ projectId: ops, name: 'TMP Team template' });
    expect((await call(carol, () => templatesRoute.POST(req('POST', '/api/templates', { data: file, projectId: ops })))).status).toBe(403);
  });

  it('shows a project’s templates to its members, and filters the library to a project and the instance-wide ones', async () => {
    expect(localNames((await list(carol)).body.templates)).toEqual(['TMP Instance template', 'TMP Team template']);
    expect(localNames((await list(dave)).body.templates)).toEqual(['TMP Instance template']);
    expect(localNames((await list(bob, `?projectId=${team}`)).body.templates)).toEqual(['TMP Instance template', 'TMP Team template']);
    expect(localNames((await list(bob, `?projectId=${ops}`)).body.templates)).toEqual(['TMP Instance template', 'TMP Team template']);
    expect(localNames((await list(bob)).body.templates)).toEqual(['TMP Bob personal', 'TMP Instance template', 'TMP Team template', 'TMP Team template']);
    expect((await list(carol, `?projectId=${ops}`)).status).toBe(404);
    expect(localNames((await list(admin)).body.templates)).toHaveLength(4);

    // One template: its members only.
    expect((await call(carol, () => templateRoute.GET(req('GET', `/api/templates/${teamTemplate.id}`), params({ id: teamTemplate.id })))).body.template).toMatchObject({ canEdit: false });
    expect((await call(dave, () => templateRoute.GET(req('GET', `/api/templates/${teamTemplate.id}`), params({ id: teamTemplate.id })))).status).toBe(404);
    expect((await call(dave, () => templateRoute.GET(req('GET', `/api/templates/${teamTemplate.id}?format=file`), params({ id: teamTemplate.id })))).status).toBe(404);
  });

  it('counts a project’s allowed nodes in `usable`', async () => {
    const { updateProjectSettings } = await import('@/lib/server/governance/scopes');
    updateProjectSettings(ops, { nodes: { mode: 'allow', types: ['core.manualTrigger'] } });
    try {
      // The copy imported into Ops, and a built-in template, can't be used there; the Sales one can in Sales.
      const scoped = (await list(bob, `?projectId=${ops}`)).body.templates;
      const copy = scoped.find((t) => t.source === 'local' && t.name === 'TMP Team template')!;
      expect(copy.projectId).toBe(ops);
      expect(copy.usable).toBe(false);
      expect(copy.problems).toEqual([expect.objectContaining({ kind: 'blocked', nodeType: 'core.set' })]);
      expect(scoped.filter((t) => t.source === 'builtin').every((t) => !t.usable)).toBe(true);
      expect((await list(bob, `?projectId=${team}`)).body.templates.find((t) => t.id === teamTemplate.id)!.usable).toBe(true);
      // Without a project picked, a saved template counts its own project's list.
      expect((await list(bob)).body.templates.find((t) => t.id === copy.id)!.usable).toBe(false);
      expect((await list(bob)).body.templates.find((t) => t.id === teamTemplate.id)!.usable).toBe(true);
      // Carol (not in Ops) can't learn Ops's list through the detail route.
      expect((await call<{ template: TemplateDetail }>(carol, () => templateRoute.GET(req('GET', `/api/templates/${teamTemplate.id}?projectId=${ops}`), params({ id: teamTemplate.id })))).body.template.usable).toBe(true);
    } finally {
      updateProjectSettings(ops, { nodes: { mode: 'off', types: [] } });
    }
  });

  it('is edited in place by its project’s editors: details, setup steps, its workflow and its project', async () => {
    const path = `/api/templates/${teamTemplate.id}`;
    const patch = (user: User, body: unknown) => call<{ template: TemplateDetail; error?: string }>(user, () => templateRoute.PATCH(req('PATCH', path, body), params({ id: teamTemplate.id })));
    expect((await patch(carol, { name: 'TMP renamed' })).status).toBe(403);
    expect((await patch(dave, { name: 'TMP renamed' })).status).toBe(404);
    expect((await patch(bob, { name: '' })).status).toBe(400);

    const edited = await patch(bob, { name: 'TMP Team template v2', description: 'Now **better**', categories: ['marketing'], setup: ['Pick a table', 'Run it'] });
    expect(edited.status).toBe(200);
    expect(edited.body.template).toMatchObject({ id: teamTemplate.id, name: 'TMP Team template v2', description: 'Now **better**', categories: ['marketing'], setup: ['Pick a table', 'Run it'], projectId: team });
    expect(edited.body.template.createdAt).toBe(teamTemplate.createdAt);

    // Replace its workflow with a saved one: its nodes, credentials as slots, no pinned data.
    const source = await createWorkflow(bob, team, tableWorkflow('TMP source', teamTable));
    store.saveWorkflow({ ...store.getWorkflow(source.id)!, pinData: { Start: [{ json: { secret: 'pinned' } }] } } as Workflow);
    const replaced = await patch(bob, { workflowId: source.id });
    expect(replaced.status).toBe(200);
    expect(replaced.body.template.nodeTypes).toEqual(['core.manualTrigger', 'core.dataTable']);
    expect(replaced.body.template.dataTables).toEqual([{ name: 'TMP Leads', columns: [{ name: 'email', type: 'string' }] }]);
    expect(JSON.stringify(replaced.body.template.workflow)).not.toContain('pinned');
    expect(replaced.body.template.name).toBe('TMP Team template v2');
    // A workflow the editor can't see is "not found".
    const hidden = await createWorkflow(admin, ops, tableWorkflow('TMP hidden', ''));
    expect((await call(alice, () => templateRoute.PATCH(req('PATCH', path, { workflowId: hidden.id }), params({ id: teamTemplate.id })))).status).toBe(404);
    expect((await patch(carol, { workflowId: source.id })).status).toBe(403);

    // Moving it: to a project the editor adds to; instance-wide only for owners and admins.
    expect((await patch(bob, { projectId: null })).status).toBe(403);
    expect((await patch(bob, { projectId: ops })).body.template.projectId).toBe(ops);
    expect((await call(carol, () => templateRoute.GET(req('GET', path), params({ id: teamTemplate.id })))).status).toBe(404);
    expect((await call<{ template: TemplateDetail }>(admin, () => templateRoute.PATCH(req('PATCH', path, { projectId: team }), params({ id: teamTemplate.id })))).body.template.projectId).toBe(team);
    // Built-in templates can't be edited.
    expect((await call(admin, () => templateRoute.PATCH(req('PATCH', '/api/templates/error-alerts', { name: 'x' }), params({ id: 'error-alerts' })))).status).toBe(400);
  });

  it('creates the workflow and its tables in the project asked for, reusing only that project’s tables', async () => {
    const use = (user: User, query: string, body: unknown = {}) =>
      call<UseTemplateResult & { error?: string }>(user, () => useRoute.POST(req('POST', `/api/templates/${teamTemplate.id}/use${query}`, body), params({ id: teamTemplate.id })));
    const inTeam = await use(bob, `?projectId=${team}`);
    expect(inTeam.status, JSON.stringify(inTeam.body)).toBe(201);
    expect(projects.homeProjectId('workflow', inTeam.body.workflow.id)).toBe(team);
    expect(inTeam.body.createdTables).toEqual([]);
    expect(inTeam.body.workflow.nodes.find((n) => n.type === 'core.dataTable')?.parameters.dataTableId).toBe(teamTable);

    // In Ops the Sales table isn't reused: Ops gets a table of its own (names are unique per project, not per instance).
    const inOps = await use(bob, `?projectId=${ops}`);
    expect(inOps.status).toBe(201);
    expect(projects.homeProjectId('workflow', inOps.body.workflow.id)).toBe(ops);
    expect(inOps.body.createdTables).toEqual(['TMP Leads']);
    const created = dataTables().findTable('TMP Leads', ops)!;
    expect(created.id).not.toBe(teamTable);
    expect(projects.homeProjectId('dataTable', created.id)).toBe(ops);
    // Using the template again in Ops reuses Ops's table.
    expect((await use(bob, `?projectId=${ops}`)).body.createdTables).toEqual([]);
    expect((await runWorkflow({ workflow: store.getWorkflow(inOps.body.workflow.id)!, mode: 'manual' })).status).toBe('success');

    // Viewers and outsiders can't create there; a folder of another project is refused.
    expect((await use(carol, `?projectId=${team}`)).status).toBe(403);
    expect((await use(dave, `?projectId=${team}`)).status).toBe(404);
    const folder = (await import('@/lib/server/folders')).folders.create({ name: 'TMP Ops folder', projectId: ops });
    expect((await use(bob, `?projectId=${team}`, { folderId: folder.id })).status).toBe(403);
    const intoFolder = await use(bob, '', { folderId: folder.id });
    expect(projects.homeProjectId('workflow', intoFolder.body.workflow.id)).toBe(ops);
  });

  it('is deleted by its project’s editors only', async () => {
    const path = `/api/templates/${teamTemplate.id}`;
    expect((await call(carol, () => templateRoute.DELETE(req('DELETE', path), params({ id: teamTemplate.id })))).status).toBe(403);
    expect((await call(dave, () => templateRoute.DELETE(req('DELETE', path), params({ id: teamTemplate.id })))).status).toBe(404);
    expect((await call(bob, () => templateRoute.DELETE(req('DELETE', path), params({ id: teamTemplate.id })))).status).toBe(200);
    expect(await templates.getTemplate(teamTemplate.id)).toBeUndefined();
  });
});

describe('remote templates, page by page', () => {
  let server: Server;
  const TOTAL = 45;
  const asked: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      asked.push(`${url.pathname}?${url.searchParams}`);
      const page = Number(url.searchParams.get('page') ?? 1);
      const rows = Number(url.searchParams.get('rows') ?? 30);
      const ids = Array.from({ length: TOTAL }, (_, i) => 5000 + i).slice((page - 1) * rows, page * rows);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ totalWorkflows: TOTAL, workflows: ids.map((id) => ({ id, name: `Remote ${id}`, description: '', user: { name: 'Ada' }, nodes: [{ name: 'n8n-nodes-base.set' }] })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.LANDFLOW_TEMPLATES_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
    clearRemoteCache();
  });

  afterAll(async () => {
    delete process.env.LANDFLOW_TEMPLATES_URL;
    clearRemoteCache();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 30 at a time with the total and whether there are more', async () => {
    const first = await list(bob, '?source=remote');
    expect(first.body.templates).toHaveLength(30);
    expect(first.body.remote).toMatchObject({ enabled: true, page: 1, total: TOTAL, hasMore: true });
    const second = await list(bob, '?source=remote&page=2');
    expect(second.body.templates.map((t) => t.id)).toEqual(Array.from({ length: 15 }, (_, i) => `n8n-${5030 + i}`));
    expect(second.body.remote).toMatchObject({ page: 2, total: TOTAL, hasMore: false });
    expect(asked).toEqual(['/api/templates/search?page=1&rows=30', '/api/templates/search?page=2&rows=30']);
    // A search pages the same way; built-in and saved templates come only with page 1's request from the library.
    const searched = await list(bob, '?search=remote&page=2');
    expect(asked.at(-1)).toBe('/api/templates/search?page=2&rows=30&search=remote');
    expect(searched.body.remote.page).toBe(2);
    expect((await list(bob, '?source=remote&page=-3')).body.remote.page).toBe(1);
  });
});
