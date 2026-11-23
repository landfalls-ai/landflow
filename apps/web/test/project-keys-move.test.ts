/**
 * C31, projects coming and going: moving a credential re-seals it with the target project's key (AS-5); deleting a
 * project with a transfer re-seals what moved and destroys the project's keys; deleting one whose credentials were
 * deleted leaves no key behind, so a copy of the database and credentials.json cannot open the old ciphertext (AS-6);
 * a re-seal that fails leaves the value readable on the old key and the key retired, not destroyed; removing a user
 * does the same for their personal project; a personal project has a key like any other (spec Q2).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
const LATER = Date.now() + 60 * 60_000; // past the grace period a retired key waits before a sweep may delete it

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-keys-move-'));
const previousEnv = { ...process.env };
const K1 = `k1:${'a1'.repeat(32)}`;
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_ENCRYPTION_KEYS: K1, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_ENCRYPTION_KEY;

const auth = await import('@/lib/server/auth');
const { credentials } = await import('@/lib/server/credentials/vault');
const { projectKeys } = await import('@/lib/server/credentials/project-keys');
const { ProjectKeyStore } = await import('@/lib/server/credentials/project-key-store');
const ring = await import('@/lib/server/credentials/key-ring');
const projects = await import('@/lib/server/projects/store');
const { moveResource, deleteProjectWithTransfer, deleteUserWithTransfer } = await import('@/lib/server/projects/transfer');
await import('@/lib/server/projects/boot'); // registers the vault's project resolver
const { database } = await import('@/lib/server/db');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

auth.disableTestAuth();
const owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive Owner', password: 'password-123' });
const alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });

/** A credential in `projectId`, with its home recorded before it is sealed (what the route does). */
function create(projectId: string | undefined, secret: string): string {
  const id = credentials.newId();
  if (projectId) projects.setHomeProject('credential', id, projectId);
  credentials.create({ name: `Cred ${secret}`, type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: secret } }, { id });
  return id;
}
const valueOf = (id: string) => credentials.dataFor({ id, name: id }, 'core.httpHeaderAuth').value;
const keyRowsOf = (projectId: string) => database().all<{ version: number; state: string }>('SELECT version, state FROM project_keys WHERE project_id = ? ORDER BY version', projectId);

describe('a credential and its project', () => {
  it('is sealed with the key of the project it was made in, including a personal project (spec Q2)', () => {
    const team = projects.createTeamProject({ name: 'Alpha' });
    const inTeam = create(team.id, 'team-secret-value-1');
    expect(credentials.sealedWith(inTeam)).toBe(`dek:${team.id}.1`);
    // No home row: the instance owner's personal project, which gets its key on this first save.
    const personal = projects.defaultProjectId()!;
    expect(personal).toBe(`personal_${owner.id}`);
    const inPersonal = create(undefined, 'personal-secret-1');
    expect(credentials.sealedWith(inPersonal)).toBe(`dek:${personal}.1`);
    expect(valueOf(inTeam)).toBe('team-secret-value-1');
    expect(valueOf(inPersonal)).toBe('personal-secret-1');
  });

  it('moving it to another project re-seals it with that project’s key, and it still works (AS-5)', () => {
    const a = projects.createTeamProject({ name: 'Move A' });
    const b = projects.createTeamProject({ name: 'Move B' });
    const id = create(a.id, 'moving-secret-123');
    expect(credentials.sealedWith(id)).toBe(`dek:${a.id}.1`);
    moveResource('credential', id, b.id);
    expect(credentials.sealedWith(id)).toBe(`dek:${b.id}.1`);
    expect(valueOf(id)).toBe('moving-secret-123');
    // A's key is still there: the project lives on.
    expect(keyRowsOf(a.id)).toEqual([{ version: 1, state: 'active' }]);
  });
});

describe('LANDFLOW_PROJECT_KEYS=off', () => {
  it('seals new credentials on the ring, as before project keys; turning it on again seals them with the project key', () => {
    const team = projects.createTeamProject({ name: 'Switch' });
    process.env.LANDFLOW_PROJECT_KEYS = 'off';
    try {
      const id = create(team.id, 'switch-secret-123456');
      expect(credentials.sealedWith(id)).toBe('ring:k1');
      expect(valueOf(id)).toBe('switch-secret-123456');
    } finally {
      delete process.env.LANDFLOW_PROJECT_KEYS;
    }
    expect(credentials.sealedWith(create(team.id, 'switch-secret-654321'))).toBe(`dek:${team.id}.1`);
  });
});

describe('deleting a project', () => {
  it('with a transfer: the credentials are re-sealed with the target’s key and the project’s keys are retired, then deleted by a sweep after the grace period', async () => {
    const from = projects.createTeamProject({ name: 'Going' });
    const to = projects.createTeamProject({ name: 'Staying' });
    const id = create(from.id, 'going-secret-12345');
    create(to.id, 'staying-secret-1234');
    deleteProjectWithTransfer(from.id, to.id);
    expect(credentials.sealedWith(id)).toBe(`dek:${to.id}.1`);
    expect(valueOf(id)).toBe('going-secret-12345');
    expect(keyRowsOf(from.id)).toEqual([{ version: 1, state: 'retired' }]);
    // Not within the grace period (another process may still be sealing with it)...
    expect(await projectKeys.sweep(undefined, Date.now())).toEqual([]);
    expect(keyRowsOf(from.id)).toHaveLength(1);
    // ...and after it, once nothing names it.
    expect(await projectKeys.sweep(undefined, LATER)).toContain(`${from.id}:1`);
    expect(keyRowsOf(from.id)).toEqual([]);
    expect(database().all("SELECT 1 FROM audit_events WHERE action = 'encryption.project_key.destroyed'").length).toBeGreaterThanOrEqual(1);
  });

  it('after its credentials were deleted: once swept no key is left, and a copy of the database and credentials.json cannot open the old ciphertext (AS-6)', async () => {
    const doomed = projects.createTeamProject({ name: 'Doomed' });
    const id = create(doomed.id, 'doomed-secret-12345');
    const stolen = structuredClone(JSON.parse(readFileSync(join(dataDir, 'credentials.json'), 'utf8')).credentials.find((c: { id: string }) => c.id === id)) as { data: import('@/lib/server/credentials/key-ring').SealedValue };
    const copyOfKeys = keyRowsOf(doomed.id);
    expect(copyOfKeys).toHaveLength(1);
    credentials.delete(id);
    projects.forgetResource('credential', id);
    deleteProjectWithTransfer(doomed.id);
    expect(keyRowsOf(doomed.id)).toEqual([{ version: 1, state: 'retired' }]);
    // The delayed crypto-shred: a sweep before the grace period keeps it, one after deletes it.
    expect(await projectKeys.sweep(undefined, Date.now())).toEqual([]);
    expect(await projectKeys.sweep(undefined, LATER)).toContain(`${doomed.id}:1`);
    expect(keyRowsOf(doomed.id)).toEqual([]);
    // The thief has the ciphertext and the ring (the env key) but the project's key is nowhere: not in the table, not in the file.
    expect(stolen.data).toMatchObject({ v: 3, dek: `${doomed.id}.1` });
    const thief = new ProjectKeyStore({ ring: ring.buildKeyRing(K1, undefined) });
    expect(() => thief.keyFor(doomed.id, 1)).toThrow(/is gone/);
    expect(readFileSync(join(dataDir, 'credentials.json'), 'utf8')).not.toContain('doomed-secret-12345');
  });

  it('when re-sealing fails the credential stays readable on the old key and that key is kept, retired; migrate finishes it', async () => {
    const from = projects.createTeamProject({ name: 'Failing' });
    const to = projects.createTeamProject({ name: 'Receiving' });
    const id = create(from.id, 'failing-secret-12345');
    const spy = vi.spyOn(credentials, 'resealOne').mockImplementation(() => {
      throw new Error('write failed');
    });
    try {
      deleteProjectWithTransfer(from.id, to.id);
    } finally {
      spy.mockRestore();
    }
    expect(credentials.sealedWith(id)).toBe(`dek:${from.id}.1`);
    expect(valueOf(id)).toBe('failing-secret-12345');
    expect(keyRowsOf(from.id)).toEqual([{ version: 1, state: 'retired' }]);
    const status = projectKeys.status();
    expect(status.projects.find((p) => p.projectId === from.id)).toMatchObject({ retired: [1], credentials: 1 });
    const result = await projectKeys.migrate((projectId) => Boolean(projects.getProject(projectId)), LATER);
    expect(result.done).toBe(true);
    expect(credentials.sealedWith(id)).toBe(`dek:${to.id}.1`);
    expect(valueOf(id)).toBe('failing-secret-12345');
    expect(keyRowsOf(from.id)).toEqual([]);
  });
});

describe('removing a user', () => {
  it('re-seals what their personal project owned with the target’s key and retires the personal project’s key, which a sweep deletes later', async () => {
    const personal = projects.ensurePersonalProject(alice.id)!;
    const target = projects.createTeamProject({ name: 'Inheritor' });
    const id = create(personal, 'alice-secret-123456');
    expect(credentials.sealedWith(id)).toBe(`dek:${personal}.1`);
    deleteUserWithTransfer(alice.id, { projectId: target.id });
    expect(credentials.sealedWith(id)).toBe(`dek:${target.id}.1`);
    expect(valueOf(id)).toBe('alice-secret-123456');
    expect(keyRowsOf(personal)).toEqual([{ version: 1, state: 'retired' }]);
    await projectKeys.sweep(undefined, LATER);
    expect(keyRowsOf(personal)).toEqual([]);
  });
});
