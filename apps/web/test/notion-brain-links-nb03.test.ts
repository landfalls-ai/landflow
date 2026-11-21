/**
 * NB03: a project's link to a Notion page (docs/features/notion-brain.md#setting-it-up): the migrations, the check (reads the
 * fake Notion, writes nothing), link / change / sync / disconnect, the problems, the resolver, the policy and the openapi
 * document. The client is a stub over the fake with the contract's headers; the real client is the integrator's join test.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notion-links-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://notion-links.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { replaceShares } = await import('@/lib/server/projects/store');
const { database, MIGRATIONS, migrateSqlite } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { openApiDocument } = await import('@/lib/server/openapi');
const { TABLES } = await import('@/lib/server/db/schema');
const { setNotionClientFactory, NOTION_VERSION } = await import('@/lib/server/notion/port');
const { setLocalBrainStore, brainStoreFor } = await import('@/lib/server/brain/store/port');
const links = await import('@/lib/server/brain/notion/links');
const { upsertEntity } = await import('@/lib/server/brain/entities');
const route = await import('@/app/api/projects/[id]/brain/notion/route');
const checkRoute = await import('@/app/api/projects/[id]/brain/notion/check/route');
const syncRoute = await import('@/app/api/projects/[id]/brain/notion/sync/route');
const problemsRoute = await import('@/app/api/projects/[id]/brain/notion/problems/route');
const problemRoute = await import('@/app/api/projects/[id]/brain/notion/problems/[problemId]/route');

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity', version: '1.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          { name: 'apiKey', displayName: 'API key', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.notion.com' },
        ],
      }),
      defineCredentialType({ name: 'githubApi', displayName: 'GitHub', properties: [{ name: 'token', displayName: 'Token', type: 'string', typeOptions: { password: true } }] }),
    ],
  }),
);

type User = Awaited<ReturnType<typeof createUser>>;
let fake: FakeNotion;
let alice: User; // admin of the team
let bob: User; // editor
let carol: User; // viewer
let team = '';
let other = '';
let credential = '';
let otherType = '';
let unusable = '';
const seen: string[] = [];

const req = (method: string, url: string, body?: unknown) => new Request(`http://notion-links.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
async function as<T>(user: User | undefined, fn: () => Promise<T>): Promise<T> {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
async function call(user: User | undefined, fn: () => Promise<Response>) {
  const response = await as(user, fn);
  const text = await response.text();
  seen.push(text);
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
const check = (user: User | undefined, project: string, page: string, credentialId = credential) => call(user, () => checkRoute.POST(req('POST', `/api/projects/${project}/brain/notion/check`, { credentialId, page }), params({ id: project })));
const link = (user: User | undefined, project: string, page: string, extra: Record<string, unknown> = {}) => call(user, () => route.POST(req('POST', `/api/projects/${project}/brain/notion`, { credentialId: credential, page, ...extra }), params({ id: project })));
const status = (user: User | undefined, project: string) => call(user, () => route.GET(req('GET', `/api/projects/${project}/brain/notion`), params({ id: project })));
const unlinkIt = (user: User | undefined, project: string) => call(user, () => route.DELETE(req('DELETE', `/api/projects/${project}/brain/notion`), params({ id: project })));

/** A stub client: the fake, read through fetch with the contract's headers (the real client is NB02's). */
function stubClient() {
  const get = async (path: string) => {
    const response = await fetch(`${fake.url}${path}`, { headers: { authorization: `Bearer ${fake.token}`, 'notion-version': NOTION_VERSION } });
    const data = (await response.json()) as Record<string, any>;
    if (!response.ok) throw Object.assign(new Error(String(data.message ?? 'refused')), { kind: response.status === 404 ? 'notFound' : response.status === 401 ? 'unauthorized' : 'invalid', status: response.status });
    return data;
  };
  const client = {
    me: () => get('/v1/users/me'),
    page: (id: string) => get(`/v1/pages/${id}`),
    children: (id: string, cursor?: string) => get(`/v1/blocks/${id}/children${cursor ? `?start_cursor=${cursor}` : ''}`),
    database: (id: string) => get(`/v1/databases/${id}`),
    dataSource: (id: string) => get(`/v1/data_sources/${id}`),
    async *paginate(call: (cursor: string | undefined) => Promise<any>) {
      let cursor: string | undefined;
      do {
        const list = await call(cursor);
        yield* list.results;
        cursor = list.has_more ? (list.next_cursor ?? undefined) : undefined;
      } while (cursor);
    },
  };
  return client as never;
}

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow bot' });
  setNotionClientFactory(() => stubClient());
  alice = await createUser({ email: 'alice@notion-links.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@notion-links.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  carol = await createUser({ email: 'carol@notion-links.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
  team = projects.createTeamProject({ name: 'Payments' }).id;
  other = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(team, alice.id, 'admin');
  projects.setMember(team, bob.id, 'editor');
  projects.setMember(team, carol.id, 'viewer');
  projects.setMember(other, alice.id, 'admin');
  credential = credentials.create({ name: 'Notion key', type: 'productivity.notionApi', data: { apiKey: fake.token, baseUrl: fake.url } }).id;
  otherType = credentials.create({ name: 'GitHub', type: 'productivity.githubApi', data: { token: 'gh-never' } }).id;
  unusable = credentials.create({ name: 'Elsewhere', type: 'productivity.notionApi', data: { apiKey: fake.token, baseUrl: fake.url } }).id;
  replaceShares('credential', credential, [{ projectId: team, role: 'user' }, { projectId: other, role: 'user' }]);
  replaceShares('credential', otherType, [{ projectId: team, role: 'user' }]);
});

afterAll(async () => {
  enableTestAuth();
  await fake.close();
  setNotionClientFactory(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the tables', () => {
  it('2908-2911 apply on a database at 2907 and on a fresh one; the partial unique indexes exist; TABLES lists the five tables', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const existing = new DatabaseSync(':memory:');
    migrateSqlite(existing, MIGRATIONS.filter((m) => m.version <= 2907));
    expect(existing.prepare("SELECT name FROM sqlite_master WHERE name = 'notion_brain_links'").all()).toEqual([]);
    expect(migrateSqlite(existing, MIGRATIONS.filter((m) => m.version <= 2911))).toEqual([2908, 2909, 2910, 2911]);
    const fresh = new DatabaseSync(':memory:');
    expect(migrateSqlite(fresh)).toEqual(expect.arrayContaining([2908, 2909, 2910, 2911]));
    for (const db of [existing, fresh]) {
      const names = (sql: string) => (db.prepare(sql).all() as Array<{ name: string }>).map((r) => r.name);
      expect(names("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'notion_%'").sort()).toEqual(['notion_brain_items', 'notion_brain_links', 'notion_brain_outbox', 'notion_brain_problems', 'notion_knowledge_docs']);
      expect(names("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notion_brain_links'")).toEqual(expect.arrayContaining(['notion_brain_links_project', 'notion_brain_links_root', 'notion_brain_links_active_project']));
      expect(names('PRAGMA table_info(notion_brain_links)')).toEqual(expect.arrayContaining(['copy', 'reason', 'next_sync_at', 'knowledge_scope', 'cursors']));
      const partial = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notion_brain_links_root'").get() as { sql: string };
      expect(partial.sql).toContain("WHERE status <> 'unlinked'");
    }
    expect(TABLES).toMatchObject({ notion_brain_links: ['id'], notion_brain_items: ['link_id', 'kind', 'local_key'], notion_brain_outbox: ['link_id', 'kind', 'local_key'], notion_brain_problems: ['id'], notion_knowledge_docs: ['link_id', 'page_id'] });
    // Later work adds its own (2912-2913: fact versions and forgetting); this test is about NB03's four.
    expect(MIGRATIONS.filter((m) => m.version > 2907 && m.version <= 2911).map((m) => m.version)).toEqual([2908, 2909, 2910, 2911]);
  });
});

describe('the check', () => {
  it('reads a shared page: its title, the existing brain and the project counts, and writes nothing', async () => {
    const root = fake.addPage({ title: 'Payments wiki', shared: true });
    upsertEntity({ type: 'system', id: 'ledger', name: 'Ledger', projectId: team } as never);
    const before = fake.writes().length;
    const result = await check(alice, team, root);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ title: 'Payments wiki', botName: 'Landflow bot', existingBrain: { found: false }, counts: { pages: 1, facts: 0, practices: 0, notes: 0 }, estimateMinutes: 1 });
    expect(fake.writes().length).toBe(before);
    expect(fake.writes()).toEqual([]);
    expect(fake.state.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('finds a "Landflow brain" page already under the page', async () => {
    const root = fake.addPage({ title: 'With brain', shared: true });
    const brain = fake.addPage({ parentId: root, title: 'Landflow brain · Payments' });
    const result = await check(alice, team, `https://www.notion.so/With-brain-${root.replace(/-/g, '')}`);
    expect(result.status).toBe(200);
    expect(result.body.existingBrain).toEqual({ found: true, pageId: brain });
  });

  it('an unshared page is a 404 that says how to share it', async () => {
    const root = fake.addPage({ title: 'Private' });
    const result = await check(alice, team, root);
    expect(result.status).toBe(404);
    expect(result.body.error).toContain("Landflow can't see this page: open it in Notion → ••• → Add connections → Landflow bot");
  });

  it('a page that does not parse is 400; a credential of another type 400; one the project cannot use 403; a non-admin 403', async () => {
    const root = fake.addPage({ title: 'Shared', shared: true });
    expect((await check(alice, team, 'not a page')).status).toBe(400);
    expect((await check(alice, team, root, otherType)).status).toBe(400);
    expect((await check(alice, team, root, unusable)).status).toBe(403);
    expect((await check(bob, team, root)).status).toBe(403);
    expect((await check(carol, team, root)).status).toBe(403);
    expect(fake.writes()).toEqual([]);
  });
});

describe('linking', () => {
  let root = '';
  it('creates the link in setting_up; the same project again is 409; a second project on the root is 409', async () => {
    root = fake.addPage({ title: 'Linked root', shared: true });
    const made = await link(alice, team, root, { rps: 3 });
    expect(made.status).toBe(202);
    expect(made.body).toMatchObject({ linked: true, projectId: team, status: 'setting_up', rps: 3, knowledgeScope: 'brain', rootTitle: 'Linked root', credential: { id: credential, name: 'Notion key' }, canManage: true });
    expect((await link(alice, team, root)).body.error).toContain('Already linked');
    expect((await link(alice, team, root)).status).toBe(409);
    const second = await link(alice, other, root);
    expect(second.status).toBe(409);
    expect((await check(alice, other, root)).status).toBe(409);
    expect((await link(bob, team, fake.addPage({ title: 'x', shared: true }))).status).toBe(403);
    expect(fake.writes()).toEqual([]);
  });

  it('members read the status; a viewer cannot manage; patch changes rps and pauses and resumes; sync answers 202', async () => {
    expect((await status(carol, team)).body).toMatchObject({ linked: true, status: 'setting_up', canManage: false });
    expect((await status(alice, other)).body).toEqual({ linked: false, canManage: true });
    const patch = (user: User, data: unknown) => call(user, () => route.PATCH(req('PATCH', `/api/projects/${team}/brain/notion`, data), params({ id: team })));
    expect((await patch(bob, { rps: 4 })).status).toBe(403);
    expect((await patch(alice, { rps: 99 })).status).toBe(400);
    expect((await patch(alice, {})).status).toBe(400);
    expect((await patch(alice, { rps: 4, knowledgeScope: 'root' })).body).toMatchObject({ rps: 4, knowledgeScope: 'root' });
    expect((await patch(alice, { paused: true })).body).toMatchObject({ status: 'paused' });
    expect((await patch(alice, { paused: false })).body.status).toBe('setting_up');
    const synced = await call(alice, () => syncRoute.POST(req('POST', `/api/projects/${team}/brain/notion/sync`), params({ id: team })));
    expect(synced.status).toBe(202);
    expect((await call(bob, () => syncRoute.POST(req('POST', `/api/projects/${team}/brain/notion/sync`), params({ id: team })))).status).toBe(403);
  });

  it('DELETE unlinks with no request to Notion and leaves the local brain alone; the project can link again', async () => {
    const count = () => database().get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_entities WHERE project_id = ?', team)!.n;
    const entities = count();
    const requests = fake.state.requests.length;
    const gone = await unlinkIt(alice, team);
    expect(gone.status).toBe(200);
    expect(gone.body.message).toContain('Notion keeps what is there');
    expect(fake.state.requests.length).toBe(requests);
    expect(count()).toBe(entities);
    expect((await status(alice, team)).body).toEqual({ linked: false, canManage: true });
    expect(database().get<{ status: string }>('SELECT status FROM notion_brain_links WHERE project_id = ?', team)!.status).toBe('unlinked');
    expect((await unlinkIt(alice, team)).status).toBe(404);
    // The root is free again, for this project or another.
    expect((await link(alice, team, root)).status).toBe(202);
  });
});

describe('LANDFLOW_NOTION_BRAIN=off', () => {
  it('answers 409 on check and link, reads every link as paused, and every project resolves local', async () => {
    const root = fake.addPage({ title: 'Off', shared: true });
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    try {
      const requests = fake.state.requests.length;
      const checked = await check(alice, other, root);
      expect(checked.status).toBe(409);
      expect(checked.body.error).toBe('The Notion brain is switched off on this instance');
      expect((await link(alice, other, root)).status).toBe(409);
      expect(fake.state.requests.length).toBe(requests);
      expect((await status(alice, team)).body).toMatchObject({ status: 'paused', reason: 'The Notion brain is switched off on this instance' });
      setLocalBrainStore({ backend: 'local' } as never);
      expect(brainStoreFor(team).backend).toBe('local');
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
  });
});

describe('the resolver', () => {
  it('an active link resolves to notion; an unlinked project, no project and a deleted project resolve local', async () => {
    setLocalBrainStore({ backend: 'local' } as never);
    expect(links.getLink(team)).toBeDefined();
    expect(brainStoreFor(team).backend).toBe('notion');
    expect(brainStoreFor(other).backend).toBe('local');
    expect(brainStoreFor(undefined).backend).toBe('local');
    // A deleted project: its link is kept, and reads as unlinked.
    const gone = projects.createTeamProject({ name: 'Doomed' }).id;
    const goneRoot = fake.addPage({ title: 'Doomed root', shared: true });
    projects.setMember(gone, alice.id, 'admin');
    replaceShares('credential', credential, [{ projectId: team, role: 'user' }, { projectId: other, role: 'user' }, { projectId: gone, role: 'user' }]);
    expect((await link(alice, gone, goneRoot)).status).toBe(202);
    expect(brainStoreFor(gone).backend).toBe('notion');
    const { removeProjectRows } = await import('@/lib/server/projects/store');
    removeProjectRows(gone);
    expect(brainStoreFor(gone).backend).toBe('local');
    expect(links.getLink(gone)).toBeUndefined();
    expect(links.listActiveLinks().map((l) => l.project_id)).not.toContain(gone);
    expect(database().get('SELECT 1 AS x FROM notion_brain_links WHERE project_id = ?', gone)).toBeDefined();
    // The deleted project's page is free again: another project can check and link it.
    expect(links.linkOfRoot(goneRoot)).toBeUndefined();
    const again = await call(alice, () => checkRoute.POST(req('POST', `/api/projects/${other}/brain/notion/check`, { credentialId: credential, page: goneRoot }), params({ id: other })));
    expect(again.status).toBe(200);
    expect((await link(alice, other, goneRoot)).status).toBe(202);
    await unlinkIt(alice, other);
    await unlinkIt(alice, team);
    expect(brainStoreFor(team).backend).toBe('local');
    expect((await link(alice, team, fake.addPage({ title: 'Again', shared: true }))).status).toBe(202);
  });
});

describe('problems', () => {
  it('lists, refuses what the kind does not offer, needs an admin for deleteLocal and records who dismissed', async () => {
    const row = links.getLink(team)!;
    const trashed = links.addProblem({ linkId: row.id, kind: 'trashed_in_notion', notionId: 'abc', localKey: 'system/ledger', detail: 'A person moved this page to trash in Notion' });
    const bad = links.addProblem({ linkId: row.id, kind: 'bad_attribute', localKey: 'system/ledger', detail: 'An Attributes line is not key: value' });
    expect(links.addProblem({ linkId: row.id, kind: 'bad_attribute', localKey: 'system/ledger', detail: 'again' }).id).toBe(bad.id);
    const list = await call(carol, () => problemsRoute.GET(req('GET', `/api/projects/${team}/brain/notion/problems`), params({ id: team })));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.find((p: any) => p.id === trashed.id).actions).toEqual(['dismiss', 'putBack', 'deleteLocal']);
    expect((await status(alice, team)).body.problems).toBe(2);
    const act = (user: User, id: string, action: string) => call(user, () => problemRoute.POST(req('POST', `/api/projects/${team}/brain/notion/problems/${id}`, { action }), params({ id: team, problemId: id })));
    expect((await act(bob, bad.id, 'putBack')).status).toBe(400);
    expect((await act(bob, trashed.id, 'deleteLocal')).status).toBe(403);
    expect((await act(alice, trashed.id, 'deleteLocal')).status).toBe(409);
    expect((await act(carol, bad.id, 'dismiss')).status).toBe(403);
    const dismissed = await act(bob, bad.id, 'dismiss');
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ resolved: true, action: 'dismiss', by: bob.id });
    expect(links.problemById(bad.id)).toMatchObject({ resolved_by: bob.id, resolved_action: 'dismiss' });
    expect(links.problemById(bad.id)!.resolved_at).toBeTruthy();
    expect((await act(bob, bad.id, 'dismiss')).status).toBe(409);
    expect((await act(bob, 'nope', 'dismiss')).status).toBe(404);
    // Once something performs the action, it runs and resolves the problem.
    links.setProblemActions(() => undefined);
    try {
      expect((await act(alice, trashed.id, 'deleteLocal')).status).toBe(200);
    } finally {
      links.setProblemActions(undefined);
    }
  });
});

describe('secrets, policy and docs', () => {
  it('no response, audit row or stored link holds the key', () => {
    const audit = JSON.stringify(queryEvents({}, { limit: 1000 }).events);
    expect(audit).toContain('notion-brain.link');
    expect(audit).not.toContain(fake.token);
    expect(seen.join('\n')).not.toContain(fake.token);
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_links'))).not.toContain(fake.token);
  });

  it('GET with an API key needs brain:read; writes stay under the projects rule; the openapi document names every route', () => {
    expect(routePolicy('GET', '/api/projects/p/brain/notion')).toEqual({ scope: 'brain:read' });
    expect(routePolicy('POST', '/api/projects/p/brain/notion')).toEqual({ scope: 'workflows:write' });
    expect(routePolicy('DELETE', '/api/projects/p/brain/notion')).toEqual({ scope: 'workflows:write' });
    expect(routePolicy('GET', '/api/projects/p/brain/notion/problems')).toEqual({ scope: 'brain:read' });
    const paths = (openApiDocument('http://notion-links.test') as { paths: Record<string, Record<string, unknown>> }).paths;
    expect(Object.keys(paths['/api/projects/{id}/brain/notion'])).toEqual(expect.arrayContaining(['get', 'post', 'patch', 'delete']));
    expect(paths).toHaveProperty(['/api/projects/{id}/brain/notion/check']);
    expect(paths).toHaveProperty(['/api/projects/{id}/brain/notion/sync']);
    expect(paths).toHaveProperty(['/api/projects/{id}/brain/notion/problems']);
    expect(paths).toHaveProperty(['/api/projects/{id}/brain/notion/problems/{problemId}']);
  });

  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('the five copies equal contracts/nb', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const src = join(__dirname, '..', 'src', 'lib');
    const same = (copy: string, contract: string) => expect(readFileSync(copy, 'utf8')).toBe(readFileSync(join(dir, 'nb', contract), 'utf8'));
    same(join(src, 'shared', 'notion-brain.ts'), 'notion-brain.ts');
    same(join(src, 'shared', 'brain-store.ts'), 'brain-store.ts');
    same(join(src, 'server', 'brain', 'store', 'port.ts'), 'brain-store-port.ts');
    same(join(src, 'server', 'notion', 'port.ts'), 'notion-port.ts');
    same(join(__dirname, 'fake-notion.ts'), 'fake-notion.ts');
  });
});
