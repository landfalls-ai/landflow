/**
 * AG01: items a run was given (the chat message, the run route's items) beat the start node's own pin; a start without them uses it.
 */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, type NodeTypeResolver, type Workflow, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];
const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});
const copy = defineNode({
  description: { name: 'copy', displayName: 'Copy', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData().map((item) => ({ json: { out: item.json.chatInput } }))],
});
const registry: Record<string, INodeType> = { trigger, copy };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};
const node = (id: string, type: string): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters: {} });
const flow = (pinData: Workflow['pinData']): Workflow => ({
  id: 'wf',
  name: 'Chat',
  nodes: [node('trigger', 'trigger'), node('copy', 'copy')],
  connections: [{ id: 'c', type: 'main', source: 'trigger', sourceIndex: 0, target: 'copy', targetIndex: 0 }],
  pinData,
});
const sample = [{ json: { chatInput: 'sample' } }];
const typed = [{ json: { chatInput: 'typed' } }];
const go = (workflow: Workflow, mode: 'chat' | 'manual' | 'trigger' | 'webhook', items?: typeof typed) =>
  executeWorkflow({ workflow, resolver, executionId: `ex_${mode}`, mode, startNodeId: 'trigger', ...(items && { triggerItems: items }) });
const out = (r: Awaited<ReturnType<typeof go>>) => r.runData.copy[0].outputs[0].map((i) => i.json.out);

describe('given trigger items and the start node pin', () => {
  it('runs the chat message, not the trigger pin, and says so', async () => {
    const result = await go(flow({ trigger: sample }), 'chat', typed);
    expect(out(result)).toEqual(['typed']);
    expect(result.runData.trigger[0].logs?.map((l) => l.message)).toContain('Used the chat message, not the pinned sample');
  });

  it('says "given items" outside chat mode', async () => {
    const result = await go(flow({ trigger: sample }), 'manual', typed);
    expect(out(result)).toEqual(['typed']);
    expect(result.runData.trigger[0].logs?.map((l) => l.message)).toContain('Used the given items, not the pinned data');
  });

  it('a manual run with no items still uses the trigger pin', async () => {
    const result = await go(flow({ trigger: sample }), 'manual');
    expect(out(result)).toEqual(['sample']);
    expect(result.runData.trigger[0].logs?.map((l) => l.message)).toEqual(['Using pinned data']);
  });

  it('a pin on another node is still used in chat mode', async () => {
    const result = await go(flow({ copy: [{ json: { out: 'pinned-copy' } }] }), 'chat', typed);
    expect(out(result)).toEqual(['pinned-copy']);
  });

  it('trigger and webhook runs ignore pins as before', async () => {
    for (const mode of ['trigger', 'webhook'] as const) expect(out(await go(flow({ trigger: sample }), mode, typed))).toEqual(['typed']);
  });
});
