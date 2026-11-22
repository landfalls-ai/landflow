/**
 * AG13 (wave ag3): Spotlight gives an agent its knowledge. The ask names a folder of the files directory; the design lists it
 * (never reads it) and says how it is searched; Create indexes it through the folder route; with no embeddings model the
 * knowledge base is searched by keywords (Landflow's BM25, no call); with no source the design asks and invents nothing.
 * The architect is scripted and the embeddings server is a local fake; nothing leaves this machine.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, VectorKnowledgeBaseConfig } from '@/lib/shared/agents';
import { agentAsk, knowledgeFolderOf } from '@/lib/shared/agent-ask';
import { knowledgeIndexSummary } from '@/lib/shared/agents';

// An agent the caller cannot update (another user's): the route says 404.
const foreign = new Set<string>();
vi.mock('@/lib/server/projects/access', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/projects/access')>();
  return { ...actual, canResource: (actor: never, kind: never, id: string, action: never) => !foreign.has(id) && actual.canResource(actor, kind, id, action) };
});

const NO_KB = 'Answers support emails and moves spam to the junk folder.'; // an ask whose scripted design proposes no knowledge base

// The architect, scripted: it proposes a knowledge base for the runbooks through the real `draftFrom` (the product's own rules).
vi.mock('@/lib/server/assistant/architect', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/assistant/architect')>();
  return {
    ...actual,
    designAgent: async (spec: { name: string; ask?: string }, input: Parameters<typeof actual.draftFrom>[1] & { types: never }) => {
      const draft = actual.draftFrom(
        spec.ask === NO_KB
          ? { name: spec.name, instructions: 'Answer support emails.', nodeTools: '', tools: [] }
          : { name: spec.name, instructions: 'Search the runbooks and answer.', nodeTools: '', knowledge: 'runbooks', tools: [{ type: 'knowledge', collection: 'runbooks', description: 'Search the incident runbooks' }] },
        { types: input.types, actor: input.actor, known: '', ...(input.resources && { resources: input.resources }), ...(spec.ask && { request: spec.ask }) },
      );
      return { ...draft, designed: true, notAdded: [] };
    },
  };
});

const root = mkdtempSync(join(tmpdir(), 'landflow-ag13-'));
const files = join(root, 'files');
process.env.LANDFLOW_FILES_DIR = files;
// Wave ag4: its own store. The suite's shared data directory can hold another file's agents with a `runbooks` base (ag4's
// reuse scenarios seed one), and this file's 'existing: false' readings are about a tenant that has none.
process.env.LANDFLOW_DATA_DIR = join(root, 'data');
const embedCalls: string[] = [];
const embeddedTexts: string[] = []; // C20: every text the fake model was asked to embed
let embedDown = false; // C20: the fake model answers 500
let embedServer: Server;

beforeAll(async () => {
  mkdirSync(files, { recursive: true });
  cpSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'runbooks'), join(files, 'runbooks'), { recursive: true });
  writeFileSync(join(root, 'outside.md'), '# outside\n\nNot in the files directory.');
  // A fake Ollama: it has no models (so the host has no embeddings model), counts every call, and answers /api/embed for the vector test.
  embedServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    embedCalls.push(req.url ?? '');
    if (req.url === '/api/tags') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [] }));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    if (embedDown && req.url === '/api/embed') return void res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'model is down' }));
    if (req.url === '/api/embed') embeddedTexts.push(...inputs);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ embeddings: inputs.map((t) => [t.includes('journal') ? 1 : 0, t.length % 7, 1]), model: 'm' }));
  });
  await new Promise<void>((resolve) => embedServer.listen(0, '127.0.0.1', resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(embedServer.address() as AddressInfo).port}`;
  process.env.LANDFLOW_BUILDER_MODEL = 'ollama/qwen3-coder:30b';
});
afterAll(() => new Promise<void>((resolve) => embedServer.close(() => resolve())));

const ASK_E = 'Create an agent that answers questions from our incident runbooks in the folder runbooks and says which runbook each answer comes from.';
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the ask names a folder', () => {
  it('reads the folder as written, never an absolute path, a .., a ~, a URL or a drive', () => {
    expect(agentAsk(ASK_E)?.knowledgeFolder).toBe('runbooks');
    expect(knowledgeFolderOf('answers from the runbooks folder')).toBe('runbooks');
    expect(knowledgeFolderOf('answers from the folder runbooks/ops')).toBe('runbooks/ops');
    expect(knowledgeFolderOf('answers from our docs in runbooks/')).toBe('runbooks');
    expect(agentAsk('Create an agent that answers questions from our incident runbooks.')?.knowledgeFolder).toBeUndefined();
    for (const bad of ['/etc', '../x', '~/docs', 'https://x/y', 'C:\\docs']) expect(knowledgeFolderOf(`answers from the folder ${bad}`)).toBeUndefined();
    expect(agentAsk('Create an agent that answers questions from the folder /etc')?.knowledgeFolder).toBeUndefined();
  });

  it('a bare "<word> folder" that asks for no knowledge names no source', () => {
    for (const ask of ['Make an agent that files each email into the right folder', 'Make an agent that moves spam to the junk folder', 'Make an agent that watches the inbox folder and summarises new mail']) {
      expect(agentAsk(ask)?.knowledgeFolder).toBeUndefined();
    }
  });

  it('a folder that is a destination or a plain object, not a source, names none even with a knowledge-ish verb', () => {
    for (const ask of ['Make an agent that answers support emails and moves spam to the junk folder', 'Make an agent that searches the inbox folder for invoices', 'Make an agent that saves the report in the reports folder based on the weekly sales']) {
      expect(agentAsk(ask)?.knowledgeFolder).toBeUndefined();
      expect(knowledgeFolderOf(ask)).toBeUndefined();
    }
    expect(knowledgeFolderOf('answer in French and move spam to the junk folder')).toBeUndefined();
    expect(agentAsk('Make an agent that answers questions from the folder runbooks')?.knowledgeFolder).toBe('runbooks');
  });
});

type Preview = { config: Partial<AgentConfig>; needs: Array<{ text: string }>; knowledge?: { folder?: string; files?: string[]; fileCount?: number; search?: string; embeddings?: string; existing?: boolean; problem?: string; collection?: string } };
async function design(extra: Record<string, unknown>): Promise<Preview> {
  const route = await import('@/app/api/agents/design/route');
  const response = await route.POST(post('/api/agents/design', { name: 'Runbook answerer', description: 'Answers from the runbooks.', ask: ASK_E, knowledge: 'incident runbooks', preview: true, ...extra }));
  expect(response.status).toBe(200);
  return (await response.json()) as Preview;
}
const kbOf = (config: Partial<AgentConfig>) => (config.tools ?? []).find((t) => t.type === 'knowledge') as VectorKnowledgeBaseConfig | undefined;
const collectionRows = async (collection: string) => (await import('@/lib/server/rag/stores')).SqliteVectorStore.prototype.metadataOf.call(new (await import('@/lib/server/rag/stores')).SqliteVectorStore(), collection);

describe('the design route', () => {
  it('a folder named: the card lists its four files and keyword search; nothing is indexed', async () => {
    const preview = await design({ knowledgeFolder: 'runbooks' });
    expect(preview.knowledge).toEqual({
      collection: 'runbooks',
      existing: false,
      folder: 'runbooks',
      files: ['runbooks/certificate-expiry.md', 'runbooks/disk-full.md', 'runbooks/high-cpu.md', 'runbooks/ssh-brute-force.md'],
      fileCount: 4,
      search: 'keyword',
      embeddings: 'keyword search (BM25, built in)',
    });
    expect(kbOf(preview.config)).toMatchObject({ store: 'sqlite', collection: 'runbooks', embeddings: { provider: 'none', model: 'bm25' }, searchMode: 'keyword', indexedFrom: 'runbooks' });
    expect(preview.needs.some((n) => /add documents/i.test(n.text))).toBe(false);
    expect(preview.config.instructions).toMatch(/name the file \(its `source`\) each answer comes from; if it finds nothing, say so/);
    expect(await collectionRows('runbooks')).toHaveLength(0);
  });

  it('no folder, as Spotlight: no knowledge base, one need asks for the folder, nothing is indexed', async () => {
    const preview = await design({});
    expect(kbOf(preview.config)).toBeUndefined();
    expect(preview.needs.filter((n) => /which folder/i.test(n.text))).toHaveLength(1);
    expect(preview.needs.some((n) => /add documents/i.test(n.text))).toBe(false);
    expect(preview.knowledge).toMatchObject({ existing: false });
    expect(preview.knowledge?.folder).toBeUndefined();
    expect(await collectionRows('runbooks')).toHaveLength(0);
  });

  it('a folder given while the design proposes no knowledge base and none was asked adds none', async () => {
    const preview = await design({ knowledgeFolder: 'runbooks', ask: NO_KB, knowledge: undefined });
    expect(kbOf(preview.config)).toBeUndefined();
    expect(preview.knowledge?.folder).toBeUndefined();
    expect(preview.config.instructions ?? '').not.toMatch(/name the file/);
  });

  it('a folder outside the files directory is never listed: the problem says why', async () => {
    const preview = await design({ knowledgeFolder: '../outside' });
    expect(preview.knowledge?.problem).toMatch(/not in the files directory/);
    expect(preview.knowledge?.files).toBeUndefined();
    expect(preview.needs.some((n) => /files directory/.test(n.text))).toBe(true);
  });
});

// ag3 fix pass (AG13 blockers 1 and 2).
describe('a folder reply to the card that asked for a source (the revise)', () => {
  const revise = async (extra: Record<string, unknown>) => {
    const route = await import('@/app/api/agents/design/route');
    // The no-source card's config has no knowledge base (the design dropped it); the reply names a folder.
    const response = await route.POST(post('/api/agents/design', { name: 'Runbook answerer', description: 'Answers from the runbooks.', ask: NO_KB, preview: true, base: { config: { name: 'Runbook answerer', instructions: 'Answer support emails.', tools: [] } }, change: 'from the folder runbooks', ...extra }));
    expect(response.status).toBe(200);
    return (await response.json()) as Preview & { changes: string[] };
  };

  it('knowledgeAsked + folder on a no-source card: the knowledge base, its files and the folder come back', async () => {
    const preview = await revise({ knowledgeFolder: 'runbooks', knowledgeAsked: true });
    expect(preview.knowledge).toMatchObject({ folder: 'runbooks', fileCount: 4, search: 'keyword' });
    expect(kbOf(preview.config)).toMatchObject({ collection: 'runbooks', indexedFrom: 'runbooks' });
  });

  it('a folder that is not named like knowledge works the same', async () => {
    mkdirSync(join(files, 'guides'), { recursive: true });
    writeFileSync(join(files, 'guides', 'onboarding.md'), '# Onboarding\n\nHow a new person starts.');
    const preview = await revise({ knowledgeFolder: 'guides', knowledgeAsked: true, change: 'from the guides folder' });
    expect(preview.knowledge).toMatchObject({ folder: 'guides', files: ['guides/onboarding.md'] });
    expect(kbOf(preview.config)).toMatchObject({ collection: 'guides', indexedFrom: 'guides' });
  });

  it('without knowledgeAsked the same folder adds nothing', async () => {
    const preview = await revise({ knowledgeFolder: 'runbooks' });
    expect(kbOf(preview.config)).toBeUndefined();
    expect(preview.knowledge?.folder).toBeUndefined();
  });
});

describe('an email folder is never a knowledge source (ag3 fix pass)', () => {
  const EMAIL_ASKS: Array<[string, string]> = [
    ['Make an agent that answers emails from the Inbox folder', 'Inbox'],
    ['Make an agent that searches emails in the Spam folder and answers them', 'Spam'],
    ['Make an agent that searches for invoices in the inbox folder', 'inbox'],
    ['Make an agent that looks up orders in the orders folder', 'orders'],
  ];

  it('the parser may read the folder, but the ask has no knowledge words, so the client sends no knowledgeAsked', () => {
    for (const [ask] of EMAIL_ASKS) {
      const parsed = agentAsk(ask);
      expect(parsed?.knowledge, ask).toBeUndefined();
    }
    // The positive ask still names its source.
    expect(agentAsk(ASK_E)?.knowledge).toBeTruthy();
    expect(agentAsk('Make an agent that answers from the runbooks folder')?.knowledge).toBeTruthy();
  });

  it('the design route, an existing inbox folder, a scripted design with no knowledge base: no base, no problem row, no need', async () => {
    mkdirSync(join(files, 'inbox'), { recursive: true });
    writeFileSync(join(files, 'inbox', 'mail.md'), '# Mail\n\nA message.');
    for (const [ask, folder] of EMAIL_ASKS) {
      const preview = await design({ ask: NO_KB, knowledge: undefined, knowledgeFolder: folder === 'inbox' || folder === 'Inbox' ? 'inbox' : folder });
      expect(kbOf(preview.config), ask).toBeUndefined();
      expect(preview.knowledge, ask).toBeUndefined();
      expect(preview.needs.some((n) => /knowledge|folder|files directory/i.test(n.text)), ask).toBe(false);
    }
  });
});

describe('the folder route and the search', () => {
  let agentId = '';
  let toolId = '';
  const folder = async (id: string, tool: string, body: unknown) => (await import('@/app/api/agents/[id]/knowledge/[toolId]/folder/route')).POST(post(`/api/agents/${id}/knowledge/${tool}/folder`, body), { params: Promise.resolve({ id, toolId: tool }) });

  it('Create indexes the folder: every chunk names its file; again replaces, never doubles', async () => {
    const preview = await design({ knowledgeFolder: 'runbooks' });
    const imported = await (await import('@/app/api/agents/import/route')).POST(post('/api/agents/import', { config: preview.config }));
    const { agent } = (await imported.json()) as { agent: { id: string; tools: Array<{ id: string; type: string }> } };
    agentId = agent.id;
    toolId = agent.tools.find((t) => t.type === 'knowledge')!.id;
    const first = await folder(agentId, toolId, { folder: 'runbooks' });
    expect(first.status).toBe(200);
    const done = (await first.json()) as { documents: number; chunks: number; failed: unknown[] };
    expect(done).toMatchObject({ documents: 4, failed: [] });
    expect(done.chunks).toBeGreaterThanOrEqual(4);
    const rows = await collectionRows('runbooks');
    expect(rows).toHaveLength(done.chunks);
    expect(rows.every((r) => String(r.metadata.source).startsWith('runbooks/'))).toBe(true);
    const again = (await (await folder(agentId, toolId, { folder: 'runbooks' })).json()) as typeof done & { reused: number; embedded: number; removed: number };
    // C20: nothing changed, so nothing is embedded and every chunk is reused.
    expect(again).toMatchObject({ documents: done.documents, chunks: done.chunks, failed: [], embedded: 0, removed: 0, reused: done.chunks });
    expect(await collectionRows('runbooks')).toHaveLength(done.chunks);
    const { agentStore } = await import('@/lib/server/agents/store');
    const saved = agentStore.get(agentId)!.tools.find((t) => t.id === toolId) as VectorKnowledgeBaseConfig;
    expect(saved.indexedFrom).toBe('runbooks');
    // C20: the draft remembers the last pass for the knowledge dialog.
    expect(saved.lastIndex).toMatchObject({ documents: 4, embedded: 0, reused: done.chunks, removed: 0, failed: 0 });
    expect(knowledgeIndexSummary(saved.lastIndex!)).toBe(`4 documents · 0 embedded, ${done.chunks} reused, 0 removed`);
  });

  it('refuses a folder outside the files directory (400) and an agent the caller cannot update (404)', async () => {
    expect((await folder(agentId, toolId, { folder: '../outside' })).status).toBe(400);
    expect((await folder(agentId, toolId, { folder: 'nothing-here' })).status).toBe(400);
    foreign.add(agentId);
    try {
      expect((await folder(agentId, toolId, { folder: 'runbooks' })).status).toBe(404);
    } finally {
      foreign.delete(agentId);
    }
    expect((await folder(agentId, 'tl_missing', { folder: 'runbooks' })).status).toBe(404);
  });

  it('the knowledge tool finds the disk-full passage first, by keywords, with no embeddings call', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { knowledgeTool } = await import('@/lib/server/agents/knowledge');
    const config = agentStore.get(agentId)!.tools.find((t) => t.id === toolId) as VectorKnowledgeBaseConfig;
    embedCalls.length = 0;
    const tool = knowledgeTool(config);
    if ('error' in tool) throw new Error(tool.error);
    const { output } = await tool.invoke({ query: 'how much journal do we keep' }, {} as never);
    const results = (output as { results: Array<{ pageContent: string; metadata: { source?: string } }> }).results;
    expect(results[0].metadata.source).toBe('runbooks/disk-full.md');
    expect(results[0].pageContent).toMatch(/730/);
    expect(embedCalls.filter((u) => u === '/api/embed')).toEqual([]);
  });
});

describe('embeddings', () => {
  it('a base drafted without a search mode, on a host with no embeddings model, still searches by keywords', async () => {
    const { draftFrom } = await import('@/lib/server/assistant/architect');
    const { agentResources } = await import('@/lib/server/assistant/agent-resources');
    const { allowedTypes } = await import('@/lib/server/assistant/scope');
    const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
    const { addKnowledgeDocument, knowledgeTool } = await import('@/lib/server/agents/knowledge');
    const actor = TEST_OWNER;
    const resources = await agentResources(actor);
    const draft = draftFrom({ name: 'Notes', instructions: 'Answer from the notes.', nodeTools: '', knowledge: 'notes', tools: [{ type: 'knowledge', collection: `notes-${Date.now()}`, description: 'Search the notes' }] }, { types: allowedTypes(undefined, actor), actor, known: '', resources });
    const config = (draft.config.tools ?? []).find((t) => t.type === 'knowledge') as VectorKnowledgeBaseConfig;
    expect(config.embeddings.provider).toBe('none');
    for (const [name, text] of [['a.md', 'The kettle is in the kitchen.'], ['b.md', 'Rotate the journal at 730 MB.'], ['c.md', 'Lunch is at noon.']]) await addKnowledgeDocument(config, { bytes: Buffer.from(text), fileName: name });
    const tool = knowledgeTool(config);
    if ('error' in tool) throw new Error(tool.error);
    const { output } = await tool.invoke({ query: 'journal' }, {} as never);
    expect((output as { results: Array<{ pageContent: string }> }).results[0].pageContent).toMatch(/journal/);
  });

  it('a keyword base on Postgres is refused with a clear message', async () => {
    const { knowledgeTool } = await import('@/lib/server/agents/knowledge');
    const tool = knowledgeTool({ id: 't', type: 'knowledge', name: 'search_x', description: 'x', store: 'pgvector', collection: 'x', embeddings: { provider: 'none', model: 'bm25' }, searchMode: 'keyword' });
    expect('error' in tool && tool.error).toMatch(/Postgres needs real vectors/);
  });

  it('an Ollama embeddings base still searches by vector', async () => {
    const { addKnowledgeDocument, knowledgeTool } = await import('@/lib/server/agents/knowledge');
    const config: VectorKnowledgeBaseConfig = { id: 't', type: 'knowledge', name: 'search_v', description: 'v', store: 'sqlite', collection: `vec-${Date.now()}`, embeddings: { provider: 'ollama', model: 'm', baseUrl: process.env.OLLAMA_URL }, searchMode: 'vector' };
    await addKnowledgeDocument(config, { bytes: Buffer.from('Keep the journal to 730 MB.'), fileName: 'a.md' });
    embedCalls.length = 0;
    const tool = knowledgeTool(config);
    if ('error' in tool) throw new Error(tool.error);
    const { output } = await tool.invoke({ query: 'journal' }, {} as never);
    expect((output as { results: unknown[] }).results).toHaveLength(1);
    expect(embedCalls.filter((u) => u === '/api/embed').length).toBeGreaterThan(0);
  });
});

// C20: re-indexing a folder embeds only what changed, keeps each file's document, and removes files that left.
describe('the last pass in words (C20)', () => {
  it('says documents, embedded, reused and removed, and failures only when there are some', () => {
    expect(knowledgeIndexSummary({ documents: 12, embedded: 3, reused: 241, removed: 5 })).toBe('12 documents · 3 embedded, 241 reused, 5 removed');
    expect(knowledgeIndexSummary({ documents: 1, embedded: 0, reused: 2, removed: 0, failed: 1 })).toBe('1 document · 0 embedded, 2 reused, 0 removed, 1 failed');
  });
});

describe('indexing a folder again (C20)', () => {
  const sub = 'c20-notes';
  const base = (n: number) => Array.from({ length: n }, (_, i) => `Section ${i}: ${Array.from({ length: 28 }, (_, w) => `word${i}x${w}`).join(' ')}.`).join('\n\n');
  const config = (collection: string): VectorKnowledgeBaseConfig => ({ id: 't', type: 'knowledge', name: 'search_notes', description: 'notes', store: 'sqlite', collection, embeddings: { provider: 'ollama', model: 'm', baseUrl: process.env.OLLAMA_URL }, searchMode: 'vector' });
  const put = (name: string, text: string) => writeFileSync(join(files, sub, name), text);
  const prepare = (collection: string) => {
    rmSync(join(files, sub), { recursive: true, force: true });
    mkdirSync(join(files, sub), { recursive: true });
    put('a.md', base(60));
    put('b.md', base(20).replace(/word/g, 'term'));
    put('c.md', base(20).replace(/word/g, 'item'));
    embeddedTexts.length = 0;
    embedDown = false;
    return config(collection);
  };

  it('the second pass embeds nothing and the knowledge list keeps its documents (AS-5, D6)', async () => {
    const { indexFolder, listKnowledgeDocuments } = await import('@/lib/server/agents/knowledge');
    const kb = prepare(`c20-same-${Date.now()}`);
    const first = await indexFolder(kb, sub);
    expect(first).toMatchObject({ documents: 3, reused: 0, removed: 0, failed: [] });
    expect(first.embedded).toBe(first.chunks);
    const ids = (await listKnowledgeDocuments(kb)).documents.map((d) => [d.fileName, d.documentId]).sort();
    embeddedTexts.length = 0;
    const second = await indexFolder(kb, sub);
    expect(second).toMatchObject({ documents: 3, embedded: 0, removed: 0, reused: first.chunks, failed: [] });
    expect(embeddedTexts).toHaveLength(0);
    expect((await listKnowledgeDocuments(kb)).documents.map((d) => [d.fileName, d.documentId]).sort()).toEqual(ids);
    console.log(`C20 folder: first pass ${first.chunks} chunks embedded ${first.embedded}; second pass embedded ${second.embedded}, reused ${second.reused}`);
  });

  it('an edited file embeds its changed chunks, a deleted file loses its chunks', async () => {
    const { indexFolder, listKnowledgeDocuments } = await import('@/lib/server/agents/knowledge');
    const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
    const kb = prepare(`c20-edit-${Date.now()}`);
    const first = await indexFolder(kb, sub);
    const aChunks = (await new SqliteVectorStore().metadataWhere(kb.collection, { source: `${sub}/a.md` })).length;
    put('a.md', base(60).replace('Section 30:', 'Section 30 (edited):'));
    embeddedTexts.length = 0;
    const second = await indexFolder(kb, sub);
    console.log(`C20 folder: edit in a ${aChunks}-chunk file of ${first.chunks}: embedded ${second.embedded}, reused ${second.reused}, removed ${second.removed}`);
    expect(second.embedded).toBeGreaterThanOrEqual(1);
    expect(second.embedded).toBeLessThanOrEqual(4);
    expect(embeddedTexts).toHaveLength(second.embedded);
    expect(second.reused).toBe(second.chunks - second.embedded);
    // The file b.md left the folder.
    rmSync(join(files, sub, 'b.md'));
    embeddedTexts.length = 0;
    const third = await indexFolder(kb, sub);
    expect(third).toMatchObject({ documents: 2, embedded: 0, failed: [] });
    expect(third.removed).toBeGreaterThan(0);
    const listed = (await listKnowledgeDocuments(kb)).documents;
    expect(listed.map((d) => d.fileName).sort()).toEqual([`${sub}/a.md`, `${sub}/c.md`]);
    expect(await new SqliteVectorStore().metadataWhere(kb.collection, { source: `${sub}/b.md` })).toEqual([]);
  });

  it('a file that can’t be read is reported and keeps its old chunks; a failing model leaves the base answering', async () => {
    const { indexFolder } = await import('@/lib/server/agents/knowledge');
    const { SqliteVectorStore } = await import('@/lib/server/rag/stores');
    const kb = prepare(`c20-fail-${Date.now()}`);
    await indexFolder(kb, sub);
    const before = await new SqliteVectorStore().metadataOf(kb.collection);
    put('b.md', '   ');
    const empty = await indexFolder(kb, sub);
    expect(empty.failed.map((f) => f.file)).toEqual([`${sub}/b.md`]);
    expect(await new SqliteVectorStore().metadataOf(kb.collection)).toHaveLength(before.length);
    put('a.md', base(60).replace('Section 10:', 'Section 10 changed:'));
    embedDown = true;
    try {
      const down = await indexFolder(kb, sub);
      expect(down.failed.map((f) => f.file)).toContain(`${sub}/a.md`);
    } finally {
      embedDown = false;
    }
    // The old chunks of a.md still answer: every id that was there is still there.
    const after = new Set((await new SqliteVectorStore().metadataOf(kb.collection)).map((r) => r.id));
    for (const row of before) expect(after.has(row.id)).toBe(true);
  });

  it('a single upload (no source) is a new document each time, as before', async () => {
    const { addKnowledgeDocument } = await import('@/lib/server/agents/knowledge');
    const kb = config(`c20-upload-${Date.now()}`);
    const one = await addKnowledgeDocument(kb, { bytes: Buffer.from('Keep the journal to 730 MB.'), fileName: 'a.md' });
    const two = await addKnowledgeDocument(kb, { bytes: Buffer.from('Keep the journal to 730 MB.'), fileName: 'a.md' });
    expect(one.documentId).not.toBe(two.documentId);
  });
});
