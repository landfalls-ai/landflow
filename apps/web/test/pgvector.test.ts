/**
 * The PGVector store against a real Postgres with pgvector (the infra stack's, database landflow_test):
 *   LANDFLOW_INTEGRATION=postgres npx vitest run test/pgvector.test.ts
 * LANDFLOW_PG_URL overrides the connection (default postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineNode, type JsonObject } from '@landflow/sdk';
import type { Embeddings } from '@landflow/engine';
import { pgConfig, postgresCredential } from '@/lib/server/nodes/vector-stores';
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
});
