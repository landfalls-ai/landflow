/**
 * Composite frames the engine runs as one step (docs/composites.md): a node failing in a frame that falls back stops
 * the frame, not the run (what entered the frame goes to its fallback with the error), a frame past its timeout fails
 * at its next node, and nodes inside read the frame's properties as `$composite.params`.
 */
import { describe, expect, it } from 'vitest';
import { defineNode, NodeOperationError } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, type CompositeScope, type NodeTypeResolver, type Workflow, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];
const action = (name: string, execute: Parameters<typeof defineNode>[0]['execute'], properties: Array<{ name: string }> = []) =>
  defineNode({
    description: { name, displayName: name, description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: properties.map((p) => ({ ...p, displayName: p.name, type: 'string' as const, default: '' })) },
    execute,
  });

const types = {
  'test.trigger': defineNode({
    description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
    execute: (ctx) => [ctx.getInputData()],
  }),
  'test.double': action('double', (ctx) => [ctx.getInputData().map((item) => ({ json: { ...item.json, n: Number(item.json.n) * 2 } }))]),
  'test.boom': action('boom', () => {
    throw new NodeOperationError('kaboom');
  }),
  'test.slow': action('slow', async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return [ctx.getInputData()];
  }),
  'test.set': action('set', (ctx) => [ctx.getInputData().map((item, i) => ({ json: { ...item.json, value: ctx.getNodeParameter('value', i) } }))], [{ name: 'value' }]),
};
const resolver: NodeTypeResolver = {
  resolve: (type) => (type in types ? inProcessNodeType('test', types[type as keyof typeof types]) : { error: `Unknown node type ${type}` }),
};

const n = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id[0].toUpperCase() + id.slice(1), type: `test.${type}`, typeVersion: 1, position: [0, 0], parameters });
const c = (source: string, target: string, targetIndex = 0) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex });

/** start → a (double) → [frame: inner (given) → after (double)] → out (double); handler is the frame's fallback. */
const flow = (inner: WorkflowNode): Workflow => ({
  id: 'wf_scopes',
  name: 'Scopes',
  nodes: [n('start', 'trigger'), n('a', 'double'), inner, n('after', 'double'), n('out', 'double'), n('handler', 'set', { value: 'handled' })],
  connections: [c('start', 'a'), c('a', inner.id), c(inner.id, 'after'), c('after', 'out')],
});
const scope = (patch: Partial<CompositeScope> = {}): CompositeScope => ({ id: 'g1', name: 'Frame', type: 'test.frame', nodeIds: ['inner', 'after'], onError: 'fallback', fallback: [{ target: 'handler', targetIndex: 0 }], ...patch });
const run = (workflow: Workflow, scopes?: CompositeScope[]) =>
  executeWorkflow({ workflow, resolver, executionId: `ex_${Math.random().toString(36).slice(2)}`, mode: 'manual', triggerItems: [{ json: { n: 3 } }], ...(scopes && { scopes }) });

describe('composite frames in the engine', () => {
  it('without a scope, a failing node stops the run', async () => {
    const result = await run(flow({ ...n('inner', 'boom') }));
    expect(result.status).toBe('error');
    expect(result.runData.handler).toBeUndefined();
  });

  it('a frame that falls back stops there and hands what entered it, with the error, to its fallback', async () => {
    const result = await run(flow(n('inner', 'boom')), [scope()]);
    expect(result.status).toBe('success');
    expect(result.runData.after).toBeUndefined();
    expect(result.runData.out).toBeUndefined();
    // What entered the frame (A's output), not the failing node's own input.
    expect(result.runData.handler?.[0]?.outputs[0]?.map((item) => item.json)).toEqual([{ n: 6, error: { message: 'kaboom', node: 'Inner', composite: 'Frame' }, value: 'handled' }]);
    expect(result.runData.inner?.[0]?.status).toBe('error');
    expect(result.runData.inner?.[0]?.logs?.at(-1)?.message).toContain('fell back to “Handler”');
  });

  it('a frame with nothing on its fallback ends quietly; one that stops keeps stopping the run', async () => {
    const quiet = await run(flow(n('inner', 'boom')), [scope({ fallback: [] })]);
    expect(quiet.status).toBe('success');
    expect(quiet.runData.inner?.[0]?.logs?.at(-1)?.message).toContain('nothing is connected');
    const stops = await run(flow(n('inner', 'boom')), [scope({ onError: 'stop' })]);
    expect(stops.status).toBe('error');
  });

  it('a node starting past the frame’s timeout fails with it, and the fallback applies', async () => {
    const result = await run(flow(n('inner', 'slow')), [scope({ timeoutSeconds: 0.01 })]);
    expect(result.status).toBe('success');
    expect(result.runData.after?.[0]?.status).toBe('error');
    expect(result.runData.after?.[0]?.error?.message).toContain('ran past its 0.01 s limit');
    expect(result.runData.handler?.[0]?.outputs[0]?.[0]?.json.error).toMatchObject({ node: 'After', composite: 'Frame' });
    // Without a timeout the same frame runs through.
    const plain = await run(flow(n('inner', 'slow')), [scope()]);
    expect(plain.runData.out?.[0]?.outputs[0]?.[0]?.json.n).toBe(24);
  });

  it('nested frames: the innermost that falls back takes the failure', async () => {
    const outer = scope({ id: 'g0', name: 'Outer', nodeIds: ['a', 'inner', 'after'], fallback: [{ target: 'out', targetIndex: 0 }] });
    const result = await run(flow(n('inner', 'boom')), [outer, scope()]);
    expect(result.runData.handler?.[0]?.outputs[0]?.[0]?.json.error).toMatchObject({ composite: 'Frame' });
    expect(result.runData.out).toBeUndefined();
  });

  it('nodes inside read the frame’s properties as $composite.params; outside it is empty', async () => {
    const workflow = flow(n('inner', 'set', { value: '{{ $composite.params.threshold }}:{{ $composite.name }}' }));
    workflow.nodes.find((node) => node.id === 'out')!.type = 'test.set';
    workflow.nodes.find((node) => node.id === 'out')!.parameters = { value: '{{ String($composite.params.threshold) }}' };
    const result = await run(workflow, [scope({ params: { threshold: 7 } })]);
    expect(result.runData.inner?.[0]?.outputs[0]?.[0]?.json.value).toBe('7:Frame');
    expect(result.runData.out?.[0]?.outputs[0]?.[0]?.json.value).toBe('undefined');
  });
});
