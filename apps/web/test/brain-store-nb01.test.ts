/**
 * The brain's storage seam (docs/features/notion-brain.md#how-it-is-built; NB01): the change feed every brain write goes
 * through (kind, key, project, origin, after the write, never for one that threw), the per-project store and its resolver,
 * and the Notion trust rules (a practice from Notion is tainted and project-level, a note from Notion is unverified).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import type { BrainChange } from '@/lib/shared/brain-store';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb01-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const store = await import('@/lib/server/brain/store');
const { changeOrigin } = await import('@/lib/server/brain/store/origin');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { withAuth } = await import('@/lib/server/auth/context');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const wiki = await import('@/lib/server/brain/wiki');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const practices = await import('@/lib/server/practices/store');
const approve = await import('@/lib/server/practices/approve');
const { noteStore } = await import('@/lib/server/notebook/store');
const notes = await import('@/lib/server/notebook/service');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');
const entitiesRoute = await import('@/app/api/entities/route');
const entityRoute = await import('@/app/api/entities/[type]/[id]/route');
const entityFactsRoute = await import('@/app/api/entities/[type]/[id]/facts/route');
const practicesRoute = await import('@/app/api/practices/route');

const owner = await createUser({ email: 'owner@nb01.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
const lead = agentStore.create({ name: 'Lead' });
const team = agentTeamStore.create({ name: 'NB01 team', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
setHomeProject('agentTeam', team.id, alpha.id);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let heard: BrainChange[] = [];
store.onBrainChange((c) => heard.push(c));
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Run `fn` and answer what the feed heard after it. */
async function changes<T>(fn: () => T | Promise<T>): Promise<BrainChange[]> {
  heard = [];
  await fn();
  await flush();
  return heard;
}
const asApiKey = <T>(fn: () => T) => withAuth({ principal: { user: TEST_OWNER, via: 'api-key' } }, fn);

async function call(handler: unknown, url: string, init: { method?: string; json?: unknown } = {}, params?: Record<string, string>) {
  const request = new Request(`http://localhost${url}`, { method: init.method ?? 'POST', ...(init.json !== undefined && { body: JSON.stringify(init.json), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeEach(() => {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', brain_facts: 'last_seen', brain_pages: 'generated_at', team_notes: 'created_at' } as const)) db.deleteBefore(table as 'brain_facts', column, '9999');
  heard = [];
});

const draftInput = (over: Record<string, unknown> = {}) => ({ handle: `team/rule-${Math.random().toString(36).slice(2, 6)}`, title: 'Charts live under deploy/helm', level: 'project' as const, projectId: alpha.id, strength: 'required' as const, topics: ['helm'], repos: [], paths: ['deploy/**'], summary: 'Charts live in deploy/helm', body: 'One chart per service.', ...over });

describe('the contracts', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('the copies equal contracts/nb', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const src = join(__dirname, '..', 'src', 'lib');
    expect(readFileSync(join(src, 'shared', 'brain-store.ts'), 'utf8')).toBe(readFileSync(join(dir, 'nb', 'brain-store.ts'), 'utf8'));
    expect(readFileSync(join(src, 'server', 'brain', 'store', 'port.ts'), 'utf8')).toBe(readFileSync(join(dir, 'nb', 'brain-store-port.ts'), 'utf8'));
  });
});

describe('who made a change', () => {
  it('is a person for a session or the test principal, landflow for an API key or no request, notion only when told', () => {
    expect(changeOrigin()).toEqual({ origin: 'landflow' });
    expect(withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () => changeOrigin())).toEqual({ origin: 'person', by: TEST_OWNER.id });
    expect(withAuth({ principal: { user: TEST_OWNER, via: 'session' } }, () => changeOrigin())).toEqual({ origin: 'person', by: TEST_OWNER.id });
    expect(asApiKey(() => changeOrigin())).toEqual({ origin: 'landflow' });
    expect(asApiKey(() => changeOrigin('notion', 'someone'))).toEqual({ origin: 'notion', by: 'someone' });
  });
});

describe('entities and facts', () => {
  it('emit one change per object through the routes (a person) and directly (landflow)', async () => {
    const created = await changes(() => call(entitiesRoute.POST, '/api/entities', { json: { type: 'initiative', id: 'onboarding', name: 'Onboarding', projectId: alpha.id } }));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'entity', key: 'initiative/onboarding', projectId: alpha.id, op: 'upsert', origin: 'person', by: TEST_OWNER.id });

    const added = await changes(() => call(entityFactsRoute.POST, '/x', { json: { kind: 'health', statement: 'Slipping' } }, { type: 'initiative', id: 'onboarding' }));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'fact', projectId: alpha.id, op: 'upsert', origin: 'person' });
    const factId = added[0].key;

    const direct = await changes(() => facts.upsertFact({ subjectType: 'workflow', subjectId: 'wf_1', kind: 'health', statement: 'ok', evidence: [], confidence: 0.5 }));
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ kind: 'fact', key: 'workflow:wf_1:health', op: 'upsert', origin: 'landflow' });
    expect(direct[0].projectId).toBeUndefined();

    const viaKey = await changes(() => asApiKey(() => entities.upsertEntity({ type: 'customer', id: 'acme', name: 'Acme', projectId: beta.id })));
    expect(viaKey[0]).toMatchObject({ origin: 'landflow', projectId: beta.id });

    const removed = await changes(() => call(entityRoute.DELETE, '/api/entities/initiative/onboarding', { method: 'DELETE' }, { type: 'initiative', id: 'onboarding' }));
    expect(removed.map((c) => `${c.kind}:${c.op}:${c.key}`)).toEqual(['entity:delete:initiative/onboarding', `fact:delete:${factId}`, 'summary:delete:initiative/onboarding']);
    expect(removed.every((c) => c.origin === 'person')).toBe(true);
  });

  it('staleFactsBefore emits one change per fact it staled, and deleteFact one delete', async () => {
    facts.upsertFact({ subjectType: 'workflow', subjectId: 'a', kind: 'health', statement: 'a', evidence: [], confidence: 0.5, projectId: alpha.id });
    facts.upsertFact({ subjectType: 'workflow', subjectId: 'b', kind: 'health', statement: 'b', evidence: [], confidence: 0.5 });
    await flush();
    const staled = await changes(() => facts.staleFactsBefore('9999'));
    expect(staled).toHaveLength(2);
    expect(staled.every((c) => c.kind === 'fact' && c.op === 'upsert' && c.origin === 'landflow')).toBe(true);
    expect(staled.find((c) => c.key === 'workflow:a:health')?.projectId).toBe(alpha.id);
    const gone = await changes(() => facts.deleteFact('workflow:a:health'));
    expect(gone).toMatchObject([{ kind: 'fact', op: 'delete', key: 'workflow:a:health', projectId: alpha.id }]);
    expect(await changes(() => facts.deleteFact('workflow:nope:health'))).toEqual([]);
  });

  it('a write that throws emits nothing', async () => {
    expect(await changes(() => expect(() => entities.upsertEntity({ type: 'bogus', name: 'x' })).toThrow())).toEqual([]);
    expect(await changes(() => expect(() => entities.deleteEntity('customer', 'ghost')).not.toThrow())).toEqual([]);
  });

  it('writeSummary emits a summary change', async () => {
    const acme = entities.upsertEntity({ type: 'customer', id: 'acme', name: 'Acme', projectId: alpha.id }).entity;
    const model: LanguageModel = { provider: 'fake', model: 'wiki', async generate() { return { text: JSON.stringify({ summary: 'Acme is a customer.' }), toolCalls: [], stopReason: 'end' }; } };
    const actor = { id: owner.id, role: 'owner' as const };
    await flush();
    const written = await changes(() => wiki.writeSummary(acme, scopeForActor(actor), actor, { model }));
    expect(written).toMatchObject([{ kind: 'summary', key: 'customer/acme', projectId: alpha.id, op: 'upsert', origin: 'landflow' }]);
  });
});

describe('practices', () => {
  const person = { source: 'person' as const, actor: { id: TEST_OWNER.id, role: 'owner' as const } };

  it('draft, approve, reject and retire each emit a practice change with the version', async () => {
    const drafted = await changes(() => withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () => practices.draftPractice(draftInput(), person)));
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ kind: 'practice', projectId: alpha.id, op: 'upsert', version: 1, origin: 'person' });
    const id = drafted[0].key;
    const actor = { id: TEST_OWNER.id, role: 'owner' as const };
    const approved = await changes(() => approve.approvePractice(actor, id, { version: 1, reviewedSources: true, conflicts: {} }));
    expect(approved).toMatchObject([{ kind: 'practice', key: id, version: 1, projectId: alpha.id }]);
    const second = await changes(() => practices.draftPractice(draftInput({ practiceId: id }), person));
    expect(second[0]).toMatchObject({ key: id, version: 2 });
    const rejected = await changes(() => approve.rejectVersion(actor, id, 2, 'no'));
    expect(rejected).toMatchObject([{ kind: 'practice', key: id, version: 2 }]);
    const retired = await changes(() => approve.retirePractice(actor, id));
    expect(retired).toMatchObject([{ kind: 'practice', key: id, op: 'upsert' }]);
  });

  it('an org practice has no project, and a draft that throws (handle taken) emits nothing', async () => {
    const input = draftInput({ level: 'org', projectId: undefined, handle: 'team/org-one' });
    const org = await changes(() => practices.draftPractice(input, person));
    expect(org).toHaveLength(1);
    expect(org[0].projectId).toBeUndefined();
    expect(await changes(() => expect(() => practices.draftPractice(input, person)).toThrow())).toEqual([]);
  });

  it('a draft from Notion is tainted with source notion at project level, and 403 at org level', async () => {
    const origin = { source: 'notion' as const };
    const drafted = await changes(() => practices.draftPractice(draftInput(), origin));
    expect(drafted).toMatchObject([{ kind: 'practice', origin: 'notion' }]);
    const { version, practice } = practices.draftPractice(draftInput(), origin);
    expect(version).toMatchObject({ source: 'notion', tainted: true });
    expect(() => practices.draftPractice(draftInput({ level: 'org', projectId: undefined, handle: 'team/org-two' }), origin)).toThrowError(/Sign in|only editors|403/i);
    try {
      practices.draftPractice(draftInput({ level: 'org', projectId: undefined, handle: 'team/org-three' }), origin);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(403);
    }
    const actor = { id: TEST_OWNER.id, role: 'owner' as const };
    try {
      approve.approvePractice(actor, practice.id, { version: version.version, conflicts: {} });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as { status?: number; code?: string }).status).toBe(409);
      expect((error as Error).name).toBe('PracticeNeedsReview');
    }
  });

  it('no route accepts notion as a source', async () => {
    const { status, body } = await call(practicesRoute.POST, '/api/practices', { json: { ...draftInput(), source: 'notion' } });
    expect(status).toBe(201);
    expect(body.version.source).not.toBe('notion');
  });
});

describe('notes', () => {
  const add = (over: Record<string, unknown> = {}) => notes.personAdd(team.id, 'Member', { kind: 'fact', text: `A fact ${Math.random()}`, ...over });

  it('a person add, verify, promote, remove and the expiry sweep each emit note changes', async () => {
    const added = await changes(() => add());
    expect(added).toMatchObject([{ kind: 'note', op: 'upsert', projectId: alpha.id, origin: 'landflow' }]);
    const id = added[0].key;
    expect(noteStore.get(id)!.status).toBe('verified');

    const run = await changes(() => noteStore.insert({ teamId: team.id, projectId: alpha.id, kind: 'fact', text: 'run note', author: 'm', scope: 'run' }));
    const verified = await changes(() => notes.verify(team.id, run[0].key, 'Member'));
    expect(verified).toMatchObject([{ kind: 'note', key: run[0].key, op: 'upsert' }]);
    const toTeam = await changes(() => notes.promote(noteStore.get(run[0].key)!, 'team', 'Member'));
    expect(toTeam).toHaveLength(1);
    const toProject = await changes(() => notes.promote(noteStore.get(run[0].key)!, 'project', 'Member'));
    expect(toProject.length).toBeGreaterThanOrEqual(1);
    expect(toProject.every((c) => c.kind === 'note' && c.key === run[0].key)).toBe(true);

    const removed = await changes(() => notes.remove(team.id, id));
    expect(removed).toMatchObject([{ kind: 'note', key: id, op: 'delete', projectId: alpha.id }]);

    const old = noteStore.insert({ teamId: team.id, projectId: alpha.id, kind: 'fact', text: 'old', author: 'm', scope: 'run' });
    database().upsert('team_notes', { ...database().get<Record<string, unknown>>('SELECT * FROM team_notes WHERE id = ?', old.id)!, expires_at: new Date(Date.now() - 1000).toISOString() });
    await flush();
    const swept = await changes(() => noteStore.expire());
    expect(swept).toMatchObject([{ kind: 'note', key: old.id, op: 'upsert' }]);
    const sweptLater = await changes(() => noteStore.expire(Date.now() + 40 * 86_400_000));
    expect(sweptLater.filter((c) => c.key === old.id)).toMatchObject([{ op: 'delete' }]);
  });

  it('deleteTeam emits a delete for each note', async () => {
    await add();
    await add();
    const gone = await changes(() => noteStore.deleteTeam(team.id));
    expect(gone.filter((c) => c.op === 'delete')).toHaveLength(2);
  });

  it('a note from Notion is unverified and tainted, and cannot be promoted without a Verify', async () => {
    const heardNote = await changes(() => notes.personAdd(team.id, 'Notion', { kind: 'fact', text: 'From a page', url: 'https://notion.so/p' }, 'notion'));
    expect(heardNote).toMatchObject([{ kind: 'note', origin: 'notion' }]);
    const note = noteStore.get(heardNote[0].key)!;
    expect(note).toMatchObject({ status: 'unverified', tainted: true, source: { tool: 'notion', url: 'https://notion.so/p' } });
    expect(() => notes.promote(note, 'team', 'Member')).toThrowError(/verifies it/);
  });
});

describe('the store and its resolver', () => {
  it('answers local for no project and for a project with no resolver', () => {
    expect(store.brainStoreFor(undefined).backend).toBe('local');
    expect(store.brainStoreFor('p1').backend).toBe('local');
  });

  it('a resolver that says notion gives that project a notion-reporting store whose writes land locally; others stay local', async () => {
    store.setBackendResolver((projectId) => (projectId === 'p1' ? { backend: 'notion' } : undefined));
    try {
      const linked = store.brainStoreFor('p1');
      expect(linked.backend).toBe('notion');
      expect(store.brainStoreFor('p2').backend).toBe('local');
      const written = await changes(() => linked.upsertEntity({ type: 'customer', id: 'zed', name: 'Zed', projectId: 'p1' }));
      expect(written).toMatchObject([{ kind: 'entity', projectId: 'p1' }]);
      expect(entities.getEntity('customer', 'zed')?.name).toBe('Zed');
      expect(linked.entity('customer', 'zed')?.name).toBe('Zed');
    } finally {
      store.setBackendResolver(undefined);
    }
  });

  it('a resolver that throws is local', () => {
    store.setBackendResolver(() => {
      throw new Error('no table');
    });
    try {
      expect(store.brainStoreFor('p1').backend).toBe('local');
    } finally {
      store.setBackendResolver(undefined);
    }
  });

  it('the local store passes the origin through', async () => {
    const written = await changes(() => store.brainStoreFor(undefined).upsertEntity({ type: 'customer', id: 'n1', name: 'N1' }, 'notion', 'editor'));
    expect(written).toMatchObject([{ origin: 'notion', by: 'editor' }]);
  });
});

describe('the change feed', () => {
  it('a listener that throws neither fails the write nor stops the next listener', async () => {
    const second: BrainChange[] = [];
    const offBad = store.onBrainChange(() => {
      throw new Error('boom');
    });
    const offNext = store.onBrainChange((c) => second.push(c));
    try {
      expect(() => entities.upsertEntity({ type: 'customer', id: 'ok', name: 'Ok' })).not.toThrow();
      await flush();
      expect(second).toHaveLength(1);
    } finally {
      offBad();
      offNext();
    }
  });

  it('stops hearing after unsubscribe', async () => {
    const mine: BrainChange[] = [];
    const stop = store.onBrainChange((c) => mine.push(c));
    stop();
    entities.upsertEntity({ type: 'customer', id: 'u', name: 'U' });
    await flush();
    expect(mine).toEqual([]);
  });
});
