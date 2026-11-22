/**
 * C21 (W4a P20): who may use a vector collection. The pure rules (keys, levels, the brain's closed names), then the access
 * store on a real database: the first write claims, another project is refused with one message whether the collection exists or
 * not, grants (read, write, "All projects"), revoking, who may grant, the instance admin's transfer, and a claim race in queue
 * mode on Postgres (LANDFLOW_INTEGRATION=queue).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_COLLECTION } from '@/lib/shared/brain';
import { brainReadAllowed, canUse, notionKeyOf, pgIdentityOf, storeKeyOf } from '@/lib/shared/collections';

describe('store keys and the pure rules', () => {
  it('trims and lower-cases a name; the store is part of the key', () => {
    expect(storeKeyOf('sqlite', ' Handbook ')).toBe('sqlite:handbook');
    expect(storeKeyOf('memory', 'Handbook')).toBe('memory:handbook');
  });

  it('a pgvector key names the connection and the table, never a password', () => {
    const pg = pgIdentityOf({ host: 'DB.example', port: 5433, database: 'vec', password: 'secret' }, 'docs');
    expect(storeKeyOf('pgvector', 'HR', pg)).toBe('pgvector:db.example:5433:vec:docs:hr');
    expect(storeKeyOf('pgvector', 'hr', pgIdentityOf({}, ''))).toBe('pgvector:localhost:5432:postgres:landflow_vectors:hr');
    expect(() => storeKeyOf('pgvector', 'hr')).toThrow();
  });

  it('write implies read, read does not imply write', () => {
    expect(canUse('write', 'read')).toBe(true);
    expect(canUse('write', 'write')).toBe(true);
    expect(canUse('read', 'read')).toBe(true);
    expect(canUse('read', 'write')).toBe(false);
  });

  it('the brain’s names have one key whatever the store, and only a project’s own Notion knowledge can be read', () => {
    expect(storeKeyOf('sqlite', 'landflow-brain-x')).toBe(storeKeyOf('pgvector', 'landflow-brain-x', pgIdentityOf({}, '')));
    expect(brainReadAllowed('landflow-notion-p1', 'p1', true)).toBe(true);
    expect(brainReadAllowed('landflow-notion-p1', 'p1', false)).toBe(false);
    expect(brainReadAllowed('landflow-notion-p1', 'p2', true)).toBe(false);
    expect(brainReadAllowed('landflow-notion-p1', undefined, true)).toBe(false);
    expect(brainReadAllowed('landflow-brain-p1', 'p1', true)).toBe(false);
    expect(brainReadAllowed('landflow-brain', 'p1', true)).toBe(false);
    expect(brainReadAllowed(AGENT_MEMORY_COLLECTION, 'p1', true)).toBe(false); // FR-6: reserved for every project
    expect(notionKeyOf('p1')).toBe('brain:landflow-notion-p1');
  });
});

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-collection-access-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const access = await import('@/lib/server/rag/collection-access');
const { queryEvents } = await import('@/lib/server/audit/store');

type Asker = { projectId: string | undefined; subject: 'workflow' };
const asker = (projectId: string | undefined): Asker => ({ projectId, subject: 'workflow' });
const MESSAGE = /project can.t use the collection “handbook”/;

let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let alice: Awaited<ReturnType<typeof auth.createUser>>; // admin of A
let bob: Awaited<ReturnType<typeof auth.createUser>>; // admin of B
let carol: Awaited<ReturnType<typeof auth.createUser>>; // editor of A
let A = '';
let B = '';
let C = '';

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });
  bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', role: 'member', password: 'password-123' });
  carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol', role: 'member', password: 'password-123' });
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  C = projects.createTeamProject({ name: 'Gamma' }).id;
  projects.setMember(A, alice.id, 'admin');
  projects.setMember(A, carol.id, 'editor');
  projects.setMember(B, bob.id, 'admin');
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const key = storeKeyOf('sqlite', 'handbook');

describe('claim on first write', () => {
  it('a collection nobody owns is open to read; the first project to write it owns it, and the claim is audited (AS-4)', async () => {
    expect(access.collectionAccess(key, A)).toBe('unclaimed');
    expect(() => access.assertCanRead(key, 'handbook', asker(B))).not.toThrow();
    await access.assertCanWrite(key, 'sqlite', 'Handbook', asker(A));
    expect(access.collectionAccess(key, A)).toBe('owner');
    const claimed = queryEvents({ action: ['collection.claimed'] }).events.find((e) => e.target?.id === key);
    expect(claimed?.projectId).toBe(A);
  });

  it('another project is refused to read and to write, with one message (D7, AS-1)', async () => {
    expect(access.collectionAccess(key, B)).toBe('none');
    expect(() => access.assertCanRead(key, 'handbook', asker(B))).toThrow(MESSAGE);
    await expect(access.assertCanWrite(key, 'sqlite', 'handbook', asker(B))).rejects.toThrow(MESSAGE);
    // the owner is still the owner: a refused write did not move anything
    expect(access.collectionAccess(key, A)).toBe('owner');
  });

  it('a caller with no project uses an unclaimed collection without claiming it, and a claimed one not at all', async () => {
    const free = storeKeyOf('sqlite', 'no-project-free');
    await access.assertCanWrite(free, 'sqlite', 'no-project-free', asker(undefined));
    expect(access.collectionAccess(free, A)).toBe('unclaimed');
    expect(() => access.assertCanRead(key, 'handbook', asker(undefined))).toThrow(MESSAGE);
  });

  it('the brain’s collections are never in the table: nobody claims landflow-agent-memory', () => {
    expect(storeKeyOf('sqlite', AGENT_MEMORY_COLLECTION).startsWith('brain:')).toBe(true);
    expect(access.brainReadFor(AGENT_MEMORY_COLLECTION, A)).toBe(false);
  });
});

describe('grants', () => {
  it('a read grant lets B read and still refuses its write; revoking refuses it again (AS-2, AS-3)', async () => {
    access.grantCollection(alice, key, B, 'read');
    expect(access.collectionAccess(key, B)).toBe('read');
    expect(() => access.assertCanRead(key, 'handbook', asker(B))).not.toThrow();
    await expect(access.assertCanWrite(key, 'sqlite', 'handbook', asker(B))).rejects.toThrow(MESSAGE);
    const granted = queryEvents({ action: ['collection.granted'] }).events.find((e) => e.target?.id === key);
    expect(granted?.details).toMatchObject({ grantee: B, from: 'none', to: 'read' }); // AS-9
    access.revokeCollection(alice, key, B);
    expect(() => access.assertCanRead(key, 'handbook', asker(B))).toThrow(MESSAGE);
    expect(queryEvents({ action: ['collection.revoked'] }).events.find((e) => e.target?.id === key)?.details).toMatchObject({ from: 'read', to: 'none' });
  });

  it('a write grant lets B write too (and read: there is no write-only grant)', async () => {
    access.grantCollection(alice, key, B, 'write');
    expect(access.collectionAccess(key, B)).toBe('write');
    await expect(access.assertCanWrite(key, 'sqlite', 'handbook', asker(B))).resolves.toBeUndefined();
    expect(() => access.assertCanRead(key, 'handbook', asker(B))).not.toThrow();
    access.revokeCollection(alice, key, B);
  });

  it('“All projects” read: every project reads, none writes (C21-D3)', async () => {
    access.grantCollection(alice, key, '*', 'read');
    for (const p of [B, C]) expect(access.collectionAccess(key, p)).toBe('read');
    await expect(access.assertCanWrite(key, 'sqlite', 'handbook', asker(C))).rejects.toThrow(MESSAGE);
    access.revokeCollection(alice, key, '*');
    expect(access.collectionAccess(key, C)).toBe('none');
  });

  it('only an admin of the owner project may grant; an editor, another project’s admin and an unknown key may not', () => {
    expect(() => access.grantCollection(carol, key, B, 'read')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => access.grantCollection(bob, key, B, 'read')).toThrow(expect.objectContaining({ status: expect.any(Number) }));
    expect(() => access.grantCollection(alice, storeKeyOf('sqlite', 'nobody-owns-this'), B, 'read')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => access.grantCollection(alice, key, 'prj_missing', 'read')).toThrow(expect.objectContaining({ status: 404 }));
    expect(access.collectionAccess(key, B)).toBe('none');
  });

  it('the project’s collection list shows owned and granted ones, and grants only to the owner’s admins', () => {
    access.grantCollection(alice, key, B, 'read');
    const mine = access.projectCollections(A, true);
    expect(mine.collections.find((c) => c.key === key)).toMatchObject({ access: 'owner', grants: [{ projectId: B, level: 'read' }] });
    const theirs = access.projectCollections(B, true);
    expect(theirs.collections.find((c) => c.key === key)).toMatchObject({ access: 'read', ownerProjectId: A });
    expect(theirs.collections.find((c) => c.key === key)?.grants).toBeUndefined();
    expect(access.projectCollections(C, false).collections.find((c) => c.key === key)).toBeUndefined();
    access.revokeCollection(alice, key, B);
  });
});

describe('the Notion knowledge switch (FR-7)', () => {
  it('an admin of the project turns it on and off; only that project can then read it, and only read', () => {
    const name = `landflow-notion-${A}`;
    expect(access.brainReadFor(name, A)).toBe(false);
    expect(() => access.setNotionRead(carol, A, true)).toThrow(expect.objectContaining({ status: 403 }));
    access.setNotionRead(alice, A, true);
    expect(access.brainReadFor(name, A)).toBe(true);
    expect(access.brainReadFor(name, B)).toBe(false);
    expect(access.brainReadFor(`landflow-notion-${B}`, A)).toBe(false);
    access.setNotionRead(alice, A, false);
    expect(access.brainReadFor(name, A)).toBe(false);
  });
});

describe('transfer', () => {
  it('an owner or admin of the instance moves a collection; others may not', async () => {
    const moved = storeKeyOf('sqlite', 'moving');
    await access.assertCanWrite(moved, 'sqlite', 'moving', asker(A));
    expect(() => access.transferCollection(alice, moved, B)).toThrow(expect.objectContaining({ status: 403 }));
    access.transferCollection(owner, moved, B);
    expect(access.collectionAccess(moved, B)).toBe('owner');
    expect(access.collectionAccess(moved, A)).toBe('none');
    expect(queryEvents({ action: ['collection.transferred'] }).events.find((e) => e.target?.id === moved)?.details).toMatchObject({ from: A, to: B });
  });
});

// Queue mode: two processes claim one collection at once and Postgres decides.
const queue = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));
describe.skipIf(!queue)('a claim race in queue mode on Postgres', async () => {
  vi.setConfig({ testTimeout: 60_000 });
  const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
  const SCHEMA = 'landflow_collection_access_test';
  const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const opened: Array<{ close(): Promise<void> }> = [];

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('A and B claim at once: one owner, the other refused (D10)', async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const first = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-claim-')), { instanceId: 'claim-a' });
    const second = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-claim-')), { instanceId: 'claim-b' });
    opened.push(first, second);
    const row = (project: string) => ({ store_key: 'sqlite:race', store: 'sqlite', name: 'race', owner_project_id: project, claimed_by: null, claimed_at: new Date().toISOString(), source: 'first-write' });
    const results = await Promise.all([access.claimCollection(first, row('prj_a')), access.claimCollection(second, row('prj_b'))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? 'prj_a' : 'prj_b';
    const stored = await admin.query('SELECT owner_project_id FROM vector_collections WHERE store_key = $1', ['sqlite:race']);
    expect(stored.rows).toEqual([{ owner_project_id: winner }]);
    // the loser's copy learned who owns it
    for (const db of [first, second]) expect(db.get<{ owner_project_id: string }>('SELECT owner_project_id FROM vector_collections WHERE store_key = ?', 'sqlite:race')?.owner_project_id).toBe(winner);
  });
});
