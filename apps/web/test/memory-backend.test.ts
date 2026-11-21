/**
 * C07: the memory backend (docs/second-brain.md#memory-backend). Written test first, one `describe` per task.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const spans = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-memory-backend-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { containerKey, parseContainer } = await import('@/lib/shared/memory');
const { isBrainCollection, AGENT_MEMORY_COLLECTION } = await import('@/lib/shared/brain');
const { noteStore } = await import('@/lib/server/notebook/store');
const { setNotebookEmbedder } = await import('@/lib/server/notebook/embed');
const { searchNotes } = await import('@/lib/server/notebook/search');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const facts = await import('@/lib/server/brain/facts');
const lifecycle = await import('@/lib/server/brain/fact-lifecycle');
const { memory } = await import('@/lib/server/memory');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('T-1 types and the migration', () => {
  it('round-trips a container through its key', () => {
    expect(containerKey({ kind: 'project', id: 'p1' })).toBe('project:p1');
    expect(parseContainer('project:p1')).toEqual({ kind: 'project', id: 'p1' });
    expect(parseContainer('team:t1')).toEqual({ kind: 'team', id: 't1' });
    const agent = parseContainer('agent:a1', 'u1');
    expect(agent).toEqual({ kind: 'agent', id: 'a1', userId: 'u1' });
    expect(containerKey(agent!)).toBe('agent:a1');
  });

  it('refuses an agent container without a user, and anything unknown', () => {
    expect(parseContainer('agent:a1')).toBeUndefined();
    expect(parseContainer('workflow:w1')).toBeUndefined();
    expect(parseContainer('project:')).toBeUndefined();
    expect(parseContainer('nonsense')).toBeUndefined();
  });

  it('reserves the agent memory collection for the brain', () => {
    expect(AGENT_MEMORY_COLLECTION).toBe('landflow-agent-memory');
    expect(isBrainCollection('landflow-agent-memory')).toBe(true);
    expect(isBrainCollection('my-docs')).toBe(false);
  });

  it('indexes brain facts by project', () => {
    const indexes = database().all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'brain_facts'`);
    expect(indexes.map((i) => i.name)).toContain('brain_facts_project');
  });
});

describe('T-5 notebook search without side effects', () => {
  let embedCalls = 0;
  const T = 'team_t5';
  beforeAll(() => {
    setNotebookEmbedder(async (texts) => {
      embedCalls++;
      return texts.map((t) => [/deploy/i.test(t) ? 1 : 0, /alert/i.test(t) ? 1 : 0]);
    });
  });
  afterAll(() => setNotebookEmbedder(undefined));

  const mk = async (text: string) => {
    const note = noteStore.insert({ teamId: T, kind: 'fact', text, scope: 'team', author: 'Lead' });
    noteStore.setEmbedding(note.id, [/deploy/i.test(text) ? 1 : 0, /alert/i.test(text) ? 1 : 0], 'custom');
    // an old access time, so a touch is visible
    noteStore.patch(note.id, { last_access_at: '2026-01-01T00:00:00.000Z' });
    return note.id;
  };

  it('leaves last_access_at and expires_at alone with touch false, and moves them by default', async () => {
    const id = await mk('Deploys go out on Tuesday');
    const before = noteStore.get(id)!;
    const quiet = await searchNotes('deploy', { teamId: T }, 5, { touch: false });
    expect(quiet.hits.map((h) => h.id)).toEqual([id]);
    const after = noteStore.get(id)!;
    expect([after.lastAccessAt, after.expiresAt]).toEqual([before.lastAccessAt, before.expiresAt]);
    await searchNotes('deploy', { teamId: T }, 5);
    expect(noteStore.get(id)!.lastAccessAt).not.toBe(before.lastAccessAt);
  });

  it('keyword mode makes no embedding call', async () => {
    embedCalls = 0;
    const found = await searchNotes('deploys', { teamId: T }, 5, { touch: false, mode: 'keyword' });
    expect(embedCalls).toBe(0);
    expect(found.via).toBe('keywords');
    expect(found.hits.length).toBeGreaterThan(0);
  });

  it('drops hits under the threshold and reports them', async () => {
    await mk('Alerts page the on-call deploys owner');
    const found = await searchNotes('deploys tuesday', { teamId: T }, 5, { touch: false, mode: 'keyword', threshold: 0.9 });
    expect(found.hits.map((h) => h.text)).toEqual(['Deploys go out on Tuesday']);
    expect(found.dropped.count).toBe(1);
    expect(found.dropped.best).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-6: the backend, access and the built-in store
// ---------------------------------------------------------------------------

describe('T-6 built-in backend', () => {
  type Caller = import('@/lib/server/memory').MemoryCaller;
  let a = '';
  let b = '';
  let ua: Caller;
  let ub: Caller;
  let viewerA: Caller;
  let teamId = '';
  let agentId = '';
  const asUser = (u: { id: string }, role: 'member' = 'member'): Caller => ({ actor: { id: u.id, role }, origin: 'person', userId: u.id });
  const spanAttrs = () => spans.getFinishedSpans();

  beforeAll(async () => {
    const mk = async (n: string) => createUser({ email: `${n}@mem.test`, name: n, role: 'member', password: `${n}-password-1` });
    const [u1, u2, u3] = [await mk('ua'), await mk('ub'), await mk('va')];
    a = createTeamProject({ name: 'A', createdBy: u1.id }).id;
    b = createTeamProject({ name: 'B', createdBy: u2.id }).id;
    setMember(a, u1.id, 'editor');
    setMember(a, u3.id, 'viewer');
    setMember(b, u2.id, 'editor');
    ua = asUser(u1);
    ub = asUser(u2);
    viewerA = asUser(u3);
    const now = new Date().toISOString();
    for (const [i, text] of ['Deploys go out on Tuesday', 'The team prefers concise reports', 'Budget owner is Dana'].entries())
      facts.upsertFact({ id: `project:${a}:memory:seed${i}`, subjectType: 'project', subjectId: a, kind: 'memory', statement: text, confidence: 1, evidence: [], projectId: a } as never, database(), now);
    facts.upsertFact({ id: `project:${a}:memory:gone`, subjectType: 'project', subjectId: a, kind: 'memory', statement: 'An old wrong fact', confidence: 1, evidence: [], projectId: a } as never, database(), now);
    await lifecycle.forgetFact(`project:${a}:memory:gone`, { reason: 'wrong' }, { userId: u1.id }, database());
    const agent = agentStore.create({ name: 'Mem' });
    agentId = agent.id;
    setHomeProject('agent', agentId, a);
    const team = agentTeamStore.create({ name: 'Mem team', members: [{ id: 'm_lead', kind: 'agent', agentId, title: 'Lead' }] });
    teamId = team.id;
    setHomeProject('agentTeam', teamId, a);
  });

  it('search with an empty query returns the latest live facts, not the forgotten one (AS-1)', async () => {
    const found = await memory.search({ kind: 'project', id: a }, '', {}, ua);
    expect(found.items.map((i) => i.text).sort()).toEqual(['Budget owner is Dana', 'Deploys go out on Tuesday', 'The team prefers concise reports']);
    expect(found.items.every((i) => i.source === 'fact' && i.kind === 'memory')).toBe(true);
  });

  it('search ranks by words with a score in 0..1', async () => {
    const found = await memory.search({ kind: 'project', id: a }, 'deploys tuesday', { mode: 'keyword' }, ua);
    expect(found.items[0]).toMatchObject({ text: 'Deploys go out on Tuesday' });
    expect(found.items[0].score).toBeGreaterThan(0.5);
  });

  it('answers not found to a member of another project, and the span records the denial (AS-2)', async () => {
    spans.reset();
    await expect(memory.search({ kind: 'project', id: a }, 'deploys', {}, ub)).rejects.toMatchObject({ name: 'MemoryNotFoundError', status: 404 });
    const span = spanAttrs().find((s) => s.name === 'memory.search')!;
    expect(span.attributes['landflow.memory.denied']).toBe(true);
    expect(span.attributes['landflow.memory.container']).toBe('project');
  });

  it('refuses a study kind on add (AS-4) and a viewer’s write', async () => {
    await expect(memory.add({ kind: 'project', id: a }, { text: 'x', kind: 'health' }, ua)).rejects.toMatchObject({ name: 'MemoryWriteRefusedError', status: 400, message: 'the study writes health facts' });
    await expect(memory.add({ kind: 'project', id: a }, { text: 'x' }, viewerA)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    await expect(memory.add({ kind: 'project', id: a }, { text: '   ' }, ua)).rejects.toMatchObject({ status: 400 });
  });

  it('adds a version-1 memory fact about the project, audited without its text', async () => {
    const item = await memory.add({ kind: 'project', id: a }, { text: 'Release notes go to #launch', static: false }, ua);
    expect(item).toMatchObject({ kind: 'memory', version: 1, source: 'fact', text: 'Release notes go to #launch' });
    const fact = facts.getFact(item.id, database())!;
    expect(fact).toMatchObject({ subjectType: 'project', subjectId: a, kind: 'memory', projectId: a });
    const rows = database().all<{ action: string; details: string }>("SELECT action, details FROM audit_events WHERE action = 'brain.memory_added'");
    expect(rows).toHaveLength(1);
    expect(rows[0].details).not.toContain('Release notes');
    expect(JSON.parse(rows[0].details)).toMatchObject({ container: 'project' });
  });

  it('replaces: a new version through supersedeFact, and a stale replaces is 409', async () => {
    const first = await memory.add({ kind: 'project', id: a }, { text: 'Standup is at 9' }, ua);
    const second = await memory.add({ kind: 'project', id: a }, { text: 'Standup is at 10', replaces: first.id }, ua);
    expect(second).toMatchObject({ id: first.id, version: 2, text: 'Standup is at 10' });
    // `<id>#v1` says "I read version 1": it is no longer the latest
    await expect(memory.add({ kind: 'project', id: a }, { text: 'Standup is at 11', replaces: `${first.id}#v1` }, ua)).rejects.toMatchObject({ name: 'StaleChainError', status: 409 });
    await expect(memory.add({ kind: 'project', id: a }, { text: 'y', replaces: 'project:nope:memory:x' }, ua)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
  });

  it('forget hides it from search and needs an editor', async () => {
    const item = await memory.add({ kind: 'project', id: a }, { text: 'Temp fact about pineapples' }, ua);
    await expect(memory.forget({ kind: 'project', id: a }, item.id, 'oops', viewerA)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    await memory.forget({ kind: 'project', id: a }, item.id, 'oops', ua);
    const found = await memory.search({ kind: 'project', id: a }, 'pineapples', { mode: 'keyword' }, ua);
    expect(found.items).toEqual([]);
    await expect(memory.forget({ kind: 'project', id: b }, item.id, 'x', ub)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
  });

  it('team container: finds notes without touching them, and add outside a run is 400 (D9)', async () => {
    const note = noteStore.insert({ teamId, projectId: a, kind: 'fact', text: 'The staging cluster resets nightly', scope: 'team', author: 'Lead' });
    noteStore.patch(note.id, { last_access_at: '2026-01-01T00:00:00.000Z' });
    const before = noteStore.get(note.id)!;
    const found = await memory.search({ kind: 'team', id: teamId }, 'staging cluster', { mode: 'keyword' }, ua);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ id: note.id, source: 'note' });
    expect(noteStore.get(note.id)!.lastAccessAt).toBe(before.lastAccessAt);
    await expect(memory.add({ kind: 'team', id: teamId }, { text: 'a note' }, ua)).rejects.toMatchObject({ status: 400, message: 'notes are written by a team run' });
    await expect(memory.search({ kind: 'team', id: teamId }, 'staging', {}, ub)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
  });

  it('agent container: a person reads their own, another user gets not found', async () => {
    const mine = { kind: 'agent' as const, id: agentId, userId: ua.userId! };
    const item = await memory.add(mine, { text: 'Calls me Jo' }, { ...ua, run: { agentId } });
    expect(item).toMatchObject({ source: 'agent-memory' });
    const found = await memory.list(mine, {}, ua);
    expect(found.items.map((i) => i.text)).toEqual(['Calls me Jo']);
    await expect(memory.list({ kind: 'agent', id: agentId, userId: ua.userId! }, {}, ub)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    // and it never reaches a project search
    const project = await memory.search({ kind: 'project', id: a }, 'Jo', { mode: 'keyword' }, ua);
    expect(project.items).toEqual([]);
  });

  it('profile: static items first, then the 10 newest', async () => {
    await memory.add({ kind: 'project', id: a }, { text: 'Company policy: never deploy on Friday', static: true }, ua);
    const profile = await memory.profile({ kind: 'project', id: a }, ua);
    expect(profile.static.map((i) => i.text)).toEqual(['Company policy: never deploy on Friday']);
    expect(profile.recent.length).toBeLessThanOrEqual(10);
    expect(profile.recent.every((i) => !i.static)).toBe(true);
  });

  it('list pages with nextCursor', async () => {
    const first = await memory.list({ kind: 'project', id: a }, { limit: 2 }, ua);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await memory.list({ kind: 'project', id: a }, { limit: 2, cursor: first.nextCursor }, ua);
    expect(second.items.map((i) => i.id)).not.toContain(first.items[0].id);
  });

  it('no span attribute holds item text', async () => {
    const texts = ['Deploys go out on Tuesday', 'Release notes go to #launch', 'Calls me Jo', 'Standup is at 10'];
    for (const span of spanAttrs()) for (const value of Object.values(span.attributes)) for (const t of texts) expect(String(value)).not.toContain(t);
    expect(spanAttrs().some((s) => s.name === 'memory.add')).toBe(true);
  });
});
