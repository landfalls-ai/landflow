/**
 * C29 T-4 and T-6: the routes. The runner's two (public paths, the runner's own token): no token, a wrong one and a
 * revoked one are 401, a poll with a queued call answers it at once and with none 204 after the wait, an answer for
 * another runner's call is 404, the guard lets the path through without a session. The admin routes: a member reads
 * only the networks of their projects and gets 403 on writes, the register answer holds the token and no later read
 * does, revoke and delete work. The test bypass is off: every request carries a session, a key or a runner token.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-networks-routes-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const calls = await import('@/lib/server/networks/calls');
const store = await import('@/lib/server/networks/store');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const networksRoute = await import('@/app/api/settings/networks/route');
const networkRoute = await import('@/app/api/settings/networks/[id]/route');
const runnersRoute = await import('@/app/api/settings/networks/[id]/runners/route');
const runnerRoute = await import('@/app/api/settings/networks/[id]/runners/[runnerId]/route');
const pollRoute = await import('@/app/api/runner/v1/poll/route');
const answerRoute = await import('@/app/api/runner/v1/calls/[id]/route');
const loadOptionsRoute = await import('@/app/api/node-types/load-options/route');
const { queryEvents } = await import('@/lib/server/audit/store');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
const defaults = { ...calls.limits };
afterEach(() => Object.assign(calls.limits, defaults));

let n = 0;
const make = async (role: 'owner' | 'admin' | 'member') => {
  const user = await auth.createUser({ email: `r${++n}@example.test`, name: `R${n}`, role, password: 'a-long-password-1' });
  return { user, session: auth.createSession(user, 'password').token };
};
const runnerCall = (route: unknown, path: string, token: string | undefined, body?: unknown, params?: Record<string, string>) =>
  call(route, path, { method: 'POST', ...(body !== undefined && { body }), headers: token ? { authorization: `Bearer ${token}` } : {} }, params);

let owner: Awaited<ReturnType<typeof make>>;
beforeAll(async () => {
  owner = await make('owner');
});

const register = async (name = 'Office') => {
  const created = await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name } });
  expect(created.status).toBe(201);
  const networkId = created.body.network.id as string;
  const runner = await call(runnersRoute.POST, `/api/settings/networks/${networkId}/runners`, { session: owner.session, body: { name: 'office-1' } }, { id: networkId });
  expect(runner.status).toBe(201);
  return { networkId, runnerId: runner.body.runner.id as string, token: runner.body.token as string };
};

describe('the runner routes', () => {
  it('are public paths: the guard needs no session for them', () => {
    expect(isPublicPath('/api/runner/v1/poll')).toBe(true);
    expect(isPublicPath('/api/runner/v1/calls/call_1')).toBe(true);
    expect(isPublicPath('/api/settings/networks')).toBe(false);
  });

  it('answer 401 to no token, a wrong token and an API key', async () => {
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', undefined, {})).status).toBe(401);
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', 'lf_run_wrong', {})).status).toBe(401);
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', 'lf_0123456789abcdefghijklmnopqrstuv', {})).status).toBe(401);
    expect((await runnerCall(answerRoute.POST, '/api/runner/v1/calls/x', undefined, { status: 200, headers: [] }, { id: 'x' })).status).toBe(401);
  });

  it('hand a queued call out at once, and 204 when there is none after the wait', async () => {
    const { networkId, token } = await register('Poll net');
    calls.limits.pollWaitMs = 150;
    const empty = await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, { version: '0.1.0' });
    expect(empty.status).toBe(204);
    const id = await calls.enqueueCall(networkId, { method: 'GET', url: 'http://10.0.0.1/', headers: [], timeoutMs: 1_000 }, {});
    const started = Date.now();
    const polled = await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, { version: '0.1.0' });
    expect(polled.status).toBe(200);
    expect(polled.body).toMatchObject({ id, request: { method: 'GET', url: 'http://10.0.0.1/' } });
    expect(Date.now() - started).toBeLessThan(1_000);
    // It is seen: the list says online with the version.
    const list = await call(networksRoute.GET, '/api/settings/networks', { session: owner.session });
    expect(list.body.networks.find((x: { id: string }) => x.id === networkId).runners[0]).toMatchObject({ status: 'online', version: '0.1.0' });
  });

  it('max 0 only reports the runner is here', async () => {
    const { token } = await register('Heartbeat net');
    const started = Date.now();
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, { max: 0 })).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('take the answer of the claiming runner only: another runner’s answer is 404', async () => {
    const a = await register('Answer net A');
    const b = await register('Answer net B');
    calls.limits.pollWaitMs = 100;
    const id = await calls.enqueueCall(a.networkId, { method: 'GET', url: 'http://10.0.0.1/', headers: [], timeoutMs: 1_000 }, {});
    await runnerCall(pollRoute.POST, '/api/runner/v1/poll', a.token, {});
    const wrong = await runnerCall(answerRoute.POST, `/api/runner/v1/calls/${id}`, b.token, { status: 200, headers: [] }, { id });
    expect(wrong.status).toBe(404);
    const right = await runnerCall(answerRoute.POST, `/api/runner/v1/calls/${id}`, a.token, { status: 200, headers: [['content-type', 'text/plain']], body: Buffer.from('hi').toString('base64') }, { id });
    expect(right.status).toBe(204);
    expect(await calls.awaitAnswer(id, { timeoutMs: 1_000 })).toMatchObject({ status: 200 });
    // A malformed answer is a 400.
    expect((await runnerCall(answerRoute.POST, `/api/runner/v1/calls/${id}`, a.token, { nope: true }, { id })).status).toBe(400);
  });

  it('AS-5 at unit level: a revoked runner’s poll is 401, and one waiting is cut off within a second', async () => {
    const { networkId, runnerId, token } = await register('Revoke net');
    calls.limits.pollWaitMs = 5_000;
    const waiting = runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    expect((await call(runnerRoute.DELETE, `/api/settings/networks/${networkId}/runners/${runnerId}`, { method: 'DELETE', session: owner.session }, { id: networkId, runnerId })).status).toBe(200);
    expect((await waiting).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, {})).status).toBe(401);
  });

  it('polls leave no audit event of their own (connect is one)', async () => {
    const { token } = await register('Quiet audit net');
    calls.limits.pollWaitMs = 20;
    const before = queryEvents({}, { limit: 500 }).events.length;
    for (let i = 0; i < 3; i++) await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, {});
    const added = queryEvents({}, { limit: 500 }).events.length - before;
    expect(added).toBe(1); // network.runner.connected
  });
});

describe('the admin routes', () => {
  it('register answers the token once; a later read never holds it', async () => {
    const { networkId, token } = await register('Token route net');
    expect(token).toMatch(/^lf_run_/);
    const read = await call(networksRoute.GET, '/api/settings/networks', { session: owner.session });
    expect(JSON.stringify(read.body)).not.toContain(token);
    expect(read.body.networks.find((x: { id: string }) => x.id === networkId).runners[0]).toMatchObject({ name: 'office-1', hint: token.slice(-4), status: 'offline' });
  });

  it('a member reads only the networks of their projects and is refused every write', async () => {
    const member = await make('member');
    const project = projects.createTeamProject({ name: 'Routes team', createdBy: owner.user.id });
    projects.setMember(project.id, member.user.id, 'builder');
    const other = projects.createTeamProject({ name: 'Routes other', createdBy: owner.user.id });
    const mine = await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name: 'Mine route net', projectId: project.id } });
    await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name: 'Theirs route net', projectId: other.id } });
    const mineId = mine.body.network.id as string;
    const registered = await call(runnersRoute.POST, `/api/settings/networks/${mineId}/runners`, { session: owner.session, body: { name: 'member-visible', allowedIps: ['203.0.113.0/24'] } }, { id: mineId });
    store.markSeen(registered.body.runner.id, { version: '9.9.9', address: '203.0.113.5' });
    const read = await call(networksRoute.GET, '/api/settings/networks', { session: member.session });
    const names = read.body.networks.map((x: { name: string }) => x.name);
    // A member gets names and status only: no address, connect-from list, token hint, version, description or workflows.
    const seenByMember = read.body.networks.find((x: { id: string }) => x.id === mineId);
    expect(seenByMember).toEqual({ id: mineId, name: 'Mine route net', projectId: project.id, runners: [{ id: registered.body.runner.id, name: 'member-visible', status: 'online' }] });
    expect(JSON.stringify(read.body)).not.toMatch(/203\.0\.113|9\.9\.9/);
    const adminRead = await call(networksRoute.GET, '/api/settings/networks', { session: owner.session });
    expect(adminRead.body.networks.find((x: { id: string }) => x.id === mineId).runners[0]).toMatchObject({ address: '203.0.113.5', allowedIps: ['203.0.113.0/24'], version: '9.9.9' });
    expect(names).toContain('Mine route net');
    expect(names).not.toContain('Theirs route net');
    const id = mine.body.network.id as string;
    expect((await call(networksRoute.POST, '/api/settings/networks', { session: member.session, body: { name: 'Nope' } })).status).toBe(403);
    expect((await call(networkRoute.PUT, `/api/settings/networks/${id}`, { method: 'PUT', session: member.session, body: { name: 'Nope' } }, { id })).status).toBe(403);
    expect((await call(runnersRoute.POST, `/api/settings/networks/${id}/runners`, { session: member.session, body: { name: 'x' } }, { id })).status).toBe(403);
    expect((await call(networkRoute.DELETE, `/api/settings/networks/${id}`, { method: 'DELETE', session: member.session }, { id })).status).toBe(403);
  });

  it('a custom role holding settings:manage still can’t write: instance-wide writes are the built-in admin’s', async () => {
    const { createRole } = await import('@/lib/server/auth/roles');
    const role = createRole({ name: 'Settings holder', rules: [{ action: 'settings:manage', effect: 'allow' }] }, owner.user);
    const holder = await make('member');
    const { updateUser } = await import('@/lib/server/auth/users');
    updateUser(holder.user.id, { customRoleId: role.id } as never);
    expect((await call(networksRoute.POST, '/api/settings/networks', { session: holder.session, body: { name: 'Held net' } })).status).toBe(403);
  });

  it('validates input and answers 409 for a taken name, 404 for an unknown network', async () => {
    expect((await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name: '' } })).status).toBe(400);
    const first = await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name: 'Dup route net' } });
    expect(first.status).toBe(201);
    expect((await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name: 'Dup route net' } })).status).toBe(409);
    expect((await call(runnersRoute.POST, '/api/settings/networks/net_nope/runners', { session: owner.session, body: { name: 'x' } }, { id: 'net_nope' })).status).toBe(404);
    const id = first.body.network.id as string;
    expect((await call(runnersRoute.POST, `/api/settings/networks/${id}/runners`, { session: owner.session, body: { name: 'x', allowedIps: ['nonsense'] } }, { id })).status).toBe(400);
  });

  it('delete removes the network and its runners, and the runner’s token stops working', async () => {
    const { networkId, token } = await register('Delete route net');
    expect((await call(networkRoute.DELETE, `/api/settings/networks/${networkId}`, { method: 'DELETE', session: owner.session }, { id: networkId })).status).toBe(200);
    expect((await runnerCall(pollRoute.POST, '/api/runner/v1/poll', token, {})).status).toBe(401);
    const read = await call(networksRoute.GET, '/api/settings/networks', { session: owner.session });
    expect(read.body.networks.some((x: { id: string }) => x.id === networkId)).toBe(false);
  });

  it('the Run In menu lists only the networks the caller can see', async () => {
    const member = await make('member');
    const mine = projects.createTeamProject({ name: 'Menu mine', createdBy: owner.user.id });
    projects.setMember(mine.id, member.user.id, 'builder');
    const other = projects.createTeamProject({ name: 'Menu other', createdBy: owner.user.id });
    for (const [name, projectId] of [['Menu open', undefined], ['Menu mine net', mine.id], ['Menu other net', other.id]] as const) {
      await call(networksRoute.POST, '/api/settings/networks', { session: owner.session, body: { name, ...(projectId && { projectId }) } });
    }
    const names = async (session: string) => ((await call(loadOptionsRoute.POST, '/api/node-types/load-options', { session, body: { type: 'core.httpRequest', method: 'networks' } })).body.options as Array<{ name: string }>).map((o) => o.name);
    const forMember = await names(member.session);
    expect(forMember).toEqual(expect.arrayContaining(['Host (this Landflow)', 'Menu open', 'Menu mine net']));
    expect(forMember).not.toContain('Menu other net');
    expect(await names(owner.session)).toContain('Menu other net');
  });
});
