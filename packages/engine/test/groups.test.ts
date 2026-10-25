/**
 * Canvas groups are editor-only, like sticky notes: a workflow with groups (collapsed or not, even ones that name
 * nodes that don't exist) runs exactly like the same workflow without them.
 */
import { describe, expect, it } from 'vitest';
import { defineNode } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, type NodeTypeResolver, type Workflow } from '../src';

const main = [{ type: 'main' as const }];

const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

const double = defineNode({
  description: { name: 'double', displayName: 'Double', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData().map((item) => ({ json: { n: Number(item.json.n) * 2 } }))],
});

const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = { 'test.trigger': trigger, 'test.double': double }[type];
    return node ? inProcessNodeType('test', node) : { error: `Unknown node type ${type}` };
  },
};

const base: Workflow = {
  id: 'wf_groups',
  name: 'Groups',
  nodes: [
    { id: 'start', name: 'Start', type: 'test.trigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'A', type: 'test.double', typeVersion: 1, position: [240, 0], parameters: {} },
    { id: 'b', name: 'B', type: 'test.double', typeVersion: 1, position: [480, 0], parameters: {} },
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'start', sourceIndex: 0, target: 'a', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
  ],
};

const run = (workflow: Workflow) =>
  executeWorkflow({ workflow, resolver, executionId: `ex_${Math.random().toString(36).slice(2)}`, mode: 'manual', triggerItems: [{ json: { n: 3 } }] });

describe('canvas groups in the engine', () => {
  it('runs a workflow with groups exactly like one without', async () => {
    const plain = await run(base);
    const grouped = await run({
      ...base,
      groups: [
        { id: 'g1', name: 'Doubling', nodeIds: ['a', 'b'], position: [200, -60], width: 560, height: 220, color: 4 },
        { id: 'g2', name: 'Collapsed, with a stale member', nodeIds: ['start', 'gone'], position: [-40, -60], width: 200, height: 200, collapsed: true },
      ],
    });
    expect(plain.status).toBe('success');
    expect(grouped.status).toBe('success');
    expect(grouped.executionOrder).toEqual(plain.executionOrder);
    expect(grouped.runData.b?.[0]?.outputs[0]?.map((item) => item.json)).toEqual([{ n: 12 }]);
    expect(grouped.runData.b?.[0]?.outputs).toEqual(plain.runData.b?.[0]?.outputs);
    expect(Object.keys(grouped.runData).sort()).toEqual(['a', 'b', 'start']);
  });
});
