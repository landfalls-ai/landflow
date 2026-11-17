/**
 * AG13 (wave ag3): Spotlight gives an agent its knowledge. The ask names a folder of the files directory; the design lists it
 * (never reads it) and says how it is searched; Create indexes it through the folder route; with no embeddings model the
 * knowledge base is searched by keywords (Landflow's BM25, no call); with no source the design asks and invents nothing.
 * The architect is scripted and the embeddings server is a local fake; nothing leaves this machine.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, VectorKnowledgeBaseConfig } from '@/lib/shared/agents';
import { agentAsk, knowledgeFolderOf } from '@/lib/shared/agent-ask';

// An agent the caller cannot update (another user's): the route says 404.
const foreign = new Set<string>();
vi.mock('@/lib/server/projects/access', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/projects/access')>();
  return { ...actual, canResource: (actor: never, kind: never, id: string, action: never) => !foreign.has(id) && actual.canResource(actor, kind, id, action) };
});

// The architect, scripted: it proposes a knowledge base for the runbooks through the real `draftFrom` (the product's own rules).
vi.mock('@/lib/server/assistant/architect', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/assistant/architect')>();
  return {
    ...actual,
    designAgent: async (spec: { name: string; ask?: string }, input: Parameters<typeof actual.draftFrom>[1] & { types: never }) => {
      const draft = actual.draftFrom(
        { name: spec.name, instructions: 'Search the runbooks and answer.', nodeTools: '', knowledge: 'runbooks', tools: [{ type: 'knowledge', collection: 'runbooks', description: 'Search the incident runbooks' }] },
        { types: input.types, actor: input.actor, known: '', ...(input.resources && { resources: input.resources }), ...(spec.ask && { request: spec.ask }) },
      );
      return { ...draft, designed: true, notAdded: [] };
    },
  };
});

const root = mkdtempSync(join(tmpdir(), 'landflow-ag13-'));
const files = join(root, 'files');
process.env.LANDFLOW_FILES_DIR = files;
const embedCalls: string[] = [];
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

  it('a folder outside the files directory is never listed: the problem says why', async () => {
    const preview = await design({ knowledgeFolder: '../outside' });
    expect(preview.knowledge?.problem).toMatch(/not in the files directory/);
    expect(preview.knowledge?.files).toBeUndefined();
    expect(preview.needs.some((n) => /files directory/.test(n.text))).toBe(true);
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
    const again = (await (await folder(agentId, toolId, { folder: 'runbooks' })).json()) as typeof done;
    expect(again).toEqual(done);
    expect(await collectionRows('runbooks')).toHaveLength(done.chunks);
    const { agentStore } = await import('@/lib/server/agents/store');
    expect((agentStore.get(agentId)!.tools.find((t) => t.id === toolId) as VectorKnowledgeBaseConfig).indexedFrom).toBe('runbooks');
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
