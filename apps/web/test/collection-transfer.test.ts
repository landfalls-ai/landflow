/**
 * C21 (W4a P20): collections follow a project that is deleted or a user who is removed. Deleting a project (or removing a user)
 * with a transfer re-owns its collections to the target project, moves the grants it held (dropping the new owner's own), and
 * audits each as collection.transferred, in the same transaction as the move; deleting one that owned no resources removes its
 * owner rows and its grants, so nothing stale stays behind.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-collection-transfer-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { deleteProjectWithTransfer, deleteUserWithTransfer } = await import('@/lib/server/projects/transfer');
const { ensurePersonalProject } = await import('@/lib/server/projects/store');
const access = await import('@/lib/server/rag/collection-access');
const { queryEvents } = await import('@/lib/server/audit/store');
const { database } = await import('@/lib/server/db');
const { storeKeyOf } = await import('@/lib/shared/collections');

const asker = (projectId: string) => ({ projectId, subject: 'workflow' as const });
const claim = (name: string, projectId: string) => access.assertCanWrite(storeKeyOf('sqlite', name), 'sqlite', name, asker(projectId));
const key = (name: string) => storeKeyOf('sqlite', name);
const grantsOf = (name: string) => database().all<{ project_id: string; level: string }>('SELECT project_id, level FROM vector_collection_grants WHERE store_key = ? ORDER BY project_id', key(name));

let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let X = '';
let Y = '';
let Z = '';

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  access.collectionAccess('sqlite:__warm__', undefined); // the one-time adoption runs on the empty database
  X = projects.createTeamProject({ name: 'Xray' }).id;
  Y = projects.createTeamProject({ name: 'Yankee' }).id;
  Z = projects.createTeamProject({ name: 'Zulu' }).id;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in previousEnv)) delete process.env[k];
  Object.assign(process.env, previousEnv);
});

describe('deleting a project with a transfer', () => {
  it('re-owns its collections to the target, moves the grants it held, drops the new owner’s own grant and audits each (same transaction)', async () => {
    await claim('xa', X);
    await claim('yb', Y);
    access.grantCollection(owner, key('xa'), Y, 'read'); // Y already reads xa: after the move it owns it, so its grant goes
    access.grantCollection(owner, key('xa'), Z, 'write'); // Z's grant stays
    access.grantCollection(owner, key('yb'), X, 'read'); // X held a grant on Y's collection: Y owns it, nothing to move
    await claim('zc', Z);
    access.grantCollection(owner, key('zc'), X, 'write'); // X held write on Z's collection: the target (Y) takes it over
    deleteProjectWithTransfer(X, Y, owner.id);
    expect(access.ownerProjectOf(key('xa'))).toBe(Y);
    expect(grantsOf('xa')).toEqual([{ project_id: Z, level: 'write' }]);
    expect(grantsOf('yb')).toEqual([]);
    expect(grantsOf('zc')).toEqual([{ project_id: Y, level: 'write' }]);
    expect(access.collectionAccess(key('xa'), Y)).toBe('owner');
    expect(access.collectionAccess(key('xa'), Z)).toBe('write');
    const moved = queryEvents({ action: ['collection.transferred'] }).events.find((e) => e.target?.id === key('xa'));
    expect(moved?.details).toMatchObject({ from: X, to: Y });
    // nothing of the deleted project is left in either table
    expect(database().all('SELECT * FROM vector_collections WHERE owner_project_id = ?', X)).toEqual([]);
    expect(database().all('SELECT * FROM vector_collection_grants WHERE project_id = ?', X)).toEqual([]);
  });

  it('a project that owned no resources takes its collections and grants with it: nobody keeps a stale row, the names are open again', async () => {
    const W = projects.createTeamProject({ name: 'Whiskey' }).id;
    await claim('wc', W);
    access.grantCollection(owner, key('wc'), Z, 'read');
    await claim('zd', Z);
    access.grantCollection(owner, key('zd'), W, 'read');
    deleteProjectWithTransfer(W, undefined, owner.id);
    expect(access.ownerProjectOf(key('wc'))).toBeUndefined();
    expect(grantsOf('wc')).toEqual([]);
    expect(grantsOf('zd')).toEqual([]);
    expect(access.collectionAccess(key('wc'), Y)).toBe('unclaimed');
  });
});

describe('removing a user whose personal project owns collections', () => {
  it('moves them to the project the user’s things are transferred to', async () => {
    const ula = await auth.createUser({ email: 'ula@example.com', name: 'Ula', role: 'member', password: 'password-123' });
    const personal = ensurePersonalProject(ula.id)!;
    await claim('ua', personal);
    access.grantCollection(owner, key('ua'), Z, 'read');
    deleteUserWithTransfer(ula.id, { projectId: Y }, owner.id);
    expect(access.ownerProjectOf(key('ua'))).toBe(Y);
    expect(grantsOf('ua')).toEqual([{ project_id: Z, level: 'read' }]);
    expect(queryEvents({ action: ['collection.transferred'] }).events.some((e) => e.target?.id === key('ua'))).toBe(true);
  });
});
