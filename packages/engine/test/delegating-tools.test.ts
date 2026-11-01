import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, withReason, type AgentTool, type ExecutionEvent, type NodeTypeResolver, type Workflow, type WorkflowConnection, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];

const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

/** A tool that remembers how often it was called in the run (ctx.getNodeState) and reports what it saw. */
const asker = defineNode({
  description: {
    name: 'asker', displayName: 'Asker', description: 'asks', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, delegates: true,
    properties: [{ name: 'message', displayName: 'Message', type: 'string', default: '' }],
  },
  execute(ctx) {
    const calls = ((ctx.getNodeState?.() as { calls?: number } | undefined)?.calls ?? 0) + 1;
    ctx.setNodeState?.({ calls });
    return [[{ json: { message: ctx.getNodeParameter('message'), calls, input: ctx.getInputData()[0].json } }]];
  },
});

const caller = defineNode({
  description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
  async execute(ctx) {
    const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const first = await tool.invoke({ message: 'one', reason: 'because the plan needs it' });
    const second = await tool.invoke({ message: 'two', reason: 'follow up' });
    return [[{ json: { schema: tool.inputSchema, first, second } as never }]];
  },
});

const registry: Record<string, INodeType> = { trigger, asker, caller };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};
const node = (id: string, type: string, position: number): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, position], parameters: {} });
const edge = (source: string, target: string, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({
  id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex,
});

describe('tools of nodes that delegate', () => {
  it('adds a required reason, keeps it out of the node, records it, and keeps node state across calls', async () => {
    const workflow: Workflow = { id: 'wf', name: 'Test', nodes: [node('a', 'trigger', 1), node('c', 'caller', 2), node('s', 'asker', 3)], connections: [edge('a', 'c'), edge('s', 'c', 1, 'ai_tool')] };
    const events: ExecutionEvent[] = [];
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }], onEvent: (e) => events.push(e) });
    expect(result.status).toBe('success');
    const out = result.runData.c[0].outputs[0][0].json as { schema: { required: string[]; properties: Record<string, unknown> }; first: { input: Record<string, unknown>; calls: number }; second: { calls: number } };
    expect(out.schema.required).toContain('reason');
    expect(out.schema.properties.reason).toMatchObject({ type: 'string' });
    // The node never sees the reason, only the arguments it knows.
    expect(out.first.input).toEqual({ message: 'one' });
    // Its state lasts for the run: the second call is its second.
    expect([out.first.calls, out.second.calls]).toEqual([1, 2]);
    // The event carries it for the journal.
    const started = events.filter((e): e is Extract<ExecutionEvent, { type: 'node.started' }> => e.type === 'node.started' && e.nodeId === 's');
    expect(started[0].input).toEqual({ message: 'one', reason: 'because the plan needs it' });
  });

  it('withReason copies the schema', () => {
    const base = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
    expect(withReason(base)).toMatchObject({ required: ['message', 'reason'] });
    expect(base.required).toEqual(['message']);
  });
});
