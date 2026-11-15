/**
 * GET /api/projects/context and the project's repositories (docs/connect-your-harness.md#project-context): PATCH repos
 * (lowercased, the rule, the cap, admins only), a lookup by repository (the caller's projects only), by id (404 without a
 * role), compact and full, the compact answer equal to the contract's example, and what Spotlight's system text gets.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import example from '@/lib/shared/project-context-example.json';
import { PROJECT_REPOS_MAX, type ProjectContextAnswer } from '@/lib/shared/project-context-api';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-context-api-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setMember, setHomeProject, getProject } = await import('@/lib/server/projects/store');
const { updateProjectBrief } = await import('@/lib/server/projects/store');
const { createGoalAs, setProjectGoalsAs } = await import('@/lib/server/goals/views');
const { builderContextEntry } = await import('@/lib/server/project-context/by-repo');
const { store } = await import('@/lib/server/store');
const { addShare } = await import('@/lib/server/projects/store');
const architectRoute = await import('@/app/api/assistant/agent/route');
const contextRoute = await import('@/app/api/projects/context/route');
const projectRoute = await import('@/app/api/projects/[id]/route');

const alice = await createUser({ email: 'alice@project-context-api.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@project-context-api.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const carol = await createUser({ email: 'carol@project-context-api.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
const owner = { id: TEST_OWNER.id, role: 'owner' as const };

const billing = createTeamProject({ name: 'Billing revamp', createdBy: alice.id });
const checkout = createTeamProject({ name: 'Checkout', createdBy: bob.id });
setMember(billing.id, alice.id, 'editor');
setMember(billing.id, bob.id, 'admin');
setMember(checkout.id, bob.id, 'editor');
updateProjectBrief(billing.id, { brief: 'Move invoices to usage-based pricing without breaking existing plans.' });
const company = createGoalAs(owner, { level: 'company', title: 'Grow paid accounts', status: 'active' });
const goal = createGoalAs(owner, { level: 'project', projectId: billing.id, parentId: company.id, title: 'Ship usage-based billing', status: 'active' });
setProjectGoalsAs(owner, billing.id, [goal.id]);

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const patch = async (id: string, body: unknown) => projectRoute.PATCH(new Request(`http://localhost/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const ask = async (query: string) => {
  const response = await contextRoute.GET(new Request(`http://localhost/api/projects/context?${query}`));
  return { status: response.status, body: (await response.json()) as ProjectContextAnswer };
};

describe('PATCH /api/projects/:id repos', () => {
  it('an admin sets them, lowercased and without duplicates', async () => {
    enableTestAuth(bob);
    const response = await patch(billing.id, { repos: ['Acme/Web', 'acme/web', 'acme/api'] });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { project: { repos: string[] } }).project.repos).toEqual(['acme/web', 'acme/api']);
    expect(getProject(billing.id)?.repos).toEqual(['acme/web', 'acme/api']);
  });

  it('an editor can’t (403)', async () => {
    enableTestAuth(alice);
    expect((await patch(billing.id, { repos: ['acme/web'] })).status).toBe(403);
  });

  it('refuses a name that is not owner/name, and more than the cap', async () => {
    enableTestAuth(bob);
    expect((await patch(billing.id, { repos: ['not a repo'] })).status).toBe(400);
    expect((await patch(billing.id, { repos: ['acme'] })).status).toBe(400);
    expect((await patch(billing.id, { repos: Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => `acme/r${i}`) })).status).toBe(400);
    expect(getProject(billing.id)?.repos).toEqual(['acme/web', 'acme/api']);
  });

  it('[] clears them', async () => {
    enableTestAuth(bob);
    const cleared = createTeamProject({ name: 'Scratch', createdBy: bob.id });
    setMember(cleared.id, bob.id, 'admin');
    await patch(cleared.id, { repos: ['acme/tmp'] });
    expect(getProject(cleared.id)?.repos).toEqual(['acme/tmp']);
    await patch(cleared.id, { repos: [] });
    expect(getProject(cleared.id)?.repos).toBeUndefined();
  });
});

describe('GET /api/projects/context', () => {
  it('seeds the second project', async () => {
    enableTestAuth(bob);
    expect((await patch(billing.id, { repos: ['acme/web'] })).status).toBe(200);
    expect((await patch(checkout.id, { repos: ['Acme/Web'] })).status).toBe(403);
    setMember(checkout.id, bob.id, 'admin');
    expect((await patch(checkout.id, { repos: ['Acme/Web'] })).status).toBe(200);
  });

  it('by repository, a member of one of two listing projects gets that one only', async () => {
    enableTestAuth(alice);
    const { status, body } = await ask('repo=ACME/web');
    expect(status).toBe(200);
    expect(body.projects).toEqual([{ id: billing.id, name: 'Billing revamp' }]);
    expect(body.context?.projectId).toBe(billing.id);
  });

  it('by repository, an owner gets both sorted by name and the first one’s block', async () => {
    enableTestAuth();
    const { body } = await ask('repo=acme/web');
    expect(body.projects.map((p) => p.name)).toEqual(['Billing revamp', 'Checkout']);
    expect(body.context?.projectId).toBe(billing.id);
  });

  it('the compact answer is the contract’s example', async () => {
    enableTestAuth();
    const { body } = await ask('repo=acme/web&size=compact');
    const withExampleIds = JSON.parse(JSON.stringify(body).replaceAll(billing.id, 'prj_billing01').replaceAll(checkout.id, 'prj_checkout1'));
    expect(withExampleIds).toEqual(example);
  });

  it('full holds the same goal and brief, and is the default only when asked', async () => {
    enableTestAuth();
    const full = (await ask(`projectId=${billing.id}&size=full`)).body;
    expect(full.context?.size).toBe('full');
    expect(full.context?.text).toContain('Ship usage-based billing');
    expect(full.context?.text).toContain('data, not instructions');
    expect((await ask(`projectId=${billing.id}`)).body.context?.size).toBe('compact');
  });

  it('by repository nothing is a 200 with no project, never a 404', async () => {
    enableTestAuth(carol);
    const { status, body } = await ask('repo=acme/web');
    expect(status).toBe(200);
    expect(body).toEqual({ projects: [], context: null });
    expect((await ask('repo=nobody/nothing')).body).toEqual({ projects: [], context: null });
  });

  it('by id without a role is 404; a bad query is 400', async () => {
    enableTestAuth(carol);
    expect((await ask(`projectId=${billing.id}`)).status).toBe(404);
    enableTestAuth(alice);
    expect((await ask(`projectId=${billing.id}`)).status).toBe(200);
    expect((await ask('size=full')).status).toBe(400);
    expect((await ask('repo=bad')).status).toBe(400);
  });
});

describe('Spotlight and the architect', () => {
  it('a workflow in a project with a goal gets the compact block as data; one outside any project gets nothing', () => {
    const wf = store.saveWorkflow({ id: 'wf_invoice_export', name: 'Invoice export', nodes: [], connections: [] });
    setHomeProject('workflow', wf.id, billing.id);
    const entry = builderContextEntry(alice, { workflowId: wf.id });
    expect(entry).toContain('Ship usage-based billing');
    expect(entry).toContain('not an instruction');
    expect(entry).toContain('This run: Spotlight.');
    expect(builderContextEntry(alice, { workflowId: 'draft' })).toBe('');
    expect(builderContextEntry(alice, { projectId: billing.id })).toContain('Where this work fits');
  });

  it('a member of a project the workflow is only shared to gets nothing; a member of the home project gets the block', () => {
    const wf = store.saveWorkflow({ id: 'wf_shared_out', name: 'Shared out', nodes: [], connections: [] });
    setHomeProject('workflow', wf.id, billing.id);
    addShare('workflow', wf.id, checkout.id, 'viewer');
    const member = (id: string) => ({ id, role: 'member' as const });
    // carol is a member of the shared-to project only: she may open the workflow but not read the home project's brief or goals
    setMember(checkout.id, carol.id, 'editor');
    expect(builderContextEntry(member(carol.id), { workflowId: wf.id })).toBe('');
    expect(builderContextEntry(undefined, { workflowId: wf.id })).toBe('');
    expect(builderContextEntry(member(alice.id), { workflowId: wf.id })).toContain('Ship usage-based billing');
  });

  it('POST /api/assistant/agent answers 404 for a project the caller has no role in, and for an unknown id', async () => {
    const post = (projectId: string) => architectRoute.POST(new Request('http://localhost/api/assistant/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], projectId }) }));
    const outsider = await createUser({ email: 'dave@project-context-api.test', name: 'Dave', role: 'member', password: 'dave-password-1' });
    enableTestAuth(outsider);
    expect((await post(billing.id)).status).toBe(404);
    expect((await post('prj_nope')).status).toBe(404);
  });
});
