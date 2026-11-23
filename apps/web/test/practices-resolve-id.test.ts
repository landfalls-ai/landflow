/**
 * GET /api/practices/resolve?id= (docs/practices.md#the-api): a practice read back by the id its listing named, only within the
 * scope the listing used. A fake port; no model, no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedPractice } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-resolve-id-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
await import('@/lib/server/practices/register');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const resolveRoute = await import('@/app/api/practices/resolve/route');
const applicableRoute = await import('@/app/api/practices/applicable/route');

const alice = await createUser({ email: 'alice@practices-resolve-id.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@practices-resolve-id.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const mine = createTeamProject({ name: 'Billing', createdBy: alice.id });
const theirs = createTeamProject({ name: 'Search', createdBy: bob.id });
setMember(mine.id, alice.id, 'editor');
setMember(theirs.id, bob.id, 'editor');

const practice = (id: string, handle: string, extra: Partial<ApprovedPractice> = {}): ApprovedPractice => ({
  id,
  handle,
  title: handle,
  level: 'org',
  strength: 'required',
  topics: [],
  repos: [],
  paths: [],
  version: 1,
  summary: `Rule ${handle}`,
  body: `Body of ${handle}`,
  checks: [{ kind: 'pathAbsent', glob: 'secrets/**' }],
  sha256: 'x',
  approvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const all = [
  practice('prc_org', 'shared/rule', { body: 'The org rule' }),
  practice('prc_mine', 'shared/rule', { level: 'project', projectId: mine.id, repos: ['acme/billing'], body: 'The project rule' }),
  practice('prc_charts', 'helm/charts', { level: 'project', projectId: mine.id, repos: ['acme/billing'], paths: ['charts/**'] }),
  practice('prc_theirs', 'search/only', { level: 'project', projectId: theirs.id }),
];
setPracticesPort({
  enabled: () => true,
  draft: () => {
    throw new Error('not used');
  },
  approved: ({ projectIds }) => all.filter((p) => p.level === 'org' || (projectIds !== 'all' && projectIds.includes(p.projectId!))),
  record: () => undefined,
});

afterAll(() => {
  setPracticesPort(undefined);
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => enableTestAuth(alice));

const get = async (query: string) => {
  const response = await resolveRoute.GET(new Request(`http://localhost/api/practices/resolve${query}`));
  return { status: response.status, body: (await response.json()) as { practice?: { handle: string; body: string }; error?: string } };
};

describe('GET /api/practices/resolve?id=', () => {
  it('gives the practice the listing named, for the listing’s scope', async () => {
    const listed = await applicableRoute.GET(new Request('http://localhost/api/practices/applicable?repo=acme/billing&path=charts/web/Chart.yaml&preview=1'));
    const { practices } = (await listed.json()) as { practices: Array<{ id: string; projectId?: string; handle: string }> };
    expect(practices.map((p) => p.id).sort()).toEqual(['prc_charts', 'prc_mine']);
    expect(practices.find((p) => p.id === 'prc_mine')?.projectId).toBe(mine.id);
    expect(practices.every((p) => typeof p.id === 'string')).toBe(true);
    const one = await get('?id=prc_mine&repo=acme/billing&path=charts/web/Chart.yaml');
    expect(one.status).toBe(200);
    expect(one.body.practice).toMatchObject({ handle: 'shared/rule', body: 'The project rule' });
  });

  it('the org practice by its id, where the project’s of the same handle stands in for it, is 404', async () => {
    expect((await get('?id=prc_org')).status).toBe(200);
    expect((await get('?id=prc_org&repo=acme/billing')).status).toBe(404);
  });

  it('another repository or a path the practice does not cover is 404', async () => {
    expect((await get('?id=prc_mine&repo=acme/other')).status).toBe(404);
    expect((await get('?id=prc_mine')).status).toBe(404);
    expect((await get('?id=prc_charts&repo=acme/billing&path=src/a.ts')).status).toBe(404);
    expect((await get('?id=prc_charts&repo=acme/billing&path=charts/a.yaml')).status).toBe(200);
  });

  it('another project’s practice is 404, and so is an unknown id', async () => {
    expect((await get('?id=prc_theirs')).status).toBe(404);
    expect((await get('?id=prc_nothing')).status).toBe(404);
  });

  it('handle and id together are 400, and so are neither', async () => {
    expect((await get('?id=prc_org&handle=shared/rule')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    expect((await get('?id=not-an-id')).status).toBe(400);
  });

  it('by handle is unchanged', async () => {
    expect((await get('?handle=shared/rule')).body.practice?.body).toBe('The org rule');
    expect((await get('?handle=shared/rule&repo=acme/billing')).body.practice?.body).toBe('The project rule');
  });
});
