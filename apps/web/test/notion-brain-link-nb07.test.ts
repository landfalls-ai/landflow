/**
 * NB07: the server side of setting the Notion brain up from the project (docs/features/notion-brain.md#setting-it-up): the
 * check's deadline and one check per project, the way back from a refused key or an unshared page (PATCH `credentialId`,
 * `paused: false`), the problems list as a brain read with `notionUrl`, the Brain page's Notion fields, and the three carryover
 * fixes (a gone brain page reaches `checkStillShared`, "Keep as a fact" reads only the newest suggestion, the unshared copy
 * test's exact assertion lives in notion-copy-nb04). NB02's real client over the fake; the keys are the fake's made-up token.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';
import { seedBrain } from './notion-brain-seed';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb07-link-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off', LANDFLOW_PUBLIC_URL: 'http://nb07.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const service = await import('@/lib/server/brain/notion/service');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const { setCheckDeadline } = await import('@/lib/server/brain/notion/check');
const { notionClient } = await import('@/lib/server/notion/client');
const { setNotionClientFactory } = await import('@/lib/server/notion/port');
const { resetLimiters } = await import('@/lib/server/notion/limiter');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { replaceShares } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { listProposals, upsertProposal } = await import('@/lib/server/brain/proposals');
const { queryEvents } = await import('@/lib/server/audit/store');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { openApiDocument } = await import('@/lib/server/openapi');
const { getEntity, upsertEntity } = await import('@/lib/server/brain/entities');
const { wikiPage } = await import('@/lib/server/brain/wiki');
const { suggestedText, NOTHING_ADDED } = await import('@/lib/server/brain/notion/conflicts');
const { notionPageUrl, mappedNotionUrl, mappedNotionUrls } = await import('@/lib/server/brain/notion/urls');
const { pushEnv, pushWhole } = await import('@/lib/server/brain/notion/push');
const { sessionFor } = await import('@/lib/server/brain/notion/render');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const route = await import('@/app/api/projects/[id]/brain/notion/route');
const checkRoute = await import('@/app/api/projects/[id]/brain/notion/check/route');
const problemsRoute = await import('@/app/api/projects/[id]/brain/notion/problems/route');

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [
      defineCredentialType({ name: 'notionApi', displayName: 'Notion API', properties: [{ name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } }, { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' }] }),
      defineCredentialType({ name: 'githubApi', displayName: 'GitHub', properties: [{ name: 'token', displayName: 'Token', type: 'string', typeOptions: { password: true } }] }),
    ],
  }),
);

let fake: FakeNotion;
let seed: Awaited<ReturnType<typeof seedBrain>>;
let good = '';
let second = '';
let wrong = '';
let otherType = '';
const logged: string[] = [];

/** A virtual clock for the ticks; the deadline tests use the real one. */
const clock = { t: 5_000_000 };
const virtual = (options: Parameters<typeof notionClient>[0]) => notionClient({ ...options, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
const real = (options: Parameters<typeof notionClient>[0]) => notionClient({ ...options, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()) });

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow nb07 bot' });
  seed = await seedBrain();
  const make = (name: string, type: string, data: Record<string, unknown>) => {
    const id = credentials.create({ name, type, data }).id;
    replaceShares('credential', id, [{ projectId: seed.projectId, role: 'user' }]);
    return id;
  };
  good = make('Notion key', 'productivity.notionApi', { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url });
  second = make('Notion key two', 'productivity.notionApi', { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url });
  wrong = make('Notion key wrong', 'productivity.notionApi', { apiKey: ['wrong', 'made', 'up', 'key'].join('-'), baseUrl: fake.url });
  otherType = make('GitHub', 'productivity.githubApi', { token: 'x' });
});

afterAll(async () => {
  setCheckDeadline();
  setNotionClientFactory(notionClient);
  await fake?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  resetLimiters();
  setCheckDeadline();
  setNotionClientFactory(virtual);
  fake.state.requests.length = 0;
});

// ----------------------------------------------------------------------------------------------------- helpers

const newRoot = (title?: string) => fake.addPage({ title: title ?? `Wiki ${Math.random().toString(36).slice(2, 6)}`, shared: true });
function link(rootPageId = newRoot(), credentialId = good) {
  const old = links.getLink(seed.projectId);
  if (old) links.unlink(old.id);
  return links.createLink({ projectId: seed.projectId, credentialId, rootPageId, rootTitle: 'Wiki', createdBy: seed.owner.id });
}
const current = (id: string) => links.linkById(id)!;
async function until(id: string, done: (l: ReturnType<typeof current>) => boolean, max = 8) {
  for (let i = 0; i < max && !done(current(id)); i++) {
    service.resetBackoff();
    await service.tickOnce();
  }
  return current(id);
}
const req = (method: string, url: string, body?: unknown) => new Request(`http://nb07.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = { params: Promise.resolve({ id: '' }) };
const params = () => ({ params: Promise.resolve({ id: seed.projectId }) });
async function call(fn: () => Promise<Response>) {
  const response = await fn();
  const text = await response.text();
  logged.push(text);
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
void ctx;
const check = (page: string, credentialId = good) => call(() => checkRoute.POST(req('POST', `/api/projects/${seed.projectId}/brain/notion/check`, { credentialId, page }), params()));
const patch = (body: Record<string, unknown>) => call(() => route.PATCH(req('PATCH', `/api/projects/${seed.projectId}/brain/notion`, body), params()));
const problemsList = () => call(() => problemsRoute.GET(req('GET', `/api/projects/${seed.projectId}/brain/notion/problems`), params()));
const notices = (linkId: string, status: string) => listProposals({ status: 'open', limit: 200 }).filter((p) => p.fingerprint === `notion-brain:${linkId}:${status}`);
const editCustomer = (description: string) => upsertEntity({ type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank', projectId: seed.projectId, description });

/** Notion answers 429 with a 30 s Retry-After to what `match` names, until `release()` (the fake has no way to clear a failure). */
function stick(match: (method: string, template: string) => boolean) {
  let armed = true;
  fake.failNext({ status: 429, code: 'rate_limited', retryAfter: 30, match: (method, template) => armed && match(method, template) }, 1000);
  return () => {
    armed = false;
  };
}

// ----------------------------------------------------------------------------------------------------- the deadline

describe('the check answers within its deadline', () => {
  it('a brain found by title is still found when the deeper reads are stuck, and a check with no named brain answers what it has', async () => {
    setCheckDeadline(1500);
    setNotionClientFactory(real);
    const root = newRoot();
    const named = fake.addPage({ parentId: root, title: `Landflow brain · ${seed.project.name}`, shared: true });
    for (let i = 0; i < 25; i++) fake.addPage({ parentId: root, title: `Child ${i}`, shared: true });
    let seenChildren = 0;
    let release = stick((method, template) => method === 'GET' && template === '/v1/blocks/:id/children' && ++seenChildren > 1);
    const started = Date.now();
    const found = await check(root);
    release();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(found.status).toBe(200);
    expect(found.body.existingBrain).toEqual({ found: true, pageId: named });

    // No page is named: the deep probe is what is stuck, and the check answers what it has.
    resetLimiters();
    const bare = newRoot();
    for (let i = 0; i < 25; i++) fake.addPage({ parentId: bare, title: `Other ${i}`, shared: true });
    seenChildren = 0;
    release = stick((method, template) => method === 'GET' && template === '/v1/blocks/:id/children' && ++seenChildren > 1);
    const t2 = Date.now();
    const none = await check(bare);
    release();
    expect(Date.now() - t2).toBeLessThan(2_500);
    expect(none.status).toBe(200);
    expect(none.body.existingBrain.found).toBe(false);
  });

  it('answers 504 when Notion has not said who the key is, and writes nothing', async () => {
    setCheckDeadline(1500);
    setNotionClientFactory(real);
    const root = newRoot();
    const release = stick((_m, template) => template === '/v1/users/me');
    const started = Date.now();
    const slow = await check(root);
    release();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(slow.status).toBe(504);
    expect(slow.body.error).toContain('Try Check again');
    expect(fake.writes()).toEqual([]);
    // The project's slot is free again.
    resetLimiters();
    fake.state.requests.length = 0;
    setCheckDeadline();
    expect((await check(root)).status).toBe(200);
  });

  it('a recheck of a link (PATCH credentialId) shares one deadline between the page read and the brain page read', async () => {
    const root = newRoot();
    const l = link(root);
    links.updateLink(l.id, { brain_page_id: fake.addPage({ parentId: root, title: 'Landflow brain', shared: true }) });
    setCheckDeadline(1500);
    // The key answers after 1.0 s and the brain page never does: 1.0 s + a second full 1.5 s would pass 2.5 s.
    setNotionClientFactory((options) => {
      const client = real(options);
      return {
        ...client,
        me: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return client.me();
        },
        page: (id: string) => (id === links.linkById(l.id)!.brain_page_id ? new Promise(() => undefined) : client.page(id)),
      } as typeof client;
    });
    const started = Date.now();
    const slow = await patch({ credentialId: second });
    expect(slow.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2_000);
    setCheckDeadline();
    setNotionClientFactory(virtual);
    links.unlink(l.id);
  });

  it('two identical checks at once ask Notion once; another page while one runs is a 409', async () => {
    const root = newRoot();
    const elsewhere = newRoot();
    const [a, b, c] = await Promise.all([check(root), check(root), check(elsewhere)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('A check of this project is running; try again when it ends');
    expect(fake.state.requests.filter((r) => r.template === '/v1/users/me')).toHaveLength(1);
    // Once it ends, the next check runs.
    expect((await check(elsewhere)).status).toBe(200);
  });
});

// ----------------------------------------------------------------------------------------------------- a way back

describe('a refused key and an unshared page have a way back', () => {
  it('a refused key stops the link by a tick; a second good key brings it back with one notice each way and pushes the queued edit', async () => {
    const root = newRoot();
    const l = link(root);
    await until(l.id, (x) => x.status === 'active');
    links.updateLink(l.id, { credential_id: wrong });
    editCustomer('Edited while the key was refused');
    const stopped = await until(l.id, (x) => x.status === 'unauthorized', 3);
    expect(stopped.status).toBe('unauthorized');
    expect(notices(l.id, 'unauthorized')).toHaveLength(1);

    // A key that is refused again changes nothing; a credential of another type is a 400.
    const before = current(l.id);
    expect((await patch({ credentialId: wrong })).status).toBe(400);
    const typed = await patch({ credentialId: otherType });
    expect(typed.status).toBe(400);
    expect(current(l.id)).toEqual(before);
    expect(notices(l.id, 'active')).toHaveLength(1); // the copy's own

    const back = await patch({ credentialId: second });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('active');
    expect(back.body.credential.id).toBe(second);
    expect(current(l.id).credential_id).toBe(second);
    expect(current(l.id).bot_name).toBe('Landflow nb07 bot');
    expect(notices(l.id, 'active')).toHaveLength(1); // refreshed, not duplicated
    expect(JSON.stringify(logged)).not.toContain(FAKE_NOTION_TOKEN);

    await until(l.id, () => false, 2);
    const row = sync.itemOf(l.id, 'entity', 'customer/kestrel-bank')!;
    expect(fake.value(row.notion_id, 'Description')).toBe('Edited while the key was refused');
    const audit = queryEvents({ action: ['notion-brain.update'] }).events.find((e) => e.details?.credentialId === second);
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(FAKE_NOTION_TOKEN);
    links.unlink(l.id);
  });

  it('"Check again" on an unshared link works once the page is shared again, and not before', async () => {
    const root = newRoot();
    const l = link(root);
    await until(l.id, (x) => x.status === 'active');
    fake.share(root, false);
    editCustomer('Edited while unshared');
    await until(l.id, (x) => x.status === 'unshared', 3);
    expect(current(l.id).status).toBe('unshared');
    expect(notices(l.id, 'unshared')).toHaveLength(1);

    const still = await patch({ paused: false });
    expect(still.status).toBe(404);
    expect(still.body.error).toContain('Add connections');
    expect(current(l.id).status).toBe('unshared');

    fake.share(root, true);
    const back = await patch({ paused: false });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('active');
    expect(current(l.id).reason).toBeNull();
    expect(notices(l.id, 'active').length).toBe(1);
    await until(l.id, () => false, 2);
    const row = sync.itemOf(l.id, 'entity', 'customer/kestrel-bank')!;
    expect(fake.value(row.notion_id, 'Description')).toBe('Edited while unshared');
    links.unlink(l.id);
  });

  it('an admin’s Pause and Resume work as before', async () => {
    const l = link();
    await until(l.id, (x) => x.status === 'active');
    expect((await patch({ paused: true })).body.status).toBe('paused');
    expect((await patch({ paused: false })).body.status).toBe('active');
    links.unlink(l.id);
  });
});

// ----------------------------------------------------------------------------------------------------- the problems list

describe('the problems list is a brain read with a link to each page', () => {
  it('reads like the link, and each problem about a Notion page carries notionUrl', async () => {
    expect(routePolicy('GET', '/api/projects/p/brain/notion/problems')).toEqual({ scope: 'brain:read' });
    expect(routePolicy('GET', '/api/projects/p/brain/notion')).toEqual({ scope: 'brain:read' });
    expect(routePolicy('POST', '/api/projects/p/brain/notion/problems/x')).toEqual({ scope: 'workflows:write' });
    expect(routePolicy('PATCH', '/api/projects/p/brain/notion')).toEqual({ scope: 'workflows:write' });
    const l = link();
    await until(l.id, (x) => x.status === 'active');
    const page = sync.itemsOf(l.id, 'entity')[0];
    links.addProblem({ linkId: l.id, kind: 'trashed_in_notion', notionId: page.notion_id, localKey: page.local_key, detail: 'A person changed the page.' });
    links.addProblem({ linkId: l.id, kind: 'schema_changed', detail: 'A property was removed.' });
    const list = await problemsList();
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const withUrl = (list.body as unknown as Array<Record<string, any>>).find((p) => p.localKey === page.local_key)!;
    expect(withUrl.notionUrl).toBe(notionPageUrl(page.notion_id));
    expect(withUrl.actions).toContain('putBack');
    const without = (list.body as unknown as Array<Record<string, any>>).find((p) => p.kind === 'schema_changed')!;
    expect(without.notionUrl).toBeUndefined();
    expect(without.actions).toContain('repair');
    const doc = openApiDocument('http://nb07.test') as { paths: Record<string, Record<string, { description?: string }>> };
    expect(JSON.stringify(doc.paths['/api/projects/{id}/brain/notion/problems'])).toContain('brain:read');
    links.unlink(l.id);
  });
});

// ----------------------------------------------------------------------------------------------------- the Brain page's fields

describe('the Brain page’s Notion fields', () => {
  it('a mapped page has its row’s URL and “Your notes”; none when unlinked, detached or disconnected', async () => {
    const l = link();
    await until(l.id, (x) => x.status === 'active');
    const entity = getEntity('customer', 'kestrel-bank')!;
    const item = sync.itemOf(l.id, 'entity', 'customer/kestrel-bank')!;
    const view = () => wikiPage(entity, undefined, { id: TEST_OWNER.id } as never, true);
    expect(view().notion).toEqual({ url: notionPageUrl(item.notion_id) });
    expect(mappedNotionUrl(seed.projectId, 'entity', 'customer/kestrel-bank')).toBe(notionPageUrl(item.notion_id));
    expect([...mappedNotionUrls(seed.projectId, 'entity', ['customer/kestrel-bank', 'customer/none']).keys()]).toEqual(['customer/kestrel-bank']);

    database().upsert('notion_knowledge_docs', { link_id: l.id, page_id: item.notion_id, title: 'Kestrel Bank · Your notes', url: 'x', path: 'p', edited_at: null, hash: 'h', markdown: `Mine ${'x'.repeat(10)} <b>text</b>`, truncated: 0 } as never);
    expect(view().notion).toEqual({ url: notionPageUrl(item.notion_id), notes: `Mine ${'x'.repeat(10)} <b>text</b>` });

    database().upsert('notion_brain_items', { ...item, state: 'detached' } as never);
    expect(view().notion).toBeUndefined();
    database().upsert('notion_brain_items', { ...item, state: 'ok' } as never);
    expect(view().notion?.url).toBeTruthy();
    links.unlink(l.id);
    expect(view().notion).toBeUndefined();
    expect(mappedNotionUrl(undefined, 'entity', 'customer/kestrel-bank')).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------------------------------- the carryover

describe('the carryover', () => {
  it('a brain page that is gone after a restart turns the link unshared, from pushing Home', async () => {
    const root = newRoot();
    const l = link(root);
    await until(l.id, (x) => x.status === 'active');
    fake.share(root, false); // the key cannot see the brain page any more
    sync.forgetLink(l.id); // a restart: this process has not verified any id
    const home = sync.itemOf(l.id, 'home' as never, '');
    if (home) database().upsert('notion_brain_items', { ...home, pushed_hash: null } as never); // Home looks changed
    const fresh = current(l.id);
    const env = pushEnv(fresh, sessionFor(fresh));
    await expect(pushWhole(env, 'home')).rejects.toMatchObject({ linkStatus: 'unshared' });
    expect(current(l.id).status).toBe('unshared');
    expect(notices(l.id, 'unshared')).toHaveLength(1);
    links.unlink(l.id);
  });

  it('"Keep as a fact" reads only the newest suggestion: a placeholder is refused, never an older day’s text', () => {
    const l = link();
    const mk = (day: string, value: string, updated: string) => {
      upsertProposal({
        source: 'analyst',
        label: 'Notion brain',
        fingerprint: `notion-brain:region:${l.id}:customer/kestrel-bank:${day}`,
        projectId: seed.projectId,
        target: { type: 'entity', id: 'customer/kestrel-bank', name: 'Kestrel Bank' },
        title: 'Someone changed the summary',
        why: 'Edited in Notion.',
        evidence: [{ label: 'Changed in Notion', value }],
        ops: [],
        audience: [],
        risk: 'low',
        confidence: 0.9,
        score: 5,
      });
      const stored = database().get<{ id: string; data: string }>('SELECT id, data FROM proposals WHERE fingerprint = ?', `notion-brain:region:${l.id}:customer/kestrel-bank:${day}`)!;
      database().upsert('proposals', { ...(database().get<Record<string, unknown>>('SELECT * FROM proposals WHERE id = ?', stored.id) as Record<string, never>), updated_at: updated } as never);
    };
    mk('2026-01-01', 'Yesterday’s text', '2026-01-01T10:00:00.000Z');
    expect(suggestedText(current(l.id), 'customer/kestrel-bank')?.text).toBe('Yesterday’s text');
    mk('2026-01-02', NOTHING_ADDED, '2026-01-02T10:00:00.000Z');
    expect(suggestedText(current(l.id), 'customer/kestrel-bank')).toBeUndefined();
    links.unlink(l.id);
  });

  it('the contract copies are the contracts', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS;
    if (!dir) return;
    const pairs: Array<[string, string]> = [
      ['notion-brain.ts', 'src/lib/shared/notion-brain.ts'],
      ['notion-urls.ts', 'src/lib/server/brain/notion/urls.ts'],
      ['notion-brain-client.ts', 'src/lib/client/notion-brain.ts'],
    ];
    for (const [contract, path] of pairs) expect(readFileSync(join(__dirname, '..', path), 'utf8')).toBe(readFileSync(join(dir, 'nb', contract), 'utf8'));
  });
});
