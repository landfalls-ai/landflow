/**
 * Wave ag3 fix pass (AG12): the '+' under a banded Run an Agent tile. Sub-nodes land below the tile's slot labels and + buttons (a
 * ~50 px block under the tile), not on them: the parent's measured height plus `SUBNODE_CLEARANCE`. The banded tile itself is
 * measured in the browser (~131 canvas px with three tool rows); happy-dom has no layout, so the height budget is the 140 the
 * placements below assume (200 px below the tile's top, less the label block).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, NodeTypeInfo } from '@/lib/shared/types';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-clearance-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { useEditor, SUBNODE_CLEARANCE } = await import('@/components/editor/store');

const info = (descriptor: NodeDescriptor): NodeTypeInfo => ({ type: `core.${descriptor.name}`, pluginId: 'core', pluginName: 'Landflow Core', language: 'typescript', transport: 'in-process', available: true, descriptor }) as NodeTypeInfo;
const nodeTypes = Object.fromEntries(corePlugin.nodes.map((n) => [`core.${n.description.name}`, info(n.description)]));
const LABEL_BLOCK = 52; // the slot labels and + buttons under a tile, as measured in the browser

describe('the + path under a banded agent tile', () => {
  it('the third tool added clears the label block of the tile', () => {
    useEditor.getState().load({ id: 'wf_clear', name: 'Clear', nodes: [{ id: 'agent', name: 'Alert triager', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: 'a1' } }], connections: [] }, []);
    useEditor.setState({ nodeTypes: nodeTypes as never });
    const BAND = 131; // measured in the browser: head 48, band with three tool rows
    useEditor.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, measured: { width: 300, height: BAND } })) }));
    const tools: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = useEditor.getState().placeNode('core.set', { from: { nodeId: 'agent', handleId: 'ai_tool:0', handleType: 'target' } }, { x: 0, y: 0 });
      expect(id, `tool ${i + 1}`).toBeDefined();
      tools.push(id!);
    }
    const agent = useEditor.getState().nodes.find((n) => n.id === 'agent')!;
    for (const id of tools) {
      const placed = useEditor.getState().nodes.find((n) => n.id === id)!;
      // Below the tile and its label block, with room for the sub-node's own handle.
      expect(placed.position.y - (agent.position.y + BAND), id).toBeGreaterThanOrEqual(LABEL_BLOCK + 8);
    }
    // And a measured tile taller than the budget pushes them further, never onto the labels.
    useEditor.setState((s) => ({ nodes: s.nodes.map((n) => (n.id === 'agent' ? { ...n, measured: { width: 300, height: 185 } } : n)) }));
    const tall = useEditor.getState().placeNode('core.set', { from: { nodeId: 'agent', handleId: 'ai_tool:0', handleType: 'target' } }, { x: 0, y: 0 })!;
    expect(useEditor.getState().nodes.find((n) => n.id === tall)!.position.y).toBeGreaterThanOrEqual(185 + SUBNODE_CLEARANCE);
  });
});
