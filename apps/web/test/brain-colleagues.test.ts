/**
 * Brain colleagues (docs/work-and-briefings.md): team means "shares a non-personal project with the owner", org means
 * everyone, private means the owner alone; the briefing's related colleagues and why; repos as systems; a person page
 * linked to its user; Post as my update.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelatedColleague, WorkItem } from '@/lib/shared/brain-work';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-colleagues-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const entities = await import('@/lib/server/brain/entities');
const { recordWork, repoEntityId } = await import('@/lib/server/brain/work');
const { briefingFor } = await import('@/lib/server/brain/briefing');
const { rankRelated, RELATED_ITEMS, RELATED_PEOPLE } = await import('@/lib/server/brain/related');
const { listUsageEvents } = await import('@/lib/server/usage/query');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
const workItemRoute = await import('@/app/api/brain/work/[sourceId]/route');
const shareRoute = await import('@/app/api/brain/work/[sourceId]/share/route');

const owner = await createUser({ email: 'owner@col.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const admin = await createUser({ email: 'admin@col.test', name: 'Admin', role: 'admin', password: 'admin-password-1' });
const alice = await createUser({ email: 'alice@col.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@col.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const carol = await createUser({ email: 'carol@col.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
const team = createTeamProject({ name: 'Platform', createdBy: owner.id });
setMember(team.id, alice.id, 'editor');
setMember(team.id, bob.id, 'editor');
const actorOf = (user: { id: string; role: 'owner' | 'admin' | 'member' }) => ({ id: user.id, role: user.role });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const session = (sourceId: string, patch: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'claude-code', sourceId, occurredAt: at(1), title: `Work ${sourceId}`, ...patch });
const titlesFor = (user: { id: string }) => listUsageEvents({ kinds: ['work.session'] }, { scope: { viewerId: user.id } }).map((e) => e.message).sort();

beforeEach(() => {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', usage_events: 'at' } as const)) db.deleteBefore(table as 'usage_events', column, '9999');
});

const callPatch = (user: { id: string }, sourceId: string, visibility: string) => {
  enableTestAuth(user as never);
  return workItemRoute.PATCH(new Request(`http://col.test/api/brain/work/${sourceId}?source=claude-code`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility }) }), { params: Promise.resolve({ sourceId }) });
};
const callShare = (user: { id: string }, sourceId: string, body: unknown = {}) => {
  enableTestAuth(user as never);
  return shareRoute.POST(new Request(`http://col.test/api/brain/work/${sourceId}/share?source=claude-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ sourceId }) });
};

describe('who reads a work item', () => {
  it('team: a project mate yes, a stranger no; org: everyone; private: the owner alone, an admin included', () => {
    recordWork(actorOf(alice), [session('t', { visibility: 'team' }), session('o', { visibility: 'org' }), session('p')]);
    expect(titlesFor(alice)).toEqual(['Work o', 'Work p', 'Work t']);
    expect(titlesFor(bob)).toEqual(['Work o', 'Work t']);
    expect(titlesFor(carol)).toEqual(['Work o']);
    expect(titlesFor(admin)).toEqual(['Work o']);
    expect(titlesFor(owner)).not.toContain('Work p');
  });

  it('a personal project does not make a team: two people in no shared project see no team work', () => {
    recordWork(actorOf(carol), [session('c1', { visibility: 'team' })]);
    expect(titlesFor(alice)).toEqual([]);
  });

  it('system readers see org; team only for the teammate they write to; never private', () => {
    recordWork(actorOf(alice), [session('t', { visibility: 'team' }), session('o', { visibility: 'org' }), session('p')]);
    const read = (scope: object) => listUsageEvents({ kinds: ['work.session'] }, { scope }).map((e) => e.message).sort();
    expect(read({ system: true })).toEqual(['Work o']);
    expect(read({ system: true, teamOf: bob.id })).toEqual(['Work o', 'Work t']);
    expect(read({ system: true, teamOf: carol.id })).toEqual(['Work o']);
  });

  it('PATCH changes visibility; another user’s item is a 404; sending it again keeps the visibility', async () => {
    recordWork(actorOf(alice), [session('s1')]);
    expect((await callPatch(bob, 's1', 'org')).status).toBe(404);
    expect((await callPatch(alice, 's1', 'team')).status).toBe(200);
    expect(titlesFor(bob)).toEqual(['Work s1']);
    recordWork(actorOf(alice), [session('s1', { title: 'Work s1' })]);
    expect(titlesFor(bob)).toEqual(['Work s1']);
    expect((await callPatch(alice, 's1', 'private')).status).toBe(200);
    expect(titlesFor(bob)).toEqual([]);
    expect((await callPatch(alice, 's1', 'everyone')).status).toBe(400);
  });
});

describe('Post as my update', () => {
  it('creates one work.self_update that links the item, and posting again updates it', async () => {
    recordWork(actorOf(alice), [session('s1', { repo: 'acme/api', summary: 'Retries now back off' })]);
    const first = await callShare(alice, 's1');
    expect(first.status).toBe(200);
    const posted = (await first.json()) as { id: string; created: boolean; of: string; visibility: string };
    expect(posted).toMatchObject({ created: true, of: 'claude-code:s1', visibility: 'org' });
    await callShare(alice, 's1', { visibility: 'team' });
    const updates = database().all<{ id: string; owner_id: string; visibility: string; attrs: string }>("SELECT * FROM usage_events WHERE kind = 'work.self_update'");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: posted.id, owner_id: alice.id, visibility: 'team' });
    expect(JSON.parse(updates[0].attrs)).toMatchObject({ of: 'claude-code:s1', repo: 'acme/api' });
    // The original stays private; the update is what a teammate reads.
    expect(titlesFor(bob)).toEqual([]);
    expect(listUsageEvents({ kinds: ['work.self_update'] }, { scope: { viewerId: bob.id } })).toHaveLength(1);
    expect((await callShare(bob, 's1')).status).toBe(404);
  });
});

describe('related colleagues in the briefing', () => {
  it('lists a teammate’s shared item with the same repo and its reason; not a stranger’s private one', () => {
    recordWork(actorOf(bob), [session('b1', { repo: 'acme/api', title: 'Fixing the retry loop', areas: ['billing'] })]);
    recordWork(actorOf(alice), [session('a1', { repo: 'acme/api', title: 'Backoff for billing retries', visibility: 'team' })]);
    recordWork(actorOf(carol), [session('c1', { repo: 'acme/api', title: 'A private session in the same repo' })]);
    const { related } = briefingFor(actorOf(bob));
    expect(related).toHaveLength(1);
    expect(related[0].person).toEqual({ name: 'Alice', userId: alice.id });
    expect(related[0].because).toEqual({ type: 'repo', name: 'acme/api' });
    expect(related[0].items.map((i) => i.title)).toEqual(['Backoff for billing retries']);
    // Carol shares no project with Alice: a team item is not hers to read; Alice's own briefing lists nobody private.
    recordWork(actorOf(carol), [session('c2', { repo: 'acme/api', title: 'Carol’s second', visibility: 'org' })]);
    expect(briefingFor(actorOf(carol)).related.map((r) => r.person.name)).toEqual([]);
  });

  it('an org item relates to anyone; items older than two days do not', () => {
    recordWork(actorOf(carol), [session('c1', { repo: 'acme/web', title: 'Carol’s page' })]);
    recordWork(actorOf(alice), [session('a1', { repo: 'acme/web', title: 'Recent', visibility: 'org', occurredAt: at(5) }), session('a2', { repo: 'acme/web', title: 'Old', visibility: 'org', occurredAt: at(80) })]);
    const { related } = briefingFor(actorOf(carol));
    expect(related.map((r) => r.items.map((i) => i.title))).toEqual([['Recent']]);
  });
});

describe('ranking related work', () => {
  const item = (id: string, patch: Partial<WorkItem> = {}): WorkItem => ({ id, sourceId: id, source: 'claude-code', kind: 'work.session', title: id, at: `2026-11-14T0${id.length}:00:00.000Z`, visibility: 'org', ...patch });
  const person = (name: string) => ({ name, userId: name });
  const mine = [{ item: item('m', { repo: 'acme/api', areas: ['billing'], summary: 'tuning the retry backoff for billing' }), initiative: 'Q4 reliability', customer: 'Initech' }];

  it('picks the strongest reason per person, caps people and items, and says why', () => {
    const theirs = [
      { person: person('zed'), item: item('z1', { areas: ['billing'] }) },
      { person: person('ann'), item: item('a1', { repo: 'acme/api' }) },
      { person: person('ann'), item: item('a2', { areas: ['billing'] }) },
      { person: person('ann'), item: item('a3', { repo: 'acme/api' }) },
      { person: person('ann'), item: item('a4', { repo: 'acme/api' }) },
      { person: person('ann'), item: item('a5', { repo: 'ACME/api' }) },
      { person: person('ivy'), item: item('i1'), initiative: 'q4 reliability' },
      { person: person('cy'), item: item('c1'), customer: 'Initech' },
      { person: person('sam'), item: item('s1', { summary: 'backoff tuning for billing retry' }) },
      { person: person('nope'), item: item('n1', { repo: 'acme/other', summary: 'gardening' }) },
    ];
    const ranked = rankRelated(mine, theirs);
    expect(ranked.map((r: RelatedColleague) => [r.person.name, r.because.type])).toEqual([['ann', 'repo'], ['ivy', 'initiative'], ['cy', 'customer'], ['zed', 'area'], ['sam', 'similar']]);
    expect(ranked[0].items).toHaveLength(RELATED_ITEMS);
    expect(ranked).toHaveLength(RELATED_PEOPLE);
    expect(rankRelated([], theirs)).toEqual([]);
  });
});

describe('repos and people', () => {
  it('records one system entity per repository, however many events name it', () => {
    recordWork(actorOf(alice), [session('a', { repo: 'acme/api', visibility: 'team' }), session('b', { repo: 'acme/api', visibility: 'org' })]);
    recordWork(actorOf(bob), [session('c', { repo: 'acme/api', visibility: 'org' }), session('d', { repo: 'acme/web', visibility: 'org' })]);
    const systems = entities.listEntities({ type: 'system' });
    expect(systems.map((s) => s.attrs.repo).sort()).toEqual(['acme/api', 'acme/web']);
    expect(systems.map((s) => s.id)).toContain(repoEntityId('acme/api'));
  });

  it('a private event makes no repository entity; sharing it (PATCH or Post as my update) does', async () => {
    recordWork(actorOf(alice), [session('p1', { repo: 'acme/secret' }), session('p2', { repo: 'acme/other' })]);
    expect(entities.listEntities({ type: 'system' })).toEqual([]);
    expect((await callPatch(alice, 'p1', 'team')).status).toBe(200);
    expect(entities.listEntities({ type: 'system' }).map((s) => s.id)).toEqual([repoEntityId('acme/secret')]);
    expect((await callShare(alice, 'p2')).status).toBe(200);
    expect(entities.listEntities({ type: 'system' }).map((s) => s.id).sort()).toEqual([repoEntityId('acme/other'), repoEntityId('acme/secret')]);
  });

  it('links a person page to the user with the same email, and personForUser finds or stores the link', () => {
    const created = entities.upsertEntity({ type: 'person', id: 'alice-col', name: 'Alice', attrs: { email: 'Alice@col.test' } });
    expect(created.entity).toMatchObject({ userId: alice.id, userName: 'Alice' });
    expect(entities.personForUser(alice.id)?.id).toBe('alice-col');
    // A page made before the user: personForUser falls back to the email and stores the link.
    database().upsert('brain_entities', { type: 'person', id: 'bob-col', name: 'Bob', description: '', owner: '', project_id: null, user_id: null, attrs: JSON.stringify({ email: 'bob@col.test' }), source: 'api', created_at: at(1), updated_at: at(1) });
    expect(entities.personForUser(bob.id)).toMatchObject({ id: 'bob-col', userId: bob.id });
    expect(database().get<{ user_id: string }>("SELECT user_id FROM brain_entities WHERE id = 'bob-col'")?.user_id).toBe(bob.id);
    expect(entities.personForUser(carol.id)).toBeUndefined();
    // Updating the page keeps the link.
    expect(entities.upsertEntity({ type: 'person', id: 'bob-col', description: 'Platform' }).entity.userId).toBe(bob.id);
  });
});
