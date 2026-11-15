/**
 * The join of "sessions belong to a project" (contracts/w9/agent-sessions.md, PC13) with PC06's availability and PC08's
 * what-it-saw: the sessions are made by the real paths (the test chat in A, "Test in project" B, a Run an Agent node in B's
 * workflow started by a member of B), the live events come from the runtime through the bus, and every cell of the
 * contract's table is read through the real routes. PC13's own test (agent-session-scope.test.ts) seeds its sessions
 * by hand; this one joins the sides. Projects A (agent X's home) and B (X shared to B). Ann: admin of A. Ben: editor of B
 * (a shared-only member: no role in X's home). Cat: viewer of A and B. Model calls go to the fake model server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { readSse, startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-session-scope-join-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const projects = await import('@/lib/server/projects');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { bus } = await import('@/lib/server/bus');
const { liveEventFilter } = await import('@/lib/server/projects/events');
const { listAgentFeedback } = await import('@/lib/server/chat-feedback');
const { canReadSessionById } = await import('@/lib/server/agents/session-scope');

const projectsRoute = await import('@/app/api/projects/route');
const sessionsRoute = await import('@/app/api/agents/[id]/sessions/route');
const sessionRoute = await import('@/app/api/agents/[id]/sessions/[sid]/route');
const feedbackRoute = await import('@/app/api/agents/[id]/sessions/[sid]/feedback/route');
const approvalsRoute = await import('@/app/api/agents/[id]/sessions/[sid]/approvals/route');
const chatRoute = await import('@/app/api/agents/[id]/chat/route');
const evalsRoute = await import('@/app/api/agents/[id]/evaluations/route');

registry.registerBuiltin(corePlugin);
// The judge (online evaluations) answers with a score; every other call is echoed.
const fake = await startFakeModels({ reply: (_provider, body) => (body?.model === 'judge' ? { text: '{"reasoning": "Fine.", "score": 2}' } : undefined) });
const ollama = fake.url.replace(/\/v1$/, '');

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
  role: 'owner' | 'admin' | 'member';
}

function request(path: string, method: string, caller: Caller, body?: unknown): Request {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

async function call(route: unknown, path: string, method: string, caller: Caller, body?: unknown, params?: Record<string, string>) {
  const response = await (route as Route)(request(path, method, caller, body), params && { params: Promise.resolve(params) });
  if (response.headers.get('content-type')?.includes('event-stream')) return { status: response.status, body: {} as Record<string, any>, text: '', events: await readSse(response) };
  const text = await response.text();
  let parsed: Record<string, any> | undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed as Record<string, any>, text, events: [] as Array<{ event: string; data: any }> };
}

const guard = (method: string, path: string, caller: Caller) => {
  const result = guardRequest(request(path, method, caller, ['GET', 'HEAD'].includes(method) ? undefined : {}));
  return result.ok ? 'ok' : result.response.status;
};

async function makeUser(email: string, name: string, role: Caller['role']): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token, role };
}

let owner: Caller, admin: Caller, ann: Caller, ben: Caller, cat: Caller;
let A = '';
let B = '';
let X = '';
let executionId = '';
const s = { sA: '', sB: '', sE: '', sOld: '' };
const events: Array<{ channel?: string; agentId?: string; projectId?: string; event?: { sessionId?: string } }> = [];
let stopListening = () => {};

/** A test chat through the real route; the session id from its stream. */
async function chat(caller: Caller, body: Record<string, unknown>) {
  const response = await call(chatRoute.POST, `/api/agents/${X}/chat`, 'POST', caller, { message: 'Hello', ...body }, { id: X });
  const sessionId = response.events.map((e) => e.data?.sessionId ?? e.data?.session?.id).find(Boolean) as string | undefined;
  return { ...response, sessionId };
}

beforeAll(async () => {
  auth.disableTestAuth();
  stopListening = bus.subscribe((event) => {
    if ((event as { channel?: string }).channel === 'agent') events.push(event as never);
  });
  owner = await makeUser('owner@join.test', 'Olive Owner', 'owner');
  admin = await makeUser('admin@join.test', 'Ada Admin', 'admin');
  ann = await makeUser('ann@join.test', 'Ann', 'member');
  ben = await makeUser('ben@join.test', 'Ben', 'member');
  cat = await makeUser('cat@join.test', 'Cat', 'member');
  A = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Alpha', members: [{ userId: ann.id, role: 'admin' }, { userId: cat.id, role: 'viewer' }] })).body.project.id;
  B = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Bravo', members: [{ userId: ben.id, role: 'editor' }, { userId: cat.id, role: 'viewer' }] })).body.project.id;
  const agent = agentStore.create({ name: 'Writer', instructions: 'Be brief.', model: { provider: 'ollama', model: 'writer', baseUrl: ollama } });
  X = agent.id;
  projects.setHomeProject('agent', X, A);
  agentStore.publish(X);
  projects.putShare('agent', X, B, 'user');

  // sOld: a session saved before wave 7, without a context (it stays with the agent's home).
  const old = newSession(agentStore.get(X)!, { source: 'test', userId: 'you', version: 'draft' });
  old.title = 'old';
  old.timeline.push({ id: 'reply_old', type: 'assistant', text: 'An old reply', at: '2026-01-01T00:00:00.000Z', model: 'm' });
  s.sOld = agentStore.saveSession(old).id;

  // sA: Ann's test chat in A (the agent's home). sB: an instance admin's "Test in project" B.
  s.sA = (await chat(ann, {})).sessionId!;
  s.sB = (await chat(admin, { projectId: B })).sessionId!;

  // sE: a Run an Agent node in B's workflow W, started by Ben.
  const wf: Workflow = {
    id: 'wf_join_scope',
    name: 'Flow in B',
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Agent', name: 'Agent', type: 'core.messageAgent', typeVersion: 1, position: [200, 0], parameters: { agentId: X, message: 'Draft the notes', conversation: 'new' } },
    ],
    connections: [{ id: 'Start-Agent', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  projects.setHomeProject('workflow', wf.id, B);
  const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start', startedBy: ben.id });
  expect(record.error?.message ?? record.status).toBe('success');
  executionId = record.executionId;
  s.sE = record.runData.Agent.at(-1)!.outputs[0][0].json.sessionId as string;
});

afterAll(async () => {
  stopListening();
  auth.enableTestAuth();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const list = (caller: Caller, query = '') => call(sessionsRoute.GET, `/api/agents/${X}/sessions${query}`, 'GET', caller, undefined, { id: X });
const one = (caller: Caller, sid: string) => call(sessionRoute.GET, `/api/agents/${X}/sessions/${sid}`, 'GET', caller, undefined, { id: X, sid });
const ids = (r: { body: Record<string, any> }) => (r.body.sessions as Array<{ id: string }>).map((x) => x.id).sort();
const sorted = (...keys: Array<keyof typeof s>) => keys.map((k) => s[k]).sort();

describe('the sessions the real paths made', () => {
  it('each carries the project its run resolved (PC08’s context), the old one none', () => {
    expect([s.sA, s.sB, s.sE].every(Boolean)).toBe(true);
    expect(agentStore.getSession(s.sA)?.context?.projectId).toBe(A);
    expect(agentStore.getSession(s.sB)?.context?.projectId).toBe(B);
    expect(agentStore.getSession(s.sE)).toMatchObject({ context: { projectId: B }, execution: { executionId } });
    expect(agentStore.getSession(s.sOld)?.context).toBeUndefined();
  });
});

describe('the contract’s table, every cell, through the real routes', () => {
  it('list', async () => {
    expect(ids(await list(ann))).toEqual(sorted('sA', 'sOld'));
    expect(ids(await list(ben))).toEqual(sorted('sB', 'sE'));
    expect(ids(await list(cat))).toEqual(sorted('sA', 'sB', 'sE', 'sOld'));
    expect(ids(await list(owner))).toEqual(sorted('sA', 'sB', 'sE', 'sOld'));
  });

  it('one session', async () => {
    const want: Array<[Caller, string, Record<keyof typeof s, number>]> = [
      [ann, 'ann', { sA: 200, sB: 404, sE: 404, sOld: 200 }],
      [ben, 'ben', { sA: 404, sB: 200, sE: 200, sOld: 404 }],
      [cat, 'cat', { sA: 200, sB: 200, sE: 200, sOld: 200 }],
      [owner, 'owner', { sA: 200, sB: 200, sE: 200, sOld: 200 }],
    ];
    for (const [caller, name, row] of want) {
      for (const key of Object.keys(row) as Array<keyof typeof s>) expect([name, key, (await one(caller, s[key])).status]).toEqual([name, key, row[key]]);
    }
  });

  it('?executionId=: a shared-only member opens the Run an Agent panel of their own run', async () => {
    expect((await list(ann, `?executionId=${executionId}`)).status).toBe(404);
    for (const caller of [ben, cat, owner]) {
      const r = await list(caller, `?executionId=${executionId}`);
      expect(r.status).toBe(200);
      expect(r.body.sessions.map((x: { id: string }) => x.id)).toEqual([s.sE]);
    }
    // The panel's session: the node's reply is in it.
    const panel = await list(ben, `?executionId=${executionId}&nodeId=Agent`);
    expect(JSON.stringify(panel.body.sessions[0].timeline)).toContain('Echo: Draft the notes');
  });

  it('the chat route: a session asked in another project is 409', async () => {
    const moved = await chat(admin, { sessionId: s.sB, projectId: A });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('This session belongs to project “Bravo”: start a new session there');
    // Continued in its own project, it stays there.
    const same = await chat(admin, { sessionId: s.sB, projectId: B });
    expect(same.status).toBe(200);
    expect(agentStore.getSession(s.sB)?.context?.projectId).toBe(B);
  });
  it('continue sB: Ann 404, Ben and Cat stopped by the guard, the owner 200', async () => {
    const path = `/api/agents/${X}/sessions/${s.sB}/feedback`;
    const entryId = agentStore.getSession(s.sB)!.timeline.findLast((e) => e.type === 'assistant')!.id;
    expect(guard('PUT', path, ann)).toBe('ok');
    expect((await call(feedbackRoute.PUT, path, 'PUT', ann, { entryId, rating: 'up' }, { id: X, sid: s.sB })).status).toBe(404);
    expect((await call(approvalsRoute.POST, `/api/agents/${X}/sessions/${s.sB}/approvals`, 'POST', ann, { callId: 'c', approved: true }, { id: X, sid: s.sB })).status).toBe(404);
    expect((await call(sessionRoute.DELETE, `/api/agents/${X}/sessions/${s.sB}`, 'DELETE', ann, undefined, { id: X, sid: s.sB })).status).toBe(404);
    expect((await chat(ann, { sessionId: s.sB })).status).toBe(404);
    expect(guard('PUT', path, ben)).toBe(403);
    expect(guard('PUT', path, cat)).toBe(403);
    expect(guard('PUT', path, owner)).toBe('ok');
    expect((await call(feedbackRoute.PUT, path, 'PUT', owner, { entryId, rating: 'down', comment: 'B secret comment' }, { id: X, sid: s.sB })).status).toBe(200);
  });

});

describe('what each person is sent and shown', () => {
  it('the live feed sends B’s session events to Ben and not to Ann', () => {
    const ofSession = (sid: string) => events.filter((e) => e.event?.sessionId === sid);
    const forB = [...ofSession(s.sB), ...ofSession(s.sE)];
    expect(forB.length).toBeGreaterThan(0);
    expect(forB.every((e) => e.projectId === B)).toBe(true);
    const sees = (c: Caller) => liveEventFilter({ id: c.id, role: c.role } as never);
    expect(forB.every(sees(ben))).toBe(true);
    expect(forB.some(sees(ann))).toBe(false);
    expect(forB.every(sees(cat))).toBe(true);
    const forA = ofSession(s.sA);
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.every(sees(ann))).toBe(true);
    expect(forA.some(sees(ben))).toBe(false);
  });

  it('listAgentFeedback and the online evaluation report hide B’s comment from Ann', async () => {
    const entryId = agentStore.getSession(s.sA)!.timeline.find((e) => e.type === 'assistant')!.id;
    expect((await call(feedbackRoute.PUT, `/api/agents/${X}/sessions/${s.sA}/feedback`, 'PUT', ann, { entryId, rating: 'down', comment: 'A comment' }, { id: X, sid: s.sA })).status).toBe(200);
    const readable = (c: Caller) => (sid: string) => canReadSessionById({ id: c.id, role: c.role } as never, agentStore.getSession(sid));
    expect(listAgentFeedback(X, undefined, 200, readable(ann)).map((f) => f.comment)).toEqual(['A comment']);
    expect(listAgentFeedback(X, undefined, 200, readable(ben)).map((f) => f.comment)).toEqual(['B secret comment']);

    // Grade both sessions through the real route (the judge on the fake model); each score carries its session's rating.
    expect((await call(evalsRoute.PUT, `/api/agents/${X}/evaluations`, 'PUT', owner, { enabled: true, sampleRate: 0, model: { provider: 'ollama', model: 'judge', baseUrl: ollama } }, { id: X })).status).toBe(200);
    for (const sid of [s.sA, s.sB]) expect((await call(evalsRoute.POST, `/api/agents/${X}/evaluations`, 'POST', owner, { sessionId: sid }, { id: X })).status).toBe(201);
    const forOwner = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', owner, undefined, { id: X });
    expect(forOwner.text).toContain('B secret comment');
    const forAnn = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', ann, undefined, { id: X });
    expect(forAnn.status).toBe(200);
    expect(forAnn.body.report.scores.map((x: { sessionId: string }) => x.sessionId)).toEqual([s.sA]);
    expect(forAnn.text).toContain('A comment');
    expect(forAnn.text).not.toContain('B secret comment');
    // Ann can't grade B's session either.
    expect((await call(evalsRoute.POST, `/api/agents/${X}/evaluations`, 'POST', ann, { sessionId: s.sB }, { id: X })).status).toBe(404);
  });
});
