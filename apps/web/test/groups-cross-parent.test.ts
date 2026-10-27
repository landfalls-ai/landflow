/**
 * ⌘G across different parents: a selection whose nodes and groups sit in different groups gets a new group inside the
 * lowest group that holds all of them (or at the top level when there is none), the groups and nodes picked move into
 * it, the groups around grow to fit, and undo, collapse, copy and paste, import and export, version diffs and the Git
 * sync file keep working with the result. Nesting itself is groups-nested.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowGroup } from '@landflow/engine';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-groups-cross-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { workflowSchema } = await import('@/lib/server/schemas');
const { ancestorsOf, descendantNodeIds, descendantGroupIds, normalizeGroups } = await import('@/lib/shared/groups');
const { useEditor } = await import('@/components/editor/store');
const { canvasGraph, groupAround, linksOf, toFrames } = await import('@/components/editor/groups');
const { serializeSelection } = await import('@/components/editor/clipboard');
const { diffWorkflows, versionHash } = await import('@/lib/server/versions');
const { workflowDocument } = await import('@/lib/server/sync/format');
const { importWorkflowJson } = await import('@/lib/server/n8n-import');

const node = (id: string, name: string, x: number, y: number, type = 'core.set') => ({ id, name, type, typeVersion: 1, position: [x, y] as [number, number], parameters: {} });

/** t → a → b → c → d → e in a row, 300px apart. */
function workflow(groups: WorkflowGroup[]): Workflow {
  const nodes = [node('t', 'Trigger', 0, 0, 'core.manualTrigger'), node('a', 'A', 300, 0), node('b', 'B', 600, 0), node('c', 'C', 900, 0), node('d', 'D', 1200, 0), node('e', 'E', 1500, 0)];
  return {
    id: 'wf_cross',
    name: 'Cross',
    nodes,
    connections: nodes.slice(1).map((n, i) => ({ id: `e${i}`, type: 'main' as const, source: nodes[i].id, sourceIndex: 0, target: n.id, targetIndex: 0 })),
    groups,
  };
}

/**
 *   Root:  P1 { a, Inner1 { b } }  P2 { c, Inner2 { d } }      (a, b, c, d in a row)
 *   Side:  e (top level)
 */
const tree = (): WorkflowGroup[] => [
  { id: 'root', name: 'Root', nodeIds: [], position: [200, -150], width: 1200, height: 400 },
  { id: 'p1', name: 'P1', nodeIds: ['a'], position: [230, -100], width: 560, height: 300, parentId: 'root' },
  { id: 'in1', name: 'Inner1', nodeIds: ['b'], position: [520, -60], width: 240, height: 220, parentId: 'p1' },
  { id: 'p2', name: 'P2', nodeIds: ['c'], position: [820, -100], width: 560, height: 300, parentId: 'root' },
  { id: 'in2', name: 'Inner2', nodeIds: ['d'], position: [1120, -60], width: 240, height: 220, parentId: 'p2' },
  { id: 'side', name: 'Side', nodeIds: ['e'], position: [1450, 400], width: 220, height: 180 },
];

const editor = () => useEditor.getState();
const frame = (id: string) => editor().groups.find((g) => g.id === id)!;
const select = (...ids: string[]) =>
  editor().onNodesChange([...editor().nodes, ...editor().groups, ...editor().stickies].map((n) => ({ type: 'select' as const, id: n.id, selected: ids.includes(n.id) })));
const links = () => linksOf(editor().groups);
const rect = (g: { position: { x: number; y: number }; width?: number; height?: number }) => ({ x: g.position.x, y: g.position.y, w: g.width ?? 0, h: g.height ?? 0 });
const holds = (outer: ReturnType<typeof frame>, inner: ReturnType<typeof frame>) => {
  const o = rect(outer);
  const i = rect(inner);
  return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
};
const snapshot = () => JSON.stringify(editor().toWorkflow().groups);

beforeEach(() => editor().load(workflow(tree()), []));

describe('⌘G across different parents', () => {
  it('nodes in sibling groups: the new group goes in their shared parent and takes both nodes', () => {
    select('a', 'c');
    const id = editor().groupSelection()!;
    expect(frame(id).data).toMatchObject({ nodeIds: ['a', 'c'], parentId: 'root' });
    expect(frame('p1').data.nodeIds).toEqual([]);
    expect(frame('p2').data.nodeIds).toEqual([]);
    // The groups they left keep their own parents and members.
    expect(frame('in1').data.parentId).toBe('p1');
    expect(frame('p1').data.parentId).toBe('root');
    expect(holds(frame('root'), frame(id))).toBe(true);
    expect(frame(id).selected).toBe(true);
    expect(editor().nodes.some((n) => n.selected)).toBe(false);
  });

  it('nodes at different depths: the lowest group that holds them all', () => {
    select('b', 'd');
    expect(frame(editor().groupSelection()!).data.parentId).toBe('root');
    editor().load(workflow(tree()), []);
    select('a', 'b');
    const id = editor().groupSelection()!;
    expect(frame(id).data.parentId).toBe('p1');
    expect(frame(id).data.nodeIds).toEqual(['a', 'b']);
    expect(frame('in1').data.nodeIds).toEqual([]);
  });

  it('groups with different parents: both move into the new group, with what they hold', () => {
    select('in1', 'in2');
    const id = editor().groupSelection()!;
    expect(frame(id).data.parentId).toBe('root');
    expect(frame('in1').data.parentId).toBe(id);
    expect(frame('in2').data.parentId).toBe(id);
    expect(descendantNodeIds(links(), id).sort()).toEqual(['b', 'd']);
    expect(frame('p1').data.nodeIds).toEqual(['a']);
    expect(holds(frame(id), frame('in1')) && holds(frame(id), frame('in2'))).toBe(true);
    expect(holds(frame('root'), frame(id))).toBe(true);
    expect(ancestorsOf(links(), 'in2')).toEqual([id, 'root']);
  });

  it('a group and a node from another branch, and picks that meet only at the top level', () => {
    select('in1', 'c');
    const first = editor().groupSelection()!;
    expect(frame(first).data.parentId).toBe('root');
    expect(frame(first).data.nodeIds).toEqual(['c']);
    expect(frame('p2').data.nodeIds).toEqual([]);
    editor().load(workflow(tree()), []);
    select('p1', 'e');
    const top = editor().groupSelection()!;
    expect(frame(top).data.parentId).toBeUndefined();
    expect(frame('p1').data.parentId).toBe(top);
    expect(frame(top).data.nodeIds).toEqual(['e']);
    expect(frame('side').data.nodeIds).toEqual([]);
    editor().load(workflow(tree()), []);
    select('root', 'side');
    const both = editor().groupSelection()!;
    expect(frame(both).data.parentId).toBeUndefined();
    expect(frame('root').data.parentId).toBe(both);
    expect(frame('side').data.parentId).toBe(both);
  });

  it('a node picked together with the group that holds it, or a group inside another picked group, comes along instead', () => {
    select('p1', 'b', 'in1', 'c');
    const id = editor().groupSelection()!;
    expect(frame(id).data).toMatchObject({ nodeIds: ['c'], parentId: 'root' });
    expect(frame('p1').data.parentId).toBe(id);
    // B stays in Inner1, which stays in P1.
    expect(frame('in1')).toMatchObject({ data: { nodeIds: ['b'], parentId: 'p1' } });
  });

  it('ignores what is hidden inside a collapsed group', () => {
    editor().updateGroup('p2', { collapsed: true });
    select('a', 'd', 'c');
    const id = editor().groupSelection();
    // D and C are hidden by the collapsed P2; only A is picked, so the new group wraps A alone, inside P1.
    expect(frame(id!).data).toMatchObject({ nodeIds: ['a'], parentId: 'p1' });
    expect(frame('p2').data.nodeIds).toEqual(['c']);
    expect(frame('in2').data.nodeIds).toEqual(['d']);
  });

  it('does nothing without a selection, and keeps every node in exactly one group', () => {
    select();
    expect(editor().groupSelection()).toBeUndefined();
    select('a', 'b', 'c', 'd', 'e');
    const id = editor().groupSelection()!;
    expect(frame(id).data.parentId).toBeUndefined();
    const members = editor().groups.flatMap((g) => g.data.nodeIds);
    expect(new Set(members).size).toBe(members.length);
    expect(members.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(frame(id).data.nodeIds.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never makes a loop, whatever is picked', () => {
    const picks: string[][] = [['p1', 'in2'], ['root', 'in1'], ['in1', 'p2', 'a'], ['p1', 'p2', 'side'], ['b', 'in2', 'e'], ['root', 'a', 'e']];
    for (const pick of picks) {
      editor().load(workflow(tree()), []);
      select(...pick);
      const id = editor().groupSelection()!;
      const normalized = normalizeGroups(editor().toWorkflow().groups, editor().nodes.map((n) => n.id));
      expect(normalized.map((g) => g.parentId)).toEqual(editor().toWorkflow().groups!.map((g) => g.parentId));
      expect(ancestorsOf(links(), id)).not.toContain(id);
      for (const g of editor().groups) expect(descendantGroupIds(links(), g.id)).not.toContain(g.id);
    }
  });
});

describe('with the result', () => {
  it('undo and redo put every parent and member back', () => {
    const before = snapshot();
    select('in1', 'in2', 'a');
    const id = editor().groupSelection()!;
    const after = snapshot();
    expect(after).not.toBe(before);
    editor().undo();
    expect(snapshot()).toBe(before);
    expect(editor().dirty).toBe(false);
    editor().redo();
    expect(snapshot()).toBe(after);
    expect(frame(id).data.parentId).toBe('root');
  });

  it('collapsing the new group hides what came from both branches and routes the connections to it', () => {
    select('a', 'c');
    const id = editor().groupSelection()!;
    editor().updateGroup(id, { collapsed: true });
    const { nodes, edges } = canvasGraph(editor().groups, editor().stickies, editor().nodes, editor().edges);
    const shown = (nodeId: string) => !nodes.find((n) => n.id === nodeId)!.hidden;
    expect([shown('a'), shown('c'), shown('b'), shown('d')]).toEqual([false, false, true, true]);
    expect(edges.filter((e) => e.type === 'groupProxy').length).toBeGreaterThan(0);
  });

  it('ungrouping hands the contents back to the parent they were in', () => {
    select('in1', 'in2');
    const id = editor().groupSelection()!;
    editor().ungroup([id]);
    expect(editor().groups.map((g) => g.id)).toEqual(['root', 'p1', 'in1', 'p2', 'in2', 'side']);
    expect(frame('in1').data.parentId).toBe('root');
    expect(frame('in2').data.parentId).toBe('root');
  });

  it('copies the new group with everything in it, pasting fresh ids with the nesting', () => {
    select('in1', 'in2');
    const id = editor().groupSelection()!;
    select(id);
    const data = editor().copySelection()!;
    editor().paste(data, { x: 4000, y: 1000 });
    const copy = editor().groups.find((g) => g.data.name === frame(id).data.name && g.id !== id)!;
    expect(copy.data.parentId).toBeUndefined();
    const children = editor().groups.filter((g) => g.data.parentId === copy.id);
    expect(children.map((g) => g.data.name).sort()).toEqual(['Inner1', 'Inner2']);
    expect(editor().nodes.filter((n) => descendantNodeIds(links(), copy.id).includes(n.id)).map((n) => n.data.wf.name).sort()).toEqual(['B1', 'D1']);
    // The originals are untouched.
    expect(frame('in1').data.parentId).toBe(id);
  });

  it('the clipboard of a cross-parent pick drops the parents that did not come along', () => {
    const data = serializeSelection(editor().toWorkflow(), new Set(['a', 'c']), new Set(), new Set());
    expect(data.groups).toBeUndefined();
    expect(data.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    // Two groups from different parents: both are top-level groups on the clipboard, with their nodes.
    const frames = serializeSelection(editor().toWorkflow(), new Set(), new Set(), new Set(['in1', 'in2']));
    expect(frames.groups?.map((g) => [g.id, g.parentId, g.nodeIds])).toEqual([
      ['in1', undefined, ['b']],
      ['in2', undefined, ['d']],
    ]);
  });

  it('saves, validates, imports and diffs as nested groups', () => {
    select('in1', 'in2');
    const id = editor().groupSelection()!;
    const saved = editor().toWorkflow();
    expect(workflowSchema.safeParse(saved).success).toBe(true);
    expect(saved.groups?.find((g) => g.id === 'in1')?.parentId).toBe(id);
    expect(saved.groups?.find((g) => g.id === id)?.parentId).toBe('root');
    expect(importWorkflowJson(saved).workflow.groups).toEqual(saved.groups);
    expect(diffWorkflows(workflow(tree()), saved).groupsChanged).toBe(true);
    expect(versionHash(saved)).not.toBe(versionHash(workflow(tree())));
    const doc = workflowDocument(saved);
    expect(workflowSchema.parse(JSON.parse(JSON.stringify(doc))).groups).toEqual(saved.groups);
    editor().load(saved, []);
    expect(editor().toWorkflow().groups).toEqual(saved.groups);
  });

  it('groupAround on its own gives the same answer as the store', () => {
    const frames = toFrames(tree());
    const nodes = editor().nodes;
    const made = groupAround(frames, nodes, 'g_new', 'New', ['a', 'c'], [])!;
    expect(made.frame.data).toMatchObject({ nodeIds: ['a', 'c'], parentId: 'root' });
    expect(groupAround(frames, nodes, 'g_new', 'New', [], [])).toBeUndefined();
  });
});
