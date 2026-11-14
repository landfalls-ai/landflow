/**
 * Who reads a work event (docs/work-and-briefings.md#who-sees-it): a private one only its owner, through every reader and
 * for owners and admins too; shared (`org`) ones everyone; events with no owner keep project scoping; the daily rollups
 * and the readers that run for the instance leave private work out.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-visibility-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const entities = await import('@/lib/server/brain/entities');
const { scopeForActor, scopeForWorkflow } = await import('@/lib/server/brain/scope');
const { recordWork } = await import('@/lib/server/brain/work');
const { briefingFor } = await import('@/lib/server/brain/briefing');
const { findSimilar } = await import('@/lib/server/brain/similar');
const { study } = await import('@/lib/server/brain/study');
const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
const { recordUsage, upsertWorkEvent } = await import('@/lib/server/usage/ledger');
const { listUsageEvents, usageReport, rollupDays, ledgerSize } = await import('@/lib/server/usage/query');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const eventsRoute = await import('@/app/api/usage/events/route');
const usageRoute = await import('@/app/api/usage/route');
const pageRoute = await import('@/app/api/brain/wiki/[type]/[id]/route');
const wiki = await import('@/lib/server/brain/wiki');

const owner = await createUser({ email: 'owner@vis.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const admin = await createUser({ email: 'admin@vis.test', name: 'Admin', role: 'admin', password: 'admin-password-1' });
const alice = await createUser({ email: 'alice@vis.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@vis.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
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

const TITLE = 'Reworked the billing retry loop';
const at = new Date(Date.now() - 3_600_000).toISOString();
const sessionOf = (sourceId: string, patch: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'claude-code', sourceId, occurredAt: at, title: TITLE, ...patch });

function clear() {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', brain_facts: 'last_seen', proposals: 'created_at', usage_events: 'at', usage_daily: 'day' } as const)) db.deleteBefore(table as 'proposals', column, '9999');
}

function seed() {
  const w = store.saveWorkflow({ id: 'wf_vis', name: 'Ingest', active: false, nodes: [], connections: [], createdBy: owner.id } as unknown as Workflow);
  setHomeProject('workflow', w.id, team.id);
  entities.upsertEntity({ type: 'person', id: 'alice-vis.test', name: 'Alice', projectId: team.id, attrs: { email: 'alice@vis.test' } });
  // A's private work, and an event of a flow (no owner) that people with the workflow can read.
  expect(recordWork(actorOf(alice), [sessionOf('s1')]).saved).toHaveLength(1);
  recordUsage({ kind: 'work.discussion', workflowId: 'wf_vis', at, attrs: { source: 'slack', sourceId: 'slack-1', title: 'Flow-made event', actor: 'alice@vis.test' } });
  database().upsert('usage_kinds', { kind: 'work.discussion', description: '', fields: '[]', project_id: null, created_by: null, created_at: at, updated_at: at });
}

const call = async (handler: unknown, url: string, params?: Record<string, string>) => {
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(new Request(`http://vis.test${url}`), params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const readers = [
  ['an owner', owner],
  ['an admin', admin],
  ['another member', bob],
] as const;

beforeEach(() => {
  clear();
  seed();
  enableTestAuth(alice);
});

describe('a private work event', () => {
  it.each(readers)('is invisible to %s through GET /api/usage/events and GET /api/usage', async (_name, user) => {
    enableTestAuth(user);
    const events = await call(eventsRoute.GET, '/api/usage/events?kinds=work.session&limit=100');
    expect(events.body.events).toEqual([]);
    const report = await call(usageRoute.GET, '/api/usage?groupBy=kind&kinds=work.session');
    expect(report.body.rows).toEqual([]);
    expect(report.body.totals.count).toBe(0);
    // Not through a search of the whole ledger either.
    const all = await call(eventsRoute.GET, '/api/usage/events?limit=500');
    expect(JSON.stringify(all.body)).not.toContain(TITLE);
  });

  it('is visible to its owner, a member, through the same routes', async () => {
    const events = await call(eventsRoute.GET, '/api/usage/events?kinds=work.session&limit=100');
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({ kind: 'work.session', actorId: alice.id, message: TITLE });
    const report = await call(usageRoute.GET, '/api/usage?groupBy=kind&kinds=work.session');
    expect(report.body.rows.map((r: any) => [r.key, r.count])).toEqual([['work.session', 1]]);
  });

  it('is an owner’s own, even though owners see every workflow', async () => {
    enableTestAuth(owner);
    expect(recordWork(actorOf(owner), [sessionOf('o1', { title: 'Owner’s own session' })]).saved).toHaveLength(1);
    const events = await call(eventsRoute.GET, '/api/usage/events?kinds=work.session&limit=100');
    expect(events.body.events.map((e: any) => e.message)).toEqual(['Owner’s own session']);
    enableTestAuth(admin);
    expect((await call(eventsRoute.GET, '/api/usage/events?kinds=work.session&limit=100')).body.events).toEqual([]);
  });

  it.each(readers)('is not on the Brain page of its owner’s person page for %s', async (_name, user) => {
    enableTestAuth(user);
    const page = await call(pageRoute.GET, '/api/brain/wiki/person/alice-vis.test', { type: 'person', id: 'alice-vis.test' });
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).not.toContain(TITLE);
    // The flow's own event (no owner) is there for whoever can open the workflow.
    expect(JSON.stringify(page.body)).toContain('Flow-made event');
  });

  it('is on the person page for its owner', async () => {
    const page = await call(pageRoute.GET, '/api/brain/wiki/person/alice-vis.test', { type: 'person', id: 'alice-vis.test' });
    expect(JSON.stringify(page.body)).toContain(TITLE);
    const direct = wiki.wikiPage(entities.getEntity('person', 'alice-vis.test')!, scopeForActor(actorOf(alice)), actorOf(alice), false);
    expect(JSON.stringify(direct)).toContain(TITLE);
    const others = wiki.wikiPage(entities.getEntity('person', 'alice-vis.test')!, scopeForActor(actorOf(bob)), actorOf(bob), false);
    expect(JSON.stringify(others)).not.toContain(TITLE);
    // A reader with no scope and nobody signed in (a background job) reads shared work only.
    expect(JSON.stringify(wiki.wikiPage(entities.getEntity('person', 'alice-vis.test')!, undefined, actorOf(owner), false))).not.toContain(TITLE);
  });

  it('is not found by Find Similar for anyone', async () => {
    for (const user of [owner, admin, bob, alice]) {
      const found = await findSimilar(TITLE, { scope: scopeForActor(actorOf(user)) });
      expect(JSON.stringify(found)).not.toContain('billing retry');
    }
  });

  it('does not reach a stored summary, or make it stale', async () => {
    const person = entities.getEntity('person', 'alice-vis.test')!;
    const prompts: string[] = [];
    const model = {
      provider: 'fake',
      model: 'wiki',
      async generate(input: { messages: Array<{ content: unknown }> }) {
        prompts.push(String(input.messages[0].content));
        return { text: JSON.stringify({ summary: 'Alice keeps the flow going.' }), toolCalls: [], stopReason: 'end' as const };
      },
    };
    await wiki.writeSummary(person, scopeForActor(actorOf(alice)), actorOf(alice), { model: model as never });
    expect(prompts[0]).not.toContain('billing retry');
    expect(prompts[0]).toContain('Flow-made event');
    expect(JSON.stringify(database().all('SELECT * FROM brain_pages'))).not.toContain('billing retry');
    const staleOf = () => wiki.wikiPage(person, scopeForActor(actorOf(alice)), actorOf(alice), false).summary!.stale;
    expect(staleOf()).toBe(false);
    expect(recordWork(actorOf(alice), [sessionOf('s9', { title: 'Another private session' })]).saved).toHaveLength(1);
    expect(staleOf()).toBe(false);
    // The owner reads the same, and the Brain's health pass does not list it as stale.
    expect(wiki.wikiHome(scopeForActor(actorOf(alice)), actorOf(alice)).health.staleSummaries).toEqual([]);
  });

  it('leaves Find Similar for a flow an owner made reading everything it did before', async () => {
    store.saveWorkflow({ id: 'wf_owner_made', name: 'Billing retry sweeper', active: false, nodes: [], connections: [], createdBy: owner.id } as unknown as Workflow);
    const found = await findSimilar('Billing retry sweeper', { scope: scopeForWorkflow('wf_owner_made') });
    expect(JSON.stringify(found)).toContain('wf_owner_made');
  });

  it('is not in the MCP brain tools for anyone else', async () => {
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
    const report = async (user: typeof alice) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await instanceServer(actorOf(user)).connect(serverSide);
      const client = new Client({ name: 'visibility-test', version: '1.0.0' });
      await client.connect(clientSide);
      const result = (await client.callTool({ name: 'brain_usage_report', arguments: { groupBy: 'kind', days: 7 } })) as { content: Array<{ text: string }> };
      await client.close();
      return JSON.parse(result.content[0].text) as { rows: Array<{ key: string; count: number }> };
    };
    for (const user of [owner, admin, bob]) expect((await report(user)).rows.map((r) => r.key)).not.toContain('work.session');
    expect((await report(alice)).rows).toContainEqual(expect.objectContaining({ key: 'work.session', count: 1 }));
  });

  it('is in its owner’s briefing and nobody else’s', () => {
    const mine = briefingFor(actorOf(alice), { day: briefingDay() });
    expect(mine.today.concat(mine.yesterday).map((i) => i.title)).toEqual([TITLE]);
    for (const user of [owner, admin, bob]) {
      const theirs = briefingFor(actorOf(user), { day: briefingDay() });
      expect(theirs.today.concat(theirs.yesterday)).toEqual([]);
    }
  });

  it('is left out of the daily rollups and of a flow’s reads', () => {
    const day = at.slice(0, 10);
    rollupDays([day]);
    const rolled = database().all<{ kind: string }>("SELECT kind FROM usage_daily WHERE kind = 'work.session'");
    expect(rolled).toEqual([]);
    expect(database().all("SELECT 1 FROM usage_daily WHERE kind = 'work.discussion'")).toHaveLength(1);
    // A flow created by an owner reads what a person without scope would: the shared ledger, never private work.
    const flowScope = scopeForWorkflow('wf_vis');
    expect(listUsageEvents({ kinds: ['work.session'] }, { scope: flowScope })).toEqual([]);
    expect(usageReport({ kinds: ['work.session'] }, 'kind', { scope: flowScope }).totals.count).toBe(0);
  });

  it('does not change what the study and the detectors produce', async () => {
    const detect = () => JSON.stringify(Object.entries(DETECTOR_RUNS).map(([id, run]) => [id, run(detectContext())]));
    const facts = () => JSON.stringify(database().all('SELECT subject_type, subject_id, kind, data FROM brain_facts ORDER BY id')).replace(/\\"(?:firstSeen|lastSeen)\\":\\"[^"\\]*\\"/g, '');
    const strip = (r: Record<string, unknown>) => ({ ...r, durationMs: 0 });
    // Without the private event, and with it.
    database().delete('usage_events', { owner_id: alice.id });
    const withoutStudy = strip(await study({ embed: false }));
    const withoutFacts = facts();
    const withoutDetect = detect();
    recordWork(actorOf(alice), [sessionOf('s1')]);
    expect(database().all("SELECT 1 FROM usage_events WHERE owner_id IS NOT NULL")).toHaveLength(1);
    expect(strip(await study({ embed: false }))).toEqual(withoutStudy);
    expect(facts()).toBe(withoutFacts);
    expect(detect()).toBe(withoutDetect);
  });
});

describe('old private work', () => {
  it('does not make the detectors think the ledger reaches back further than it does', () => {
    const detect = () => JSON.stringify(Object.entries(DETECTOR_RUNS).map(([id, run]) => [id, run(detectContext())]));
    database().delete('usage_events', { owner_id: alice.id });
    const before = detect();
    upsertWorkEvent(alice.id, { kind: 'work.session', source: 'claude-code', sourceId: 'old', occurredAt: new Date(Date.now() - 70 * 86_400_000).toISOString(), title: 'An old session' });
    expect(detect()).toBe(before);
    expect(Date.parse(ledgerSize().oldest ?? at)).toBeGreaterThan(Date.now() - 60 * 86_400_000);
  });
});

describe('shared and unowned events', () => {
  it('an org event is read by everyone; a team event stays private for now; an unowned one keeps project scoping', async () => {
    upsertWorkEvent(alice.id, { kind: 'work.session', source: 'claude-code', sourceId: 'shared', occurredAt: at, title: 'Shared with everyone', visibility: 'org' });
    upsertWorkEvent(alice.id, { kind: 'work.session', source: 'claude-code', sourceId: 'team', occurredAt: at, title: 'Team only', visibility: 'team' });
    for (const user of [owner, admin, bob]) {
      enableTestAuth(user);
      const titles = (await call(eventsRoute.GET, '/api/usage/events?kinds=work.session&limit=100')).body.events.map((e: any) => e.message);
      expect(titles).toEqual(['Shared with everyone']);
    }
    // Unowned: a member outside the workflow's project doesn't see it; one inside, and an owner, do.
    const carol = await createUser({ email: 'carol@vis.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
    enableTestAuth(carol);
    expect((await call(eventsRoute.GET, '/api/usage/events?kinds=work.discussion&limit=100')).body.events).toEqual([]);
    for (const user of [bob, owner]) {
      enableTestAuth(user);
      expect((await call(eventsRoute.GET, '/api/usage/events?kinds=work.discussion&limit=100')).body.events).toHaveLength(1);
    }
  });
});

/** Today in the instance time zone, as the briefing counts it. */
function briefingDay(): string {
  return briefingFor(actorOf(owner)).day;
}
