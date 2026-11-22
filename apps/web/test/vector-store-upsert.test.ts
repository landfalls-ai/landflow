/**
 * C20 (W4a P19): the Vector Store node's "Upsert by Key". With a key (an expression per item) the item's chunks replace
 * what the collection holds under that key and only new text is embedded; without it the insert is what it always was.
 * The embeddings sub-node counts the texts it embeds.
 */
import { describe, expect, it } from 'vitest';
import { defineNode, type JsonObject } from '@landflow/sdk';
import type { Embeddings } from '@landflow/engine';
import { MemoryVectorStore } from '@/lib/server/rag/stores';
import { runFlow, outputsOf } from './helpers';

const embedded: string[] = [];
let embedCalls = 0;
const fakeEmbeddings = defineNode({
  description: { name: 'countingEmbeddings', displayName: 'Counting Embeddings', description: 'x', version: 1, kind: 'subnode', supplies: 'ai_embedding', categories: ['AI'], inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
  supplyData: (ctx): Embeddings => ({
    provider: 'test',
    model: String(ctx.getNodeParameter('model', 0, 'm1')),
    embedDocuments: async (texts) => (embedCalls++, embedded.push(...texts), texts.map((t) => [t.length, 1, 2])),
    embedQuery: async (text) => [text.length, 1, 2],
  }),
});

const PAGES = [
  { id: 'a', text: 'Returns: items can be returned within 30 days.' },
  { id: 'b', text: 'Shipping is free for orders over 50 euros.' },
  { id: 'c', text: 'Every laptop has a two year warranty.' },
];

const flow = (collection: string, store: Record<string, unknown>, input: Array<Record<string, unknown>> = PAGES, loader: Record<string, unknown> = {}) =>
  runFlow(
    [
      { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection, ...store } },
      { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}', ...loader } },
      { name: 'Embeddings', type: 'test.countingEmbeddings' },
    ],
    [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding']],
    { input, extra: { countingEmbeddings: fakeEmbeddings } },
  );

const failure = (result: Awaited<ReturnType<typeof flow>>) => (result.runData.Store ?? []).filter((run) => run.source === 'main').at(-1)?.error;

describe('Vector Store node: Upsert by Key', () => {
  it('inserting the same three pages twice holds each once and the second run embeds nothing (AS-6)', async () => {
    const collection = `upsert_twice_${Date.now()}`;
    const options = { upsertKey: '{{ $json.id }}' };
    embedded.length = 0;
    const first = await flow(collection, options);
    expect(outputsOf(first, 'Store')[0]).toHaveLength(3);
    expect(embedded).toHaveLength(3);
    const calls = embedCalls;
    embedded.length = 0;
    const second = await flow(collection, options);
    expect(outputsOf(second, 'Store')[0]).toHaveLength(3);
    expect(embedded).toHaveLength(0);
    expect(embedCalls).toBe(calls);
    expect(await new MemoryVectorStore().count(collection)).toBe(3);
    const rows = await new MemoryVectorStore().metadataOf(collection);
    expect(rows.map((r) => r.metadata.upsertKey).sort()).toEqual(['a', 'b', 'c']);
  });

  it('one page changed: its chunks are replaced, the others reused', async () => {
    const collection = `upsert_change_${Date.now()}`;
    const options = { upsertKey: '{{ $json.id }}' };
    await flow(collection, options);
    embedded.length = 0;
    await flow(collection, options, [PAGES[0], { id: 'b', text: 'Shipping is free for orders over 80 euros.' }, PAGES[2]]);
    expect(embedded).toEqual(['Shipping is free for orders over 80 euros.']);
    const store = new MemoryVectorStore();
    expect(await store.count(collection)).toBe(3);
    const texts = (await store.similaritySearch(collection, [1, 1, 2], 10)).map((d) => d.pageContent);
    expect(texts).toContain('Shipping is free for orders over 80 euros.');
    expect(texts).not.toContain('Shipping is free for orders over 50 euros.');
  });

  it('items that share a key are one document', async () => {
    const collection = `upsert_group_${Date.now()}`;
    await flow(collection, { upsertKey: 'site' }, PAGES);
    expect(await new MemoryVectorStore().count(collection)).toBe(3);
    embedded.length = 0;
    await flow(collection, { upsertKey: 'site' }, PAGES.slice(0, 2));
    expect(embedded).toHaveLength(0);
    expect(await new MemoryVectorStore().count(collection)).toBe(2);
  });

  it('without a key the insert is today’s insert: a second run doubles the collection', async () => {
    const collection = `upsert_off_${Date.now()}`;
    await flow(collection, {});
    embedded.length = 0;
    await flow(collection, {});
    expect(embedded).toHaveLength(3);
    expect(await new MemoryVectorStore().count(collection)).toBe(6);
  });

  it('a key together with Clear Collection is a node error naming both', async () => {
    const result = await flow(`upsert_both_${Date.now()}`, { upsertKey: '{{ $json.id }}', clearStore: true });
    expect(failure(result)?.message).toMatch(/Upsert by Key/);
    expect(failure(result)?.message).toMatch(/Clear Collection/);
  });

  it('an item whose key comes out empty, while others have one, is a node error naming the item', async () => {
    const result = await flow(`upsert_empty_${Date.now()}`, { upsertKey: '{{ $json.id }}' }, [PAGES[0], { text: 'no id here' }]);
    expect(failure(result)?.message).toMatch(/Upsert by Key/);
    expect(failure(result)?.message).toMatch(/item 2/);
  });

  it('every key empty is the plain insert', async () => {
    const collection = `upsert_allempty_${Date.now()}`;
    await flow(collection, { upsertKey: '{{ $json.missing }}' });
    expect(await new MemoryVectorStore().count(collection)).toBe(3);
  });
});

const meta = (...entries: Array<[string, string]>) => ({ options: { metadata: { metadataValues: entries.map(([name, value]) => ({ name, value })) } } });

describe('Upsert by Key: what a workflow cannot set (review 3, 4, 5)', () => {
  it('ids are namespaced, so a key can never equal a knowledge base document id', async () => {
    const collection = `upsert_ids_${Date.now()}`;
    await flow(collection, { upsertKey: 'doc_abc' });
    for (const row of await new MemoryVectorStore().metadataOf(collection)) expect(row.id).toMatch(/^upsert:[0-9a-f]{16}:[0-9a-f]{16}:\d+$/);
  });

  it('metadata named like the re-index fields is dropped on a plain insert', async () => {
    const collection = `upsert_reserved_${Date.now()}`;
    await flow(collection, {}, PAGES, meta(['chunkHash', 'forged'], ['embedKey', 'test:m1'], ['documentKey', 'doc_x'], ['upsertKey', 'a']));
    for (const row of await new MemoryVectorStore().metadataOf(collection)) {
      expect(row.metadata).not.toHaveProperty('chunkHash');
      expect(row.metadata).not.toHaveProperty('embedKey');
      expect(row.metadata).not.toHaveProperty('documentKey');
      expect(row.metadata).not.toHaveProperty('upsertKey');
    }
  });

  it('metadata named itemIndex cannot move a chunk to another item', async () => {
    const collection = `upsert_index_${Date.now()}`;
    await flow(collection, { upsertKey: '{{ $json.id }}' }, PAGES, meta(['itemIndex', '0']));
    const keys = (await new MemoryVectorStore().metadataOf(collection)).map((r) => r.metadata.upsertKey).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('a document with no valid itemIndex is a node error, not a guess', async () => {
    const loose = defineNode({
      description: { name: 'looseLoader', displayName: 'Loose Loader', description: 'x', version: 1, kind: 'subnode', supplies: 'ai_document', categories: ['AI'], inputs: [], outputs: [{ type: 'ai_document' }], properties: [] },
      supplyData: () => ({ load: async () => [{ pageContent: 'no index here', metadata: {} }] }),
    });
    const result = await runFlow(
      [
        { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: `upsert_loose_${Date.now()}`, upsertKey: '{{ $json.id }}' } },
        { name: 'Loader', type: 'test.looseLoader' },
        { name: 'Embeddings', type: 'test.countingEmbeddings' },
      ],
      [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding']],
      { input: PAGES, extra: { countingEmbeddings: fakeEmbeddings, looseLoader: loose } },
    );
    expect(failure(result)?.message).toMatch(/item/i);
  });
});
