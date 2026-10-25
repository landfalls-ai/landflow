/**
 * The engine's part of the durable runtime: a node's `timeoutSeconds` (per attempt, through the
 * abort signal, with retries and "continue on error"), per-step idempotency keys, a checkpoint
 * after every main-flow node, and continuing a run from a checkpoint (`kind: 'restart'`) as if it
 * had never stopped, `$('Node')` references included.
 */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType, type NodeItem } from '@landflow/sdk';
import {
  executeWorkflow,
  inProcessNodeType,
  type ExecuteWorkflowOptions,
  type NodeTypeResolver,
  type RunCheckpoint,
  type Workflow,
  type WorkflowConnection,
  type WorkflowNode,
} from '../src';

const main = [{ type: 'main' as const }];

const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

const set = defineNode({
  description: {
    name: 'set', displayName: 'Set', description: '', version: 1, kind: 'action', inputs: main, outputs: main,
    properties: [{ name: 'key', displayName: 'Key', type: 'string', default: 'k' }, { name: 'value', displayName: 'Value', type: 'string' }],
  },
  execute: (ctx) =>
    ctx.getInputData().map((item, i) => ({ json: { ...item.json, [ctx.getNodeParameter<string>('key', i)]: ctx.getNodeParameter('value', i) } })),
});

let slowCalls = 0;
/** Takes `ms` (default 1 s) and honors the abort signal. */
const slow = defineNode({
  description: {
    name: 'slow', displayName: 'Slow', description: '', version: 1, kind: 'action', inputs: main, outputs: main,
    properties: [{ name: 'ms', displayName: 'Milliseconds', type: 'number', default: 1000 }],
  },
  execute(ctx) {
    slowCalls++;
    const ms = ctx.getNodeParameter<number>('ms', 0);
    return new Promise<NodeItem[]>((resolve, reject) => {
      const timer = setTimeout(() => resolve(ctx.getInputData()), ms);
      ctx.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  },
});

/** Never settles and ignores the abort signal. */
const stuck = defineNode({
  description: { name: 'stuck', displayName: 'Stuck', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: () => new Promise<NodeItem[]>(() => {}),
});

/** Outputs the idempotency key it was called with. */
const keyed = defineNode({
  description: { name: 'keyed', displayName: 'Keyed', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) => [{ json: { key: ctx.getIdempotencyKey() ?? null } }],
});

const registry: Record<string, INodeType> = { trigger, set, slow, stuck, keyed };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};

let y = 0;
const n = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, name: extra.name ?? id, type: `t.${type}`, typeVersion: 1, position: [0, (y += 100)], parameters, ...extra,
});
const c = (source: string, target: string): WorkflowConnection => ({ id: `${source}-${target}`, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 });
const wf = (nodes: WorkflowNode[], connections: WorkflowConnection[]): Workflow => ({ id: 'wf', name: 'Durable', nodes, connections });
const run = (workflow: Workflow, options: Partial<ExecuteWorkflowOptions> = {}) =>
  executeWorkflow({ workflow, resolver, executionId: 'ex_durable', mode: 'trigger', triggerItems: [{ json: { n: 1 } }], ...options });
const json = (items: NodeItem[] | undefined) => (items ?? []).map((item) => item.json);
/** Through JSON, like a checkpoint saved to the database. */
const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('node timeout', () => {
  it('fails an attempt that takes longer than timeoutSeconds, through the abort signal', async () => {
    const started = Date.now();
    const result = await run(wf([n('a', 'trigger'), n('s', 'slow', { ms: 5000 }, { timeoutSeconds: 0.05 })], [c('a', 's')]));
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ message: 'Node timed out after 0.05 s', nodeId: 's' });
    expect(result.runData.s[0].status).toBe('error');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('also stops a node that ignores the signal', async () => {
    const result = await run(wf([n('a', 'trigger'), n('s', 'stuck', {}, { timeoutSeconds: 0.05 })], [c('a', 's')]));
    expect(result.error?.message).toBe('Node timed out after 0.05 s');
  });

  it('counts per attempt: retries run again, and "continue on error" goes on', async () => {
    slowCalls = 0;
    const retried = await run(wf([n('a', 'trigger'), n('s', 'slow', { ms: 5000 }, { timeoutSeconds: 0.03, retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 0 })], [c('a', 's')]));
    expect(retried.status).toBe('error');
    expect(slowCalls).toBe(3);

    const continued = await run(
      wf([n('a', 'trigger'), n('s', 'slow', { ms: 5000 }, { timeoutSeconds: 0.03, onError: 'continue' }), n('b', 'set', { key: 'after', value: 'yes' })], [c('a', 's'), c('s', 'b')]),
    );
    expect(continued.status).toBe('success');
    expect(json(continued.runData.b[0].outputs[0])[0]).toMatchObject({ after: 'yes', error: { message: 'Node timed out after 0.03 s' } });
  });

  it('leaves a node alone that finishes in time', async () => {
    const result = await run(wf([n('a', 'trigger'), n('s', 'slow', { ms: 5 }, { timeoutSeconds: 2 })], [c('a', 's')]));
    expect(result.status).toBe('success');
  });
});

describe('idempotency keys', () => {
  it('gives every main-flow step `<executionId>:<nodeId>:<runIndex>`', async () => {
    const result = await run(wf([n('a', 'trigger'), n('k', 'keyed'), n('k2', 'keyed')], [c('a', 'k'), c('k', 'k2')]));
    expect(json(result.runData.k[0].outputs[0])).toEqual([{ key: 'ex_durable:k:0' }]);
    expect(json(result.runData.k2[0].outputs[0])).toEqual([{ key: 'ex_durable:k2:0' }]);
  });
});

describe('checkpoints', () => {
  const chain = () =>
    wf(
      [n('a', 'trigger'), n('b', 'set', { key: 'b', value: '{{ $json.n }}' }, { name: 'B' }), n('c', 'set', { key: 'c', value: "{{ $('B').item.json.b }}!" }), n('d', 'set', { key: 'd', value: 'done' })],
      [c('a', 'b'), c('b', 'c'), c('c', 'd')],
    );

  it('hands over the state after the start and after every main-flow node, under a stable step id', async () => {
    const checkpoints: RunCheckpoint[] = [];
    const result = await run(chain(), { onCheckpoint: (checkpoint) => checkpoints.push(persisted(checkpoint)) });
    expect(result.status).toBe('success');
    expect(checkpoints.map((cp) => cp.stepId)).toEqual(['start', 'a#0', 'b#0', 'c#0', 'd#0']);
    expect(checkpoints.map((cp) => cp.steps)).toEqual([0, 1, 2, 3, 4]);
    expect(checkpoints[2].state.stack.map((entry) => entry.nodeId)).toEqual(['c']);
    expect(checkpoints[2].state.waiting).toBeUndefined();
  });

  it('continues from a checkpoint after a crash as if it never stopped, `$(Node)` included', async () => {
    const workflow = chain();
    const uninterrupted = await run(workflow);
    const checkpoints: RunCheckpoint[] = [];
    await run(workflow, { onCheckpoint: (checkpoint) => checkpoints.push(persisted(checkpoint)) });
    const afterB = checkpoints.find((cp) => cp.stepId === 'b#0')!;

    // What the host saves: the state without run data or `$('Node')` outputs; the runs come from its step rows.
    const runs = { runData: afterB.state.runData, executionOrder: afterB.state.executionOrder };
    const state = { ...afterB.state, ...runs, nodeOutputs: {} };
    const resumed = await run(workflow, { resume: { state, kind: 'restart' } });
    expect(resumed.status).toBe('success');
    expect(resumed.executionOrder).toEqual(['a', 'b', 'c', 'd']);
    expect(json(resumed.runData.c[0].outputs[0])).toEqual(json(uninterrupted.runData.c[0].outputs[0]));
    expect(json(resumed.runData.c[0].outputs[0])).toEqual([{ n: 1, b: 1, c: '1!' }]);
    expect(resumed.startedAt).toBe(afterB.state.startedAt);
  });

  it('refuses a checkpoint whose next node is no longer in the workflow', async () => {
    const workflow = chain();
    const checkpoints: RunCheckpoint[] = [];
    await run(workflow, { onCheckpoint: (checkpoint) => checkpoints.push(persisted(checkpoint)) });
    const afterB = checkpoints.find((cp) => cp.stepId === 'b#0')!;
    const changed = { ...workflow, nodes: workflow.nodes.filter((node) => node.id !== 'c') };
    const resumed = await run(changed, { resume: { state: afterB.state, kind: 'restart' } });
    expect(resumed.status).toBe('error');
    expect(resumed.error?.message).toMatch(/Node c of the saved state is not in the workflow/);
  });
});
