/**
 * C21 (W4a P20): the collection routes and the project's Collections card. GET /api/projects/:id/collections (owned and granted,
 * grants for the owner's admins), POST …/collections/:key (grant, revoke, the Notion switch: admins of the owner only, audited),
 * the name check the knowledge dialog makes, and GET/POST /api/settings/collections (instance admins: the adoption report, adopt
 * again, transfer). The card draws owned and granted rows, "Share with…" for an admin only and the upgrade's notice with
 * one-click Grant read / Grant write.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectCollections } from '@/lib/shared/collections';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-collection-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const access = await import('@/lib/server/rag/collection-access');
const { queryEvents } = await import('@/lib/server/audit/store');
const { storeKeyOf, notionKeyOf } = await import('@/lib/shared/collections');
const listRoute = await import('@/app/api/projects/[id]/collections/route');
const keyRoute = await import('@/app/api/projects/[id]/collections/[key]/route');
const settingsRoute = await import('@/app/api/settings/collections/route');
const { CollectionsCardView } = await import('@/components/projects/collections-card');

interface Caller {
  id: string;
  session: string;
}
type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(route: unknown, url: string, caller: Caller, params: Record<string, string> = {}, body?: unknown) {
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await (route as Route)(new Request(`http://localhost:3000${url}`, { method: body !== undefined ? 'POST' : 'GET', headers, ...(body !== undefined && { body: JSON.stringify(body) }) }), { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function makeUser(email: string, name: string, role: 'owner' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

let owner: Caller, alice: Caller, bob: Caller, carol: Caller, dave: Caller;
let A = '';
let B = '';
const name = 'handbook';
const key = storeKeyOf('sqlite', name);
const list = (project: string, caller: Caller, query = '') => call(listRoute.GET, `/api/projects/${project}/collections${query}`, caller, { id: project });
const post = (project: string, caller: Caller, body: unknown, k = key) => call(keyRoute.POST, `/api/projects/${project}/collections/${encodeURIComponent(k)}`, caller, { id: project, key: k }, body);

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive', 'owner');
  alice = await makeUser('alice@example.com', 'Alice', 'member'); // admin of A
  bob = await makeUser('bob@example.com', 'Bob', 'member'); // admin of B
  carol = await makeUser('carol@example.com', 'Carol', 'member'); // editor of A
  dave = await makeUser('dave@example.com', 'Dave', 'member'); // viewer of A
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(A, alice.id, 'admin');
  projects.setMember(A, carol.id, 'editor');
  projects.setMember(A, dave.id, 'viewer');
  projects.setMember(B, bob.id, 'admin');
  await access.assertCanWrite(key, 'sqlite', name, { projectId: A, subject: 'workflow' });
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in previousEnv)) delete process.env[k];
  Object.assign(process.env, previousEnv);
});

describe('GET /api/projects/:id/collections', () => {
  it('A lists its collection as owned; B lists nothing before a grant and the grant after it', async () => {
    const mine = await list(A, alice);
    expect(mine.status).toBe(200);
    expect(mine.body.collections).toEqual([expect.objectContaining({ key, name, access: 'owner', grants: [] })]);
    expect(mine.body.canManage).toBe(true);
    expect((await list(B, bob)).body.collections).toEqual([]);
    expect((await post(A, alice, { grant: { projectId: B, level: 'read' } })).status).toBe(200);
    const theirs = await list(B, bob);
    expect(theirs.body.collections).toEqual([expect.objectContaining({ key, access: 'read', ownerProjectId: A })]);
    expect(theirs.body.collections[0].grants).toBeUndefined();
    expect(theirs.body.canManage).toBe(true); // an admin of B, who sees no grants of A's
    expect((await list(A, alice)).body.collections[0].grants).toEqual([expect.objectContaining({ projectId: B, level: 'read' })]);
  });

  it('a viewer sees the rows without grants, and a non-member gets 404', async () => {
    const viewer = await list(A, dave);
    expect(viewer.body.canManage).toBe(false);
    expect(viewer.body.collections[0].grants).toBeUndefined();
    expect((await list(A, bob)).status).toBe(404);
  });

  it('the name check says no for another project’s collection and for a brain name, yes for a free one, and never names the owner', async () => {
    await access.revokeCollection({ id: alice.id } as never, key, B);
    const refused = await list(B, bob, `?check=${name}&store=sqlite`);
    expect(refused.body).toEqual({ usable: false, message: expect.stringMatching(/This project can.t use the collection “handbook”/) });
    expect(JSON.stringify(refused.body)).not.toMatch(/Alpha|prj_/);
    expect((await list(A, alice, `?check=${name}&store=sqlite`)).body).toEqual({ usable: true });
    expect((await list(B, bob, '?check=brand-new&store=sqlite')).body).toEqual({ usable: true });
    expect((await list(B, bob, '?check=landflow-agent-memory&store=sqlite')).body.usable).toBe(false);
  });
});

describe('POST /api/projects/:id/collections/:key', () => {
  it('only an admin of the owner may grant, revoke or switch Notion; the rest get 403 or 404', async () => {
    const body = { grant: { projectId: B, level: 'read' } };
    expect((await post(A, carol, body)).status).toBe(403);
    expect((await post(A, dave, body)).status).toBe(403);
    expect((await post(A, bob, body)).status).toBe(404); // not a member of A: it is not there for them
    expect((await post(B, bob, body)).status).toBe(404); // B doesn't own it
    expect((await post(A, alice, { grant: { projectId: B, level: 'admin' } })).status).toBe(400);
    expect((await post(A, alice, { grant: { projectId: B, level: 'write' } })).status).toBe(200);
    expect((await list(B, bob)).body.collections[0].access).toBe('write');
    expect((await post(A, alice, { revoke: B })).status).toBe(200);
    expect((await post(A, alice, { revoke: B })).status).toBe(404); // nothing left to revoke
    expect((await list(B, bob)).body.collections).toEqual([]);
    expect((await post(A, carol, { notionRead: true }, notionKeyOf(A))).status).toBe(403);
    expect((await post(A, alice, { notionRead: true }, notionKeyOf(A))).status).toBe(200);
    expect(access.notionReadOn(A)).toBe(true);
    expect((await post(A, alice, { notionRead: false }, notionKeyOf(A))).status).toBe(200);
    expect((await post(A, alice, { notionRead: true }, 'sqlite:other')).status).toBe(404);
  });

  it('“All projects” can be granted, and every change is audited with from and to (AS-9)', async () => {
    expect((await post(A, alice, { grant: { projectId: '*', level: 'read' } })).status).toBe(200);
    expect((await list(B, bob)).body.collections[0]).toMatchObject({ access: 'read' });
    await post(A, alice, { revoke: '*' });
    const granted = queryEvents({ action: ['collection.granted'] }).events.filter((e) => e.target?.id === key);
    expect(granted.map((e) => e.details)).toEqual(expect.arrayContaining([expect.objectContaining({ grantee: '*', from: 'none', to: 'read' }), expect.objectContaining({ grantee: B, from: 'none', to: 'write' })]));
    const revoked = queryEvents({ action: ['collection.revoked'] }).events.filter((e) => e.target?.id === key);
    expect(revoked.length).toBeGreaterThanOrEqual(3);
    expect(granted[0]?.actor?.id).toBeTruthy();
  });
});

describe('/api/settings/collections', () => {
  it('lists every collection with the adoption report for an instance admin only', async () => {
    const all = await call(settingsRoute.GET, '/api/settings/collections', owner);
    expect(all.status).toBe(200);
    expect(all.body.collections.map((c: { key: string }) => c.key)).toContain(key);
    expect(all.body.adoption).toMatchObject({ collections: 0, lost: [] });
    expect((await call(settingsRoute.GET, '/api/settings/collections', alice)).status).toBe(403);
  });

  it('adopt re-runs and answers the report; transfer moves the owner; a member may do neither', async () => {
    expect((await call(settingsRoute.POST, '/api/settings/collections', owner, {}, { adopt: true })).body.adoption).toMatchObject({ collections: 0 });
    expect((await call(settingsRoute.POST, '/api/settings/collections', alice, {}, { adopt: true })).status).toBe(403);
    expect((await call(settingsRoute.POST, '/api/settings/collections', alice, {}, { transfer: { key, projectId: B } })).status).toBe(403);
    expect((await call(settingsRoute.POST, '/api/settings/collections', owner, {}, { transfer: { key, projectId: B } })).status).toBe(200);
    expect((await list(B, bob)).body.collections[0]).toMatchObject({ access: 'owner' });
    expect((await list(A, alice)).body.collections).toEqual([]);
    expect((await call(settingsRoute.POST, '/api/settings/collections', owner, {}, { transfer: { key: 'sqlite:nothing', projectId: B } })).status).toBe(404);
  });
});

describe('the Collections card', () => {
  const view = (patch: Partial<ProjectCollections> = {}): ProjectCollections => ({
    collections: [
      { key: 'sqlite:handbook', store: 'sqlite', name: 'handbook', access: 'owner', ownerProjectId: 'prj_a', ownerName: 'Alpha', source: 'upgrade', grants: [{ projectId: 'prj_b', projectName: 'Beta', level: 'read' }], lostAccess: [{ projectId: 'prj_c', projectName: 'Gamma' }] },
      { key: 'sqlite:faq', store: 'sqlite', name: 'faq', access: 'write', ownerProjectId: 'prj_d', ownerName: 'Delta', source: 'first-write' },
    ],
    lost: [{ key: 'sqlite:notes', store: 'sqlite', name: 'notes', ownerProjectId: 'prj_d', ownerName: 'Delta' }],
    canManage: true,
    notion: { collection: 'landflow-notion-prj_a', read: false },
    ...patch,
  });
  const html = (v: ProjectCollections) => renderToStaticMarkup(createElement(CollectionsCardView, { view: v, base: '/api/projects/prj_a/collections', post: () => undefined, reload: () => undefined }));

  it('an admin sees owned and granted rows, Share with…, stop buttons and the upgrade’s notice with Grant read and Grant write', () => {
    const out = html(view());
    expect(out).toContain('handbook');
    expect(out).toContain('Owned');
    expect(out).toContain('owned by Delta');
    expect(out).toContain('Search and change');
    expect(out).toContain('Share with…');
    expect(out).toContain('Beta · search');
    expect(out).toContain('Stop sharing with Beta');
    expect(out).toContain('These projects lost access in the upgrade');
    expect(out).toContain('Gamma');
    expect(out).toContain('Grant read');
    expect(out).toContain('Grant write');
    expect(out).toMatch(/Clear the collection and insert again/); // the notice warns that keys upserted before the upgrade won.t match
    expect(out).toContain('Let this project’s flows read its Notion knowledge');
    expect(out).toContain('“notes” now belongs to Delta');
  });

  it('a member sees the same rows and no buttons that change anything', () => {
    const out = html(view({ canManage: false }));
    expect(out).toContain('handbook');
    expect(out).not.toContain('Share with…');
    expect(out).not.toContain('Grant read');
    expect(out).not.toContain('Stop sharing with');
    expect(out).toContain('The project’s admins change who uses a collection.');
  });

  it('an empty project says how a collection gets here, and the rows stack on a phone', () => {
    expect(html(view({ collections: [], lost: [], notion: null }))).toContain('No collections yet');
    expect(html(view())).toContain('max-md:flex-col');
  });
});
