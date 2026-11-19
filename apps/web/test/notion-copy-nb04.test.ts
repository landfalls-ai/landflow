/**
 * The initial copy and the service around it (NB04) against the local Notion fake only: the layout under the root, what goes
 * and what never does, a copy that stops anywhere and resumes with no duplicate, a lost create answer, a rate-limit storm, a
 * refused or deleted key, the switch-off, and the contract copies. The Notion client is NB02's real one, registered by the
 * runtime; the key is the fake's made-up token.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';
import { ORG_TITLE, PRIVATE_TITLE, TEAM_TITLE, WORK_ACTOR, seedBrain } from './notion-brain-seed';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb04-copy-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off', LANDFLOW_PUBLIC_URL: 'http://nb04-copy.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const service = await import('@/lib/server/brain/notion/service');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const { notionClient } = await import('@/lib/server/notion/client');
const { setNotionClientFactory } = await import('@/lib/server/notion/port');
const { NotionError } = await import('@/lib/server/notion/errors');
const { resetLimiters } = await import('@/lib/server/notion/limiter');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { replaceShares } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { listProposals } = await import('@/lib/server/brain/proposals');
const { logger } = await import('@/lib/server/telemetry');
const { copyRequests, DATABASE_KINDS, DATABASES, brainPageTitle } = await import('@/lib/shared/notion-brain');

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [defineCredentialType({ name: 'notionApi', displayName: 'Notion API', properties: [{ name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } }, { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' }] })],
  }),
);

let fake: FakeNotion;
let seed: Awaited<ReturnType<typeof seedBrain>>;
let credential = '';
const logged: string[] = [];

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow copy bot' });
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }
  seed = await seedBrain();
  credential = credentials.create({ name: 'Notion copy key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  replaceShares('credential', credential, [{ projectId: seed.projectId, role: 'user' }]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  setNotionClientFactory(notionClient);
  await fake?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** A virtual clock shared by every client: `sleep` advances it and records the wait, so nothing here waits for real. */
const clock = { t: 5_000_000, waits: [] as number[] };
const virtual = (options: Parameters<typeof notionClient>[0]) => notionClient({ ...options, now: () => clock.t, sleep: async (ms) => { clock.waits.push(ms); clock.t += ms; } });

beforeEach(() => {
  resetLimiters();
  clock.waits = [];
  setNotionClientFactory(virtual);
});

// ----------------------------------------------------------------------------------------------------- helpers

const newRoot = () => fake.addPage({ title: `Wiki ${Math.random().toString(36).slice(2, 6)}`, shared: true });
function link(rootPageId = newRoot(), projectId = seed.projectId) {
  const old = links.getLink(projectId);
  if (old) links.unlink(old.id);
  return links.createLink({ projectId, credentialId: credential, rootPageId, rootTitle: 'Wiki', createdBy: seed.owner.id });
}
const current = (id: string) => links.linkById(id)!;

/** Ticks until `done` or `max` ticks; a restart between ticks forgets what the process saw. */
async function until(id: string, done: (l: ReturnType<typeof current>) => boolean, max = 8) {
  for (let i = 0; i < max && !done(current(id)); i++) {
    service.resetBackoff();
    await service.tickOnce();
  }
  return current(id);
}

const pages = () => [...fake.state.pages.values()];
const childrenOf = (id: string) => pages().filter((p) => p.parent.type === 'page_id' && p.parent.page_id === id && !p.inTrash);
const databasesOf = (id: string) => [...fake.state.databases.values()].filter((d) => d.parentPageId === id && !d.inTrash);
const rowsOf = (dataSourceId: string) => pages().filter((p) => p.parent.type === 'data_source_id' && p.parent.data_source_id === dataSourceId && !p.inTrash);

/** A client that dies after `n` calls (as a process that was killed) until the next restart. */
function dyingAfter(n: number, failure: () => Error = () => new Error('killed')) {
  let calls = 0;
  setNotionClientFactory((options) => {
    const inner = virtual(options);
    return new Proxy(inner, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function' || key === 'paginate') return value;
        return (...args: unknown[]) => {
          if (++calls > n) throw failure();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  });
}

// ----------------------------------------------------------------------------------------------------- the copy

describe('the initial copy of a fixture brain', () => {
  it('builds the brain page, Log, four databases and exactly the project’s rows, and keeps private work out', async () => {
    const root = newRoot();
    const l = link(root);
    const before = fake.state.requests.length;
    // One tick copies it all: nothing waits for a second try.
    await service.tickOnce();
    const done = current(l.id);
    expect(done.status).toBe('active');
    expect(JSON.parse(done.copy!)).toMatchObject({ phase: 'done' });

    const [brain] = childrenOf(root);
    expect(childrenOf(root)).toHaveLength(1);
    expect(brain.title).toBe(brainPageTitle(seed.project.name));
    expect(brain.id).toBe(done.brain_page_id);
    expect(childrenOf(brain.id).map((p) => p.title)).toEqual(['Log']);
    expect(databasesOf(brain.id).map((d) => d.title).sort()).toEqual(DATABASE_KINDS.map((k) => DATABASES[k].title).sort());

    const dbs = sync.linkDatabases(done);
    const rows = (kind: (typeof DATABASE_KINDS)[number]) => rowsOf(dbs[kind]!.dataSourceId);
    expect(rows('pages')).toHaveLength(seed.counts.pages);
    expect(rows('facts')).toHaveLength(seed.counts.facts);
    expect(rows('practices')).toHaveLength(seed.counts.practices);
    expect(rows('notebook')).toHaveLength(seed.counts.notes);
    const statuses = rows('practices').map((r) => fake.value(r.id, 'Status')).sort();
    expect(statuses).toEqual(['approved', 'draft']);
    // Keyed by Landflow ID; no run note, no fact of another project or of none.
    const ids = rows('facts').map((r) => fake.value(r.id, 'Landflow ID')!);
    expect(ids.every((id) => id.startsWith('entity:customer/'))).toBe(true);
    expect(rows('notebook').map((r) => fake.value(r.id, 'Text')).sort()).toEqual(seed.projectNotes.map((n) => n.text).sort());
    expect(rows('pages').map((r) => fake.value(r.id, 'Landflow ID')).sort()).toEqual(seed.all.map((e) => `${e.type}/${e.id}`).sort());

    // The items hold every created id, and every row is Landflow's.
    expect(sync.itemsOf(l.id, 'entity')).toHaveLength(seed.counts.pages);
    expect(sync.itemsOf(l.id, 'fact')).toHaveLength(seed.counts.facts);

    // Nothing private anywhere in what the fake holds.
    const everything = JSON.stringify([...fake.state.pages.values(), ...fake.state.databases.values()]);
    expect(everything).not.toContain(PRIVATE_TITLE);
    expect(everything).not.toContain(TEAM_TITLE);
    expect(everything).not.toContain(WORK_ACTOR);
    expect(everything).not.toContain('another project note');
    expect(everything).not.toContain('run note');
    // Org work is there (the Kestrel page lists it).
    expect(everything).toContain(ORG_TITLE);

    // Each page and practice body has the region markers and an empty "Your notes".
    for (const row of [...rows('pages'), ...rows('practices')]) {
      const parts = sync.splitBody(fake.body(row.id)!);
      expect(parts.markers).toBe('comment');
      expect(parts.region).toBeTruthy();
      expect(parts.notes).toBe('');
    }
    // Home and Log hold Landflow's text.
    expect(fake.body(brain.id)).toContain('14 pages');
    expect(sync.splitBody(fake.body(childrenOf(brain.id)[0].id)!).region).toContain('## ');
    // Links to mapped pages became mentions.
    const kestrel = rows('pages').find((r) => fake.value(r.id, 'Landflow ID') === 'customer/kestrel-bank')!;
    expect(fake.body(kestrel.id)).toContain('<mention-page url="https://www.notion.so/');
    expect(fake.body(kestrel.id)).toContain(`${'Kestrel pays'.length ? '' : ''}Kestrel renews under`);
    // The request count stays near the formula.
    expect(fake.state.requests.length - before).toBeLessThanOrEqual(copyRequests(seed.counts) + 15);
    // One notice for the active status, no key in any log.
    expect(listProposals({ status: 'open', limit: 100 }).filter((p) => p.fingerprint === `notion-brain:${l.id}:active`)).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(FAKE_NOTION_TOKEN);
    // The write log is not on, but the fake saw no search.
    expect(fake.state.requests.some((r) => r.template === '/v1/search')).toBe(false);
  });
});

/** Every page, database and row the fake holds under a root, by title: duplicates show as a count above one. */
function census(root: string, brainId: string) {
  const titles = [...childrenOf(root), ...childrenOf(brainId), ...databasesOf(brainId)].map((p) => p.title);
  const rows = databasesOf(brainId).flatMap((d) => rowsOf(d.dataSourceId).map((r) => `${d.title}:${fake.value(r.id, 'Landflow ID')}`));
  const dup = (list: string[]) => list.filter((x, i) => list.indexOf(x) !== i);
  return { titles, rows, dupTitles: dup(titles), dupRows: dup(rows) };
}

describe('a copy that stops and starts again', () => {
  it('resumes with no duplicate page, database or row, within the request budget, whenever it was killed', async () => {
    const budget = copyRequests(seed.counts) + 15;
    for (const n of [1, 3, 6, 9, 14, 21, 30, 44, 58]) {
      const root = newRoot();
      const l = link(root);
      const before = fake.state.requests.length;
      dyingAfter(n);
      await service.tickOnce();
      const sentBeforeRestart = fake.state.requests.length - before;
      expect(current(l.id).status).toBe('copying');
      // A restart: the process forgets what it saw, the client works again.
      sync.forgetLink(l.id);
      setNotionClientFactory(virtual);
      const resumedFrom = fake.state.requests.length;
      const done = await until(l.id, (x) => x.status === 'active');
      expect(done.status, `killed after ${n}`).toBe('active');
      const brain = done.brain_page_id!;
      const found = census(root, brain);
      expect(found.dupTitles, `killed after ${n}`).toEqual([]);
      expect(found.dupRows, `killed after ${n}`).toEqual([]);
      expect(found.rows).toHaveLength(seed.counts.pages + seed.counts.facts + seed.counts.practices + seed.counts.notes);
      expect(childrenOf(root)).toHaveLength(1);
      expect(fake.state.requests.length - resumedFrom, `after restart (killed after ${n})`).toBeLessThanOrEqual(budget);
        expect(fake.state.requests.length - before, `in all (killed after ${n}, ${sentBeforeRestart} before)`).toBeLessThanOrEqual(budget + sentBeforeRestart);
      links.unlink(l.id);
    }
  });

  it('adopts a database whose follow-up read failed, and a page whose create answer was lost', async () => {
    const root = newRoot();
    const l = link(root);
    // Every read of a data source fails for the first database: the create landed, its properties could not be read.
    fake.failNext({ status: 404, match: (method, template) => method === 'GET' && template === '/v1/data_sources/:id' }, 3);
    await service.tickOnce();
    expect(current(l.id).status).toBe('copying');
    const brain = current(l.id).brain_page_id!;
    expect(databasesOf(brain)).toHaveLength(1);
    // A create whose answer is lost: the brain page's next row lands but the call reports failure.
    let lost = 0;
    setNotionClientFactory((options) => {
      const inner = virtual(options);
      return { ...inner, createPage: async (input) => { const page = await inner.createPage(input); if (lost++ === 2) throw Object.assign(new Error('no answer'), { kind: 'network', status: 0, retryable: true, mayHaveLanded: true }); return page; } } as typeof inner;
    });
    sync.forgetLink(l.id);
    const done = await until(l.id, (x) => x.status === 'active');
    expect(done.status).toBe('active');
    expect(lost).toBeGreaterThan(2);
    const found = census(root, brain);
    expect(found.dupTitles).toEqual([]);
    expect(found.dupRows).toEqual([]);
    expect(databasesOf(brain)).toHaveLength(4);
    links.unlink(l.id);
  });

  it('adopts a Landflow brain that is already under the root, by title and Landflow ID', async () => {
    const root = newRoot();
    const first = link(root);
    const done = await until(first.id, (x) => x.status === 'active');
    const rowsBefore = census(root, done.brain_page_id!).rows.length;
    links.unlink(first.id);
    sync.forgetLink();
    // The same root linked again, with nothing remembered: the page, Log, databases and rows are found, not made again.
    const again = link(root);
    const before = fake.state.requests.filter((r) => r.method === 'POST' && r.template === '/v1/pages').length;
    const after = await until(again.id, (x) => x.status === 'active');
    expect(after.brain_page_id).toBe(done.brain_page_id);
    expect(census(root, after.brain_page_id!).rows).toHaveLength(rowsBefore);
    expect(census(root, after.brain_page_id!).dupRows).toEqual([]);
    expect(fake.state.requests.filter((r) => r.method === 'POST' && r.template === '/v1/pages').length).toBe(before);
    links.unlink(again.id);
  });
});

describe('Notion pushing back', () => {
  it('a rate-limit storm: the copy completes, Retry-After is honoured and nothing is dropped', async () => {
    const root = newRoot();
    const l = link(root);
    fake.setRateLimit(10, 3);
    const done = await until(l.id, (x) => x.status === 'active', 12);
    expect(done.status).toBe('active');
    expect(clock.waits.filter((w) => w === 3000).length).toBeGreaterThanOrEqual(8);
    const found = census(root, done.brain_page_id!);
    expect(found.dupRows).toEqual([]);
    expect(found.rows).toHaveLength(seed.counts.pages + seed.counts.facts + seed.counts.practices + seed.counts.notes);
    links.unlink(l.id);
  });

  it('a 401 in the middle stops the link as unauthorized, keeps the outbox, and resuming with a new key continues', async () => {
    const root = newRoot();
    const l = link(root);
    sync.enqueue(l.id, 'entity', 'customer/kestrel-bank');
    dyingAfter(20, () => new NotionError('Notion POST /v1/pages: 401 unauthorized', { kind: 'unauthorized', status: 401 }));
    await service.tickOnce();
    setNotionClientFactory(virtual);
    const stopped = current(l.id);
    expect(stopped.status).toBe('unauthorized');
    expect(stopped.reason).toBe('Notion refused the key');
    const rowsMade = sync.itemsOf(l.id).length;
    expect(rowsMade).toBeGreaterThan(0);
    // A stopped link sends nothing, and its outbox stays.
    const quiet = fake.state.requests.length;
    for (let i = 0; i < 3; i++) await service.tickOnce();
    expect(fake.state.requests.length).toBe(quiet);
    expect(database().all('SELECT 1 FROM notion_brain_outbox WHERE link_id = ?', l.id)).toHaveLength(1);
    // The person gives a working key and resumes.
    links.setStatus(l.id, 'copying');
    const done = await until(l.id, (x) => x.status === 'active');
    expect(done.status).toBe('active');
    expect(census(root, done.brain_page_id!).dupRows).toEqual([]);
    expect(sync.itemsOf(l.id, 'entity').length).toBe(seed.counts.pages);
    await service.tickOnce();
    expect(database().all('SELECT 1 FROM notion_brain_outbox WHERE link_id = ?', l.id)).toHaveLength(0);
    expect(listProposals({ status: 'open', limit: 100 }).filter((p) => p.fingerprint === `notion-brain:${l.id}:unauthorized`)).toHaveLength(1);
    links.unlink(l.id);
  });

  it('a deleted credential stops the link as unauthorized with its reason, and files one notice', async () => {
    const gone = credentials.create({ name: 'Doomed key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
    replaceShares('credential', gone, [{ projectId: seed.projectId, role: 'user' }]);
    const l = links.createLink({ projectId: (links.getLink(seed.projectId) && (links.unlink(links.getLink(seed.projectId)!.id), seed.projectId)) || seed.projectId, credentialId: gone, rootPageId: newRoot(), createdBy: seed.owner.id });
    credentials.delete(gone);
    await service.tickOnce();
    await service.tickOnce();
    const stopped = current(l.id);
    expect(stopped.status).toBe('unauthorized');
    expect(stopped.reason).toBe('The Notion key was deleted');
    expect(listProposals({ status: 'open', limit: 100 }).filter((p) => p.fingerprint === `notion-brain:${l.id}:unauthorized`)).toHaveLength(1);
    links.unlink(l.id);
  });

  it('LANDFLOW_NOTION_BRAIN=off sends nothing, and switching it on starts the copy', async () => {
    const l = link();
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    try {
      const before = fake.state.requests.length;
      for (let i = 0; i < 10; i++) await service.tickOnce();
      expect(fake.state.requests.length).toBe(before);
      expect(current(l.id).status).toBe('setting_up');
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
    expect((await until(l.id, (x) => x.status === 'active')).status).toBe('active');
    links.unlink(l.id);
  });

  it('a page that is no longer shared stops the link as unshared', async () => {
    const root = newRoot();
    const l = link(root);
    await until(l.id, (x) => x.status === 'active');
    fake.share(root, false);
    sync.enqueue(l.id, 'entity', 'customer/kestrel-bank');
    database().upsert('notion_brain_items', { ...sync.itemOf(l.id, 'entity', 'customer/kestrel-bank')!, pushed_hash: null } as never);
    await service.tickOnce();
    expect(current(l.id).status).toBe('unshared');
    expect(current(l.id).reason).toContain('Share');
    links.unlink(l.id);
  });
});

describe('what leaves a trace', () => {
  it('LANDFLOW_NOTION_WRITE_LOG holds one line per write and no text, and no log line holds a key or page text', async () => {
    const file = join(dataDir, 'writes.jsonl');
    process.env.LANDFLOW_NOTION_WRITE_LOG = file;
    try {
      const root = newRoot();
      const l = link(root);
      const writesBefore = fake.writes().length;
      const done = await until(l.id, (x) => x.status === 'active');
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
      expect(lines).toHaveLength(fake.writes().length - writesBefore);
      for (const line of lines) expect(Object.keys(line).sort().filter((k) => !['at', 'method', 'pathTemplate', 'targetId', 'parentId'].includes(k))).toEqual([]);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(PRIVATE_TITLE);
      expect(text).not.toContain('Kestrel');
      expect(done.status).toBe('active');
      links.unlink(l.id);
    } finally {
      delete process.env.LANDFLOW_NOTION_WRITE_LOG;
    }
    const everything = logged.join('\n');
    expect(everything).not.toContain(FAKE_NOTION_TOKEN);
    expect(everything).not.toContain('Kestrel Bank');
    expect(everything).not.toContain(ORG_TITLE);
  });
});

describe('the contracts', () => {
  const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS;
  it.skipIf(!dir)('sync.ts and the render fixtures equal contracts/nb', () => {
    const here = join(__dirname, '..');
    expect(readFileSync(join(here, 'src/lib/server/brain/notion/sync.ts'), 'utf8')).toBe(readFileSync(join(dir!, 'nb', 'sync.ts'), 'utf8'));
    for (const file of ['input.ts', 'kestrel-bank.md', 'ana.md', 'home.md']) {
      expect(readFileSync(join(here, 'test/fixtures/notion-render', file), 'utf8')).toBe(readFileSync(join(dir!, 'nb', 'render-fixtures', file), 'utf8'));
    }
  });
});
