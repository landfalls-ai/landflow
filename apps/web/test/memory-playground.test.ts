/**
 * The memory search playground (C11, docs/run-trace.md#memory-playground): the exports it needs, the service over a team
 * notebook, a project's facts and a knowledge base (no side effects, scores before and after rerank, the embedding model
 * down), access, the rate limit, and the component's rules.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiDocument, Reranker } from '@landflow/engine';
import type { PlaygroundAnswer } from '@/lib/shared/memory-playground';

vi.setConfig({ testTimeout: 20_000 });
// An embeddings model that answers when its base URL says `stub`, so a test can fail the store while the embedding succeeds.
vi.mock('@/lib/server/rag/embeddings', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/rag/embeddings')>();
  return { ...real, ollamaEmbeddings: ((options: { baseUrl: string }) => (options.baseUrl.includes('stub') ? { provider: 'ollama', model: 'stub', embedDocuments: async (t: string[]) => t.map(() => [0]), embedQuery: async () => [0] } : real.ollamaEmbeddings(options as never))) as typeof real.ollamaEmbeddings };
});

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-playground-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { noteStore } = await import('@/lib/server/notebook/store');
const { setNotebookEmbedder } = await import('@/lib/server/notebook/embed');
const { searchNotes } = await import('@/lib/server/notebook/search');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { knowledgeSearcher } = await import('@/lib/server/agents/knowledge');
const { insertDocuments, SqliteVectorStore } = await import('@/lib/server/rag/stores');
const facts = await import('@/lib/server/brain/facts');
const { runPlayground } = await import('@/lib/server/memory/playground');
const { playgroundSchema } = await import('@/lib/server/memory/playground-schema');
const route = await import('@/app/api/memory/search/route');
const { PlaygroundPanel, PlaygroundResults } = await import('@/components/memory/playground');

afterAll(() => {
  setNotebookEmbedder(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const post = (body: unknown) => new Request('http://localhost/api/memory/search', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const owner = { id: 'owner', role: 'owner' as const };
const base = { mode: 'hybrid' as const, limit: 10, threshold: 0 };

describe('T-5 what the playground reuses', () => {
  it('knowledgeSearcher gives the store, collection and search mode knowledgeTool uses', () => {
    const s = knowledgeSearcher({ id: 'k', type: 'knowledge', name: 'docs', description: '', store: 'sqlite', collection: ' runbooks ', embeddings: { provider: 'none', model: 'bm25' }, searchMode: 'hybrid' });
    expect(s.collection).toBe('runbooks');
    expect(s.options.searchMode).toBe('hybrid');
    expect(s.store.kind).toBe('sqlite');
    expect(s.embeddings.provider).toBe('none');
  });

  it('refuses a reserved collection', () => {
    expect(() => knowledgeSearcher({ id: 'k', type: 'knowledge', name: 'x', description: '', store: 'sqlite', collection: 'landflow-brain', embeddings: { provider: 'none', model: 'bm25' } })).toThrow(/second brain/);
  });
});

describe('T-6 a team notebook', () => {
  const lead = agentStore.create({ name: 'Lead' });
  const team = agentTeamStore.create({ name: 'Notebook', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
  const ids: string[] = [];
  beforeAll(() => {
    setNotebookEmbedder(async (texts) => texts.map((t) => [/freeze/i.test(t) ? 1 : 0, /icon/i.test(t) ? 1 : 0, 0.1]));
    for (let i = 0; i < 30; i++) {
      const text = i % 3 === 0 ? `Deploy freeze note ${i}` : i % 3 === 1 ? `Icon folder note ${i}` : `Plain note ${i}`;
      const note = noteStore.insert({ teamId: team.id, kind: 'fact', text, scope: 'team', author: 'Lead' });
      noteStore.setEmbedding(note.id, [/freeze/i.test(text) ? 1 : 0, /icon/i.test(text) ? 1 : 0, 0.1], 'custom');
      noteStore.patch(note.id, { last_access_at: '2026-01-01T00:00:00.000Z' });
      ids.push(note.id);
    }
  });

  it('answers in findNotes order and moves no note (AS-5)', async () => {
    const before = ids.map((id) => [noteStore.get(id)!.lastAccessAt, noteStore.get(id)!.expiresAt]);
    const answer = await runPlayground(owner, { ...base, source: { kind: 'notebook', teamId: team.id }, query: 'deploy freeze', mode: 'meaning', threshold: 0.42, limit: 5 });
    const same = await searchNotes('deploy freeze', { teamId: team.id }, 5, { touch: false, mode: 'meaning', threshold: 0.42 });
    expect(answer.results.map((r) => r.id)).toEqual(same.hits.map((h) => h.id));
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.via).toBe('meaning');
    expect(answer.timings.searchMs).toBeGreaterThanOrEqual(0);
    expect(ids.map((id) => [noteStore.get(id)!.lastAccessAt, noteStore.get(id)!.expiresAt])).toEqual(before);
  });

  it('counts what the threshold dropped (FR-7)', async () => {
    const answer = await runPlayground(owner, { ...base, source: { kind: 'notebook', teamId: team.id }, query: 'deploy note', mode: 'keyword', threshold: 0.8 });
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results.every((r) => r.score >= 0.8)).toBe(true);
    expect(answer.dropped.count).toBeGreaterThan(0);
    expect(answer.dropped.best).toBeLessThan(0.8);
  });

  it('says the embedding model is unreachable in meaning mode (AS-6)', async () => {
    setNotebookEmbedder(async () => {
      throw new Error('ECONNREFUSED');
    });
    const answer = await runPlayground(owner, { ...base, source: { kind: 'notebook', teamId: team.id }, query: 'deploy freeze', mode: 'meaning' });
    expect(answer).toMatchObject({ results: [], error: 'The embedding model is unreachable' });
    setNotebookEmbedder(async (texts) => texts.map(() => [0, 0, 0.1]));
  });

  it('reranks with a stub: both scores and the rerank time', async () => {
    const reverse: Reranker = { rerank: async (_q, docs: AiDocument[]) => [...docs].reverse().map((d, i) => ({ ...d, score: 0.9 - i * 0.1 })) };
    const answer = await runPlayground(owner, { ...base, source: { kind: 'notebook', teamId: team.id }, query: 'note', mode: 'keyword', limit: 3, rerank: { kind: 'llm', model: 'x' } }, { makeReranker: () => reverse });
    expect(answer.results).toHaveLength(3);
    expect(answer.results.every((r) => typeof r.rerankScore === 'number' && typeof r.score === 'number')).toBe(true);
    expect(answer.results[0].rerankScore).toBeCloseTo(0.9);
    expect(answer.timings.rerankMs).toBeGreaterThanOrEqual(0);
  });
});

describe('T-6 access, a project’s facts and a knowledge base', () => {
  let member: { id: string; role: 'member' };
  let pid: string;
  let agentId: string;
  let teamId: string;
  const COLLECTION = 'pg-runbooks';
  beforeAll(async () => {
    const u1 = await createUser({ email: 'e@pg.test', name: 'Editor', role: 'member', password: 'editor-password-1' });
    const u2 = await createUser({ email: 'o@pg.test', name: 'Outsider', role: 'member', password: 'outsider-password-1' });
    pid = createTeamProject({ name: 'PG', createdBy: u1.id }).id;
    setMember(pid, u1.id, 'editor');
    member = { id: u2.id, role: 'member' };
    editor = { id: u1.id, role: 'member' };
    for (const [i, text] of ['Deploy freeze on Fridays', 'Icons live in the assets folder', 'Alerts page the on-call'].entries())
      facts.upsertFact({ id: `project:${pid}:memory:pg${i}`, subjectType: 'project', subjectId: pid, kind: 'memory', statement: text, confidence: 1, evidence: [], projectId: pid } as never, database(), new Date().toISOString());
    const agent = agentStore.create({
      name: 'KB agent',
      tools: [
        { id: 'kb1', type: 'knowledge', name: 'search_runbooks', description: 'runbooks', store: 'sqlite', collection: COLLECTION, embeddings: { provider: 'none', model: 'bm25' } },
        { id: 'kb2', type: 'knowledge', source: 'node', name: 'n', description: '', nodeType: 'x.y', parameters: {} },
        { id: 'kb4', type: 'knowledge', name: 'search_stub', description: '', store: 'sqlite', collection: COLLECTION, embeddings: { provider: 'ollama', model: 'stub', baseUrl: 'http://stub.invalid' } },
        { id: 'kb3', type: 'knowledge', name: 'search_down', description: '', store: 'sqlite', collection: COLLECTION, embeddings: { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:1' } },
      ],
    } as never);
    agentId = agent.id;
    setHomeProject('agent', agentId, pid);
    teamId = agentTeamStore.create({ name: 'PG team', members: [{ id: 'm_lead', kind: 'agent', agentId, title: 'Lead' }] }).id;
    setHomeProject('agentTeam', teamId, pid);
    await insertDocuments(new SqliteVectorStore(), COLLECTION, ['Restart the worker with the runbook', 'Rotate the keys every quarter', 'Worker restarts need a freeze'].map((pageContent) => ({ pageContent, metadata: {}, embedding: [0] })));
  });
  let editor: { id: string; role: 'member' };

  it('searches a project’s facts with scores 0..1 for a member, and 404s an outsider', async () => {
    const answer = await runPlayground(editor, { ...base, source: { kind: 'facts', projectId: pid }, query: 'deploy freeze', mode: 'keyword' });
    expect(answer.results[0].text).toContain('Deploy freeze');
    expect(answer.results.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
    await expect(runPlayground(member, { ...base, source: { kind: 'facts', projectId: pid }, query: 'deploy', mode: 'keyword' })).rejects.toMatchObject({ status: 404 });
  });

  it('a member without a personal-project fallback: facts default to the caller’s own project, never the owner’s', async () => {
    const answer = await runPlayground(member, { ...base, source: { kind: 'facts' }, query: 'anything', mode: 'keyword' });
    expect(answer.results).toEqual([]);
  });

  it('keeps only facts the caller may read, and never an agent-user memory (blocker 4)', async () => {
    const agent = agentStore.create({ name: 'Private mem' });
    setHomeProject('agent', agent.id, pid);
    facts.upsertFact({ id: `agent-user:${agent.id}/someone:memory:p1`, subjectType: 'agent-user', subjectId: `${agent.id}/someone`, kind: 'memory', statement: 'Deploy freeze secret of someone', confidence: 1, evidence: [], projectId: pid } as never, database(), new Date().toISOString());
    const answer = await runPlayground(editor, { ...base, source: { kind: 'facts', projectId: pid }, query: 'deploy freeze', mode: 'keyword' });
    expect(answer.results.map((r) => r.text)).not.toContain('Deploy freeze secret of someone');
    expect(answer.results.length).toBeGreaterThan(0);
  });

  it('a Cohere credential must be usable by the searched source’s project (blocker 7)', async () => {
    const { credentials } = await import('@/lib/server/credentials/vault');
    const { registry } = await import('@/lib/server/plugins/registry');
    const { corePlugin } = await import('@/lib/server/nodes');
    registry.registerBuiltin(corePlugin);
    const second = createTeamProject({ name: 'Second', createdBy: editor.id }).id;
    setMember(second, editor.id, 'editor');
    const cred = credentials.create({ name: 'cohere second', type: 'core.cohereApi', data: { apiKey: 'k', baseUrl: 'http://127.0.0.1:1' } });
    setHomeProject('credential', cred.id, second);
    const rerank = { kind: 'cohere' as const, credentialId: cred.id };
    // The editor may read it, but the first project may not use it.
    await expect(runPlayground(editor, { ...base, source: { kind: 'facts', projectId: pid }, query: 'deploy', mode: 'keyword', rerank })).rejects.toMatchObject({ status: 404 });
    // Its own project passes the check (no facts there, so the reranker is never called).
    await expect(runPlayground(editor, { ...base, source: { kind: 'facts', projectId: second }, query: 'deploy', mode: 'keyword', rerank })).resolves.toMatchObject({ results: [] });
    expect(playgroundSchema.safeParse({ source: { kind: 'facts' }, query: '   ' }).success).toBe(false);
  });

  it('scores only the facts the caller may read: a hidden fact changes no count and takes no slot (re-review 1)', async () => {
    // A workflow's fact the editor may not see, scoring higher than the visible ones for this query.
    facts.upsertFact({ id: 'workflow:w_hidden_pg:health', subjectType: 'workflow', subjectId: 'w_hidden_pg', kind: 'health', statement: 'zebra quokka narwhal tapir', confidence: 1, evidence: [], projectId: pid } as never, database(), new Date().toISOString());
    facts.upsertFact({ id: `project:${pid}:memory:zq`, subjectType: 'project', subjectId: pid, kind: 'memory', statement: 'zebra visible note', confidence: 1, evidence: [], projectId: pid } as never, database(), new Date().toISOString());
    const dropped = await runPlayground(editor, { ...base, source: { kind: 'facts', projectId: pid }, query: 'zebra quokka narwhal', mode: 'keyword', threshold: 1 });
    expect(dropped.results).toEqual([]);
    // The visible fact has one of three words (0.33): dropped counts it, never the hidden one (which has all three).
    expect(dropped.dropped).toMatchObject({ count: 1 });
    expect(dropped.dropped.best).toBeLessThan(0.5);
    const one = await runPlayground(editor, { ...base, source: { kind: 'facts', projectId: pid }, query: 'zebra quokka', mode: 'keyword', limit: 1 });
    expect(one.results.map((r) => r.text)).toEqual(['zebra visible note']);
  });

  it('creates nothing when no project is named (re-review 5)', async () => {
    const { getProject } = await import('@/lib/server/projects/store');
    const { personalProjectId } = await import('@/lib/shared/projects');
    const solo = await createUser({ email: 'solo@pg.test', name: 'Solo', role: 'member', password: 'solo-password-1' });
    const before = getProject(personalProjectId(solo.id));
    await runPlayground({ id: solo.id, role: 'member' }, { ...base, source: { kind: 'facts' }, query: 'deploy', mode: 'keyword' });
    expect(getProject(personalProjectId(solo.id))).toEqual(before);
  });

  it('a knowledge base needs edit access to the agent (AS-7)', async () => {
    const req = { ...base, source: { kind: 'kb' as const, agentId, toolId: 'kb1' }, query: 'worker', mode: 'keyword' as const };
    await expect(runPlayground(member, req)).rejects.toMatchObject({ status: 404 });
    const answer = await runPlayground(editor, req);
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results[0].text).toMatch(/worker/i);
  });

  it('a plugin knowledge base is 400 and an unknown tool 404', async () => {
    await expect(runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'kb2' }, query: 'x', mode: 'keyword' })).rejects.toMatchObject({ status: 400 });
    await expect(runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'nope' }, query: 'x', mode: 'keyword' })).rejects.toMatchObject({ status: 404 });
  });

  it('a knowledge base with a stub reranker: both scores, rerank time, and no store write', async () => {
    const spies = (['add', 'clear', 'deleteWhere'] as const).map((m) => vi.spyOn(SqliteVectorStore.prototype, m));
    const reranker: Reranker = { rerank: async (_q, docs: AiDocument[]) => [...docs].reverse().map((d, i) => ({ ...d, score: 0.8 - i * 0.2 })) };
    const answer: PlaygroundAnswer = await runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'kb1' }, query: 'worker restarts freeze', mode: 'keyword', limit: 2, rerank: { kind: 'llm', model: 'x' } }, { makeReranker: () => reranker });
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results.every((r) => typeof r.rerankScore === 'number')).toBe(true);
    expect(answer.timings.rerankMs).toBeGreaterThanOrEqual(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('raises a store failure instead of saying the embedding model is unreachable (re-review 4)', async () => {
    const spy = vi.spyOn(SqliteVectorStore.prototype, 'similaritySearch').mockRejectedValue(new Error('the store broke'));
    await expect(runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'kb4' }, query: 'worker', mode: 'meaning' })).rejects.toThrow('the store broke');
    spy.mockRestore();
  });

  it('says the embedding model is unreachable for a knowledge base in meaning mode (AS-6)', async () => {
    const answer = await runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'kb3' }, query: 'worker', mode: 'meaning' });
    expect(answer).toMatchObject({ results: [], error: 'The embedding model is unreachable' });
    const hybrid = await runPlayground(editor, { ...base, source: { kind: 'kb', agentId, toolId: 'kb3' }, query: 'worker', mode: 'hybrid' });
    expect(hybrid.via).toBe('keywords');
  });
});

describe('T-6 the route', () => {
  let used = 0; // searches this window already took (a bad body counts too: the schema runs first, so it does not)
  it('refuses a query over 2,000 characters, and a bad body', async () => {
    expect(playgroundSchema.safeParse({ source: { kind: 'facts' }, query: 'x'.repeat(2001) }).success).toBe(false);
    const response = await route.POST(post({ source: { kind: 'facts' }, query: 'x'.repeat(2001) }));
    expect(response.status).toBe(400);
    expect((await route.POST(post({ source: { kind: 'nope' }, query: 'x' }))).status).toBe(400);
  });

  it('writes no audit row: a search is a read', async () => {
    const { auditSkipped, auditRequest } = await import('@/lib/server/audit/http');
    expect(auditSkipped('/api/memory/search')).toBe(true);
    const count = () => database().get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events')!.n;
    const projectId = createTeamProject({ name: 'Audit', createdBy: 'owner' }).id;
    const before = count();
    const request = post({ source: { kind: 'facts', projectId }, query: 'audit', mode: 'keyword' });
    expect((await auditRequest([request], () => route.POST(request))).status).toBe(200);
    expect(count()).toBe(before);
    used += 1;
  });

  it('answers 429 with Retry-After on the 21st request in a minute (FR-9)', async () => {
    let last: Response | undefined;
    const statuses: number[] = [];
    for (let i = 0; i < 21 - used; i++) {
      last = await route.POST(post({ source: { kind: 'facts' }, query: `q${i}`, mode: 'keyword' }));
      statuses.push(last.status);
    }
    expect(statuses.slice(0, -1).every((s) => s !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('writes no usage row at all', () => {
    const rows = database().get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_usage');
    expect(rows?.n ?? 0).toBe(0);
  });
});

describe('T-7 the component', () => {
  it('offers only the modes the source supports, and draws both scores and the dropped line', () => {
    const only = renderToStaticMarkup(createElement(PlaygroundPanel, { source: { kind: 'kb', agentId: 'a', toolId: 't' }, modes: ['keyword'] }));
    expect(only).toContain('Keywords only');
    expect(only).not.toContain('Meaning');
    const all = renderToStaticMarkup(createElement(PlaygroundPanel, { source: { kind: 'facts' } }));
    expect(all).toContain('Meaning');
    expect(all).toContain('Hybrid');
    const html = renderToStaticMarkup(
      createElement(PlaygroundResults, {
        answer: { results: [{ id: 'n1', text: 'a <b>bold</b> note', score: 0.61, rerankScore: 0.9, sourceId: 'n1' }], dropped: { count: 4, best: 0.28 }, via: 'meaning', timings: { searchMs: 12, embedMs: 8, rerankMs: 30 } },
      }),
    );
    expect(html).toContain('score 0.61');
    expect(html).toContain('after rerank 0.90');
    expect(html).toContain('4 dropped below the threshold (best 0.28)');
    expect(html).toContain('rerank 30 ms');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('imports no zod', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/memory/playground.tsx'), 'utf8');
    expect(source).not.toMatch(/from 'zod'/);
    expect(source).not.toMatch(/playground-schema/);
  });
});
