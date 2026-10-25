/**
 * Projects and sharing (lib/server/projects, the route guard's resource table in lib/server/auth/policy.ts):
 *
 * - every resource route against every kind of caller (table-driven, through the guard, so destructive routes are
 *   checked without running): instance owner and admin, a team project's admin, editor and viewer, an outsider,
 *   someone a workflow was shared with, and an API key acting as its user;
 * - lists, the credential picker, executions, insights, project pages and live events filtered per caller;
 * - sharing workflows (edit/view) and credentials (use, never readable);
 * - credentials across projects in real runs (an HTTP Request node with Header Auth against a local server);
 * - "Move to project", deleting a team project, and removing a user with the transfer of what they own.
 * The test bypass is off: every request carries a real session or API key.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-projects-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const projects = await import('@/lib/server/projects');
const { liveEventFilter } = await import('@/lib/server/projects/events');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { resourceCan } = await import('@/lib/shared/projects');

const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const workflowSharesRoute = await import('@/app/api/workflows/[id]/shares/route');
const workflowTransferRoute = await import('@/app/api/workflows/[id]/transfer/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const credentialSharesRoute = await import('@/app/api/credentials/[id]/shares/route');
const credentialTransferRoute = await import('@/app/api/credentials/[id]/transfer/route');
const credentialTestRoute = await import('@/app/api/credentials/test/route');
const dataTablesRoute = await import('@/app/api/data-tables/route');
const agentsRoute = await import('@/app/api/agents/route');
const executionsRoute = await import('@/app/api/executions/route');
const projectsRoute = await import('@/app/api/projects/route');
const projectRoute = await import('@/app/api/projects/[id]/route');
const membersRoute = await import('@/app/api/projects/[id]/members/route');
const userRoute = await import('@/app/api/users/[id]/route');
const userResourcesRoute = await import('@/app/api/users/[id]/resources/route');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const loadOptionsRoute = await import('@/app/api/node-types/load-options/route');

registry.registerBuiltin(corePlugin);

// ---- helpers -----------------------------------------------------------------------------------------------

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
  role: 'owner' | 'admin' | 'member';
}

function request(path: string, method: string, caller?: { session?: string; key?: string }, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (caller?.session) headers.cookie = `landflow_session=${caller.session}`;
  if (caller?.key) headers.authorization = `Bearer ${caller.key}`;
  return new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

async function call(route: unknown, path: string, method: string, caller: { session?: string; key?: string } | undefined, body?: unknown, params?: Record<string, string>) {
  const response = await (route as Route)(request(path, method, caller, body), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

/** The guard's answer for `method path` as `caller`: 'ok', or the status it refused with. */
function guard(method: string, path: string, caller: { session?: string; key?: string }): 'ok' | number {
  const result = guardRequest(request(path, method, caller, ['GET', 'HEAD'].includes(method) ? undefined : {}));
  return result.ok ? 'ok' : result.response.status;
}

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token, role };
}

let owner: Caller, admin: Caller, alice: Caller, bob: Caller, carol: Caller, dave: Caller;
let team = '';
let other = '';
const ids = { workflow: '', ownerWorkflow: '', credential: '', ownerCredential: '', table: '', agent: '', execution: '' };
let echo: Server;
let echoUrl = '';
const received: Array<string | undefined> = [];

const emptyWorkflow = (name: string) => ({ name, nodes: [], connections: [] });

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  admin = await makeUser('admin@example.com', 'Ada Admin', 'admin');
  alice = await makeUser('alice@example.com', 'Alice', 'member');
  bob = await makeUser('bob@example.com', 'Bob', 'member');
  carol = await makeUser('carol@example.com', 'Carol', 'member');
  dave = await makeUser('dave@example.com', 'Dave', 'member');

  // A team project made through the API: Alice admin, Bob editor, Carol viewer. Dave is in none.
  const created = await call(projectsRoute.POST, '/api/projects', 'POST', admin, {
    name: 'Data',
    members: [
      { userId: alice.id, role: 'admin' },
      { userId: bob.id, role: 'editor' },
      { userId: carol.id, role: 'viewer' },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  team = created.body.project.id;
  other = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(other, alice.id, 'editor');

  // What the team owns, created by its members through the API.
  ids.workflow = (await call(workflowsRoute.POST, `/api/workflows?projectId=${team}`, 'POST', bob, emptyWorkflow('Team workflow'))).body.workflow.id;
  const credential = await call(credentialsRoute.POST, `/api/credentials?projectId=${team}`, 'POST', alice, { name: 'Team header', type: 'core.httpHeaderAuth', data: { name: 'x-secret', value: 'team-secret' } });
  expect(credential.status, JSON.stringify(credential.body)).toBe(201);
  ids.credential = credential.body.credential.id;
  ids.table = (await call(dataTablesRoute.POST, `/api/data-tables?projectId=${team}`, 'POST', bob, { name: 'Team table', columns: [{ name: 'n', type: 'number' }] })).body.table.id;
  ids.agent = (await call(agentsRoute.POST, `/api/agents?projectId=${team}`, 'POST', bob, { name: 'Team agent' })).body.agent.id;
  // The owner's own things, in their personal project.
  ids.ownerWorkflow = (await call(workflowsRoute.POST, '/api/workflows', 'POST', owner, emptyWorkflow('Owner workflow'))).body.workflow.id;
  ids.ownerCredential = (await call(credentialsRoute.POST, '/api/credentials', 'POST', owner, { name: 'Owner header', type: 'core.httpHeaderAuth', data: { name: 'x-secret', value: 'owner-secret' } })).body.credential.id;
  // A saved execution of the team workflow.
  ids.execution = 'ex_projects_1';
  store.saveExecution({ executionId: ids.execution, workflowId: ids.workflow, workflowName: 'Team workflow', status: 'success', mode: 'manual', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [] } as never);

  echo = createServer((req, res) => {
    received.push(req.headers['x-secret'] as string | undefined);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  auth.enableTestAuth();
  if (echo) await new Promise<void>((resolve) => echo.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- every resource route, every caller --------------------------------------------------------------------

type Expect = 'ok' | 403 | 404;
/** What each caller gets for each action on a resource owned by the team project. */
const BY_ACTION: Record<'read' | 'update' | 'delete' | 'share', Record<'owner' | 'admin' | 'alice' | 'bob' | 'carol' | 'dave', Expect>> = {
  read: { owner: 'ok', admin: 'ok', alice: 'ok', bob: 'ok', carol: 'ok', dave: 404 },
  update: { owner: 'ok', admin: 'ok', alice: 'ok', bob: 'ok', carol: 403, dave: 404 },
  delete: { owner: 'ok', admin: 'ok', alice: 'ok', bob: 'ok', carol: 403, dave: 404 },
  share: { owner: 'ok', admin: 'ok', alice: 'ok', bob: 403, carol: 403, dave: 404 },
};

/** [method, path (W, C, T, A, E = the team's workflow, credential, table, agent, execution), action]. */
const ROUTES: Array<[string, string, keyof typeof BY_ACTION]> = [
  ['GET', '/api/workflows/W', 'read'],
  ['PUT', '/api/workflows/W', 'update'],
  ['DELETE', '/api/workflows/W', 'delete'],
  ['POST', '/api/workflows/W/run', 'update'],
  ['POST', '/api/workflows/W/execute', 'update'],
  ['POST', '/api/workflows/W/publish', 'update'],
  ['POST', '/api/workflows/W/unpublish', 'update'],
  ['GET', '/api/workflows/W/publication', 'read'],
  ['GET', '/api/workflows/W/versions', 'read'],
  ['GET', '/api/workflows/W/versions/v1', 'read'],
  ['POST', '/api/workflows/W/versions/v1/restore', 'update'],
  ['GET', '/api/workflows/W/lock', 'read'],
  ['POST', '/api/workflows/W/lock', 'update'],
  ['POST', '/api/workflows/W/move', 'update'],
  ['GET', '/api/workflows/W/polls', 'read'],
  ['GET', '/api/workflows/W/evaluations', 'read'],
  ['POST', '/api/workflows/W/evaluations', 'update'],
  ['GET', '/api/workflows/W/online-evaluations', 'read'],
  ['PUT', '/api/workflows/W/online-evaluations', 'update'],
  ['GET', '/api/workflows/W/alert', 'read'],
  ['GET', '/api/workflows/W/shares', 'read'],
  ['PUT', '/api/workflows/W/shares', 'share'],
  ['POST', '/api/workflows/W/transfer', 'share'],
  ['GET', '/api/insights/workflows/W', 'read'],
  ['GET', '/api/executions/E', 'read'],
  ['DELETE', '/api/executions/E', 'update'],
  ['POST', '/api/executions/E/retry', 'update'],
  ['POST', '/api/executions/E/rerun', 'update'],
  ['POST', '/api/executions/E/stop', 'update'],
  ['POST', '/api/executions/E/debug', 'update'],
  ['GET', '/api/credentials/C', 'read'],
  ['PATCH', '/api/credentials/C', 'update'],
  ['DELETE', '/api/credentials/C', 'delete'],
  ['GET', '/api/credentials/C/oauth2/authorize', 'update'],
  ['POST', '/api/credentials/C/oauth2/token', 'update'],
  ['GET', '/api/credentials/C/shares', 'read'],
  ['PUT', '/api/credentials/C/shares', 'share'],
  ['POST', '/api/credentials/C/transfer', 'share'],
  ['GET', '/api/data-tables/T', 'read'],
  ['PATCH', '/api/data-tables/T', 'update'],
  ['DELETE', '/api/data-tables/T', 'delete'],
  ['GET', '/api/data-tables/T/rows', 'read'],
  ['POST', '/api/data-tables/T/rows', 'update'],
  ['PATCH', '/api/data-tables/T/rows/1', 'update'],
  ['DELETE', '/api/data-tables/T/rows/1', 'update'],
  ['POST', '/api/data-tables/T/rows/upsert', 'update'],
  ['POST', '/api/data-tables/T/columns', 'update'],
  ['DELETE', '/api/data-tables/T/columns/n', 'update'],
  ['GET', '/api/data-tables/T/export', 'read'],
  ['POST', '/api/data-tables/T/import', 'update'],
  ['POST', '/api/data-tables/T/transfer', 'share'],
  ['GET', '/api/agents/A', 'read'],
  ['PUT', '/api/agents/A', 'update'],
  ['DELETE', '/api/agents/A', 'delete'],
  ['POST', '/api/agents/A/chat', 'update'],
  ['POST', '/api/agents/A/publish', 'update'],
  ['GET', '/api/agents/A/sessions', 'read'],
  ['GET', '/api/agents/A/sessions/s1', 'read'],
  ['POST', '/api/agents/A/sessions/s1/approvals', 'update'],
  ['GET', '/api/agents/A/evaluations', 'read'],
  ['POST', '/api/agents/A/transfer', 'share'],
];

const fill = (path: string) =>
  path
    .replace('/W', `/${ids.workflow}`)
    .replace('/C', `/${ids.credential}`)
    .replace('/T', `/${ids.table}`)
    .replace('/A', `/${ids.agent}`)
    .replace('/E', `/${ids.execution}`);

describe('every resource route checks project access', () => {
  const callers = () => ({ owner, admin, alice, bob, carol, dave });
  it.each(ROUTES)('%s %s (%s)', (method, path, action) => {
    const got = Object.fromEntries(Object.entries(callers()).map(([name, caller]) => [name, guard(method, fill(path), caller)]));
    expect(got).toEqual(BY_ACTION[action]);
  });

  it('routes that aren’t one resource are left to their handlers', () => {
    for (const path of ['/api/workflows/import', '/api/credentials/test', '/api/agents/import', '/api/agents/models', '/api/agents/workflow-tools', '/api/executions/stop-all']) {
      expect(guard(path === '/api/agents/models' || path === '/api/agents/workflow-tools' ? 'GET' : 'POST', path, dave), path).toBe('ok');
    }
  });

  it('unknown ids answer 404 to members (nothing leaks) and reach the handler for owners and admins', () => {
    expect(guard('GET', '/api/workflows/wf_nope', dave)).toBe(404);
    expect(guard('GET', '/api/workflows/wf_nope', admin)).toBe('ok');
  });

  it('API keys act as their user', async () => {
    const key = (await call(apiKeysRoute.POST, '/api/api-keys', 'POST', bob, { label: 'ci', scopes: ['workflows:read', 'workflows:write', 'executions:read'] })).body.token as string;
    expect(guard('PUT', `/api/workflows/${ids.workflow}`, { key })).toBe('ok');
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}`, { key })).toBe(404);
    expect(guard('GET', `/api/executions/${ids.execution}`, { key })).toBe('ok');
    const listed = await call(workflowsRoute.GET, '/api/workflows', 'GET', { key });
    expect(listed.body.workflows.map((w: { id: string }) => w.id)).toEqual([ids.workflow]);
    // A viewer's key can't do more than the viewer.
    const viewerKey = (await call(apiKeysRoute.POST, '/api/api-keys', 'POST', carol, { label: 'ci', scopes: ['workflows:write'] })).body.token as string;
    expect(guard('PUT', `/api/workflows/${ids.workflow}`, { key: viewerKey })).toBe(403);
  });

  it('the owner still sees and does everything (single-user behaviour)', async () => {
    for (const [method, path] of ROUTES) expect(guard(method, fill(path), owner), `${method} ${path}`).toBe('ok');
    const listed = await call(workflowsRoute.GET, '/api/workflows', 'GET', owner);
    expect(listed.body.workflows.map((w: { id: string }) => w.id).sort()).toEqual(expect.arrayContaining([ids.workflow, ids.ownerWorkflow]));
  });
});

// ---- lists ------------------------------------------------------------------------------------------------

describe('lists show what the caller can see', () => {
  it('workflows, with each one’s project and the caller’s access; ?projectId= keeps one project', async () => {
    const bobs = await call(workflowsRoute.GET, '/api/workflows', 'GET', bob);
    expect(bobs.body.workflows).toHaveLength(1);
    expect(bobs.body.workflows[0]).toMatchObject({ id: ids.workflow, ownership: { projectId: team, projectName: 'Data', projectType: 'team', access: { role: 'editor', home: true }, shared: false } });
    expect(bobs.body.stats.workflows).toBe(1);
    expect((await call(workflowsRoute.GET, '/api/workflows', 'GET', dave)).body.workflows).toEqual([]);
    const ownerTeam = await call(workflowsRoute.GET, `/api/workflows?projectId=${team}`, 'GET', owner);
    expect(ownerTeam.body.workflows.map((w: { id: string }) => w.id)).toEqual([ids.workflow]);
    // Single workflow: its ownership, which the editor uses to go read-only for viewers.
    const carols = await call(workflowRoute.GET, `/api/workflows/${ids.workflow}`, 'GET', carol, undefined, { id: ids.workflow });
    expect(carols.body.ownership.access).toEqual({ role: 'viewer', home: true });
    expect(resourceCan(carols.body.ownership.access, 'update')).toBe(false);
  });

  it('credentials, data tables, agents, executions and projects', async () => {
    expect((await call(credentialsRoute.GET, '/api/credentials', 'GET', bob)).body.credentials.map((c: { id: string }) => c.id)).toEqual([ids.credential]);
    expect((await call(credentialsRoute.GET, '/api/credentials', 'GET', dave)).body.credentials).toEqual([]);
    expect((await call(dataTablesRoute.GET, '/api/data-tables', 'GET', carol)).body.tables.map((t: { id: string }) => t.id)).toEqual([ids.table]);
    expect((await call(dataTablesRoute.GET, '/api/data-tables', 'GET', dave)).body.tables).toEqual([]);
    expect((await call(agentsRoute.GET, '/api/agents', 'GET', bob)).body.agents.map((a: { id: string }) => a.id)).toEqual([ids.agent]);
    expect((await call(agentsRoute.GET, '/api/agents', 'GET', dave)).body.agents).toEqual([]);
    expect((await call(executionsRoute.GET, '/api/executions', 'GET', carol)).body.executions.map((e: { id: string }) => e.id)).toEqual([ids.execution]);
    expect((await call(executionsRoute.GET, '/api/executions', 'GET', dave)).body.executions).toEqual([]);

    const bobsProjects = (await call(projectsRoute.GET, '/api/projects', 'GET', bob)).body.projects as Array<{ id: string; type: string; role: string; counts: Record<string, number> }>;
    expect(bobsProjects.map((p) => [p.id, p.type, p.role])).toEqual([
      [`personal_${bob.id}`, 'personal', 'admin'],
      [team, 'team', 'editor'],
    ]);
    expect(bobsProjects[1].counts).toEqual({ workflow: 1, credential: 1, dataTable: 1, agent: 1 });
    expect((await call(projectsRoute.GET, '/api/projects', 'GET', admin)).body.projects.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([team, other, `personal_${admin.id}`, `personal_${bob.id}`]));
    // A project page: its members (members of it only).
    const page = await call(projectRoute.GET, `/api/projects/${team}`, 'GET', carol, undefined, { id: team });
    expect(page.body.project.members.map((m: { name: string; role: string }) => [m.name, m.role])).toEqual([
      ['Alice', 'admin'],
      ['Bob', 'editor'],
      ['Carol', 'viewer'],
    ]);
    expect((await call(projectRoute.GET, `/api/projects/${team}`, 'GET', dave, undefined, { id: team })).status).toBe(404);
  });

  it('the credential picker offers what the workflow’s project may use', async () => {
    const picker = await call(credentialsRoute.GET, `/api/credentials?workflowId=${ids.workflow}`, 'GET', owner);
    expect(picker.body.credentials.map((c: { id: string }) => c.id)).toEqual([ids.credential]);
    const ownerPicker = await call(credentialsRoute.GET, `/api/credentials?workflowId=${ids.ownerWorkflow}`, 'GET', owner);
    expect(ownerPicker.body.credentials.map((c: { id: string }) => c.id)).toEqual([ids.ownerCredential]);
  });

  it('live events reach the members of the workflow’s project only', () => {
    const event = { channel: 'execution' as const, workflowId: ids.workflow, event: { type: 'execution.started' } as never };
    expect(liveEventFilter({ id: carol.id, role: 'member' })(event)).toBe(true);
    expect(liveEventFilter({ id: dave.id, role: 'member' })(event)).toBe(false);
    expect(liveEventFilter({ id: admin.id, role: 'admin' })(event)).toBe(true);
    expect(liveEventFilter({ id: dave.id, role: 'member' })({ channel: 'registry', event: { type: 'plugin.online' } as never })).toBe(true);
  });
});

// ---- project management ------------------------------------------------------------------------------------

describe('project management', () => {
  it('only owners and admins create team projects; project admins manage members', async () => {
    expect((await call(projectsRoute.POST, '/api/projects', 'POST', alice, { name: 'Nope' })).status).toBe(403);
    const renamed = await call(projectRoute.PATCH, `/api/projects/${other}`, 'PATCH', alice, { name: 'Ops!' }, { id: other });
    expect(renamed.status).toBe(403); // an editor there
    const members = await call(membersRoute.PUT, `/api/projects/${team}/members`, 'PUT', alice, { members: [{ userId: alice.id, role: 'admin' }, { userId: bob.id, role: 'editor' }, { userId: carol.id, role: 'viewer' }, { userId: dave.id, role: 'viewer' }] }, { id: team });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    expect(guard('GET', `/api/workflows/${ids.workflow}`, dave)).toBe('ok');
    expect((await call(membersRoute.PUT, `/api/projects/${team}/members`, 'PUT', bob, { members: [] }, { id: team })).status).toBe(403);
    // Back to how it was.
    await call(membersRoute.PUT, `/api/projects/${team}/members`, 'PUT', alice, { members: [{ userId: alice.id, role: 'admin' }, { userId: bob.id, role: 'editor' }, { userId: carol.id, role: 'viewer' }] }, { id: team });
    expect(guard('GET', `/api/workflows/${ids.workflow}`, dave)).toBe(404);
  });

  it('creating in a project needs edit rights there', async () => {
    expect((await call(workflowsRoute.POST, `/api/workflows?projectId=${team}`, 'POST', carol, emptyWorkflow('x'))).status).toBe(403);
    expect((await call(workflowsRoute.POST, `/api/workflows?projectId=${team}`, 'POST', dave, emptyWorkflow('x'))).status).toBe(403);
    const mine = await call(workflowsRoute.POST, '/api/workflows', 'POST', dave, emptyWorkflow('Dave’s'));
    expect(projects.homeProjectId('workflow', mine.body.workflow.id)).toBe(`personal_${dave.id}`);
    expect(guard('PUT', `/api/workflows/${mine.body.workflow.id}`, dave)).toBe('ok');
    expect(guard('GET', `/api/workflows/${mine.body.workflow.id}`, bob)).toBe(404);
  });
});

// ---- sharing ----------------------------------------------------------------------------------------------

describe('sharing', () => {
  it('a workflow shared with a user to view, then to edit', async () => {
    expect(guard('GET', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe(404);
    const shared = await call(workflowSharesRoute.PUT, `/api/workflows/${ids.ownerWorkflow}/shares`, 'PUT', owner, { shares: [{ userId: bob.id, role: 'viewer' }] }, { id: ids.ownerWorkflow });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.shares).toEqual([expect.objectContaining({ projectId: `personal_${bob.id}`, projectName: 'Bob', projectType: 'personal', userId: bob.id, role: 'viewer' })]);
    expect(guard('GET', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe('ok');
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe(403);
    const listed = await call(workflowsRoute.GET, '/api/workflows', 'GET', bob);
    expect(listed.body.workflows.find((w: { id: string }) => w.id === ids.ownerWorkflow).ownership).toMatchObject({ projectName: 'Olive Owner', shared: true, access: { role: 'viewer', home: false } });

    await call(workflowSharesRoute.PUT, `/api/workflows/${ids.ownerWorkflow}/shares`, 'PUT', owner, { shares: [{ userId: bob.id, role: 'editor' }] }, { id: ids.ownerWorkflow });
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe('ok');
    // Shared editors don't delete, share or move.
    expect(guard('DELETE', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe(403);
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}/shares`, bob)).toBe(403);
  });

  it('a workflow shared with a project: its members get the weaker of their role and the share', async () => {
    await call(workflowSharesRoute.PUT, `/api/workflows/${ids.ownerWorkflow}/shares`, 'PUT', owner, { shares: [{ projectId: team, role: 'editor' }] }, { id: ids.ownerWorkflow });
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe('ok');
    expect(guard('GET', `/api/workflows/${ids.ownerWorkflow}`, carol)).toBe('ok');
    expect(guard('PUT', `/api/workflows/${ids.ownerWorkflow}`, carol)).toBe(403);
    expect(guard('GET', `/api/workflows/${ids.ownerWorkflow}`, dave)).toBe(404);
    // Replacing the shares removes Bob's personal one; clearing them hides it again.
    const cleared = await call(workflowSharesRoute.PUT, `/api/workflows/${ids.ownerWorkflow}/shares`, 'PUT', owner, { shares: [] }, { id: ids.ownerWorkflow });
    expect(cleared.body.shares).toEqual([]);
    expect(guard('GET', `/api/workflows/${ids.ownerWorkflow}`, bob)).toBe(404);
  });

  it('refuses roles a kind can’t have and shares by people who can’t share', async () => {
    expect((await call(credentialSharesRoute.PUT, `/api/credentials/${ids.credential}/shares`, 'PUT', alice, { shares: [{ projectId: other, role: 'editor' }] }, { id: ids.credential })).status).toBe(400);
    expect((await call(workflowSharesRoute.PUT, `/api/workflows/${ids.workflow}/shares`, 'PUT', alice, { shares: [{ projectId: other, role: 'user' }] }, { id: ids.workflow })).status).toBe(400);
    const guarded = guardRequest(request(`/api/workflows/${ids.workflow}/shares`, 'PUT', bob, {}));
    expect(guarded.ok).toBe(false);
  });

  it('a credential shared to use: listed and usable, never readable', async () => {
    const shared = await call(credentialSharesRoute.PUT, `/api/credentials/${ids.ownerCredential}/shares`, 'PUT', owner, { shares: [{ projectId: team, role: 'user' }] }, { id: ids.ownerCredential });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const bobs = await call(credentialRoute.GET, `/api/credentials/${ids.ownerCredential}`, 'GET', bob, undefined, { id: ids.ownerCredential });
    expect(bobs.status).toBe(200);
    expect(bobs.body.credential.data).toEqual({});
    expect(JSON.stringify(bobs.body)).not.toContain('owner-secret');
    expect(bobs.body.ownership).toMatchObject({ shared: true, access: { role: 'user', home: false } });
    expect(guard('PATCH', `/api/credentials/${ids.ownerCredential}`, bob)).toBe(403);
    // The owner sees the non-secret fields; nobody sees the secret.
    const owners = await call(credentialRoute.GET, `/api/credentials/${ids.ownerCredential}`, 'GET', owner, undefined, { id: ids.ownerCredential });
    expect(owners.body.credential.data).toEqual({ name: 'x-secret' });
    expect(owners.body.credential.secrets).toEqual(['value']);
    // Testing a saved credential sends its secret to a plugin: not for users of a share.
    expect((await call(credentialTestRoute.POST, '/api/credentials/test', 'POST', bob, { type: 'core.httpHeaderAuth', id: ids.ownerCredential, data: {} })).status).toBe(403);
    // Loading options with it is using it: fine for the team, not for Dave.
    const options = (caller: Caller) => call(loadOptionsRoute.POST, '/api/node-types/load-options', 'POST', caller, { type: 'core.httpRequest', method: 'none', credentials: { httpHeaderAuth: { id: ids.ownerCredential, name: 'Owner header' } } });
    expect((await options(dave)).status).toBe(404);
    expect((await options(bob)).status).toBe(200);
    // Picker: the team workflow may use it now.
    const picker = await call(credentialsRoute.GET, `/api/credentials?workflowId=${ids.workflow}`, 'GET', bob);
    expect(picker.body.credentials.map((c: { id: string }) => c.id).sort()).toEqual([ids.credential, ids.ownerCredential].sort());
  });
});

// ---- credentials in runs ----------------------------------------------------------------------------------

describe('credentials across projects in runs', () => {
  const httpWorkflow = (id: string, credential: { id: string; name: string }): Workflow => ({
    id,
    name: id,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'Call',
        name: 'Call',
        type: 'core.httpRequest',
        typeVersion: 1,
        position: [200, 0],
        parameters: { method: 'GET', url: echoUrl, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
        credentials: { httpHeaderAuth: credential },
      },
    ],
    connections: [{ id: 'e1', type: 'main', source: 'Start', target: 'Call', sourceIndex: 0, targetIndex: 0 }],
  });
  const run = (workflow: Workflow) => runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start', triggerItems: [{ json: {} }] });

  it('a workflow uses its own project’s credential, and one shared with its project', async () => {
    store.saveWorkflow(httpWorkflow('wf_run_team', { id: ids.credential, name: 'Team header' }));
    projects.setHomeProject('workflow', 'wf_run_team', team);
    received.length = 0;
    const own = await run(store.getWorkflow('wf_run_team')!);
    expect(own.status, JSON.stringify(own.error)).toBe('success');
    expect(received).toEqual(['team-secret']);

    // The owner's credential is shared with the team (previous block): usable here too.
    store.saveWorkflow(httpWorkflow('wf_run_team_shared', { id: ids.ownerCredential, name: 'Owner header' }));
    projects.setHomeProject('workflow', 'wf_run_team_shared', team);
    const shared = await run(store.getWorkflow('wf_run_team_shared')!);
    expect(shared.status, JSON.stringify(shared.error)).toBe('success');
    expect(received).toEqual(['team-secret', 'owner-secret']);
  });

  it('a workflow in another project can’t use it: the node fails and the secret never goes out', async () => {
    store.saveWorkflow(httpWorkflow('wf_run_dave', { id: ids.credential, name: 'Team header' }));
    projects.setHomeProject('workflow', 'wf_run_dave', projects.ensurePersonalProject(dave.id)!);
    received.length = 0;
    const result = await run(store.getWorkflow('wf_run_dave')!);
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error ?? result.runData)).toContain('isn’t available to this workflow’s project');
    expect(received).toEqual([]);
    // Even an admin's workflow follows its project: the owner's personal project can't use the team's credential.
    store.saveWorkflow(httpWorkflow('wf_run_owner', { id: ids.credential, name: 'Team header' }));
    projects.setHomeProject('workflow', 'wf_run_owner', `personal_${owner.id}`);
    expect((await run(store.getWorkflow('wf_run_owner')!)).status).toBe('error');
    expect(received).toEqual([]);
  });
});

// ---- move and transfer -------------------------------------------------------------------------------------

describe('move to project', () => {
  it('moves a workflow (and shares the credentials it uses) when the caller admins its project and edits the target', async () => {
    store.saveWorkflow({ ...store.getWorkflow('wf_run_team')!, id: 'wf_move' });
    projects.setHomeProject('workflow', 'wf_move', team);
    // Bob edits but doesn't admin the team project.
    expect(guard('POST', '/api/workflows/wf_move/transfer', bob)).toBe(403);
    // Alice admins Data and edits Ops.
    const moved = await call(workflowTransferRoute.POST, '/api/workflows/wf_move/transfer', 'POST', alice, { projectId: other, shareCredentials: true }, { id: 'wf_move' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ from: team, ownership: { projectId: other, projectName: 'Ops' }, sharedCredentials: [ids.credential] });
    expect(projects.homeProjectId('workflow', 'wf_move')).toBe(other);
    expect(projects.credentialUsableBy(ids.credential, other)).toBe(true);
    // It still runs from its new project.
    received.length = 0;
    expect((await runWorkflow({ workflow: store.getWorkflow('wf_move')!, mode: 'manual', startNodeId: 'Start', triggerItems: [{ json: {} }] })).status).toBe('success');
    expect(received).toEqual(['team-secret']);
    // Carol (Data viewer) lost it; she can't move things into a project she isn't an editor of.
    expect(guard('GET', '/api/workflows/wf_move', carol)).toBe(404);
  });

  it('moves a credential, keeping it usable by the project it left unless told otherwise', async () => {
    const created = await call(credentialsRoute.POST, `/api/credentials?projectId=${team}`, 'POST', alice, { name: 'Movable', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } });
    const id = created.body.credential.id as string;
    const moved = await call(credentialTransferRoute.POST, `/api/credentials/${id}/transfer`, 'POST', alice, { projectId: other }, { id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(projects.homeProjectId('credential', id)).toBe(other);
    expect(projects.credentialUsableBy(id, team)).toBe(true);
    expect(projects.shares('credential', id).map((s) => [s.projectId, s.role])).toEqual([[team, 'user']]);
    const again = await call(credentialTransferRoute.POST, `/api/credentials/${id}/transfer`, 'POST', admin, { projectId: team, keepAccess: false }, { id });
    expect(again.status).toBe(200);
    // Moved home: the share to its new home goes, and Ops doesn't keep it.
    expect(projects.shares('credential', id)).toEqual([]);
    expect(projects.credentialUsableBy(id, other)).toBe(false);
    // Into a project the caller can't edit: refused.
    expect((await call(credentialTransferRoute.POST, `/api/credentials/${id}/transfer`, 'POST', alice, { projectId: `personal_${bob.id}` }, { id })).status).toBe(403);
  });

  it('deletes a team project, moving what it owns in one transaction', async () => {
    const temp = projects.createTeamProject({ name: 'Temp' });
    projects.setHomeProject('workflow', 'wf_temp_1', temp.id);
    projects.setHomeProject('dataTable', 'dt_temp_1', temp.id);
    const refused = await call(projectRoute.DELETE, `/api/projects/${temp.id}`, 'DELETE', admin, undefined, { id: temp.id });
    expect(refused.status).toBe(409);
    expect(projects.getProject(temp.id)).toBeDefined();
    const deleted = await call(projectRoute.DELETE, `/api/projects/${temp.id}?transferTo=${other}`, 'DELETE', admin, undefined, { id: temp.id });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.moved).toEqual({ workflow: 1, dataTable: 1 });
    expect(projects.getProject(temp.id)).toBeUndefined();
    expect(projects.homeProjectId('workflow', 'wf_temp_1')).toBe(other);
  });
});

describe('removing a user transfers what they own', () => {
  it('asks where it goes, then moves it (and their shares) to another user, in one transaction', async () => {
    const erin = await makeUser('erin@example.com', 'Erin', 'member');
    const wf = (await call(workflowsRoute.POST, '/api/workflows', 'POST', erin, emptyWorkflow('Erin’s'))).body.workflow.id as string;
    const cred = (await call(credentialsRoute.POST, '/api/credentials', 'POST', erin, { name: 'Erin’s key', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'erin' } })).body.credential.id as string;
    projects.addShare('workflow', ids.ownerWorkflow, `personal_${erin.id}`, 'viewer');
    projects.setMember(team, erin.id, 'editor');

    const owned = await call(userResourcesRoute.GET, `/api/users/${erin.id}/resources`, 'GET', admin, undefined, { id: erin.id });
    expect(owned.body).toEqual({ projectId: `personal_${erin.id}`, counts: { workflow: 1, credential: 1 }, total: 2 });

    // Without a target: refused, nothing changes.
    const refused = await call(userRoute.DELETE, `/api/users/${erin.id}`, 'DELETE', admin, undefined, { id: erin.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/choose a user or project/);
    expect(auth.getUser(erin.id)).toBeDefined();
    // A failing transfer (unknown target) leaves everything as it was.
    expect((await call(userRoute.DELETE, `/api/users/${erin.id}`, 'DELETE', admin, { transferTo: { projectId: 'prj_missing' } }, { id: erin.id })).status).toBe(404);
    expect(projects.homeProjectId('workflow', wf)).toBe(`personal_${erin.id}`);
    expect(auth.getUser(erin.id)).toBeDefined();

    const removed = await call(userRoute.DELETE, `/api/users/${erin.id}`, 'DELETE', admin, { transferTo: { userId: dave.id } }, { id: erin.id });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ ok: true, moved: { workflow: 1, credential: 1 }, transferredTo: { id: `personal_${dave.id}`, type: 'personal' } });
    expect(auth.getUser(erin.id)).toBeUndefined();
    expect(auth.sessionUser(erin.session)).toBeUndefined();
    expect(projects.homeProjectId('workflow', wf)).toBe(`personal_${dave.id}`);
    expect(projects.homeProjectId('credential', cred)).toBe(`personal_${dave.id}`);
    expect(guard('PUT', `/api/workflows/${wf}`, dave)).toBe('ok');
    // What was shared with Erin is shared with Dave now; her memberships and personal project are gone.
    expect(projects.shares('workflow', ids.ownerWorkflow).map((s) => s.projectId)).toEqual([`personal_${dave.id}`]);
    expect(projects.getProject(`personal_${erin.id}`)).toBeUndefined();
    expect(projects.members(team).some((m) => m.userId === erin.id)).toBe(false);
  });

  it('to a team project, or without a target when they own nothing; never the owner', async () => {
    const finn = await makeUser('finn@example.com', 'Finn', 'member');
    const wf = (await call(workflowsRoute.POST, '/api/workflows', 'POST', finn, emptyWorkflow('Finn’s'))).body.workflow.id as string;
    const removed = await call(userRoute.DELETE, `/api/users/${finn.id}?transferToProject=${team}`, 'DELETE', owner, undefined, { id: finn.id });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(projects.homeProjectId('workflow', wf)).toBe(team);
    const gus = await makeUser('gus@example.com', 'Gus', 'member');
    expect((await call(userRoute.DELETE, `/api/users/${gus.id}`, 'DELETE', admin, undefined, { id: gus.id })).status).toBe(200);
    expect((await call(userRoute.DELETE, `/api/users/${owner.id}`, 'DELETE', admin, { transferTo: { userId: dave.id } }, { id: owner.id })).status).toBe(403);
  });
});
