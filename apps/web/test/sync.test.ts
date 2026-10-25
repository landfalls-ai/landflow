/**
 * Git sync: the file format (stable key order, slugs, folders as directories, credentials by name and type) and the
 * export and apply endpoints through their route handlers — round trips, prune, conflicts against a base, data
 * table schemas and variables — plus the background run and stop endpoints the CLI uses.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { SyncApplyResult, SyncExport } from '@/lib/shared/sync';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-sync-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const format = await import('@/lib/server/sync/format');
const { store } = await import('@/lib/server/store');
const { folders } = await import('@/lib/server/folders');
const { variables } = await import('@/lib/server/variables');
const { dataTables } = await import('@/lib/server/datatables');
const { credentials } = await import('@/lib/server/credentials/vault');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const exportRoute = await import('@/app/api/sync/export/route');
const applyRoute = await import('@/app/api/sync/apply/route');
const executeRoute = await import('@/app/api/workflows/[id]/execute/route');
const stopRoute = await import('@/app/api/executions/[id]/stop/route');
const executionRoute = await import('@/app/api/executions/[id]/route');

type Files = Array<{ path: string; content: string }>;

async function exported(query = ''): Promise<SyncExport> {
  const response = await exportRoute.GET(new Request(`http://sync.test/api/sync/export${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as SyncExport;
}

async function apply(body: { files: Files; prune?: boolean; dryRun?: boolean; force?: boolean; base?: Record<string, string> }) {
  const response = await applyRoute.POST(new Request('http://sync.test/api/sync/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as SyncApplyResult & { error?: string } };
}

const filesOf = (e: SyncExport): Files => e.files.map(({ path, content }) => ({ path, content }));
const edit = (files: Files, path: string, change: (doc: Record<string, unknown>) => void): Files =>
  files.map((f) => {
    if (f.path !== path) return f;
    const doc = JSON.parse(f.content) as Record<string, unknown>;
    change(doc);
    return { path, content: format.stringify(doc) };
  });

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });

function workflow(id: string, name: string, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name,
    nodes: [node('start', 'Start', 'core.manualTrigger'), node('set', 'Set', 'core.set', { zeta: 1, alpha: { b: 2, a: 1 } })],
    connections: [{ id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
    ...extra,
  };
}

beforeAll(async () => {
  await ensureBootstrapped();
  // Start from a known instance: no seeded workflows.
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
});

describe('sync format', () => {
  it('slugifies names into file names', () => {
    expect(format.slugify('Hello, World! Ünïcode')).toBe('hello-world-unicode');
    expect(format.slugify('  --A__B--  ')).toBe('a-b');
    expect(format.slugify('日本語')).toBe('');
    expect(format.slugify('x'.repeat(200))).toHaveLength(80);
  });

  it('knows which paths it owns', () => {
    for (const path of ['landflow-sync.json', 'variables.json', 'credentials.json', 'data-tables/leads.schema.json', 'workflows/a.workflow.json', 'workflows/f/.folder.json', 'workflows/f/g/b.workflow.json']) {
      expect(format.isManagedPath(path), path).toBe(true);
    }
    for (const path of ['README.md', 'workflows/notes.md', 'data-tables/x/y.schema.json', 'other/a.workflow.json']) expect(format.isManagedPath(path), path).toBe(false);
    expect(format.isSafePath('workflows/../x')).toBe(false);
    expect(format.isSafePath('/etc/passwd')).toBe(false);
  });

  it('writes workflows with a fixed key order, credentials by name and type, no timestamps or folder', () => {
    const doc = format.workflowDocument(
      {
        ...workflow('wf_1', 'Flow', { tags: ['b', 'a'], folderId: 'fd_1', createdAt: 'x', updatedAt: 'y', settings: { timezone: 'UTC', concurrencyLimit: 2 } }),
        nodes: [node('n1', 'Model', 'core.openAiChat', { z: 1, a: 2 }, { credentials: { openAiApi: { id: 'cr_1', name: 'Old name' } }, notes: 'hi' })],
      },
      [{ id: 'cr_1', name: 'OpenAI prod', type: 'core.openAiApi' }],
    );
    expect(Object.keys(doc)).toEqual(['id', 'name', 'active', 'tags', 'settings', 'nodes', 'connections']);
    expect(doc.tags).toEqual(['a', 'b']);
    expect(Object.keys(doc.settings as object)).toEqual(['concurrencyLimit', 'timezone']);
    const first = (doc.nodes as Array<Record<string, unknown>>)[0];
    expect(Object.keys(first)).toEqual(['id', 'name', 'type', 'typeVersion', 'position', 'notes', 'credentials', 'parameters']);
    expect(first.credentials).toEqual({ openAiApi: { name: 'OpenAI prod', type: 'core.openAiApi' } });
    // Parameters keep their order.
    expect(Object.keys(first.parameters as object)).toEqual(['z', 'a']);
  });

  it('renders the same bytes whatever order the state comes in, and keeps names unique per directory', () => {
    const state = {
      workflows: [workflow('wf_b', 'Same name', { folderId: 'fd_1' }), workflow('wf_a', 'Same name', { folderId: 'fd_1' }), workflow('wf_c', 'Top')],
      folders: [
        { id: 'fd_1', name: 'Marketing', createdAt: '', updatedAt: '' },
        { id: 'fd_2', name: 'Inner', parentId: 'fd_1', createdAt: '', updatedAt: '' },
      ],
      variables: [
        { key: 'B', value: '2' },
        { key: 'A', value: '1' },
      ],
      dataTables: [{ id: 'dt_1', name: 'Leads', columns: [{ name: 'email', type: 'string' }] }],
      credentials: [],
    };
    const one = format.renderState(state);
    const two = format.renderState({ ...state, workflows: [...state.workflows].reverse(), folders: [...state.folders].reverse(), variables: [...state.variables].reverse() });
    expect(two.files).toEqual(one.files);
    expect(one.files.map((f) => f.path)).toEqual([
      'credentials.json',
      'data-tables/leads.schema.json',
      'landflow-sync.json',
      'variables.json',
      'workflows/marketing/.folder.json',
      'workflows/marketing/inner/.folder.json',
      'workflows/marketing/same-name-wf-b.workflow.json',
      'workflows/marketing/same-name.workflow.json',
      'workflows/top.workflow.json',
    ]);
    expect(one.workflowPaths.wf_a).toBe('workflows/marketing/same-name.workflow.json');
    expect(JSON.parse(one.files.find((f) => f.path === 'variables.json')!.content)).toEqual({ variables: [{ key: 'A' }, { key: 'B' }] });
    expect(JSON.parse(format.renderState(state, { values: true }).files.find((f) => f.path === 'variables.json')!.content).variables[0]).toEqual({ key: 'A', value: '1' });
    expect(one.files.every((f) => f.content.endsWith('\n'))).toBe(true);
  });

  it('reports files it cannot read', () => {
    expect(format.parseFiles([]).errors[0]).toMatch(/landflow-sync.json is missing/);
    const parsed = format.parseFiles([
      { path: 'landflow-sync.json', content: '{"format":"landflow-sync/v1"}' },
      { path: 'workflows/a.workflow.json', content: '{ nope' },
      { path: 'variables.json', content: '{"variables":[{"key":1}]}' },
      { path: 'README.md', content: 'ignored' },
    ]);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toMatch(/variables.json/);
    expect(parsed.errors[1]).toMatch(/workflows\/a.workflow.json: not valid JSON/);
  });
});

describe('export and apply', () => {
  let base: SyncExport;

  beforeAll(() => {
    const marketing = folders.create({ name: 'Marketing' });
    folders.create({ name: 'Campaigns', parentId: marketing.id });
    const credential = credentials.create({ name: 'Model key', type: 'core.openAiApi', data: { apiKey: 'sk-secret-never-exported' } });
    store.saveWorkflow(workflow('wf_top', 'Top flow', { tags: ['ops'] }));
    store.saveWorkflow({
      ...workflow('wf_ai', 'AI flow', { folderId: marketing.id }),
      nodes: [node('m', 'Model', 'core.openAiChat', {}, { credentials: { openAiApi: { id: credential.id, name: credential.name } } })],
      connections: [],
    });
    variables.create({ key: 'API_BASE', value: 'https://api.example.com' });
    dataTables().createTable({ name: 'Leads', columns: [{ name: 'email', type: 'string' }] });
  });

  it('exports the instance as files, without secrets', async () => {
    base = await exported();
    const paths = base.files.map((f) => f.path);
    expect(paths).toEqual([
      'credentials.json',
      'data-tables/leads.schema.json',
      'landflow-sync.json',
      'variables.json',
      'workflows/marketing/.folder.json',
      'workflows/marketing/ai-flow.workflow.json',
      'workflows/marketing/campaigns/.folder.json',
      'workflows/top-flow.workflow.json',
    ]);
    const all = base.files.map((f) => f.content).join('\n');
    expect(all).not.toContain('sk-secret-never-exported');
    expect(all).not.toContain('https://api.example.com');
    const ai = JSON.parse(base.files.find((f) => f.path.endsWith('ai-flow.workflow.json'))!.content);
    expect(ai.nodes[0].credentials).toEqual({ openAiApi: { name: 'Model key', type: 'core.openAiApi' } });
    expect(ai).not.toHaveProperty('updatedAt');
    expect(JSON.parse(base.files.find((f) => f.path === 'credentials.json')!.content)).toEqual({ credentials: [{ name: 'Model key', type: 'core.openAiApi' }] });
    expect(base.summary).toEqual({ workflows: 2, folders: 2, variables: 1, dataTables: 1, credentials: 1 });
    expect(base.hashes['workflow:wf_top']).toBe(base.files.find((f) => f.path === 'workflows/top-flow.workflow.json')!.hash);
    expect((await exported('?values=true')).files.find((f) => f.path === 'variables.json')!.content).toContain('https://api.example.com');
    // Exporting again gives the same bytes.
    expect((await exported()).files).toEqual(base.files);
  });

  it('limits the export to some workflows', async () => {
    const one = await exported('?workflow=wf_ai');
    expect(one.files.filter((f) => f.path.startsWith('workflows/')).map((f) => f.path)).toEqual(['workflows/marketing/.folder.json', 'workflows/marketing/ai-flow.workflow.json']);
    const missing = await exportRoute.GET(new Request('http://sync.test/api/sync/export?workflow=wf_nope'));
    expect(missing.status).toBe(404);
  });

  it('finds nothing to do when the files match', async () => {
    const { status, body } = await apply({ files: filesOf(base), dryRun: true });
    expect(status).toBe(200);
    expect(body.changes).toEqual([]);
    expect(body.errors).toEqual([]);
  });

  it('applies edited, added and moved files by stable id, and exports them back unchanged', async () => {
    let files = edit(filesOf(base), 'workflows/top-flow.workflow.json', (doc) => {
      doc.name = 'Top flow renamed';
      (doc.nodes as Array<Record<string, unknown>>)[1].parameters = { zeta: 2 };
    });
    // A new workflow without an id, in a new directory without .folder.json.
    files.push({ path: 'workflows/sales/new-one.workflow.json', content: format.stringify({ name: 'New one', nodes: [node('s', 'Start', 'core.manualTrigger')], connections: [] }) });
    // Move the AI flow to the top level.
    const ai = files.find((f) => f.path === 'workflows/marketing/ai-flow.workflow.json')!;
    files = files.filter((f) => f !== ai).concat({ path: 'workflows/ai-flow.workflow.json', content: ai.content });

    const preview = await apply({ files, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.applied).toBe(false);
    expect(preview.body.changes.map((c) => [c.kind, c.action, c.name, c.fields])).toEqual([
      ['folder', 'create', 'sales', undefined],
      ['workflow', 'update', 'AI flow', ['folder']],
      ['workflow', 'create', 'New one', undefined],
      ['workflow', 'update', 'Top flow renamed', ['name', 'nodes']],
    ]);
    expect(store.getWorkflow('wf_top')!.name).toBe('Top flow');

    const { status, body } = await apply({ files });
    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: true, appliedCount: 4, errors: [] });
    expect(store.getWorkflow('wf_top')!.name).toBe('Top flow renamed');
    expect(store.getWorkflow('wf_ai')!.folderId).toBeUndefined();
    const created = store.listWorkflows().find((w) => w.name === 'New one')!;
    expect(created.id).toBe(format.idForPath('wf', 'workflows/sales/new-one.workflow.json'));
    expect(folders.get(created.folderId!)!.name).toBe('sales');
    // The credential reference resolved back to the saved credential's id.
    expect(store.getWorkflow('wf_ai')!.nodes[0].credentials!.openAiApi.id).toMatch(/\S/);

    // Pull after push: the export holds what was pushed (plus the new folder's .folder.json and the new id).
    const after = await exported();
    const top = after.files.find((f) => f.path === 'workflows/top-flow-renamed.workflow.json')!;
    expect(top.content).toBe(files.find((f) => f.path === 'workflows/top-flow.workflow.json')!.content);
    expect(after.hashes).toEqual(body.hashes);
    expect((await apply({ files: filesOf(after), dryRun: true })).body.changes).toEqual([]);
    base = after;
  });

  it('deletes only with prune', async () => {
    const files = filesOf(base).filter((f) => f.path !== 'workflows/ai-flow.workflow.json' && f.path !== 'workflows/marketing/campaigns/.folder.json');
    const kept = await apply({ files });
    expect(kept.status).toBe(200);
    expect(kept.body.changes.map((c) => [c.kind, c.action, c.name, c.skipped])).toEqual([
      ['workflow', 'delete', 'AI flow', 'prune'],
      ['folder', 'delete', 'Campaigns', 'prune'],
    ]);
    expect(store.getWorkflow('wf_ai')).toBeDefined();

    const pruned = await apply({ files, prune: true, base: base.hashes });
    expect(pruned.status).toBe(200);
    expect(pruned.body.appliedCount).toBe(2);
    expect(store.getWorkflow('wf_ai')).toBeUndefined();
    expect(folders.list().map((f) => f.name)).not.toContain('Campaigns');
    base = await exported();
  });

  it('holds back changes that conflict with edits made on the instance since the base', async () => {
    const files = edit(filesOf(base), 'workflows/top-flow-renamed.workflow.json', (doc) => {
      doc.description = 'from the files';
    });
    // Someone edits the same workflow in the editor after the pull.
    store.saveWorkflow({ ...store.getWorkflow('wf_top')!, description: 'from the editor' });
    // And creates another one, which a pruning push would delete.
    store.saveWorkflow(workflow('wf_fresh', 'Fresh in the editor'));

    const blocked = await apply({ files, base: base.hashes, prune: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.applied).toBe(false);
    expect(blocked.body.conflicts).toBe(2);
    expect(blocked.body.changes.filter((c) => c.conflict).map((c) => [c.id, c.conflict])).toEqual([
      ['wf_top', 'changed on the instance since the last sync'],
      ['wf_fresh', 'created on the instance since the last sync'],
    ]);
    expect(store.getWorkflow('wf_top')!.description).toBe('from the editor');

    // A dry run reports the same plan with 200; without a base the files win; force applies conflicts.
    expect((await apply({ files, base: base.hashes, dryRun: true })).status).toBe(200);
    const forced = await apply({ files, base: base.hashes, force: true });
    expect(forced.status).toBe(200);
    expect(store.getWorkflow('wf_top')!.description).toBe('from the files');
    expect(store.getWorkflow('wf_fresh')).toBeDefined();
    base = await exported();
  });

  it('refuses files that don’t validate, and applies nothing', async () => {
    const files = filesOf(base);
    const top = files.find((f) => f.path === 'workflows/top-flow-renamed.workflow.json')!;
    const broken = [...files, { path: 'workflows/copy.workflow.json', content: top.content }, { path: 'workflows/bad.workflow.json', content: format.stringify({ id: 'wf_bad', name: '' }) }];
    const { status, body } = await apply({ files: broken });
    expect(status).toBe(400);
    expect(body.errors.join('\n')).toMatch(/workflow id wf_top is in another file too/);
    expect(body.errors.join('\n')).toMatch(/bad.workflow.json: name/);
    expect(store.getWorkflow('wf_bad')).toBeUndefined();
    expect((await apply({ files: files.filter((f) => f.path !== 'landflow-sync.json') })).status).toBe(400);
  });

  it('warns about credentials this instance lacks, keeping the name', async () => {
    const files = [
      ...filesOf(base),
      {
        path: 'workflows/needs-cred.workflow.json',
        content: format.stringify({ id: 'wf_cred', name: 'Needs cred', nodes: [node('m', 'Model', 'core.openAiChat', {}, { credentials: { openAiApi: { name: 'Elsewhere', type: 'core.openAiApi' } } })], connections: [] }),
      },
    ];
    const { status, body } = await apply({ files });
    expect(status).toBe(200);
    expect(body.warnings.join('\n')).toMatch(/credential “Elsewhere” \(core.openAiApi\) isn't on this instance/);
    expect(store.getWorkflow('wf_cred')!.nodes[0].credentials).toEqual({ openAiApi: { id: '', name: 'Elsewhere' } });
    // It exports back as it came in (in canonical form), so it stays in sync.
    base = await exported();
    expect(JSON.parse(base.files.find((f) => f.path === 'workflows/needs-cred.workflow.json')!.content)).toEqual({ ...JSON.parse(files.at(-1)!.content), active: false });
    expect((await apply({ files: filesOf(base), dryRun: true })).body.changes).toEqual([]);
  });

  it('syncs data table schemas: create by id, add columns, never retype; drops need prune', async () => {
    const leads = dataTables().listTables().find((t) => t.name === 'Leads')!;
    dataTables().insertRows(leads.id, [{ email: 'a@example.com' }]);
    let files = edit(filesOf(base), 'data-tables/leads.schema.json', (doc) => {
      (doc.columns as unknown[]).push({ name: 'score', type: 'number' });
    });
    files.push({ path: 'data-tables/orders.schema.json', content: format.stringify({ id: 'dt_orders', name: 'Orders', columns: [{ name: 'total', type: 'number' }] }) });
    const { status, body } = await apply({ files });
    expect(status).toBe(200);
    expect(body.changes.map((c) => [c.kind, c.action, c.name, c.fields])).toEqual([
      ['dataTable', 'update', 'Leads', ['+column score']],
      ['dataTable', 'create', 'Orders', undefined],
    ]);
    expect(dataTables().getTable(leads.id).columns.map((c) => c.name)).toEqual(['email', 'score']);
    expect(dataTables().getTable('dt_orders').name).toBe('Orders');
    // Rows are untouched.
    expect(dataTables().listRows(leads.id).total).toBe(1);

    const retyped = edit(files, 'data-tables/leads.schema.json', (doc) => {
      doc.columns = [{ name: 'email', type: 'number' }, { name: 'score', type: 'number' }];
    });
    const refused = await apply({ files: retyped });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0]).toMatch(/column “email” is string on the instance and number in the file/);

    files = edit(files, 'data-tables/leads.schema.json', (doc) => {
      doc.columns = [{ name: 'email', type: 'string' }];
    });
    expect((await apply({ files })).body.changes.map((c) => [c.fields, c.skipped])).toEqual([[['-column score'], 'prune']]);
    expect((await apply({ files, prune: true })).body.appliedCount).toBe(1);
    expect(dataTables().getTable(leads.id).columns.map((c) => c.name)).toEqual(['email']);
    base = await exported();
  });

  it('syncs variables: names create empty ones, values update, prune deletes', async () => {
    let files = edit(filesOf(base), 'variables.json', (doc) => {
      doc.variables = [{ key: 'API_BASE' }, { key: 'REGION', value: 'eu' }, { key: 'EMPTY' }];
    });
    const first = await apply({ files });
    expect(first.body.changes.map((c) => [c.action, c.id])).toEqual([
      ['create', 'REGION'],
      ['create', 'EMPTY'],
    ]);
    expect(variables.get('API_BASE')!.value).toBe('https://api.example.com');
    expect(variables.get('EMPTY')!.value).toBe('');
    files = edit(files, 'variables.json', (doc) => {
      doc.variables = [{ key: 'REGION', value: 'us' }];
    });
    const second = await apply({ files, prune: true });
    expect(second.body.changes.map((c) => [c.action, c.id])).toEqual([
      ['update', 'REGION'],
      ['delete', 'API_BASE'],
      ['delete', 'EMPTY'],
    ]);
    expect(variables.list()).toEqual([{ key: 'REGION', value: 'us' }]);
    // Without variables.json, variables are left alone even with prune.
    const none = await apply({ files: files.filter((f) => f.path !== 'variables.json'), prune: true });
    expect(none.body.changes.filter((c) => c.kind === 'variable')).toEqual([]);
  });

  it('publishes workflows whose file says active, and unpublishes those it turns off', async () => {
    const { publishedVersionId } = await import('@/lib/server/publications');
    base = await exported();
    const path = 'workflows/top-flow-renamed.workflow.json';
    let files = edit(filesOf(base), path, (doc) => {
      doc.active = true;
    });
    expect((await apply({ files })).status).toBe(200);
    const first = publishedVersionId('wf_top');
    expect(first).toBeDefined();
    expect(store.getWorkflow('wf_top')!.active).toBe(true);
    // Changing an active workflow's graph publishes the new version (a plain save would only be a draft).
    files = edit(files, path, (doc) => {
      (doc.nodes as Array<Record<string, unknown>>)[0].notes = 'v2';
    });
    expect((await apply({ files })).body.changes.map((c) => c.fields)).toEqual([['nodes']]);
    expect(publishedVersionId('wf_top')).toBeDefined();
    expect(publishedVersionId('wf_top')).not.toBe(first);
    files = edit(files, path, (doc) => {
      doc.active = false;
    });
    await apply({ files });
    expect(publishedVersionId('wf_top')).toBeUndefined();
    expect(store.getWorkflow('wf_top')!.active).toBe(false);
  });
});

describe('background runs for the CLI', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('starts a run, follows it, and refuses to stop one that ended', async () => {
    store.saveWorkflow(workflow('wf_run', 'Runnable'));
    const response = await executeRoute.POST(new Request('http://sync.test/api/workflows/wf_run/execute', { method: 'POST', body: JSON.stringify({ input: { hello: 'world' } }) }), ctx('wf_run'));
    expect(response.status).toBe(202);
    const started = (await response.json()) as { executionId: string; status: string };
    expect(started.status).toBe('running');
    let status = 'running';
    for (let i = 0; i < 100 && (status === 'running' || status === 'queued'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const read = await executionRoute.GET(new Request(`http://sync.test/api/executions/${started.executionId}`), ctx(started.executionId));
      status = ((await read.json()) as { execution: { status: string } }).execution.status;
    }
    expect(status).toBe('success');
    const stop = await stopRoute.POST(new Request(`http://sync.test/api/executions/${started.executionId}/stop`, { method: 'POST' }), ctx(started.executionId));
    expect(stop.status).toBe(409);
    expect((await stopRoute.POST(new Request('http://sync.test/x', { method: 'POST' }), ctx('ex_missing'))).status).toBe(404);
    expect((await executeRoute.POST(new Request('http://sync.test/x', { method: 'POST' }), ctx('wf_missing'))).status).toBe(404);
    expect((await executeRoute.POST(new Request('http://sync.test/x', { method: 'POST', body: JSON.stringify({ startNode: 'Nope' }) }), ctx('wf_run'))).status).toBe(404);
  });
});
