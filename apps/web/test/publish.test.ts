/**
 * Draft and publish (lib/server/publish.ts): saves are drafts, production triggers (webhooks, forms, Execute Workflow
 * from production runs) run the published version, manual runs the draft; publish with a note, rollback to an older
 * version, unpublish, the legacy `active` flag, executions that record the version they ran, the boot check and
 * migration 200 for workflows that were active before.
 */
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-publish-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://publish.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { listVersions, recordVersion } = await import('@/lib/server/versions');
const { runWorkflow } = await import('@/lib/server/runner');
const publish = await import('@/lib/server/publish');
const { getPublication, publishedVersionId } = await import('@/lib/server/publications');
const { database } = await import('@/lib/server/db');
const { migrateSqlite } = await import('@/lib/server/db/database');
const { MIGRATIONS } = await import('@/lib/server/db/schema');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const unpublishRoute = await import('@/app/api/workflows/[id]/unpublish/route');
const publicationRoute = await import('@/app/api/workflows/[id]/publication/route');
const versionsRoute = await import('@/app/api/workflows/[id]/versions/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
const setV = (value: number | string) => node('Set', 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'v', type: 'string', value: String(value) }] } }, 220);
const edge = (source: string, target: string, id = `${source}-${target}`) => ({ id, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

function hookWorkflow(id: string, path: string, value: number | string, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Hook ${id}`,
    nodes: [node('Hook', 'core.webhook', { path, method: 'POST', respond: 'lastNode' }), setV(value)],
    connections: [edge('Hook', 'Set')],
    ...extra,
  };
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const call = (path: string) =>
  webhookRoute.POST(new Request(`http://publish.test/api/webhook/${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), params({ path: path.split('/') }));
const post = (url: string, body?: unknown) =>
  new Request(`http://publish.test${url}`, { method: 'POST', ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

/** The webhook's answer: the Set node's `v`, or the HTTP status when it didn't run. */
async function served(path: string): Promise<string | number> {
  const response = await call(path);
  if (response.status !== 200) return response.status;
  return ((await response.json()) as { v: string }).v;
}

// ---------------------------------------------------------------------------
// Draft and publish
// ---------------------------------------------------------------------------

describe('draft and publish', () => {
  it('serves only the published version; saves stay drafts until published', async () => {
    const id = 'wf_pub_basic';
    store.saveWorkflow(hookWorkflow(id, 'pub-basic', 1));
    expect(await served('pub-basic')).toBe(404);

    const first = await publish.publishDraft(id, 'user_a', 'First release');
    expect(first.published).toMatchObject({ versionNumber: 1, publishedBy: 'user_a', note: 'First release' });
    expect(first.unpublishedChanges).toBe(false);
    expect(store.getWorkflow(id)?.active).toBe(true);
    expect(await served('pub-basic')).toBe('1');

    // A save of the active workflow changes the draft only.
    store.saveWorkflow({ ...store.getWorkflow(id)!, nodes: hookWorkflow(id, 'pub-basic', 2).nodes });
    expect(await served('pub-basic')).toBe('1');
    const status = await publish.publicationStatus(id);
    expect(status).toMatchObject({ published: { versionNumber: 1 }, draft: { versionNumber: 2 }, unpublishedChanges: true });

    // Manual runs (the editor) run the draft, and say which version they ran.
    const manual = await runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: 'Hook', triggerItems: [{ json: {} }] });
    expect(manual.runData.Set[0].outputs[0][0].json).toEqual({ v: '2' });
    expect(manual).toMatchObject({ versionNumber: 2, versionPublished: false });

    // Production runs record the published version.
    await served('pub-basic');
    const production = store.listExecutions({ workflowId: id }).find((e) => e.mode === 'webhook')!;
    expect(production).toMatchObject({ versionNumber: 1, versionPublished: true });
    expect(store.getExecution(production.id)).toMatchObject({ versionNumber: 1, versionPublished: true });
  });

  it('publishes, rolls back and unpublishes through the API', async () => {
    const id = 'wf_pub_api';
    store.saveWorkflow(hookWorkflow(id, 'pub-api', 'one'));
    const v1 = listVersions(id)[0];
    store.saveWorkflow(hookWorkflow(id, 'pub-api', 'two'));

    const published = await publishRoute.POST(post(`/api/workflows/${id}/publish`, { note: 'Ship two' }), params({ id }));
    expect(published.status).toBe(200);
    const body = await published.json();
    expect(body).toMatchObject({ published: { versionNumber: 2, note: 'Ship two' }, unpublishedChanges: false, triggerErrors: [] });
    expect(await served('pub-api')).toBe('two');

    // Rollback: publish the older version.
    const rollback = await publishRoute.POST(post(`/api/workflows/${id}/publish`, { versionId: v1.id, note: 'Back to one' }), params({ id }));
    expect((await rollback.json()).published).toMatchObject({ versionId: v1.id, versionNumber: 1 });
    expect(await served('pub-api')).toBe('one');
    const versions = await (await versionsRoute.GET(new Request('http://publish.test'), params({ id }))).json();
    expect(versions.publishedVersionId).toBe(v1.id);
    // The published version is what the draft is compared with: the newer draft counts as unpublished changes.
    const status = await (await publicationRoute.GET(new Request('http://publish.test'), params({ id }))).json();
    expect(status).toMatchObject({ unpublishedChanges: true, draft: { versionNumber: 2 } });
    expect(status.log.map((entry: { action: string; versionNumber: number; note?: string }) => [entry.action, entry.versionNumber, entry.note])).toEqual([
      ['publish', 1, 'Back to one'],
      ['publish', 2, 'Ship two'],
    ]);

    const unpublished = await unpublishRoute.POST(post(`/api/workflows/${id}/unpublish`), params({ id }));
    expect((await unpublished.json()).published).toBeUndefined();
    expect(store.getWorkflow(id)?.active).toBe(false);
    expect(await served('pub-api')).toBe(404);
    expect((await publish.publicationStatus(id)).log[0]).toMatchObject({ action: 'unpublish', versionNumber: 1 });

    const missing = await publishRoute.POST(post(`/api/workflows/${id}/publish`, { versionId: 'nope' }), params({ id }));
    expect(missing.status).toBe(404);
  });

  it('keeps the active flag working for older clients', async () => {
    const id = 'wf_pub_legacy';
    const put = (body: Partial<Workflow>) =>
      workflowRoute.PUT(new Request(`http://publish.test/api/workflows/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params({ id }));
    store.saveWorkflow(hookWorkflow(id, 'pub-legacy', 'a'));

    // active: true publishes; saving again with active: true puts the save live, as it used to.
    expect((await put({ ...hookWorkflow(id, 'pub-legacy', 'a'), active: true })).status).toBe(200);
    expect(await served('pub-legacy')).toBe('a');
    await put({ ...hookWorkflow(id, 'pub-legacy', 'b'), active: true });
    expect(await served('pub-legacy')).toBe('b');
    // The editor leaves `active` out: a draft.
    const { active: _active, ...draft } = hookWorkflow(id, 'pub-legacy', 'c');
    await put(draft);
    expect(store.getWorkflow(id)?.active).toBe(true);
    expect(await served('pub-legacy')).toBe('b');
    // active: false unpublishes.
    await put({ ...draft, active: false });
    expect(publishedVersionId(id)).toBeUndefined();
    expect(await served('pub-legacy')).toBe(404);
  });

  it('runs the published version of a sub-workflow from production runs, the draft from manual runs', async () => {
    const child = (value: string): Workflow => ({
      id: 'wf_pub_child',
      name: 'Child',
      nodes: [node('Called', 'core.workflowTrigger', { inputSource: 'passthrough' }), setV(value)],
      connections: [edge('Called', 'Set')],
    });
    store.saveWorkflow(child('published'));
    await publish.publishDraft('wf_pub_child');
    store.saveWorkflow({ ...child('draft'), active: true });

    const parent: Workflow = {
      id: 'wf_pub_parent',
      name: 'Parent',
      nodes: [node('Hook', 'core.webhook', { path: 'pub-parent', method: 'POST', respond: 'lastNode' }), node('Call', 'core.executeWorkflow', { workflowId: 'wf_pub_child' }, 220)],
      connections: [edge('Hook', 'Call')],
    };
    store.saveWorkflow(parent);
    await publish.publishDraft(parent.id);
    expect(await served('pub-parent')).toBe('published');
    const manual = await runWorkflow({ workflow: store.getWorkflow(parent.id)!, mode: 'manual', startNodeId: 'Hook', triggerItems: [{ json: {} }] });
    expect(manual.runData.Call[0].outputs[0][0].json).toEqual({ v: 'draft' });

    // Never published: production calls run the saved workflow (sub-workflows never had to be active).
    store.saveWorkflow({ ...child('saved'), id: 'wf_pub_child_unpublished' });
    expect(publish.workflowForCall('wf_pub_child_unpublished', 'webhook')?.nodes[1].parameters).toMatchObject({ fields: { values: [{ value: 'saved' }] } });
    expect(publish.workflowForCall('wf_pub_child', 'manual')?.nodes[1].parameters).toMatchObject({ fields: { values: [{ value: 'draft' }] } });
    expect(publish.workflowForCall('wf_pub_child', 'trigger')?.nodes[1].parameters).toMatchObject({ fields: { values: [{ value: 'published' }] } });
  });

  it('keeps the published version out of version pruning and through renames', async () => {
    const id = 'wf_pub_rename';
    store.saveWorkflow(hookWorkflow(id, 'pub-rename', 'kept'));
    await publish.publishDraft(id);
    store.saveWorkflow({ ...store.getWorkflow(id)!, name: 'Renamed' });
    // A rename is not a new version: the production graph is the published one, under the saved name.
    expect(publish.productionWorkflowById(id)?.name).toBe('Renamed');
    expect(await served('pub-rename')).toBe('kept');
  });

  it('publishes active workflows that have no publication at boot', () => {
    const id = 'wf_pub_boot';
    store.saveWorkflow({ ...hookWorkflow(id, 'pub-boot', 'x'), active: true });
    // Active without a publication: data imported behind the store's back (an old JSON import, a database restore).
    database().delete('workflow_publications', { workflow_id: id });
    expect(publishedVersionId(id)).toBeUndefined();
    // Until then it runs as saved.
    expect(publish.productionWorkflowById(id)?.nodes).toHaveLength(2);
    expect(publish.ensurePublications()).toBeGreaterThanOrEqual(1);
    expect(getPublication(id)).toMatchObject({ versionNumber: 1, publishedBy: 'migration', note: 'Active before draft and publish' });
  });
});

describe('migration 200', () => {
  it('publishes the newest version of workflows that were active', () => {
    const sqlite = new DatabaseSync(':memory:');
    migrateSqlite(
      sqlite,
      MIGRATIONS.filter((m) => m.version < 200),
    );
    const insertWorkflow = sqlite.prepare('INSERT INTO workflows (id, name, active, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)');
    insertWorkflow.run('wf_old_active', 'Old', 1, '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '{}');
    insertWorkflow.run('wf_old_inactive', 'Off', 0, '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '{}');
    insertWorkflow.run('wf_old_unversioned', 'None', 1, '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', '{}');
    const insertVersion = sqlite.prepare('INSERT INTO workflow_versions (id, workflow_id, number, hash, created_at, summary, workflow) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertVersion.run('v1', 'wf_old_active', 1, 'h1', '2025-01-01T00:00:00.000Z', '{}', '{}');
    insertVersion.run('v2', 'wf_old_active', 2, 'h2', '2025-02-01T00:00:00.000Z', '{}', '{}');
    insertVersion.run('v3', 'wf_old_inactive', 1, 'h3', '2025-02-01T00:00:00.000Z', '{}', '{}');

    const applied = migrateSqlite(sqlite);
    expect(applied).toContain(200);
    expect(sqlite.prepare('SELECT workflow_id, version_id, published_by FROM workflow_publications').all()).toEqual([
      { workflow_id: 'wf_old_active', version_id: 'v2', published_by: 'migration' },
    ]);
    expect(sqlite.prepare('SELECT id, action, version_number FROM workflow_publish_log').all()).toEqual([{ id: 'pl_migrated_wf_old_active', action: 'publish', version_number: 2 }]);
    sqlite.close();
  });
});

describe('versions', () => {
  it('matches an unchanged draft to the published version', () => {
    const id = 'wf_pub_match';
    store.saveWorkflow(hookWorkflow(id, 'pub-match', 1));
    const first = listVersions(id)[0];
    expect(recordVersion(store.getWorkflow(id)!)).toBeUndefined();
    expect(first.number).toBe(1);
  });
});
