/**
 * Sessions belong to a project (PC13, docs/projects-and-goals.md#sessions-belong-to-a-project): the contract's table through
 * the real routes, with real users and sessions. Projects A (agent X's home) and B (X shared to B). Ann: admin of A.
 * Ben: editor of B. Cat: viewer of A and B. Made-up data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-session-scope-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const projects = await import('@/lib/server/projects');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { emptyContext } = await import('@/lib/server/project-context/empty');
const { canContinueSession, canReadSession, sessionProjectId } = await import('@/lib/server/agents/session-scope');
const { liveEventFilter } = await import('@/lib/server/projects/events');
const { listAgentFeedback, setFeedback } = await import('@/lib/server/chat-feedback');
const { saveScore } = await import('@/lib/server/evaluations/store');
const { database } = await import('@/lib/server/db');

const agentsRoute = await import('@/app/api/agents/route');
const sessionsRoute = await import('@/app/api/agents/[id]/sessions/route');
const sessionRoute = await import('@/app/api/agents/[id]/sessions/[sid]/route');
const feedbackRoute = await import('@/app/api/agents/[id]/sessions/[sid]/feedback/route');
const approvalsRoute = await import('@/app/api/agents/[id]/sessions/[sid]/approvals/route');
const chatRoute = await import('@/app/api/agents/[id]/chat/route');
const evalsRoute = await import('@/app/api/agents/[id]/evaluations/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const projectsRoute = await import('@/app/api/projects/route');

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

let owner: Caller, admin: Caller, ann: Caller, ben: Caller, cat: Caller;
let A = '';
let B = '';
let X = '';
const s: Record<'sA' | 'sB' | 'sE' | 'sOld' | 'sGone', string> = { sA: '', sB: '', sE: '', sOld: '', sGone: '' };
const replyId = (sessionId: string) => `reply_${sessionId}`;

function saveSession(projectId: string | undefined, extra: { execution?: { workflowId: string; executionId: string; nodeId: string }; title?: string; at?: string } = {}) {
  const session = newSession(agentStore.get(X)!, { source: 'test', userId: 'you', version: 'draft' });
  if (projectId) session.context = { ...emptyContext(), mode: 'full', projectId };
  if (extra.execution) session.execution = extra.execution;
  if (extra.title) session.title = extra.title;
  session.timeline.push({ id: replyId(session.id), type: 'assistant', text: 'A reply', at: extra.at ?? new Date().toISOString(), model: 'm' });
  return agentStore.saveSession(session);
}

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  admin = await makeUser('admin@example.com', 'Ada Admin', 'admin');
  ann = await makeUser('ann@example.com', 'Ann', 'member');
  ben = await makeUser('ben@example.com', 'Ben', 'member');
  cat = await makeUser('cat@example.com', 'Cat', 'member');
  A = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Alpha', members: [{ userId: ann.id, role: 'admin' }, { userId: cat.id, role: 'viewer' }] })).body.project.id;
  B = (await call(projectsRoute.POST, '/api/projects', 'POST', admin, { name: 'Bravo', members: [{ userId: ben.id, role: 'editor' }, { userId: cat.id, role: 'viewer' }] })).body.project.id;
  X = (await call(agentsRoute.POST, `/api/agents?projectId=${A}`, 'POST', admin, { name: 'Writer' })).body.agent.id;
  projects.putShare('agent', X, B, 'user');

  const W = (await call(workflowsRoute.POST, `/api/workflows?projectId=${B}`, 'POST', admin, { name: 'Flow', nodes: [], connections: [] })).body.workflow.id;
  const now = new Date().toISOString();
  database().upsert('executions', { id: 'exec_e', workflow_id: W, status: 'success', mode: 'manual', started_at: now, finished_at: now, duration_ms: 1, summary: '{}', data: '{}' });

  s.sOld = saveSession(undefined, { title: 'old', at: '2026-01-01T00:00:00.000Z' }).id;
  s.sA = saveSession(A, { title: 'a' }).id;
  s.sB = saveSession(B, { title: 'b' }).id;
  s.sE = saveSession(B, { title: 'e', execution: { workflowId: W, executionId: 'exec_e', nodeId: 'n1' } }).id;
  // A project that was deleted: its sessions are for owners and admins only.
  const gone = projects.createTeamProject({ name: 'Gone' }).id;
  s.sGone = saveSession(gone, { title: 'gone' }).id;
  projects.deleteProjectWithTransfer(gone);
});

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const list = (caller: Caller, query = '') => call(sessionsRoute.GET, `/api/agents/${X}/sessions${query}`, 'GET', caller, undefined, { id: X });
const one = (caller: Caller, sid: string) => call(sessionRoute.GET, `/api/agents/${X}/sessions/${sid}`, 'GET', caller, undefined, { id: X, sid });
const titles = (r: { body: Record<string, any> }) => r.body.sessions.map((x: { title: string }) => x.title).sort();

describe('who reads which session (the contract table)', () => {
  it('the session list, by caller', async () => {
    expect(titles(await list(ann))).toEqual(['a', 'old']);
    expect(titles(await list(ben))).toEqual(['b', 'e']);
    expect(titles(await list(cat))).toEqual(['a', 'b', 'e', 'old']);
    expect(titles(await list(owner))).toEqual(['a', 'b', 'e', 'gone', 'old']);
    expect(titles(await list(admin))).toEqual(['a', 'b', 'e', 'gone', 'old']);
  });

  it('one session, by caller', async () => {
    const want: Record<string, Record<string, number>> = {
      ann: { sA: 200, sB: 404, sE: 404, sOld: 200, sGone: 404 },
      ben: { sA: 404, sB: 200, sE: 200, sOld: 404, sGone: 404 },
      cat: { sA: 200, sB: 200, sE: 200, sOld: 200, sGone: 404 },
      owner: { sA: 200, sB: 200, sE: 200, sOld: 200, sGone: 200 },
    };
    const who = { ann, ben, cat, owner } as Record<string, Caller>;
    for (const [name, row] of Object.entries(want)) {
      for (const [key, status] of Object.entries(row)) expect([name, key, (await one(who[name], s[key as keyof typeof s])).status]).toEqual([name, key, status]);
    }
  });

  it('?executionId= lists the run’s sessions for whoever reads the run', async () => {
    expect((await list(ann, '?executionId=exec_e')).status).toBe(404);
    for (const caller of [ben, cat, owner]) {
      const r = await list(caller, '?executionId=exec_e');
      expect(r.status).toBe(200);
      expect(r.body.sessions.map((x: { id: string }) => x.id)).toEqual([s.sE]);
    }
  });

  it('continuing: the guard needs run on the agent, then the caller must continue the session', async () => {
    const put = (caller: Caller, sid: string) => call(feedbackRoute.PUT, `/api/agents/${X}/sessions/${sid}/feedback`, 'PUT', caller, { entryId: replyId(sid), rating: 'up' }, { id: X, sid });
    const path = (sid: string) => `/api/agents/${X}/sessions/${sid}/feedback`;
    expect(guard('PUT', path(s.sB), ben)).toBe(403);
    expect(guard('PUT', path(s.sB), cat)).toBe(403);
    expect(guard('PUT', path(s.sB), ann)).toBe('ok');
    // Ann passes the guard (editor of the agent's home) but sB is not hers: 404.
    expect((await put(ann, s.sB)).status).toBe(404);
    expect((await put(ann, s.sA)).status).toBe(200);
    // Approvals and delete answer the same way.
    expect((await call(approvalsRoute.POST, `/api/agents/${X}/sessions/${s.sB}/approvals`, 'POST', ann, { callId: 'c', approved: true }, { id: X, sid: s.sB })).status).toBe(404);
    expect((await call(sessionRoute.DELETE, `/api/agents/${X}/sessions/${s.sB}`, 'DELETE', ann, undefined, { id: X, sid: s.sB })).status).toBe(404);
    expect((await one(owner, s.sB)).status).toBe(200);
  });

  it('the chat route: a session of another project is 404, one asked in another project is 409', async () => {
    const chat = (caller: Caller, body: Record<string, unknown>) => call(chatRoute.POST, `/api/agents/${X}/chat`, 'POST', caller, { message: 'hi', ...body }, { id: X });
    expect((await chat(ann, { sessionId: s.sB })).status).toBe(404);
    const moved = await chat(admin, { sessionId: s.sB, projectId: A });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('This session belongs to project “Bravo”: start a new session there');
    // A session with no context follows the agent's home.
    expect((await chat(admin, { sessionId: s.sOld, projectId: B })).status).toBe(409);
  });

  it('a session’s project: its own, else the agent’s home now', () => {
    expect(sessionProjectId(agentStore.getSession(s.sB)!)).toBe(B);
    expect(sessionProjectId(agentStore.getSession(s.sOld)!)).toBe(A);
    // Moving the agent to another home: a session without a project follows it, one with a project stays.
    projects.moveResource('agent', X, B);
    expect(sessionProjectId(agentStore.getSession(s.sOld)!)).toBe(B);
    expect(sessionProjectId(agentStore.getSession(s.sA)!)).toBe(A);
    projects.moveResource('agent', X, A);
    projects.putShare('agent', X, B, 'user');
  });

  it('the helpers read and continue as the table says', () => {
    const actor = (c: Caller, role: 'owner' | 'admin' | 'member') => ({ id: c.id, role }) as Parameters<typeof canReadSession>[0];
    const sB = agentStore.getSession(s.sB)!;
    expect(canReadSession(actor(ben, 'member'), sB)).toBe(true);
    expect(canContinueSession(actor(ben, 'member'), sB)).toBe(true);
    expect(canReadSession(actor(cat, 'member'), sB)).toBe(true);
    expect(canContinueSession(actor(cat, 'member'), sB)).toBe(false);
    expect(canReadSession(actor(ann, 'member'), sB)).toBe(false);
  });
});

describe('paging, the live feed and the readers of ratings', () => {
  it('a page with projectIds is full: sessions of other projects are cut before the page', () => {
    const only = { projectIds: new Set([B]), homeProjectId: A };
    const page = agentStore.listSessions(X, 2, only);
    expect(page.map((x) => x.title).sort()).toEqual(['b', 'e']);
    expect(agentStore.listSessions(X, 1, only)).toHaveLength(1);
    // A summary without a project counts as the home.
    expect(agentStore.listSessions(X, 10, { projectIds: new Set([A]), homeProjectId: A }).map((x) => x.title).sort()).toEqual(['a', 'old']);
    expect(agentStore.listSessions(X, 10, { projectIds: new Set([A]) }).map((x) => x.title)).toEqual(['a']);
  });

  it('the summary carries its project', () => {
    expect(agentStore.listSessions(X, 10).find((x) => x.title === 'b')?.projectId).toBe(B);
    expect(agentStore.listSessions(X, 10).find((x) => x.title === 'old')?.projectId).toBeUndefined();
  });

  it('the live feed shows an agent event to the members of its project', () => {
    const entry = (projectId?: string) => ({ channel: 'agent' as const, agentId: X, ...(projectId && { projectId }), event: { type: 'run.finished' as const, sessionId: 'x', status: 'idle' as const, reason: 'completed' as const, usage: { inputTokens: 0, outputTokens: 0 } } });
    const sees = (c: Caller, role: 'owner' | 'admin' | 'member', projectId?: string) => liveEventFilter({ id: c.id, role })(entry(projectId));
    expect([sees(ann, 'member', A), sees(ben, 'member', A), sees(cat, 'member', A), sees(admin, 'admin', A)]).toEqual([true, false, true, true]);
    expect([sees(ann, 'member', B), sees(ben, 'member', B), sees(cat, 'member', B), sees(admin, 'admin', B)]).toEqual([false, true, true, true]);
    // No project: the old rule (home members only).
    expect([sees(ann, 'member'), sees(ben, 'member'), sees(cat, 'member')]).toEqual([true, false, true]);
  });

  it('ratings and graded replies follow their session', async () => {
    setFeedback({ kind: 'agent', agentId: X, sessionId: s.sA, entryId: replyId(s.sA) }, 'down', { comment: 'A comment' });
    setFeedback({ kind: 'agent', agentId: X, sessionId: s.sB, entryId: replyId(s.sB) }, 'down', { comment: 'B secret comment' });
    const readable = (c: Caller, role: 'owner' | 'admin' | 'member') => (sid: string) => canReadSession({ id: c.id, role } as never, agentStore.getSession(sid)!);
    expect(listAgentFeedback(X, undefined, 200, readable(ann, 'member')).map((f) => f.comment)).toEqual(['A comment']);
    expect(listAgentFeedback(X, undefined, 200, readable(ben, 'member')).map((f) => f.comment)).toEqual(['B secret comment']);
    expect(listAgentFeedback(X).map((f) => f.comment).sort()).toEqual(['A comment', 'B secret comment']);

    for (const [id, sessionId, comment] of [['sc_a', s.sA, 'A comment'], ['sc_b', s.sB, 'B secret comment']] as const) {
      saveScore({ id, target: `agent:${X}`, createdAt: new Date().toISOString(), score: 2, flagged: true, reasoning: 'r', input: 'q', output: 'a', judge: 'j/m', agentId: X, sessionId, userFeedback: { rating: 'down', comment } });
    }
    const report = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', ann, undefined, { id: X });
    expect(report.status).toBe(200);
    expect(report.body.report.scores.map((x: { id: string }) => x.id)).toEqual(['sc_a']);
    expect(report.body.report.total).toBe(2);
    expect(report.text).not.toContain('B secret comment');
    const put = await call(evalsRoute.PUT, `/api/agents/${X}/evaluations`, 'PUT', ann, {}, { id: X });
    expect(put.status).toBe(200);
    expect(put.body.report.scores.map((x: { id: string }) => x.id)).toEqual(['sc_a']);
    expect(put.text).not.toContain('B secret comment');
    const all = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', owner, undefined, { id: X });
    expect(all.body.report.scores.map((x: { id: string }) => x.id).sort()).toEqual(['sc_a', 'sc_b']);
  });

  it('graded replies read each session once per call, and owners and admins read none', async () => {
    for (const id of ['sc_a2', 'sc_a3']) {
      saveScore({ id, target: `agent:${X}`, createdAt: new Date().toISOString(), score: 3, flagged: false, reasoning: 'r', input: 'q', output: 'a', judge: 'j/m', agentId: X, sessionId: s.sA });
    }
    const spy = vi.spyOn(agentStore, 'getSession');
    try {
      const report = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', ann, undefined, { id: X });
      expect(report.body.report.scores.map((x: { id: string }) => x.id).sort()).toEqual(['sc_a', 'sc_a2', 'sc_a3']);
      const reads = spy.mock.calls.map(([id]) => id);
      expect(reads.filter((id) => id === s.sA)).toHaveLength(1);
      expect(reads.filter((id) => id === s.sB)).toHaveLength(1);
      spy.mockClear();
      const all = await call(evalsRoute.GET, `/api/agents/${X}/evaluations`, 'GET', admin, undefined, { id: X });
      expect(all.body.report.scores.map((x: { id: string }) => x.id).sort()).toEqual(['sc_a', 'sc_a2', 'sc_a3', 'sc_b']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
