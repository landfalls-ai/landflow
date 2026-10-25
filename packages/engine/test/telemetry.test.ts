import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { defineNode, NodeOperationError, type INodeType } from '@landflow/sdk';
import {
  executeWorkflow,
  inProcessNodeType,
  type AgentTool,
  type DebugController,
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

// Stands in for a remote plugin: the transport client opens its RPC span inside the node's span.
const remote = defineNode({
  description: {
    name: 'remote',
    displayName: 'Remote',
    description: '',
    version: 1,
    kind: 'action',
    inputs: main,
    outputs: main,
    usableAsTool: true,
    properties: [],
  },
  execute: (ctx) =>
    trace.getTracer('test').startActiveSpan('plugin.rpc Execute', (span) => {
      span.end();
      return ctx.getInputData().map((item) => ({ json: { ...item.json, remote: true } }));
    }),
});

const boom = defineNode({
  description: { name: 'boom', displayName: 'Boom', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: () => {
    throw new NodeOperationError('kaboom');
  },
});

// A model that opens a gen_ai span like the host's adapters, asks for one tool call, then answers.
const model = defineNode({
  description: {
    name: 'model',
    displayName: 'Model',
    description: '',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    inputs: [],
    outputs: [{ type: 'ai_languageModel' }],
    properties: [],
  },
  supplyData: (): LanguageModel => ({
    provider: 'test',
    model: 'scripted',
    generate: ({ messages }) =>
      trace.getTracer('test').startActiveSpan('gen_ai.chat scripted', async (span) => {
        span.end();
        const last = messages[messages.length - 1];
        if (last.role === 'tool') return { text: 'done', toolCalls: [], stopReason: 'end_turn' };
        return { text: '', toolCalls: [{ id: 't1', name: 'Remote', input: { q: 1 } }], stopReason: 'tool_use' };
      }),
  }),
});

const agent = defineNode({
  description: {
    name: 'agent',
    displayName: 'Agent',
    description: '',
    version: 1,
    kind: 'action',
    outputs: main,
    inputs: [...main, { type: 'ai_languageModel', required: true, maxConnections: 1 }, { type: 'ai_tool' }],
    properties: [],
  },
  async execute(ctx) {
    const [llm] = await ctx.getInputConnectionData!<LanguageModel>('ai_languageModel');
    const tools = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const turn = await llm.generate({ messages: [{ role: 'user', content: 'go' }], tools });
    const call = turn.toolCalls[0];
    const result = await tools[0].invoke(call.input);
    const final = await llm.generate({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', text: '', toolCalls: turn.toolCalls },
        { role: 'tool', results: [{ id: call.id, name: call.name, content: JSON.stringify(result) }] },
      ],
      tools,
    });
    return [[{ json: { output: final.text } }]];
  },
});

const types: Record<string, INodeType> = { trigger, remote, boom, model, agent };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = types[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};

let y = 0;
const n = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  name: extra.name ?? id,
  type: `t.${type}`,
  typeVersion: 1,
  position: [0, (y += 100)],
  parameters: {},
  ...extra,
});
const c = (source: string, target: string, sourceIndex = 0, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({
  id: `${source}-${target}-${sourceIndex}-${targetIndex}`,
  type,
  source,
  sourceIndex,
  target,
  targetIndex,
});
const wf = (nodes: WorkflowNode[], connections: WorkflowConnection[]): Workflow => ({ id: 'wf', name: 'Traced', nodes, connections });
const linear = () => wf([n('a', 'trigger'), n('b', 'remote')], [c('a', 'b')]);
const run = (workflow: Workflow, extra: Partial<Parameters<typeof executeWorkflow>[0]> = {}) =>
  executeWorkflow({ workflow, resolver, executionId: 'ex_1', mode: 'manual', triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }], ...extra });

describe('without an OpenTelemetry SDK', () => {
  it('runs normally and records no trace ids', async () => {
    const result = await run(linear());
    expect(result.status).toBe('success');
    expect(result.traceId).toBeUndefined();
    expect(result.runData.b[0].spanId).toBeUndefined();
  });
});

describe('span tree', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });
  beforeEach(() => exporter.reset());

  const spans = () => exporter.getFinishedSpans();
  const named = (name: string) => spans().filter((s) => s.name === name);
  const one = (name: string) => {
    const found = named(name);
    expect(found, name).toHaveLength(1);
    return found[0];
  };
  const parentOf = (span: ReadableSpan) => spans().find((s) => s.spanContext().spanId === span.parentSpanContext?.spanId);

  it('nests node spans under workflow.execute and stores the ids on the result', async () => {
    const result = await run(linear());
    const root = one('workflow.execute');
    const remoteSpan = one('node.execute t.remote');
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes).toMatchObject({
      'landflow.workflow.id': 'wf',
      'landflow.workflow.name': 'Traced',
      'landflow.execution.id': 'ex_1',
      'landflow.execution.mode': 'manual',
      'landflow.execution.status': 'success',
    });
    expect(parentOf(one('node.execute t.trigger'))).toBe(root);
    expect(parentOf(remoteSpan)).toBe(root);
    expect(remoteSpan.attributes).toMatchObject({
      'landflow.node.id': 'b',
      'landflow.node.type': 't.remote',
      'landflow.plugin.id': 't',
      'landflow.transport': 'in-process',
      'landflow.node.source': 'main',
      'landflow.items.in': 2,
      'landflow.items.out': 2,
    });
    // Whatever the node does runs with its span active.
    expect(parentOf(one('plugin.rpc Execute'))).toBe(remoteSpan);
    expect(result.traceId).toBe(root.spanContext().traceId);
    expect(result.runData.b[0].spanId).toBe(remoteSpan.spanContext().spanId);
  });

  it('continues the caller’s trace', async () => {
    const result = await trace.getTracer('test').startActiveSpan('POST /api/workflows/[id]/run', async (http) => {
      const out = await run(linear());
      http.end();
      return out;
    });
    const http = one('POST /api/workflows/[id]/run');
    expect(parentOf(one('workflow.execute'))).toBe(http);
    expect(result.traceId).toBe(http.spanContext().traceId);
  });

  it('makes model, tool and plugin calls children of the agent’s span', async () => {
    const result = await run(
      wf(
        [n('a', 'trigger'), n('ag', 'agent'), n('m', 'model'), n('r', 'remote', { name: 'Remote' })],
        [c('a', 'ag'), c('m', 'ag', 0, 1, 'ai_languageModel'), c('r', 'ag', 0, 2, 'ai_tool')],
      ),
    );
    expect(result.status).toBe('success');
    const agentSpan = one('node.execute t.agent');
    const modelSpans = named('node.execute t.model');
    const toolSpan = one('node.execute t.remote');
    expect(modelSpans).toHaveLength(2);
    for (const span of modelSpans) {
      expect(parentOf(span)).toBe(agentSpan);
      expect(span.attributes['landflow.node.source']).toBe('ai_languageModel');
    }
    expect(parentOf(toolSpan)).toBe(agentSpan);
    expect(toolSpan.attributes['landflow.node.source']).toBe('ai_tool');
    for (const chat of named('gen_ai.chat scripted')) expect(modelSpans).toContain(parentOf(chat));
    expect(parentOf(one('plugin.rpc Execute'))).toBe(toolSpan);
    expect(result.runData.r[0].spanId).toBe(toolSpan.spanContext().spanId);
  });

  it('marks failed nodes and executions as errors', async () => {
    const result = await run(wf([n('a', 'trigger'), n('b', 'boom')], [c('a', 'b')]));
    expect(result.status).toBe('error');
    const node = one('node.execute t.boom');
    expect(node.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'kaboom' });
    expect(node.events.map((e) => e.name)).toContain('exception');
    const root = one('workflow.execute');
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['landflow.execution.status']).toBe('error');
  });

  it('records debugger pauses as events on the execution span', async () => {
    const debug: DebugController = { breakpoints: () => new Set(['b']), pause: async () => 'continue' };
    await run(linear(), { debug });
    const root = one('workflow.execute');
    expect(root.attributes['landflow.execution.debug']).toBe(true);
    expect(root.events.map((e) => [e.name, e.attributes?.['landflow.node.name']])).toEqual([
      ['debugger.paused', 'b'],
      ['debugger.resumed', 'b'],
    ]);
  });

  it('marks reused nodes of a partial run', async () => {
    const workflow = linear();
    const first = await run(workflow);
    exporter.reset();
    const second = await run(workflow, {
      executionId: 'ex_2',
      partial: { executionId: first.executionId, runData: first.runData, executionOrder: first.executionOrder, startNodeId: 'b', scope: 'only' },
    });
    const root = one('workflow.execute');
    expect(root.attributes).toMatchObject({ 'landflow.execution.rerun_of': 'ex_1', 'landflow.execution.rerun_scope': 'only' });
    const reused = one('node.execute t.trigger');
    expect(reused.attributes['landflow.node.reused']).toBe(true);
    expect(second.runData.a[0].spanId).toBe(reused.spanContext().spanId);
    expect(one('node.execute t.remote').attributes['landflow.node.reused']).toBeUndefined();
  });
});
