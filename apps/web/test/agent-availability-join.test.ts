/**
 * The join of agent availability (contract agent-availability-api): PC06's real routes answer, and PC07's
 * `project-names.ts` helpers and PC12's `member-options.ts` read those answers exactly as the screens do. Each side has its
 * own test with fakes (agent-availability, agent-screens, goal-pickers); this one wires both real sides on a seeded host.
 * Real users and sessions (the test bypass is off), made-up data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSummary } from '@/lib/shared/agents';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-availability-join-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const agentsRoute = await import('@/app/api/agents/route');
const agentSharesRoute = await import('@/app/api/agents/[id]/shares/route');
const agentChatRoute = await import('@/app/api/agents/[id]/chat/route');
const agentSessionsRoute = await import('@/app/api/agents/[id]/sessions/route');
const agentSessionRoute = await import('@/app/api/agents/[id]/sessions/[sid]/route');
const projectsRoute = await import('@/app/api/projects/route');
const names = await import('@/components/agents/project-names');
const { memberOptions, optionLabel, NOT_AVAILABLE } = await import('@/components/agents/member-options');

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

async function call(route: unknown, path: string, method: string, caller: Caller, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const response = await (route as Route)(request, params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any>, text };
}

async function makeUser(email: string, name: string, role: 'owner' | 'admin' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

let admin: Caller, ann: Caller, cat: Caller;
let ops = '';
let billing = '';
let quiet = '';
const ids = { writer: '', triage: '', invoice: '', session: '' };

beforeAll(async () => {
  auth.disableTestAuth();
  await makeUser('owner@join.test', 'Olive Owner', 'owner');
  admin = await makeUser('admin@join.test', 'Ada Admin', 'admin');
  ann = await makeUser('ann@join.test', 'Ann', 'member'); // admin of Operations
  cat = await makeUser('cat@join.test', 'Cat', 'member'); // editor of Billing revamp
  ops = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Operations', members: [{ userId: ann.id, role: 'admin' }] })).body.project.id;
  billing = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Billing revamp', members: [{ userId: cat.id, role: 'editor' }] })).body.project.id;
  quiet = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Quiet' })).body.project.id;
  const make = async (caller: Caller, projectId: string, name: string) => (await call(agentsRoute.POST, `/api/agents?projectId=${projectId}`, 'POST', caller, { name })).body.agent.id as string;
  ids.writer = await make(ann, ops, 'Release writer');
  ids.triage = await make(ann, ops, 'Triage');
  ids.invoice = await make(cat, billing, 'Invoice checker');
  // One agent shared to Billing revamp, one with every project ('*').
  expect((await call(agentSharesRoute.PUT, `/api/agents/${ids.writer}/shares`, 'PUT', ann, { projectIds: [billing], all: false }, { id: ids.writer })).status).toBe(200);
  expect((await call(agentSharesRoute.PUT, `/api/agents/${ids.triage}/shares`, 'PUT', ann, { projectIds: [], all: true }, { id: ids.triage })).status).toBe(200);
  const session = newSession(agentStore.get(ids.writer)!, { source: 'api', userId: 'u', version: 'draft' });
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

const availability = async (caller: Caller, id: string) => (await call(agentSharesRoute.GET, `/api/agents/${id}/shares`, 'GET', caller, undefined, { id })).body.availability as import('@/components/agents/project-names').AvailabilityAnswer;
const callerProjects = async (caller: Caller) => ((await call(projectsRoute.GET, '/api/projects', 'GET', caller)).body.projects as Array<{ id: string; name: string }>).map((p) => ({ id: p.id, name: p.name }));

describe('PC06 shares → PC07 project-names', () => {
  it('the Available in line and Test in project read the real answer as they read the contract example', async () => {
    const shared = await availability(admin, ids.writer);
    expect(names.availabilityLabel(shared)).toBe('Operations, Billing revamp');
    expect(names.testProjectOptions(shared)).toEqual([
      { id: ops, name: 'Operations' },
      { id: billing, name: 'Billing revamp' },
    ]);
    // Ann (no role in Billing revamp) sees the home alone.
    expect(names.availabilityLabel(await availability(ann, ids.writer))).toBe('Operations');

    const everywhere = await availability(cat, ids.triage);
    expect(names.availabilityLabel(everywhere)).toBe('All projects');
    // With All projects, Test in project offers the home and every project the person sees (as test-chat.tsx asks).
    const options = names.testProjectOptions(everywhere, await callerProjects(cat));
    expect(options[0]).toEqual({ id: ops, name: 'Operations' });
    expect(options.map((p) => p.id)).toContain(billing);
    expect(options.map((p) => p.id)).not.toContain(quiet);
  });

  it('the dialog keeps the shares and sends a body the route accepts', async () => {
    const shares = (await call(agentSharesRoute.GET, `/api/agents/${ids.writer}/shares`, 'GET', admin, undefined, { id: ids.writer })).body.shares;
    const selected = names.sharedIds(shares, ops);
    expect(selected).toEqual([billing]);
    const put = await call(agentSharesRoute.PUT, `/api/agents/${ids.writer}/shares`, 'PUT', ann, names.availabilityBody(selected, false, ops), { id: ids.writer });
    expect(put.status, put.text).toBe(200);
    expect(put.body.shares.map((s: { projectId: string }) => s.projectId)).toEqual([billing]);
  });

  it('a card says where a shared agent comes from, and who may change it', async () => {
    const list = (await call(agentsRoute.GET, '/api/agents', 'GET', cat)).body.agents as unknown[];
    const find = (id: string) => list.find((a) => (a as { id: string }).id === id);
    expect(names.sharedFromLabel(names.ownershipOfSummary(find(ids.writer)))).toBe('Shared from Operations');
    expect(names.sharedFromLabel(names.ownershipOfSummary(find(ids.invoice)))).toBeUndefined();
    expect(names.canMakeAvailable(names.ownershipOfSummary(find(ids.writer)))).toBe(false);
    const annList = (await call(agentsRoute.GET, '/api/agents', 'GET', ann)).body.agents as unknown[];
    expect(names.canMakeAvailable(names.ownershipOfSummary(annList.find((a) => (a as { id: string }).id === ids.writer)))).toBe(true);
  });
});

describe('PC06 ?availableIn= → PC12 member-options', () => {
  it('a team in Billing revamp is offered its own agent and the shared ones, labelled', async () => {
    const all = (await call(agentsRoute.GET, '/api/agents', 'GET', admin)).body.agents as AgentSummary[];
    const available = (await call(agentsRoute.GET, `/api/agents?availableIn=${billing}`, 'GET', cat)).body.agents;
    const options = memberOptions(all, available);
    expect(options.map((o) => o.id).sort()).toEqual([ids.invoice, ids.triage, ids.writer].sort());
    expect(options.find((o) => o.id === ids.invoice)?.note).toBeUndefined();
    expect(optionLabel(options.find((o) => o.id === ids.writer)!)).toContain('Shared from Operations');
    expect(optionLabel(options.find((o) => o.id === ids.triage)!)).toBe('Triage  ·  Shared from Operations');
  });

  it('a team in Quiet is offered only the all-projects agent, and keeps a member that is not available', async () => {
    const all = (await call(agentsRoute.GET, '/api/agents', 'GET', admin)).body.agents as AgentSummary[];
    const available = (await call(agentsRoute.GET, `/api/agents?availableIn=${quiet}`, 'GET', admin)).body.agents;
    const options = memberOptions(all, available, [ids.writer]);
    expect(options.map((o) => o.id)).toEqual([ids.triage, ids.writer]);
    expect(options[1]).toMatchObject({ id: ids.writer, name: 'Release writer', note: NOT_AVAILABLE });
  });
});

describe('the walls the screens rely on', () => {
  it('the test chat in a project the agent is not available in is 403, and the screen says so', async () => {
    const denied = await call(agentChatRoute.POST, `/api/agents/${ids.writer}/chat`, 'POST', admin, { message: 'hi', projectId: quiet }, { id: ids.writer });
    expect(denied.status).toBe(403);
    expect(names.testProjectOptions(await availability(admin, ids.writer)).map((p) => p.id)).not.toContain(quiet);
    // use-agent-run.ts shows its own sentence on any 403 of a test in a project.
    expect(names.NOT_AVAILABLE_MESSAGE.replace('’', "'")).toBe(denied.body.error.replace('’', "'"));
  });

  it('a shared-only member lists none of the agent’s home sessions and gets 404 on one; a home member reads them', async () => {
    // PC13: the list is 200 and empty of the home project's sessions; the session itself is still 404.
    const shared = await call(agentSessionsRoute.GET, `/api/agents/${ids.writer}/sessions`, 'GET', cat, undefined, { id: ids.writer });
    expect(shared.status).toBe(200);
    expect(shared.body.sessions).toEqual([]);
    expect((await call(agentSessionRoute.GET, `/api/agents/${ids.writer}/sessions/${ids.session}`, 'GET', cat, undefined, { id: ids.writer, sid: ids.session })).status).toBe(404);
    const home = await call(agentSessionsRoute.GET, `/api/agents/${ids.writer}/sessions`, 'GET', ann, undefined, { id: ids.writer });
    expect(home.status).toBe(200);
    expect(home.body.sessions.map((s: { id: string }) => s.id)).toEqual([ids.session]);
  });
});
