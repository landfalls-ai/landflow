/**
 * GET /api/practices/resolve (docs/practices.md): one approved practice in full, the way delivery and MCP practice_get pick it: the
 * off switch, redaction, the project practice over an org one that shares its handle, and what a caller may get.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovedPractice } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-resolve-'));
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
const resolveRoute = await import('@/app/api/practices/resolve/route');

const alice = await createUser({ email: 'alice@practices-resolve.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@practices-resolve.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const p1 = createTeamProject({ name: 'Billing', createdBy: alice.id });
const p2 = createTeamProject({ name: 'Search', createdBy: bob.id });
setMember(p1.id, alice.id, 'editor');
setMember(p2.id, bob.id, 'editor');

const practice = (handle: string, extra: Partial<ApprovedPractice> = {}): ApprovedPractice => ({
  id: `prc_${handle.replace('/', '_')}_${extra.level ?? 'org'}`,
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
  practice('shared/rule', { body: 'The org rule' }),
  practice('shared/rule', { level: 'project', projectId: p1.id, body: 'The project rule', repos: ['acme/billing'] }),
  practice('org/secret', { body: 'Use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 never', checks: [{ kind: 'pathExists', glob: 'README.md' }] }),
  practice('p2/only', { level: 'project', projectId: p2.id }),
];
let enabled = true;
setPracticesPort({
  enabled: () => enabled,
  draft: () => {
    throw new Error('not used');
  },
  approved: ({ projectIds }) => (enabled ? all.filter((p) => p.level === 'org' || (projectIds !== 'all' && projectIds.includes(p.projectId!))) : []),
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
beforeEach(() => {
  enabled = true;
  enableTestAuth();
});

type Full = { practice: { handle: string; version: number; body: string; scope: { level: string }; checks: unknown[] } };
const get = async (query: string) => {
  const response = await resolveRoute.GET(new Request(`http://localhost/api/practices/resolve${query}`));
  return { status: response.status, body: (await response.json()) as Full };
};

describe('GET /api/practices/resolve', () => {
  it('gives the body and machine checks of an approved practice', async () => {
    enableTestAuth(alice);
    const { status, body } = await get('?handle=org/secret');
    expect(status).toBe(200);
    expect(body.practice.checks).toHaveLength(1);
    expect(body.practice.body).toContain('Use token');
  });

  it('redacts a secret in the body', async () => {
    enableTestAuth(alice);
    const { body } = await get('?handle=org/secret');
    expect(body.practice.body).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('LANDFLOW_PRACTICES=off gives no body at all', async () => {
    enabled = false;
    enableTestAuth(alice);
    const response = await resolveRoute.GET(new Request('http://localhost/api/practices/resolve?handle=org/secret'));
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('Use token');
  });

  it('an org and a project practice that share a handle and a version: the project one wins, and level picks either', async () => {
    enableTestAuth(alice);
    // Delivery without a repository gives the organization's practice only; with the repository, the project's stands in for it.
    expect((await get('?handle=shared/rule')).body.practice.body).toBe('The org rule');
    expect((await get('?handle=shared/rule&repo=acme/billing')).body.practice.body).toBe('The project rule');
    expect((await get(`?handle=shared/rule&projectId=${p1.id}`)).body.practice.scope.level).toBe('project');
    expect((await get('?handle=shared/rule&level=org')).body.practice.body).toBe('The org rule');
    expect((await get('?handle=shared/rule&level=project')).body.practice.body).toBe('The project rule');
  });

  it('never gives another project’s practice', async () => {
    enableTestAuth(alice);
    expect((await get('?handle=p2/only')).status).toBe(404);
    expect((await get(`?handle=p2/only&projectId=${p2.id}`)).status).toBe(404);
  });

  it('is 404 for an unknown handle and 400 for a bad one', async () => {
    enableTestAuth(alice);
    expect((await get('?handle=no/such')).status).toBe(404);
    expect((await get('?handle=Bad Handle')).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });
});
