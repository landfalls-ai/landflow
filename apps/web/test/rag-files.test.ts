/**
 * Files in the RAG pipeline: the Default Data Loader's binary mode (PDF, DOCX, text, Markdown, HTML, CSV, JSON), the
 * Cohere reranker against a fake /v2/rerank server, and documents uploaded to an agent's knowledge base.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defineNode, inlineBinary, type NodeItem } from '@landflow/sdk';
import type { AiDocument, Embeddings } from '@landflow/engine';
import { writeZip } from '@/lib/server/binary/formats';
import { cohereRerankerNode } from '@/lib/server/nodes/rag';
import { fileDocuments, fileKind, fileText } from '@/lib/server/rag/files';
import { cohereReranker } from '@/lib/server/rag/rerank';
import { recursiveCharacterSplit, tokenize } from '@/lib/server/rag/splitters';
import { MemoryVectorStore } from '@/lib/server/rag/stores';
import { outputsOf, runFlow, type Input } from './helpers';
import { searchTerms } from '@/lib/server/rag/search';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-rag-files-'));
process.env.LANDFLOW_DATA_DIR = dataDir;

/** A PDF with one page per text (offsets computed, so any reader takes it). */
export function pdf(...pages: string[]): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A DOCX with the paragraphs; `'---'` makes a page break. */
export function docx(...paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => (p === '---' ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`))
    .join('');
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) },
  ]);
}

const DIMENSIONS = 64;
export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of searchTerms(text)) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

const fakeEmbeddingsNode = defineNode({
  description: { name: 'fakeEmbeddings', displayName: 'Fake Embeddings', description: 'x', version: 1, kind: 'subnode', supplies: 'ai_embedding', categories: ['AI'], inputs: [], outputs: [{ type: 'ai_embedding' }], properties: [] },
  supplyData: (): Embeddings => ({ provider: 'test', model: 'hash-64', embedDocuments: async (texts) => texts.map(hashEmbed), embedQuery: async (text) => hashEmbed(text) }),
});

/** Attaches the files to the items it receives. */
function filesNode(files: Array<{ field: string; bytes: Buffer; fileName: string; mimeType?: string }>) {
  return defineNode({
    description: { name: 'files', displayName: 'Files', description: 'x', version: 1, kind: 'action', categories: ['Test'], inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
    execute: (ctx) =>
      ctx.getInputData().map(
        (item): NodeItem => ({
          json: item.json,
          binary: Object.fromEntries(files.map((f) => [f.field, inlineBinary(f.bytes, { fileName: f.fileName, ...(f.mimeType && { mimeType: f.mimeType }) })])),
        }),
      ),
  });
}

describe('fileText and fileKind', () => {
  it('reads a PDF page by page', async () => {
    const pages = await fileText({ bytes: pdf('Alpha page one', 'Beta page two'), fileName: 'a.pdf', mimeType: 'application/pdf' });
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].text).toContain('Alpha page one');
    expect(pages[1].text).toContain('Beta page two');
  });

  it('reads a DOCX, with pages where the document has page breaks', async () => {
    const single = await fileText({ bytes: docx('Hello & welcome', 'Second paragraph'), fileName: 'a.docx' });
    expect(single).toEqual([{ text: 'Hello & welcome\nSecond paragraph' }]);
    const paged = await fileText({ bytes: docx('One', '---', 'Two'), fileName: 'b.docx' });
    expect(paged.map((p) => [p.page, p.text])).toEqual([[1, 'One'], [2, 'Two']]);
  });

  it('reads text, Markdown, HTML, CSV and JSON', async () => {
    const text = async (name: string, content: string, mimeType?: string) => (await fileText({ bytes: Buffer.from(content), fileName: name, ...(mimeType && { mimeType }) }))[0].text;
    expect(await text('n.txt', 'plain words', 'text/plain')).toBe('plain words');
    expect(await text('n.md', '# Title\n\nbody')).toBe('# Title\n\nbody');
    expect(await text('n.html', '<html><body><h1>Hi</h1><script>x()</script><p>there &amp; you</p></body></html>')).toBe('Hi\nthere & you');
    expect(await text('n.csv', 'name,city\nAda,London\nGrace,New York\n')).toBe('name: Ada\ncity: London\n\nname: Grace\ncity: New York');
    expect(await text('n.json', JSON.stringify([{ q: 'a', n: 1 }, { q: 'b', n: 2 }]), 'application/json')).toBe('q: a\nn: 1\n\nq: b\nn: 2');
    // A generic type does not hide the extension.
    expect(fileKind({ bytes: Buffer.from('x'), fileName: 'notes.md', mimeType: 'application/octet-stream' })).toBe('markdown');
  });

  it('explains what it cannot read', async () => {
    await expect(fileText({ bytes: Buffer.from([0, 1, 2, 3]), fileName: 'x.bin', mimeType: 'application/octet-stream' })).rejects.toThrow(/x\.bin.*isn’t supported/);
    await expect(fileText({ bytes: Buffer.from('{oops'), fileName: 'x.json' })).rejects.toThrow(/not valid JSON/);
    await expect(fileText({ bytes: writeZip([{ name: 'a.txt', data: Buffer.from('x') }]), fileName: 'x.docx' })).rejects.toThrow(/DOCX/);
  });

  it('chunks with the file name, page and a running chunk number', async () => {
    const docs = await fileDocuments({ bytes: pdf('Alpha one', 'Beta two'), fileName: 'a.pdf', mimeType: 'application/pdf' }, async (t) => [t], { itemIndex: 3 });
    expect(docs.map((d) => d.metadata)).toEqual([
      { itemIndex: 3, fileName: 'a.pdf', mimeType: 'application/pdf', page: 1, chunk: 0 },
      { itemIndex: 3, fileName: 'a.pdf', mimeType: 'application/pdf', page: 2, chunk: 1 },
    ]);
  });
});

describe('Default Data Loader in binary mode', () => {
  const run = (files: Parameters<typeof filesNode>[0], loader: Record<string, unknown>, input: Input = [{ id: 1 }]) =>
    runFlow(
      [
        { name: 'Files', type: 'test.files' },
        { name: 'Store', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', memoryKey: `rf-${Math.random()}` } },
        { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'binaryData', ...loader } },
        { name: 'Embeddings', type: 'test.fakeEmbeddings' },
      ],
      [['Start', 'Files'], ['Files', 'Store'], ['Loader', 'Store', 'ai_document'], ['Embeddings', 'Store', 'ai_embedding']],
      { input, extra: { files: filesNode(files), fakeEmbeddings: fakeEmbeddingsNode } },
    );

  it('loads a PDF and a DOCX with per-file metadata', async () => {
    const result = await run(
      [
        { field: 'data', bytes: pdf('Refunds take thirty days', 'Shipping is free'), fileName: 'policy.pdf', mimeType: 'application/pdf' },
        { field: 'notes', bytes: docx('Warranty covers two years'), fileName: 'warranty.docx' },
      ],
      { binaryField: '' },
    );
    const [rows] = outputsOf(result, 'Store');
    const metadata = rows.map((r) => r.metadata as Record<string, unknown>);
    expect(metadata.map((m) => [m.fileName, m.page])).toEqual([
      ['policy.pdf', 1],
      ['policy.pdf', 2],
      ['warranty.docx', undefined],
    ]);
    expect(rows[0].pageContent).toContain('Refunds take thirty days');
    expect(metadata[2].itemIndex).toBe(0);
  });

  it('reads only the named fields and names a missing one', async () => {
    const files = [{ field: 'data', bytes: Buffer.from('only this'), fileName: 'a.txt', mimeType: 'text/plain' }];
    const [rows] = outputsOf(await run(files, { binaryField: 'data' }), 'Store');
    expect(rows).toHaveLength(1);
    await expect(async () => outputsOf(await run(files, { binaryField: 'nope' }), 'Store')).rejects.toThrow(/no binary field “nope”/);
  });

  it('fails clearly on an unsupported file', async () => {
    await expect(async () => outputsOf(await run([{ field: 'data', bytes: Buffer.from([1, 2, 3, 4]), fileName: 'x.png', mimeType: 'image/png' }], { binaryField: 'data' }), 'Store')).rejects.toThrow(/x\.png.*isn’t supported/);
  });
});

// ---------------------------------------------------------------------------
// Cohere reranker
// ---------------------------------------------------------------------------

interface Seen {
  path: string;
  authorization?: string;
  body: { model: string; query: string; documents: string[]; top_n: number; max_tokens_per_doc?: number };
}

/** A fake Cohere server: scores a document by how many words of the query it contains. */
async function fakeCohere(status = 200) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Seen['body'];
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'invalid api token' }));
      return;
    }
    const words = new Set(tokenizeWords(body.query));
    const results = body.documents
      .map((doc, index) => ({ index, relevance_score: tokenizeWords(doc).filter((w) => words.has(w)).length / 10 }))
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, body.top_n);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r1', results, meta: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const tokenizeWords = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const DOCS: AiDocument[] = [
  { pageContent: 'Standard delivery takes five days', metadata: { n: 0 } },
  { pageContent: 'The return policy allows refunds within thirty days', metadata: { n: 1 } },
  { pageContent: 'Laptops have a two year warranty', metadata: { n: 2 } },
];

describe('Cohere reranker', () => {
  it('posts to /v2/rerank with the key and orders by relevance_score', async () => {
    const server = await fakeCohere();
    try {
      const reranker = cohereReranker({ baseUrl: `${server.url}/`, apiKey: 'co-test', topK: 2, maxTokensPerDoc: 256 });
      const out = await reranker.rerank('return policy refunds', DOCS);
      expect(out[0].metadata.n).toBe(1);
      expect(out).toHaveLength(2);
      expect(out[0].score).toBeGreaterThan(out[1].score!);
      expect(server.seen[0].path).toBe('/v2/rerank');
      expect(server.seen[0].authorization).toBe('Bearer co-test');
      expect(server.seen[0].body).toMatchObject({ model: 'rerank-v3.5', query: 'return policy refunds', top_n: 2, max_tokens_per_doc: 256 });
      expect(server.seen[0].body.documents).toEqual(DOCS.map((d) => d.pageContent));
    } finally {
      await server.close();
    }
  });

  it('fails with the server’s answer, or keeps the order when asked to', async () => {
    const server = await fakeCohere(401);
    try {
      await expect(cohereReranker({ baseUrl: server.url, apiKey: 'bad' }).rerank('q', DOCS)).rejects.toThrow(/answered 401/);
      const kept = await cohereReranker({ baseUrl: server.url, apiKey: 'bad', topK: 2, keepOrderOnFailure: true }).rerank('q', DOCS);
      expect(kept.map((d) => d.metadata.n)).toEqual([0, 1]);
    } finally {
      await server.close();
    }
  });

  it('works as a sub-node on a vector store with a Cohere credential', async () => {
    const server = await fakeCohere();
    try {
      const key = `rr-${Math.random()}`;
      const result = await runFlow(
        [
          { name: 'Insert', type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', memoryKey: key } },
          { name: 'Loader', type: 'core.documentDefaultDataLoader', parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}' } },
          { name: 'Embeddings', type: 'test.fakeEmbeddings' },
          { name: 'Search', type: 'core.vectorStoreInMemory', parameters: { mode: 'load', memoryKey: key, prompt: 'return policy refunds', topK: 2, useReranker: true } },
          { name: 'Reranker', type: 'core.rerankerCohere', parameters: { model: 'rerank-v3.5', topN: 2 }, credentials: { cohereApi: { apiKey: 'co-test', baseUrl: server.url } } },
          { name: 'Embeddings2', type: 'test.fakeEmbeddings' },
        ],
        [['Start', 'Insert'], ['Loader', 'Insert', 'ai_document'], ['Embeddings', 'Insert', 'ai_embedding'], ['Insert', 'Search'], ['Embeddings2', 'Search', 'ai_embedding'], ['Reranker', 'Search', 'ai_reranker']],
        { input: DOCS.map((d) => ({ text: d.pageContent })), extra: { fakeEmbeddings: fakeEmbeddingsNode } },
      );
      // One search per inserted document (three input items), two results each.
      const [rows] = outputsOf(result, 'Search');
      expect(rows).toHaveLength(6);
      expect((rows[0].document as { pageContent: string }).pageContent).toContain('return policy');
      expect(server.seen).toHaveLength(3);
      expect(server.seen[0].authorization).toBe('Bearer co-test');
      expect(cohereRerankerNode.description.credentials).toEqual([{ name: 'cohereApi', required: true }]);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Agent knowledge base documents
// ---------------------------------------------------------------------------

describe('knowledge base documents', () => {
  it('uploads, lists, searches and deletes documents', async () => {
    // An OpenAI-compatible embeddings endpoint on the fake server.
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: hashEmbed(text) })), usage: { prompt_tokens: 1 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { addKnowledgeDocument, deleteKnowledgeDocument, listKnowledgeDocuments } = await import('@/lib/server/agents/knowledge');
    const { ollamaEmbeddings } = await import('@/lib/server/rag/embeddings');
    void ollamaEmbeddings;
    try {
      // Ollama embeddings against the fake: /api/embed.
      server.removeAllListeners('request');
      server.on('request', async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: inputs.map(hashEmbed), model: 'm' }));
      });
      const config = {
        id: 'tool_1',
        type: 'knowledge' as const,
        name: 'search_docs',
        description: 'docs',
        store: 'sqlite' as const,
        collection: `kb-${Math.random()}`,
        embeddings: { provider: 'ollama' as const, model: 'm', baseUrl: url },
      };
      const a = await addKnowledgeDocument(config, { bytes: pdf('Refund within thirty days', 'Free shipping over fifty euros'), fileName: 'policy.pdf', mimeType: 'application/pdf' });
      const b = await addKnowledgeDocument(config, { bytes: Buffer.from('# Warranty\n\nTwo years on laptops.'), fileName: 'warranty.md' });
      expect(a).toMatchObject({ fileName: 'policy.pdf', pages: 2, chunks: 2 });
      expect(b).toMatchObject({ fileName: 'warranty.md', chunks: 1 });
      const listed = await listKnowledgeDocuments(config);
      expect(listed.documents.map((d) => [d.fileName, d.chunks])).toEqual([['policy.pdf', 2], ['warranty.md', 1]]);
      expect(await deleteKnowledgeDocument(config, a.documentId)).toBe(2);
      expect((await listKnowledgeDocuments(config)).documents.map((d) => d.fileName)).toEqual(['warranty.md']);
      await expect(addKnowledgeDocument(config, { bytes: Buffer.from('   '), fileName: 'empty.txt' })).rejects.toThrow(/no text/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('deleteWhere and metadataOf work on the memory store', async () => {
    const store = new MemoryVectorStore();
    await store.add('c', [
      { pageContent: 'a', metadata: { documentId: 'x' }, embedding: [1, 0] },
      { pageContent: 'b', metadata: { documentId: 'x' }, embedding: [0, 1] },
      { pageContent: 'c', metadata: { documentId: 'y' }, embedding: [1, 1] },
    ]);
    expect(await store.deleteWhere('c', { documentId: 'x' })).toBe(2);
    expect((await store.metadataOf('c')).map((r) => r.metadata.documentId)).toEqual(['y']);
  });
});

afterAll(() => {
  void recursiveCharacterSplit;
  void tokenize;
});
