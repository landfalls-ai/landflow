import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { applyVersion, deleteVersions, diffWorkflows, getVersion, listVersions, markRestored, MAX_VERSIONS, recordVersion, summarizeDiff, versionHash } from '@/lib/server/versions';

const { store } = await import('@/lib/server/store');

let counter = 0;
const uniqueId = (label: string) => `wf_versions_${label}_${process.pid}_${++counter}`;

const node = (id: string, name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  name,
  type: 'core.noOp',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
  ...extra,
});

function workflow(id: string, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: 'Versioned',
    nodes: [node('a', 'Start', { type: 'core.manualTrigger' }), node('b', 'HTTP Request', { type: 'core.httpRequest', position: [260, 0], parameters: { url: 'https://a' } })],
    connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
    ...patch,
  };
}

describe('versionHash', () => {
  it('ignores key order, name, tags and edge ids that do not matter', () => {
    const base = workflow('x');
    const reordered: Workflow = { ...base, name: 'Renamed', tags: ['t'], nodes: base.nodes.map((n) => ({ parameters: n.parameters, position: n.position, typeVersion: n.typeVersion, type: n.type, name: n.name, id: n.id })) };
    expect(versionHash(reordered)).toBe(versionHash(base));
    expect(versionHash({ ...base, settings: { timezone: 'Europe/Paris' } })).not.toBe(versionHash(base));
    expect(versionHash({ ...base, stickyNotes: [{ id: 's', content: 'hi', position: [0, 0], width: 200, height: 120 }] })).not.toBe(versionHash(base));
  });
});

describe('diffWorkflows and summarizeDiff', () => {
  const prev = workflow('d');

  it('describes the first version', () => {
    expect(summarizeDiff(diffWorkflows(undefined, prev), true)).toBe('Created with 2 nodes');
  });

  it('lists added and removed nodes by name, capped at two', () => {
    const next = workflow('d', {
      nodes: [prev.nodes[0], node('c', 'Set'), node('d', 'Code'), node('e', 'If')],
      connections: [],
    });
    const diff = diffWorkflows(prev, next);
    expect(diff.nodesAdded).toEqual(['Set', 'Code', 'If']);
    expect(diff.nodesRemoved).toEqual(['HTTP Request']);
    expect(diff.connectionsRemoved).toBe(1);
    expect(summarizeDiff(diff, false)).toBe('3 nodes added (Set, Code, …) · 1 removed (HTTP Request) · connections changed');
  });

  it('tells changed parameters from a move', () => {
    const changed = workflow('d', { nodes: [prev.nodes[0], { ...prev.nodes[1], parameters: { url: 'https://b' } }] });
    expect(diffWorkflows(prev, changed).nodesChanged).toEqual(['HTTP Request']);
    expect(summarizeDiff(diffWorkflows(prev, changed), false)).toBe('1 changed (HTTP Request)');

    const moved = workflow('d', { nodes: [prev.nodes[0], { ...prev.nodes[1], position: [400, 80] }] });
    const diff = diffWorkflows(prev, moved);
    expect(diff.nodesChanged).toEqual([]);
    expect(diff.nodesMoved).toEqual(['HTTP Request']);
    expect(summarizeDiff(diff, false)).toBe('Layout changed');
  });

  it('compares connections by their ends, not their ids', () => {
    const sameEnds = workflow('d', { connections: [{ ...prev.connections[0], id: 'other' }] });
    expect(summarizeDiff(diffWorkflows(prev, sameEnds), false)).toBe('No changes');
    const rewired = workflow('d', { connections: [{ ...prev.connections[0], sourceIndex: 1 }] });
    const diff = diffWorkflows(prev, rewired);
    expect([diff.connectionsAdded, diff.connectionsRemoved]).toEqual([1, 1]);
    expect(summarizeDiff(diff, false)).toBe('Connections changed');
  });

  it('reports settings and sticky notes', () => {
    expect(summarizeDiff(diffWorkflows(prev, workflow('d', { settings: { timeoutSeconds: 30 } })), false)).toBe('Settings changed');
    expect(summarizeDiff(diffWorkflows(prev, workflow('d', { stickyNotes: [{ id: 's', content: '# Note', position: [0, 0], width: 240, height: 160 }] })), false)).toBe(
      'Sticky notes changed',
    );
  });
});

describe('recordVersion', () => {
  it('records a version per change and skips unchanged saves', () => {
    const id = uniqueId('dedupe');
    const first = recordVersion(workflow(id));
    expect(first).toMatchObject({ number: 1, nodeCount: 2, summary: 'Created with 2 nodes' });
    expect(recordVersion({ ...workflow(id), name: 'Only the name changed' })).toBeUndefined();
    const second = recordVersion(workflow(id, { settings: { timezone: 'UTC' } }));
    expect(second).toMatchObject({ number: 2, summary: 'Settings changed' });
    expect(listVersions(id).map((v) => v.number)).toEqual([2, 1]);
    expect(getVersion(id, first!.id)?.workflow.settings).toBeUndefined();
    expect(getVersion(id, second!.id)?.workflow.settings).toEqual({ timezone: 'UTC' });
    expect(getVersion(id, '../etc')).toBeUndefined();
  });

  it(`keeps the newest ${MAX_VERSIONS} and deletes older files`, () => {
    const id = uniqueId('cap');
    const ids: string[] = [];
    for (let i = 0; i < MAX_VERSIONS + 5; i++) ids.push(recordVersion(workflow(id, { settings: { timeoutSeconds: i + 1 } }))!.id);
    const versions = listVersions(id);
    expect(versions).toHaveLength(MAX_VERSIONS);
    expect(versions[0].number).toBe(MAX_VERSIONS + 5);
    expect(versions.at(-1)!.number).toBe(6);
    expect(getVersion(id, ids[0])).toBeUndefined();
    expect(getVersion(id, ids[5])).toBeDefined();
    const dir = join(process.env.LANDFLOW_DATA_DIR!, 'workflow-versions', id);
    expect(existsSync(join(dir, `${ids[4]}.json`))).toBe(false);
    deleteVersions(id);
    expect(existsSync(dir)).toBe(false);
    expect(listVersions(id)).toEqual([]);
  });
});

describe('store integration and restore', () => {
  it('records a version on every saveWorkflow that changes the graph, and restores an older one as a new version', () => {
    const id = uniqueId('store');
    store.saveWorkflow({ ...workflow(id), tags: ['ops'] });
    store.saveWorkflow({ ...workflow(id), tags: ['ops'] }); // unchanged: no version
    const edited = workflow(id, {
      nodes: [...workflow(id).nodes, node('c', 'Set', { position: [520, 0] })],
      connections: [...workflow(id).connections, { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 }],
      pinData: { a: [{ json: { pinned: true } }] },
    });
    store.saveWorkflow({ ...edited, name: 'Renamed', tags: ['ops', 'new'] });
    const versions = listVersions(id);
    expect(versions.map((v) => v.summary)).toEqual(['1 node added (Set) · connections changed', 'Created with 2 nodes']);

    const first = getVersion(id, versions[1].id)!;
    const restoredDoc = applyVersion(store.getWorkflow(id)!, first);
    expect(restoredDoc).toMatchObject({ name: 'Renamed', tags: ['ops', 'new'] });
    expect(restoredDoc.pinData).toBeUndefined();
    store.saveWorkflow(restoredDoc);
    const after = listVersions(id);
    expect(after).toHaveLength(3);
    expect(after[0].summary).toBe('1 removed (Set) · connections changed');
    const marked = markRestored(id, after[0].id, { id: first.id, number: first.number });
    expect(marked).toMatchObject({ restoredFrom: { id: first.id, number: 1 }, summary: 'Restored version 1 · 1 removed (Set) · connections changed' });
    expect(listVersions(id)[0].summary).toBe(marked!.summary);
    expect(getVersion(id, after[0].id)?.restoredFrom).toEqual({ id: first.id, number: 1 });
    expect(store.getWorkflow(id)!.nodes.map((n) => n.name)).toEqual(['Start', 'HTTP Request']);

    store.deleteWorkflow(id);
    deleteVersions(id);
    expect(listVersions(id)).toEqual([]);
  });
});
