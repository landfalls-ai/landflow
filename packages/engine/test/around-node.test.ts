/** `aroundNode` (SP01): the host's hook runs around a node's work and a sub-node's, nested. */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import {
  executeWorkflow,
  inProcessNodeType,
  type AiDocument,
  type DocumentLoader,
  type Embeddings,
  type LanguageModel,
  type NodeTypeResolver,
  type Retriever,
  type Workflow,
  type WorkflowConnection,
  type WorkflowNode,
} from '../src';

const main = [{ type: 'main' as const }];
const base = { description: '', version: 1 };

const trigger = defineNode({
  description: { ...base, name: 'trigger', displayName: 'Trigger', kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

/** Embeds a text as [length, 1]. */
const embed = defineNode({
  description: { ...base, name: 'embed', displayName: 'Embed', kind: 'subnode', supplies: 'ai_embedding', inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
  supplyData: (): Embeddings => ({
    provider: 'test',
    model: 'length',
    embedDocuments: async (texts) => texts.map((text) => [text.length, 1]),
    embedQuery: async (text) => [text.length, 1],
  }),
});

/** A retriever that needs an embeddings sub-node of its own. */
const store = defineNode({
  description: {
    ...base, name: 'store', displayName: 'Store', kind: 'subnode', supplies: 'ai_retriever',
    inputs: [{ type: 'ai_embedding', required: true }], outputs: [{ type: 'ai_retriever' }], properties: [],
  },
  async supplyData(ctx): Promise<Retriever> {
    const [embeddings] = await ctx.getInputConnectionData!<Embeddings>('ai_embedding');
    return {
      async retrieve(query) {
        const [length] = await embeddings.embedQuery(query);
        return [{ pageContent: `match for ${query}`, metadata: { length }, score: 1 }];
      },
    };
  },
});

/** A loader whose `text` parameter is an expression, resolved per root item. */
const loader = defineNode({
  description: {
    ...base, name: 'loader', displayName: 'Loader', kind: 'subnode', supplies: 'ai_document', inputs: [], outputs: [{ type: 'ai_document' }],
    properties: [{ name: 'text', displayName: 'Text', type: 'string', default: '' }],
  },
  supplyData: (ctx): DocumentLoader => ({
    load: async (items) => items.map((_item, i): AiDocument => ({ pageContent: String(ctx.getNodeParameter('text', i)), metadata: { i } })),
  }),
});

const root = defineNode({
  description: { ...base, name: 'root', displayName: 'Root', kind: 'action', outputs: main, inputs: [...main, { type: 'ai_retriever' }], properties: [] },
  async execute(ctx) {
    const [retriever] = await ctx.getInputConnectionData!<Retriever>('ai_retriever');
    await retriever.retrieve('hi');
    return [ctx.getInputData()];
  },
});

const registry: Record<string, INodeType> = { trigger, embed, store, loader, root };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};
const n = (id: string, type: string): WorkflowNode => ({ id, name: `Name ${id}`, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters: {} });
const c = (source: string, target: string, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({ id: `${source}-${target}`, type, source, sourceIndex: 0, target, targetIndex: 0 });
const workflow: Workflow = {
  id: 'wf', name: 'Test',
  nodes: [n('t', 'trigger'), n('r', 'root'), n('s', 'store'), n('e', 'embed')],
  connections: [c('t', 'r'), c('s', 'r', 'ai_retriever'), c('e', 's', 'ai_embedding')],
};

describe('aroundNode', () => {
  it('wraps each node and nested sub-nodes, innermost last', async () => {
    const seen: string[] = [];
    const stack: string[] = [];
    const depth: Record<string, string[]> = {};
    const result = await executeWorkflow({
      workflow, resolver, executionId: 'ex', mode: 'manual',
      aroundNode: async (node, fn) => {
        seen.push(`${node.id}:${node.name}:${node.type}`);
        stack.push(node.id);
        depth[node.id] = [...stack];
        try {
          return await fn();
        } finally {
          stack.pop();
        }
      },
    });
    expect(result.status).toBe('success');
    expect(seen).toEqual(expect.arrayContaining(['t:Name t:t.trigger', 'r:Name r:t.root', 's:Name s:t.store', 'e:Name e:t.embed']));
    expect(depth.e).toEqual(['r', 's', 'e']);
  });

  it('changes nothing without the hook', async () => {
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual' });
    expect(result.status).toBe('success');
    expect(result.runData.e[0]).toMatchObject({ source: 'embedding', parentNodeId: 's' });
  });
});
