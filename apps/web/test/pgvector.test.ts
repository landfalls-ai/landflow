/**
 * The PGVector store against a real Postgres with pgvector (the infra stack's, database landflow_test):
 *   LANDFLOW_INTEGRATION=postgres npx vitest run test/pgvector.test.ts
 * LANDFLOW_PG_URL overrides the connection (default postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineNode, type JsonObject } from '@landflow/sdk';
import type { Embeddings } from '@landflow/engine';
import { pgConfig, postgresCredential } from '@/lib/server/nodes/vector-stores';
import { syncDocument } from '@/lib/server/rag/chunk-diff';
import { closePgPools, insertDocuments, PgVectorStore, pgTableName, searchStore } from '@/lib/server/rag/stores';
import { searchTerms } from '@/lib/server/rag/search';
import { outputsOf, runFlow } from './helpers';

const enabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres');
const url = new URL(process.env.LANDFLOW_PG_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test');
const credential = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: 'disable' };
const TABLE = `landflow_vectors_test_${process.pid}`;

const DIMENSIONS = 32;
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of searchTerms(text)) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

const DOCS = [
  { pageContent: 'Our return policy: items can be returned within 30 days for a refund.', metadata: { title: 'Returns', lang: 'en' } },
  { pageContent: 'Shipping is free for orders over 50 euros.', metadata: { title: 'Shipping', lang: 'en' } },
  { pageContent: 'Every laptop has a two year warranty covering hardware defects.', metadata: { title: 'Warranty', lang: 'en' } },
  { pageContent: 'Der Versand ist ab 50 Euro kostenlos.', metadata: { title: 'Versand', lang: 'de' } },
];

describe.skipIf(!enabled)('PGVector store (Postgres)', () => {
  const store = new PgVectorStore(pgConfig(credential), TABLE);
  const collection = 'handbook';

  beforeAll(async () => {
    await store.clear(collection);
    await insertDocuments(store, collection, DOCS.map((doc) => ({ ...doc, embedding: embed(doc.pageContent) })));
  });

  afterAll(async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ ...credential, ssl: false });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS ${pgTableName(TABLE)}`);
    await client.end();
    await closePgPools();
  });

  it('tests the credential and reports pgvector', async () => {
    expect(await postgresCredential.test!(credential)).toEqual({ ok: true, message: expect.stringMatching(/^Connected; pgvector \d+\.\d+/) });
    expect((await postgresCredential.test!({ ...credential, password: 'wrong' })).ok).toBe(false);
  });

  it('creates the table, counts and lists collections', async () => {
    expect(await store.count(collection)).toBe(4);
    expect(await store.collections()).toContainEqual({ name: collection, count: 4 });
  });

  it('searches by cosine distance', async () => {
    const found = await store.similaritySearch(collection, embed('laptop warranty years'), 2);
    expect(found[0].metadata.title).toBe('Warranty');
    expect(found[0].score).toBeGreaterThan(found[1].score!);
  });

  it('searches by keywords with full-text search', async () => {
    const found = await store.keywordSearch(collection, 'free shipping orders', 10);
    expect(found[0].metadata.title).toBe('Shipping');
    expect(found.map((d) => d.metadata.title)).not.toContain('Warranty');
  });

  it('filters on metadata and fuses hybrid results', async () => {
    const german = await store.similaritySearch(collection, embed('Versand kostenlos'), 4, { lang: 'de' });
    expect(german.map((d) => d.metadata.title)).toEqual(['Versand']);
    const hybrid = await searchStore(store, collection, { query: 'refund within 30 days', vector: embed('refund within 30 days'), topK: 1, mode: 'hybrid' });
    expect(hybrid[0].metadata.title).toBe('Returns');
  });

  it('keeps collections apart and rejects vectors of another size', async () => {
    await store.add('other', [{ pageContent: 'elsewhere', metadata: {}, embedding: embed('elsewhere') }]);
    expect(await store.count('other')).toBe(1);
    expect((await store.similaritySearch(collection, embed('elsewhere'), 10)).map((d) => d.pageContent)).not.toContain('elsewhere');
    await expect(store.add(collection, [{ pageContent: 'x', metadata: {}, embedding: [1, 2, 3] }])).rejects.toThrow(/dimensional/);
    await store.clear('other');
    expect(await store.count('other')).toBe(0);
  });

  it('works as a node: insert with the credential, then Get Many', async () => {
    const embeddingsNode = defineNode({
      description: { name: 'embed', displayName: 'Embed', description: '', version: 1, kind: 'subnode', supplies: 'ai_embedding', inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
      supplyData: (): Embeddings => ({ provider: 'test', model: 'hash', embedDocuments: async (texts) => texts.map(embed), embedQuery: async (text) => embed(text) }),
    });
    const node = (parameters: Record<string, unknown>) => ({ name: 'Store', type: 'core.vectorStorePGVector', parameters: { tableName: TABLE, collection: 'node_flow', ...parameters }, credentials: { postgres: credential as JsonObject } });
    const insert = await runFlow(
      [node({ mode: 'insert', clearStore: true }), { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.pageContent }}' } }, { name: 'Embed', type: 'test.embed' }],
      [['Start', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embed', 'Store', 'ai_embedding']],
      { input: DOCS, extra: { embed: embeddingsNode } },
    );
    expect(outputsOf(insert, 'Store')[0]).toHaveLength(4);
    const get = await runFlow(
      [node({ mode: 'load', prompt: '{{ $json.q }}', topK: 1, options: { searchMode: 'hybrid' } }), { name: 'Embed', type: 'test.embed' }],
      [['Start', 'Store'], ['Embed', 'Store', 'ai_embedding']],
      { input: [{ q: 'two year laptop warranty' }], extra: { embed: embeddingsNode } },
    );
    expect(outputsOf(get, 'Store')[0][0].document).toMatchObject({ pageContent: DOCS[2].pageContent });
  });

  it('refuses table names that are not plain identifiers', () => {
    expect(() => new PgVectorStore(pgConfig(credential), 'bad; DROP TABLE x')).toThrow(/Invalid table name/);
    expect(pgTableName('public.vectors')).toBe('"public"."vectors"');
  });

  // C20: the one-transaction replace and the hash lookup.
  const doc = (id: string, source: string, text: string, extra: JsonObject = {}) => ({ id, pageContent: text, metadata: { source, ...extra }, embedding: embed(text) });
  const ids = async (collection: string, source: string) => (await store.metadataWhere(collection, { source })).map((row) => row.id).sort();

  it('metadataWhere, vectorsByHash and replace (the new set in, the old set out, one step)', async () => {
    const c = 'c20_basic';
    await store.clear(c);
    await store.add(c, [doc('1', 'a.md', 'one', { chunkHash: 'h1', embedKey: 'k' }), doc('2', 'a.md', 'two'), doc('3', 'b.md', 'three')]);
    expect(await ids(c, 'a.md')).toEqual(['1', '2']);
    const found = await store.vectorsByHash(c, ['h1', 'nope'], 'k');
    expect([...found.keys()]).toEqual(['h1']);
    expect(found.get('h1')!.map((v) => Math.round(v))).toEqual(embed('one'));
    expect((await store.vectorsByHash(c, ['h1'], 'other')).size).toBe(0);
    expect(await store.replace(c, { remove: { source: 'a.md' }, add: [doc('4', 'a.md', 'four')] })).toEqual({ removed: 2, added: 1 });
    expect(await ids(c, 'a.md')).toEqual(['4']);
    expect(await store.count(c)).toBe(2);
    await expect(store.replace(c, { remove: {}, add: [] })).rejects.toThrow(/filter/);
  });

  it('a search from another connection sees the old set or the new set, never a mix (AS-3, AS-8)', async () => {
    const c = 'c20_swap';
    await store.clear(c);
    const old = Array.from({ length: 12 }, (_, i) => doc(`old-${i}`, 'a.md', `old text ${i}`));
    await store.add(c, old);
    const other = new PgVectorStore(pgConfig(credential), TABLE); // its own object over the same pool: another connection serves it
    const fresh = Array.from({ length: 12 }, (_, i) => doc(`new-${i}`, 'a.md', `new text ${i}`));
    let done = false;
    const swap = store.replace(c, { remove: { source: 'a.md' }, add: fresh }).finally(() => (done = true));
    const seen = new Set<string>();
    while (!done) {
      const rows = await other.metadataWhere(c, { source: 'a.md' });
      expect(rows).toHaveLength(12);
      const kinds = new Set(rows.map((r) => r.id.split('-')[0]));
      expect(kinds.size).toBe(1);
      seen.add([...kinds][0]);
    }
    await swap;
    expect(await ids(c, 'a.md')).toEqual(fresh.map((d) => d.id).sort());
  });

  it('a failure inside the step leaves the old chunks (AS-4, AS-8)', async () => {
    const c = 'c20_fail';
    await store.clear(c);
    await store.add(c, [doc('1', 'a.md', 'one'), doc('2', 'a.md', 'two'), doc('3', 'b.md', 'three')]);
    // Two chunks with one id: the insert fails after the delete ran, inside the transaction.
    await expect(store.replace(c, { remove: { source: 'a.md' }, add: [doc('9', 'a.md', 'nine'), doc('9', 'a.md', 'nine again')] })).rejects.toThrow();
    expect(await ids(c, 'a.md')).toEqual(['1', '2']);
    // A size the collection does not hold is refused before the delete.
    await expect(store.replace(c, { remove: { source: 'a.md' }, add: [{ id: '8', pageContent: 'x', metadata: { source: 'a.md' }, embedding: [1, 2, 3] }] })).rejects.toThrow(/dimensional/);
    expect(await ids(c, 'a.md')).toEqual(['1', '2']);
  });

  it('syncDocument: the second pass embeds nothing, an edit embeds one chunk, a failing model changes nothing', async () => {
    const c = 'c20_sync';
    await store.clear(c);
    let embedded = 0;
    let down = false;
    const embeddings: Embeddings = {
      provider: 'test',
      model: 'hash-32',
      embedDocuments: async (texts) => {
        if (down) throw new Error('the embeddings model is down');
        embedded += texts.length;
        return texts.map(embed);
      },
      embedQuery: async (text) => embed(text),
    };
    const chunks = (edit = false) => Array.from({ length: 10 }, (_, i) => ({ text: `chunk number ${i} ${edit && i === 4 ? 'edited' : 'same'} words`, metadata: { source: 'a.md', chunk: i } }));
    const input = (edit = false) => ({ collection: c, match: { source: 'a.md' }, documentKey: 'doc_a', chunks: chunks(edit) });
    expect(await syncDocument(store, embeddings, input())).toMatchObject({ reused: 0, embedded: 10, removed: 0 });
    embedded = 0;
    expect(await syncDocument(store, embeddings, input())).toMatchObject({ reused: 10, embedded: 0, removed: 0 });
    expect(embedded).toBe(0);
    expect(await syncDocument(store, embeddings, input(true))).toMatchObject({ reused: 9, embedded: 1, removed: 1 });
    expect(embedded).toBe(1);
    const before = await store.metadataOf(c);
    down = true;
    await expect(syncDocument(store, embeddings, { ...input(), chunks: chunks().map((chunk) => ({ ...chunk, text: `${chunk.text} again` })) })).rejects.toThrow(/down/);
    expect(await store.metadataOf(c)).toEqual(before);
  });
});
