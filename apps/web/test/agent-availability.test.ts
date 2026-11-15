/**
 * Agents across projects (PC06): shares to projects or all projects, the availability helpers, the available-only list
 * and Run an Agent picker, the test-in-project check, and sessions read from the home project only.
 * Real users and sessions (the test bypass is off), made-up data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-availability-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const projects = await import('@/lib/server/projects');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { withTableScope } = await import('@/lib/server/datatables/projects');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { ALL_PROJECTS } = await import('@/lib/shared/projects');

const agentsRoute = await import('@/app/api/agents/route');
const agentSharesRoute = await import('@/app/api/agents/[id]/shares/route');
const agentChatRoute = await import('@/app/api/agents/[id]/chat/route');
const agentSessionsRoute = await import('@/app/api/agents/[id]/sessions/route');
const agentSessionRoute = await import('@/app/api/agents/[id]/sessions/[sid]/route');
const agentEvalsRoute = await import('@/app/api/agents/[id]/evaluations/route');
const agentGateRoute = await import('@/app/api/agents/[id]/eval-gate/route');
const dataTablesRoute = await import('@/app/api/data-tables/route');
const { liveEventFilter } = await import('@/lib/server/projects/events');
const loadOptionsRoute = await import('@/app/api/node-types/load-options/route');
const agentRoute = await import('@/app/api/agents/[id]/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowSharesRoute = await import('@/app/api/workflows/[id]/shares/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const credentialSharesRoute = await import('@/app/api/credentials/[id]/shares/route');
const projectsRoute = await import('@/app/api/projects/route');
const { database } = await import('@/lib/server/db');

registry.registerBuiltin(corePlugin);

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

function request(path: string, method: string, caller: Caller, body?: unknown): Request {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

async function call(route: unknown, path: string, method: string, caller: Caller, body?: unknown, params?: Record<string, string>) {
  const response = await (route as Route)(request(path, method, caller, body), params && { params: Promise.resolve(params) });
  const text = await response.text();
  let parsed: Record<string, any> | undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed as Record<string, any>, text };
}

const guard = (method: string, path: string, caller: Caller) => {
  const result = guardRequest(request(path, method, caller, ['GET', 'HEAD'].includes(method) ? undefined : {}));
  return result.ok ? 'ok' : result.response.status;
};

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

let owner: Caller, admin: Caller, ann: Caller, ben: Caller, cat: Caller, dan: Caller, eve: Caller;
let home = '';
let billing = '';
let quiet = '';
const ids = { agent: '', allAgent: '', session: '', billingAgent: '' };

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  admin = await makeUser('admin@example.com', 'Ada Admin', 'admin');
  ann = await makeUser('ann@example.com', 'Ann', 'member'); // admin of Ops
  ben = await makeUser('ben@example.com', 'Ben', 'member'); // editor of Ops
  cat = await makeUser('cat@example.com', 'Cat', 'member'); // editor of Billing revamp
  dan = await makeUser('dan@example.com', 'Dan', 'member'); // viewer of Ops
  eve = await makeUser('eve@example.com', 'Eve', 'member'); // in no team
  const ops = await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Operations', members: [{ userId: ann.id, role: 'admin' }, { userId: ben.id, role: 'editor' }, { userId: dan.id, role: 'viewer' }] });
  home = ops.body.project.id;
  const bill = await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Billing revamp', members: [{ userId: cat.id, role: 'editor' }] });
  billing = bill.body.project.id;
  quiet = projects.createTeamProject({ name: 'Quiet' }).id;

  ids.agent = (await call(agentsRoute.POST, `/api/agents?projectId=${home}`, 'POST', ben, { name: 'Release writer' })).body.agent.id;
  ids.allAgent = (await call(agentsRoute.POST, `/api/agents?projectId=${home}`, 'POST', ben, { name: 'Triage' })).body.agent.id;
  ids.billingAgent = (await call(agentsRoute.POST, `/api/agents?projectId=${billing}`, 'POST', cat, { name: 'Invoice checker' })).body.agent.id;
  const agent = agentStore.get(ids.agent)!;
  const session = newSession(agent, { source: 'api', userId: 'u', version: 'draft' });
  agentStore.saveSession(session);
  ids.session = session.id;
});

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const listIds = async (caller: Caller, query = '') => (await call(agentsRoute.GET, `/api/agents${query}`, 'GET', caller)).body.agents.map((a: { id: string }) => a.id).sort();
const putShares = (caller: Caller, id: string, body: unknown) => call(agentSharesRoute.PUT, `/api/agents/${id}/shares`, 'PUT', caller, body, { id });
const getShares = (caller: Caller, id: string) => call(agentSharesRoute.GET, `/api/agents/${id}/shares`, 'GET', caller, undefined, { id });

describe('a home-only agent', () => {
  it('is not seen, read or used by another project', async () => {
    expect(await listIds(cat)).toEqual([ids.billingAgent]);
    expect(projects.agentAvailableIn(ids.agent, billing)).toBe(false);
    expect(projects.availableAgentIds(billing).has(ids.agent)).toBe(false);
    expect(await listIds(cat, `?availableIn=${billing}`)).toEqual([ids.billingAgent]);
  });
});

describe('sharing to a project', () => {
  it('only a home admin (or an instance admin) may replace the shares', async () => {
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, ben)).toBe(403);
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, dan)).toBe(403);
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, cat)).toBe(404);
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, ann)).toBe('ok');
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, admin)).toBe('ok');
  });

  it('an unknown project is 404, the home is ignored, a bad body is 400', async () => {
    expect((await putShares(ann, ids.agent, { projectIds: ['prj_nope'], all: false })).status).toBe(404);
    expect((await putShares(ann, ids.agent, { projectIds: [ALL_PROJECTS], all: false })).status).toBe(404);
    expect((await putShares(ann, ids.agent, { projectIds: [billing, billing], all: false })).status).toBe(400);
    const ok = await putShares(ann, ids.agent, { projectIds: [home], all: false });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.shares).toEqual([]);
  });

  it('shares it, audited, and the answer matches the contract', async () => {
    const put = await putShares(ann, ids.agent, { projectIds: [billing], all: false });
    expect(put.status, put.text).toBe(200);
    // Ann has no role in Billing revamp, so it is left out of what she sees; the admin sees it.
    expect(put.body.availability).toEqual({ home: { id: home, name: 'Operations' }, all: false, projects: [] });
    expect((await getShares(admin, ids.agent)).body.availability.projects).toEqual([{ id: billing, name: 'Billing revamp' }]);
    expect(put.body.shares).toHaveLength(1);
    expect(put.body.shares[0]).toMatchObject({ projectId: billing, projectName: 'Billing revamp', projectType: 'team', role: 'user' });
    expect((await getShares(dan, ids.agent)).body.shares).toEqual(put.body.shares);
    expect(database().all<{ id: string }>("SELECT id FROM audit_events WHERE action = 'resource.share' AND target_id = ?", ids.agent).length).toBeGreaterThan(0);
  });

  it('the project sees it with access user, can neither change nor delete it, nor share it', async () => {
    expect(await listIds(cat)).toEqual([ids.agent, ids.billingAgent].sort());
    const listed = (await call(agentsRoute.GET, '/api/agents', 'GET', cat)).body.agents.find((a: { id: string }) => a.id === ids.agent);
    expect(listed.ownership).toMatchObject({ projectId: home, projectName: 'Operations', access: { role: 'user', home: false }, shared: true });
    expect(guard('GET', `/api/agents/${ids.agent}`, cat)).toBe('ok');
    expect(guard('PUT', `/api/agents/${ids.agent}`, cat)).toBe(403);
    expect(guard('DELETE', `/api/agents/${ids.agent}`, cat)).toBe(403);
    expect(guard('PUT', `/api/agents/${ids.agent}/shares`, cat)).toBe(403);
    expect(guard('POST', `/api/agents/${ids.agent}/sessions/x/approvals`, cat)).toBe(403);
    expect((await call(agentRoute.GET, `/api/agents/${ids.agent}`, 'GET', cat, undefined, { id: ids.agent })).status).toBe(200);
    expect(projects.agentAvailableIn(ids.agent, billing)).toBe(true);
    expect(projects.agentAvailableIn(ids.agent, quiet)).toBe(false);
    expect(await listIds(eve)).toEqual([]);
  });

  it('the caller sees only the projects they have a role in', async () => {
    await putShares(admin, ids.agent, { projectIds: [billing, quiet], all: false });
    expect((await getShares(cat, ids.agent)).body.availability.projects).toEqual([{ id: billing, name: 'Billing revamp' }]);
    expect((await getShares(admin, ids.agent)).body.availability.projects.map((p: { name: string }) => p.name)).toEqual(['Billing revamp', 'Quiet']);
    await putShares(ann, ids.agent, { projectIds: [billing], all: false });
  });

  it('?availableIn= needs a role in that project', async () => {
    expect((await call(agentsRoute.GET, `/api/agents?availableIn=${billing}`, 'GET', ben)).status).toBe(404);
    expect((await call(agentsRoute.GET, '/api/agents?availableIn=prj_nope', 'GET', ben)).status).toBe(404);
    expect(await listIds(cat, `?availableIn=${billing}`)).toEqual([ids.agent, ids.billingAgent].sort());
    expect(await listIds(ben, `?availableIn=${home}`)).toEqual([ids.agent, ids.allAgent].sort());
    expect(await listIds(admin, `?availableIn=${billing}`)).toEqual([ids.agent, ids.billingAgent].sort());
  });

  it('Run an Agent lists only what is available in the workflow\'s project', async () => {
    const options = async (projectId?: string, actor?: Caller) => (await withTableScope({ projectId }, () => registry.loadOptions('core.messageAgent', 'agents', {}))) as Array<{ value: string; description?: string }>;
    const inBilling = await options(billing);
    expect(inBilling.map((o) => o.value).sort()).toEqual([ids.agent, ids.billingAgent].sort());
    expect(inBilling.find((o) => o.value === ids.agent)?.description).toMatch(/^From Operations/);
    expect(inBilling.find((o) => o.value === ids.billingAgent)?.description).not.toMatch(/^From/);
    expect((await options(quiet)).map((o) => o.value)).toEqual([]);
    expect((await options(undefined)).map((o) => o.value).sort()).toEqual([ids.agent, ids.allAgent, ids.billingAgent].sort());
  });

  it('the test chat in an unavailable project is 403; an unknown role is 404', async () => {
    const chat = (caller: Caller, projectId: string) => call(agentChatRoute.POST, `/api/agents/${ids.allAgent}/chat`, 'POST', caller, { message: 'hi', projectId }, { id: ids.allAgent });
    const denied = await chat(admin, billing);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('This agent isn’t available in that project');
    expect((await chat(cat, home)).status).toBe(404);
  });
});

describe('sharing with all projects', () => {
  it('everyone sees it; it is not in shares; availability.all is true', async () => {
    const put = await putShares(ann, ids.allAgent, { projectIds: [], all: true });
    expect(put.status, put.text).toBe(200);
    expect(put.body.shares).toEqual([]);
    expect(put.body.availability).toEqual({ home: { id: home, name: 'Operations' }, all: true, projects: [] });
    for (const caller of [cat, eve]) expect(await listIds(caller)).toContain(ids.allAgent);
    const mine = (await call(agentsRoute.GET, '/api/agents', 'GET', eve)).body.agents.find((a: { id: string }) => a.id === ids.allAgent);
    expect(mine.ownership.access).toEqual({ role: 'user', home: false });
    expect(projects.agentAvailableIn(ids.allAgent, quiet)).toBe(true);
    expect(projects.availableAgentIds(quiet).has(ids.allAgent)).toBe(true);
    expect(projects.visibleIds({ id: eve.id, role: 'member' }, 'agent', [ids.allAgent, ids.agent])).toEqual(new Set([ids.allAgent]));
    expect(projects.resourceAccess({ id: eve.id, role: 'member' }, 'agent', ids.allAgent)).toEqual({ role: 'user', home: false });
    const chat = await call(agentChatRoute.POST, `/api/agents/${ids.allAgent}/chat`, 'POST', cat, { message: 'hi', projectId: billing }, { id: ids.allAgent });
    expect(chat.text).not.toContain('available in that project');
  });

  it('withOwnership(projectId) keeps shared and "all" agents', () => {
    const items = [{ id: ids.agent }, { id: ids.allAgent }, { id: ids.billingAgent }];
    const adminActor = { id: admin.id, role: 'admin' as const };
    const kept = projects.withOwnership(adminActor, 'agent', items, billing).map((i) => i.id).sort();
    expect(kept).toEqual([ids.agent, ids.allAgent, ids.billingAgent].sort());
    expect(projects.withOwnership(adminActor, 'agent', items, quiet).map((i) => i.id)).toEqual([ids.allAgent]);
    // A member only keeps what they see: Cat sees the shared and "all" agents and her own, not Eve's view of nothing.
    const catActor = { id: cat.id, role: 'member' as const };
    expect(projects.withOwnership(catActor, 'agent', items, billing).map((i) => i.id).sort()).toEqual([ids.agent, ids.allAgent, ids.billingAgent].sort());
    expect(projects.withOwnership({ id: eve.id, role: 'member' as const }, 'agent', items, billing).map((i) => i.id)).toEqual([ids.allAgent]);
  });

  it('the readers of resource_shares handle "*": per-kind, per-resource and per-project', () => {
    expect(projects.shares('agent', ids.allAgent).map((s) => s.projectId)).toEqual([ALL_PROJECTS]);
    expect(projects.allShares('agent').get(ids.allAgent)?.[0]?.projectId).toBe(ALL_PROJECTS);
    expect(projects.sharesTo(billing, 'agent').map((s) => s.resourceId)).toEqual([ids.agent]);
    expect(projects.sharesTo(ALL_PROJECTS, 'agent').map((s) => s.resourceId)).toEqual([ids.allAgent]);
  });

  it('a project delete and a transfer keep the "*" row', () => {
    const doomed = projects.createTeamProject({ name: 'Doomed' });
    projects.deleteProjectWithTransfer(doomed.id, quiet);
    expect(projects.shares('agent', ids.allAgent).map((s) => s.projectId)).toEqual([ALL_PROJECTS]);
    projects.moveResource('agent', ids.allAgent, quiet);
    expect(projects.shares('agent', ids.allAgent).map((s) => s.projectId)).toEqual([ALL_PROJECTS]);
    projects.moveResource('agent', ids.allAgent, home);
    // Moving an agent to a project it is shared with drops that share, as today.
    projects.moveResource('agent', ids.agent, billing);
    expect(projects.shares('agent', ids.agent)).toEqual([]);
    projects.moveResource('agent', ids.agent, home);
  });

  it('deleting the agent forgets its shares', () => {
    projects.putShare('agent', 'agt_gone', ALL_PROJECTS, 'user');
    projects.forgetResource('agent', 'agt_gone');
    expect(projects.shares('agent', 'agt_gone')).toEqual([]);
  });

  it('"*" is refused for workflows and credentials; their sharing is unchanged', async () => {
    const wf = (await call(workflowsRoute.POST, `/api/workflows?projectId=${home}`, 'POST', ben, { name: 'Flow', nodes: [], connections: [] })).body.workflow.id;
    const refused = await call(workflowSharesRoute.PUT, `/api/workflows/${wf}/shares`, 'PUT', ann, { shares: [{ projectId: ALL_PROJECTS, role: 'viewer' }] }, { id: wf });
    expect(refused.status).toBe(400);
    const okShare = await call(workflowSharesRoute.PUT, `/api/workflows/${wf}/shares`, 'PUT', ann, { shares: [{ projectId: billing, role: 'viewer' }] }, { id: wf });
    expect(okShare.status).toBe(200);
    expect(okShare.body.shares.map((s: { projectId: string }) => s.projectId)).toEqual([billing]);
    const cred = (await call(credentialsRoute.POST, `/api/credentials?projectId=${home}`, 'POST', ann, { name: 'Key', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } })).body.credential.id;
    const credRefused = await call(credentialSharesRoute.PUT, `/api/credentials/${cred}/shares`, 'PUT', ann, { shares: [{ projectId: ALL_PROJECTS, role: 'user' }] }, { id: cred });
    expect(credRefused.status).toBe(400);
  });
});

describe('sessions are read from home only', () => {
  it('a shared-only member (a project, or all) gets 404; a home viewer reads them', async () => {
    const list = (caller: Caller, id: string) => call(agentSessionsRoute.GET, `/api/agents/${id}/sessions`, 'GET', caller, undefined, { id });
    const one = (caller: Caller, id: string, sid: string) => call(agentSessionRoute.GET, `/api/agents/${id}/sessions/${sid}`, 'GET', caller, undefined, { id, sid });
    // ids.agent is shared to Billing; a session of it
    expect((await list(cat, ids.agent)).status).toBe(404);
    expect((await one(cat, ids.agent, ids.session)).status).toBe(404);
    expect((await list(dan, ids.agent)).status).toBe(200);
    expect((await list(dan, ids.agent)).body.sessions.map((s: { id: string }) => s.id)).toEqual([ids.session]);
    expect((await one(dan, ids.agent, ids.session)).status).toBe(200);
    expect((await list(admin, ids.agent)).status).toBe(200);
    // shared with all
    expect((await list(eve, ids.allAgent)).status).toBe(404);
  });

  it('the evaluation scores and the eval gate are home-only too', async () => {
    const evals = (caller: Caller, id: string) => call(agentEvalsRoute.GET, `/api/agents/${id}/evaluations`, 'GET', caller, undefined, { id });
    const gate = (caller: Caller, id: string) => call(agentGateRoute.GET, `/api/agents/${id}/eval-gate`, 'GET', caller, undefined, { id });
    for (const check of [evals, gate]) {
      expect((await check(cat, ids.agent)).status).toBe(404);
      expect((await check(eve, ids.allAgent)).status).toBe(404);
      expect((await check(dan, ids.agent)).status).toBe(200);
    }
  });

  it('load-options with agentId offers the home project\'s data tables to home members only', async () => {
    const table = (await call(dataTablesRoute.POST, `/api/data-tables?projectId=${home}`, 'POST', ben, { name: 'Ops private table', columns: [{ name: 'n', type: 'number' }] })).body.table.id as string;
    const tables = async (caller: Caller, agentId: string) =>
      ((await call(loadOptionsRoute.POST, '/api/node-types/load-options', 'POST', caller, { type: 'core.dataTable', method: 'tables', agentId })).body.options as Array<{ value: string }>).map((o) => o.value);
    expect(await tables(dan, ids.agent)).toContain(table);
    expect(await tables(cat, ids.agent)).not.toContain(table);
    expect(await tables(dan, ids.allAgent)).toContain(table);
    expect(await tables(eve, ids.allAgent)).not.toContain(table);
  });

  it('the live event feed drops an agent\'s session events for a project that only uses it', () => {
    const entry = (agentId: string) => ({ channel: 'agent' as const, agentId, event: { type: 'entry', sessionId: 's', entry: {} } as never });
    for (const id of [ids.agent, ids.allAgent]) {
      expect(liveEventFilter({ id: cat.id, role: 'member' })(entry(id))).toBe(false);
      expect(liveEventFilter({ id: eve.id, role: 'member' })(entry(id))).toBe(false);
      expect(liveEventFilter({ id: dan.id, role: 'member' })(entry(id))).toBe(true);
      expect(liveEventFilter({ id: admin.id, role: 'admin' })(entry(id))).toBe(true);
    }
  });
});
