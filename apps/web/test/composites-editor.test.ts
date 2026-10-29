/**
 * Composites in the editor store (docs/composites.md): inserting a type drops a frame with its starter bound to the
 * slots, a node added for a slot joins the frame, is bound and is wired the way the type's `feeds` rules say, a node
 * dropped into a frame binds to the slot it obviously fills, nodes in a locked slot can't be deleted, issue fixes
 * apply, a frame can be typed and made plain again, and copy and paste keep the bindings on the pasted nodes.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { CompositeTypeInfo } from '@/lib/shared/composites';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-composites-editor-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { useEditor } = await import('@/components/editor/store');
const { checkedGraph, editorLookup } = await import('@/components/editor/composites');
const { compositeReports } = await import('@/lib/shared/composites');

const info = (pluginId: string, descriptor: NodeTypeInfo['descriptor']): NodeTypeInfo =>
  ({ type: `${pluginId}.${descriptor.name}`, pluginId, pluginName: pluginId, language: 'typescript', transport: 'in-process', available: true, descriptor }) as NodeTypeInfo;
const nodeTypes: NodeTypeInfo[] = corePlugin.nodes.map((n) => info('core', n.description));
const composites: CompositeTypeInfo[] = (corePlugin.composites ?? []).map((d) => ({ type: `core.${d.name}`, source: { kind: 'plugin', pluginId: 'core', pluginName: 'Landflow Core' }, descriptor: d, versions: [d.version], available: true }));
const fixtures = join(import.meta.dirname, 'fixtures', 'plugin-manifests');
for (const file of readdirSync(fixtures)) {
  const manifest = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  for (const node of manifest.nodes) nodeTypes.push(info(manifest.plugin.id, node));
  for (const d of manifest.composites ?? []) composites.push({ type: `${manifest.plugin.id}.${d.name}`, source: { kind: 'plugin', pluginId: manifest.plugin.id, pluginName: manifest.plugin.name }, descriptor: d, versions: [d.version], available: true });
}

const editor = () => useEditor.getState();
const frame = (id: string) => editor().groups.find((g) => g.id === id)!;
const report = (id: string) => compositeReports(checkedGraph(editor().nodes, editor().edges, editor().groups), editorLookup(editor().nodeTypes, editor().composites)).find((r) => r.groupId === id)!;
const byType = (type: string) => editor().nodes.filter((n) => n.data.wf.type === type);

beforeEach(() => {
  editor().load({ id: 'wf_c', name: 'Composites', nodes: [], connections: [] }, nodeTypes);
  editor().setComposites(composites);
});

describe('inserting a type', () => {
  it('drops a frame with the starter bound to its slots, checked clean, in one undo step', () => {
    const id = editor().insertComposite('core.aiStep', { x: 100, y: 100 })!;
    expect(frame(id).data.composite).toMatchObject({ type: 'core.aiStep', version: 1 });
    expect(frame(id).data.nodeIds).toHaveLength(2);
    const [agent] = byType('core.aiAgent');
    expect(frame(id).data.composite!.slots).toEqual({ reasoner: [agent.id], model: [byType('core.anthropicChatModel')[0].id] });
    // Parameters the starter doesn't set are the node's defaults.
    expect(agent.data.wf.parameters).toMatchObject({ prompt: expect.any(String) });
    expect(editor().edges).toHaveLength(1);
    expect(report(id).issues).toEqual([]);
    expect(editor().toWorkflow().groups?.[0].composite?.slots.reasoner).toEqual([agent.id]);
    editor().undo();
    expect(editor().nodes).toEqual([]);
    expect(editor().groups).toEqual([]);
  });

  it('doesn’t land on what is already there', () => {
    const first = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    const second = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    const [a, b] = [frame(first), frame(second)];
    expect(b.position.y).toBeGreaterThanOrEqual(a.position.y + (a.height ?? 0));
    expect(b.data.parentId).toBeUndefined();
    // Its nodes moved with it.
    for (const id of b.data.nodeIds) expect(editor().nodes.find((n) => n.id === id)!.position.y).toBeGreaterThan(b.position.y);
  });

  it('takes the triage plugin’s type, starter and all', () => {
    const id = editor().insertComposite('triage.aiTriage', { x: 0, y: 0 })!;
    expect(frame(id).data.nodeIds).toHaveLength(5);
    expect(report(id).issues).toEqual([]);
  });
});

describe('filling a slot', () => {
  it('adds the node to the frame, binds it and wires it as the rules say', () => {
    const id = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    const [agent] = byType('core.aiAgent');
    const memoryId = editor().placeNode('core.simpleMemory', { slot: { groupId: id, slot: 'memory' }, position: { x: 60, y: 300 } }, { x: 0, y: 0 })!;
    expect(frame(id).data.nodeIds).toContain(memoryId);
    expect(frame(id).data.composite!.slots.memory).toEqual([memoryId]);
    expect(editor().edges.some((e) => e.source === memoryId && e.target === agent.id && e.data?.connectionType === 'ai_memory')).toBe(true);
    expect(report(id).issues).toEqual([]);
  });

  it('fills an empty required slot left by a deleted model, wired to the reasoner', () => {
    const id = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    editor().removeNodes([byType('core.anthropicChatModel')[0].id]);
    expect(report(id).issues.map((i) => i.code)).toEqual(['slot-empty']);
    const model = editor().placeNode('core.openAiChatModel', { slot: { groupId: id, slot: 'model' }, position: { x: 60, y: 280 } }, { x: 0, y: 0 })!;
    expect(frame(id).data.composite!.slots.model).toEqual([model]);
    expect(report(id).issues).toEqual([]);
  });
});

describe('dropping a node into a frame', () => {
  it('binds it to the slot it obviously fills, and leaving the frame unbinds it', () => {
    const id = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    const tool = editor().addNode('core.calculatorTool', { x: 2000, y: 2000 })!;
    const box = frame(id);
    const into = { x: box.position.x + 200, y: box.position.y + 120 };
    editor().onNodesChange([{ type: 'position', id: tool, position: into, dragging: false }]);
    expect(frame(id).data.nodeIds).toContain(tool);
    expect(frame(id).data.composite!.slots.tools).toEqual([tool]);
    editor().onNodesChange([{ type: 'position', id: tool, position: { x: 3000, y: 3000 }, dragging: false }]);
    expect(frame(id).data.nodeIds).not.toContain(tool);
    expect(editor().toWorkflow().groups![0].composite!.slots.tools).toBeUndefined();
  });

  it('leaves a node free when no slot obviously takes it', () => {
    const id = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    const set = editor().addNode('core.set', { x: 2000, y: 2000 })!;
    editor().onNodesChange([{ type: 'position', id: set, position: { x: frame(id).position.x + 200, y: frame(id).position.y + 120 }, dragging: false }]);
    expect(frame(id).data.nodeIds).toContain(set);
    expect(report(id).free).toEqual([set]);
  });
});

describe('locked slots, fixes and typing', () => {
  it('keeps a node in a locked slot from being deleted', () => {
    const id = editor().insertComposite('triage.aiTriage', { x: 0, y: 0 })!;
    const [decide] = byType('triage.triageDecision');
    editor().removeNodes([decide.id]);
    editor().onNodesChange([{ type: 'remove', id: decide.id }]);
    expect(byType('triage.triageDecision')).toHaveLength(1);
    // Made plain, the frame no longer holds it back.
    editor().updateGroup(id, { composite: undefined });
    editor().removeNodes([decide.id]);
    expect(byType('triage.triageDecision')).toHaveLength(0);
  });

  it('applies the fixes the issues offer', () => {
    const id = editor().insertComposite('triage.aiTriage', { x: 0, y: 0 })!;
    const [chain] = byType('core.chainLlm');
    editor().updateNode(chain.id, { onError: 'stop' });
    const issue = report(id).issues.find((i) => i.code === 'on-error')!;
    editor().fixComposite(id, issue.fix!);
    expect(byType('core.chainLlm')[0].data.wf.onError).toBe('continue');
    editor().bindSlotOf(id, chain.id, 'decision');
    const mismatch = report(id).issues.find((i) => i.code === 'slot-mismatch')!;
    editor().fixComposite(id, mismatch.fix!);
    expect(frame(id).data.composite!.slots.decision).toHaveLength(1);
    editor().fixComposite(id, { kind: 'upgrade', version: 1 });
    expect(frame(id).data.composite!.version).toBe(1);
  });

  it('copies and pastes a composite frame with its bindings on the pasted nodes', () => {
    const id = editor().insertComposite('core.aiStep', { x: 0, y: 0 })!;
    editor().duplicateNode(id);
    const copy = editor().groups.find((g) => g.id !== id)!;
    expect(copy.data.composite!.slots.reasoner).toHaveLength(1);
    expect(copy.data.composite!.slots.reasoner[0]).not.toBe(frame(id).data.composite!.slots.reasoner[0]);
    expect(copy.data.nodeIds).toContain(copy.data.composite!.slots.reasoner[0]);
    expect(report(copy.id).issues).toEqual([]);
  });
});
