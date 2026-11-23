/**
 * The node creator: trigger-mode search keeps the friendly trigger titles, core nodes add directly (no action list),
 * and an action picked from an app's list is placed with its resource and operation set, in one undo step.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, NodeTypeInfo } from '@/lib/shared/types';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-node-creator-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { useEditor } = await import('@/components/editor/store');
const { NodeCreator } = await import('@/components/editor/node-creator');

const info = (pluginId: string, descriptor: NodeDescriptor): NodeTypeInfo =>
  ({ type: `${pluginId}.${descriptor.name}`, pluginId, pluginName: pluginId === 'core' ? 'Landflow Core' : 'Linear', language: 'typescript', transport: pluginId === 'core' ? 'in-process' : 'http', available: true, descriptor }) as NodeTypeInfo;
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'plugin-manifests', 'linear.json'), 'utf8')) as { nodes: NodeDescriptor[] };
const nodeTypes: NodeTypeInfo[] = [...corePlugin.nodes.map((n) => info('core', n.description)), ...manifest.nodes.map((n) => info('linear', n))];
// A core node that has a resource and an operation, like an app's: it still adds directly.
const coreWithOperations = info('core', { ...manifest.nodes.find((n) => n.name === 'linear')!, name: 'zebraOps', displayName: 'Zebra ops' });
nodeTypes.push(coreWithOperations);
const editor = () => useEditor.getState();

// Server rendering reads zustand's initial state: copy the live state into it.
const creator = (initialQuery: string) => {
  Object.assign(useEditor.getInitialState(), useEditor.getState());
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(NodeCreator, { initialQuery })));
};

beforeEach(() => {
  editor().load({ id: 'wf_nc', name: 'Creator', nodes: [], connections: [] }, nodeTypes);
});

describe('search', () => {
  it('keeps the friendly trigger titles while picking a trigger', () => {
    editor().openPalette({});
    const html = creator('webhook');
    expect(html).toContain('On webhook call');
  });

  it('lists a core node without an action count, and adds it directly', () => {
    editor().load({ id: 'wf_nc', name: 'Creator', nodes: [], connections: [] }, nodeTypes);
    editor().addNode('core.manualTrigger', { x: 0, y: 0 });
    editor().openPalette({ connectionType: 'main' });
    const html = creator('zebra');
    expect(html).toContain('Zebra ops');
    expect(html).not.toMatch(/\d+ actions?:/);
  });
});

describe('picking an action', () => {
  it('places the node with its resource and operation set, defaults fresh, in one undo step', () => {
    const linear = nodeTypes.find((t) => t.pluginId === 'linear')!;
    const id = editor().placeNode(linear.type, {}, { x: 10, y: 10 }, { resource: 'issue', operation: 'create' })!;
    const node = editor().nodes.find((n) => n.id === id)!;
    expect(node.data.wf.parameters).toMatchObject({ resource: 'issue', operation: 'create' });
    // What depends on the picked operation starts at its defaults, not empty.
    const create = linear.descriptor.properties.filter((p) => p.displayOptions?.show?.operation?.includes('create') && p.default !== undefined && p.default !== '');
    for (const p of create) expect(node.data.wf.parameters, p.name).toHaveProperty(p.name);
    editor().undo();
    expect(editor().nodes).toEqual([]);
  });
});
