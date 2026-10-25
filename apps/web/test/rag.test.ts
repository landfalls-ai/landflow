import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexedPorts, portParameters, visiblePorts } from '@landflow/protocol';
import { defineNode, type JsonObject } from '@landflow/sdk';
import type { AiDocument, Embeddings, LanguageModel } from '@landflow/engine';
import { knowledgeTool } from '@/lib/server/agents/knowledge';
import { aiAgentNode } from '@/lib/server/nodes/ai';
import { inMemoryVectorStoreNode } from '@/lib/server/nodes/vector-stores';
import type { ToolContext } from '@/lib/server/agents/tools';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { ollamaEmbeddings } from '@/lib/server/rag/embeddings';
import { loadDocuments, metadataEntries, textOf } from '@/lib/server/rag/loader';
import { llmReranker, rankByScores } from '@/lib/server/rag/rerank';
import { bm25Scores, cosineSimilarity, reciprocalRankFusion, searchTerms } from '@/lib/server/rag/search';
import { CODE_SEPARATORS, recursiveCharacterSplit, tokenize, tokenSplit } from '@/lib/server/rag/splitters';
import { insertDocuments, MemoryVectorStore, searchStore, SqliteVectorStore, type VectorStore } from '@/lib/server/rag/stores';
import { outputsOf, runFlow, type FlowEdge, type FlowNode } from './helpers';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const DIMENSIONS = 64;

/** A deterministic bag-of-words embedding: texts that share words point the same way. */
export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of searchTerms(text)) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

const embedded: string[] = [];
const fakeEmbeddingsNode = defineNode({
  description: {
    name: 'fakeEmbeddings',
    displayName: 'Fake Embeddings',
    description: 'Bag-of-words vectors',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_embedding',
    categories: ['AI'],
    inputs: [],
    outputs: [{ type: 'ai_embedding' }],
    properties: [],
  },
  supplyData: (): Embeddings => ({
    provider: 'test',
    model: 'hash-64',
    embedDocuments: async (texts) => (embedded.push(...texts), texts.map(hashEmbed)),
    embedQuery: async (text) => hashEmbed(text),
  }),
});

type Step = (input: GenerateInput) => { text?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> };

/** A chat model sub-node that plays a script and records what it was asked. */
function scriptedModel(steps: Step[]) {
  const calls: GenerateInput[] = [];
  const node = defineNode({
    description: {
      name: 'scripted',
      displayName: 'Scripted Model',
      description: 'Replies from a script',
      version: 1,
      kind: 'subnode',
      supplies: 'ai_languageModel',
      categories: ['AI'],
      inputs: [],
      outputs: [{ type: 'ai_languageModel' }],
      properties: [],
    },
    supplyData: (): LanguageModel => ({
      provider: 'test',
      model: 'scripted',
      async generate(input) {
        calls.push({ ...input, messages: [...input.messages] });
        const step = steps.shift();
        if (!step) throw new Error('No scripted reply left');
        const reply = step(input);
        return { text: reply.text ?? '', toolCalls: reply.toolCalls ?? [], stopReason: reply.toolCalls?.length ? 'tool_use' : 'stop' };
      },
    }),
  });
  return { node, calls };
}

const DOCS = [
  { title: 'Returns', text: 'Our return policy: items can be returned within 30 days of delivery for a full refund.' },
  { title: 'Shipping', text: 'Shipping is free for orders over 50 euros. Standard delivery takes 3 to 5 business days.' },
  { title: 'Warranty', text: 'Every laptop comes with a two year warranty that covers hardware defects.' },
  { title: 'Support', text: 'Contact support by email; the team answers within one business day.' },
];

/** Start → Store (insert) with a Default Data Loader and fake embeddings. */
const insertFlow = (store: FlowNode, loader: Record<string, unknown> = { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' }, extra: { nodes?: FlowNode[]; edges?: FlowEdge[] } = {}) =>
  runFlow(
    [store, { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: loader }, { name: 'Embeddings', type: 'test.fakeEmbeddings' }, ...(extra.nodes ?? [])],
    [['Start', store.name], ['Loader', store.name, 'ai_document'], ['Embeddings', store.name, 'ai_embedding'], ...(extra.edges ?? [])],
    { input: DOCS, extra: { fakeEmbeddings: fakeEmbeddingsNode } },
  );

const failure = (result: Awaited<ReturnType<typeof runFlow>>, name: string) => (result.runData[name] ?? []).filter((run) => run.source === 'main').at(-1)?.error;

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------

describe('text splitters', () => {
  const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(12).trim();

  it('cuts at the coarsest separator that fits: paragraphs, then lines, then words', () => {
    expect(recursiveCharacterSplit('First paragraph here.\n\nSecond paragraph here.', { chunkSize: 25, chunkOverlap: 0 })).toEqual([
      'First paragraph here.',
      'Second paragraph here.',
    ]);
    const chunks = recursiveCharacterSplit(prose, { chunkSize: 60, chunkOverlap: 0 });
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    // Words are never cut in half.
    expect(chunks.join(' ').split(/\s+/)).toEqual(prose.split(/\s+/));
  });

  it('repeats the end of a chunk at the start of the next (overlap)', () => {
    const chunks = recursiveCharacterSplit(prose, { chunkSize: 50, chunkOverlap: 15 });
    expect(chunks.length).toBeGreaterThan(5);
    const overlap = (prev: string, next: string) => {
      for (let n = Math.min(prev.length, next.length, 15); n > 0; n--) if (prev.endsWith(next.slice(0, n))) return n;
      return 0;
    };
    for (let i = 1; i < chunks.length; i++) expect(overlap(chunks[i - 1], chunks[i])).toBeGreaterThan(2);
  });

  it('falls back to characters for long unbroken text and rejects an overlap as large as the chunk', () => {
    expect(recursiveCharacterSplit('x'.repeat(25), { chunkSize: 10, chunkOverlap: 0 })).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    expect(() => recursiveCharacterSplit('abc', { chunkSize: 10, chunkOverlap: 10 })).toThrow();
    expect(recursiveCharacterSplit('   ', { chunkSize: 10, chunkOverlap: 0 })).toEqual([]);
  });

  it('splits markdown at headings with the code preset', () => {
    const markdown = '# Guide\n\nIntro text.\n## Install\n\nRun the installer.\n## Usage\n\nOpen the app.';
    const chunks = recursiveCharacterSplit(markdown, { chunkSize: 40, chunkOverlap: 0, separators: CODE_SEPARATORS.markdown });
    expect(chunks).toEqual(['# Guide\n\nIntro text.', '## Install\n\nRun the installer.', '## Usage\n\nOpen the app.']);
  });

  it('tokenizes like a GPT pre-tokenizer and gives back the text when joined', () => {
    expect(tokenize('Hello, world! 12345')).toEqual(['Hello', ',', ' world', '!', ' 123', '45']);
    const text = 'Retrieval-augmented generation (RAG) grounds answers in documents.';
    expect(tokenize(text).join('')).toBe(text);
    // Long words count as several tokens.
    expect(tokenize('internationalization')).toEqual(['internat', 'ionaliza', 'tion']);
  });

  it('cuts windows of tokens with overlap', () => {
    const text = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const chunks = tokenSplit(text, { chunkSize: 10, chunkOverlap: 2 });
    expect(chunks.every((c) => tokenize(c).length <= 10)).toBe(true);
    // "w12" is two tokens ("w", "12"): windows of 5 words, each repeating the last word of the one before.
    expect(chunks.slice(0, 2)).toEqual(['w0 w1 w2 w3 w4', 'w4 w5 w6 w7 w8']);
    expect(tokenSplit('', { chunkSize: 5, chunkOverlap: 0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('ranking', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/different dimensions/);
  });

  it('scores keywords with BM25, ignoring stopwords', () => {
    const docs = ['the cat sat on the mat', 'dogs and cats', 'a cat, a cat, another cat', 'nothing relevant here'];
    const scores = bm25Scores('the cat', docs);
    expect(scores[3]).toBe(0);
    expect(scores[1]).toBe(0); // "cats" is a different term
    expect(scores[2]).toBeGreaterThan(scores[0]);
    expect(bm25Scores('the of and', docs)).toEqual([0, 0, 0, 0]);
  });

  it('fuses rankings with reciprocal rank fusion (k = 60)', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
    ]);
    expect(fused.map((f) => f.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(fused[2].score).toBeCloseTo(1 / 61);
    expect(reciprocalRankFusion([['x', 'y']], 0)[0].score).toBe(1);
  });

  it('orders reranked documents by score and keeps ties in order', () => {
    const docs: AiDocument[] = ['a', 'b', 'c'].map((pageContent) => ({ pageContent, metadata: {} }));
    expect(rankByScores(docs, new Map([[2, 9], [0, 3]])).map((d) => [d.pageContent, d.score])).toEqual([
      ['c', 0.9],
      ['a', 0.3],
      ['b', undefined],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Data loader
// ---------------------------------------------------------------------------

describe('data loader', () => {
  it('reads values as text', () => {
    expect(textOf('plain')).toBe('plain');
    expect(textOf({ title: 'Hi', tags: ['a'], empty: '', none: null, n: 3 })).toBe('title: Hi\ntags: ["a"]\nn: 3');
    expect(textOf(undefined)).toBe('');
  });

  it('turns items into split documents with item, chunk and custom metadata', async () => {
    const docs = await loadDocuments(
      [{ json: { body: 'one two three four' } }, { json: { body: '' } }, { json: { body: 'five' } }],
      { mode: 'expressionData', data: (i) => [`one two three four`, '', 'five'][i], metadata: (i) => ({ source: `doc${i}` }), split: async (text) => text.split(' ').reduce<string[]>((acc, w, i) => (i % 2 ? ((acc[acc.length - 1] += ` ${w}`), acc) : [...acc, w]), []) },
    );
    expect(docs).toEqual([
      { pageContent: 'one two', metadata: { itemIndex: 0, chunk: 0, source: 'doc0' } },
      { pageContent: 'three four', metadata: { itemIndex: 0, chunk: 1, source: 'doc0' } },
      { pageContent: 'five', metadata: { itemIndex: 2, chunk: 0, source: 'doc2' } },
    ]);
    expect(metadataEntries({ metadataValues: [{ name: 'lang', value: 'en' }, { name: ' ', value: 'x' }] })).toEqual({ lang: 'en' });
  });
});

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'landflow-vectors-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stores: Array<[string, () => VectorStore]> = [
  ['in-memory', () => new MemoryVectorStore()],
  ['SQLite', () => new SqliteVectorStore(join(dir, 'vectors.sqlite'))],
];

describe.each(stores)('%s vector store', (_label, make) => {
  const collection = `test_${Math.random().toString(36).slice(2)}`;
  const store = make();
  const docs = DOCS.map((d, i) => ({ pageContent: d.text, metadata: { title: d.title, n: i }, embedding: hashEmbed(d.text) }));

  beforeAll(async () => {
    await store.clear(collection);
    await insertDocuments(store, collection, docs);
  });

  it('counts and lists collections', async () => {
    expect(await store.count(collection)).toBe(4);
    expect(await store.collections()).toContainEqual({ name: collection, count: 4 });
  });

  it('finds documents by meaning (cosine), best first', async () => {
    const found = await store.similaritySearch(collection, hashEmbed('how long is the laptop warranty'), 2);
    expect(found[0].metadata.title).toBe('Warranty');
    expect(found[0].score).toBeGreaterThan(found[1].score!);
    expect(found[0].id).toBeTruthy();
  });

  it('finds documents by keywords, leaving out non-matching ones', async () => {
    const found = await store.keywordSearch(collection, 'free shipping', 10);
    expect(found.map((d) => d.metadata.title)).toEqual(['Shipping']);
  });

  it('filters on metadata', async () => {
    const found = await store.similaritySearch(collection, hashEmbed('refund'), 4, { title: 'Support' });
    expect(found.map((d) => d.metadata.title)).toEqual(['Support']);
    expect(await store.similaritySearch(collection, hashEmbed('refund'), 4, { n: 0 })).toHaveLength(1);
  });

  it('searches hybrid with RRF', async () => {
    const found = await searchStore(store, collection, { query: 'return refund within 30 days', vector: hashEmbed('return refund within 30 days'), topK: 2, mode: 'hybrid' });
    expect(found[0].metadata.title).toBe('Returns');
    expect(found[0].score).toBeCloseTo(2 / 61);
  });

  it('rejects vectors of another size and clears a collection', async () => {
    await expect(store.add(collection, [{ pageContent: 'x', metadata: {}, embedding: [1, 2, 3] }])).rejects.toThrow(/64-dimensional/);
    await store.clear(collection);
    expect(await store.count(collection)).toBe(0);
  });
});

describe('SQLite vector store persistence', () => {
  it('keeps documents across store instances', async () => {
    const file = join(dir, 'persist.sqlite');
    await new SqliteVectorStore(file).add('kept', [{ pageContent: 'hello world', metadata: { a: 1 }, embedding: hashEmbed('hello world') }]);
    const found = await new SqliteVectorStore(file).similaritySearch('kept', hashEmbed('hello'), 1);
    expect(found).toMatchObject([{ pageContent: 'hello world', metadata: { a: 1 } }]);
  });
});

// ---------------------------------------------------------------------------
// Embeddings and reranker adapters
// ---------------------------------------------------------------------------

describe('Ollama embeddings', () => {
  const requests: Array<{ model: string; input: string[]; dimensions?: number }> = [];
  let base = '';
  let close = () => {};
  beforeAll(async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      res.writeHead(body.model === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body.model === 'missing' ? { error: 'model "missing" not found, try pulling it first' } : { model: body.model, embeddings: body.input.map(hashEmbed) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it('embeds in batches with document and query prefixes', async () => {
    const embeddings = ollamaEmbeddings({ baseUrl: base, model: 'nomic-embed-text', batchSize: 2, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
    const vectors = await embeddings.embedDocuments(['a b', 'c d', 'e f']);
    expect(vectors).toHaveLength(3);
    expect(requests.map((r) => r.input)).toEqual([['search_document: a b', 'search_document: c d'], ['search_document: e f']]);
    await embeddings.embedQuery('where');
    expect(requests.at(-1)!.input).toEqual(['search_query: where']);
  });

  it('explains a missing model', async () => {
    await expect(ollamaEmbeddings({ baseUrl: base, model: 'missing' }).embedQuery('x')).rejects.toThrow(/Ollama error 404/);
  });

  it('serves an agent knowledge base', async () => {
    const collection = 'agent_kb_test';
    const store = new MemoryVectorStore();
    await store.clear(collection);
    await store.add(collection, DOCS.map((d) => ({ pageContent: d.text, metadata: { title: d.title }, embedding: hashEmbed(d.text) })));
    const tool = knowledgeTool({
      id: 'kb',
      type: 'knowledge',
      name: 'search handbook',
      description: '',
      store: 'memory',
      collection,
      embeddings: { provider: 'ollama', model: 'fake-embed', baseUrl: base },
      topK: 1,
      searchMode: 'hybrid',
    });
    if ('error' in tool) throw new Error(tool.error);
    expect(tool.name).toBe('search_handbook');
    expect(tool.nodeType).toBe('core.vectorStoreInMemory');
    const { output } = await tool.invoke({ query: 'is shipping free' }, {} as ToolContext);
    expect(output).toMatchObject({ results: [{ metadata: { title: 'Shipping' } }] });
    expect(knowledgeTool({ ...{ id: 'x', type: 'knowledge', name: 'x', description: '', store: 'memory', embeddings: { provider: 'ollama', model: 'm' } }, collection: ' ' })).toEqual({ error: 'x: no collection set' });
  });
});

describe('LLM reranker', () => {
  const docs: AiDocument[] = ['about cats', 'about refunds', 'about dogs'].map((pageContent) => ({ pageContent, metadata: {} }));
  const model = (reply: string): LanguageModel => ({ provider: 'test', model: 'judge', generate: async () => ({ text: reply, toolCalls: [], stopReason: 'stop' }) });

  it('re-orders passages by the model’s scores', async () => {
    const ranked = await llmReranker(model('{"scores":[{"index":0,"score":1},{"index":1,"score":9},{"index":2,"score":4}]}')).rerank('refund policy', docs, { topK: 2 });
    expect(ranked.map((d) => [d.pageContent, d.score])).toEqual([
      ['about refunds', 0.9],
      ['about dogs', 0.4],
    ]);
  });

  it('keeps the retrieval order when the reply is unusable', async () => {
    const ranked = await llmReranker(model('I cannot do that')).rerank('q', docs, { topK: 2 });
    expect(ranked.map((d) => d.pageContent)).toEqual(['about cats', 'about refunds']);
  });
});

// ---------------------------------------------------------------------------
// Nodes in workflows
// ---------------------------------------------------------------------------

describe('mode-dependent ports', () => {
  it('shows the ports of the chosen mode and keeps their indexes', () => {
    const { inputs, outputs } = inMemoryVectorStoreNode.description;
    const shown = (parameters: Record<string, unknown>) => ({ inputs: visiblePorts(inputs, parameters).map((p) => p.type), outputs: visiblePorts(outputs, parameters).map((p) => p.type) });
    expect(shown({ mode: 'insert' })).toEqual({ inputs: ['main', 'ai_document', 'ai_embedding'], outputs: ['main'] });
    expect(shown({ mode: 'load' })).toEqual({ inputs: ['main', 'ai_embedding'], outputs: ['main'] });
    expect(shown({ mode: 'retrieve-as-tool' })).toEqual({ inputs: ['ai_embedding'], outputs: ['ai_tool'] });
    expect(shown({ mode: 'retrieve', useReranker: true })).toEqual({ inputs: ['ai_embedding', 'ai_reranker'], outputs: ['ai_retriever'] });
    // Dropped on an agent's Tool slot, the store switches to "As Tool".
    expect(portParameters(outputs.find((p) => p.type === 'ai_tool')!)).toEqual({ mode: 'retrieve-as-tool' });
  });

  it('gives the AI Agent a Fallback Model slot (ai_languageModel 1) while the switch is on', () => {
    const models = (needsFallback: boolean) =>
      indexedPorts(aiAgentNode.description.inputs, { needsFallback })
        .filter((p) => p.port.type === 'ai_languageModel' && p.visible)
        .map((p) => [p.port.displayName, p.index]);
    expect(models(false)).toEqual([['Chat Model', 0]]);
    expect(models(true)).toEqual([
      ['Chat Model', 0],
      ['Fallback Model', 1],
    ]);
  });
});

describe('vector store nodes', () => {
  it('inserts documents through the loader and embeddings, then gets them back (Get Many)', async () => {
    const collection = 'flow_insert';
    const insert = await insertFlow({ name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection, clearStore: true } }, {
      jsonMode: 'expressionData',
      jsonData: '{{ $json.text }}',
      options: { metadata: { metadataValues: [{ name: 'title', value: '{{ $json.title }}' }] } },
    });
    const [inserted] = outputsOf(insert, 'Store');
    expect(inserted).toHaveLength(4);
    expect(inserted[2]).toMatchObject({ pageContent: DOCS[2].text, metadata: { itemIndex: 2, chunk: 0, title: 'Warranty' } });
    // Sub-node calls are in the run data: the loader and the embeddings model.
    expect(insert.runData.Loader.some((r) => r.source === 'document' && r.status === 'success')).toBe(true);
    expect(insert.runData.Embeddings.some((r) => r.source === 'embedding')).toBe(true);

    const get = await runFlow(
      [
        { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'load', collection, prompt: '{{ $json.q }}', topK: 1 } },
        { name: 'Embeddings', type: 'test.fakeEmbeddings' },
      ],
      [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']],
      { input: [{ q: 'laptop warranty years' }, { q: 'email support team' }], extra: { fakeEmbeddings: fakeEmbeddingsNode } },
    );
    const [found] = outputsOf(get, 'Store');
    expect(found.map((f) => (f.document as JsonObject).metadata)).toMatchObject([{ title: 'Warranty' }, { title: 'Support' }]);
    expect(found[0].score).toBeGreaterThan(0);
  });

  it('uses a custom text splitter on the loader', async () => {
    const result = await insertFlow(
      { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: 'flow_split', clearStore: true } },
      { jsonMode: 'expressionData', jsonData: '{{ $json.text }}', textSplittingMode: 'custom' },
      { nodes: [{ name: 'Splitter', type: 'core.textSplitterRecursiveCharacterTextSplitter', parameters: { chunkSize: 40, chunkOverlap: 0 } }], edges: [['Splitter', 'Loader', 'ai_textSplitter']] },
    );
    const [inserted] = outputsOf(result, 'Store');
    expect(inserted.length).toBeGreaterThan(4);
    expect(inserted.every((doc) => String(doc.pageContent).length <= 40)).toBe(true);
    expect(result.runData.Splitter.some((r) => r.source === 'textSplitter')).toBe(true);
  });

  it('feeds a Question and Answer Chain as a retriever, with a reranker', async () => {
    await insertFlow({ name: 'Store', type: 'core.vectorStoreSqlite', parameters: { mode: 'insert', collection: 'qa_flow', clearStore: true } });
    const answer = scriptedModel([(input) => ({ text: input.system!.includes('free for orders over 50 euros') ? 'Free above 50 euros.' : 'I don’t know.' })]);
    const judge = scriptedModel([() => ({ text: '{"scores":[{"index":0,"score":10}]}' })]);
    const result = await runFlow(
      [
        { name: 'QA', type: 'core.chainRetrievalQa', parameters: { query: '{{ $json.chatInput }}', options: { returnSourceDocuments: true } } },
        { name: 'Model', type: 'test.scripted' },
        { name: 'Store', type: 'core.vectorStoreSqlite', parameters: { mode: 'retrieve', collection: 'qa_flow', topK: 1, useReranker: true, options: { searchMode: 'hybrid' } } },
        { name: 'Embeddings', type: 'test.fakeEmbeddings' },
        { name: 'Reranker', type: 'core.rerankerLlm', parameters: { topN: 1 } },
        { name: 'Judge', type: 'test.judge' },
      ],
      [
        ['Start', 'QA'],
        ['Model', 'QA', 'ai_languageModel'],
        ['Store', 'QA', 'ai_retriever', 0, 0],
        ['Embeddings', 'Store', 'ai_embedding'],
        ['Reranker', 'Store', 'ai_reranker'],
        ['Judge', 'Reranker', 'ai_languageModel'],
      ],
      { input: [{ chatInput: 'Is shipping free?' }], extra: { fakeEmbeddings: fakeEmbeddingsNode, scripted: answer.node, judge: judge.node } },
    );
    const [[out]] = outputsOf(result, 'QA');
    expect(out.response).toBe('Free above 50 euros.');
    expect(out.sourceDocuments).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
    expect(result.runData.Store.some((r) => r.source === 'retriever' && r.status === 'success')).toBe(true);
    expect(result.runData.Reranker.some((r) => r.source === 'reranker')).toBe(true);
  });

  it('explains a vector store in the wrong mode', async () => {
    const result = await runFlow(
      [
        { name: 'QA', type: 'core.chainRetrievalQa', parameters: { query: 'x' } },
        { name: 'Model', type: 'test.scripted' },
        { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: 'c' } },
        { name: 'Embeddings', type: 'test.fakeEmbeddings' },
      ],
      [['Start', 'QA'], ['Model', 'QA', 'ai_languageModel'], ['Store', 'QA', 'ai_retriever'], ['Embeddings', 'Store', 'ai_embedding']],
      { extra: { fakeEmbeddings: fakeEmbeddingsNode, scripted: scriptedModel([]).node } },
    );
    expect(failure(result, 'QA')?.message).toMatch(/is in “Insert Documents” mode/);
  });

  it('fails clearly without embeddings or with an empty prompt', async () => {
    const noEmbeddings = await runFlow([{ name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'load', collection: 'c', prompt: 'x' } }], [['Start', 'Store']]);
    expect(failure(noEmbeddings, 'Store')?.message).toBe('No embeddings model connected');
    const empty = await runFlow(
      [{ name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'load', collection: 'c', prompt: '' } }, { name: 'Embeddings', type: 'test.fakeEmbeddings' }],
      [['Start', 'Store'], ['Embeddings', 'Store', 'ai_embedding']],
      { extra: { fakeEmbeddings: fakeEmbeddingsNode } },
    );
    expect(failure(empty, 'Store')?.message).toBe('The prompt is empty');
  });
});

describe('end to end: insert, then an AI Agent searches the store as a tool', () => {
  it('answers from the retrieved passage', async () => {
    const collection = 'e2e_handbook';
    const insert = await insertFlow({ name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection, clearStore: true } });
    expect(insert.status).toBe('success');

    const model = scriptedModel([
      (input) => {
        expect(input.tools.map((t) => t.name)).toEqual(['search_handbook']);
        expect(input.tools[0].inputSchema).toMatchObject({ required: ['query'] });
        return { toolCalls: [{ id: 'c1', name: 'search_handbook', input: { query: 'how many days to return an item for a refund' } }] };
      },
      (input) => {
        const results = input.messages.at(-1) as { role: 'tool'; results: Array<{ content: string }> };
        const passages = JSON.parse(results.results[0].content) as { results: Array<{ pageContent: string; metadata: JsonObject }> };
        expect(passages.results[0].pageContent).toContain('within 30 days');
        return { text: 'You can return items within 30 days.' };
      },
    ]);
    const result = await runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: '{{ $json.chatInput }}' } },
        { name: 'Model', type: 'test.scripted' },
        { name: 'Handbook', type: 'core.vectorStoreInMemory', parameters: { mode: 'retrieve-as-tool', collection, toolName: 'search_handbook', topK: 2 } },
        { name: 'Embeddings', type: 'test.fakeEmbeddings' },
      ],
      [
        ['Start', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Handbook', 'Agent', 'ai_tool'],
        ['Embeddings', 'Handbook', 'ai_embedding'],
      ],
      { input: [{ chatInput: 'What is the return window?' }], extra: { fakeEmbeddings: fakeEmbeddingsNode, scripted: model.node } },
    );
    const [[answer]] = outputsOf(result, 'Agent');
    expect(answer.output).toBe('You can return items within 30 days.');
    expect(model.calls).toHaveLength(2);
    // The search shows up as a tool run of the store, and the query embedding as a sub-run of the embeddings model.
    expect(result.runData.Handbook.some((r) => r.source === 'tool' && r.status === 'success')).toBe(true);
    expect(result.runData.Embeddings.some((r) => r.source === 'embedding')).toBe(true);
  });
});
