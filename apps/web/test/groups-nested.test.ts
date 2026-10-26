/**
 * Nested canvas groups (`parentId`): the saved shape and its normalisation, the tree and collapse helpers, and the
 * editor store with groups inside groups (⌘G around frames, moving a parent moves everything inside, dragging a frame
 * in and out, resizing, collapsing a parent, ungroup and delete handing contents to the parent, undo, copy and paste,
 * duplicate, tidy up), version diffs and the Git sync file. Groups without nesting are groups.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowGroup } from '@landflow/engine';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-groups-nested-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { workflowSchema } = await import('@/lib/server/schemas');
const shared = await import('@/lib/shared/groups');
const { normalizeGroups, ancestorsOf, descendantGroupIds, descendantNodeIds, collapsedBoxes, parentAt, routeEdges, GROUP_HANDLES } = shared;
const { useEditor } = await import('@/components/editor/store');
const { canvasGraph, frameLabel } = await import('@/components/editor/groups');
const { parseClipboard, serializeSelection, preparePaste } = await import('@/components/editor/clipboard');
const { diffWorkflows, versionHash } = await import('@/lib/server/versions');
const { workflowDocument } = await import('@/lib/server/sync/format');
const { importWorkflowJson } = await import('@/lib/server/n8n-import');

const node = (id: string, name: string, x: number, y: number, type = 'core.set') => ({ id, name, type, typeVersion: 1, position: [x, y] as [number, number], parameters: {} });

/** t → a → b → c → d in a row, 300px apart. */
function workflow(groups?: WorkflowGroup[]): Workflow {
  return {
    id: 'wf_nested',
    name: 'Nested',
    nodes: [node('t', 'Trigger', 0, 0, 'core.manualTrigger'), node('a', 'A', 300, 0), node('b', 'B', 600, 0), node('c', 'C', 900, 0), node('d', 'D', 1200, 0)],
    connections: [
      { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'a', targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
      { id: 'e3', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
      { id: 'e4', type: 'main', source: 'c', sourceIndex: 0, target: 'd', targetIndex: 0 },
    ],
    ...(groups && { groups }),
  };
}

/** Outer holds A and Inner; Inner holds B and C. */
const nested = (extra: Partial<Record<'outer' | 'inner', Partial<WorkflowGroup>>> = {}): WorkflowGroup[] => [
  { id: 'outer', name: 'Outer', nodeIds: ['a'], position: [200, -200], width: 1000, height: 500, ...extra.outer },
  { id: 'inner', name: 'Inner', nodeIds: ['b', 'c'], position: [520, -100], width: 600, height: 300, parentId: 'outer', ...extra.inner },
];

const editor = () => useEditor.getState();
const frame = (id: string) => editor().groups.find((g) => g.id === id)!;
const pos = (id: string) => editor().nodes.find((n) => n.id === id)!.position;
const select = (...ids: string[]) =>
  editor().onNodesChange([...editor().nodes, ...editor().groups, ...editor().stickies].map((n) => ({ type: 'select' as const, id: n.id, selected: ids.includes(n.id) })));
const inside = (outer: { position: { x: number; y: number }; width?: number; height?: number }, inner: { position: { x: number; y: number }; width?: number; height?: number }) =>
  inner.position.x >= outer.position.x &&
  inner.position.y >= outer.position.y &&
  inner.position.x + (inner.width ?? 0) <= outer.position.x + (outer.width ?? 0) &&
  inner.position.y + (inner.height ?? 0) <= outer.position.y + (outer.height ?? 0);

describe('saved shape', () => {
  it('keeps parents that name another group, drops unknown ones and loops', () => {
    const groups = normalizeGroups(
      [
        { id: 'a', name: 'A', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'b' },
        { id: 'b', name: 'B', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'c' },
        { id: 'c', name: 'C', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'a' },
        { id: 'd', name: 'D', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'gone' },
        { id: 'e', name: 'E', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'e' },
        { id: 'a', name: 'dup', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'd' },
      ],
      [],
    );
    // a → b → c is kept; c → a would close the loop, so it goes. Unknown and self parents go too.
    expect(groups.map((g) => [g.id, g.parentId])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', undefined],
      ['d', undefined],
      ['e', undefined],
    ]);
    expect(groups[2]).not.toHaveProperty('parentId');
  });

  it('a workflow without nesting comes out exactly as it went in', () => {
    const flat = [{ id: 'g1', name: 'Middle', nodeIds: ['a', 'b'], position: [260, -70] as [number, number], width: 560, height: 230, color: 2, collapsed: true }];
    expect(normalizeGroups(flat, ['a', 'b'])).toEqual(flat);
    editor().load(workflow(flat), []);
    expect(editor().toWorkflow().groups).toEqual(flat);
    expect(editor().dirty).toBe(false);
  });

  it('the schema keeps parentId and refuses a group inside itself', () => {
    const parsed = workflowSchema.parse(workflow(nested()));
    expect(parsed.groups?.[1].parentId).toBe('outer');
    const loop = workflowSchema.safeParse(workflow(nested({ outer: { parentId: 'inner' } })));
    expect(loop.success).toBe(false);
    expect(loop.error?.issues.map((i) => i.message)).toContain('Group "outer" is inside itself');
    // A parent that is gone is tolerated (the editor drops it on load).
    expect(workflowSchema.safeParse(workflow(nested({ inner: { parentId: 'gone' } }))).success).toBe(true);
  });
});

describe('tree helpers', () => {
  const groups = [
    { id: 'top', nodeIds: ['a'] },
    { id: 'mid', nodeIds: ['b'], parentId: 'top' },
    { id: 'low', nodeIds: ['c'], parentId: 'mid' },
    { id: 'side', nodeIds: ['d'] },
  ];

  it('walks up and down the tree', () => {
    expect(ancestorsOf(groups, 'low')).toEqual(['mid', 'top']);
    expect(descendantGroupIds(groups, 'top')).toEqual(['mid', 'low']);
    expect(descendantNodeIds(groups, 'top').sort()).toEqual(['a', 'b', 'c']);
    expect(descendantNodeIds(groups, 'side')).toEqual(['d']);
    // A loop (never saved) doesn't hang the walk.
    expect(ancestorsOf([{ id: 'x', nodeIds: [], parentId: 'y' }, { id: 'y', nodeIds: [], parentId: 'x' }], 'x')).toEqual(['y']);
  });

  it('a collapsed group stands for everything inside it; the outermost collapsed one wins', () => {
    const one = collapsedBoxes(groups.map((g) => (g.id === 'mid' ? { ...g, collapsed: true } : g)));
    expect(Object.fromEntries(one.boxOf)).toEqual({ b: 'mid', c: 'mid' });
    expect([...one.hidden]).toEqual(['low']);
    const both = collapsedBoxes(groups.map((g) => (g.id === 'mid' || g.id === 'top' ? { ...g, collapsed: true } : g)));
    expect(Object.fromEntries(both.boxOf)).toEqual({ a: 'top', b: 'top', c: 'top' });
    expect([...both.hidden].sort()).toEqual(['low', 'mid']);
    // An override (the read-only canvases' expand) wins over the saved state.
    expect(collapsedBoxes(groups.map((g) => ({ ...g, collapsed: true })), (g) => g.id === 'low').boxOf.get('c')).toBe('low');
  });

  it('a dropped frame lands in the smallest bigger frame around its centre, never inside itself', () => {
    const frames = [
      { id: 'big', position: [0, 0] as [number, number], width: 1000, height: 1000 },
      { id: 'small', position: [100, 100] as [number, number], width: 300, height: 300 },
    ];
    expect(parentAt(frames, { x: 150, y: 150, width: 100, height: 100 }, new Set())?.id).toBe('small');
    // Bigger than the small frame: it goes in the big one.
    expect(parentAt(frames, { x: 50, y: 50, width: 400, height: 400 }, new Set())?.id).toBe('big');
    expect(parentAt(frames, { x: 150, y: 150, width: 100, height: 100 }, new Set(['small']))?.id).toBe('big');
    expect(parentAt(frames, { x: 2000, y: 2000, width: 100, height: 100 }, new Set())).toBeUndefined();
  });

  it('routes connections to the box, one line per box, node and port', () => {
    const edges = [
      { id: 'e1', source: 't', target: 'b', sourceHandle: 'main:0', targetHandle: 'main:0' },
      { id: 'e2', source: 't', target: 'c', sourceHandle: 'main:0', targetHandle: 'main:0' },
      { id: 'e3', source: 'b', target: 'c' },
      { id: 'e4', source: 'm', target: 'b', sourceHandle: 'ai_languageModel:0', targetHandle: 'ai_languageModel:0', data: { connectionType: 'ai_languageModel' } },
      { id: 'e5', source: 'x', target: 'y' },
    ];
    const routed = routeEdges(edges, new Map([['b', 'box'], ['c', 'box']]));
    expect(routed.edges.map((e) => e.id)).toEqual(['e5']);
    expect(routed.routes.map((r) => [r.source, r.target, r.targetHandle, r.edgeIds])).toEqual([
      ['t', 'box', GROUP_HANDLES.in, ['e1', 'e2']],
      ['m', 'box', GROUP_HANDLES.aiIn, ['e4']],
    ]);
    expect(routeEdges(edges, new Map()).edges).toBe(edges);
  });
});

describe('editor store', () => {
  beforeEach(() => editor().load(workflow(nested()), []));

  it('loads the nesting and saves it back', () => {
    expect(frame('inner').data.parentId).toBe('outer');
    expect(editor().toWorkflow().groups).toEqual(nested());
    expect(workflowSchema.safeParse(editor().toWorkflow()).success).toBe(true);
  });

  it('⌘G around a frame and a node nests both in a new group inside their common parent', () => {
    select('inner', 'a');
    const id = editor().groupSelection()!;
    const made = frame(id);
    // A leaves Outer for the new group, Inner moves in with B and C, and the new group sits in Outer.
    expect(made.data).toMatchObject({ nodeIds: ['a'], parentId: 'outer' });
    expect(made.selected).toBe(true);
    expect(frame('outer').data.nodeIds).toEqual([]);
    expect(frame('inner').data.parentId).toBe(id);
    expect(inside(made, frame('inner'))).toBe(true);
    expect(inside(frame('outer'), made)).toBe(true);
    // A node and a frame from different top-level places: the new group is top level.
    editor().load(workflow([...nested(), { id: 'side', name: 'Side', nodeIds: ['d'], position: [1160, 300], width: 220, height: 180 }]), []);
    select('side', 'a');
    expect(frame(editor().groupSelection()!).data.parentId).toBeUndefined();
    editor().undo();
    expect(editor().groups.map((g) => g.id)).toEqual(['outer', 'inner', 'side']);
    expect(frame('outer').data.nodeIds).toEqual(['a']);
  });

  it('⌘G picks the innermost common parent and grows it to fit', () => {
    select('b', 'c');
    const id = editor().groupSelection()!;
    expect(frame(id).data.parentId).toBe('inner');
    expect(frame(id).data.nodeIds).toEqual(['b', 'c']);
    expect(frame('inner').data.nodeIds).toEqual([]);
    expect(inside(frame('inner'), frame(id))).toBe(true);
    expect(inside(frame('outer'), frame('inner'))).toBe(true);
    // Wrapping a single frame: ⌘G with just Inner selected.
    select('inner');
    const wrap = editor().groupSelection()!;
    expect(frame('inner').data.parentId).toBe(wrap);
    expect(frame(wrap).data.parentId).toBe('outer');
    expect(frame(wrap).data.nodeIds).toEqual([]);
    expect(frameLabel(frame(wrap).data, descendantNodeIds(editor().groups.map((g) => ({ id: g.id, nodeIds: g.data.nodeIds, parentId: g.data.parentId })), wrap).length, 2)).toBe(
      'Group Group 2, 2 nodes, 2 groups',
    );
  });

  it('moving a parent moves the frames and nodes inside it, once each', () => {
    const start = { ...frame('outer').position };
    const innerStart = { ...frame('inner').position };
    editor().onNodesChange([{ type: 'position', id: 'outer', position: { x: start.x + 100, y: start.y + 50 }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id: 'outer', position: { x: start.x + 100, y: start.y + 50 }, dragging: false }]);
    expect(frame('inner').position).toEqual({ x: innerStart.x + 100, y: innerStart.y + 50 });
    expect(pos('a')).toEqual({ x: 400, y: 50 });
    expect(pos('b')).toEqual({ x: 700, y: 50 });
    expect(pos('c')).toEqual({ x: 1000, y: 50 });
    expect(pos('d')).toEqual({ x: 1200, y: 0 });
    // Parent and child dragged together (both selected): the child's nodes move once.
    editor().onNodesChange([
      { type: 'position', id: 'outer', position: { x: start.x + 110, y: start.y + 50 }, dragging: true },
      { type: 'position', id: 'inner', position: { x: innerStart.x + 110, y: innerStart.y + 50 }, dragging: true },
    ]);
    expect(pos('b')).toEqual({ x: 710, y: 50 });
    expect(frame('inner').position.x).toBe(innerStart.x + 110);
    // Moving the child alone leaves the parent's own node where it is.
    editor().onNodesChange([{ type: 'position', id: 'inner', position: { x: innerStart.x + 130, y: innerStart.y + 50 }, dragging: true }]);
    expect(pos('b')).toEqual({ x: 730, y: 50 });
    expect(pos('a')).toEqual({ x: 410, y: 50 });
  });

  it('a frame dragged into a bigger one joins it (which grows), and leaves when dragged out', () => {
    editor().load(workflow([...nested(), { id: 'side', name: 'Side', nodeIds: ['d'], position: [1160, 300], width: 220, height: 180 }]), []);
    const outerRight = frame('outer').position.x + frame('outer').width!;
    // Drop Side so its centre is just inside Outer's bottom-right corner.
    editor().onNodesChange([{ type: 'position', id: 'side', position: { x: outerRight - 150, y: 210 }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id: 'side', position: { x: outerRight - 150, y: 210 }, dragging: false }]);
    expect(frame('side').data.parentId).toBe('outer');
    expect(inside(frame('outer'), frame('side'))).toBe(true);
    // Its node came along and stays its own.
    expect(frame('side').data.nodeIds).toEqual(['d']);
    // Out again, far away.
    editor().onNodesChange([{ type: 'position', id: 'side', position: { x: 3000, y: 3000 }, dragging: false }]);
    expect(frame('side').data.parentId).toBeUndefined();
    expect(editor().toWorkflow().groups!.find((g) => g.id === 'side')).not.toHaveProperty('parentId');
  });

  it('a frame never lands inside one of its own groups, and a collapsed group takes nothing', () => {
    // Outer dropped so its centre sits in Inner: Inner is smaller (and inside it), so Outer stays top level.
    editor().onNodesChange([{ type: 'position', id: 'outer', position: { x: 300, y: -150 }, dragging: false }]);
    expect(frame('outer').data.parentId).toBeUndefined();
    expect(frame('inner').data.parentId).toBe('outer');
    // A node dropped on a collapsed group's frame doesn't join it.
    editor().updateGroup('inner', { collapsed: true });
    const { x, y } = frame('inner').position;
    editor().onNodesChange([{ type: 'position', id: 'd', position: { x: x + 200, y: y + 120 }, dragging: false }]);
    expect(frame('inner').data.nodeIds).toEqual(['b', 'c']);
    // It lands in Outer instead (the innermost expanded group under it), which grows to fit.
    expect(frame('outer').data.nodeIds).toEqual(['a', 'd']);
  });

  it('a node dropped in a nested frame joins the innermost one, and every frame around it grows', () => {
    const innerRight = frame('inner').position.x + frame('inner').width!;
    const outerRight = frame('outer').position.x + frame('outer').width!;
    editor().onNodesChange([{ type: 'position', id: 'd', position: { x: innerRight - 60, y: 0 }, dragging: false }]);
    expect(frame('inner').data.nodeIds).toEqual(['b', 'c', 'd']);
    expect(frame('inner').position.x + frame('inner').width!).toBeGreaterThan(innerRight);
    expect(inside(frame('outer'), frame('inner'))).toBe(true);
    expect(frame('outer').position.x + frame('outer').width!).toBeGreaterThanOrEqual(outerRight);
  });

  it('resizing: a sibling frame now inside moves in, a child now outside moves out to the parent', () => {
    editor().load(
      workflow([
        { id: 'outer', name: 'Outer', nodeIds: [], position: [0, -400], width: 2000, height: 1200 },
        { id: 'one', name: 'One', nodeIds: ['a'], position: [200, -100], width: 300, height: 300, parentId: 'outer' },
        { id: 'two', name: 'Two', nodeIds: ['c'], position: [800, -100], width: 300, height: 300, parentId: 'outer' },
      ]),
      [],
    );
    const one = frame('one');
    // Stretch One right over Two.
    editor().onNodesChange([{ type: 'dimensions', id: 'one', dimensions: { width: 1100, height: 500 }, resizing: true, setAttributes: true }]);
    editor().onNodesChange([{ type: 'dimensions', id: 'one', dimensions: { width: 1100, height: 500 }, resizing: false, setAttributes: true }]);
    expect(frame('two').data.parentId).toBe('one');
    // Shrink it back: Two is outside again and goes back to Outer.
    editor().onNodesChange([{ type: 'dimensions', id: 'one', dimensions: { width: one.width!, height: one.height! }, resizing: false, setAttributes: true }]);
    expect(frame('two').data.parentId).toBe('outer');
  });

  it('collapsing a parent hides everything inside it and routes connections to its box', () => {
    editor().updateGroup('inner', { collapsed: true });
    let s = editor();
    let graph = canvasGraph(s.groups, s.stickies, s.nodes, s.edges);
    expect(graph.nodes.filter((n) => n.hidden).map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([
      ['t', 'a'],
      ['a', 'inner'],
      ['inner', 'd'],
    ]);
    // Nested frames draw above their parent.
    expect(graph.nodes.find((n) => n.id === 'inner')!.zIndex).toBeGreaterThan(graph.nodes.find((n) => n.id === 'outer')!.zIndex!);
    // Now the parent too: Inner is hidden, every node inside Outer is drawn as Outer's box.
    select('a');
    editor().updateGroup('outer', { collapsed: true });
    expect(editor().nodes.find((n) => n.id === 'a')!.selected).toBe(false);
    s = editor();
    graph = canvasGraph(s.groups, s.stickies, s.nodes, s.edges);
    expect(graph.nodes.find((n) => n.id === 'inner')!.hidden).toBe(true);
    expect(graph.nodes.filter((n) => n.hidden && n.type === 'lf').map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(graph.edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['t', 'main:0', 'outer', GROUP_HANDLES.in],
      ['outer', GROUP_HANDLES.out, 'd', 'main:0'],
    ]);
    expect(graph.nodes.find((n) => n.id === 'outer')!.ariaLabel).toBe('Group Outer, 3 nodes, 1 group, collapsed');
    // ⌘A skips what is hidden; expanding the parent shows the collapsed child's box again.
    editor().selectAll();
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['t', 'd']);
    editor().updateGroup('outer', { collapsed: false });
    s = editor();
    graph = canvasGraph(s.groups, s.stickies, s.nodes, s.edges);
    expect(graph.nodes.find((n) => n.id === 'inner')!.hidden).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === 'inner')!.width).toBe(248);
  });

  it('ungrouping or deleting a parent hands its nodes and groups to the group around it', () => {
    editor().load(workflow([{ id: 'top', name: 'Top', nodeIds: [], position: [-400, -600], width: 2400, height: 1400 }, ...nested({ outer: { parentId: 'top' } })]), []);
    editor().ungroup(['outer']);
    expect(frame('inner').data.parentId).toBe('top');
    expect(frame('top').data.nodeIds).toEqual(['a']);
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['a']);
    editor().undo();
    expect(frame('inner').data.parentId).toBe('outer');
    // Deleting the frame (Backspace) does the same.
    editor().onNodesChange([{ type: 'remove', id: 'outer' }]);
    expect(editor().groups.map((g) => g.id)).toEqual(['top', 'inner']);
    expect(frame('inner').data.parentId).toBe('top');
    expect(editor().nodes).toHaveLength(5);
    editor().undo();
    // Delete the group and everything in it (the context menu passes every node and group inside).
    editor().removeNodes(['a', 'b', 'c', 'inner', 'outer']);
    expect(editor().groups.map((g) => g.id)).toEqual(['top']);
    expect(frame('top').data.nodeIds).toEqual([]);
    expect(editor().nodes.map((n) => n.id)).toEqual(['t', 'd']);
  });

  it('undoes and redoes nesting', () => {
    editor().load(workflow([...nested(), { id: 'side', name: 'Side', nodeIds: ['d'], position: [1160, 300], width: 220, height: 180 }]), []);
    const outerRight = frame('outer').position.x + frame('outer').width!;
    editor().onNodesChange([{ type: 'position', id: 'side', position: { x: outerRight - 150, y: 210 }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id: 'side', position: { x: outerRight - 150, y: 210 }, dragging: false }]);
    expect(frame('side').data.parentId).toBe('outer');
    editor().undo();
    expect(frame('side').data.parentId).toBeUndefined();
    expect(frame('side').position).toEqual({ x: 1160, y: 300 });
    expect(editor().dirty).toBe(false);
    editor().redo();
    expect(frame('side').data.parentId).toBe('outer');
  });

  it('copies a parent with its nested groups and pastes them with fresh, remapped ids', () => {
    select('outer');
    const data = editor().copySelection()!;
    expect(data.groups?.map((g) => [g.id, g.parentId])).toEqual([
      ['outer', undefined],
      ['inner', 'outer'],
    ]);
    expect(data.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(parseClipboard(JSON.stringify(data))?.kind).toBe('landflow');
    editor().paste(data, { x: 3000, y: 1000 });
    const pastedOuter = editor().groups.find((g) => g.data.name === 'Outer' && g.id !== 'outer')!;
    const pastedInner = editor().groups.find((g) => g.data.name === 'Inner' && g.id !== 'inner')!;
    expect(pastedInner.data.parentId).toBe(pastedOuter.id);
    expect(pastedOuter.data.parentId).toBeUndefined();
    expect(editor().nodes.filter((n) => pastedInner.data.nodeIds.includes(n.id)).map((n) => n.data.wf.name).sort()).toEqual(['B1', 'C1']);
    expect(workflowSchema.safeParse(editor().toWorkflow()).success).toBe(true);
  });

  it('a nested group copied alone loses its parent on the clipboard; duplicated in place it joins the same parent', () => {
    const data = serializeSelection(editor().toWorkflow(), new Set(), new Set(), new Set(['inner']));
    expect(data.groups).toHaveLength(1);
    expect(data.groups![0]).not.toHaveProperty('parentId');
    // Duplicate (⌘D / toolbar): the copy lands next to the original, inside Outer, so it joins Outer.
    editor().duplicateNode('inner');
    const copy = editor().groups.find((g) => g.data.name === 'Inner' && g.id !== 'inner')!;
    expect(copy.data.parentId).toBe('outer');
    expect(inside(frame('outer'), copy)).toBe(true);
    // Pasted far away, it is a top-level group.
    editor().paste(data, { x: 5000, y: 5000 });
    expect(editor().groups.filter((g) => g.data.name === 'Inner' && !g.data.parentId)).toHaveLength(1);
  });

  it('paste remaps parents only to groups that came along', () => {
    let n = 0;
    const plan = preparePaste(
      {
        kind: 'landflow/nodes',
        version: 1,
        nodes: [],
        connections: [],
        stickyNotes: [],
        groups: [
          { id: 'kid', name: 'Kid', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'mum' },
          { id: 'mum', name: 'Mum', nodeIds: [], position: [0, 0], width: 600, height: 400 },
          { id: 'orphan', name: 'Orphan', nodeIds: [], position: [0, 0], width: 300, height: 200, parentId: 'elsewhere' },
        ],
      },
      { existingNames: [], newId: (kind) => `${kind}_${++n}` },
    );
    const [kid, mum, orphan] = plan.groups;
    expect(kid.parentId).toBe(mum.id);
    expect(mum.id).not.toBe('mum');
    expect(orphan).not.toHaveProperty('parentId');
  });

  it('tidy up fits each frame around its nodes and the frames inside it, inner ones first', () => {
    editor().tidyUp();
    const outer = frame('outer');
    const inner = frame('inner');
    expect(inside(outer, inner)).toBe(true);
    for (const id of ['b', 'c']) {
      const p = pos(id);
      expect(p.x).toBeGreaterThan(inner.position.x);
      expect(p.x).toBeLessThan(inner.position.x + inner.width!);
    }
    expect(pos('a').x).toBeGreaterThan(outer.position.x);
  });

  it('merging (import into the open workflow) keeps the nesting', () => {
    editor().load(workflow(), []);
    editor().mergeWorkflow(workflow(nested()));
    const outer = editor().groups.find((g) => g.data.name === 'Outer')!;
    expect(editor().groups.find((g) => g.data.name === 'Inner')!.data.parentId).toBe(outer.id);
  });
});

describe('versions, import and Git sync', () => {
  it('a change of parent makes a new version and shows in the diff', () => {
    const flat = workflow(nested({ inner: { parentId: undefined } }));
    expect(versionHash(workflow(nested()))).not.toBe(versionHash(flat));
    expect(diffWorkflows(flat, workflow(nested())).groupsChanged).toBe(true);
  });

  it('imports keep the nesting and drop loops', () => {
    const result = importWorkflowJson(workflow(nested()));
    expect(result.workflow.groups?.map((g) => [g.id, g.parentId])).toEqual([
      ['outer', undefined],
      ['inner', 'outer'],
    ]);
    const looped = importWorkflowJson(workflow(nested({ outer: { parentId: 'inner' } })));
    expect(looped.workflow.groups?.map((g) => g.parentId)).toEqual(['inner', undefined]);
  });

  it('the sync file carries parentId and parses back', () => {
    const doc = workflowDocument(workflow(nested()));
    const groups = doc.groups as unknown as WorkflowGroup[];
    expect(groups[1].parentId).toBe('outer');
    expect(groups[0]).not.toHaveProperty('parentId');
    expect(workflowSchema.parse(JSON.parse(JSON.stringify(doc))).groups).toEqual(nested());
  });
});
