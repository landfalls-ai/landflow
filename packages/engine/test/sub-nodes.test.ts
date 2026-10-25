/** Sub-node resolution beyond models and tools: retrieval ports, sub-nodes of sub-nodes, per-item parameters and port indexes. */
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

const model = (name: string) =>
  defineNode({
    description: { ...base, name, displayName: name, kind: 'subnode', supplies: 'ai_languageModel', inputs: [], outputs: [{ type: 'ai_languageModel' }], properties: [] },
    supplyData: (): LanguageModel => ({ provider: 'test', model: name, generate: async () => ({ text: name, toolCalls: [], stopReason: 'end_turn' }) }),
  });

const root = defineNode({
  description: {
    ...base, name: 'root', displayName: 'Root', kind: 'action', outputs: main,
    inputs: [
      ...main,
      { type: 'ai_languageModel', displayName: 'Chat Model' },
      { type: 'ai_languageModel', displayName: 'Fallback Model' },
      { type: 'ai_retriever' },
      { type: 'ai_document' },
    ],
    properties: [],
  },
  async execute(ctx) {
    const get = ctx.getInputConnectionData!;
    const all = await get<LanguageModel>('ai_languageModel');
    const [fallback] = await get<LanguageModel>('ai_languageModel', 1);
    const [retriever] = await get<Retriever>('ai_retriever');
    const [docs] = await get<DocumentLoader>('ai_document');
    return [
      [
        {
          json: {
            models: all.map((m) => m.model),
            fallback: fallback?.model ?? null,
            retrieved: retriever ? ((await retriever.retrieve('hello')) as never) : null,
            loaded: docs ? ((await docs.load(ctx.getInputData())).map((d) => d.pageContent) as never) : null,
          },
        },
      ],
    ];
  },
});

const registry: Record<string, INodeType> = { trigger, embed, store, loader, root, primary: model('primary'), backup: model('backup') };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};

const n = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters });
const c = (source: string, target: string, type: WorkflowConnection['type'] = 'main', targetIndex = 0): WorkflowConnection => ({
  id: `${source}-${target}-${targetIndex}`, type, source, sourceIndex: 0, target, targetIndex,
});
const run = (nodes: WorkflowNode[], connections: WorkflowConnection[]) =>
  executeWorkflow({ workflow: { id: 'wf', name: 'Test', nodes, connections } satisfies Workflow, resolver, executionId: 'ex', mode: 'manual', triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }] });

describe('sub-node resolution', () => {
  it('resolves sub-nodes of sub-nodes and records each use under the node it serves', async () => {
    const result = await run([n('t', 'trigger'), n('r', 'root'), n('s', 'store'), n('e', 'embed')], [c('t', 'r'), c('s', 'r', 'ai_retriever'), c('e', 's', 'ai_embedding')]);
    expect(result.status).toBe('success');
    expect(result.runData.r[0].outputs[0][0].json.retrieved).toEqual([{ pageContent: 'match for hello', metadata: { length: 5 }, score: 1 }]);
    expect(result.runData.s[0]).toMatchObject({ source: 'retriever', parentNodeId: 'r', status: 'success' });
    expect(result.runData.e[0]).toMatchObject({ source: 'embedding', parentNodeId: 's', status: 'success' });
    expect(result.runData.s[0].outputs[0][0].json).toMatchObject({ count: 1 });
  });

  it("resolves a sub-node's parameters per root item", async () => {
    const result = await run([n('t', 'trigger'), n('r', 'root'), n('l', 'loader', { text: 'item {{ $json.n }}' })], [c('t', 'r'), c('l', 'r', 'ai_document')]);
    expect(result.status).toBe('success');
    expect(result.runData.r[0].outputs[0][0].json.loaded).toEqual(['item 1', 'item 2']);
    expect(result.runData.l[0]).toMatchObject({ source: 'document', parentNodeId: 'r' });
  });

  it('returns ports in order and filters by port index', async () => {
    const result = await run(
      [n('t', 'trigger'), n('r', 'root'), n('p', 'primary'), n('b', 'backup')],
      [c('t', 'r'), c('b', 'r', 'ai_languageModel', 1), c('p', 'r', 'ai_languageModel', 0)],
    );
    expect(result.status).toBe('success');
    expect(result.runData.r[0].outputs[0][0].json).toMatchObject({ models: ['primary', 'backup'], fallback: 'backup' });
  });

  it('refuses a sub-node attached to itself', async () => {
    const result = await run([n('t', 'trigger'), n('r', 'root'), n('s', 'store'), n('e', 'store')], [c('t', 'r'), c('s', 'r', 'ai_retriever'), c('e', 's', 'ai_embedding'), c('s', 'e', 'ai_embedding')]);
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/attached to itself/);
  });
});
