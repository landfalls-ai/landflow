/**
 * C21 (W4a P20): agents' knowledge bases honour collection grants. An agent's home project asks: a base that names another
 * project's collection is not built (the run says why), can't be searched in the playground, shows no count, and its uploads and
 * folder indexing answer 403 with the one message; a grant opens it read-only; project knowledge follows its project; the
 * architect's listing leaves out what the project can't read and marks what was shared with it; the brain's names (and
 * landflow-agent-memory) stay closed to every saved config. Keyword search (no embeddings model): nothing leaves this machine.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VectorKnowledgeBaseConfig } from '@/lib/shared/agents';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-aka-'));
const filesDir = join(dataDir, 'files');
mkdirSync(join(filesDir, 'runbooks'), { recursive: true });
writeFileSync(join(filesDir, 'runbooks', 'disk.md'), '# Disk full\n\nFree space with the cleanup job, then restart the service.');
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_FILES_DIR: filesDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { buildTools } = await import('@/lib/server/agents/tools');
const knowledge = await import('@/lib/server/agents/knowledge');
const { agentConnections, withDocumentCounts } = await import('@/lib/server/agents/connections');
const access = await import('@/lib/server/rag/collection-access');
const { runPlayground } = await import('@/lib/server/memory/playground');
const { catalogKnowledge } = await import('@/lib/server/assistant/tenant-catalog');
const { assertAgentSettingsPatch } = await import('@/lib/server/project-context/project-settings');
const documentsRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/documents/route');
const folderRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/folder/route');
const { storeKeyOf } = await import('@/lib/shared/collections');
const { AGENT_MEMORY_COLLECTION } = await import('@/lib/shared/brain');

const unique = (name: string) => `${name}-${Date.now().toString(36)}`;
const base = (collection: string, id = 'kb1'): VectorKnowledgeBaseConfig => ({ id, type: 'knowledge', source: 'vector', name: 'search_docs', description: 'Search the docs', store: 'sqlite', collection, embeddings: { provider: 'none', model: 'bm25' }, topK: 4 });

let A = '';
let B = '';
let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let alice: Awaited<ReturnType<typeof auth.createUser>>;
let session = '';

/** An agent whose knowledge base names `collection`, at home in `project`. */
function agentIn(project: string, collection: string, name = `agent-${Math.random().toString(36).slice(2, 6)}`) {
  const agent = agentStore.create({ name, tools: [base(collection)] });
  setHomeProject('agent', agent.id, project);
  return agent;
}
const tool = (agentId: string) => agentStore.get(agentId)!.tools.find((t) => t.type === 'knowledge')!;
const call = async (route: (request: Request, ctx: { params: Promise<{ id: string; toolId: string }> }) => Promise<Response>, method: string, agentId: string, init: { body?: BodyInit; json?: unknown } = {}) => {
  const headers: Record<string, string> = { cookie: `landflow_session=${session}`, ...(init.json !== undefined && { 'content-type': 'application/json' }) };
  const response = await route(new Request(`http://localhost:3000/api/agents/${agentId}/knowledge/kb1/x`, { method, headers, ...(init.body !== undefined && { body: init.body }), ...(init.json !== undefined && { body: JSON.stringify(init.json) }) }), { params: Promise.resolve({ id: agentId, toolId: 'kb1' }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const upload = (text = 'Refunds are paid within 14 days of the return.') => {
  const form = new FormData();
  form.append('file', new File([text], 'refunds.md', { type: 'text/markdown' }));
  return form;
};

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  session = auth.createSession(owner, 'password').token;
  alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(A, alice.id, 'admin');
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('an agent’s knowledge base and the collection’s owner', () => {
  it('the owner’s agent uploads (and claims), searches and lists; another project’s agent is refused everywhere (FR-5, AS-1)', async () => {
    const name = unique('hr-policies');
    const mine = agentIn(A, name);
    const theirs = agentIn(B, name);
    const uploaded = await call(documentsRoute.POST as never, 'POST', mine.id, { body: upload() });
    expect(uploaded.status).toBe(201);
    expect(access.collectionAccess(storeKeyOf('sqlite', name), A)).toBe('owner');

    // the tool: built for A and finds the passage; for B it is not built and the run's list says why
    const ok = buildTools(agentStore.get(mine.id)!, agentStore.get(mine.id)!);
    expect(ok.unavailable).toEqual([]);
    const found = await ok.tools[0]!.invoke({ query: 'refunds' }, {} as never);
    expect(JSON.stringify(found.output)).toContain('14 days');
    const refused = buildTools(agentStore.get(theirs.id)!, agentStore.get(theirs.id)!);
    expect(refused.tools).toEqual([]);
    expect(refused.unavailable.join()).toMatch(new RegExp(`project can.t use the collection “${name}”`));

    // the playground, the count, the uploads, the listing and the folder index
    const request = { source: { kind: 'kb' as const, agentId: theirs.id, toolId: 'kb1' }, query: 'refunds', mode: 'keyword' as const, limit: 5, threshold: 0 };
    await expect(runPlayground(owner, request)).rejects.toThrow(/can.t use the collection/);
    await expect(runPlayground(owner, { ...request, source: { kind: 'kb', agentId: mine.id, toolId: 'kb1' } })).resolves.toMatchObject({ results: [expect.anything()] });
    const counts = await withDocumentCounts(agentStore.get(theirs.id)!, agentConnections(agentStore.get(theirs.id)!));
    expect(counts.find((c) => c.kind === 'knowledge')?.documents).toBeUndefined();
    expect((await withDocumentCounts(agentStore.get(mine.id)!, agentConnections(agentStore.get(mine.id)!))).find((c) => c.kind === 'knowledge')?.documents).toBe(1);
    expect((await call(documentsRoute.POST as never, 'POST', theirs.id, { body: upload('Their text') })).status).toBe(403);
    expect((await call(documentsRoute.GET as never, 'GET', theirs.id)).status).toBe(403);
    const folder = await call(folderRoute.POST as never, 'POST', theirs.id, { json: { folder: 'runbooks' } });
    expect(folder.status).toBe(403);
    expect(folder.body.error).toMatch(/can.t use the collection/);
    expect((await call(documentsRoute.DELETE as never, 'DELETE', theirs.id)).status).toBeGreaterThanOrEqual(400); // no documentId: 400 before any delete
    // nothing of B's was written
    expect((await knowledge.listKnowledgeDocuments(tool(mine.id) as VectorKnowledgeBaseConfig, { asProject: A })).documents).toHaveLength(1);
  });

  it('a read grant opens search and listing, still refuses upload, folder index and delete; revoking closes it again (AS-2, AS-3)', async () => {
    const name = unique('shared-faq');
    const mine = agentIn(A, name);
    const theirs = agentIn(B, name);
    await call(documentsRoute.POST as never, 'POST', mine.id, { body: upload() });
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'read');
    const built = buildTools(agentStore.get(theirs.id)!, agentStore.get(theirs.id)!);
    expect(built.unavailable).toEqual([]);
    expect(JSON.stringify((await built.tools[0]!.invoke({ query: 'refunds' }, {} as never)).output)).toContain('14 days');
    expect((await call(documentsRoute.GET as never, 'GET', theirs.id)).status).toBe(200);
    expect((await call(documentsRoute.POST as never, 'POST', theirs.id, { body: upload('Not allowed') })).status).toBe(403);
    expect((await call(folderRoute.POST as never, 'POST', theirs.id, { json: { folder: 'runbooks' } })).status).toBe(403);
    const documentId = ((await call(documentsRoute.GET as never, 'GET', mine.id)).body.documents as Array<{ documentId: string }>)[0]!.documentId;
    const deleted = await documentsRoute.DELETE(new Request(`http://localhost:3000/x?documentId=${documentId}`, { method: 'DELETE', headers: { cookie: `landflow_session=${session}` } }), { params: Promise.resolve({ id: theirs.id, toolId: 'kb1' }) } as never);
    expect(deleted.status).toBe(403);
    // a tool built before the revoke refuses its next search
    access.revokeCollection(alice, storeKeyOf('sqlite', name), B);
    await expect(built.tools[0]!.invoke({ query: 'refunds' }, {} as never)).rejects.toThrow(/can.t use the collection/);
    expect(buildTools(agentStore.get(theirs.id)!, agentStore.get(theirs.id)!).tools).toEqual([]);
  });

  it('a write grant lets the other project’s agent index a folder', async () => {
    const name = unique('shared-runbooks');
    const mine = agentIn(A, name);
    const theirs = agentIn(B, name);
    await call(documentsRoute.POST as never, 'POST', mine.id, { body: upload() });
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'write');
    const indexed = await call(folderRoute.POST as never, 'POST', theirs.id, { json: { folder: 'runbooks' } });
    expect(indexed.status).toBe(200);
    expect(indexed.body.documents).toBe(1);
    access.revokeCollection(alice, storeKeyOf('sqlite', name), B);
  });

  it('a knowledge base on a collection nobody owns still works for everyone until it is written', async () => {
    const name = unique('open-docs');
    const theirs = agentIn(B, name);
    expect(buildTools(agentStore.get(theirs.id)!, agentStore.get(theirs.id)!).unavailable).toEqual([]);
    expect((await call(documentsRoute.POST as never, 'POST', theirs.id, { body: upload() })).status).toBe(201); // B writes first: B owns it
    expect(access.collectionAccess(storeKeyOf('sqlite', name), B)).toBe('owner');
  });
});

describe('project knowledge asks as its project', () => {
  it('saving a setting that names another project’s collection is a 400 with the message; naming the project’s own is fine', async () => {
    const name = unique('project-docs');
    await access.assertCanWrite(storeKeyOf('sqlite', name), 'sqlite', name, { projectId: A, subject: 'workflow' });
    const { id: _id, ...config } = base(name);
    expect(() => assertAgentSettingsPatch(B, { knowledge: { enabled: true, tool: config } } as never)).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/This project can.t use the collection/) }));
    expect(() => assertAgentSettingsPatch(A, { knowledge: { enabled: true, tool: config } } as never)).not.toThrow();
    // the tool project knowledge builds for B is refused too
    const built = knowledge.knowledgeTool(base(name), { asProject: B, subject: 'project' });
    expect('error' in built && built.error).toMatch(/This project can.t use the collection/);
  });
});

describe('the brain’s names stay closed to a saved configuration', () => {
  it.each(['landflow-brain-x', AGENT_MEMORY_COLLECTION, 'landflow-notion-x'])('%s: the tool is not built and uploads are refused', async (name) => {
    const built = knowledge.knowledgeTool(base(name), { asProject: A });
    expect('error' in built && built.error).toMatch(/second brain.s own collection/);
    await expect(knowledge.addKnowledgeDocument(base(name), { bytes: new TextEncoder().encode('x y z'), fileName: 'a.md' }, {}, { asProject: A })).rejects.toThrow(/second brain.s own collection/);
  });

  it('the runtime’s own Notion brain path (allowReserved) is unchanged', () => {
    const built = knowledge.knowledgeTool(base(`landflow-notion-${A}`), { allowReserved: true });
    expect('error' in built).toBe(false);
  });
});

describe('the architect’s listing (FR-5, AS-8)', () => {
  it('leaves out a collection the project can’t read, and shows a shared one with its level', async () => {
    const name = unique('listed-handbook');
    const mine = agentIn(A, name, 'Handbook agent');
    await call(documentsRoute.POST as never, 'POST', mine.id, { body: upload() });
    const names = async (project: string) => (await catalogKnowledge(owner, project)).bases.filter((b) => b.collection === name);
    expect(await names(B)).toEqual([]);
    expect((await names(A))[0]).toMatchObject({ collection: name, usedBy: ['Handbook agent'] });
    access.grantCollection(alice, storeKeyOf('sqlite', name), B, 'read');
    const shared = await names(B);
    expect(shared).toHaveLength(1);
    // the grant shows the level and never the owner project's agent names
    expect(shared[0]).toMatchObject({ collection: name, level: 'read', usedBy: [], documents: 1 });
    access.revokeCollection(alice, storeKeyOf('sqlite', name), B);
    expect(await names(B)).toEqual([]);
  });
});
