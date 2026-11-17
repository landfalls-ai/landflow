/** AG03: a node used as a tool gets the data to work on (an `item` argument) when it reads its whole input item. */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import { deriveToolSchema, executeWorkflow, inProcessNodeType, toolInputItem, type AgentTool, type NodeTypeResolver, type Workflow, type WorkflowConnection, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];

/** Shaped like Normalize Alert: options and booleans, no field parameter, reads item.json whole. */
const normalizer = defineNode({
  description: {
    name: 'normalizer', displayName: 'Normalizer', description: '', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true,
    properties: [
      { name: 'format', displayName: 'Format', type: 'options', default: 'auto', options: [{ name: 'Auto', value: 'auto' }, { name: 'Wazuh', value: 'wazuh' }] },
      { name: 'includeRaw', displayName: 'Keep Raw', type: 'boolean', default: true },
    ],
  },
  execute: (ctx) => [[{ json: { format: ctx.getNodeParameter('format'), seen: ctx.getInputData()[0].json } }]],
});
const sentiment = defineNode({
  description: { name: 'sentiment', displayName: 'Sentiment', description: '', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, properties: [{ name: 'field', displayName: 'Field', type: 'string', default: 'text' }] },
  execute: (ctx) => [ctx.getInputData()],
});
const declared = defineNode({
  description: { name: 'declared', displayName: 'Declared', description: '', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, toolInputSchema: { type: 'object', properties: {}, required: [] }, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});
const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

const CALLS: Array<Record<string, unknown>> = [
  { item: { rule: { level: 10 }, data: { srcip: '203.0.113.45' } }, format: 'wazuh' },
  { item: JSON.stringify({ rule: { level: 10 }, data: { srcip: '203.0.113.45' } }), format: 'wazuh' },
  { item: 'Failed password for root from 203.0.113.45', format: 'wazuh' },
];
const caller = defineNode({
  description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
  async execute(ctx) {
    const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const results = [];
    for (const call of CALLS) results.push(await tool.invoke(call));
    return [[{ json: { results } as never }]];
  },
});

const registry: Record<string, INodeType> = { trigger, normalizer, caller };
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

describe('the item argument of a tool', () => {
  it('is required for a node with no field parameter, absent with one, and leaves a declared schema and $fromAI alone', () => {
    const schema = deriveToolSchema(normalizer.description, {});
    expect(schema).toMatchObject({ required: ['item'], properties: { item: { type: 'object', additionalProperties: true }, format: { enum: ['auto', 'wazuh'] } } });
    const withField = deriveToolSchema(sentiment.description, {});
    expect(withField.properties).not.toHaveProperty('item');
    expect(withField).toMatchObject({ required: ['text'] });
    expect(deriveToolSchema(declared.description, {})).toEqual({ type: 'object', properties: {}, required: [] });
    expect(deriveToolSchema(normalizer.description, { format: "={{ $fromAI('format', 'the format') }}" })).toEqual({
      type: 'object', properties: { format: { type: 'string', description: 'the format' } }, required: ['format'],
    });
  });

  it('toolInputItem takes an object, a JSON string or text; without item in the schema it is today\'s rule', () => {
    const schema = deriveToolSchema(normalizer.description, {});
    expect(toolInputItem(schema, { item: { a: 1 }, format: 'x' })).toEqual({ json: { a: 1 }, rest: { format: 'x' } });
    expect(toolInputItem(schema, { item: '{"a":1}' })).toEqual({ json: { a: 1 }, rest: {} });
    expect(toolInputItem(schema, { item: 'plain' })).toEqual({ json: { text: 'plain' }, rest: {} });
    const plain = deriveToolSchema(sentiment.description, {});
    expect(toolInputItem(plain, { text: 'hi', item: 'x' })).toEqual({ json: { text: 'hi', item: 'x' }, rest: { text: 'hi', item: 'x' } });
  });

  it('reaches a tool sub-node of a workflow AI Agent as the node\'s input item, with the rest as overrides', async () => {
    const workflow: Workflow = { id: 'wf', name: 'Test', nodes: [node('a', 'trigger', 1), node('c', 'caller', 2), node('s', 'normalizer', 3)], connections: [edge('a', 'c'), edge('s', 'c', 1, 'ai_tool')] };
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }] });
    expect(result.status).toBe('success');
    const out = result.runData.c[0].outputs[0][0].json as { results: Array<{ format: string; seen: unknown }> };
    const alert = { rule: { level: 10 }, data: { srcip: '203.0.113.45' } };
    expect(out.results[0]).toEqual({ format: 'wazuh', seen: alert });
    expect(out.results[1]).toEqual({ format: 'wazuh', seen: alert });
    expect(out.results[2]).toEqual({ format: 'wazuh', seen: { text: 'Failed password for root from 203.0.113.45' } });
  });
});
