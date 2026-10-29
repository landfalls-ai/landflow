/**
 * Composite types on the host (docs/composites.md): the registry lists what plugins declare (core's `core.aiStep` and
 * the triage plugin's `triage.aiTriage`), the library saves `local.<name>` types with a new version per save, and
 * /api/composites lists, saves and deletes them (only whoever saved one, or an owner or admin, deletes it). A version
 * whose frames break their contract can't be published; warnings don't stop it. A run treats a frame whose type falls
 * back as one step: a node failing in it sends what entered the frame to its fallback, and the run goes on.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { CompositeTypeDescriptor } from '@landflow/protocol';
import type { CompositeTypeInfo } from '@/lib/shared/composites';
import type { UserRecord } from '@/lib/shared/auth';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-composite-types-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { listCompositeTypes, saveLocalComposite, serverCompositeLookup, workflowCompositeIssues, workflowScopes, CompositeError } = await import('@/lib/server/composites');
const { runWorkflow } = await import('@/lib/server/runner');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const listRoute = await import('@/app/api/composites/route');
const itemRoute = await import('@/app/api/composites/[type]/route');
const { instantiateComposite } = await import('@/lib/shared/composites');
const { store } = await import('@/lib/server/store');
const { publishDraft, PublishError } = await import('@/lib/server/publish');
const { importTemplate } = await import('@/lib/server/templates');
const { localTemplates } = await import('@/lib/server/templates/store');

registry.registerBuiltin(corePlugin);
const triage = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'plugin-manifests', 'triage.json'), 'utf8'));
registry.registerBuiltin({ info: triage.plugin, nodes: triage.nodes.map((description: unknown) => ({ description, execute: async () => [[]] })), composites: triage.composites } as unknown as IPlugin);
const threatIntel = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'plugin-manifests', 'threat-intel.json'), 'utf8'));
registry.registerBuiltin({ info: threatIntel.plugin, nodes: threatIntel.nodes.map((description: unknown) => ({ description, execute: async () => [[]] })) } as unknown as IPlugin);
const { validateOps } = await import('@/lib/server/assistant/ops');
const { compositeOutline } = await import('@/lib/server/composites');
const triageFlow = () => {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'plugins/triage/flows/alert-triage-to-landfall.json'), 'utf8'));
  return { id: 'wf_triage', name: 'Triage', active: false, ...file.template.workflow };
};

afterAll(() => enableTestAuth());

const call = async (route: (request: Request, ctx: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown } = {}, type?: string) => {
  const request = new Request(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined && { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  });
  const response = await route(request, (type ? { params: Promise.resolve({ type }) } : undefined) as never);
  return { status: response.status, body: await response.json() };
};

const bare = (name: string, version = 1): CompositeTypeDescriptor => ({
  name,
  displayName: 'Enrich then post',
  description: 'Looks the alert up, then posts it',
  version,
  slots: [{ name: 'post', displayName: 'Post', accepts: { type: 'core.httpRequest' } }],
});

describe('composite types', () => {
  it('come from the plugins, core’s included', () => {
    const types = listCompositeTypes().map((t) => [t.type, t.source.kind, t.versions, t.available]);
    expect(types).toEqual([
      ['core.aiStep', 'plugin', [1], true],
      ['triage.aiTriage', 'plugin', [1], true],
    ]);
    expect(workflowCompositeIssues(triageFlow())).toEqual([]);
  });

  it('check a starter of core’s AI step clean against the registry', () => {
    const lookup = serverCompositeLookup();
    const made = instantiateComposite('core.aiStep', lookup.composite('core.aiStep')!, { x: 0, y: 0 }, { takenNames: [], newId: (() => { let n = 0; return () => `n${++n}`; })(), groupId: 'g1' });
    expect(workflowCompositeIssues({ nodes: made.nodes, connections: made.connections, groups: [made.group] })).toEqual([]);
    // Without the model connection, the rule fails.
    expect(workflowCompositeIssues({ nodes: made.nodes, connections: [], groups: [made.group] }).map((i) => i.code)).toEqual(['feeds']);
  });

  it('save to the library with a new version each time', () => {
    const first = saveLocalComposite(bare('enrichPost'), 'u1');
    expect(first).toMatchObject({ type: 'local.enrichPost', source: { kind: 'local', createdBy: 'u1' }, versions: [1], available: true });
    const second = saveLocalComposite({ ...bare('enrichPost'), description: 'v2' });
    expect(second.versions).toEqual([2, 1]);
    expect(second.descriptor).toMatchObject({ version: 2, description: 'v2' });
    expect(second.all?.map((d) => d.version)).toEqual([2, 1]);
    expect(serverCompositeLookup().composite('local.enrichPost', 1)?.description).toBe('Looks the alert up, then posts it');
    expect(saveLocalComposite(bare('enrichPost', 7)).versions[0]).toBe(7);
    expect(() => saveLocalComposite({ ...bare('bad name'), slots: [] })).toThrow(CompositeError);
  });
});

describe('/api/composites', () => {
  it('lists, saves and deletes', async () => {
    const list = await call(listRoute.GET, '/api/composites');
    expect(list.status).toBe(200);
    expect(list.body.composites.map((t: CompositeTypeInfo) => t.type)).toEqual(expect.arrayContaining(['core.aiStep', 'triage.aiTriage', 'local.enrichPost']));

    const saved = await call(listRoute.POST, '/api/composites', { method: 'POST', body: { descriptor: bare('saveMe') } });
    expect(saved.status).toBe(201);
    expect(saved.body.composite).toMatchObject({ type: 'local.saveMe', versions: [1], source: { createdBy: TEST_OWNER.id } });
    const invalid = await call(listRoute.POST, '/api/composites', { method: 'POST', body: { descriptor: { name: 'x' } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.length).toBeGreaterThan(0);

    expect((await call(itemRoute.DELETE, '/api/composites/triage.aiTriage', { method: 'DELETE' }, 'triage.aiTriage')).status).toBe(400);
    expect((await call(itemRoute.DELETE, '/api/composites/local.nope', { method: 'DELETE' }, 'local.nope')).status).toBe(404);
    expect((await call(itemRoute.DELETE, '/api/composites/local.saveMe', { method: 'DELETE' }, 'local.saveMe')).body).toEqual({ ok: true });
    expect(listCompositeTypes().some((t) => t.type === 'local.saveMe')).toBe(false);
  });

  it('lets only whoever saved a type, or an owner or admin, delete it', async () => {
    saveLocalComposite(bare('theirs'), 'someone-else');
    enableTestAuth({ ...TEST_OWNER, id: 'u_member', role: 'member' } as UserRecord);
    expect((await call(itemRoute.DELETE, '/api/composites/local.theirs', { method: 'DELETE' }, 'local.theirs')).status).toBe(403);
    enableTestAuth({ ...TEST_OWNER, id: 'someone-else', role: 'member' } as UserRecord);
    expect((await call(itemRoute.DELETE, '/api/composites/local.theirs', { method: 'DELETE' }, 'local.theirs')).status).toBe(200);
    enableTestAuth();
  });
});

describe('publishing', () => {
  it('is blocked by a broken contract and not by a warning', async () => {
    let n = 0;
    const made = instantiateComposite('core.aiStep', serverCompositeLookup().composite('core.aiStep')!, { x: 300, y: 0 }, { takenNames: [], newId: () => `n${++n}`, groupId: 'g1' });
    const trigger = { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} };
    const workflow = store.saveWorkflow({ id: 'wf_gate', name: 'Gate', active: false, nodes: [trigger, ...made.nodes], connections: [], groups: [made.group] } as never);
    const refused = await publishDraft(workflow.id).catch((caught) => caught);
    expect(refused).toBeInstanceOf(PublishError);
    expect(refused.status).toBe(422);
    expect(refused.message).toMatch(/composite’s contract.*Chat model isn’t connected to “AI Agent”/);

    // Wired up, it publishes; a type gone missing is only a warning.
    store.saveWorkflow({ ...store.getWorkflow(workflow.id)!, connections: made.connections });
    expect((await publishDraft(workflow.id)).published).toBeTruthy();
    const unknown = { ...made.group, composite: { ...made.group.composite!, type: 'local.gone' } };
    store.saveWorkflow({ ...store.getWorkflow(workflow.id)!, connections: [], groups: [unknown] });
    expect((await publishDraft(workflow.id)).published).toBeTruthy();
  });
});

describe('templates', () => {
  it('leave nothing behind when a saved one’s detail can’t be built', () => {
    // A marketplace install rolls back only the templates it was handed: one saved before its check failed would stay.
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'plugins/triage/flows/alert-triage-to-landfall.json'), 'utf8'));
    const before = localTemplates.list().length;
    const spy = vi.spyOn(registry, 'compositeTypes').mockImplementation(() => {
      throw new Error('registry reloading');
    });
    try {
      expect(() => importTemplate(file)).toThrow('registry reloading');
    } finally {
      spy.mockRestore();
    }
    expect(localTemplates.list()).toHaveLength(before);
    expect(importTemplate(file).problems.filter((p) => p.kind === 'contract')).toEqual([]);
  });
});

describe('the assistant', () => {
  it('sees the contracts in its context', () => {
    const outline = compositeOutline(triageFlow());
    expect(outline).toContain('“AI triage (fail-open)” is typed by the composite AI triage (triage.aiTriage v1)');
    expect(outline).toContain('AI model (one; takes a chat model): “Claude”');
    expect(outline).toContain('Rules: AI model feeds Reasoner; Enrichment and Reasoner continue on error');
    expect(outline).toContain('Not in a slot: “Alert + verdict”');
  });

  it('warns about an edit that breaks a contract, not about what was already broken', () => {
    const wf = triageFlow();
    const model = wf.nodes.find((n: { id: string }) => n.id === 'model');
    const removed = validateOps(wf, [{ op: 'removeNode', node: model.name }]);
    expect(removed.ops).toHaveLength(1);
    expect(removed.warnings).toContain('the composite contract: AI model is empty: add a chat model');
    const renamed = validateOps(wf, [{ op: 'renameNode', node: 'Alert + verdict', name: 'Join both' }]);
    expect(renamed.warnings.filter((w) => w.startsWith('the composite contract'))).toEqual([]);
  });
});

describe('running', () => {
  it('falls back from a frame whose type says so, with the type’s properties as $composite.params', async () => {
    saveLocalComposite({
      name: 'guarded',
      displayName: 'Guarded step',
      description: 'A step that must not stop the run',
      version: 1,
      slots: [{ name: 'step', displayName: 'Step', accepts: { type: 'core.stopAndError' } }],
      onError: 'fallback',
      properties: [{ name: 'label', displayName: 'Label', type: 'string', default: 'guarded' }],
    });
    const workflow = {
      id: 'wf_guarded',
      name: 'Guarded',
      active: false,
      nodes: [
        { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} },
        { id: 'fail', name: 'Fail', type: 'core.stopAndError', typeVersion: 1, position: [240, 0] as [number, number], parameters: { message: 'failed in {{ $composite.params.label }}' } },
        { id: 'handle', name: 'Handle', type: 'core.noOp', typeVersion: 1, position: [480, 120] as [number, number], parameters: {} },
      ],
      connections: [{ id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'fail', targetIndex: 0 }],
      groups: [{ id: 'g1', name: 'Guard', nodeIds: ['fail'], position: [200, -60] as [number, number], width: 300, height: 200, composite: { type: 'local.guarded', version: 1, slots: { step: ['fail'] }, fallback: [{ target: 'handle' }] } }],
    };
    expect(workflowScopes(workflow)).toEqual([expect.objectContaining({ id: 'g1', onError: 'fallback', fallback: [{ target: 'handle', targetIndex: 0 }], params: { label: 'guarded' } })]);
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'start' });
    expect(record.status).toBe('success');
    expect(record.runData.fail?.[0]?.status).toBe('error');
    expect(record.runData.handle?.[0]?.outputs[0]?.[0]?.json.error).toEqual({ message: 'failed in guarded', node: 'Fail', composite: 'Guard' });
    // A plain group runs as before: the failure stops the run.
    const plain = await runWorkflow({ workflow: { ...workflow, groups: [{ ...workflow.groups[0], composite: undefined }] }, mode: 'manual', startNodeId: 'start' });
    expect(plain.status).toBe('error');
  });
});
