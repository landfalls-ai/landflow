/**
 * Pushing (NB04) against the local Notion fake only: the render fixtures byte for byte, one outbox row and one PATCH for a
 * description, ten changes in a second as one push, a person's edit of the part Landflow writes (the hook, the put-back,
 * "Your notes" untouched), the scoped writer refusing a page outside the root, creates that may have landed, deletes, the
 * practice callout, the switch-off, and fitMarkdown never cutting inside a code fence.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';
import { seedBrain } from './notion-brain-seed';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb04-push-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const render = await import('@/lib/server/brain/notion/render');
const sync = await import('@/lib/server/brain/notion/sync');
const fixtures = await import('./fixtures/notion-render/input');
await import('@/lib/server/runtime');
const service = await import('@/lib/server/brain/notion/service');
const links = await import('@/lib/server/brain/notion/links');
const { notionClient } = await import('@/lib/server/notion/client');
const { NotionError } = await import('@/lib/server/notion/errors');
const { setNotionClientFactory } = await import('@/lib/server/notion/port');
const { resetLimiters } = await import('@/lib/server/notion/limiter');
const { fitMarkdown, CUT_LINE } = await import('@/lib/server/notion/text');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { replaceShares } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { withAuth } = await import('@/lib/server/auth/context');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const practices = await import('@/lib/server/practices/store');
const { noteStore } = await import('@/lib/server/notebook/store');
const { logger } = await import('@/lib/server/telemetry');
const { DATABASES } = await import('@/lib/shared/notion-brain');

describe('the render fixtures', () => {
  for (const c of fixtures.RENDER_CASES) {
    it(`renders ${c.file} byte for byte and splits back`, () => {
      const ctx = { mapped: (ref: string) => fixtures.MAPPED[ref], publicUrl: fixtures.PUBLIC_URL };
      const region = c.kind === 'page' ? render.pageRegion(c.page, ctx) : render.homeRegion(c.home, ctx);
      const body = c.kind === 'page' ? sync.pageBody(region) : sync.wholeBody(region);
      const expected = readFileSync(join(__dirname, 'fixtures/notion-render', c.file), 'utf8');
      expect(body).toBe(expected);
      const parts = sync.splitBody(expected);
      expect(parts.region).toBe(region);
      expect(parts.notes).toBe('');
    });
  }
});

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [defineCredentialType({ name: 'notionApi', displayName: 'Notion API', properties: [{ name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } }, { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' }] })],
  }),
);

let fake: FakeNotion;
let seed: Awaited<ReturnType<typeof seedBrain>>;
let linkId = '';
let root = '';
const logged: string[] = [];
const person = withAuth;

const clock = { t: 9_000_000, waits: [] as number[] };
const virtual = (options: Parameters<typeof notionClient>[0]) => notionClient({ ...options, now: () => clock.t, sleep: async (ms) => { clock.waits.push(ms); clock.t += ms; } });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const asPerson = <T>(fn: () => T): T => person({ principal: { user: TEST_OWNER, via: 'test' } }, fn);
const current = () => links.linkById(linkId)!;
const outbox = () => database().all<{ kind: string; local_key: string; last_error: string | null; attempts: number }>('SELECT * FROM notion_brain_outbox WHERE link_id = ? ORDER BY kind, local_key', linkId);
const rowOf = (kind: 'entity' | 'fact' | 'practice' | 'note', key: string) => sync.itemOf(linkId, kind, key)!.notion_id;
/** Everything the fake was asked to change since `mark`, as `METHOD template`. */
const writesSince = (mark: number) => fake.state.requests.slice(mark).filter((r) => (r.method === 'POST' || r.method === 'PATCH') && !r.template.endsWith('/query'));
const mark = () => fake.state.requests.length;

async function settle() {
  await flush();
  service.resetBackoff();
  await service.tickOnce();
}

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow push bot' });
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }
  seed = await seedBrain();
  const credential = credentials.create({ name: 'Notion push key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  replaceShares('credential', credential, [{ projectId: seed.projectId, role: 'user' }]);
  root = fake.addPage({ title: 'Wiki', shared: true });
  setNotionClientFactory(virtual);
  linkId = links.createLink({ projectId: seed.projectId, credentialId: credential, rootPageId: root, rootTitle: 'Wiki', createdBy: seed.owner.id }).id;
  service.resetBackoff();
  await service.tickOnce();
  expect(current().status).toBe('active');
  // The pushes below come from the project's changes, not from the copy.
  await flush();
  for (const row of outbox()) database().delete('notion_brain_outbox', { link_id: linkId, kind: row.kind, local_key: row.local_key });
});

afterAll(async () => {
  vi.restoreAllMocks();
  setNotionClientFactory(notionClient);
  await fake?.close();
});

beforeEach(() => {
  resetLimiters();
  setNotionClientFactory(virtual);
  sync.setRegionConflict(undefined);
});

describe('a change on the Brain page reaches its row', () => {
  it('a description is one outbox row and one PATCH of that row, with no body write; ten changes in a second are one push', async () => {
    const id = rowOf('entity', 'customer/harbor-air');
    expect(outbox()).toEqual([]);
    asPerson(() => entities.upsertEntity({ type: 'customer', id: 'harbor-air', description: 'Airline, since 2019' }));
    await flush();
    expect(outbox().filter((r) => r.kind === 'entity')).toHaveLength(1);
    const m = mark();
    await settle();
    const writes = writesSince(m);
    expect(writes.map((w) => `${w.method} ${w.template}`)).toEqual(['PATCH /v1/pages/:id']);
    expect(fake.value(id, 'Description')).toBe('Airline, since 2019');
    expect(outbox().filter((r) => r.kind === 'entity')).toEqual([]);

    for (let i = 0; i < 10; i++) asPerson(() => entities.upsertEntity({ type: 'customer', id: 'harbor-air', description: `Airline v${i}` }));
    await flush();
    expect(outbox().filter((r) => r.kind === 'entity')).toHaveLength(1);
    const m2 = mark();
    await settle();
    expect(writesSince(m2)).toHaveLength(1);
    expect(fake.value(id, 'Description')).toBe('Airline v9');
    // Nothing changed: the next tick writes nothing.
    const m3 = mark();
    await settle();
    expect(writesSince(m3)).toEqual([]);
  });

  it('a fact added to a page is a new Facts row and a new line on the page', async () => {
    const entity = entities.getEntity('customer', 'lumen-health')!;
    const fact = asPerson(() => entities.addEntityFact(entity, { kind: 'health', statement: 'Renewal at risk' }));
    await settle();
    const row = rowOf('fact', fact.id);
    expect(fake.value(row, 'Statement')).toBe('Renewal at risk');
    expect(fake.value(row, 'About')).toBe(rowOf('entity', 'customer/lumen-health'));
    expect(fake.value(row, 'Source')).toBe('Person');
    expect(fake.body(rowOf('entity', 'customer/lumen-health'))).toContain('Renewal at risk');
    asPerson(() => facts.deleteFact(fact.id));
    const m = mark();
    await settle();
    expect(fake.state.pages.get(row)!.inTrash).toBe(true);
    expect(writesSince(m).some((w) => w.template === '/v1/pages/:id')).toBe(true);
  });

  it('a new page is made once, even when its create landed and its answer was lost', async () => {
    let lost = 0;
    setNotionClientFactory((options) => {
      const inner = virtual(options);
      return { ...inner, createPage: async (input) => { const page = await inner.createPage(input); if (lost++ === 0) throw new NotionError('Notion POST /v1/pages: 503', { kind: 'unavailable', status: 503, mayHaveLanded: true }); return page; } } as typeof inner;
    });
    asPerson(() => entities.upsertEntity({ type: 'customer', id: 'newco', name: 'NewCo', projectId: seed.projectId }));
    await settle();
    const rows = [...fake.state.pages.values()].filter((p) => fake.value(p.id, 'Landflow ID') === 'customer/newco');
    expect(rows).toHaveLength(1);
    expect(sync.itemOf(linkId, 'entity', 'customer/newco')!.notion_id).toBe(rows[0].id);
    expect(fake.body(rows[0].id)).toContain('## Summary');
    // The item was lost (a restart before it was saved): the row is adopted by Landflow ID, not made twice.
    database().delete('notion_brain_items', { link_id: linkId, kind: 'entity', local_key: 'customer/newco' });
    sync.enqueue(linkId, 'entity', 'customer/newco');
    await settle();
    expect([...fake.state.pages.values()].filter((p) => fake.value(p.id, 'Landflow ID') === 'customer/newco')).toHaveLength(1);
    expect(sync.itemOf(linkId, 'entity', 'customer/newco')).toBeTruthy();
  });

  it('a deleted page goes to trash with its facts; a summary delete for a row Notion never had sends nothing', async () => {
    asPerson(() => entities.upsertEntity({ type: 'system', id: 'doomed', name: 'Doomed', projectId: seed.projectId }));
    await flush();
    // Deleted before the push: the outbox holds its entity and summary rows, and nothing was ever in Notion.
    const m0 = mark();
    asPerson(() => entities.deleteEntity('system', 'doomed'));
    await settle();
    expect(writesSince(m0)).toEqual([]);
    expect(sync.itemOf(linkId, 'entity', 'system/doomed')).toBeUndefined();

    const row = rowOf('entity', 'system/billing-api');
    asPerson(() => entities.deleteEntity('system', 'billing-api'));
    const m = mark();
    await settle();
    expect(fake.state.pages.get(row)!.inTrash).toBe(true);
    expect(sync.itemOf(linkId, 'entity', 'system/billing-api')).toBeUndefined();
    expect(writesSince(m).filter((w) => w.template === '/v1/pages/:id')).toHaveLength(1);
  });
});

describe('a person edits the part of a page Landflow writes', () => {
  it('calls the conflict hook with the old and new text, puts the region back, and leaves "Your notes" byte for byte', async () => {
    const id = rowOf('entity', 'customer/orbit-foods');
    const body = fake.body(id)!;
    const parts = sync.splitBody(body);
    const edited = sync.pageBody(parts.region!.replace('_No summary yet._', 'Orbit is mine now'), 'Dana wrote this\n\n- and a list');
    fake.editAsPerson(id, { markdown: edited });
    const seen: Array<{ before: string; after: string; key: string }> = [];
    sync.setRegionConflict(({ before, after, item }) => void seen.push({ before, after, key: item.local_key }));
    const entity = entities.getEntity('customer', 'orbit-foods')!;
    asPerson(() => entities.addEntityFact(entity, { kind: 'health', statement: 'Orbit pays late' }));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('customer/orbit-foods');
    expect(seen[0].before).toBe(parts.region);
    expect(seen[0].after).toContain('Orbit is mine now');
    const after = sync.splitBody(fake.body(id)!);
    expect(after.region).toContain('Orbit pays late');
    expect(after.region).not.toContain('Orbit is mine now');
    expect(after.notes).toBe('Dana wrote this\n\n- and a list');
    expect(fake.body(id)!.endsWith('Dana wrote this\n\n- and a list\n')).toBe(true);
    expect(sync.itemOf(linkId, 'entity', 'customer/orbit-foods')!.pushed_region).toBe(after.region);
  });

  it('files a problem when nothing hears the conflict', async () => {
    const id = rowOf('entity', 'customer/kestrel-bank');
    const parts = sync.splitBody(fake.body(id)!);
    fake.editAsPerson(id, { markdown: sync.pageBody(`${parts.region}\n\nExtra by hand`, 'my notes') });
    asPerson(() => entities.addEntityFact(entities.getEntity('customer', 'kestrel-bank')!, { kind: 'usage', statement: 'Used a lot' }));
    await settle();
    const problems = links.problems(linkId);
    expect(problems.map((p) => p.kind)).toContain('landflow_part_edited');
    expect(sync.splitBody(fake.body(id)!).region).not.toContain('Extra by hand');
    expect(sync.splitBody(fake.body(id)!).notes).toBe('my notes');
  });

  it('puts Home back when a person edits it, never replacing the child pages and databases', async () => {
    const brain = current().brain_page_id!;
    const before = fake.body(brain)!;
    fake.editAsPerson(brain, { markdown: before.replace('14 pages', 'a person typed here') });
    // The sync was told to re-push Home (the pull's job): the stored hash is cleared and it is queued.
    const item = sync.itemOf(linkId, 'home' as never, '')!;
    database().upsert('notion_brain_items', { ...item, pushed_hash: null } as never);
    sync.enqueue(linkId, 'home', '');
    await settle();
    expect(fake.body(brain)).toContain('pages:');
    expect(fake.body(brain)).not.toContain('a person typed here');
    expect(fake.state.pages.get(current().log_page_id!)!.inTrash).toBe(false);
    expect([...fake.state.databases.values()].filter((d) => d.parentPageId === brain && !d.inTrash)).toHaveLength(4);
  });
});

describe('the scoped writer', () => {
  it('refuses a row whose notion_id points outside the root, and the next object still lands', async () => {
    const stranger = fake.addPage({ title: 'Stranger root', shared: true });
    const outside = fake.addPage({ parentId: stranger, title: 'X', markdown: 'secret' });
    const item = sync.itemOf(linkId, 'entity', 'person/ben')!;
    const original = item.notion_id;
    database().upsert('notion_brain_items', { ...item, notion_id: outside } as never);
    sync.forgetLink(linkId);
    asPerson(() => entities.upsertEntity({ type: 'person', id: 'ben', description: 'Changed on the Brain page' }));
    asPerson(() => entities.upsertEntity({ type: 'person', id: 'chen', description: 'Chen is fine' }));
    const m = mark();
    await settle();
    const since = fake.state.requests.slice(m);
    const compact = outside.replace(/-/g, '');
    expect(since.filter((r) => r.path.replace(/-/g, '').includes(compact) && r.method !== 'GET')).toEqual([]);
    expect(since.filter((r) => r.path.replace(/-/g, '').includes(compact))).toHaveLength(1);
    expect(logged.some((line) => line.includes(`[notion-brain] refused write ${outside}`))).toBe(true);
    const stuck = outbox().find((r) => r.local_key === 'person/ben')!;
    expect(stuck.last_error).toContain('outside');
    expect(fake.value(rowOf('entity', 'person/chen'), 'Description')).toBe('Chen is fine');
    expect(fake.body(outside)).toBe('secret');
    // Put it right again so later tests are not affected.
    database().upsert('notion_brain_items', { ...sync.itemOf(linkId, 'entity', 'person/ben')!, notion_id: original } as never);
    sync.forgetLink(linkId);
    database().delete('notion_brain_outbox', { link_id: linkId, kind: 'entity', local_key: 'person/ben' });
  });
});

describe('practices, notes and the switch', () => {
  it('shows the approved text, with a callout while a draft from Notion waits', async () => {
    const id = seed.practices.approved;
    const row = rowOf('practice', id);
    const approvedBody = fake.body(row)!;
    expect(approvedBody).toContain('Rules for Charts live under deploy/helm.');
    expect(approvedBody).not.toContain('waiting for approval');
    const draft = asPerson(() => practices.draftPractice({ practiceId: id, handle: 'team/charts', title: 'Charts live under deploy/helm', level: 'project', projectId: seed.projectId, strength: 'required', topics: ['helm'], repos: [], paths: ['deploy/**'], summary: 'Changed in Notion', body: 'Rules edited in Notion.' }, { source: 'notion' }));
    // A change of origin notion is the puller's (NB05 queues what it wants shown); here the page is queued by hand.
    sync.enqueue(linkId, 'practice', id);
    await settle();
    const after = fake.body(row)!;
    expect(after).toContain(`Your change is draft v${draft.version.version}, waiting for approval in Landflow`);
    expect(after).toContain('Rules for Charts live under deploy/helm.');
    expect(after).not.toContain('Rules edited in Notion.');
    expect(fake.value(row, 'Status')).toBe('approved');
    expect(sync.splitBody(after).notes).toBe('');
  });

  it('pushes a note, and a status change of it', async () => {
    const note = seed.projectNotes[0];
    const row = rowOf('note', note.id);
    expect(fake.value(row, 'Status')).toBe('unverified');
    database().upsert('team_notes', { ...database().get<Record<string, never>>('SELECT * FROM team_notes WHERE id = ?', note.id)!, status: 'verified' });
    sync.enqueue(linkId, 'note', note.id);
    await settle();
    expect(fake.value(row, 'Status')).toBe('verified');
  });

  it('LANDFLOW_NOTION_BRAIN=off: ten ticks make no request, the outbox still fills, and switching it on pushes what changed', async () => {
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    try {
      const m = mark();
      asPerson(() => entities.upsertEntity({ type: 'person', id: 'dana', description: 'Dana while off' }));
      await flush();
      for (let i = 0; i < 10; i++) await service.tickOnce();
      expect(fake.state.requests.length).toBe(m);
      expect(outbox().some((r) => r.local_key === 'person/dana')).toBe(true);
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
    await settle();
    expect(fake.value(rowOf('entity', 'person/dana'), 'Description')).toBe('Dana while off');
  });

  it('a paused link sends nothing and keeps filling its outbox', async () => {
    links.setStatus(linkId, 'paused', 'Paused by an admin');
    asPerson(() => entities.upsertEntity({ type: 'person', id: 'eli', description: 'Eli while paused' }));
    await flush();
    const m = mark();
    for (let i = 0; i < 3; i++) await service.tickOnce();
    expect(fake.state.requests.length).toBe(m);
    expect(outbox().some((r) => r.local_key === 'person/eli')).toBe(true);
    links.setStatus(linkId, 'active');
    await settle();
    expect(fake.value(rowOf('entity', 'person/eli'), 'Description')).toBe('Eli while paused');
  });

  it('an origin of notion is not queued, but a person or landflow change is', async () => {
    const m = outbox().length;
    asPerson(() => entities.upsertEntity({ type: 'person', id: 'ana', description: 'From Notion' }, undefined, undefined, 'notion'));
    await flush();
    expect(outbox().filter((r) => r.local_key === 'person/ana')).toEqual([]);
    expect(outbox().length).toBeGreaterThanOrEqual(m);
    await settle();
  });
});

describe('fitMarkdown', () => {
  it('never cuts inside a fenced code block, and a # comment in one is not a heading', () => {
    const code = ['```bash', ...Array.from({ length: 6 }, (_, i) => `# step ${i}`), 'echo done', '```'].join('\n');
    const filler = Array.from({ length: 4600 }, (_, i) => `line ${i}`).join('\n');
    const cut = fitMarkdown(`## First\n\n${filler.slice(0, 20)}\n\n${code}\n\n${filler}`);
    expect(cut.endsWith(`${CUT_LINE}\n`)).toBe(true);
    const fences = cut.split('\n').filter((l) => l.startsWith('```')).length;
    expect(fences % 2).toBe(0);
    // A fence open at the limit is dropped whole, not left open.
    const risky = fitMarkdown(`${Array.from({ length: 4498 }, (_, i) => `line ${i}`).join('\n')}\n\n\`\`\`\n# one\n# two\n# three\n\`\`\`\n`);
    expect(risky.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0);
    expect(risky).not.toContain('# one');
  });
});
