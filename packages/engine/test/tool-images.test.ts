import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, isToolOutputWithImages, splitToolOutput, type AgentTool, type NodeTypeResolver, type Workflow, type WorkflowConnection, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];
const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});
// A tool node that attaches a PNG and a text file: only the image becomes a tool image.
const shot = defineNode({
  description: { name: 'shot', displayName: 'Shot', description: 'shot', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, properties: [] },
  execute: () => [
    [
      {
        json: { title: 'Page' },
        binary: {
          data: { id: 'ex.abc', mimeType: 'image/png', fileSize: 1234, fileName: 'page.png' },
          notes: { id: 'ex.def', mimeType: 'text/plain', fileSize: 5 },
        },
      },
    ],
  ],
});
const plain = defineNode({
  description: { name: 'plain', displayName: 'Plain', description: 'plain', version: 1, kind: 'action', inputs: main, outputs: main, usableAsTool: true, properties: [] },
  execute: () => [[{ json: { ok: true } }]],
});
const caller = defineNode({
  description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
  async execute(ctx) {
    const tools = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const results = await Promise.all(tools.map((tool) => tool.invoke({})));
    return [[{ json: { results } as never }]];
  },
});
const types: Record<string, INodeType> = { trigger, shot, plain, caller };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = types[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};
const node = (id: string, type: string, position: number): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, position], parameters: {} });
const edge = (source: string, target: string, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({ id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex });

describe('tool results with images', () => {
  it('a node tool whose item has an image in binary returns { text, images } by reference; others are unchanged', async () => {
    const workflow: Workflow = {
      id: 'wf',
      name: 'Test',
      nodes: [node('a', 'trigger', 1), node('c', 'caller', 2), node('s', 'shot', 3), node('p', 'plain', 4)],
      connections: [edge('a', 'c'), edge('s', 'c', 1, 'ai_tool'), edge('p', 'c', 2, 'ai_tool')],
    };
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: {} }] });
    expect(result.status).toBe('success');
    const [withImage, withoutImage] = (result.runData.c[0].outputs[0][0].json as { results: unknown[] }).results;
    expect(isToolOutputWithImages(withImage)).toBe(true);
    expect(withImage).toMatchObject({
      text: JSON.stringify({ title: 'Page' }),
      value: { title: 'Page' },
      images: [{ mimeType: 'image/png', fileName: 'page.png', ref: { id: 'ex.abc', fileSize: 1234 } }],
    });
    expect((withImage as { images: unknown[] }).images).toHaveLength(1);
    expect(withoutImage).toEqual({ ok: true });
    // The sub-run's record keeps the item with its binary references, never bytes.
    expect(result.runData.s[0].outputs[0][0]).toMatchObject({ json: { title: 'Page' }, binary: { data: { id: 'ex.abc' } } });
  });

  it('splitToolOutput keeps plain values as they were', () => {
    expect(splitToolOutput('hi')).toEqual({ text: 'hi', images: [] });
    expect(splitToolOutput({ a: 1 })).toEqual({ text: '{"a":1}', images: [] });
    expect(splitToolOutput({ text: 't', images: [] })).toEqual({ text: '{"text":"t","images":[]}', images: [] });
    expect(splitToolOutput({ text: 't', images: [{ mimeType: 'image/png', data: 'AA' }] })).toEqual({ text: 't', images: [{ mimeType: 'image/png', data: 'AA' }] });
  });
});
