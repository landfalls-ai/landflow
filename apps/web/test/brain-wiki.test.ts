/**
 * The Brain page (docs/second-brain.md#the-brain-page): work events tied to the pages they name, the home (shared work
 * across teams, teams, health), a page (work, people, related, mentions, the summary and when it is out of date), Ask
 * (with and without a model, from a page), the walls around other projects, and the routes. A fake model; no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-wiki-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const entities = await import('@/lib/server/brain/entities');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const { saveKind } = await import('@/lib/server/usage/kinds');
const { recordUsage } = await import('@/lib/server/usage/ledger');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const wiki = await import('@/lib/server/brain/wiki');
const { hintId, wikiLinks } = await import('@/lib/shared/brain-wiki');
const homeRoute = await import('@/app/api/brain/wiki/route');
const pageRoute = await import('@/app/api/brain/wiki/[type]/[id]/route');
const summaryRoute = await import('@/app/api/brain/wiki/[type]/[id]/summary/route');
const askRoute = await import('@/app/api/brain/ask/route');

const owner = await createUser({ email: 'owner@wiki.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@wiki.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
setMember(alpha.id, alice.id, 'editor');
const aliceActor = { id: alice.id, role: 'member' as const };

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const FIELDS = ['source', 'sourceId', 'url', 'actor', 'title', 'summary', 'team', 'initiative', 'customer', 'occurredAt'].map((name) => ({ name, type: 'string' as const, required: false }));
for (const kind of ['work.discussion', 'work.doc_edited', 'work.bug_reported']) saveKind({ kind, fields: FIELDS });

function flow(id: string, project: string) {
  const w = store.saveWorkflow({ id, name: `Ingest ${id}`, active: false, nodes: [], connections: [], createdBy: owner.id } as unknown as Workflow);
  setHomeProject('workflow', w.id, project);
  return w;
}

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function work(workflowId: string, kind: string, attrs: Record<string, string>, hoursAgo = 1) {
  return recordUsage({ kind: kind as 'work.discussion', workflowId, at: ago(hoursAgo), attrs: { source: 'slack', sourceId: `${kind}:${Math.random()}`, occurredAt: ago(hoursAgo), ...attrs } })!;
}

function clear() {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', brain_facts: 'last_seen', proposals: 'created_at', usage_events: 'at', brain_pages: 'generated_at' } as const)) db.deleteBefore(table as 'proposals', column, '9999');
}

/**
 * Alpha: Acme (customer), Atlas (initiative), Dana (R&D) and Lee (Sales) from the Directory; work in Slack from Sales
 * and in Linear from R&D, both about Acme. Beta: Globex and its work, which Alice can't open.
 */
function seed() {
  flow('wf_alpha', alpha.id);
  flow('wf_beta', beta.id);
  const make = (input: Parameters<typeof entities.upsertEntity>[0]) => entities.upsertEntity(input).entity;
  make({ type: 'customer', id: 'acme', name: 'Acme', projectId: alpha.id, owner: 'Lee' });
  make({ type: 'initiative', id: 'atlas', name: 'Atlas', description: 'The new ingest service, first for Acme', projectId: alpha.id });
  make({ type: 'person', id: 'dana-example.com', name: 'Dana Levi', projectId: alpha.id, attrs: { email: 'dana@example.com', department: 'R&D' } });
  make({ type: 'person', id: 'lee-example.com', name: 'Lee Cohen', projectId: alpha.id, attrs: { email: 'lee@example.com', department: 'Sales' } });
  make({ type: 'customer', id: 'globex', name: 'Globex', projectId: beta.id });
  work('wf_alpha', 'work.discussion', { title: '#customer-acme: renewal pricing', actor: 'lee@example.com', customer: 'acme' }, 2);
  work('wf_alpha', 'work.bug_reported', { title: 'ENG-42: Acme export times out', actor: 'Dana@Example.com', customer: 'Acme', initiative: 'Atlas', team: 'Engineering' }, 1);
  work('wf_alpha', 'work.doc_edited', { title: 'Atlas design notes', actor: 'dana@example.com', initiative: 'Atlas' }, 40 * 24);
  work('wf_beta', 'work.discussion', { title: 'Globex kickoff', actor: 'kim@example.com', customer: 'globex', team: 'CS' }, 3);
}

function fakeModel(reply: (prompt: string) => Record<string, unknown>): LanguageModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    provider: 'fake',
    model: 'wiki',
    prompts,
    async generate(input) {
      const prompt = String(input.messages[0].content);
      prompts.push(prompt);
      return { text: JSON.stringify(reply(prompt)), toolCalls: [], stopReason: 'end' };
    },
  };
}

beforeEach(() => {
  clear();
  seed();
});

describe('work items', () => {
  it('name their pages by the ids the work templates make, and take a team from the person when they have none', () => {
    expect(hintId('#customer-Acme Inc.')).toBe('customer-acme-inc.');
    expect(hintId('Acme')).toBe('acme');
    const index = wiki.pageIndex(entities.listEntities());
    const items = wiki.workEvents(60, undefined).map((e) => wiki.workItem(e, index));
    const bug = items.find((i) => i.kind === 'work.bug_reported')!;
    expect(bug.refs.sort()).toEqual(['customer/acme', 'initiative/atlas', 'person/dana-example.com']);
    expect(bug.team).toBe('Engineering');
    expect(bug.actor).toBe('dana@example.com');
    const slack = items.find((i) => i.title?.startsWith('#customer-acme'))!;
    expect(slack.refs.sort()).toEqual(['customer/acme', 'person/lee-example.com']);
    expect(slack.team).toBe('Sales');
  });

  it('are only the work.* kinds, newest first', () => {
    recordUsage({ kind: 'run.failed', workflowId: 'wf_alpha', attrs: {} });
    const events = wiki.workEvents(60, undefined);
    expect(events.every((e) => e.kind.startsWith('work.'))).toBe(true);
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort().reverse());
  });
});

describe('the home', () => {
  it('shows a customer two teams worked on this week as shared work, with who on each team', () => {
    const home = wiki.wikiHome(undefined, undefined);
    expect(home.days).toBe(7);
    const acme = home.shared.find((s) => s.ref === 'customer/acme')!;
    expect(acme.teams.map((t) => t.team).sort()).toEqual(['Engineering', 'Sales']);
    expect(acme.teams.find((t) => t.team === 'Sales')!.people).toEqual(['Lee Cohen']);
    expect(acme.latest[0].title).toContain('ENG-42');
    // Atlas this week is one team only: not shared.
    expect(home.shared.some((s) => s.ref === 'initiative/atlas')).toBe(false);
  });

  it('counts each page’s work in 7 and 30 days, and lists teams, kinds and the latest work', () => {
    const home = wiki.wikiHome(undefined, undefined);
    const entry = (ref: string) => home.entries.find((e) => `${e.type}/${e.id}` === ref)!;
    expect(entry('customer/acme')).toMatchObject({ week: 2, month: 2, teams: ['Engineering', 'Sales'], owner: 'Lee' });
    expect(entry('initiative/atlas')).toMatchObject({ week: 1, month: 1 });
    expect(home.teams.map((t) => t.team)).toEqual(expect.arrayContaining(['Engineering', 'Sales', 'CS']));
    expect(home.kinds.find((k) => k.kind === 'work.discussion')!.events).toBe(2);
    expect(home.recent[0].title).toContain('ENG-42');
  });

  it('lists what needs a person: no owner, no work in 30 days', () => {
    const home = wiki.wikiHome(undefined, undefined);
    expect(home.health.noOwner.map((p) => p.ref)).toEqual(expect.arrayContaining(['initiative/atlas', 'customer/globex']));
    expect(home.health.noOwner.map((p) => p.ref)).not.toContain('customer/acme');
    entities.upsertEntity({ type: 'system', id: 'billing', name: 'Billing', projectId: alpha.id });
    expect(wiki.wikiHome(undefined, undefined).health.quiet.map((p) => p.ref)).toContain('system/billing');
  });

  it('shows a member only the pages and work of the projects they can open', () => {
    const home = wiki.wikiHome(scopeForActor(aliceActor), aliceActor);
    expect(home.entries.map((e) => e.id)).not.toContain('globex');
    expect(home.recent.some((w) => w.title === 'Globex kickoff')).toBe(false);
    expect(home.teams.map((t) => t.team)).not.toContain('CS');
  });
});

describe('a page', () => {
  it('has the work that names it, the people and teams on it, related pages and the pages that mention it', () => {
    const page = wiki.wikiPage(entities.getEntity('customer', 'acme')!, undefined, undefined, true);
    expect(page.work.map((w) => w.title)).toEqual(['ENG-42: Acme export times out', '#customer-acme: renewal pricing']);
    expect(page.people.map((p) => [p.name, p.ref, p.events])).toEqual(
      expect.arrayContaining([
        ['Dana Levi', 'person/dana-example.com', 1],
        ['Lee Cohen', 'person/lee-example.com', 1],
      ]),
    );
    expect(page.related).toEqual([expect.objectContaining({ ref: 'initiative/atlas', shared: 1 })]);
    expect(page.teams.map((t) => t.team).sort()).toEqual(['Engineering', 'Sales']);
    expect(page.mentionedIn).toEqual([{ ref: 'initiative/atlas', name: 'Atlas' }]);
    expect(page.summary).toBeUndefined();
    expect(page.canEdit).toBe(true);
  });

  it('on a person, lists the work they did and the people on the same pages', () => {
    const page = wiki.wikiPage(entities.getEntity('person', 'dana-example.com')!, undefined, undefined, false);
    expect(page.work.map((w) => w.title)).toEqual(['ENG-42: Acme export times out', 'Atlas design notes']);
    expect(page.people.map((p) => p.name)).toEqual(['Lee Cohen']);
  });

  it('keeps the summary the model writes, drops links to pages that aren’t there, and says when it is out of date', async () => {
    const acme = entities.getEntity('customer', 'acme')!;
    const model = fakeModel(() => ({ summary: 'Acme is a customer. [[person/lee-example.com]] leads the renewal while R&D fixes exports for [[initiative/atlas]]. See [[customer/ghost|Ghost]] and [[customer/globex]].' }));
    const summary = await wiki.writeSummary(acme, scopeForActor(aliceActor), aliceActor, { model });
    expect(summary.text).toContain('[[initiative/atlas]]');
    expect(summary.text).not.toContain('[[customer/ghost');
    expect(summary.text).toContain('See Ghost and globex.');
    expect(summary.links).toEqual([{ ref: 'person/lee-example.com', name: 'Lee Cohen' }, { ref: 'initiative/atlas', name: 'Atlas' }]);
    expect(summary.model).toBe('fake/wiki');
    // The model saw the work, the people and the related page, and nothing from Beta.
    expect(model.prompts[0]).toContain('ENG-42: Acme export times out');
    expect(model.prompts[0]).toContain('[[initiative/atlas|Atlas]]');
    // People come with their names, not ids the model would turn into names.
    expect(model.prompts[0]).toContain('[[person/dana-example.com|Dana Levi]]');
    expect(model.prompts[0]).not.toContain('Globex');

    expect(wiki.wikiPage(acme, undefined, undefined, false).summary).toMatchObject({ stale: false, model: 'fake/wiki' });
    work('wf_alpha', 'work.discussion', { title: 'Acme asks about SSO', actor: 'lee@example.com', customer: 'acme' }, 0);
    expect(wiki.wikiPage(acme, undefined, undefined, false).summary!.stale).toBe(true);
    expect(wiki.wikiHome(undefined, undefined).health.staleSummaries.map((p) => p.ref)).toContain('customer/acme');
    // A page the summary links to lists it as mentioning it.
    expect(wiki.wikiPage(entities.getEntity('initiative', 'atlas')!, undefined, undefined, false).mentionedIn.map((m) => m.ref)).toContain('customer/acme');
    // Deleting the page deletes its summary.
    entities.deleteEntity('customer', 'acme');
    expect(database().get('SELECT subject FROM brain_pages WHERE subject = ?', 'customer/acme')).toBeUndefined();
  });

  it('needs a model to write a summary', async () => {
    await expect(wiki.writeSummary(entities.getEntity('customer', 'acme')!, undefined, undefined)).rejects.toMatchObject({ status: 409 });
  });
});

describe('ask', () => {
  it('without a model, returns the pages, facts and work it found', async () => {
    const answer = await wiki.askBrain('What is happening with Acme exports?', undefined, undefined);
    expect(answer.answer).toBeUndefined();
    expect(answer.pages[0]).toMatchObject({ type: 'customer', id: 'acme' });
    expect(answer.work[0].title).toBe('ENG-42: Acme export times out');
  });

  it('with a model, answers from what it found with page links, only from what the asker can see', async () => {
    const model = fakeModel(() => ({ answer: 'R&D is fixing Acme exports [1] in [[initiative/atlas]], while Sales talks renewal [2]. [[customer/globex]] is unrelated.' }));
    const answer = await wiki.askBrain('Who works on Acme and Globex?', scopeForActor(aliceActor), aliceActor, { model });
    expect(answer.answer).toContain('[[initiative/atlas]]');
    expect(answer.answer).not.toContain('[[customer/globex]]');
    expect(answer.model).toBe('fake/wiki');
    // "Acme", written plainly, is linked too: it is one of the pages the model was shown.
    expect(answer.answer).toContain('[[customer/acme|Acme]] exports');
    expect(answer.links).toEqual([
      { ref: 'customer/acme', name: 'Acme' },
      { ref: 'initiative/atlas', name: 'Atlas' },
    ]);
    expect(model.prompts[0]).not.toContain('Globex kickoff');
    expect(answer.pages.map((p) => p.id)).not.toContain('globex');
  });

  it('asked from a page, puts that page first', async () => {
    const model = fakeModel(() => ({ answer: 'It is on track.' }));
    const answer = await wiki.askBrain('Is it on track?', undefined, undefined, { model, about: 'initiative/atlas' });
    expect(answer.about).toBe('initiative/atlas');
    expect(answer.pages[0]).toMatchObject({ type: 'initiative', id: 'atlas' });
    expect(model.prompts[0]).toContain('asked on the page [[initiative/atlas]]');
  });

  it('reads links out of a text', () => {
    expect(wikiLinks('See [[customer/acme]], [[initiative/atlas|Atlas]] and [[customer/acme]] again; not [[Bad Link]].')).toEqual(['customer/acme', 'initiative/atlas']);
  });
});

describe('routes', () => {
  it('serve the home, a page, the summary (409 without a model) and Ask', async () => {
    const home = await call(homeRoute.GET, '/api/brain/wiki');
    expect(home.status).toBe(200);
    expect(home.body.shared[0].ref).toBe('customer/acme');
    expect(home.body.status.entities).toBeGreaterThan(0);

    const page = await call(pageRoute.GET, '/api/brain/wiki/customer/acme', {}, { type: 'customer', id: 'acme' });
    expect(page.status).toBe(200);
    expect(page.body.entity.name).toBe('Acme');
    expect((await call(pageRoute.GET, '/api/brain/wiki/customer/nobody', {}, { type: 'customer', id: 'nobody' })).status).toBe(404);

    const summary = await call(summaryRoute.POST, '/api/brain/wiki/customer/acme/summary', { method: 'POST' }, { type: 'customer', id: 'acme' });
    expect(summary.status).toBe(409);

    const ask = await call(askRoute.POST, '/api/brain/ask', { json: { question: 'Acme exports' } });
    expect(ask.status).toBe(200);
    expect(ask.body.work[0].title).toContain('ENG-42');
    expect((await call(askRoute.POST, '/api/brain/ask', { json: { question: '' } })).status).toBe(400);
  });
});

describe('linkMentions', () => {
  const pages = [
    { ref: 'person/dana-example.com', name: 'Dana Levi' },
    { ref: 'customer/acme', name: 'Acme' },
    { ref: 'initiative/acme-export', name: 'Acme export' },
    { ref: 'customer/acme', name: 'Acme' },
  ];
  it('links the first plain mention of each page, the longest name first', () => {
    expect(wiki.linkMentions('Dana Levi fixed the Acme export for Acme. Dana Levi again.', pages)).toBe(
      '[[person/dana-example.com|Dana Levi]] fixed the [[initiative/acme-export|Acme export]] for [[customer/acme|Acme]]. Dana Levi again.',
    );
  });
  it('leaves links, the page itself, and names inside other words alone', () => {
    expect(wiki.linkMentions('[[customer/acme|Acme]] and Acmeville; Dana Levi', pages, 'person/dana-example.com')).toBe('[[customer/acme|Acme]] and Acmeville; Dana Levi');
  });
});
