/**
 * C20 (W4a P19): re-index only what changed. Content-defined sections keep chunk boundaries steady when a paragraph is
 * inserted; `syncDocument` embeds only the chunks whose text (and embeddings model) is new and swaps a document's
 * chunks in one step. The embeddings stub counts the texts it is asked to embed: that count is the point.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Embeddings } from '@landflow/engine';
import { chunkHash, embedKeyOf, syncDocument } from '@/lib/server/rag/chunk-diff';
import { contentSections, SECTION_MAX, SECTION_MIN, stableChunks } from '@/lib/server/rag/sections';
import { searchTerms } from '@/lib/server/rag/search';
import { MemoryVectorStore, SqliteVectorStore, type VectorStore } from '@/lib/server/rag/stores';
import { recursiveCharacterSplit } from '@/lib/server/rag/splitters';

const dir = mkdtempSync(join(tmpdir(), 'landflow-c20-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DIMENSIONS = 32;
function hashEmbed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of searchTerms(text)) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

/** An embeddings stub that counts every text it embeds (and every call). */
function counting(model = 'hash-32', failOn?: (texts: string[]) => boolean) {
  const texts: string[] = [];
  let calls = 0;
  const embeddings: Embeddings = {
    provider: 'test',
    model,
    embedDocuments: async (batch) => {
      calls++;
      if (failOn?.(batch)) throw new Error('the embeddings model is down');
      texts.push(...batch);
      return batch.map(hashEmbed);
    },
    embedQuery: async (text) => hashEmbed(text),
  };
  return { embeddings, texts, calls: () => calls, reset: () => (texts.length = 0) };
}

/** `count` paragraphs of about 330 characters, each unique (a topic number and a pseudo-random run of words). */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
function paragraph(n: number, tag = 'p'): string {
  let seed = n * 7919 + tag.length * 104729;
  const words: string[] = [];
  while (words.join(' ').length < 320) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    words.push(WORDS[(seed >>> 8) % WORDS.length]);
  }
  return `Paragraph ${tag}${n}: ${words.join(' ')}.`;
}
const document = (count: number, edit?: (blocks: string[]) => string[]) => {
  const blocks = Array.from({ length: count }, (_, i) => paragraph(i));
  return (edit ? edit(blocks) : blocks).join('\n\n');
};

const OPTIONS = { chunkSize: 1000, chunkOverlap: 200 };

describe('content-defined sections', () => {
  it('cuts the same text the same way, and no section passes SECTION_MAX', () => {
    const text = document(120);
    expect(contentSections(text)).toEqual(contentSections(text));
    const sections = contentSections(text);
    expect(sections.length).toBeGreaterThan(10);
    for (const section of sections) expect(section.length).toBeLessThanOrEqual(SECTION_MAX);
    // Every section but the last holds at least SECTION_MIN characters, unless a heading cut it short.
    for (const section of sections.slice(0, -1)) expect(section.length).toBeGreaterThanOrEqual(SECTION_MIN - 400);
    expect(sections.join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('a heading starts a section once the one before it is long enough, and a short file stays one section', () => {
    const body = (word: string) => `${word} `.repeat(200).trim(); // 1,000 characters or so
    const text = ['# Title', body('intro'), '## One', body('first'), '## Two', body('second')].join('\n\n');
    expect(contentSections(text)).toEqual([`# Title\n\n${body('intro')}`, `## One\n\n${body('first')}`, `## Two\n\n${body('second')}`]);
    const short = ['# RB-101', 'Owner: Platform team.', '## When', 'The disk is above 91% used.', '## Steps', 'Shrink the journal to 730 MB.'].join('\n\n');
    expect(contentSections(short)).toEqual([short]);
  });

  it('a block longer than SECTION_MAX is still cut (the splitter handles it), and an empty text has no sections', () => {
    expect(contentSections('')).toEqual([]);
    expect(contentSections('x'.repeat(SECTION_MAX * 2)).join('').length).toBe(SECTION_MAX * 2);
  });

  it('inserting a paragraph changes at most two sections: every other section is byte-identical', () => {
    for (const at of [3, 25, 55, 90]) {
      const before = contentSections(document(120));
      const after = contentSections(document(120, (blocks) => [...blocks.slice(0, at), paragraph(999, 'new'), ...blocks.slice(at)]));
      const kept = new Set(before);
      const changed = after.filter((section) => !kept.has(section));
      expect(changed.length, `insert at ${at}`).toBeLessThanOrEqual(2);
      expect(before.filter((section) => !after.includes(section)).length, `insert at ${at}`).toBeLessThanOrEqual(2);
    }
  });

  it('stableChunks are no longer than the splitter makes them, and the chunks after an edit are the same', () => {
    const text = document(60);
    const chunks = stableChunks(text, OPTIONS);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(OPTIONS.chunkSize);
    expect(chunks.length).toBeGreaterThan(25);
    const edited = stableChunks(document(60, (blocks) => [paragraph(777, 'ins'), ...blocks]), OPTIONS);
    const old = new Set(chunks);
    // The greedy splitter alone shifts every boundary; sections keep all but the first section's chunks.
    const changedStable = edited.filter((chunk) => !old.has(chunk)).length;
    expect(changedStable).toBeLessThanOrEqual(8);
    const greedy = new Set(recursiveCharacterSplit(text, OPTIONS));
    const greedyEdited = recursiveCharacterSplit(document(60, (blocks) => [paragraph(777, 'ins'), ...blocks]), OPTIONS);
    const changedGreedy = greedyEdited.filter((chunk) => !greedy.has(chunk)).length;
    console.log(`insert at the top of ${chunks.length} chunks: ${changedStable} chunks change with sections, ${changedGreedy} with the greedy splitter`);
    expect(changedGreedy).toBeGreaterThan(2 * changedStable);
  });
});

let counter = 0;
const stores: Array<[string, () => VectorStore]> = [
  ['memory', () => new MemoryVectorStore()],
  ['sqlite', () => new SqliteVectorStore(join(dir, `v-${Math.random().toString(36).slice(2)}.sqlite`))],
];

describe.each(stores)('syncDocument on the %s store', (_name, open) => {
  let c = '';
  beforeEach(() => { c = `c${++counter}`; }); // the memory store's collections are shared by the process

  const chunksOf = (text: string) => stableChunks(text, OPTIONS).map((t, i) => ({ text: t, metadata: { source: 'a.md', chunk: i } }));
  const run = (store: VectorStore, e: Embeddings, collection: string, text: string, source = 'a.md', documentKey = 'doc_a') =>
    syncDocument(store, e, { collection, match: { source }, documentKey, chunks: chunksOf(text).map((c) => ({ ...c, metadata: { ...c.metadata, source } })) });

  it('the first pass embeds every chunk, an unchanged second pass none and writes nothing (AS-5)', async () => {
    const store = open();
    const e = counting();
    const text = document(40);
    const n = chunksOf(text).length;
    const first = await run(store, e.embeddings, c, text);
    expect(first).toMatchObject({ reused: 0, embedded: n, removed: 0 });
    expect(e.texts).toHaveLength(n);
    expect(await store.count(c)).toBe(n);
    e.reset();
    const callsBefore = e.calls();
    const writes: unknown[] = [];
    const replace = store.replace.bind(store);
    store.replace = async (...args) => (writes.push(args), replace(...args));
    expect(await run(store, e.embeddings, c, text)).toMatchObject({ reused: n, embedded: 0, removed: 0 });
    expect(e.calls()).toBe(callsBefore);
    expect(writes).toHaveLength(0);
  });

  it('every stored chunk carries its hash, embeddings key and document key', async () => {
    const store = open();
    const e = counting();
    await run(store, e.embeddings, c, document(10));
    for (const { id, metadata } of await store.metadataOf(c)) {
      expect(metadata.embedKey).toBe(embedKeyOf(e.embeddings));
      expect(metadata.documentKey).toBe('doc_a');
      expect(typeof metadata.chunkHash).toBe('string');
      expect(id.startsWith(`doc_a:${String(metadata.chunkHash).slice(0, 16)}:`)).toBe(true);
    }
    expect(chunkHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an edited paragraph embeds a few chunks and reuses the rest (AS-1)', async () => {
    const store = open();
    const e = counting();
    const text = document(60);
    const n = chunksOf(text).length;
    await run(store, e.embeddings, c, text);
    e.reset();
    const edited = document(60, (blocks) => blocks.map((b, i) => (i === 30 ? `${b} And one more sentence.` : b)));
    const result = await run(store, e.embeddings, c, edited);
    console.log(`AS-1: ${n} chunks, edit in the middle: embedded ${result.embedded}, reused ${result.reused}, removed ${result.removed}`);
    expect(result.embedded).toBeLessThanOrEqual(6);
    expect(result.embedded).toBeGreaterThanOrEqual(1);
    expect(result.reused).toBeGreaterThanOrEqual(n - 7);
    expect(e.texts).toHaveLength(result.embedded);
    expect(await store.count(c)).toBe(chunksOf(edited).length);
  });

  it('a paragraph inserted at the top reuses the chunks after it (AS-2) and a removed one is counted', async () => {
    const store = open();
    const e = counting();
    const text = document(60);
    await run(store, e.embeddings, c, text);
    e.reset();
    const inserted = document(60, (blocks) => [paragraph(555, 'top'), ...blocks]);
    const result = await run(store, e.embeddings, c, inserted);
    console.log(`AS-2: insert at top: embedded ${result.embedded}, reused ${result.reused}, removed ${result.removed}`);
    expect(result.embedded).toBeLessThanOrEqual(8);
    expect(result.reused).toBeGreaterThanOrEqual(25);
    e.reset();
    const shorter = document(60, (blocks) => blocks.slice(0, 40));
    const dropped = await run(store, e.embeddings, c, shorter);
    expect(dropped.removed).toBeGreaterThan(0);
    expect(await store.count(c)).toBe(chunksOf(shorter).length);
  });

  it('another embeddings model reuses nothing (AS-7)', async () => {
    const store = open();
    const text = document(20);
    const n = chunksOf(text).length;
    await run(store, counting('model-a').embeddings, c, text);
    const b = counting('model-b');
    expect(await run(store, b.embeddings, c, text)).toMatchObject({ reused: 0, embedded: n, removed: 0 });
    expect(b.texts).toHaveLength(n);
  });

  it('the same paragraph in two documents is embedded once (D7)', async () => {
    const store = open();
    const e = counting();
    const text = document(8);
    await run(store, e.embeddings, c, text, 'a.md', 'doc_a');
    e.reset();
    const result = await run(store, e.embeddings, c, text, 'b.md', 'doc_b');
    expect(result.embedded).toBe(0);
    expect(e.texts).toHaveLength(0);
    expect(await store.count(c)).toBe(2 * chunksOf(text).length);
  });

  it('a repeated text inside one document is embedded once and stored twice', async () => {
    const store = open();
    const e = counting();
    const result = await syncDocument(store, e.embeddings, {
      collection: c,
      match: { source: 'r.md' },
      documentKey: 'doc_r',
      chunks: [{ text: 'same words', metadata: { source: 'r.md' } }, { text: 'same words', metadata: { source: 'r.md' } }, { text: 'other words', metadata: { source: 'r.md' } }],
    });
    expect(result).toMatchObject({ reused: 1, embedded: 2, removed: 0 });
    expect(await store.count(c)).toBe(3);
  });

  it('chunks stored before this change (no hash) are embedded once, then reused (D9)', async () => {
    const store = open();
    const e = counting();
    const text = document(10);
    const chunks = chunksOf(text);
    await store.add(c, chunks.map((c) => ({ pageContent: c.text, metadata: { source: 'a.md', documentId: 'doc_old' }, embedding: hashEmbed(c.text) })));
    const first = await run(store, e.embeddings, c, text);
    expect(first.embedded).toBe(chunks.length);
    expect(first.removed).toBe(chunks.length);
    expect(await store.count(c)).toBe(chunks.length);
    e.reset();
    expect((await run(store, e.embeddings, c, text)).embedded).toBe(0);
  });

  it('an embeddings failure leaves the old chunks answering and stores nothing new (AS-4)', async () => {
    const store = open();
    const good = counting();
    const text = document(20);
    await run(store, good.embeddings, c, text);
    const before = await store.metadataOf(c);
    let batch = 0;
    const bad = counting('hash-32', () => ++batch >= 1);
    const edited = document(20, (blocks) => blocks.map((b, i) => (i % 3 === 0 ? `${b} changed` : b)));
    await expect(run(store, bad.embeddings, c, edited)).rejects.toThrow(/down/);
    expect(await store.metadataOf(c)).toEqual(before);
    const hits = await store.similaritySearch(c, hashEmbed('paragraph'), 3);
    expect(hits).toHaveLength(3);
  });

  it('vectors of another size than the collection holds are refused before anything is removed', async () => {
    const store = open();
    const e = counting();
    await run(store, e.embeddings, c, document(6), 'a.md', 'doc_a');
    const before = await store.metadataOf(c);
    const wide: Embeddings = { ...e.embeddings, embedDocuments: async (texts) => texts.map(() => [1, 2, 3]) };
    await expect(run(store, wide, c, document(6, (b) => b.slice(1)), 'b.md', 'doc_b')).rejects.toThrow(/dimensional/);
    expect(await store.metadataOf(c)).toEqual(before);
  });
});
