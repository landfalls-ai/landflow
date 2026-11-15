/**
 * Goals (docs/projects-and-goals.md): the tree and its rules, who sees and edits what, project goals and their order,
 * initiative links, the company mission in Settings, and the context data source. Real sessions, no test bypass.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-goals-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { upsertEntity } = await import('@/lib/server/brain/entities');
const { goalsContextSource } = await import('@/lib/server/goals/context-source');
const { contextDataSource } = await import('@/lib/server/project-context/seam');
const { CONTEXT_LIMITS } = await import('@/lib/shared/project-context');
const { BRIEF_LIMITS } = await import('@/lib/shared/goals');
const goalsRoute = await import('@/app/api/goals/route');
const goalRoute = await import('@/app/api/goals/[id]/route');
const initiativesRoute = await import('@/app/api/goals/[id]/initiatives/route');
const projectGoalsRoute = await import('@/app/api/projects/[id]/goals/route');
const projectRoute = await import('@/app/api/projects/[id]/route');
const settingsRoute = await import('@/app/api/settings/route');

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

async function call(route: unknown, path: string, method: string, caller: Caller, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await (route as Route)(new Request(`http://localhost:3000${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) }), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

let owner: Caller, alice: Caller, bob: Caller, dave: Caller;
let alpha = '';
let beta = '';
let initiative = '';
let hiddenInitiative = '';

const createGoal = (caller: Caller, body: Record<string, unknown>) => call(goalsRoute.POST, '/api/goals', 'POST', caller, body);
const flat = (nodes: Array<{ id: string; children: any[] }>): string[] => nodes.flatMap((n) => [n.id, ...flat(n.children)]);

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  alice = await makeUser('alice@example.com', 'Alice', 'member');
  bob = await makeUser('bob@example.com', 'Bob', 'member');
  dave = await makeUser('dave@example.com', 'Dave', 'member');
  alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  beta = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(alpha, alice.id, 'admin');
  projects.setMember(alpha, bob.id, 'editor');
  projects.setMember(beta, dave.id, 'admin');
  initiative = upsertEntity({ type: 'initiative', name: 'Launch in Spain', projectId: alpha }).entity.id;
  hiddenInitiative = upsertEntity({ type: 'initiative', name: 'Secret plan' }).entity.id;
});

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('goals', () => {
  let root = '';
  let child = '';
  let alphaGoal = '';
  let betaGoal = '';

  it('lets an admin create, read, change and delete a company goal', async () => {
    const created = await createGoal(owner, { title: 'Grow in Europe', why: 'The market is open', level: 'company', targetDate: '2027-06-30' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    root = created.body.goal.id;
    expect(created.body.goal).toMatchObject({ level: 'company', status: 'active', canEdit: true, projects: [], initiatives: [] });
    const patched = await call(goalRoute.PATCH, `/api/goals/${root}`, 'PATCH', owner, { title: 'Grow across Europe', ownerId: alice.id, why: null }, { id: root });
    expect(patched.body.goal).toMatchObject({ title: 'Grow across Europe', ownerId: alice.id, ownerName: 'Alice' });
    expect(patched.body.goal.why).toBeUndefined();
    const detail = await call(goalRoute.GET, `/api/goals/${root}`, 'GET', alice, undefined, { id: root });
    expect(detail.body.goal.canEdit).toBe(false);
    expect(detail.body.chain.map((g: { id: string }) => g.id)).toEqual([root]);
    const spare = (await createGoal(owner, { title: 'Spare', level: 'company' })).body.goal.id;
    expect((await call(goalRoute.DELETE, `/api/goals/${spare}`, 'DELETE', owner, undefined, { id: spare })).body).toEqual({ ok: true });
    expect((await call(goalRoute.GET, `/api/goals/${spare}`, 'GET', owner, undefined, { id: spare })).status).toBe(404);
  });

  it('keeps company goals to owners and admins and project goals to their project admins', async () => {
    expect((await createGoal(alice, { title: 'Nope', level: 'company' })).status).toBe(403);
    expect((await createGoal(bob, { title: 'Editors can’t', level: 'project', projectId: alpha })).status).toBe(403);
    expect((await createGoal(alice, { title: 'Beta’s', level: 'project', projectId: beta })).status).toBe(404);
    expect((await createGoal(owner, { title: 'No project', level: 'project' })).status).toBe(400);
    expect((await createGoal(owner, { title: 'Company with project', level: 'company', projectId: alpha })).status).toBe(400);
    const mine = await createGoal(alice, { title: 'Ship Alpha v2', level: 'project', projectId: alpha, parentId: root });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    alphaGoal = mine.body.goal.id;
    expect(mine.body.goal.projects).toEqual([{ id: alpha, name: 'Alpha' }]);
    betaGoal = (await createGoal(dave, { title: 'Beta secret goal', level: 'project', projectId: beta })).body.goal.id;
    expect((await call(goalRoute.PATCH, `/api/goals/${root}`, 'PATCH', alice, { title: 'x' }, { id: root })).status).toBe(403);
    expect((await call(goalRoute.PATCH, `/api/goals/${alphaGoal}`, 'PATCH', bob, { title: 'x' }, { id: alphaGoal })).status).toBe(403);
  });

  it('shows a member company goals and their own projects’ goals, never another project’s', async () => {
    const aliceSees = flat((await call(goalsRoute.GET, '/api/goals', 'GET', alice)).body.goals);
    expect(aliceSees).toContain(root);
    expect(aliceSees).toContain(alphaGoal);
    expect(aliceSees).not.toContain(betaGoal);
    expect((await call(goalRoute.GET, `/api/goals/${betaGoal}`, 'GET', alice, undefined, { id: betaGoal })).status).toBe(404);
    const daveList = (await call(goalsRoute.GET, '/api/goals', 'GET', dave)).body;
    expect(flat(daveList.goals)).toContain(betaGoal);
    expect(flat(daveList.goals)).not.toContain(alphaGoal);
    expect(flat((await call(goalsRoute.GET, '/api/goals', 'GET', owner)).body.goals)).toEqual(expect.arrayContaining([root, alphaGoal, betaGoal]));
    // The tree: Alpha's goal sits under the company goal; a viewer who can't see a parent gets the child as a root.
    const tree = (await call(goalsRoute.GET, '/api/goals', 'GET', alice)).body.goals as Array<{ id: string; children: Array<{ id: string }> }>;
    expect(tree.find((n) => n.id === root)?.children.map((c) => c.id)).toEqual([alphaGoal]);
    // A project goal of Beta under a goal Alice can't see is a root for her, and for Dave it hangs under its parent.
    const under = (await createGoal(owner, { title: 'Beta child of secret', level: 'project', projectId: beta, parentId: betaGoal })).body.goal.id;
    const sees = (nodes: Array<{ id: string; children: any[] }>) => nodes.some((n) => n.id === under);
    expect(sees((await call(goalsRoute.GET, '/api/goals', 'GET', alice)).body.goals)).toBe(false);
    expect(flat((await call(goalsRoute.GET, '/api/goals', 'GET', dave)).body.goals)).toContain(under);
    // ?projectId= for a project Alice can't see answers nothing.
    expect(flat((await call(goalsRoute.GET, `/api/goals?projectId=${beta}`, 'GET', alice)).body.goals)).toEqual([]);
    // ?projectId= keeps the goals that project serves or owns.
    const forAlpha = flat((await call(goalsRoute.GET, `/api/goals?projectId=${alpha}`, 'GET', owner)).body.goals);
    expect(forAlpha).toContain(alphaGoal);
    expect(forAlpha).not.toContain(betaGoal);
  });

  it('enforces levels, depth and cycles', async () => {
    child = (await createGoal(owner, { title: 'Spain', level: 'company', parentId: root })).body.goal.id;
    const grand = (await createGoal(owner, { title: 'Madrid', level: 'company', parentId: child })).body.goal.id;
    const great = await createGoal(owner, { title: 'Chamberi', level: 'company', parentId: grand });
    expect(great.status).toBe(201);
    const tooDeep = await createGoal(owner, { title: 'Too deep', level: 'company', parentId: great.body.goal.id });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.error).toMatch(/4 levels/);
    // A company goal's parent is a company goal.
    expect((await createGoal(owner, { title: 'Odd', level: 'company', parentId: alphaGoal })).status).toBe(400);
    // Cycles: a goal can't go under itself or its own descendant.
    expect((await call(goalRoute.PATCH, `/api/goals/${root}`, 'PATCH', owner, { parentId: grand }, { id: root })).status).toBe(400);
    expect((await call(goalRoute.PATCH, `/api/goals/${root}`, 'PATCH', owner, { parentId: root }, { id: root })).status).toBe(400);
    // Moving a subtree down past the depth limit is refused too.
    const lone = (await createGoal(owner, { title: 'Lone', level: 'company' })).body.goal.id;
    expect((await call(goalRoute.PATCH, `/api/goals/${root}`, 'PATCH', owner, { parentId: lone }, { id: root })).status).toBe(400);
    expect((await call(goalRoute.DELETE, `/api/goals/${lone}`, 'DELETE', owner, undefined, { id: lone })).status).toBe(200);
    // A parent the caller can't see is not found.
    expect((await createGoal(alice, { title: 'Under Beta', level: 'project', projectId: alpha, parentId: betaGoal })).status).toBe(400);
  });

  it('refuses to delete a goal with sub-goals (409 GoalHasChildren) and cleans up after a delete', async () => {
    const refused = await call(goalRoute.DELETE, `/api/goals/${root}`, 'DELETE', owner, undefined, { id: root });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'goal_has_children', error: 'Move or delete its sub-goals first' });
    const leaf = (await createGoal(alice, { title: 'Leaf', level: 'project', projectId: alpha })).body.goal.id;
    await call(initiativesRoute.PUT, `/api/goals/${leaf}/initiatives`, 'PUT', alice, { ids: [initiative] }, { id: leaf });
    expect((await call(goalRoute.DELETE, `/api/goals/${leaf}`, 'DELETE', alice, undefined, { id: leaf })).status).toBe(200);
    expect((await call(projectGoalsRoute.GET, `/api/projects/${alpha}/goals`, 'GET', alice, undefined, { id: alpha })).body.goals.map((g: { id: string }) => g.id)).toEqual([alphaGoal]);
    const { database } = await import('@/lib/server/db');
    expect(database().get('SELECT 1 FROM goal_links WHERE goal_id = ?', leaf)).toBeUndefined();
  });

  it('deletes a project’s goals with it and leaves nothing pointing at it', async () => {
    const { database } = await import('@/lib/server/db');
    const gone = projects.createTeamProject({ name: 'Doomed' }).id;
    const top = (await createGoal(owner, { title: 'Doomed top', level: 'project', projectId: gone })).body.goal.id;
    const sub = (await createGoal(owner, { title: 'Doomed sub', level: 'project', projectId: gone, parentId: top })).body.goal.id;
    const outer = (await createGoal(owner, { title: 'Outer under doomed', level: 'project', projectId: alpha, parentId: top })).body.goal.id;
    await call(initiativesRoute.PUT, `/api/goals/${sub}/initiatives`, 'PUT', owner, { ids: [initiative] }, { id: sub });
    const served = (await createGoal(owner, { title: 'Served company goal', level: 'company', projectIds: [gone] })).body.goal.id;
    projects.deleteProjectWithTransfer(gone, undefined, owner.id);
    for (const id of [top, sub]) {
      expect(database().get('SELECT 1 FROM goals WHERE id = ?', id)).toBeUndefined();
      expect(database().get('SELECT 1 FROM goal_links WHERE goal_id = ?', id)).toBeUndefined();
      expect(database().get('SELECT 1 FROM project_goals WHERE goal_id = ?', id)).toBeUndefined();
    }
    expect(database().get('SELECT 1 FROM project_goals WHERE project_id = ?', gone)).toBeUndefined();
    expect(database().get('SELECT 1 FROM goals WHERE project_id = ?', gone)).toBeUndefined();
    expect(database().get('SELECT 1 FROM goals WHERE id = ?', served)).toBeDefined();
    expect((await call(goalRoute.GET, `/api/goals/${outer}`, 'GET', owner, undefined, { id: outer })).body.goal.parentId).toBeUndefined();
  });

  it('links brain initiatives the caller may read, and answers 400 for others', async () => {
    const linked = await call(initiativesRoute.PUT, `/api/goals/${alphaGoal}/initiatives`, 'PUT', alice, { ids: [initiative] }, { id: alphaGoal });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.goal.initiatives).toEqual([{ id: initiative, name: 'Launch in Spain' }]);
    const unknown = await call(initiativesRoute.PUT, `/api/goals/${alphaGoal}/initiatives`, 'PUT', alice, { ids: [initiative, 'nope', hiddenInitiative] }, { id: alphaGoal });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('nope');
    expect(unknown.body.error).toContain(hiddenInitiative);
    expect((await call(initiativesRoute.PUT, `/api/goals/${alphaGoal}/initiatives`, 'PUT', bob, { ids: [] }, { id: alphaGoal })).status).toBe(403);
    expect((await call(initiativesRoute.PUT, `/api/goals/${alphaGoal}/initiatives`, 'PUT', alice, { ids: [] }, { id: alphaGoal })).body.goal.initiatives).toEqual([]);
  });

  it('orders the goals a project serves; the first planned or active one is primary', async () => {
    const planned = (await createGoal(alice, { title: 'Later', level: 'project', projectId: alpha, status: 'planned' })).body.goal.id;
    const done = (await createGoal(alice, { title: 'Dropped', level: 'project', projectId: alpha, status: 'cancelled' })).body.goal.id;
    // Company goals are served on request; another project's goal never.
    const set = await call(projectGoalsRoute.PUT, `/api/projects/${alpha}/goals`, 'PUT', alice, { goalIds: [done, root, planned, alphaGoal] }, { id: alpha });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.goals.map((g: { id: string }) => g.id)).toEqual([done, root, planned, alphaGoal]);
    const detail = await call(projectRoute.GET, `/api/projects/${alpha}`, 'GET', alice, undefined, { id: alpha });
    const goals = detail.body.project.brief.goals as Array<{ id: string; status: string }>;
    expect(goals.map((g) => g.id)).toEqual([done, root, planned, alphaGoal]);
    expect(goals.find((g) => g.status === 'planned' || g.status === 'active')?.id).toBe(root);
    expect((await call(projectGoalsRoute.PUT, `/api/projects/${alpha}/goals`, 'PUT', alice, { goalIds: [betaGoal] }, { id: alpha })).status).toBe(400);
    expect((await call(projectGoalsRoute.PUT, `/api/projects/${alpha}/goals`, 'PUT', bob, { goalIds: [root] }, { id: alpha })).status).toBe(403);
    expect((await call(projectGoalsRoute.GET, `/api/projects/${alpha}/goals`, 'GET', dave, undefined, { id: alpha })).status).toBe(404);
    expect((await call(projectGoalsRoute.PUT, `/api/projects/${alpha}/goals`, 'PUT', alice, { goalIds: Array.from({ length: 11 }, (_, i) => `g${i}`) }, { id: alpha })).status).toBe(400);
    // A company goal can name the projects that serve it, each one the caller admins.
    const served = await createGoal(owner, { title: 'Serve both', level: 'company', projectIds: [alpha, beta] });
    expect(served.body.goal.projects.map((p: { name: string }) => p.name).sort()).toEqual(['Alpha', 'Beta']);
    // Cancelled goals stay in the tree and in the list, but not in the context data.
    expect(goalsContextSource.project(alpha)?.goalIds).toEqual([root, planned, alphaGoal, served.body.goal.id]);
    expect(flat((await call(goalsRoute.GET, '/api/goals?status=cancelled', 'GET', owner)).body.goals)).toEqual([done]);
  });

  it('keeps the company mission in settings', async () => {
    expect((await call(settingsRoute.PATCH, '/api/settings', 'PATCH', alice, { company: { mission: 'x' } })).status).toBe(403);
    const saved = await call(settingsRoute.PATCH, '/api/settings', 'PATCH', owner, { company: { name: 'Acme', mission: 'Make hosting boring' } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.company).toEqual({ name: 'Acme', mission: 'Make hosting boring' });
    expect((await call(settingsRoute.GET, '/api/settings', 'GET', alice)).body.company).toEqual({ name: 'Acme', mission: 'Make hosting boring' });
    expect((await call(goalsRoute.GET, '/api/goals', 'GET', dave)).body.mission).toBe('Make hosting boring');
    expect((await call(settingsRoute.PATCH, '/api/settings', 'PATCH', owner, { company: { mission: 'm'.repeat(BRIEF_LIMITS.mission + 1) } })).status).toBe(400);
    expect((await call(settingsRoute.PATCH, '/api/settings', 'PATCH', owner, { company: { name: 'n'.repeat(BRIEF_LIMITS.companyName) } })).status).toBe(200);
    expect((await call(settingsRoute.PATCH, '/api/settings', 'PATCH', owner, { company: { name: 'n'.repeat(BRIEF_LIMITS.companyName + 1) } })).status).toBe(400);
    const cleared = await call(settingsRoute.PATCH, '/api/settings', 'PATCH', owner, { company: { name: null } });
    expect(cleared.body.company).toEqual({ mission: 'Make hosting boring' });
    expect((await call(goalsRoute.GET, '/api/goals', 'GET', dave)).body.canCreateCompanyGoals).toBe(false);
  });

  it('gives the context source the mission, the project and the goal chain', async () => {
    expect(contextDataSource()).toBe(goalsContextSource);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(goalsContextSource.mission()).toBe('Make hosting boring');
    await call(projectRoute.PATCH, `/api/projects/${alpha}`, 'PATCH', alice, { brief: { brief: 'Rebuild the dashboard', constraints: 'No new vendors', status: 'active', leadId: bob.id } }, { id: alpha });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(goalsContextSource.project(alpha)).toMatchObject({ id: alpha, name: 'Alpha', brief: 'Rebuild the dashboard', constraints: 'No new vendors', status: 'active', leadName: 'Bob' });
    expect(goalsContextSource.project('missing')).toBeUndefined();
    // The chain: root first, the goal last, at most CONTEXT_LIMITS.chain long; unknown goals give [].
    const deepest = (await call(goalsRoute.GET, '/api/goals', 'GET', owner)).body.goals;
    const walk = (nodes: Array<{ id: string; title: string; children: any[] }>): string[] => nodes.flatMap((n) => (n.title === 'Chamberi' ? [n.id] : walk(n.children)));
    const [chamberi] = walk(deepest);
    const chain = goalsContextSource.goalChain(chamberi);
    expect(chain.map((g) => g.title)).toEqual(['Grow across Europe', 'Spain', 'Madrid', 'Chamberi']);
    expect(chain.length).toBeLessThanOrEqual(CONTEXT_LIMITS.chain);
    expect(chain[0]).toMatchObject({ level: 'company', ownerName: 'Alice' });
    expect(goalsContextSource.goalChain('goal_missing')).toEqual([]);
  });
});
