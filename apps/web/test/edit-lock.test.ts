/**
 * Edit locks (lib/server/auth/edit-locks.ts, /api/workflows/<id>/lock): one editor tab holds a workflow, renewals,
 * expiry, release, take-over rules (owners/admins, or the holder from another tab), `lock` events on the bus, and
 * the guard refusing a save from a tab that lost the lock (423).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-edit-lock-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { editLocks, LOCK_TTL_MS } = await import('@/lib/server/auth/edit-locks');
const { bus } = await import('@/lib/server/bus');
const lockRoute = await import('@/app/api/workflows/[id]/lock/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const workflowsRoute = await import('@/app/api/workflows/route');

const BASE = 'http://localhost:3000';
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(route: unknown, path: string, init: { method?: string; body?: unknown; session?: string; headers?: Record<string, string> }, params?: Record<string, string>) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.session) headers.cookie = `landflow_session=${init.session}`;
  const request = new Request(`${BASE}${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const response = await (route as Route)(request, params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

let owner: { id: string; session: string };
let admin: { id: string; session: string };
let member: { id: string; session: string };
let member2: { id: string; session: string };
let workflowId = '';

async function user(email: string, name: string, role: 'owner' | 'admin' | 'member') {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await user('owner@example.com', 'Olive', 'owner');
  admin = await user('admin@example.com', 'Ada', 'admin');
  member = await user('max@example.com', 'Max', 'member');
  member2 = await user('mia@example.com', 'Mia', 'member');
  // A team project everyone edits in (projects: members only reach workflows of their projects).
  const projects = await import('@/lib/server/projects');
  const team = projects.createTeamProject({ name: 'Team' });
  for (const one of [admin, member, member2]) projects.setMember(team.id, one.id, 'editor');
  const created = await call(workflowsRoute.POST, `/api/workflows?projectId=${team.id}`, { method: 'POST', body: { name: 'Locked', nodes: [], connections: [] }, session: owner.session });
  workflowId = created.body.workflow.id;
});

beforeEach(() => editLocks.clear());

afterAll(() => {
  auth.enableTestAuth();
  editLocks.clear();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const lock = (session: string, tabId: string, takeover = false) =>
  call(lockRoute.POST, `/api/workflows/${workflowId}/lock`, { method: 'POST', body: { tabId, ...(takeover && { takeover: true }) }, session }, { id: workflowId });

describe('edit locks (store)', () => {
  const holder = (tabId: string, userId = 'u1') => ({ userId, userName: userId, tabId });

  it('the first tab takes it, renews it, others wait; release frees it', () => {
    const t0 = Date.now();
    const first = editLocks.acquire('wf', holder('tab-a'), { now: t0 });
    expect(first.mine).toBe(true);
    const other = editLocks.acquire('wf', holder('tab-b', 'u2'), { now: t0 + 1000 });
    expect(other).toMatchObject({ mine: false, lock: { tabId: 'tab-a' } });
    const renewed = editLocks.acquire('wf', holder('tab-a'), { now: t0 + 5000 });
    expect(renewed.mine).toBe(true);
    expect(renewed.lock.since).toBe(first.lock.since);
    expect(Date.parse(renewed.lock.expiresAt)).toBe(t0 + 5000 + LOCK_TTL_MS);
    expect(editLocks.release('wf', 'tab-b')).toBe(false);
    expect(editLocks.release('wf', 'tab-a')).toBe(true);
    expect(editLocks.get('wf')).toBeUndefined();
  });

  it('expires when not renewed, and takeover replaces the holder', () => {
    const t0 = Date.now() - LOCK_TTL_MS - 1000;
    editLocks.acquire('wf', holder('tab-a'), { now: t0 });
    expect(editLocks.get('wf')).toBeUndefined();
    editLocks.acquire('wf', holder('tab-a'));
    const taken = editLocks.acquire('wf', holder('tab-b', 'u2'), { takeover: true });
    expect(taken).toMatchObject({ mine: true, lock: { tabId: 'tab-b', userId: 'u2' } });
  });

  it('publishes lock events on the bus (taken, released), not for renewals', () => {
    const events: unknown[] = [];
    const off = bus.subscribe((event) => event.channel === 'lock' && events.push(event.lock && { tabId: event.lock.tabId }));
    try {
      editLocks.acquire('wf-events', holder('tab-a'));
      editLocks.acquire('wf-events', holder('tab-a'));
      editLocks.release('wf-events', 'tab-a');
    } finally {
      off();
    }
    expect(events).toEqual([{ tabId: 'tab-a' }, null]);
  });

  it('removing a user drops their locks', () => {
    editLocks.acquire('wf-1', holder('tab-a', 'gone'));
    editLocks.acquire('wf-2', holder('tab-b', 'stays'));
    editLocks.releaseUser('gone');
    expect(editLocks.get('wf-1')).toBeUndefined();
    expect(editLocks.get('wf-2')).toBeDefined();
  });
});

describe('edit locks (API)', () => {
  it('one tab edits; another user is told who is editing', async () => {
    const mine = await lock(member.session, 'tab-member-1');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ mine: true, lock: { userId: member.id, userName: 'Max', tabId: 'tab-member-1' }, heartbeatMs: 10_000 });
    const theirs = await lock(member2.session, 'tab-member2-1');
    expect(theirs.body).toMatchObject({ mine: false, lock: { userName: 'Max' } });
    const got = await call(lockRoute.GET, `/api/workflows/${workflowId}/lock`, { session: owner.session }, { id: workflowId });
    expect(got.body.lock).toMatchObject({ userName: 'Max' });
  });

  it('members can’t take over from someone else; admins can; you can from your other tab', async () => {
    await lock(member.session, 'tab-member-1');
    const refused = await lock(member2.session, 'tab-member2-1', true);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Max');

    const ownTab = await lock(member.session, 'tab-member-2', true);
    expect(ownTab.body).toMatchObject({ mine: true, lock: { tabId: 'tab-member-2' } });

    const byAdmin = await lock(admin.session, 'tab-admin-1', true);
    expect(byAdmin.body).toMatchObject({ mine: true, lock: { userName: 'Ada' } });
    expect((await lock(member.session, 'tab-member-2')).body.mine).toBe(false);
  });

  it('a tab that lost the lock can’t save over the new editor (423); the holder and plain API calls can', async () => {
    await lock(member.session, 'tab-member-1');
    await lock(owner.session, 'tab-owner-1', true);
    const body = { name: 'Locked', nodes: [], connections: [] };
    const stale = await call(workflowRoute.PUT, `/api/workflows/${workflowId}`, { method: 'PUT', body, session: member.session, headers: { 'x-landflow-editor-tab': 'tab-member-1' } }, { id: workflowId });
    expect(stale.status).toBe(423);
    expect(stale.body).toMatchObject({ error: 'Olive is editing this workflow', lock: { tabId: 'tab-owner-1' } });
    const holder = await call(workflowRoute.PUT, `/api/workflows/${workflowId}`, { method: 'PUT', body, session: owner.session, headers: { 'x-landflow-editor-tab': 'tab-owner-1' } }, { id: workflowId });
    expect(holder.status).toBe(200);
    // Saves without an editor tab (scripts, the CLI) aren't lock-checked.
    expect((await call(workflowRoute.PUT, `/api/workflows/${workflowId}`, { method: 'PUT', body, session: member.session }, { id: workflowId })).status).toBe(200);
  });

  it('releases on close, and only for the holding tab', async () => {
    await lock(member.session, 'tab-member-1');
    const wrong = await call(lockRoute.DELETE, `/api/workflows/${workflowId}/lock?tabId=tab-other`, { method: 'DELETE', session: member.session }, { id: workflowId });
    expect(wrong.body.released).toBe(false);
    const released = await call(lockRoute.DELETE, `/api/workflows/${workflowId}/lock?tabId=tab-member-1`, { method: 'DELETE', session: member.session }, { id: workflowId });
    expect(released.body.released).toBe(true);
    expect((await lock(member2.session, 'tab-member2-1')).body.mine).toBe(true);
  });

  it('needs a signed-in user and an existing workflow', async () => {
    expect((await call(lockRoute.POST, `/api/workflows/${workflowId}/lock`, { method: 'POST', body: { tabId: 'tab-anon-1' } }, { id: workflowId })).status).toBe(401);
    const missing = await call(lockRoute.POST, '/api/workflows/wf_missing/lock', { method: 'POST', body: { tabId: 'tab-member-1' }, session: member.session }, { id: 'wf_missing' });
    expect(missing.status).toBe(404);
  });
});
