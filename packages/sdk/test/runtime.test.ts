import { describe, expect, it } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import { defineNode, definePlugin, NodeOperationError, normalizeOutputs, runLoadOptions, runNode, buildManifest } from '../src';

const node = defineNode({
  description: {
    name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action',
    inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
    properties: [
      { name: 'suffix', displayName: 'Suffix', type: 'string', default: '!' },
      { name: 'fail', displayName: 'Fail', type: 'boolean', default: false },
    ],
  },
  execute(ctx) {
    ctx.logger.info('echoing');
    return ctx.getInputData().map((item, i) => {
      if (ctx.getNodeParameter('fail', i)) throw new NodeOperationError('asked to fail', { itemIndex: i, description: 'because fail=true' });
      return { json: { text: `${item.json.text}${ctx.getNodeParameter<string>('suffix', i)}` } };
    });
  },
  methods: { loadOptions: { suffixes: () => [{ name: 'Bang', value: '!' }] } },
});

const request = (itemParameters: Record<string, unknown>[], parameters: Record<string, unknown> = {}): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1', executionId: 'e', mode: 'manual',
  node: { id: 'n', name: 'Echo', type: 't.echo', typeVersion: 1 },
  parameters: parameters as never, itemParameters: itemParameters as never,
  inputs: [itemParameters.map((_, i) => ({ json: { text: `item${i}` } }))],
});

describe('runNode', () => {
  it('resolves per-item params, falls back to defaults and fills pairedItem', async () => {
    const response = await runNode(node, request([{ suffix: '?' }, {}]));
    expect(response.outputs[0]).toEqual([
      { json: { text: 'item0?' }, pairedItem: { item: 0 } },
      { json: { text: 'item1!' }, pairedItem: { item: 1 } },
    ]);
    expect(response.logs).toEqual([{ level: 'info', message: 'echoing' }]);
  });

  it('takes defaults from the visible property when several share a name', async () => {
    const multi = defineNode({
      description: {
        name: 'multi', displayName: 'Multi', description: '', version: 1, kind: 'action',
        inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
        properties: [
          { name: 'resource', displayName: 'Resource', type: 'options', default: 'message', options: [{ name: 'Message', value: 'message' }, { name: 'Chat', value: 'chat' }] },
          { name: 'operation', displayName: 'Operation', type: 'options', default: 'send', options: [{ name: 'Send', value: 'send' }], displayOptions: { show: { resource: ['message'] } } },
          { name: 'operation', displayName: 'Operation', type: 'options', default: 'get', options: [{ name: 'Get', value: 'get' }], displayOptions: { show: { resource: ['chat'] } } },
          { name: 'limit', displayName: 'Limit', type: 'number', default: 50, displayOptions: { show: { operation: ['get'] } } },
        ],
      },
      execute: (ctx) => ctx.getInputData().map((_, i) => ({ json: { operation: ctx.getNodeParameter('operation', i), limit: ctx.getNodeParameter('limit', i) } })),
    });
    const response = await runNode(multi, request([{}, { resource: 'chat' }]));
    expect(response.outputs[0]!.map((item) => item.json)).toEqual([
      { operation: 'send', limit: 50 },
      { operation: 'get', limit: 50 },
    ]);
  });

  it('tells the node to continue on fail when the host asks', async () => {
    const flag = defineNode({
      description: { name: 'flag', displayName: 'Flag', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
      execute: (ctx) => [{ json: { continueOnFail: ctx.continueOnFail() } }],
    });
    expect((await runNode(flag, { ...request([{}]), continueOnFail: true })).outputs[0]![0]!.json).toEqual({ continueOnFail: true });
    expect((await runNode(flag, request([{}]))).outputs[0]![0]!.json).toEqual({ continueOnFail: false });
  });

  it('turns NodeOperationError into an error payload', async () => {
    const response = await runNode(node, request([{ fail: true }]));
    expect(response.error).toEqual({ message: 'asked to fail', description: 'because fail=true', itemIndex: 0 });
  });

  it('normalizes plain objects and single outputs', () => {
    expect(normalizeOutputs([{ a: 1 }] as never, 0)).toEqual([[{ json: { a: 1 } }]]);
    expect(normalizeOutputs([[{ json: { a: 1 } }], []], 1)).toEqual([[{ json: { a: 1 }, pairedItem: { item: 0 } }], []]);
  });

  it('serves load options and builds a manifest', async () => {
    expect(await runLoadOptions(node, 'suffixes', {})).toEqual([{ name: 'Bang', value: '!' }]);
    const manifest = buildManifest(definePlugin({ info: { id: 'demo', name: 'Demo', version: '1.0.0' }, nodes: [node] }));
    expect(manifest.plugin).toMatchObject({ id: 'demo', language: 'typescript' });
    expect(manifest.nodes.map((n) => n.name)).toEqual(['echo']);
  });

  it('rejects duplicate node names', () => {
    expect(() => definePlugin({ info: { id: 'x', name: 'X', version: '1' }, nodes: [node, node] })).toThrow(/duplicate/);
  });
});
