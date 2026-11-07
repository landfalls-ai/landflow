import { describe, expect, it } from 'vitest';
import { defineNode, NodeOperationError, type INodeType, type NodeItem } from '@landflow/sdk';
import {
  executeWorkflow,
  inProcessNodeType,
  retryDelayMs,
  MAX_RETRY_WAIT_MS,
  type AgentTool,
  type ExecutionEvent,
  type LanguageModel,
  type NodeTypeResolver,
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

const branch = defineNode({
  description: {
    name: 'if', displayName: 'If', description: '', version: 1, kind: 'action', inputs: main,
    outputs: [{ type: 'main', displayName: 'true' }, { type: 'main', displayName: 'false' }],
    properties: [{ name: 'condition', displayName: 'Condition', type: 'boolean' }],
  },
  execute: (ctx) => {
    const yes: NodeItem[] = [], no: NodeItem[] = [];
    for (const [i, item] of ctx.getInputData().entries()) (ctx.getNodeParameter<boolean>('condition', i) ? yes : no).push(item);
    return [yes, no];
  },
});

const merge = defineNode({
  description: { name: 'merge', displayName: 'Merge', description: '', version: 1, kind: 'action', inputs: [...main, ...main], outputs: main, properties: [] },
  execute: (ctx) => [[...ctx.getInputData(0), ...ctx.getInputData(1)]],
});

let flakyCalls = 0;
const flaky = defineNode({
  description: { name: 'flaky', displayName: 'Flaky', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) => {
    flakyCalls++;
    if (flakyCalls < 3) throw new NodeOperationError('not yet');
    return ctx.getInputData();
  },
});

const boom = defineNode({
  description: { name: 'boom', displayName: 'Boom', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: () => {
    throw new NodeOperationError('kaboom', { description: 'it exploded' });
  },
});

// Fails on odd n, handling continueOnFail per item the way n8n integrations do.
const picky = defineNode({
  description: { name: 'picky', displayName: 'Picky', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) =>
    ctx.getInputData().map((item, i): NodeItem => {
      if (Number(item.json.n) % 2 === 0) return { json: { ok: item.json.n } };
      if (ctx.continueOnFail()) return { json: { error: `odd ${item.json.n}` }, pairedItem: { item: i } };
      throw new NodeOperationError(`odd ${item.json.n}`, { itemIndex: i });
    }),
});

const upper = defineNode({
  description: {
    name: 'upper', displayName: 'Upper', description: 'Uppercase `text`', version: 1, kind: 'action', inputs: main, outputs: main,
    usableAsTool: true, properties: [{ name: 'field', displayName: 'Field', type: 'string', default: 'text' }],
  },
  execute: (ctx) => ctx.getInputData().map((item) => ({ json: { upper: String(item.json[ctx.getNodeParameter<string>('field')]).toUpperCase() } })),
});

// A scripted model: first asks for the "Upper" tool, then answers with its result.
const scriptedModel = defineNode({
  description: { name: 'model', displayName: 'Model', description: '', version: 1, kind: 'subnode', supplies: 'ai_languageModel', inputs: [], outputs: [{ type: 'ai_languageModel' }], properties: [] },
  supplyData: (): LanguageModel => ({
    provider: 'test',
    model: 'scripted',
    async generate({ messages }) {
      const last = messages[messages.length - 1];
      if (last.role === 'tool') return { text: `Result: ${last.results[0].content}`, toolCalls: [], stopReason: 'end_turn' };
      return { text: '', toolCalls: [{ id: 't1', name: 'Upper', input: { text: 'hello' } }], stopReason: 'tool_use' };
    },
  }),
});

const agent = defineNode({
  description: {
    name: 'agent', displayName: 'Agent', description: '', version: 1, kind: 'action', outputs: main,
    inputs: [...main, { type: 'ai_languageModel', required: true, maxConnections: 1 }, { type: 'ai_tool' }], properties: [],
  },
  async execute(ctx) {
    const [model] = await ctx.getInputConnectionData!<LanguageModel>('ai_languageModel');
    const tools = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const turn = await model.generate({ messages: [{ role: 'user', content: 'go' }], tools });
    const call = turn.toolCalls[0];
    const result = await tools.find((t) => t.name === call.name)!.invoke(call.input);
    const final = await model.generate({
      messages: [{ role: 'user', content: 'go' }, { role: 'assistant', text: '', toolCalls: turn.toolCalls }, { role: 'tool', results: [{ id: call.id, name: call.name, content: JSON.stringify(result) }] }],
      tools,
    });
    return [[{ json: { output: final.text } }]];
  },
});

const registry: Record<string, INodeType> = { trigger, set, if: branch, merge, flaky, boom, picky, upper, model: scriptedModel, agent };
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
const c = (source: string, target: string, sourceIndex = 0, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({
  id: `${source}-${target}-${sourceIndex}-${targetIndex}`, type, source, sourceIndex, target, targetIndex,
});
const wf = (nodes: WorkflowNode[], connections: WorkflowConnection[]): Workflow => ({ id: 'wf', name: 'Test', nodes, connections });
const run = (workflow: Workflow, onEvent?: (e: ExecutionEvent) => void) =>
  executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }], onEvent });

describe('executeWorkflow', () => {
  it('runs a linear flow and resolves expressions per item', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'set', { key: 'double', value: '{{ $json.n * 2 }}' })], [c('a', 'b')]));
    expect(result.status).toBe('success');
    expect(result.runData.b[0].outputs[0].map((i) => i.json.double)).toEqual([2, 4]);
  });

  it('routes items down IF branches and skips empty ones', async () => {
    const result = await run(
      wf(
        [n('a', 'trigger'), n('if', 'if', { condition: '{{ $json.n > 1 }}' }), n('yes', 'set', { value: 'big' }), n('no', 'set', { value: 'small' })],
        [c('a', 'if'), c('if', 'yes', 0), c('if', 'no', 1)],
      ),
    );
    expect(result.runData.yes[0].outputs[0]).toHaveLength(1);
    expect(result.runData.no[0].outputs[0][0].json).toEqual({ n: 1, k: 'small' });
  });

  it('waits for both inputs of a merge node', async () => {
    const result = await run(
      wf(
        [n('a', 'trigger'), n('x', 'set', { key: 'from', value: 'x' }), n('y', 'set', { key: 'from', value: 'y' }), n('m', 'merge')],
        [c('a', 'x'), c('a', 'y'), c('x', 'm', 0, 0), c('y', 'm', 0, 1)],
      ),
    );
    expect(result.runData.m).toHaveLength(1);
    expect(result.runData.m[0].outputs[0].map((i) => i.json.from)).toEqual(['x', 'x', 'y', 'y']);
    expect(result.executionOrder.indexOf('m')).toBeGreaterThan(result.executionOrder.indexOf('y'));
  });

  it('runs a merge with partial input when one branch is empty', async () => {
    const result = await run(
      wf(
        [n('a', 'trigger'), n('if', 'if', { condition: true }), n('m', 'merge')],
        [c('a', 'if'), c('if', 'm', 0, 0), c('if', 'm', 1, 1)],
      ),
    );
    expect(result.runData.m[0].outputs[0]).toHaveLength(2);
  });

  it('supports $() references to earlier nodes', async () => {
    const result = await run(
      wf(
        [n('a', 'trigger'), n('b', 'set', { key: 'k', value: 'first' }, { name: 'First' }), n('c', 'set', { key: 'copy', value: "{{ $('First').item.json.k }}-{{ $itemIndex }}" })],
        [c('a', 'b'), c('b', 'c')],
      ),
    );
    expect(result.runData.c[0].outputs[0].map((i) => i.json.copy)).toEqual(['first-0', 'first-1']);
  });

  it('fails the workflow on error and reports the node', async () => {
    const events: ExecutionEvent[] = [];
    const result = await run(wf([n('a', 'trigger'), n('b', 'boom')], [c('a', 'b')]), (e) => events.push(e));
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ message: 'kaboom', nodeId: 'b' });
    expect(events.at(-1)).toMatchObject({ type: 'execution.finished', status: 'error' });
  });

  it('continues on error when configured', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'boom', {}, { onError: 'continue' }), n('c', 'set')], [c('a', 'b'), c('b', 'c')]));
    expect(result.status).toBe('success');
    expect(result.runData.c[0].outputs[0][0].json.error).toEqual({ message: 'kaboom' });
  });

  it('lets a node continue per item when it is set to continue on error', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'picky', {}, { onError: 'continue' })], [c('a', 'b')]));
    expect(result.status).toBe('success');
    expect(result.runData.b[0].outputs[0].map((i) => i.json)).toEqual([{ error: 'odd 1' }, { ok: 2 }]);
    const failed = await run(wf([n('a', 'trigger'), n('b', 'picky')], [c('a', 'b')]));
    expect(failed.error).toMatchObject({ message: 'odd 1' });
  });

  it('retries flaky nodes', async () => {
    flakyCalls = 0;
    const result = await run(wf([n('a', 'trigger'), n('b', 'flaky', {}, { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 1 })], [c('a', 'b')]));
    expect(result.status).toBe('success');
    expect(flakyCalls).toBe(3);
  });

  it('waits longer after each failed try with exponential backoff', async () => {
    expect(retryDelayMs({ waitBetweenTriesMs: 100 }, 1)).toBe(100);
    expect(retryDelayMs({ waitBetweenTriesMs: 100 }, 4)).toBe(100);
    expect(retryDelayMs({ waitBetweenTriesMs: 100, retryBackoff: 'fixed' }, 3)).toBe(100);
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs({ waitBetweenTriesMs: 100, retryBackoff: 'exponential' }, attempt))).toEqual([100, 200, 400, 800]);
    expect(retryDelayMs({ retryBackoff: 'exponential' }, 2)).toBe(2000);
    expect(retryDelayMs({ waitBetweenTriesMs: 30_000, retryBackoff: 'exponential' }, 5)).toBe(MAX_RETRY_WAIT_MS);
    flakyCalls = 0;
    const started = Date.now();
    const result = await run(wf([n('a', 'trigger'), n('b', 'flaky', {}, { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 30, retryBackoff: 'exponential' })], [c('a', 'b')]));
    expect(result.status).toBe('success');
    expect(flakyCalls).toBe(3);
    // Two failed tries wait 30 ms then 60 ms before the third succeeds.
    expect(Date.now() - started).toBeGreaterThanOrEqual(85);
  });

  it('passes data through disabled nodes', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'boom', {}, { disabled: true }), n('c', 'set')], [c('a', 'b'), c('b', 'c')]));
    expect(result.status).toBe('success');
  });

  it('reports unknown node types as node errors', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'nope')], [c('a', 'b')]));
    expect(result.error?.message).toContain('Unknown node type');
  });

  it('wires sub-nodes into an agent and turns action nodes into tools', async () => {
    const events: ExecutionEvent[] = [];
    const result = await run(
      wf(
        [n('a', 'trigger'), n('ag', 'agent'), n('m', 'model'), n('u', 'upper', {}, { name: 'Upper' })],
        [c('a', 'ag'), c('m', 'ag', 0, 1, 'ai_languageModel'), c('u', 'ag', 0, 2, 'ai_tool')],
      ),
      (e) => events.push(e),
    );
    expect(result.status).toBe('success');
    expect(result.runData.ag[0].outputs[0][0].json.output).toBe('Result: {"upper":"HELLO"}');
    expect(result.runData.u[0]).toMatchObject({ source: 'tool', parentNodeId: 'ag', status: 'success' });
    expect(result.runData.m).toHaveLength(2);
    const toolStart = events.find((e) => e.type === 'node.started' && e.nodeId === 'u');
    expect(toolStart).toMatchObject({ source: 'tool', parentNodeId: 'ag' });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeWorkflow({
      workflow: wf([n('a', 'trigger')], []), resolver, executionId: 'ex', mode: 'manual', signal: controller.signal,
    });
    expect(result.status).toBe('canceled');
  });
});

describe('debugging', () => {
  const linear = () => wf([n('a', 'trigger'), n('b', 'set', { value: 'x' }), n('c', 'set', { key: 'c', value: 'y' })], [c('a', 'b'), c('b', 'c')]);

  it('pauses at breakpoints with the input the node is about to get', async () => {
    const paused: string[] = [];
    const events: ExecutionEvent[] = [];
    const result = await executeWorkflow({
      workflow: linear(), resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: { n: 1 } }],
      debug: {
        breakpoints: () => new Set(['c']),
        pause: async (info) => {
          paused.push(info.nodeId);
          expect(info.inputs[0][0].json).toEqual({ n: 1, k: 'x' });
          return 'continue';
        },
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe('success');
    expect(paused).toEqual(['c']);
    expect(events.map((e) => e.type)).toContain('execution.resumed');
  });

  it('steps node by node and stops on request', async () => {
    const paused: string[] = [];
    const result = await executeWorkflow({
      workflow: linear(), resolver, executionId: 'ex', mode: 'manual',
      debug: { stepping: true, breakpoints: () => new Set(), pause: async (info) => (paused.push(info.nodeId), paused.length < 2 ? 'step' : 'stop') },
    });
    expect(paused).toEqual(['a', 'b']);
    expect(result.status).toBe('canceled');
    expect(Object.keys(result.runData)).toEqual(['a']);
  });

  it('cancels a paused run when the signal aborts', async () => {
    const controller = new AbortController();
    const result = await executeWorkflow({
      workflow: linear(), resolver, executionId: 'ex', mode: 'manual', signal: controller.signal,
      debug: { stepping: true, breakpoints: () => new Set(), pause: () => (setTimeout(() => controller.abort(), 5), new Promise(() => {})) },
    });
    expect(result.status).toBe('canceled');
  });
});

describe('partial runs', () => {
  const graph = () =>
    wf(
      [
        n('a', 'trigger'),
        n('b', 'set', { key: 'b', value: '{{ $json.n }}' }, { name: 'B' }),
        n('c', 'set', { key: 'c', value: "{{ $('B').item.json.b }}!" }),
        n('d', 'set', { key: 'd', value: 'end' }),
      ],
      [c('a', 'b'), c('b', 'c'), c('c', 'd')],
    );

  it('re-runs from a node, reusing upstream data and $() references', async () => {
    const first = await run(graph());
    const events: ExecutionEvent[] = [];
    const second = await executeWorkflow({
      workflow: graph(), resolver, executionId: 'ex2', mode: 'manual',
      partial: { executionId: 'ex', runData: first.runData, executionOrder: first.executionOrder, startNodeId: 'c', scope: 'from' },
      onEvent: (e) => events.push(e),
    });
    expect(second.status).toBe('success');
    expect(second.runData.a[0].reused).toEqual({ executionId: 'ex' });
    expect(second.runData.b[0].reused).toBeDefined();
    expect(second.runData.c[0].reused).toBeUndefined();
    expect(second.runData.c[0].outputs[0].map((i) => i.json.c)).toEqual(['1!', '2!']);
    expect(second.runData.d[0].outputs[0]).toHaveLength(2);
    const started = events.filter((e) => e.type === 'node.started').map((e) => (e as { nodeId: string }).nodeId);
    expect(started).toEqual(['c', 'd']);
  });

  it('re-runs a single task with its recorded input', async () => {
    const first = await run(graph());
    const second = await executeWorkflow({
      workflow: graph(), resolver, executionId: 'ex2', mode: 'manual',
      partial: { executionId: 'ex', runData: first.runData, startNodeId: 'b', scope: 'only' },
    });
    expect(second.runData.b[0].reused).toBeUndefined();
    expect(second.runData.c[0].reused).toBeDefined();
    expect(second.runData.d[0].reused).toBeDefined();
    expect(second.executionOrder.filter((id) => !second.runData[id][0].reused)).toEqual(['b']);
  });

  it("feeds a new node from its parents' recorded output", async () => {
    const first = await run(graph());
    const edited = graph();
    edited.nodes.push(n('e', 'set', { key: 'e', value: 'new' }));
    edited.connections.push(c('b', 'e'));
    const second = await executeWorkflow({
      workflow: edited, resolver, executionId: 'ex2', mode: 'manual',
      partial: { executionId: 'ex', runData: first.runData, startNodeId: 'e', scope: 'only' },
    });
    expect(second.runData.e[0].outputs[0].map((i) => i.json.e)).toEqual(['new', 'new']);
  });

  it('gives a merge the reused branch when only one branch re-runs', async () => {
    const workflow = () =>
      wf(
        [n('a', 'trigger'), n('x', 'set', { key: 'from', value: 'x' }), n('y', 'set', { key: 'from', value: 'y' }), n('m', 'merge')],
        [c('a', 'x'), c('a', 'y'), c('x', 'm', 0, 0), c('y', 'm', 0, 1)],
      );
    const first = await run(workflow());
    const second = await executeWorkflow({
      workflow: workflow(), resolver, executionId: 'ex2', mode: 'manual',
      partial: { executionId: 'ex', runData: first.runData, startNodeId: 'y', scope: 'from' },
    });
    expect(second.runData.m[0].reused).toBeUndefined();
    expect(second.runData.m[0].outputs[0].map((i) => i.json.from)).toEqual(['x', 'x', 'y', 'y']);
  });

  it('stops at a destination node', async () => {
    const result = await executeWorkflow({ workflow: graph(), resolver, executionId: 'ex', mode: 'manual', destinationNodeId: 'b' });
    expect(Object.keys(result.runData)).toEqual(['a', 'b']);
  });
});

describe('tool schemas', () => {
  it('builds schemas from $fromAI placeholders and resolves them at call time', async () => {
    const seen: unknown[] = [];
    const probe = defineNode({
      description: { name: 'probe', displayName: 'Probe', description: 'echo', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, properties: [{ name: 'msg', displayName: 'Msg', type: 'string' }] },
      execute: (ctx) => {
        seen.push(ctx.getNodeParameter('msg'));
        return [[{ json: { echoed: ctx.getNodeParameter('msg') } }]];
      },
    });
    const capture = defineNode({
      description: { name: 'capture', displayName: 'Capture', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
      async execute(ctx) {
        const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
        const result = await tool.invoke({ greeting: 'hi' });
        return [[{ json: { schema: tool.inputSchema, result } as never }]];
      },
    });
    registry.probe = probe;
    registry.capture = capture;
    const result = await run(
      wf([n('a', 'trigger'), n('c', 'capture'), n('p', 'probe', { msg: "{{ $fromAI('greeting', 'What to say', 'string') }} there" })], [c('a', 'c'), c('p', 'c', 0, 1, 'ai_tool')]),
    );
    expect(result.status).toBe('success');
    const out = result.runData.c[0].outputs[0][0].json as { schema: { required: string[] }; result: unknown };
    expect(out.schema.required).toEqual(['greeting']);
    expect(out.result).toEqual({ echoed: 'hi there' });
  });

  it('turns field parameters into required arguments', async () => {
    const { deriveToolSchema } = await import('../src/tool-schema');
    const schema = deriveToolSchema(upper.description, { field: 'text' }) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['text']);
  });
});

describe('node progress', () => {
  it('turns ctx.sendProgress of a tool sub-node into throttled node.progress events, the last one always', async () => {
    const slow = defineNode({
      description: { name: 'slow', displayName: 'Slow', description: 'works', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, properties: [] },
      async execute(ctx) {
        for (let i = 1; i <= 20; i++) ctx.sendProgress?.({ step: i });
        await new Promise((resolve) => setTimeout(resolve, 20));
        ctx.sendProgress?.({ step: 21 });
        return [[{ json: { done: true } }]];
      },
    });
    const caller = defineNode({
      description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
      async execute(ctx) {
        const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
        await tool.invoke({});
        return [[{ json: {} }]];
      },
    });
    registry.slow = slow;
    registry.caller = caller;
    const events: ExecutionEvent[] = [];
    const result = await run(wf([n('a', 'trigger'), n('c', 'caller'), n('s', 'slow')], [c('a', 'c'), c('s', 'c', 0, 1, 'ai_tool')]), (e) => events.push(e));
    expect(result.status).toBe('success');
    const progress = events.filter((e): e is Extract<ExecutionEvent, { type: 'node.progress' }> => e.type === 'node.progress');
    expect(progress.length).toBeLessThan(5);
    expect(progress[0]).toMatchObject({ executionId: 'ex', nodeId: 's', nodeName: 's', parentNodeId: 'c', data: { step: 1 } });
    expect(progress.at(-1)!.data).toEqual({ step: 21 });
    // Progress comes between the sub-node's start and end.
    const types = events.filter((e) => 'nodeId' in e && e.nodeId === 's').map((e) => e.type);
    expect(types[0]).toBe('node.started');
    expect(types.at(-1)).toBe('node.finished');
  });
});
