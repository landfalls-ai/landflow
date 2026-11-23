/**
 * Saving and deleting a workflow (app/api/workflows/[id]/route.ts): a save that says which version it is based on
 * (`If-Match: "<updatedAt>"`, or body `baseUpdatedAt`) is refused with 412 `workflow_conflict` when the stored one moved on;
 * without it the last write wins; a delete removes the workflow, its versions, publications and project rows in one
 * transaction or none of them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-workflow-concurrency-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { listVersions } = await import('@/lib/server/versions');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const versions = await import('@/lib/server/versions');
const publications = await import('@/lib/server/publications');
const projectStore = await import('@/lib/server/projects/store');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const trigger = { id: 'm', name: 'Manual', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }), ...(body === undefined && { headers }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function create(name: string): Promise<Workflow> {
  const response = await workflowsRoute.POST(req('POST', '/api/workflows', { name, nodes: [trigger], connections: [] }));
  return ((await response.json()) as { workflow: Workflow }).workflow;
}
const save = (workflow: Workflow, patch: Record<string, unknown>, headers: Record<string, string> = {}) =>
  workflowRoute.PUT(req('PUT', `/api/workflows/${workflow.id}`, { ...workflow, ...patch }, headers), params(workflow.id));

describe('PUT /api/workflows/[id] with a base version', () => {
  it('saves with the right If-Match and refuses a stale one with 412 and the stored version', async () => {
    const opened = await create('Concurrent');
    await wait(5);
    const first = await save(opened, { name: 'Tab A' }, { 'if-match': `"${opened.updatedAt}"` });
    expect(first.status).toBe(200);
    const saved = ((await first.json()) as { workflow: Workflow }).workflow;
    expect(saved.updatedAt).not.toBe(opened.updatedAt);

    // Tab B still holds the version it opened.
    const stale = await save(opened, { name: 'Tab B' }, { 'if-match': `"${opened.updatedAt}"` });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ error: 'This workflow changed since you opened it', code: 'workflow_conflict', current: { updatedAt: saved.updatedAt } });
    expect(store.getWorkflow(opened.id)?.name).toBe('Tab A');

    // Tab B reloads: its new base is accepted (weak tags too).
    const retry = await save(saved, { name: 'Tab B' }, { 'if-match': `W/"${saved.updatedAt}"` });
    expect(retry.status).toBe(200);
    expect(store.getWorkflow(opened.id)?.name).toBe('Tab B');
  });

  it('takes the base from the body (baseUpdatedAt) and never stores it', async () => {
    const opened = await create('Body base');
    await wait(5);
    expect((await save(opened, { name: 'Moved on' })).status).toBe(200);
    const stale = await save(opened, { name: 'Late', baseUpdatedAt: opened.updatedAt });
    expect(stale.status).toBe(412);
    const current = store.getWorkflow(opened.id)!;
    const fine = await save(current, { name: 'Fine', baseUpdatedAt: current.updatedAt });
    expect(fine.status).toBe(200);
    expect(store.getWorkflow(opened.id)).not.toHaveProperty('baseUpdatedAt');
  });

  it('without a base the last write wins (API, CLI and MCP clients)', async () => {
    const opened = await create('Last write');
    await wait(5);
    expect((await save(opened, { name: 'One' })).status).toBe(200);
    expect((await save(opened, { name: 'Two' })).status).toBe(200);
    expect(store.getWorkflow(opened.id)?.name).toBe('Two');
  });
});

describe('DELETE /api/workflows/[id]', () => {
  it('removes the workflow and its versions together', async () => {
    const workflow = await create('Gone');
    expect(listVersions(workflow.id).length).toBeGreaterThan(0);
    const response = await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params(workflow.id));
    expect(response.status).toBe(200);
    expect(store.getWorkflow(workflow.id)).toBeUndefined();
    expect(listVersions(workflow.id)).toHaveLength(0);
    expect((await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params(workflow.id))).status).toBe(404);
  });

  it('is atomic: when one of the writes throws, nothing is deleted', async () => {
    const workflow = await create('Stays');
    const before = listVersions(workflow.id).length;
    const spy = vi.spyOn(versions, 'deleteVersions').mockImplementation(() => {
      // The workflow row was deleted in the same transaction just before this call.
      throw new Error('disk full');
    });
    const listeners = vi.fn();
    const off = store.onWorkflowsChanged(listeners);
    try {
      const response = await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params(workflow.id));
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain('disk full');
    } finally {
      spy.mockRestore();
      off();
    }
    expect(store.getWorkflow(workflow.id)).toBeDefined();
    expect(database().get<{ id: string }>('SELECT id FROM workflows WHERE id = ?', workflow.id)).toBeDefined();
    expect(listVersions(workflow.id)).toHaveLength(before);
    expect(listeners).not.toHaveBeenCalled();
  });

  it('is atomic when the last write throws: the publication stays and its listeners hear nothing', async () => {
    const workflow = await create('Published');
    const [version] = listVersions(workflow.id);
    publications.setPublication(workflow.id, version!.id);
    const heard = vi.fn();
    const off = publications.onPublicationChanged(heard);
    // The project rows go last, after the versions and the publication.
    const spy = vi.spyOn(projectStore, 'forgetResource').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      const response = await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params(workflow.id));
      expect(response.status).toBe(500);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(store.getWorkflow(workflow.id)).toBeDefined();
    expect(publications.publishedVersionId(workflow.id)).toBe(version!.id);
    expect(heard).not.toHaveBeenCalled();

    // Deleted for real, the listeners hear of it once, after the commit.
    expect((await workflowRoute.DELETE(req('DELETE', `/api/workflows/${workflow.id}`), params(workflow.id))).status).toBe(200);
    expect(publications.publishedVersionId(workflow.id)).toBeUndefined();
    expect(heard).toHaveBeenCalledWith(workflow.id);
    off();
  });
});
