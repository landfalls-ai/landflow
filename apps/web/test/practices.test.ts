/**
 * Practices (docs/practices.md): drafting and taint, who approves, versions and the hash, visibility between projects,
 * handles, reject, retire, waivers and LANDFLOW_PRACTICES=off. Routes are called as the synthetic owner, an admin and
 * members; an API key is a request with its bearer token.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PracticeDetailResponse, PracticesResponse, PracticeView, PracticeVersion } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const listRoute = await import('@/app/api/practices/route');
const itemRoute = await import('@/app/api/practices/[id]/route');
const approveRoute = await import('@/app/api/practices/[id]/approve/route');
const retireRoute = await import('@/app/api/practices/[id]/retire/route');
const waiversRoute = await import('@/app/api/practices/[id]/waivers/route');
const applicationsRoute = await import('@/app/api/practices/[id]/applications/route');
const rejectRoute = await import('@/app/api/practices/[id]/versions/[version]/reject/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const { practicesPort } = await import('@/lib/server/practices/port');
await import('@/lib/server/practices/register');
const { hashFields } = await import('@/lib/server/practices/store');

const owner = await createUser({ email: 'owner@prac.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const admin = await createUser({ email: 'admin@prac.test', name: 'Admin', role: 'admin', password: 'admin-password-1' });
const member = await createUser({ email: 'member@prac.test', name: 'Member', role: 'member', password: 'member-password-1' });
const padmin = await createUser({ email: 'padmin@prac.test', name: 'Project Admin', role: 'member', password: 'padmin-password-1' });
const viewer = await createUser({ email: 'viewer@prac.test', name: 'Viewer', role: 'member', password: 'viewer-password-1' });
const outsider = await createUser({ email: 'editor2@prac.test', name: 'Other Editor', role: 'member', password: 'editor-password-1' });

const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
const beta = projects.createTeamProject({ name: 'Beta' }).id;
projects.setMember(alpha, padmin.id, 'admin');
projects.setMember(alpha, viewer.id, 'viewer');
projects.setMember(beta, outsider.id, 'editor');

afterAll(() => {
  enableTestAuth();
  delete process.env.LANDFLOW_PRACTICES;
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type User = typeof owner;
const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://prac.test${url}`, { method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const bearer = (user: User, scopes: Array<'brain:read' | 'brain:write' | 'admin'> = ['brain:write']) => ({ authorization: `Bearer ${createApiKey(user, { label: 'k', scopes }).token}` });
const as = (user: User) => enableTestAuth(user);
const idOf = (id: string) => ({ params: Promise.resolve({ id }) });

const draftBody = (over: Record<string, unknown> = {}) => ({
  handle: 'helm/chart-location',
  level: 'org',
  title: 'Charts live under deploy/helm',
  strength: 'required',
  topics: ['helm'],
  repos: [],
  paths: ['deploy/helm/**'],
  summary: 'Charts live in deploy/helm/<service>/',
  body: 'Put each service chart in deploy/helm/<service>/.',
  ...over,
});
let seq = 0;
const handle = () => `team/rule-${++seq}`;

const draft = async (user: User, over: Record<string, unknown> = {}, headers?: Record<string, string>) => {
  as(user);
  const response = await listRoute.POST(req('POST', '/api/practices', draftBody({ handle: handle(), topics: [`topic-${seq}`], ...over }), headers));
  return { status: response.status, body: (await response.json()) as { practice: PracticeView; version: PracticeVersion; error?: string; code?: string } };
};
const approve = async (user: User, id: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
  as(user);
  const response = await approveRoute.POST(req('POST', `/api/practices/${id}/approve`, body, headers), idOf(id));
  return { status: response.status, body: (await response.json()) as { practice?: PracticeView; error?: string; code?: string; conflicts?: Array<{ id: string }> } };
};
const list = async (user: User, query = '') => {
  as(user);
  return (await (await listRoute.GET(req('GET', `/api/practices${query}`))).json()) as PracticesResponse;
};
const detail = async (user: User, id: string) => {
  as(user);
  const response = await itemRoute.GET(req('GET', `/api/practices/${id}`), idOf(id));
  return { status: response.status, body: (await response.json()) as PracticeDetailResponse };
};
const approvedHandles = () => practicesPort()!.approved({ projectIds: 'all' }).map((p) => p.handle);

describe('drafting and taint', () => {
  it('marks a session draft as a person’s and an API key draft as tainted', async () => {
    const byPerson = await draft(member);
    expect(byPerson.status).toBe(201);
    expect(byPerson.body.version).toMatchObject({ version: 1, source: 'person', tainted: false });
    expect(byPerson.body.practice).toMatchObject({ status: 'draft', level: 'org', canApprove: false, canDraft: true });

    const cited = { repo: 'acme/web', sha: 'abc1234', path: 'CLAUDE.md', excerpt: 'Charts live in deploy/helm.' };
    const learned = await draft(member, { citations: [cited] }, bearer(member));
    expect(learned.body.version).toMatchObject({ source: 'learned', tainted: true });
    expect(learned.body.version.citations[0]).toMatchObject({ verified: false });
    const agent = await draft(member, {}, bearer(member));
    expect(agent.body.version).toMatchObject({ source: 'agent', tainted: true });
  });

  it('refuses a key without brain:write and cleans what it keeps', async () => {
    as(member);
    const readOnly = await listRoute.POST(req('POST', '/api/practices', draftBody({ handle: handle() }), bearer(member, ['brain:read'])));
    expect(readOnly.status).toBe(403);
    const dirty = await draft(member, { title: 'Use  key sk-ant-api03-abcdefghijklmnopqrstuvwxyz\nnow', topics: ['helm', 'helm', 'devops'], paths: ['b/**', 'a/**'] });
    expect(dirty.status).toBe(201);
    expect(dirty.body.version.title).not.toContain('sk-ant');
    expect(dirty.body.version.title).not.toContain('\n');
    expect(dirty.body.version.topics).toEqual(['devops', 'helm']);
    expect(dirty.body.version.paths).toEqual(['a/**', 'b/**']);
  });

  it('answers 400 for a bad handle, an unknown project, a bad regular expression and an org practice with a project', async () => {
    expect((await draft(member, { handle: 'Not Valid' })).status).toBe(400);
    expect((await draft(member, { level: 'project' })).status).toBe(400);
    expect((await draft(member, { level: 'org', projectId: alpha })).status).toBe(400);
    expect((await draft(owner, { level: 'project', projectId: 'prj_missing' })).status).toBe(404);
    const bad = await draft(member, { checks: [{ kind: 'fileMatches', glob: '**/*.ts', pattern: '(' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('pattern');
  });
});

describe('approval, versions and the hash', () => {
  it('lets the owner and an admin approve, not a member or an API key', async () => {
    const made = await draft(member);
    const id = made.body.practice.id;
    expect((await approve(member, id, { version: 1 })).status).toBe(403);
    expect((await approve(owner, id, { version: 1 }, bearer(owner, ['admin']))).status).toBe(403);
    expect(approvedHandles()).not.toContain(made.body.practice.handle);

    const done = await approve(admin, id, { version: 1 });
    expect(done.status).toBe(200);
    expect(done.body.practice).toMatchObject({ status: 'approved', approvedVersion: 1 });
    expect(approvedHandles()).toContain(made.body.practice.handle);
    expect((await approve(admin, id, { version: 1 })).status).toBe(400);
  });

  it('makes a PATCH a new draft while approved() still returns version 1 with its hash', async () => {
    const made = await draft(member);
    const id = made.body.practice.id;
    await approve(owner, id, { version: 1 });
    as(member);
    const patched = await itemRoute.PATCH(req('PATCH', `/api/practices/${id}`, { body: 'A new rule text.' }), idOf(id));
    expect(patched.status).toBe(201);
    const next = (await patched.json()) as { version: PracticeVersion; practice: PracticeView };
    expect(next.version).toMatchObject({ version: 2, body: 'A new rule text.' });
    expect(next.practice.approvedVersion).toBe(1);

    const [row] = practicesPort()!.approved({ projectIds: [] }).filter((p) => p.id === id);
    expect(row).toMatchObject({ version: 1, body: made.body.version.body });
    expect(row.sha256).toBe(made.body.version.sha256);
    expect(row.sha256).toBe(hashFields(made.body.version));
    const seen = await detail(owner, id);
    expect(seen.body.versions.map((v) => [v.version, v.state])).toEqual([[2, 'pending'], [1, 'approved']]);
  });

  it('leaves out a version edited behind the store', async () => {
    const made = await draft(member);
    const id = made.body.practice.id;
    await approve(owner, id, { version: 1 });
    expect(approvedHandles()).toContain(made.body.practice.handle);
    const row = database().get<Record<string, string | number>>('SELECT * FROM practice_versions WHERE practice_id = ? AND version = 1', id)!;
    database().upsert('practice_versions', { ...row, body: 'Changed in the database.' });
    expect(approvedHandles()).not.toContain(made.body.practice.handle);
  });

  it('refuses an edit that changes nothing the caller sent', async () => {
    const made = await draft(member);
    as(member);
    const empty = await itemRoute.PATCH(req('PATCH', `/api/practices/${made.body.practice.id}`, {}), idOf(made.body.practice.id));
    expect(empty.status).toBe(400);
  });
});

describe('project practices and visibility', () => {
  it('lets the project admin approve; others neither see nor approve; a viewer sees approved, not drafts', async () => {
    const made = await draft(owner, { level: 'project', projectId: alpha, handle: 'alpha/rule' });
    expect(made.status).toBe(201);
    const id = made.body.practice.id;

    expect((await detail(outsider, id)).status).toBe(404);
    expect((await approve(outsider, id, { version: 1 })).status).toBe(404);
    expect((await detail(viewer, id)).status).toBe(404);
    expect((await detail(padmin, id)).status).toBe(200);

    expect((await approve(padmin, id, { version: 1 })).status).toBe(200);
    expect((await detail(viewer, id)).status).toBe(200);
    expect((await list(outsider)).practices.map((p) => p.id)).not.toContain(id);
    expect((await list(viewer)).practices.map((p) => p.id)).toContain(id);
    expect(practicesPort()!.approved({ projectIds: [alpha] }).map((p) => p.id)).toContain(id);
    expect(practicesPort()!.approved({ projectIds: [beta] }).map((p) => p.id)).not.toContain(id);

    as(padmin);
    const second = await itemRoute.PATCH(req('PATCH', `/api/practices/${id}`, { summary: 'Newer summary' }), idOf(id));
    expect(second.status).toBe(201);
    expect((await detail(viewer, id)).body.practice.drafts).toEqual([]);
    expect((await detail(padmin, id)).body.practice.drafts).toHaveLength(1);
  });

  it('keeps one editor’s drafts from another project’s editor, and refuses drafting without a role', async () => {
    const mine = await draft(outsider, { level: 'project', projectId: beta, handle: 'beta/rule' });
    expect(mine.status).toBe(201);
    expect((await detail(padmin, mine.body.practice.id)).status).toBe(404);
    expect((await detail(outsider, mine.body.practice.id)).status).toBe(200);
    expect((await draft(outsider, { level: 'project', projectId: alpha, handle: 'alpha/other' })).status).toBe(403);
    expect((await draft(viewer, { level: 'project', projectId: alpha, handle: 'alpha/viewer' })).status).toBe(403);
  });

  it('keeps a handle unique per level and project', async () => {
    expect((await draft(member, { handle: 'team/shared' })).status).toBe(201);
    expect((await draft(member, { handle: 'team/shared' })).status).toBe(409);
    expect((await draft(owner, { handle: 'team/shared', level: 'project', projectId: alpha })).status).toBe(201);
    expect((await draft(outsider, { handle: 'team/shared', level: 'project', projectId: beta })).status).toBe(201);
    expect((await draft(owner, { handle: 'team/shared', level: 'project', projectId: alpha })).status).toBe(409);
  });
});

describe('reject, retire and waivers', () => {
  it('rejects with a reason of 10 to 500 characters and retires', async () => {
    const made = await draft(member);
    const id = made.body.practice.id;
    as(owner);
    const short = await rejectRoute.POST(req('POST', `/api/practices/${id}/versions/1/reject`, { reason: 'too short' }), { params: Promise.resolve({ id, version: '1' }) });
    expect(short.status).toBe(400);
    as(member);
    const denied = await rejectRoute.POST(req('POST', `/api/practices/${id}/versions/1/reject`, { reason: 'not for a member' }), { params: Promise.resolve({ id, version: '1' }) });
    expect(denied.status).toBe(403);
    as(owner);
    const rejected = await rejectRoute.POST(req('POST', `/api/practices/${id}/versions/1/reject`, { reason: 'Contradicts our runbook' }), { params: Promise.resolve({ id, version: '1' }) });
    expect(rejected.status).toBe(200);
    expect((await detail(owner, id)).body.versions[0]).toMatchObject({ state: 'rejected', rejectReason: 'Contradicts our runbook' });
    expect((await approve(owner, id, { version: 1 })).status).toBe(400);

    const other = await draft(member);
    await approve(owner, other.body.practice.id, { version: 1 });
    as(member);
    expect((await retireRoute.POST(req('POST', '/x'), idOf(other.body.practice.id))).status).toBe(403);
    as(owner);
    const retired = await retireRoute.POST(req('POST', '/x'), idOf(other.body.practice.id));
    expect(((await retired.json()) as { practice: PracticeView }).practice.status).toBe('retired');
    expect(approvedHandles()).not.toContain(other.body.practice.handle);
    expect((await list(owner, '?status=retired')).practices.map((p) => p.id)).toContain(other.body.practice.id);
  });

  it('waives for a run the caller can read, once', async () => {
    const made = await draft(member);
    const id = made.body.practice.id;
    await approve(owner, id, { version: 1 });
    as(owner);
    const created = await workflowsRoute.POST(req('POST', '/api/workflows', { name: 'Flow', nodes: [], connections: [] }));
    const workflowId = ((await created.json()) as { workflow: { id: string } }).workflow.id;
    const now = new Date().toISOString();
    database().upsert('executions', { id: 'exec_waive_1', workflow_id: workflowId, status: 'success', mode: 'manual', started_at: now, finished_at: now, duration_ms: 1, summary: '{}', data: '{}' });

    const waive = async (user: User, body: Record<string, unknown>) => {
      as(user);
      const response = await waiversRoute.POST(req('POST', `/api/practices/${id}/waivers`, body), idOf(id));
      return { status: response.status, body: (await response.json()) as { application?: { id: string; kind: string; reason: string } } };
    };
    expect((await waive(member, { executionId: 'exec_waive_1', version: 1, reason: 'A member may not waive' })).status).toBe(403);
    expect((await waive(owner, { executionId: 'exec_missing', version: 1, reason: 'There is no such run' })).status).toBe(404);
    expect((await waive(owner, { executionId: 'exec_waive_1', version: 1, reason: 'short' })).status).toBe(400);
    expect((await waive(owner, { executionId: 'exec_waive_1', version: 7, reason: 'There is no version 7' })).status).toBe(400);
    const first = await waive(owner, { executionId: 'exec_waive_1', version: 1, reason: 'A one-off hotfix, approved by the lead' });
    expect(first.status).toBe(201);
    expect(first.body.application).toMatchObject({ kind: 'waived', reason: 'A one-off hotfix, approved by the lead' });
    const again = await waive(owner, { executionId: 'exec_waive_1', version: 1, reason: 'Waived a second time' });
    expect(again.body.application!.id).toBe(first.body.application!.id);

    as(owner);
    const page = (await (await applicationsRoute.GET(req('GET', `/api/practices/${id}/applications`), idOf(id))).json()) as { applications: Array<{ kind: string; userId?: string }> };
    expect(page.applications).toHaveLength(1);
    expect(page.applications[0].userId).toBe(owner.id);
    as(member);
    const seen = (await (await applicationsRoute.GET(req('GET', `/api/practices/${id}/applications`), idOf(id))).json()) as { applications: Array<{ userId?: string }> };
    expect(seen.applications[0].userId).toBeUndefined();
  });
});

describe('the port', () => {
  it('is set by importing practices/register', () => {
    expect(practicesPort()).toBeDefined();
  });

  it('returns nothing when LANDFLOW_PRACTICES is off, while drafting and approving still work', async () => {
    const made = await draft(member);
    process.env.LANDFLOW_PRACTICES = 'off';
    try {
      expect(practicesPort()!.enabled()).toBe(false);
      expect((await approve(owner, made.body.practice.id, { version: 1 })).status).toBe(200);
      expect(practicesPort()!.approved({ projectIds: 'all' })).toEqual([]);
      expect((await draft(member)).status).toBe(201);
    } finally {
      delete process.env.LANDFLOW_PRACTICES;
    }
    expect(approvedHandles()).toContain(made.body.practice.handle);
  });

  it('records applications without throwing', () => {
    expect(() => practicesPort()!.record({ practiceId: 'prc_missing', version: 1, kind: 'delivered' })).not.toThrow();
  });
});
