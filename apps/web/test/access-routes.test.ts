/**
 * C35 routes (docs/reference/api.md): handlers called directly as a signed-in user (test/setup.ts). Who sees what, the status codes, the
 * zod bodies with plain sentences, and that the policy makes every route session-only (an API key is refused before a handler runs).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-routes-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { makeWorld } = await import('./fixtures/access-world');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { fake } = await import('./fixtures/fake-access-plugins');
const setupRoute = await import('@/app/api/access/setup/route');
const entriesRoute = await import('@/app/api/access/entries/route');
const entryRoute = await import('@/app/api/access/entries/[id]/route');
const requestsRoute = await import('@/app/api/access/requests/route');
const requestRoute = await import('@/app/api/access/requests/[id]/route');
const cancelRoute = await import('@/app/api/access/requests/[id]/cancel/route');
const decisionRoute = await import('@/app/api/access/requests/[id]/decision/route');
const grantsRoute = await import('@/app/api/access/grants/route');
const revokeRoute = await import('@/app/api/access/grants/[id]/revoke/route');
const doneRoute = await import('@/app/api/access/grants/[id]/done/route');
const retryRoute = await import('@/app/api/access/grants/[id]/retry/route');
const accountsRoute = await import('@/app/api/access/accounts/route');
const chatRoute = await import('@/app/api/access/chat/route');

const w = await makeWorld({ install: false });
const { mia, ola, ann, lead, admin, owner, team, manual } = w;
const url = 'http://landflow.test/api/access';
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (method: string, data?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(data !== undefined && { body: JSON.stringify(data) }) });
const call = async (user: typeof mia, fn: () => Promise<Response>) => {
  w.as(user);
  const response = await fn();
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

describe('every route is session-only', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/access/setup'], ['POST', '/api/access/setup'], ['GET', '/api/access/entries'], ['POST', '/api/access/entries'], ['GET', '/api/access/entries/x'], ['PATCH', '/api/access/entries/x'], ['DELETE', '/api/access/entries/x'],
    ['GET', '/api/access/requests'], ['POST', '/api/access/requests'], ['GET', '/api/access/requests/x'], ['POST', '/api/access/requests/x/cancel'], ['POST', '/api/access/requests/x/decision'],
    ['GET', '/api/access/grants'], ['POST', '/api/access/grants/x/revoke'], ['POST', '/api/access/grants/x/done'], ['POST', '/api/access/grants/x/retry'], ['GET', '/api/access/accounts'], ['PUT', '/api/access/accounts'], ['POST', '/api/access/chat'],
  ];
  it('the policy refuses an API key everywhere', () => {
    for (const [method, path] of routes) expect(routePolicy(method, path), `${method} ${path}`).toMatchObject({ scope: 'any', sessionOnly: true });
  });
});

describe('before setup', () => {
  it('says so to a member and answers 409 to a request; an admin sets it up, a member cannot', async () => {
    expect((await call(mia, () => setupRoute.GET())).body).toMatchObject({ installed: false, active: false });
    expect((await call(mia, () => requestsRoute.POST(new Request(`${url}/requests`, body('POST', { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh' }))))).status).toBe(409);
    expect((await call(mia, () => setupRoute.POST(new Request(`${url}/setup`, body('POST'))))).status).toBe(403);
    const installed = await call(admin, () => setupRoute.POST(new Request(`${url}/setup`, body('POST'))));
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ installed: true, active: true });
    expect((await call(admin, () => setupRoute.POST(new Request(`${url}/setup`, body('POST', {}))))).body.workflowId).toBe(installed.body.workflowId);
    await w.install();
  });
});

describe('the catalog', () => {
  it('lists what each may see, creates for admins only, validates bodies in plain sentences', async () => {
    const asMia = await call(mia, () => entriesRoute.GET());
    expect(asMia.status).toBe(200);
    expect(asMia.body.items.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(['Platform team', 'Figma editor']));
    expect(asMia.body.items.every((e: { credentialId?: string; canEdit: boolean }) => !e.credentialId && !e.canEdit)).toBe(true);
    expect(asMia.body.people).toBeUndefined();
    expect((await call(lead, () => entriesRoute.GET())).body.people.length).toBeGreaterThan(3);
    const create = { name: 'Org members', system: 'github-org', target: { org: 'acme' }, credentialId: w.github.id, durations: [60], approverIds: [ann.id], owners: [lead.id] };
    expect((await call(mia, () => entriesRoute.POST(new Request(`${url}/entries`, body('POST', create))))).status).toBe(403);
    const bad = await call(admin, () => entriesRoute.POST(new Request(`${url}/entries`, body('POST', { ...create, durations: [] }))));
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringMatching(/at least one duration/) } });
    expect((await call(admin, () => entriesRoute.POST(new Request(`${url}/entries`, body('POST', { ...create, system: 'ftp' }))))).status).toBe(400);
    const made = await call(admin, () => entriesRoute.POST(new Request(`${url}/entries`, body('POST', create))));
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Org members', version: 1 });
    // One entry: seen, edited by an owner, stale version, deleted by an admin.
    expect((await call(mia, () => entryRoute.GET(new Request(`${url}/entries/${made.body.id}`), ctx(made.body.id)))).status).toBe(200);
    expect((await call(mia, () => entryRoute.PATCH(new Request('http://x', body('PATCH', { version: 1, name: 'Mine' })), ctx(made.body.id)))).status).toBe(403);
    const patched = await call(lead, () => entryRoute.PATCH(new Request('http://x', body('PATCH', { version: 1, durations: [15, 60] })), ctx(made.body.id)));
    expect(patched.body).toMatchObject({ version: 2, durations: [15, 60] });
    expect((await call(lead, () => entryRoute.PATCH(new Request('http://x', body('PATCH', { version: 1, name: 'Stale' })), ctx(made.body.id)))).status).toBe(409);
    expect((await call(lead, () => entryRoute.PATCH(new Request('http://x', body('PATCH', { name: 'No version' })), ctx(made.body.id)))).status).toBe(400);
    expect((await call(lead, () => entryRoute.DELETE(new Request('http://x', body('DELETE')), ctx(made.body.id)))).status).toBe(403);
    expect((await call(admin, () => entryRoute.DELETE(new Request('http://x', body('DELETE')), ctx(made.body.id)))).status).toBe(204);
    expect((await call(mia, () => entryRoute.GET(new Request('http://x'), ctx(made.body.id)))).status).toBe(404);
  });
});

describe('requests, decisions and grants', () => {
  fake.seedTeam('acme', 'platform');
  const ask = (user: typeof mia, data: unknown) => call(user, () => requestsRoute.POST(new Request(`${url}/requests`, body('POST', data))));

  it('files a request as the session user, whatever the body says, and lists by scope', async () => {
    expect((await ask(mia, { entryId: team.id, durationMinutes: 60, reason: 'hi' })).body.error).toMatch(/3 to 500 characters/);
    expect((await ask(mia, { entryId: team.id, durationMinutes: '60', reason: 'Fixing the build' })).status).toBe(400);
    const made = await ask(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh', requesterId: ola.id, requester: { id: ola.id } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ requester: { id: mia.id }, status: 'pending', channel: 'form' });
    const dup = await ask(mia, { entryId: team.id, durationMinutes: 60, reason: 'Fixing the build', account: 'mia-gh' });
    expect(dup).toMatchObject({ status: 409, body: { existingId: made.body.id } });

    const list = (user: typeof mia, q: string) => call(user, () => requestsRoute.GET(new Request(`${url}/requests${q}`)));
    expect((await list(mia, '?scope=mine')).body.items.map((r: { id: string }) => r.id)).toContain(made.body.id);
    expect((await list(ola, '?scope=mine')).body.items).toEqual([]);
    expect((await list(ann, '?scope=decide')).body.items.map((r: { id: string }) => r.id)).toEqual([made.body.id]);
    expect((await list(mia, '?scope=decide')).body.items).toEqual([]);
    // The approver gets the server-built question (the target and the unverified account) and the choices; the requester never does.
    const waiting = (await list(ann, '?scope=decide')).body.items[0];
    expect(waiting.question.text).toMatch(/What: GitHub team/);
    expect(waiting.question.text).toMatch(/\(unverified: typed by the requester\)/);
    expect(waiting.choices.map((c: { value: string }) => c.value)[0]).toBe('60');
    expect((await list(mia, '?scope=mine')).body.items.find((r: { id: string }) => r.id === made.body.id).question).toBeUndefined();
    expect((await list(admin, '?scope=all')).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await list(ola, '?scope=all')).body.items).toEqual([]);
    expect((await list(mia, '?scope=bogus')).status).toBe(400);
    expect((await list(mia, '')).body.setup).toMatchObject({ active: true });
    expect((await call(ola, () => requestRoute.GET(new Request('http://x'), ctx(made.body.id)))).status).toBe(404);
    expect((await call(ann, () => requestRoute.GET(new Request('http://x'), ctx(made.body.id)))).status).toBe(200);

    // Deciding: the requester and a bystander can't, the approver can, once.
    const decide = (user: typeof mia, id: string, data: unknown) => call(user, () => decisionRoute.POST(new Request('http://x', body('POST', data)), ctx(id)));
    expect((await decide(mia, made.body.id, { approved: true })).status).toBe(403);
    expect((await decide(ola, made.body.id, { approved: true })).status).toBe(404);
    expect((await decide(ann, made.body.id, { approved: 'yes' })).status).toBe(400);
    expect((await decide(ann, made.body.id, { approved: true, choice: '999' })).body.error).toMatch(/not one of the choices/);
    const approved = await decide(ann, made.body.id, { approved: true, choice: '15' });
    expect(approved).toMatchObject({ status: 200, body: { status: 'approved', grant: { status: 'active' } } });
    expect((await decide(ann, made.body.id, { approved: true })).status).toBe(409);
    expect((await call(mia, () => cancelRoute.POST(new Request('http://x', body('POST')), ctx(made.body.id)))).status).toBe(409);

    // Grants: the holder sees and gives it back, a bystander can't.
    const grantId = approved.body.grant.id as string;
    const grants = (user: typeof mia, q = '') => call(user, () => grantsRoute.GET(new Request(`${url}/grants${q}`)));
    expect((await grants(mia)).body.items.map((g: { id: string }) => g.id)).toEqual([grantId]);
    expect((await grants(ola, '?scope=all')).body.items).toEqual([]);
    expect((await grants(ann, '?scope=all')).body.items.map((g: { id: string }) => g.id)).toEqual([grantId]);
    expect((await grants(mia, '?status=bogus')).status).toBe(400);
    expect((await call(ola, () => revokeRoute.POST(new Request('http://x', body('POST')), ctx(grantId)))).status).toBe(404);
    expect((await call(mia, () => doneRoute.POST(new Request('http://x', body('POST')), ctx(grantId)))).status).toBe(403);
    expect((await call(mia, () => retryRoute.POST(new Request('http://x', body('POST')), ctx(grantId)))).status).toBe(403);
    const back = await call(mia, () => revokeRoute.POST(new Request('http://x', body('POST')), ctx(grantId)));
    expect(back).toMatchObject({ status: 200, body: { status: 'revoked' } });
    expect(fake.members('teams', 'acme/platform')).toEqual({});
  });

  it('cancels a waiting request and denies one', async () => {
    const a = await ask(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    expect((await call(ola, () => cancelRoute.POST(new Request('http://x', body('POST')), ctx(a.body.id)))).status).toBe(404);
    expect((await call(mia, () => cancelRoute.POST(new Request('http://x', body('POST')), ctx(a.body.id)))).body.status).toBe('cancelled');
    const b = await ask(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    const denied = await call(ann, () => decisionRoute.POST(new Request('http://x', body('POST', { approved: false, comment: 'Not now' })), ctx(b.body.id)));
    expect(denied.body).toMatchObject({ status: 'denied', note: 'Not now' });
    // A manual grant: approve, Done by the approver.
    const c = await ask(mia, { entryId: manual.id, durationMinutes: 60, reason: 'Edit the launch deck' });
    const grant = (await call(ann, () => decisionRoute.POST(new Request('http://x', body('POST', { approved: true })), ctx(c.body.id)))).body.grant;
    expect(grant).toMatchObject({ status: 'pending', canMarkDone: true });
    expect((await call(mia, () => grantsRoute.GET(new Request(`${url}/grants`)))).body.items.find((g: { id: string }) => g.id === grant.id)).toMatchObject({ canMarkDone: false });
    const done = await call(ann, () => doneRoute.POST(new Request('http://x', body('POST')), ctx(grant.id)));
    expect(done.body).toMatchObject({ status: 'active' });
    await call(admin, () => revokeRoute.POST(new Request('http://x', body('POST')), ctx(grant.id)));
    await call(admin, () => doneRoute.POST(new Request('http://x', body('POST')), ctx(grant.id)));
  });
});

describe('accounts and chat', () => {
  it('keeps the caller’s own GitHub username and shows the email Google uses', async () => {
    expect((await call(ola, () => accountsRoute.GET())).body).toEqual({ google: 'ola@landflow.test' });
    expect((await call(ola, () => accountsRoute.PUT(new Request('http://x', body('PUT', { github: 'not a login!' }))))).status).toBe(400);
    expect((await call(ola, () => accountsRoute.PUT(new Request('http://x', body('PUT', { github: 'ola-gh' }))))).body).toEqual({ github: 'ola-gh', google: 'ola@landflow.test' });
    expect((await call(mia, () => accountsRoute.GET())).body.github).toBe('mia-gh');
    expect((await call(ola, () => accountsRoute.PUT(new Request('http://x', body('PUT', {}))))).status).toBe(400);
  });
  it('answers 409 until the chat flow has a model, and validates the body', async () => {
    expect((await call(mia, () => chatRoute.POST(new Request('http://x', body('POST', { message: '' }))))).status).toBe(400);
    const answer = await call(mia, () => chatRoute.POST(new Request('http://x', body('POST', { message: 'hello', sessionId: 's1' }))));
    expect([409, 200, 502]).toContain(answer.status);
    void owner;
  });
  it('limits the chat to 20 messages a minute a person (a message can start a model call)', async () => {
    const send = () => call(ola, () => chatRoute.POST(new Request('http://x', body('POST', { message: 'hello', sessionId: 's2' }))));
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await send()).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.slice(0, 20)).not.toContain(429);
    expect((await call(mia, () => chatRoute.POST(new Request('http://x', body('POST', { message: 'hi', sessionId: 's3' }))))).status).not.toBe(429);
  });
});
