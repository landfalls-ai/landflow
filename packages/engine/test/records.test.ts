import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import type { ExecuteResponse, NodeRecord } from '@landflow/protocol';
import {
  executeWorkflow,
  inProcessNodeType,
  type AgentTool,
  type ExecutionEvent,
  type NodeTypeResolver,
  type Workflow,
  type WorkflowConnection,
  type WorkflowNode,
} from '../src';

const main = [{ type: 'main' as const }];
const desc = (name: string, extra: object = {}) => ({ name, displayName: name, description: '', version: 1, kind: 'action' as const, inputs: main, outputs: main, properties: [], ...extra });

const trigger = defineNode({ description: desc('trigger', { kind: 'trigger', inputs: [] }), execute: (ctx) => [ctx.getInputData()] });
const reporter = defineNode({
  description: desc('reporter', { usableAsTool: true }),
  execute: (ctx) => {
    ctx.artifact({ name: 'PR #1: Hello', kind: 'pull_request', url: 'https://example.test/pr/1' });
    ctx.check({ name: 'tests', status: 'pass' });
    return [ctx.getInputData()];
  },
});
const caller = defineNode({
  description: desc('caller', { inputs: [...main, { type: 'ai_tool' }] }),
  async execute(ctx) {
    const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    await tool.invoke({ title: 'Hello' });
    return [[{ json: {} }]];
  },
});

const records: NodeRecord[] = [
  { type: 'artifact', name: 'Branch x', kind: 'branch', at: '2026-10-31T10:00:00.000Z' },
  { type: 'check', name: 'lint', status: 'warn' },
];
/** Stands in for a remote plugin: runs the node without a live record sink and returns its records in the response. */
const remote = (node: INodeType) => {
  const resolved = inProcessNodeType('t', node);
  return {
    ...resolved,
    transport: 'http' as const,
    execute: async (): Promise<ExecuteResponse> => ({ outputs: [[{ json: { remote: true } }]], records }),
  };
};

let inProcess = true;
const nodes: Record<string, INodeType> = { trigger, reporter, caller };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = nodes[type.replace(/^t\./, '')];
    if (!node) return { error: `Unknown node type "${type}"` };
    return inProcess || type !== 't.reporter' ? inProcessNodeType('t', node) : remote(node);
  },
};

let y = 0;
const n = (id: string, type: string): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, (y += 100)], parameters: {} });
const c = (source: string, target: string, type: WorkflowConnection['type'] = 'main', targetIndex = 0): WorkflowConnection => ({ id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex });
const wf = (workflowNodes: WorkflowNode[], connections: WorkflowConnection[]): Workflow => ({ id: 'wf', name: 'Test', nodes: workflowNodes, connections });

async function events(workflow: Workflow) {
  const out: ExecutionEvent[] = [];
  const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }], onEvent: (e) => out.push(e) });
  expect(result.status).toBe('success');
  return out.filter((e): e is Extract<ExecutionEvent, { type: 'node.record' }> => e.type === 'node.record');
}

describe('node.record', () => {
  it('reports what an in-process main node makes, in order, as it happens', async () => {
    inProcess = true;
    const found = await events(wf([n('a', 'trigger'), n('r', 'reporter')], [c('a', 'r')]));
    expect(found.map((e) => [e.nodeId, e.record.type, e.record.name])).toEqual([['r', 'artifact', 'PR #1: Hello'], ['r', 'check', 'tests']]);
    expect(found[0]!.parentNodeId).toBeUndefined();
    expect(found[0]!.record).toMatchObject({ kind: 'pull_request', url: 'https://example.test/pr/1' });
    expect(found[0]!.at).toBe(found[0]!.record.at);
  });

  it('reports a tool sub-node under its root, and gives node.started the call arguments', async () => {
    inProcess = true;
    const out: ExecutionEvent[] = [];
    await executeWorkflow({
      workflow: wf([n('a', 'trigger'), n('k', 'caller'), n('t', 'reporter')], [c('a', 'k'), c('t', 'k', 'ai_tool', 1)]),
      resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }], onEvent: (e) => out.push(e),
    });
    const found = out.filter((e) => e.type === 'node.record');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ nodeId: 't', parentNodeId: 'k' });
    const started = out.find((e) => e.type === 'node.started' && e.nodeId === 't');
    expect(started).toMatchObject({ parentNodeId: 'k', input: { title: 'Hello' } });
    expect(out.find((e) => e.type === 'node.started' && e.nodeId === 'k')).not.toHaveProperty('input');
  });

  it('reports the records of a remote response, at their own time or the receive time', async () => {
    inProcess = false;
    const before = Date.now();
    const found = await events(wf([n('a', 'trigger'), n('r', 'reporter')], [c('a', 'r')]));
    inProcess = true;
    expect(found.map((e) => e.record.name)).toEqual(['Branch x', 'lint']);
    expect(found[0]!.at).toBe('2026-10-31T10:00:00.000Z');
    expect(Date.parse(found[1]!.at)).toBeGreaterThanOrEqual(before);
  });

  it('reports the records of a remote tool sub-node under its root', async () => {
    inProcess = false;
    const out: ExecutionEvent[] = [];
    await executeWorkflow({
      workflow: wf([n('a', 'trigger'), n('k', 'caller'), n('t', 'reporter')], [c('a', 'k'), c('t', 'k', 'ai_tool', 1)]),
      resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }], onEvent: (e) => out.push(e),
    });
    inProcess = true;
    const found = out.filter((e) => e.type === 'node.record');
    expect(found.map((e) => e.type === 'node.record' && e.parentNodeId)).toEqual(['k', 'k']);
  });
});
