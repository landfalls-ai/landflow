/**
 * The event subscription routes (C19): who may do what (project admins write, members read, others get 404), the secret
 * shown once, the outbound policy at save time (AS-5), the limit of 20 per project, Retry now and Send test, and the audit
 * events. The policy table is untouched: everything sits under /api/projects.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-event-routes-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const collection = await import('@/app/api/projects/[id]/event-subscriptions/route');
const item = await import('@/app/api/projects/[id]/event-subscriptions/[subscriptionId]/route');
const retry = await import('@/app/api/projects/[id]/event-subscriptions/[subscriptionId]/retry/route');
const sendTest = await import('@/app/api/projects/[id]/event-subscriptions/[subscriptionId]/test/route');

type Ctx = { params: Promise<Record<string, string>> };
type Route = (request: Request, ctx: Ctx) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

let owner: Caller, admin: Caller, editor: Caller, viewer: Caller, outsider: Caller;
let team = '';
let otherTeam = '';
let receiver: Server;
let receiverUrl = '';
const hits: Array<{ headers: Record<string, unknown>; body: string }> = [];

async function call(route: unknown, method: string, caller: Caller, params: Record<string, string>, body?: unknown, path = '') {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await (route as Route)(new Request(`http://localhost:3000/api/projects/${params.id}/event-subscriptions${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) }), { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const list = (caller: Caller, id = team) => call(collection.GET, 'GET', caller, { id });
const create = (caller: Caller, body: unknown, id = team) => call(collection.POST, 'POST', caller, { id }, body);

async function makeUser(email: string, name: string, role: 'owner' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  admin = await makeUser('admin@example.com', 'Alice', 'member');
  editor = await makeUser('editor@example.com', 'Bob', 'member');
  viewer = await makeUser('viewer@example.com', 'Carol', 'member');
  outsider = await makeUser('erin@example.com', 'Erin', 'member');
  team = projects.createTeamProject({ name: 'Events' }).id;
  otherTeam = projects.createTeamProject({ name: 'Elsewhere' }).id;
  projects.setMember(team, admin.id, 'admin');
  projects.setMember(team, editor.id, 'editor');
  projects.setMember(team, viewer.id, 'viewer');
  projects.setMember(otherTeam, outsider.id, 'admin');
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      hits.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;
});

afterAll(async () => {
  auth.enableTestAuth();
  await new Promise<void>((done) => receiver.close(() => done()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const input = (over: Record<string, unknown> = {}) => ({ name: 'Receiver', url: receiverUrl, events: ['run.failed'], ...over });

describe('creating and reading', () => {
  it('lets a project admin add one: 201, the secret once, none in the list, and an audit event', async () => {
    const made = await create(admin, input({ url: `${receiverUrl}?token=hunter2` }));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.secret).toMatch(/^whsec_/);
    expect(made.body.subscription).toMatchObject({ name: 'Receiver', events: ['run.failed'], enabled: true, backlog: 0, dead: 0, projectId: team });
    expect(made.body.subscription.secret).toBeUndefined();
    const listed = await list(viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.canEdit).toBe(false);
    expect(listed.body.subscriptions).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    // A viewer sees the host only: a path or query may carry a token. An admin sees the whole URL.
    expect(JSON.stringify(listed.body)).not.toContain('hunter2');
    expect(listed.body.subscriptions[0].url).toBe(new URL(receiverUrl).origin);
    expect(JSON.stringify((await list(admin)).body)).toContain('hunter2');
    expect((await list(admin)).body.canEdit).toBe(true);
    const event = queryEvents({ action: ['event_subscription.created'] }, { limit: 1 }).events[0]!;
    expect(event).toMatchObject({ target: { id: made.body.subscription.id }, projectId: team });
    expect(JSON.stringify(event)).not.toContain(made.body.secret);
    expect(JSON.stringify(event)).not.toContain('/hook');
  });

  it('lets the instance owner add one with no membership row', async () => {
    expect((await create(owner, input({ name: 'Owner’s' }))).status).toBe(201);
  });

  it('refuses editors, viewers and outsiders on writes, and outsiders on reads', async () => {
    expect((await create(editor, input())).status).toBe(403);
    expect((await create(viewer, input())).status).toBe(403);
    expect((await create(outsider, input())).status).toBe(404);
    expect((await list(outsider)).status).toBe(404);
    expect((await list(editor)).status).toBe(200);
  });

  it('checks the body', async () => {
    expect((await create(admin, input({ name: '' }))).status).toBe(400);
    expect((await create(admin, input({ events: [] }))).status).toBe(400);
    expect((await create(admin, input({ events: ['nope'] }))).status).toBe(400);
    expect((await create(admin, input({ url: 'ftp://example.com/x' }))).status).toBe(400);
    expect((await create(admin, input({ url: 'not a url' }))).status).toBe(400);
    const named = await create(admin, input({ events: ['node.finished'] }));
    expect(named.status).toBe(400);
    expect(named.body.error).toMatch(/steps/);
  });

  it('refuses an address the outbound policy blocks, and says why (AS-5)', async () => {
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'true';
    try {
      const refused = await create(admin, input());
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/can’t send to this address.*private address/);
      process.env.LANDFLOW_OUTBOUND_ALLOW = '127.0.0.1';
      expect((await create(admin, input({ name: 'Allowed' }))).status).toBe(201);
    } finally {
      delete process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
      delete process.env.LANDFLOW_OUTBOUND_ALLOW;
    }
  });

  it('allows 20 per project and a 21st is a 409', async () => {
    const have = ((await list(admin)).body.subscriptions as unknown[]).length;
    for (let i = have; i < 20; i++) expect((await create(admin, input({ name: `n${i}` }))).status).toBe(201);
    expect((await create(admin, input({ name: 'one more' }))).status).toBe(409);
    // Another project has its own twenty.
    expect((await create(outsider, input(), otherTeam)).status).toBe(201);
  });
});

describe('changing, retrying, testing and deleting', () => {
  let id = '';
  it('PATCH changes fields, answers a new secret once and re-enabling clears the reason', async () => {
    id = (await list(admin)).body.subscriptions[0].id;
    const params = { id: team, subscriptionId: id };
    const renamed = await call(item.PATCH, 'PATCH', admin, params, { name: 'Renamed', includeOutput: true });
    expect(renamed.body.subscription).toMatchObject({ name: 'Renamed', includeOutput: true });
    expect(renamed.body.secret).toBeUndefined();
    const fresh = await call(item.PATCH, 'PATCH', admin, params, { newSecret: true });
    expect(fresh.body.secret).toMatch(/^whsec_/);
    database().upsert('event_subscriptions', { ...database().get<Record<string, string>>('SELECT * FROM event_subscriptions WHERE id = ?', id)!, enabled: 0, disabled_reason: 'The receiver answered 410 Gone' });
    const back = await call(item.PATCH, 'PATCH', admin, params, { enabled: true });
    expect(back.body.subscription).toMatchObject({ enabled: true, disabledReason: null });
    expect((await call(item.PATCH, 'PATCH', editor, params, { name: 'x' })).status).toBe(403);
    expect(queryEvents({ action: ['event_subscription.updated'] }, { limit: 1 }).events[0]).toMatchObject({ target: { id } });
  });

  it('another project’s subscription is a 404 through this project’s URL', async () => {
    expect((await call(item.PATCH, 'PATCH', owner, { id: otherTeam, subscriptionId: id }, { name: 'x' })).status).toBe(404);
    expect((await call(retry.POST, 'POST', owner, { id: otherTeam, subscriptionId: id }, undefined, `/${id}/retry`)).status).toBe(404);
  });

  it('retry makes dead events due again; test sends a signed test event', async () => {
    const params = { id: team, subscriptionId: id };
    database().insertNew('event_outbox', { topic: 'subscription', target_id: id, event_id: 'ex_dead:run.failed', created_at: new Date().toISOString(), payload: '{}', attempts: 9, next_at: new Date().toISOString(), dead_at: new Date().toISOString(), last_error: 'x' });
    expect((await call(retry.POST, 'POST', admin, params, undefined, `/${id}/retry`)).body).toEqual({ retried: 1 });
    expect((await call(retry.POST, 'POST', editor, params, undefined, `/${id}/retry`)).status).toBe(403);
    hits.length = 0;
    const sent = await call(sendTest.POST, 'POST', admin, params, undefined, `/${id}/test`);
    expect(sent.body).toMatchObject({ ok: true, status: 200 });
    expect(hits[0]!.headers['x-landflow-event']).toBe('test');
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ type: 'test', projectId: team });
  });

  it('DELETE removes the subscription and its waiting events', async () => {
    const params = { id: team, subscriptionId: id };
    expect((await call(item.DELETE, 'DELETE', editor, params)).status).toBe(403);
    expect((await call(item.DELETE, 'DELETE', admin, params)).status).toBe(200);
    expect(database().all('SELECT * FROM event_outbox WHERE target_id = ?', id)).toEqual([]);
    expect((await call(item.DELETE, 'DELETE', admin, params)).status).toBe(404);
    expect(queryEvents({ action: ['event_subscription.deleted'] }, { limit: 1 }).events[0]).toMatchObject({ target: { id } });
  });
});
