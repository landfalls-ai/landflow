/**
 * GET /api/practices/applicable and POST /api/practices/cite (docs/practices.md): what a caller may get, the sizes, the
 * off switch, delivery rows and citing. A fake port with made-up practices in two projects.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRACTICE_BUDGETS, PRACTICES_TRAILER, type ApprovedPractice } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-applicable-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setMember, setHomeProject } = await import('@/lib/server/projects/store');
const { authDb } = await import('@/lib/server/auth/db');
// The host boots lazily on the first route call and its runtime imports practices/register, which sets the store's port;
// load it first so the fake port below (set after it) is the one the routes read.
await import('@/lib/server/practices/register');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { parseCitations } = await import('@/lib/server/practices/cite');
const applicableRoute = await import('@/app/api/practices/applicable/route');
const citeRoute = await import('@/app/api/practices/cite/route');

const alice = await createUser({ email: 'alice@practices-applicable.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@practices-applicable.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const p1 = createTeamProject({ name: 'Billing', createdBy: alice.id });
const p2 = createTeamProject({ name: 'Search', createdBy: bob.id });
setMember(p1.id, alice.id, 'editor');
setMember(p2.id, bob.id, 'editor');

const practice = (handle: string, extra: Partial<ApprovedPractice> = {}): ApprovedPractice => ({
  id: `prc_${handle.replace('/', '_')}`,
  handle,
  title: handle,
  level: 'org',
  strength: 'recommended',
  topics: [],
  repos: [],
  paths: [],
  version: 2,
  summary: `Rule ${handle}`,
  body: 'Body',
  checks: [],
  sha256: 'x',
  approvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const all = [
  practice('org/everywhere'),
  practice('p1/billing', { level: 'project', projectId: p1.id, repos: ['acme/billing'] }),
  practice('p1/open', { level: 'project', projectId: p1.id }),
  practice('p2/search', { level: 'project', projectId: p2.id, repos: ['acme/search'] }),
  practice('p2/open', { level: 'project', projectId: p2.id }),
];
let enabled = true;
const recorded: Array<Record<string, unknown>> = [];
const askedScopes: Array<readonly string[] | 'all'> = [];
setPracticesPort({
  enabled: () => enabled,
  draft: () => {
    throw new Error('not used');
  },
  approved: ({ projectIds }) => {
    askedScopes.push(projectIds);
    return enabled ? all.filter((p) => p.level === 'org' || (projectIds !== 'all' && projectIds.includes(p.projectId!))) : [];
  },
  record: (row) => void recorded.push({ ...row }),
});

afterAll(() => {
  setPracticesPort(undefined);
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  enabled = true;
  recorded.length = 0;
  askedScopes.length = 0;
  enableTestAuth();
});

const asUser = (user: typeof alice) => enableTestAuth(user);
const get = async (query: string) => {
  const response = await applicableRoute.GET(new Request(`http://localhost/api/practices/applicable${query}`));
  return { status: response.status, body: (await response.json()) as { practices: Array<{ handle: string }>; text: string; budget: number; omitted: number } };
};
const post = async (body: unknown) => {
  const response = await citeRoute.POST(new Request('http://localhost/api/practices/cite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as { recorded: string[]; unknown: string[] } };
};
const handles = (body: { practices: Array<{ handle: string }> }) => body.practices.map((p) => p.handle).sort();

describe('what a caller may get', () => {
  it('a member never gets another project’s practices, with or without projectId, repo or path', async () => {
    asUser(alice);
    expect(handles((await get('')).body)).toEqual(['org/everywhere']);
    expect(handles((await get('?repo=acme/billing')).body)).toEqual(['org/everywhere', 'p1/billing']);
    expect(handles((await get('?repo=acme/search&path=src/a.ts')).body)).toEqual(['org/everywhere']);
    expect(handles((await get(`?projectId=${p1.id}`)).body)).toEqual(['org/everywhere', 'p1/open']);
    expect(handles((await get(`?projectId=${p1.id}&repo=acme/billing`)).body)).toEqual(['org/everywhere', 'p1/billing', 'p1/open']);
    for (const ids of askedScopes) expect(ids).not.toBe('all');
    for (const ids of askedScopes) expect(ids).not.toContain(p2.id);
  });

  it('a project the caller is not in is 404', async () => {
    asUser(alice);
    const response = await get(`?projectId=${p2.id}`);
    expect(response.status).toBe(404);
    expect((await get('?projectId=nope')).status).toBe(404);
  });

  it('owners and admins get any project, but never as all', async () => {
    enableTestAuth(TEST_OWNER);
    expect(handles((await get('?repo=acme/search')).body)).toEqual(['org/everywhere', 'p2/search']);
    expect(handles((await get(`?projectId=${p2.id}`)).body)).toEqual(['org/everywhere', 'p2/open']);
    for (const ids of askedScopes) expect(ids).not.toBe('all');
  });

  it('paths and topics only narrow', async () => {
    asUser(alice);
    expect((await get('?topic=helm')).body.practices).toEqual([]);
    expect((await get(`?projectId=${p1.id}&path=docs/a.md`)).body.practices).toHaveLength(2);
  });

  it('refuses bad input', async () => {
    expect((await get('?size=huge')).status).toBe(400);
    expect((await get(`?task=${'x'.repeat(501)}`)).status).toBe(400);
    expect((await get('?topic=a&topic=b&topic=c&topic=d&topic=e&topic=f')).status).toBe(400);
    expect((await get(`?${Array.from({ length: 21 }, (_, i) => `path=a${i}`).join('&')}`)).status).toBe(400);
    expect((await get('?repo=not a repo')).status).toBe(400);
  });
});

describe('sizes, the off switch and delivery', () => {
  it('each size gives its budget', async () => {
    asUser(alice);
    expect((await get('')).body.budget).toBe(PRACTICE_BUDGETS.mod);
    expect((await get('?size=mod')).body.budget).toBe(PRACTICE_BUDGETS.mod);
    expect((await get('?size=full')).body.budget).toBe(PRACTICE_BUDGETS.inProcess);
    expect((await get('?size=index')).body.budget).toBe(PRACTICE_BUDGETS.remote);
  });

  it('answers the block with a heading and one line per practice', async () => {
    asUser(alice);
    const { body } = await get('?repo=acme/billing');
    expect(body.text).toContain('- [org/everywhere@2] recommended: Rule org/everywhere');
    expect(body.text).toContain('- [p1/billing@2]');
    expect(body.omitted).toBe(0);
  });

  it('LANDFLOW_PRACTICES=off gives an empty answer', async () => {
    enabled = false;
    asUser(alice);
    expect((await get('?size=index')).body).toEqual({ practices: [], text: '', budget: PRACTICE_BUDGETS.remote, omitted: 0 });
    expect(recorded).toEqual([]);
  });

  it('records a delivered row per included practice, and none with preview=1', async () => {
    asUser(alice);
    await get('?repo=acme/billing');
    expect(recorded.map((r) => [r.practiceId, r.kind, r.userId, r.repo])).toEqual(
      expect.arrayContaining([
        ['prc_org_everywhere', 'delivered', alice.id, 'acme/billing'],
        ['prc_p1_billing', 'delivered', alice.id, 'acme/billing'],
      ]),
    );
    recorded.length = 0;
    await get('?repo=acme/billing&preview=1');
    expect(recorded).toEqual([]);
  });

  it('records only what was included', async () => {
    asUser(alice);
    all.push(practice('org/huge', { summary: 'z'.repeat(300) }), ...Array.from({ length: 10 }, (_, i) => practice(`org/pad${i}`, { summary: 'z'.repeat(250) })));
    try {
      const { body } = await get('?size=index');
      expect(body.omitted).toBeGreaterThan(0);
      expect(recorded).toHaveLength(body.practices.length);
    } finally {
      all.length = 5;
    }
  });
});

describe('citing', () => {
  it('parses the trailer line and commit trailers', () => {
    const text = ['Done.', `${PRACTICES_TRAILER} [helm/chart-location@3], [a/b@1]`, 'Practice: c/d@2', '  Practice: c/d@2', 'Practice: bad'].join('\n');
    expect(parseCitations(text)).toEqual(['helm/chart-location@3', 'a/b@1', 'c/d@2']);
    expect(parseCitations('nothing here')).toEqual([]);
  });

  it('records cited rows for practices the caller may get, versions up to the approved one, and lists the rest as unknown', async () => {
    asUser(alice);
    const { status, body } = await post({ text: `${PRACTICES_TRAILER} [org/everywhere@2], [p1/billing@1], [p2/search@2], [org/everywhere@3], [nope/none@1]`, citations: ['p1/open@2', 'bad'], repo: 'acme/billing' });
    expect(status).toBe(200);
    expect(body.recorded.sort()).toEqual(['org/everywhere@2', 'p1/billing@1', 'p1/open@2']);
    expect(body.unknown.sort()).toEqual(['bad', 'nope/none@1', 'org/everywhere@3', 'p2/search@2'].sort());
    expect(recorded.map((r) => [r.practiceId, r.version, r.kind, r.userId, r.repo]).sort()).toEqual([
      ['prc_org_everywhere', 2, 'cited', alice.id, 'acme/billing'],
      ['prc_p1_billing', 1, 'cited', alice.id, 'acme/billing'],
      ['prc_p1_open', 2, 'cited', alice.id, 'acme/billing'],
    ]);
  });

  it('a handle shared by an organization and a project practice is credited to the one that was delivered', async () => {
    all.push(practice('helm/chart', { version: 5 }), practice('helm/chart', { id: 'prc_helm_chart_p1', level: 'project', projectId: p1.id, repos: ['acme/other'], version: 1 }));
    try {
      asUser(alice);
      const { body } = await post({ citations: ['helm/chart@5', 'helm/chart@1'], repo: 'acme/billing' });
      expect(body.recorded.sort()).toEqual(['helm/chart@1', 'helm/chart@5']);
      expect(recorded.map((r) => [r.practiceId, r.version])).toEqual([['prc_helm_chart', 5], ['prc_helm_chart', 1]]);
    } finally {
      all.splice(-2);
    }
  });

  it('records nothing when practices are off', async () => {
    enabled = false;
    asUser(alice);
    const { body } = await post({ citations: ['org/everywhere@2'] });
    expect(body).toEqual({ recorded: [], unknown: ['org/everywhere@2'] });
    expect(recorded).toEqual([]);
  });

  it('an execution the caller cannot read is 404; one they can is recorded on the row', async () => {
    setHomeProject('workflow', 'wf_practices_p1', p1.id);
    setHomeProject('workflow', 'wf_practices_p2', p2.id);
    const now = new Date().toISOString();
    for (const [id, workflowId] of [['ex_practices_p1', 'wf_practices_p1'], ['ex_practices_p2', 'wf_practices_p2']] as const) {
      authDb().upsert('executions', { id, workflow_id: workflowId, status: 'success', mode: 'manual', started_at: now, duration_ms: 1, summary: '{}', data: '{}' });
    }
    asUser(alice);
    expect((await post({ citations: ['org/everywhere@2'], executionId: 'ex_practices_p2' })).status).toBe(404);
    expect((await post({ citations: ['org/everywhere@2'], executionId: 'ex_missing' })).status).toBe(404);
    expect(recorded).toEqual([]);
    expect((await post({ citations: ['org/everywhere@2'], executionId: 'ex_practices_p1' })).status).toBe(200);
    expect(recorded[0]).toMatchObject({ kind: 'cited', executionId: 'ex_practices_p1' });
  });

  it('refuses more than 20 citations and a bad body', async () => {
    expect((await post({ citations: Array.from({ length: 21 }, (_, i) => `a/b@${i + 1}`) })).status).toBe(400);
    expect((await post({ repo: 'not a repo' })).status).toBe(400);
  });
});
