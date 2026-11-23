/**
 * Wave nb3's joins (backbone/contracts/nb/README.md §8, N1–N7): NB07's Brain card and Brain-page fields and NB08's Spotlight
 * turn and brain MCP, each on its real side, over wave nb1's and nb2's seams. As in nb2's joins, the test loads
 * `@/lib/server/runtime` for the brain store, the `notion brain` service, the pull and the knowledge steps (it checks that
 * `SERVICES` names `notion brain` before it imports `service.ts` for `tickOnce`); the Notion client is NB02's real `client.ts`
 * with a `productivity.notionApi` credential whose `baseUrl` is the local fake's URL; routes are called as the synthetic owner
 * (an editor or a member where named). The browser's client contract (`lib/client/notion-brain.ts`) and Spotlight's turn reach
 * the real route handlers through a `fetch` shim; any other URL (the fake on 127.0.0.1) goes to the real fetch. No model is
 * needed. Nothing here reaches api.notion.com or leaves 127.0.0.1.
 *
 * Each join fails with its seam cut (checked by hand at integration, see docs/history.md): N1 with `wiki.ts`'s Notion line,
 * `brain-tools.ts`'s `notionUrl` lines, or `urls.ts` ignoring `detached`; N2 with the problems route without `notionUrl`, or
 * `actionsFor` offering an admin action to an editor; N3 with the PATCH writing the status through `updateLink` (no notice), or
 * keeping a key without checking it; N4 with the check's deadline removed; N5 with NB08 writing its own status words; N6 with
 * `policy.ts` back to the nb2 rule; N7 with a copy that drifts from the contracts folder.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 10_000, hookTimeout: 120_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb3-joins-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
  LANDFLOW_PUBLIC_URL: 'http://nb3-joins.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The real sides, the sync through the runtime only.
const runtime = await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { withAuth } = await import('@/lib/server/auth/context');
const { TEST_OWNER, enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { routePolicy } = await import('@/lib/server/auth/policy');
const projectsStore = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const { listProposals } = await import('@/lib/server/brain/proposals');
const practices = await import('@/lib/server/practices/store');
const approve = await import('@/lib/server/practices/approve');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { notionClient } = await import('@/lib/server/notion/client');
const { notionClientFor, setNotionClientFactory } = await import('@/lib/server/notion/port');
const { resetLimiters } = await import('@/lib/server/notion/limiter');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const { setCheckDeadline } = await import('@/lib/server/brain/notion/check');
const { notionPageUrl } = await import('@/lib/server/brain/notion/urls');
const { brainPageTitle } = await import('@/lib/shared/notion-brain');
const { notionBrainAsk, hideNotionKeys, HIDDEN_KEY } = await import('@/lib/shared/notion-brain-ask');
const client = await import('@/lib/client/notion-brain');
const { ApiError } = await import('@/lib/client/api');
const { notionBrainReply, KEY_WARNING } = await import('@/components/spotlight/notion-brain-turn');
const linkRoute = await import('@/app/api/projects/[id]/brain/notion/route');
const checkRoute = await import('@/app/api/projects/[id]/brain/notion/check/route');
const syncRoute = await import('@/app/api/projects/[id]/brain/notion/sync/route');
const problemsRoute = await import('@/app/api/projects/[id]/brain/notion/problems/route');
const problemRoute = await import('@/app/api/projects/[id]/brain/notion/problems/[problemId]/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const wikiRoute = await import('@/app/api/brain/wiki/[type]/[id]/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          { name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' },
        ],
      }),
      defineCredentialType({ name: 'githubApi', displayName: 'GitHub', properties: [{ name: 'token', displayName: 'Token', type: 'string', typeOptions: { password: true } }] }),
    ],
  }),
);

const PROJECT = 'Payments nb3';
type UserRecord = Awaited<ReturnType<typeof createUser>>;
let service: typeof import('@/lib/server/brain/notion/service');
let fake: FakeNotion;
let projectId = '';
let credential = '';
let root = '';
let linkId = '';
let customerFact = '';
let editor: UserRecord;
let member: UserRecord;
const EDITOR = { canEdit: true, canManage: false };
const realFetch = globalThis.fetch;
/** Every request the browser's client made, as the shim saw it. */
const shimmed: Array<{ method: string; path: string; body: string }> = [];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const link = () => links.linkById(linkId)!;
const rowOf = (kind: 'entity' | 'fact', key: string) => sync.itemOf(linkId, kind, key)!.notion_id;
const req = (method: string, url: string, body?: unknown) => new Request(`http://nb3-joins.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
async function call(fn: () => Promise<Response>) {
  const response = await fn();
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
/** Runs `fn` as `user` (the route guard's test principal), then as the synthetic owner again. */
async function as<T>(user: UserRecord, fn: () => Promise<T>): Promise<T> {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
const notices = (status: string) => listProposals({ status: 'open', limit: 200 }).filter((p) => p.fingerprint === `notion-brain:${linkId}:${status}`);

/** One tick of the real service, after the brain changes that came before it were heard. */
async function tick() {
  await flush();
  service.resetBackoff();
  await service.tickOnce();
  await flush();
}
/** Sync now (the admin's button), then one tick: the pull and the knowledge walk run. */
async function syncNow() {
  const asked = await call(() => syncRoute.POST(req('POST', `/api/projects/${projectId}/brain/notion/sync`), params({ id: projectId })));
  expect(asked.status).toBe(202);
  await tick();
}

/** The browser's `fetch`: a relative `/api/…` path is the real route handler, called as whoever the guard signs in. */
async function shim(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith('/')) return realFetch(input, init);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : '';
  shimmed.push({ method, path: url, body });
  const { cache: _cache, ...rest } = init;
  const request = new Request(`http://nb3-joins.test${url}`, rest);
  const path = url.split('?')[0];
  const at = (re: RegExp) => path.match(re)?.slice(1).map(decodeURIComponent);
  const handlers = <M extends Record<string, unknown>>(mod: M) => mod[method] as ((r: Request, c?: unknown) => Promise<Response>) | undefined;
  let m: string[] | undefined;
  let found: { fn?: (r: Request, c?: unknown) => Promise<Response>; ctx?: unknown } | undefined;
  if (path === '/api/credentials') found = { fn: handlers(credentialsRoute) };
  else if ((m = at(/^\/api\/projects\/([^/]+)\/brain\/notion$/))) found = { fn: handlers(linkRoute), ctx: params({ id: m[0] }) };
  else if ((m = at(/^\/api\/projects\/([^/]+)\/brain\/notion\/check$/))) found = { fn: handlers(checkRoute), ctx: params({ id: m[0] }) };
  else if ((m = at(/^\/api\/projects\/([^/]+)\/brain\/notion\/sync$/))) found = { fn: handlers(syncRoute), ctx: params({ id: m[0] }) };
  else if ((m = at(/^\/api\/projects\/([^/]+)\/brain\/notion\/problems$/))) found = { fn: handlers(problemsRoute), ctx: params({ id: m[0] }) };
  else if ((m = at(/^\/api\/projects\/([^/]+)\/brain\/notion\/problems\/([^/]+)$/))) found = { fn: handlers(problemRoute), ctx: params({ id: m[0], problemId: m[1] }) };
  if (!found?.fn) throw new Error(`The shim has no route for ${method} ${url}`);
  return found.fn(request, found.ctx);
}

/** The brain's MCP server over the in-memory transport, as the owner with a `brain:read` key. */
async function mcpCall(name: string, args: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer({ id: TEST_OWNER.id, role: 'owner' } as never, undefined, ['brain:read']).connect(serverSide);
  const mcp = new Client({ name: 'nb3-joins', version: '1.0.0' });
  await mcp.connect(clientSide);
  try {
    return JSON.parse(((await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]?.text ?? 'null');
  } finally {
    await mcp.close();
  }
}

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow nb3 bot', workspaceName: 'Joins workspace' });

  // A team project with 1 customer, 1 person, 2 facts (one about the customer) and 1 approved practice; an admin (the owner),
  // an editor and a member.
  editor = await createUser({ email: 'editor@nb3-joins.test', name: 'Editor', role: 'member', password: 'editor-password-1' });
  member = await createUser({ email: 'member@nb3-joins.test', name: 'Member', role: 'member', password: 'member-password-1' });
  projectId = projectsStore.createTeamProject({ name: PROJECT }).id;
  projectsStore.setMember(projectId, editor.id, 'editor');
  projectsStore.setMember(projectId, member.id, 'viewer');
  entities.upsertEntity({ type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank', projectId, description: 'A bank' });
  entities.upsertEntity({ type: 'person', id: 'ana', name: 'Ana', projectId, attrs: { department: 'Sales' } });
  customerFact = facts.upsertFact({ subjectType: 'entity', subjectId: 'customer/kestrel-bank', subjectName: 'Kestrel Bank', kind: 'health', statement: 'Kestrel renews in March', evidence: [], confidence: 0.8, projectId }).id;
  facts.upsertFact({ subjectType: 'entity', subjectId: 'person/ana', subjectName: 'Ana', kind: 'purpose', statement: 'Ana runs the renewals', evidence: [], confidence: 0.8, projectId });
  const person = { source: 'person' as const, actor: { id: TEST_OWNER.id, role: 'owner' as const } };
  const drafted = withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, () =>
    practices.draftPractice({ handle: 'team/charts', title: 'Charts live under deploy/helm', level: 'project', projectId, strength: 'required', topics: ['helm'], repos: [], paths: ['deploy/**'], summary: 'Charts summary', body: 'Rules for charts.' }, person),
  );
  approve.approvePractice({ id: TEST_OWNER.id, role: 'owner' }, drafted.practice.id, { version: 1, reviewedSources: true, conflicts: {} });

  credential = credentials.create({ name: 'Notion nb3 key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  projectsStore.replaceShares('credential', credential, [{ projectId, role: 'user' }]);
  root = fake.addPage({ title: 'Payments wiki', shared: true });

  // The sync is the runtime's: it must be in SERVICES before its module is used for ticks.
  expect(runtime.SERVICES.map((s) => s.name)).toContain('notion brain');
  service = await import('@/lib/server/brain/notion/service');

  const made = await call(() => linkRoute.POST(req('POST', `/api/projects/${projectId}/brain/notion`, { credentialId: credential, page: root, rps: 8 }), params({ id: projectId })));
  expect(made.status).toBe(202);
  linkId = links.getLink(projectId)!.id;
  for (let i = 0; i < 5 && link().status !== 'active'; i++) await tick();
  expect(link().status).toBe('active');
  await syncNow();
  await tick();

  vi.stubGlobal('fetch', shim);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  setCheckDeadline();
  setNotionClientFactory(notionClient);
  enableTestAuth();
  await fake?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('N6: the problems list is a brain read', () => {
  it('the problems list and the link read with brain:read; a problem action and the link’s writes stay workflows:write', () => {
    expect(routePolicy('GET', '/api/projects/p/brain/notion/problems')).toEqual({ scope: 'brain:read' });
    expect(routePolicy('GET', '/api/projects/p/brain/notion')).toEqual({ scope: 'brain:read' });
    expect(routePolicy('POST', '/api/projects/p/brain/notion/problems/x')).toEqual({ scope: 'workflows:write' });
    for (const method of ['POST', 'PATCH', 'DELETE']) expect(routePolicy(method, '/api/projects/p/brain/notion')).toEqual({ scope: 'workflows:write' });
    expect(routePolicy('POST', '/api/projects/p/brain/notion/check')).toEqual({ scope: 'workflows:write' });
    expect(routePolicy('POST', '/api/projects/p/brain/notion/sync')).toEqual({ scope: 'workflows:write' });
  });
});

describe('N7: the contract copies', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('urls.ts, lib/client/notion-brain.ts and the nb3 notion-brain.ts equal backbone/contracts/nb, and the nb1 and nb2 copies still do', () => {
    const dir = join(process.env.LANDFLOW_BACKBONE_CONTRACTS!, 'nb');
    const src = join(__dirname, '..', 'src', 'lib');
    const same = (copy: string, contract: string) => expect(readFileSync(copy, 'utf8'), contract).toBe(readFileSync(join(dir, contract), 'utf8'));
    same(join(src, 'server', 'brain', 'notion', 'urls.ts'), 'notion-urls.ts');
    same(join(src, 'client', 'notion-brain.ts'), 'notion-brain-client.ts');
    same(join(src, 'shared', 'notion-brain.ts'), 'notion-brain.ts');
    same(join(src, 'server', 'brain', 'notion', 'sync.ts'), 'sync.ts');
    for (const file of ['input.ts', 'kestrel-bank.md', 'ana.md', 'home.md']) same(join(__dirname, 'fixtures', 'notion-render', file), join('render-fixtures', file));
    same(join(src, 'shared', 'brain-store.ts'), 'brain-store.ts');
    same(join(src, 'server', 'brain', 'store', 'port.ts'), 'brain-store-port.ts');
    same(join(src, 'server', 'notion', 'port.ts'), 'notion-port.ts');
    same(join(__dirname, 'fake-notion.ts'), 'fake-notion.ts');
  });
});

describe('N2: the browser contract against the real routes (lib/client/notion-brain.ts → NB03’s and NB07’s routes)', () => {
  it('keys, check, status, a trashed row’s problem with its link, and the actions an editor may press are what the routes do', async () => {
    // The Notion keys the project may use, by name.
    expect(await client.projectNotionKeys(projectId)).toEqual([{ id: credential, name: 'Notion nb3 key', type: 'productivity.notionApi' }]);
    // The check: the root's title and what a copy would send.
    const checked = await client.checkNotionPage(projectId, { credentialId: credential, page: root });
    expect(checked.title).toBe('Payments wiki');
    expect(checked.counts).toEqual({ pages: 2, facts: 2, practices: 1, notes: 0 });
    expect(checked.existingBrain).toEqual({ found: true, pageId: link().brain_page_id });
    // After the copy, the card's sentence.
    expect(client.statusSentence(await client.notionLink(projectId))).toMatch(/^In sync · synced /);

    // A person trashes a row in Notion: one problem, with its Notion link and Put back.
    const anaRow = rowOf('entity', 'person/ana');
    fake.trash(anaRow);
    await syncNow();
    const problems = await client.notionProblems(projectId);
    expect(problems).toHaveLength(1);
    const [problem] = problems;
    expect(problem.notionUrl).toBe(notionPageUrl(anaRow));
    expect(problem.actions).toContain('putBack');
    const view = await client.notionLink(projectId);
    expect(view.linked && view.problems).toBe(1);
    expect(client.statusAnswer(view, problems)).toContain(problem.detail);

    // A member reads the list (a brain read) and may press nothing.
    expect(await as(member, () => client.notionProblems(projectId))).toHaveLength(1);
    expect(client.actionsFor(problem, { canEdit: false, canManage: false })).toEqual([]);

    // The editor is offered only what the route accepts from an editor.
    const offered = client.actionsFor(problem, EDITOR);
    expect(offered).toEqual(['dismiss', 'putBack']);
    for (const action of problem.actions.filter((a) => !offered.includes(a))) {
      const refused = await as(editor, () => client.actOnNotionProblem(projectId, problem.id, action)).catch((e: unknown) => e);
      expect(refused, action).toBeInstanceOf(ApiError);
      expect((refused as InstanceType<typeof ApiError>).status, action).toBe(403);
    }
    expect(await client.notionProblems(projectId)).toHaveLength(1); // nothing changed
    const put = await as(editor, () => client.actOnNotionProblem(projectId, problem.id, 'putBack'));
    expect(put).toMatchObject({ id: problem.id, resolved: true, action: 'putBack', by: editor.id });
    expect(await client.notionProblems(projectId)).toEqual([]);
    await tick();
  });
});

describe('N5: Spotlight’s answer is the link’s real status (NB08’s notionBrainAsk and notionBrainReply → the client → the real routes)', () => {
  it('the sync question, a link ask naming the root, and a pasted key that is never sent', async () => {
    const question = 'Is this project’s brain in sync with Notion?';
    expect(notionBrainAsk(question)).toEqual({ kind: 'status' });
    const before = client.statusAnswer(await client.notionLink(projectId), await client.notionProblems(projectId));
    const reply = await notionBrainReply(notionBrainAsk(question)!, { projectId });
    const after = client.statusAnswer(await client.notionLink(projectId), await client.notionProblems(projectId));
    expect(reply.kind).toBe('text');
    expect([before, after]).toContain((reply as { text: string }).text);
    expect((reply as { text: string }).text).toMatch(/^The brain is in Notion under “Payments wiki”\. Synced /);

    const rootLink = notionPageUrl(root);
    const asked = notionBrainAsk(`Keep this project’s brain in Notion under ${rootLink}`);
    expect(asked).toEqual({ kind: 'link', page: rootLink });
    const card = await notionBrainReply(asked!, { projectId });
    expect(card).toMatchObject({ kind: 'card', projectId, page: rootLink });
    const data = (card as { data: NonNullable<Extract<typeof card, { kind: 'card' }>['data']> }).data;
    expect(data.keys).toEqual([{ id: credential, name: 'Notion nb3 key', type: 'productivity.notionApi' }]);
    expect(data.preselected?.id).toBe(credential);
    expect(data.canManage).toBe(true);
    // The project is linked: the card shows the status, not a Connect.
    expect(data.link.linked).toBe(true);
    expect(client.statusSentence(data.link)).toMatch(/^In sync · /);

    const key = ['ntn', 'Q7'.repeat(22)].join('_');
    const seen = shimmed.length;
    const pasted = `Here is our key ${key}, keep the brain in Notion`;
    expect(notionBrainAsk(pasted)).toEqual({ kind: 'key' });
    expect(hideNotionKeys(pasted)).toBe(`Here is our key ${HIDDEN_KEY}, keep the brain in Notion`);
    expect(await notionBrainReply(notionBrainAsk(pasted)!, { projectId })).toEqual({ kind: 'key', text: KEY_WARNING, projectId });
    expect(shimmed.length).toBe(seen);
    expect(JSON.stringify(shimmed)).not.toContain(key);
  });
});

describe('N4: the check answers within its deadline (NB07’s check.ts → NB02’s limiter and retries)', () => {
  /** Notion answers 429 with a 30 s Retry-After to what `match` names until released. */
  function stick(match: (method: string, template: string) => boolean) {
    let armed = true;
    fake.failNext({ status: 429, code: 'rate_limited', retryAfter: 30, match: (method, template) => armed && match(method, template) }, 1000);
    return () => void (armed = false);
  }
  let big = '';
  let bare = '';
  let named = '';
  beforeAll(async () => {
    // A root with 25 child pages, each holding a database without `Landflow ID`, and the project's named brain page; and the
    // same without the named page.
    const notion = notionClientFor({ credentialId: credential, rps: 50 });
    big = fake.addPage({ title: 'Big wiki', shared: true });
    bare = fake.addPage({ title: 'Big wiki without a brain', shared: true });
    for (let i = 0; i < 25; i++) {
      for (const [parentId, word] of [[big, 'Team'], [bare, 'Group']] as const) {
        const child = fake.addPage({ parentId, title: `${word} ${i}` });
        await notion.createDatabase({ parent: { page_id: child }, title: `${word} table ${i}`, properties: { Name: { title: {} } } });
      }
    }
    named = fake.addPage({ parentId: big, title: brainPageTitle(PROJECT) });
  });
  const check = (page: string) => call(() => checkRoute.POST(req('POST', `/api/projects/${projectId}/brain/notion/check`, { credentialId: credential, page }), params({ id: projectId })));

  it('answers 200 with the named brain while the deep probe is stuck, 504 when Notion has not said who the key is, one check per project', async () => {
    // NB02's real client, its retry waits on the real clock (unref'd, so a wait left behind at the deadline holds nothing open).
    setNotionClientFactory((options) => notionClient({ ...options, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()) }));
    setCheckDeadline(1500);
    const writes = () => fake.writes().length;
    try {
      resetLimiters();
      const written = writes();

      // The deep probe's reads are stuck: the named brain is still found in time.
      let children = 0;
      let release = stick((method, template) => method === 'GET' && ((template === '/v1/blocks/:id/children' && ++children > 1) || template === '/v1/databases/:id' || template === '/v1/data_sources/:id'));
      let started = Date.now();
      const found = await check(big);
      release();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(found.status).toBe(200);
      expect(found.body.existingBrain).toEqual({ found: true, pageId: named });
      // With no named page the stuck probe is cut at the deadline, and the check answers what it has.
      resetLimiters();
      children = 0;
      release = stick((method, template) => method === 'GET' && ((template === '/v1/blocks/:id/children' && ++children > 1) || template === '/v1/databases/:id' || template === '/v1/data_sources/:id'));
      started = Date.now();
      const none = await check(bare);
      release();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(none.status).toBe(200);
      expect(none.body.existingBrain).toEqual({ found: false });

      // Who the key is is stuck: 504 in time, and nothing written.
      resetLimiters();
      release = stick((_m, template) => template === '/v1/users/me');
      started = Date.now();
      const slow = await check(big);
      release();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(slow.status).toBe(504);
      expect(writes()).toBe(written);

      // Two identical checks at once ask Notion once and get the same answer; another page while one runs is a 409.
      resetLimiters();
      setCheckDeadline();
      const mark = fake.state.requests.length;
      const [a, b, c] = await Promise.all([check(big), check(big), check(bare)]);
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(c.status).toBe(409);
      expect(fake.state.requests.slice(mark).filter((r) => r.template === '/v1/users/me')).toHaveLength(1);
      expect(writes()).toBe(written);
    } finally {
      setCheckDeadline();
      setNotionClientFactory(notionClient);
      resetLimiters();
    }
  });
});

describe('N3: a refused key comes back through the card’s buttons (NB07’s PATCH → NB04’s status.ts)', () => {
  it('a wrong key stops the link with one notice; another good key brings it back with the notice and pushes the queued edit', async () => {
    credentials.update(credential, { data: { apiKey: ['made', 'up', 'wrong', 'key'].join('-'), baseUrl: fake.url } });
    entities.upsertEntity({ type: 'customer', id: 'kestrel-bank', name: 'Kestrel Bank', projectId, description: 'Edited while the key was refused' });
    for (let i = 0; i < 3 && link().status !== 'unauthorized'; i++) await tick();
    expect(link().status).toBe('unauthorized');
    expect(notices('unauthorized')).toHaveLength(1);
    const activeAt = notices('active')[0]?.updatedAt;
    expect(activeAt).toBeTruthy();
    const stopped = link();

    const second = credentials.create({ name: 'Notion nb3 key two', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
    projectsStore.replaceShares('credential', second, [{ projectId, role: 'user' }]);
    const github = credentials.create({ name: 'GitHub', type: 'productivity.githubApi', data: { token: 'x' } }).id;
    projectsStore.replaceShares('credential', github, [{ projectId, role: 'user' }]);

    // A credential of another type, and a key Notion refuses, change nothing.
    for (const credentialId of [github, credential]) {
      const refused = await client.changeNotionLink(projectId, { credentialId }).catch((e: unknown) => e);
      expect(refused, credentialId).toBeInstanceOf(ApiError);
      expect((refused as InstanceType<typeof ApiError>).status, credentialId).toBe(400);
      expect(link()).toEqual(stopped);
    }

    await new Promise((resolve) => setTimeout(resolve, 5)); // the notice's refresh lands in a later millisecond
    const back = await client.changeNotionLink(projectId, { credentialId: second });
    expect(back.status).toBe('active');
    expect(back.credential?.id).toBe(second);
    expect(link()).toMatchObject({ status: 'active', credential_id: second, bot_name: 'Landflow nb3 bot' });
    const active = notices('active');
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe(`The brain is in Notion: ${PROJECT}`);
    expect(Date.parse(active[0].updatedAt)).toBeGreaterThan(Date.parse(activeAt!));

    await tick();
    expect(fake.value(rowOf('entity', 'customer/kestrel-bank'), 'Description')).toBe('Edited while the key was refused');
  });
});

describe('N1: Open in Notion is the same row on the Brain page and over MCP (NB07’s wiki.ts → urls.ts ← NB08’s brain-tools.ts)', () => {
  const wiki = () => call(() => wikiRoute.GET(req('GET', '/api/brain/wiki/customer/kestrel-bank'), params({ type: 'customer', id: 'kestrel-bank' })));
  const searched = async () => ((await mcpCall('brain_search_facts', { query: 'Kestrel renews' })) as { facts: Array<{ id: string; notionUrl?: string }> }).facts;

  it('the page’s and the fact’s Notion rows; none once the row is trashed, and no fact has one after Disconnect', async () => {
    const customerRow = rowOf('entity', 'customer/kestrel-bank');
    const page = await wiki();
    expect(page.status).toBe(200);
    expect(page.body.notion?.url).toBe(notionPageUrl(customerRow));
    const fact = (await searched()).find((f) => f.id === customerFact);
    expect(fact?.notionUrl).toBe(notionPageUrl(rowOf('fact', customerFact)));

    // A person trashes the customer's row: the pull's full listing detaches it, and the page has no Notion link.
    fake.trash(customerRow);
    await syncNow();
    expect(sync.itemOf(linkId, 'entity', 'customer/kestrel-bank')?.state).toBe('detached');
    const detached = await wiki();
    expect(detached.status).toBe(200);
    expect(detached.body.notion).toBeUndefined();

    // Disconnect: no fact carries a Notion link any more.
    expect((await searched()).some((f) => f.notionUrl)).toBe(true);
    const gone = await client.disconnectNotion(projectId);
    expect(gone).toMatchObject({ ok: true, linked: false });
    const after = await searched();
    expect(after.map((f) => f.id)).toContain(customerFact);
    expect(after.some((f) => f.notionUrl)).toBe(false);
  });
});

describe('the key stays in the vault', () => {
  it('no stored link, problem or browser request holds the key', () => {
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_links'))).not.toContain(FAKE_NOTION_TOKEN);
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_problems'))).not.toContain(FAKE_NOTION_TOKEN);
    expect(JSON.stringify(shimmed)).not.toContain(FAKE_NOTION_TOKEN);
  });
});
