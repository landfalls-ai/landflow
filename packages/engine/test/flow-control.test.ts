import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType, type JsonObject, type NodeItem } from '@landflow/sdk';
import {
  executeWorkflow,
  inProcessNodeType,
  type ExecuteWorkflowOptions,
  type ExecutionEvent,
  type NodeTypeResolver,
  type ResumeState,
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

const merge = defineNode({
  description: { name: 'merge', displayName: 'Merge', description: '', version: 1, kind: 'action', inputs: [...main, ...main], outputs: main, properties: [] },
  execute: (ctx) => [[...ctx.getInputData(0), ...ctx.getInputData(1)]],
});

/** Asks the engine to wait; returns its input marked, which is the output of a `time` resume. */
const pause = defineNode({
  description: {
    name: 'pause', displayName: 'Pause', description: '', version: 1, kind: 'action', inputs: main, outputs: main,
    properties: [{ name: 'resume', displayName: 'Resume', type: 'string', default: 'webhook' }],
  },
  execute(ctx) {
    const resume = ctx.getNodeParameter<'time' | 'webhook'>('resume');
    ctx.logger.info('waiting');
    ctx.putExecutionToWait!({ resume, ...(resume === 'time' && { until: new Date(Date.now() + 3_600_000).toISOString() }), data: { note: 'hi' } });
    return [ctx.getInputData().map((item) => ({ json: { ...item.json, waited: true } }))];
  },
});

/** A tiny Loop Over Items: output 0 = done (everything that came back), output 1 = the next batch of one. */
const loop = defineNode({
  description: { name: 'loop', displayName: 'Loop', description: '', version: 1, kind: 'action', inputs: main, outputs: [...main, ...main], properties: [] },
  execute(ctx) {
    const state = ctx.getNodeState!<{ left: JsonObject[]; done: JsonObject[] }>();
    const input = ctx.getInputData().map((item) => item.json);
    const next = state ? { left: state.left, done: [...state.done, ...input] } : { left: input, done: [] as JsonObject[] };
    const batch = next.left.slice(0, 1);
    if (!batch.length) {
      ctx.setNodeState!(undefined);
      return [next.done.map((json) => ({ json })), []];
    }
    ctx.setNodeState!({ left: next.left.slice(1), done: next.done });
    return [[], batch.map((json) => ({ json }))];
  },
});

/** Never settles and ignores the abort signal. */
const stuck = defineNode({
  description: { name: 'stuck', displayName: 'Stuck', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: () => new Promise<NodeItem[]>(() => {}),
});

const registry: Record<string, INodeType> = { trigger, set, merge, pause, loop, stuck };
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
const c = (source: string, target: string, sourceIndex = 0, targetIndex = 0): WorkflowConnection => ({
  id: `${source}-${target}-${sourceIndex}-${targetIndex}`, type: 'main', source, sourceIndex, target, targetIndex,
});
const wf = (nodes: WorkflowNode[], connections: WorkflowConnection[], settings?: Workflow['settings']): Workflow => ({ id: 'wf', name: 'Test', nodes, connections, settings });
const run = (workflow: Workflow, options: Partial<ExecuteWorkflowOptions> = {}) =>
  executeWorkflow({ workflow, resolver, executionId: 'ex_wait', mode: 'manual', triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }], ...options });
const json = (items: NodeItem[] | undefined) => (items ?? []).map((item) => item.json);
/** What the runner does: the state goes to disk as JSON. */
const persisted = (state: ResumeState | undefined): ResumeState => JSON.parse(JSON.stringify(state));

describe('waiting executions', () => {
  it('suspends at the waiting node and resumes with the payload as its output', async () => {
    const workflow = wf([n('a', 'trigger'), n('b', 'set', { value: 'before' }), n('w', 'pause'), n('d', 'set', { key: 'after', value: '{{ $json.reply }}' })], [c('a', 'b'), c('b', 'w'), c('w', 'd')]);
    const first = await run(workflow);
    expect(first.status).toBe('waiting');
    expect(first.wait).toMatchObject({ nodeId: 'w', nodeName: 'w', resume: 'webhook', data: { note: 'hi' } });
    expect(first.runData.w).toBeUndefined();
    expect(first.executionOrder).toEqual(['a', 'b']);
    expect(first.resumeState?.waiting.inputs[0]).toHaveLength(2);

    const events: ExecutionEvent[] = [];
    const resumed = await run(workflow, {
      resume: { state: persisted(first.resumeState), kind: 'webhook', outputs: [[{ json: { reply: 'yes' } }]] },
      onEvent: (event) => events.push(event),
    });
    expect(resumed.status).toBe('success');
    expect(resumed.startedAt).toBe(first.startedAt);
    expect(resumed.executionOrder).toEqual(['a', 'b', 'w', 'd']);
    expect(json(resumed.runData.w[0].outputs[0])).toEqual([{ reply: 'yes' }]);
    expect(resumed.runData.w[0].logs?.map((l) => l.message)).toEqual(['waiting', 'Resumed by a webhook call']);
    expect(json(resumed.runData.d[0].outputs[0])).toEqual([{ reply: 'yes', after: 'yes' }]);
    expect(events[0]).toMatchObject({ type: 'execution.started', resumed: true });
    // Only the new runs are streamed.
    expect(events.filter((e) => e.type === 'node.finished').map((e) => e.type === 'node.finished' && e.nodeId)).toEqual(['w', 'd']);
  });

  it('continues a time wait with what the node returned', async () => {
    const workflow = wf([n('a', 'trigger'), n('w', 'pause', { resume: 'time' })], [c('a', 'w')]);
    const first = await run(workflow);
    expect(first.wait?.resume).toBe('time');
    expect(Date.parse(first.wait!.until!)).toBeGreaterThan(Date.now());
    const resumed = await run(workflow, { resume: { state: persisted(first.resumeState), kind: 'time' } });
    expect(json(resumed.runData.w[0].outputs[0])).toEqual([{ n: 1, waited: true }, { n: 2, waited: true }]);
    expect(resumed.lastNodeId).toBe('w');
  });

  it('keeps other branches and parked multi-input nodes across the wait', async () => {
    // y runs first (higher on the canvas) and parks the merge; x then waits.
    const workflow = wf(
      [n('a', 'trigger'), n('y', 'set', { key: 'from', value: 'y' }), n('x', 'pause'), n('m', 'merge'), n('z', 'set', { key: 'from', value: 'z' })],
      [c('a', 'y'), c('a', 'x'), c('a', 'z'), c('y', 'm', 0, 1), c('x', 'm', 0, 0)],
    );
    const first = await run(workflow);
    expect(first.status).toBe('waiting');
    expect(first.resumeState?.parked).toEqual([{ nodeId: 'm', slots: [null, expect.any(Array)] }]);
    expect(first.resumeState?.stack.map((e) => e.nodeId)).toEqual(['z']);
    const resumed = await run(workflow, { resume: { state: persisted(first.resumeState), kind: 'webhook', outputs: [[{ json: { from: 'x' } }]] } });
    expect(resumed.status).toBe('success');
    expect(json(resumed.runData.m[0].outputs[0]).map((j) => j.from)).toEqual(['x', 'y', 'y']);
    expect(resumed.runData.z).toHaveLength(1);
  });

  it('fails the waiting node when the resume carries an error', async () => {
    const workflow = wf([n('a', 'trigger'), n('w', 'pause'), n('d', 'set')], [c('a', 'w'), c('w', 'd')]);
    const first = await run(workflow);
    const resumed = await run(workflow, { resume: { state: persisted(first.resumeState), kind: 'subworkflow', error: 'Sub-workflow failed' } });
    expect(resumed.status).toBe('error');
    expect(resumed.error).toMatchObject({ message: 'Sub-workflow failed', nodeId: 'w' });
    expect(resumed.runData.w[0]).toMatchObject({ status: 'error', error: { message: 'Sub-workflow failed' } });
    expect(resumed.runData.d).toBeUndefined();
  });

  it('exposes the resume URLs as $execution.resumeUrl / resumeFormUrl', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'set', { value: '{{ $execution.resumeUrl }} {{ $execution.resumeFormUrl }}' })], [c('a', 'b')]), {
      resumeUrls: { webhook: 'http://h/api/waiting/ex_wait', form: 'http://h/form/waiting/ex_wait' },
    });
    expect(result.runData.b[0].outputs[0][0].json.k).toBe('http://h/api/waiting/ex_wait http://h/form/waiting/ex_wait');
  });
});

describe('loops and node state', () => {
  const loopFlow = () =>
    wf(
      [
        n('a', 'trigger'),
        n('l', 'loop', {}, { name: 'Loop' }),
        n('body', 'set', { key: 'seen', value: "{{ $('Loop').item.json.n }}" }),
        n('after', 'set', { key: 'latest', value: "{{ $('Loop').item.json.n }}" }),
        n('done', 'set', { key: 'finished', value: 'yes' }),
      ],
      [c('a', 'l'), c('l', 'done', 0), c('l', 'body', 1), c('body', 'after'), c('after', 'l')],
    );

  it('runs a loop back to an earlier node until it is done', async () => {
    const result = await run(loopFlow(), { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }] });
    expect(result.status).toBe('success');
    expect(result.runData.l).toHaveLength(4);
    expect(result.runData.body.map((r) => r.outputs[0][0].json.seen)).toEqual([1, 2, 3]);
    // Not a direct child of the loop: $('Loop') still sees the latest batch (output 0 is empty while looping).
    expect(result.runData.after.map((r) => r.outputs[0][0].json.latest)).toEqual([1, 2, 3]);
    expect(json(result.runData.done[0].outputs[0]).map((j) => [j.n, j.seen, j.finished])).toEqual([
      [1, 1, 'yes'],
      [2, 2, 'yes'],
      [3, 3, 'yes'],
    ]);
  });

  it('keeps node state across waits inside a loop', async () => {
    const workflow = wf(
      [n('a', 'trigger'), n('l', 'loop'), n('w', 'pause'), n('done', 'set', { key: 'finished', value: 'yes' })],
      [c('a', 'l'), c('l', 'done', 0), c('l', 'w', 1), c('w', 'l')],
    );
    let result = await run(workflow);
    const replies: string[] = [];
    while (result.status === 'waiting') {
      expect(result.resumeState?.nodeState.l).toBeDefined();
      replies.push(`r${replies.length}`);
      result = await run(workflow, { resume: { state: persisted(result.resumeState), kind: 'webhook', outputs: [[{ json: { reply: replies.at(-1)! } }]] } });
    }
    expect(result.status).toBe('success');
    expect(replies).toEqual(['r0', 'r1']);
    expect(json(result.runData.done[0].outputs[0])).toEqual([
      { reply: 'r0', finished: 'yes' },
      { reply: 'r1', finished: 'yes' },
    ]);
  });

  it('stops a destination run before the loop without walking it forever', async () => {
    const result = await run(loopFlow(), { destinationNodeId: 'body' });
    expect(result.status).toBe('success');
    expect(Object.keys(result.runData).sort()).toEqual(['a', 'body', 'l']);
  });

  it('re-runs a loop from its loop node with the input from outside the loop', async () => {
    const workflow = loopFlow();
    const source = await run(workflow, { triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] });
    const partial = await run(workflow, {
      executionId: 'ex_partial',
      partial: { executionId: 'ex_wait', runData: source.runData, executionOrder: source.executionOrder, startNodeId: 'l', scope: 'from' },
    });
    expect(partial.status).toBe('success');
    expect(partial.runData.body.filter((r) => !r.reused).map((r) => r.outputs[0][0].json.seen)).toEqual([1, 2]);
    expect(json(partial.runData.done.filter((r) => !r.reused)[0].outputs[0])).toHaveLength(2);
  });
});

describe('workflow timeout', () => {
  it('fails the run when settings.timeoutSeconds runs out, even if a node ignores the signal', async () => {
    const started = Date.now();
    const result = await run(wf([n('a', 'trigger'), n('s', 'stuck')], [c('a', 's')], { timeoutSeconds: 1 }));
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Workflow timed out after 1 s');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('counts only running time: a resumed run gets what is left', async () => {
    const workflow = wf([n('a', 'trigger'), n('w', 'pause'), n('s', 'stuck')], [c('a', 'w'), c('w', 's')], { timeoutSeconds: 60 });
    const first = await run(workflow);
    expect(first.status).toBe('waiting');
    const state = { ...persisted(first.resumeState), activeMs: 60_000 };
    const resumed = await run(workflow, { resume: { state, kind: 'webhook' } });
    expect(resumed.status).toBe('error');
    expect(resumed.error?.message).toBe('Workflow timed out after 60 s');
  });

  it('reports a cancel as canceled, not as a timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await run(wf([n('a', 'trigger'), n('s', 'stuck')], [c('a', 's')], { timeoutSeconds: 30 }), { signal: controller.signal });
    expect(result.status).toBe('canceled');
  });
});
