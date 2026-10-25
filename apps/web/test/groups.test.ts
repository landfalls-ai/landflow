/**
 * Canvas groups: the saved shape (`workflow.groups`, checked by the workflow schema and normalised on import), the
 * editor store's grouping logic (frame around the selection, moving a frame moves its nodes, resize and drag in or
 * out change membership, collapse hides members and re-routes their connections, ungroup), undo / redo, copy and
 * paste and duplicate with groups, version diffs, and the Git sync round trip. The engine ignoring groups is
 * packages/engine/test/groups.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowGroup } from '@landflow/engine';
import type { SyncExport } from '@/lib/shared/sync';

// The store takes two constants from the sticky-note component (TSX, which the test runner doesn't compile).
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-groups-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { workflowSchema } = await import('@/lib/server/schemas');
const { normalizeGroups, frameAround, groupAt, GROUP_PADDING } = await import('@/lib/shared/groups');
const { useEditor } = await import('@/components/editor/store');
const { canvasGraph, GROUP_HANDLES } = await import('@/components/editor/groups');
const { parseClipboard } = await import('@/components/editor/clipboard');
const { diffWorkflows, summarizeDiff, versionHash, applyVersion } = await import('@/lib/server/versions');
const { importWorkflowJson } = await import('@/lib/server/n8n-import');

const node = (id: string, name: string, x: number, y: number, type = 'core.set') => ({ id, name, type, typeVersion: 1, position: [x, y] as [number, number], parameters: {} });

function workflow(groups?: WorkflowGroup[]): Workflow {
  return {
    id: 'wf_groups',
    name: 'Groups',
    nodes: [node('t', 'Trigger', 0, 0, 'core.manualTrigger'), node('a', 'A', 300, 0), node('b', 'B', 600, 0), node('c', 'C', 900, 0)],
    connections: [
      { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'a', targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
      { id: 'e3', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 },
    ],
    ...(groups && { groups }),
  };
}

const editor = () => useEditor.getState();
const frame = (id: string) => editor().groups.find((g) => g.id === id)!;
const pos = (id: string) => editor().nodes.find((n) => n.id === id)!.position;
const select = (...ids: string[]) =>
  editor().onNodesChange([...editor().nodes, ...editor().groups, ...editor().stickies].map((n) => ({ type: 'select' as const, id: n.id, selected: ids.includes(n.id) })));

describe('saved shape', () => {
  it('accepts groups and checks ids and membership', () => {
    const ok = workflowSchema.safeParse(workflow([{ id: 'g1', name: 'Middle', nodeIds: ['a', 'b', 'gone'], position: [260, -70], width: 560, height: 230, color: 3, collapsed: true }]));
    expect(ok.success).toBe(true);
    const twice = workflowSchema.safeParse(
      workflow([
        { id: 'g1', name: 'One', nodeIds: ['a'], position: [0, 0], width: 300, height: 200 },
        { id: 'g1', name: 'Two', nodeIds: ['b'], position: [0, 0], width: 300, height: 200 },
      ]),
    );
    expect(twice.success).toBe(false);
    const shared = workflowSchema.safeParse(
      workflow([
        { id: 'g1', name: 'One', nodeIds: ['a'], position: [0, 0], width: 300, height: 200 },
        { id: 'g2', name: 'Two', nodeIds: ['a'], position: [0, 0], width: 300, height: 200 },
      ]),
    );
    expect(shared.success).toBe(false);
    expect(shared.error?.issues[0]?.message).toContain('two groups');
    // Optional: a workflow without groups is unchanged.
    expect(workflowSchema.parse(workflow()).groups).toBeUndefined();
  });

  it('normalises groups: known members once, names, sizes, colours', () => {
    const groups = normalizeGroups(
      [
        { id: 'g1', name: '  Ingest  ', nodeIds: ['a', 'a', 'zz'], position: [10.4, 20.6], width: 99_999, height: 10, color: 2 },
        { id: 'g1', name: 'dup', nodeIds: [], position: [0, 0], width: 300, height: 200 },
        { id: 'g2', name: '', nodeIds: ['a', 'b'], position: [0, 0], width: 300, height: 200, color: 0, collapsed: false },
      ],
      ['a', 'b'],
    );
    expect(groups).toEqual([
      { id: 'g1', name: 'Ingest', nodeIds: ['a'], position: [10, 21], width: 20_000, height: 40, color: 2 },
      { id: 'g2', name: 'Group', nodeIds: ['b'], position: [0, 0], width: 300, height: 200 },
    ]);
  });

  it('frames nodes with room for the label, and finds the smallest frame under a point', () => {
    const rect = frameAround([{ x: 100, y: 100, width: 88, height: 128 }])!;
    expect(rect.y).toBe(100 - GROUP_PADDING.top);
    expect(rect.width).toBeGreaterThanOrEqual(88 + GROUP_PADDING.side * 2);
    const big = { id: 'big', position: [0, 0] as [number, number], width: 1000, height: 1000 };
    const small = { id: 'small', position: [100, 100] as [number, number], width: 200, height: 200 };
    expect(groupAt([big, small], { x: 150, y: 150 })?.id).toBe('small');
    expect(groupAt([big, small], { x: 800, y: 800 })?.id).toBe('big');
    expect(groupAt([big, { ...small, collapsed: true }], { x: 150, y: 150 })?.id).toBe('big');
  });
});

describe('editor store', () => {
  beforeEach(() => editor().load(workflow(), []));

  it('groups the selected nodes in a frame around them, and saves it', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    expect(id).toMatch(/^g_/);
    const g = frame(id);
    expect(g.data).toMatchObject({ name: 'Group', nodeIds: ['a', 'b'], collapsed: false });
    expect(g.selected).toBe(true);
    expect(g.position.x).toBeLessThan(300);
    expect(g.position.x + g.width!).toBeGreaterThan(688);
    // A second group gets the next name; nodes leave their old group.
    select('b');
    const second = editor().groupSelection()!;
    expect(frame(second).data.name).toBe('Group 2');
    expect(frame(id).data.nodeIds).toEqual(['a']);
    const saved = editor().toWorkflow();
    expect(saved.groups).toHaveLength(2);
    expect(workflowSchema.safeParse(saved).success).toBe(true);
    // Nothing selected: nothing to group.
    select();
    expect(editor().groupSelection()).toBeUndefined();
  });

  it('⌘A selects every node but no frame, so ⌘G groups them all', () => {
    select('a');
    const first = editor().groupSelection()!;
    expect(frame(first).selected).toBe(true);
    editor().selectAll();
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['t', 'a', 'b', 'c']);
    expect(frame(first).selected).toBe(false);
    const all = editor().groupSelection()!;
    expect(frame(all).data.nodeIds).toEqual(['t', 'a', 'b', 'c']);
  });

  it('moves a frame’s nodes with it, but not on a resize from the top-left', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    const start = { ...frame(id).position };
    editor().onNodesChange([{ type: 'position', id, position: { x: start.x + 50, y: start.y + 30 }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id, position: { x: start.x + 50, y: start.y + 30 }, dragging: false }]);
    expect(pos('a')).toEqual({ x: 350, y: 30 });
    expect(pos('b')).toEqual({ x: 650, y: 30 });
    expect(pos('c')).toEqual({ x: 900, y: 0 });
    // A member dragged together with its frame moves once.
    editor().onNodesChange([
      { type: 'position', id, position: { x: start.x + 60, y: start.y + 30 }, dragging: true },
      { type: 'position', id: 'a', position: { x: 360, y: 30 }, dragging: true },
    ]);
    expect(pos('a')).toEqual({ x: 360, y: 30 });
    expect(pos('b')).toEqual({ x: 660, y: 30 });
    // Resizing from the left edge moves the frame only.
    const before = { ...frame(id).position };
    editor().onNodesChange([
      { type: 'position', id, position: { x: before.x - 100, y: before.y } },
      { type: 'dimensions', id, dimensions: { width: frame(id).width! + 100, height: frame(id).height! }, resizing: true, setAttributes: true },
    ]);
    expect(frame(id).position.x).toBe(before.x - 100);
    expect(pos('a')).toEqual({ x: 360, y: 30 });
  });

  it('nodes dropped into a frame join it (it grows to fit), dropped outside leave it', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    const { x, y } = frame(id).position;
    const right = x + frame(id).width!;
    // Drop C just inside the right edge: it joins and the frame grows around it.
    editor().onNodesChange([{ type: 'position', id: 'c', position: { x: right - 60, y: y + 80 }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id: 'c', position: { x: right - 60, y: y + 80 }, dragging: false }]);
    expect(frame(id).data.nodeIds).toEqual(['a', 'b', 'c']);
    expect(frame(id).position.x + frame(id).width!).toBeGreaterThan(right);
    // Drag A far away: it leaves.
    editor().onNodesChange([{ type: 'position', id: 'a', position: { x: -2000, y: 900 }, dragging: false }]);
    expect(frame(id).data.nodeIds).toEqual(['b', 'c']);
    // Collapsed groups don't take nodes.
    editor().updateGroup(id, { collapsed: true });
    editor().onNodesChange([{ type: 'position', id: 't', position: { x: x + 20, y: y + 20 }, dragging: false }]);
    expect(frame(id).data.nodeIds).toEqual(['b', 'c']);
  });

  it('a resized frame takes the nodes now inside it and lets go of those outside', () => {
    select('a');
    const id = editor().groupSelection()!;
    const g = frame(id);
    // Stretch it right over B.
    editor().onNodesChange([{ type: 'dimensions', id, dimensions: { width: g.width! + 400, height: g.height! }, resizing: true, setAttributes: true }]);
    editor().onNodesChange([{ type: 'dimensions', id, dimensions: { width: g.width! + 400, height: g.height! }, resizing: false, setAttributes: true }]);
    expect(frame(id).data.nodeIds.sort()).toEqual(['a', 'b']);
    // Shrink it back from the left: A is outside now.
    editor().onNodesChange([
      { type: 'position', id, position: { x: 500, y: g.position.y } },
      { type: 'dimensions', id, dimensions: { width: 300, height: g.height! }, resizing: false, setAttributes: true },
    ]);
    expect(frame(id).data.nodeIds).toEqual(['b']);
  });

  it('collapsing hides the members and draws their connections to the box', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    editor().updateGroup(id, { collapsed: true, name: 'Middle', color: 4 });
    const s = editor();
    const graph = canvasGraph(s.groups, s.stickies, s.nodes, s.edges);
    const box = graph.nodes.find((n) => n.id === id)!;
    expect(box.width).toBe(248);
    expect(box.ariaLabel).toBe('Group Middle, 2 nodes, collapsed');
    expect(graph.nodes.filter((n) => n.hidden).map((n) => n.id).sort()).toEqual(['a', 'b']);
    // e2 is inside the group (gone); e1 and e3 now end at the box.
    expect(graph.edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual([
      ['t', 'main:0', id, GROUP_HANDLES.in],
      [id, GROUP_HANDLES.out, 'c', 'main:0'],
    ]);
    // Saved collapsed with the expanded size kept.
    const saved = editor().toWorkflow().groups![0];
    expect(saved).toMatchObject({ name: 'Middle', color: 4, collapsed: true });
    expect(saved.width).toBeGreaterThan(248);
    // Without collapsed groups the store's arrays pass through.
    editor().updateGroup(id, { collapsed: false });
    expect(canvasGraph(editor().groups, [], editor().nodes, editor().edges).edges).toBe(editor().edges);
  });

  it('ungroups (keeping and selecting the nodes), and removing nodes updates the members', () => {
    select('a', 'b', 'c');
    const id = editor().groupSelection()!;
    editor().removeNodes(['c']);
    expect(frame(id).data.nodeIds).toEqual(['a', 'b']);
    // ⇧⌘G with a member selected ungroups its group.
    select('a');
    editor().ungroup();
    expect(editor().groups).toEqual([]);
    expect(editor().nodes.filter((n) => n.selected).map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(editor().nodes.map((n) => n.id)).toEqual(['t', 'a', 'b']);
    // Deleting a frame keeps its nodes.
    const again = editor().groupSelection()!;
    editor().onNodesChange([{ type: 'remove', id: again }]);
    expect(editor().groups).toEqual([]);
    expect(editor().nodes).toHaveLength(3);
  });

  it('undoes and redoes grouping, moving, renaming and ungrouping', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    const start = { ...frame(id).position };
    editor().onNodesChange([{ type: 'position', id, position: { x: start.x + 100, y: start.y }, dragging: true }]);
    editor().onNodesChange([{ type: 'position', id, position: { x: start.x + 100, y: start.y }, dragging: false }]);
    editor().updateGroup(id, { name: 'Renamed' });
    editor().undo();
    expect(frame(id).data.name).toBe('Group');
    editor().undo();
    expect(frame(id).position).toEqual(start);
    expect(pos('a')).toEqual({ x: 300, y: 0 });
    editor().undo();
    expect(editor().groups).toEqual([]);
    editor().redo();
    editor().redo();
    expect(frame(id).position.x).toBe(start.x + 100);
    expect(pos('a')).toEqual({ x: 400, y: 0 });
    editor().ungroup([id]);
    editor().undo();
    expect(frame(id).data.nodeIds).toEqual(['a', 'b']);
  });

  it('copies a group with its nodes and pastes it with fresh ids', () => {
    select('a', 'b');
    const id = editor().groupSelection()!;
    // Only the frame is selected: its nodes come along.
    const data = editor().copySelection()!;
    expect(data.groups?.map((g) => g.id)).toEqual([id]);
    expect(data.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(data.connections.map((c) => c.id)).toEqual(['e2']);
    const parsed = parseClipboard(JSON.stringify(data));
    expect(parsed?.kind === 'landflow' && parsed.data.groups).toHaveLength(1);
    const count = editor().paste(data, { x: 2000, y: 500 });
    expect(count).toBe(3);
    const pasted = editor().groups.find((g) => g.id !== id)!;
    expect(pasted.id).toMatch(/^g_/);
    expect(pasted.selected).toBe(true);
    const copies = editor().nodes.filter((n) => pasted.data.nodeIds.includes(n.id));
    expect(copies.map((n) => n.data.wf.name).sort()).toEqual(['A1', 'B1']);
    expect(pasted.position).toEqual({ x: 2000, y: 500 });
    // Members keep their place inside the frame.
    expect(copies[0].position.x - pasted.position.x).toBe(300 - frame(id).position.x);
    // Duplicating the group (toolbar, ⌘D) works the same way.
    editor().duplicateNode(id);
    expect(editor().groups).toHaveLength(3);
    expect(editor().nodes).toHaveLength(8);
    const saved = editor().toWorkflow();
    expect(workflowSchema.safeParse(saved).success).toBe(true);
    expect(new Set(saved.groups!.flatMap((g) => g.nodeIds)).size).toBe(6);
  });

  it('loads, merges and lays out groups', () => {
    editor().load(workflow([{ id: 'g1', name: 'Middle', nodeIds: ['a', 'b', 'gone'], position: [260, -70], width: 560, height: 230, collapsed: true }]), []);
    expect(frame('g1').data.nodeIds).toEqual(['a', 'b']);
    expect(editor().toWorkflow().groups).toEqual([{ id: 'g1', name: 'Middle', nodeIds: ['a', 'b'], position: [260, -70], width: 560, height: 230, collapsed: true }]);
    editor().mergeWorkflow(workflow([{ id: 'g1', name: 'Imported', nodeIds: ['a'], position: [260, -70], width: 300, height: 230 }]));
    const imported = editor().groups.find((g) => g.data.name === 'Imported')!;
    expect(imported.id).not.toBe('g1');
    expect(imported.data.nodeIds).toHaveLength(1);
    expect(editor().nodes.find((n) => n.id === imported.data.nodeIds[0])?.data.wf.name).toBe('A1');
    // Tidy up moves nodes, and the frames follow them.
    editor().tidyUp();
    const member = editor().nodes.find((n) => n.id === imported.data.nodeIds[0])!;
    const refit = editor().groups.find((g) => g.id === imported.id)!;
    expect(member.position.x).toBeGreaterThan(refit.position.x);
    expect(member.position.y).toBeGreaterThan(refit.position.y);
    expect(member.position.x).toBeLessThan(refit.position.x + refit.width!);
  });
});

describe('versions, import and Git sync', () => {
  const grouped = workflow([{ id: 'g1', name: 'Middle', nodeIds: ['a', 'b'], position: [260, -70], width: 560, height: 230 }]);

  it('a change to the groups makes a version; no groups keeps the old hash', () => {
    expect(versionHash({ ...workflow(), groups: [] })).toBe(versionHash(workflow()));
    expect(versionHash(grouped)).not.toBe(versionHash(workflow()));
    const diff = diffWorkflows(workflow(), grouped);
    expect(diff.groupsChanged).toBe(true);
    expect(summarizeDiff(diff, false)).toMatch(/groups changed/i);
    const restored = applyVersion({ ...workflow(), groups: [] }, { workflow: grouped } as Parameters<typeof applyVersion>[1]);
    expect(restored.groups).toEqual(grouped.groups);
  });

  it('Landflow imports keep groups; n8n workflows have none', () => {
    const result = importWorkflowJson({ ...grouped, groups: [...grouped.groups!, { id: 'g2', name: 'Again', nodeIds: ['a'], position: [0, 0], width: 300, height: 200 }] });
    expect(result.workflow.groups?.map((g) => [g.id, g.nodeIds])).toEqual([
      ['g1', ['a', 'b']],
      ['g2', []],
    ]);
    expect(result.report.groups).toBe(2);
    const n8n = importWorkflowJson({
      name: 'From n8n',
      nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    });
    expect(n8n.workflow.groups).toBeUndefined();
    expect(n8n.workflow.nodes).toHaveLength(1);
  });

  describe('sync', () => {
    let store: (typeof import('@/lib/server/store'))['store'];
    let exportRoute: typeof import('@/app/api/sync/export/route');
    let applyRoute: typeof import('@/app/api/sync/apply/route');
    const exported = async (): Promise<SyncExport> => (await exportRoute.GET(new Request('http://sync.test/api/sync/export'))).json();

    beforeAll(async () => {
      ({ store } = await import('@/lib/server/store'));
      exportRoute = await import('@/app/api/sync/export/route');
      applyRoute = await import('@/app/api/sync/apply/route');
      const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
      await ensureBootstrapped();
      for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
      store.saveWorkflow({ ...grouped, id: 'wf_grouped', name: 'Grouped' });
      store.saveWorkflow({ ...workflow(), id: 'wf_plain', name: 'Plain', groups: [] });
    });

    it('round-trips groups through files, and leaves files without groups alone', async () => {
      const first = await exported();
      const file = first.files.find((f) => f.path === 'workflows/grouped.workflow.json')!;
      const doc = JSON.parse(file.content);
      expect(doc.groups).toEqual(grouped.groups);
      expect(Object.keys(doc).indexOf('groups')).toBeGreaterThan(Object.keys(doc).indexOf('connections'));
      expect(JSON.parse(first.files.find((f) => f.path === 'workflows/plain.workflow.json')!.content)).not.toHaveProperty('groups');

      // Rename the group in the file and apply it.
      doc.groups[0].name = 'Renamed in Git';
      const files = first.files.map((f) => ({ path: f.path, content: f.path === file.path ? `${JSON.stringify(doc, null, 2)}\n` : f.content }));
      const response = await applyRoute.POST(new Request('http://sync.test/api/sync/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) }));
      const body = await response.json();
      expect(body.changes.map((c: { name: string; fields?: string[] }) => [c.name, c.fields])).toEqual([['Grouped', ['groups']]]);
      expect(store.getWorkflow('wf_grouped')!.groups![0].name).toBe('Renamed in Git');
      const again = await exported();
      expect(again.files.find((f) => f.path === file.path)!.content).toBe(files.find((f) => f.path === file.path)!.content);
    });
  });
});
